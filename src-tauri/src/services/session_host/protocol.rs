//! The session host's wire protocol (`docs/windows_session_host_plan.md` §2,
//! Protocol). Pure: framing, the control messages and version negotiation,
//! with no I/O beyond reading and writing frames on a byte stream.
//!
//! A frame is a little-endian `u32` payload length, one kind byte, then the
//! payload. Kind [`KIND_CONTROL`] carries one JSON [`Request`] (client → host)
//! or [`Reply`] (host → client); [`KIND_OUTPUT`] carries terminal bytes to an
//! attached client; [`KIND_INPUT`] carries keystrokes from one. A payload is at
//! most [`MAX_FRAME`] bytes; a longer length closes the connection. A frame of
//! a kind this build does not know is skipped, so a later kind needs no `PROTO`
//! bump unless its sender relies on it being read.
//!
//! Both message enums end in an `Unknown` variant: a request this host does not
//! know answers `Error{unsupported}`, a reply or event a client does not know
//! is ignored. Anything that changes the meaning of an existing message bumps
//! [`PROTO`]; [`negotiate`] picks the highest level both sides speak, and
//! [`CAPS`] names optional features a client may test for.

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// The protocol level this build speaks at most.
pub const PROTO: u32 = 1;
/// The oldest protocol level this build still speaks.
pub const PROTO_MIN: u32 = 1;
/// The oldest protocol level whose `Kill` and `KillPrefix` this build still
/// sends: ending a session must work against any host still running one,
/// however old, even after [`PROTO_MIN`] moves past it. Both requests are
/// unchanged since level 1; never raise this unless they change.
pub const REAP_PROTO_MIN: u32 = 1;
/// Optional host features, announced in [`Reply::Welcome`].
pub const CAPS: &[&str] = &["snapshot", "repaint", "paste-bracketed", "osc-cwd", "kill-prefix"];

/// The largest payload one frame may carry (1 MiB).
pub const MAX_FRAME: usize = 1 << 20;
/// The largest frame the host reads before a `Hello` authenticated the peer.
pub const MAX_HELLO_FRAME: usize = 8 << 10;
/// Raw input bytes per `Input` request (base64 keeps it well under a frame).
pub const INPUT_CHUNK: usize = 256 << 10;
/// Paste text bytes per `Paste` request: JSON escapes a control character
/// into six bytes, so even an all-control chunk stays under a frame.
pub const PASTE_CHUNK: usize = 128 << 10;
/// A JSON [`Request`] or [`Reply`].
pub const KIND_CONTROL: u8 = 0;
/// Terminal output to an attached client.
pub const KIND_OUTPUT: u8 = 1;
/// Keystrokes from an attached client.
pub const KIND_INPUT: u8 = 2;

/// One frame off the wire. `kind` stays a byte so an unknown kind can be skipped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub kind: u8,
    pub payload: Vec<u8>,
}

/// The bytes of one frame; a payload past [`MAX_FRAME`] is `InvalidInput`
/// (callers chunk output with [`chunks`], input and pastes by
/// [`INPUT_CHUNK`] / [`PASTE_CHUNK`]).
pub fn encode(kind: u8, payload: &[u8]) -> std::io::Result<Vec<u8>> {
    if payload.len() > MAX_FRAME {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "frame payload over MAX_FRAME"));
    }
    let mut out = Vec::with_capacity(payload.len() + 5);
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.push(kind);
    out.extend_from_slice(payload);
    Ok(out)
}

/// `bytes` split into payloads that each fit one frame.
pub fn chunks(bytes: &[u8]) -> impl Iterator<Item = &[u8]> {
    bytes.chunks(MAX_FRAME)
}

/// Reads one frame. `Ok(None)` is a clean end of stream before a frame began;
/// a stream cut mid-frame is `UnexpectedEof`, a length past [`MAX_FRAME`] is
/// `InvalidData` (the caller closes the connection either way).
pub async fn read_frame<R: AsyncRead + Unpin>(r: &mut R) -> std::io::Result<Option<Frame>> {
    read_frame_max(r, MAX_FRAME).await
}

/// [`read_frame`] with a lower payload bound (`max`), for the unauthenticated
/// `Hello`: a peer without the token cannot make the host allocate a MiB.
pub async fn read_frame_max<R: AsyncRead + Unpin>(r: &mut R, max: usize) -> std::io::Result<Option<Frame>> {
    let mut head = [0u8; 5];
    let first = r.read(&mut head[..1]).await?;
    if first == 0 {
        return Ok(None);
    }
    r.read_exact(&mut head[1..]).await?;
    let len = u32::from_le_bytes([head[0], head[1], head[2], head[3]]) as usize;
    if len > max.min(MAX_FRAME) {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "frame over its size bound"));
    }
    let mut payload = vec![0u8; len];
    r.read_exact(&mut payload).await?;
    Ok(Some(Frame { kind: head[4], payload }))
}

