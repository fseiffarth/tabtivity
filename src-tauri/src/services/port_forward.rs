//! Local port forwards over a remote project's ControlMaster
//! (`docs/localhost_viewer_plan.md`, `docs/context/port_forwards.md`).
//!
//! A program in a remote tab prints `http://localhost:8888/lab?token=…`. The
//! link must open **that** program's page, so one `ssh -O forward -L` asks the
//! master the tab already rides to listen on this machine's loopback and carry
//! the traffic to the printed host and port. The frontend then opens
//! `http://127.0.0.1:<local>/…` in the system browser.
//!
//! The rules this module holds (the plan's Rules 2–6):
//! - **`-L` only**, never `-R` or `-D`: a remote or SOCKS forward would give
//!   the far side a door into this machine.
//! - **The local end is always `127.0.0.1`.** The bind address is a constant
//!   here, and the local port is picked here (the remote's own number when it
//!   is free, else a free one), never taken from the renderer.
//! - **The remote end** is a loopback address or a plain host name, each
//!   validated ([`normalize_remote_host`]).
//! - **It never dials.** It rides a master that answers `-O check` or refuses
//!   with [`PortForwardError::NotConnected`]; the argv is `-F none` +
//!   `ProxyCommand=false` + `ControlMaster=no` on a literal socket path, so a
//!   dead master cannot fall through to a fresh login.
//! - **Nothing outlives its owner.** Each forward belongs to the tabs that
//!   asked for it and is cancelled when the last one is gone ([`close_for_tab`]),
//!   when its master is torn down ([`close_for_master`]), on Stop
//!   ([`close_id`]) and at quit ([`close_all`]). The registry holds host, port
//!   and local port, never a URL or token.
//!
//! `ssh` runs behind the [`Mux`] seam, so the registry logic is tested without
//! one. Windows has no ControlMaster: [`SUPPORTED`] is false there and the
//! commands refuse (phase 1b adds an `ssh -N -L` child).

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use app_core::sync::LockExt;
use serde::Serialize;

use crate::schema::project::RemoteSpec;
use crate::services::ssh_common::{ssh_target, target_key, validate_arg};

/// Whether this OS can forward at all (it needs a ControlMaster).
pub const SUPPORTED: bool = cfg!(not(windows));

/// The only address a forward ever listens on.
pub const BIND_ADDRESS: &str = "127.0.0.1";

/// How long one `ssh -O forward|cancel` may take. The mux client talks to a
/// local socket, so this is generous.
const MUX_TIMEOUT: Duration = Duration::from_secs(8);

/// How long the master's `-O check` may take.
const ALIVE_TIMEOUT: Duration = Duration::from_secs(4);

/// Why a forward was not made. [`Self::wire`] is what crosses to the renderer:
/// a stable `port-forward:<token>` prefix it translates, then free text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PortForwardError {
    /// No live master for the project's host: the forward never dials.
    NotConnected,
    /// This OS cannot forward yet (Windows).
    UnsupportedOs,
    /// The project is local, unknown or a reserved scope.
    NotRemote,
    /// The host or port is not one a forward may name.
    Invalid(String),
    /// ssh refused the forward.
    Failed(String),
}

impl PortForwardError {
    pub fn wire(&self) -> String {
        match self {
            Self::NotConnected => "port-forward:not-connected".to_string(),
            Self::UnsupportedOs => "port-forward:unsupported-os".to_string(),
            Self::NotRemote => "port-forward:not-remote".to_string(),
            Self::Invalid(why) => format!("port-forward:invalid: {why}"),
            Self::Failed(why) => format!("port-forward:failed: {why}"),
        }
    }
}

/// The remote end of a forward, as ssh's `-L` wants it. `0.0.0.0` and `::`
/// (what a server prints when it listens everywhere) mean the remote's
/// loopback; `[::1]` loses its brackets. Anything else must be a plain host
/// name or an IPv6 literal: ssh splits the `-L` value on `:`, so a name with
/// a colon, slash or space would silently name a different forward.
pub fn normalize_remote_host(raw: &str) -> Result<String, PortForwardError> {
    let host = raw.trim();
    let host = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(host);
    if host.is_empty() {
        return Err(PortForwardError::Invalid("host is empty".to_string()));
    }
    validate_arg("host", host).map_err(PortForwardError::Invalid)?;
    if matches!(host, "0.0.0.0" | "::") {
        return Ok("127.0.0.1".to_string());
    }
    if host.contains(':') {
        return host
            .parse::<std::net::Ipv6Addr>()
            .map(|a| a.to_string())
            .map_err(|_| PortForwardError::Invalid("host is not an address".to_string()));
    }
    let plain = host.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));
    if !plain || host.len() > 253 {
        return Err(PortForwardError::Invalid("host is not a plain name".to_string()));
    }
    Ok(host.to_string())
}

