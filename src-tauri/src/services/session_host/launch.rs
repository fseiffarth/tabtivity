//! Getting a client to a running host on Windows (plan §2, Process): the
//! versioned copy, the lazy detached start, the prune of old copies and the
//! retirement of an older host once it is idle.
//!
//! - The host runs from `<control_dir>/session-host/<version>/` (the
//!   sidecar's `control_dir`, staged like the sidecar's own copy): never the
//!   installed exe (the updater replaces it) nor `bin/<version>/` (the
//!   sidecar's install prunes that).
//! - No autostart: the first client that finds no pipe starts the host
//!   `DETACHED_PROCESS | CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP |
//!   CREATE_BREAKAWAY_FROM_JOB` — without the breakaway when the job it runs
//!   in denies it — and retries the pipe for up to 3 s. Either the desktop or
//!   the sidecar may start it; the host's mutex makes a second one exit 0.
//! - A host of an older version is asked `Shutdown{if_idle}`; while it has
//!   sessions it keeps serving (the negotiation already picked a protocol
//!   level both speak) and running agents are never killed for an update.
//! - Anything but "no such pipe" (a host that exists and refuses, or another
//!   user's pipe) is the caller's error: it fails closed rather than starting
//!   a second host (plan §4).

use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use tokio::net::windows::named_pipe::NamedPipeClient;

use super::client::{self, Client, ClientError, Connector};
use super::copies;
use super::protocol::ErrorCode;
use super::route::{self, HostFailure};
use super::win::pipe::{pipe_name, PipeConnector};

/// How long a client waits for a host it started (or found starting).
pub const START_WAIT: Duration = Duration::from_secs(3);
/// How often a start is repeated while the pipe stays absent (a host that
/// was exiting as we started ours makes ours exit at once).
const RESTART_EVERY: Duration = Duration::from_secs(1);

const DETACHED_PROCESS: u32 = 0x0000_0008;
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// `ERROR_ACCESS_DENIED`: the job this process runs in forbids breakaway.
const ERROR_ACCESS_DENIED: i32 = 5;

/// `<control_dir>/session-host/<version>+<build>/<exe>` (the build read from
/// `source`, [`copies::read_build_id`]), staged from `source` when absent or
/// behind it. A rebuilt binary gets a fresh directory, so a copy a running
/// host holds open is never in the way.
pub fn ensure_copy(control_dir: &Path, source: &Path, version: &str) -> Result<PathBuf, String> {
    use crate::commands::mobile_control::{binary_behind, install_binary_copy};
    let dir_name = copies::identity(version, copies::read_build_id(source).as_deref());
    let target = copies::copy_path(control_dir, &dir_name);
    if target.is_file() && !binary_behind(&target, source) {
        return Ok(target);
    }
    let dir = target.parent().ok_or("session host copy has no folder")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    match install_binary_copy(source, dir, &copies::exe_name()) {
        Ok(path) => Ok(path),
        Err(_) if target.is_file() => Ok(target),
        Err(e) => Err(e),
    }
}

/// How the last detached start went ([`last_start`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StartOutcome {
    /// Started outside this process's job.
    pub breakaway: bool,
    /// Started inside a job that kills its members when it closes: the host,
    /// and every session in it, end with whatever owns that job (an IDE, a
    /// terminal) — no longer independent of this process.
    pub dies_with_parent_job: bool,
}

static LAST_START: std::sync::Mutex<Option<StartOutcome>> = std::sync::Mutex::new(None);

/// The outcome of this process's last [`start_detached`], for status.
pub fn last_start() -> Option<StartOutcome> {
    *LAST_START.lock().unwrap_or_else(|e| e.into_inner())
}