/// Writes one frame and flushes it.
pub async fn write_frame<W: AsyncWrite + Unpin>(w: &mut W, kind: u8, payload: &[u8]) -> std::io::Result<()> {
    w.write_all(&encode(kind, payload)?).await?;
    w.flush().await
}

/// Writes `msg` as a control frame.
pub async fn write_control<W: AsyncWrite + Unpin, T: Serialize>(w: &mut W, msg: &T) -> std::io::Result<()> {
    write_frame(w, KIND_CONTROL, &control_payload(msg)).await
}

/// The JSON payload of a control frame.
pub fn control_payload<T: Serialize>(msg: &T) -> Vec<u8> {
    // Serializing these plain enums cannot fail.
    serde_json::to_vec(msg).unwrap_or_default()
}

/// The protocol level a host speaking `host_min..=host_max` and a client
/// speaking `client_min..=client_max` agree on: the highest both speak, or
/// `None` when the ranges do not meet.
pub fn negotiate(host_min: u32, host_max: u32, client_min: u32, client_max: u32) -> Option<u32> {
    let level = host_max.min(client_max);
    (level >= host_min.max(client_min)).then_some(level)
}

/// `Vec<u8>` as a base64 string: a JSON number array would quadruple it.
mod b64 {
    use base64::Engine;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&base64::engine::general_purpose::STANDARD.encode(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let text = String::deserialize(d)?;
        base64::engine::general_purpose::STANDARD.decode(text).map_err(serde::de::Error::custom)
    }
}

/// How a session's window size follows its clients (tmux `window-size`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SizePolicy {
    /// The client that most recently attached, typed or resized.
    #[default]
    Latest,
    /// The largest columns and rows over every attached client.
    Largest,
}

/// Client → host. Tagged by `op`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Request {
    /// The first frame of every connection.
    Hello { token: String, proto_min: u32, proto_max: u32, client_version: String },
    /// Create-or-attach: an existing session ignores `argv`, `env` and `cwd`
    /// (`create_only` makes that an `exists` error instead). `argv[0]` must
    /// be absolute; the host never searches `PATH`. `env` is the child's whole
    /// environment.
    Spawn {
        name: String,
        argv: Vec<String>,
        #[serde(default)]
        env: Vec<(String, String)>,
        #[serde(default)]
        cwd: Option<String>,
        cols: u16,
        rows: u16,
        /// An exited child keeps its screen, marked dead and input-less.
        #[serde(default)]
        remain_on_exit: bool,
        #[serde(default)]
        size_policy: SizePolicy,
        #[serde(default)]
        create_only: bool,
    },
    /// Turns the connection into a stream: [`Reply::Snapshot`] and its bytes,
    /// then live output. From then on the client sends [`KIND_INPUT`] frames
    /// and `Resize` controls only.
    Attach {
        name: String,
        cols: u16,
        rows: u16,
        #[serde(default)]
        history_lines: usize,
    },
    /// In a stream, the client's own size (`name` ignored). Otherwise sets
    /// session `name`'s size directly.
    Resize {
        #[serde(default)]
        name: Option<String>,
        cols: u16,
        rows: u16,
    },
    /// Raw bytes to a session's input (refused while dead), base64 on the
    /// wire, at most [`INPUT_CHUNK`] per request.
    Input {
        name: String,
        #[serde(with = "b64")]
        bytes: Vec<u8>,
    },
    /// Text typed as one paste; wrapped in bracketed-paste markers only when
    /// `bracketed` and the session's screen has mode 2004 on. A paste past
    /// [`PASTE_CHUNK`] goes as several requests: every one after the first
    /// sets `cont` (no start marker), every one before the last sets `more`
    /// (no end marker), so the whole paste is bracketed once.
    Paste {
        name: String,
        text: String,
        bracketed: bool,
        #[serde(default)]
        cont: bool,
        #[serde(default)]
        more: bool,
    },
    /// With `history_lines` 0 the visible screen, else the last
    /// `history_lines` rows of history, ending one row above the screen.
    Capture {
        name: String,
        #[serde(default)]
        join_wrapped: bool,
        /// Keep SGR colours (tmux `-e`).
        #[serde(default)]
        escapes: bool,
        #[serde(default)]
        history_lines: usize,
    },
    Info { name: String },
    List,
    /// Already gone is not an error.
    Kill { name: String },
    KillPrefix { prefix: String },
    Rename { name: String, new_name: String },
    /// With `if_idle`, refused while any session lives; without, kills every
    /// session. The host exits after replying.
    Shutdown { if_idle: bool },
    #[serde(other)]
    Unknown,
}

