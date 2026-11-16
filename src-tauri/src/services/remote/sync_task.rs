//! The lifecycle the two per-project background loops share: `sync_auto`'s
//! reconcile loop and `git_peer`'s lockstep poll.
//!
//! One task per project and registry, and one per mirror across this app's
//! processes (`process_lease`). A task that outlasts its stop's wait stays
//! registered as stopping and keeps its lease until it really ends, so a slow
//! transfer or pass is never detached while the project reads as free; a start
//! that finds it waits behind it ([`behind_stopping`]).

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{Mutex, Notify};

use crate::services::process_lease::{self, RunnerExited};

/// How long a stop waits for the task to end before leaving it to finish.
pub const STOP_WAIT: Duration = Duration::from_secs(5);

/// One running loop. `extra` is what its owner keeps beside it (`sync_auto`'s
/// pause count).
pub struct Task<X = ()> {
    cancel: Arc<Notify>,
    join: tokio::task::JoinHandle<()>,
    /// Set by [`stop`]: the loop ends after the file or pass it is in, and the
    /// task is on its way out even if it outlasts the stop's wait.
    stopping: Arc<AtomicBool>,
    /// How many stops this task has been asked for: a restart deferred behind it
    /// is dropped when a newer stop (a second disconnect) came after it.
    stops: Arc<AtomicUsize>,
    /// Flips when the task has really ended (and released its lease).
    exited: RunnerExited,
    pub extra: X,
}

impl<X> Task<X> {
    pub fn ended(&self) -> bool {
        self.join.is_finished() || *self.exited.borrow()
    }

    /// Stopped, though it may still be finishing.
    pub fn stopping(&self) -> bool {
        self.stopping.load(Ordering::SeqCst)
    }

    /// A task around an already-spawned `join` that holds the lease's exit guard.
    #[cfg(test)]
    pub(crate) fn for_test(join: tokio::task::JoinHandle<()>, exited: RunnerExited, extra: X) -> Self {
        Task {
            cancel: Arc::new(Notify::new()),
            join,
            stopping: Arc::new(AtomicBool::new(false)),
            stops: Arc::new(AtomicUsize::new(0)),
            exited,
            extra,
        }
    }
}

/// A registry of per-project tasks, keyed by project id.
pub type Tasks<X = ()> = Arc<Mutex<HashMap<String, Task<X>>>>;

pub fn new_tasks<X>() -> Tasks<X> {
    Arc::new(Mutex::new(HashMap::new()))
}

/// What a loop is handed to notice its stop: `cancel` wakes it between passes,
/// `stopping` is what a pass already running checks.
pub struct Stop {
    pub cancel: Arc<Notify>,
    pub stopping: Arc<AtomicBool>,
}

/// Whether a restart deferred behind a stopping task (that had seen `seen` stops)
/// is still wanted: not when the project was stopped again since — that stop is
/// the newer intent, and the pool it saw may only be about to close.
pub(crate) fn restart_still_wanted(stops: &AtomicUsize, seen: usize) -> bool {
    stops.load(Ordering::SeqCst) == seen
}

/// `None` when a task for `project_id` can be started now. When a stopped one
/// is still finishing, the wait for it: resolves once it has ended, to whether
/// the start is still wanted then (no newer stop came). The caller starts the
/// new task after it, never beside the old one.
pub async fn behind_stopping<X>(
    tasks: &Tasks<X>,
    project_id: &str,
) -> Option<impl Future<Output = bool> + Send + 'static> {
    let guard = tasks.lock().await;
    let task = guard.get(project_id).filter(|t| t.stopping() && !t.ended())?;
    let mut exited = task.exited.clone();
    let stops = Arc::clone(&task.stops);
    let seen = stops.load(Ordering::SeqCst);
    Some(async move {
        let _ = exited.wait_for(|done| *done).await;
        restart_still_wanted(&stops, seen)
    })
}

/// Register and spawn `project_id`'s loop, unless one is registered and alive or
/// another process of this app holds `lease` (it keeps running the loop; `busy`
/// is logged). `make` builds the loop and its `extra` only once the task is
/// certain to start.
pub async fn spawn<X, Fut>(
    tasks: &Tasks<X>,
    project_id: &str,
    lease: &str,
    busy: &str,
    make: impl FnOnce(Stop) -> (Fut, X),
) where
    Fut: Future<Output = ()> + Send + 'static,
{
    let mut guard = tasks.lock().await;
    // A loop that ended on its own (the host was tagged HPC mid-session) leaves a
    // finished task behind; treating that as "already running" would refuse every
    // restart until the next disconnect, so untagging the host would change nothing.
    if guard.get(project_id).is_some_and(Task::ended) {
        guard.remove(project_id);
    }
    if guard.contains_key(project_id) {
        return; // already running
    }
    // One loop per mirror: the other process sharing this state dir (the window
    // or its desktop sidecar) may already run it (final review B4).
    if !process_lease::claim_sync(lease) {
        eprintln!("{busy}");
        return;
    }
    let cancel = Arc::new(Notify::new());
    let stopping = Arc::new(AtomicBool::new(false));
    let (exit, exited) = process_lease::runner_exit(lease);
    let (run, extra) = make(Stop { cancel: cancel.clone(), stopping: stopping.clone() });
    let join = tokio::spawn(async move {
        let _exit = exit; // the lease ends with this task, however it ends
        run.await;
    });
    guard.insert(
        project_id.to_string(),
        Task { cancel, join, stopping, stops: Arc::new(AtomicUsize::new(0)), exited, extra },
    );
}

/// Stop `project_id`'s task and wait up to `wait` for it to end. False when it is
/// still finishing: it stays registered as stopping and keeps its lease until it
/// ends. True when it ended (and was removed) or there was none.
pub async fn stop<X>(tasks: &Tasks<X>, project_id: &str, wait: Duration) -> bool {
    let mut exited = {
        let guard = tasks.lock().await;
        let Some(task) = guard.get(project_id) else {
            return true;
        };
        task.stopping.store(true, Ordering::SeqCst);
        task.stops.fetch_add(1, Ordering::SeqCst);
        task.cancel.notify_one();
        task.exited.clone()
    };
    if !process_lease::wait_runner_exit(&mut exited, wait).await {
        return false;
    }
    let mut guard = tasks.lock().await;
    if guard.get(project_id).is_some_and(Task::ended) {
        guard.remove(project_id);
    }
    true
}

/// Stop every task and wait for each (app exit, before the pool is torn down).
pub async fn stop_all<X>(tasks: &Tasks<X>) {
    let all: Vec<Task<X>> = tasks.lock().await.drain().map(|(_, t)| t).collect();
    for task in all {
        task.stopping.store(true, Ordering::SeqCst);
        task.cancel.notify_one();
        let _ = tokio::time::timeout(STOP_WAIT, task.join).await;
    }
}

/// How many stops `project_id`'s task has been asked for, and the counter itself.
#[cfg(test)]
pub(crate) async fn stops_of<X>(tasks: &Tasks<X>, project_id: &str) -> (Arc<AtomicUsize>, usize) {
    let guard = tasks.lock().await;
    let task = &guard[project_id];
    (Arc::clone(&task.stops), task.stops.load(Ordering::SeqCst))
}
