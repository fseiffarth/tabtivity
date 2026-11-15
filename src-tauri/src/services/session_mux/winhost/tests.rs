//! `WinHostMux` against a real in-process host (ConPTY children): every
//! trait method, the flag gate, no-server answers, the wrap's mark, and the
//! P0 checks on the pipe-backed tab stream and the phone's stream attach.

use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::*;
use crate::services::session_host::win::test_support::{cmd_exe, echo_program, test_host, wait_until_async};

fn opts(session: &str, cmd: &str, args: &[&str]) -> PtyOptions {
    serde_json::from_value(serde_json::json!({
        "id": "tab", "cmd": cmd, "args": args, "cwd": "", "cols": 100, "rows": 30,
        "tmux_session": session, "env": { "SECRET_TEST_KEY": "s3cret-value" },
    }))
    .unwrap()
}

async fn on_thread<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    tokio::task::spawn_blocking(f).await.unwrap()
}

async fn screen_until(mux: &Arc<WinHostMux>, name: &str, want: &str) -> String {
    let mut text = String::new();
    for _ in 0..500 {
        let (m, n) = (mux.clone(), name.to_string());
        text = on_thread(move || m.screen(&n)).await.unwrap_or_default();
        if text.contains(want) {
            return text;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("{want:?} never appeared: {text:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn every_call_works_against_a_real_host() {
    let th = test_host();
    let mux = Arc::new(WinHostMux::with_launch(th.launch.clone()));
    assert!(mux.available());
    let m = mux.clone();
    on_thread(move || m.spawn_detached(&opts("wh-one", &cmd_exe(), &["/q", "/k", "echo", "started"]))).await.unwrap();
    screen_until(&mux, "wh-one", "started").await;

    let m = mux.clone();
    let (listed, has, missing, pane) = on_thread(move || {
        (m.list().unwrap(), m.has("wh-one").unwrap(), m.has("wh-none").unwrap(), m.pane("wh-one").unwrap())
    })
    .await;
    let one = listed.iter().find(|s| s.name == "wh-one").expect("listed");
    assert!(one.cmd.eq_ignore_ascii_case("cmd"), "{one:?}");
    assert!(one.created > 1_600_000_000, "seconds, not ms: {}", one.created);
    assert!(has && !missing);
    assert!(!pane.dead && pane.pid.is_some());
    assert_eq!(pane.window, Some((100, 30)));

    // Keys and a paste are typed into the session.
    let m = mux.clone();
    on_thread(move || m.send_keys("wh-one", &[Key::Literal("echo keyed-71".into()), Key::from_name("Enter")])).await.unwrap();
    screen_until(&mux, "wh-one", "keyed-71\n").await;
    let m = mux.clone();
    on_thread(move || m.paste("wh-one", "echo pasted-72\r", true)).await.unwrap();
    screen_until(&mux, "wh-one", "pasted-72").await;
    let m = mux.clone();
    assert!(on_thread(move || m.send_keys("wh-one", &[Key::from_name("Hyper")])).await.is_err());

    // History above the screen, CRLF line ends.
    let m = mux.clone();
    on_thread(move || {
        for i in 0..40 {
            m.send_keys("wh-one", &[Key::Literal(format!("echo line-{i}")), Key::from_name("Enter")]).unwrap();
        }
    })
    .await;
    screen_until(&mux, "wh-one", "line-39\n").await;
    let m = mux.clone();
    let history = on_thread(move || m.scrollback("wh-one", 200).unwrap()).await;
    let text = String::from_utf8_lossy(&history);
    assert!(text.contains("line-0") && text.ends_with("\r\n"), "{text:?}");
    assert!(!text.replace("\r\n", "").contains('\n'), "every line end is CRLF");

    // Rename, then kill (twice: already gone is Ok), then the quit reap.
    let m = mux.clone();
    on_thread(move || m.rename("wh-one", "wh-two")).await.unwrap();
    let m = mux.clone();
    assert!(!on_thread(move || m.has("wh-one").unwrap()).await);
    let m = mux.clone();
    on_thread(move || {
        m.kill("wh-two").unwrap();
        m.kill("wh-two").unwrap();
    })
    .await;
    let app = format!("{}reaped", crate::services::tmux_local::LOCAL_TMUX_PREFIX);
    let m = mux.clone();
    let app2 = app.clone();
    on_thread(move || {
        m.spawn_detached(&opts(&app2, &cmd_exe(), &["/q", "/k"])).unwrap();
        m.spawn_detached(&opts("foreign", &cmd_exe(), &["/q", "/k"])).unwrap();
        m.kill_app_sessions().unwrap();
    })
    .await;
    let m = mux.clone();
    let names: Vec<String> = on_thread(move || m.list().unwrap()).await.into_iter().map(|s| s.name).collect();
    assert_eq!(names, ["foreign"], "the app's sessions only");
    assert_eq!(mux.env_text("foreign"), None);
}

#[tokio::test(flavor = "multi_thread")]
async fn with_no_host_queries_answer_none_and_start_nothing() {
    let tmp = tempfile::tempdir().unwrap();
    let state = tmp.path().join("state");
    let launch = Launch {
        control_dir: crate::services::mobile_control::config::control_dir_for(&state),
        state_dir: state,
        source: std::env::current_exe().unwrap(),
        version: env!("CARGO_PKG_VERSION").into(),
    };
    let mux = WinHostMux::with_launch(launch.clone());
    on_thread(move || {
        assert_eq!(mux.list(), Ok(Vec::new()));
        assert_eq!(mux.has("s"), Ok(false));
        assert_eq!(mux.kill("s"), Ok(()));
        assert_eq!(mux.kill_app_sessions(), Ok(()));
        assert_eq!(mux.pane("s"), Err(MuxError::NoServer));
        assert!(matches!(mux.screen("bad name"), Err(MuxError::Refused(_))));
    })
    .await;
    assert!(!copies::copy_path(&launch.control_dir, &launch.identity()).exists(), "a query stages no copy");
}

#[test]
fn the_setting_gates_everything() {
    let tmp = tempfile::tempdir().unwrap();
    let settings = tmp.path().join("settings.json");
    let launch = Launch {
        state_dir: tmp.path().into(),
        control_dir: tmp.path().join("control"),
        source: std::env::current_exe().unwrap(),
        version: "1.0.0".into(),
    };
    let mux = WinHostMux { launch: Ok(launch), gate: Gate::Settings(settings.clone()) };
    assert!(!mux.available(), "no settings file is off");
    std::fs::write(&settings, r#"{"windows_session_host": false}"#).unwrap();
    assert!(!mux.available());
    // Off, nothing new is made, but a running host's sessions are still
    // listed (none here: no host runs, and none is started).
    assert_eq!(mux.list(), Ok(Vec::new()));
    assert!(!copies::copy_path(&tmp.path().join("control"), "1.0.0").exists(), "a listing stages nothing");
    assert!(matches!(mux.attach_client("s", true), Err(MuxError::Unavailable(_))));
    let mut o = opts("s", &cmd_exe(), &[]);
    mux.wrap(&mut o);
    assert!(!o.mux_wrapped && o.cmd == cmd_exe(), "off: no wrap");
    std::fs::write(&settings, r#"{"windows_session_host": true}"#).unwrap();
    assert!(mux.available());
    std::fs::write(&settings, "not json").unwrap();
    assert!(!mux.available());
}

#[test]
fn wrap_marks_the_launch_and_keeps_its_argv() {
    let tmp = tempfile::tempdir().unwrap();
    let launch = Launch {
        state_dir: tmp.path().join("state"),
        control_dir: tmp.path().join("control"),
        source: std::env::current_exe().unwrap(),
        version: env!("CARGO_PKG_VERSION").into(),
    };
    let mux = WinHostMux::with_launch(launch.clone());
    let mut o = opts("wrapped", "cmd.exe", &["/k", "echo", "hi"]);
    mux.wrap(&mut o);
    assert!(o.mux_wrapped);
    assert_eq!((o.cmd.as_str(), o.args.clone()), ("cmd.exe", vec!["/k".to_string(), "echo".into(), "hi".into()]));
    assert!(!copies::copy_path(&launch.control_dir, &launch.identity()).exists(), "a wrap stages nothing");
    // What the spawn sends: an absolute program, the tab's env with PATH.
    let spawn = host_spawn_for(&o, "wrapped").unwrap();
    assert!(std::path::Path::new(&spawn.argv[0]).is_absolute(), "{:?}", spawn.argv);
    assert_eq!(spawn.argv[1..], ["/k".to_string(), "echo".into(), "hi".into()]);
    assert!(spawn.env.iter().any(|(k, v)| k == "SECRET_TEST_KEY" && v == "s3cret-value"));
    assert!(spawn.env.iter().any(|(k, _)| k.eq_ignore_ascii_case("PATH")));
    assert!(spawn.remain_on_exit, "an agent tab keeps its pane");
    let mut chat = o.clone();
    chat.assistant = Some(serde_json::from_value(serde_json::json!({ "cli": "claude" })).unwrap());
    assert!(!host_spawn_for(&chat, "wrapped").unwrap().remain_on_exit, "an assistant chat ends");

    // A batch file stays in-process.
    let bat = tmp.path().join("tool.bat");
    std::fs::write(&bat, "@echo off\r\n").unwrap();
    let mut o = opts("batch", &bat.to_string_lossy(), &["50%"]);
    mux.wrap(&mut o);
    assert!(!o.mux_wrapped);
    // No session name: nothing to wrap.
    let mut o = opts("x", "cmd.exe", &[]);
    o.tmux_session = None;
    mux.wrap(&mut o);
    assert!(!o.mux_wrapped);
}

/// Reads a stream's output on a thread of its own into a shared buffer.
fn drain(mut reader: Box<dyn Read + Send>) -> (Arc<Mutex<Vec<u8>>>, std::thread::JoinHandle<()>) {
    let buf = Arc::new(Mutex::new(Vec::new()));
    let sink = buf.clone();
    let thread = std::thread::spawn(move || {
        let mut chunk = [0u8; 4096];
        while let Ok(n) = reader.read(&mut chunk) {
            if n == 0 {
                break;
            }
            sink.lock().unwrap().extend_from_slice(&chunk[..n]);
        }
    });
    (buf, thread)
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

fn read_log(log: &std::path::Path) -> Vec<u8> {
    std::fs::read(log).unwrap_or_default()
}

/// The P0 checks, on the pipe-backed tab stream a desktop tab gets: the
/// tab's own launch goes in a `Spawn` (create-or-attach), Ctrl+C reaches the
/// program as 0x03 and the stream lives on, a resize reaches the session, a
/// bracketed paste arrives byte for byte, a second open reattaches without
/// starting anything, and killing the session ends the stream.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn p0_a_tab_stream_carries_ctrl_c_resize_and_paste_and_ends_with_its_session() {
    let th = test_host();
    let mux = Arc::new(WinHostMux::with_launch(th.launch.clone()));
    let log = th.launch.state_dir.parent().unwrap().join("echo.log");
    let (argv, env) = echo_program(&log);
    let mut tab = opts("p0", &argv[0], &argv[1..].iter().map(String::as_str).collect::<Vec<_>>());
    tab.env = env.into_iter().filter(|(k, _)| k.starts_with("SESSION_HOST_TEST")).collect();
    mux.wrap(&mut tab);
    assert!(tab.mux_wrapped);
    let m = mux.clone();
    let opened = tab.clone();
    let pty = on_thread(move || m.open_tab(&opened, false)).await.expect("the host serves the tab");
    let HostPty { master, reader, writer, mut child, handle, created } = pty;
    assert!(created, "the Spawn made the session");
    let typer = Arc::new(Mutex::new(writer));
    // The input writer blocks when full: typed from a plain thread.
    let type_bytes = |bytes: &'static [u8]| {
        let typer = typer.clone();
        on_thread(move || typer.lock().unwrap().write_all(bytes))
    };
    let (screen, thread) = drain(reader);
    assert!(
        wait_until_async(Duration::from_secs(20), || contains(&screen.lock().unwrap(), b"ECHO-READY")).await,
        "the stand-in never drew: {:?}",
        String::from_utf8_lossy(&screen.lock().unwrap())
    );
    assert_eq!(child.process_id(), None, "no local process: a teardown reaps nothing here");

    // Ctrl+C is data for the session, and the stream lives on.
    type_bytes(b"\x03").await.unwrap();
    assert!(
        wait_until_async(Duration::from_secs(10), || read_log(&log).contains(&0x03)).await,
        "0x03 never reached the program: {:?}",
        read_log(&log)
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(child.try_wait().unwrap().is_none(), "Ctrl+C must not end the stream");

    // The tab's resize reaches the session.
    master.resize(portable_pty::PtySize { rows: 41, cols: 123, pixel_width: 0, pixel_height: 0 }).unwrap();
    let mut window = None;
    for _ in 0..250 {
        let m = mux.clone();
        window = on_thread(move || m.pane("p0")).await.unwrap().window;
        if window == Some((123, 41)) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(window, Some((123, 41)), "the session follows the tab's size");

    // A bracketed paste arrives byte for byte.
    let paste = b"\x1b[200~line one\nline two \xc3\xa9\x1b[201~";
    type_bytes(paste).await.unwrap();
    assert!(
        wait_until_async(Duration::from_secs(10), || contains(&read_log(&log), paste)).await,
        "the paste arrived as {:?}",
        String::from_utf8_lossy(&read_log(&log))
    );

    // A second open of the same tab (a restart) reattaches: one session, its
    // screen in the snapshot, nothing new started.
    let m = mux.clone();
    let again = on_thread(move || m.open_tab(&tab, false)).await.unwrap();
    assert!(!again.created, "a reattach creates nothing");
    let (screen2, _thread2) = drain(again.reader);
    assert!(wait_until_async(Duration::from_secs(10), || contains(&screen2.lock().unwrap(), b"ECHO-READY")).await);
    let m = mux.clone();
    let listed = on_thread(move || m.list()).await.unwrap();
    assert_eq!(listed.iter().filter(|s| s.name == "p0").count(), 1);

    // Killing the session ends the stream (EOF; the child reads as exited).
    let m = mux.clone();
    on_thread(move || m.kill("p0")).await.unwrap();
    on_thread(move || thread.join().unwrap()).await;
    assert!(handle.wait_ended(Duration::from_secs(10)).ended);
    assert!(child.try_wait().unwrap().is_some());
    drop(th);
}

/// The phone's attach: a stream onto a running session that never creates
/// one; `attach_client` has no client to offer.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_phones_stream_attach_attaches_only() {
    let th = test_host();
    let mux = Arc::new(WinHostMux::with_launch(th.launch.clone()));
    let log = th.launch.state_dir.parent().unwrap().join("phone.log");
    let (argv, env) = echo_program(&log);
    let mut tab = opts("phone", &argv[0], &argv[1..].iter().map(String::as_str).collect::<Vec<_>>());
    tab.env = env.into_iter().filter(|(k, _)| k.starts_with("SESSION_HOST_TEST")).collect();
    let m = mux.clone();
    on_thread(move || m.spawn_detached(&tab)).await.unwrap();
    assert!(matches!(mux.attach_client("phone", true), Err(MuxError::Unavailable(_))));

    let m = mux.clone();
    let stream = on_thread(move || m.attach_stream("phone", 90, 30, 0)).await.unwrap();
    assert_eq!(stream.size(), (90, 30));
    let (reader, mut writer, control) = stream.into_parts();
    let (screen, thread) = drain(reader);
    assert!(wait_until_async(Duration::from_secs(20), || contains(&screen.lock().unwrap(), b"ECHO-READY")).await);
    let _writer = on_thread(move || {
        writer.write_all(b"from the phone").unwrap();
        writer
    })
    .await;
    assert!(wait_until_async(Duration::from_secs(10), || contains(&read_log(&log), b"from the phone")).await);
    control.close();
    on_thread(move || thread.join().unwrap()).await;
    let m = mux.clone();
    assert!(on_thread(move || m.has("phone")).await.unwrap(), "closing the stream detaches only");

    let m = mux.clone();
    on_thread(move || m.kill("phone")).await.unwrap();
    let m = mux.clone();
    assert!(matches!(on_thread(move || m.attach_stream("phone", 80, 24, 0)).await, Err(MuxError::NotFound)));
    let m = mux.clone();
    assert!(!on_thread(move || m.has("phone")).await.unwrap(), "attach never creates");
}

/// A host that cannot start is absent (the fallback is safe); a pipe that
/// opens and never greets is silent (fail closed).
#[tokio::test(flavor = "multi_thread")]
async fn an_unstartable_host_is_absent_and_a_mute_pipe_silent() {
    let tmp = tempfile::tempdir().unwrap();
    let state = tmp.path().join("state");
    let launch = Launch {
        control_dir: crate::services::mobile_control::config::control_dir_for(&state),
        state_dir: state.clone(),
        source: tmp.path().join("missing.exe"),
        version: env!("CARGO_PKG_VERSION").into(),
    };
    let err = launch::connect_classified(&launch, route::HANDSHAKE_DEADLINE).await.err().unwrap();
    assert!(matches!(err, HostFailure::Absent(_)), "{err:?}");

    std::fs::create_dir_all(copies::host_root(&launch.control_dir)).unwrap();
    crate::services::local_pipe::create_token_at(&copies::token_path(&launch.control_dir)).unwrap();
    let name = launch.pipe_name();
    let mut server = crate::services::local_pipe::create_server(&name, true).unwrap();
    let mute = tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok(stream) = crate::services::local_pipe::accept(&mut server, &name).await {
            held.push(stream);
        }
    });
    let began = std::time::Instant::now();
    let err = launch::connect_classified(&launch, Duration::from_millis(300)).await.err().unwrap();
    assert!(matches!(err, HostFailure::Silent(_)), "{err:?}");
    assert!(began.elapsed() < Duration::from_secs(5), "the handshake deadline, not the cap");
    // The tab's open fails closed with the same answer (a host binary to
    // copy exists, so the mux is ready; the pipe is there, so none starts).
    let mux = WinHostMux::with_launch(Launch { source: std::env::current_exe().unwrap(), ..launch.clone() });
    let tab = opts("mute", &cmd_exe(), &["/q", "/k"]);
    let failure = on_thread(move || mux.open_tab(&tab, false)).await.err().unwrap();
    assert_eq!(route::decide(&failure), route::SpawnDecision::FailClosed(route::ERR_SILENT), "{failure:?}");
    mute.abort();
}

/// The setting turned off while a session runs in the host: the session is
/// still found (`has`), attached to without a `Spawn` (attach-only never
/// creates), never fallen back from (a create-path open fails closed), and
/// still ended by `kill` and the quit reap.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_session_outlives_its_setting_and_is_still_reached_and_ended() {
    let th = test_host();
    let on = Arc::new(WinHostMux::with_launch(th.launch.clone()));
    let app = format!("{}kept", crate::services::tmux_local::LOCAL_TMUX_PREFIX);
    let (m, name) = (on.clone(), app.clone());
    on_thread(move || m.spawn_detached(&opts(&name, &cmd_exe(), &["/q", "/k"]))).await.unwrap();

    // No settings file: the setting is off.
    let settings = th.launch.state_dir.join("settings.json");
    let off = Arc::new(WinHostMux { launch: Ok(th.launch.clone()), gate: Gate::Settings(settings) });
    assert!(!off.available() && off.holds_sessions());
    let (m, name) = (off.clone(), app.clone());
    assert_eq!(on_thread(move || m.has(&name)).await, Ok(true));

    let (m, tab) = (off.clone(), opts(&app, &cmd_exe(), &["/q", "/k"]));
    let failure = on_thread(move || m.open_tab(&tab, false)).await.err().unwrap();
    assert_eq!(route::decide(&failure), route::SpawnDecision::FailClosed(route::ERR_SILENT), "{failure:?}");

    let (m, tab) = (off.clone(), opts(&app, &cmd_exe(), &["/q", "/k"]));
    let pty = on_thread(move || m.open_tab(&tab, true)).await.expect("attach-only needs no setting");
    assert!(!pty.created);

    // Attach-only onto a session that is not there: refused, nothing made.
    let (m, tab) = (off.clone(), opts("wh-missing", &cmd_exe(), &["/q", "/k"]));
    let failure = on_thread(move || m.open_tab(&tab, true)).await.err().unwrap();
    assert!(matches!(failure, HostFailure::Refused(_)), "{failure:?}");
    let m = off.clone();
    assert_eq!(on_thread(move || m.has("wh-missing")).await, Ok(false), "attach-only never creates");

    // Ended while off: kill and the quit reap still reach the host.
    drop(pty);
    let (m, name) = (off.clone(), app.clone());
    on_thread(move || m.kill(&name)).await.unwrap();
    let (m, name) = (off.clone(), app.clone());
    assert_eq!(on_thread(move || m.has(&name)).await, Ok(false));
    let (m, name) = (on.clone(), app.clone());
    on_thread(move || m.spawn_detached(&opts(&name, &cmd_exe(), &["/q", "/k"]))).await.unwrap();
    let m = off.clone();
    on_thread(move || m.kill_app_sessions()).await.unwrap();
    let (m, name) = (off.clone(), app.clone());
    assert_eq!(on_thread(move || m.has(&name)).await, Ok(false), "the quit reap ends it with the setting off");
}

/// No host running: the live-session probe answers "none" without starting
/// one, so the tab runs in-process.
#[tokio::test(flavor = "multi_thread")]
async fn the_live_session_probe_starts_no_host() {
    let tmp = tempfile::tempdir().unwrap();
    let state = tmp.path().join("state");
    let launch = Launch {
        control_dir: crate::services::mobile_control::config::control_dir_for(&state),
        state_dir: state.clone(),
        source: std::env::current_exe().unwrap(),
        version: env!("CARGO_PKG_VERSION").into(),
    };
    let off = WinHostMux { launch: Ok(launch.clone()), gate: Gate::Settings(state.join("settings.json")) };
    assert_eq!(on_thread(move || off.has("s")).await, Ok(false));
    assert!(!copies::copy_path(&launch.control_dir, &launch.identity()).exists(), "nothing staged or started");
}

/// A listing only asks: under its own short deadline (it runs under the
/// phone catalog's lock), and never retiring a host — not even an older,
/// idle one, which a full connect would ask to leave.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_listing_is_quick_and_never_retires_a_host() {
    let th = test_host();
    let newer = WinHostMux::with_launch(Launch { version: "999.0.0".into(), ..th.launch.clone() });
    assert_eq!(on_thread(move || newer.list()).await, Ok(Vec::new()), "the older idle host answers");
    tokio::time::sleep(Duration::from_millis(300)).await;
    let mux = WinHostMux::with_launch(th.launch.clone());
    assert_eq!(on_thread(move || mux.pane("none")).await, Err(MuxError::NotFound), "the host is still there");
    drop(th);

    // A pipe that opens and never greets: the listing gives up at its own
    // deadline, not the 15 s call cap.
    let tmp = tempfile::tempdir().unwrap();
    let state = tmp.path().join("state");
    let launch = Launch {
        control_dir: crate::services::mobile_control::config::control_dir_for(&state),
        state_dir: state,
        source: std::env::current_exe().unwrap(),
        version: env!("CARGO_PKG_VERSION").into(),
    };
    std::fs::create_dir_all(copies::host_root(&launch.control_dir)).unwrap();
    crate::services::local_pipe::create_token_at(&copies::token_path(&launch.control_dir)).unwrap();
    let name = launch.pipe_name();
    let mut server = crate::services::local_pipe::create_server(&name, true).unwrap();
    let mute = tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok(stream) = crate::services::local_pipe::accept(&mut server, &name).await {
            held.push(stream);
        }
    });
    let mux = WinHostMux::with_launch(launch);
    let began = std::time::Instant::now();
    assert!(on_thread(move || mux.list()).await.is_err());
    let took = began.elapsed();
    assert!(took >= LIST_DEADLINE - Duration::from_millis(100) && took < LIST_DEADLINE + Duration::from_millis(1500), "{took:?}");
    mute.abort();
}
