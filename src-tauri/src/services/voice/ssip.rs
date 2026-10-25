//! Read-aloud on Linux: SSIP, speech-dispatcher's own protocol, spoken over
//! its Unix socket (user decision 2026-10-23). Nothing is linked — no
//! libspeechd — so a machine without speech-dispatcher starts fine and
//! read-aloud reports `no-speech-server`. Not `spd-say`: killing it does not
//! stop the speech, and its `-C` silences every client, a screen reader too
//! (step 0).
//!
//! The protocol is line-based. A command is one line; its answer is lines
//! `NNN-text` ending in `NNN text`, 2xx meaning OK. `SPEAK` takes the text as
//! data lines ending in a lone `.` — so a data line that *is* `.` would end
//! it early and run what follows as commands: [`encode_body`] doubles a
//! leading dot (the SMTP rule SSIP uses) and folds every line break into a
//! space. Notifications arrive between answers as 7xx groups (`701` BEGIN,
//! `702` END, `703` CANCEL), each naming the message id `SPEAK` answered.
//!
//! The encoder and the parser are pure; [`Client`] runs them over any
//! stream, so the tests drive it against a fake server. Every wait has a
//! limit: a server with no sound card answered BEGIN and then nothing at all
//! (probed 2026-10-23), so a client that waited forever would hang the voice.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use super::VoiceError;

/// The longest text one `SPEAK` carries, in bytes; callers chunk far below it.
pub const MAX_BODY_BYTES: usize = 8 * 1024;

/// One chunk as SPEAK data: control characters (line breaks included) folded
/// to spaces so it is one line, capped at `MAX_BODY_BYTES` on a character
/// boundary, a leading `.` doubled, then the terminating lone dot.
pub fn encode_body(chunk: &str) -> String {
    let folded: String = chunk.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let mut text = folded.trim();
    if text.len() > MAX_BODY_BYTES {
        let mut end = MAX_BODY_BYTES;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text = &text[..end];
    }
    let stuffed = if text.starts_with('.') { format!(".{text}") } else { text.to_string() };
    format!("{stuffed}\r\n.\r\n")
}

/// The rate multiplier (0.5–2.0, 1 = normal) as SSIP's −100…100, on a log
/// scale so ×2 and ×½ are equally far from normal.
pub fn rate_arg(multiplier: f32) -> i32 {
    let m = if multiplier.is_finite() && multiplier > 0.0 { multiplier } else { 1.0 };
    (m.log2() * 100.0).round().clamp(-100.0, 100.0) as i32
}

/// The language SSIP is told: the primary subtag, lowercase letters only (it
/// goes into a command line).
pub fn language_arg(lang: &str) -> Option<String> {
    let primary = lang.split(['-', '_']).next().unwrap_or("").to_ascii_lowercase();
    ((2..=3).contains(&primary.len()) && primary.bytes().all(|b| b.is_ascii_lowercase())).then_some(primary)
}

/// One line of the server's: its code, whether it ends its group (`NNN text`
/// rather than `NNN-text`), and the text.
pub fn parse_line(line: &str) -> Option<(u16, bool, &str)> {
    let line = line.trim_end_matches(['\r', '\n']);
    let code: u16 = line.get(..3)?.parse().ok()?;
    match line.as_bytes().get(3) {
        Some(b'-') => Some((code, false, &line[4..])),
        Some(b' ') => Some((code, true, &line[4..])),
        None => Some((code, true, "")),
        _ => None,
    }
}

/// An answer to a command: its final code and every line's text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reply {
    pub code: u16,
    pub lines: Vec<String>,
}

impl Reply {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.code)
    }
}

/// A notification about a message the client sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    Begin(u64),
    End(u64),
    Cancel(u64),
}

enum Incoming {
    Reply(Reply),
    Event(Event),
}

/// Groups the server's lines into answers and notifications.
#[derive(Default)]
struct Grouper {
    code: Option<u16>,
    lines: Vec<String>,
}

impl Grouper {
    fn push(&mut self, line: &str) -> Option<Incoming> {
        let (code, last, text) = parse_line(line)?;
        if self.code.is_some_and(|c| c != code) {
            // A group the server never closed: start over with this one.
            self.lines.clear();
        }
        self.code = Some(code);
        self.lines.push(text.to_string());
        if !last {
            return None;
        }
        self.code = None;
        let lines = std::mem::take(&mut self.lines);
        if (700..800).contains(&code) {
            let id = lines.first().and_then(|l| l.trim().parse().ok())?;
            return match code {
                701 => Some(Incoming::Event(Event::Begin(id))),
                702 => Some(Incoming::Event(Event::End(id))),
                703 => Some(Incoming::Event(Event::Cancel(id))),
                _ => None,
            };
        }
        Some(Incoming::Reply(Reply { code, lines }))
    }
}

