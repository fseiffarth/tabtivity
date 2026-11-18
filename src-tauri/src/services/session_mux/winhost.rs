//! The Windows backend: the native session host (`services/session_host/`,
//! plan §2) behind the experimental `windows_session_host` setting.
//!
//! [`SessionMux::available`] is cheap and starts nothing: the flag is on and a
//! host copy can be made (this binary is readable). With the flag off every
//! call is [`MuxError::Unavailable`] — exactly today's Windows behaviour.
//!
//! Each call is one connection on a thread of its own with a current-thread
//! runtime (callers are sync, some on an async worker), under
//! [`CALL_DEADLINE`]. Queries never start the host: no pipe is
//! [`MuxError::NoServer`]. `wrap` and `spawn_detached` may start it.
//!
//! `wrap` only **marks** a launch (`PtyOptions::mux_wrapped`), its argv
//! untouched: `terminal::spawn_pty` then opens the tab as a pipe-backed
//! stream ([`open_tab`], `terminal::host_pty`) — a create-or-attach `Spawn`
//! carrying the argv, environment and cwd over the authenticated pipe, then
//! `Attach`. The release exe is GUI-subsystem and gets no console in a
//! ConPTY, so no attach client runs (plan, P0 outcome). A launch the host may
//! not run (a batch file) stays unmarked, in-process. A viewer that is not a
//! tab (the phone's bridge) attaches with [`SessionMux::attach_stream`];
//! [`SessionMux::attach_client`] is `Unavailable` here.
//!
//! MCP stamps (`root_mcp_mark`): the `Spawn` carries `PtyOptions::mcp_mark`
//! and the host keeps it only when that `Spawn` creates the session;
//! [`SessionMux::mcp_marks`] is one `List` (cached [`MARKS_TTL`] per pipe), and
//! "unknown" from a host without `CAP_MCP_MARK` or where no host runs or will
//! run (`route::marks_answer`).

use std::future::Future;
use std::path::PathBuf;
use std::time::Duration;

use tokio::net::windows::named_pipe::NamedPipeClient;

use super::{ClientCmd, Key, MuxError, MuxKind, MuxStream, PaneInfo, SessionInfo, SessionMarks, SessionMux};
use crate::services::session_host::client::{Client, ClientError};
use crate::services::session_host::launch::{self, Launch};
use crate::services::session_host::protocol::{ErrorCode, SizePolicy};
use crate::services::session_host::route::{self, HostFailure, HostSpawn};
use crate::services::session_host::win::pipe::PipeConnector;
use crate::services::session_host::copies;
use crate::terminal::host_pty::{self, HostPty};
use crate::terminal::PtyOptions;

/// No mux call waits longer (a lazy start is ≤ 3 s of it).
pub const CALL_DEADLINE: Duration = Duration::from_secs(15);
/// A listing never waits longer: it runs under the phone catalog's lock,
/// in front of every catalog-backed route (tmux's `LIST_TIMEOUT` twin).
pub const LIST_DEADLINE: Duration = Duration::from_secs(3);
/// Opening a tab's stream — connect (a lazy start, a retirement), `Spawn`,
/// `Attach` — never takes longer; past it the spawn fails closed.
pub const OPEN_DEADLINE: Duration = Duration::from_secs(25);
/// The `settings.json` key of the experimental switch.
pub const SETTING_KEY: &str = "windows_session_host";
/// How long a [`SessionMux::mcp_marks`] listing is reused (tmux's twin): a
/// restore's burst of tabs reads one `List`.
pub const MARKS_TTL: Duration = Duration::from_secs(3);

/// A stamp listing per host pipe, with when it was read.
type MarksCache = std::collections::HashMap<String, (std::time::Instant, SessionMarks)>;

/// The last stamp listing of each host pipe (one in the app; tests run several).
static MARKS: std::sync::Mutex<Option<MarksCache>> = std::sync::Mutex::new(None);

fn marks_cache() -> std::sync::MutexGuard<'static, Option<MarksCache>> {
    MARKS.lock().unwrap_or_else(|p| p.into_inner())
}

impl WinHostMux {
    /// Forget this host's cached listing (a session was made, killed or
    /// renamed under it).
    fn forget_marks(&self) {
        if let (Ok(launch), Some(cache)) = (self.launch.as_ref(), marks_cache().as_mut()) {
            cache.remove(&launch.pipe_name());
        }
    }
}

