//! The session host's dispatch (plan §2): one [`Host`] owns every session and
//! serves connections over any `AsyncRead + AsyncWrite` stream through a
//! [`PtySpawner`]. The Windows named pipe and ConPTY plug in later
//! (`win/pipe.rs`, `win/conpty.rs`); tests drive it over `tokio::io::duplex`
//! with a fake PTY.
//!
//! A connection's first frame is `Hello` (read with a few-KiB bound): a wrong
//! token (compared in constant time) or no hello in time closes it without an
//! answer; no shared protocol level answers `Error{version}` and closes. Then
//! it is request/reply, until `Attach` turns it into a stream: a `Snapshot`
//! (history + full repaint), live output, input frames and `Resize`.
//!
//! Locking. A global lock holds only the table (names, sizes, dead, starting)
//! and the session map. Each session has its own lock over its screen and its
//! clients' queues. The order is always global → session, never the reverse.
//! - Output: each PTY is read on its own thread, which takes the session's
//!   lock per chunk to feed the screen and append to every client's queue, so a
//!   `Snapshot` taken under that lock is followed by exactly the output after
//!   it. A read cut mid escape sequence or mid code point is held back
//!   ([`super::screen::complete_prefix`]), so a snapshot or repaint never
//!   leaves a client starting inside one.
//! - Backpressure: the reader never waits on a client. A queue past its byte
//!   bound drops its pending output, and the client's writer sends a full
//!   `Repaint` in its place once it catches up (tmux `tty_block_maybe`).
//! - Input goes through a bounded channel to a per-session writer thread, so
//!   a PTY that stops reading blocks neither the host nor `Kill`: kill, resize
//!   and `try_wait` go through [`Pty`], which never waits on a write. A
//!   killed child is waited for (no zombie).
//! - Spawning runs outside every lock; the table holds a `starting` entry
//!   meanwhile, which an attach waits for and input refuses as `busy`.
//!
//! The host runs only the absolute, non-UNC `argv[0]` an authenticated client
//! sends ([`super::table::validate_spawn`]), with exactly the env it sends; it
//! never searches `PATH`.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use subtle::ConstantTimeEq;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, Notify};
use tokio::task::JoinHandle;

use super::protocol::{
    self, control_payload, negotiate, ErrorCode, PaneInfo, Reply, Request, SessionInfo, KIND_CONTROL, KIND_INPUT,
    KIND_OUTPUT, MAX_FRAME, MAX_HELLO_FRAME, PROTO, PROTO_MIN,
};
use super::screen::{complete_prefix, paste_chunk, CaptureOpts, Screen, DEFAULT_HISTORY_ROWS};
use super::table::{validate_spawn, ClientId, Clock, Created, IdleTimer, NewSession, SessionId, Table, TableError};

/// What a session is started with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnSpec {
    /// `argv[0]` is absolute and not UNC.
    pub argv: Vec<String>,
    /// The child's whole environment.
    pub env: Vec<(String, String)>,
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

/// Control of a running pseudo-terminal child (ConPTY + Job Object on
/// Windows). None of these may wait on a write to the child's input in
/// progress: `kill` must work while a write is stuck.
pub trait Pty: Send + Sync {
    fn resize(&self, cols: u16, rows: u16) -> std::io::Result<()>;
    /// Ends the child and its whole subtree.
    fn kill(&self) -> std::io::Result<()>;
    /// `Some(exit code)` once the child has exited (and is reaped).
    fn try_wait(&self) -> std::io::Result<Option<i32>>;
    fn pid(&self) -> Option<u32>;
}

/// A spawned child: its control, its input and the blocking reader of its
/// output.
pub struct Spawned {
    pub pty: Arc<dyn Pty>,
    pub input: Box<dyn Write + Send>,
    pub output: Box<dyn Read + Send>,
}

/// Starts PTY children. Called on the blocking pool, outside every lock.
pub trait PtySpawner: Send + Sync + 'static {
    fn spawn(&self, spec: &SpawnSpec) -> std::io::Result<Spawned>;
}

/// Host settings; [`HostConfig::new`] fills the defaults.
#[derive(Debug, Clone)]
pub struct HostConfig {
    /// The shared secret every `Hello` must carry. Empty refuses everyone.
    pub token: String,
    pub host_version: String,
    pub pid: u32,
    pub history_rows: usize,
    /// Pending output one client may queue before it is dropped for a repaint.
    pub client_queue_bytes: usize,
    pub idle_exit_ms: u64,
    pub hello_timeout: Duration,
    /// How long an attach waits for a session that is still starting.
    pub start_wait: Duration,
}