/// How a chunk's speech ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Spoken {
    Done,
    Cancelled,
}

/// How long one command may take to be answered.
const REPLY_LIMIT: Duration = Duration::from_secs(2);

/// An SSIP connection: commands go out on `writer`, a reader thread sorts
/// what comes back into answers and notifications.
pub struct Client<W: Write> {
    writer: W,
    incoming: Receiver<Incoming>,
    events: VecDeque<Event>,
    /// The last LANGUAGE / RATE set, so they are sent only on a change.
    lang: Option<String>,
    rate: Option<i32>,
}

/// Why the connection is no use any more: the caller drops it and reports
/// `no-speech-server`, and the next read-aloud connects afresh.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Broken;

impl From<Broken> for VoiceError {
    fn from(_: Broken) -> VoiceError {
        VoiceError::NoSpeechServer
    }
}

impl<W: Write> Client<W> {
    /// Start the reader on `reader` and introduce the client: its name, the
    /// END/CANCEL notifications, plain text, the `text` priority (a screen
    /// reader's `message`/`important` speech goes first).
    pub fn open<R: Read + Send + 'static>(reader: R, writer: W, client_name: &str) -> Result<Self, Broken> {
        let (tx, rx) = mpsc::channel();
        std::thread::Builder::new()
            .name("voice-ssip-reader".into())
            .spawn(move || {
                let mut grouper = Grouper::default();
                for line in BufReader::new(reader).lines() {
                    let Ok(line) = line else { return };
                    if let Some(item) = grouper.push(&line) {
                        if tx.send(item).is_err() {
                            return;
                        }
                    }
                }
            })
            .map_err(|_| Broken)?;
        let mut client = Self { writer, incoming: rx, events: VecDeque::new(), lang: None, rate: None };
        for command in [
            format!("SET self CLIENT_NAME {client_name}"),
            "SET self NOTIFICATION END on".to_string(),
            "SET self NOTIFICATION CANCEL on".to_string(),
            "SET self SSML_MODE off".to_string(),
            "SET self PRIORITY text".to_string(),
        ] {
            if !client.command(&command)?.ok() {
                return Err(Broken);
            }
        }
        Ok(client)
    }

    fn send(&mut self, text: &str) -> Result<(), Broken> {
        self.writer.write_all(text.as_bytes()).and_then(|()| self.writer.flush()).map_err(|_| Broken)
    }

    /// Wait for the next answer, keeping the notifications that come first.
    fn reply(&mut self) -> Result<Reply, Broken> {
        let deadline = Instant::now() + REPLY_LIMIT;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match self.incoming.recv_timeout(left) {
                Ok(Incoming::Reply(reply)) => return Ok(reply),
                Ok(Incoming::Event(event)) => self.events.push_back(event),
                Err(_) => return Err(Broken),
            }
        }
    }

    pub fn command(&mut self, line: &str) -> Result<Reply, Broken> {
        self.send(&format!("{line}\r\n"))?;
        self.reply()
    }

    /// Set the language and rate the next message is spoken with, when they
    /// changed. A language the server refuses is left as it was.
    pub fn configure(&mut self, lang: &str, rate: f32) -> Result<(), Broken> {
        if let Some(lang) = language_arg(lang).filter(|l| self.lang.as_ref() != Some(l)) {
            if self.command(&format!("SET self LANGUAGE {lang}"))?.ok() {
                self.lang = Some(lang);
            }
        }
        let rate = rate_arg(rate);
        if self.rate != Some(rate) && self.command(&format!("SET self RATE {rate}"))?.ok() {
            self.rate = Some(rate);
        }
        Ok(())
    }

    /// Queue `chunk` and answer the server's message id for it.
    pub fn speak(&mut self, chunk: &str) -> Result<u64, Broken> {
        if self.command("SPEAK")?.code != 230 {
            return Err(Broken);
        }
        self.send(&encode_body(chunk))?;
        let reply = self.reply()?;
        if reply.code != 225 {
            return Err(Broken);
        }
        reply.lines.first().and_then(|l| l.trim().parse().ok()).ok_or(Broken)
    }

    /// Wait until message `id` ends or is cancelled. `cancel` turning true
    /// sends `CANCEL self` (this client's speech only); `limit` bounds the
    /// whole wait, after which the connection counts as broken.
    pub fn wait(&mut self, id: u64, limit: Duration, cancel: &AtomicBool) -> Result<Spoken, Broken> {
        let deadline = Instant::now() + limit;
        let mut cancelled_at: Option<Instant> = None;
        loop {
            while let Some(event) = self.events.pop_front() {
                match event {
                    Event::End(m) if m == id => return Ok(Spoken::Done),
                    Event::Cancel(m) if m == id => return Ok(Spoken::Cancelled),
                    _ => {}
                }
            }
            if cancelled_at.is_none() && cancel.load(Ordering::SeqCst) {
                self.command("CANCEL self")?;
                cancelled_at = Some(Instant::now());
            }
            // A cancel the server acknowledged but never notified still ends it.
            if cancelled_at.is_some_and(|at| at.elapsed() > REPLY_LIMIT) {
                return Ok(Spoken::Cancelled);
            }
            if Instant::now() >= deadline {
                return Err(Broken);
            }
            match self.incoming.recv_timeout(Duration::from_millis(50)) {
                Ok(Incoming::Event(event)) => self.events.push_back(event),
                // An answer nobody waits for (a late one to CANCEL).
                Ok(Incoming::Reply(_)) => {}
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return Err(Broken),
            }
        }
    }

    /// Stop this client's speech, now.
    pub fn cancel(&mut self) -> Result<(), Broken> {
        self.command("CANCEL self").map(|_| ())
    }
}