/// Whether the mux is switched on.
#[derive(Debug, Clone)]
enum Gate {
    /// `settings.json`'s [`SETTING_KEY`], read per call.
    Settings(PathBuf),
    #[cfg(test)]
    Always,
}

pub struct WinHostMux {
    launch: Result<Launch, String>,
    gate: Gate,
}

/// Whether the `settings.json` at `path` turns the session host on. Unset,
/// unreadable or not `true` is off.
pub fn flag_on(path: &std::path::Path) -> bool {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|settings| settings.get(SETTING_KEY)?.as_bool())
        .unwrap_or(false)
}

fn unavailable() -> MuxError {
    MuxError::Unavailable("the Windows session host is not enabled".into())
}

fn mux_err(e: ClientError) -> MuxError {
    match e {
        ClientError::Io(e) if e.kind() == std::io::ErrorKind::NotFound => MuxError::NoServer,
        ClientError::Host { code: ErrorCode::NotFound, .. } => MuxError::NotFound,
        ClientError::Host { msg, .. } => MuxError::Refused(msg),
        other => MuxError::Io(other.to_string()),
    }
}

/// Runs `f` to completion on a fresh thread and runtime, under [`CALL_DEADLINE`].
fn block<T, F, Fut>(f: F) -> Result<T, MuxError>
where
    T: Send + 'static,
    F: FnOnce() -> Fut + Send + 'static,
    Fut: Future<Output = Result<T, MuxError>>,
{
    block_within(CALL_DEADLINE, f)
}

/// [`block`] under `deadline`.
fn block_within<T, F, Fut>(deadline: Duration, f: F) -> Result<T, MuxError>
where
    T: Send + 'static,
    F: FnOnce() -> Fut + Send + 'static,
    Fut: Future<Output = Result<T, MuxError>>,
{
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| MuxError::Io(format!("session host runtime: {e}")))?;
        rt.block_on(async {
            tokio::time::timeout(deadline, f())
                .await
                .unwrap_or_else(|_| Err(MuxError::Io("the session host did not answer in time".into())))
        })
    })
    .join()
    .unwrap_or_else(|_| Err(MuxError::Io("session host call panicked".into())))
}

/// A greeted connection that never starts the host, never retires one and
/// never prunes (`launch::connect_query`).
async fn query(launch: &Launch) -> Result<Client<NamedPipeClient>, MuxError> {
    query_from(launch, crate::services::session_host::protocol::PROTO_MIN).await
}

/// [`query`] offering protocol levels from `proto_min` up.
async fn query_from(launch: &Launch, proto_min: u32) -> Result<Client<NamedPipeClient>, MuxError> {
    let name = launch.pipe_name();
    let connector = PipeConnector { name: name.clone() };
    launch::connect_query(&connector, &launch.control_dir, &launch.identity(), proto_min).await.map_err(mux_err)
}

/// The `Spawn` a launch of `opts` hands the host: what an in-process spawn
/// would have run, or why the host may not run it.
pub fn host_spawn_for(opts: &PtyOptions, name: &str) -> Result<HostSpawn, String> {
    let cmd = crate::terminal::launch_command(opts);
    let argv: Vec<String> = cmd.get_argv().iter().map(|a| a.to_string_lossy().into_owned()).collect();
    let argv = route::host_argv(argv, |bare| {
        crate::paths::resolve_executable(bare).map(|p| p.to_string_lossy().into_owned())
    })?;
    let cwd = cmd.get_cwd().map(|c| c.to_string_lossy().into_owned()).filter(|c| !c.is_empty());
    Ok(HostSpawn {
        name: name.to_string(),
        argv,
        env: route::host_env(cmd.iter_full_env_as_str()),
        cwd,
        // Every agent tab keeps its pane but an assistant chat (plan, Defaults 4).
        remain_on_exit: opts.assistant.is_none(),
        size_policy: SizePolicy::Latest,
        // Kept by the host only if this Spawn creates the session.
        mcp_mark: opts.mcp_mark.clone(),
    })
}

impl WinHostMux {
    /// This machine's: this state dir's host, gated by its settings.
    pub fn here() -> Self {
        let state_dir = crate::storage::state_dir();
        Self { launch: Launch::here(&state_dir), gate: Gate::Settings(state_dir.join("settings.json")) }
    }

