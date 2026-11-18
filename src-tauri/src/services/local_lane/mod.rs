//! The local lane: how a fenced agent with **no network** reaches the local
//! Ollama and a few of Tabtivity's own tools (`docs/local_models_only_plan.md`,
//! phase 2; `docs/context/local_models_only.md`).
//!
//! A project with Local models only and Cut network on runs its local tabs in a
//! bubblewrap fence with `--unshare-net`: the fence's loopback is its own, so the
//! host's Ollama and Tabtivity MCP ports do not exist there. What the CLI needs
//! comes through two halves:
//!
//! - **host side** ([`server`], [`policy`], [`http`]): per tab, Unix sockets in
//!   `<state_dir>/local-lane/` (mode 0600, in a 0700 folder), created here, bound
//!   into the fence under its private `/run`, removed when the tab ends and at
//!   quit ([`stop_for_exit`]). One forwards to the loopback Ollama after the
//!   listener-owner check, one to Tabtivity's MCP server. Every request is
//!   parsed, judged and rebuilt: only the Ollama routes in
//!   [`policy::OLLAMA_ROUTES`], every model a request names passing
//!   `ollama_client::model_is_local_at`, model lists narrowed to local models;
//!   only the cockpit, help and markup MCP lanes.
//! - **fence side** ([`relay`]): the fence's command is this binary in
//!   `--local-relay` mode, bound read-only. It listens on the **same ports** the
//!   CLI was already configured with (the verified Ollama port, the MCP port), so
//!   every pin and MCP config keeps working, pumps connections to the sockets,
//!   and execs the CLI.
//!
//! Everything here is `AppHandle`-free and builds in the server daemon too (Unix
//! only: the fence it serves is Linux's, and macOS joins in Phase 3).

pub mod http;
pub mod policy;
pub mod relay;
pub mod server;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use app_core::sync::LockExt;

/// The folder of the lane sockets, under the state dir (private to this user;
/// every fence shadows the state tree, and a lane socket is bound in on top).
pub const DIR_NAME: &str = "local-lane";

/// Where the lane lives inside a fence: a folder under the fence's private
/// `/run`, so the bind mounts need nothing to exist in the read-only root.
pub const FENCE_DIR: &str = concat!("/run/", crate::app_slug!(), "-lane");

/// The relay binary, bound read-only inside the fence.
pub const FENCE_RELAY: &str = concat!("/run/", crate::app_slug!(), "-lane/relay");
const FENCE_OLLAMA_SOCK: &str = concat!("/run/", crate::app_slug!(), "-lane/ollama.sock");
const FENCE_MCP_SOCK: &str = concat!("/run/", crate::app_slug!(), "-lane/mcp.sock");

/// The two ports a cut fence's relay listens on: Ollama's, and the MCP
/// server's when there is one (and it is another port).
pub fn relay_ports(ollama_endpoint: &str, mcp_port: Option<u16>) -> Result<(u16, Option<u16>), String> {
    let (host, port) = crate::services::ollama_client::split_host_port(ollama_endpoint)
        .filter(|(host, _)| crate::services::ollama_client::host_is_loopback(host))
        .ok_or_else(|| format!("the Ollama address `{ollama_endpoint}` is not a loopback address"))?;
    let _ = host;
    Ok((port, mcp_port.filter(|p| *p != port)))
}

/// Run `f` with a path to `path` that fits a socket address (`sun_path` holds about a
/// hundred bytes; a state dir under a long home does not): on Linux, a long path is
/// reached as `/proc/self/fd/<its folder, held open>/<name>`. Other paths are passed
/// as they are.
pub fn with_socket_path<T>(path: &Path, f: impl FnOnce(&Path) -> std::io::Result<T>) -> std::io::Result<T> {
    #[cfg(target_os = "linux")]
    if path.as_os_str().len() >= 100 {
        use std::os::fd::AsRawFd;
        if let (Some(dir), Some(name)) = (path.parent(), path.file_name()) {
            let held = std::fs::File::open(dir)?;
            return f(&Path::new("/proc/self/fd").join(held.as_raw_fd().to_string()).join(name));
        }
    }
    f(path)
}

