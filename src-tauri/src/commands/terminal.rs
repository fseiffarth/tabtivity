use std::{
    fs,
    io::Read,
    path::Path,
    sync::{Arc, Mutex},
};

use tauri::{AppHandle, State};

use crate::services::mobile_control::inbox;
use crate::terminal::{PtyOptions, PtyRegistry};

pub type RegistryState = Arc<Mutex<PtyRegistry>>;

/// What `pty_spawn` tells the tab it launched.
#[derive(Debug, Clone, Copy, Default, serde::Serialize)]
pub struct PtySpawned {
    /// The session name rode in on the launch argv (Claude's `--name`), so the
    /// tab must not also type its `/rename` line.
    pub named: bool,
    /// The tab's previous process died mid-turn (`agent_turn::bind_tab`): the
    /// tab starts out marked interrupted.
    pub interrupted: bool,
    /// The tab's previous process left its turn finished: its agent sits at
    /// its composer, so the window reads no question off its screen until
    /// the hooks speak again (`agent_turn::LeftTurn`).
    pub resting: bool,
}

#[tauri::command]
pub async fn pty_spawn(
    app: AppHandle,
    registry: State<'_, RegistryState>,
    pool: State<'_, crate::services::remote::RemotePoolState>,
    opts: PtyOptions,
    session_name: Option<String>,
) -> Result<PtySpawned, String> {
    // The launch assembly is shared with the Mobile sidecar's headless spawn
    // (`services::launch_prep`); this command keeps what needs the window:
    // the registry's crash-loop guard, the PTY itself and its event.
    let prepared =
        crate::services::launch_prep::prepare(opts, session_name, Some(pool.inner())).await?;

    // Crash-loop guard.
    {
        let mut reg = registry.lock().unwrap();
        if !reg.check_crash_loop(&prepared.opts.id) {
            return Err(format!(
                "terminal '{}' is crash-looping; not restarting",
                prepared.opts.id
            ));
        }
    }

    let mcp_token_handed_out = prepared.mcp_token_handed_out();
    let (named, interrupted, resting) = (prepared.named, prepared.interrupted, prepared.resting);
    let drop_dir = prepared.drop_dir.clone();
    let result = crate::terminal::spawn_pty(app.clone(), registry.inner().clone(), prepared.opts.clone(), prepared.spawn_seq());
    if result.is_ok() {
        registry.lock().unwrap().set_drop_dir(&prepared.opts.id, drop_dir);
        prepared.commit();
        if mcp_token_handed_out {
            // The MCP session access fold lists live sessions; a new token is one.
            let _ = tauri::Emitter::emit(&app, crate::commands::root_mcp::SESSIONS_EVENT, ());
        }
    }
    result.map(|()| PtySpawned { named, interrupted, resting })
}

/// Honest per-scope fence status for the project-pill menu.  This performs no
/// spawn and uses the same cached bubblewrap probe and backend authority inputs
/// as `pty_spawn`.
#[tauri::command]
pub fn agent_fence_status(project_id: String) -> crate::services::agent_fence::AgentFenceStatus {
    crate::services::agent_fence::status_for_scope(&project_id)
}

/// Whether fenced Copilot tabs have a sign-in Tabtivity holds for them, and as
/// whom. Never returns the token (see `services::copilot_auth`).
#[tauri::command]
pub async fn copilot_fence_auth_status() -> crate::services::copilot_auth::CopilotFenceAuth {
    crate::services::copilot_auth::status().await
}

/// Forget the Copilot sign-in Tabtivity holds for fenced tabs.
#[tauri::command]
pub async fn copilot_fence_sign_out() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(crate::services::copilot_auth::sign_out)
        .await
        .map_err(|e| e.to_string())?
}

/// The project pills' fence markers, one call for every pill: whether new
/// agent tabs start unfenced by choice, and how many live ones run outside the
/// fence right now — measured from the agent processes, not from what their
/// spawn decided (see `agent_fence::HostAgentTab`).
#[tauri::command]
pub async fn agent_fence_marks(
    registry: State<'_, RegistryState>,
    project_ids: Vec<String>,
) -> Result<std::collections::HashMap<String, crate::services::agent_fence::AgentFenceMark>, String> {
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let live = crate::services::agent_fence::live_unfenced_by_scope(|id| {
            registry.lock().unwrap().pid(id)
        });
        crate::services::agent_fence::marks_for_scopes(&project_ids, &live)
    })
    .await
    .map_err(|e| e.to_string())
}

