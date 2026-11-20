//! Per-turn checkpoints (`docs/turn_checkpoints_plan.md`,
//! `docs/context/checkpoints.md`): a snapshot of an agent tab's folder as each
//! turn begins and ends, and a way to put files back.
//!
//! - [`store`]: one git object store per folder under
//!   `<state_dir>/checkpoints/<key>/`, never the folder's own `.git`, never
//!   mounted into a fence (the fence masks the whole state dir).
//! - [`snapshot`]: tracked + untracked files, not the ignored ones.
//! - [`restore`]: the diff since a checkpoint and the restore, with its own undo.
//! - [`install`]: a restore's writes and removals in the folder, through
//!   directory handles that follow no link (a folder swapped for a link fails
//!   that path; nothing lands outside the folder).
//! - this module: the tab → folder bindings, the triggers (`agent_turn`'s
//!   transitions), the per-folder serial worker, retention and the settings.
//!
//! AppHandle-free. Every snapshot runs on a worker thread, never under
//! `agent_turn`'s locks.

pub mod install;
pub mod restore;
pub mod snapshot;
pub mod store;
pub mod worker;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use app_core::sync::LockExt;
use serde::{Deserialize, Serialize};

use crate::services::agent_turn::TurnState;
pub use restore::{Restored, Since};
pub use snapshot::Who;
pub use store::{Kind, Row, Store};

/// The event a finished snapshot is announced with: `{ uid, id, kind }`.
pub const EVENT: &str = "checkpoint-added";

/// Checkpoints kept per folder, and for how long.
pub const MAX_ROWS: usize = 300;
pub const KEEP_MS: u64 = 14 * 24 * 60 * 60 * 1000;
/// A `pre-restore` row is not pruned for the count cap this long.
pub const PRE_RESTORE_KEEP_MS: u64 = 7 * 24 * 60 * 60 * 1000;
/// Refs dropped before the store is repacked.
const GC_AFTER: u32 = 50;
/// Rows a list answers.
const LIST_ROWS: usize = 200;

/// A folder's store past this many bytes drops its oldest checkpoints, a
/// quarter at a time with a repack in between, until it fits.
pub const MAX_STORE_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
struct AddedPayload {
    uid: String,
    id: String,
    kind: Kind,
    /// The snapshot failed (`id` is empty): why.
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

// ── Git version ───────────────────────────────────────────────────────────

/// The oldest git the store runs on. 2.40 brought `attr.tree`, which keeps the
/// folder's own `.gitattributes` (filters, `eol`, `ident`, encodings) from
/// touching what is stored or restored; 2.32 brought `GIT_CONFIG_GLOBAL`, which
/// keeps the user's global config (a Git LFS filter) out. An older git would
/// silently store something other than the bytes on disk, so it gets none.
pub const MIN_GIT: (u32, u32) = (2, 40);
/// How long a probe of the local git's version is trusted (an upgrade while
/// the app runs is picked up after this).
const GIT_PROBE_TTL: Duration = Duration::from_secs(60);

/// Whether a git of `version` may run checkpoints. Pure.
pub fn git_supported_by(version: Option<(u32, u32)>) -> bool {
    version.is_some_and(|v| v >= MIN_GIT)
}

/// A probe of the local git: when, and the `(major, minor)` it found.
type GitProbe = (Instant, Option<(u32, u32)>);

/// The local git's version, probed at most once per [`GIT_PROBE_TTL`].
fn git_version() -> Option<(u32, u32)> {
    static CACHE: OnceLock<Mutex<Option<GitProbe>>> = OnceLock::new();
    let mut cache = CACHE.get_or_init(|| Mutex::new(None)).lock_ok();
    if let Some((at, version)) = *cache {
        if at.elapsed() < GIT_PROBE_TTL {
            return version;
        }
    }
    let version = crate::services::git_hardened::local_git_version_blocking();
    *cache = Some((Instant::now(), version));
    version
}

/// Why checkpoints can't run on a git of `version`, or `None`.
pub fn git_refusal(version: Option<(u32, u32)>) -> Option<String> {
    if git_supported_by(version) {
        return None;
    }
    let (major, minor) = MIN_GIT;
    Some(match version {
        Some((have_major, have_minor)) => {
            format!("checkpoints need git {major}.{minor} or later; this git is {have_major}.{have_minor}")
        }
        None => format!("checkpoints need git {major}.{minor} or later; no git was found"),
    })
}

/// Checkpoints are on and the local git can run them.
fn ready() -> Result<(), String> {
    if !capturing_in(&state_root()) {
        return Err("checkpoints are off".into());
    }
    git_refusal(git_version()).map_or(Ok(()), Err)
}

// ── Settings ──────────────────────────────────────────────────────────────

/// `<state_dir>/checkpoints.json`. Off until the user turns it on: capture
/// happens in the backend, so the switch lives there, not in the window.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    #[serde(default)]
    enabled: bool,
}