/// Whether this process runs in a job with `KILL_ON_JOB_CLOSE`.
fn own_job_kills_on_close() -> bool {
    use windows::Win32::System::JobObjects::{
        JobObjectExtendedLimitInformation, QueryInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    // SAFETY: a NULL job names this process's own job; the struct is sized
    // for the class and outlives the call.
    let ok = unsafe {
        QueryInformationJobObject(
            None,
            JobObjectExtendedLimitInformation,
            (&mut info as *mut JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            None,
        )
        .is_ok()
    };
    ok && info.BasicLimitInformation.LimitFlags.0 & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.0 != 0
}

/// Spawns `exe args…` from `exe`'s folder with no stdio, detached from this
/// process, its console and its job; without the breakaway when the job
/// denies it. The environment is scrubbed to what the host needs
/// ([`route::host_process_env`]): the starter may be a desktop that is about
/// to spawn an agent with API keys, and none of that belongs to the host.
fn spawn_detached(exe: &Path, args: &[&str]) -> io::Result<(std::process::Child, StartOutcome)> {
    use std::os::windows::process::CommandExt;
    let base = DETACHED_PROCESS | CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP;
    let env = route::host_process_env(
        std::env::vars_os().filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?))),
    );
    let spawn = |flags: u32| {
        let mut cmd = Command::new(exe);
        cmd.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).creation_flags(flags);
        cmd.env_clear().envs(env.iter().map(|(k, v)| (k, v)));
        if let Some(dir) = exe.parent() {
            cmd.current_dir(dir);
        }
        cmd.spawn()
    };
    match spawn(base | CREATE_BREAKAWAY_FROM_JOB) {
        Ok(child) => Ok((child, StartOutcome { breakaway: true, dies_with_parent_job: false })),
        Err(e) if e.raw_os_error() == Some(ERROR_ACCESS_DENIED) => {
            let child = spawn(base)?;
            let outcome = StartOutcome { breakaway: false, dies_with_parent_job: own_job_kills_on_close() };
            if outcome.dies_with_parent_job {
                eprintln!(
                    "session host: started inside this process's kill-on-close job (breakaway denied); \
                     its sessions end when that job closes"
                );
            }
            Ok((child, outcome))
        }
        Err(e) => Err(e),
    }
}

/// Starts `exe --session-host` detached ([`spawn_detached`]); the outcome is
/// kept for [`last_start`].
pub fn start_detached(exe: &Path) -> io::Result<()> {
    let (_child, outcome) = spawn_detached(exe, &[super::MODE_FLAG])?;
    *LAST_START.lock().unwrap_or_else(|e| e.into_inner()) = Some(outcome);
    Ok(())
}

/// Removes the copies older than `ours`, except `running` ones. Best-effort:
/// a copy that will not delete (a host still running from it) is retried by
/// the next prune.
pub fn prune_copies(control_dir: &Path, ours: &str, running: &[&str]) {
    let root = copies::host_root(control_dir);
    let Ok(entries) = std::fs::read_dir(&root) else { return };
    let dirs: Vec<String> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    for dir in copies::prunable(dirs.iter().map(String::as_str), ours, running) {
        let _ = std::fs::remove_dir_all(root.join(dir));
    }
}

/// What a client needs to reach (and if need be start) the host.
#[derive(Debug, Clone)]
pub struct Launch {
    pub state_dir: PathBuf,
    pub control_dir: PathBuf,
    /// The binary a copy is staged from (this process's own image).
    pub source: PathBuf,
    pub version: String,
}

impl Launch {
    /// For this process: its image, its version, `state_dir`'s control dir.
    pub fn here(state_dir: &Path) -> Result<Self, String> {
        Ok(Self {
            state_dir: state_dir.to_path_buf(),
            control_dir: crate::services::mobile_control::config::control_dir_for(state_dir),
            source: crate::commands::mobile_control::mobile_binary_source()?,
            version: env!("CARGO_PKG_VERSION").to_string(),
        })
    }

    pub fn pipe_name(&self) -> String {
        pipe_name(&self.state_dir)
    }

    /// `<version>+<build>` of [`Self::source`] ([`copies::identity`]): what
    /// this client greets with and compares a host's version against.
    pub fn identity(&self) -> String {
        copies::identity(&self.version, copies::read_build_id(&self.source).as_deref())
    }

    /// Stages this version's copy and starts it.
    pub fn start(&self) -> io::Result<()> {
        let exe = ensure_copy(&self.control_dir, &self.source, &self.version).map_err(io::Error::other)?;
        start_detached(&exe)
    }

    /// [`LazyConnector`] that starts through [`Self::start`].
    pub fn connector(&self) -> LazyConnector<impl Fn() -> io::Result<()> + Send + Sync + '_> {
        LazyConnector::new(self.pipe_name(), || self.start())
    }
}

/// Opens the pipe; on "no such pipe" runs `start` (again every second while
/// it stays absent) and retries for up to [`START_WAIT`].
pub struct LazyConnector<S> {
    pipe: PipeConnector,
    start: S,
    wait: Duration,
}

