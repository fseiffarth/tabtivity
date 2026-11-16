//! The window's half of tab messaging (`services::tabs_mcp`): list a scope's
//! messages for the cockpit's Messages fold and the hover card, hand the
//! Deliver button and the per-project idle wake the host's fixed
//! [`tabs_mcp::NOTICE`] with the tab's schedule target, clear a scope's
//! mailbox, and store the wake opt-in. All `client`: the lane is served by the
//! window alone (`Runtime::serves_tabs`), so its state lives where the window
//! runs and nothing crosses the phone. The service rings `tabs-mcp-changed`
//! through the hook installed here.
//!
//! What may reach a prompt is the notice and nothing else: no message text,
//! sender label or anything an agent chose. The window queues it through the
//! scheduler's idle gate (`queuePromptForTab`).

use app_core::CoreCtx;
use serde::Serialize;
use serde_json::Value;

use crate::services::tabs_mcp::{self, MessageView};

/// The `projects.json` key of the per-project idle wake (absent = off). Never
/// copied into the project tree: authority stays in the registry.
pub const WAKE_KEY: &str = "tab_messages_wake";

/// Called once from the window's listener start (`commands::root_mcp`).
pub fn install_change_hook(ctx: &CoreCtx) {
    let ctx = ctx.clone();
    tabs_mcp::set_change_hook(Box::new(move || {
        ctx.emit(tabs_mcp::CHANGED_EVENT, ());
    }));
}

/// What the window queues: the host's notice for one tab's schedule target.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Delivery {
    pub notice: &'static str,
    pub schedule_target_id: String,
}

/// The wake's claims for one scope: the notice and the schedule targets to
/// queue it for (empty when the opt-in is off or nothing new is unread).
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Wake {
    pub notice: &'static str,
    pub schedule_target_ids: Vec<String>,
}

/// `scope`'s messages, oldest first: all of them, or those the saved tab
/// `tab_id` sent or received. Shown as plain text, marked as written by the
/// sending agent.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn tabs_mcp_traffic(scope: String, tab_id: Option<String>) -> Result<Vec<MessageView>, String> {
    app_core::rt::spawn_blocking(move || tabs_mcp::traffic(&scope, tab_id.as_deref()))
        .await
        .map_err(|e| e.to_string())
}

/// The user's Deliver click: the notice and the tab's schedule target, which
/// the window queues through the idle gate. `off` when the lane is switched
/// off, `nothing_unread` when the tab has no unread message it can read,
/// `not_found` when the tab is not open or its schedule target is gone.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn tabs_mcp_deliver(scope: String, tab_id: String) -> Result<Delivery, String> {
    app_core::rt::spawn_blocking(move || {
        deliver_in(&crate::storage::state_dir(), &scope, &tab_id, &crate::services::root_mcp::session_alive)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn deliver_in(state: &std::path::Path, scope: &str, tab_id: &str, alive: &dyn Fn(&str) -> bool) -> Result<Delivery, String> {
    if !tabs_mcp::enabled_in(&state.join("settings.json")) { return Err("off".into()); }
    let schedule_target_id = schedule_target_in(state, scope, tab_id).ok_or("not_found")?;
    tabs_mcp::deliver_claim_in(state, scope, tab_id, alive)?;
    Ok(Delivery { notice: tabs_mcp::NOTICE, schedule_target_id })
}

/// The schedule target of saved tab `tab_id` of `scope` (its
/// `scheduleTargetId`), read under the workspace's shared lock.
fn schedule_target_in(state: &std::path::Path, scope: &str, tab_id: &str) -> Option<String> {
    let path = crate::services::mobile_control::headless::session_file(state, scope);
    let tab = crate::services::workspace::read_tab_in(&path, tab_id, || Ok(())).ok()?;
    tab.extra.get("scheduleTargetId").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string)
}

/// Empty `scope`'s mailbox (the fold's Clear). How many messages went.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn tabs_mcp_clear(scope: String) -> Result<usize, String> {
    app_core::rt::spawn_blocking(move || tabs_mcp::purge_scope(&scope)).await.map_err(|e| e.to_string())
}

