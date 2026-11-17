//! Auto-sync reconcile engine for remote (SSH) projects.
//!
//! Sits on top of the manual selective-sync core (`services::remote_sync`,
//! `commands::sync`): when the user marks a file/folder **auto-sync**
//! (`SyncEntry::auto_sync`, set via `sync_set_auto`), a per-project background
//! task keeps it in sync bidirectionally without a click. It reuses every
//! `remote_sync` primitive (`walk_host_files`, `walk_mirror_files`, `divergence`,
//! `push_decision`, `pull_file`, `push_file_atomic`, `record_*`, `save_manifest`)
//! — this module only adds the *trigger* (a mirror filesystem watcher + an
//! interval) and the *policy* (act on the safe direction; never auto-touch an
//! amber/orange conflict).
//!
//! Lifecycle: `start` is called after a successful `remote_connect` and `stop`
//! from `remote_disconnect`; `stop_all` runs at app exit. One task per project,
//! so reconcile passes never overlap; each pass holds the project's mutation
//! lock (`services::sync_op`) for its whole length, so manual sync commands,
//! git lockstep and the other process sharing the state dir never write beside it.
//!
//! Safe-direction policy per file, judged by `remote_sync::divergence` against
//! the recorded bases:
//!   - host moved, local unchanged  → PULL host→local
//!   - local moved, host unchanged  → PUSH local→host (guarded by `push_decision`)
//!   - both moved (AMBER/orange)    → SKIP, left for manual resolution — unless the
//!     project's "take the newer copy" switch is on (`services::sync_take_newer`):
//!     then the copy with the newer mtime wins, after the other is backed up
//!   - neither moved (green)        → no-op
//!
//! Deletions are intentionally NOT propagated in v1 (a gone host side reads as
//! "couldn't check" and a gone local side's push errors out and is skipped) —
//! the conservative "never destructive automatically" stance.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use app_core::CoreCtx;
use tokio::sync::{mpsc, Notify};
use tokio::time::MissedTickBehavior;

use crate::services::remote::{pooled_sftp, remote_target_for, sync_pool, RemotePoolState, RemoteTarget};
use crate::services::remote_sync::{
    self, ensure_loaded, mirror_dir, Manifest, PushDecision, Stat, SyncManifestState, Transfer,
};
use crate::services::sftp;
use crate::services::sync_take_newer;
use crate::services::sync_task;

/// Host re-stat cadence: how often a connected project's auto paths are checked
/// for incoming host changes (the local side is also caught near-instantly by the
/// mirror watcher).
const AUTO_INTERVAL: Duration = Duration::from_secs(25);
/// Coalesce a burst of mirror writes into one pass: after the first watcher event
/// we wait this long, absorbing further events, before reconciling.
const DEBOUNCE: Duration = Duration::from_millis(1500);

/// Per-file bound on a reconcile transfer's SFTP round-trips — the background twin
/// of `commands::sync::PUSH_FILE_TIMEOUT`. Both transfers ride the pooled session,
/// so an unbounded wait on a dropped connection hangs this task forever *and*, since
/// a manual push leases the same session, wedges the user's push buttons too.
const RECONCILE_FILE_TIMEOUT: Duration = Duration::from_secs(120);

/// Await a transfer future under [`RECONCILE_FILE_TIMEOUT`], folding a stall into the
/// same `Err(String)` the transfer itself returns — so the caller's existing
/// error arm skips the file instead of the whole pass hanging on the pooled session.
async fn run_bounded<T, E: From<String>>(
    fut: impl std::future::Future<Output = Result<T, E>>,
) -> Result<T, E> {
    match tokio::time::timeout(RECONCILE_FILE_TIMEOUT, fut).await {
        Ok(r) => r,
        Err(_) => Err(format!(
            "transfer stalled after {}s (remote connection may have dropped)",
            RECONCILE_FILE_TIMEOUT.as_secs()
        )
        .into()),
    }
}

/// `fut`, unless a manual sync command starts waiting for `project_id`'s lock
/// first: then `None`, and the pass ends so it releases the lock. Only for the
/// pass's read-only work (host walks and stats) — a transfer cut off there could
/// leave a file written but unrecorded, or a temp file on the host.
async fn unless_manual<T>(project_id: &str, fut: impl std::future::Future<Output = T>) -> Option<T> {
    tokio::select! {
        biased;
        _ = crate::services::sync_op::manual_arrived(project_id) => None,
        r = fut => Some(r),
    }
}

/// Absorb the rest of a watcher burst on `rx`: true once `quiet` passed with no
/// further event, or `max` after the call when the events never pause — a log
/// appended every second would otherwise hold the pass off for as long as it
/// is written, and the loop's interval tick with it (not polled meanwhile).
/// False when the task is cancelled or the watcher is gone.
pub(crate) async fn absorb_burst(
    rx: &mut mpsc::UnboundedReceiver<()>,
    cancel: &Notify,
    quiet: Duration,
    max: Duration,
) -> bool {
    let deadline = tokio::time::Instant::now() + max;
    loop {
        tokio::select! {
            _ = cancel.notified() => return false,
            _ = tokio::time::sleep(quiet) => return true,
            _ = tokio::time::sleep_until(deadline) => return true,
            res = rx.recv() => { if res.is_none() { return false; } }
        }
    }
}

/// One running auto-sync task ([`sync_task::Task`]) and its pause count: the
/// held [`PauseGuard`]s. While non-zero, the loop skips its passes so a git
/// checkout (`services::git_peer`) can rewrite the mirror without those writes
/// being pulled/pushed. `git_peer` re-stamps the file-sync bases before its
/// guard drops, so the next pass reads the rewritten tracked files as green
/// rather than as local edits. (A pass already running is not interrupted by a
/// pause: the checkout waits for it on the project's mutation lock instead.)
pub type AutoSyncTask = sync_task::Task<Arc<AtomicUsize>>;

/// A pause of one project's auto-sync ([`pause`]), lifted when dropped — on every
/// return path of the checkout that took it, an early error or a cancelled caller
/// included, where a flag cleared by hand could stay set forever.
pub struct PauseGuard(Option<Arc<AtomicUsize>>);

