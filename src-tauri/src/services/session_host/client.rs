//! A session host client (plan §2, Modules): handshake, request/reply and an
//! attached stream, over any `AsyncRead + AsyncWrite` stream. It backs
//! `session_mux::winhost` and the pipe-backed PTY (`terminal::host_pty`).
//!
//! Getting a stream is the [`Connector`]'s job, and that is the seam for what
//! comes later: the Windows connector opens the named pipe and, on "no such
//! pipe", starts the host (`launch.rs`: its own copy, detached, breakaway) and
//! retries for up to 3 s. A host that exists but does not answer is not
//! "absent" — the caller fails closed there rather than starting a second one
//! (plan §4, Fallback vs fail closed). Tests connect over `tokio::io::duplex`.

use std::future::Future;

use tokio::io::{AsyncRead, AsyncWrite, ReadHalf, WriteHalf};

use super::protocol::{
    self, ErrorCode, PaneInfo, Reply, Request, SessionInfo, INPUT_CHUNK, KIND_CONTROL, KIND_INPUT, KIND_OUTPUT,
    PASTE_CHUNK, PROTO, PROTO_MIN,
};
use super::screen::PASTE_END_MARKER;

/// Opens a byte stream to the host.
pub trait Connector: Send + Sync {
    type Io: AsyncRead + AsyncWrite + Unpin + Send + 'static;
    fn connect(&self) -> impl Future<Output = std::io::Result<Self::Io>> + Send;
}

#[derive(Debug)]
pub enum ClientError {
    Io(std::io::Error),
    /// The host closed the connection: a refused token closes without a word.
    Closed,
    /// No protocol level both sides speak.
    Version(String),
    /// The host refused the request.
    Host { code: ErrorCode, msg: String },
    /// A reply that does not fit the request.
    Protocol(String),
}

impl std::fmt::Display for ClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ClientError::Io(e) => write!(f, "session host i/o: {e}"),
            ClientError::Closed => write!(f, "session host closed the connection"),
            ClientError::Version(m) => write!(f, "session host version: {m}"),
            ClientError::Host { code, msg } => write!(f, "session host refused ({code:?}): {msg}"),
            ClientError::Protocol(m) => write!(f, "session host protocol: {m}"),
        }
    }
}

impl std::error::Error for ClientError {}

impl From<std::io::Error> for ClientError {
    fn from(e: std::io::Error) -> Self {
        ClientError::Io(e)
    }
}

pub type Result<T> = std::result::Result<T, ClientError>;

/// What the host said in `Welcome`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Welcome {
    pub proto: u32,
    pub host_version: String,
    pub pid: u32,
    pub caps: Vec<String>,
}

fn unexpected(reply: Reply) -> ClientError {
    ClientError::Protocol(format!("unexpected reply {reply:?}"))
}

/// The reply to a request. Frames of other kinds are skipped; a reply this
/// build does not know is a [`ClientError::Protocol`] (only stream events may
/// be skipped, and a request has exactly one reply). `Error` becomes
/// [`ClientError::Host`].
async fn recv_reply<R: AsyncRead + Unpin>(rd: &mut R) -> Result<Reply> {
    loop {
        let Some(frame) = protocol::read_frame(rd).await? else { return Err(ClientError::Closed) };
        if frame.kind != KIND_CONTROL {
            continue;
        }
        let reply: Reply = serde_json::from_slice(&frame.payload).map_err(|e| ClientError::Protocol(e.to_string()))?;
        return match reply {
            Reply::Unknown => Err(ClientError::Protocol("a reply this build does not know".into())),
            Reply::Error { code, msg } => Err(ClientError::Host { code, msg }),
            other => Ok(other),
        };
    }
}

/// `text` in pieces of at most `max` bytes, cut on character boundaries.
fn text_chunks(text: &str, max: usize) -> Vec<&str> {
    let mut out = Vec::new();
    let mut rest = text;
    while rest.len() > max {
        let mut cut = max;
        while !rest.is_char_boundary(cut) {
            cut -= 1;
        }
        out.push(&rest[..cut]);
        rest = &rest[cut..];
    }
    out.push(rest);
    out
}

/// A greeted connection in request/reply mode.
pub struct Client<IO> {
    io: IO,
    welcome: Welcome,
}