/// The per-project idle wake's claim (plan step 7), asked by the window's
/// `TabMessagesHost` on every change: re-reads the opt-in and the switch,
/// then claims one wake per unread batch per listed tab (6 per tab per hour).
/// The window queues the notice for each target returned, and nothing else.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn tabs_mcp_wake_claim(scope: String) -> Result<Wake, String> {
    app_core::rt::spawn_blocking(move || {
        wake_in(&crate::storage::state_dir(), &scope, wake_enabled(&scope), &crate::services::root_mcp::session_alive)
    })
        .await
        .map_err(|e| e.to_string())
}

/// Whether `scope`'s registry entry opts in to the wake. Unreadable is off.
fn wake_enabled(scope: &str) -> bool {
    crate::services::remote::project_entry(scope).is_ok_and(|entry| wake_opted_in(&entry.extra))
}

fn wake_opted_in(extra: &std::collections::HashMap<String, Value>) -> bool {
    extra.get(WAKE_KEY).and_then(Value::as_bool).unwrap_or(false)
}

fn wake_in(state: &std::path::Path, scope: &str, opted_in: bool, alive: &dyn Fn(&str) -> bool) -> Wake {
    let mut wake = Wake { notice: tabs_mcp::NOTICE, schedule_target_ids: Vec::new() };
    if !opted_in || !tabs_mcp::enabled_in(&state.join("settings.json")) { return wake; }
    wake.schedule_target_ids = tabs_mcp::wake_claims_in(state, scope, std::time::Instant::now(), alive)
        .iter()
        .filter_map(|tab| schedule_target_in(state, scope, tab))
        .collect();
    wake
}

/// The user typed into tab PTY `id` (desktop or phone; the window reports it
/// only while some project opts in to the wake): its woken turn, if any, is
/// over, so what it sends next may wake its recipient again.
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn tabs_mcp_human_input(ctx: crate::tauri_host::Ctx, id: String) {
    let id = crate::commands::terminal::pty_id_for(&ctx, ctx.get::<crate::terminal::RegistryState>(), id);
    tabs_mcp::human_input(&id);
}

/// Store the per-project wake opt-in in `projects.json` (off removes the key:
/// absent = off). Never mirrored into the project's own `project.json`.
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn set_project_tab_messages_wake(project_id: String, on: bool) -> Result<(), String> {
    crate::services::project_registry::patch_project_entry(&project_id, |entry| {
        if on { entry.extra.insert(WAKE_KEY.into(), Value::Bool(true)); } else { entry.extra.remove(WAKE_KEY); }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_wake_opt_in_is_a_true_bool_only() {
        let mut extra = std::collections::HashMap::new();
        assert!(!wake_opted_in(&extra), "absent is off");
        extra.insert(WAKE_KEY.to_string(), Value::String("true".into()));
        assert!(!wake_opted_in(&extra), "a string is off");
        extra.insert(WAKE_KEY.to_string(), Value::Bool(true));
        assert!(wake_opted_in(&extra));
    }

    #[test]
    fn deliver_and_wake_carry_the_notice_and_nothing_else() {
        let state = tempfile::tempdir().unwrap();
        std::fs::write(state.path().join("settings.json"), "{}").unwrap();
        // No message: nothing to deliver, nothing to wake.
        assert_eq!(deliver_in(state.path(), "p", "t1", &|_| true), Err("not_found".to_string()), "no saved tab");
        let wake = wake_in(state.path(), "p", true, &|_| true);
        assert_eq!(wake.notice, tabs_mcp::NOTICE);
        assert!(wake.schedule_target_ids.is_empty());
        // Opted out: nothing is claimed.
        assert!(wake_in(state.path(), "p", false, &|_| true).schedule_target_ids.is_empty());
        // The serialized shapes carry the fixed notice under fixed keys.
        let json = serde_json::to_value(Delivery { notice: tabs_mcp::NOTICE, schedule_target_id: "s".into() }).unwrap();
        assert_eq!(json, serde_json::json!({"notice": tabs_mcp::NOTICE, "scheduleTargetId": "s"}));
    }

    #[test]
    fn switched_off_delivers_nothing() {
        let state = tempfile::tempdir().unwrap();
        std::fs::write(state.path().join("settings.json"), r#"{"tabs_mcp": false}"#).unwrap();
        assert_eq!(deliver_in(state.path(), "p", "t1", &|_| true), Err("off".to_string()));
    }
}