impl Drop for PauseGuard {
    fn drop(&mut self) {
        if let Some(paused) = &self.0 {
            paused.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

/// Tauri-managed registry of per-project auto-sync tasks, keyed by project id.
pub type AutoSyncState = sync_task::Tasks<Arc<AtomicUsize>>;

/// Build a fresh, empty registry for `tauri::Builder::manage`.
pub fn new_state() -> AutoSyncState {
    sync_task::new_tasks()
}

/// Payload of the `auto-sync` event, emitted after a pass that transferred
/// anything so the frontend can refresh its sync status (and optionally surface a
/// "N synced, M conflicts" hint).
#[derive(Clone, Serialize)]
struct AutoSyncEvent {
    project_id: String,
    pulled: usize,
    pushed: usize,
    skipped_amber: usize,
    /// Mirror files left out of pushes (a link, a FIFO, a giant): the project's
    /// whole current notice, so the UI replaces what it shows.
    skipped_unsafe: remote_sync::MirrorSkips,
}

/// Start the per-project auto-sync task (idempotent; no-op for a local project).
/// Spawns a recursive filesystem watcher on the local mirror plus the reconcile
/// loop. Called after `remote_connect` succeeds.
pub async fn start(
    ctx: CoreCtx,
    pool: RemotePoolState,
    manifest: SyncManifestState,
    state: &AutoSyncState,
    project_id: &str,
) {
    // A stopped loop still finishing its last transfer keeps the project: start
    // this one once it has ended, never beside it (and only if still connected).
    if let Some(ended) = sync_task::behind_stopping(state, project_id).await {
        let state = state.clone();
        let project_id = project_id.to_string();
        tokio::spawn(async move {
            if ended.await && pooled_sftp(&pool, &project_id).await.is_some() {
                start_now(ctx, pool, manifest, &state, &project_id).await;
            }
        });
        return;
    }
    start_now(ctx, pool, manifest, state, project_id).await;
}

/// Whether a remote project keeps a local mirror for auto-sync to reconcile:
/// not a remote-only one ([`crate::schema::project::RemoteSpec::is_remote_only`],
/// VM projects included), which is never mirrored.
fn has_mirror_to_sync(spec: &crate::schema::project::RemoteSpec) -> bool {
    !spec.is_remote_only()
}

async fn start_now(
    ctx: CoreCtx,
    pool: RemotePoolState,
    manifest: SyncManifestState,
    state: &AutoSyncState,
    project_id: &str,
) {
    // Only remote projects have a host to sync against.
    let Some(target) = remote_target_for(project_id) else {
        return;
    };
    // …that keeps a local copy: a remote-only project has no mirror to sync
    // (and the `create_dir_all` below must not mint one)…
    if !has_mirror_to_sync(&target.spec) {
        return;
    }
    // …and a host the user tagged HPC gets no *background* sync at all. Every
    // pass walks the host tree over SFTP, and on a cluster that tree is normally
    // on the parallel filesystem, where a recursive walk is a metadata storm
    // against a shared server — at a 25 s cadence, unasked for, for as long as the
    // project is open. Manual sync (the file view's push/pull) is untouched: the
    // objection is to the cadence, not to the transfer.
    if crate::services::hpc_mode::is_hpc_spec(&target.spec) {
        return;
    }
    // One loop per mirror across this app's processes; the one that does not run
    // it still syncs by hand (the manifest is compare-and-swap across processes).
    let key = crate::services::process_lease::remote_sync_key(project_id);
    let busy = format!("sync_auto: {project_id}: another process of this app runs its auto-sync");
    sync_task::spawn(state, project_id, &key, &busy, |stop| {
        // Mirror watcher → mpsc into the loop (debounced there). The mirror must
        // exist for the recursive watch to attach (connect() already creates it, but
        // be defensive for a first-ever run).
        //
        // The watcher itself is attached by the loop, not here, and only once the
        // manifest actually marks something for auto-sync — see `attach_watcher`.
        let mirror = mirror_dir(project_id);
        let _ = std::fs::create_dir_all(&mirror);
        let (tx, rx) = mpsc::unbounded_channel::<()>();
        let paused = Arc::new(AtomicUsize::new(0));
        let run = run_loop(
            ctx,
            pool,
            manifest,
            target,
            project_id.to_string(),
            mirror,
            tx,
            rx,
            stop.cancel,
            paused.clone(),
            stop.stopping,
        );
        (run, paused)
    })
    .await;
}

/// Pause the project's auto-sync reconcile passes until the returned guard drops
/// (a no-op guard if no task). Used by `services::git_peer` around a coordinated
/// checkout so the checkout's mirror writes are neither pulled nor pushed; drop the
/// guard only after re-stamping any checkout-rewritten tracked-file bases, else the
/// next pass will treat them as local edits. Pauses nest.
pub async fn pause(state: &AutoSyncState, project_id: &str) -> PauseGuard {
    let paused = state.lock().await.get(project_id).map(|t| Arc::clone(&t.extra));
    if let Some(p) = &paused {
        p.fetch_add(1, Ordering::SeqCst);
    }
    PauseGuard(paused)
}

/// Stop the project's auto-sync task (no-op if none): cancel it and wait a bounded
/// time so a stuck pass can't hang disconnect. A task still mid-transfer after
/// that stays registered as stopping and keeps its lease until it actually ends
/// (its pass stops after the current file; `start` defers behind it), so a slow
/// transfer is never detached while the project reads as free. The watcher goes
/// with the task.
pub async fn stop(state: &AutoSyncState, project_id: &str) {
    if !sync_task::stop(state, project_id, sync_task::STOP_WAIT).await {
        eprintln!("sync_auto: {project_id}: a transfer is still finishing; auto-sync keeps the project until it ends");
    }
}

/// Stop every auto-sync task. Used at app exit before tearing down the pool.
pub async fn stop_all(state: &AutoSyncState) {
    sync_task::stop_all(state).await;
}

/// Attach the mirror watcher, but only once the manifest marks *something* for
/// auto-sync. No-op if already attached, or if there is still nothing marked.
///
/// Byte-sync scope is opt-in per path (no marker ⇒ nothing crosses), so a remote
/// project that has never marked anything — the common case — used to pay for a
/// recursive watch it could not act on: `reconcile_pass` collects the `auto_sync`
/// entries and returns immediately when there are none, but the watch had already
/// cost one inotify watch per directory in the mirror (8017 on a measured project
/// with two virtualenvs), each event waking a thread to send on a channel whose
/// consumer would bail. Deferring the attach makes that cost follow the feature.
///
/// Re-checked on every interval tick rather than wired into `sync_set_auto`, which
/// deliberately transfers nothing and leaves the engine to act on its next pass —
/// so the marker and the watcher stay decoupled, and a manifest edited by any
/// route (command, import, hand-edited file) is picked up the same way.
async fn ensure_watcher(
    slot: &mut Option<notify::RecommendedWatcher>,
    manifest: &SyncManifestState,
    project_id: &str,
    mirror: &std::path::Path,
    tx: &mpsc::UnboundedSender<()>,
) {
    if slot.is_some() {
        return;
    }
    {
        let mut g = manifest.lock().await;
        let m = ensure_loaded(&mut g, project_id);
        if !m.values().any(|e| e.auto_sync) {
            return;
        }
    }
    let tx = tx.clone();
    // The mirror as spelled and by its real path: macOS's FSEvents reports
    // events under the real one, so a mirror reached through a symlink would
    // match no `.git` write and every one would queue a walk.
    let mut roots = vec![mirror.to_path_buf()];
    roots.extend(std::fs::canonicalize(mirror).ok().filter(|real| real != mirror));
    let Ok(mut w) = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        // The recursive watch covers `.git` and `.tabtivity` too, and byte-sync never
        // moves a byte of either — yet every lockstep pass (bundle, fetch, refs),
        // every `git status` stat-cache refresh and every tab-runtime write under
        // `.tabtivity` used to queue a full host walk here. Only a write to something
        // byte-sync could actually act on gets to wake the loop.
        if let Ok(ev) = res {
            if event_touches_synced_bytes_under(&roots, &ev.paths) {
                let _ = tx.send(());
            }
        }
    }) else {
        return; // no watcher → interval passes still run, just less promptly
    };
    if w.watch(mirror, RecursiveMode::Recursive).is_ok() {
        *slot = Some(w);
    }
}

/// Whether a watcher event names at least one path byte-sync could act on — i.e.
/// anything that is **not** inside the mirror's `.git` or `.tabtivity` directories
/// (both are never byte-mirrored: git state travels through lockstep, `.tabtivity` is
/// Tabtivity's own runtime dir). An event with no paths at all (some backends emit
/// rescan/overflow notices that way) counts as "could be anything" and wakes the
/// loop. Pure.
fn event_touches_synced_bytes(mirror: &std::path::Path, paths: &[std::path::PathBuf]) -> bool {
    if paths.is_empty() {
        return true;
    }
    paths.iter().any(|p| {
        let rel = match p.strip_prefix(mirror) {
            Ok(r) => r,
            Err(_) => return true, // outside the mirror as we know it → don't guess
        };
        !matches!(
            rel.components().next(),
            Some(std::path::Component::Normal(first)) if first == ".git" || first.to_str().is_some_and(crate::brand::is_project_dir)
        )
    })
}

/// [`event_touches_synced_bytes`] for a mirror known by several spellings
/// (as given, and its real path): a path is skipped when any of them places
/// it in `.git` or the app's folder.
fn event_touches_synced_bytes_under(mirrors: &[std::path::PathBuf], paths: &[std::path::PathBuf]) -> bool {
    paths.is_empty()
        || paths
            .iter()
            .any(|p| mirrors.iter().all(|m| event_touches_synced_bytes(m, std::slice::from_ref(p))))
}

/// Whether this loop's host is tagged HPC **right now** — the same gate `start()`
/// applies, asked again on every tick so tagging a machine mid-session actually
/// stops the traffic rather than only preventing the next start.
fn hpc_now(target: &RemoteTarget) -> bool {
    crate::services::hpc_mode::is_hpc_spec(&target.spec)
}

/// The per-project loop: reconcile on a fixed interval (host changes) and shortly
/// after any mirror write (local changes), until cancelled. A single task ⇒ passes
/// are serialized and never overlap.
async fn run_loop(
    ctx: CoreCtx,
    pool: RemotePoolState,
    manifest: SyncManifestState,
    target: RemoteTarget,
    project_id: String,
    mirror: std::path::PathBuf,
    tx: mpsc::UnboundedSender<()>,
    mut rx: mpsc::UnboundedReceiver<()>,
    cancel: Arc<Notify>,
    paused: Arc<AtomicUsize>,
    stopping: Arc<AtomicBool>,
) {
    let mut interval = tokio::time::interval(AUTO_INTERVAL);
    interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    // Dropped with the task (cancel/stop) → unwatch, exactly as the old field on
    // `AutoSyncTask` did. `None` until the manifest marks something; see below.
    let mut watcher: Option<notify::RecommendedWatcher> = None;
    ensure_watcher(&mut watcher, &manifest, &project_id, &mirror, &tx).await;
    loop {
        tokio::select! {
            _ = cancel.notified() => break,
            _ = interval.tick() => {
                // Re-read the tag, don't trust the one `start()` saw: tagging a
                // machine is normally something the user does *because* they
                // noticed the traffic, and a gate evaluated once at connect would
                // leave the loop they are trying to stop running until the next
                // disconnect. Breaking ends the task; `stop()` then finds it
                // already finished, which is the same state as a cancel.
                if hpc_now(&target) { break; }
                // Converted to remote-only since the loop started: nothing
                // left to sync (`stop` then finds the task finished).
                if crate::services::remote::is_remote_only_now(&project_id) { break; }
                if paused.load(Ordering::SeqCst) > 0 { continue; }
                // Cheap once attached; this is what picks up a `sync_set_auto` that
                // marked the first path after the task was already running.
                ensure_watcher(&mut watcher, &manifest, &project_id, &mirror, &tx).await;
                reconcile_pass(Some(&ctx), &pool, &manifest, &target, &project_id, &paused, &stopping).await;
            }
            res = rx.recv() => {
                if res.is_none() { break; } // watcher gone → stop
                // Debounce: absorb the rest of the burst before reconciling, for
                // no longer than a tick would have waited.
                if !absorb_burst(&mut rx, &cancel, DEBOUNCE, AUTO_INTERVAL).await { return; }
                // The watcher fires on local edits, which are exactly as much
                // host traffic as a tick — same re-check as the interval arm.
                if hpc_now(&target) { break; }
                // Skip the pass while a checkout is rewriting the mirror; the writes
                // that queued these watcher events are re-based by git_peer before
                // resume, so dropping this pass loses nothing.
                if paused.load(Ordering::SeqCst) > 0 { continue; }
                reconcile_pass(Some(&ctx), &pool, &manifest, &target, &project_id, &paused, &stopping).await;
            }
        }
    }
}

/// Run exactly one byte-sync reconcile pass, synchronously, with no watcher, no
/// interval, and no UI event. This is the same pass [`run_loop`] drives — the loop
/// contributes only the *when*.
///
/// Exists for the live-SSH lockstep driver (`examples/lockstep_drv.rs`), which walks
/// `docs/git_lockstep_case_matrix.md` against a real host: the byte-sync half of the
/// BS+LS cases has to be the real engine, or the matrix proves nothing about the code
/// that ships.
pub async fn reconcile_once(
    pool: &RemotePoolState,
    manifest: &SyncManifestState,
    target: &RemoteTarget,
    project_id: &str,
) {
    reconcile_pass(None, pool, manifest, target, project_id, &AtomicUsize::new(0), &AtomicBool::new(false)).await;
}

/// Subtract the git-tracked set from the byte-sync candidates when lockstep owns them
/// (#28p D1). A no-op when lockstep is off, so a project that never opted in keeps
/// exactly today's behaviour — including its behaviour for files git happens to track.
/// With lockstep on, a tracked set git could not list (`git_peer::tracked_paths`'s
/// `Err`) is `Err` here: which files lockstep owns is unknown, so nothing is
/// byte-synced. Pure.
pub fn drop_tracked(
    candidates: &mut BTreeSet<String>,
    tracked: &Result<HashSet<String>, String>,
    lockstep_enabled: bool,
) -> Result<(), String> {
    if !lockstep_enabled {
        return Ok(());
    }
    let tracked = tracked.as_ref().map_err(|e| lockstep_unknown(e))?;
    candidates.retain(|rel| !tracked.contains(rel));
    Ok(())
}

/// The refusal when lockstep is on but its tracked set could not be listed.
pub fn lockstep_unknown(why: &str) -> String {
    format!("Git Lockstep owns the git-tracked files, but they could not be listed ({why}); nothing was byte-synced")
}

/// One reconcile pass over the project's auto-sync paths. Bails gracefully if the
/// pool is cold/dead. Reuses the `remote_sync` primitives throughout.
///
/// `ctx` is `None` when the pass is driven outside the app (see [`reconcile_once`]);
/// it is used for nothing but the completion event.
///
/// The whole pass — the snapshot, the ownership probe, the walks and every
/// transfer — runs under the project's mutation lock (`services::sync_op`), so
/// nothing it decided on can be rewritten by another writer of this app before
/// it acts. `paused`/`stopping` are re-read once the lock is held (a checkout
/// that paused the loop held it first) and `stopping` again before each file
/// starts. A manual command waiting for the lock (`sync_op::acquire_manual`)
/// ends the pass early: no further file starts, or at once during a host walk
/// or stat. Files are decided and moved a few at a time (`sync_pool`); the ones
/// in flight always finish and are recorded, in candidate order.
async fn reconcile_pass(
    ctx: Option<&CoreCtx>,
    pool: &RemotePoolState,
    manifest: &SyncManifestState,
    target: &RemoteTarget,
    project_id: &str,
    paused: &AtomicUsize,
    stopping: &AtomicBool,
) {
    let _op = match crate::services::sync_op::acquire(project_id).await {
        Ok(op) => op,
        Err(e) => {
            eprintln!("auto-sync: {project_id}: {e}");
            return;
        }
    };
    if paused.load(Ordering::SeqCst) > 0 || stopping.load(Ordering::SeqCst) {
        return;
    }
    // The project stopped keeping a local copy while this pass waited for the
    // lock (`commands::remote_unpair` writes the flag under it): the
    // `target` this loop started with is stale, and its mirror may be moving.
    if crate::services::remote::is_remote_only_now(project_id) {
        return;
    }
    // Bail if the connection is cold or the ssh child died (keepalive evicted it) —
    // asked once the lock is held, so a pass that waited out another writer acts
    // on the session as it is now.
    let Some(sftp) = pooled_sftp(pool, project_id).await else {
        return;
    };
    // An unreadable `sync.json` stands in as empty in the cache; act on nothing
    // until it is repaired (logged once, by the read that found it).
    if remote_sync::check_manifest_readable(project_id).is_err() {
        return;
    }

    // Snapshot the manifest and collect the auto markers under the lock.
    let (snapshot, auto_dirs, auto_files): (Manifest, Vec<String>, Vec<String>) = {
        let mut g = manifest.lock().await;
        let m = ensure_loaded(&mut g, project_id);
        let dirs = m
            .iter()
            .filter(|(_, e)| e.auto_sync && e.is_dir)
            .map(|(k, _)| k.clone())
            .collect();
        let files = m
            .iter()
            .filter(|(_, e)| e.auto_sync && !e.is_dir)
            .map(|(k, _)| k.clone())
            .collect();
        (m.clone(), dirs, files)
    };
    if auto_dirs.is_empty() && auto_files.is_empty() {
        return;
    }

    // Candidate files = auto single-file entries ∪ host walk of each auto dir ∪
    // mirror walk of each auto dir (so new files on EITHER side are picked up).
    // An auto dir may be the project root (""), i.e. project-wide auto-sync-all,
    // in which case the walks cover the whole tree.
    let mut candidates: BTreeSet<String> = auto_files.into_iter().collect();
    // Host directory walks already paid for size+mtime. Carry those values into
    // the reconcile loop instead of serially re-stat'ing every walked file over
    // SFTP. Explicit single-file markers and mirror-only candidates still stat.
    // The walk's permission bits ride along for the pull (the mirror copy keeps
    // the host's mode).
    let mut walked_host: HashMap<String, (Stat, Option<u32>)> = HashMap::new();
    // Neither walk enters a folder no auto file can be under (an excluded
    // `data/`, a carved-out `.venv`): its files would only be dropped below.
    let snapshot = Arc::new(snapshot);
    let skip = remote_sync::auto_walk_skip(&snapshot);
    for d in &auto_dirs {
        let walk = remote_sync::walk_host_files_bounded(&sftp, &target.spec.remote_path, d, &skip, usize::MAX);
        let Some(walk) = unless_manual(project_id, walk).await else {
            return; // a manual sync is waiting → hand it the lock
        };
        match walk {
            Ok((files, _)) => {
                for file in files {
                    candidates.insert(file.rel.clone());
                    walked_host.insert(file.rel, ((file.size, file.mtime), file.mode));
                }
            }
            Err(_) => return, // connection dropped mid-walk → abandon this pass
        }
    }
    // The mirror side of the same folders, off the runtime thread.
    let local = {
        let (snapshot, pid, dirs) = (snapshot.clone(), project_id.to_string(), auto_dirs);
        app_core::rt::spawn_blocking(move || {
            let skip = remote_sync::auto_walk_skip(&snapshot);
            dirs.iter()
                .filter_map(|d| remote_sync::walk_mirror_files_skipping(&pid, d, &skip).ok())
                .flatten()
                .collect::<Vec<String>>()
        })
        .await
        .unwrap_or_default()
    };
    candidates.extend(local);
    // Drop paths carved out by a local OFF override (an `auto_off` on the file or a
    // nearer directory marker): the reconcile only touches paths whose *effective*
    // auto-sync is on, so a project-wide auto can still exclude individual subtrees.
    candidates.retain(|rel| remote_sync::is_auto(&snapshot, rel));
    walked_host.retain(|rel, _| candidates.contains(rel));

    // #28p D1: with git lockstep on, the tracked tree belongs to lockstep — it delivers
    // those files as *commits*. Shipping them here as loose bytes first lands them on
    // the peer untracked, which then blocks the very fast-forward that would have
    // delivered them properly (git refuses to overwrite an untracked file even when it
    // is byte-identical). Which of those two happened used to be decided by a debounce
    // race between the two engines — nondeterministically wedging the project.
    // Only asked when lockstep is on; a listing git could not give defers the pass.
    let (lockstep, tracked) = {
        let pid = project_id.to_string();
        app_core::rt::spawn_blocking(move || crate::services::git_peer::lockstep_tracked(&pid))
            .await
            .unwrap_or_else(|e| (true, Err(e.to_string())))
    };
    if let Err(e) = drop_tracked(&mut candidates, &tracked, lockstep) {
        eprintln!("auto-sync: {project_id}: {e}");
        return;
    }

    let mirror_root = mirror_dir(project_id);
    let records = remote_sync::RecordBatch::new(manifest, project_id);
    let pass = Pass { sftp: &sftp, records: &records, project_id, mirror_root: &mirror_root };
    let mut pulled = 0usize;
    let mut pushed = 0usize;
    let mut skipped = 0usize;
    let mut notice_changed = false;
    // "Take the newer copy" (read once a pass): the backup folder is made on the
    // first conflict it resolves, and the losers are logged after the loop.
    let take_newer = sync_take_newer::enabled(project_id);
    let mut backup: Option<std::path::PathBuf> = None;
    let mut replaced_local: Vec<String> = Vec::new();
    let mut replaced_host: Vec<String> = Vec::new();
    // Both-sides-changed files the newer copy resolves, taken one at a time after
    // the other files (each backs a copy up first; they are rare).
    let mut resolvable: Vec<Resolvable> = Vec::new();
    // Set when a manual sync arrived during a candidate's host stat.
    let handed_over = AtomicBool::new(false);
    let candidates: Vec<String> = candidates.into_iter().collect();
    {
        let (candidates, walked_host, snapshot, handed_over) = (&candidates, &walked_host, &*snapshot, &handed_over);
        let (pass, mirror_root, root) = (&pass, mirror_root.as_path(), target.spec.remote_path.as_str());
        // Stopped, or a manual pull/push/delete is waiting for the lock: no further
        // file starts; the files in flight finish and are recorded. The rest of the
        // tree is picked up by the next pass.
        let halt = || {
            stopping.load(Ordering::SeqCst)
                || handed_over.load(Ordering::SeqCst)
                || crate::services::sync_op::manual_waiting(project_id)
        };
        // What the file may hold in memory while it moves: the larger of the two
        // copies as last seen (a pull reads the host copy whole, a push the mirror's).
        let weight = |i: usize| {
            let rel = &candidates[i];
            let host = walked_host
                .get(rel)
                .map(|((size, _), _)| *size)
                .or_else(|| snapshot.get(rel).map(|e| e.host_size))
                .unwrap_or(0);
            let local = match remote_sync::mirror_lstat(mirror_root, rel) {
                Ok(remote_sync::MirrorStat::File(m)) => m.len(),
                _ => 0,
            };
            host.max(local)
        };
        let (decisions, mut decided) = sync_pool::run_ordered(
            candidates.len(),
            sync_pool::Limits::TRANSFERS,
            weight,
            halt,
            move |i| {
                let rel = candidates[i].as_str();
                let walked = walked_host.get(rel).copied();
                let file = Candidate { pass, manifest, project_id, root, rel, walked, take_newer, handed_over };
                async move { file.decide().await }
            },
        );
        let settle = async {
            while let Some((_, step)) = decided.recv().await {
                notice_changed |= step.notice_changed;
                match step.action {
                    Action::None => {}
                    Action::Pulled { rel, host, local } => {
                        pass.note_unrecorded(pass.records.record(&rel, Transfer::Pull, host, local).await);
                        pulled += 1;
                    }
                    Action::Pushed { rel, done } => {
                        pass.note_unrecorded(pass.records.record(&rel, Transfer::Push, done.host, done.local).await);
                        pushed += 1;
                    }
                    Action::Skipped => skipped += 1,
                    Action::Resolve(file) => resolvable.push(*file),
                }
            }
        };
        tokio::join!(decisions, settle);
    }

    for Resolvable { rel, host_abs, host, host_mode, local, winner } in resolvable {
        // Checked before each file, as the transfers above are.
        if stopping.load(Ordering::SeqCst)
            || handed_over.load(Ordering::SeqCst)
            || crate::services::sync_op::manual_waiting(project_id)
        {
            break;
        }
        // The rest of the pass ran since this file was judged: a marker the user
        // changed meanwhile (auto off, an exclusion) wins here as it does there.
        // (The copy that loses is re-checked against what the pass saw by
        // `take_newer_copy` itself.)
        let still_auto = {
            let mut g = manifest.lock().await;
            remote_sync::is_auto(ensure_loaded(&mut g, project_id), &rel)
        };
        if !still_auto {
            continue;
        }
        let root = backup
            .get_or_insert_with(|| sync_take_newer::backup_root(project_id, crate::clock::now_secs()))
            .clone();
        let conflict = Conflict { pass: &pass, backup_root: &root, rel: &rel, host_abs: &host_abs, host, host_mode, local };
        let outcome = take_newer_copy(&conflict, winner).await;
        // A try cut short for a waiting manual sync is not a failure to
        // remember: the next pass tries again.
        if outcome.is_ok() || !crate::services::sync_op::manual_waiting(project_id) {
            sync_take_newer::note_outcome(project_id, &rel, host, local, outcome.is_ok());
        }
        match outcome {
            Ok(()) => match winner {
                sync_take_newer::Winner::Host => {
                    pulled += 1;
                    replaced_local.push(rel);
                }
                sync_take_newer::Winner::Local => {
                    pushed += 1;
                    replaced_host.push(rel);
                }
            },
            Err(remote_sync::PushError::Skipped(skip)) => {
                eprintln!("auto-sync: take-newer skip {skip}");
                notice_changed |= remote_sync::note_mirror_skip(project_id, skip);
                skipped += 1;
            }
            Err(e) => {
                eprintln!("auto-sync: take-newer skip '{rel}': {e}");
                skipped += 1;
            }
        }
    }

    pass.note_unrecorded(records.flush().await);

    if let Some(root) = &backup {
        let recovery = Some(sync_take_newer::recovery_note(root));
        crate::services::local_loss::record_paths(
            project_id,
            crate::services::local_loss::LossSource::Sync,
            crate::services::local_loss::LossKind::Overwritten,
            "Auto-sync took the newer host copy of a file both sides had changed",
            replaced_local,
            recovery.clone(),
        );
        crate::services::local_loss::record_paths(
            project_id,
            crate::services::local_loss::LossSource::Sync,
            crate::services::local_loss::LossKind::OverwrittenOnHost,
            "Auto-sync took the newer local copy of a file both sides had changed",
            replaced_host,
            recovery,
        );
    }

    if pulled + pushed > 0 || notice_changed {
        if let Some(ctx) = ctx {
            ctx.emit(
                "auto-sync",
                AutoSyncEvent {
                    project_id: project_id.to_string(),
                    pulled,
                    pushed,
                    skipped_amber: skipped,
                    skipped_unsafe: remote_sync::mirror_skips(project_id),
                },
            );
        }
    }
}

/// What every transfer of one pass shares.
struct Pass<'a> {
    sftp: &'a openssh_sftp_client::Sftp,
    records: &'a remote_sync::RecordBatch<'a>,
    project_id: &'a str,
    mirror_root: &'a std::path::Path,
}

