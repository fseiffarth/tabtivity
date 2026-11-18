//! The Windows session host (`docs/windows_session_host_plan.md` §2): a
//! persistent process that owns ConPTYs and plays tmux server's role over a
//! named pipe, so a Windows agent tab outlives its window and reaches the phone
//! the way a tmux session does on Unix (`services::session_mux` is the seam).
//!
//! This is the cross-platform core, built and tested on every OS:
//!
//! - [`protocol`]: frames (length, kind, ≤ 1 MiB), the JSON control messages
//!   and `Hello`/`Welcome` version negotiation.
//! - [`screen`]: a session's vt100 screen — capture, history, mode 2004,
//!   repaints, and where a read may be cut without splitting a sequence.
//! - [`table`]: sessions by exact name, create-or-attach, the size policy,
//!   the dead state, the idle-exit rule on an injectable clock.
//! - [`server`]: the dispatch over any byte stream, a [`server::Pty`] control
//!   trait and a per-session input writer thread — token handshake, spawn
//!   outside every lock, per-session locks, snapshot-then-live streams,
//!   per-client bounded queues with repaint-on-overflow.
//! - [`client`]: the client side, over any stream a [`client::Connector`]
//!   opens.
//!
//! - [`cmdline`]: the Windows command line and environment block a spawn
//!   hands `CreateProcessW`, built purely.
//! - [`route`]: which launches run in the host, the programs it may run,
//!   the scrubbed environment of a started host, and the fallback rule
//!   (absent → in-process, silent → fail closed) with its error codes.
//! - [`copies`]: the on-disk layout (versioned copies, token,
//!   `sessions.json`), which copies a prune removes, when an older host is
//!   retired.
//!
//! Windows only: [`win`] (the pipe with its protected DACL and peer checks,
//! the ConPTY + Job Object `Pty`, [`win::run_host`] behind `--session-host`)
//! and [`launch`] (the versioned copy, the lazy detached start behind
//! [`client::Connector`], the classified connect, prune, idle-only
//! retirement). A desktop tab or the phone reaches a session as an attached
//! stream (`terminal::host_pty`), never through a console client: the
//! release exe is GUI-subsystem and gets no console in a ConPTY (plan, P0
//! outcome). AppHandle-free; builds in the daemon.

pub mod client;
pub mod cmdline;
pub mod copies;
pub mod protocol;
pub mod screen;
pub mod route;
pub mod server;
pub mod table;

#[cfg(windows)]
pub mod launch;
#[cfg(windows)]
pub mod win;

/// The argument that runs this binary as the session host (`main.rs`).
pub const MODE_FLAG: &str = "--session-host";

#[cfg(test)]
pub(crate) mod fake_pty;
