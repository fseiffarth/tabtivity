//! The in-fence half of the local lane, as the real binary: `<binary> --local-relay
//! PORT=SOCKET -- CMD` listens, forks its server and execs the command in its own
//! process. Run against a lane served here and a stub Ollama, with no namespace.

#![cfg(all(unix, feature = "desktop"))]

use app_lib::services::local_lane::server::{Connect, Judge, LaneServer, Limits, Target};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

const TAGS: &str = r#"{"models":[{"name":"llama3:latest"},{"name":"x:cloud","remote_host":"https://ollama.com"}]}"#;

fn stub() -> std::net::SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        for mut conn in listener.incoming().flatten() {
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                let _ = conn.read(&mut buf);
                let _ = conn.write_all(
                    format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{TAGS}", TAGS.len()).as_bytes(),
                );
            });
        }
    });
    addr
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

#[test]
fn the_relay_binary_pumps_to_the_lane_and_execs_the_command_in_its_own_process() {
    let Some(bash) = ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash"].into_iter().find(|p| std::path::Path::new(p).exists()) else {
        eprintln!("no bash: skipped");
        return;
    };
    let upstream = stub();
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("lane").join("o.sock");
    let judge: Judge = Arc::new(|_| Ok(()));
    let connect: Connect = Arc::new(move || TcpStream::connect(upstream).map_err(|e| e.to_string()));
    let server = LaneServer::start(&sock, Target::Ollama { judge, connect, host: upstream.to_string() }, Limits::default()).unwrap();
    let port = free_port();
    // The command asks for the model list through the relay's port, prints the
    // answer and its own pid, and exits 7.
    let script = format!(
        "exec 3<>/dev/tcp/127.0.0.1/{port}; printf 'GET /api/tags HTTP/1.1\\r\\nHost: x\\r\\n\\r\\n' >&3; cat <&3; echo; echo PID=$$; exit 7"
    );
    let child = Command::new(env!("CARGO_BIN_EXE_tabtivity"))
        .args(["--local-relay", &format!("{port}={}", sock.display()), "--", bash, "-c", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let pid = child.id();
    let out = child.wait_with_output().unwrap();
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    // The command's exit code is the process's, and it ran as the process we started.
    assert_eq!(out.status.code(), Some(7), "{text} {}", String::from_utf8_lossy(&out.stderr));
    assert!(text.contains(&format!("PID={pid}")), "the command is not the relay's own process: {text}");
    // The lane filtered the list on its way back.
    assert!(text.contains("llama3:latest") && !text.contains("x:cloud"), "{text}");
    // The server process went with the command: nothing listens on the port any more.
    let started = Instant::now();
    while TcpStream::connect(("127.0.0.1", port)).is_ok() {
        assert!(started.elapsed() < Duration::from_secs(10), "the relay's server outlived its command");
        std::thread::sleep(Duration::from_millis(100));
    }
    server.stop();
    assert!(!sock.exists());
}

#[test]
fn a_relay_that_cannot_listen_or_start_its_command_fails_closed() {
    let held = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = held.local_addr().unwrap().port();
    let run = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_tabtivity")).args(args).stdin(Stdio::null()).output().unwrap()
    };
    // The port is taken: the command never starts.
    let out = run(&["--local-relay", &format!("{port}=/tmp/none.sock"), "--", "/bin/sh", "-c", "echo STARTED"]);
    assert_eq!(out.status.code(), Some(111));
    assert!(!String::from_utf8_lossy(&out.stdout).contains("STARTED"));
    // No command, no port: usage errors.
    assert_eq!(run(&["--local-relay", "--", "/bin/sh"]).status.code(), Some(2));
    assert_eq!(run(&["--local-relay", "1=/tmp/none.sock"]).status.code(), Some(2));
    // A command that does not exist.
    let free = free_port();
    let out = run(&["--local-relay", &format!("{free}=/tmp/none.sock"), "--", "/nonexistent/cli"]);
    assert_eq!(out.status.code(), Some(127));
}
