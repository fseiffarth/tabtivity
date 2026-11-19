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
//!
//! Windows has no fence: its `.cmd` shim asks `--agent-shim-env` ([`run_env`])
//! for the scope's environment and the real CLI and runs it itself. There the
//! "already an agent" case does reach this binary, marked by
//! `TABTIVITY_AGENT_UNFENCED` ([`UNFENCED_ENV`]): [`nested_real_cli`] answers
//! the real CLI alone.

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
    // The chat assistant's tabs run only the profile Tabtivity builds for them
    // (`services::assistant`): a typed CLI would be seeded from, and run with,
    // the scope's `agent_global` layer, tools and all.
    if crate::storage::is_reserved_scope(scope) && scope != crate::storage::ROOT_SCOPE {
        return Err(concat!("agent shim: not available in this ", crate::app_name!(), " scope").into());
    }
    let project_id = (scope != crate::storage::ROOT_SCOPE).then(|| scope.clone());
    let cwd = std::env::current_dir().map_err(|e| format!("agent shim: cwd: {e}"))?;
    Ok((project_id, cwd))
}

/// The calling tab's scope for a typed CLI ([`scope_for`]).
struct ShimScope {
    project_id: Option<String>,
    cwd: PathBuf,
    scope_id: String,
    #[cfg_attr(windows, allow(dead_code))]
    roots: Vec<PathBuf>,
    home: PathBuf,
}

/// The calling tab's scope for `cli`: its id, writable roots and prepared home,
/// with the cwd checked against the roots. Shared by the fenced shim and the
/// Windows one.
fn scope_for(cli: &str, env: &HashMap<String, String>) -> Result<ShimScope, String> {
    let (project_id, cwd) = plan(cli, env)?;
    if !crate::services::agent_registry::agent_bins().contains(&cli) {
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
    Ok(ShimScope { project_id, cwd, scope_id, roots, home: home.dir })
}

/// The variable names of the Windows shim's answer ([`env_answer`]): the
/// real CLI, how `cmd` must start it, and a refusal.
pub fn windows_answer_vars() -> (String, String, String) {
    let u = crate::brand::UPPER;
    (format!("{u}_SHIM_REAL"), format!("{u}_SHIM_CALL"), format!("{u}_SHIM_ERROR"))
}

/// How `cmd.exe` starts the resolved CLI `real` as the last line of the
/// `.cmd` shim: an `.exe` directly, another batch file through `call` (so it
/// returns its status), a PowerShell script through `powershell.exe`.
pub fn windows_call_prefix(real: &std::path::Path) -> &'static str {
    match real.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("cmd" | "bat") => "call",
        Some("ps1") => "powershell.exe -NoProfile -ExecutionPolicy Bypass -File",
        _ => "",
    }
}

/// The environment a CLI typed into a Windows shell tab runs with, on top
/// of the shell's own `process_env`: the scope home and the Windows profile
/// set (`agent_fence::home_env_for`, the agent tab's), which replace the
/// shell's values, and the per-CLI file-storage switches
/// (`agent_auth::fence_env`), where a value the user set wins. What a
/// Windows agent tab of the scope gets (`launch_prep`, the "platform" arm).
pub fn windows_scope_env(
    home: &std::path::Path,
    user_home: &std::path::Path,
    user_appdata: Option<&std::path::Path>,
    cli: &str,
    process_env: &HashMap<String, String>,
) -> Vec<(String, String)> {
    let mut env = crate::services::agent_fence::home_env_for(true, home, user_home, user_appdata, cli);
    for (k, v) in crate::services::agent_auth::fence_env(cli) {
        if !process_env.contains_key(*k) {
            env.push(((*k).to_string(), (*v).to_string()));
        }
    }
    env
}

/// The answer `--agent-shim-env` prints for the `.cmd` shim to read with
/// `for /f`: one `NAME=value` per line, the real CLI last. A refusal is the
/// one error line, so the shim can say it and stop. A value with a line
/// break cannot cross and is dropped.
pub fn env_answer(result: Result<(std::path::PathBuf, Vec<(String, String)>), String>) -> String {
    let (real_var, call_var, err_var) = windows_answer_vars();
    let clean = |s: &str| !s.contains(['\r', '\n']);
    match result {
        Ok((real, env)) => {
            let mut out = String::new();
            for (k, v) in env.iter().filter(|(k, v)| clean(k) && clean(v) && !k.contains('=')) {
                out.push_str(&format!("{k}={v}\n"));
            }
            out.push_str(&format!("{call_var}={}\n", windows_call_prefix(&real)));
            out.push_str(&format!("{real_var}={}\n", real.to_string_lossy()));
            out
        }
        Err(e) => format!("{err_var}={}\n", e.replace(['\r', '\n'], " ")),
    }
}