/// `127.0.0.1:<local>:<remote_host>:<remote_port>` — an IPv6 remote host is
/// bracketed, as `-L` needs.
pub fn forward_spec(local_port: u16, remote_host: &str, remote_port: u16) -> String {
    let host = if remote_host.contains(':') { format!("[{remote_host}]") } else { remote_host.to_string() };
    format!("{BIND_ADDRESS}:{local_port}:{host}:{remote_port}")
}

/// The options every mux call carries. `-F none` reads no ssh_config (no
/// `Match exec`); `ControlMaster=no` + `ProxyCommand=false` make a dead master
/// an exit, never a new login (`ssh_exec::host_mux_args` has the long story).
/// `ClearAllForwardings` is deliberately absent: it would cancel the `-L`.
fn mux_args(control_path: &Path, op: &str, spec: &str, ssh_port: Option<u16>, target: &str) -> Result<Vec<String>, String> {
    let path = crate::services::ssh_exec::literal_control_path(control_path)?;
    let mut args: Vec<String> = vec!["-F".into(), "none".into()];
    for option in [
        "BatchMode=yes".to_string(),
        "ControlMaster=no".to_string(),
        format!("ControlPath={path}"),
        "ProxyCommand=false".to_string(),
    ] {
        args.push("-o".into());
        args.push(option);
    }
    args.push("-O".into());
    args.push(op.into());
    args.push("-L".into());
    args.push(spec.to_string());
    if let Some(port) = ssh_port {
        args.push("-p".into());
        args.push(port.to_string());
    }
    validate_arg("target", target)?;
    args.push(target.to_string());
    Ok(args)
}

/// `ssh … -O forward -L 127.0.0.1:<local>:<host>:<port> [-p <ssh port>] <target>`
/// over the literal socket `control_path`.
pub fn forward_args(
    spec: &RemoteSpec,
    control_path: &Path,
    local_port: u16,
    remote_host: &str,
    remote_port: u16,
) -> Result<Vec<String>, String> {
    let target = ssh_target(&spec.user, &spec.host)?;
    mux_args(control_path, "forward", &forward_spec(local_port, remote_host, remote_port), spec.port, &target)
}

/// The matching `-O cancel`.
pub fn cancel_args(
    spec: &RemoteSpec,
    control_path: &Path,
    local_port: u16,
    remote_host: &str,
    remote_port: u16,
) -> Result<Vec<String>, String> {
    let target = ssh_target(&spec.user, &spec.host)?;
    mux_args(control_path, "cancel", &forward_spec(local_port, remote_host, remote_port), spec.port, &target)
}

/// The local port for a forward: `preferred` when it is free on the loopback,
/// else any free one. The listener is dropped before ssh binds, so the race is
/// real but harmless (ssh would report the bind and [`open_via`] retries once).
pub fn pick_local_port(preferred: u16) -> Option<u16> {
    let try_bind = |port: u16| {
        std::net::TcpListener::bind((BIND_ADDRESS, port)).ok().and_then(|l| l.local_addr().ok()).map(|a| a.port())
    };
    if preferred != 0 {
        if let Some(port) = try_bind(preferred) {
            return Some(port);
        }
    }
    try_bind(0)
}

/// The seam to `ssh`: tests record argv instead of spawning.
pub trait Mux {
    /// Whether a ControlMaster answers on `control_path` (strict: anything
    /// short of a yes is no).
    fn alive(&self, control_path: &Path) -> bool;
    /// The pid of the master answering on `control_path` (`-O check` says
    /// "Master running (pid=N)"), when it can be read. A forward lives in one
    /// master process: a different pid on the same socket is a different master.
    fn master_pid(&self, _control_path: &Path) -> Option<u32> {
        None
    }
    /// Run `ssh <args>`; `Err` carries stderr.
    fn run(&self, args: Vec<String>) -> Result<(), String>;
}

