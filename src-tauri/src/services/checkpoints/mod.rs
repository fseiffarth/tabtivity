//! Per-turn checkpoints (`docs/turn_checkpoints_plan.md`,
//! `docs/context/checkpoints.md`): a snapshot of an agent tab's folder as each
//! turn begins and ends, and a way to put files back.
//!
//! - [`store`]: one git object store per folder under
//!   `<state_dir>/checkpoints/<key>/`, never the folder's own `.git`, never
//!   mounted into a fence (the fence masks the whole state dir).
//! - [`snapshot`]: tracked + untracked files, not the ignored ones.
//! - [`restore`]: the diff since a checkpoint and the restore, with its own undo.
//! - this module: the tab → folder bindings, the triggers (`agent_turn`'s
//!   transitions), the per-folder serial worker, retention and the settings.
//!
//! AppHandle-free. Every snapshot runs on a worker thread, never under
//! `agent_turn`'s locks.

pub mod restore;
pub mod snapshot;
pub mod store;
pub mod worker;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

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

#[derive(Debug, Clone, Serialize)]
struct AddedPayload {
    uid: String,
    id: String,
    kind: Kind,
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

/// Whether checkpoints are on. A missing or unreadable file reads as off.
pub fn enabled_in(state_dir: &Path) -> bool {
    crate::storage::read_json::<Settings>(&settings_path(state_dir)).map(|s| s.enabled).unwrap_or(false)
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
/// is checkpointed as the folder `roots` put it in. `roots`: `None` for a
/// launch that gets no checkpoints (remote project, the root console's Host
/// session, the assistant): the tab is unbound. Called by `launch_prep`
/// beside `agent_turn::bind_tab`.
pub fn bind(uid: &str, cwd: &str, project_id: Option<&str>, cmd: &str, roots: Option<&[PathBuf]>) {
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
        })
    })();
    let mut map = bindings().lock_ok();
    match bound {
        Some(b) => map.insert(uid.to_string(), b),
        None => map.remove(uid),
    };
}

/// Forget a tab that is gone.
pub fn unbind(uid: &str) {
    bindings().lock_ok().remove(uid);
}

fn bound(uid: &str) -> Result<Bound, String> {
    bindings()
        .lock_ok()
        .get(uid)
        .cloned()
        .ok_or_else(|| "this tab has no checkpoints (a remote, root or assistant tab, or its folder is not a project's)".to_string())
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
    let Some(kind) = kind_for(prev, state) else { return };
    if !enabled_in(&state_root()) {
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
}

pub fn list(uid: &str) -> Listing {
    let enabled = enabled_in(&state_root());
    let Ok(bound) = bound(uid) else { return Listing { enabled, bound: false, rows: Vec::new() } };
    let mut rows = Store::for_bound(&root(), &bound.folder).map(|s| s.rows()).unwrap_or_default();
    let skip = rows.len().saturating_sub(LIST_ROWS);
    rows.drain(..skip);
    Listing { enabled, bound: true, rows }
}

fn store_row(uid: &str, id: &str) -> Result<(Bound, Store, Row), String> {
    let bound = bound(uid)?;
    let store = Store::for_bound(&root(), &bound.folder)?;
    let row = store.row(id).filter(Row::has_snapshot).ok_or("that checkpoint is gone")?;
    Ok((bound, store, row))
}

/// What differs in the tab's folder from checkpoint `id`. `paths`: only those
/// files' diff text is read.
pub fn since(uid: &str, id: &str, paths: Option<&[String]>) -> Result<SinceView, String> {
    if !enabled_in(&state_root()) {
        return Err("checkpoints are off".into());
    }
    let (bound, store, row) = store_row(uid, id)?;
    let since = restore::since(&store, &row, &who_for(uid, &bound, None), paths)?;
    Ok(SinceView { since, others_working: other_tabs_working(uid, &bound.folder), raced: row.raced, partial: row.partial })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SinceView {
    #[serde(flatten)]
    pub since: Since,
    /// Another agent tab in this folder is mid-turn.
    pub others_working: bool,
    pub raced: bool,
    pub partial: bool,
}

/// Whether another bound tab of `folder` is working or waiting on a decision.
fn other_tabs_working(uid: &str, folder: &Path) -> bool {
    let tabs: Vec<String> = bindings()
        .lock_ok()
        .iter()
        .filter(|(other, b)| other.as_str() != uid && b.folder == folder)
        .map(|(other, _)| other.clone())
        .collect();
    tabs.iter().any(|other| matches!(crate::services::agent_turn::state_of(other), Some(TurnState::Working | TurnState::Decision)))
}

/// Put the tab's folder back to checkpoint `id` (`paths`: only those; `None`
/// = every differing file). Refused while this tab's agent works, and while
/// another tab's does unless `confirm_others`.
pub fn restore(uid: &str, id: &str, paths: Option<&[String]>, confirm_others: bool) -> Result<Restored, String> {
    if !enabled_in(&state_root()) {
        return Err("checkpoints are off".into());
    }
    let (bound, store, row) = store_row(uid, id)?;
    if matches!(crate::services::agent_turn::state_of(uid), Some(TurnState::Working | TurnState::Decision)) {
        return Err("the agent in this tab is working; restore when it has finished".into());
    }
    if !confirm_others && other_tabs_working(uid, &bound.folder) {
        return Err("another agent tab in this folder is working".into());
    }
    let result = restore::restore(&store, &row, &who_for(uid, &bound, None), paths)?;
    announce(uid, &result.undo_id, Kind::PreRestore);
    Ok(result)
}

/// A checkpoint now, for the tab (the Reader's and the tab menu's
/// "Checkpoint now"). Waits for the folder's worker.
pub fn now(uid: &str, label: Option<&str>) -> Result<Row, String> {
    if !enabled_in(&state_root()) {
        return Err("checkpoints are off".into());
    }
    let bound = bound(uid)?;
    let (tx, rx) = std::sync::mpsc::channel();
    worker::submit(worker::Job {
        folder: bound.folder.clone(),
        kind: Kind::Manual,
        who: who_for(uid, &bound, label),
        prompt_at: None,
        reply: Some(tx),
    });
    rx.recv().map_err(|_| "the checkpoint was not taken (quitting)".to_string())?
}

fn announce(uid: &str, id: &str, kind: Kind) {
    worker::emit(AddedPayload { uid: uid.to_string(), id: id.to_string(), kind });
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
    SettingsView { enabled: enabled_in(state_dir), stores }
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

fn remove_store(s: &Store) -> Result<(), String> {
    let lock = s.lock()?;
    // Under the lock so a snapshot in flight finishes first; then it ends.
    drop(lock);
    std::fs::remove_dir_all(&s.dir).map_err(|e| format!("{}: {e}", s.dir.display()))
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

/// Stores whose folder is gone and whose last row is past retention.
pub fn sweep_orphans_in(root: &Path, now_ms: u64) -> usize {
    let mut removed = 0;
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
