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
//! and unfenced in the Host session.
//!
//! OpenCode's `auth.json` is not credential-only either (threat recheck
//! 2026-10-24, gap 42): a `wellknown` entry makes OpenCode fetch and load a
//! remote configuration (MCP servers, plugins). So its file must pass
//! [`admissible`] at adopt *and* at place (the store's copy before it goes
//! into a home, the home's copy before it is left there), and a tab's copy is
//! adopted only as a token rotation of an `oauth` entry the store already
//! holds ([`opencode_adoption`]) — never a new entry, a changed key, type,
//! `enterpriseUrl` or `accountId`. [`sweep_unadmissible_in`] moves failing
//! copies aside at startup and flags a V2 database that already took a
//! `wellknown` source. AppHandle-free and unit-testable.

use std::collections::BTreeSet;
use app_core::sync::LockExt;
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
    let _ = write_store(&placed_file(store_dir, home, leaf), hash.as_bytes());
}

/// A non-blank file's bytes.
fn content(bytes: Option<Vec<u8>>) -> Option<Vec<u8>> {
    bytes.filter(|b| !b.iter().all(u8::is_ascii_whitespace))
}

/// Write a store file or sidecar owner-only and whole, in a `0700` folder:
/// the store dir is Tabtivity's own, but a keeper pass and a spawn may run at once.
fn write_store(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| io::Error::other("missing parent directory"))?;
    crate::services::agent_home::create_private_dir(parent)?;
    storage::write_private_atomic(path, bytes).map_err(io::Error::other)
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
/// it named a `command` where a credential belongs, or it carried `config`
/// (an entry or field a CLI's login file may not bring, [`admissible`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct Blocked {
    pub account: Option<String>,
    pub stored: Option<String>,
    pub command: Option<String>,
    #[serde(default)]
    pub config: Option<String>,
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

/// A name from a file an agent wrote, short enough for the Agents view.
fn short(name: &str) -> String {
    name.chars().take(60).collect()
}

/// One OpenCode `auth.json` entry (`Auth.Info`): `api` (`key`, optional
/// string `metadata`) or `oauth` (`refresh`, `access`, `expires`, optional
/// `accountId`, `enterpriseUrl`). Anything else — `wellknown` above all, and
/// any field the two shapes do not have — is refused, naming `entry.field`.
fn opencode_entry_admissible(name: &str, entry: &serde_json::Value) -> Result<(), String> {
    let fail = |field: &str| Err(format!("{}.{field}", short(name)));
    let Some(fields) = entry.as_object() else { return fail("type") };
    let (known, strings): (&[&str], &[&str]) = match fields.get("type").and_then(|t| t.as_str()) {
        Some("api") => (&["type", "key", "metadata"], &["key"]),
        Some("oauth") => (
            &["type", "refresh", "access", "expires", "accountId", "enterpriseUrl"],
            &["refresh", "access", "accountId", "enterpriseUrl"],
        ),
        _ => return fail("type"),
    };
    if let Some(unknown) = fields.keys().find(|k| !known.contains(&k.as_str())) {
        return fail(unknown);
    }
    let required: &[&str] = if known.contains(&"key") { &["key"] } else { &["refresh", "access", "expires"] };
    if let Some(missing) = required.iter().find(|k| !fields.contains_key(**k)) {
        return fail(missing);
    }
    if let Some(bad) = strings.iter().find(|k| fields.get(**k).is_some_and(|v| !v.is_string())) {
        return fail(bad);
    }
    if fields.get("expires").is_some_and(|v| !v.is_number()) {
        return fail("expires");
    }
    if fields
        .get("metadata")
        .is_some_and(|m| m.as_object().is_none_or(|o| o.values().any(|v| !v.is_string())))
    {
        return fail("metadata");
    }
    Ok(())
}

/// The entries of an OpenCode `auth.json`: a JSON object, each entry
/// [`opencode_entry_admissible`]. Bytes that do not parse are refused too —
/// OpenCode would not load them, but a file that is not a login is not
/// ours to share.
fn opencode_entries(bytes: &[u8]) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| "auth.json".to_string())?;
    let serde_json::Value::Object(entries) = value else { return Err("auth.json".to_string()) };
    for (name, entry) in &entries {
        opencode_entry_admissible(name, entry)?;
    }
    Ok(entries)
}

