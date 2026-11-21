//! The pipe-backed PTY against the fake host (every OS): snapshot then live
//! output, input and resize as frames, an ended session as EOF, a dead
//! remain-on-exit pane kept open, kill = detach, failures passed through.

use std::io::{Read, Write};
use std::time::Duration;

use super::*;
use crate::services::session_host::client::Client;
use crate::services::session_host::fake_pty::{connect_pair, eventually, spawn_req, test_host, TOKEN};
use crate::services::session_host::server::Host;

/// A stream onto `name` (created by `Spawn` with `remain_on_exit`) through a
/// fresh duplex connection to `host`.
fn open_on(host: &Host, name: &str, remain_on_exit: bool) -> Result<HostPty, HostFailure> {
    let io = connect_pair(host);
    let name = name.to_string();
    open(
        move || async move {
            let mut c = Client::handshake(io, TOKEN, "t").await.map_err(|e| HostFailure::Silent(e.to_string()))?;
            let created =
                c.spawn(spawn_req(&name, remain_on_exit)).await.map_err(|e| HostFailure::Refused(e.to_string()))?;
            let attached = c.attach(&name, 100, 30, 0).await.map_err(|e| HostFailure::Refused(e.to_string()))?;
            Ok((attached, created))
        },
        Duration::from_secs(10),
    )
}

/// Reads `reader` on a thread of its own into a shared buffer.
fn drain(mut reader: Box<dyn Read + Send>) -> (Arc<Mutex<Vec<u8>>>, std::thread::JoinHandle<()>) {
    let buf = Arc::new(Mutex::new(Vec::new()));
    let sink = buf.clone();
    let thread = std::thread::spawn(move || {
        let mut chunk = [0u8; 1024];
        while let Ok(n) = reader.read(&mut chunk) {
            if n == 0 {
                break;
            }
            sink.lock().unwrap().extend_from_slice(&chunk[..n]);
        }
    });
    (buf, thread)
}

fn has(buf: &Arc<Mutex<Vec<u8>>>, needle: &[u8]) -> bool {
    buf.lock().unwrap().windows(needle.len()).any(|w| w == needle)
}

