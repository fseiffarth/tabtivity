//! Tauri commands for git-aware local↔remote lockstep sync (TODO #28n, Phase 1).
//!
//! Thin wrappers over `services::git_peer`: toggle the per-project opt-in, read the
//! observed status, run a manual reconcile (Retry), and perform a coordinated
//! checkout. The heavy lifting (probe, bundle transport, fast-forward apply, checkout
//! lockstep, base re-stamping) lives in the service so it stays `AppHandle`-free and
//! unit-testable.

use tauri::{AppHandle, State};

use crate::services::git_peer::{self, BackupRef, GitPeerRegistry, GitPeerState, ReconcileOpts};
use crate::services::remote::{remote_target_for, RemotePoolState};
use crate::services::remote_sync::SyncManifestState;
use crate::services::sync_auto::AutoSyncState;

/// Read a project's persisted lockstep state (disabled/synchronized default).
#[tauri::command]
pub async fn git_peer_status(project_id: String) -> Result<GitPeerState, String> {
    Ok(git_peer::load_state(&project_id))
}

/// Toggle the per-project opt-in. Enabling persists the flag, launches the detection
/// task (`.git` watcher + host poll), and reconciles once; disabling stops the task.
/// Returns the resulting state.
#[tauri::command]
pub async fn git_peer_set_enabled(
    app: AppHandle,
    pool: State<'_, RemotePoolState>,
    manifest: State<'_, SyncManifestState>,
    auto: State<'_, AutoSyncState>,
    reg: State<'_, GitPeerRegistry>,
    worker_sync: State<'_, crate::services::worker_sync::WorkerSyncState>,
    project_id: String,
    enabled: bool,
) -> Result<GitPeerState, String> {
    if remote_target_for(&project_id).is_none() {
        return Err("Git lockstep is only available for SSH remote projects".to_string());
    }
    let mut state = git_peer::load_state(&project_id);
    state.enabled = enabled;
    git_peer::save_state(&project_id, &state)?;

    if enabled {
        // start() reads the freshly-persisted `enabled`, attaches the watcher, and
        // runs an initial detect+emit in its loop.
        git_peer::start(
            app,
            pool.inner().clone(),
            manifest.inner().clone(),
            auto.inner().clone(),
            reg.inner(),
            worker_sync.inner().clone(),
            &project_id,
        )
        .await;
    } else {
        git_peer::stop(reg.inner(), &project_id).await;
    }
    Ok(git_peer::load_state(&project_id))
}

/// Manually reconcile now (the Retry / "Sync git" action). Runs a detection pass and
/// emits the new status.
#[tauri::command]
pub async fn git_peer_sync_now(
    app: AppHandle,
    pool: State<'_, RemotePoolState>,
    manifest: State<'_, SyncManifestState>,
    auto: State<'_, AutoSyncState>,
    project_id: String,
) -> Result<GitPeerState, String> {
    let target = remote_target_for(&project_id)
        .ok_or("Git lockstep is only available for SSH remote projects")?;
    let _reconcile = git_peer::reconcile_guard(&project_id).await;
    let state = git_peer::detect_and_sync(
        pool.inner(),
        manifest.inner(),
        auto.inner(),
        &project_id,
        &target.spec,
        // A manual Retry means "actually look": bypass the D5 ref-signature early-out,
        // which would otherwise answer from cache after the user cleared a blocker that
        // moved no ref (deleting an untracked collision, say).
        ReconcileOpts {
            forced: true,
            ..Default::default()
        },
    )
    .await;
    git_peer::emit_status(&app, &project_id, &state);
    Ok(state)
}

/// Confirm an initial pairing that would overwrite differing files on the empty side
/// (#28p D3). Only reachable from the state's `pairingConflict`, whose paths the UI has
/// already named — this is the explicit consent that the refusal demands, and the only
/// caller that may set `allow_pair_overwrite`.
#[tauri::command]
pub async fn git_peer_pair_confirm(
    app: AppHandle,
    pool: State<'_, RemotePoolState>,
    manifest: State<'_, SyncManifestState>,
    auto: State<'_, AutoSyncState>,
    project_id: String,
) -> Result<GitPeerState, String> {
    let rt = remote_target_for(&project_id)
        .ok_or("Git lockstep is only available for SSH remote projects")?;
    let _reconcile = git_peer::reconcile_guard(&project_id).await;
    let state = git_peer::detect_and_sync(
        pool.inner(),
        manifest.inner(),
        auto.inner(),
        &project_id,
        &rt.spec,
        ReconcileOpts {
            forced: true,
            allow_pair_overwrite: true,
            ..Default::default()
        },
    )
    .await;
    git_peer::emit_status(&app, &project_id, &state);
    Ok(state)
}

