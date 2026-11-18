//! "Take the newer copy" for byte-sync conflicts: the per-project switch in the
//! file view's orange (diverged) list, read by the auto-sync engine
//! (`services::sync_auto`) on every pass.
//!
//! Auto-sync already moves a file that only one side changed. What it leaves for a
//! human is the file BOTH sides edited since the last sync. With this switch on, the
//! engine resolves those too: the copy with the newer modification time wins, but
//! only on paths auto-sync covers and only when both copies exist. A deletion on
//! either side is never decided this way, and neither is a tie. The copy that loses
//! is first saved under `<state_dir>/remote-projects/<id>/conflict-backups/<unix
//! secs>/<rel>`, and the loss is recorded in `services::local_loss`. A backup that
//! cannot be written means the file is not touched.
//!
//! The verdict compares a host mtime with a local one, so it trusts the two clocks to
//! agree. That is the one place byte-sync compares them, and it is why the switch is
//! opt-in and keeps the losing copy.
//!
//! The switch lives in its own `sync_settings.json`, not in `sync.json`: the manifest is
//! a path → entry map whose root entry already means "auto-sync all", and a project
//! preference has no path.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::services::remote_sync;

/// How long a conflict backup is kept before a later backup prunes it.
const BACKUP_KEEP_SECS: u64 = 30 * 24 * 3600;

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncPrefs {
    #[serde(default)]
    take_newer: bool,
    /// Keys a newer build wrote, kept on a rewrite.
    #[serde(flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
}

fn project_dir(project_id: &str) -> PathBuf {
    crate::storage::remote_project_dir_in(&crate::storage::state_dir(), project_id)
}

fn prefs_path(project_id: &str) -> PathBuf {
    project_dir(project_id).join("sync_settings.json")
}

/// Whether the project resolves both-sides-changed files by the newer copy. An
/// absent or unreadable file reads as off: the switch only ever adds overwrites.
pub fn enabled(project_id: &str) -> bool {
    crate::storage::read_json::<SyncPrefs>(&prefs_path(project_id))
        .map(|p| p.take_newer)
        .unwrap_or(false)
}

/// Turn the switch on or off. A file that cannot be parsed is an error, not
/// overwritten.
pub fn set(project_id: &str, on: bool) -> Result<(), String> {
    crate::storage::patch_json(&prefs_path(project_id), SyncPrefs::default(), |p: &mut SyncPrefs| {
        p.take_newer = on;
        Ok(())
    })
}

/// Which copy wins a both-sides-changed file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Winner {
    Host,
    Local,
}

/// The newer of the two copies by modification time, or `None` when a side is
/// missing (a deletion), a side has no mtime, or the mtimes are equal: nothing then
/// says which one is newer. Pure.
pub fn winner(host: Meta, local: Meta) -> Option<Winner> {
    let host_mtime = host?.1?;
    let local_mtime = local?.1?;
    match host_mtime.cmp(&local_mtime) {
        std::cmp::Ordering::Greater => Some(Winner::Host),
        std::cmp::Ordering::Less => Some(Winner::Local),
        std::cmp::Ordering::Equal => None,
    }
}

/// One side's (size, mtime), as the pass stat'd it.
pub type Meta = Option<(u64, Option<u64>)>;

/// Conflicts that failed to resolve, by project and path, with the two sides as they
/// stood then. The same file in the same state is not tried again: each try writes a
/// backup first, and a failure that repeats (a permission, a dropped session that is
/// back) would otherwise leave one every pass. Either side moving clears it.
static FAILED: std::sync::Mutex<std::collections::BTreeMap<(String, String), (Meta, Meta)>> =
    std::sync::Mutex::new(std::collections::BTreeMap::new());

/// Whether to try `rel` with these facts: not when the same facts failed before.
pub fn worth_trying(project_id: &str, rel: &str, host: Meta, local: Meta) -> bool {
    use app_core::sync::LockExt;
    FAILED.lock_ok().get(&(project_id.to_string(), rel.to_string())) != Some(&(host, local))
}

/// Remember how a try ended: a failure is kept with its facts, a success forgets it.
pub fn note_outcome(project_id: &str, rel: &str, host: Meta, local: Meta, ok: bool) {
    use app_core::sync::LockExt;
    let key = (project_id.to_string(), rel.to_string());
    let mut failed = FAILED.lock_ok();
    if ok {
        failed.remove(&key);
    } else {
        failed.insert(key, (host, local));
    }
}

/// Whether both copies fit the byte-sync cap: a larger one cannot be transferred, so
/// it is not backed up either.
pub fn within_cap(host: Meta, local: Meta) -> bool {
    let fits = |m: Meta| m.is_some_and(|(size, _)| size <= remote_sync::MAX_SYNC_FILE_BYTES);
    fits(host) && fits(local)
}

/// The folder one pass's backups go into, created on first use, pruning folders
/// older than [`BACKUP_KEEP_SECS`] as it does.
pub fn backup_root(project_id: &str, now: u64) -> PathBuf {
    let parent = project_dir(project_id).join("conflict-backups");
    prune_backups(&parent, now);
    parent.join(now.to_string())
}

