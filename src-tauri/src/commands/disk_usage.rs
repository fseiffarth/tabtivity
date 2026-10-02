//! Tauri surface for the Disk Usage Analyzer pane.
//!
//! Thin, like `commands::monitor`: the scanning itself lives in [`crate::duscan`]
//! (pure, unit-tested, `AppHandle`-free); this module only dispatches local vs
//! remote, streams progress, and owns the cancel registry.
//!
//! A scan can take minutes (`/`, a big `$HOME`), so every branch runs inside
//! `spawn_blocking` — a blocking body on a sync command runs on the UI thread and
//! freezes the whole window, which is exactly the failure the remote git commands
//! hit before. The caller mints a `scan_id`, listens for `disk-scan-progress`, and
//! can abort mid-walk with [`disk_usage_cancel`].

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;

use crate::duscan::{self, DuDevice, DuScan, Tally};
use crate::tauri_host::Ctx;
use app_core::CoreCtx;

/// Cancel flags for the scans currently in flight, keyed by the frontend's
/// `scan_id`. An entry lives only for the duration of its scan.
pub type DuScanState = Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>;

pub fn new_state() -> DuScanState {
    Arc::new(Mutex::new(HashMap::new()))
}

/// Progress payload for the `disk-scan-progress` event, keyed by `scan_id` so a
/// pane ignores other panes' scans. Bookended `start` / `dir` / `done` phases,
/// mirroring `commands::sync`'s `sync-progress`. snake_case on the wire.
#[derive(Debug, Clone, Serialize)]
struct DuProgress {
    scan_id: String,
    /// `start` | `dir` | `done`.
    phase: String,
    /// The directory being read (`phase == "dir"`), else the scan root.
    path: String,
    files: u64,
    dirs: u64,
    bytes: u64,
}

fn emit(ctx: &CoreCtx, scan_id: &str, phase: &str, path: &str, t: &Tally) {
    ctx.emit(
        "disk-scan-progress",
        DuProgress {
            scan_id: scan_id.to_string(),
            phase: phase.to_string(),
            path: path.to_string(),
            files: t.files,
            dirs: t.dirs,
            bytes: t.bytes,
        },
    );
}

/// Scan `root` and return its size tree.
///
/// `project_id` selects the machine: a project with a `remote` spec scans on the
/// **host** (and `root` is a path over there), anything else scans locally. As in
/// `fs::dir_size`, remoteness is resolved *before* any local-fs access — a remote
/// project's stored directory is a local state dir, not the tree being measured.
#[tauri::command]
pub async fn disk_usage_scan(
    ctx: Ctx,
    scan_id: String,
    root: String,
    project_id: Option<String>,
    confirmed: Option<bool>,
) -> Result<DuScan, String> {
    let state = ctx.get::<DuScanState>();
    let remote = project_id
        .as_deref()
        .and_then(crate::services::remote::remote_target_for);

    // A scan of a host tagged HPC is refused until the user confirms this run.
    // `remote_du_tree` stats every file under `root`, and on a cluster that root
    // is normally on the parallel filesystem — the one recursive walk a site's
    // filesystem guide names outright. Refusing rather than silently skipping,
    // and per-run rather than once, because the pane's whole purpose is that walk:
    // a scan the user asked for by name is theirs to have, a scan a pane opened
    // for them is not (`services::hpc_mode::HPC_GUARD`).
    if let Some(target) = remote.as_ref() {
        if confirmed != Some(true) && crate::services::hpc_mode::is_hpc_spec(&target.spec) {
            return Err(crate::services::hpc_mode::guard_error(
                "du-scan",
                &target.spec,
            ));
        }
    }

    // A confirmed scan is the user asking for this machine by name, so it also
    // clears the dial policy (`ssh_common::authorize_dial`) that would otherwise
    // refuse the walk's own ssh — one confirmation covers the whole act, not the
    // scan only to be stopped again one layer down.
    let _dial = remote
        .as_ref()
        .filter(|_| confirmed == Some(true))
        .map(|t| crate::services::ssh_common::user_dial(&t.spec.user, &t.spec.host, t.spec.port));

    let cancel = Arc::new(AtomicBool::new(false));
    if let Ok(mut map) = state.lock() {
        map.insert(scan_id.clone(), cancel.clone());
    }

    let result = if let Some(target) = remote {
        let spec = target.spec.clone();
        let root = root.clone();
        tokio::task::spawn_blocking(move || crate::services::ssh_exec::remote_du_tree(&spec, &root))
            .await
            .map_err(|e| e.to_string())?
    } else {
        let app2 = ctx.0.clone();
        let id = scan_id.clone();
        let root = root.clone();
        emit(&ctx, &scan_id, "start", &root, &Tally::default());
        tokio::task::spawn_blocking(move || {
            let mut on_progress = |t: &Tally, at: &std::path::Path| {
                emit(&app2, &id, "dir", &at.to_string_lossy(), t);
            };
            duscan::scan_local(&root, &cancel, &mut on_progress)
        })
        .await
        .map_err(|e| e.to_string())?
    };

    if let Ok(mut map) = state.lock() {
        map.remove(&scan_id);
    }
    let done = result
        .as_ref()
        .map(|s| Tally {
            files: s.files,
            dirs: s.dirs,
            bytes: s.root.size,
            errors: s.errors,
        })
        .unwrap_or_default();
    emit(&ctx, &scan_id, "done", &root, &done);

    result
}

/// Ask an in-flight **local** scan to stop. It returns the partial tree it had
/// built, with `cancelled` set. A no-op for an unknown or already-finished
/// `scan_id` — and for a remote scan, which is a single `du` round-trip on the host
/// with no walk of ours to interrupt.
#[tauri::command]
pub fn disk_usage_cancel(ctx: Ctx, scan_id: String) {
    let state = ctx.get::<DuScanState>();
    if let Ok(map) = state.lock() {
        if let Some(flag) = map.get(&scan_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

/// Scan targets offered on the pane's home screen (home dir + its filesystem),
/// each with its capacity where the platform can tell us.
#[tauri::command]
pub async fn disk_usage_devices() -> Result<Vec<DuDevice>, String> {
    Ok(duscan::devices())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The `disk-scan-progress` payload is snake_case with the fixed key set
    /// the pane filters on (`scan_id`) and switches on (`phase`).
    #[test]
    fn the_progress_payload_is_snake_case_with_a_fixed_key_set() {
        let progress = DuProgress {
            scan_id: "s1".into(),
            phase: "dir".into(),
            path: "/tmp/x".into(),
            files: 3,
            dirs: 1,
            bytes: 4096,
        };
        let out = serde_json::to_value(&progress).unwrap();
        let mut keys: Vec<&str> = out.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["bytes", "dirs", "files", "path", "phase", "scan_id"]);
        assert_eq!(out["scan_id"], "s1");
        assert_eq!(out["bytes"], 4096);
    }
}
