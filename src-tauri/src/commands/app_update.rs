//! Tauri surface for "check for a new Tabtivity" (Settings → Updates).
//!
//! Thin on purpose: the release parsing, the URL allowlist, the staging and the
//! per-platform install all live in [`crate::services::app_update`], which is
//! `AppHandle`-free and unit-tested. This module owns only the two things a
//! service cannot: the download progress event, and the fact that the *whole*
//! flow re-checks rather than trusting anything the renderer hands back.
//!
//! No command here takes a URL or a path. `download_app_update` re-asks GitHub
//! which asset belongs to this platform, and `install_app_update` installs what
//! the download staged — so a compromised renderer cannot nominate a file to
//! fetch or a binary to run.

use tauri::{AppHandle, Emitter};

use crate::services::app_update::{self, InstallOutcome, UpdateCheck};

/// Emitted while an update downloads.
const EV_PROGRESS: &str = "app-update-progress";

/// Only emit a progress event once the download has moved this far, so a
/// 150 MB artifact costs tens of IPC messages rather than thousands.
const PROGRESS_STEP_BYTES: u64 = 1024 * 1024;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    received: u64,
    total: Option<u64>,
}

/// What was downloaded and how it will be applied.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedInfo {
    /// The asset's own name, as published — never the path it was written to.
    pub name: String,
    pub version: String,
    pub install_kind: app_update::InstallKind,
    pub bytes: u64,
}

fn describe(staged: &app_update::Staged) -> StagedInfo {
    StagedInfo {
        name: staged.name.clone(),
        version: staged.version.clone(),
        install_kind: staged.kind,
        bytes: std::fs::metadata(&staged.path).map(|m| m.len()).unwrap_or(0),
    }
}

/// Ask GitHub whether a newer release exists.
#[tauri::command]
pub async fn check_app_update() -> Result<UpdateCheck, String> {
    app_update::check().await
}

/// The release page, for the "open on GitHub" link. A constant rather than
/// something the frontend hardcodes, so the repository is named in one place.
#[tauri::command]
pub fn app_update_releases_url() -> String {
    app_update::RELEASES_PAGE.to_string()
}

/// An update already downloaded in this session, if any.
#[tauri::command]
pub fn app_update_staged() -> Option<StagedInfo> {
    app_update::staged()
        .filter(|staged| staged.path.is_file())
        .map(|staged| describe(&staged))
}

/// Download the artifact for this platform, emitting [`EV_PROGRESS`] as it goes.
///
/// Re-checks first: the asset URL is never taken from the renderer, and a check
/// that has been sitting open in the panel for an hour may be stale.
#[tauri::command]
pub async fn download_app_update(app: AppHandle) -> Result<StagedInfo, String> {
    let check = app_update::check().await?;
    if !check.update_available {
        return Err("already up to date".to_string());
    }
    let asset = check
        .asset
        .ok_or("this release published no artifact for your platform")?;
    let version = check.latest.unwrap_or_default();

    let mut last_emitted = 0u64;
    let staged = app_update::stage_download(&asset, &version, check.install_kind, |received, total| {
        let done = total.is_some_and(|total| received >= total);
        if received - last_emitted < PROGRESS_STEP_BYTES && received != 0 && !done {
            return;
        }
        last_emitted = received;
        let _ = app.emit(EV_PROGRESS, Progress { received, total });
    })
    .await?;
    Ok(describe(&staged))
}

/// Apply the staged update. See [`app_update::install`] for what that means per
/// platform — none of the branches restart Tabtivity themselves.
#[tauri::command]
pub async fn install_app_update() -> Result<InstallOutcome, String> {
    tauri::async_runtime::spawn_blocking(app_update::install)
        .await
        .map_err(|e| format!("install task: {e}"))?
}