/// Set in the environment of every agent CLI Tabtivity starts unfenced in a
/// home of its own on a platform with no fence (Windows): an agent tab, the
/// Host session, a CLI the shim started in a shell tab. The Windows twin of
/// `AGENT_FENCE` for the shim: a CLI typed *there* (the agent's own shell)
/// already has its scope's environment, so the shim steps aside and answers
/// the real CLI only, as the POSIX script does inside a fence. Its value is
/// the shim directory, which that lookup skips: the caller's `APPDATA` is the
/// agent home's, so `--agent-shim-env` cannot find Tabtivity's state dir —
/// nor the shim directory under it — from its own environment. A control
/// variable (`launch_prep::CONTROL_ENV`): only Tabtivity sets it.
pub const UNFENCED_ENV: &str = crate::app_env!("AGENT_UNFENCED");

/// [`UNFENCED_ENV`] for a spawn on this platform: set on Windows, nothing on
/// Linux and macOS, whose fence (or, for the Host session, the POSIX script's
/// own `HOST_SESSION` branch) is the marker.
pub fn unfenced_marker(windows: bool, shim_dir: &std::path::Path) -> Option<(String, String)> {
    windows.then(|| (UNFENCED_ENV.to_string(), shim_dir.to_string_lossy().into_owned()))
}

/// What the Windows shim answers when its caller already runs in an agent's
/// environment (`marker` is the caller's [`UNFENCED_ENV`]): the real CLI,
/// found on the caller's `path` outside the shim directory the marker names.
/// `None` when the caller is not such a process and the scope's gates and
/// environment apply. Decided before anything is read from Tabtivity's state
/// dir, which such a caller's `APPDATA` no longer leads to: read from there,
/// the one-time acceptance looked ungiven and the agent's own `claude` was
/// refused, and the Host session's lookup, skipping the wrong directory,
/// answered the shim itself, which then ran itself without end.
pub fn nested_real_cli(
    os: crate::paths::OsKind,
    cli: &str,
    marker: Option<&std::ffi::OsStr>,
    path: Option<&std::ffi::OsStr>,
    pathext: Option<&std::ffi::OsStr>,
    exists: &impl Fn(&std::path::Path) -> bool,
) -> Option<Result<PathBuf, String>> {
    let shims = PathBuf::from(marker.filter(|m| !m.is_empty())?);
    let real = path.and_then(|path| crate::paths::resolve_on_path_skipping(os, path, &shims, cli, pathext, exists));
    Some(real.ok_or_else(|| format!("{cli}: command not found")))
}

/// Windows has no fence to build: what the shell-tab shim needs is the CLI
/// itself and the scope's environment, which the `.cmd` shim
/// (`agent_bin::cmd_shim_script`) sets and then runs the CLI with — on the
/// same console, so its TUI stays in the tab (this binary is a GUI
/// executable there and could not host it). The same gates as an agent tab:
/// the AI switch, the user's one-time acceptance of unfenced agents, the
/// scope's roots, Local models only. A caller that is itself an agent
/// ([`nested_real_cli`]) gets the real CLI and keeps its environment.
#[cfg(windows)]
fn windows_env_plan(cli: &str) -> Result<(std::path::PathBuf, Vec<(String, String)>), String> {
    // First, and from the environment alone: see `nested_real_cli`.
    if let Some(real) = nested_real_cli(
        crate::paths::OsKind::Windows,
        cli,
        std::env::var_os(UNFENCED_ENV).as_deref(),
        std::env::var_os("PATH").as_deref(),
        std::env::var_os("PATHEXT").as_deref(),
        &|path| path.is_file(),
    ) {
        return real.map(|real| (real, Vec::new()));
    }
    if crate::services::ai_switch::is_off() {
        return Err(concat!("agent shim: AI is off; switch it on with the power button in ", crate::app_name!(), "'s side panel").into());
    }
    let env: HashMap<String, String> = std::env::vars().collect();
    let real = || {
        crate::paths::resolve_executable(cli).ok_or_else(|| format!("{cli}: command not found"))
    };
    // The root console's Host session already runs in its own home.
    if env.contains_key(crate::app_env!("HOST_SESSION")) {
        return Ok((real()?, Vec::new()));
    }
    if !crate::services::agent_fence::platform_accepted() {
        return Err(concat!(
            "agent shim: agents run unfenced on Windows; open an agent tab in ", crate::app_name!(),
            " once and accept that first"
        ).into());
    }
    let ShimScope { project_id, cwd, scope_id, home, .. } = scope_for(cli, &env)?;
    let opts = shim_pty_options(cli, &[], &env, &cwd, project_id);
    crate::services::agent_privacy::fence_gate(&opts, &scope_id)?;
    let user_appdata = std::env::var_os("APPDATA").map(PathBuf::from);
    let mut scope_env = windows_scope_env(&home, &crate::paths::home_dir(), user_appdata.as_deref(), cli, &env);
    // The CLI is an agent from here on: one it starts itself steps aside.
    scope_env.extend(unfenced_marker(true, &crate::services::agent_bin::bin_dir()));
    Ok((real()?, scope_env))
}

