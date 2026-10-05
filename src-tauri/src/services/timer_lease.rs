//! The single-client timer lease (headless owner plan, H2, interim).
//!
//! Scheduled prompts, auto-continue, the warm-up cron, calendar alarms and
//! CalDAV sync are still fired by React hosts in a window. Two Tabtivity
//! processes on one state dir — a packaged build beside a dev window, a
//! window that survived a crash — would each fire them. Until the timers
//! move into the owner, a host runs only while its window holds this lease:
//! one holder at a time, renewed by heartbeat, expiring on its own so a
//! holder that died hands over within [`TTL_SECS`].
//!
//! The lease is a small file beside the other state files, edited under its
//! `FileLock`, so the two processes agree without talking to each other.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::storage;

/// How long a heartbeat holds the lease. A holder renews well inside it
/// (the frontend every ~10 s); a dead one is replaced after it.
pub const TTL_SECS: u64 = 30;
const FILE_NAME: &str = "timer-lease.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Lease {
    holder: String,
    /// Unix seconds.
    expires_at: u64,
}

/// What a client is told after asking: whether it holds the lease now, and
/// who does otherwise.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LeaseState {
    pub held: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub holder: Option<String>,
    pub expires_at: u64,
}

fn read(path: &Path) -> Option<Lease> {
    storage::read_json(path).ok()
}

/// Take or renew the lease for `client` at `now`: granted when nobody holds
/// it, the holder's lease expired, or `client` is the holder. Refused, with
/// the holder named, otherwise.
pub fn acquire_in(path: &Path, client: &str, now: u64, ttl: u64) -> Result<LeaseState, String> {
    if client.is_empty() {
        return Err("a timer lease needs a client id".into());
    }
    let _lock = storage::FileLock::exclusive(path).map_err(|e| format!("lock {}: {e}", path.display()))?;
    let current = read(path);
    let free = current.as_ref().is_none_or(|lease| lease.expires_at <= now || lease.holder == client);
    if !free {
        let lease = current.unwrap_or_default();
        return Ok(LeaseState { held: false, holder: Some(lease.holder), expires_at: lease.expires_at });
    }
    let lease = Lease { holder: client.to_string(), expires_at: now + ttl };
    storage::write_json_atomic(path, &lease).map_err(|e| e.to_string())?;
    Ok(LeaseState { held: true, holder: Some(lease.holder), expires_at: lease.expires_at })
}

/// Who holds the lease at `now`, without asking for it: the window whose
/// timers are running, or `None` when no window does — a lease never taken,
/// released, or a holder that stopped renewing. What the Mobile sidecar's
/// scheduler reads (headless owner plan, H2): it fires only while no window
/// holds the timers, and never takes the lease itself — a window that opens
/// must be able to take over the timers the sidecar cannot run.
pub fn holder_in(path: &Path, now: u64) -> Option<String> {
    read(path).filter(|lease| lease.expires_at > now).map(|lease| lease.holder)
}

/// `<state_dir>/timer-lease.json`.
pub fn lease_file(state_dir: &Path) -> std::path::PathBuf {
    state_dir.join(FILE_NAME)
}

/// Give the lease up if `client` holds it, so the next asker takes it at
/// once rather than after the TTL.
pub fn release_in(path: &Path, client: &str) -> Result<(), String> {
    let _lock = storage::FileLock::exclusive(path).map_err(|e| format!("lock {}: {e}", path.display()))?;
    if read(path).is_some_and(|lease| lease.holder == client) {
        let expired = Lease { holder: client.to_string(), expires_at: 0 };
        storage::write_json_atomic(path, &expired).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn lease_path() -> std::path::PathBuf {
    storage::state_dir().join(FILE_NAME)
}

/// [`acquire_in`] on the state dir's lease, now, for [`TTL_SECS`].
pub fn acquire(client: &str) -> Result<LeaseState, String> {
    acquire_in(&lease_path(), client, now_secs(), TTL_SECS)
}

/// [`release_in`] on the state dir's lease.
pub fn release(client: &str) -> Result<(), String> {
    release_in(&lease_path(), client)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        (dir, path)
    }

    /// The plan's interim guarantee: with two clients exactly one holds the
    /// lease, so a timer fires once; the holder keeps it by renewing; a dead
    /// holder is replaced after the TTL; a released one at once.
    #[test]
    fn one_client_holds_the_lease_at_a_time() {
        let (_dir, path) = file();
        let a = acquire_in(&path, "window-a", 1_000, 30).unwrap();
        assert!(a.held);
        assert_eq!(a.expires_at, 1_030);

        let b = acquire_in(&path, "window-b", 1_005, 30).unwrap();
        assert!(!b.held, "the second window is refused");
        assert_eq!(b.holder.as_deref(), Some("window-a"));

        // A renews inside the TTL and keeps it past B's next try.
        assert!(acquire_in(&path, "window-a", 1_020, 30).unwrap().held);
        assert!(!acquire_in(&path, "window-b", 1_040, 30).unwrap().held);

        // A dies: after its lease runs out, B takes over.
        let b = acquire_in(&path, "window-b", 1_051, 30).unwrap();
        assert!(b.held);
        assert!(!acquire_in(&path, "window-a", 1_052, 30).unwrap().held, "A is now the outsider");

        // B releases: A is back at once, without waiting out the TTL.
        release_in(&path, "window-b").unwrap();
        assert!(acquire_in(&path, "window-a", 1_053, 30).unwrap().held);
        // A release by a non-holder changes nothing.
        release_in(&path, "window-b").unwrap();
        assert!(!acquire_in(&path, "window-b", 1_054, 30).unwrap().held);
    }

    #[test]
    fn a_missing_or_corrupt_lease_file_is_free() {
        let (_dir, path) = file();
        assert!(acquire_in(&path, "x", 10, 30).unwrap().held);
        std::fs::write(&path, b"{ not json").unwrap();
        assert!(acquire_in(&path, "y", 11, 30).unwrap().held);
        assert!(acquire_in(&path, "", 12, 30).is_err());
    }
}