/// Connects through `connector` and greets the host.
pub async fn connect<C: Connector>(connector: &C, token: &str, client_version: &str) -> Result<Client<C::Io>> {
    let io = connector.connect().await?;
    Client::handshake(io, token, client_version).await
}

impl<IO: AsyncRead + AsyncWrite + Unpin> Client<IO> {
    /// Sends `Hello` with this build's protocol range and waits for `Welcome`.
    pub async fn handshake(io: IO, token: &str, client_version: &str) -> Result<Self> {
        Self::handshake_from(io, token, client_version, PROTO_MIN).await
    }

    /// [`Self::handshake`] offering every level from `proto_min` up: a
    /// connection that only ends sessions offers [`protocol::REAP_PROTO_MIN`]
    /// so an older host can still be told to.
    pub async fn handshake_from(mut io: IO, token: &str, client_version: &str, proto_min: u32) -> Result<Self> {
        let hello = Request::Hello {
            token: token.to_string(),
            proto_min,
            proto_max: PROTO,
            client_version: client_version.to_string(),
        };
        protocol::write_control(&mut io, &hello).await?;
        match recv_reply(&mut io).await {
            Ok(Reply::Welcome { proto, host_version, pid, caps }) => {
                if protocol::negotiate(proto_min, PROTO, proto, proto) != Some(proto) {
                    return Err(ClientError::Version(format!("host chose protocol {proto}")));
                }
                Ok(Self { io, welcome: Welcome { proto, host_version, pid, caps } })
            }
            Ok(other) => Err(unexpected(other)),
            Err(ClientError::Host { code: ErrorCode::Version, msg }) => Err(ClientError::Version(msg)),
            Err(e) => Err(e),
        }
    }

    pub fn welcome(&self) -> &Welcome {
        &self.welcome
    }

    pub fn has_cap(&self, cap: &str) -> bool {
        self.welcome.caps.iter().any(|c| c == cap)
    }

    /// Sends `req` and returns the reply.
    pub async fn request(&mut self, req: &Request) -> Result<Reply> {
        protocol::write_control(&mut self.io, req).await?;
        recv_reply(&mut self.io).await
    }

    async fn ok(&mut self, req: &Request) -> Result<()> {
        match self.request(req).await? {
            Reply::Ok => Ok(()),
            other => Err(unexpected(other)),
        }
    }

    /// Sends a `Spawn`; `true` when it created the session.
    pub async fn spawn(&mut self, spawn: Request) -> Result<bool> {
        if !matches!(spawn, Request::Spawn { .. }) {
            return Err(ClientError::Protocol("spawn takes a Spawn request".into()));
        }
        match self.request(&spawn).await? {
            Reply::Spawned { created } => Ok(created),
            other => Err(unexpected(other)),
        }
    }

    pub async fn capture(&mut self, name: &str, join_wrapped: bool, escapes: bool, history_lines: usize) -> Result<String> {
        let req = Request::Capture { name: name.into(), join_wrapped, escapes, history_lines };
        match self.request(&req).await? {
            Reply::Captured { text } => Ok(text),
            other => Err(unexpected(other)),
        }
    }

    pub async fn info(&mut self, name: &str) -> Result<PaneInfo> {
        match self.request(&Request::Info { name: name.into() }).await? {
            Reply::Pane(info) => Ok(info),
            other => Err(unexpected(other)),
        }
    }

    pub async fn list(&mut self) -> Result<Vec<SessionInfo>> {
        match self.request(&Request::List).await? {
            Reply::Sessions { sessions } => Ok(sessions),
            other => Err(unexpected(other)),
        }
    }

    /// Raw bytes, in [`INPUT_CHUNK`] requests.
    pub async fn input(&mut self, name: &str, bytes: &[u8]) -> Result<()> {
        for chunk in bytes.chunks(INPUT_CHUNK) {
            self.ok(&Request::Input { name: name.into(), bytes: chunk.to_vec() }).await?;
        }
        Ok(())
    }