fn settings_path(state_dir: &Path) -> PathBuf {
    state_dir.join("checkpoints.json")
}

/// Whether the backend switch is on. A missing or unreadable file reads as off.
pub fn enabled_in(state_dir: &Path) -> bool {
    crate::storage::read_json::<Settings>(&settings_path(state_dir)).map(|s| s.enabled).unwrap_or(false)
}

/// Whether checkpoints are taken: the backend switch and the window's
/// experimental flag (`settings.json` `turn_checkpoints`, by the experiments'
/// own rule) are both on. The card sets both in one click; when they disagree
/// (an edited `settings.json`, a profile whose flag went off elsewhere) none
/// are taken, so nothing is captured that the window does not show.
pub fn capturing_in(state_dir: &Path) -> bool {
    enabled_in(state_dir)
        && crate::storage::read_json::<crate::schema::Settings>(&state_dir.join("settings.json"))
            .is_ok_and(|s| s.turn_checkpoints())
}

/// [`set_enabled_in`], refusing to turn checkpoints on over a git of
/// `version` that can't run them. Turning them off always works.
pub fn set_enabled_checked_in(state_dir: &Path, enabled: bool, version: Option<(u32, u32)>) -> Result<(), String> {
    if enabled {
        if let Some(refusal) = git_refusal(version) {
            return Err(refusal);
        }
    }
    set_enabled_in(state_dir, enabled)
}

/// Turn checkpoints on or off for the local git (`checkpoint_settings_set`).
pub fn set_enabled(enabled: bool) -> Result<(), String> {
    set_enabled_checked_in(&state_root(), enabled, git_version())
}

pub fn set_enabled_in(state_dir: &Path, enabled: bool) -> Result<(), String> {
    crate::storage::patch_json(&settings_path(state_dir), Settings::default(), |s| {
        s.enabled = enabled;
        Ok(())
    })
}

fn state_root() -> PathBuf {
    crate::storage::state_dir()
}

fn root() -> PathBuf {
    store::root_in(&state_root())
}

// ── Which tab, which folder ───────────────────────────────────────────────

#[derive(Debug, Clone)]
struct Bound {
    folder: PathBuf,
    project_id: String,
    cli: String,
    /// What the window names the tab by ([`bind`]'s answer): random, minted
    /// per launch, handed to the window in `pty_spawn`'s answer and never put
    /// in the agent's environment. The launch uid is in it (`TAB_UID`), so the
    /// uid alone is never taken as the caller's say-so.
    key: String,
    /// The tab's hooks have reported a turn (this launch, or the previous
    /// run's record): a missing turn state then means idle, not unknown.
    turns_known: bool,
}

fn bindings() -> &'static Mutex<HashMap<String, Bound>> {
    static B: OnceLock<Mutex<HashMap<String, Bound>>> = OnceLock::new();
    B.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The folder a tab launched in `cwd` is checkpointed as: the project root
/// (or box member root) containing it, or the linked worktree it sits in
/// (`<root>/<worktrees dir>/<name>`, a folder of its own). `roots` come from
/// `projects.json` / `boxes.json` (`agent_fence::roots_for_scope`), never from
/// the tab. `None` when `cwd` is in none of them.
pub fn resolve_folder(roots: &[PathBuf], cwd: &Path) -> Option<PathBuf> {
    let cwd = cwd.canonicalize().ok()?;
    let mut best: Option<PathBuf> = None;
    for root in roots {
        let Ok(root) = root.canonicalize() else { continue };
        if cwd.starts_with(&root)
            && best.as_ref().is_none_or(|b| root.components().count() > b.components().count())
        {
            best = Some(root);
        }
    }
    let root = best?;
    let worktrees = crate::brand::WORKTREES_DIR.split('/').fold(root.clone(), |path, seg| path.join(seg));
    if let Ok(rest) = cwd.strip_prefix(&worktrees) {
        if let Some(first) = rest.components().next() {
            let dir = worktrees.join(first);
            if std::fs::symlink_metadata(&dir).is_ok_and(|m| m.is_dir()) {
                return Some(dir);
            }
        }
    }
    Some(root)
}