/// The real thing.
pub struct SshMux;

impl Mux for SshMux {
    fn alive(&self, control_path: &Path) -> bool {
        crate::services::ssh_exec::master_alive(control_path, ALIVE_TIMEOUT)
    }

    fn master_pid(&self, control_path: &Path) -> Option<u32> {
        let args = crate::services::ssh_exec::master_check_args(control_path).ok()?;
        let mut command = crate::paths::command_no_window("ssh");
        command.args(args);
        let out = crate::paths::output_within(command, ALIVE_TIMEOUT).ok()?;
        if !out.status.success() {
            return None;
        }
        // ssh prints it on stderr; stdout is read too, for a build that differs.
        parse_master_pid(&String::from_utf8_lossy(&out.stderr))
            .or_else(|| parse_master_pid(&String::from_utf8_lossy(&out.stdout)))
    }

    fn run(&self, args: Vec<String>) -> Result<(), String> {
        let mut command = crate::paths::command_no_window("ssh");
        command.args(args);
        let out = crate::paths::output_within(command, MUX_TIMEOUT).map_err(|e| e.to_string())?;
        if out.status.success() {
            return Ok(());
        }
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if stderr.is_empty() { "ssh refused the forward".to_string() } else { stderr })
    }
}

/// The `N` of `Master running (pid=N)`.
pub fn parse_master_pid(text: &str) -> Option<u32> {
    let digits: String = text.split("pid=").nth(1)?.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

/// Whether two readings of "which master is on this socket" are known to be
/// different processes. An unreadable pid on either side is not evidence.
fn other_master(recorded: Option<u32>, now: Option<u32>) -> bool {
    matches!((recorded, now), (Some(a), Some(b)) if a != b)
}

/// The identity of a forward: the same ssh target, remote host and port is one
/// forward however many tabs ask.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForwardKey {
    pub target: String,
    pub remote_host: String,
    pub remote_port: u16,
}

#[derive(Debug, Clone)]
struct Forward {
    id: u64,
    key: ForwardKey,
    local_port: u16,
    /// The PTY ids that asked for it; the forward ends with the last one.
    owners: BTreeSet<String>,
    control_path: PathBuf,
    project_id: String,
    host_id: String,
    host_label: String,
    /// The ssh target and port to rebuild `-O cancel` from.
    ssh_target: String,
    ssh_port: Option<u16>,
    /// The master process the forward was made in. The pool drops a dead
    /// connection without a teardown (`remote::connect_host` and the other
    /// reapers), so a row can outlive its master: after a reconnect the socket
    /// answers again, from a master that never heard of the forward.
    master_pid: Option<u32>,
}

impl Forward {
    fn cancel_args(&self) -> Result<Vec<String>, String> {
        mux_args(
            &self.control_path,
            "cancel",
            &forward_spec(self.local_port, &self.key.remote_host, self.key.remote_port),
            self.ssh_port,
            &self.ssh_target,
        )
    }
}

/// One row of the Ports list: no paths, no tokens.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ForwardRow {
    pub id: String,
    pub project_id: String,
    pub host_id: String,
    pub host_label: String,
    pub remote_host: String,
    pub remote_port: u16,
    pub local_port: u16,
}

/// What `open` answers with.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    pub id: String,
    pub local_port: u16,
    /// An existing forward served the request.
    pub reused: bool,
}

pub struct Registry {
    forwards: Vec<Forward>,
    next_id: u64,
}

impl Default for Registry {
    fn default() -> Self {
        Self::new()
    }
}

impl Registry {
    pub const fn new() -> Self {
        Self { forwards: Vec::new(), next_id: 1 }
    }

    pub fn rows(&self) -> Vec<ForwardRow> {
        self.forwards
            .iter()
            .map(|f| ForwardRow {
                id: f.id.to_string(),
                project_id: f.project_id.clone(),
                host_id: f.host_id.clone(),
                host_label: f.host_label.clone(),
                remote_host: f.key.remote_host.clone(),
                remote_port: f.key.remote_port,
                local_port: f.local_port,
            })
            .collect()
    }

