//! A **pipe-backed PTY**: a terminal whose program runs in the Windows session
//! host (`services::session_host`) and which this process sees only as an
//! attached stream over the host's pipe (plan, P0 outcome). It stands where a
//! portable-pty pair stands in the registry — a master to resize, a reader of
//! output, a writer of input, a child to wait on and kill — so a tab spawned
//! through the host takes the same paths as any other: `terminal-*` events,
//! the replay buffers, `pty_write` (the AI switch's filter runs before the
//! bytes reach the [`HostPty::writer`]), `pty_resize`, teardown.
//!
//! Semantics are a tmux client's, which is what the stream replaces:
//!
//! - Output is the host's snapshot of the screen first, then live output.
//!   A host that had to drop this client's output repaints the whole screen,
//!   so the bytes always draw the real screen.
//! - Input goes as `Input` frames, a resize as the stream's `Resize`.
//! - The session's program ending ends the stream (EOF, the tab's exit) —
//!   unless it runs under remain-on-exit: then the stream stays open on the
//!   dead pane (input refused by the host) and the child reads as running,
//!   as a tmux client of a dead pane does; `SessionMux::pane` says dead.
//! - Killing the [`HostPty::child`] **detaches**: the stream closes and the
//!   session lives on in the host, as a killed tmux client leaves its
//!   session. Ending the session — and its whole process tree, through the
//!   host's Job Object — is `SessionMux::kill` (`local_tmux_kill`, the
//!   clean-quit `kill_app_sessions`). There is no local process: the child
//!   has no pid, so a teardown's subtree walk finds nothing of it here.
//!
//! Each stream runs on a thread of its own with a current-thread runtime: a
//! named pipe belongs to the runtime that opened it, so the connect, the
//! `Spawn`, the `Attach` and the pump all run there. Cross-platform over any
//! `AsyncRead + AsyncWrite`, so Linux CI tests it against the fake host.

use std::future::Future;
use std::io::{self, Read, Write};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::Duration;

use portable_pty::{Child, ChildKiller, ExitStatus, PtySize};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::mpsc;

use crate::services::session_host::client::{Attached, StreamEvent};
use crate::services::session_host::route::HostFailure;

/// Output chunks in flight between the stream and its reader: when the
/// reader falls behind, the stream stops reading the pipe and the host's
/// per-client queue takes over (drop, then repaint).
const OUTPUT_CAP: usize = 64;
/// Input chunks in flight to the stream: a writer past it waits, as a write
/// to a full PTY does.
const INPUT_CAP: usize = 64;
/// The exit code a stream that ended without the program's own reports (the
/// host went, the connection broke, or this end detached): never `0`.
pub const LOST_EXIT_CODE: u32 = u32::MAX;

/// Resizes and the close: small, never waited on.
enum Cmd {
    Resize(u16, u16),
    Close,
}

/// What the stream has said so far.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct StreamStatus {
    /// The stream is over: the session ended, was killed, the host went, or
    /// this end closed it.
    pub ended: bool,
    /// The session's program exited under remain-on-exit: the pane stays,
    /// input-less.
    pub dead: bool,
    /// The program's exit code, once it exited.
    pub exit_code: Option<i32>,
}

#[derive(Debug, Default)]
struct Shared {
    status: Mutex<StreamStatus>,
    changed: Condvar,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, StreamStatus> {
        self.status.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn update(&self, f: impl FnOnce(&mut StreamStatus)) {
        f(&mut self.lock());
        self.changed.notify_all();
    }
}

/// A handle on one stream, cloneable: its size, resize, close, status.
#[derive(Debug, Clone)]
pub struct StreamHandle {
    cmd: mpsc::UnboundedSender<Cmd>,
    shared: Arc<Shared>,
    size: Arc<Mutex<(u16, u16)>>,
}

impl std::fmt::Debug for Cmd {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Cmd::Resize(c, r) => write!(f, "Resize({c}x{r})"),
            Cmd::Close => f.write_str("Close"),
        }
    }
}

