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
    /// The agent tmux sessions that were ended although no window held a PTY on
    /// them: a tab the phone started headless, or a session that outlived a crash.
    pub closed_sessions: Vec<String>,
    /// The project's running verified local tabs whose sandbox was built under
    /// the other Cut network setting: they keep it until they are opened again.
    /// Nothing restarts them; the dialog asks. (`<scope>:<tab key>`, like `closed_tabs`.)
    pub restart_tabs: Vec<String>,
}

/// Set a project's agent privacy: Local models only, and Cut network (accepted on
/// Linux, where the sandbox cuts the network; refused elsewhere). Desktop only: the phone
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
    let (closed_tabs, closed_sessions) = if stored.local_models_only {
        close_unverified_agents(&ctx, &project_id).await?
    } else {
        (Vec::new(), Vec::new())
    };
    let restart_tabs = if stored.local_models_only { agent_privacy::restart_for_cut(&project_id, stored.cut_network) } else { Vec::new() };
    Ok(AgentPrivacyChange {
        local_models_only: stored.local_models_only,
        cut_network: stored.cut_network,
        closed_tabs,
        closed_sessions,
        restart_tabs,
    })
}

/// End every live agent PTY that is not a verified local tab of `project` and
/// can see its folder (`agent_privacy::ptys_to_end`): the project's own, and any
/// whose fence was built before the switch and still shows the folder — a parent
/// project's, a box's, the root console's with the read-only project view. Each
/// goes with its whole subtree (as `pty_kill` does) and the local tmux session it
/// was a client of, so a cloud agent does not outlive the switch.
async fn close_unverified_agents(ctx: &Ctx, project: &str) -> Result<(Vec<String>, Vec<String>), String> {
    let id = project.to_string();
    let dir = app_core::rt::try_blocking("agent privacy", move || {
        Ok(crate::services::remote::projects()?.iter().find(|p| p.id == id).and_then(|p| p.directory().map(std::path::PathBuf::from)))
    })
    .await?;
    let registry = ctx.get::<RegistryState>();
    let (ids, taken, sessions, held) = {
        let mut registry = registry.lock_ok();
        // Every tmux session a live PTY is a client of, taken or kept: the sweep below
        // is for the sessions no PTY holds.
        let held: Vec<String> = registry
            .ai_ids()
            .iter()
            .flat_map(|(id, tab)| [registry.local_tmux_of(id), registry.local_tmux_of(tab)])
            .flatten()
            .collect();
        let ids = agent_privacy::ptys_to_end(
            project,
            dir.as_deref(),
            &registry.ai_ids(),
            &crate::services::agent_fence::live_fence_views(),
            &|tab| agent_privacy::is_verified(tab, project),
        );
        let sessions: Vec<String> = ids.iter().filter_map(|id| registry.local_tmux_of(id)).collect();
        let taken: Vec<_> = ids.iter().filter_map(|id| registry.take(id)).collect();
        (ids, taken, sessions, held)
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
    let id = project.to_string();
    let closed_sessions = app_core::rt::blocking("terminal", move || end_detached_agents(&id, dir.as_deref(), &held)).await?;
    Ok((ids, closed_sessions))
}

/// End the agent tmux sessions no registry PTY holds that the switch must not leave
/// running (`agent_privacy::tmux_sessions_to_end`): each with its whole process subtree
/// (the pane's process and everything below it, found before the session goes), then
/// the session itself. Blocking; a machine without tmux or a server has none.
fn end_detached_agents(project: &str, dir: Option<&std::path::Path>, held: &[String]) -> Vec<String> {
    use crate::services::tmux_local;
    if !tmux_local::tmux_available() {
        return Vec::new();
    }
    let Ok(listed) = tmux_local::tmux_command().args(tmux_local::local_tmux_ls_args()).output() else {
        return Vec::new();
    };
    if !listed.status.success() {
        return Vec::new();
    }
    let sessions: Vec<agent_privacy::TmuxAgent> = crate::services::ssh_exec::parse_tmux_ls(&String::from_utf8_lossy(&listed.stdout))
        .into_iter()
        .filter(|s| tmux_local::is_app_local_tmux_session(&s.name))
        .map(|s| agent_privacy::TmuxAgent { session: s.name, cwd: s.current_path })
        .collect();
    let doomed = agent_privacy::tmux_sessions_to_end(
        project,
        dir,
        &sessions,
        held,
        &crate::services::agent_fence::live_tmux_tabs(),
        &|tab| agent_privacy::is_verified(tab, project),
    );
    if doomed.is_empty() {
        return doomed;
    }
    let panes = tmux_local::tmux_command()
        .args(["list-panes", "-a", "-F", "#{session_name}\t#{pane_pid}"])
        .output()
        .map(|o| crate::services::agent_fence::parse_tmux_pane_pids(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_default();
    for session in &doomed {
        if let Some(pid) = panes.get(session) {
            crate::terminal::reap_child_subtree(*pid, crate::terminal::ReapMode::Graceful);
        }
        let _ = tmux_local::tmux_command().args(tmux_local::local_tmux_kill_args(session)).output();
    }
    doomed
}
