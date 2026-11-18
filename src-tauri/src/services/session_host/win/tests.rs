//! The host for real on Windows: a ConPTY behind the pipe, the DACL read back
//! from the kernel, the single instance, subtree reaping and the host
//! process's death taking its sessions along. Every test has its own state
//! dir, so its own pipe and mutex names.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tokio::net::windows::named_pipe::NamedPipeClient;

use super::conpty::ConPtySpawner;
use super::pipe::{claim_instance, mutex_name, pipe_name, serve, Listener, PipeConnector};
use super::test_support::{child_pids, cmd_exe, current_env, ping_exe, process_alive, wait_until, wait_until_async};
use super::{run_host, HostEnd, HostOptions};
use crate::services::local_pipe;
use crate::services::session_host::client::{self, Client, ClientError, StreamEvent};
use crate::services::session_host::copies;
use crate::services::session_host::protocol::Request;
use crate::services::session_host::server::{Host, HostConfig};
use crate::services::session_host::table::SystemClock;

const TOKEN: &str = "test-token";
/// The env var that turns [`child_host_entry`] into a host process.
const CHILD_STATE_ENV: &str = "SESSION_HOST_TEST_CHILD_STATE";

fn control_dir(state: &Path) -> PathBuf {
    crate::services::mobile_control::config::control_dir_for(state)
}

/// An in-process host with the real ConPTY spawner on `state`'s pipe.
fn start_host(state: &Path) -> (Host, String) {
    let host = Host::new(HostConfig::new(TOKEN, "test", std::process::id()), ConPtySpawner, Arc::new(SystemClock));
    let name = pipe_name(state);
    let listener = Listener::bind(&name).unwrap();
    tokio::spawn(serve(host.clone(), listener));
    (host, name)
}

async fn connect(name: &str, token: &str) -> client::Result<Client<NamedPipeClient>> {
    client::connect(&PipeConnector { name: name.to_string() }, token, "test").await
}

fn spawn_req(name: &str, argv: Vec<String>, remain_on_exit: bool) -> Request {
    Request::Spawn {
        name: name.into(),
        argv,
        env: current_env(),
        cwd: None,
        cols: 100,
        rows: 30,
        remain_on_exit,
        size_policy: Default::default(),
        create_only: false,
        mcp_mark: None,
    }
}

/// `fut` bounded: a host that never answers fails the test with `what`, it
/// does not hang the whole backend step until its timeout cuts it off.
async fn within<T>(secs: u64, what: &str, fut: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(secs), fut)
        .await
        .unwrap_or_else(|_| panic!("{what}: no answer within {secs}s"))
}