/// How long a chunk may take to be spoken: generous for a slow voice, so
/// only a server that has stopped answering runs into it.
pub fn speak_limit(chunk: &str, rate: f32) -> Duration {
    let chars = chunk.chars().count() as f64;
    let slow = (1.0 / rate.clamp(0.5, 2.0) as f64).max(1.0);
    Duration::from_secs_f64(10.0 + chars * 0.15 * slow)
}

/// The socket and the server, on Linux.
#[cfg(unix)]
pub mod transport {
    use std::os::unix::net::UnixStream;
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    use super::{Broken, Client};

    /// Where speech-dispatcher listens: `SPEECHD_ADDRESS` only when it names
    /// a Unix socket by an absolute path (never an inet address: speech
    /// leaves the machine), else the per-user socket under
    /// `$XDG_RUNTIME_DIR`.
    pub fn socket_path(address: Option<&str>, runtime_dir: Option<&str>) -> Option<PathBuf> {
        if let Some(address) = address.filter(|a| !a.is_empty()) {
            return address
                .strip_prefix("unix_socket:")
                .map(PathBuf::from)
                .filter(|p| p.is_absolute());
        }
        let runtime = runtime_dir.filter(|d| !d.is_empty())?;
        Some(PathBuf::from(runtime).join("speech-dispatcher").join("speechd.sock"))
    }

    pub fn default_socket() -> Option<PathBuf> {
        socket_path(
            std::env::var("SPEECHD_ADDRESS").ok().as_deref(),
            std::env::var("XDG_RUNTIME_DIR").ok().as_deref(),
        )
    }

    /// Whether read-aloud can work here at all: a socket to reach, or a
    /// server to start.
    pub fn available() -> bool {
        default_socket().is_some_and(|p| p.exists())
            || std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
                .any(|dir| dir.join("speech-dispatcher").is_file())
    }

