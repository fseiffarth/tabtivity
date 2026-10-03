#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use app_lib::brand::SLUG;
fn main() {
    // `tabtivity --key-helper <socket>`: a hosted server's Claude
    // `apiKeyHelper` (`services::server::agent_keys`) — prints the key the
    // daemon's helper socket answers, and nothing else; first, so it touches
    // no state (it runs inside the agent fence).
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new(app_lib::services::server::agent_keys::HELPER_ARG)) {
        let socket = std::env::args_os().nth(2).unwrap_or_default();
        std::process::exit(app_lib::services::server::agent_keys::run_helper(&socket));
    }
    // Before anything looks a name up: where a lookup that only finds the old
    // name is counted (`<state>/legacy-hits.json`).
    app_lib::services::brand_migration::hits::install();
    // `tabtivity --agent-shim <cli> [args…]`: the shell-tab shim
    // (`services::agent_shim`) — builds the calling tab's fence and execs it.
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--agent-shim")) {
        let args: Vec<String> = std::env::args().skip(2).collect();
        let Some((cli, rest)) = args.split_first() else {
            eprintln!(concat!("agent shim: usage: ", app_lib::app_slug!(), " --agent-shim <cli> [args…]"));
            std::process::exit(2);
        };
        std::process::exit(app_lib::services::agent_shim::run(cli, rest));
    }
    // `tabtivity --fence-scope <bwrap> [args…]`: the agent fence's step before
    // bwrap (`services::fence_scope`) — enters the Landlock scope and execs.
    #[cfg(target_os = "linux")]
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--fence-scope")) {
        let args: Vec<std::ffi::OsString> = std::env::args_os().skip(2).collect();
        std::process::exit(app_lib::services::fence_scope::run(&args));
    }
    // `tabtivity --serverd`: the per-user server daemon (hosted plan §3.1),
    // the same entry as the `tabtivity-serverd` binary.
    #[cfg(unix)]
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--serverd")) {
        app_lib::services::server::daemon::main();
    }
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--mobile-host")) {
        let state_dir = app_lib::storage::state_dir();
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("mobile runtime");
        // Every exit is announced, including the clean ones. A sidecar that
        // stops with `Restart=on-failure` watching it is gone until somebody
        // presses Reconnect, so "why did Mobile stop?" has to be answerable
        // from `journalctl --user -u tabtivity-mobile-host` alone — a silent exit 0
        // leaves a dead process, a stale socket, and a desktop that can only
        // report `Connection refused (os error 111)`.
        match runtime.block_on(app_lib::services::mobile_control::host::run(state_dir)) {
            // Disabled is a decision, not a failure: exiting non-zero would make
            // `Restart=on-failure` relaunch an enabled unit forever against a
            // configuration that says off.
            Err(error)
                if error == app_lib::services::mobile_control::config::DISABLED_ERROR =>
            {
                eprintln!("{SLUG}-mobile-host: exiting: {error}");
            }
            Err(error) => {
                eprintln!("{SLUG}-mobile-host: {error}");
                std::process::exit(1);
            }
            Ok(()) => eprintln!(concat!(app_lib::app_slug!(), "-mobile-host: exiting: shut down on admin request")),
        }
        return;
    }
    app_lib::run()
}