/// Folders a store must never be made for: a filesystem root, the home
/// folder, or any folder holding the state dir (the store would snapshot
/// itself).
pub fn unsuitable(folder: &Path, state_dir: &Path) -> bool {
    let state = state_dir.canonicalize().unwrap_or_else(|_| state_dir.to_path_buf());
    folder.parent().is_none()
        || state.starts_with(folder)
        || crate::paths::home_dir().canonicalize().is_ok_and(|home| home == folder)
}

/// Remember that agent tab `uid`, launched in `cwd` of project `project_id`,
/// is checkpointed as the folder `roots` put it in; the key the window names
/// it by from now on (see [`Bound::key`]). `roots`: `None` for a launch that
/// gets no checkpoints (remote project, the root console's Host session, the
/// assistant): the tab is unbound and there is no key. `turns_known`: the
/// previous run's turn record showed the tab's hooks work
/// (`agent_turn::bind_tab`'s answer). Called by `launch_prep` beside
/// `agent_turn::bind_tab`.
pub fn bind(
    uid: &str,
    cwd: &str,
    project_id: Option<&str>,
    cmd: &str,
    roots: Option<&[PathBuf]>,
    turns_known: bool,
) -> Option<String> {
    let bound = (|| {
        let (project_id, roots) = (project_id?, roots?);
        if crate::storage::is_reserved_scope(project_id) {
            return None;
        }
        let folder = resolve_folder(roots, Path::new(cwd))?;
        (!unsuitable(&folder, &state_root())).then(|| Bound {
            folder,
            project_id: project_id.to_string(),
            cli: crate::services::agent_fence::basename(cmd).to_string(),
            key: new_key(),
            turns_known,
        })
    })();
    let mut map = bindings().lock_ok();
    match bound {
        Some(b) => {
            let key = b.key.clone();
            map.insert(uid.to_string(), b);
            Some(key)
        }
        None => {
            map.remove(uid);
            None
        }
    }
}

/// 128 random bits as hex.
fn new_key() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::fill(&mut bytes).is_err() {
        // No randomness: no key anyone could guess either; the tab gets none
        // that matches (`by_key` refuses an empty one).
        return String::new();
    }
    crate::digest::hex(&bytes)
}

/// Forget a tab that is gone.
pub fn unbind(uid: &str) {
    bindings().lock_ok().remove(uid);
}

const NO_CHECKPOINTS: &str = "this tab has no checkpoints (a remote, root or assistant tab, or its folder is not a project's)";

fn bound(uid: &str) -> Result<Bound, String> {
    bindings().lock_ok().get(uid).cloned().ok_or_else(|| NO_CHECKPOINTS.to_string())
}

/// The tab the window's `key` names, and its uid.
fn by_key(key: &str) -> Result<(String, Bound), String> {
    if key.is_empty() {
        return Err(NO_CHECKPOINTS.into());
    }
    bindings()
        .lock_ok()
        .iter()
        .find(|(_, b)| !b.key.is_empty() && b.key == key)
        .map(|(uid, b)| (uid.clone(), b.clone()))
        .ok_or_else(|| NO_CHECKPOINTS.to_string())
}

/// Whether nothing tells if tab `uid`'s agent is working: it has no turn
/// state and its hooks have never reported one (Codex before its hooks are
/// trusted, a CLI without hooks, a tab not prompted yet).
fn turn_unknown(uid: &str) -> bool {
    crate::services::agent_turn::state_of(uid).is_none()
        && !bindings().lock_ok().get(uid).is_some_and(|b| b.turns_known)
}

fn who_for(uid: &str, bound: &Bound, label: Option<&str>) -> Who {
    Who {
        tab_uid: uid.to_string(),
        tab_label: label.map(|l| l.chars().take(80).collect()).unwrap_or_default(),
        cli: bound.cli.clone(),
        session_id: crate::services::agent_session::read_live_session_for(Some(&bound.project_id), uid),
        project_id: Some(bound.project_id.clone()),
    }
}

// ── Triggers ──────────────────────────────────────────────────────────────