    fn take_where(&mut self, mut gone: impl FnMut(&Forward) -> bool) -> Vec<Forward> {
        let (taken, kept): (Vec<_>, Vec<_>) = std::mem::take(&mut self.forwards).into_iter().partition(|f| gone(f));
        self.forwards = kept;
        taken
    }

    /// `owner` stops needing its forwards; those no other tab asked for are
    /// removed and returned for cancelling.
    fn release_owner(&mut self, owner: &str) -> Vec<Forward> {
        for f in &mut self.forwards {
            f.owners.remove(owner);
        }
        self.take_where(|f| f.owners.is_empty())
    }
}

/// What a caller hands [`open_via`]: everything is resolved by the backend
/// from the project id; none of it is the renderer's spec.
pub struct OpenRequest<'a> {
    pub spec: &'a RemoteSpec,
    pub control_path: PathBuf,
    pub project_id: &'a str,
    pub host_id: &'a str,
    pub owner: &'a str,
    pub remote_host: &'a str,
    pub remote_port: u16,
}

/// Forward `remote_host:remote_port` over the master on `req.control_path`, or
/// join the forward that already exists for the same key. `pick` chooses the
/// local port from the preferred one (tests pass a fixed answer).
pub fn open_via(
    registry: &Mutex<Registry>,
    mux: &dyn Mux,
    req: &OpenRequest<'_>,
    pick: &dyn Fn(u16) -> Option<u16>,
) -> Result<Opened, PortForwardError> {
    if !SUPPORTED {
        return Err(PortForwardError::UnsupportedOs);
    }
    if req.remote_port == 0 {
        return Err(PortForwardError::Invalid("port is 0".to_string()));
    }
    let remote_host = normalize_remote_host(req.remote_host)?;
    let key = ForwardKey {
        target: target_key(req.spec.user.as_deref(), &req.spec.host, req.spec.port),
        remote_host: remote_host.clone(),
        remote_port: req.remote_port,
    };
    // Never dial: a master that does not answer is "not connected". A stale
    // forward on a dead master is dropped here, not reused.
    if !mux.alive(&req.control_path) {
        registry.lock_ok().take_where(|f| f.control_path == req.control_path);
        return Err(PortForwardError::NotConnected);
    }
    // A forward made in a master that is gone is not reused: its local port
    // listens no more, and the next program to bind it would be handed the
    // page (and its `?token=`) of a server it never was.
    let master_pid = mux.master_pid(&req.control_path);
    registry
        .lock_ok()
        .take_where(|f| f.control_path == req.control_path && other_master(f.master_pid, master_pid));
    if let Some(opened) = join_existing(registry, &key, req.owner) {
        return Ok(opened);
    }

    let mut local = pick(req.remote_port).ok_or_else(|| PortForwardError::Failed("no free local port".to_string()))?;
    let mut attempt = 0;
    loop {
        let args = forward_args(req.spec, &req.control_path, local, &remote_host, req.remote_port)
            .map_err(PortForwardError::Invalid)?;
        match mux.run(args) {
            Ok(()) => break,
            // The master does the bind, and the mux client reports a taken
            // port only as "forwarding request failed" — so any first failure
            // gets one retry on a fresh port.
            Err(stderr) if attempt == 0 => {
                attempt += 1;
                local = pick(0).ok_or(PortForwardError::Failed(stderr))?;
            }
            Err(stderr) => return Err(PortForwardError::Failed(stderr)),
        }
    }

    let target = ssh_target(&req.spec.user, &req.spec.host).map_err(PortForwardError::Invalid)?;
    let mut guard = registry.lock_ok();
    // A concurrent open of the same key got in while ssh ran: keep theirs.
    if let Some(existing) = guard.forwards.iter_mut().find(|f| f.key == key) {
        existing.owners.insert(req.owner.to_string());
        let opened = Opened { id: existing.id.to_string(), local_port: existing.local_port, reused: true };
        drop(guard);
        if let Ok(args) = forward_args_cancel(req, local, &remote_host) {
            let _ = mux.run(args);
        }
        return Ok(opened);
    }
    let id = guard.next_id;
    guard.next_id += 1;
    guard.forwards.push(Forward {
        id,
        key,
        local_port: local,
        owners: BTreeSet::from([req.owner.to_string()]),
        control_path: req.control_path.clone(),
        project_id: req.project_id.to_string(),
        host_id: req.host_id.to_string(),
        host_label: req.spec.label.clone().filter(|l| !l.trim().is_empty()).unwrap_or_else(|| req.spec.host.clone()),
        ssh_target: target,
        ssh_port: req.spec.port,
        master_pid,
    });
    Ok(Opened { id: id.to_string(), local_port: local, reused: false })
}

