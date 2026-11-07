//! The explicit open of a result an agent listed for its own tab
//! (`docs/cockpit_mcp_extensions_plan.md`, decision 12). The window names the
//! tab's scope, its saved tab id, the item's index and the revision it drew -
//! never a path - and the host judges the *stored* reference again
//! (`services::cockpit_results::open_in`) before the window opens the file
//! through the ordinary viewer path. Also the dismissal of an agent's
//! reported question (decision 20).

use crate::services::cockpit_meta::{self, Dismissal};
use crate::services::cockpit_results::{self, ResultTarget};

/// Where the item `index` of the tab's saved result list leads now: the file
/// to open, or why not. Metadata only; the file is not read.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn cockpit_result_target(scope: String, tab_id: String, index: usize, revision: u64) -> Result<ResultTarget, String> {
    app_core::rt::try_blocking("fs", move || cockpit_result_target_blocking(&scope, &tab_id, index, revision)).await
}

/// The body of [`cockpit_result_target`], on the calling thread.
pub fn cockpit_result_target_blocking(scope: &str, tab_id: &str, index: usize, revision: u64) -> Result<ResultTarget, String> {
    Ok(cockpit_results::open_in(&crate::storage::state_dir(), scope, tab_id, index, revision))
}

/// The user's dismissal of the question an agent reported for its tab
/// (`tab_request_attention`; plan decision 20). The window names the scope, the
/// saved tab id and the attention id it drew; the host sets `dismissed` only
/// while that id is still the tab's question (a compare-and-swap under the
/// workspace lock), so a newer question or one that went with its spawn is
/// refused and nothing is written. It answers and approves nothing.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn cockpit_attention_dismiss(scope: String, tab_id: String, attention_id: String) -> Result<Dismissal, String> {
    app_core::rt::try_blocking("fs", move || cockpit_attention_dismiss_blocking(&scope, &tab_id, &attention_id)).await
}

/// The body of [`cockpit_attention_dismiss`], on the calling thread.
pub fn cockpit_attention_dismiss_blocking(scope: &str, tab_id: &str, attention_id: &str) -> Result<Dismissal, String> {
    let path = crate::services::mobile_control::headless::session_file(&crate::storage::state_dir(), scope);
    cockpit_meta::dismiss_in(&path, scope, tab_id, attention_id)
}