/// Whether `bytes` may be shared as `cli`'s login: where a CLI's login file
/// can carry more than a credential, the first field that does. Only
/// OpenCode's has a check (the Goose and Qoder files were surveyed and
/// nothing in them is loaded as configuration; see the plan's step 1).
pub fn admissible(cli: &str, bytes: &[u8]) -> Result<(), String> {
    match cli {
        "opencode" => opencode_entries(bytes).map(|_| ()),
        _ => Ok(()),
    }
}

/// What taking a tab's copy of a login into the store comes to: the bytes
/// the store should hold afterwards (`None`: nothing to take), and the first
/// thing in the copy that is not taken, for the Agents view.
struct Adoption {
    bytes: Option<Vec<u8>>,
    refused: Option<String>,
}

/// [`Adoption`] of `home` (a tab's copy) over `stored` (the store's file).
/// Every CLI but OpenCode takes the copy as it is. OpenCode takes only a
/// rotation of the tokens of an `oauth` entry the store already holds: the
/// store's own entries, with `refresh`, `access` and `expires` from the copy.
/// A new entry, a changed `api` entry, and a changed `type`, `accountId` or
/// `enterpriseUrl` are not taken; a copy that is not [`admissible`] in the
/// first place is taken in no part.
fn opencode_adoption(stored: Option<&[u8]>, home: &[u8]) -> Adoption {
    let refuse = |field: String| Adoption { bytes: None, refused: Some(field) };
    let copy = match opencode_entries(home) {
        Ok(copy) => copy,
        Err(field) => return refuse(field),
    };
    let Some(stored) = stored.and_then(|s| opencode_entries(s).ok()) else {
        return refuse(copy.keys().next().map(|n| short(n)).unwrap_or_else(|| "auth.json".to_string()));
    };
    let mut merged = stored.clone();
    let mut refused = None;
    for (name, entry) in &copy {
        let Some(held) = stored.get(name) else {
            refused.get_or_insert_with(|| short(name));
            continue;
        };
        let oauth = held.get("type").and_then(|t| t.as_str()) == Some("oauth");
        let fixed = ["type", "accountId", "enterpriseUrl"];
        if !oauth || fixed.iter().any(|f| held.get(f) != entry.get(f)) {
            if held != entry {
                refused.get_or_insert_with(|| short(name));
            }
            continue;
        }
        if let Some(target) = merged.get_mut(name).and_then(|m| m.as_object_mut()) {
            for token in ["refresh", "access", "expires"] {
                if let Some(value) = entry.get(token) {
                    target.insert(token.to_string(), value.clone());
                }
            }
        }
    }
    let bytes = (merged != stored).then(|| serde_json::to_vec_pretty(&merged).ok()).flatten();
    Adoption { bytes, refused }
}

fn adoption_of(cli: &str, stored: Option<&[u8]>, home: &[u8]) -> Adoption {
    match cli {
        "opencode" => opencode_adoption(stored, home),
        _ => Adoption { bytes: Some(home.to_vec()), refused: None },
    }
}

/// `bytes`, the user's own login file for `cli`, as the store may take it at
/// an import. OpenCode's keeps the entries that pass [`admissible`] (the
/// user's own `wellknown` entry stays on this computer); nothing left is an
/// error. Other CLIs are taken as they are.
fn importable(cli: &str, bytes: Vec<u8>) -> Result<Vec<u8>, String> {
    if cli != "opencode" {
        return Ok(bytes);
    }
    let serde_json::Value::Object(entries) = serde_json::from_slice(&bytes).map_err(|_| "that file is not a JSON object".to_string())? else {
        return Err("that file is not a JSON object".to_string());
    };
    let total = entries.len();
    let kept: serde_json::Map<String, serde_json::Value> =
        entries.into_iter().filter(|(name, entry)| opencode_entry_admissible(name, entry).is_ok()).collect();
    if kept.is_empty() {
        return Err("that file holds no plain api or oauth login entry (an entry that names a remote configuration is not shared)".to_string());
    }
    if kept.len() == total {
        return Ok(bytes);
    }
    serde_json::to_vec_pretty(&kept).map_err(|e| e.to_string())
}

