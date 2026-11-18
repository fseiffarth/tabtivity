//! The sync resolver's "Hand to an agent" export and its "Load resolved"
//! read-back (`services::sync_handoff`). The window sends the two texts it
//! already holds; nothing is fetched from the host here and nothing is written
//! to the project or the host.

use crate::services::remote::remote_target_for;
use crate::services::sync_handoff::{self, HandoffExport, HandoffFileIn, ResolvedLoad};

/// Write the diverged files of a remote project into its agent home's hand-over
/// folder (`~/handoff/<id>` inside an agent tab). Refused for a project that is
/// not remote (remoteness comes from the project record, not a path).
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn sync_handoff_export(project_id: String, files: Vec<HandoffFileIn>) -> Result<HandoffExport, String> {
    app_core::rt::try_blocking("sync", move || sync_handoff_export_blocking(project_id, files)).await
}

fn sync_handoff_export_blocking(project_id: String, files: Vec<HandoffFileIn>) -> Result<HandoffExport, String> {
    if remote_target_for(&project_id).is_none() {
        return Err("not a remote project".into());
    }
    let suffix = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0)
        & 0xffff) as u16;
    sync_handoff::export_in(&crate::storage::state_dir(), &project_id, &files, chrono::Utc::now(), suffix)
}

/// The agent's `resolved/<rel>` in one export the app recorded for this file:
/// `export_id` when the window names one (the export it made, or an older one
/// the user chose), else the newest recorded. `local_hash`/`remote_hash` are
/// the SHA-256 of the texts the resolver shows now, so a result made from
/// other copies comes back marked stale. Only read: the window puts it in the
/// Result column for the user to review.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn sync_handoff_load_resolved(
    project_id: String,
    rel_path: String,
    export_id: Option<String>,
    local_hash: String,
    remote_hash: String,
) -> Result<Option<ResolvedLoad>, String> {
    app_core::rt::try_blocking("sync", move || {
        sync_handoff::load_resolved_in(
            &crate::storage::state_dir(),
            &project_id,
            &rel_path,
            export_id.as_deref(),
            &local_hash,
            &remote_hash,
        )
    })
    .await
}

/// Open export `id`'s folder in the OS file manager ("Show folder" in the
/// hand-over dialog). The folder is found from the project and the id, never
/// from a path the window sends.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn sync_handoff_reveal(project_id: String, id: String) -> Result<(), String> {
    app_core::rt::try_blocking("sync", move || {
        let dir = sync_handoff::export_dir_in(&crate::storage::state_dir(), &project_id, &id)
            .ok_or_else(|| "that export is gone".to_string())?;
        crate::services::os_open::check(&dir)?;
        opener::open(&dir).map_err(|e| e.to_string())
    })
    .await
}