async fn join(thread: std::thread::JoinHandle<()>) {
    tokio::task::spawn_blocking(move || thread.join().unwrap()).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn output_input_and_resize_flow_and_the_end_is_eof() {
    let (host, fake, _clock) = test_host();
    let pty = tokio::task::spawn_blocking({
        let host = host.clone();
        move || open_on(&host, "s", false)
    })
    .await
    .unwrap()
    .unwrap();
    let child = fake.last();
    child.emit(b"before");
    let HostPty { master, reader, mut writer, child: mut session_child, handle, .. } = pty;
    assert_eq!(master.get_size().unwrap().cols, 100);
    let (out, thread) = drain(reader);
    eventually(|| has(&out, b"before")).await;
    child.emit(b"live output");
    eventually(|| has(&out, b"live output")).await;

    // The writer blocks when full: a plain thread, as the registry's.
    let mut writer = tokio::task::spawn_blocking(move || {
        writer.write_all(b"typed \x03").unwrap();
        writer
    })
    .await
    .unwrap();
    eventually(|| child.input() == b"typed \x03").await;
    master.resize(PtySize { cols: 120, rows: 40, pixel_width: 0, pixel_height: 0 }).unwrap();
    eventually(|| child.sizes().last() == Some(&(120, 40))).await;
    assert_eq!(master.get_size().unwrap().rows, 40);

    assert!(session_child.try_wait().unwrap().is_none(), "running");
    child.exit(3);
    join(thread).await;
    let status = handle.wait_ended(Duration::from_secs(5));
    assert!(status.ended && !status.dead);
    assert_eq!(status.exit_code, Some(3));
    assert_eq!(session_child.try_wait().unwrap().map(|s| s.exit_code()), Some(3));
    let late = tokio::task::spawn_blocking(move || writer.write_all(b"late")).await.unwrap();
    assert!(late.is_err(), "a closed stream refuses input");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_dead_remain_on_exit_pane_stays_open_until_killed() {
    let (host, fake, _clock) = test_host();
    let pty = tokio::task::spawn_blocking({
        let host = host.clone();
        move || open_on(&host, "dead", true)
    })
    .await
    .unwrap()
    .unwrap();
    let child = fake.last();
    let HostPty { reader, child: mut session_child, handle, .. } = pty;
    let (out, thread) = drain(reader);
    child.emit(b"last words");
    child.exit(1);
    eventually(|| handle.status().dead).await;
    assert!(has(&out, b"last words"));
    assert!(!handle.status().ended, "the dead pane stays viewable");
    assert!(session_child.try_wait().unwrap().is_none(), "the tab lives on, like a tmux client of a dead pane");

    let mut c = Client::handshake(connect_pair(&host), TOKEN, "t").await.unwrap();
    c.kill("dead").await.unwrap();
    join(thread).await;
    assert!(handle.wait_ended(Duration::from_secs(5)).ended);
    assert!(session_child.try_wait().unwrap().is_some());
}

/// Killing the child detaches: the stream ends, the session lives on and a
/// new stream reattaches to it (a create-or-attach `Spawn` ignores its argv).
#[tokio::test(flavor = "multi_thread")]
async fn kill_detaches_and_the_session_runs_on() {
    let (host, fake, _clock) = test_host();
    let open_s = || {
        let host = host.clone();
        tokio::task::spawn_blocking(move || open_on(&host, "kept", false))
    };
    let pty = open_s().await.unwrap().unwrap();
    assert!(pty.created);
    let HostPty { reader, child: mut session_child, handle, .. } = pty;
    let (_out, thread) = drain(reader);
    session_child.kill().unwrap();
    join(thread).await;
    assert!(handle.wait_ended(Duration::from_secs(5)).ended);
    let code = session_child.try_wait().unwrap().map(|s| s.exit_code());
    assert_eq!(code, Some(LOST_EXIT_CODE), "no exit code of the program's own: never read as success");
    let mut c = Client::handshake(connect_pair(&host), TOKEN, "t").await.unwrap();
    let info = c.info("kept").await.unwrap();
    assert!(!info.dead, "the session still runs");
    eventually_attached(&mut c, 0).await;
    assert_eq!(fake.count(), 1);

    let again = open_s().await.unwrap().unwrap();
    assert_eq!(fake.count(), 1, "the reattach started nothing");
    assert!(!again.created);
    let (out, _thread) = drain(again.reader);
    fake.last().emit(b"still here");
    eventually(|| has(&out, b"still here")).await;
}

async fn eventually_attached(c: &mut Client<tokio::io::DuplexStream>, want: usize) {
    // A deadline, not a count: a loaded CI runner (the whole suite in
    // parallel) took longer than 500 polls of 5 ms.
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    while std::time::Instant::now() < deadline {
        if c.list().await.unwrap().iter().any(|s| s.name == "kept" && s.attached == want) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("the session never had {want} clients");
}

/// Every part dropped (the registry dropped the entry) closes the stream.
#[tokio::test(flavor = "multi_thread")]
async fn dropping_every_part_detaches() {
    let (host, fake, _clock) = test_host();
    let pty = tokio::task::spawn_blocking({
        let host = host.clone();
        move || open_on(&host, "kept", false)
    })
    .await
    .unwrap()
    .unwrap();
    let mut c = Client::handshake(connect_pair(&host), TOKEN, "t").await.unwrap();
    eventually_attached(&mut c, 1).await;
    let watch = pty.handle.clone();
    drop(pty);
    // The handle above is a part too: the stream lives while it does, output
    // arriving with no reader left included (the attach's snapshot can reach
    // the pump only now on a loaded runner).
    fake.last().emit(b"nobody reads this");
    tokio::time::sleep(Duration::from_millis(50)).await;
    eventually_attached(&mut c, 1).await;
    drop(watch);
    eventually_attached(&mut c, 0).await;
}

#[test]
fn a_failed_open_is_passed_through_and_a_deadline_is_silence() {
    let failed = open::<tokio::io::DuplexStream, _, _>(
        || async { Err(HostFailure::Absent("no copy".into())) },
        Duration::from_secs(5),
    );
    assert_eq!(failed.err(), Some(HostFailure::Absent("no copy".into())));
    let hung = open::<tokio::io::DuplexStream, _, _>(
        || async {
            tokio::time::sleep(Duration::from_secs(60)).await;
            Err(HostFailure::Absent("never".into()))
        },
        Duration::from_millis(100),
    );
    assert!(matches!(hung.err(), Some(HostFailure::Silent(_))), "a Spawn may have run: never a fallback");
}
