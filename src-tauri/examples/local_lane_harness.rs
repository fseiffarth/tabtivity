//! A probe, not part of the product: serve the host half of the local lane
//! (`services::local_lane::server`) on one Unix socket against a real or stub
//! Ollama, and log every request and refusal. With `<binary> --local-relay
//! PORT=SOCKET -- <cli>` on the other end this is the whole lane without a
//! namespace, which is how the per-driver table in
//! `docs/context/local_models_only.md` was measured.
//!
//! ```text
//! cargo run -p tabtivity --example local_lane_harness -- \
//!     --sock /tmp/lane/o.sock --upstream 127.0.0.1:11434 [--stop-file /tmp/lane/stop] [--seconds 600]
//! ```
//! It exits when the stop file appears or the time is up, removing the socket.

#[cfg(unix)]
fn main() {
    use app_lib::services::local_lane::server::{Event, LaneServer, Limits, Target};
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    let args: Vec<String> = std::env::args().skip(1).collect();
    let arg = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let (Some(sock), Some(upstream)) = (arg("--sock"), arg("--upstream")) else {
        eprintln!("usage: local_lane_harness --sock PATH --upstream HOST:PORT [--stop-file PATH] [--seconds N]");
        std::process::exit(2);
    };
    let stop_file = arg("--stop-file");
    let seconds: u64 = arg("--seconds").and_then(|s| s.parse().ok()).unwrap_or(600);

    // The local models of the upstream: its /api/tags, minus the entries that name a remote.
    let tags_of = {
        let upstream = upstream.clone();
        move || -> Option<Vec<(String, bool)>> {
            let mut s = TcpStream::connect(&upstream).ok()?;
            s.set_read_timeout(Some(Duration::from_secs(10))).ok()?;
            s.write_all(format!("GET /api/tags HTTP/1.0\r\nHost: {upstream}\r\n\r\n").as_bytes()).ok()?;
            let mut raw = String::new();
            s.read_to_string(&mut raw).ok()?;
            let v: serde_json::Value = serde_json::from_str(raw.split("\r\n\r\n").nth(1)?).ok()?;
            Some(
                v["models"]
                    .as_array()?
                    .iter()
                    .filter_map(|m| {
                        let name = m["name"].as_str()?.to_string();
                        let remote = m["remote_host"].as_str().is_some_and(|h| !h.is_empty())
                            || m["remote_model"].as_str().is_some_and(|h| !h.is_empty())
                            || name.ends_with("cloud");
                        Some((name, remote))
                    })
                    .collect(),
            )
        }
    };
    let judge: app_lib::services::local_lane::server::Judge = Arc::new(move |model| {
        let tags = tags_of().ok_or("not_running")?;
        let latest = format!("{model}:latest");
        match tags.iter().find(|(n, _)| n == model || (!model.contains(':') && *n == latest)) {
            Some((_, false)) => Ok(()),
            Some((_, true)) => Err("model_not_local"),
            None => Err("model_not_installed"),
        }
    });
    let connect_to = upstream.clone();
    let connect: app_lib::services::local_lane::server::Connect =
        Arc::new(move || TcpStream::connect(&connect_to).map_err(|e| e.to_string()));
    let log = Arc::new(Mutex::new(()));
    let started = Instant::now();
    let observer: app_lib::services::local_lane::server::Observer = Arc::new(move |event| {
        let _guard = log.lock();
        let t = started.elapsed().as_secs_f32();
        match event {
            Event::Request { method, target } => eprintln!("[lane {t:7.1}s] {method} {target}"),
            Event::Model { name, verdict } => eprintln!("[lane {t:7.1}s]   model {name}: {verdict}"),
            Event::Refused { status, message } => eprintln!("[lane {t:7.1}s]   REFUSED {status}: {message}"),
            Event::Answered { status } => eprintln!("[lane {t:7.1}s]   answered {status}"),
        }
    });
    let limits = Limits { observer: Some(observer), ..Limits::default() };
    let server = LaneServer::start(
        std::path::Path::new(&sock),
        Target::Ollama { judge, connect, host: upstream.clone() },
        limits,
    )
    .expect("lane socket");
    eprintln!("[lane] serving {sock} -> {upstream}");
    let end = Instant::now() + Duration::from_secs(seconds);
    while Instant::now() < end && !stop_file.as_deref().is_some_and(|p| std::path::Path::new(p).exists()) {
        std::thread::sleep(Duration::from_millis(200));
    }
    server.stop();
}

#[cfg(not(unix))]
fn main() {}
