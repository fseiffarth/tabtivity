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
            Some("hub") => std::process::exit(hub(&args[1..])),
            Some("hub-forget") => std::process::exit(hub_forget(&args[1..])),
            Some("calendar") => std::process::exit(calendar(&args[1..])),
            Some("--help") | Some("-h") => {
                println!("{slug}-gateway serve\n{slug}-gateway keeper [--socket PATH] [--dir PATH]\n{slug}-gateway hub [--socket PATH] [--root PATH] [--dir PATH]\n{slug}-gateway hub-forget USER\n{slug}-gateway calendar [--socket PATH] [--dir PATH]\n\nserve: routes each signed-in device to its own account's daemon. Configured by the unit's environment (see /etc/{slug}/server.env).\nkeeper: holds the administrator's agent API keys (as {slug}-auth, on the socket systemd passes).\nhub: owns the shared projects' bare repositories (as {slug}-hub, on the socket systemd passes).\nhub-forget: as root, takes a removed account off every shared project (the admin helper's user-remove).\ncalendar: holds the calendars and to-do lists users opened to each other (as {slug}-cal, on the socket systemd passes).");
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

/// `<slug>-gateway hub`: the share hub (hosted plan §6.2), started by
/// `<slug>-hub.service` as `<slug>-hub` on the socket its socket unit
/// passes; `--socket` binds one itself (a manual test), `--root`/`--dir`
/// name other places.
#[cfg(unix)]
fn hub(args: &[String]) -> i32 {
    use app_gateway::hub;
    let slug = app_gateway::brand::SLUG;
    let value = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let mut service = hub::default_hub();
    if let (Some(root), Some(dir)) = (value("--root"), value("--dir")) {
        service = hub::Hub::new(root.into(), dir.into(), Box::new(hub::SystemHubPeers));
    }
    let runtime = match tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("{slug}-gateway hub: runtime: {error}");
            return 1;
        }
    };
    let result = runtime.block_on(async {
        let listener = match app_gateway::keeper::activation_listener()? {
            Some(listener) => listener,
            None => {
                let path = value("--socket").ok_or("no socket from systemd and no --socket PATH")?;
                tokio::net::UnixListener::bind(&path).map_err(|e| format!("bind {path}: {e}"))?
            }
        };
        eprintln!("{slug}-gateway hub: serving {}", service.root().display());
        hub::serve(std::sync::Arc::new(service), listener).await
    });
    match result {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("{slug}-gateway hub: {error}");
            1
        }
    }
}

/// `<slug>-gateway hub-forget USER`: as root, ask the hub to take USER off
/// every share (their named ACL entries go with it).
#[cfg(unix)]
fn hub_forget(args: &[String]) -> i32 {
    use app_gateway::hub_wire::Request;
    let slug = app_gateway::brand::SLUG;
    let Some(user) = args.first().filter(|u| app_gateway::wire::valid_account_name(u)) else {
        eprintln!("{slug}-gateway hub-forget: an account name is needed");
        return 2;
    };
    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("{slug}-gateway hub-forget: runtime: {error}");
            return 1;
        }
    };
    match runtime.block_on(app_gateway::hub::ask(&app_gateway::names::hub_socket(), &Request::Forget { user: user.clone() }, b"")) {
        Ok(reply) if reply.ok => 0,
        Ok(reply) => {
            eprintln!("{slug}-gateway hub-forget: {}", reply.error.unwrap_or_default());
            1
        }
        Err(error) => {
            eprintln!("{slug}-gateway hub-forget: {error}");
            1
        }
    }
}

/// `<slug>-gateway calendar`: the shared-calendar service (hosted plan
/// §6.7), started by `<slug>-calendar.service` as `<slug>-cal`.
#[cfg(unix)]
fn calendar(args: &[String]) -> i32 {
    use app_gateway::calendars;
    let slug = app_gateway::brand::SLUG;
    let value = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let mut service = calendars::default_service();
    if let Some(dir) = value("--dir") {
        service = calendars::Calendars::new(dir.into(), Box::new(app_gateway::hub::SystemHubPeers));
    }
    let runtime = match tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("{slug}-gateway calendar: runtime: {error}");
            return 1;
        }
    };
    let result = runtime.block_on(async {
        let listener = match app_gateway::keeper::activation_listener()? {
            Some(listener) => listener,
            None => {
                let path = value("--socket").ok_or("no socket from systemd and no --socket PATH")?;
                tokio::net::UnixListener::bind(&path).map_err(|e| format!("bind {path}: {e}"))?
            }
        };
        eprintln!("{slug}-gateway calendar: serving {}", service.dir().display());
        calendars::serve(std::sync::Arc::new(service), listener).await
    });
    match result {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("{slug}-gateway calendar: {error}");
            1
        }
    }
}