    /// Always on, over `launch` (tests).
    #[cfg(test)]
    pub fn with_launch(launch: Launch) -> Self {
        Self { launch: Ok(launch), gate: Gate::Always }
    }

    /// Over `launch`, with its setting off (no `settings.json`): a host that
    /// still runs keeps its sessions reachable (tests elsewhere).
    #[cfg(test)]
    pub fn switched_off(launch: Launch) -> Self {
        let settings = launch.state_dir.join("settings.json");
        Self { launch: Ok(launch), gate: Gate::Settings(settings) }
    }

    fn enabled(&self) -> bool {
        match &self.gate {
            Gate::Settings(path) => flag_on(path),
            #[cfg(test)]
            Gate::Always => true,
        }
    }

    /// The launch when the mux is on and a copy can be made.
    fn ready(&self) -> Result<Launch, MuxError> {
        let launch = self.launch.as_ref().map_err(|e| MuxError::Unavailable(e.clone()))?;
        if !self.enabled() {
            return Err(unavailable());
        }
        let copy = copies::copy_path(&launch.control_dir, &launch.identity());
        if !copy.is_file() && !launch.source.is_file() {
            return Err(MuxError::Unavailable("no session host binary to copy".into()));
        }
        Ok(launch.clone())
    }

    /// The launch whatever the setting says: what ends or finds sessions a
    /// running host still holds (the setting may have been turned off since).
    fn reachable(&self) -> Result<Launch, MuxError> {
        self.launch.clone().map_err(MuxError::Unavailable)
    }

    /// A tab's stream onto its session (see [`open_tab`]). `attach_only`
    /// sends no `Spawn` (a rejoin while the AI switch is off, or a live
    /// session found while the setting is off): it never creates, never
    /// starts the host, needs no setting, and never falls back.
    pub fn open_tab(&self, opts: &PtyOptions, attach_only: bool) -> Result<HostPty, HostFailure> {
        let Some(name) = opts.tmux_session.clone().filter(|n| check_name(n).is_ok()) else {
            return Err(HostFailure::Refused(format!("terminal: tab '{}' has no valid session name", opts.id)));
        };
        let (cols, rows) = (if opts.cols == 0 { 80 } else { opts.cols }, if opts.rows == 0 { 24 } else { opts.rows });
        if attach_only {
            let launch = self.reachable().map_err(|e| HostFailure::Refused(e.to_string()))?;
            return host_pty::open(
                move || async move {
                    let refused = |e: MuxError| match e {
                        MuxError::NoServer | MuxError::NotFound => {
                            HostFailure::Refused(format!("session '{name}' has ended; start the tab again"))
                        }
                        e => HostFailure::Silent(e.to_string()),
                    };
                    let client = query(&launch).await.map_err(refused)?;
                    let attached = client.attach(&name, cols, rows, 0).await.map_err(|e| refused(mux_err(e)))?;
                    Ok((attached, false))
                },
                OPEN_DEADLINE,
            );
        }
        let launch = match self.ready() {
            Ok(launch) => launch,
            // Switched off after the launch was marked: a session may run,
            // so never the in-process fallback; a retry decides afresh.
            Err(_) if !self.enabled() => {
                return Err(HostFailure::Silent("the session host was switched off while the tab started".into()))
            }
            Err(e) => return Err(HostFailure::Absent(e.to_string())),
        };
        let spawn = host_spawn_for(opts, &name).map_err(HostFailure::Refused)?;
        host_pty::open(
            move || async move {
                let mut client = launch::connect_classified(&launch, route::HANDSHAKE_DEADLINE).await?;
                let created = client.spawn(spawn.request(cols, rows)).await.map_err(|e| route::classify_request(&e))?;
                let attached = client.attach(&name, cols, rows, 0).await.map_err(|e| route::classify_request(&e))?;
                Ok((attached, created))
            },
            OPEN_DEADLINE,
        )
    }

    /// One request on a query connection to any running host, setting or
    /// not, offering levels from `proto_min` up: what `has`, `kill` and the
    /// quit reap use, so a session outlives no switch.
    fn ask_any<T, F, Fut>(&self, proto_min: u32, f: F) -> Result<T, MuxError>
    where
        T: Send + 'static,
        F: FnOnce(Client<NamedPipeClient>) -> Fut + Send + 'static,
        Fut: Future<Output = Result<T, ClientError>>,
    {
        self.ask_any_within(CALL_DEADLINE, proto_min, f)
    }