    /// One paste, in [`PASTE_CHUNK`] requests the host brackets as a whole.
    pub async fn paste(&mut self, name: &str, text: &str, bracketed: bool) -> Result<()> {
        // A marker split across two pieces would escape the host's per-piece
        // stripping; drop it from the whole text first.
        let text = if bracketed { text.replace(PASTE_END_MARKER, "") } else { text.to_string() };
        let pieces = text_chunks(&text, PASTE_CHUNK);
        let last = pieces.len() - 1;
        for (i, piece) in pieces.into_iter().enumerate() {
            let req = Request::Paste { name: name.into(), text: piece.into(), bracketed, cont: i > 0, more: i < last };
            self.ok(&req).await?;
        }
        Ok(())
    }

    pub async fn resize(&mut self, name: &str, cols: u16, rows: u16) -> Result<()> {
        self.ok(&Request::Resize { name: Some(name.into()), cols, rows }).await
    }

    /// Already gone is `Ok`.
    pub async fn kill(&mut self, name: &str) -> Result<()> {
        self.ok(&Request::Kill { name: name.into() }).await
    }

    pub async fn kill_prefix(&mut self, prefix: &str) -> Result<usize> {
        match self.request(&Request::KillPrefix { prefix: prefix.into() }).await? {
            Reply::Killed { count } => Ok(count),
            other => Err(unexpected(other)),
        }
    }

    pub async fn rename(&mut self, name: &str, new_name: &str) -> Result<()> {
        self.ok(&Request::Rename { name: name.into(), new_name: new_name.into() }).await
    }

    pub async fn shutdown(&mut self, if_idle: bool) -> Result<()> {
        self.ok(&Request::Shutdown { if_idle }).await
    }

    /// Turns the connection into a stream on session `name`. The first events
    /// are the snapshot's bytes ([`StreamEvent::Output`]).
    pub async fn attach(mut self, name: &str, cols: u16, rows: u16, history_lines: usize) -> Result<Attached<IO>> {
        let req = Request::Attach { name: name.into(), cols, rows, history_lines };
        match self.request(&req).await? {
            Reply::Snapshot { cols, rows } => Ok(Attached { io: self.io, size: (cols, rows) }),
            other => Err(unexpected(other)),
        }
    }
}

/// What an attached stream delivers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamEvent {
    /// Terminal bytes: the snapshot first, then live output.
    Output(Vec<u8>),
    /// Output was lost; a full repaint at this size follows.
    Repaint { cols: u16, rows: u16 },
    Exit { code: Option<i32> },
    /// The session stays, dead and input-less.
    Dead,
}

/// The next stream event; `None` when the host ended the stream.
async fn next_event<R: AsyncRead + Unpin>(rd: &mut R) -> Result<Option<StreamEvent>> {
    loop {
        let Some(frame) = protocol::read_frame(rd).await? else { return Ok(None) };
        match frame.kind {
            KIND_OUTPUT => return Ok(Some(StreamEvent::Output(frame.payload))),
            KIND_CONTROL => {
                let reply: Reply =
                    serde_json::from_slice(&frame.payload).map_err(|e| ClientError::Protocol(e.to_string()))?;
                match reply {
                    Reply::Repaint { cols, rows } => return Ok(Some(StreamEvent::Repaint { cols, rows })),
                    Reply::Exit { code } => return Ok(Some(StreamEvent::Exit { code })),
                    Reply::Dead => return Ok(Some(StreamEvent::Dead)),
                    _ => continue,
                }
            }
            _ => continue,
        }
    }
}

/// An attached stream.
pub struct Attached<IO> {
    io: IO,
    size: (u16, u16),
}

impl<IO: AsyncRead + AsyncWrite + Unpin> Attached<IO> {
    /// The session's `(cols, rows)` when the snapshot was taken.
    pub fn size(&self) -> (u16, u16) {
        self.size
    }

    pub async fn next(&mut self) -> Result<Option<StreamEvent>> {
        next_event(&mut self.io).await
    }

    pub async fn input(&mut self, bytes: &[u8]) -> Result<()> {
        send_input(&mut self.io, bytes).await
    }

    pub async fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        send_resize(&mut self.io, cols, rows).await
    }

    /// Separate halves, to read output while typing.
    pub fn into_split(self) -> (AttachedReader<IO>, AttachedWriter<IO>) {
        let (rd, wr) = tokio::io::split(self.io);
        (AttachedReader { rd }, AttachedWriter { wr })
    }
}

