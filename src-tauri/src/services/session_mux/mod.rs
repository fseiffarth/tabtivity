//! The **session mux**: one seam in front of every local persistent-session
//! use (`docs/windows_session_host_plan.md` §1). tmux backs it on Unix
//! ([`tmux::TmuxMux`], over the `tmux_local` builders, unchanged); on Windows
//! the native session host does ([`winhost`], behind the experimental
//! `windows_session_host` setting; off, every call is `Unavailable`).
//!
//! Sync and blocking, like the tmux calls it replaces: callers already sit in
//! `spawn_blocking` / `rt::blocking`. AppHandle-free; builds in the daemon.
//! Remote/SSH tmux (`AttachTarget::Host`, `ssh_exec::host_*`) stays outside.
//!
//! Semantics every backend keeps: names match exactly (tmux adds `=` where the
//! caller always did); `wrap`/`spawn_detached` are create-or-attach; `list`
//! answers `Ok(vec![])` when no server runs and `Err` when it could not be
//! asked; `kill` of a session already gone is `Ok`.

use std::path::PathBuf;
use std::sync::Arc;

use crate::terminal::PtyOptions;

pub mod keys;
pub mod tmux;
#[cfg(windows)]
pub mod winhost;

/// Which backend a mux is — what the phone's `terminals` value is read from
/// (`discovery::terminals_support_on`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MuxKind {
    Tmux,
    WinHost,
}

/// Why a mux call did not happen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MuxError {
    /// No server is running: no session exists.
    NoServer,
    /// The server runs, the session does not.
    NotFound,
    /// This machine has no backend (Windows before the session host).
    Unavailable(String),
    /// The backend answered with a refusal; the text is its own.
    Refused(String),
    /// The backend could not be reached (spawn failed, deadline passed).
    Io(String),
}

impl std::fmt::Display for MuxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoServer => f.write_str("no session server is running"),
            Self::NotFound => f.write_str("no such session"),
            Self::Unavailable(why) | Self::Refused(why) | Self::Io(why) => f.write_str(why),
        }
    }
}

impl std::error::Error for MuxError {}

/// A client process that attaches to a session: what a PTY spawns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientCmd {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// Set on the client on top of what it inherits.
    pub env: Vec<(String, String)>,
}

/// A viewer's live stream onto a session ([`SessionMux::attach_stream`]):
/// the backend's own screen of it first, then live output; input and resizes
/// the other way. On the Windows session host this is how the phone's bridge
/// attaches, where tmux runs an attach client ([`SessionMux::attach_client`]).
///
/// Read and write it whole (`Read`/`Write`), or split it
/// ([`MuxStream::into_parts`]) to read output on one thread while another
/// types. Reads block: never read it on an async worker. A read of `0` is the
/// end: the session ended or was killed, the backend went, or it was closed.
/// Dropping every part (or [`MuxStream::close`]) detaches; the session runs on.
pub struct MuxStream {
    reader: Box<dyn std::io::Read + Send>,
    writer: Box<dyn std::io::Write + Send>,
    control: crate::terminal::host_pty::StreamHandle,
}

impl MuxStream {
    /// A stream over a pipe-backed attach (`terminal::host_pty`).
    pub fn new(pty: crate::terminal::host_pty::HostPty) -> Self {
        Self { reader: pty.reader, writer: pty.writer, control: pty.handle }
    }

    /// The session's `(cols, rows)` at attach, or this viewer's last resize.
    pub fn size(&self) -> (u16, u16) {
        self.control.size()
    }

    /// This viewer's size; the session follows its latest client.
    pub fn resize(&self, cols: u16, rows: u16) -> std::io::Result<()> {
        self.control.resize(cols, rows)
    }

    /// Detach; the next read returns the rest of what was received, then `0`.
    pub fn close(&self) {
        self.control.close();
    }

    /// Whether the stream ended, and whether the session's pane is dead
    /// (remain-on-exit: on screen, input-less).
    pub fn status(&self) -> crate::terminal::host_pty::StreamStatus {
        self.control.status()
    }

    /// Output, input and the control handle, apart.
    pub fn into_parts(
        self,
    ) -> (Box<dyn std::io::Read + Send>, Box<dyn std::io::Write + Send>, crate::terminal::host_pty::StreamHandle) {
        (self.reader, self.writer, self.control)
    }
}

