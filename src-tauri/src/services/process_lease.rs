//! Cross-process ownership of the live things the desktop window and its
//! Mobile sidecar can both start — a project's container, a project VM, a
//! remote project's background sync loops (final review B4).
//!
//! With Browser access on, the sidecar answers a browser's commands from the
//! same state dir as the window but with its own in-process registries, so
//! neither knew what the other ran: a browser's project switch removed the
//! window's running container, the window's start-up sweeps reaped the
//! sidecar's containers and VMs, and both could run one remote project's
//! sync loops against one mirror. A lease is an advisory file lock under
//! `<state_dir>/leases/` (`storage::FileLock`), so it ends with its process —
//! a crash leaves nothing held:
//!
//! * [`hold`] — "this process uses it": a **shared** lock, kept until
//!   [`release`]. Both processes may hold one at once (a browser tab and a
//!   window tab in one project's container).
//! * [`free_to_tear_down`] — drops this process's own hold and takes the
//!   lock **exclusively** if nobody else holds it: the one gate before a
//!   teardown or a sweep removes the thing. `None` means another process
//!   still uses it, so it stays.
//! * [`claim`] — the single runner (a remote project's sync loops): an
//!   exclusive lock kept until [`release`]; `false` when the other process
//!   already runs it.
//!
//! On a server the daemon is the only process; the leases cost a lock file.

use std::collections::HashMap;
use app_core::sync::LockExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::storage::FileLock;

/// The go-ahead [`free_to_tear_down`] answers: hold it for the teardown's
/// length. It carries no lock on a file system without advisory locks, where
/// a teardown proceeds as it did before leases existed.
pub struct TearDown {
    _lock: Option<FileLock>,
}

/// What this process holds, by key.
static HELD: Mutex<Option<HashMap<PathBuf, FileLock>>> = Mutex::new(None);

/// `<state_dir>/leases/<key>` (the lock file is `<key>.lock`). Keys are made
/// file-name safe; distinct kinds carry distinct prefixes.
pub fn path_in(state_dir: &Path, key: &str) -> PathBuf {
    let safe: String = key
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') { c } else { '_' })
        .collect();
    state_dir.join("leases").join(safe)
}

fn path(key: &str) -> PathBuf {
    path_in(&crate::storage::state_dir(), key)
}

/// The lease key of a project container, by its name.
pub fn container_key(name: &str) -> String {
    format!("container-{name}")
}

/// The lease key of a project VM, by its project id.
pub fn vm_key(project_id: &str) -> String {
    format!("vm-{project_id}")
}

/// The lease key of a remote project's background byte-sync loop.
pub fn remote_sync_key(project_id: &str) -> String {
    format!("remote-sync-{project_id}")
}

/// The lease key of a remote project's git lockstep loop.
pub fn git_peer_key(project_id: &str) -> String {
    format!("git-peer-{project_id}")
}

/// The key of a remote project's mutation lock (`services::sync_op`), which
/// every byte-sync and lockstep write holds for its length.
pub fn sync_op_key(project_id: &str) -> String {
    format!("sync-op-{project_id}")
}

/// Mark `key` used by this process (shared). Idempotent; best effort — a
/// file system without locks leaves the thing unguarded, as before.
pub fn hold(key: &str) {
    hold_at(&path(key));
}

/// Drop this process's hold or claim of `key`.
pub fn release(key: &str) {
    release_at(&path(key));
}

/// Drop this process's own hold of `key`, then take it exclusively if no
/// other process holds it; keep the guard for the teardown's length.
pub fn free_to_tear_down(key: &str) -> Option<TearDown> {
    free_to_tear_down_at(&path(key))
}

/// Become the single runner of `key`; `true` also when this process already
/// is.
pub fn claim(key: &str) -> bool {
    claim_at(&path(key), true)
}

/// [`claim`] for a remote project's sync loops, which write the user's files:
/// a lock that exists but failed is `false` — nobody can tell whether the other
/// process already runs them, so this one does not start a second writer. A
/// file system without advisory locks still claims, as before leases existed.
pub fn claim_sync(key: &str) -> bool {
    claim_at(&path(key), false)
}

/// Held by a claimed runner's task for its whole life (a remote project's sync
/// or lockstep loop): dropping it — the task returned, panicked or was aborted
/// — releases the claim and tells every [`RunnerExited`] waiter. The claim
/// ends with the runner, never with a stop that gave up waiting for it, so a
/// timed-out stop cannot hand the key to a second runner beside the first.
pub struct RunnerExit {
    path: PathBuf,
    tx: tokio::sync::watch::Sender<bool>,
}

/// Whether a runner's task has ended ([`RunnerExit`]).
pub type RunnerExited = tokio::sync::watch::Receiver<bool>;

/// The exit guard for the runner that just claimed `key`, and its waiter.
pub fn runner_exit(key: &str) -> (RunnerExit, RunnerExited) {
    runner_exit_at(&path(key))
}

pub(crate) fn runner_exit_at(path: &Path) -> (RunnerExit, RunnerExited) {
    let (tx, rx) = tokio::sync::watch::channel(false);
    (RunnerExit { path: path.to_path_buf(), tx }, rx)
}

impl Drop for RunnerExit {
    fn drop(&mut self) {
        release_at(&self.path);
        self.tx.send_replace(true);
    }
}

/// Wait up to `within` for a runner's task to end; whether it did.
pub async fn wait_runner_exit(exited: &mut RunnerExited, within: std::time::Duration) -> bool {
    tokio::time::timeout(within, exited.wait_for(|done| *done)).await.is_ok()
}

