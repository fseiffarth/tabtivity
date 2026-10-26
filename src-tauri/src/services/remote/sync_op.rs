//! One mutation owner per remote project (`docs/auto_sync_safety_plan.md`,
//! phase 1b).
//!
//! Byte-sync (the auto pass, manual pull/push/delete, a content-verified
//! resolve) and Git Lockstep (its background pass, checkout, resolve, restore)
//! all rewrite the same mirror and the same host tree. They used to be guarded
//! separately — lockstep by its own reconcile lock, byte-sync by nothing but
//! the per-file manifest mutex and a pause flag read at pass start — so a
//! checkout could run beside a transfer that was still writing, and the window
//! and its desktop sidecar each ran their manual commands unaware of the
//! other's. [`acquire`] is now the one lock all of them take, for their whole
//! operation: an in-process async mutex (so waiting never blocks a thread),
//! then an advisory file lock under `<state_dir>/leases/` (so the other process
//! sharing the state dir waits too).
//!
//! There is deliberately one lock, not one per engine: a single lock has no
//! order to get wrong. Never acquire it while holding a manifest mutex, and
//! never from code a holder calls (it is not reentrant) — the holders are the
//! command and loop entry points, never the helpers under them.
//!
//! The user's own commands take it through [`acquire_manual`], which the
//! background auto-sync pass yields to at its next safe point: a click never
//! waits out a whole-tree walk.
//!
//! Its identity boundary is the state dir plus the project id: two separate
//! installations, or two registrations of one checkout, do not coordinate and
//! are external writers to each other.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, OnceLock};

use app_core::sync::LockExt;
use tokio::sync::{Mutex, OwnedMutexGuard};

use crate::storage::FileLock;

/// The project's mutation lock, held for an operation's whole length. Dropping
/// it releases the other process first, then this one's next waiter.
pub struct SyncOp {
    _file: Option<FileLock>,
    _local: OwnedMutexGuard<()>,
}

/// How often a waiter re-asks for the lock the other process holds.
const LOCK_POLL: std::time::Duration = std::time::Duration::from_millis(25);

/// One async mutex per project id, for this process.
fn local_locks() -> &'static std::sync::Mutex<HashMap<String, Arc<Mutex<()>>>> {
    static LOCKS: OnceLock<std::sync::Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(Default::default)
}

/// Take `project_id`'s mutation lock, waiting for the current holder in this
/// process or the other one. `Err` when the cross-process lock exists but could
/// not be taken: whether the other process is mid-write is then unknown, so the
/// caller writes nothing. A file system without advisory locks proceeds with
/// the in-process lock alone, as before leases existed.
pub async fn acquire(project_id: &str) -> Result<SyncOp, String> {
    acquire_in(&crate::storage::state_dir(), project_id).await
}

/// [`acquire`] with its lock file under `state_dir`.
pub async fn acquire_in(state_dir: &Path, project_id: &str) -> Result<SyncOp, String> {
    let local = {
        let mut locks = local_locks().lock_ok();
        Arc::clone(locks.entry(project_id.to_string()).or_default())
    };
    let local = local.lock_owned().await;
    let path = crate::services::process_lease::path_in(
        state_dir,
        &crate::services::process_lease::sync_op_key(project_id),
    );
    // Polled, not a blocking `flock` on a pool thread: a waiter dropped mid-wait
    // (a cancelled command, a stopping loop) then simply stops asking, and no
    // blocking task is left that a shutting-down runtime would have to wait for.
    let file = loop {
        match FileLock::try_exclusive(&path) {
            Ok(Some(lock)) => break Some(lock),
            Ok(None) => tokio::time::sleep(LOCK_POLL).await,
            Err(e) if crate::storage::lock_unsupported(&e) => break None,
            Err(e) => return Err(format!("could not take this project's sync lock: {e}; nothing was synced")),
        }
    };
    Ok(SyncOp { _file: file, _local: local })
}

/// The user's own sync commands waiting for a project's lock, and the signal a
/// background pass listens for to give it up early.
#[derive(Default)]
struct Manual {
    waiting: std::sync::atomic::AtomicUsize,
    arrived: tokio::sync::Notify,
}

fn manual_for(project_id: &str) -> Arc<Manual> {
    static MANUAL: OnceLock<std::sync::Mutex<HashMap<String, Arc<Manual>>>> = OnceLock::new();
    let mut map = MANUAL.get_or_init(Default::default).lock_ok();
    Arc::clone(map.entry(project_id.to_string()).or_default())
}

/// Counts one manual waiter for as long as it lives.
struct ManualWait(Arc<Manual>);