fn write_blocked(store_dir: &Path, blocked: &Blocked) {
    if let Ok(body) = serde_json::to_vec(blocked) {
        let _ = write_store(&store_dir.join(BLOCKED_FILE), &body);
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
    let Adoption { bytes: taken, refused } = adoption_of(cli, content(std::fs::read(store).ok()).as_deref(), bytes);
    let Some(taken) = taken else {
        if let Some(field) = refused {
            eprintln!("agent_auth: {cli}: a tab's login brings more than a token refresh at {field}; not adopted");
            write_blocked(store_dir, &Blocked { config: Some(field), ..Blocked::default() });
        }
        return false;
    };
    if let Err(e) = write_store(store, &taken) {
        eprintln!("agent_auth: {cli}: store {}: {e}", store.display());
        return false;
    }
    if let Some(account) = account {
        let _ = write_store(&store_dir.join(ACCOUNT_FILE), account.as_bytes());
    }
    let _ = std::fs::remove_file(store_dir.join(BLOCKED_FILE));
    if let Some(field) = refused {
        eprintln!("agent_auth: {cli}: a tab's login brings more than a token refresh at {field}; only the refresh was adopted");
        write_blocked(store_dir, &Blocked { config: Some(field), ..Blocked::default() });
    }
    true
}

/// Which half of a reconciliation runs. A pass over every home adopts from
/// all of them first and places into all of them after, so a login made in
/// any home reaches every other in the same pass whatever the order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
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
///
/// Answers whether the pair is *settled*: the home holds the store's bytes
/// (or neither exists) and this call wrote nothing. Only a settled pair may be
/// skipped by [`reconcile_file`]'s stat gate — a pending or refused adoption
/// also depends on the home's account file, so it is looked at again each pass.
fn reconcile_file_now(
    cli: &str,
    store_dir: &Path,
    store: &Path,
    leaf: &str,
    home: &Path,
    copy: &HomeFile,
    step: Step,
) -> bool {
    #[cfg(test)]
    FULL_PASSES.with(|n| n.set(n.get() + 1));
    let home_bytes = content(copy.read());
    // A store file that fails its CLI's content check is never placed.
    let store_bytes = content(std::fs::read(store).ok()).filter(|b| admissible(cli, b).is_ok());
    let receive_only = crate::services::agent_home::is_local_model_home(home);
    if receive_only
        && home_bytes.as_ref().is_some_and(|b| {
            store_bytes.as_ref() != Some(b)
                && read_placed(store_dir, home, leaf).as_deref() != Some(crate::digest::sha256_hex(b).as_str())
        })
    {
        // Held back, not settled: looked at again each pass.
        return false;
    }
    if let (Some(bytes), true, false) = (&home_bytes, step.adopts(), receive_only) {
        let hash = crate::digest::sha256_hex(bytes);
        let placed = read_placed(store_dir, home, leaf);
        let changed = placed.as_deref() != Some(hash.as_str()) && store_bytes.as_deref() != Some(bytes.as_slice());
        if changed && adopt(cli, store_dir, store, home, bytes) {
            write_placed(store_dir, home, leaf, &hash);
            return false;
        }
    }
    if !step.places() {
        return home_bytes == store_bytes;
    }
    let Some(bytes) = store_bytes else {
        // Nothing to put over a copy that fails the content check: move it
        // aside, so the CLI never loads it.
        if !receive_only && home_bytes.as_ref().is_some_and(|b| admissible(cli, b).is_err()) {
            move_aside(cli, copy);
            return false;
        }
        return home_bytes.is_none();
    };
    let hash = crate::digest::sha256_hex(&bytes);
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
        false
    } else if read_placed(store_dir, home, leaf).as_deref() != Some(hash.as_str()) {
        write_placed(store_dir, home, leaf, &hash);
        false
    } else {
        true
    }
}

/// What a `stat` says about one of the three files a pair is made of. Any
/// write, truncate, replace-by-rename or removal moves at least one field.
#[derive(Clone, Debug, PartialEq, Eq)]
struct FileStamp {
    len: u64,
    modified: Option<std::time::SystemTime>,
    /// `(device, inode, ctime)` on unix: a rename onto the path moves the
    /// inode, and ctime moves even when a writer restores mtime.
    identity: Option<(u64, u64, i64, i64)>,
}

fn file_stamp(path: &Path) -> Option<FileStamp> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        Some((meta.dev(), meta.ino(), meta.ctime(), meta.ctime_nsec()))
    };
    #[cfg(not(unix))]
    let identity = None;
    Some(FileStamp { len: meta.len(), modified: meta.modified().ok(), identity })
}

/// The stamps of a pair: the home's copy, the store's file, the placed sidecar.
type PairStamp = [Option<FileStamp>; 3];