/// The entry point behind `tabtivity --agent-shim-env <cli>` (Windows): print
/// [`env_answer`] on stdout, which the `.cmd` shim reads. Always exits 0;
/// a refusal is in the answer.
pub fn run_env(cli: &str) -> i32 {
    #[cfg(windows)]
    let result = windows_env_plan(cli);
    #[cfg(not(windows))]
    let result = Err::<(PathBuf, Vec<(String, String)>), String>(format!(
        "agent shim: {cli}: the environment answer is for the Windows shim only"
    ));
    use std::io::Write;
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(env_answer(result).as_bytes());
    let _ = out.flush();
    0
}

fn shim_pty_options(
    cli: &str,
    args: &[String],
    env: &HashMap<String, String>,
    cwd: &std::path::Path,
    project_id: Option<String>,
) -> crate::terminal::PtyOptions {
    crate::terminal::PtyOptions {
        login: None,
        assistant: None,
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
        project_id,
        remote_host_id: None,
        tmux_session: None,
        tmux_attach: None,
        host_bound_uid: None,
        local_model: false,
        schedule_target_id: None,
        host_session: false,
        api_key: None,
        mux_wrapped: false,
        mcp_mark: None,
    }
}

/// Build the fenced command for `cli args…` in the calling tab's scope.
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub fn command(cli: &str, args: &[String]) -> Result<std::process::Command, String> {
    let env: HashMap<String, String> = std::env::vars().collect();
    let ShimScope { project_id, cwd, scope_id, roots, home: home_dir } = scope_for(cli, &env)?;
    let mut opts = shim_pty_options(cli, args, &env, &cwd, project_id);
    let own = roots
        .iter()
        .filter(|root| cwd.starts_with(root))
        .max_by_key(|root| root.components().count())
        .cloned()
        .unwrap_or_else(|| cwd.clone());
    let added = crate::services::agent_fence::add_box_root_args(&mut opts, &roots, &own);
    if cli == "claude" {
        if let Err(e) = crate::services::agent_home::trust_claude_added_dirs(&home_dir, &added) {
            eprintln!("agent shim: trust the box roots for Claude: {e}");
        }
    }
    #[cfg(target_os = "linux")]
    crate::services::agent_fence::wrap_pty_options_bwrap(&mut opts, &roots, &scope_id, &home_dir)?;
    #[cfg(target_os = "macos")]
    crate::services::agent_fence::wrap_pty_options_sandbox_exec(&mut opts, &roots, &scope_id, &home_dir)?;
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
/// left there may reach it. On Linux the fence's pid namespace dies with the
/// CLI, so nothing fenced can add more after this; on macOS a process the
/// agent left behind could still.
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
    // The AI switch (`services::ai_switch`): no CLI starts while AI is off.
    if crate::services::ai_switch::is_off() {
        eprintln!(concat!("agent shim: AI is off; switch it on with the power button in ", crate::app_name!(), "'s side panel"));
        return 1;
    }
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
    /// 2442d: what a CLI typed into a Windows shell tab runs with — the scope
    /// home over the shell's own profile, the file-storage switch unless the
    /// user set it — and the answer the `.cmd` shim reads.
    #[test]
    fn the_windows_shim_env_replaces_the_profile_and_keeps_the_users_switch() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("agent-homes").join("p");
        let user = tmp.path().join("user");
        let mut shell = HashMap::new();
        shell.insert("USERPROFILE".to_string(), user.to_string_lossy().into_owned());
        let env = windows_scope_env(&home, &user, None, "goose", &shell);
        let get = |k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| PathBuf::from(v));
        assert_eq!(get("USERPROFILE"), Some(home.clone()), "the scope home replaces the shell's");
        assert_eq!(get("APPDATA"), Some(home.join("AppData").join("Roaming")));
        assert_eq!(get("GOOSE_DISABLE_KEYRING"), Some(PathBuf::from("1")));
        shell.insert("GOOSE_DISABLE_KEYRING".to_string(), "0".to_string());
        let env = windows_scope_env(&home, &user, None, "goose", &shell);
        assert!(!env.iter().any(|(k, _)| k == "GOOSE_DISABLE_KEYRING"), "the user's value wins");

        let (real_var, call_var, err_var) = windows_answer_vars();
        let real = PathBuf::from(r"C:\npm\claude.cmd");
        let answer = env_answer(Ok((real, vec![
            ("HOME".into(), r"C:\h".into()),
            ("BAD".into(), "a\nb".into()),
        ])));
        let lines: Vec<&str> = answer.lines().collect();
        assert_eq!(lines, [r"HOME=C:\h".to_string(), format!("{call_var}=call"), format!(r"{real_var}=C:\npm\claude.cmd")]);
        let refused = env_answer(Err("no\nway".into()));
        assert_eq!(refused, format!("{err_var}=no way\n"));
        assert_eq!(windows_call_prefix(std::path::Path::new(r"C:\x\claude.exe")), "");
        assert!(windows_call_prefix(std::path::Path::new(r"C:\x\c.PS1")).starts_with("powershell.exe"));
    }

    /// 2442d review: a CLI an agent types in its own shell on Windows reaches
    /// the `.cmd` shim with the agent home's `APPDATA`, from which Tabtivity's
    /// state dir cannot be found. The marker the spawn left decides, before
    /// any state is read: the real CLI past the shim directory, never the
    /// shim itself (which would run itself again) and no second environment.
    #[test]
    fn a_windows_agents_own_cli_call_steps_aside_past_the_shim() {
        use crate::paths::OsKind;
        use std::ffi::OsStr;
        use std::path::Path;
        let shims = Path::new("state").join("bin");
        let npm = Path::new("npm").to_path_buf();
        let path = std::env::join_paths([shims.clone(), npm.clone()]).unwrap();
        // The shim first on PATH, the real CLI behind it: npm's batch file
        // beside its extensionless sh script.
        let files = [shims.join("claude.cmd"), npm.join("claude.cmd"), npm.join("claude")];
        let exists = |p: &Path| files.iter().any(|f| f == p);
        let pathext = Some(OsStr::new(".COM;.EXE;.BAT;.CMD"));
        let ask = |marker: Option<&OsStr>, path: &OsStr| nested_real_cli(OsKind::Windows, "claude", marker, Some(path), pathext, &exists);

        // A shell tab: no marker, so the gates and the scope's environment apply.
        assert_eq!(ask(None, &path), None);
        assert_eq!(ask(Some(OsStr::new("")), &path), None);

        // An agent tab, the Host session, a CLI the shim started: marked on
        // Windows only, with the shim directory.
        let (name, value) = unfenced_marker(true, &shims).expect("Windows marks the spawn");
        assert_eq!(name, UNFENCED_ENV);
        assert_eq!(unfenced_marker(false, &shims), None, "Linux and macOS have the fence's marker");
        assert_eq!(ask(Some(OsStr::new(&value)), &path), Some(Ok(npm.join("claude.cmd"))));

        // Nothing but the shim on PATH: not found, never the shim.
        let only_shims = std::env::join_paths([shims.clone()]).unwrap();
        assert_eq!(ask(Some(OsStr::new(&value)), &only_shims), Some(Err("claude: command not found".to_string())));
        assert_eq!(
            nested_real_cli(OsKind::Windows, "claude", Some(OsStr::new(&value)), None, pathext, &exists),
            Some(Err("claude: command not found".to_string())),
        );

        // Only Tabtivity sets it: a tab layout that carries one loses it.
        assert!(crate::services::launch_prep::is_control_env(UNFENCED_ENV));
        assert!(crate::services::launch_prep::is_control_env(&UNFENCED_ENV.to_ascii_lowercase()));
    }

    #[test]
    fn the_shim_refuses_the_chat_assistants_scope() {
        // A typed CLI would be seeded from and run with the scope's global
        // layer; the scope runs only the profile Tabtivity builds for it.
        for scope in [crate::storage::ASSISTANT_SCOPE, "Assistant", "assistant "] {
            let mut env = HashMap::new();
            env.insert(crate::app_env!("SCOPE").into(), scope.into());
            assert!(plan("claude", &env).is_err(), "{scope:?}");
        }
        let mut env = HashMap::new();
        env.insert(crate::app_env!("SCOPE").into(), "assistant2".into());
        assert!(plan("claude", &env).is_ok());
    }
}
