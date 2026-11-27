//! The phone's bridge onto a Windows session host tab, end to end against a
//! real in-process host (ConPTY children): the stream's snapshot is the
//! replay, in bounded frames after the `replay` marker; the window size is
//! adopted; typed frames reach the pane and are acked; a resize reaches the
//! session; Send now presses through the mux; a detach leaves the session
//! running.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::ws::Message;
use futures_util::{sink, stream};

use super::{attach_with, AttachTarget, TerminalRegistry, Viewer, REPLAY_CHUNK};
use crate::services::mobile_control::auth::AuthStore;
use crate::services::mobile_control::discovery::{live_on, CatalogCache};
use crate::services::mobile_control::protocol::TerminalEvent;
use crate::services::session_host::win::test_support::{cmd_exe, test_host, wait_until_async};
use crate::services::session_mux::winhost::WinHostMux;
use crate::services::session_mux::{MuxKind, SessionMux};
use crate::terminal::PtyOptions;

const TMUX: &str = concat!(crate::app_slug!(), "-p-1--shell-123456789");

/// One project with one shell tab under [`TMUX`] in `state`, open to every
/// phone (shells allowed), its folder at `root`.
fn scope(state: &std::path::Path, root: &std::path::Path) {
    std::fs::create_dir_all(root).unwrap();
    std::fs::write(
        state.join("settings.json"),
        serde_json::json!({ "assistant": false, crate::brand::MOBILE_HOST_KEY: { "enabled": true, "shell_tabs": true } }).to_string(),
    )
    .unwrap();
    let sessions = state.join("sessions").join("p-1");
    std::fs::create_dir_all(&sessions).unwrap();
    std::fs::write(
        sessions.join("terminals.json"),
        serde_json::json!({ "tabLayout": [{
            "label": "Shell", "cmd": "cmd", "cwd": root.to_string_lossy(), "kind": "shell", "tmuxSession": TMUX,
        }] })
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        state.join("projects.json"),
        serde_json::json!([{
            "id": "p-1", "name": "P", "status": "active", "directory": root.to_string_lossy(),
            crate::brand::MOBILE_ACCESS_KEY: true,
        }])
        .to_string(),
    )
    .unwrap();
}