    /// [`Self::ask_any`] under `deadline`.
    fn ask_any_within<T, F, Fut>(&self, deadline: Duration, proto_min: u32, f: F) -> Result<T, MuxError>
    where
        T: Send + 'static,
        F: FnOnce(Client<NamedPipeClient>) -> Fut + Send + 'static,
        Fut: Future<Output = Result<T, ClientError>>,
    {
        let launch = self.reachable()?;
        block_within(deadline, move || async move { f(query_from(&launch, proto_min).await?).await.map_err(mux_err) })
    }

    /// A read or a keystroke on a session a running host holds, setting or
    /// not: with the setting off a live session stays visible and reachable
    /// on the phone (listed, attached, typed into by the scheduler) until it
    /// ends; only new sessions need the setting.
    fn ask_live<T, F, Fut>(&self, f: F) -> Result<T, MuxError>
    where
        T: Send + 'static,
        F: FnOnce(Client<NamedPipeClient>) -> Fut + Send + 'static,
        Fut: Future<Output = Result<T, ClientError>>,
    {
        self.ask_any(crate::services::session_host::protocol::PROTO_MIN, f)
    }

    /// One request on a query connection.
    fn ask<T, F, Fut>(&self, f: F) -> Result<T, MuxError>
    where
        T: Send + 'static,
        F: FnOnce(Client<NamedPipeClient>) -> Fut + Send + 'static,
        Fut: Future<Output = Result<T, ClientError>>,
    {
        let launch = self.ready()?;
        block(move || async move { f(query(&launch).await?).await.map_err(mux_err) })
    }
}

fn check_name(name: &str) -> Result<(), MuxError> {
    if crate::services::ssh_exec::valid_tmux_session_name(name) {
        Ok(())
    } else {
        Err(MuxError::Refused(format!("invalid session name '{name}'")))
    }
}

fn secs(ms: u64) -> u64 {
    ms / 1000
}

impl SessionMux for WinHostMux {
    fn kind(&self) -> MuxKind {
        MuxKind::WinHost
    }

    fn available(&self) -> bool {
        self.ready().is_ok()
    }

    /// A host started while the setting was on keeps its sessions after it
    /// is turned off: `has`, `kill` and the quit reap still reach it.
    fn holds_sessions(&self) -> bool {
        self.launch.is_ok()
    }

    fn wrap(&self, opts: &mut PtyOptions) {
        let Some(name) = opts.tmux_session.clone() else { return };
        if check_name(&name).is_err() {
            return;
        }
        if self.ready().is_err() {
            return;
        }
        if let Err(why) = host_spawn_for(opts, &name) {
            eprintln!("session_mux: '{name}' stays in-process: {why}");
            return;
        }
        // The argv stays: `terminal::spawn_pty` sends it in the `Spawn`.
        opts.mux_wrapped = true;
    }

    fn spawn_detached(&self, opts: &PtyOptions) -> Result<(), MuxError> {
        let Some(name) = opts.tmux_session.clone() else {
            return Err(MuxError::Refused(format!("terminal: tab '{}' has no session to start", opts.id)));
        };
        check_name(&name)?;
        let launch = self.ready()?;
        let spawn = host_spawn_for(opts, &name).map_err(MuxError::Refused)?;
        let (cols, rows) = (opts.cols.max(1), opts.rows.max(1));
        let spawned = block(move || async move {
            let mut client = launch::connect_host(&launch).await.map_err(mux_err)?;
            client.spawn(spawn.request(cols, rows)).await.map_err(mux_err)?;
            Ok(())
        });
        self.forget_marks();
        spawned
    }

    /// No client process can attach here (the release exe has no console in
    /// a ConPTY): a viewer attaches with [`SessionMux::attach_stream`].
    fn attach_client(&self, name: &str, _for_phone: bool) -> Result<ClientCmd, MuxError> {
        check_name(name)?;
        self.ready()?;
        Err(MuxError::Unavailable("the session host attaches by stream (attach_stream), not by a client".into()))
    }

