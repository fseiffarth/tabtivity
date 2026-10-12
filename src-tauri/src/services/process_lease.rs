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
pub fn free_to_tear_down(key: &str) -> Option<FileLock> {
    free_to_tear_down_at(&path(key))
}

/// Become the single runner of `key`; `true` also when this process already
/// is.
pub fn claim(key: &str) -> bool {
    claim_at(&path(key))
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
        match FileLock::shared(path) {
            Ok(lock) => {
                held.insert(path.to_path_buf(), lock);
            }
            Err(e) => eprintln!("process_lease: hold {}: {e}", path.display()),
        }
    });
}

pub(crate) fn release_at(path: &Path) {
    with_held(|held| {
        held.remove(path);
    });
}

pub(crate) fn free_to_tear_down_at(path: &Path) -> Option<FileLock> {
    release_at(path);
    match FileLock::try_exclusive(path) {
        Ok(lock) => lock,
        // No lock to be had at all: behave as before leases existed.
        Err(e) => {
            eprintln!("process_lease: {}: {e}", path.display());
            FileLock::exclusive(path).ok()
        }
    }
}

pub(crate) fn claim_at(path: &Path) -> bool {
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
            Err(e) => {
                eprintln!("process_lease: claim {}: {e}", path.display());
                true
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
        assert!(!claim_at(&lease), "the other process runs it");
        drop(other);
        assert!(claim_at(&lease));
        assert!(claim_at(&lease), "still ours");
        assert!(FileLock::try_exclusive(&lease).unwrap().is_none(), "held for the claim's length");
        release_at(&lease);
        assert!(FileLock::try_exclusive(&lease).unwrap().is_some());
    }

    #[test]
    fn keys_become_plain_file_names() {
        let p = path_in(Path::new("/s"), "remote-sync-../x y");
        assert_eq!(p, Path::new("/s/leases/remote-sync-.._x_y"));
        assert_eq!(p.parent(), Some(Path::new("/s/leases")));
    }
}
