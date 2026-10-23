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
//!   - both moved (AMBER/orange)    → SKIP, left for manual resolution
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
use tokio::sync::{mpsc, Mutex, Notify};
use tokio::time::MissedTickBehavior;

use crate::schema::net_usage;
use crate::services::remote::{pooled_sftp, remote_target_for, RemotePoolState, RemoteTarget};
use crate::services::remote_sync::{
    self, ensure_loaded, mirror_dir, mirror_local_path, Manifest, PushDecision, SyncManifestState,
};
use crate::services::sftp;

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
async fn run_bounded<T>(
    fut: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    match tokio::time::timeout(RECONCILE_FILE_TIMEOUT, fut).await {
        Ok(r) => r,
        Err(_) => Err(format!(
            "transfer stalled after {}s (remote connection may have dropped)",
            RECONCILE_FILE_TIMEOUT.as_secs()
        )),
    }
}

/// One running auto-sync task: its cancel signal, its join handle, and the mirror
/// watcher whose lifetime is tied to the task (dropping it unwatches).
pub struct AutoSyncTask {
    cancel: Arc<Notify>,
    join: tokio::task::JoinHandle<()>,
    /// Held [`PauseGuard`]s: while non-zero, the loop skips its passes so a git
    /// checkout (`services::git_peer`) can rewrite the mirror without those writes
    /// being pulled/pushed. `git_peer` re-stamps the file-sync bases before its
    /// guard drops, so the next pass reads the rewritten tracked files as green
    /// rather than as local edits. (A pass already running is not interrupted by a
    /// pause: the checkout waits for it on the project's mutation lock instead.)
    paused: Arc<AtomicUsize>,
    /// Set by [`stop`]: the running pass ends after its current file, and the task
    /// is on its way out even if it outlasts the stop's wait.
    stopping: Arc<AtomicBool>,
    /// How many stops this task has been asked for: a restart deferred behind it
    /// is dropped when a newer stop (a second disconnect) came after it.
    stops: Arc<AtomicUsize>,
    /// Flips when the task has really ended (and released its lease).
    exited: crate::services::process_lease::RunnerExited,
}

impl AutoSyncTask {
    fn ended(&self) -> bool {
        self.join.is_finished() || *self.exited.borrow()
    }
}

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
pub type AutoSyncState = Arc<Mutex<HashMap<String, AutoSyncTask>>>;

/// Build a fresh, empty registry for `tauri::Builder::manage`.
pub fn new_state() -> AutoSyncState {
    Arc::new(Mutex::new(HashMap::new()))
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
    {
        let guard = state.lock().await;
        if let Some(t) = guard.get(project_id) {
            if t.stopping.load(Ordering::SeqCst) && !t.ended() {
                let mut exited = t.exited.clone();
                let stops = Arc::clone(&t.stops);
                let seen = stops.load(Ordering::SeqCst);
                let state = state.clone();
                let project_id = project_id.to_string();
                tokio::spawn(async move {
                    let _ = exited.wait_for(|done| *done).await;
                    if restart_still_wanted(&stops, seen) && pooled_sftp(&pool, &project_id).await.is_some() {
                        start_now(ctx, pool, manifest, &state, &project_id).await;
                    }
                });
                return;
            }
        }
    }
    start_now(ctx, pool, manifest, state, project_id).await;
}