/// Why the host refused a request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// A request this host does not know.
    Unsupported,
    /// No protocol level both sides speak.
    Version,
    BadRequest,
    BadName,
    NotFound,
    Exists,
    /// The session's command has exited (remain-on-exit): no input.
    Dead,
    Busy,
    Io,
    #[serde(other)]
    Other,
}

/// One session in [`Reply::Sessions`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionInfo {
    pub name: String,
    /// Unix milliseconds.
    pub created: u64,
    /// Unix milliseconds of the last output.
    pub activity: u64,
    /// Attached stream clients.
    pub attached: usize,
    /// The spawn cwd, updated from OSC 7 / OSC 9;9.
    pub cwd: Option<String>,
    pub argv: Vec<String>,
    pub dead: bool,
}

/// One session's pane facts, [`Reply::Pane`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PaneInfo {
    pub name: String,
    pub dead: bool,
    pub exit_code: Option<i32>,
    pub pid: Option<u32>,
    pub created: u64,
    pub activity: u64,
    pub cols: u16,
    pub rows: u16,
    pub attached: usize,
    pub cwd: Option<String>,
    pub bracketed_paste: bool,
    pub alternate_screen: bool,
    /// Every output byte the session produced.
    pub output_bytes: u64,
}

/// Host → client: replies, then (on an attached stream) events. Tagged by `type`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Reply {
    Welcome { proto: u32, host_version: String, pid: u32, caps: Vec<String> },
    Ok,
    Spawned { created: bool },
    Captured { text: String },
    Pane(PaneInfo),
    Sessions { sessions: Vec<SessionInfo> },
    Killed { count: usize },
    Error { code: ErrorCode, msg: String },
    /// Stream: the [`KIND_OUTPUT`] frames that follow are the history and a
    /// full repaint of the screen; live output follows them with no gap.
    Snapshot { cols: u16, rows: u16 },
    /// Stream: this client fell behind and lost output; the frames that
    /// follow repaint the whole screen.
    Repaint { cols: u16, rows: u16 },
    /// Stream: the command ended (`code` unknown after a kill).
    Exit { code: Option<i32> },
    /// Stream: the session stays, dead and input-less (remain-on-exit).
    Dead,
    #[serde(other)]
    Unknown,
}