/// List the tmux sessions running on the **local** machine (TODO #85), for a local
/// project's Sessions view. Empty on Windows / without tmux / no server.
#[tauri::command]
pub async fn local_tmux_list() -> Result<Vec<crate::services::ssh_exec::TmuxSession>, String> {
    if !crate::services::tmux_local::tmux_available() {
        return Ok(Vec::new());
    }
    tauri::async_runtime::spawn_blocking(|| {
        let out = crate::paths::command_no_window("tmux")
            .args(crate::services::tmux_local::local_tmux_ls_args())
            .output();
        match out {
            Ok(o) => crate::services::ssh_exec::parse_tmux_ls(&String::from_utf8_lossy(&o.stdout)),
            Err(_) => Vec::new(),
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// Kill a **local** tmux session (TODO #85) — the explicit-close / Sessions-view
/// kill of a local persistent tab. No-op on Windows / without tmux.
#[tauri::command]
pub async fn local_tmux_kill(session: String) -> Result<(), String> {
    if !crate::services::tmux_local::tmux_available() {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let output = crate::paths::command_no_window("tmux")
            .args(crate::services::tmux_local::local_tmux_kill_args(&session))
            .output()
            .map_err(|e| format!("could not run tmux: {e}"))?;
        // Killed or already gone either way: its launcher (if the command line
        // needed one) has nothing left to launch, and its agent's API proxy
        // tokens nothing left to serve.
        crate::services::tmux_local::remove_launcher(&session);
        crate::services::api_proxy::on_tmux_session_gone(&session);
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
            // Explicit close is idempotent: a session that already exited is
            // already in the desired state.
            if detail.contains("can't find session")
                || detail.contains("no server running")
                || detail.contains("failed to connect to server")
            {
                return Ok(());
            }
            return Err(if detail.is_empty() {
                format!("tmux could not kill session '{session}'")
            } else {
                format!("tmux could not kill session '{session}': {detail}")
            });
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// End every tmux session Tabtivity created on the local machine during a clean
/// application quit — the frontend close handler's half of
/// `services::tmux_local::kill_app_sessions`, which owns the rule (every
/// `tabtivity-` session, no foreign one) and is also run by `RunEvent::Exit` as
/// the net for exits that never reach frontend code. A renderer or process
/// crash reaches neither, leaving the sessions alive for restore.
#[tauri::command]
pub async fn local_tmux_kill_app_sessions() -> Result<(), String> {
    if !crate::services::tmux_local::tmux_available() {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(crate::services::tmux_local::kill_app_sessions)
        .await
        .map_err(|e| e.to_string())?
}

/// The visible screen of a **local** tmux session, as plain rows — what the
/// model tag beside an agent tab reads the session's status line from
/// (`stores/agents/agentModels`). `None` when the session is not here (a remote
/// tab, one that exited, no tmux), which the caller reads as "no screen".
#[tauri::command]
pub async fn local_tmux_screen(session: String) -> Result<Option<String>, String> {
    if !crate::services::ssh_exec::valid_tmux_session_name(&session)
        || !crate::services::tmux_local::tmux_available()
    {
        return Ok(None);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let output = crate::paths::command_no_window("tmux")
            .args(crate::services::tmux_local::local_tmux_screen_args(&session))
            .output()
            .ok()?;
        output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
    })
    .await
    .map_err(|e| e.to_string())
}

/// Rename a **local** tmux session (TODO #85). `new_name` must be a safe tmux name.
#[tauri::command]
pub async fn local_tmux_rename(session: String, new_name: String) -> Result<(), String> {
    if !crate::services::ssh_exec::valid_tmux_session_name(&new_name) {
        return Err("a session name may only contain letters, digits, '-' and '_'".to_string());
    }
    if !crate::services::tmux_local::tmux_available() {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let renamed = crate::paths::command_no_window("tmux")
            .args(crate::services::tmux_local::local_tmux_rename_args(
                &session, &new_name,
            ))
            .output()
            .is_ok_and(|o| o.status.success());
        // The agent inside keeps running: its API proxy tokens follow the
        // session's new name instead of being swept as gone.
        if renamed {
            crate::services::api_proxy::on_tmux_renamed(&session, &new_name);
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// What a drop of OS files onto a terminal tab gives the tab to type.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct PtyDropped {
    /// One per file that made it, in drop order: for an agent tab the inbox
    /// reference (`inbox::INBOX_DIR/<file>`, relative to the tab's folder),
    /// for a shell tab the file's own path.
    pub items: Vec<String>,
    /// Why the first file that did not make it was refused — an inbox wire
    /// code, `not_a_file` or `unreadable`. The files after it are not tried.
    pub error: Option<String>,
}

/// Files dropped onto a local terminal tab from the OS file manager. An agent
/// tab gets each file copied into the inbox of the folder it works in — the
/// same git-ignored drop box a file sent from the phone lands in, and readable
/// from inside the fence or container, which a path elsewhere on this disk is
/// not. A shell runs on the host and gets the paths themselves, as a native
/// terminal would. A remote tab is refused (`remote_tab`): its program cannot
/// see this disk.
#[tauri::command]
pub async fn pty_drop_files(
    registry: State<'_, RegistryState>,
    id: String,
    paths: Vec<String>,
    agent: bool,
) -> Result<PtyDropped, String> {
    let dir = registry
        .lock()
        .unwrap()
        .drop_dir(&id)
        .ok_or("no_terminal")?
        .ok_or("remote_tab")?;
    tauri::async_runtime::spawn_blocking(move || drop_files(Path::new(&dir), &paths, agent))
        .await
        .map_err(|e| e.to_string())
}

fn drop_files(dir: &Path, paths: &[String], agent: bool) -> PtyDropped {
    let mut dropped = PtyDropped::default();
    for path in paths {
        match drop_file(dir, Path::new(path), agent) {
            Ok(item) => dropped.items.push(item),
            Err(code) => {
                dropped.error = Some(code.to_string());
                break;
            }
        }
    }
    dropped
}

fn drop_file(dir: &Path, path: &Path, agent: bool) -> Result<String, &'static str> {
    if !path.is_absolute() {
        return Err("not_a_file");
    }
    if !agent {
        return Ok(path.to_string_lossy().into_owned());
    }
    let meta = fs::metadata(path).map_err(|_| "unreadable")?;
    if !meta.is_file() {
        return Err("not_a_file");
    }
    if meta.len() > inbox::MAX_INBOX_FILE as u64 {
        return Err("file_too_large");
    }
    // Bounded even if the file grew since the check: `store` refuses the excess.
    let mut bytes = Vec::new();
    fs::File::open(path)
        .and_then(|file| file.take(inbox::MAX_INBOX_FILE as u64 + 1).read_to_end(&mut bytes))
        .map_err(|_| "unreadable")?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    inbox::store(dir, &name, &bytes)
        .map(|stored| stored.reference)
        .map_err(|e| e.code())
}

#[tauri::command]
pub async fn pty_write(
    registry: State<'_, RegistryState>,
    id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    // Watch for a Tabtivity-minted interactive login command being typed in, which is
    // what marks this PTY as a legitimate destination for the matching saved
    // credential (see `commands::credentials`).
    crate::commands::credentials::note_pty_input(&id, &data);
    let sender = registry.lock().unwrap().input_sender(&id);
    if let Some(sender) = sender {
        sender
            .send(data)
            .await
            .map_err(|_| format!("terminal '{id}' is no longer accepting input"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn pty_resize(
    registry: State<'_, RegistryState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    crate::terminal::resize_pty(registry.inner(), &id, cols, rows)
}

/// A pane's visibility report (visible-only streaming): a hidden pane's PTY
/// stops emitting `terminal-output` over IPC entirely — the backend buffers it
/// and condenses throttled `terminal-activity` digests for the pill
/// indicators — and re-showing drains the buffer as one `terminal-replay`.
/// See the routing block in `terminal/mod.rs`.
#[tauri::command]
pub async fn pty_set_visible(
    app: AppHandle,
    window: tauri::Window,
    id: String,
    viewer_id: String,
    visible: bool,
    update_seq: u64,
) -> Result<(), String> {
    // The window label comes from the CALLING window, never from the payload —
    // a view may only ever speak for itself (the rule `webview_renderer_claim`
    // follows). It is what lets the `Destroyed` hook drop the registrations of a
    // window that died without unmounting (Group B #238).
    crate::terminal::route_set_visible(&app, &id, &viewer_id, visible, update_seq, window.label());
    Ok(())
}

/// The retained tail of a PTY's output (Group B #235).
///
/// A second viewer — a tab popped out into its own window, a pane remounted by
/// a reseed — opens a fresh xterm on a PTY that may have been running for hours,
/// and used to render blank until the program next drew. This is the catch-up:
/// the router keeps a bounded tail of everything it routed (visible or not) and
/// hands it back here, to be written into the new terminal before its first live
/// byte. A read, not a drain: a third window attaching later gets it too.
#[tauri::command]
pub async fn pty_scrollback(
    id: String,
) -> Result<crate::terminal::TerminalScrollback, String> {
    Ok(crate::terminal::route_scrollback(&id))
}

#[tauri::command]
pub async fn pty_remove_view(id: String, viewer_id: String, update_seq: u64) -> Result<(), String> {
    crate::terminal::route_remove_view(&id, &viewer_id, update_seq);
    Ok(())
}

/// Hold a marker-watch on a PTY: stream its output as if its pane were
/// visible, for the login flows that scan a possibly-hidden terminal's raw
/// stream (`useRemoteSession`/`useRemoteReconnect`).
#[tauri::command]
pub async fn pty_watch(app: AppHandle, id: String) -> Result<(), String> {
    crate::terminal::route_watch(&app, &id);
    Ok(())
}

#[tauri::command]
pub async fn pty_unwatch(id: String) -> Result<(), String> {
    crate::terminal::route_unwatch(&id);
    Ok(())
}

#[tauri::command]
pub async fn pty_kill(registry: State<'_, RegistryState>, id: String) -> Result<(), String> {
    // The terminal is gone, so its login marking must not outlive it and bless a
    // future PTY that reuses the id.
    crate::commands::credentials::forget_login_pty(&id);
    // Taken under the lock, torn down after it: the lock is on every
    // keystroke's path, the teardown walks the process table. The teardown
    // ends the per-tab state of the spawn it took, and only while that spawn
    // is still the id's newest: this kill can land after a remount began
    // respawning the id (gap 18). Nothing taken, nothing to end — the
    // reader task's end already cleaned up that spawn.
    let taken = registry.lock().unwrap().take(&id);
    if let Some(taken) = taken {
        tauri::async_runtime::spawn_blocking(move || taken.teardown())
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Kill every live PTY belonging to one project scope. PTY ids are
/// `<scope>:<tab-key>`; the delimiter is part of the match so similarly named
/// projects cannot affect each other.
#[tauri::command]
pub async fn pty_kill_scope(
    registry: State<'_, RegistryState>,
    scope: String,
) -> Result<Vec<String>, String> {
    // Every PTY of the scope is taken in one short hold of the registry lock
    // (it is on every keystroke's path) and torn down after it, with one
    // process-table walk for the lot instead of one per tab.
    let (ids, taken) = {
        let mut registry = registry.lock().unwrap();
        let ids = registry.ids_for_scope(&scope);
        let taken: Vec<_> = ids.iter().filter_map(|id| registry.take(id)).collect();
        (ids, taken)
    };
    for id in &ids {
        crate::commands::credentials::forget_login_pty(id);
        crate::terminal::route_remove_all_views(id);
    }
    // The teardown ends each taken spawn's per-tab state, generation-guarded
    // like `pty_kill`'s.
    tauri::async_runtime::spawn_blocking(move || crate::terminal::teardown_taken(taken))
        .await
        .map_err(|e| e.to_string())?;
    Ok(ids)
}

/// Live CPU usage (percent of a single core; may exceed 100 on multi-core work)
/// for the processes rooted at the given PTYs and all their descendants.
///
/// Samples busy CPU ticks twice over a short interval via `sysstat` (Linux
/// `/proc`, Windows `GetProcessTimes`). On backends that don't sample (other
/// OSes) the ticks are always 0, so this returns 0.0 and the UI hides the figure.
#[tauri::command]
pub async fn project_cpu_percent(
    registry: State<'_, RegistryState>,
    pty_ids: Vec<String>,
) -> Result<f64, String> {
    use crate::sysstat;

    let roots: Vec<u32> = {
        let reg = registry.lock().unwrap();
        pty_ids.iter().filter_map(|id| reg.pid(id)).collect()
    };
    if roots.is_empty() {
        return Ok(0.0);
    }

    // Resolve the process tree once, then sample its busy time across a fixed
    // window. Newly spawned children mid-window simply contribute less; that is
    // acceptable for a coarse live readout.
    let pids = sysstat::descendant_pids(&roots);
    let interval = std::time::Duration::from_millis(300);
    let t0 = sysstat::sum_jiffies(&pids);
    tokio::time::sleep(interval).await;
    let t1 = sysstat::sum_jiffies(&pids);

    let busy_secs = t1.saturating_sub(t0) as f64 / sysstat::clk_tck() as f64;
    let pct = busy_secs / interval.as_secs_f64() * 100.0;
    Ok((pct * 10.0).round() / 10.0)
}

/// Register a tab as a **host-bound local-model tab** — the one kind of tab that
/// keeps running on the host when the project's container toggle is on.
///
/// Called by `TabBar` / `NewTabMenu` at the moment such a tab is created, with the
/// uuid the tab persists as `hostBoundUid`. The grant is a file in the state dir
/// (`services::sandbox::register_host_bound_tab`), which is what makes it survive
/// a relaunch — the tab's key and PTY id do not — without the decision riding on
/// anything a project's own files can state.
#[tauri::command]
pub fn register_host_bound_tab(project_id: String, uid: String) -> Result<(), String> {
    crate::services::sandbox::register_host_bound_tab(&project_id, &uid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_drop_copies_into_the_tab_folders_inbox() {
        let tab = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let shot = outside.path().join("shot one.png");
        fs::write(&shot, b"png bytes").unwrap();
        let dropped = drop_files(tab.path(), &[shot.to_string_lossy().into_owned()], true);
        assert_eq!(dropped.error, None);
        let reference = &dropped.items[0];
        assert!(reference.starts_with(&format!("{}/", inbox::INBOX_DIR)), "{reference}");
        assert_eq!(fs::read(tab.path().join(reference)).unwrap(), b"png bytes");
    }

    #[test]
    fn shell_drop_hands_back_the_path_and_copies_nothing() {
        let tab = tempfile::tempdir().unwrap();
        // Absolute on this OS: a leading `/` alone is relative on Windows.
        let path = if cfg!(windows) { r"C:\somewhere\a file.txt" } else { "/somewhere/a file.txt" }.to_string();
        let dropped = drop_files(tab.path(), std::slice::from_ref(&path), false);
        assert_eq!(dropped, PtyDropped { items: vec![path], error: None });
        assert!(!tab.path().join(inbox::INBOX_DIR).exists());
    }

    #[test]
    fn agent_drop_stops_at_the_first_refusal() {
        let tab = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let good = outside.path().join("a.txt");
        fs::write(&good, b"a").unwrap();
        let paths = [
            good.to_string_lossy().into_owned(),
            outside.path().to_string_lossy().into_owned(),
            good.to_string_lossy().into_owned(),
        ];
        let dropped = drop_files(tab.path(), &paths, true);
        assert_eq!(dropped.items.len(), 1);
        assert_eq!(dropped.error.as_deref(), Some("not_a_file"));
        assert_eq!(drop_files(tab.path(), &["rel.txt".into()], true).error.as_deref(), Some("not_a_file"));
    }
}