/// Whether a restart deferred behind a stopping task (that had seen `seen` stops)
/// is still wanted: not when the project was stopped again since — that stop is
/// the newer intent, and the pool it saw may only be about to close.
pub(crate) fn restart_still_wanted(stops: &AtomicUsize, seen: usize) -> bool {
    stops.load(Ordering::SeqCst) == seen
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
    // …and a host the user tagged HPC gets no *background* sync at all. Every
    // pass walks the host tree over SFTP, and on a cluster that tree is normally
    // on the parallel filesystem, where a recursive walk is a metadata storm
    // against a shared server — at a 25 s cadence, unasked for, for as long as the
    // project is open. Manual sync (the file view's push/pull) is untouched: the
    // objection is to the cadence, not to the transfer.
    if crate::services::hpc_mode::is_hpc_spec(&target.spec) {
        return;
    }
    let mut guard = state.lock().await;
    // A loop that ended on its own (the host was tagged HPC mid-session) leaves a
    // finished task behind; treating that as "already running" would refuse every
    // restart until the next disconnect, so untagging the host would change nothing.
    if guard.get(project_id).is_some_and(AutoSyncTask::ended) {
        guard.remove(project_id);
    }
    if guard.contains_key(project_id) {
        return; // already running
    }
    // One loop per mirror: the other process sharing this state dir (the
    // window or its desktop sidecar) may already run it (`process_lease`,
    // final review B4); it keeps doing so, and this one's manual syncs still
    // work (the manifest is compare-and-swap across processes).
    let key = crate::services::process_lease::remote_sync_key(project_id);
    if !crate::services::process_lease::claim_sync(&key) {
        eprintln!("sync_auto: {project_id}: another process of this app runs its auto-sync");
        return;
    }

    // Mirror watcher → mpsc into the loop (debounced there). The mirror must
    // exist for the recursive watch to attach (connect() already creates it, but
    // be defensive for a first-ever run).
    //
    // The watcher itself is attached by the loop, not here, and only once the
    // manifest actually marks something for auto-sync — see `attach_watcher`.
    let mirror = mirror_dir(project_id);
    let _ = std::fs::create_dir_all(&mirror);
    let (tx, rx) = mpsc::unbounded_channel::<()>();

    let cancel = Arc::new(Notify::new());
    let paused = Arc::new(AtomicUsize::new(0));
    let stopping = Arc::new(AtomicBool::new(false));
    let (exit, exited) = crate::services::process_lease::runner_exit(&key);
    let loop_fut = run_loop(
        ctx,
        pool,
        manifest,
        target,
        project_id.to_string(),
        mirror,
        tx,
        rx,
        cancel.clone(),
        paused.clone(),
        stopping.clone(),
    );
    let join = tokio::spawn(async move {
        let _exit = exit; // the lease ends with this task, however it ends
        loop_fut.await;
    });
    guard.insert(
        project_id.to_string(),
        AutoSyncTask {
            cancel,
            join,
            paused,
            stopping,
            stops: Arc::new(AtomicUsize::new(0)),
            exited,
        },
    );
}

/// Pause the project's auto-sync reconcile passes until the returned guard drops
/// (a no-op guard if no task). Used by `services::git_peer` around a coordinated
/// checkout so the checkout's mirror writes are neither pulled nor pushed; drop the
/// guard only after re-stamping any checkout-rewritten tracked-file bases, else the
/// next pass will treat them as local edits. Pauses nest.
pub async fn pause(state: &AutoSyncState, project_id: &str) -> PauseGuard {
    let paused = state.lock().await.get(project_id).map(|t| Arc::clone(&t.paused));
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
    stop_within(state, project_id, Duration::from_secs(5)).await;
}

async fn stop_within(state: &AutoSyncState, project_id: &str, wait: Duration) {
    let mut exited = {
        let guard = state.lock().await;
        let Some(t) = guard.get(project_id) else {
            return;
        };
        t.stopping.store(true, Ordering::SeqCst);
        t.stops.fetch_add(1, Ordering::SeqCst);
        t.cancel.notify_one();
        t.exited.clone()
    };
    if crate::services::process_lease::wait_runner_exit(&mut exited, wait).await {
        let mut guard = state.lock().await;
        if guard.get(project_id).is_some_and(AutoSyncTask::ended) {
            guard.remove(project_id);
        }
    } else {
        eprintln!("sync_auto: {project_id}: a transfer is still finishing; auto-sync keeps the project until it ends");
    }
}