async fn send_input<W: AsyncWrite + Unpin>(wr: &mut W, bytes: &[u8]) -> Result<()> {
    for chunk in protocol::chunks(bytes) {
        protocol::write_frame(wr, KIND_INPUT, chunk).await?;
    }
    Ok(())
}

async fn send_resize<W: AsyncWrite + Unpin>(wr: &mut W, cols: u16, rows: u16) -> Result<()> {
    Ok(protocol::write_control(wr, &Request::Resize { name: None, cols, rows }).await?)
}

pub struct AttachedReader<IO> {
    rd: ReadHalf<IO>,
}

impl<IO: AsyncRead + AsyncWrite> AttachedReader<IO> {
    pub async fn next(&mut self) -> Result<Option<StreamEvent>> {
        next_event(&mut self.rd).await
    }
}

pub struct AttachedWriter<IO> {
    wr: WriteHalf<IO>,
}

impl<IO: AsyncRead + AsyncWrite> AttachedWriter<IO> {
    pub async fn input(&mut self, bytes: &[u8]) -> Result<()> {
        send_input(&mut self.wr, bytes).await
    }

    pub async fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        send_resize(&mut self.wr, cols, rows).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::session_host::fake_pty::{abs_argv, connect_pair, eventually, spawn_req, test_host};

    struct DuplexConnector(crate::services::session_host::server::Host);

    impl Connector for DuplexConnector {
        type Io = tokio::io::DuplexStream;
        fn connect(&self) -> impl Future<Output = std::io::Result<Self::Io>> + Send {
            let host = self.0.clone();
            async move {
                let (client, server) = tokio::io::duplex(1 << 16);
                tokio::spawn(async move { host.serve(server).await });
                Ok(client)
            }
        }
    }