    /// Connect, starting the server first when nothing listens — as
    /// libspeechd does. Ubuntu socket-activates it, so this is the fallback
    /// for a session without systemd. A server started here exits on its own
    /// idle timeout; the quit does not stop it.
    pub fn connect(client_name: &str) -> Result<Client<UnixStream>, Broken> {
        let path = default_socket().ok_or(Broken)?;
        let stream = match UnixStream::connect(&path) {
            Ok(stream) => stream,
            Err(_) => {
                spawn_server();
                let deadline = Instant::now() + Duration::from_secs(3);
                loop {
                    match UnixStream::connect(&path) {
                        Ok(stream) => break stream,
                        Err(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
                        Err(_) => return Err(Broken),
                    }
                }
            }
        };
        let reader = stream.try_clone().map_err(|_| Broken)?;
        Client::open(reader, stream, client_name)
    }

    fn spawn_server() {
        // argv, no shell; it forks and returns once its socket is up.
        let child = std::process::Command::new("speech-dispatcher")
            .arg("--spawn")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
        if let Ok(mut child) = child {
            let deadline = Instant::now() + Duration::from_secs(3);
            while Instant::now() < deadline {
                if !matches!(child.try_wait(), Ok(None)) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_body_is_one_dot_stuffed_line() {
        assert_eq!(encode_body("Hallo Welt."), "Hallo Welt.\r\n.\r\n");
        // A lone dot would end the message: it is doubled.
        assert_eq!(encode_body("."), "..\r\n.\r\n");
        assert_eq!(encode_body(".x"), "..x\r\n.\r\n");
        // Line breaks cannot open a line of their own: no `.` line, no
        // command after it.
        assert_eq!(encode_body("a\r\n.\r\nQUIT"), "a  .  QUIT\r\n.\r\n");
        assert_eq!(encode_body("\n.\nSET self RATE 100"), ".. SET self RATE 100\r\n.\r\n");
        assert_eq!(encode_body("  "), "\r\n.\r\n");
    }

    #[test]
    fn a_long_body_is_cut_on_a_character_boundary() {
        let body = encode_body(&"ä".repeat(MAX_BODY_BYTES));
        let text = body.strip_suffix("\r\n.\r\n").unwrap();
        assert!(text.len() <= MAX_BODY_BYTES);
        assert!(text.chars().all(|c| c == 'ä'));
    }

    #[test]
    fn the_rate_is_a_log_scale_within_ssips_range() {
        assert_eq!(rate_arg(1.0), 0);
        assert_eq!(rate_arg(2.0), 100);
        assert_eq!(rate_arg(0.5), -100);
        assert_eq!(rate_arg(4.0), 100);
        assert_eq!(rate_arg(f32::NAN), 0);
        assert_eq!(rate_arg(1.41), 50);
    }

    #[test]
    fn only_a_plain_language_code_reaches_a_command() {
        assert_eq!(language_arg("de-DE").as_deref(), Some("de"));
        assert_eq!(language_arg("EN").as_deref(), Some("en"));
        assert_eq!(language_arg("auto"), None);
        assert_eq!(language_arg("de\r\nQUIT"), None);
        assert_eq!(language_arg(""), None);
    }

    #[test]
    fn lines_group_into_answers_and_notifications() {
        let mut g = Grouper::default();
        assert!(g.push("225-21").is_none());
        let Some(Incoming::Reply(reply)) = g.push("225 OK MESSAGE QUEUED") else { panic!() };
        assert_eq!(reply, Reply { code: 225, lines: vec!["21".into(), "OK MESSAGE QUEUED".into()] });
        assert!(g.push("702-21").is_none());
        assert!(g.push("702-3").is_none());
        assert!(matches!(g.push("702 END"), Some(Incoming::Event(Event::End(21)))));
        assert!(g.push("703-22\r").is_none());
        assert!(g.push("703-3").is_none());
        assert!(matches!(g.push("703 CANCELED"), Some(Incoming::Event(Event::Cancel(22)))));
        assert!(g.push("garbage").is_none());
        assert_eq!(parse_line("409 ERR RATE TOO HIGH"), Some((409, true, "ERR RATE TOO HIGH")));
    }

    #[test]
    fn a_limit_grows_with_the_chunk_and_a_slow_voice() {
        assert!(speak_limit("short", 1.0) < speak_limit(&"x".repeat(900), 1.0));
        assert!(speak_limit(&"x".repeat(900), 0.5) > speak_limit(&"x".repeat(900), 1.0));
    }

    #[cfg(unix)]
    #[test]
    fn the_socket_is_a_local_one() {
        use transport::socket_path;
        use std::path::PathBuf;
        let runtime = "/run/user/1000";
        assert_eq!(
            socket_path(None, Some(runtime)),
            Some(PathBuf::from(runtime).join("speech-dispatcher").join("speechd.sock"))
        );
        assert_eq!(socket_path(Some("unix_socket:/tmp/s.sock"), Some(runtime)), Some(PathBuf::from("/tmp/s.sock")));
        assert_eq!(socket_path(Some("inet_socket:example.org:6560"), Some(runtime)), None);
        assert_eq!(socket_path(Some("unix_socket:relative.sock"), Some(runtime)), None);
        assert_eq!(socket_path(None, None), None);
    }

    /// A speech-dispatcher stand-in on a socket pair: answers each command
    /// as the real one did (probed 2026-10-23), records the lines it got, and
    /// ends each message after `speak_ms` unless cancelled.
    #[cfg(unix)]
    mod fake_server {
        use super::super::*;
        use std::io::{BufRead, BufReader, Write};
        use std::os::unix::net::UnixStream;
        use std::sync::{Arc, Mutex};

        pub fn start(speak_ms: u64, notify: bool) -> (Client<UnixStream>, Arc<Mutex<Vec<String>>>) {
            let (ours, theirs) = UnixStream::pair().unwrap();
            let got = Arc::new(Mutex::new(Vec::new()));
            let log = got.clone();
            std::thread::spawn(move || {
                let mut out = theirs.try_clone().unwrap();
                let mut lines = BufReader::new(theirs).lines();
                let mut next_id = 0u64;
                let pending: Arc<Mutex<Option<u64>>> = Arc::new(Mutex::new(None));
                while let Some(Ok(line)) = lines.next() {
                    log.lock().unwrap().push(line.clone());
                    let reply = if line == "SPEAK" {
                        out.write_all(b"230 OK RECEIVING DATA\r\n").unwrap();
                        let mut body = Vec::new();
                        for data in lines.by_ref() {
                            let data = data.unwrap();
                            if data == "." {
                                break;
                            }
                            body.push(data);
                        }
                        log.lock().unwrap().push(format!("BODY {}", body.join("|")));
                        next_id += 1;
                        let id = next_id;
                        *pending.lock().unwrap() = Some(id);
                        let (mut later, pending) = (out.try_clone().unwrap(), pending.clone());
                        std::thread::spawn(move || {
                            std::thread::sleep(Duration::from_millis(speak_ms));
                            if notify && pending.lock().unwrap().take() == Some(id) {
                                let _ = write!(later, "702-{id}\r\n702-1\r\n702 END\r\n");
                            }
                        });
                        format!("225-{id}\r\n225 OK MESSAGE QUEUED\r\n")
                    } else if line == "CANCEL self" {
                        if let Some(id) = pending.lock().unwrap().take() {
                            if notify {
                                write!(out, "703-{id}\r\n703-1\r\n703 CANCELED\r\n").unwrap();
                            }
                        }
                        "210 OK CANCELED\r\n".to_string()
                    } else if line.starts_with("SET self RATE ") {
                        "203 OK RATE SET\r\n".to_string()
                    } else {
                        "200 OK\r\n".to_string()
                    };
                    out.write_all(reply.as_bytes()).unwrap();
                }
            });
            let reader = ours.try_clone().unwrap();
            (Client::open(reader, ours, "me:voice:test").unwrap(), got)
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_chunk_is_spoken_to_its_end() {
        let (mut client, got) = fake_server::start(50, true);
        client.configure("de-DE", 1.0).unwrap();
        let id = client.speak("Hallo.").unwrap();
        assert_eq!(client.wait(id, Duration::from_secs(5), &AtomicBool::new(false)), Ok(Spoken::Done));
        let got = got.lock().unwrap().clone();
        assert_eq!(got[0], "SET self CLIENT_NAME me:voice:test");
        assert!(got.contains(&"SET self NOTIFICATION END on".to_string()));
        assert!(got.contains(&"SET self PRIORITY text".to_string()));
        assert!(got.contains(&"SET self LANGUAGE de".to_string()));
        assert!(got.contains(&"BODY Hallo.".to_string()));
    }

    #[cfg(unix)]
    #[test]
    fn text_that_looks_like_the_protocol_stays_text() {
        let (mut client, got) = fake_server::start(10, true);
        for chunk in [".", ".x", "\r\n.\r\nQUIT"] {
            let id = client.speak(chunk).unwrap();
            assert_eq!(client.wait(id, Duration::from_secs(5), &AtomicBool::new(false)), Ok(Spoken::Done));
        }
        let got = got.lock().unwrap().clone();
        assert!(!got.contains(&"QUIT".to_string()), "{got:?}");
        assert!(got.contains(&"BODY ..".to_string()));
        assert!(got.contains(&"BODY ..x".to_string()));
        assert!(got.contains(&"BODY ..  QUIT".to_string()), "{got:?}");
    }

    #[cfg(unix)]
    #[test]
    fn a_stop_cancels_this_clients_speech() {
        let (mut client, got) = fake_server::start(10_000, true);
        let id = client.speak("A long sentence.").unwrap();
        let cancel = AtomicBool::new(true);
        let started = Instant::now();
        assert_eq!(client.wait(id, Duration::from_secs(30), &cancel), Ok(Spoken::Cancelled));
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(got.lock().unwrap().contains(&"CANCEL self".to_string()));
    }

    #[cfg(unix)]
    #[test]
    fn a_server_that_goes_quiet_is_given_up_on() {
        // BEGIN and then nothing, as speech-dispatcher with no sound card.
        let (mut client, _) = fake_server::start(0, false);
        let id = client.speak("Hallo.").unwrap();
        let started = Instant::now();
        assert_eq!(client.wait(id, Duration::from_millis(300), &AtomicBool::new(false)), Err(Broken));
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