/// Stop every auto-sync task. Used at app exit before tearing down the pool.
pub async fn stop_all(state: &AutoSyncState) {
    let tasks: Vec<AutoSyncTask> = state.lock().await.drain().map(|(_, t)| t).collect();
    for t in tasks {
        t.stopping.store(true, Ordering::SeqCst); // a running pass ends after its file
        t.cancel.notify_one();
        let _ = tokio::time::timeout(Duration::from_secs(5), t.join).await;
    }
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
pub fn event_touches_synced_bytes(mirror: &std::path::Path, paths: &[std::path::PathBuf]) -> bool {
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

/// The per-project loop: reconcile on a fixed interval (host changes) and shortly
/// after any mirror write (local changes), until cancelled. A single task ⇒ passes
/// are serialized and never overlap.
/// Whether this loop's host is tagged HPC **right now** — the same gate `start()`
/// applies, asked again on every tick so tagging a machine mid-session actually
/// stops the traffic rather than only preventing the next start.
fn hpc_now(target: &RemoteTarget) -> bool {
    crate::services::hpc_mode::is_hpc_spec(&target.spec)
}

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
                if paused.load(Ordering::SeqCst) > 0 { continue; }
                // Cheap once attached; this is what picks up a `sync_set_auto` that
                // marked the first path after the task was already running.
                ensure_watcher(&mut watcher, &manifest, &project_id, &mirror, &tx).await;
                reconcile_pass(Some(&ctx), &pool, &manifest, &target, &project_id, &paused, &stopping).await;
            }
            res = rx.recv() => {
                if res.is_none() { break; } // watcher gone → stop
                // Debounce: absorb the rest of the burst before reconciling.
                loop {
                    tokio::select! {
                        _ = cancel.notified() => return,
                        _ = tokio::time::sleep(DEBOUNCE) => break,
                        res = rx.recv() => { if res.is_none() { return; } }
                    }
                }
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
/// that paused the loop held it first) and `stopping` again between files.
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
    let mut walked_host_meta: HashMap<String, (u64, Option<u64>)> = HashMap::new();
    let mut walked_host_mode: HashMap<String, Option<u32>> = HashMap::new();
    for d in &auto_dirs {
        match remote_sync::walk_host_files(&sftp, &target.spec.remote_path, d).await {
            Ok(files) => {
                for file in files {
                    walked_host_meta.insert(file.rel.clone(), (file.size, file.mtime));
                    walked_host_mode.insert(file.rel.clone(), file.mode);
                    candidates.insert(file.rel);
                }
            }
            Err(_) => return, // connection dropped mid-walk → abandon this pass
        }
        if let Ok(local) = remote_sync::walk_mirror_files(project_id, d) {
            candidates.extend(local);
        }
    }
    // Drop paths carved out by a local OFF override (an `auto_off` on the file or a
    // nearer directory marker): the reconcile only touches paths whose *effective*
    // auto-sync is on, so a project-wide auto can still exclude individual subtrees.
    candidates.retain(|rel| remote_sync::is_auto(&snapshot, rel));
    walked_host_meta.retain(|rel, _| candidates.contains(rel));

    // #28p D1: with git lockstep on, the tracked tree belongs to lockstep — it delivers
    // those files as *commits*. Shipping them here as loose bytes first lands them on
    // the peer untracked, which then blocks the very fast-forward that would have
    // delivered them properly (git refuses to overwrite an untracked file even when it
    // is byte-identical). Which of those two happened used to be decided by a debounce
    // race between the two engines — nondeterministically wedging the project.
    // Only asked when lockstep is on; a listing git could not give defers the pass.
    let lockstep = crate::services::git_peer::load_state(project_id).enabled;
    let tracked = if lockstep {
        crate::services::git_peer::tracked_paths(project_id)
    } else {
        Ok(HashSet::new())
    };
    if let Err(e) = drop_tracked(&mut candidates, &tracked, lockstep) {
        eprintln!("auto-sync: {project_id}: {e}");
        return;
    }

    let mirror_root = mirror_dir(project_id);
    let mut pulled = 0usize;
    let mut pushed = 0usize;
    let mut skipped = 0usize;
    for rel in candidates {
        if stopping.load(Ordering::SeqCst) {
            break; // stopped: end after the file in flight, not after the whole tree
        }
        let host_abs = remote_sync::join_remote(&target.spec.remote_path, &rel);
        // `Option`, distinguishing a gone host path (None) from an empty file —
        // the same input `push_decision`/`divergence` expect (matches sync_push).
        // Only a positive NoSuchFile is `None`: a stat that could not answer
        // (permissions, a dropped session, no size) skips the file, where it used
        // to read as "gone" and let a never-synced file be pushed over a real one.
        let walked = walked_host_meta.get(&rel).copied();
        let (host, host_mode) = match walked {
            Some(meta) => (Some(meta), walked_host_mode.get(&rel).copied().flatten()),
            None => match sftp::metadata_opt_with_mode_on(&sftp, &host_abs).await {
                Ok(Some((size, mtime, mode))) => (Some((size, mtime)), mode),
                Ok(None) => (None, None),
                Err(e) => {
                    eprintln!("auto-sync: skip '{rel}': {e}");
                    continue;
                }
            },
        };
        let local_path = mirror_local_path(project_id, &rel);
        // Same for the mirror: only NotFound is gone.
        let local = match std::fs::metadata(&local_path) {
            Ok(m) => Some(remote_sync::local_meta(&m)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => {
                eprintln!("auto-sync: skip '{rel}': {e}");
                continue;
            }
        };
        // The entry as it stands now, not as the pass's snapshot had it: a marker the
        // user changed mid-pass (auto off, an exclusion — those setters do not wait
        // for the pass) wins, and so does a base another record wrote.
        let entry = {
            let mut g = manifest.lock().await;
            let m = ensure_loaded(&mut g, project_id);
            if !remote_sync::is_auto(m, &rel) {
                continue;
            }
            m.get(&rel).cloned().unwrap_or_default()
        };

        match remote_sync::divergence(&entry, host, local) {
            (false, false) => {} // green
            (true, false) => {
                // Host changed only → pull. `host` is Some here (divergence only
                // flags the host side from a real stat).
                if let Some((hsize, _)) = host {
                    // Bounded like the manual push: a stall on the pooled session
                    // must not hang this background task forever (which, sharing the
                    // session, would wedge every manual push too). A timeout abandons
                    // the pass; the pool keepalive then evicts a dead master.
                    match run_bounded(remote_sync::pull_file(&sftp, &host_abs, hsize, host_mode, &mirror_root, &rel))
                        .await
                    {
                        Ok((ls, lm)) => {
                            let (hs, hm) = host.unwrap_or((hsize, None));
                            let mut g = manifest.lock().await;
                            let m = ensure_loaded(&mut g, project_id);
                            remote_sync::record_pull(m, &rel, hs, hm, ls, lm);
                            // Background: logged; the unsaved record is forgotten
                            // (both sides read as moved, so later passes skip it).
                            if let Err(e) = remote_sync::save_manifest_or_mark_stale(
                                project_id,
                                m,
                                std::slice::from_ref(&rel),
                            ) {
                                eprintln!("auto-sync: pulled '{rel}' but could not record it: {e}");
                            }
                            net_usage::record_files(project_id, 1, 0);
                            pulled += 1;
                        }
                        Err(e) => eprintln!("auto-sync: pull skip '{rel}': {e}"),
                    }
                }
            }
            (false, true) => {
                // Local changed only → push, but only if the host still matches the
                // recorded base (never clobber a racing host change). The walk's
                // size+mtime found the candidate; it is seconds old by now, so the
                // host is stat'd again for the decision itself.
                let host_now = if walked.is_some() {
                    match sftp::metadata_opt_on(&sftp, &host_abs).await {
                        Ok(now) => now,
                        Err(e) => {
                            eprintln!("auto-sync: push skip '{rel}': {e}");
                            continue;
                        }
                    }
                } else {
                    host
                };
                if remote_sync::push_decision(&entry, host_now) == PushDecision::Safe {
                    match run_bounded(remote_sync::push_file_atomic(&sftp, &local_path, &host_abs))
                        .await
                    {
                        Ok((hs, hm)) => {
                            let (ls, lm) =
                                remote_sync::local_size_mtime(std::fs::metadata(&local_path).ok());
                            let mut g = manifest.lock().await;
                            let m = ensure_loaded(&mut g, project_id);
                            remote_sync::record_push(m, &rel, hs, hm, ls, lm);
                            if let Err(e) = remote_sync::save_manifest_or_mark_stale(
                                project_id,
                                m,
                                std::slice::from_ref(&rel),
                            ) {
                                eprintln!("auto-sync: pushed '{rel}' but could not record it: {e}");
                            }
                            net_usage::record_files(project_id, 0, 1);
                            pushed += 1;
                        }
                        Err(e) => eprintln!("auto-sync: push skip '{rel}': {e}"),
                    }
                } else {
                    skipped += 1; // host raced → treat as a conflict, leave for manual
                }
            }
            (true, true) => skipped += 1, // AMBER/orange → never auto-synced
        }
    }

    if pulled + pushed > 0 {
        if let Some(ctx) = ctx {
            ctx.emit(
                "auto-sync",
                AutoSyncEvent {
                    project_id: project_id.to_string(),
                    pulled,
                    pushed,
                    skipped_amber: skipped,
                },
            );
        }
    }
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
        let task = AutoSyncTask {
            cancel: Arc::new(Notify::new()),
            join,
            paused: Arc::new(AtomicUsize::new(0)),
            stopping: Arc::new(AtomicBool::new(false)),
            stops: Arc::new(AtomicUsize::new(0)),
            exited,
        };
        (task, release, lease)
    }

    /// A pause lifts when its guard drops — an early return included — and
    /// pauses nest, so one checkout ending never resumes another's.
    #[tokio::test]
    async fn a_pause_lifts_with_its_guard_and_pauses_nest() {
        let dir = tempfile::tempdir().unwrap();
        let (task, release, _) = fake_task(dir.path());
        let paused = Arc::clone(&task.paused);
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
        stop_within(&state, "p", Duration::from_millis(50)).await;
        {
            let guard = state.lock().await;
            let t = guard.get("p").expect("still registered");
            assert!(t.stopping.load(Ordering::SeqCst) && !t.ended());
        }
        assert!(FileLock::try_exclusive(&lease).unwrap().is_none(), "the lease is still the task's");
        // A restart deferred behind it now (a reconnect) …
        let (stops, seen) = {
            let guard = state.lock().await;
            let t = &guard["p"];
            (Arc::clone(&t.stops), t.stops.load(Ordering::SeqCst))
        };
        assert!(restart_still_wanted(&stops, seen));
        // … is dropped by a newer stop (a second disconnect) before the task ends.
        stop_within(&state, "p", Duration::from_millis(10)).await;
        assert!(!restart_still_wanted(&stops, seen), "the later stop wins");
        let _ = release.send(());
        stop_within(&state, "p", Duration::from_secs(5)).await;
        assert!(!state.lock().await.contains_key("p"), "gone once it ended");
        assert!(FileLock::try_exclusive(&lease).unwrap().is_some(), "released with the task");
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