    /// Attaches only — never creates, never starts the host (no pipe is
    /// [`MuxError::NoServer`], no session [`MuxError::NotFound`]), setting
    /// or not: a live session stays attachable.
    fn attach_stream(&self, name: &str, cols: u16, rows: u16, history_lines: usize) -> Result<MuxStream, MuxError> {
        check_name(name)?;
        let launch = self.reachable()?;
        let name = name.to_string();
        let (cols, rows) = (cols.max(1), rows.max(1));
        // `query` and `attach` errors ride the failure's text; the kind is
        // recovered from `kind` below.
        let kind = std::sync::Arc::new(std::sync::Mutex::new(None));
        let seen = kind.clone();
        let opened = host_pty::open(
            move || async move {
                let note = |e: MuxError| {
                    *seen.lock().unwrap_or_else(|p| p.into_inner()) = Some(e.clone());
                    HostFailure::Silent(e.to_string())
                };
                let client = query(&launch).await.map_err(note)?;
                let attached = client.attach(&name, cols, rows, history_lines).await.map_err(|e| note(mux_err(e)))?;
                Ok((attached, false))
            },
            CALL_DEADLINE,
        );
        match opened {
            Ok(pty) => Ok(MuxStream::new(pty)),
            Err(failure) => Err(kind.lock().unwrap_or_else(|p| p.into_inner()).take().unwrap_or(MuxError::Io(failure.to_string()))),
        }
    }

    /// Setting or not (live sessions stay listed), under [`LIST_DEADLINE`].
    fn list(&self) -> Result<Vec<SessionInfo>, MuxError> {
        let floor = crate::services::session_host::protocol::PROTO_MIN;
        match self.ask_any_within(LIST_DEADLINE, floor, |mut c| async move { c.list().await }) {
            Ok(sessions) => Ok(sessions
                .into_iter()
                .map(|s| SessionInfo {
                    cmd: s
                        .argv
                        .first()
                        .and_then(|p| p.rsplit(['\\', '/']).next())
                        .map(|leaf| leaf.split('.').next().unwrap_or(leaf).to_string())
                        .unwrap_or_default(),
                    name: s.name,
                    created: secs(s.created),
                    activity: secs(s.activity),
                    attached: s.attached > 0,
                    cwd: s.cwd.unwrap_or_default(),
                })
                .collect()),
            Err(MuxError::NoServer) => Ok(Vec::new()),
            Err(e) => Err(e),
        }
    }

    /// One `List` of any running host, setting or not, under
    /// [`LIST_DEADLINE`], reused for [`MARKS_TTL`] (the lock is held across
    /// the listing: a restore's tabs wait on one). Only a host announcing
    /// `CAP_MCP_MARK` is listed; see [`route::marks_answer`].
    fn mcp_marks(&self) -> Result<SessionMarks, MuxError> {
        let launch = self.reachable()?;
        let pipe = launch.pipe_name();
        let mut cached = marks_cache();
        let cache = cached.get_or_insert_with(MarksCache::new);
        if let Some((at, marks)) = cache.get(&pipe) {
            if at.elapsed() < MARKS_TTL {
                return Ok(marks.clone());
            }
        }
        let floor = crate::services::session_host::protocol::PROTO_MIN;
        let listed = self.ask_any_within(LIST_DEADLINE, floor, |mut c| async move { c.mcp_marks().await });
        let marks = route::marks_answer(listed, self.available())?;
        cache.retain(|_, (at, _)| at.elapsed() < MARKS_TTL);
        cache.insert(pipe, (std::time::Instant::now(), marks.clone()));
        Ok(marks)
    }

    fn note_mcp_mark(&self, name: &str, mark: &str) {
        let Ok(launch) = self.launch.as_ref() else { return };
        if let Some((_, marks)) = marks_cache().as_mut().and_then(|cache| cache.get_mut(&launch.pipe_name())) {
            marks.note(name, mark);
        }
    }

    fn has(&self, name: &str) -> Result<bool, MuxError> {
        check_name(name)?;
        let name = name.to_string();
        let floor = crate::services::session_host::protocol::PROTO_MIN;
        match self.ask_any(floor, move |mut c| async move { c.info(&name).await }) {
            Ok(_) => Ok(true),
            Err(MuxError::NoServer | MuxError::NotFound) => Ok(false),
            Err(e) => Err(e),
        }
    }

