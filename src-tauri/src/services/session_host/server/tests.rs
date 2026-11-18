//! The host over `tokio::io::duplex` with a fake PTY (plan §4, Tests: the
//! Linux CI list).

use std::time::Duration;

use super::super::client::{Client, ClientError, StreamEvent};
use super::super::fake_pty::{
    abs_argv, connect_pair, connect_pair_sized, eventually, host_with, spawn_req, test_config, test_host, TOKEN,
};
use super::super::protocol::{self, ErrorCode, Reply, Request, SizePolicy, KIND_CONTROL, PROTO};
use super::super::screen::{CaptureOpts, Screen};
use super::*;

const PLAIN: CaptureOpts = CaptureOpts { join_wrapped: true, escapes: false };

fn with(mut req: Request, f: impl FnOnce(&mut Request)) -> Request {
    f(&mut req);
    req
}

fn sized(req: Request, cols: u16, rows: u16) -> Request {
    with(req, |s| {
        if let Request::Spawn { cols: c, rows: r, .. } = s {
            (*c, *r) = (cols, rows);
        }
    })
}

async fn client(host: &Host) -> Client<tokio::io::DuplexStream> {
    Client::handshake(connect_pair(host), TOKEN, "test").await.unwrap()
}

async fn raw_hello(io: &mut tokio::io::DuplexStream, token: &str, min: u32, max: u32) {
    let hello = Request::Hello { token: token.into(), proto_min: min, proto_max: max, client_version: "t".into() };
    protocol::write_control(io, &hello).await.unwrap();
}

async fn raw_reply(io: &mut tokio::io::DuplexStream) -> Option<Reply> {
    let frame = protocol::read_frame(io).await.unwrap()?;
    assert_eq!(frame.kind, KIND_CONTROL);
    Some(serde_json::from_slice(&frame.payload).unwrap())
}

fn host_code(r: Result<impl std::fmt::Debug, ClientError>) -> ErrorCode {
    match r {
        Err(ClientError::Host { code, .. }) => code,
        other => panic!("expected a host error, got {other:?}"),
    }
}