impl StreamHandle {
    /// This client's size; the session follows its latest client.
    pub fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        *self.size.lock().unwrap_or_else(|e| e.into_inner()) = (cols, rows);
        self.cmd.send(Cmd::Resize(cols, rows)).map_err(|_| closed())
    }

    /// The size this client last asked for (at first, the session's).
    pub fn size(&self) -> (u16, u16) {
        *self.size.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Detach: the stream ends, the session runs on. Idempotent.
    pub fn close(&self) {
        let _ = self.cmd.send(Cmd::Close);
    }

    pub fn status(&self) -> StreamStatus {
        *self.shared.lock()
    }

    /// Blocks until the stream is over or `timeout` passes; the status then.
    pub fn wait_ended(&self, timeout: Duration) -> StreamStatus {
        let guard = self.shared.lock();
        let (guard, _) = self
            .shared
            .changed
            .wait_timeout_while(guard, timeout, |s| !s.ended)
            .unwrap_or_else(|e| e.into_inner());
        *guard
    }
}

fn closed() -> io::Error {
    io::Error::new(io::ErrorKind::BrokenPipe, "the session stream is closed")
}

/// One attached stream, in a PTY pair's shape.
pub struct HostPty {
    /// The open's `Spawn` created the session (it did not exist): a spawn
    /// that is then refused must end it, not only detach.
    pub created: bool,
    /// Resize and size; for the registry's master slot.
    pub master: Box<dyn super::PtyMaster>,
    /// The session's output: the snapshot, then live. EOF when the stream
    /// ends. Blocking: read it from a plain thread, never an async task.
    pub reader: Box<dyn Read + Send>,
    /// Input to the session, bounded: a full queue makes a write wait.
    pub writer: Box<dyn Write + Send>,
    /// Waits on the stream; `kill` detaches. No pid.
    pub child: Box<dyn Child + Send + Sync>,
    pub handle: StreamHandle,
}

/// Opens a stream: runs `open` (connect, `Spawn`, `Attach`) on a thread of
/// its own, under `deadline`, then pumps the attached stream there until it
/// ends or every handle on it is gone. Blocks until `open` is done.
///
/// A deadline that passes is [`HostFailure::Silent`]: a `Spawn` may have
/// started the session, so the caller must not start another. `open`
/// answers the attached stream and whether its `Spawn` created the session.
pub fn open<IO, F, Fut>(open: F, deadline: Duration) -> Result<HostPty, HostFailure>
where
    IO: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    F: FnOnce() -> Fut + Send + 'static,
    Fut: Future<Output = Result<(Attached<IO>, bool), HostFailure>>,
{
    let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
    let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
    let (input_tx, input_rx) = mpsc::channel(INPUT_CAP);
    let (out_tx, out_rx) = mpsc::channel(OUTPUT_CAP);
    let shared = Arc::new(Shared::default());
    let pump_shared = shared.clone();
    std::thread::Builder::new()
        .name("session-host-stream".into())
        .spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
                Ok(rt) => rt,
                Err(e) => {
                    let _ = ready_tx.send(Err(HostFailure::Absent(format!("session stream runtime: {e}"))));
                    return;
                }
            };
            rt.block_on(async move {
                let (attached, created) = match tokio::time::timeout(deadline, open()).await {
                    Ok(Ok(opened)) => opened,
                    Ok(Err(failure)) => {
                        let _ = ready_tx.send(Err(failure));
                        return;
                    }
                    Err(_) => {
                        let _ = ready_tx.send(Err(HostFailure::Silent("the session host did not answer in time".into())));
                        return;
                    }
                };
                if ready_tx.send(Ok((attached.size(), created))).is_err() {
                    return;
                }
                pump(attached, cmd_rx, input_rx, out_tx, pump_shared).await;
            });
        })
        .map_err(|e| HostFailure::Absent(format!("session stream thread: {e}")))?;
    let (size, created) = match ready_rx.recv() {
        Ok(Ok(opened)) => opened,
        Ok(Err(failure)) => return Err(failure),
        Err(_) => return Err(HostFailure::Silent("the session stream stopped while opening".into())),
    };
    let handle = StreamHandle { cmd: cmd_tx, shared, size: Arc::new(Mutex::new(size)) };
    Ok(HostPty {
        created,
        master: Box::new(HostMaster(handle.clone())),
        reader: Box::new(OutputReader { rx: out_rx, pending: Vec::new(), pos: 0 }),
        writer: Box::new(InputWriter { tx: input_tx, shared: handle.shared.clone() }),
        child: Box::new(HostChild(handle.clone())),
        handle,
    })
}

