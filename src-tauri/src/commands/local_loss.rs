//! Tauri commands for the local-loss warning log (#28q).
//!
//! Thin wrappers over `services::local_loss`, which is where the doc comment explaining
//! *why* this is a file rather than an event lives. The frontend re-reads the log
//! whenever a lockstep or sync pass reports in, so a deletion that happened during a
//! background pass — or while the app was closed — still surfaces.

use crate::services::local_loss::{self, LocalLoss};

/// Every recorded local loss for a project, newest first. Empty for a local project (it
/// has no mirror to lose anything from) and for the overwhelming majority of remote ones.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn local_loss_list(project_id: String) -> Result<Vec<LocalLoss>, String> {
    Ok(local_loss::load(&project_id))
}

/// Mark every entry seen (the dialog's "Got it"). The entries stay on disk — acking is
/// permanent, and a user who dismissed a 3am deletion can still read
/// `remote-projects/<id>/local_loss.json` to find out which files it took. (A UI to
/// browse the history would live next to the backup-ref list in `GitHistory`; there
/// isn't one yet, which is why there is no "clear" command either.)
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn local_loss_ack(project_id: String) -> Result<(), String> {
    local_loss::ack_all(&project_id);
    Ok(())
}