    #[tokio::test]
    async fn connects_greets_and_requests() {
        let (host, fake, _clock) = test_host();
        let mut c = connect(&DuplexConnector(host.clone()), "secret", "test").await.unwrap();
        assert_eq!(c.welcome().proto, PROTO);
        assert!(c.has_cap("snapshot"));
        assert!(c.spawn(spawn_req("one", false)).await.unwrap());
        assert!(!c.spawn(spawn_req("one", false)).await.unwrap());
        assert_eq!(c.list().await.unwrap()[0].argv, abs_argv());
        fake.last().emit(b"hi there");
        let mut text = String::new();
        for _ in 0..500 {
            text = c.capture("one", true, false, 0).await.unwrap();
            if text.contains("hi there") {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert!(text.starts_with("hi there"), "{text:?}");
        c.input("one", b"x").await.unwrap();
        let child = fake.last();
        eventually(|| child.input() == b"x").await;
        c.kill("one").await.unwrap();
        c.kill("one").await.unwrap();
        assert!(matches!(c.info("one").await, Err(ClientError::Host { code: ErrorCode::NotFound, .. })));
    }

    #[tokio::test]
    async fn an_unknown_reply_to_a_request_is_an_error_not_a_hang() {
        let (io, mut host_end) = tokio::io::duplex(1 << 16);
        let fake_host = tokio::spawn(async move {
            protocol::read_frame(&mut host_end).await.unwrap();
            let welcome = Reply::Welcome { proto: PROTO, host_version: "v".into(), pid: 1, caps: vec![] };
            protocol::write_control(&mut host_end, &welcome).await.unwrap();
            protocol::read_frame(&mut host_end).await.unwrap();
            protocol::write_frame(&mut host_end, KIND_CONTROL, br#"{"type":"hologram"}"#).await.unwrap();
            host_end
        });
        let mut c = Client::handshake(io, "t", "v").await.unwrap();
        let res = tokio::time::timeout(std::time::Duration::from_secs(5), c.list()).await.unwrap();
        assert!(matches!(res, Err(ClientError::Protocol(_))), "{res:?}");
        drop(fake_host.await.unwrap());
    }

    /// A reaping connection offers every level from `REAP_PROTO_MIN` and
    /// accepts a host that answers at it.
    #[tokio::test]
    async fn a_reaping_handshake_speaks_down_to_the_reap_level() {
        let (io, mut host_end) = tokio::io::duplex(1 << 16);
        let fake_host = tokio::spawn(async move {
            let hello = protocol::read_frame(&mut host_end).await.unwrap().unwrap();
            let hello: Request = serde_json::from_slice(&hello.payload).unwrap();
            let Request::Hello { proto_min, .. } = hello else { panic!("{hello:?}") };
            let welcome = Reply::Welcome { proto: proto_min, host_version: "old".into(), pid: 1, caps: vec![] };
            protocol::write_control(&mut host_end, &welcome).await.unwrap();
            (proto_min, host_end)
        });
        let c = Client::handshake_from(io, "t", "v", protocol::REAP_PROTO_MIN).await.unwrap();
        let (offered, _host_end) = fake_host.await.unwrap();
        assert_eq!(offered, protocol::REAP_PROTO_MIN);
        assert_eq!(c.welcome().proto, protocol::REAP_PROTO_MIN);
    }

    #[test]
    fn text_chunks_cut_on_char_boundaries() {
        assert_eq!(text_chunks("", 3), vec![""]);
        assert_eq!(text_chunks("abcdefg", 3), vec!["abc", "def", "g"]);
        assert_eq!(text_chunks("aé€b", 3), vec!["aé", "€", "b"]);
        let joined: String = text_chunks(&"é".repeat(1000), 7).concat();
        assert_eq!(joined, "é".repeat(1000));
    }

    #[tokio::test]
    async fn large_input_and_pastes_go_in_pieces_and_arrive_whole() {
        let (host, fake, _clock) = test_host();
        let mut c = Client::handshake(connect_pair(&host), "secret", "t").await.unwrap();
        c.spawn(spawn_req("big", false)).await.unwrap();
        let child = fake.last();
        let input: Vec<u8> = (0..INPUT_CHUNK * 2 + 17).map(|i| (i % 251) as u8).collect();
        c.input("big", &input).await.unwrap();
        eventually(|| child.input().len() == input.len()).await;
        assert_eq!(child.input(), input);

        child.emit(b"\x1b[?2004h");
        for _ in 0..1000 {
            if c.info("big").await.unwrap().bracketed_paste {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert!(c.info("big").await.unwrap().bracketed_paste, "mode 2004 never turned on");
        let text = format!("{}\x1b[201~{}", "é\n".repeat(PASTE_CHUNK), "end");
        c.paste("big", &text, true).await.unwrap();
        let want = [&input[..], b"\x1b[200~", text.replace("\x1b[201~", "").as_bytes(), b"\x1b[201~"].concat();
        eventually(|| child.input().len() == want.len()).await;
        assert!(child.input() == want, "the paste is bracketed exactly once");
    }

    #[tokio::test]
    async fn a_wrong_token_is_closed_without_an_answer() {
        let (host, _fake, _clock) = test_host();
        let io = connect_pair(&host);
        assert!(matches!(Client::handshake(io, "wrong", "test").await, Err(ClientError::Closed)));
    }

    #[tokio::test]
    async fn the_attached_stream_carries_input_and_output() {
        let (host, fake, _clock) = test_host();
        let mut c = Client::handshake(connect_pair(&host), "secret", "t").await.unwrap();
        c.spawn(spawn_req("s", false)).await.unwrap();
        let attached = Client::handshake(connect_pair(&host), "secret", "t")
            .await
            .unwrap()
            .attach("s", 80, 24, 0)
            .await
            .unwrap();
        assert_eq!(attached.size(), (80, 24));
        let (mut rd, mut wr) = attached.into_split();
        // The snapshot's bytes come first.
        assert!(matches!(rd.next().await.unwrap(), Some(StreamEvent::Output(_))));
        wr.input(b"typed").await.unwrap();
        let child = fake.last();
        eventually(|| child.input() == b"typed").await;
        fake.last().emit(b"live");
        assert_eq!(rd.next().await.unwrap(), Some(StreamEvent::Output(b"live".to_vec())));
        fake.last().exit(0);
        assert_eq!(rd.next().await.unwrap(), Some(StreamEvent::Exit { code: Some(0) }));
        assert_eq!(rd.next().await.unwrap(), None);
    }
}