async fn capture_until(c: &mut Client<NamedPipeClient>, name: &str, want: &str) -> String {
    let mut text = String::new();
    for _ in 0..500 {
        text = c.capture(name, true, false, 0).await.unwrap();
        if text.contains(want) {
            return text;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("{want:?} never appeared; screen: {text:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_host_pipe_dacl_reads_back_protected_and_owner_only() {
    use std::os::windows::io::AsRawHandle;
    let tmp = tempfile::tempdir().unwrap();
    let listener = Listener::bind(&pipe_name(tmp.path())).unwrap();
    local_pipe::test_support::assert_protected_dacl(windows::Win32::Foundation::HANDLE(
        listener.server().as_raw_handle(),
    ));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_second_host_is_refused() {
    let tmp = tempfile::tempdir().unwrap();
    let state = tmp.path().join("state");
    // The mutex: one claim per state dir.
    let first = claim_instance(&mutex_name(&state)).unwrap();
    assert!(first.is_some());
    assert!(claim_instance(&mutex_name(&state)).unwrap().is_none());
    drop(first);
    // The pipe: `first_pipe_instance` refuses a second listener.
    let _listener = Listener::bind(&pipe_name(&state)).unwrap();
    assert!(Listener::bind(&pipe_name(&state)).is_err());

    // The whole host: the loser ends at once, without touching the winner.
    let other = tmp.path().join("other");
    let runner = {
        let other = other.clone();
        tokio::spawn(async move { run_host(&other, HostOptions::default()).await })
    };
    let name = pipe_name(&other);
    assert!(wait_until_async(Duration::from_secs(10), || std::fs::metadata(copies::token_path(&control_dir(&other))).is_ok()).await);
    // Bounded: a host that never answers fails the test, it does not hang it.
    let mut version = None;
    for _ in 0..1000 {
        let token = local_pipe::read_token_at(&copies::token_path(&control_dir(&other))).unwrap();
        if let Ok(Ok(c)) = tokio::time::timeout(Duration::from_secs(2), connect(&name, &token)).await {
            version = Some(c.welcome().host_version.clone());
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let version = version.expect("the host came up");
    // `<version>+<build>`: this test binary's build identity.
    let ours = copies::identity(
        env!("CARGO_PKG_VERSION"),
        copies::read_build_id(&std::env::current_exe().unwrap()).as_deref(),
    );
    assert_eq!(version, ours);
    assert!(version.starts_with(concat!(env!("CARGO_PKG_VERSION"), "+")), "{version}");
    let token_before = std::fs::read(copies::token_path(&control_dir(&other))).unwrap();
    let loser = within(15, "the second host ended at once", run_host(&other, HostOptions::default())).await;
    assert_eq!(loser.unwrap(), HostEnd::AlreadyRunning);
    assert_eq!(std::fs::read(copies::token_path(&control_dir(&other))).unwrap(), token_before, "the loser wrote nothing");
    let real = local_pipe::read_token_at(&copies::token_path(&control_dir(&other))).unwrap();
    within(15, "the host took Shutdown", async {
        connect(&name, &real).await.unwrap().shutdown(false).await.unwrap();
    })
    .await;
    let end = tokio::time::timeout(Duration::from_secs(15), runner).await.expect("the host exits when asked");
    assert_eq!(end.unwrap().unwrap(), HostEnd::Exited);
}

/// A mutex of the host's name that this user may not open (another
/// principal's) is an error, never taken for a running host.
#[test]
fn a_squatted_mutex_name_is_refused_not_mistaken_for_a_host() {
    use windows::core::HSTRING;
    use windows::Win32::System::Threading::CreateMutexW;
    let tmp = tempfile::tempdir().unwrap();
    let name = mutex_name(&tmp.path().join("state"));
    let system_only = local_pipe::PipeSecurity::from_sddl("D:P(A;;GA;;;SY)").unwrap();
    // SAFETY: the attributes outlive the call; the handle is owned below.
    let squat = unsafe { CreateMutexW(Some(system_only.attributes()), false, &HSTRING::from(name.as_str())) };
    let _squat = super::OwnedHandle(squat.unwrap());
    let err = claim_instance(&name).err().expect("refused");
    assert_eq!(err.kind(), std::io::ErrorKind::PermissionDenied, "{err}");
    assert!(err.to_string().contains("another user"), "{err}");
}

#[test]
fn names_fold_the_state_dirs_spelling() {
    let tmp = tempfile::tempdir().unwrap();
    let state = tmp.path().join("State");
    std::fs::create_dir_all(&state).unwrap();
    let upper = std::path::PathBuf::from(state.to_string_lossy().to_uppercase());
    let trailing = std::path::PathBuf::from(format!("{}\\", state.display()));
    assert_eq!(pipe_name(&state), pipe_name(&upper));
    assert_eq!(pipe_name(&state), pipe_name(&trailing));
    assert_eq!(mutex_name(&state), mutex_name(&upper));
    assert_ne!(pipe_name(&state), pipe_name(&tmp.path().join("other")));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_bad_token_is_refused() {
    let tmp = tempfile::tempdir().unwrap();
    let (_host, name) = start_host(tmp.path());
    assert!(matches!(connect(&name, "wrong").await, Err(ClientError::Closed)));
    assert!(matches!(connect(&name, "").await, Err(ClientError::Closed)));
    assert!(connect(&name, TOKEN).await.is_ok());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_conpty_echo_round_trips_through_host_and_client() {
    let tmp = tempfile::tempdir().unwrap();
    let (_host, name) = start_host(tmp.path());
    let mut c = connect(&name, TOKEN).await.unwrap();
    let argv = vec![cmd_exe(), "/c".into(), "echo".into(), "round-trip-8841".into()];
    assert!(c.spawn(spawn_req("echo", argv, true)).await.unwrap());
    capture_until(&mut c, "echo", "round-trip-8841").await;
    // remain-on-exit: the screen stays, the pane is dead.
    let mut dead = false;
    for _ in 0..500 {
        let info = c.info("echo").await.unwrap();
        if info.dead {
            assert_eq!(info.exit_code, Some(0));
            dead = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(dead, "the exited child left a dead pane");
    assert!(c.capture("echo", true, false, 0).await.unwrap().contains("round-trip-8841"));
}

#[tokio::test(flavor = "multi_thread")]
async fn typed_input_reaches_the_child_and_its_output_the_stream() {
    let tmp = tempfile::tempdir().unwrap();
    let (_host, name) = start_host(tmp.path());
    let mut c = connect(&name, TOKEN).await.unwrap();
    let argv = vec![cmd_exe(), "/q".into(), "/k".into()];
    c.spawn(spawn_req("shell", argv, false)).await.unwrap();
    let attached = connect(&name, TOKEN).await.unwrap().attach("shell", 100, 30, 0).await.unwrap();
    let (mut rd, mut wr) = attached.into_split();
    // The typed text never contains the answer: only the child computes it.
    wr.input(b"set /a 6*7+1000\r").await.unwrap();
    let mut seen = Vec::new();
    let found = tokio::time::timeout(Duration::from_secs(15), async {
        while let Ok(Some(event)) = rd.next().await {
            if let StreamEvent::Output(bytes) = event {
                seen.extend_from_slice(&bytes);
                if String::from_utf8_lossy(&seen).contains("1042") {
                    return true;
                }
            }
        }
        false
    })
    .await;
    assert_eq!(found, Ok(true), "{:?}", String::from_utf8_lossy(&seen));
    capture_until(&mut c, "shell", "1042").await;
    c.kill("shell").await.unwrap();
}

/// A child that starts a ping in its own hidden console — not attached to
/// the session's pseudoconsole, so closing that never ends it; only the Job
/// can — and exits.
fn own_console_ping_argv() -> Vec<String> {
    let powershell = super::test_support::system_dir().join("WindowsPowerShell").join("v1.0").join("powershell.exe");
    let script =
        format!("Start-Process -WindowStyle Hidden -FilePath '{}' -ArgumentList '-n','60','127.0.0.1'", ping_exe());
    vec![
        powershell.to_string_lossy().into_owned(),
        "-NoProfile".into(),
        "-NonInteractive".into(),
        "-Command".into(),
        script,
    ]
}

/// Spawns [`own_console_ping_argv`] as remain-on-exit session `name`, waits
/// until its child exited (the pseudoconsole closed with it) while the ping
/// still runs, and returns the ping's pid.
async fn ping_outliving_its_console(c: &mut Client<NamedPipeClient>, name: &str) -> u32 {
    c.spawn(spawn_req(name, own_console_ping_argv(), true)).await.unwrap();
    let parent = c.info(name).await.unwrap().pid.unwrap();
    for _ in 0..1500 {
        let pings = child_pids(parent, "ping");
        if !pings.is_empty() && c.info(name).await.unwrap().dead {
            // Past the pseudoconsole's close (the waiter's grace and more).
            tokio::time::sleep(Duration::from_millis(1000)).await;
            assert!(process_alive(pings[0]), "the ping survived its console closing: only the Job can end it");
            return pings[0];
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("the ping never started, or its parent never exited");
}

#[tokio::test(flavor = "multi_thread")]
async fn kill_reaps_a_grandchild() {
    let tmp = tempfile::tempdir().unwrap();
    let (_host, name) = start_host(tmp.path());
    let mut c = connect(&name, TOKEN).await.unwrap();
    let ping = ping_outliving_its_console(&mut c, "tree").await;
    c.kill("tree").await.unwrap();
    assert!(wait_until(Duration::from_secs(10), || !process_alive(ping)), "the grandchild outlived the kill");
    assert!(c.list().await.unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn sessions_json_follows_the_set_and_the_host_exits_when_idle() {
    let tmp = tempfile::tempdir().unwrap();
    let state = tmp.path().join("state");
    let runner = {
        let state = state.clone();
        tokio::spawn(async move {
            run_host(&state, HostOptions { idle_exit_ms: 500, tick: Duration::from_millis(50) }).await
        })
    };
    let control = control_dir(&state);
    let sessions = copies::sessions_path(&control);
    assert!(wait_until_async(Duration::from_secs(10), || copies::read_sessions(&sessions).is_empty() && sessions.is_file()).await);
    let token = local_pipe::read_token_at(&copies::token_path(&control)).unwrap();
    let mut c = connect(&pipe_name(&state), &token).await.unwrap();
    let argv = vec![ping_exe(), "-n".into(), "30".into(), "127.0.0.1".into()];
    let mut req = spawn_req("listed", argv, false);
    if let Request::Spawn { cwd, .. } = &mut req {
        *cwd = Some(tmp.path().to_string_lossy().into_owned());
    }
    c.spawn(req).await.unwrap();
    assert!(
        wait_until_async(Duration::from_secs(10), || {
            copies::read_sessions(&sessions).iter().any(|s| s.name == "listed" && s.cwd.as_deref() == Some(&*tmp.path().to_string_lossy()))
        })
        .await
    );
    c.kill("listed").await.unwrap();
    drop(c);
    let end = tokio::time::timeout(Duration::from_secs(15), runner).await.expect("the idle host exits");
    assert_eq!(end.unwrap().unwrap(), HostEnd::Exited);
    assert!(copies::read_sessions(&sessions).is_empty());
}

/// Run as a child process by [`killing_the_host_process_reaps_its_sessions`]:
/// a real host process on the state dir the env var names. A no-op anywhere
/// else (it is `#[ignore]`d, and returns at once without the variable).
#[test]
#[ignore]
fn child_host_entry() {
    let Ok(state) = std::env::var(CHILD_STATE_ENV) else { return };
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    let _ = rt.block_on(run_host(Path::new(&state), HostOptions::default()));
}

#[tokio::test(flavor = "multi_thread")]
async fn killing_the_host_process_reaps_its_sessions() {
    let tmp = tempfile::tempdir().unwrap();
    let state = tmp.path().join("state");
    let test_name = concat!(module_path!(), "::child_host_entry");
    let test_name = test_name.split_once("::").map_or(test_name, |(_, rest)| rest);
    // The child's output kept, so a host that never came up says why.
    let child_log = tmp.path().join("child-host.log");
    let log_file = std::fs::File::create(&child_log).unwrap();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", test_name, "--ignored", "--nocapture", "--test-threads=1"])
        .env(CHILD_STATE_ENV, &state)
        .stdout(log_file.try_clone().unwrap())
        .stderr(log_file)
        .spawn()
        .unwrap();
    let name = pipe_name(&state);
    let token_path = copies::token_path(&control_dir(&state));
    let mut c = None;
    for _ in 0..1000 {
        if let Ok(token) = local_pipe::read_token_at(&token_path) {
            if let Ok(Ok(client)) = tokio::time::timeout(Duration::from_secs(2), connect(&name, &token)).await {
                c = Some(client);
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let Some(mut c) = c else {
        let exited = child.try_wait();
        let _ = child.kill();
        let _ = child.wait();
        panic!(
            "the child host never came up (exit status {exited:?}, token written: {}); it said:\n{}",
            token_path.exists(),
            std::fs::read_to_string(&child_log).unwrap_or_default()
        );
    };
    assert_ne!(c.welcome().pid, std::process::id(), "a separate host process");
    let ping = ping_outliving_its_console(&mut c, "orphan").await;
    child.kill().unwrap();
    let _ = child.wait();
    assert!(wait_until(Duration::from_secs(10), || !process_alive(ping)), "the session died with its host");
}
