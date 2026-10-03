//! The server gateway (hosted plan §3.1): `<slug>-gateway serve`, started by
//! `<slug>-gateway.service` as `<slug>-gw`. Linux only.

fn main() {
    #[cfg(unix)]
    {
        let args: Vec<String> = std::env::args().skip(1).collect();
        let slug = app_gateway::brand::SLUG;
        match args.first().map(String::as_str) {
            Some("serve") | None => {}
            Some("--help") | Some("-h") => {
                println!("{slug}-gateway serve\n\nRoutes each signed-in device to its own account's daemon. Configured by the unit's environment (see /etc/{slug}/server.env).");
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
