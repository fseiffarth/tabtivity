//! Tauri commands for the per-scope tab archive (`services::tab_archive`).
//!
//! The window archives a tab by sending its persisted shape (`toSavedTabEntry`)
//! and ends the tab itself; a restore takes the entry out and builds the tab
//! the way a restart does. Every change tells every window
//! (`tab-archive:changed`), so a popout's and the side panel's lists follow.
//! Each body is `async` over a blocking one: they write the state dir.

use crate::schema::project::TabEntry;
use crate::services::tab_archive::{self, ArchivedTab, TAB_ARCHIVE_CHANGED_EVENT};
use crate::tauri_host::Ctx;

fn changed(ctx: &Ctx, project_id: &str) {
    ctx.emit(TAB_ARCHIVE_CHANGED_EVENT, serde_json::json!({ "scope": project_id }));
}

/// A scope's archived tabs, newest first.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn tab_archive_list(project_id: String) -> Result<Vec<ArchivedTab>, String> {
    app_core::rt::try_blocking("tab-archive", move || tab_archive::list(&project_id)).await
}

/// Put tabs into a scope's archive. Answers the new entries.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn tab_archive_add(ctx: Ctx, project_id: String, tabs: Vec<TabEntry>) -> Result<Vec<ArchivedTab>, String> {
    let scope = project_id.clone();
    let added = app_core::rt::try_blocking("tab-archive", move || tab_archive::add(&project_id, tabs)).await?;
    changed(&ctx, &scope);
    Ok(added)
}

/// Take one entry out of a scope's archive to restore it; `None` when it is
/// already gone.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn tab_archive_take(ctx: Ctx, project_id: String, id: String) -> Result<Option<ArchivedTab>, String> {
    let scope = project_id.clone();
    let taken = app_core::rt::try_blocking("tab-archive", move || tab_archive::take(&project_id, &id)).await?;
    if taken.is_some() {
        changed(&ctx, &scope);
    }
    Ok(taken)
}

/// Drop entries from a scope's archive for good. Answers how many went.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn tab_archive_delete(ctx: Ctx, project_id: String, ids: Vec<String>) -> Result<usize, String> {
    let scope = project_id.clone();
    let gone = app_core::rt::try_blocking("tab-archive", move || tab_archive::delete(&project_id, &ids)).await?;
    if gone > 0 {
        changed(&ctx, &scope);
    }
    Ok(gone)
}