fn forward_args_cancel(req: &OpenRequest<'_>, local: u16, remote_host: &str) -> Result<Vec<String>, String> {
    cancel_args(req.spec, &req.control_path, local, remote_host, req.remote_port)
}

fn join_existing(registry: &Mutex<Registry>, key: &ForwardKey, owner: &str) -> Option<Opened> {
    let mut guard = registry.lock_ok();
    let existing = guard.forwards.iter_mut().find(|f| &f.key == key)?;
    existing.owners.insert(owner.to_string());
    Some(Opened { id: existing.id.to_string(), local_port: existing.local_port, reused: true })
}

/// `-O cancel` for each forward, failures ignored: a dead master already took
/// its forwards with it.
fn cancel_forwards(mux: &dyn Mux, forwards: Vec<Forward>) {
    for forward in forwards {
        if let Ok(args) = forward.cancel_args() {
            let _ = mux.run(args);
        }
    }
}

/// Stop one forward by its list id. Whether it existed.
pub fn close_id_via(registry: &Mutex<Registry>, mux: &dyn Mux, id: &str) -> bool {
    let Ok(id) = id.parse::<u64>() else { return false };
    let taken = registry.lock_ok().take_where(|f| f.id == id);
    let found = !taken.is_empty();
    cancel_forwards(mux, taken);
    found
}

pub fn close_for_tab_via(registry: &Mutex<Registry>, mux: &dyn Mux, owner: &str) {
    let taken = registry.lock_ok().release_owner(owner);
    cancel_forwards(mux, taken);
}

pub fn close_for_master_via(registry: &Mutex<Registry>, mux: &dyn Mux, control_path: &Path) {
    let taken = registry.lock_ok().take_where(|f| f.control_path == control_path);
    cancel_forwards(mux, taken);
}

pub fn close_all_via(registry: &Mutex<Registry>, mux: &dyn Mux) {
    let taken = registry.lock_ok().take_where(|_| true);
    cancel_forwards(mux, taken);
}

// ── The process-wide registry ───────────────────────────────────────────────

static REGISTRY: Mutex<Registry> = Mutex::new(Registry::new());

/// Forward for a tab of project `project_id` on host `host_id` (blocking: it
/// runs `ssh`). Call off the async workers.
pub fn open(
    spec: &RemoteSpec,
    control_path: PathBuf,
    project_id: &str,
    host_id: &str,
    owner: &str,
    remote_host: &str,
    remote_port: u16,
) -> Result<Opened, PortForwardError> {
    open_via(
        &REGISTRY,
        &SshMux,
        &OpenRequest { spec, control_path, project_id, host_id, owner, remote_host, remote_port },
        &pick_local_port,
    )
}

pub fn list() -> Vec<ForwardRow> {
    REGISTRY.lock_ok().rows()
}

/// Stop one forward (blocking: `ssh -O cancel`).
pub fn close_id(id: &str) -> bool {
    close_id_via(&REGISTRY, &SshMux, id)
}

/// The tab (PTY id) is gone: its forwards no other tab uses end. The registry
/// is updated at once; the `ssh -O cancel` runs on a thread of its own, since
/// this is called from PTY teardown and the reader task.
pub fn close_for_tab(owner: &str) {
    let taken = REGISTRY.lock_ok().release_owner(owner);
    if taken.is_empty() {
        return;
    }
    std::thread::spawn(move || cancel_forwards(&SshMux, taken));
}

/// The master on `control_path` is being torn down (blocking).
pub fn close_for_master(control_path: &Path) {
    close_for_master_via(&REGISTRY, &SshMux, control_path);
}

/// Quit: cancel every forward (blocking; bounded by [`MUX_TIMEOUT`] each).
/// A master kept alive by `ControlPersist` must not keep a local port bound
/// after the app is gone.
pub fn close_all() {
    close_all_via(&REGISTRY, &SshMux);
}

#[cfg(test)]
mod tests;