impl Pass<'_> {
    /// Pull `rel` into the mirror, returning its new local base. Bounded like
    /// the manual push: a stall on the pooled session must not hang this
    /// background task forever (which, sharing the session, would wedge every
    /// manual push too). A timeout skips the file; the pool keepalive then
    /// evicts a dead master. The caller records the base.
    async fn fetch(&self, rel: &str, host_abs: &str, host: Stat, mode: Option<u32>) -> Result<Stat, String> {
        run_bounded(remote_sync::pull_file(self.sftp, host_abs, host.0, mode, self.mirror_root, rel)).await
    }

    /// Push `rel` from the mirror, returning the new bases; the caller has
    /// decided the push is safe, and records them. Bounded as [`Self::fetch`] is.
    async fn send(&self, rel: &str, host_abs: &str) -> Result<remote_sync::PushedFile, remote_sync::PushError> {
        run_bounded(remote_sync::push_file_atomic(self.sftp, self.mirror_root, rel, host_abs)).await
    }

    /// [`Self::fetch`] and record the new base.
    async fn pull(&self, rel: &str, host_abs: &str, host: Stat, mode: Option<u32>) -> Result<(), String> {
        let local = self.fetch(rel, host_abs, host, mode).await?;
        self.note_unrecorded(self.records.record(rel, Transfer::Pull, host, local).await);
        Ok(())
    }

    /// [`Self::send`] and record the new bases.
    async fn push(&self, rel: &str, host_abs: &str) -> Result<(), remote_sync::PushError> {
        let done = self.send(rel, host_abs).await?;
        self.note_unrecorded(self.records.record(rel, Transfer::Push, done.host, done.local).await);
        Ok(())
    }

    /// Background: records that could not be saved are logged, and forgotten
    /// (both sides read as moved, so later passes skip those files).
    fn note_unrecorded(&self, saved: Result<(), remote_sync::Unrecorded>) {
        if let Err(lost) = saved {
            eprintln!(
                "auto-sync: {}: moved {} file(s) but could not record them: {}",
                self.project_id,
                lost.paths.len(),
                lost.error
            );
        }
    }
}