/// The checkpoint a hook-reported transition asks for, if any: entering
/// `Working` from anything but `Working`/`Decision` is a turn's start (`pre`);
/// the first `Done` after one is its end (`post`). `Idle` (a session end)
/// and everything else take none.
pub fn kind_for(prev: Option<TurnState>, state: TurnState) -> Option<Kind> {
    match (prev, state) {
        (Some(TurnState::Working | TurnState::Decision), TurnState::Working) => None,
        (_, TurnState::Working) => Some(Kind::Pre),
        (Some(TurnState::Working | TurnState::Decision), TurnState::Done) => Some(Kind::Post),
        _ => None,
    }
}

/// `agent_turn`'s hand-off for a transition of tab `uid` from `prev` to
/// `state`; `prompt_at` is when the turn's record was written (milliseconds
/// since the epoch). Returns at once: the snapshot is queued on the folder's
/// worker. Not under `agent_turn`'s locks.
pub fn on_turn(uid: &str, prev: Option<TurnState>, state: TurnState, prompt_at: Option<u64>) {
    if let Some(b) = bindings().lock_ok().get_mut(uid) {
        b.turns_known = true;
    }
    let Some(kind) = kind_for(prev, state) else { return };
    if !capturing_in(&state_root()) || !git_supported_by(git_version()) {
        return;
    }
    let Ok(bound) = bound(uid) else { return };
    worker::submit(worker::Job {
        folder: bound.folder.clone(),
        kind,
        who: who_for(uid, &bound, None),
        prompt_at: (kind == Kind::Pre).then_some(prompt_at).flatten(),
        reply: None,
    });
}

// ── The window's calls ────────────────────────────────────────────────────

/// A tab's checkpoints, for its Reader.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub enabled: bool,
    /// The tab is bound to a folder (a local project's agent tab).
    pub bound: bool,
    /// Newest last.
    pub rows: Vec<Row>,
    /// Why the folder's last automatic snapshot failed, until one succeeds.
    pub failure: Option<String>,
}

pub fn list(key: &str) -> Listing {
    let enabled = capturing_in(&state_root());
    let Ok((_, bound)) = by_key(key) else { return Listing { enabled, bound: false, rows: Vec::new(), failure: None } };
    let mut rows = Store::for_bound(&root(), &bound.folder).map(|s| s.rows()).unwrap_or_default();
    let skip = rows.len().saturating_sub(LIST_ROWS);
    rows.drain(..skip);
    let failure = failures().lock_ok().get(&bound.folder).cloned();
    Listing { enabled, bound: true, rows, failure }
}

fn failures() -> &'static Mutex<HashMap<PathBuf, String>> {
    static F: OnceLock<Mutex<HashMap<PathBuf, String>>> = OnceLock::new();
    F.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Remember (`Some`) or forget (`None`) why `folder`'s last snapshot failed.
fn note_failure(folder: &Path, error: Option<&String>) {
    let mut map = failures().lock_ok();
    match error {
        Some(e) => map.insert(folder.to_path_buf(), e.clone()),
        None => map.remove(folder),
    };
}

fn store_row(key: &str, id: &str) -> Result<(String, Bound, Store, Row), String> {
    let (uid, bound) = by_key(key)?;
    let store = Store::for_bound(&root(), &bound.folder)?;
    let row = store.row(id).filter(Row::has_snapshot).ok_or("that checkpoint is gone")?;
    Ok((uid, bound, store, row))
}

