//! The shell-tab agent shim: `tabtivity --agent-shim <cli> [args…]`.
//!
//! Shell tabs are the user's terminals and are never fenced, so typing
//! `cursor-agent` into one used to run it against the user's real home. Every
//! shell tab now has one shim per registry CLI at the front of its PATH
//! (`services::agent_bin`), a tiny script that execs this entry point. It
//! builds the same fence a tab of the tab's scope would get — the scope's
//! Tabtivity-owned home, the shared logins, the project roots — and runs it as
//! its child on the same terminal, draining the terminal's input queue once
//! it has exited and before the shell reads again ([`run`]). There is no
//! bypass flag: it launches the CLI Tabtivity would launch, fenced, or refuses.
//! Running the binary by absolute path stays the user's own shell, real
//! home, no Tabtivity logins.
//!
//! The scope comes from `TABTIVITY_SCOPE`, which every tab Tabtivity spawns carries
//! (`commands::terminal::pty_spawn`); outside a Tabtivity tab the shim refuses.
//! Inside a fence (`TABTIVITY_AGENT_FENCE`) the script never reaches here — it
//! execs the real CLI from the rest of PATH instead.

use std::collections::HashMap;
use std::path::PathBuf;

/// Everything the shim needs before it can build a fence, resolved from the
/// process environment. Pure over `env`.
pub fn plan(cli: &str, env: &HashMap<String, String>) -> Result<(Option<String>, PathBuf), String> {
    if cli.is_empty() || cli.contains('/') || cli.contains('\\') {
        return Err("agent shim: a registry CLI name, not a path".into());
    }
    if env.contains_key(crate::app_env!("AGENT_FENCE")) {
        return Err("agent shim: already inside the agent sandbox".into());
    }
    let scope = env
        .get(crate::app_env!("SCOPE"))
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            concat!("agent shim: not a ", crate::app_name!(), " tab (no ", crate::app_upper!(), "_SCOPE); open the CLI from a ", crate::app_name!(), " tab").to_string()
        })?;
    let project_id = (scope != crate::storage::ROOT_SCOPE).then(|| scope.clone());
    let cwd = std::env::current_dir().map_err(|e| format!("agent shim: cwd: {e}"))?;
    Ok((project_id, cwd))
}

/// Build the fenced command for `cli args…` in the calling tab's scope.
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub fn command(cli: &str, args: &[String]) -> Result<std::process::Command, String> {
    let env: HashMap<String, String> = std::env::vars().collect();
    let (project_id, cwd) = plan(cli, &env)?;
    if !crate::commands::agents::agent_bins().contains(&cli) {
        return Err(format!("agent shim: '{cli}' is not a registry CLI"));
    }
    let scope_id = crate::services::agent_home::scope_of(project_id.as_deref());
    let roots = crate::services::agent_fence::roots_for_scope(project_id.as_deref(), true)
        .ok_or_else(|| format!("agent shim: unknown scope '{scope_id}'"))?;
    if !roots.iter().any(|root| cwd.starts_with(root)) {
        return Err(format!(
            "agent shim: {} is outside the scope's roots; cd into the project first",
            cwd.display()
        ));
    }
    let home = crate::services::agent_home::prepare_scope_home(&scope_id, &roots)
        .map_err(|e| format!("agent shim: prepare home: {e}"))?;
    let mut opts = crate::terminal::PtyOptions {
        id: format!("shim:{}", std::process::id()),
        cmd: cli.to_string(),
        args: args.to_vec(),
        env: env.clone(),
        cwd: cwd.to_string_lossy().into_owned(),
        cols: 80,
        rows: 24,
        local_only: true,
        sandbox: false,
        agent: true,
        project_id: project_id.clone(),
        remote_host_id: None,
        tmux_session: None,
        tmux_attach: None,
        host_bound_uid: None,
        local_model: false,
        schedule_target_id: None,
        host_session: false,
    };
    let own = roots
        .iter()
        .filter(|root| cwd.starts_with(root))
        .max_by_key(|root| root.components().count())
        .cloned()
        .unwrap_or_else(|| cwd.clone());
    crate::services::agent_fence::add_box_root_args(&mut opts, &roots, &own);
    #[cfg(target_os = "linux")]
    crate::services::agent_fence::wrap_pty_options_bwrap(&mut opts, &roots, &scope_id, &home.dir)?;
    #[cfg(target_os = "macos")]
    crate::services::agent_fence::wrap_pty_options_sandbox_exec(&mut opts, &roots, &scope_id, &home.dir)?;
    let mut command = std::process::Command::new(&opts.cmd);
    command.args(&opts.args).current_dir(&opts.cwd);
    for (k, v) in &opts.env {
        command.env(k, v);
    }
    if let Some(path) = crate::paths::effective_path() {
        command.env("PATH", path);
    }
    Ok(command)
}