/// One candidate of a pass and what its decision needs. Its decision and transfer
/// run beside a few others' (`sync_pool::run_ordered`); what it moved is recorded
/// by the pass's sequential half, in candidate order.
#[derive(Clone, Copy)]
struct Candidate<'a> {
    pass: &'a Pass<'a>,
    manifest: &'a SyncManifestState,
    project_id: &'a str,
    /// The host project root.
    root: &'a str,
    rel: &'a str,
    /// The host walk's stat and mode, when the walk listed the file.
    walked: Option<(Stat, Option<u32>)>,
    take_newer: bool,
    /// Raised when a manual sync arrived during this file's host stat: no
    /// further file starts.
    handed_over: &'a AtomicBool,
}

/// What one candidate came to.
struct Step {
    action: Action,
    /// Whether the mirror-skip notice changed.
    notice_changed: bool,
}

enum Action {
    /// Green, not auto any more, or skipped for a reason already logged.
    None,
    /// Moved host → mirror; the new bases are for the manifest.
    Pulled { rel: String, host: Stat, local: Stat },
    /// Moved mirror → host.
    Pushed { rel: String, done: remote_sync::PushedFile },
    /// Left orange: changed on both sides, or the host raced a push.
    Skipped,
    /// Changed on both sides, and the newer copy will be taken.
    Resolve(Box<Resolvable>),
}