/// Whether the running binary can be the relay inside a fence: it is bound in
/// read-only and linked against the host's libraries, which the fence shows as the
/// host has them. An AppImage keeps its libraries in a temporary FUSE mount under
/// `/tmp` and finds them through the environment its launcher sets, and the fence's
/// `/tmp` is empty, so the relay would not start; that is refused with the reason,
/// not left to fail inside the sandbox. (`appimage` is the `APPIMAGE` variable of this
/// process.) A static helper written to `<state_dir>/bin` is the fallback if this
/// ever has to run from an AppImage.
pub fn relay_exe_check(exe: &Path, appimage: Option<&str>) -> Result<(), String> {
    let temp_mount = exe.starts_with("/tmp") || exe.to_string_lossy().contains("/.mount_");
    if appimage.is_some_and(|a| !a.is_empty()) || temp_mount {
        return Err(format!(
            "Agent sandbox: Cut network runs the relay from {} itself, and this copy runs from a temporary mount (an AppImage) whose libraries the sandbox does not show, so this agent was not started. Install the package, or build {} from source.",
            crate::brand::DISPLAY, crate::brand::DISPLAY
        ));
    }
    Ok(())
}

/// What a fence needs of a tab's open lane.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FenceLane {
    /// The host-side sockets: Ollama's, and the MCP server's.
    pub ollama_socket: PathBuf,
    pub mcp_socket: Option<PathBuf>,
    pub ollama_port: u16,
    pub mcp_port: Option<u16>,
}

impl FenceLane {
    /// The bubblewrap arguments that put the relay binary and the sockets in
    /// the fence: the binary read-only, each socket bound at its fixed path.
    pub fn binds(&self, relay_exe: &Path) -> Vec<String> {
        let s = |p: &Path| p.to_string_lossy().into_owned();
        let mut out = vec!["--ro-bind".into(), s(relay_exe), FENCE_RELAY.into(), "--bind".into(), s(&self.ollama_socket), FENCE_OLLAMA_SOCK.into()];
        if let Some(mcp) = &self.mcp_socket {
            out.extend(["--bind".into(), s(mcp), FENCE_MCP_SOCK.into()]);
        }
        out
    }

    /// The command the fence runs in front of the CLI's own: the relay binary,
    /// its listen specs and the `--` that starts the CLI.
    pub fn command_prefix(&self) -> Vec<String> {
        let mut specs = vec![relay::Spec { port: self.ollama_port, socket: PathBuf::from(FENCE_OLLAMA_SOCK) }];
        if let (Some(port), Some(_)) = (self.mcp_port, &self.mcp_socket) {
            specs.push(relay::Spec { port, socket: PathBuf::from(FENCE_MCP_SOCK) });
        }
        let mut out = vec![FENCE_RELAY.to_string()];
        out.extend(relay::mode_args(&specs));
        out
    }
}

// ── The open lanes ──────────────────────────────────────────────────────────

struct Lane {
    servers: Vec<server::LaneServer>,
    fence: FenceLane,
}

fn lanes() -> &'static Mutex<HashMap<String, Lane>> {
    static LANES: OnceLock<Mutex<HashMap<String, Lane>>> = OnceLock::new();
    LANES.get_or_init(Default::default)
}

/// The socket file name for `tab_id`: a hash, so a tab id never reaches a path.
pub fn socket_stem(tab_id: &str) -> String {
    crate::digest::sha256_hex(tab_id.as_bytes())[..16].to_string()
}

