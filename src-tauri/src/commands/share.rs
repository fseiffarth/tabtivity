//! Shared projects (hosted plan §6.2–§6.6, P4): the browser's Sharing panel.
//! Every command works only in a server daemon; the bodies are
//! `services::server::share`. The hub decides who may do what by this
//! daemon's uid; these commands only ever name share ids and this user's own
//! project ids.

use std::path::PathBuf;

use serde::Serialize;

use crate::commands::projects::{entry_directory, entry_is_remote, entry_is_vm, read_projects_list, ImportProjectRequest};
use crate::schema::projects::ProjectEntry;
use crate::services::server::hub_wire::{Request, Role, ShareInfo};
use crate::services::server::share::{self, BranchState, Pushed, Review, ShareRow};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareOverview {
    /// This daemon's account (the hub's name for "you").
    pub me: String,
    pub rows: Vec<ShareRow>,
}

fn me() -> Result<String, String> {
    share::require_server()?;
    crate::services::server::user_name().ok_or_else(|| "This daemon does not know its account".to_string())
}

fn state_dir() -> PathBuf {
    crate::storage::state_dir()
}

fn entry(project_id: &str) -> Result<ProjectEntry, String> {
    read_projects_list()?.into_iter().find(|p| p.id == project_id).ok_or_else(|| "Unknown project".to_string())
}

/// Why `entry` cannot be shared: remote, VM and container projects are
/// refused in v1 (lockstep, byte-sync and worker sync assume one human,
/// plan §6.2).
fn refusal(entry: &ProjectEntry) -> Option<&'static str> {
    if entry_is_remote(entry) {
        return Some("A remote project cannot be shared; share it on its host instead");
    }
    if entry_is_vm(entry) {
        return Some("A VM project cannot be shared");
    }
    if crate::services::sandbox::sandbox_spec_for(&entry.id).is_some_and(|s| s.enabled) {
        return Some("A project that runs in a container cannot be shared");
    }
    None
}

/// The user's shares: their own, those shared with them, and the greyed
/// rows of those no longer shared.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn share_list() -> Result<ShareOverview, String> {
    let me = me()?;
    app_core::rt::try_blocking("sharing", move || {
        let state = state_dir();
        let mut rows = share::overview_in(&state, share::list_at(&share::hub_socket())?)?;
        for row in rows.iter_mut() {
            if let Some(link) = row.project_id.as_deref().and_then(|p| share::link_of(&state, p)) {
                // A check that cannot run reads as pending: fail closed.
                row.pending_review = share::unreviewed(&link).unwrap_or_else(|e| vec![e]);
            }
        }
        Ok(ShareOverview { me, rows })
    })
    .await
}

/// Share a local git project: a hub, its remote, the branch pushed.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn share_create(project_id: String) -> Result<ShareInfo, String> {
    let me = me()?;
    app_core::rt::try_blocking("sharing", move || {
        let entry = entry(&project_id)?;
        if let Some(why) = refusal(&entry) {
            return Err(why.to_string());
        }
        let dir = entry_directory(&entry).map(PathBuf::from).ok_or("The project has no folder")?;
        share::create_in(&state_dir(), &share::hub_socket(), &project_id, &dir, &entry.name, &me)
    })
    .await
}

fn role_of(role: &str) -> Result<Role, String> {
    match role {
        "viewer" => Ok(Role::Viewer),
        "editor" => Ok(Role::Editor),
        _ => Err(format!("Not a role: {role}")),
    }
}

fn hub(request: Request) -> Result<(), String> {
    let reply = share::ask_at(&share::hub_socket(), &request, None)?;
    if reply.ok {
        Ok(())
    } else {
        Err(share::explain(&reply))
    }
}

/// Give a server user a role on one of this user's shares.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn share_grant(share: String, user: String, role: String) -> Result<(), String> {
    me()?;
    let role = role_of(&role)?;
    app_core::rt::try_blocking("sharing", move || hub(Request::Grant { share, user, role })).await
}

/// Take a member off one of this user's shares: their access ends at once;
/// their clone stays theirs.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn share_revoke(share: String, user: String) -> Result<(), String> {
    me()?;
    app_core::rt::try_blocking("sharing", move || hub(Request::Revoke { share, user })).await
}

/// Stop sharing (the owner): the hub goes to the holding area, members see
/// "deleted by owner", this user's own project is untouched (its gate 2
/// stays until changes from members in it are reviewed).
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn share_delete(share: String) -> Result<(), String> {
    me()?;
    app_core::rt::try_blocking("sharing", move || share::stop_in(&state_dir(), &share::hub_socket(), &share)).await
}