impl std::io::Read for MuxStream {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.reader.read(buf)
    }
}

impl std::io::Write for MuxStream {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.writer.write(buf)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.writer.flush()
    }
}

/// One live session, as [`SessionMux::list`] reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionInfo {
    pub name: String,
    /// Seconds since the Unix epoch.
    pub created: u64,
    /// Last output, seconds since the Unix epoch.
    pub activity: u64,
    /// At least one client is attached.
    pub attached: bool,
    /// The active pane's working directory; empty when unknown.
    pub cwd: String,
    /// The active pane's foreground command; empty when unknown.
    pub cmd: String,
}

/// A session's pane, as [`SessionMux::pane`] reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PaneInfo {
    /// The command ended and the pane is kept (`remain-on-exit`).
    pub dead: bool,
    pub pid: Option<u32>,
    pub created: u64,
    pub activity: u64,
    /// The window's geometry, `(cols, rows)`.
    pub window: Option<(u16, u16)>,
}

/// Every live session and the MCP stamp it was created with
/// ([`SessionMux::mcp_marks`]): what a restore reads once for all its tabs,
/// instead of one `has` per tab.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionMarks(std::collections::HashMap<String, Option<String>>);

impl SessionMarks {
    /// `(session, raw stamp)` rows; `None` is a session with no stamp.
    pub fn from_rows(rows: impl IntoIterator<Item = (String, Option<String>)>) -> Self {
        Self(rows.into_iter().collect())
    }

    /// The session is live.
    pub fn contains(&self, name: &str) -> bool {
        self.0.contains_key(name)
    }

    /// The listing's row for `name` (`None`: not live; `Some(None)`: live, no
    /// stamp) — the shape `root_mcp_mark::Stamp::of` reads.
    pub fn entry(&self, name: &str) -> Option<&Option<String>> {
        self.0.get(name)
    }

    /// Note a session this process just created with `mark`, ahead of the
    /// next listing.
    pub fn note(&mut self, name: &str, mark: &str) {
        self.0.insert(name.to_string(), Some(mark.to_string()));
    }
}

/// One key for [`SessionMux::send_keys`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Key {
    /// A named key in tmux's spelling (`Enter`, `Escape`).
    Named(String),
    /// Ctrl plus a letter (`C-a`).
    Ctrl(char),
    /// Text typed as is, never read as key names.
    Literal(String),
}

impl Key {
    /// A key from tmux's spelling: `C-x` is [`Key::Ctrl`], anything else
    /// [`Key::Named`].
    pub fn from_name(name: &str) -> Self {
        if let Some(rest) = name.strip_prefix("C-") {
            let mut chars = rest.chars();
            if let (Some(c), None) = (chars.next(), chars.next()) {
                return Self::Ctrl(c);
            }
        }
        Self::Named(name.to_string())
    }
}