impl<S: Fn() -> io::Result<()> + Send + Sync> LazyConnector<S> {
    pub fn new(name: String, start: S) -> Self {
        Self { pipe: PipeConnector { name }, start, wait: START_WAIT }
    }
}

impl<S: Fn() -> io::Result<()> + Send + Sync> Connector for LazyConnector<S> {
    type Io = NamedPipeClient;
    async fn connect(&self) -> io::Result<NamedPipeClient> {
        let deadline = tokio::time::Instant::now() + self.wait;
        let mut last_start: Option<tokio::time::Instant> = None;
        loop {
            match self.pipe.connect().await {
                Ok(io) => return Ok(io),
                Err(e) if e.kind() == io::ErrorKind::NotFound => {
                    let now = tokio::time::Instant::now();
                    if now >= deadline {
                        return Err(io::Error::new(io::ErrorKind::TimedOut, "the session host did not come up"));
                    }
                    if last_start.is_none_or(|t| now - t >= RESTART_EVERY) {
                        last_start = Some(now);
                        (self.start)()?;
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                Err(e) => return Err(e),
            }
        }
    }
}

/// Connects through `connector` and greets the host with the token it wrote.
#[cfg(test)]
async fn greet<C: Connector<Io = NamedPipeClient>>(
    connector: &C,
    control_dir: &Path,
    version: &str,
) -> client::Result<Client<NamedPipeClient>> {
    greet_from(connector, control_dir, version, super::protocol::PROTO_MIN).await
}

/// [`greet`] offering protocol levels from `proto_min` up.
async fn greet_from<C: Connector<Io = NamedPipeClient>>(
    connector: &C,
    control_dir: &Path,
    version: &str,
    proto_min: u32,
) -> client::Result<Client<NamedPipeClient>> {
    let io = connector.connect().await?;
    // Read after the pipe opened: the host writes it before binding.
    let token = crate::services::local_pipe::read_token_at(&copies::token_path(control_dir))
        .map_err(|e| ClientError::Io(io::Error::other(e)))?;
    Client::handshake_from(io, &token, version, proto_min).await
}

/// Waits (bounded) until no host answers on `name`.
async fn wait_pipe_gone(name: &str, wait: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        match crate::services::local_pipe::open_client(name).await {
            Err(e) if e.kind() == io::ErrorKind::NotFound => return true,
            _ if tokio::time::Instant::now() >= deadline => return false,
            _ => tokio::time::sleep(Duration::from_millis(50)).await,
        }
    }
}

/// Whether `e` means the host is on its way out — it closed the connection
/// before `Welcome`, the pipe broke, or it refused a `Spawn` as
/// [`super::server::SHUTTING_DOWN`] — so a fresh connection (which starts a
/// new host if need be) is the answer, not an error to show.
pub fn host_is_leaving(e: &ClientError) -> bool {
    match e {
        ClientError::Closed => true,
        ClientError::Io(io) => matches!(
            io.kind(),
            io::ErrorKind::BrokenPipe | io::ErrorKind::ConnectionReset | io::ErrorKind::UnexpectedEof
        ),
        ClientError::Host { code: ErrorCode::Busy, msg } => msg == super::server::SHUTTING_DOWN,
        _ => false,
    }
}

/// [`greet`], again while the host is leaving ([`host_is_leaving`]): each
/// round is another lazy connect, which starts the next host once the pipe
/// is gone. Bounded by twice [`START_WAIT`].
async fn greet_retrying<C: Connector<Io = NamedPipeClient>>(
    connector: &C,
    control_dir: &Path,
    version: &str,
    proto_min: u32,
) -> client::Result<Client<NamedPipeClient>> {
    let deadline = tokio::time::Instant::now() + START_WAIT * 2;
    loop {
        match greet_from(connector, control_dir, version, proto_min).await {
            Err(e) if host_is_leaving(&e) && tokio::time::Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            other => return other,
        }
    }
}

/// The client half of [`connect_host`], over any connector: greet (riding
/// out a host that is leaving), retire an older idle host and reconnect,
/// prune. `version` is the client's identity (`<version>+<build>`,
/// [`Launch::identity`]); a bare version works, without build retirement.
pub async fn connect_with<C: Connector<Io = NamedPipeClient>>(
    connector: &C,
    name: &str,
    control_dir: &Path,
    version: &str,
) -> client::Result<Client<NamedPipeClient>> {
    connect_with_from(connector, name, control_dir, version, super::protocol::PROTO_MIN).await
}

/// [`connect_with`] offering protocol levels from `proto_min` up (a
/// connection that only ends sessions: [`super::protocol::REAP_PROTO_MIN`]).
pub async fn connect_with_from<C: Connector<Io = NamedPipeClient>>(
    connector: &C,
    name: &str,
    control_dir: &Path,
    version: &str,
    proto_min: u32,
) -> client::Result<Client<NamedPipeClient>> {
    let mut client = greet_retrying(connector, control_dir, version, proto_min).await?;
    if copies::should_retire(&client.welcome().host_version, version) {
        match client.shutdown(true).await {
            Ok(()) => {
                drop(client);
                // The old host leaves within its tick; then ours starts.
                wait_pipe_gone(name, START_WAIT).await;
                client = greet_retrying(connector, control_dir, version, proto_min).await?;
            }
            // Sessions are running: the old host keeps serving.
            Err(ClientError::Host { code: ErrorCode::Busy, .. }) => {}
            Err(e) => return Err(e),
        }
    }
    let host_version = client.welcome().host_version.clone();
    prune_copies(control_dir, version, &[version, host_version.as_str()]);
    Ok(client)
}

/// A greeted connection that only asks: it rides out a host that is
/// leaving, but never retires one, never prunes and — over a connector that
/// starts nothing — never starts one (the session mux's queries: a listing
/// under the catalog's lock must not take a host down or wait on one).
pub async fn connect_query<C: Connector<Io = NamedPipeClient>>(
    connector: &C,
    control_dir: &Path,
    version: &str,
    proto_min: u32,
) -> client::Result<Client<NamedPipeClient>> {
    greet_retrying(connector, control_dir, version, proto_min).await
}

/// A greeted connection to this state dir's host, started if absent.
pub async fn connect_host(launch: &Launch) -> client::Result<Client<NamedPipeClient>> {
    connect_with(&launch.connector(), &launch.pipe_name(), &launch.control_dir, &launch.identity()).await
}

/// The whole classified connect, a lazy start and a retirement included,
/// never runs past this.
const CONNECT_CAP: Duration = Duration::from_secs(20);

/// A connector that notes when the pipe opened (the start of the handshake
/// deadline).
struct Tracking<'a, C> {
    inner: C,
    opened_at: &'a std::sync::Mutex<Option<std::time::Instant>>,
}