/// Clone a share shared with this user into the projects root and register
/// it through the ordinary import path (duplicate gate, untrusted
/// `project.json` fields stripped). From then on it is this user's own
/// project, with their own tabs, trust and agent homes.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn share_add(share: String) -> Result<ProjectEntry, String> {
    me()?;
    app_core::rt::try_blocking("sharing", move || {
        let state = state_dir();
        if let Some(project) = share::projects_of(&state, &share).into_iter().next() {
            return Err(format!("This share is already a project here ({project})"));
        }
        let info = share::list_at(&share::hub_socket())?.into_iter().find(|s| s.id == share && s.deleted.is_none()).ok_or("That share is not shared with you")?;
        if info.role == "owner" {
            return Err("This is your own project".into());
        }
        let dest = share::clone_into(&crate::commands::projects::projects_root(), &info)?;
        let request = ImportProjectRequest {
            source_dir: dest.to_string_lossy().into_owned(),
            name: info.name.clone(),
            description: None,
            git_type: Some("local".into()),
            git_provider: None,
            mode: "keep".into(),
            scaffold_fill_modes: None,
            manual_validation_confirmed: None,
            skip_scaffold: true,
            remote: None,
            mirror_parent: None,
        };
        let entry = match crate::commands::projects::import_project_blocking(request) {
            Ok(entry) => entry,
            Err(e) => {
                let _ = std::fs::remove_dir_all(&dest);
                return Err(e);
            }
        };
        // Without its link the clone would be an ordinary project: hooks on,
        // nothing reviewed. Not registered then, and not kept.
        if let Err(e) = share::adopt_in(&state, &entry.id, &info, &dest) {
            let _ = crate::commands::projects::forget_project_blocking(entry.id.clone());
            let _ = std::fs::remove_dir_all(&dest);
            return Err(e);
        }
        Ok(entry)
    })
    .await
}

fn link(project_id: &str) -> Result<share::Link, String> {
    share::link_of(&state_dir(), project_id).ok_or_else(|| "This project is not shared".to_string())
}

/// Push the checked-out branch through the hub (owner: by its name; editor:
/// under `<user>/`).
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn share_push(project_id: String) -> Result<Pushed, String> {
    let me = me()?;
    app_core::rt::try_blocking("sharing", move || share::push_in(&state_dir(), &share::hub_socket(), &link(&project_id)?, &me)).await
}

/// Fetch the hub and report each of its branches against HEAD.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn share_fetch(project_id: String) -> Result<Vec<BranchState>, String> {
    me()?;
    app_core::rt::try_blocking("sharing", move || share::fetch_report(&link(&project_id)?)).await
}

/// "This user has the project open" (or closed), for its co-members.
/// Silent for a project that is not an active share.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn share_presence(project_id: String, open: bool) -> Result<(), String> {
    if crate::services::server::user_name().is_none() {
        return Ok(());
    }
    app_core::rt::try_blocking("sharing", move || {
        let Some(link) = share::link_of(&state_dir(), &project_id).filter(|l| l.state == "active") else { return Ok(()) };
        hub(Request::Presence { share: link.share, open })
    })
    .await
}

/// What merging the hub's `branch` would change in agent-facing files
/// (§6.5 gate 2), shown before the merge.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn share_review(project_id: String, branch: String) -> Result<Review, String> {
    me()?;
    app_core::rt::try_blocking("sharing", move || share::review_merge(&link(&project_id)?, &branch)).await
}

/// Page `page` of a review (`branch`: of that merge; none: of what is
/// already there) the user is paging through — every page must have been
/// shown before the review can be accepted (TODO #2375).
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn share_review_page(project_id: String, branch: Option<String>, digest: String, page: usize) -> Result<String, String> {
    me()?;
    app_core::rt::try_blocking("sharing", move || {
        let link = link(&project_id)?;
        let of = match branch.as_deref() {
            Some(branch) => share::ReviewOf::Merge(branch),
            None => share::ReviewOf::Pending,
        };
        share::review_page(&link, of, &digest, page)
    })
    .await
}

/// Merge the hub's `branch` (hookless; a conflict is aborted and reported).
/// `digest` is the review the user saw, required when the merge brings
/// agent-facing changes.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn share_merge(project_id: String, branch: String, digest: Option<String>) -> Result<String, String> {
    me()?;
    app_core::rt::try_blocking("sharing", move || share::merge_in(&state_dir(), &link(&project_id)?, &branch, digest.as_deref())).await
}

/// Agent-facing files already in the project from others, unreviewed (a
/// fresh clone, a merge made in a terminal), with their content.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn share_pending(project_id: String) -> Result<Option<Review>, String> {
    me()?;
    app_core::rt::try_blocking("sharing", move || share::pending_review(&link(&project_id)?)).await
}

/// The user reviewed what [`share_pending`] showed (`digest`): agents may
/// start in the project again.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn share_accept(project_id: String, digest: String) -> Result<(), String> {
    me()?;
    app_core::rt::try_blocking("sharing", move || share::accept_in(&state_dir(), &link(&project_id)?, &digest)).await
}