/// The local persistent-session backend. Object-safe: held as
/// `Arc<dyn SessionMux>`.
pub trait SessionMux: Send + Sync {
    fn kind(&self) -> MuxKind;
    fn available(&self) -> bool;
    /// Whether sessions may still live in this backend even when it makes no
    /// new ones (`available` false): what gates ending them (`kill`, the
    /// quit reap) and finding them (`has`), so turning a setting off never
    /// orphans a running agent. tmux: [`SessionMux::available`].
    fn holds_sessions(&self) -> bool {
        self.available()
    }
    /// Make `opts` the create-or-attach launch of `opts.tmux_session` and
    /// mark it so (`PtyOptions::mux_wrapped`); a no-op without a session
    /// name or a backend. tmux rewrites the argv into its client; the
    /// Windows session host leaves it and only marks it, for
    /// `terminal::spawn_pty` to send in a `Spawn` over the host's pipe.
    fn wrap(&self, opts: &mut PtyOptions);
    /// Start `opts.tmux_session` with no client (create-or-attach).
    fn spawn_detached(&self, opts: &PtyOptions) -> Result<(), MuxError>;
    /// The client that attaches to `name` and never creates it. `for_phone`:
    /// the sidecar's own client (its PATH, `TERM=vt100`). `Unavailable` on a
    /// backend that attaches by stream ([`SessionMux::attach_stream`]).
    fn attach_client(&self, name: &str, for_phone: bool) -> Result<ClientCmd, MuxError>;
    /// A stream onto `name` at this viewer's `cols`×`rows`; never creates
    /// it. Its first bytes are the backend's snapshot: up to
    /// `history_lines` rows of history pushed into the viewer's scrollback
    /// (CRLF, SGR kept; none at `0`), then the screen — taken under the lock
    /// that orders the live output after it, so nothing falls between. The
    /// seam for a backend no client process can attach to (the Windows
    /// session host); tmux attaches through [`SessionMux::attach_client`] and
    /// answers `Unavailable` here.
    fn attach_stream(&self, name: &str, cols: u16, rows: u16, history_lines: usize) -> Result<MuxStream, MuxError> {
        let _ = (name, cols, rows, history_lines);
        Err(MuxError::Unavailable("this backend attaches through a client process (attach_client)".into()))
    }
    /// Ready the server for a phone viewer (tmux: `keep_dim`). Best effort.
    fn prepare_viewer(&self) {}
    fn list(&self) -> Result<Vec<SessionInfo>, MuxError>;
    /// Every live session with the MCP stamp it was created with
    /// (`services::root_mcp::root_mcp_mark`): one listing for all tabs of a
    /// restore, so a backend may serve it from a short cache (tmux: about
    /// 3 s behind a single flight). No server is `Ok` and empty. The default is
    /// "cannot tell" (`Unavailable`): `launch_prep` then treats every launch as
    /// a create and asks [`SessionMux::has`] for a rejoin, as it did before
    /// sessions were stamped. A backend that can carry the stamp (the Windows
    /// session host) overrides this and [`SessionMux::note_mcp_mark`], and
    /// writes the stamp `PtyOptions::mcp_mark` carries when it creates a
    /// session.
    fn mcp_marks(&self) -> Result<SessionMarks, MuxError> {
        Err(MuxError::Unavailable("this backend keeps no MCP stamp".into()))
    }
    /// `mark` was just set on the new session `name` (`launch_prep` decided a
    /// create): a backend that caches [`SessionMux::mcp_marks`] folds it in, so
    /// a second launch of the same session within the cache's life does not
    /// read it as absent.
    fn note_mcp_mark(&self, name: &str, mark: &str) {
        let _ = (name, mark);
    }
    /// Overwrite the live session `name`'s stamp with `mark`: a revival
    /// (`root_mcp_reattach`) renews the nonce, so the next reattach in this
    /// run reads the stamp as its own and adopts. The default cannot
    /// (`Unavailable`): the session keeps its old stamp, and a revived
    /// session is then found on this listener's port by its grant
    /// (`root_mcp_mark::classify_reattach`) but not revived by a later run.
    fn restamp_mcp(&self, name: &str, mark: &str) -> Result<(), MuxError> {
        let _ = (name, mark);
        Err(MuxError::Unavailable("this backend cannot re-stamp a session".into()))
    }
    fn has(&self, name: &str) -> Result<bool, MuxError>;
    fn pane(&self, name: &str) -> Result<PaneInfo, MuxError>;
    /// The window's `(cols, rows)`. A backend may answer it more cheaply than
    /// the whole [`SessionMux::pane`].
    fn window(&self, name: &str) -> Result<(u16, u16), MuxError> {
        self.pane(name)?.window.ok_or(MuxError::NotFound)
    }
    /// The visible screen as plain lines, wrapped rows joined.
    fn screen(&self, name: &str) -> Result<String, MuxError>;
    /// Up to `lines` of history above the visible screen, SGR kept, CRLF line
    /// ends ([`normalize_scrollback`]). Empty when there is none.
    fn scrollback(&self, name: &str, lines: usize) -> Result<Vec<u8>, MuxError>;
    fn send_keys(&self, name: &str, keys: &[Key]) -> Result<(), MuxError>;
    /// Paste `text`, newlines kept as newlines; `bracketed` when the pane
    /// asked for bracketed paste.
    fn paste(&self, name: &str, text: &str, bracketed: bool) -> Result<(), MuxError>;
    /// The session's environment as `KEY=VALUE` text, when it can be read.
    fn env_text(&self, name: &str) -> Option<String>;
    /// End `name` and everything it ran; already gone is `Ok`.
    fn kill(&self, name: &str) -> Result<(), MuxError>;
    fn rename(&self, old: &str, new: &str) -> Result<(), MuxError>;
    /// End every session the app minted and nothing else — the clean-quit
    /// reap (`tmux_local::sessions_to_reap` owns the rule). No server is `Ok`.
    fn kill_app_sessions(&self) -> Result<(), MuxError> {
        kill_app_sessions_in(self)
    }
}

