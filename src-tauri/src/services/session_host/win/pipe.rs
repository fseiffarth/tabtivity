//! The session host's named pipe: the listener the host serves on and the
//! [`Connector`] a client opens it with. Both ride [`crate::services::local_pipe`]
//! (protected owner-only DACL, remote clients rejected, each side checking the
//! other's process user); the token is checked by the host's own `Hello`.
//!
//! One host per state dir: a `Local\` mutex and the pipe both carry a hash of
//! the state dir, and the pipe is created with `first_pipe_instance`, so a
//! second host — or anything squatting the name first — is refused.

use std::io;
use std::path::Path;
use std::time::Duration;

use tokio::net::windows::named_pipe::{NamedPipeClient, NamedPipeServer};
use windows::core::HSTRING;
use windows::Win32::Foundation::{GetLastError, E_ACCESSDENIED, ERROR_ALREADY_EXISTS};
use windows::Win32::System::Threading::CreateMutexW;

use super::OwnedHandle;
use crate::services::local_pipe;
use crate::services::session_host::client::Connector;
use crate::services::session_host::server::Host;

fn prefix() -> String {
    format!("{}-session-host-", crate::brand::SLUG)
}

/// What both names hash: the state dir spelled one way
/// ([`local_pipe::normalized_path_key`]) and whether this process is
/// elevated, so an elevated host and a medium-integrity one never share a
/// name — neither can reach, start for or block the other.
pub fn instance_hash(state_dir: &Path) -> String {
    let mut key = local_pipe::normalized_path_key(state_dir);
    if local_pipe::current_elevated() {
        key.push_str("|elevated");
    }
    local_pipe::key_hash(&key)
}

/// The host's pipe for `state_dir`.
pub fn pipe_name(state_dir: &Path) -> String {
    format!(r"\\.\pipe\{}{}", prefix(), instance_hash(state_dir))
}

/// The host's single-instance mutex for `state_dir`.
pub fn mutex_name(state_dir: &Path) -> String {
    format!(r"Local\{}{}", prefix(), instance_hash(state_dir))
}

/// Proof this process is the one host for its state dir, held for its life.
pub struct Instance(#[allow(dead_code)] OwnedHandle);

/// Claims the single-instance mutex `name` (created with the pipe's
/// protected owner-only DACL); `None` when another host holds it. A mutex of
/// that name this user may not open — squatted by another user — is
/// `PermissionDenied`, never mistaken for a running host.
pub fn claim_instance(name: &str) -> io::Result<Option<Instance>> {
    let security = local_pipe::PipeSecurity::for_current_user()?;
    // SAFETY: the attributes outlive the call; the handle is owned by the
    // guard; GetLastError is read right after the call that set it.
    unsafe {
        let handle = match CreateMutexW(Some(security.attributes()), false, &HSTRING::from(name)) {
            Ok(h) => OwnedHandle(h),
            Err(e) if e.code() == E_ACCESSDENIED => {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    format!("the session host's name {name} is taken by another user"),
                ))
            }
            Err(e) => return Err(e.into()),
        };
        if GetLastError() == ERROR_ALREADY_EXISTS {
            return Ok(None);
        }
        Ok(Some(Instance(handle)))
    }
}

/// The host's listening pipe.
pub struct Listener {
    name: String,
    server: NamedPipeServer,
}

impl Listener {
    /// Creates the first instance of `name`; fails when it already exists.
    /// Call inside a tokio runtime.
    pub fn bind(name: &str) -> io::Result<Self> {
        Ok(Self { name: name.to_string(), server: local_pipe::create_server(name, true)? })
    }

    /// Another instance of `name`, for a host that listens again after
    /// calling an exit off while its other instances still exist (so not
    /// `first_pipe_instance`; the mutex already proves who owns the name).
    pub fn bind_more(name: &str) -> io::Result<Self> {
        Ok(Self { name: name.to_string(), server: local_pipe::create_server(name, false)? })
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    /// The listening instance (its DACL is what every instance gets).
    pub fn server(&self) -> &NamedPipeServer {
        &self.server
    }

    /// The next same-user client.
    pub async fn accept(&mut self) -> io::Result<NamedPipeServer> {
        local_pipe::accept(&mut self.server, &self.name).await
    }
}

/// Serves every connection on `listener` until the task is dropped.
pub async fn serve(host: Host, mut listener: Listener) {
    loop {
        match listener.accept().await {
            // Counted before the next await: a stop right after this still
            // sees the connection (`Host::resume_if_connected`).
            Ok(stream) => drop(host.spawn_serve(stream)),
            // A transient failure must not take the host's pipe down.
            Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
        }
    }
}

/// Opens the host's pipe once (busy instances ridden out). "No such pipe" is
/// `NotFound`, the one answer a lazy start acts on.
#[derive(Debug, Clone)]
pub struct PipeConnector {
    pub name: String,
}

impl Connector for PipeConnector {
    type Io = NamedPipeClient;
    fn connect(&self) -> impl std::future::Future<Output = io::Result<NamedPipeClient>> + Send {
        let name = self.name.clone();
        async move { local_pipe::open_client(&name).await }
    }
}