/// The Ollama target of a lane for the verified `endpoint`: every named model
/// judged by `ollama_client::model_is_local_at` (cached), the listener's owner
/// checked on every connection.
pub fn ollama_target(endpoint: &str) -> Result<server::Target, String> {
    use crate::services::ollama_client as oc;
    relay_ports(endpoint, None)?;
    let (judge_addr, connect_addr) = (endpoint.to_string(), endpoint.to_string());
    Ok(server::Target::Ollama {
        judge: Arc::new(move |model| oc::model_is_local_at(&judge_addr, model)),
        connect: Arc::new(move || {
            let stream = oc::connect_ollama(&connect_addr)?;
            oc::owner_gate(&connect_addr)?;
            Ok(stream)
        }),
        host: endpoint.to_string(),
    })
}

/// The MCP target: Tabtivity's own server on `127.0.0.1:<port>`.
pub fn mcp_target(port: u16) -> server::Target {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    server::Target::Mcp {
        connect: Arc::new(move || std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_secs(4)).map_err(|e| e.to_string())),
        host: format!("127.0.0.1:{port}"),
    }
}

/// Open the lane of `tab_id` (replacing a lane the id had): the Ollama socket
/// for the verified `endpoint`, and the MCP socket when the process serves
/// one. Sockets left by an earlier run are removed the first time.
pub fn open(tab_id: &str, state_dir: &Path, endpoint: &str, mcp_port: Option<u16>) -> Result<FenceLane, String> {
    let (ollama_port, mcp_port) = relay_ports(endpoint, mcp_port)?;
    let dir = state_dir.join(DIR_NAME);
    static SWEPT: OnceLock<()> = OnceLock::new();
    SWEPT.get_or_init(|| {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if entry.path().extension().is_some_and(|e| e == "sock") {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    });
    close(tab_id);
    let stem = socket_stem(tab_id);
    let fail = |what: &str, e: &dyn std::fmt::Display| format!("Agent sandbox: the local model lane could not be opened ({what}: {e}), so this agent was not started.");
    let mut servers = Vec::new();
    let ollama_path = dir.join(format!("{stem}.sock"));
    servers.push(server::LaneServer::start(&ollama_path, ollama_target(endpoint)?, server::Limits::default()).map_err(|e| fail("model socket", &e))?);
    let mcp_socket = match mcp_port {
        Some(port) => {
            let path = dir.join(format!("{stem}.mcp.sock"));
            servers.push(server::LaneServer::start(&path, mcp_target(port), server::Limits::default()).map_err(|e| fail("tools socket", &e))?);
            Some(path)
        }
        None => None,
    };
    let fence = FenceLane { ollama_socket: ollama_path, mcp_socket, ollama_port, mcp_port };
    lanes().lock_ok().insert(tab_id.to_string(), Lane { servers, fence: fence.clone() });
    Ok(fence)
}

/// End `tab_id`'s lane: its sockets are closed and removed. A tab with none is a no-op.
pub fn close(tab_id: &str) {
    let lane = lanes().lock_ok().remove(tab_id);
    if let Some(lane) = lane {
        for server in lane.servers {
            server.stop();
        }
    }
}

/// Whether `tab_id` has an open lane.
pub fn is_open(tab_id: &str) -> bool {
    lanes().lock_ok().contains_key(tab_id)
}

/// The lane of `tab_id`, as the fence would bind it.
pub fn lane_of(tab_id: &str) -> Option<FenceLane> {
    lanes().lock_ok().get(tab_id).map(|l| l.fence.clone())
}

/// Close every lane (`RunEvent::Exit`): no socket outlives the quit.
pub fn stop_for_exit() {
    let all: Vec<Lane> = lanes().lock_ok().drain().map(|(_, lane)| lane).collect();
    // Every lane told first, then each joined: one wait for all of them.
    all.iter().flat_map(|lane| &lane.servers).for_each(server::LaneServer::signal);
    for lane in all {
        for server in lane.servers {
            server.stop();
        }
    }
}

#[cfg(test)]
mod tests;