/// The names of the running sessions the app minted (the clean-quit reap's
/// rule, `tmux_local::sessions_to_reap`); none when the backend cannot list.
pub fn app_session_names<M: SessionMux + ?Sized>(mux: &M) -> Vec<String> {
    match mux.list() {
        Ok(listed) => crate::services::tmux_local::sessions_to_reap(listed.iter().map(|s| s.name.as_str())),
        Err(_) => Vec::new(),
    }
}

/// [`SessionMux::kill_app_sessions`] over `list` and `kill`: every app
/// session listed is ended, and each one that would not end is named.
pub fn kill_app_sessions_in<M: SessionMux + ?Sized>(mux: &M) -> Result<(), MuxError> {
    let listed = mux.list()?;
    let failures: Vec<String> =
        crate::services::tmux_local::sessions_to_reap(listed.iter().map(|s| s.name.as_str()))
            .into_iter()
            .filter_map(|name| mux.kill(&name).err().map(|e| format!("{name}: {e}")))
            .collect();
    if failures.is_empty() {
        Ok(())
    } else {
        Err(MuxError::Refused(format!(
            concat!("could not stop every ", crate::app_name!(), " local session: {}"),
            failures.join("; ")
        )))
    }
}

/// This machine's mux: tmux everywhere but Windows, where it is the session
/// host — `Unavailable` unless its experimental setting is on.
pub fn mux() -> Arc<dyn SessionMux> {
    select(None)
}

/// [`mux`] with tmux's paste staged at `paste_file` (the scheduler stages in
/// its own state dir). Ignored by a backend that stages nothing.
pub fn mux_staging_at(paste_file: PathBuf) -> Arc<dyn SessionMux> {
    select(Some(paste_file))
}

#[cfg(not(windows))]
fn select(paste_file: Option<PathBuf>) -> Arc<dyn SessionMux> {
    let mux = tmux::TmuxMux::default();
    Arc::new(match paste_file {
        Some(path) => mux.with_paste_file(path),
        None => mux,
    })
}

#[cfg(windows)]
fn select(_paste_file: Option<PathBuf>) -> Arc<dyn SessionMux> {
    Arc::new(winhost::WinHostMux::here())
}