/// A both-sides-changed file the "take the newer copy" switch will resolve, with
/// the facts the pass saw. Resolved after the pass's other files, one at a time.
struct Resolvable {
    rel: String,
    host_abs: String,
    host: Option<Stat>,
    host_mode: Option<u32>,
    local: Option<Stat>,
    winner: sync_take_newer::Winner,
}

impl Candidate<'_> {
    async fn decide(self) -> Step {
        let mut notice_changed = false;
        let action = self.act(&mut notice_changed).await;
        Step { action, notice_changed }
    }

    /// The safe-direction policy for one file (the module docs): stat both sides,
    /// judge each against its base, move the side that alone changed.
    async fn act(self, notice_changed: &mut bool) -> Action {
        let Candidate { pass, manifest, project_id, root, rel, walked, take_newer, handed_over } = self;
        let host_abs = remote_sync::join_remote(root, rel);
        // `Option`, distinguishing a gone host path (None) from an empty file —
        // the same input `push_decision`/`divergence` expect (matches sync_push).
        // Only a positive NoSuchFile is `None`: a stat that could not answer
        // (permissions, a dropped session, no size) skips the file, where it used
        // to read as "gone" and let a never-synced file be pushed over a real one.
        let (host, host_mode) = match walked {
            Some((meta, mode)) => (Some(meta), mode),
            None => match unless_manual(project_id, sftp::metadata_opt_with_mode_on(pass.sftp, &host_abs)).await {
                None => {
                    handed_over.store(true, Ordering::SeqCst);
                    return Action::None;
                }
                Some(Ok(Some((size, mtime, mode)))) => (Some((size, mtime)), mode),
                Some(Ok(None)) => (None, None),
                Some(Err(e)) => {
                    eprintln!("auto-sync: skip '{rel}': {e}");
                    return Action::None;
                }
            },
        };
        // Same for the mirror, by lstat: only NotFound is gone, and a link (the
        // file, or a folder above it) or a special file is never read as the
        // regular file it replaced — it is left alone and reported.
        let local = match remote_sync::mirror_lstat(pass.mirror_root, rel) {
            Ok(remote_sync::MirrorStat::File(m)) => {
                if m.len() <= remote_sync::MAX_SYNC_FILE_BYTES {
                    *notice_changed |= remote_sync::clear_mirror_skip(project_id, rel);
                }
                Some(remote_sync::local_meta(&m))
            }
            Ok(remote_sync::MirrorStat::Missing) => {
                *notice_changed |= remote_sync::clear_mirror_skip(project_id, rel);
                None
            }
            Ok(remote_sync::MirrorStat::Skip(kind)) => {
                eprintln!("auto-sync: skip '{rel}': not a regular mirror file ({kind:?})");
                *notice_changed |= remote_sync::note_mirror_skip(
                    project_id,
                    remote_sync::MirrorSkip { rel: rel.to_string(), kind, size: None },
                );
                return Action::None;
            }
            Err(e) => {
                eprintln!("auto-sync: skip '{rel}': {e}");
                return Action::None;
            }
        };
        // The entry as it stands now, not as the pass's snapshot had it: a marker the
        // user changed mid-pass (auto off, an exclusion — those setters do not wait
        // for the pass) wins, and so does a base another record wrote.
        let entry = {
            let mut g = manifest.lock().await;
            let m = ensure_loaded(&mut g, project_id);
            if !remote_sync::is_auto(m, rel) {
                return Action::None;
            }
            m.get(rel).cloned().unwrap_or_default()
        };

        match remote_sync::divergence(&entry, host, local) {
            (false, false) => Action::None, // green
            (true, false) => {
                // Host changed only → pull (`divergence` flags the host side
                // only from a real stat).
                let Some(host) = host else { return Action::None };
                match pass.fetch(rel, &host_abs, host, host_mode).await {
                    Ok(local) => Action::Pulled { rel: rel.to_string(), host, local },
                    Err(e) => {
                        eprintln!("auto-sync: pull skip '{rel}': {e}");
                        Action::None
                    }
                }
            }
            (false, true) => {
                // Local changed only → push, but only if the host still matches the
                // recorded base (never clobber a racing host change). The walk's
                // size+mtime found the candidate; it is seconds old by now, so the
                // host is stat'd again for the decision itself.
                let host_now = if walked.is_some() {
                    match unless_manual(project_id, sftp::metadata_opt_on(pass.sftp, &host_abs)).await {
                        None => {
                            handed_over.store(true, Ordering::SeqCst);
                            return Action::None;
                        }
                        Some(Ok(now)) => now,
                        Some(Err(e)) => {
                            eprintln!("auto-sync: push skip '{rel}': {e}");
                            return Action::None;
                        }
                    }
                } else {
                    host
                };
                if remote_sync::push_decision(&entry, host_now) != PushDecision::Safe {
                    return Action::Skipped; // host raced → treat as a conflict, leave for manual
                }
                match pass.send(rel, &host_abs).await {
                    Ok(done) => Action::Pushed { rel: rel.to_string(), done },
                    Err(remote_sync::PushError::Skipped(skip)) => {
                        eprintln!("auto-sync: push skip {skip}");
                        *notice_changed |= remote_sync::note_mirror_skip(project_id, skip);
                        Action::None
                    }
                    Err(e) => {
                        eprintln!("auto-sync: push skip '{rel}': {e}");
                        Action::None
                    }
                }
            }
            (true, true) => {
                // AMBER/orange: left for manual resolution, unless the project
                // takes the newer copy and the two copies say which one that is.
                let winner = take_newer
                    .then(|| sync_take_newer::winner(host, local))
                    .flatten()
                    .filter(|_| sync_take_newer::within_cap(host, local))
                    .filter(|_| sync_take_newer::worth_trying(project_id, rel, host, local));
                match winner {
                    None => Action::Skipped,
                    Some(winner) => Action::Resolve(Box::new(Resolvable {
                        rel: rel.to_string(),
                        host_abs,
                        host,
                        host_mode,
                        local,
                        winner,
                    })),
                }
            }
        }
    }
}