impl Drop for ManualWait {
    fn drop(&mut self) {
        self.0.waiting.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

/// [`acquire`] for a command the user started (a pull, push, delete, checkout):
/// while it waits, the background auto-sync pass holding the lock ends at its
/// next safe point ([`manual_waiting`], [`manual_arrived`]) instead of making
/// the click wait out a whole-tree walk — or, on a dropped session, forever.
pub async fn acquire_manual(project_id: &str) -> Result<SyncOp, String> {
    acquire_manual_in(&crate::storage::state_dir(), project_id).await
}

/// [`acquire_manual`] with its lock file under `state_dir`.
pub async fn acquire_manual_in(state_dir: &Path, project_id: &str) -> Result<SyncOp, String> {
    let manual = manual_for(project_id);
    manual.waiting.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let wait = ManualWait(manual);
    wait.0.arrived.notify_waiters();
    acquire_in(state_dir, project_id).await
}

/// Whether a manual command is waiting for `project_id`'s lock right now.
pub fn manual_waiting(project_id: &str) -> bool {
    manual_for(project_id).waiting.load(std::sync::atomic::Ordering::SeqCst) > 0
}

/// Resolves once a manual command is waiting for `project_id`'s lock (at once
/// when one already is). A background pass races its read-only work against it.
pub async fn manual_arrived(project_id: &str) {
    let manual = manual_for(project_id);
    loop {
        let arrived = manual.arrived.notified();
        tokio::pin!(arrived);
        arrived.as_mut().enable();
        if manual.waiting.load(std::sync::atomic::Ordering::SeqCst) > 0 {
            return;
        }
        arrived.await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn one_owner_per_project_but_not_across_projects() {
        let dir = tempfile::tempdir().unwrap();
        let first = acquire_in(dir.path(), "op-test-a").await.unwrap();
        let other = tokio::time::timeout(Duration::from_millis(500), acquire_in(dir.path(), "op-test-b"))
            .await
            .expect("another project is not blocked");
        drop(other);
        let path = dir.path().to_path_buf();
        let waiting = tokio::spawn(async move { acquire_in(&path, "op-test-a").await.map(|_| ()) });
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!waiting.is_finished(), "the same project waits for its owner");
        drop(first);
        tokio::time::timeout(Duration::from_secs(5), waiting)
            .await
            .expect("released to the waiter")
            .unwrap()
            .unwrap();
    }

    /// The other process (window or sidecar), as `flock` sees it: a lock taken
    /// on a separate open file holds the project until it lets go.
    #[tokio::test]
    async fn the_other_process_holding_the_lock_is_waited_for() {
        let dir = tempfile::tempdir().unwrap();
        let path = crate::services::process_lease::path_in(
            dir.path(),
            &crate::services::process_lease::sync_op_key("op-test-x"),
        );
        let theirs = FileLock::exclusive(&path).unwrap();
        let root = dir.path().to_path_buf();
        let waiting = tokio::spawn(async move { acquire_in(&root, "op-test-x").await.map(|_| ()) });
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(!waiting.is_finished(), "waits while the other process writes");
        drop(theirs);
        tokio::time::timeout(Duration::from_secs(5), waiting)
            .await
            .expect("taken once they let go")
            .unwrap()
            .unwrap();
    }

    /// A manual command waiting for the lock is announced to the holder, and
    /// stops counting once it holds the lock itself.
    #[tokio::test]
    async fn a_waiting_manual_command_is_announced_to_the_holder() {
        let dir = tempfile::tempdir().unwrap();
        let held = acquire_in(dir.path(), "op-test-manual").await.unwrap();
        assert!(!manual_waiting("op-test-manual"));
        let announced = tokio::spawn(manual_arrived("op-test-manual"));
        let root = dir.path().to_path_buf();
        let waiting = tokio::spawn(async move { acquire_manual_in(&root, "op-test-manual").await.map(|_| ()) });
        tokio::time::timeout(Duration::from_secs(5), announced)
            .await
            .expect("the holder hears of the waiter")
            .unwrap();
        assert!(manual_waiting("op-test-manual"));
        drop(held);
        tokio::time::timeout(Duration::from_secs(5), waiting)
            .await
            .expect("taken once the holder lets go")
            .unwrap()
            .unwrap();
        assert!(!manual_waiting("op-test-manual"));
    }

    /// A lock that exists but cannot be taken (its directory is a file) is an
    /// error, never an unguarded go-ahead.
    #[tokio::test]
    async fn a_failed_lock_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("leases"), b"not a directory").unwrap();
        assert!(acquire_in(dir.path(), "op-test-y").await.is_err());
    }
}
