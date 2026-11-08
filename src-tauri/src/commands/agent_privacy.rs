//! The Tauri command behind a project's Local models only switch
//! (`services::agent_privacy`, `docs/context/local_models_only.md`).

use app_core::sync::LockExt;

use crate::services::agent_privacy::{self, Privacy};
use crate::tauri_host::Ctx;
use crate::terminal::RegistryState;

/// What `set_project_agent_privacy` stored, and the tabs it ended.
#[derive(Debug, Clone, serde::Serialize)]
pub struct AgentPrivacyChange {
    pub local_models_only: bool,
    pub cut_network: bool,
    /// The agent tabs of the project that were running and were not a verified
    /// local launch: ended with their whole process subtree, because turning
    /// the switch on must not leave a cloud agent reading the folder.
    pub closed_tabs: Vec<String>,
}

/// Set a project's agent privacy: Local models only, and Cut network (stored in
/// the setting's shape, refused until it is enforced). Desktop only: the phone
/// reads the setting from the project record and has no setter. Turning Local
/// models only on is refused with a message naming the project when the
/// project cannot be covered (remote, container or VM project; another
/// project inside its folder; an Ollama that is not on this machine), and ends
/// the project's running agent tabs the gate did not verify.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn set_project_agent_privacy(
    ctx: Ctx,
    project_id: String,
    local_models_only: bool,
    cut_network: bool,
) -> Result<AgentPrivacyChange, String> {
    let want = Privacy { local_models_only, cut_network };
    let id = project_id.clone();
    let stored = app_core::rt::try_blocking("agent privacy", move || agent_privacy::set(&id, want)).await?;
    let closed_tabs = if stored.local_models_only {
        close_unverified_agents(&ctx, &project_id).await?
    } else {
        Vec::new()
    };
    Ok(AgentPrivacyChange { local_models_only: stored.local_models_only, cut_network: stored.cut_network, closed_tabs })
}

/// End every live agent PTY of `project` the spawn gate did not verify, with
/// its whole subtree (as `pty_kill` does) and the local tmux session it was
/// a client of, so a cloud agent does not outlive the switch.
async fn close_unverified_agents(ctx: &Ctx, project: &str) -> Result<Vec<String>, String> {
    let registry = ctx.get::<RegistryState>();
    let (ids, taken, sessions) = {
        let mut registry = registry.lock_ok();
        let ids: Vec<String> = registry
            .ids_for_scope(project)
            .into_iter()
            .filter(|id| registry.is_ai(id) && !agent_privacy::is_verified(id, project))
            .collect();
        let sessions: Vec<String> = ids.iter().filter_map(|id| registry.local_tmux_of(id)).collect();
        let taken: Vec<_> = ids.iter().filter_map(|id| registry.take(id)).collect();
        (ids, taken, sessions)
    };
    for id in &ids {
        crate::commands::credentials::forget_login_pty(id);
        crate::terminal::route_remove_all_views(id);
    }
    app_core::rt::blocking("terminal", move || {
        crate::terminal::teardown_taken(taken);
        for session in sessions {
            let _ = crate::services::tmux_local::tmux_command()
                .args(crate::services::tmux_local::local_tmux_kill_args(&session))
                .output();
        }
    })
    .await?;
    Ok(ids)
}