    fn pane(&self, name: &str) -> Result<PaneInfo, MuxError> {
        check_name(name)?;
        let name = name.to_string();
        let info = self.ask_live(move |mut c| async move { c.info(&name).await })?;
        Ok(PaneInfo {
            dead: info.dead,
            pid: info.pid,
            created: secs(info.created),
            activity: secs(info.activity),
            window: Some((info.cols, info.rows)),
        })
    }

    fn screen(&self, name: &str) -> Result<String, MuxError> {
        check_name(name)?;
        let name = name.to_string();
        self.ask_live(move |mut c| async move { c.capture(&name, true, false, 0).await })
    }

    fn scrollback(&self, name: &str, lines: usize) -> Result<Vec<u8>, MuxError> {
        check_name(name)?;
        if lines == 0 {
            return Ok(Vec::new());
        }
        let name = name.to_string();
        let text = self.ask_live(move |mut c| async move { c.capture(&name, true, true, lines).await })?;
        if text.is_empty() {
            return Ok(Vec::new());
        }
        Ok(super::normalize_scrollback(text.into_bytes()))
    }

    fn send_keys(&self, name: &str, keys: &[Key]) -> Result<(), MuxError> {
        check_name(name)?;
        let bytes = super::keys::key_bytes(keys).map_err(MuxError::Refused)?;
        let name = name.to_string();
        self.ask_live(move |mut c| async move { c.input(&name, &bytes).await })
    }

    fn paste(&self, name: &str, text: &str, bracketed: bool) -> Result<(), MuxError> {
        check_name(name)?;
        let (name, text) = (name.to_string(), text.to_string());
        self.ask_live(move |mut c| async move { c.paste(&name, &text, bracketed).await })
    }

    fn env_text(&self, _name: &str) -> Option<String> {
        None
    }

    fn kill(&self, name: &str) -> Result<(), MuxError> {
        check_name(name)?;
        let name = name.to_string();
        let floor = crate::services::session_host::protocol::REAP_PROTO_MIN;
        let killed = self.ask_any(floor, move |mut c| async move { c.kill(&name).await });
        self.forget_marks();
        match killed {
            Ok(()) | Err(MuxError::NoServer | MuxError::NotFound) => Ok(()),
            Err(e) => Err(e),
        }
    }

    fn rename(&self, old: &str, new: &str) -> Result<(), MuxError> {
        check_name(old)?;
        check_name(new)?;
        let (old, new) = (old.to_string(), new.to_string());
        let renamed = self.ask(move |mut c| async move { c.rename(&old, &new).await });
        self.forget_marks();
        renamed
    }

    /// One `KillPrefix` of the app's prefix: the host only ever ran sessions
    /// this build minted, never one under the old name.
    fn kill_app_sessions(&self) -> Result<(), MuxError> {
        let prefix = crate::services::tmux_local::LOCAL_TMUX_PREFIX;
        let floor = crate::services::session_host::protocol::REAP_PROTO_MIN;
        let killed = self.ask_any(floor, move |mut c| async move { c.kill_prefix(prefix).await });
        self.forget_marks();
        match killed {
            Ok(_) | Err(MuxError::NoServer) => Ok(()),
            Err(e) => Err(e),
        }
    }
}

/// A tab's stream onto its session in this machine's host, for
/// `terminal::spawn_pty` (a launch `wrap` marked): connect (staging and
/// starting the host if absent), create-or-attach `Spawn`, `Attach`. The
/// failure is classified for the fallback rule (`route::decide`).
pub fn open_tab(opts: &PtyOptions, attach_only: bool) -> Result<HostPty, HostFailure> {
    WinHostMux::here().open_tab(opts, attach_only)
}

/// Whether this machine's host, if one runs, holds session `name` — the
/// fail-closed probe before an in-process launch of a tab the host would
/// have taken (`route::must_probe_live_session`). Never starts the host;
/// ignores the setting. `Err` is a host that is there and does not answer.
pub fn probe_live_session(name: &str) -> Result<bool, String> {
    WinHostMux::here().has(name).map_err(|e| e.to_string())
}

/// Ends session `name` in this machine's host, if one runs (setting or not).
pub fn end_session(name: &str) {
    if let Err(e) = WinHostMux::here().kill(name) {
        eprintln!("session_mux: could not end session '{name}': {e}");
    }
}

#[cfg(test)]
mod tests;
