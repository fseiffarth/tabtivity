//! Shared calendars and to-do lists (hosted plan §6.7, P4c): the Server
//! settings' Calendar sharing panel and the browser's change watch. Server
//! daemon only; the bodies are `services::server::shared_calendar`, the
//! decisions the shared-calendar service's.

use serde::Serialize;

use crate::services::server::cal_wire::{CalInfo, Request, Role};
use crate::services::server::shared_calendar::{self as shared, service_socket};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedCalendars {
    pub me: String,
    /// The calendars this user shares (with their members) and the ones
    /// opened to them.
    pub list: Vec<CalInfo>,
}

async fn off_thread<T: Send + 'static>(job: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tokio::task::spawn_blocking(job).await.map_err(|e| format!("shared calendars: {e}"))?
}

fn me() -> Result<String, String> {
    if !crate::services::server::is_server() {
        return Err("Sharing a calendar needs the hosted server".into());
    }
    crate::services::server::user_name().ok_or_else(|| "This daemon does not know its account".to_string())
}

fn role(word: &str) -> Result<Option<Role>, String> {
    match word {
        "" | "none" => Ok(None),
        "viewer" => Ok(Some(Role::Viewer)),
        "editor" => Ok(Some(Role::Editor)),
        other => Err(format!("Not a role: {other}")),
    }
}

fn service(request: Request) -> Result<(), String> {
    let reply = shared::ask_at(&service_socket(), &request)?;
    if reply.ok {
        Ok(())
    } else {
        Err(shared::explain(&reply))
    }
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn shared_calendar_list() -> Result<SharedCalendars, String> {
    let me = me()?;
    off_thread(move || {
        let list = shared::global().ok_or("not a server")?.refresh()?;
        Ok(SharedCalendars { me, list })
    })
    .await
}

/// Share one of this user's calendars for the first time: it moves out of
/// their `calendar.json` into the service (the panel asks first).
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn shared_calendar_share(calendar_id: String) -> Result<CalInfo, String> {
    me()?;
    off_thread(move || shared::share_in(&crate::commands::calendar::calendar_path(), &crate::storage::state_dir(), &service_socket(), &calendar_id)).await
}

/// Open (or change, or close: both `""`) the events and the to-do list of
/// one of this user's shared calendars to `user`.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn shared_calendar_grant(id: String, user: String, events: String, tasks: String) -> Result<(), String> {
    me()?;
    let (events, tasks) = (role(&events)?, role(&tasks)?);
    off_thread(move || service(Request::Grant { id, user, events, tasks })).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn shared_calendar_revoke(id: String, user: String) -> Result<(), String> {
    me()?;
    off_thread(move || service(Request::Revoke { id, user })).await
}

/// Stop sharing: the calendar moves back into this user's `calendar.json`.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn shared_calendar_unshare(id: String) -> Result<(), String> {
    me()?;
    off_thread(move || shared::unshare_in(&crate::commands::calendar::calendar_path(), &crate::storage::state_dir(), &service_socket(), &id)).await
}

/// Long-poll: `true` as soon as a shared calendar this user may see moved
/// past this daemon's copy (or appeared, or went away), `false` after the
/// service's wait bound. The browser reloads its calendar on `true`.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn shared_calendar_wait() -> Result<bool, String> {
    if !crate::services::server::is_server() {
        return Ok(false);
    }
    off_thread(move || shared::global().ok_or("not a server")?.wait()).await
}