impl<C: Connector> Connector for Tracking<'_, C> {
    type Io = C::Io;
    async fn connect(&self) -> io::Result<C::Io> {
        let io = self.inner.connect().await?;
        *self.opened_at.lock().unwrap_or_else(|e| e.into_inner()) = Some(std::time::Instant::now());
        Ok(io)
    }
}

/// [`connect_host`], with a failure classified for the fallback rule
/// ([`route::classify_connect`]). "Silent" is precise: the pipe opened and
/// no `Welcome` came within `handshake` (or the connect ran past
/// [`CONNECT_CAP`] after opening it); "absent": the copy could not be staged
/// or started, the pipe never came up, or no protocol level is shared.
pub async fn connect_classified(
    launch: &Launch,
    handshake: Duration,
) -> Result<Client<NamedPipeClient>, HostFailure> {
    use std::sync::atomic::{AtomicBool, Ordering};
    let opened_at = std::sync::Mutex::new(None);
    let start_failed = AtomicBool::new(false);
    let start = || {
        let started = launch.start();
        if started.is_err() {
            start_failed.store(true, Ordering::SeqCst);
        }
        started
    };
    let connector = Tracking { inner: LazyConnector::new(launch.pipe_name(), start), opened_at: &opened_at };
    let name = launch.pipe_name();
    let identity = launch.identity();
    let connecting = connect_with(&connector, &name, &launch.control_dir, &identity);
    let opened = || opened_at.lock().unwrap_or_else(|e| e.into_inner()).is_some();
    let watchdog = async {
        let began = std::time::Instant::now();
        loop {
            tokio::time::sleep(Duration::from_millis(50)).await;
            let at = *opened_at.lock().unwrap_or_else(|e| e.into_inner());
            if at.is_some_and(|t| t.elapsed() >= handshake) || began.elapsed() >= CONNECT_CAP {
                return;
            }
        }
    };
    tokio::select! {
        res = connecting => res.map_err(|e| route::classify_connect(opened(), start_failed.load(Ordering::SeqCst), &e)),
        () = watchdog => Err(if opened() {
            HostFailure::Silent("the session host does not answer".into())
        } else {
            HostFailure::Absent("the session host did not come up".into())
        }),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use super::*;
    use crate::services::session_host::server::{Host, HostConfig};
    use crate::services::session_host::table::SystemClock;
    use crate::services::session_host::win::conpty::ConPtySpawner;
    use crate::services::session_host::win::pipe::{serve, Listener};
    use crate::services::session_host::win::test_support::{ping_exe, process_alive, wait_until};

    #[test]
    fn a_copy_is_staged_once_and_restaged_when_behind() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("src.bin");
        std::fs::write(&source, b"build one").unwrap();
        let control = tmp.path().join("control");
        let copy = ensure_copy(&control, &source, "1.0.0").unwrap();
        assert_eq!(copy, copies::copy_path(&control, "1.0.0"));
        assert_eq!(std::fs::read(&copy).unwrap(), b"build one");
        std::fs::write(&source, b"build two, longer").unwrap();
        ensure_copy(&control, &source, "1.0.0").unwrap();
        assert_eq!(std::fs::read(&copy).unwrap(), b"build two, longer");
        assert!(!control.join("bin").exists(), "the sidecar's bin is not touched");
    }

    #[test]
    fn prune_keeps_ours_the_running_one_and_files() {
        let tmp = tempfile::tempdir().unwrap();
        let control = tmp.path();
        for v in ["0.1.0", "0.1.1", "0.1.2", "0.2.0"] {
            std::fs::create_dir_all(copies::host_root(control).join(v)).unwrap();
        }
        std::fs::write(copies::token_path(control), b"t").unwrap();
        prune_copies(control, "0.1.2", &["0.1.2", "0.1.0"]);
        let root = copies::host_root(control);
        assert!(root.join("0.1.0").exists());
        assert!(!root.join("0.1.1").exists());
        assert!(root.join("0.1.2").exists());
        assert!(root.join("0.2.0").exists());
        assert!(copies::token_path(control).exists());
    }

    /// The detached start (breakaway, or its fallback) really runs the
    /// program: it leaves a marker, and is waited for before the temp
    /// folder goes.
    #[test]
    fn a_detached_start_runs_the_program() {
        let tmp = tempfile::tempdir().unwrap();
        let marker = tmp.path().join("ran.txt");
        let cmd = crate::services::session_host::win::test_support::cmd_exe();
        let marker_arg = marker.to_string_lossy().into_owned();
        let (mut child, outcome) =
            spawn_detached(Path::new(&cmd), &["/c", "type", "nul", ">", marker_arg.as_str()]).unwrap();
        assert!(child.wait().unwrap().success());
        assert!(marker.is_file(), "the detached program ran");
        if outcome.breakaway {
            assert!(!outcome.dies_with_parent_job);
        }
    }

    #[test]
    fn a_rebuilt_binary_gets_its_own_copy_beside_the_running_one() {
        use std::os::windows::fs::OpenOptionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let control = tmp.path().join("control");
        let source = tmp.path().join("app.exe");
        let pe = |stamp: u32| {
            let mut head = vec![0u8; 0x200];
            head[..2].copy_from_slice(b"MZ");
            head[0x3c..0x40].copy_from_slice(&0x80u32.to_le_bytes());
            head[0x80..0x84].copy_from_slice(b"PE\0\0");
            head[0x88..0x8c].copy_from_slice(&stamp.to_le_bytes());
            head
        };
        std::fs::write(&source, pe(1)).unwrap();
        let first = ensure_copy(&control, &source, "1.0.0").unwrap();
        // A host runs from the first copy: its file stays locked open.
        let held = std::fs::OpenOptions::new().read(true).share_mode(0).open(&first).unwrap();
        std::fs::write(&source, pe(2)).unwrap();
        let second = ensure_copy(&control, &source, "1.0.0").unwrap();
        assert_ne!(first, second, "a new build has its own directory");
        assert_eq!(std::fs::read(&second).unwrap(), pe(2));
        let first_dir = first.parent().unwrap().file_name().unwrap().to_string_lossy().into_owned();
        let second_dir = second.parent().unwrap().file_name().unwrap().to_string_lossy().into_owned();
        assert!(copies::should_retire(&first_dir, &second_dir), "{first_dir} vs {second_dir}");
        drop(held);
    }

    fn unique_state(tmp: &Path) -> PathBuf {
        tmp.join("state")
    }

    /// An in-process host on `state_dir`'s pipe answering as `version`.
    fn bind_host(state_dir: &Path, control_dir: &Path, version: &str) -> Host {
        let token = crate::services::local_pipe::create_token_at(&copies::token_path(control_dir)).unwrap();
        let host = Host::new(HostConfig::new(token, version, std::process::id()), ConPtySpawner, Arc::new(SystemClock));
        let listener = Listener::bind(&pipe_name(state_dir)).unwrap();
        let accept = tokio::spawn(serve(host.clone(), listener));
        // As `run_host`: once `tick` says exit, the pipe goes.
        let ticking = host.clone();
        tokio::spawn(async move {
            ticking.run_ticks(Duration::from_millis(50)).await;
            accept.abort();
        });
        host
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn no_pipe_starts_the_host_once_and_connects() {
        let tmp = tempfile::tempdir().unwrap();
        let state = unique_state(tmp.path());
        let control = tmp.path().join("control");
        let starts = Arc::new(AtomicUsize::new(0));
        let rt = tokio::runtime::Handle::current();
        let start = {
            let (starts, state, control) = (starts.clone(), state.clone(), control.clone());
            move || {
                if starts.fetch_add(1, Ordering::SeqCst) == 0 {
                    let (state, control) = (state.clone(), control.clone());
                    rt.spawn(async move {
                        tokio::time::sleep(Duration::from_millis(200)).await;
                        bind_host(&state, &control, env!("CARGO_PKG_VERSION"));
                    });
                }
                Ok(())
            }
        };
        let connector = LazyConnector::new(pipe_name(&state), start);
        let c = connect_with(&connector, &pipe_name(&state), &control, env!("CARGO_PKG_VERSION")).await.unwrap();
        assert_eq!(c.welcome().host_version, env!("CARGO_PKG_VERSION"));
        assert_eq!(starts.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_host_that_never_comes_is_a_timeout_not_a_hang() {
        let tmp = tempfile::tempdir().unwrap();
        let state = unique_state(tmp.path());
        let mut connector = LazyConnector::new(pipe_name(&state), || Ok(()));
        connector.wait = Duration::from_millis(300);
        let err = connector.connect().await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_older_busy_host_is_kept_and_an_older_idle_one_retired() {
        let tmp = tempfile::tempdir().unwrap();
        let state = unique_state(tmp.path());
        let control = tmp.path().join("control");
        bind_host(&state, &control, "0.0.1");
        let name = pipe_name(&state);
        // The "start" of the newer host this client would run.
        let rt = tokio::runtime::Handle::current();
        let start = {
            let (state, control) = (state.clone(), control.clone());
            move || {
                let (state, control) = (state.clone(), control.clone());
                rt.spawn(async move { bind_host(&state, &control, "9.9.9") });
                Ok(())
            }
        };
        let connector = LazyConnector::new(name.clone(), start);

        // Busy: a session runs, so the old host stays and serves.
        let mut c = greet(&connector, &control, "9.9.9").await.unwrap();
        let spawn = crate::services::session_host::protocol::Request::Spawn {
            name: "busy".into(),
            argv: vec![ping_exe(), "-n".into(), "30".into(), "127.0.0.1".into()],
            env: crate::services::session_host::win::test_support::current_env(),
            cwd: None,
            cols: 80,
            rows: 24,
            remain_on_exit: false,
            size_policy: Default::default(),
            create_only: false,
            mcp_mark: None,
        };
        assert!(c.spawn(spawn).await.unwrap());
        let pid = c.info("busy").await.unwrap().pid.unwrap();
        let again = connect_with(&connector, &name, &control, "9.9.9").await.unwrap();
        assert_eq!(again.welcome().host_version, "0.0.1");
        assert!(process_alive(pid), "a running agent is never killed for an update");

        // Idle: the old host shuts down and the newer one takes over.
        c.kill("busy").await.unwrap();
        assert!(wait_until(Duration::from_secs(10), || !process_alive(pid)));
        drop((c, again));
        let newer = connect_with(&connector, &name, &control, "9.9.9").await.unwrap();
        assert_eq!(newer.welcome().host_version, "9.9.9");
    }
}
