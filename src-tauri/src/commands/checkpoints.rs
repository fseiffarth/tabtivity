//! Tauri commands for per-turn checkpoints (`services::checkpoints`).
//!
//! The renderer names a tab (its launch uid, `tab_key`) and a checkpoint id;
//! the folder is the one the backend bound that tab to at launch, found among
//! the project's own roots. A file list (`only`) is a filter on the paths the
//! backend's diff reports, never a path handed to git. Every body is
//! `async` over a blocking one: git runs, and a restore writes files.

use crate::services::checkpoints::{self, Listing, Restored, Row, SettingsView, SinceView};

/// A tab's checkpoints, newest last. Cheap: reads the log only.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn checkpoint_list(tab_key: String) -> Result<Listing, String> {
    app_core::rt::spawn_blocking(move || checkpoints::list(&tab_key)).await.map_err(|e| e.to_string())
}

/// The files that differ now from checkpoint `id`, with diffs (`only`: just
/// those files' diff text). Brings the store's view of the folder up to date
/// first, so it runs git over the tree.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn checkpoint_diff(tab_key: String, id: String, only: Option<Vec<String>>) -> Result<SinceView, String> {
    app_core::rt::spawn_blocking(move || checkpoints::since(&tab_key, &id, only.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

/// Put the tab's folder back to checkpoint `id`: the files in `only`, or every
/// differing one. Takes a `pre-restore` checkpoint first (the answer's
/// `undo_id` restores it back).
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn checkpoint_restore(
    tab_key: String,
    id: String,
    only: Option<Vec<String>>,
    confirm_others: Option<bool>,
) -> Result<Restored, String> {
    app_core::rt::spawn_blocking(move || {
        checkpoints::restore(&tab_key, &id, only.as_deref(), confirm_others.unwrap_or(false))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// "Checkpoint now": a manual snapshot of the tab's folder.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn checkpoint_now(tab_key: String, label: Option<String>) -> Result<Row, String> {
    app_core::rt::spawn_blocking(move || checkpoints::now(&tab_key, label.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

/// The feature switch and each folder's store, for Settings.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn checkpoint_settings_get() -> Result<SettingsView, String> {
    app_core::rt::spawn_blocking(checkpoints::settings_view).await.map_err(|e| e.to_string())
}

/// Turn checkpoints on or off. Off stops new snapshots; what is stored stays.
/// Turning them on is refused over a git older than `checkpoints::MIN_GIT`.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn checkpoint_settings_set(enabled: bool) -> Result<SettingsView, String> {
    app_core::rt::spawn_blocking(move || {
        checkpoints::set_enabled(enabled)?;
        Ok(checkpoints::settings_view())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Delete one folder's checkpoints (`key`, as Settings lists it) or all.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn checkpoint_clear(key: Option<String>) -> Result<SettingsView, String> {
    app_core::rt::spawn_blocking(move || checkpoints::clear(key.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}