/// What differs in the tab's folder from checkpoint `id`. `paths`: only those
/// files' diff text is read.
pub fn since(key: &str, id: &str, paths: Option<&[String]>) -> Result<SinceView, String> {
    ready()?;
    let (uid, bound, store, row) = store_row(key, id)?;
    let since = restore::since(&store, &row, &who_for(&uid, &bound, None), paths)?;
    let others = other_tabs(&uid, &bound.folder);
    Ok(SinceView {
        since,
        others_working: others.working,
        others_unknown: others.unknown,
        turn_unknown: turn_unknown(&uid),
        raced: row.raced,
        partial: row.partial,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SinceView {
    #[serde(flatten)]
    pub since: Since,
    /// Another agent tab in this folder is mid-turn.
    pub others_working: bool,
    /// Another agent tab in this folder can't be told working or not
    /// ([`turn_unknown`]).
    pub others_unknown: bool,
    /// This tab's own agent can't be told working or not: a restore needs
    /// `confirm_unknown`.
    pub turn_unknown: bool,
    pub raced: bool,
    pub partial: bool,
}

/// The other bound tabs of a folder: is one working (or waiting on a
/// decision), can one not be told.
struct Others {
    working: bool,
    unknown: bool,
}

fn other_tabs(uid: &str, folder: &Path) -> Others {
    let tabs: Vec<String> = bindings()
        .lock_ok()
        .iter()
        .filter(|(other, b)| other.as_str() != uid && b.folder == folder)
        .map(|(other, _)| other.clone())
        .collect();
    Others {
        working: tabs
            .iter()
            .any(|other| matches!(crate::services::agent_turn::state_of(other), Some(TurnState::Working | TurnState::Decision))),
        unknown: tabs.iter().any(|other| turn_unknown(other)),
    }
}

/// Why a restore must not go ahead now, or `None`: this tab's agent works
/// (always refused), or can't be told and `confirm_unknown` is not given,
/// or another tab's works or can't be told and `confirm_others` is not given.
/// Pure over the three readings.
pub fn restore_refusal(own: Option<TurnState>, own_unknown: bool, others_working: bool, others_unknown: bool, confirm_others: bool, confirm_unknown: bool) -> Option<&'static str> {
    if matches!(own, Some(TurnState::Working | TurnState::Decision)) {
        return Some("the agent in this tab is working; restore when it has finished");
    }
    if own_unknown && !confirm_unknown {
        return Some("this tab's agent does not report its turns (its hooks are off or not trusted yet), so whether it is working can't be told; confirm to restore anyway");
    }
    if !confirm_others && others_working {
        return Some("another agent tab in this folder is working");
    }
    if !confirm_others && others_unknown {
        return Some("another agent tab in this folder does not report its turns, so whether it is working can't be told; confirm to restore anyway");
    }
    None
}

/// Put the tab's folder back to checkpoint `id` (`paths`: only those; `None`
/// = every differing file). See [`restore_refusal`] for when it is refused:
/// that gate reads the agents' own hook records, which they can write, so it
/// only spares work in progress. Keeping the writes inside the folder is
/// [`restore::restore`]'s own job, gate or not.
pub fn restore(key: &str, id: &str, paths: Option<&[String]>, confirm_others: bool, confirm_unknown: bool) -> Result<Restored, String> {
    ready()?;
    let (uid, bound, store, row) = store_row(key, id)?;
    let others = other_tabs(&uid, &bound.folder);
    let own = crate::services::agent_turn::state_of(&uid);
    if let Some(why) = restore_refusal(own, turn_unknown(&uid), others.working, others.unknown, confirm_others, confirm_unknown) {
        return Err(why.into());
    }
    let result = restore::restore(&store, &row, &who_for(&uid, &bound, None), paths)?;
    announce(&uid, &result.undo_id, Kind::PreRestore);
    Ok(result)
}

/// A checkpoint now, for the tab (the Reader's and the tab menu's
/// "Checkpoint now"). Waits for the folder's worker.
pub fn now(key: &str, label: Option<&str>) -> Result<Row, String> {
    ready()?;
    let (uid, bound) = by_key(key)?;
    let uid = uid.as_str();
    let (tx, rx) = std::sync::mpsc::channel();
    worker::submit(worker::Job {
        folder: bound.folder.clone(),
        kind: Kind::Manual,
        who: who_for(uid, &bound, label),
        prompt_at: None,
        reply: Some(tx),
    });
    rx.recv().map_err(|_| "the checkpoint was not taken (quitting, or it failed)".to_string())?
}

fn announce(uid: &str, id: &str, kind: Kind) {
    worker::emit(AddedPayload { uid: uid.to_string(), id: id.to_string(), kind, error: None });
}

fn announce_failure(uid: &str, kind: Kind, error: &str) {
    worker::emit(AddedPayload { uid: uid.to_string(), id: String::new(), kind, error: Some(error.to_string()) });
}

// ── Settings card ─────────────────────────────────────────────────────────

/// One folder's store, for Settings.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreInfo {
    pub key: String,
    pub folder: String,
    pub bytes: u64,
    pub count: usize,
    pub last_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    pub enabled: bool,
    pub stores: Vec<StoreInfo>,
    /// The local git can run checkpoints (at least [`MIN_GIT`]).
    pub git_ok: bool,
    /// The local git's `major.minor`, `None` without git.
    pub git_version: Option<String>,
}

pub fn settings_view_in(state_dir: &Path) -> SettingsView {
    let mut stores: Vec<StoreInfo> = store::all_in(&store::root_in(state_dir))
        .into_iter()
        .map(|s| {
            let rows = s.rows();
            StoreInfo {
                key: s.key(),
                folder: crate::paths::display_path(&s.folder),
                bytes: s.size(),
                count: rows.iter().filter(|r| r.has_snapshot()).count(),
                last_at: rows.last().map_or(0, |r| r.at),
            }
        })
        .collect();
    stores.sort_by_key(|a| std::cmp::Reverse(a.bytes));
    let version = git_version();
    SettingsView {
        enabled: enabled_in(state_dir),
        stores,
        git_ok: git_supported_by(version),
        git_version: version.map(|(major, minor)| format!("{major}.{minor}")),
    }
}

pub fn settings_view() -> SettingsView {
    settings_view_in(&state_root())
}

/// Delete one folder's checkpoints (`key`) or every folder's (`None`).
pub fn clear_in(root: &Path, key: Option<&str>) -> Result<(), String> {
    for s in store::all_in(root) {
        if key.is_some_and(|k| k != s.key()) {
            continue;
        }
        remove_store(&s)?;
    }
    Ok(())
}

/// Remove a store: renamed aside under its lock (a snapshot in flight
/// finishes first; one that starts after finds no store and begins a new
/// one, never half of the old), then deleted. Windows can't rename a folder
/// holding an open lock file, so there the rename follows the lock.
fn remove_store(s: &Store) -> Result<(), String> {
    let root = s.dir.parent().ok_or("the store has no checkpoints folder")?;
    let trash = root.join(format!("{}{}-{}", store::TRASH_PREFIX, s.key(), store::new_id(crate::clock::now_ms())));
    let moved = {
        let _lock = s.lock()?;
        std::fs::rename(&s.dir, &trash)
    };
    if moved.is_err() {
        std::fs::rename(&s.dir, &trash).map_err(|e| format!("{}: {e}", s.dir.display()))?;
    }
    std::fs::remove_dir_all(&trash).map_err(|e| format!("{}: {e}", trash.display()))
}

pub fn clear(key: Option<&str>) -> Result<SettingsView, String> {
    clear_in(&root(), key)?;
    Ok(settings_view())
}

/// A project is removed: its stores go with it.
pub fn purge_project(project_id: &str) {
    purge_project_in(&root(), project_id);
}

pub fn purge_project_in(root: &Path, project_id: &str) {
    for s in store::all_in(root) {
        if s.meta().is_some_and(|m| m.project_id.as_deref() == Some(project_id)) {
            if let Err(e) = remove_store(&s) {
                eprintln!("checkpoints: purge {}: {e}", s.dir.display());
            }
        }
    }
}

// ── Retention ─────────────────────────────────────────────────────────────

/// The rows `rows` keeps at `now_ms`: those younger than [`KEEP_MS`], at most
/// [`MAX_ROWS`] of the newest, and every `pre-restore` row of the last
/// [`PRE_RESTORE_KEEP_MS`] whatever the count. Pure; the rows' order is kept.
pub fn retained(rows: &[Row], now_ms: u64) -> Vec<bool> {
    let mut keep = vec![false; rows.len()];
    let mut counted = 0;
    for (i, row) in rows.iter().enumerate().rev() {
        let age = now_ms.saturating_sub(row.at);
        if row.kind == Kind::PreRestore && age <= PRE_RESTORE_KEEP_MS {
            keep[i] = true;
        } else if age <= KEEP_MS && counted < MAX_ROWS {
            keep[i] = true;
            counted += 1;
        }
    }
    keep
}

/// Drop the rows past retention from `store` (their refs and log lines); how
/// many snapshots' refs went. The caller holds the store's lock.
pub fn prune_locked(store: &Store, now_ms: u64) -> Result<usize, String> {
    let rows = store.rows();
    let keep = retained(&rows, now_ms);
    if keep.iter().all(|k| *k) {
        return Ok(0);
    }
    let mut dropped = 0;
    let mut kept = Vec::with_capacity(rows.len());
    for (row, keep) in rows.into_iter().zip(keep) {
        if keep {
            kept.push(row);
        } else if row.has_snapshot() {
            // A ref already gone is as good as deleted.
            let _ = store.run(&["update-ref", "-d", &format!("{}{}", store::REF_PREFIX, row.id)], None, 1 << 16);
            dropped += 1;
        }
    }
    store.write_rows(&kept)?;
    if dropped > 0 {
        store.update_meta(|m| m.gc_pending = m.gc_pending.saturating_add(dropped as u32))?;
    }
    Ok(dropped)
}

/// The rows a store over its byte cap keeps (one step): all but the oldest
/// quarter (at least one) of its snapshots, never the newest one and never a
/// `pre-restore` of the last [`PRE_RESTORE_KEEP_MS`]. Restore rows hold no
/// snapshot and stay. Pure; the rows are oldest first.
pub fn trimmed(rows: &[Row], now_ms: u64) -> Vec<bool> {
    let newest = rows.iter().rposition(Row::has_snapshot);
    let droppable: Vec<usize> = rows
        .iter()
        .enumerate()
        .filter(|(i, r)| {
            r.has_snapshot()
                && Some(*i) != newest
                && !(r.kind == Kind::PreRestore && now_ms.saturating_sub(r.at) <= PRE_RESTORE_KEEP_MS)
        })
        .map(|(i, _)| i)
        .collect();
    let mut keep = vec![true; rows.len()];
    for &i in droppable.iter().take(droppable.len().div_ceil(4)) {
        keep[i] = false;
    }
    keep
}

/// When `store` has outgrown `max_bytes`, drop one [`trimmed`] step and make
/// the next idle repack due (the bytes only go with it). Waits while a repack
/// is already due, so queued snapshots don't drop a step each before it ran.
/// How many snapshots went. The caller holds the lock.
pub fn cap_locked(store: &Store, now_ms: u64, max_bytes: u64) -> Result<usize, String> {
    if store.meta().is_some_and(|m| m.gc_pending >= GC_AFTER) || store.size() <= max_bytes {
        return Ok(0);
    }
    let rows = store.rows();
    let keep = trimmed(&rows, now_ms);
    let mut dropped = 0;
    let mut kept = Vec::with_capacity(rows.len());
    for (row, keep) in rows.into_iter().zip(keep) {
        if keep {
            kept.push(row);
        } else {
            let _ = store.run(&["update-ref", "-d", &format!("{}{}", store::REF_PREFIX, row.id)], None, 1 << 16);
            dropped += 1;
        }
    }
    if dropped == 0 {
        return Ok(0);
    }
    store.write_rows(&kept)?;
    store.update_meta(|m| m.gc_pending = m.gc_pending.max(GC_AFTER))?;
    Ok(dropped)
}

/// Repack `store` once enough refs were dropped since the last time. The
/// caller holds the lock.
pub fn gc_locked(store: &Store) -> Result<bool, String> {
    let pending = store.meta().map_or(0, |m| m.gc_pending);
    if pending < GC_AFTER {
        return Ok(false);
    }
    store.run_ok(&["gc", "--prune=now", "-q"], None, 1 << 16)?;
    store.update_meta(|m| m.gc_pending = 0)?;
    Ok(true)
}

/// Stores whose folder is gone and whose last row is past retention, and
/// stores a removal left renamed aside (it was stopped halfway).
pub fn sweep_orphans_in(root: &Path, now_ms: u64) -> usize {
    let mut removed = 0;
    for entry in std::fs::read_dir(root).into_iter().flatten().flatten() {
        if entry.file_name().to_string_lossy().starts_with(store::TRASH_PREFIX) && std::fs::remove_dir_all(entry.path()).is_ok() {
            removed += 1;
        }
    }
    for s in store::all_in(root) {
        if s.folder.exists() {
            continue;
        }
        let last = s.rows().last().map_or_else(|| s.meta().map_or(0, |m| m.created * 1000), |r| r.at);
        if now_ms.saturating_sub(last) > KEEP_MS && remove_store(&s).is_ok() {
            removed += 1;
        }
    }
    removed
}

// ── Lifetime ──────────────────────────────────────────────────────────────

/// Start the window-side parts: the event sink and the orphan sweep.
pub fn start(ctx: app_core::CoreCtx) {
    worker::set_ctx(ctx);
    std::thread::spawn(|| {
        let removed = sweep_orphans_in(&root(), crate::clock::now_ms());
        if removed > 0 {
            eprintln!("checkpoints: removed {removed} store(s) of folders that are gone");
        }
    });
}

/// The quit teardown: no new snapshot starts, and one in flight gets a
/// moment to finish. Its git is bounded and ends with the process group.
pub fn stop_for_exit() {
    worker::stop(std::time::Duration::from_millis(1500));
}

#[cfg(test)]
mod tests;