impl Reply {
    pub fn error(code: ErrorCode, msg: impl Into<String>) -> Self {
        Reply::Error { code, msg: msg.into() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn frames_round_trip_and_end_cleanly() {
        let (mut a, mut b) = tokio::io::duplex(1 << 16);
        write_frame(&mut a, KIND_OUTPUT, b"hello").await.unwrap();
        write_frame(&mut a, KIND_INPUT, b"").await.unwrap();
        drop(a);
        assert_eq!(read_frame(&mut b).await.unwrap(), Some(Frame { kind: KIND_OUTPUT, payload: b"hello".to_vec() }));
        assert_eq!(read_frame(&mut b).await.unwrap(), Some(Frame { kind: KIND_INPUT, payload: vec![] }));
        assert_eq!(read_frame(&mut b).await.unwrap(), None);
    }

    #[tokio::test]
    async fn an_oversized_frame_is_refused_on_both_ends() {
        let big = vec![0u8; MAX_FRAME + 1];
        assert_eq!(encode(KIND_OUTPUT, &big).unwrap_err().kind(), std::io::ErrorKind::InvalidInput);
        let (mut a, _b) = tokio::io::duplex(64);
        let err = write_frame(&mut a, KIND_OUTPUT, &big).await.unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput);
        // Before Hello the bound is a few KiB.
        let frame = encode(KIND_CONTROL, &vec![b'x'; MAX_HELLO_FRAME + 1]).unwrap();
        let err = read_frame_max(&mut frame.as_slice(), MAX_HELLO_FRAME).await.unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
        let frame = encode(KIND_CONTROL, &vec![b'x'; MAX_HELLO_FRAME]).unwrap();
        assert!(read_frame_max(&mut frame.as_slice(), MAX_HELLO_FRAME).await.unwrap().is_some());
    }

    #[test]
    fn input_travels_as_base64_and_the_largest_chunks_fit_a_frame() {
        let req = Request::Input { name: "s".into(), bytes: vec![0, 3, 255] };
        let json = String::from_utf8(control_payload(&req)).unwrap();
        assert!(json.contains(r#""bytes":"AAP/""#), "{json}");
        let req = Request::Input { name: "s".into(), bytes: vec![0xff; INPUT_CHUNK] };
        assert!(control_payload(&req).len() < MAX_FRAME);
        let text = "\u{1}".repeat(PASTE_CHUNK);
        let req = Request::Paste { name: "s".into(), text, bracketed: true, cont: false, more: false };
        assert!(control_payload(&req).len() < MAX_FRAME);
    }

    #[tokio::test]
    async fn an_oversized_or_cut_frame_is_an_error() {
        let mut big = ((MAX_FRAME + 1) as u32).to_le_bytes().to_vec();
        big.push(KIND_OUTPUT);
        let err = read_frame(&mut big.as_slice()).await.unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);

        let mut cut = encode(KIND_OUTPUT, b"abcdef").unwrap();
        cut.truncate(7);
        let err = read_frame(&mut cut.as_slice()).await.unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::UnexpectedEof);
    }

    #[test]
    fn a_full_frame_fits_and_chunks_cover_the_input() {
        let bytes = vec![7u8; MAX_FRAME * 2 + 3];
        let parts: Vec<_> = chunks(&bytes).collect();
        assert_eq!(parts.iter().map(|p| p.len()).collect::<Vec<_>>(), vec![MAX_FRAME, MAX_FRAME, 3]);
        assert_eq!(encode(KIND_OUTPUT, parts[0]).unwrap().len(), MAX_FRAME + 5);
    }

    #[test]
    fn control_messages_round_trip() {
        let reqs = vec![
            Request::Hello { token: "t".into(), proto_min: 1, proto_max: 3, client_version: "0.2".into() },
            Request::Spawn {
                name: "s".into(),
                argv: vec!["x".into()],
                env: vec![("PATH".into(), "p".into())],
                cwd: Some("c".into()),
                cols: 80,
                rows: 24,
                remain_on_exit: true,
                size_policy: SizePolicy::Largest,
                create_only: false,
            },
            Request::Attach { name: "s".into(), cols: 1, rows: 2, history_lines: 3 },
            Request::Input { name: "s".into(), bytes: vec![0, 3, 255] },
            Request::Paste { name: "s".into(), text: "t".into(), bracketed: true, cont: true, more: false },
            Request::Capture { name: "s".into(), join_wrapped: true, escapes: false, history_lines: 0 },
            Request::List,
            Request::Shutdown { if_idle: true },
        ];
        for req in reqs {
            let back: Request = serde_json::from_slice(&control_payload(&req)).unwrap();
            assert_eq!(back, req);
        }
        let reply = Reply::Pane(PaneInfo {
            name: "s".into(),
            dead: true,
            exit_code: Some(2),
            pid: None,
            created: 1,
            activity: 2,
            cols: 3,
            rows: 4,
            attached: 0,
            cwd: None,
            bracketed_paste: false,
            alternate_screen: false,
            output_bytes: 9,
        });
        let back: Reply = serde_json::from_slice(&control_payload(&reply)).unwrap();
        assert_eq!(back, reply);
    }

    #[test]
    fn unknown_messages_and_codes_decode_to_unknown() {
        let req: Request = serde_json::from_str(r#"{"op":"teleport","to":"mars"}"#).unwrap();
        assert_eq!(req, Request::Unknown);
        let reply: Reply = serde_json::from_str(r#"{"type":"hologram","x":1}"#).unwrap();
        assert_eq!(reply, Reply::Unknown);
        let reply: Reply = serde_json::from_str(r#"{"type":"error","code":"quota","msg":"m"}"#).unwrap();
        assert_eq!(reply, Reply::error(ErrorCode::Other, "m"));
        // Fields a later build adds to a known message are ignored.
        let req: Request = serde_json::from_str(r#"{"op":"kill","name":"a","grace_ms":5}"#).unwrap();
        assert_eq!(req, Request::Kill { name: "a".into() });
    }

    #[test]
    fn negotiation_picks_the_highest_shared_level() {
        assert_eq!(negotiate(1, 3, 1, 2), Some(2));
        assert_eq!(negotiate(1, 2, 1, 5), Some(2));
        assert_eq!(negotiate(2, 4, 3, 9), Some(4));
        assert_eq!(negotiate(1, 1, 2, 3), None, "a host too old for the client");
        assert_eq!(negotiate(3, 4, 1, 2), None, "a client too old for the host");
        assert_eq!(negotiate(PROTO_MIN, PROTO, PROTO_MIN, PROTO), Some(PROTO));
    }
}