/// One both-sides-changed file the "take the newer copy" switch resolves, with the
/// facts the pass already holds about it.
struct Conflict<'a> {
    pass: &'a Pass<'a>,
    backup_root: &'a std::path::Path,
    rel: &'a str,
    host_abs: &'a str,
    host: Option<Stat>,
    host_mode: Option<u32>,
    local: Option<Stat>,
}

/// Resolve a conflict to `winner`: back up the losing copy, check it has not moved
/// since the pass looked, then transfer and record the new base. Any failure before
/// the transfer leaves both sides untouched; the file then stays in the orange list.
async fn take_newer_copy(c: &Conflict<'_>, winner: sync_take_newer::Winner) -> Result<(), remote_sync::PushError> {
    let Some(host) = c.host else {
        return Err("no host copy".to_string().into());
    };
    let Pass { sftp, project_id, mirror_root, .. } = *c.pass;
    match winner {
        sync_take_newer::Winner::Host => {
            sync_take_newer::back_up_mirror_copy(mirror_root, c.backup_root, c.rel)?;
            // The local copy saved must be the one the pull replaces.
            let now = match remote_sync::mirror_lstat(mirror_root, c.rel)? {
                remote_sync::MirrorStat::File(m) => Some(remote_sync::local_meta(&m)),
                _ => None,
            };
            if now != c.local {
                return Err("the local copy changed during the pass".to_string().into());
            }
            c.pass.pull(c.rel, c.host_abs, host, c.host_mode).await?;
        }
        sync_take_newer::Winner::Local => {
            // The host copy goes into the backup folder first, by the same
            // confined, size-capped download a pull uses.
            run_bounded(remote_sync::pull_file(sftp, c.host_abs, host.0, c.host_mode, c.backup_root, c.rel)).await?;
            // …and must still be the host's copy when the push replaces it.
            let now = match unless_manual(project_id, sftp::metadata_opt_on(sftp, c.host_abs)).await {
                None => return Err("a manual sync is waiting".to_string().into()),
                Some(r) => r?,
            };
            if now != c.host {
                return Err("the host copy changed during the pass".to_string().into());
            }
            c.pass.push(c.rel, c.host_abs).await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(items: &[&str]) -> BTreeSet<String> {
        items.iter().map(|s| s.to_string()).collect()
    }
    fn hset(items: &[&str]) -> HashSet<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    /// A registered task that runs until `release` fires, holding the runner exit
    /// guard of a lease under `dir` exactly as `start` arranges it.
    fn fake_task(dir: &std::path::Path) -> (AutoSyncTask, tokio::sync::oneshot::Sender<()>, std::path::PathBuf) {
        let lease = crate::services::process_lease::path_in(dir, &crate::services::process_lease::remote_sync_key("p"));
        assert!(crate::services::process_lease::claim_at(&lease, false));
        let (exit, exited) = crate::services::process_lease::runner_exit_at(&lease);
        let (release, wait) = tokio::sync::oneshot::channel::<()>();
        let join = tokio::spawn(async move {
            let _exit = exit;
            let _ = wait.await;
        });
        (AutoSyncTask::for_test(join, exited, Arc::new(AtomicUsize::new(0))), release, lease)
    }

    /// Auto-sync starts only for a project that keeps a local copy: a
    /// remote-only or VM project has no mirror to watch or reconcile.
    #[test]
    fn auto_sync_skips_a_remote_only_project() {
        let spec = |vm: Option<bool>, remote_only: Option<bool>| crate::schema::project::RemoteSpec {
            user: None,
            host: "host.example".into(),
            port: None,
            remote_path: "/srv/p".into(),
            openvpn: None,
            auto_connect: None,
            key_auth: None,
            persist_sessions: None,
            agent_dir: None,
            vm,
            remote_only,
            label: None,
            extra: Default::default(),
        };
        assert!(has_mirror_to_sync(&spec(None, None)));
        assert!(has_mirror_to_sync(&spec(None, Some(false))));
        assert!(!has_mirror_to_sync(&spec(None, Some(true))));
        assert!(!has_mirror_to_sync(&spec(Some(true), None)));
    }

    /// A pause lifts when its guard drops — an early return included — and
    /// pauses nest, so one checkout ending never resumes another's.
    #[tokio::test]
    async fn a_pause_lifts_with_its_guard_and_pauses_nest() {
        let dir = tempfile::tempdir().unwrap();
        let (task, release, _) = fake_task(dir.path());
        let paused = Arc::clone(&task.extra);
        let state = new_state();
        state.lock().await.insert("p".into(), task);
        let outer = pause(&state, "p").await;
        let inner = pause(&state, "p").await;
        assert_eq!(paused.load(Ordering::SeqCst), 2);
        drop(inner);
        assert_eq!(paused.load(Ordering::SeqCst), 1, "still paused by the outer one");
        drop(outer);
        assert_eq!(paused.load(Ordering::SeqCst), 0);
        drop(pause(&state, "no-such-project").await);
        let _ = release.send(());
    }

    /// A stop that gives up waiting never detaches the task: it stays registered
    /// as stopping and keeps its lease until it really ends.
    #[tokio::test]
    async fn a_timed_out_stop_keeps_the_task_and_its_lease() {
        use crate::storage::FileLock;
        let dir = tempfile::tempdir().unwrap();
        let (task, release, lease) = fake_task(dir.path());
        let state = new_state();
        state.lock().await.insert("p".into(), task);
        assert!(!sync_task::stop(&state, "p", Duration::from_millis(50)).await);
        {
            let guard = state.lock().await;
            let t = guard.get("p").expect("still registered");
            assert!(t.stopping() && !t.ended());
        }
        assert!(sync_task::behind_stopping(&state, "p").await.is_some(), "a start waits behind it");
        assert!(FileLock::try_exclusive(&lease).unwrap().is_none(), "the lease is still the task's");
        // A restart deferred behind it now (a reconnect) …
        let (stops, seen) = sync_task::stops_of(&state, "p").await;
        assert!(sync_task::restart_still_wanted(&stops, seen));
        // … is dropped by a newer stop (a second disconnect) before the task ends.
        let deferred = sync_task::behind_stopping(&state, "p").await.expect("still stopping");
        assert!(!sync_task::stop(&state, "p", Duration::from_millis(10)).await);
        assert!(!sync_task::restart_still_wanted(&stops, seen), "the later stop wins");
        let _ = release.send(());
        assert!(!deferred.await, "the deferred start sees the later stop once the task ended");
        assert!(sync_task::stop(&state, "p", Duration::from_secs(5)).await);
        assert!(!state.lock().await.contains_key("p"), "gone once it ended");
        assert!(sync_task::behind_stopping(&state, "p").await.is_none(), "nothing left to wait behind");
        assert!(FileLock::try_exclusive(&lease).unwrap().is_some(), "released with the task");
    }

    /// A burst settles once it pauses, and one that never pauses is absorbed
    /// for `max` only: the pass behind it is no longer held off for as long as
    /// a log is appended.
    #[tokio::test(start_paused = true)]
    async fn a_burst_is_absorbed_until_it_pauses_or_for_max() {
        let (quiet, max) = (Duration::from_secs(1), Duration::from_secs(5));
        let cancel = Notify::new();

        let (tx, mut rx) = mpsc::unbounded_channel::<()>();
        let started = tokio::time::Instant::now();
        assert!(absorb_burst(&mut rx, &cancel, quiet, max).await);
        assert_eq!(started.elapsed(), quiet, "a single event settles after the quiet time");

        let feeder = tokio::spawn(async move {
            while tx.send(()).is_ok() {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        });
        let started = tokio::time::Instant::now();
        assert!(absorb_burst(&mut rx, &cancel, quiet, max).await);
        assert_eq!(started.elapsed(), max, "steady events end at the bound");

        feeder.abort();
        let _ = feeder.await;
        assert!(!absorb_burst(&mut rx, &cancel, quiet, max).await, "the watcher is gone");
    }

    #[test]
    fn tracked_files_are_left_to_lockstep_when_it_is_on() {
        // #28p D1: byte-sync must not ship a git-tracked file as loose bytes — landing
        // it untracked on the peer is what blocks the fast-forward that would have
        // delivered it as a commit.
        let mut c = set(&["src/a.rs", "notes.md", "build/out.bin"]);
        drop_tracked(&mut c, &Ok(hset(&["src/a.rs", "README.md"])), true).unwrap();
        assert_eq!(c, set(&["notes.md", "build/out.bin"]));
    }

    #[test]
    fn git_and_app_writes_do_not_wake_the_byte_sync_loop() {
        use std::path::{Path, PathBuf};
        let mirror = Path::new("/m/mirror");
        let p = |s: &str| PathBuf::from(s);
        // Lockstep's own writes and git's stat-cache refreshes all live here.
        assert!(!event_touches_synced_bytes(
            mirror,
            &[p("/m/mirror/.git/index"), p(concat!("/m/mirror/.git/refs/", crate::app_slug!(), "/peer/main"))]
        ));
        assert!(!event_touches_synced_bytes(mirror, &[p(concat!("/m/mirror/.", crate::app_slug!(), "/tabs.json"))]));
        // A real file write anywhere else does — even alongside a .git one.
        assert!(event_touches_synced_bytes(
            mirror,
            &[p("/m/mirror/.git/index"), p("/m/mirror/src/a.rs")]
        ));
        // A file merely *named* like the dirs is not inside them.
        assert!(event_touches_synced_bytes(mirror, &[p("/m/mirror/.gitignore")]));
        assert!(event_touches_synced_bytes(mirror, &[p("/m/mirror/sub/.git/config")]));
        // No paths (a rescan/overflow notice) and a path outside the mirror both
        // err toward running the pass rather than skipping it.
        assert!(event_touches_synced_bytes(mirror, &[]));
        assert!(event_touches_synced_bytes(mirror, &[p("/elsewhere/x")]));
    }

    /// macOS's FSEvents names a mirror reached through a symlink by its real
    /// path: a `.git` write there must still not wake the loop.
    #[test]
    fn a_git_write_under_the_mirrors_real_path_does_not_wake_the_loop() {
        use std::path::PathBuf;
        let p = |parts: &[&str]| parts.iter().collect::<PathBuf>();
        let mirrors = [p(&["link", "mirror"]), p(&["real", "mirror"])];
        assert!(!event_touches_synced_bytes_under(&mirrors, &[p(&["real", "mirror", ".git", "index"])]));
        assert!(!event_touches_synced_bytes_under(&mirrors, &[p(&["link", "mirror", ".git", "index"])]));
        assert!(event_touches_synced_bytes_under(&mirrors, &[p(&["real", "mirror", "src", "a.rs"])]));
        assert!(event_touches_synced_bytes_under(&mirrors, &[p(&["elsewhere", "x"])]));
        assert!(event_touches_synced_bytes_under(&mirrors, &[]));
    }

    #[test]
    fn lockstep_off_changes_nothing() {
        // A project that never opted in keeps exactly today's behaviour, tracked files
        // and all — this fix must not quietly stop syncing files for those projects.
        let mut c = set(&["src/a.rs", "notes.md"]);
        drop_tracked(&mut c, &Ok(hset(&["src/a.rs"])), false).unwrap();
        assert_eq!(c, set(&["src/a.rs", "notes.md"]));
        // Off, a listing git could not give is never even asked about.
        drop_tracked(&mut c, &Err("no git".into()), false).unwrap();
        assert_eq!(c, set(&["src/a.rs", "notes.md"]));

        // An empty tracked set that git answered (an unborn repo) is likewise a no-op.
        let mut c = set(&["src/a.rs"]);
        drop_tracked(&mut c, &Ok(HashSet::new()), true).unwrap();
        assert_eq!(c, set(&["src/a.rs"]));
    }

    /// With lockstep on, a tracked set git could not list is not "lockstep owns
    /// nothing": byte-sync would then write the very files lockstep owns.
    #[test]
    fn an_unlisted_tracked_set_defers_byte_sync_when_lockstep_is_on() {
        let mut c = set(&["src/a.rs", "notes.md"]);
        let err = drop_tracked(&mut c, &Err("git ls-files failed".into()), true).unwrap_err();
        assert!(err.contains("git ls-files failed"), "{err}");
        assert_eq!(c, set(&["src/a.rs", "notes.md"]), "the candidates are left for the caller to drop");
    }
}
