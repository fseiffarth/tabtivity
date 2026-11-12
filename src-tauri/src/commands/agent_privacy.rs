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
    /// Only sessions confirmed gone afterwards.
    pub closed_sessions: Vec<String>,
    /// The project's running verified local tabs whose sandbox was built under
    /// the other Cut network setting: they keep it until they are opened again.
    /// Nothing restarts them; the dialog asks. (`<scope>:<tab key>`, like `closed_tabs`.)
    pub restart_tabs: Vec<String>,
    /// The agent tmux sessions the switch meant to end (a closed tab's, or one no
    /// window held) that could not be confirmed gone: the setting holds for new
    /// agents, but these may still read the folder. Empty for a complete switch.
    pub unconfirmed: Vec<String>,
    /// Why the sweep could not finish or confirm its work (tmux would not list its
    /// sessions, refused a kill, the project list could not be read); `None` when
    /// it did. The setting stays stored either way: it is never rolled back.
    pub sweep_error: Option<String>,
}

/// Set a project's agent privacy: Local models only, and Cut network (accepted on
/// Linux, where the sandbox cuts the network; refused elsewhere). Desktop only: the phone
/// reads the setting from the project record and has no setter. Turning Local
/// models only on is refused with a message naming the project when the
/// project cannot be covered (remote, container or VM project; another
/// project inside its folder; an Ollama that is not on this machine), and ends
/// the project's running agent tabs the gate did not verify. A sweep that could
/// not end or confirm every one still answers with the stored setting, naming
/// what it could not confirm (`unconfirmed`, `sweep_error`).
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
    let mut change = AgentPrivacyChange {
        local_models_only: stored.local_models_only,
        cut_network: stored.cut_network,
        closed_tabs: Vec::new(),
        closed_sessions: Vec::new(),
        restart_tabs: Vec::new(),
        unconfirmed: Vec::new(),
        sweep_error: None,
    };
    if stored.local_models_only {
        // The setting is stored: a sweep that fails is reported, never an error
        // that would leave the window believing the switch is still off.
        match close_unverified_agents(&ctx, &project_id).await {
            Ok(closed) => {
                change.closed_tabs = closed.tabs;
                change.closed_sessions = closed.sessions;
                change.unconfirmed = closed.sweep.unconfirmed;
                change.sweep_error = (!closed.sweep.errors.is_empty()).then(|| closed.sweep.errors.join("; "));
            }
            Err(e) => change.sweep_error = Some(e),
        }
        change.restart_tabs = agent_privacy::restart_for_cut(&project_id, stored.cut_network);
    }
    Ok(change)
}

/// What [`close_unverified_agents`] ended, and its tmux sweep.
struct Closed {
    tabs: Vec<String>,
    /// Sessions no PTY held, confirmed gone.
    sessions: Vec<String>,
    sweep: agent_privacy::Sweep,
}

/// End every live agent PTY that is not a verified local tab of `project` and
/// can see its folder (`agent_privacy::ptys_to_end`): the project's own, and any
/// whose fence was built before the switch and still shows the folder — a parent
/// project's, a box's, the root console's with the read-only project view. Each
/// goes with its whole subtree (as `pty_kill` does) and the local tmux session it
/// was a client of, so a cloud agent does not outlive the switch; then the agent
/// sessions no PTY holds (`agent_privacy::sweep_sessions`). Every session is
/// confirmed gone or reported in the sweep.
async fn close_unverified_agents(ctx: &Ctx, project: &str) -> Result<Closed, String> {
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
        let ais = registry.ai_ids();
        let held: Vec<String> = ais
            .iter()
            .flat_map(|(id, tab)| [registry.local_tmux_of(id), registry.local_tmux_of(tab)])
            .flatten()
            .collect();
        let ids = agent_privacy::ptys_to_end(
            project,
            dir.as_deref(),
            &ais,
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
    let id = project.to_string();
    let forced = sessions.clone();
    let sweep = app_core::rt::blocking("terminal", move || {
        crate::terminal::teardown_taken(taken);
        agent_privacy::sweep_sessions(&id, dir.as_deref(), &forced, &held)
    })
    .await?;
    let sessions = sweep.ended.iter().filter(|s| !sessions.contains(s)).cloned().collect();
    Ok(Closed { tabs: ids, sessions, sweep })
}

/// End spawn `seq` of PTY `id`, registered a moment ago, that the Local models only
/// re-check refused (`launch_prep::recheck_privacy`: the switch went on while it was
/// starting): its whole subtree, as `pty_kill` does, and the local tmux session it is a
/// client of, with that session's processes. Nothing when the id already runs a newer
/// spawn, which its own re-check judges. A note for the refusal when the session could
/// not be confirmed gone.
pub(crate) async fn end_refused_spawn(registry: &RegistryState, id: &str, seq: u64) -> Option<String> {
    let (taken, session) = {
        let mut reg = registry.lock_ok();
        reg.input_sender_of_spawn(id, seq)?;
        let session = reg.local_tmux_of(id);
        (reg.take(id), session)
    };
    crate::commands::credentials::forget_login_pty(id);
    crate::terminal::route_remove_all_views(id);
    let sweep = app_core::rt::blocking("terminal", move || {
        crate::terminal::teardown_taken(taken.into_iter().collect());
        agent_privacy::end_sessions(session.as_slice())
    })
    .await;
    unconfirmed_note(sweep)
}

/// The words a refusal adds when ending a refused spawn's session was not confirmed.
pub(crate) fn unconfirmed_note(sweep: Result<agent_privacy::Sweep, String>) -> Option<String> {
    match sweep {
        Ok(sweep) if sweep.complete() => None,
        Ok(sweep) => Some(format!(
            "Its tmux session {} could not be confirmed stopped ({}).",
            sweep.unconfirmed.join(", "),
            sweep.errors.join("; ")
        )),
        Err(e) => Some(format!("Its tmux session could not be confirmed stopped ({e}).")),
    }
}
