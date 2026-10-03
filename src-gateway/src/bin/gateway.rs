//! The server gateway (hosted plan §3.1): `<slug>-gateway serve`, started by
//! `<slug>-gateway.service` as `<slug>-gw`. Linux only.

fn main() {
    #[cfg(unix)]
    {
        let args: Vec<String> = std::env::args().skip(1).collect();
        let slug = app_gateway::brand::SLUG;
        match args.first().map(String::as_str) {
            Some("serve") | None => {}
            Some("keeper") => std::process::exit(keeper(&args[1..])),
            Some("--help") | Some("-h") => {
                println!("{slug}-gateway serve\n{slug}-gateway keeper [--socket PATH] [--dir PATH]\n\nserve: routes each signed-in device to its own account's daemon. Configured by the unit's environment (see /etc/{slug}/server.env).\nkeeper: holds the administrator's agent API keys (as {slug}-auth, on the socket systemd passes).");
                return;
            }
            Some(other) => {
                eprintln!("{slug}-gateway: unknown argument {other:?} (try --help)");
                std::process::exit(2);
            }
        }
        let config = match app_gateway::config::GatewayConfig::from_env() {
            Ok(config) => config,
            Err(error) => {
                eprintln!("{slug}-gateway: {error}");
                std::process::exit(2);
            }
        };
        let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
            Ok(runtime) => runtime,
            Err(error) => {
                eprintln!("{slug}-gateway: runtime: {error}");
                std::process::exit(1);
            }
        };
        if let Err(error) = runtime.block_on(app_gateway::server::serve(config)) {
            eprintln!("{slug}-gateway: {error}");
            std::process::exit(1);
        }
    }
    #[cfg(not(unix))]
    {
        eprintln!("the server gateway runs on Linux only");
        std::process::exit(2);
    }
}

/// `<slug>-gateway keeper`: the key keeper (hosted plan §5.4), started by
/// `<slug>-auth-keeper.service` as `<slug>-auth` on the socket its socket
/// unit passes; `--socket` binds one itself (a manual test), `--dir` names
/// another key directory.
#[cfg(unix)]
fn keeper(args: &[String]) -> i32 {
    use app_gateway::keeper::{self, Keeper, SystemPeers};
    let slug = app_gateway::brand::SLUG;
    let value = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let dir = value("--dir").map(std::path::PathBuf::from).unwrap_or_else(app_gateway::names::keeper_state_dir);
    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("{slug}-gateway keeper: runtime: {error}");
            return 1;
        }
    };
    let result = runtime.block_on(async {
        let listener = match keeper::activation_listener()? {
            Some(listener) => listener,
            None => {
                let path = value("--socket").ok_or("no socket from systemd and no --socket PATH")?;
                tokio::net::UnixListener::bind(&path).map_err(|e| format!("bind {path}: {e}"))?
            }
        };
        let keeper = std::sync::Arc::new(Keeper::new(dir, Box::new(SystemPeers)));
        eprintln!("{slug}-gateway keeper: {} key(s) on offer in {}", keeper.offered().len(), keeper.dir().display());
        keeper::serve(keeper, listener).await
    });
    match result {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("{slug}-gateway keeper: {error}");
            1
        }
    }
}