/// Discard whatever is waiting in the terminal's input queue. The shim runs
/// on the user's own shell tab; once the fenced CLI has exited, the next
/// reader of that queue is the unfenced shell, so nothing the fenced process
/// left there may reach it (the same drain a fenced tmux pane runs before
/// its trailing shell, `tmux_local::FENCE_INPUT_DRAIN`). On Linux the fence's
/// pid namespace dies with the CLI, so nothing fenced can add more after
/// this; on macOS a process the agent left behind could still, which is the
/// same limit the pane drain has there.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn drain_terminal_input() {
    // SAFETY: plain libc calls on descriptor 0.
    unsafe {
        if libc::isatty(0) == 1 {
            libc::tcflush(0, libc::TCIFLUSH);
        }
    }
}

/// The entry point behind `tabtivity --agent-shim`. Runs the fenced CLI as a
/// child, on the same terminal, and waits for it — rather than `exec`ing
/// into it — so the terminal can be drained between the fenced process and
/// the shell that continues on it. Every failure is printed and becomes the
/// exit status; the child's own status is passed through.
pub fn run(cli: &str, args: &[String]) -> i32 {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        use std::os::unix::process::{CommandExt, ExitStatusExt};
        match command(cli, args) {
            Ok(mut command) => {
                // Ctrl+C and Ctrl+\ go to the foreground process group, the
                // child included; the shim itself must outlive them to drain
                // and report. The child gets the default dispositions back.
                // SAFETY: signal disposition changes; the child's runs
                // between fork and exec, on nothing but libc.
                unsafe {
                    libc::signal(libc::SIGINT, libc::SIG_IGN);
                    libc::signal(libc::SIGQUIT, libc::SIG_IGN);
                    command.pre_exec(|| {
                        libc::signal(libc::SIGINT, libc::SIG_DFL);
                        libc::signal(libc::SIGQUIT, libc::SIG_DFL);
                        Ok(())
                    });
                }
                let status = command.status();
                drain_terminal_input();
                match status {
                    Ok(status) => status
                        .code()
                        .unwrap_or_else(|| 128 + status.signal().unwrap_or(0)),
                    Err(err) => {
                        eprintln!("agent shim: run: {err}");
                        126
                    }
                }
            }
            Err(e) => {
                eprintln!("{e}");
                1
            }
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = (cli, args);
        eprintln!(concat!("agent shim: no agent sandbox on this platform; open the CLI from a ", crate::app_name!(), " agent tab"));
        1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shim_refuses_outside_a_tab_inside_a_fence_and_for_paths() {
        let mut env = HashMap::new();
        assert!(plan("claude", &env).is_err());
        env.insert(crate::app_env!("SCOPE").into(), "root".into());
        let (project, _) = plan("claude", &env).unwrap();
        assert_eq!(project, None);
        env.insert(crate::app_env!("SCOPE").into(), "p1".into());
        assert_eq!(plan("claude", &env).unwrap().0.as_deref(), Some("p1"));
        assert!(plan("/usr/bin/claude", &env).is_err());
        env.insert(crate::app_env!("AGENT_FENCE").into(), "1".into());
        assert!(plan("claude", &env).is_err());
    }
}