/// List both peers' `refs/tabtivity/backup/*` safety refs, newest first (#28p D6).
#[tauri::command]
pub async fn git_peer_backups(project_id: String) -> Result<Vec<BackupRef>, String> {
    let rt = remote_target_for(&project_id)
        .ok_or("Git lockstep is only available for SSH remote projects")?;
    Ok(git_peer::list_backups(&project_id, &rt.spec))
}

/// Move a branch back onto a backup ref, on the peer that holds it (#28p D6). The
/// branch's current tip is backed up first, so a restore is itself undoable.
#[tauri::command]
pub async fn git_peer_restore_backup(
    app: AppHandle,
    pool: State<'_, RemotePoolState>,
    manifest: State<'_, SyncManifestState>,
    auto: State<'_, AutoSyncState>,
    project_id: String,
    peer: String,
    refname: String,
) -> Result<GitPeerState, String> {
    let rt = remote_target_for(&project_id)
        .ok_or("Git lockstep is only available for SSH remote projects")?;
    let _reconcile = git_peer::reconcile_guard(&project_id).await;
    let state = git_peer::restore_backup(
        pool.inner(),
        manifest.inner(),
        auto.inner(),
        &project_id,
        &rt.spec,
        &peer,
        &refname,
    )
    .await?;
    git_peer::emit_status(&app, &project_id, &state);
    Ok(state)
}

/// The local mirror's absolute path — where "Resolve in terminal" (#28p D8) opens its
/// shell, since that is the working copy the user merges/rebases in.
#[tauri::command]
pub async fn git_peer_mirror_dir(project_id: String) -> Result<String, String> {
    if remote_target_for(&project_id).is_none() {
        return Err("Git lockstep is only available for SSH remote projects".to_string());
    }
    Ok(crate::services::remote_sync::mirror_dir(&project_id)
        .to_string_lossy()
        .to_string())
}

/// Coordinated checkout: check `target` out on the initiating side, bring the peer in
/// step, and check the same target out there (guarded — never `-f`). `initiating_side`
/// is `"local"` or `"remote"` (default `"local"`; the frontend passes `initiatingSide`).
#[tauri::command]
pub async fn git_peer_checkout(
    app: AppHandle,
    pool: State<'_, RemotePoolState>,
    manifest: State<'_, SyncManifestState>,
    auto: State<'_, AutoSyncState>,
    project_id: String,
    target: String,
    initiating_side: Option<String>,
) -> Result<GitPeerState, String> {
    let rt = remote_target_for(&project_id)
        .ok_or("Git lockstep is only available for SSH remote projects")?;
    let side = initiating_side.unwrap_or_else(|| "local".to_string());
    let _reconcile = git_peer::reconcile_guard(&project_id).await;
    let state = git_peer::checkout_lockstep(
        pool.inner(),
        manifest.inner(),
        auto.inner(),
        &project_id,
        &rt.spec,
        &target,
        &side,
        false,
    )
    .await?;
    git_peer::emit_status(&app, &project_id, &state);
    Ok(state)
}

/// Resolve a divergence by choosing an authority: `authority` is `"local"` or
/// `"remote"`. The winner's history is force-applied to the loser (its overwritten
/// tips backed up to `refs/tabtivity/backup/*` first), file-sync bases are re-stamped,
/// and the recomputed status is emitted. The Use-local / Use-remote action (#28n
/// Phase 2), only offered when the state is `Desynchronized`.
#[tauri::command]
pub async fn git_peer_resolve(
    app: AppHandle,
    pool: State<'_, RemotePoolState>,
    manifest: State<'_, SyncManifestState>,
    auto: State<'_, AutoSyncState>,
    project_id: String,
    authority: String,
) -> Result<GitPeerState, String> {
    let rt = remote_target_for(&project_id)
        .ok_or("Git lockstep is only available for SSH remote projects")?;
    let _reconcile = git_peer::reconcile_guard(&project_id).await;
    let state = git_peer::resolve(
        pool.inner(),
        manifest.inner(),
        auto.inner(),
        &project_id,
        &rt.spec,
        &authority,
    )
    .await?;
    git_peer::emit_status(&app, &project_id, &state);
    Ok(state)
}