fn with_held<R>(f: impl FnOnce(&mut HashMap<PathBuf, FileLock>) -> R) -> R {
    let mut held = HELD.lock_ok();
    f(held.get_or_insert_with(HashMap::new))
}

pub(crate) fn hold_at(path: &Path) {
    with_held(|held| {
        if held.contains_key(path) {
            return;
        }
        // A file system without locks leaves the thing unguarded, as
        // before leases existed (logged once by the fallback).
        match FileLock::shared_or_unlocked(path) {
            Ok(Some(lock)) => {
                held.insert(path.to_path_buf(), lock);
            }
            Ok(None) => {}
            Err(e) => eprintln!("process_lease: hold {}: {e}", path.display()),
        }
    });
}

pub(crate) fn release_at(path: &Path) {
    with_held(|held| {
        held.remove(path);
    });
}

pub(crate) fn free_to_tear_down_at(path: &Path) -> Option<TearDown> {
    release_at(path);
    match FileLock::try_exclusive(path) {
        Ok(lock) => lock.map(|lock| TearDown { _lock: Some(lock) }),
        // No lock to be had at all: behave as before leases existed.
        Err(e) if crate::storage::lock_unsupported(&e) => {
            eprintln!("process_lease: {}: {e}; tearing down unguarded", path.display());
            Some(TearDown { _lock: None })
        }
        // A lock that exists but failed: nobody can tell whether another
        // process still uses it, so it stays.
        Err(e) => {
            eprintln!("process_lease: {}: {e}", path.display());
            None
        }
    }
}

/// `error_claims`: what a lock that exists but failed answers ([`claim`] keeps
/// its old `true`; [`claim_sync`] says `false`).
pub(crate) fn claim_at(path: &Path, error_claims: bool) -> bool {
    with_held(|held| {
        if held.contains_key(path) {
            return true;
        }
        match FileLock::try_exclusive(path) {
            Ok(Some(lock)) => {
                held.insert(path.to_path_buf(), lock);
                true
            }
            Ok(None) => false,
            Err(e) if crate::storage::lock_unsupported(&e) => {
                eprintln!("process_lease: claim {}: {e}; running unguarded", path.display());
                true
            }
            Err(e) => {
                eprintln!("process_lease: claim {}: {e}", path.display());
                error_claims
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The other process, as far as `flock` can tell: a lock taken on a
    /// separate open file is a separate holder.
    fn other_holds_shared(path: &Path) -> FileLock {
        FileLock::shared(path).unwrap()
    }

    #[test]
    fn a_thing_another_process_uses_is_not_torn_down() {
        let dir = tempfile::tempdir().unwrap();
        let lease = path_in(dir.path(), &container_key("p1"));
        hold_at(&lease);
        let other = other_holds_shared(&lease);
        assert!(free_to_tear_down_at(&lease).is_none(), "the other process still uses it");
        drop(other);
        let mine = free_to_tear_down_at(&lease);
        assert!(mine.is_some(), "nobody uses it any more");
        drop(mine);
        // Our own hold alone never blocks our own teardown.
        hold_at(&lease);
        assert!(free_to_tear_down_at(&lease).is_some());
    }

    #[test]
    fn one_runner_per_key_until_it_lets_go() {
        let dir = tempfile::tempdir().unwrap();
        let lease = path_in(dir.path(), &remote_sync_key("r/1"));
        let other = FileLock::try_exclusive(&lease).unwrap().expect("free at first");
        assert!(!claim_at(&lease, false), "the other process runs it");
        drop(other);
        assert!(claim_at(&lease, false));
        assert!(claim_at(&lease, false), "still ours");
        assert!(FileLock::try_exclusive(&lease).unwrap().is_none(), "held for the claim's length");
        release_at(&lease);
        assert!(FileLock::try_exclusive(&lease).unwrap().is_some());
    }

    /// A lock that exists but cannot be taken (here: its directory is a file)
    /// leaves the sync loops unclaimed — a second writer is worse than none —
    /// while the VM runner's [`claim`] keeps its old answer.
    #[test]
    fn a_failed_lock_never_claims_the_sync_loops() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("leases"), b"not a directory").unwrap();
        let lease = path_in(dir.path(), &remote_sync_key("r/1"));
        assert!(!claim_at(&lease, false));
        assert!(claim_at(&lease, true));
        release_at(&lease);
    }

    /// A runner's claim ends with its task, not with a stop that stopped
    /// waiting: until the guard drops, the key stays held.
    #[tokio::test]
    async fn a_runner_holds_its_claim_until_its_task_ends() {
        let dir = tempfile::tempdir().unwrap();
        let lease = path_in(dir.path(), &git_peer_key("r/2"));
        assert!(claim_at(&lease, false));
        let (exit, mut exited) = runner_exit_at(&lease);
        assert!(!wait_runner_exit(&mut exited, std::time::Duration::from_millis(50)).await);
        assert!(FileLock::try_exclusive(&lease).unwrap().is_none(), "still the runner's");
        drop(exit);
        assert!(wait_runner_exit(&mut exited, std::time::Duration::from_millis(50)).await);
        assert!(FileLock::try_exclusive(&lease).unwrap().is_some(), "released with the task");
    }

    #[test]
    fn keys_become_plain_file_names() {
        let p = path_in(Path::new("/s"), "remote-sync-../x y");
        assert_eq!(p, Path::new("/s/leases/remote-sync-.._x_y"));
        assert_eq!(p.parent(), Some(Path::new("/s/leases")));
    }
}