/// Pumps `attached` both ways until it ends or this end closes it.
async fn pump<IO>(
    attached: Attached<IO>,
    mut cmds: mpsc::UnboundedReceiver<Cmd>,
    mut input: mpsc::Receiver<Vec<u8>>,
    out: mpsc::Sender<Vec<u8>>,
    shared: Arc<Shared>,
) where
    IO: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (mut rd, mut wr) = attached.into_split();
    let reading = shared.clone();
    let mut reader = tokio::spawn(async move {
        loop {
            match rd.next().await {
                Ok(Some(StreamEvent::Output(bytes))) => {
                    if out.send(bytes).await.is_err() {
                        break;
                    }
                }
                // The repaint's bytes follow as output.
                Ok(Some(StreamEvent::Repaint { .. })) => {}
                Ok(Some(StreamEvent::Exit { code })) => reading.update(|s| s.exit_code = code),
                Ok(Some(StreamEvent::Dead)) => reading.update(|s| s.dead = true),
                Ok(None) | Err(_) => break,
            }
        }
        // Over before the reader sees EOF (`out` drops after this).
        reading.update(|s| s.ended = true);
    });
    // Ends on `Close`, a failed send, or once every handle (the control
    // senders) is gone; the input writer alone going leaves it running.
    // A write the host does not take (its pipe stalled) is raced against
    // `Close`, so a hung host never keeps the stream, its thread and its
    // pipe past a close; a resize arriving meanwhile goes after it.
    let mut writer = tokio::spawn(async move {
        let mut input_open = true;
        let mut resize: Option<(u16, u16)> = None;
        loop {
            if let Some((cols, rows)) = resize.take() {
                match unless_closed(wr.resize(cols, rows), &mut cmds, &mut resize).await {
                    Some(Ok(())) => continue,
                    _ => break,
                }
            }
            let sent = tokio::select! {
                biased;
                cmd = cmds.recv() => match cmd {
                    Some(Cmd::Resize(cols, rows)) => {
                        resize = Some((cols, rows));
                        Ok(())
                    }
                    Some(Cmd::Close) | None => break,
                },
                bytes = input.recv(), if input_open => match bytes {
                    Some(bytes) => match unless_closed(wr.input(&bytes), &mut cmds, &mut resize).await {
                        Some(sent) => sent,
                        None => break,
                    },
                    None => {
                        input_open = false;
                        Ok(())
                    }
                },
            };
            if sent.is_err() {
                break;
            }
        }
    });
    let reader_done = tokio::select! {
        _ = &mut reader => true,
        _ = &mut writer => false,
    };
    shared.update(|s| s.ended = true);
    // The other half stops too (a finished `JoinHandle` is never polled
    // again); both dropped, the pipe closes and the host detaches this client.
    let other = if reader_done { writer } else { reader };
    other.abort();
    let _ = other.await;
}

/// `op` (a write on the pipe) to its end — unless `Close` comes first, or
/// every handle went: then `None`, and `op` is dropped unfinished. A resize
/// that comes meanwhile is kept in `resize` for after.
async fn unless_closed<R>(
    op: impl Future<Output = R>,
    cmds: &mut mpsc::UnboundedReceiver<Cmd>,
    resize: &mut Option<(u16, u16)>,
) -> Option<R> {
    tokio::pin!(op);
    loop {
        tokio::select! {
            biased;
            cmd = cmds.recv() => match cmd {
                Some(Cmd::Resize(cols, rows)) => *resize = Some((cols, rows)),
                Some(Cmd::Close) | None => return None,
            },
            done = &mut op => return Some(done),
        }
    }
}