async fn capture_until(c: &mut Client<tokio::io::DuplexStream>, name: &str, needle: &str) -> String {
    for _ in 0..1000 {
        let text = c.capture(name, true, false, 0).await.unwrap();
        if text.contains(needle) {
            return text;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("{needle:?} never appeared");
}

#[tokio::test]
async fn a_bad_token_closes_without_an_answer() {
    let (host, _fake, _clock) = test_host();
    let mut io = connect_pair(&host);
    raw_hello(&mut io, "not-the-token", 1, PROTO).await;
    assert_eq!(protocol::read_frame(&mut io).await.unwrap(), None);

    // A first frame that is not Hello closes too.
    let mut io = connect_pair(&host);
    protocol::write_control(&mut io, &Request::List).await.unwrap();
    assert_eq!(protocol::read_frame(&mut io).await.unwrap(), None);

    // So does silence past the hello timeout.
    let mut cfg = test_config();
    cfg.hello_timeout = Duration::from_millis(30);
    let (host, _fake, _clock) = host_with(cfg);
    let mut io = connect_pair(&host);
    assert_eq!(protocol::read_frame(&mut io).await.unwrap(), None);

    // An empty configured token refuses everyone, the empty token included.
    let (host, _fake, _clock) = host_with(HostConfig::new("", "v", 1));
    let mut io = connect_pair(&host);
    raw_hello(&mut io, "", 1, PROTO).await;
    assert_eq!(protocol::read_frame(&mut io).await.unwrap(), None);
}

#[tokio::test]
async fn hello_negotiates_the_protocol_level() {
    let (host, _fake, _clock) = test_host();
    let mut io = connect_pair(&host);
    raw_hello(&mut io, TOKEN, 1, PROTO + 5).await;
    match raw_reply(&mut io).await {
        Some(Reply::Welcome { proto, host_version, pid, caps }) => {
            assert_eq!((proto, host_version.as_str(), pid), (PROTO, "test-host", 7));
            assert!(caps.iter().any(|c| c == "repaint"));
        }
        other => panic!("{other:?}"),
    }

    let mut io = connect_pair(&host);
    raw_hello(&mut io, TOKEN, PROTO + 1, PROTO + 3).await;
    assert!(matches!(raw_reply(&mut io).await, Some(Reply::Error { code: ErrorCode::Version, .. })));
    assert_eq!(raw_reply(&mut io).await, None, "closed after the refusal");
}

#[tokio::test]
async fn unknown_and_malformed_requests_are_answered_and_the_connection_lives() {
    let (host, _fake, _clock) = test_host();
    let mut io = connect_pair(&host);
    raw_hello(&mut io, TOKEN, 1, PROTO).await;
    assert!(matches!(raw_reply(&mut io).await, Some(Reply::Welcome { .. })));
    protocol::write_frame(&mut io, KIND_CONTROL, br#"{"op":"teleport","to":"mars"}"#).await.unwrap();
    assert!(matches!(raw_reply(&mut io).await, Some(Reply::Error { code: ErrorCode::Unsupported, .. })));
    protocol::write_frame(&mut io, KIND_CONTROL, b"{not json").await.unwrap();
    assert!(matches!(raw_reply(&mut io).await, Some(Reply::Error { code: ErrorCode::BadRequest, .. })));
    // A frame of a kind this build does not know is skipped.
    protocol::write_frame(&mut io, 9, b"future").await.unwrap();
    protocol::write_control(&mut io, &Request::List).await.unwrap();
    assert_eq!(raw_reply(&mut io).await, Some(Reply::Sessions { sessions: vec![] }));
}

#[tokio::test]
async fn spawn_is_create_or_attach_by_exact_name() {
    let (host, fake, _clock) = test_host();
    let mut c = client(&host).await;
    assert!(c.spawn(spawn_req("agent-1", false)).await.unwrap());
    assert!(c.spawn(spawn_req("agent", false)).await.unwrap(), "a prefix is a different session");
    assert_eq!(fake.count(), 2);
    let child = fake.last();
    assert_eq!(child.spec.argv, abs_argv());
    assert_eq!(child.spec.env, vec![("PATH".to_string(), "only-this".to_string())], "env is exactly what was sent");

    let other = with(spawn_req("agent", false), |s| {
        if let Request::Spawn { argv, env, .. } = s {
            *argv = vec![abs_argv()[0].clone(), "--other".into()];
            env.clear();
        }
    });
    assert!(!c.spawn(other).await.unwrap(), "an existing session ignores the new command");
    assert_eq!(fake.count(), 2);
    let only = with(spawn_req("agent", false), |s| {
        if let Request::Spawn { create_only, .. } = s {
            *create_only = true;
        }
    });
    assert_eq!(host_code(c.spawn(only).await), ErrorCode::Exists);

    let relative = with(spawn_req("rel", false), |s| {
        if let Request::Spawn { argv, .. } = s {
            *argv = vec!["claude".into()];
        }
    });
    assert_eq!(host_code(c.spawn(relative).await), ErrorCode::BadRequest, "no PATH search");
    let bad = spawn_req("a:b", false);
    assert_eq!(host_code(c.spawn(bad).await), ErrorCode::BadName);
    assert_eq!(fake.count(), 2);
    let names: Vec<String> = c.list().await.unwrap().into_iter().map(|s| s.name).collect();
    assert_eq!(names, vec!["agent".to_string(), "agent-1".to_string()]);
}

#[tokio::test]
async fn attach_streams_the_snapshot_then_live_output_with_no_gap() {
    let (host, fake, _clock) = test_host();
    let mut c = client(&host).await;
    c.spawn(sized(spawn_req("s", false), 20, 5)).await.unwrap();
    let child = fake.last();
    const N: usize = 2000;
    let emitter = std::thread::spawn(move || {
        for i in 0..N {
            child.emit(format!("{i}\r\n").as_bytes());
            if i % 50 == 0 {
                std::thread::sleep(Duration::from_millis(1));
            }
        }
    });
    // Attach while the output is still flowing.
    for _ in 0..1000 {
        if c.info("s").await.unwrap().output_bytes > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    let mut attached = client(&host).await.attach("s", 20, 5, 10_000).await.unwrap();
    let mut term = Screen::new(20, 5, 100_000);
    let last = format!("{}", N - 1);
    while !term.capture(PLAIN).lines().any(|l| l == last) {
        match tokio::time::timeout(Duration::from_secs(5), attached.next()).await.unwrap().unwrap() {
            Some(StreamEvent::Output(bytes)) => term.process(&bytes),
            other => panic!("unexpected {other:?}"),
        }
    }
    emitter.join().unwrap();
    let all = format!("{}{}", term.history(usize::MAX, PLAIN), term.capture(PLAIN));
    let numbers: Vec<usize> = all.lines().filter_map(|l| l.trim().parse().ok()).collect();
    assert_eq!(numbers, (0..N).collect::<Vec<_>>(), "every line once, in order");
}

#[tokio::test]
async fn a_dead_session_keeps_its_screen_and_refuses_input() {
    let (host, fake, _clock) = test_host();
    let mut c = client(&host).await;
    c.spawn(spawn_req("keep", true)).await.unwrap();
    let child = fake.last();
    let mut attached = client(&host).await.attach("keep", 80, 24, 0).await.unwrap();
    assert!(matches!(attached.next().await.unwrap(), Some(StreamEvent::Output(_))));
    child.emit(b"last words");
    assert_eq!(attached.next().await.unwrap(), Some(StreamEvent::Output(b"last words".to_vec())));
    child.exit(3);
    assert_eq!(attached.next().await.unwrap(), Some(StreamEvent::Exit { code: Some(3) }));
    assert_eq!(attached.next().await.unwrap(), Some(StreamEvent::Dead));

    let info = c.info("keep").await.unwrap();
    assert!(info.dead);
    assert_eq!(info.exit_code, Some(3));
    assert_eq!(host_code(c.input("keep", b"x").await), ErrorCode::Dead);
    assert_eq!(host_code(c.paste("keep", "x", true).await), ErrorCode::Dead);
    // Input on the stream is dropped too. The stream handles its frames in
    // order, so once the resize behind the input lands, the input was handled.
    attached.input(b"ignored").await.unwrap();
    attached.resize(81, 24).await.unwrap();
    eventually(|| child.sizes().contains(&(81, 24))).await;
    assert!(c.capture("keep", true, false, 0).await.unwrap().starts_with("last words"));
    assert!(child.input().is_empty());
    assert!(c.list().await.unwrap()[0].dead);

    // A later attach sees the screen, then Dead.
    let mut late = client(&host).await.attach("keep", 80, 24, 0).await.unwrap();
    let Some(StreamEvent::Output(bytes)) = late.next().await.unwrap() else { panic!() };
    let mut term = Screen::new(80, 24, 0);
    term.process(&bytes);
    assert!(term.capture(PLAIN).starts_with("last words"));
    assert_eq!(late.next().await.unwrap(), Some(StreamEvent::Dead));
    // Killing it is how it goes.
    c.kill("keep").await.unwrap();
    assert!(c.list().await.unwrap().is_empty());
}

#[tokio::test]
async fn an_ordinary_exit_ends_the_session_and_its_streams() {
    let (host, fake, _clock) = test_host();
    let mut c = client(&host).await;
    c.spawn(spawn_req("ends", false)).await.unwrap();
    let mut attached = client(&host).await.attach("ends", 80, 24, 0).await.unwrap();
    attached.next().await.unwrap();
    fake.last().exit(0);
    assert_eq!(attached.next().await.unwrap(), Some(StreamEvent::Exit { code: Some(0) }));
    assert_eq!(attached.next().await.unwrap(), None);
    assert!(c.list().await.unwrap().is_empty());
    assert_eq!(host_code(c.info("ends").await), ErrorCode::NotFound);
}

#[tokio::test]
async fn tick_reaps_a_child_that_exits_without_closing_its_output() {
    let (host, fake, _clock) = test_host();
    let mut c = client(&host).await;
    c.spawn(spawn_req("quiet", true)).await.unwrap();
    // The exit code is set but the output stays open (ConPTY keeps its pipe).
    fake.last().exit_keeping_output(5);
    assert!(!c.info("quiet").await.unwrap().dead);
    assert!(!host.tick());
    let info = c.info("quiet").await.unwrap();
    assert!(info.dead);
    assert_eq!(info.exit_code, Some(5));
}

#[tokio::test]
async fn a_slow_client_loses_output_and_gets_a_repaint() {
    let mut cfg = test_config();
    cfg.client_queue_bytes = 256;
    let (host, fake, _clock) = host_with(cfg);
    let mut c = client(&host).await;
    c.spawn(sized(spawn_req("s", false), 20, 5)).await.unwrap();
    // A tiny pipe the test does not read: the client's writer blocks.
    let slow = Client::handshake(connect_pair_sized(&host, 64), TOKEN, "t").await.unwrap();
    let mut attached = slow.attach("s", 20, 5, 0).await.unwrap();
    let child = fake.last();
    for i in 0..100 {
        child.emit(format!("line-{i:03}\r\n").as_bytes());
    }
    let host_screen = capture_until(&mut c, "s", "line-099").await;

    let mut term = Screen::new(20, 5, 0);
    let mut repainted = false;
    while !term.capture(PLAIN).contains("line-099") {
        match tokio::time::timeout(Duration::from_secs(5), attached.next()).await.unwrap().unwrap() {
            Some(StreamEvent::Output(bytes)) => term.process(&bytes),
            Some(StreamEvent::Repaint { cols, rows }) => {
                assert_eq!((cols, rows), (20, 5));
                repainted = true;
            }
            other => panic!("unexpected {other:?}"),
        }
    }
    assert!(repainted, "the overflow was repaired by a repaint");
    assert_eq!(term.capture(PLAIN), host_screen);
    // Caught up: live output flows again, unrepainted.
    child.emit(b"after");
    let Some(StreamEvent::Output(bytes)) = attached.next().await.unwrap() else { panic!() };
    assert_eq!(bytes, b"after");
}

#[tokio::test]
async fn paste_is_bracketed_only_under_mode_2004() {
    let (host, fake, _clock) = test_host();
    let mut c = client(&host).await;
    c.spawn(spawn_req("p", false)).await.unwrap();
    let child = fake.last();
    c.paste("p", "one\ntwo", true).await.unwrap();
    eventually(|| child.input() == b"one\ntwo").await;
    child.emit(b"\x1b[?2004h");
    let mut on = false;
    for _ in 0..1000 {
        on = c.info("p").await.unwrap().bracketed_paste;
        if on {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(on, "mode 2004 never turned on");
    c.paste("p", "x", true).await.unwrap();
    c.paste("p", "y", false).await.unwrap();
    let want = b"one\ntwo\x1b[200~x\x1b[201~y";
    eventually(|| child.input().len() >= want.len()).await;
    assert_eq!(child.input(), want);
}

#[tokio::test]
async fn a_sequence_cut_by_a_read_never_starts_a_client_mid_way() {
    let (host, fake, _clock) = test_host();
    let mut c = client(&host).await;
    c.spawn(sized(spawn_req("cut", false), 20, 3)).await.unwrap();
    let child = fake.last();
    // The read ends inside a CSI and inside a UTF-8 code point.
    child.emit(b"ok \x1b[3");
    child.emit(b"1mred\x1b[m \xe2\x82");
    capture_until(&mut c, "cut", "ok red").await;
    // The attach falls between the two halves of the euro sign.
    let mut attached = client(&host).await.attach("cut", 20, 3, 0).await.unwrap();
    child.emit(b"\xac!");
    let mut term = Screen::new(20, 3, 0);
    while !term.capture(PLAIN).contains('!') {
        match tokio::time::timeout(Duration::from_secs(5), attached.next()).await.unwrap().unwrap() {
            Some(StreamEvent::Output(bytes)) => term.process(&bytes),
            other => panic!("unexpected {other:?}"),
        }
    }
    assert!(term.capture(PLAIN).starts_with("ok red €!"), "{:?}", term.capture(PLAIN));
    let coloured = term.capture(CaptureOpts { join_wrapped: true, escapes: true });
    assert!(coloured.contains("\x1b[31m"), "{coloured:?}");
}

#[tokio::test]
async fn a_slow_spawn_holds_no_lock_and_an_attach_waits_for_it() {
    let (host, fake, _clock) = test_host();
    let mut c = client(&host).await;
    c.spawn(spawn_req("fast", false)).await.unwrap();
    fake.hold_spawns();
    let mut slow = client(&host).await;
    let spawning = tokio::spawn(async move { slow.spawn(spawn_req("slow", false)).await });
    eventually(|| host.session_count() == 2).await;
    // The host still answers while the child is being created.
    let names: Vec<String> = c.list().await.unwrap().into_iter().map(|s| s.name).collect();
    assert_eq!(names, vec!["fast".to_string(), "slow".to_string()]);
    assert_eq!(host_code(c.input("slow", b"x").await), ErrorCode::Busy);
    assert!(!c.spawn(spawn_req("slow", false)).await.unwrap(), "create-or-attach sees it");
    c.input("fast", b"y").await.unwrap();
    let host2 = host.clone();
    let attach = tokio::spawn(async move { client(&host2).await.attach("slow", 80, 24, 0).await.map(|a| a.size()) });
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(!attach.is_finished(), "the attach waits for the start");
    fake.release_spawns();
    assert!(spawning.await.unwrap().unwrap());
    assert_eq!(attach.await.unwrap().unwrap(), (80, 24));
    assert_eq!(fake.count(), 2);
}

#[tokio::test]
async fn a_session_killed_while_starting_reaps_its_child() {
    let (host, fake, _clock) = test_host();
    let mut c = client(&host).await;
    fake.hold_spawns();
    let mut slow = client(&host).await;
    let spawning = tokio::spawn(async move { slow.spawn(spawn_req("gone", false)).await });
    eventually(|| host.session_count() == 1).await;
    c.kill("gone").await.unwrap();
    fake.release_spawns();
    assert_eq!(host_code(spawning.await.unwrap()), ErrorCode::NotFound);
    let child = fake.last();
    assert_eq!(child.exited(), Some(-1));
    assert!(child.reaped());
    assert!(c.list().await.unwrap().is_empty());
}

#[tokio::test]
async fn kill_works_while_a_write_is_stuck() {
    let (host, fake, _clock) = test_host();
    let mut c = client(&host).await;
    c.spawn(spawn_req("stuck", false)).await.unwrap();
    let child = fake.last();
    child.stop_reading();
    c.input("stuck", b"never read").await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), c.kill("stuck")).await.unwrap().unwrap();
    assert_eq!(child.exited(), Some(-1));
    assert!(child.reaped(), "the killed child was waited for");
    assert!(c.list().await.unwrap().is_empty());
}

#[tokio::test]
async fn spawn_refuses_smuggled_env_and_paths() {
    let (host, fake, _clock) = test_host();
    let mut c = client(&host).await;
    let bad_env = with(spawn_req("e", false), |s| {
        if let Request::Spawn { env, .. } = s {
            env.push(("A=B".into(), "v".into()));
        }
    });
    assert_eq!(host_code(c.spawn(bad_env).await), ErrorCode::BadRequest);
    let unc = with(spawn_req("u", false), |s| {
        if let Request::Spawn { argv, .. } = s {
            argv[0] = "\\\\server\\share\\agent.exe".into();
        }
    });
    assert_eq!(host_code(c.spawn(unc).await), ErrorCode::BadRequest);
    let nul = with(spawn_req("n", false), |s| {
        if let Request::Spawn { cwd, .. } = s {
            *cwd = Some("a\0b".into());
        }
    });
    assert_eq!(host_code(c.spawn(nul).await), ErrorCode::BadRequest);
    assert_eq!(fake.count(), 0);
    assert!(c.list().await.unwrap().is_empty());
}

#[tokio::test]
async fn a_capture_too_big_for_a_frame_drops_its_oldest_lines() {
    let mut cfg = test_config();
    cfg.history_rows = 5_000;
    let (host, fake, _clock) = host_with(cfg);
    let mut c = client(&host).await;
    c.spawn(sized(spawn_req("big", false), 200, 5)).await.unwrap();
    let child = fake.last();
    // Quotes double in JSON: 3000 × 200 × 2 bytes is past a frame.
    for i in 0..3_000 {
        child.emit(format!("{i:05}{}\r\n", "\"".repeat(190)).as_bytes());
    }
    capture_until(&mut c, "big", "02999").await;
    let text = c.capture("big", true, false, 5_000).await.unwrap();
    assert!(text.lines().last().unwrap().starts_with("02995"), "the newest rows are kept");
    assert!(!text.starts_with("00000"), "the oldest rows went");
    assert!(protocol::control_payload(&Reply::Captured { text }).len() <= protocol::MAX_FRAME);
}

#[tokio::test]
async fn a_connection_between_ticks_restarts_the_idle_period() {
    let (host, _fake, clock) = test_host();
    assert!(!host.tick());
    clock.advance(59_000);
    drop(client(&host).await);
    eventually(|| host.connection_count() == 0).await;
    clock.advance(2_000);
    assert!(!host.tick(), "the connection reset the quiet period");
    clock.advance(60_000);
    assert!(host.tick());
}

#[tokio::test]
async fn shutdown_refuses_later_spawns() {
    let (host, fake, _clock) = test_host();
    let mut c = client(&host).await;
    c.shutdown(true).await.unwrap();
    assert_eq!(host_code(c.spawn(spawn_req("late", false)).await), ErrorCode::Busy);
    assert_eq!(fake.count(), 0);
    assert!(host.tick());
}

#[tokio::test]
async fn a_dropped_serve_future_detaches_its_client() {
    let (host, fake, _clock) = test_host();
    let mut c = client(&host).await;
    c.spawn(spawn_req("s", false)).await.unwrap();
    let child = fake.last();
    let (client_end, server_end) = tokio::io::duplex(1 << 16);
    let serving = {
        let host = host.clone();
        tokio::spawn(async move { host.serve(server_end).await })
    };
    let attached = Client::handshake(client_end, TOKEN, "t").await.unwrap().attach("s", 100, 30, 0).await.unwrap();
    eventually(|| child.sizes() == vec![(100, 30)]).await;
    assert_eq!(c.info("s").await.unwrap().attached, 1);
    serving.abort();
    let _ = serving.await;
    assert_eq!(c.info("s").await.unwrap().attached, 0);
    drop(attached);
    eventually(|| host.connection_count() == 1).await;
}

#[tokio::test]
async fn capture_joins_wrapped_rows_and_reads_history() {
    let (host, fake, _clock) = test_host();
    let mut c = client(&host).await;
    c.spawn(sized(spawn_req("w", false), 5, 3)).await.unwrap();
    fake.last().emit(b"old\r\nabcdefgh\r\nxy");
    capture_until(&mut c, "w", "xy").await;
    assert_eq!(c.capture("w", true, false, 0).await.unwrap(), "abcdefgh\nxy\n");
    assert_eq!(c.capture("w", false, false, 0).await.unwrap(), "abcde\nfgh\nxy\n");
    assert_eq!(c.capture("w", true, false, 10).await.unwrap(), "old\n");
}

#[tokio::test]
async fn kill_rename_and_kill_prefix() {
    let (host, fake, _clock) = test_host();
    let mut c = client(&host).await;
    for name in ["app-a", "app-b", "other"] {
        c.spawn(spawn_req(name, false)).await.unwrap();
    }
    let other = fake.last();
    c.kill("missing").await.unwrap();
    assert_eq!(host_code(c.kill("bad name").await), ErrorCode::BadName);
    assert_eq!(host_code(c.rename("app-a", "other").await), ErrorCode::Exists);
    assert_eq!(host_code(c.rename("nope", "x").await), ErrorCode::NotFound);
    c.rename("other", "kept").await.unwrap();
    assert_eq!(c.kill_prefix("app-").await.unwrap(), 2);
    let names: Vec<String> = c.list().await.unwrap().into_iter().map(|s| s.name).collect();
    assert_eq!(names, vec!["kept".to_string()]);
    assert_eq!(other.exited(), None, "the renamed session still runs");
    other.emit(b"still here");
    capture_until(&mut c, "kept", "still here").await;
    c.kill("kept").await.unwrap();
    assert_eq!(other.exited(), Some(-1), "kill reached the PTY");
}

#[tokio::test]
async fn the_window_follows_the_latest_client() {
    let (host, fake, _clock) = test_host();
    let mut c = client(&host).await;
    c.spawn(spawn_req("s", false)).await.unwrap();
    let child = fake.last();
    let mut a = client(&host).await.attach("s", 80, 24, 0).await.unwrap();
    assert!(child.sizes().is_empty(), "the same size: no resize");
    let mut b = client(&host).await.attach("s", 100, 30, 0).await.unwrap();
    eventually(|| child.sizes() == vec![(100, 30)]).await;
    a.input(b"k").await.unwrap();
    eventually(|| child.sizes() == vec![(100, 30), (80, 24)]).await;
    assert_eq!(c.info("s").await.unwrap().attached, 2);
    b.resize(120, 40).await.unwrap();
    eventually(|| child.sizes().last() == Some(&(120, 40))).await;
    drop(b);
    eventually(|| child.sizes().last() == Some(&(80, 24))).await;
    a.next().await.unwrap();

    // Largest: the max of each dimension, typing changes nothing.
    let largest = with(spawn_req("big", false), |s| {
        if let Request::Spawn { size_policy, .. } = s {
            *size_policy = SizePolicy::Largest;
        }
    });
    c.spawn(largest).await.unwrap();
    let child = fake.last();
    let mut a = client(&host).await.attach("big", 100, 20, 0).await.unwrap();
    let _b = client(&host).await.attach("big", 90, 40, 0).await.unwrap();
    eventually(|| child.sizes().last() == Some(&(100, 40))).await;
    a.input(b"k").await.unwrap();
    eventually(|| child.input() == b"k").await;
    assert_eq!(child.sizes().last(), Some(&(100, 40)));
}

#[tokio::test]
async fn idle_exit_and_shutdown() {
    let (host, _fake, clock) = test_host();
    assert!(!host.tick());
    clock.advance(59_999);
    assert!(!host.tick());
    clock.advance(1);
    assert!(host.tick(), "a quiet minute with nothing open");

    let (host, _fake, clock) = test_host();
    let mut c = client(&host).await;
    assert!(!host.tick());
    clock.advance(120_000);
    assert!(!host.tick(), "an open connection keeps the host");
    c.spawn(spawn_req("s", false)).await.unwrap();
    assert_eq!(host_code(c.shutdown(true).await), ErrorCode::Busy);
    assert!(!host.tick());
    c.shutdown(false).await.unwrap();
    assert_eq!(host.session_count(), 0);
    assert!(host.tick(), "shutdown asked");

    let (host, _fake, _clock) = test_host();
    let mut c = client(&host).await;
    c.shutdown(true).await.unwrap();
    assert!(host.tick());
}

#[tokio::test]
async fn osc_cwd_reaches_the_listing() {
    let (host, fake, _clock) = test_host();
    let mut c = client(&host).await;
    c.spawn(spawn_req("cwd", false)).await.unwrap();
    assert_eq!(c.list().await.unwrap()[0].cwd, None);
    fake.last().emit(b"\x1b]7;file://h/work/tree\x07ready");
    capture_until(&mut c, "cwd", "ready").await;
    assert_eq!(c.list().await.unwrap()[0].cwd.as_deref(), Some("/work/tree"));
    let info = c.info("cwd").await.unwrap();
    assert_eq!(info.pid, Some(4242));
    assert!(info.output_bytes > 0);
}

/// An exit decided while a client was connecting is called off once the
/// accept loop has stopped and finds it counted; with nobody there it stands.
#[tokio::test]
async fn a_connection_counted_by_spawn_serve_calls_off_an_exit() {
    let (host, _fake, clock) = test_host();
    assert!(!host.tick());
    clock.advance(10_000_000);
    assert!(host.tick(), "idle past the limit");
    assert!(!host.resume_if_connected(), "nobody connected: the exit stands");
    let (client, server) = tokio::io::duplex(1 << 16);
    let task = host.spawn_serve(server);
    assert_eq!(host.connection_count(), 1, "counted before the task ran");
    assert!(host.resume_if_connected());
    let mut c = Client::handshake(client, TOKEN, "t").await.unwrap();
    assert!(c.spawn(spawn_req("after", false)).await.unwrap(), "spawns are accepted again");
    drop(c);
    task.await.unwrap();
}

fn stamped(name: &str, mark: Option<&str>) -> Request {
    with(spawn_req(name, false), |s| {
        if let Request::Spawn { mcp_mark, .. } = s {
            *mcp_mark = mark.map(str::to_string);
        }
    })
}

#[tokio::test]
async fn the_mcp_stamp_is_kept_from_the_creating_spawn_and_listed() {
    let (host, fake, _clock) = test_host();
    let mut c = client(&host).await;
    assert!(c.has_cap(protocol::CAP_MCP_MARK));
    assert!(c.spawn(stamped("agent", Some("n1:g1:4000"))).await.unwrap());
    assert!(!c.spawn(stamped("agent", Some("n2:g2:5000"))).await.unwrap(), "an attach");
    assert!(c.spawn(stamped("shell", None)).await.unwrap());
    assert_eq!(
        host_code(c.spawn(stamped("bad", Some("n:g:1\u{1b}[2J"))).await),
        ErrorCode::BadRequest,
        "a control byte never reaches a listing"
    );
    assert_eq!(fake.count(), 2);
    let rows = c.mcp_marks().await.unwrap().expect("this host keeps stamps");
    assert_eq!(
        rows,
        vec![("agent".to_string(), Some("n1:g1:4000".to_string())), ("shell".to_string(), None)],
        "the creating Spawn's stamp, every live session listed"
    );
    c.rename("agent", "agent-2").await.unwrap();
    let rows = c.mcp_marks().await.unwrap().unwrap();
    assert!(rows.contains(&("agent-2".to_string(), Some("n1:g1:4000".to_string()))), "a rename keeps it: {rows:?}");
    c.kill("agent-2").await.unwrap();
    assert_eq!(c.mcp_marks().await.unwrap().unwrap(), vec![("shell".to_string(), None)]);
}

/// A host of a build before [`protocol::CAP_MCP_MARK`]: it welcomes without
/// the cap and records every later frame it is sent.
async fn old_host(io: tokio::io::DuplexStream) -> Vec<Request> {
    let mut io = io;
    let Some(Request::Hello { .. }) = raw_reply_req(&mut io).await else { panic!("no hello") };
    let caps = ["snapshot", "repaint", "paste-bracketed", "osc-cwd", "kill-prefix"];
    let welcome = Reply::Welcome {
        proto: 1,
        host_version: "0.2.80".into(),
        pid: 1,
        caps: caps.iter().map(|c| c.to_string()).collect(),
    };
    protocol::write_control(&mut io, &welcome).await.unwrap();
    let mut seen = Vec::new();
    while let Some(req) = raw_reply_req(&mut io).await {
        // Its listing has no stamp column: a client reading it would see
        // "no stamp" for a session whose stamp it cannot know.
        let reply: serde_json::Value = serde_json::json!({"type": "sessions", "sessions": [
            {"name": "agent", "created": 1, "activity": 1, "attached": 0, "cwd": null, "argv": [], "dead": false}
        ]});
        protocol::write_frame(&mut io, KIND_CONTROL, reply.to_string().as_bytes()).await.unwrap();
        seen.push(req);
    }
    seen
}

async fn raw_reply_req(io: &mut tokio::io::DuplexStream) -> Option<Request> {
    let frame = protocol::read_frame(io).await.unwrap()?;
    Some(serde_json::from_slice(&frame.payload).unwrap())
}

#[tokio::test]
async fn an_older_host_reads_as_unknown_not_as_unstamped() {
    let (client_io, host_io) = tokio::io::duplex(1 << 16);
    let host = tokio::spawn(old_host(host_io));
    let mut c = Client::handshake(client_io, TOKEN, "t").await.unwrap();
    assert!(!c.has_cap(protocol::CAP_MCP_MARK));
    assert_eq!(c.mcp_marks().await.unwrap(), None, "unknown, not an error");
    // Its plain listing still works and carries no stamp.
    let listed = c.list().await.unwrap();
    assert_eq!((listed[0].name.as_str(), listed[0].mcp_mark.as_deref()), ("agent", None));
    drop(c);
    assert_eq!(host.await.unwrap(), vec![Request::List], "mcp_marks sent nothing to the old host");
}