fn pair_stamp(store_dir: &Path, store: &Path, leaf: &str, home: &Path, copy: &HomeFile) -> PairStamp {
    [file_stamp(&copy.path()), file_stamp(store), file_stamp(&placed_file(store_dir, home, leaf))]
}

/// A file touched this recently may be rewritten again inside the same
/// timestamp tick on a coarse filesystem, with the same length (a refreshed
/// token usually is): such a stamp proves nothing yet, so it is not trusted.
const STAMP_SETTLE: Duration = Duration::from_secs(3);

fn stamp_is_trustworthy(stamp: &PairStamp, now: std::time::SystemTime) -> bool {
    stamp.iter().flatten().all(|file| {
        file.modified
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age >= STAMP_SETTLE)
    })
}

/// The pairs last seen settled, by home copy, store file and step.
type SettledPairs = std::collections::HashMap<(PathBuf, PathBuf, Step), PairStamp>;

fn settled_pairs() -> &'static Mutex<SettledPairs> {
    static SETTLED: OnceLock<Mutex<SettledPairs>> = OnceLock::new();
    SETTLED.get_or_init(Default::default)
}

/// Homes come and go; past this many remembered pairs the gate starts over
/// (one full pass re-learns it).
const SETTLED_CAP: usize = 4096;

#[cfg(test)]
thread_local! {
    /// Full (read + hash) reconciles run on this thread, for the gate's tests.
    static FULL_PASSES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// [`reconcile_file_now`] behind a stat gate. The keeper visits every home ×
/// CLI × path every [`POLL`], forever; reading and SHA-256ing both sides each
/// time was its whole cost. A pair that was settled and whose three files
/// still `stat` exactly as they did then cannot need anything, so it is
/// skipped without a read. Everything else — a changed size, mtime, ctime or
/// inode on either side, a missing or new file, a pair never seen settled, a
/// file touched within [`STAMP_SETTLE`] — takes the full path as before.
fn reconcile_file(cli: &str, store_dir: &Path, store: &Path, leaf: &str, home: &Path, copy: &HomeFile, step: Step) {
    let key = (copy.path(), store.to_path_buf(), step);
    let before = pair_stamp(store_dir, store, leaf, home, copy);
    {
        let settled = settled_pairs().lock_ok();
        if settled.get(&key) == Some(&before) {
            return;
        }
    }
    let settled_now = reconcile_file_now(cli, store_dir, store, leaf, home, copy, step);
    let after = pair_stamp(store_dir, store, leaf, home, copy);
    let mut settled = settled_pairs().lock_ok();
    // `after == before`: nothing was written under the full pass, by it or by
    // a tab, so `after` is the stamp of exactly the bytes it compared.
    if settled_now && after == before && stamp_is_trustworthy(&after, std::time::SystemTime::now()) {
        if settled.len() >= SETTLED_CAP {
            settled.clear();
        }
        settled.insert(key, after);
    } else {
        settled.remove(&key);
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
    // The store and the homes are shared by every process on this state dir
    // (the window, its desktop sidecar, a server's daemon and its shell
    // shims): one adopt/place at a time, or two could each adopt a different
    // refresh and place the older one, or leave a login half-removed beside
    // the administrator's key (final review B4).
    // No pass without the lock: a later pass (the keeper's next poll, the
    // next spawn) retries, where an unguarded one could place a stale login.
    let _one_at_a_time = match storage::FileLock::exclusive(&store_root_in(state_dir)) {
        Ok(lock) => lock,
        Err(e) => {
            eprintln!("agent_auth: lock {}: {e}; skipping this reconcile", store_root_in(state_dir).display());
            return;
        }
    };
    reconcile_home_with(state_dir, home, step, &crate::services::server::agent_keys::holds_admin_key);
}

/// Whether a login file holds the administrator's current key for a CLI
/// (`services::server::agent_keys::holds_admin_key`); `None`: unknown.
type HoldsAdminKey = dyn Fn(&str, &[u8]) -> Option<bool>;

fn reconcile_home_with(state_dir: &Path, home: &Path, step: Step, holds_key: &HoldsAdminKey) {
    let on_admin_key = crate::services::server::agent_keys::chosen_in(state_dir);
    for (cli, paths) in registry() {
        let store_dir = store_dir_in(state_dir, cli);
        if on_admin_key.contains(cli) {
            beside_admin_key(cli, state_dir, &store_dir, paths, home, step, holds_key);
            continue;
        }
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

/// A CLI this user runs on the administrator's API key (hosted plan §5.2,
/// "never both"): the home keeps none of the user's own login for it, so the
/// CLI never picks between the environment key and a login file. The store
/// keeps the login; switching back places it again.
///
/// A login a tab wrote all the same — a tab from before the switch
/// refreshing its token, a `/login` in the tab — is still adopted first, so
/// a rotated refresh token is not lost; but never a file holding the
/// administrator's key (a CLI that saved the key it was handed): the
/// administrator's key never becomes the user's own login. When that cannot
/// be told (the keeper unreachable, the key withdrawn), the written file is
/// neither adopted nor removed — it stays in the home until it can be told:
/// removing it would lose the only copy of a rotated refresh token, and no
/// new agent runs beside it meanwhile, since the same keeper answer fails
/// the next spawn (`agent_keys::inject_env`). Only single-file logins are
/// adopted here (every CLI that can take a key keeps one).
fn beside_admin_key(cli: &str, state_dir: &Path, store_dir: &Path, paths: &[AuthPath], home: &Path, step: Step, holds_key: &HoldsAdminKey) {
    // The bytes of a login file a tab wrote since the store last placed one.
    let written = |path: &AuthPath| -> Option<Vec<u8>> {
        let bytes = content(HomeFile::open_existing(home, path.rel)?.read())?;
        let unchanged = read_placed(store_dir, home, &leaf_of(path.rel)).as_deref() == Some(crate::digest::sha256_hex(&bytes).as_str())
            || content(std::fs::read(store_path_in(state_dir, cli, path)).ok()).as_deref() == Some(bytes.as_slice());
        (!unchanged).then_some(bytes)
    };
    let files = || paths.iter().filter(|p| p.kind == AuthKind::File);
    if step.adopts() {
        for path in files() {
            let Some(bytes) = written(path) else { continue };
            let store = store_path_in(state_dir, cli, path);
            if holds_key(cli, &bytes) == Some(false) && adopt(cli, store_dir, &store, home, &bytes) {
                write_placed(store_dir, home, &leaf_of(path.rel), &crate::digest::sha256_hex(&bytes));
            }
        }
    }
    if step.places() {
        let undecided: Vec<&str> = files()
            .filter(|path| written(path).is_some_and(|bytes| holds_key(cli, &bytes).is_none()))
            .map(|path| path.rel)
            .collect();
        let leave: Vec<AuthPath> = paths.iter().filter(|p| !undecided.contains(&p.rel)).copied().collect();
        remove_copies(home, &leave);
        if cli == "claude" {
            if let Some(file) = HomeFile::open_existing(home, ".claude.json") {
                strip_claude_identity(&file);
            }
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
    match (home_account, &stored) {
        // The home is signed in: record its identity unless it is another
        // account, or the home is a receive-only local-model one.
        (Some(account), _)
            if stored_account.as_deref().is_none_or(|s| s == account)
                && !crate::services::agent_home::is_local_model_home(home) =>
        {
            let mut keys = crate::services::agent_home::filtered_claude_json(&value, &[]);
            keys.as_object_mut().map(|o| o.remove("projects"));
            // This runs every keeper pass, and a store write is synced (and on
            // Windows ACL'd): only what changed is written.
            if stored.as_ref() != Some(&keys) {
                if let Ok(body) = serde_json::to_vec(&keys) {
                    let _ = write_store(&identity, &body);
                }
            }
            if stored_account.is_none() {
                let _ = write_store(&store_dir.join(ACCOUNT_FILE), account.as_bytes());
            }
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
    /// The key keeper offers this CLI and the API proxy serves it. Own-key
    /// support alone (Codex) does not enable administrator key management.
    pub admin_key_capable: bool,
    /// A hosted server's administrator offers an API key for this CLI.
    pub admin_key_offered: bool,
    /// This user's agents run on the administrator's key for this CLI, not
    /// on their own login (hosted plan §5.2).
    pub uses_admin_key: bool,
    /// The CLI is switched on for a stored provider API key and one of its
    /// providers has one (`services::agent_api_keys`). Filled by the
    /// `agent_logins` command, never here: this module stays keyring-free.
    pub api_key: bool,
    /// Of an `api_key` CLI: its provider's monthly budget is spent, or no
    /// limit is set, so its keyed tabs are refused (`services::api_usage`).
    /// Filled by the `agent_logins` command too, for `api_key_saved` CLIs as
    /// well.
    pub api_budget_reached: bool,
    /// A stored provider API key could run this CLI, switched on or not: the
    /// ＋ menu's API section offers it (`agent_api_keys::keyable_clis`).
    /// Filled by the `agent_logins` command.
    pub api_key_saved: bool,
    /// Of OpenCode: the scopes whose own database holds a `wellknown` source
    /// the startup sweep found ([`sweep_unadmissible_in`]); each can be
    /// signed out ([`sign_out_scope_in`]). Empty for every other CLI.
    pub wellknown_homes: Vec<WellknownHome>,
}

/// A home whose OpenCode database took a `wellknown` source: it fetches that
/// origin's remote configuration at every start.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WellknownHome {
    /// The home's directory name (a scope's key; `host` for the Host session).
    pub key: String,
    /// The scope's project name, filled where the registry names it.
    #[serde(default)]
    pub label: Option<String>,
    /// The origins it took, as written (at most a few).
    pub origins: Vec<String>,
}

pub fn status_in(state_dir: &Path, user_home: &Path) -> Vec<LoginStatus> {
    status_with(state_dir, user_home, &BTreeSet::new())
}

/// [`status_in`] with the CLIs a hosted server's administrator offers a key
/// for (`services::server::agent_keys::offered`).
pub fn status_with(state_dir: &Path, user_home: &Path, offered: &BTreeSet<String>) -> Vec<LoginStatus> {
    let on_admin_key = crate::services::server::agent_keys::chosen_in(state_dir);
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
                .filter(|b| b.account.is_some() || b.command.is_some() || b.config.is_some());
            LoginStatus {
                id: cli.to_string(),
                signed_in,
                account: read_sidecar(&store_dir, ACCOUNT_FILE),
                importable,
                blocked,
                shared: !paths.is_empty(),
                admin_key_capable: crate::services::server::keys_wire::KEY_CLIS.contains(&cli)
                    && crate::services::agent_api_keys::proxies(cli),
                admin_key_offered: offered.contains(cli),
                uses_admin_key: on_admin_key.contains(cli),
                api_key: false,
                api_budget_reached: false,
                api_key_saved: false,
                wellknown_homes: if cli == "opencode" { read_wellknown_homes(&store_dir) } else { Vec::new() },
            }
        })
        .collect()
}

/// The login rows. A key broker's month for a CLI on the administrator's
/// key is in the API-key status (`agent_api_keys::status`), beside the one
/// credential choice per CLI (#2389).
pub fn status() -> Vec<LoginStatus> {
    let mut logins =
        status_with(&storage::state_dir(), &crate::paths::home_dir(), &crate::services::server::agent_keys::offered());
    if logins.iter().any(|l| !l.wellknown_homes.is_empty()) {
        let projects = crate::services::remote::projects().unwrap_or_default();
        for home in logins.iter_mut().flat_map(|l| l.wellknown_homes.iter_mut()) {
            home.label = projects.iter().find(|p| storage::project_key(&p.id) == home.key).map(|p| p.name.clone());
        }
    }
    logins
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
                let bytes = importable(cli, bytes).map_err(|e| format!("{}: {e}", src.display()))?;
                write_store(&store, &bytes).map_err(|e| format!("{}: {e}", store.display()))?;
                if let Some(account) = account_of(cli, &bytes) {
                    let _ = write_store(&store_dir.join(ACCOUNT_FILE), account.as_bytes());
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
                let _ = write_store(&store_dir.join(ACCOUNT_FILE), account.as_bytes());
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
/// - The Host home (unfenced) has its copy of a retired file renamed aside
///   to `<name>.pre-scope` ([`PRE_SCOPE_SUFFIX`]) where the bytes are the
///   store's current ones or the ones the store last placed there — that
///   is, Tabtivity put it there, from whichever scope, or adopted it from
///   the Host session itself (the two leave the same record). Nothing is
///   deleted: a login or settings the user made there survive under the
///   new name. A copy that differs from both is the Host session's own
///   write and stays where it is.
/// - Then the CLI's store directory goes, with its records (kept when the
///   rename failed, so the next start can tell again).
/// - In a login directory, every store file the allowlist no longer admits
///   goes, and a home's copy of such a name is renamed aside the same way
///   only where it still matches what the store placed in that home.
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
                let hash = crate::digest::sha256_hex(&bytes);
                let ours = std::fs::read(store_dir.join(&leaf)).is_ok_and(|s| crate::digest::sha256_hex(&s) == hash)
                    || read_placed(&store_dir, &host, &leaf).as_deref() == Some(hash.as_str());
                if ours && !move_aside(cli, &copy) {
                    // Keep the store so the next start can tell again.
                    continue;
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

/// What a retired home copy is renamed to, in its own directory:
/// `<name>.pre-scope` (then `.1`, `.2`, … when taken). No CLI loads such a
/// name and no [`DirNames`] admits it, so the keeper neither adopts nor
/// places it; the user's own settings in it survive for them to copy back.
const PRE_SCOPE_SUFFIX: &str = ".pre-scope";

/// Rename a home copy aside ([`PRE_SCOPE_SUFFIX`]) instead of deleting it.
/// Logs one line either way; `false` when it could not be moved.
fn move_aside(cli: &str, copy: &HomeFile) -> bool {
    match copy.rename_aside(PRE_SCOPE_SUFFIX) {
        Ok(to) => {
            eprintln!("agent_auth: {cli}: no longer shared, moved {} aside to {to}", copy.path().display());
            true
        }
        Err(e) => {
            eprintln!("agent_auth: {cli}: move {} aside: {e}", copy.path().display());
            false
        }
    }
}

pub fn retire_shared_paths() {
    retire_shared_paths_in(&storage::state_dir());
}

/// The CLIs whose login file has a content check ([`admissible`]).
const CHECKED: &[&str] = &["opencode"];

/// The most of a login file the sweep reads: more is not a login.
const LOGIN_FILE_CAP: u64 = 1 << 20;

/// Sidecar in OpenCode's store dir naming the homes whose database holds a
/// `wellknown` source ([`WellknownHome`]s, as JSON).
const WELLKNOWN_FILE: &str = ".wellknown";

fn read_for_check(file: &HomeFile) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut bytes = Vec::new();
    file.open_read()?.take(LOGIN_FILE_CAP + 1).read_to_end(&mut bytes).ok()?;
    Some(bytes)
}

/// Move a store file aside to `<name>.pre-scope` (`.1`, `.2`, … when taken).
fn move_store_aside(path: &Path) -> io::Result<()> {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    for n in 0..1000u32 {
        let aside = if n == 0 { format!("{name}{PRE_SCOPE_SUFFIX}") } else { format!("{name}{PRE_SCOPE_SUFFIX}.{n}") };
        let to = path.with_file_name(aside);
        if std::fs::symlink_metadata(&to).is_err() {
            return std::fs::rename(path, to);
        }
    }
    Err(io::Error::new(io::ErrorKind::AlreadyExists, "no free name to move the file aside to"))
}

/// At startup (window and sidecar, before the keeper and any spawn): every
/// login file of a CLI with a content check ([`CHECKED`]) that fails it is
/// moved aside to `<name>.pre-scope` — the store's copy and every home's, the
/// Host and assistant homes and the local-model homes included. Nothing is
/// deleted. A moved-aside store means signed out until the user imports
/// again; a home's copy is then replaced by the store's. Idempotent. The database half is [`flag_wellknown_databases_in`].
pub fn sweep_unadmissible_in(state_dir: &Path) {
    let _one_at_a_time = match storage::FileLock::exclusive(&store_root_in(state_dir)) {
        Ok(lock) => lock,
        Err(e) => {
            eprintln!("agent_auth: lock {}: {e}; skipping the content sweep", store_root_in(state_dir).display());
            return;
        }
    };
    let homes = crate::services::agent_home::existing_homes_in(state_dir);
    for (cli, paths) in registry().into_iter().filter(|(cli, _)| CHECKED.contains(cli)) {
        for path in paths.iter().filter(|p| p.kind == AuthKind::File) {
            let store = store_path_in(state_dir, cli, path);
            if std::fs::read(&store).ok().and_then(|b| content(Some(b))).is_some_and(|b| admissible(cli, &b).is_err()) {
                match move_store_aside(&store) {
                    Ok(()) => eprintln!("agent_auth: {cli}: the stored login fails its content check; moved {} aside", store.display()),
                    Err(e) => eprintln!("agent_auth: {cli}: move {} aside: {e}", store.display()),
                }
            }
            for home in &homes {
                let Some(copy) = HomeFile::open_existing(home, path.rel) else { continue };
                if read_for_check(&copy).and_then(|b| content(Some(b))).is_some_and(|b| admissible(cli, &b).is_err()) {
                    move_aside(cli, &copy);
                }
            }
        }
    }
}

/// [`sweep_unadmissible_in`] against the real state dir, then — off the
/// calling thread, since a database can be large — [`flag_wellknown_databases_in`].
pub fn sweep_unadmissible() {
    let state_dir = storage::state_dir();
    sweep_unadmissible_in(&state_dir);
    if let Err(e) = std::thread::Builder::new()
        .name("agent-auth-wellknown".into())
        .spawn(move || flag_wellknown_databases_in(&state_dir))
    {
        eprintln!("agent_auth: spawn the wellknown scan: {e}");
    }
}

/// The homes whose OpenCode database holds a `wellknown` source, as the
/// last scan left them ([`WELLKNOWN_FILE`]).
fn read_wellknown_homes(store_dir: &Path) -> Vec<WellknownHome> {
    std::fs::read(store_dir.join(WELLKNOWN_FILE))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn write_wellknown_homes(store_dir: &Path, homes: &[WellknownHome]) {
    let path = store_dir.join(WELLKNOWN_FILE);
    if homes.is_empty() {
        let _ = std::fs::remove_file(path);
    } else if let Ok(body) = serde_json::to_vec(homes) {
        let _ = write_store(&path, &body);
    }
}

/// Scan every home's OpenCode database for a `wellknown` source (OpenCode 2
/// imports one from a legacy `auth.json` once, then loads that origin's
/// remote configuration at every start) and record the homes that hold one,
/// for the Agents view to offer [`sign_out_scope_in`]. Reads each database
/// strictly read-only through `agent_sqlite`.
pub fn flag_wellknown_databases_in(state_dir: &Path) {
    let flagged: Vec<WellknownHome> = crate::services::agent_home::existing_homes_in(state_dir)
        .into_iter()
        .filter_map(|home| {
            let origins = crate::services::opencode_store::wellknown_sources_in(&home)?;
            Some(WellknownHome { key: home_key(&home), label: None, origins })
        })
        .collect();
    let store_dir = store_dir_in(state_dir, "opencode");
    if flagged.is_empty() && !store_dir.join(WELLKNOWN_FILE).exists() {
        return;
    }
    if !flagged.is_empty() {
        eprintln!("agent_auth: opencode: {} home(s) hold a wellknown source (remote configuration)", flagged.len());
    }
    write_wellknown_homes(&store_dir, &flagged);
}

/// Sign OpenCode out of one scope the sweep flagged: that home's database
/// (with its write-ahead log) is moved aside to `<name>.pre-scope`, so the
/// next OpenCode there starts clean — no `wellknown` source, no cached remote
/// configuration — and its session list starts empty. The shared login
/// reaches it again from the store. Refused for a scope the sweep did not flag.
pub fn sign_out_scope_in(state_dir: &Path, key: &str) -> Result<(), String> {
    let store_dir = store_dir_in(state_dir, "opencode");
    let mut flagged = read_wellknown_homes(&store_dir);
    if !flagged.iter().any(|h| h.key == key) {
        return Err("that scope's OpenCode is not flagged".to_string());
    }
    let home = crate::services::agent_home::existing_homes_in(state_dir)
        .into_iter()
        .find(|h| home_key(h) == key)
        .ok_or_else(|| "that scope has no home".to_string())?;
    // The log and the shared-memory file first: a database moved away from
    // its log would let a new database inherit it.
    for name in ["opencode.db-wal", "opencode.db-shm", "opencode.db"] {
        let rel = format!(".local/share/opencode/{name}");
        let Some(file) = HomeFile::open_existing(&home, &rel) else { continue };
        if file.metadata().is_some() {
            file.rename_aside(PRE_SCOPE_SUFFIX).map_err(|e| format!("{name}: {e}"))?;
        }
    }
    flagged.retain(|h| h.key != key);
    write_wellknown_homes(&store_dir, &flagged);
    Ok(())
}

pub fn sign_out_scope(key: &str) -> Result<(), String> {
    sign_out_scope_in(&storage::state_dir(), key)
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
            if copy.read().is_some_and(|b| crate::digest::sha256_hex(&b) == placed) {
                move_aside(cli, &copy);
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
    let _guard = keeper_lock().lock_ok();
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
mod tests;
