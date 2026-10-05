//! Warnings for the local side of a remote project losing something (#28q).
//!
//! Two transports write into the local mirror of a remote (SSH) project, and a handful
//! of those writes *destroy* what is already there: a lockstep fast-forward or
//! `reset --hard` deletes the tracked files the incoming commit dropped; the `git clean`
//! that un-blocks a refused fast-forward removes untracked files outright; a confirmed
//! initial pairing overwrites the colliding mirror files it warned about; and a manual
//! byte-sync pull overwrites a mirror file that had unsynced local edits.
//!
//! Each of those is deliberate, and all but the last are recoverable — but none of them
//! *said* anything, so from the user's chair a local file simply vanished, usually
//! during a background pass they never asked for. This module is the record: every
//! destructive local write appends an entry here, and the UI raises the unacknowledged
//! ones (`components/common/LocalLossDialog`).
//!
//! It is a **file**, not an event, for two reasons that both come from where the writes
//! happen: `services::{git_peer,sync_auto}` are deliberately `AppHandle`-free, and a
//! background reconcile can delete a file with no window listening — a warning that
//! existed only as an event would be dropped exactly when it mattered. The frontend
//! re-reads this log whenever a lockstep/sync pass reports in, so a loss recorded while
//! the app was closed still surfaces on the next launch.
//!
//! What is deliberately NOT recorded: byte-sync's own reconcile
//! (`services::sync_auto`), which is non-destructive by construction — it pulls only
//! when the local side is unchanged, pushes only when the host is, and skips a file
//! that moved on both sides rather than picking a winner.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// Serializes the log's read-modify-write operations across background git
/// reconciliation, manual sync commands, and acknowledgement from the UI.
static LOG_WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Keep the log bounded: the newest N entries survive a `record`.
const MAX_ENTRIES: usize = 50;
/// Per entry, name at most this many paths (`total` still carries the real count, so a
/// 900-file `reset --hard` reports honestly without writing 900 strings into the log).
const MAX_PATHS: usize = 25;

/// What happened to the local file.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LossKind {
    /// The file is gone from the mirror.
    Deleted,
    /// The file is still there, but content that was only on the local side was
    /// overwritten by the host's.
    Overwritten,
}

/// Which transport did it — the two have very different recovery stories, so the UI
/// says which one is talking.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LossSource {
    /// Git lockstep (`services::git_peer`).
    Git,
    /// Byte-sync (`services::remote_sync` / `commands::sync`).
    Sync,
}

/// One destructive local write, as the UI shows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalLoss {
    /// Unix seconds — also the entry's identity for acknowledgement.
    pub ts: u64,
    pub source: LossSource,
    pub kind: LossKind,
    /// The operation that did it, as a user-facing phrase ("fast-forward from the
    /// host"), not a function name.
    pub op: String,
    /// Project-relative paths, truncated to [`MAX_PATHS`].
    pub paths: Vec<String>,
    /// How many paths there really were (`> paths.len()` when truncated).
    pub total: usize,
    /// How to get the content back, when it can be got back. `None` means it cannot —
    /// which the dialog says in as many words rather than leaving blank.
    pub recovery: Option<String>,
    /// Cleared until the user has seen it.
    #[serde(default)]
    pub acked: bool,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// `~/.local/share/tabtivity/remote-projects/<id>/local_loss.json`. Sits beside
/// `git_peer.json` in the project's local state dir — the log is about the *local*
/// mirror, so it belongs on the machine that lost the file, not on the host.
pub fn log_path(project_id: &str) -> PathBuf {
    log_path_in(&crate::storage::state_dir(), project_id)
}

/// [`log_path`] under an explicit state dir, so a reader that already has one
/// (`services::root_mcp`, whose tests drive a tempdir) does not restate where
/// the log lives.
pub fn log_path_in(state_dir: &std::path::Path, project_id: &str) -> PathBuf {
    state_dir
        .join("remote-projects")
        .join(project_id)
        .join("local_loss.json")
}

/// Every recorded loss for a project, newest first. Empty for a project that has never
/// lost anything (the overwhelmingly common case, and the reason this never errors).
fn load_unlocked(project_id: &str) -> Vec<LocalLoss> {
    crate::storage::read_json(&log_path(project_id)).unwrap_or_default()
}

pub fn load(project_id: &str) -> Vec<LocalLoss> {
    let _guard = LOG_WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    load_unlocked(project_id)
}

fn save(project_id: &str, entries: &[LocalLoss]) {
    let _ = crate::storage::write_json_atomic(&log_path(project_id), &entries);
}

/// Append a loss and persist. Best-effort throughout: this is the *warning* about a
/// destructive write, and failing to file it must never turn into a second failure on
/// top of the first — the callers are all `let _ =`-style recovery paths themselves.
pub fn record(project_id: &str, loss: LocalLoss) {
    let _guard = LOG_WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut entries = load_unlocked(project_id);
    entries.insert(0, loss);
    entries.truncate(MAX_ENTRIES);
    save(project_id, &entries);
}

/// Record the loss of `paths`, or do nothing at all when it is empty — which is what
/// makes this safe to call unconditionally from every destructive site, including the
/// ones that usually destroy nothing. Truncates the path list to [`MAX_PATHS`], keeping
/// the true count in `total`.
pub fn record_paths(
    project_id: &str,
    source: LossSource,
    kind: LossKind,
    op: &str,
    mut paths: Vec<String>,
    recovery: Option<String>,
) {
    if paths.is_empty() {
        return;
    }
    let total = paths.len();
    paths.sort();
    paths.truncate(MAX_PATHS);
    record(
        project_id,
        LocalLoss {
            ts: now_secs(),
            source,
            kind,
            op: op.to_string(),
            paths,
            total,
            recovery,
            acked: false,
        },
    );
}

/// Mark every entry seen (the dialog's "Got it"). The entries stay on disk — the point
/// of the log is that it outlives the warning, so a user who dismissed a deletion at 3am
/// can still read it to find out which files it took.
pub fn ack_all(project_id: &str) {
    let _guard = LOG_WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut entries = load_unlocked(project_id);
    if entries.iter().all(|e| e.acked) {
        return;
    }
    for e in &mut entries {
        e.acked = true;
    }
    save(project_id, &entries);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_paths_record_nothing() {
        // Every destructive site calls this unconditionally — the usual case is that it
        // destroyed nothing, and that must not file a warning about zero files.
        let before = load("no-such-project");
        record_paths(
            "no-such-project",
            LossSource::Git,
            LossKind::Deleted,
            "fast-forward from the host",
            Vec::new(),
            None,
        );
        assert_eq!(load("no-such-project"), before);
    }
}