fn text(message: &Message) -> Option<TerminalEvent> {
    match message {
        Message::Text(text) => serde_json::from_str(text.as_str()).ok(),
        _ => None,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_phone_attaches_to_a_session_host_tab_replays_types_resizes_and_is_acked() {
    let th = test_host();
    let mux: Arc<dyn SessionMux> = Arc::new(WinHostMux::with_launch(th.launch.clone()));
    assert_eq!(mux.kind(), MuxKind::WinHost);
    let dir = tempfile::tempdir().unwrap();
    let (state, root) = (dir.path().join("state"), dir.path().join("p"));
    std::fs::create_dir_all(&state).unwrap();
    scope(&state, &root);

    // The tab's session: 60 lines of history, more than its 20 rows.
    let opts: PtyOptions = serde_json::from_value(serde_json::json!({
        "id": "tab", "cmd": cmd_exe(), "cwd": root.to_string_lossy(), "cols": 100, "rows": 20, "tmux_session": TMUX,
        "args": ["/q", "/k", "for", "/l", "%i", "in", "(1,1,60)", "do", "@echo", "history-%i"],
    }))
    .unwrap();
    let m = mux.clone();
    tokio::task::spawn_blocking(move || m.spawn_detached(&opts)).await.unwrap().unwrap();
    let m = mux.clone();
    assert!(
        wait_until_async(Duration::from_secs(20), || m.screen(TMUX).is_ok_and(|s| s.contains("history-60"))).await,
        "the session ran"
    );

    // The catalog joins against the host's own listing (no host started by it).
    let m = mux.clone();
    let live = tokio::task::spawn_blocking(move || live_on(&*m)).await.unwrap().unwrap();
    assert!(live.contains_key(TMUX), "listed by the session host");
    let mut auth = AuthStore::open(&dir.path().join("control"), "https://desk.example.ts.net".into()).unwrap();
    auth.insert_test_session("tok", "d1");
    let key = auth.host_key().to_vec();
    let mut cache = CatalogCache::with_live(live);
    let catalog = cache.load(&state, &key).unwrap();
    let tab_id = catalog.projects.iter().flat_map(|p| &p.tabs).find(|t| t.tmux_name == TMUX).expect("listed").public.id.clone();
    assert!(catalog.grants(&tab_id, TMUX), "the tab is available");

    // The phone's socket, as two channels.
    let (to_bridge, from_phone) = tokio::sync::mpsc::unbounded_channel::<Message>();
    let (to_phone, mut phone) = tokio::sync::mpsc::unbounded_channel::<Message>();
    let rx = Box::pin(stream::unfold(from_phone, |mut rx| async move {
        rx.recv().await.map(|m| (Ok::<_, std::convert::Infallible>(m), rx))
    }));
    let tx = Box::pin(sink::unfold(to_phone, |tx, m: Message| async move {
        tx.send(m).map_err(|_| ())?;
        Ok::<_, ()>(tx)
    }));
    let registry = TerminalRegistry::default();
    let bridge = tokio::spawn(attach_with(
        tx,
        rx,
        AttachTarget::Local { name: TMUX.into() },
        mux.clone(),
        Viewer { device_id: "d1".into(), project_id: "p-1".into() },
        registry.clone(),
        Arc::new(Mutex::new(auth)),
        "tok".into(),
        state.clone(),
        tab_id,
        Arc::new(Mutex::new(cache)),
        false,
        false,
        |_| {},
        || {},
    ));

    // Everything the phone got so far, and the output as text.
    let mut events: Vec<TerminalEvent> = Vec::new();
    let mut output: Vec<u8> = Vec::new();
    let mut frames: Vec<usize> = Vec::new();
    let mut first_binary_after: Option<usize> = None;
    let mut pump = |phone: &mut tokio::sync::mpsc::UnboundedReceiver<Message>| {
        while let Ok(message) = phone.try_recv() {
            match message {
                Message::Binary(bytes) => {
                    first_binary_after.get_or_insert(events.len());
                    frames.push(bytes.len());
                    output.extend_from_slice(&bytes);
                }
                other => events.extend(text(&other)),
            }
        }
        (events.clone(), String::from_utf8_lossy(&output).into_owned())
    };
    let mut seen = (Vec::new(), String::new());
    for _ in 0..500 {
        seen = pump(&mut phone);
        if seen.1.contains("history-60") && seen.1.contains("history-1\r\n") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    // The replay marker, the adopted window, then the snapshot: history in
    // the scrollback and the screen, no capture of its own.
    assert_eq!(seen.0.first(), Some(&TerminalEvent::Replay), "{:?}", seen.0);
    assert!(seen.0.contains(&TerminalEvent::Window { cols: 100, rows: 20 }), "{:?}", seen.0);
    assert!(seen.1.contains("history-1\r\n") && seen.1.contains("history-60"), "{:?}", seen.1);
    assert_eq!(seen.1.matches("history-1\r\n").count(), 1, "the history once, not a capture and a snapshot");

    // A typed frame reaches the pane and is acked by its ordinal.
    to_bridge.send(Message::Binary(b"echo typed-77\r".to_vec().into())).unwrap();
    for _ in 0..500 {
        seen = pump(&mut phone);
        if seen.0.contains(&TerminalEvent::Ack { seq: 1 }) && seen.1.matches("typed-77").count() >= 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(seen.0.contains(&TerminalEvent::Ack { seq: 1 }), "{:?}", seen.0);
    assert!(seen.1.matches("typed-77").count() >= 2, "echoed and run: {:?}", seen.1);

    // The phone's resize reaches the session (it follows its latest client).
    to_bridge.send(Message::Text(r#"{"type":"resize","cols":90,"rows":30}"#.into())).unwrap();
    let m = mux.clone();
    assert!(
        wait_until_async(Duration::from_secs(10), || m.window(TMUX) == Ok((90, 30))).await,
        "{:?}",
        mux.window(TMUX)
    );
    // The bridge's window poll then tells the phone the adopted size.

    // Send now: no queue sign on screen, no keys pressed.
    to_bridge.send(Message::Text(r#"{"type":"send_now","family":"claude"}"#.into())).unwrap();
    for _ in 0..500 {
        seen = pump(&mut phone);
        if seen.0.iter().any(|e| matches!(e, TerminalEvent::SendNow { .. })) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(seen.0.contains(&TerminalEvent::SendNow { sent: false }), "{:?}", seen.0);

    // A detach ends the bridge and leaves the session running.
    assert!(registry.is_busy(TMUX));
    to_bridge.send(Message::Text(r#"{"type":"detached"}"#.into())).unwrap();
    let ended = tokio::time::timeout(Duration::from_secs(10), bridge).await.expect("the bridge ends").unwrap();
    assert_eq!(ended, Ok(()));
    assert!(!registry.is_busy(TMUX));
    let m = mux.clone();
    assert!(tokio::task::spawn_blocking(move || m.has(TMUX)).await.unwrap().unwrap(), "a detach only");

    // Every output frame fits the replay's bound, and none came before the marker.
    assert!(frames.iter().all(|len| *len <= REPLAY_CHUNK), "{frames:?}");
    assert!(first_binary_after.is_some_and(|n| n >= 1));
    let m = mux.clone();
    tokio::task::spawn_blocking(move || m.kill(TMUX)).await.unwrap().unwrap();
}

/// Send now on the session host: the queue sign on the pane's screen lets
/// the CLI's keys go in through the mux; without it nothing is pressed.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn send_now_presses_through_the_session_host_only_while_the_hint_shows() {
    let th = test_host();
    let mux: Arc<dyn SessionMux> = Arc::new(WinHostMux::with_launch(th.launch.clone()));
    let hint = super::queue_hint("claude").unwrap();
    let name = concat!(crate::app_slug!(), "-p-1--agent-sendnow01");
    let opts: PtyOptions = serde_json::from_value(serde_json::json!({
        "id": "tab", "cmd": cmd_exe(), "cwd": "", "cols": 100, "rows": 20, "tmux_session": name,
        "args": ["/q", "/k", "echo", "ready-1"],
    }))
    .unwrap();
    let m = mux.clone();
    tokio::task::spawn_blocking(move || m.spawn_detached(&opts)).await.unwrap().unwrap();
    let m = mux.clone();
    assert!(wait_until_async(Duration::from_secs(20), || m.screen(name).is_ok_and(|s| s.contains("ready-1"))).await);
    let target = AttachTarget::Local { name: name.into() };
    let (t, m) = (target.clone(), mux.clone());
    assert!(!tokio::task::spawn_blocking(move || t.send_now_on(hint, &*m)).await.unwrap(), "no sign, no press");

    let m = mux.clone();
    tokio::task::spawn_blocking(move || {
        m.send_keys(name, &[crate::services::session_mux::Key::Literal("cls & echo ❯ Press up to edit queued messages".into())])
            .unwrap();
        m.send_keys(name, &[crate::services::session_mux::Key::from_name("Enter")]).unwrap();
    })
    .await
    .unwrap();
    let m = mux.clone();
    assert!(
        wait_until_async(Duration::from_secs(10), || m
            .screen(name)
            .is_ok_and(|s| s.lines().any(|row| row.starts_with("❯ Press up to edit queued messages"))))
        .await,
        "{:?}",
        mux.screen(name)
    );
    let (t, m) = (target.clone(), mux.clone());
    assert!(tokio::task::spawn_blocking(move || t.send_now_on(hint, &*m)).await.unwrap(), "the sign shows: pressed");
    let m = mux.clone();
    tokio::task::spawn_blocking(move || m.kill(name)).await.unwrap().unwrap();
}

/// With the session host's setting switched off, a session it still runs
/// stays on the phone until it ends: listed (the catalog grants it, so an
/// open terminal's re-check keeps it), attachable, read and typed into (the
/// scheduler) — while `terminals` says `unsupported` and nothing new starts.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_live_session_stays_on_the_phone_with_the_setting_off() {
    use crate::services::mobile_control::discovery::terminals_support_of;
    use crate::services::session_mux::{Key, MuxError};
    let th = test_host();
    let on: Arc<dyn SessionMux> = Arc::new(WinHostMux::with_launch(th.launch.clone()));
    let off: Arc<dyn SessionMux> = Arc::new(WinHostMux::switched_off(th.launch.clone()));
    let dir = tempfile::tempdir().unwrap();
    let (state, root) = (dir.path().join("state"), dir.path().join("p"));
    std::fs::create_dir_all(&state).unwrap();
    scope(&state, &root);
    let opts: PtyOptions = serde_json::from_value(serde_json::json!({
        "id": "tab", "cmd": cmd_exe(), "cwd": root.to_string_lossy(), "cols": 100, "rows": 20, "tmux_session": TMUX,
        "args": ["/q", "/k", "echo", "before-off"],
    }))
    .unwrap();
    let m = on.clone();
    tokio::task::spawn_blocking(move || m.spawn_detached(&opts)).await.unwrap().unwrap();
    let m = off.clone();
    assert!(wait_until_async(Duration::from_secs(20), || m.screen(TMUX).is_ok_and(|s| s.contains("before-off"))).await);

    assert!(!off.available() && off.holds_sessions());
    assert_eq!(terminals_support_of(&*off), crate::services::mobile_control::discovery::TERMINALS_UNSUPPORTED);
    let m = off.clone();
    let live = tokio::task::spawn_blocking(move || live_on(&*m)).await.unwrap().unwrap();
    assert!(live.contains_key(TMUX), "still listed");
    let mut auth = AuthStore::open(&dir.path().join("control"), "https://desk.example.ts.net".into()).unwrap();
    auth.insert_test_session("tok", "d1");
    let mut cache = CatalogCache::with_live(live);
    let catalog = cache.load(&state, auth.host_key()).unwrap();
    let tab_id = catalog.projects.iter().flat_map(|p| &p.tabs).find(|t| t.tmux_name == TMUX).expect("listed").public.id.clone();
    assert_eq!(super::recheck(Some(catalog), "d1", true, &tab_id, TMUX), Ok(()), "an open terminal is kept");

    let m = off.clone();
    let (pane, typed) = tokio::task::spawn_blocking(move || {
        (m.pane(TMUX), m.send_keys(TMUX, &[Key::Literal("echo while-off".into()), Key::from_name("Enter")]))
    })
    .await
    .unwrap();
    assert!(pane.is_ok_and(|p| !p.dead), "the scheduler's probe");
    typed.unwrap();
    let m = off.clone();
    assert!(wait_until_async(Duration::from_secs(10), || m.screen(TMUX).is_ok_and(|s| s.lines().any(|l| l.trim_end() == "while-off"))).await);
    let m = off.clone();
    let stream = tokio::task::spawn_blocking(move || m.attach_stream(TMUX, 100, 20, 0)).await.unwrap().expect("attachable");
    stream.close();
    let m = off.clone();
    let mut fresh: PtyOptions = serde_json::from_value(serde_json::json!({
        "id": "tab2", "cmd": cmd_exe(), "args": [], "cwd": "", "cols": 80, "rows": 24, "tmux_session": "wh-off-new",
    }))
    .unwrap();
    m.wrap(&mut fresh);
    assert!(!fresh.mux_wrapped, "nothing new is marked");
    assert!(matches!(tokio::task::spawn_blocking(move || m.spawn_detached(&fresh)).await.unwrap(), Err(MuxError::Unavailable(_))));
    let m = off.clone();
    tokio::task::spawn_blocking(move || m.kill(TMUX)).await.unwrap().unwrap();
}
