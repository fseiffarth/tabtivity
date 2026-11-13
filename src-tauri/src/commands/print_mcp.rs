//! The window's half of the print MCP (`services::print_mcp`): list the
//! pending agent print requests (the Print Manager tab and the toast), hand
//! the preview a request's PDF snapshot, and record the user's Approve (claim,
//! then printed or release) or Reject. All three are `client` commands: approval is the window's own
//! print preview and this machine's printers, so a browser or phone client
//! has none of them. The service rings `print-mcp-changed` through the hook
//! installed here, so it stays context-free.

use app_core::CoreCtx;

use crate::services::print_mcp::{self, RequestView, State};

/// Called once from the window's listener start (`commands::root_mcp`).
pub fn install_change_hook(ctx: &CoreCtx) {
    let ctx = ctx.clone();
    print_mcp::set_change_hook(Box::new(move || {
        ctx.emit(print_mcp::CHANGED_EVENT, ());
    }));
}

/// The requests waiting for the user, oldest first.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn print_mcp_requests() -> Result<Vec<RequestView>, String> {
    app_core::rt::spawn_blocking(print_mcp::pending).await.map_err(|e| e.to_string())
}

/// The PDF a pending request snapshotted at the agent's call, as a raw IPC
/// body (an `ArrayBuffer`, as `read_file_bytes`). `gone` once it ended.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn print_mcp_pdf(id: String) -> Result<tauri::ipc::Response, String> {
    let bytes = print_mcp::pdf(&id).map_err(|e| e.code().to_string())?;
    Ok(tauri::ipc::Response::new(bytes.as_ref().clone()))
}

/// The user's decision, in steps: `claim` on Approve & print, before anything
/// is laid out or sent (only one window wins it); then `printed` once the
/// system print dialog took the job, or `release` when nothing was sent (the
/// layout failed, the dialog was cancelled). `rejected` for Reject. `gone`
/// when the request is not in the state the step needs (withdrawn, expired,
/// its tab closed, decided or claimed elsewhere).
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn print_mcp_decide(id: String, outcome: String) -> Result<(), String> {
    let result = match outcome.as_str() {
        "claim" => print_mcp::claim(&id),
        "release" => print_mcp::release(&id),
        "printed" => print_mcp::decide(&id, State::Printed),
        "rejected" => print_mcp::decide(&id, State::Rejected),
        _ => return Err("invalid_outcome".into()),
    };
    result.map_err(|e| e.code().to_string())
}