/// `capture-pane -p` writes Unix newlines. xterm's ordinary output uses CRLF;
/// without the CR, lines retain the previous column and a wrapped history
/// becomes unreadable. Any CR already present is kept, and the replay always
/// ends on a line end.
pub fn normalize_scrollback(output: Vec<u8>) -> Vec<u8> {
    let mut history = Vec::with_capacity(output.len() + 1);
    let mut previous_was_cr = false;
    for byte in output {
        if byte == b'\n' && !previous_was_cr {
            history.push(b'\r');
        }
        history.push(byte);
        previous_was_cr = byte == b'\r';
    }
    if !history.ends_with(b"\n") {
        if !history.ends_with(b"\r") {
            history.push(b'\r');
        }
        history.push(b'\n');
    }
    history
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_parse_from_tmux_names() {
        assert_eq!(Key::from_name("C-x"), Key::Ctrl('x'));
        assert_eq!(Key::from_name("Escape"), Key::Named("Escape".into()));
        assert_eq!(Key::from_name("C-"), Key::Named("C-".into()));
        assert_eq!(Key::from_name("C-xy"), Key::Named("C-xy".into()));
    }

    #[test]
    fn scrollback_gets_terminal_line_endings() {
        assert_eq!(normalize_scrollback(b"one\ntwo\r\nthree".to_vec()), b"one\r\ntwo\r\nthree\r\n");
    }

    /// A mux that lists `names` and records each kill; `stuck` will not end.
    struct Listed {
        names: Vec<String>,
        stuck: &'static str,
        killed: std::sync::Mutex<Vec<String>>,
    }

    impl SessionMux for Listed {
        fn kind(&self) -> MuxKind {
            MuxKind::WinHost
        }
        fn available(&self) -> bool {
            true
        }
        fn wrap(&self, _opts: &mut PtyOptions) {}
        fn spawn_detached(&self, _opts: &PtyOptions) -> Result<(), MuxError> {
            Ok(())
        }
        fn attach_client(&self, _name: &str, _for_phone: bool) -> Result<ClientCmd, MuxError> {
            Err(MuxError::NotFound)
        }
        fn list(&self) -> Result<Vec<SessionInfo>, MuxError> {
            Ok(self
                .names
                .iter()
                .map(|name| SessionInfo { name: name.clone(), created: 0, activity: 0, attached: false, cwd: String::new(), cmd: String::new() })
                .collect())
        }
        fn has(&self, _name: &str) -> Result<bool, MuxError> {
            Ok(true)
        }
        fn pane(&self, _name: &str) -> Result<PaneInfo, MuxError> {
            Err(MuxError::NotFound)
        }
        fn screen(&self, _name: &str) -> Result<String, MuxError> {
            Ok(String::new())
        }
        fn scrollback(&self, _name: &str, _lines: usize) -> Result<Vec<u8>, MuxError> {
            Ok(Vec::new())
        }
        fn send_keys(&self, _name: &str, _keys: &[Key]) -> Result<(), MuxError> {
            Ok(())
        }
        fn paste(&self, _name: &str, _text: &str, _bracketed: bool) -> Result<(), MuxError> {
            Ok(())
        }
        fn env_text(&self, _name: &str) -> Option<String> {
            None
        }
        fn kill(&self, name: &str) -> Result<(), MuxError> {
            self.killed.lock().unwrap().push(name.to_string());
            if name == self.stuck {
                return Err(MuxError::Refused("busy".into()));
            }
            Ok(())
        }
        fn rename(&self, _old: &str, _new: &str) -> Result<(), MuxError> {
            Ok(())
        }
    }

    /// The clean-quit reap over any backend: the app's sessions and no
    /// foreign one, each that would not end named.
    #[test]
    fn the_quit_reap_ends_the_apps_sessions_only() {
        let ours = concat!(crate::app_slug!(), "-p--agent-1");
        let stuck = concat!(crate::app_slug!(), "-p--agent-2");
        let mux = Listed { names: vec![ours.into(), "work".into(), stuck.into()], stuck, killed: Default::default() };
        let refused = mux.kill_app_sessions().expect_err("one would not end");
        assert!(refused.to_string().contains(stuck), "{refused}");
        assert_eq!(*mux.killed.lock().unwrap(), [ours, stuck]);
        let mux = Listed { names: vec!["work".into()], stuck, killed: Default::default() };
        assert_eq!(mux.kill_app_sessions(), Ok(()));
        assert!(mux.killed.lock().unwrap().is_empty());
    }

    /// The restore wake's listing: the app's running sessions, never a
    /// foreign one, and nothing is ended.
    #[test]
    fn the_app_session_listing_names_the_apps_sessions_only() {
        let ours = concat!(crate::app_slug!(), "-p--agent-1");
        let mux = Listed { names: vec![ours.into(), "work".into()], stuck: "", killed: Default::default() };
        assert_eq!(app_session_names(&mux), [ours]);
        assert!(mux.killed.lock().unwrap().is_empty());
    }

    /// The selector: tmux everywhere but Windows, where the session host is
    /// unavailable while its setting is off (the tests' state dir has none).
    #[test]
    fn the_selector_picks_this_platforms_backend() {
        let mux = mux();
        if cfg!(windows) {
            assert_eq!(mux.kind(), MuxKind::WinHost);
            assert!(!mux.available());
            // Off, a running host's live sessions are still listed; the
            // tests' state dir has none.
            assert!(mux.holds_sessions());
            assert_eq!(mux.list(), Ok(Vec::new()));
            assert!(matches!(mux.attach_client("s", true), Err(MuxError::Unavailable(_))));
        } else {
            assert_eq!(mux.kind(), MuxKind::Tmux);
        }
    }
}