struct OutputReader {
    rx: mpsc::Receiver<Vec<u8>>,
    pending: Vec<u8>,
    pos: usize,
}

impl Read for OutputReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        while self.pos >= self.pending.len() {
            match self.rx.blocking_recv() {
                Some(chunk) => {
                    self.pending = chunk;
                    self.pos = 0;
                }
                None => return Ok(0),
            }
        }
        let n = buf.len().min(self.pending.len() - self.pos);
        buf[..n].copy_from_slice(&self.pending[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

/// Bounded: a write past [`INPUT_CAP`] chunks in flight waits. From a plain
/// thread it blocks; on a multi-thread runtime's worker it waits in
/// `block_in_place`; on a current-thread runtime it answers `WouldBlock`.
/// Once the stream says it ended, a write is refused: `pump` stops its input
/// half only after the end is published, and a write in that gap would
/// otherwise be queued for a session that is gone.
struct InputWriter {
    tx: mpsc::Sender<Vec<u8>>,
    shared: Arc<Shared>,
}

impl InputWriter {
    fn send(&self, bytes: Vec<u8>) -> io::Result<()> {
        use tokio::sync::mpsc::error::TrySendError;
        if self.shared.lock().ended {
            return Err(closed());
        }
        let bytes = match self.tx.try_send(bytes) {
            Ok(()) => return Ok(()),
            Err(TrySendError::Closed(_)) => return Err(closed()),
            Err(TrySendError::Full(bytes)) => bytes,
        };
        let sent = match tokio::runtime::Handle::try_current() {
            Err(_) => self.tx.blocking_send(bytes),
            Ok(rt) if rt.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread => {
                tokio::task::block_in_place(|| self.tx.blocking_send(bytes))
            }
            Ok(_) => return Err(io::Error::new(io::ErrorKind::WouldBlock, "the session stream's input is full")),
        };
        sent.map_err(|_| closed())
    }
}

impl Write for InputWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if !buf.is_empty() {
            self.send(buf.to_vec())?;
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

struct HostMaster(StreamHandle);

impl super::PtyMaster for HostMaster {
    fn resize(&self, size: PtySize) -> Result<(), String> {
        self.0.resize(size.cols, size.rows).map_err(|e| e.to_string())
    }

    fn get_size(&self) -> Result<PtySize, String> {
        let (cols, rows) = self.0.size();
        Ok(PtySize { cols, rows, pixel_width: 0, pixel_height: 0 })
    }
}

/// The stream as a child process: running until the stream ends.
#[derive(Debug)]
struct HostChild(StreamHandle);

/// The program's own code, or [`LOST_EXIT_CODE`] when it never said one.
fn exit_status(status: StreamStatus) -> ExitStatus {
    ExitStatus::with_exit_code(status.exit_code.map_or(LOST_EXIT_CODE, |code| code as u32))
}

impl ChildKiller for HostChild {
    /// Detaches (see the module doc): the session runs on.
    fn kill(&mut self) -> io::Result<()> {
        self.0.close();
        Ok(())
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(HostChild(self.0.clone()))
    }
}

impl Child for HostChild {
    fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        let status = self.0.status();
        Ok(status.ended.then(|| exit_status(status)))
    }

    fn wait(&mut self) -> io::Result<ExitStatus> {
        loop {
            let status = self.0.wait_ended(Duration::from_secs(3600));
            if status.ended {
                return Ok(exit_status(status));
            }
        }
    }

    fn process_id(&self) -> Option<u32> {
        None
    }

    #[cfg(windows)]
    fn as_raw_handle(&self) -> Option<std::os::windows::io::RawHandle> {
        None
    }
}

#[cfg(test)]
mod tests;