impl HostConfig {
    pub fn new(token: impl Into<String>, host_version: impl Into<String>, pid: u32) -> Self {
        Self {
            token: token.into(),
            host_version: host_version.into(),
            pid,
            history_rows: DEFAULT_HISTORY_ROWS,
            client_queue_bytes: 4 << 20,
            idle_exit_ms: 60_000,
            hello_timeout: Duration::from_secs(5),
            start_wait: Duration::from_secs(10),
        }
    }
}

/// The `Busy` message of a `Spawn` refused because the host is leaving: a
/// client reconnects (starting a fresh host if need be) and retries.
pub const SHUTTING_DOWN: &str = "the host is shutting down";

/// Input chunks queued per session before a sender waits.
const INPUT_QUEUE: usize = 256;
/// How long a killed child is waited for before it is left to the OS.
const REAP_WAIT: Duration = Duration::from_secs(5);

enum Out {
    Control(Vec<u8>),
    /// Live output: dropped when the queue overflows.
    Output(Vec<u8>),
    /// Snapshot bytes: never dropped.
    Pinned(Vec<u8>),
    /// Output was dropped here: the writer repaints the screen in its place.
    RepaintHere,
}

struct ClientQ {
    items: VecDeque<Out>,
    bytes: usize,
    behind: bool,
    closed: bool,
    notify: Arc<Notify>,
}

impl ClientQ {
    fn push(&mut self, out: Out) {
        self.items.push_back(out);
        self.notify.notify_one();
    }

    fn push_control(&mut self, reply: &Reply) {
        self.push(Out::Control(control_payload(reply)));
    }

    fn push_pinned(&mut self, bytes: &[u8]) {
        for chunk in protocol::chunks(bytes) {
            self.items.push_back(Out::Pinned(chunk.to_vec()));
        }
        self.notify.notify_one();
    }

    fn push_output(&mut self, bytes: &[u8], cap: usize) {
        if self.behind || self.closed {
            return;
        }
        if self.bytes + bytes.len() > cap {
            self.items.retain(|o| !matches!(o, Out::Output(_)));
            self.bytes = 0;
            self.behind = true;
            self.push(Out::RepaintHere);
            return;
        }
        self.bytes += bytes.len();
        self.push(Out::Output(bytes.to_vec()));
    }

    fn close(&mut self) {
        self.closed = true;
        self.notify.notify_one();
    }
}

/// A session's runtime half, under its own lock.
struct Inner {
    screen: Screen,
    output_bytes: u64,
    /// The tail of the last read that ended mid-sequence.
    held: Vec<u8>,
    clients: HashMap<ClientId, ClientQ>,
    /// Removed from the table: no more output, no new clients.
    ended: bool,
    /// Exited under remain-on-exit.
    dead: bool,
    /// A paste sent in pieces is open (bracketed).
    paste_open: bool,
    /// The cwd last reported to the table.
    cwd: Option<String>,
}

struct Session {
    id: SessionId,
    pty: Arc<dyn Pty>,
    input: mpsc::Sender<Vec<u8>>,
    inner: Mutex<Inner>,
}

impl Session {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl Inner {
    /// Feeds complete output to the screen and every client; returns the new
    /// cwd when an OSC changed it.
    fn feed(&mut self, bytes: &[u8], cap: usize) -> Option<String> {
        if bytes.is_empty() {
            return None;
        }
        self.output_bytes += bytes.len() as u64;
        self.screen.process(bytes);
        for q in self.clients.values_mut() {
            q.push_output(bytes, cap);
        }
        let cwd = self.screen.cwd().map(str::to_owned);
        if cwd.is_some() && cwd != self.cwd {
            self.cwd.clone_from(&cwd);
            return cwd;
        }
        None
    }

    fn end(&mut self, code: Option<i32>) {
        self.ended = true;
        for q in self.clients.values_mut() {
            q.push_control(&Reply::Exit { code });
            q.close();
        }
    }
}

struct Global {
    table: Table,
    sessions: HashMap<SessionId, Arc<Session>>,
    next_client: ClientId,
    connections: usize,
    idle: IdleTimer,
    shutdown: bool,
}

impl Global {
    /// Session `name` with a running child.
    fn session(&self, name: &str) -> Result<Arc<Session>, TableError> {
        let e = self.table.get(name).ok_or(TableError::NotFound)?;
        if e.starting {
            return Err(TableError::Starting);
        }
        self.sessions.get(&e.id).cloned().ok_or(TableError::NotFound)
    }

