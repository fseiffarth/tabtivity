//! The sync resolver's "Hand to an agent" export and its "Load resolved"
//! read-back (`services::sync_handoff`). The window sends the two texts it
//! already holds; nothing is fetched from the host here and nothing is written
//! to the project or the host.

use crate::services::remote::remote_target_for;
use crate::services::sync_handoff::{self, HandoffExport, HandoffFileIn, ResolvedFile};

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
    let nonce = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0)
        & 0xffff) as u16;
    sync_handoff::export_in(&crate::storage::state_dir(), &project_id, &files, chrono::Utc::now(), nonce)
}

/// The newest `resolved/<rel>` an agent wrote for one file, or `None`. Only
/// read: the window puts it in the Result column for the user to review.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn sync_handoff_load_resolved(project_id: String, rel_path: String) -> Result<Option<ResolvedFile>, String> {
    app_core::rt::try_blocking("sync", move || {
        Ok(sync_handoff::load_resolved_in(&crate::storage::state_dir(), &project_id, &rel_path))
    })
    .await
}