/// Remove the backup folders under `parent` whose name (unix secs) is older than
/// [`BACKUP_KEEP_SECS`]. Anything not named like a pass folder is left alone.
fn prune_backups(parent: &Path, now: u64) {
    let Ok(dir) = std::fs::read_dir(parent) else {
        return;
    };
    for entry in dir.flatten() {
        let Some(ts) = entry.file_name().to_str().and_then(|n| n.parse::<u64>().ok()) else {
            continue;
        };
        if now.saturating_sub(ts) > BACKUP_KEEP_SECS && entry.file_type().is_ok_and(|t| t.is_dir()) {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// Copy the mirror's copy of `rel` into `backup_root`, before a pull replaces it.
/// Both ends are confined (`confined_mirror_path`): no `..`, no symlinked folder.
pub fn back_up_mirror_copy(mirror_root: &Path, backup_root: &Path, rel: &str) -> Result<PathBuf, String> {
    let src = remote_sync::confined_mirror_path(mirror_root, rel)?;
    std::fs::create_dir_all(backup_root).map_err(|e| e.to_string())?;
    let dest = remote_sync::confined_mirror_path(backup_root, rel)?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    remote_sync::confined_mirror_path(backup_root, rel)?;
    std::fs::copy(&src, &dest).map_err(|e| format!("could not back up the local copy: {e}"))?;
    Ok(dest)
}

/// What the local-loss log says to recover a file from.
pub fn recovery_note(backup_root: &Path) -> String {
    format!("The replaced copy was saved in {}", backup_root.display())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_newer_mtime_wins_and_anything_else_is_left_alone() {
        assert_eq!(winner(Some((1, Some(200))), Some((1, Some(100)))), Some(Winner::Host));
        assert_eq!(winner(Some((1, Some(100))), Some((1, Some(200)))), Some(Winner::Local));
        assert_eq!(winner(Some((1, Some(100))), Some((2, Some(100)))), None, "a tie decides nothing");
        assert_eq!(winner(None, Some((1, Some(100)))), None, "a host deletion is never taken");
        assert_eq!(winner(Some((1, Some(100))), None), None, "a local deletion is never taken");
        assert_eq!(winner(Some((1, None)), Some((1, Some(100)))), None, "no host mtime, no verdict");
    }

    #[test]
    fn a_failed_conflict_is_retried_only_once_a_side_moves() {
        let (host, local) = (Some((1, Some(200))), Some((1, Some(100))));
        assert!(worth_trying("p-retry", "a.txt", host, local));
        note_outcome("p-retry", "a.txt", host, local, false);
        assert!(!worth_trying("p-retry", "a.txt", host, local), "same facts, no second backup");
        assert!(worth_trying("p-retry", "a.txt", Some((2, Some(300))), local), "the host moved");
        assert!(worth_trying("p-retry", "b.txt", host, local), "another file");
        note_outcome("p-retry", "a.txt", host, local, true);
        assert!(worth_trying("p-retry", "a.txt", host, local));
    }

    #[test]
    fn a_copy_over_the_cap_is_not_taken() {
        let cap = remote_sync::MAX_SYNC_FILE_BYTES;
        assert!(within_cap(Some((cap, Some(1))), Some((1, Some(2)))));
        assert!(!within_cap(Some((cap + 1, Some(1))), Some((1, Some(2)))));
        assert!(!within_cap(Some((1, Some(1))), Some((cap + 1, Some(2)))));
    }

    #[test]
    fn a_mirror_copy_is_backed_up_under_its_relative_path() {
        let dir = tempfile::tempdir().unwrap();
        let mirror = dir.path().join("mirror");
        let backup = dir.path().join("backups").join("1000");
        std::fs::create_dir_all(mirror.join("sub")).unwrap();
        std::fs::write(mirror.join("sub").join("a.txt"), b"local edit").unwrap();
        let rel = ["sub", "a.txt"].join("/");
        let dest = back_up_mirror_copy(&mirror, &backup, &rel).unwrap();
        assert_eq!(dest, backup.join("sub").join("a.txt"));
        assert_eq!(std::fs::read(dest).unwrap(), b"local edit");
        assert!(back_up_mirror_copy(&mirror, &backup, "../escape.txt").is_err());
    }

    #[test]
    fn old_backup_folders_are_pruned_and_others_kept() {
        let dir = tempfile::tempdir().unwrap();
        let now = 10 * BACKUP_KEEP_SECS;
        let old = (now - BACKUP_KEEP_SECS - 1).to_string();
        let recent = (now - 60).to_string();
        for name in [old.as_str(), recent.as_str(), "notes"] {
            std::fs::create_dir_all(dir.path().join(name)).unwrap();
        }
        prune_backups(dir.path(), now);
        assert!(!dir.path().join(&old).exists());
        assert!(dir.path().join(&recent).exists());
        assert!(dir.path().join("notes").exists(), "a folder not named by a time is not ours");
    }

    #[test]
    fn prefs_keep_keys_a_newer_build_wrote() {
        let p: SyncPrefs = serde_json::from_str(r#"{"takeNewer":true,"later":1}"#).unwrap();
        assert!(p.take_newer);
        let back = serde_json::to_value(&p).unwrap();
        assert_eq!(back["later"], 1);
        let empty: SyncPrefs = serde_json::from_str("{}").unwrap();
        assert!(!empty.take_newer);
    }
}