    /// Removes session `id` and ends its streams; returns its runtime half
    /// (none while it was still starting).
    fn end_session(&mut self, id: SessionId, code: Option<i32>) -> Option<Arc<Session>> {
        self.table.remove_id(id);
        let session = self.sessions.remove(&id)?;
        session.lock().end(code);
        Some(session)
    }

    /// Applies a new window size to session `id`'s screen and PTY.
    fn apply_size(&self, id: SessionId, size: Option<(u16, u16)>) {
        let (Some((cols, rows)), Some(s)) = (size, self.sessions.get(&id)) else { return };
        s.lock().screen.resize(cols, rows);
        let _ = s.pty.resize(cols, rows);
    }
}

struct Shared {
    cfg: HostConfig,
    spawner: Arc<dyn PtySpawner>,
    clock: Arc<dyn Clock>,
    global: Mutex<Global>,
    /// Woken whenever a starting session started or failed to.
    started: Notify,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, Global> {
        self.global.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// The session host. Cheap to clone; every clone is the same host.
#[derive(Clone)]
pub struct Host {
    shared: Arc<Shared>,
}

fn table_code(e: TableError) -> ErrorCode {
    match e {
        TableError::BadName => ErrorCode::BadName,
        TableError::NotFound => ErrorCode::NotFound,
        TableError::Exists => ErrorCode::Exists,
        TableError::Dead => ErrorCode::Dead,
        TableError::Starting => ErrorCode::Busy,
    }
}

fn table_error(e: TableError) -> Reply {
    Reply::error(table_code(e), format!("{e:?}"))
}

/// A capture that fits one frame: the oldest lines go first.
fn captured(mut text: String) -> Reply {
    loop {
        let size = control_payload(&Reply::Captured { text: String::new() }).len()
            + serde_json::to_string(&text).map(|s| s.len()).unwrap_or(usize::MAX);
        if size <= MAX_FRAME {
            return Reply::Captured { text };
        }
        let lines = text.split_inclusive('\n').count();
        text = if lines > 1 {
            text.split_inclusive('\n').skip((lines / 4).max(1)).collect()
        } else {
            // One huge line: keep its end.
            let mut start = text.len().saturating_sub(MAX_FRAME / 8);
            while !text.is_char_boundary(start) {
                start += 1;
            }
            text[start..].to_string()
        };
    }
}

/// Kills `pty` and waits (bounded) for it to be reaped.
async fn kill_and_reap(pty: Arc<dyn Pty>) {
    let _ = tokio::task::spawn_blocking(move || {
        let _ = pty.kill();
        let deadline = std::time::Instant::now() + REAP_WAIT;
        while std::time::Instant::now() < deadline {
            if !matches!(pty.try_wait(), Ok(None)) {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    })
    .await;
}

/// Counts a connection while it lives; opening and closing both restart the
/// idle period.
struct ConnGuard(Arc<Shared>);

impl ConnGuard {
    fn new(shared: Arc<Shared>) -> Self {
        {
            let mut g = shared.lock();
            g.connections += 1;
            g.idle.reset();
        }
        Self(shared)
    }
}

impl Drop for ConnGuard {
    fn drop(&mut self) {
        let mut g = self.0.lock();
        g.connections -= 1;
        g.idle.reset();
    }
}

/// Detaches a stream client however its connection ends, a dropped `serve`
/// future included: its queue, its size entry and its writer task go.
struct StreamGuard {
    shared: Arc<Shared>,
    session: Arc<Session>,
    cid: ClientId,
    writer: JoinHandle<()>,
}

impl Drop for StreamGuard {
    fn drop(&mut self) {
        self.writer.abort();
        self.session.lock().clients.remove(&self.cid);
        let mut g = self.shared.lock();
        let size = g.table.detach_client(self.session.id, self.cid);
        g.apply_size(self.session.id, size);
    }
}

impl Host {
    pub fn new(cfg: HostConfig, spawner: impl PtySpawner, clock: Arc<dyn Clock>) -> Self {
        let idle = IdleTimer::new(cfg.idle_exit_ms);
        let global = Global {
            table: Table::new(),
            sessions: HashMap::new(),
            next_client: 0,
            connections: 0,
            idle,
            shutdown: false,
        };
        let shared =
            Shared { cfg, spawner: Arc::new(spawner), clock, global: Mutex::new(global), started: Notify::new() };
        Self { shared: Arc::new(shared) }
    }

    pub fn session_count(&self) -> usize {
        self.shared.lock().table.len()
    }

    pub fn connection_count(&self) -> usize {
        self.shared.lock().connections
    }

    /// Every session, as `List` answers (the host's `sessions.json` too).
    pub fn sessions(&self) -> Vec<SessionInfo> {
        let g = self.shared.lock();
        g.table
            .iter()
            .map(|(name, e)| SessionInfo {
                name: name.clone(),
                created: e.created,
                activity: e.activity,
                attached: e.clients.len(),
                cwd: e.cwd.clone(),
                argv: e.argv.clone(),
                dead: e.is_dead(),
            })
            .collect()
    }

    /// Called once [`Self::tick`] said exit and the accept loop has stopped
    /// (every accepted connection counted, [`Self::spawn_serve`]): when a
    /// client arrived meanwhile the exit is called off — `shutdown` cleared,
    /// the idle period restarted — and the caller listens again (`true`).
    pub fn resume_if_connected(&self) -> bool {
        let mut g = self.shared.lock();
        if g.connections == 0 {
            return false;
        }
        g.shutdown = false;
        g.idle.reset();
        true
    }

    /// Reaps exited children, then decides under the lock whether the host
    /// exits (`Shutdown` asked, or idle past `idle_exit_ms`). Once it says
    /// yes, every later `Spawn` is refused. The accept loop calls this on an
    /// interval ([`Self::run_ticks`]).
    pub fn tick(&self) -> bool {
        let live: Vec<(SessionId, Arc<dyn Pty>)> = {
            let g = self.shared.lock();
            g.table
                .iter()
                .filter(|(_, e)| !e.is_dead() && !e.starting)
                .filter_map(|(_, e)| g.sessions.get(&e.id).map(|s| (e.id, s.pty.clone())))
                .collect()
        };
        for (id, pty) in live {
            if let Ok(Some(code)) = pty.try_wait() {
                self.on_exit(id, Some(code));
            }
        }
        let now = self.shared.clock.now_ms();
        let mut g = self.shared.lock();
        let (sessions, connections) = (g.table.len(), g.connections);
        if g.idle.observe(now, sessions, connections) {
            g.shutdown = true;
        }
        g.shutdown
    }

    /// Ticks every `every` until [`Self::tick`] says to exit.
    pub async fn run_ticks(&self, every: Duration) {
        let mut interval = tokio::time::interval(every);
        loop {
            interval.tick().await;
            if self.tick() {
                return;
            }
        }
    }

    fn note_output(&self, id: SessionId, cwd: Option<String>) {
        let now = self.shared.clock.now_ms();
        let mut g = self.shared.lock();
        g.table.note_activity(id, now);
        if let Some(cwd) = cwd {
            g.table.set_cwd(id, &cwd);
        }
    }

    /// One read from the child; `false` once the session ended.
    fn on_output(&self, session: &Session, bytes: &[u8]) -> bool {
        let cap = self.shared.cfg.client_queue_bytes;
        let cwd = {
            let mut inner = session.lock();
            if inner.ended {
                return false;
            }
            inner.held.extend_from_slice(bytes);
            let cut = complete_prefix(&inner.held);
            if cut == 0 {
                return true;
            }
            let ready: Vec<u8> = inner.held.drain(..cut).collect();
            inner.feed(&ready, cap)
        };
        self.note_output(session.id, cwd);
        true
    }

    /// The child's output ended: pass on what was held back; if the child
    /// has exited, end or kill the session now, else [`Self::tick`] will.
    fn on_eof(&self, session: &Session) {
        let cwd = {
            let mut inner = session.lock();
            if inner.ended {
                return;
            }
            let rest = std::mem::take(&mut inner.held);
            inner.feed(&rest, self.shared.cfg.client_queue_bytes)
        };
        self.note_output(session.id, cwd);
        if let Ok(Some(code)) = session.pty.try_wait() {
            self.on_exit(session.id, Some(code));
        }
    }

    fn on_exit(&self, id: SessionId, code: Option<i32>) {
        let mut g = self.shared.lock();
        match g.table.by_id(id) {
            Some((_, e)) if !e.is_dead() => {}
            _ => return,
        }
        if g.table.mark_dead(id, code) {
            if let Some(s) = g.sessions.get(&id) {
                let mut inner = s.lock();
                inner.dead = true;
                for q in inner.clients.values_mut() {
                    q.push_control(&Reply::Exit { code });
                    q.push_control(&Reply::Dead);
                }
            }
        } else {
            g.end_session(id, code);
        }
    }

    /// The child's input writer and output reader threads.
    fn start_threads(
        &self,
        session: &Arc<Session>,
        mut rx: mpsc::Receiver<Vec<u8>>,
        mut input: Box<dyn Write + Send>,
        mut output: Box<dyn Read + Send>,
    ) -> std::io::Result<()> {
        let id = session.id;
        std::thread::Builder::new().name(format!("session-host-in-{id}")).spawn(move || {
            while let Some(bytes) = rx.blocking_recv() {
                if input.write_all(&bytes).and_then(|()| input.flush()).is_err() {
                    break;
                }
            }
        })?;
        let host = self.clone();
        let session = session.clone();
        std::thread::Builder::new().name(format!("session-host-out-{id}")).spawn(move || {
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                match output.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if !host.on_output(&session, &buf[..n]) {
                            return;
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                    Err(_) => break,
                }
            }
            host.on_eof(&session);
        })?;
        Ok(())
    }

    /// Serves one connection until it closes.
    pub async fn serve<IO>(&self, io: IO)
    where
        IO: AsyncRead + AsyncWrite + Send + 'static,
    {
        self.serve_counted(ConnGuard::new(self.shared.clone()), io).await
    }

    /// [`Self::serve`] on a new task, the connection counted before this
    /// returns: an accept loop stopped right after it can trust
    /// [`Self::resume_if_connected`].
    pub fn spawn_serve<IO>(&self, io: IO) -> JoinHandle<()>
    where
        IO: AsyncRead + AsyncWrite + Send + 'static,
    {
        let conn = ConnGuard::new(self.shared.clone());
        let host = self.clone();
        tokio::spawn(async move { host.serve_counted(conn, io).await })
    }

    async fn serve_counted<IO>(&self, _conn: ConnGuard, io: IO)
    where
        IO: AsyncRead + AsyncWrite + Send + 'static,
    {
        let (mut rd, mut wr) = tokio::io::split(io);
        if !self.handshake(&mut rd, &mut wr).await {
            let _ = wr.shutdown().await;
            return;
        }
        loop {
            let frame = match protocol::read_frame(&mut rd).await {
                Ok(Some(f)) => f,
                _ => return,
            };
            if frame.kind != KIND_CONTROL {
                continue;
            }
            let req = match serde_json::from_slice::<Request>(&frame.payload) {
                Ok(req) => req,
                Err(e) => {
                    let reply = Reply::error(ErrorCode::BadRequest, e.to_string());
                    if protocol::write_control(&mut wr, &reply).await.is_err() {
                        return;
                    }
                    continue;
                }
            };
            if let Request::Attach { name, cols, rows, history_lines } = req {
                match self.attach(&name, cols, rows, history_lines).await {
                    Ok((session, cid)) => return self.stream(session, cid, rd, wr).await,
                    Err(reply) => {
                        if protocol::write_control(&mut wr, &reply).await.is_err() {
                            return;
                        }
                        continue;
                    }
                }
            }
            let reply = self.handle(req).await;
            if protocol::write_control(&mut wr, &reply).await.is_err() {
                return;
            }
        }
    }

    /// Reads and checks `Hello`, answers `Welcome`; `false` closes.
    async fn handshake<R, W>(&self, rd: &mut R, wr: &mut W) -> bool
    where
        R: AsyncRead + Unpin,
        W: AsyncWrite + Unpin,
    {
        let cfg = &self.shared.cfg;
        let frame = match tokio::time::timeout(cfg.hello_timeout, protocol::read_frame_max(rd, MAX_HELLO_FRAME)).await
        {
            Ok(Ok(Some(f))) if f.kind == KIND_CONTROL => f,
            _ => return false,
        };
        let Ok(Request::Hello { token, proto_min, proto_max, client_version: _ }) =
            serde_json::from_slice::<Request>(&frame.payload)
        else {
            return false;
        };
        let token_ok: bool = token.as_bytes().ct_eq(cfg.token.as_bytes()).into();
        if cfg.token.is_empty() || !token_ok {
            return false;
        }
        let Some(proto) = negotiate(PROTO_MIN, PROTO, proto_min, proto_max) else {
            let msg = format!("host speaks protocol {PROTO_MIN}..={PROTO}");
            let _ = protocol::write_control(wr, &Reply::error(ErrorCode::Version, msg)).await;
            return false;
        };
        let welcome = Reply::Welcome {
            proto,
            host_version: cfg.host_version.clone(),
            pid: cfg.pid,
            caps: protocol::CAPS.iter().map(|c| c.to_string()).collect(),
        };
        protocol::write_control(wr, &welcome).await.is_ok()
    }

    /// One request/reply.
    async fn handle(&self, req: Request) -> Reply {
        match req {
            Request::Spawn { name, argv, env, cwd, cols, rows, remain_on_exit, size_policy, create_only } => {
                let new = NewSession {
                    name,
                    argv,
                    cwd,
                    cols,
                    rows,
                    policy: size_policy,
                    remain_on_exit,
                    create_only,
                };
                self.spawn(new, env).await
            }
            Request::Resize { name: Some(name), cols, rows } => {
                let mut g = self.shared.lock();
                let Some(id) = g.table.get(&name).map(|e| e.id) else {
                    return table_error(TableError::NotFound);
                };
                let size = g.table.set_size(id, cols, rows);
                g.apply_size(id, size);
                Reply::Ok
            }
            Request::Resize { name: None, .. } => Reply::error(ErrorCode::BadRequest, "resize needs a name outside a stream"),
            Request::Input { name, bytes } => match self.input_session(&name) {
                Ok(session) => send_input(&session, bytes).await,
                Err(reply) => reply,
            },
            Request::Paste { name, text, bracketed, cont, more } => {
                let session = match self.input_session(&name) {
                    Ok(s) => s,
                    Err(reply) => return reply,
                };
                let bytes = {
                    let mut inner = session.lock();
                    let mode = inner.screen.bracketed_paste();
                    paste_chunk(&text, bracketed, mode, cont, more, &mut inner.paste_open)
                };
                send_input(&session, bytes).await
            }
            Request::Capture { name, join_wrapped, escapes, history_lines } => {
                let found = self.shared.lock().session(&name);
                let session = match found {
                    Ok(s) => s,
                    Err(e) => return table_error(e),
                };
                let opts = CaptureOpts { join_wrapped, escapes };
                let text = {
                    let inner = session.lock();
                    if history_lines == 0 {
                        inner.screen.capture(opts)
                    } else {
                        inner.screen.history(history_lines, opts)
                    }
                };
                captured(text)
            }
            Request::Info { name } => {
                let g = self.shared.lock();
                let Some(e) = g.table.get(&name) else { return table_error(TableError::NotFound) };
                let session = match g.session(&name) {
                    Ok(s) => s,
                    Err(e) => return table_error(e),
                };
                let inner = session.lock();
                Reply::Pane(PaneInfo {
                    name,
                    dead: e.is_dead(),
                    exit_code: e.dead.flatten(),
                    pid: session.pty.pid(),
                    created: e.created,
                    activity: e.activity,
                    cols: e.size.0,
                    rows: e.size.1,
                    attached: e.clients.len(),
                    cwd: e.cwd.clone(),
                    bracketed_paste: inner.screen.bracketed_paste(),
                    alternate_screen: inner.screen.alternate_screen(),
                    output_bytes: inner.output_bytes,
                })
            }
            Request::List => Reply::Sessions { sessions: self.sessions() },
            Request::Kill { name } => {
                if !super::table::valid_name(&name) {
                    return table_error(TableError::BadName);
                }
                self.kill_names(vec![name]).await;
                Reply::Ok
            }
            Request::KillPrefix { prefix } => {
                if !super::table::valid_name(&prefix) {
                    return table_error(TableError::BadName);
                }
                let names = self.shared.lock().table.names_with_prefix(&prefix);
                Reply::Killed { count: self.kill_names(names).await }
            }
            Request::Rename { name, new_name } => match self.shared.lock().table.rename(&name, &new_name) {
                Ok(()) => Reply::Ok,
                Err(e) => table_error(e),
            },
            Request::Shutdown { if_idle } => {
                let names: Vec<String> = {
                    let mut g = self.shared.lock();
                    if if_idle && !g.table.is_empty() {
                        return Reply::error(ErrorCode::Busy, "sessions are running");
                    }
                    // Decided under the lock: no Spawn is accepted after this.
                    g.shutdown = true;
                    g.table.iter().map(|(n, _)| n.clone()).collect()
                };
                self.kill_names(names).await;
                Reply::Ok
            }
            Request::Hello { .. } => Reply::error(ErrorCode::BadRequest, "already greeted"),
            Request::Attach { .. } => Reply::error(ErrorCode::BadRequest, "attach is handled by the connection"),
            Request::Unknown => Reply::error(ErrorCode::Unsupported, "unknown request"),
        }
    }

    /// Session `name` if it takes input: running, started, not dead.
    fn input_session(&self, name: &str) -> Result<Arc<Session>, Reply> {
        let g = self.shared.lock();
        g.table.input_target(name).map_err(table_error)?;
        g.session(name).map_err(table_error)
    }

    async fn spawn(&self, new: NewSession, env: Vec<(String, String)>) -> Reply {
        if let Err(msg) = validate_spawn(&new.argv, &env, new.cwd.as_deref()) {
            return Reply::error(ErrorCode::BadRequest, msg);
        }
        let spec = SpawnSpec {
            argv: new.argv.clone(),
            env,
            cwd: new.cwd.clone(),
            cols: new.cols.max(1),
            rows: new.rows.max(1),
        };
        let now = self.shared.clock.now_ms();
        let id = {
            let mut g = self.shared.lock();
            if g.shutdown {
                return Reply::error(ErrorCode::Busy, SHUTTING_DOWN);
            }
            match g.table.create_or_attach(new, now) {
                Ok(Created::Existing(_)) => return Reply::Spawned { created: false },
                Ok(Created::New(id)) => id,
                Err(e) => return table_error(e),
            }
        };
        // Outside every lock: process creation may be slow.
        let spawner = self.shared.spawner.clone();
        let spawned = tokio::task::spawn_blocking(move || spawner.spawn(&spec).map(|s| (s, spec)))
            .await
            .map_err(std::io::Error::other)
            .and_then(|r| r);
        let (spawned, spec) = match spawned {
            Ok(s) => s,
            Err(e) => {
                let mut g = self.shared.lock();
                if g.table.by_id(id).is_some_and(|(_, e)| e.starting) {
                    g.table.remove_id(id);
                }
                drop(g);
                self.shared.started.notify_waiters();
                return Reply::error(ErrorCode::Io, e.to_string());
            }
        };
        let (tx, rx) = mpsc::channel(INPUT_QUEUE);
        let session = Arc::new(Session {
            id,
            pty: spawned.pty.clone(),
            input: tx,
            inner: Mutex::new(Inner {
                screen: Screen::new(spec.cols, spec.rows, self.shared.cfg.history_rows),
                output_bytes: 0,
                held: Vec::new(),
                clients: HashMap::new(),
                ended: false,
                dead: false,
                paste_open: false,
                cwd: None,
            }),
        });
        let kept = {
            let mut g = self.shared.lock();
            if !g.shutdown && g.table.mark_started(id) {
                // The size may have changed while it started.
                let size = g.table.by_id(id).map(|(_, e)| e.size);
                g.sessions.insert(id, session.clone());
                if size.is_some_and(|s| s != (spec.cols, spec.rows)) {
                    g.apply_size(id, size);
                }
                true
            } else {
                g.table.remove_id(id);
                false
            }
        };
        self.shared.started.notify_waiters();
        if !kept {
            kill_and_reap(spawned.pty).await;
            return Reply::error(ErrorCode::NotFound, "the session ended while it was starting");
        }
        if let Err(e) = self.start_threads(&session, rx, spawned.input, spawned.output) {
            self.shared.lock().end_session(id, None);
            kill_and_reap(spawned.pty).await;
            return Reply::error(ErrorCode::Io, e.to_string());
        }
        Reply::Spawned { created: true }
    }

    /// Kills the named sessions that exist; returns how many did.
    async fn kill_names(&self, names: Vec<String>) -> usize {
        let (count, ended) = {
            let mut g = self.shared.lock();
            let ids: Vec<SessionId> = names.iter().filter_map(|n| g.table.get(n).map(|e| e.id)).collect();
            let ended: Vec<Arc<Session>> = ids.iter().filter_map(|&id| g.end_session(id, None)).collect();
            (ids.len(), ended)
        };
        for session in ended {
            kill_and_reap(session.pty.clone()).await;
        }
        count
    }

    /// Registers a stream client on session `name`, waiting while it starts:
    /// its queue begins with the `Snapshot`, taken under the session lock that
    /// orders all later output after it.
    async fn attach(&self, name: &str, cols: u16, rows: u16, history_lines: usize) -> Result<(Arc<Session>, ClientId), Reply> {
        let deadline = tokio::time::Instant::now() + self.shared.cfg.start_wait;
        let (session, cid) = loop {
            let started = self.shared.started.notified();
            {
                let mut g = self.shared.lock();
                let Some(e) = g.table.get(name) else { return Err(table_error(TableError::NotFound)) };
                let (id, starting) = (e.id, e.starting);
                if !starting {
                    let Some(session) = g.sessions.get(&id).cloned() else {
                        return Err(table_error(TableError::NotFound));
                    };
                    g.next_client += 1;
                    let cid = g.next_client;
                    let size = g.table.touch_client(id, cid, Some((cols, rows)));
                    g.apply_size(id, size);
                    break (session, cid);
                }
            }
            if tokio::time::timeout_at(deadline, started).await.is_err() {
                return Err(table_error(TableError::Starting));
            }
        };
        let mut inner = session.lock();
        if inner.ended {
            drop(inner);
            let mut g = self.shared.lock();
            let size = g.table.detach_client(session.id, cid);
            g.apply_size(session.id, size);
            return Err(table_error(TableError::NotFound));
        }
        let (scols, srows) = inner.screen.size();
        let mut q = ClientQ { items: VecDeque::new(), bytes: 0, behind: false, closed: false, notify: Arc::new(Notify::new()) };
        q.push_control(&Reply::Snapshot { cols: scols, rows: srows });
        q.push_pinned(&inner.screen.snapshot(history_lines));
        if inner.dead {
            q.push_control(&Reply::Dead);
        }
        inner.clients.insert(cid, q);
        drop(inner);
        Ok((session, cid))
    }

    /// Runs an attached stream: a writer task drains the client's queue, this
    /// task reads its input and resizes until either side ends.
    async fn stream<R, W>(&self, session: Arc<Session>, cid: ClientId, mut rd: R, wr: W)
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let writer = tokio::spawn(write_stream(session.clone(), cid, wr));
        let mut guard = StreamGuard { shared: self.shared.clone(), session: session.clone(), cid, writer };
        let id = session.id;
        loop {
            let frame = tokio::select! {
                f = protocol::read_frame(&mut rd) => f,
                _ = &mut guard.writer => break,
            };
            let frame = match frame {
                Ok(Some(f)) => f,
                _ => break,
            };
            match frame.kind {
                KIND_INPUT => {
                    {
                        let mut g = self.shared.lock();
                        if g.table.by_id(id).is_none_or(|(_, e)| e.is_dead()) {
                            continue;
                        }
                        let size = g.table.touch_client(id, cid, None);
                        g.apply_size(id, size);
                    }
                    let _ = session.input.send(frame.payload).await;
                }
                KIND_CONTROL => {
                    if let Ok(Request::Resize { cols, rows, .. }) = serde_json::from_slice::<Request>(&frame.payload) {
                        let mut g = self.shared.lock();
                        let size = g.table.touch_client(id, cid, Some((cols, rows)));
                        g.apply_size(id, size);
                    }
                }
                _ => {}
            }
        }
        drop(guard);
    }
}

async fn send_input(session: &Session, bytes: Vec<u8>) -> Reply {
    match session.input.send(bytes).await {
        Ok(()) => Reply::Ok,
        Err(_) => Reply::error(ErrorCode::Io, "the session's input is closed"),
    }
}

/// Drains client `cid`'s queue to `wr`; a `RepaintHere` becomes a full
/// repaint built under the session lock. Ends when the queue is closed and
/// empty, or the write fails.
async fn write_stream<W: AsyncWrite + Unpin>(session: Arc<Session>, cid: ClientId, mut wr: W) {
    loop {
        let (batch, closed, notify) = {
            let mut inner = session.lock();
            let inner = &mut *inner;
            let Some(q) = inner.clients.get_mut(&cid) else { break };
            let mut batch = Vec::with_capacity(q.items.len());
            for out in q.items.drain(..) {
                match out {
                    Out::Control(p) => batch.push((KIND_CONTROL, p)),
                    Out::Output(b) | Out::Pinned(b) => batch.push((KIND_OUTPUT, b)),
                    Out::RepaintHere => {
                        let (cols, rows) = inner.screen.size();
                        batch.push((KIND_CONTROL, control_payload(&Reply::Repaint { cols, rows })));
                        for chunk in protocol::chunks(&inner.screen.repaint()) {
                            batch.push((KIND_OUTPUT, chunk.to_vec()));
                        }
                        q.behind = false;
                    }
                }
            }
            q.bytes = 0;
            (batch, q.closed, q.notify.clone())
        };
        if batch.is_empty() {
            if closed {
                break;
            }
            notify.notified().await;
            continue;
        }
        for (kind, payload) in batch {
            if protocol::write_frame(&mut wr, kind, &payload).await.is_err() {
                if let Some(q) = session.lock().clients.get_mut(&cid) {
                    q.closed = true;
                }
                return;
            }
        }
    }
    let _ = wr.shutdown().await;
}

#[cfg(test)]
mod tests;
