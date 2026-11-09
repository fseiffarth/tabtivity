//! The host half of the local lane: one Unix socket per tab (and per target),
//! served by threads of this process, no `AppHandle`.
//!
//! The fence side is untrusted. A connection is read as a request, judged by
//! [`super::policy`], and only then sent on, rebuilt, to the one loopback
//! address the lane was opened for. Refusals are JSON errors the CLI can show.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::io::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::http::{self, Head};
use super::policy::{self, Api, Filter, Refusal};

/// What a lane tells its observer (a probe or a log), nothing more: never a body.
pub enum Event<'a> {
    /// A request head was read.
    Request { method: &'a str, target: &'a str },
    /// A model a request named was judged (`verdict`: `ok` or the refusal).
    Model { name: &'a str, verdict: &'a str },
    /// The request was refused, with the status and words the client got.
    Refused { status: u16, message: &'a str },
    /// The upstream answered with this status.
    Answered { status: u16 },
}

/// Called for every [`Event`] of a lane; `None` in the app.
pub type Observer = Arc<dyn Fn(Event<'_>) + Send + Sync>;

/// The bounds of one lane. The defaults are what ships; tests shrink them.
#[derive(Clone)]
pub struct Limits {
    /// Told what the lane does (the per-driver probe's log).
    pub observer: Option<Observer>,
    /// The largest request body (a long chat with images is a few MiB).
    pub max_body: usize,
    /// The largest response read whole so that a model list can be filtered.
    pub max_buffered: usize,
    /// How long the request head may take to arrive.
    pub head_time: Duration,
    /// How long the whole body may take to arrive.
    pub body_time: Duration,
    /// How long nothing may move on a response (a model can load for minutes
    /// before its first token).
    pub idle: Duration,
    /// The longest one exchange may last.
    pub total: Duration,
    /// Simultaneous exchanges on one lane.
    pub max_conns: usize,
}

impl Default for Limits {
    fn default() -> Limits {
        Limits {
            max_body: 32 * 1024 * 1024,
            max_buffered: 8 * 1024 * 1024,
            head_time: Duration::from_secs(15),
            body_time: Duration::from_secs(120),
            idle: Duration::from_secs(900),
            total: Duration::from_secs(4 * 3600),
            max_conns: 32,
            observer: None,
        }
    }
}

/// The verdict on one model name: `Ok`, or the `ollama_client` verdict string.
pub type Judge = Arc<dyn Fn(&str) -> Result<(), &'static str> + Send + Sync>;
/// A connection to the one upstream this lane serves, already vouched for (for
/// Ollama: the loopback listener's owner is checked, `ollama_client::owner_gate`).
pub type Connect = Arc<dyn Fn() -> Result<TcpStream, String> + Send + Sync>;

/// What a lane socket forwards to.
#[derive(Clone)]
pub enum Target {
    /// The local Ollama: the model routes, every named model judged.
    Ollama { judge: Judge, connect: Connect, host: String },
    /// Tabtivity's own MCP server: the allowed tool lanes only.
    Mcp { connect: Connect, host: String },
}

/// Headers copied to Ollama. Nothing else of the client's is.
const OLLAMA_KEEP: &[&str] = &["content-type", "accept", "user-agent"];
/// Headers copied to the MCP server: the content type and accept pair, the
/// bearer token, and the session headers of the streamable transport.
const MCP_KEEP: &[&str] = &["content-type", "accept", "authorization", "mcp-session-id", "mcp-protocol-version", "last-event-id", "origin", "user-agent"];

/// A running lane socket.
pub struct LaneServer {
    path: PathBuf,
    closed: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl LaneServer {
    /// Bind `path` (mode 0600, in a folder only this user can open) and serve
    /// `target` on it until [`LaneServer::stop`].
    pub fn start(path: &Path, target: Target, limits: Limits) -> std::io::Result<LaneServer> {
        if let Some(dir) = path.parent() {
            make_private_dir(dir)?;
        }
        match std::fs::symlink_metadata(path) {
            Ok(m) if m.file_type().is_dir() => return Err(std::io::Error::other("a folder is in the way of the lane socket")),
            Ok(_) => std::fs::remove_file(path)?,
            Err(_) => {}
        }
        let listener = UnixListener::bind(path)?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        let closed = Arc::new(AtomicBool::new(false));
        let thread = {
            let (closed, limits) = (closed.clone(), limits);
            std::thread::Builder::new().name("local-lane".into()).spawn(move || accept_loop(listener, target, limits, closed))?
        };
        Ok(LaneServer { path: path.to_path_buf(), closed, thread: Some(thread) })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Stop accepting, end the exchanges in flight within a second, and remove
    /// the socket file.
    pub fn stop(mut self) {
        self.signal();
        self.shutdown();
    }

    /// Tell the lane to stop without waiting: [`stop`](Self::stop) of several
    /// lanes then takes one wait, not one each.
    pub fn signal(&self) {
        self.closed.store(true, Ordering::SeqCst);
    }

    fn shutdown(&mut self) {
        self.signal();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        let _ = std::fs::remove_file(&self.path);
    }
}

impl Drop for LaneServer {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// `dir` and its missing parents, mode 0700 (an existing folder is tightened).
pub fn make_private_dir(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
}

fn accept_loop(listener: UnixListener, target: Target, limits: Limits, closed: Arc<AtomicBool>) {
    let live = Arc::new(AtomicUsize::new(0));
    // Polled with a short timeout and accepted without blocking, so a stop is seen
    // within a quarter of a second whatever happened to the socket file.
    let _ = listener.set_nonblocking(true);
    while !closed.load(Ordering::SeqCst) {
        let mut ready = libc::pollfd { fd: listener.as_raw_fd(), events: libc::POLLIN, revents: 0 };
        // SAFETY: one valid pollfd for the listener this thread owns.
        unsafe { libc::poll(&mut ready, 1, 250) };
        let conn = match listener.accept() {
            Ok((conn, _)) => conn,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => {
                std::thread::sleep(Duration::from_millis(50));
                continue;
            }
        };
        if closed.load(Ordering::SeqCst) {
            break;
        }
        let _ = conn.set_nonblocking(false);
        if live.fetch_add(1, Ordering::SeqCst) >= limits.max_conns {
            live.fetch_sub(1, Ordering::SeqCst);
            let mut conn = conn;
            let _ = conn.write_all(&http::response(503, "application/json", policy::refusal_body(Api::Native, 503, "Too many requests at once.").as_bytes()));
            continue;
        }
        let (target, limits, closed) = (target.clone(), limits.clone(), closed.clone());
        let slot = Slot(live.clone());
        // A failed spawn drops the closure, and with it the slot.
        let _ = std::thread::Builder::new().name("local-lane-conn".into()).spawn(move || {
            let _slot = slot;
            handle(conn, &target, &limits, &closed);
        });
    }
}

/// One of a lane's simultaneous exchanges; frees its place when dropped.
struct Slot(Arc<AtomicUsize>);

impl Drop for Slot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// The API family a refusal is worded for, from the request target.
fn api_for_target(target: &str) -> Api {
    match policy::target_path(target) {
        Some("/v1/messages") => Api::Anthropic,
        Some(p) if p.starts_with("/v1/") => Api::OpenAi,
        _ => Api::Native,
    }
}

fn note(limits: &Limits, event: Event<'_>) {
    if let Some(observer) = &limits.observer {
        observer(event);
    }
}

fn refuse(limits: &Limits, conn: &mut UnixStream, api: Api, why: &Refusal) {
    note(limits, Event::Refused { status: why.status, message: &why.message });
    let body = policy::refusal_body(api, why.status, &why.message);
    let _ = conn.write_all(&http::response(why.status, "application/json", body.as_bytes()));
    let _ = conn.flush();
}

/// Whether the client end of `conn` has hung up (nothing is read: peek only).
pub fn client_gone(conn: &UnixStream) -> bool {
    let mut byte = 0u8;
    // SAFETY: one byte into a local, a valid descriptor, no flags that block.
    let n = unsafe { libc::recv(conn.as_raw_fd(), (&mut byte as *mut u8).cast(), 1, libc::MSG_PEEK | libc::MSG_DONTWAIT) };
    n == 0
}

fn timed_out(e: &std::io::Error) -> bool {
    matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut)
}

/// Read until `done` says the buffer holds what is wanted. `Err(408)` on the
/// deadline, `None` if the client left or the lane closed.
fn read_until(
    conn: &mut UnixStream,
    buf: &mut Vec<u8>,
    deadline: Instant,
    closed: &AtomicBool,
    mut done: impl FnMut(&[u8]) -> bool,
) -> Result<Option<()>, Refusal> {
    let mut chunk = [0u8; 16 * 1024];
    while !done(buf) {
        if closed.load(Ordering::SeqCst) || Instant::now() > deadline {
            return if closed.load(Ordering::SeqCst) { Ok(None) } else { Err(Refusal::new(408, "The request took too long to arrive.")) };
        }
        match conn.read(&mut chunk) {
            Ok(0) => return Ok(None),
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(e) if timed_out(&e) => {}
            Err(_) => return Ok(None),
        }
    }
    Ok(Some(()))
}

fn handle(mut conn: UnixStream, target: &Target, limits: &Limits, closed: &AtomicBool) {
    let _ = conn.set_read_timeout(Some(Duration::from_secs(1)));
    let _ = conn.set_write_timeout(Some(Duration::from_secs(60)));
    let started = Instant::now();
    let mut buf: Vec<u8> = Vec::new();
    let head_deadline = started + limits.head_time;
    let mut too_big = false;
    match read_until(&mut conn, &mut buf, head_deadline, closed, |b| {
        too_big = http::head_end(b).is_none() && b.len() > http::MAX_HEAD;
        too_big || http::head_end(b).is_some()
    }) {
        Ok(Some(())) => {}
        Ok(None) => return,
        Err(why) => return refuse(limits, &mut conn, Api::Native, &why),
    }
    if too_big {
        return refuse(limits, &mut conn, Api::Native, &Refusal::new(431, "The request head is too large."));
    }
    let Some(end) = http::head_end(&buf) else { return };
    let head = match http::parse_head(&buf[..end], limits.max_body) {
        Ok(head) => head,
        Err(why) => return refuse(limits, &mut conn, Api::Native, &why),
    };
    note(limits, Event::Request { method: &head.method, target: &head.target });
    let api = api_for_target(&head.target);
    let plan = match plan(target, &head) {
        Ok(plan) => plan,
        Err(why) => return refuse(limits, &mut conn, api, &why),
    };
    // The body: exactly the declared length.
    let want = head.length.unwrap_or(0);
    if plan.needs_body && head.length.is_none() {
        return refuse(limits, &mut conn, api, &Refusal::new(411, "This request needs a Content-Length."));
    }
    if !plan.needs_body && want > 0 {
        return refuse(limits, &mut conn, api, &Refusal::new(400, "This request takes no body."));
    }
    let mut body: Vec<u8> = buf[end..].to_vec();
    if body.len() > want {
        return refuse(limits, &mut conn, api, &Refusal::new(400, "More bytes followed the request than it declared."));
    }
    if head.expects_continue && body.len() < want {
        let _ = conn.write_all(b"HTTP/1.1 100 Continue\r\n\r\n");
    }
    match read_until(&mut conn, &mut body, Instant::now() + limits.body_time, closed, |b| b.len() >= want) {
        Ok(Some(())) => {}
        Ok(None) => return,
        Err(why) => return refuse(limits, &mut conn, api, &why),
    }
    // Every model the request names is local, or the request goes nowhere.
    if let (Target::Ollama { judge, .. }, Some(route)) = (target, plan.route) {
        if route.needs_model {
            match policy::models_named(&route, &body) {
                Ok(names) => {
                    for name in &names {
                        let verdict = judge(name);
                        note(limits, Event::Model { name, verdict: verdict.err().unwrap_or("ok") });
                        if let Err(verdict) = verdict {
                            return refuse(limits, &mut conn, api, &policy::model_refusal(name, verdict));
                        }
                    }
                }
                Err(why) => return refuse(limits, &mut conn, api, &why),
            }
        }
    }
    let (connect, host, keep, judge) = match target {
        Target::Ollama { connect, host, judge } => (connect, host, OLLAMA_KEEP, Some(judge)),
        Target::Mcp { connect, host } => (connect, host, MCP_KEEP, None),
    };
    let mut up = match connect() {
        Ok(up) => up,
        Err(e) => return refuse(limits, &mut conn, api, &Refusal::new(503, format!("The model server could not be reached ({e})."))),
    };
    let _ = up.set_read_timeout(Some(Duration::from_secs(1)));
    let _ = up.set_write_timeout(Some(Duration::from_secs(60)));
    let request = http::upstream_request(&head.method, plan.path, host, &head, keep, &body);
    if up.write_all(&request).is_err() {
        return refuse(limits, &mut conn, api, &Refusal::new(502, "The request could not be sent to the model server."));
    }
    drop(body);
    forward(&mut conn, &mut up, &plan, judge, api, limits, closed, started);
}

/// What a request resolved to.
struct Plan {
    /// The path sent upstream: the canonical one, never the client's spelling.
    path: &'static str,
    needs_body: bool,
    route: Option<policy::Route>,
}

fn plan(target: &Target, head: &Head) -> Result<Plan, Refusal> {
    match target {
        Target::Ollama { .. } => {
            let route = policy::ollama_route(&head.method, &head.target)?;
            Ok(Plan { path: route.path, needs_body: route.post, route: Some(route) })
        }
        Target::Mcp { .. } => {
            let path = policy::mcp_route(&head.method, &head.target)?;
            Ok(Plan { path, needs_body: true, route: None })
        }
    }
}

/// Read the upstream's response and pass it on: streamed, or read whole and
/// narrowed when the route asks for it.
#[allow(clippy::too_many_arguments)]
fn forward(conn: &mut UnixStream, up: &mut TcpStream, plan: &Plan, judge: Option<&Judge>, api: Api, limits: &Limits, closed: &AtomicBool, started: Instant) {
    let mut raw: Vec<u8> = Vec::new();
    let mut idle = Instant::now();
    let mut chunk = vec![0u8; 16 * 1024];
    // The head.
    let end = loop {
        if let Some(end) = http::head_end(&raw) {
            break end;
        }
        if closed.load(Ordering::SeqCst) || client_gone(conn) {
            return;
        }
        if started.elapsed() > limits.total || idle.elapsed() > limits.idle {
            return refuse(limits, conn, api, &Refusal::new(504, "The model server did not answer."));
        }
        if raw.len() > 64 * 1024 {
            return refuse(limits, conn, api, &Refusal::new(502, "The model server's answer head is too large."));
        }
        match up.read(&mut chunk) {
            Ok(0) => return refuse(limits, conn, api, &Refusal::new(502, "The model server closed the connection without answering.")),
            Ok(n) => {
                raw.extend_from_slice(&chunk[..n]);
                idle = Instant::now();
            }
            Err(e) if timed_out(&e) => {}
            Err(_) => return refuse(limits, conn, api, &Refusal::new(502, "The model server connection failed.")),
        }
    };
    let head = match http::parse_response_head(&raw[..end]) {
        Ok(head) if head.status >= 200 => head,
        _ => return refuse(limits, conn, api, &Refusal::new(502, "The model server's answer could not be read.")),
    };
    note(limits, Event::Answered { status: head.status });
    let filter = plan.route.map_or(Filter::None, |r| r.filter);
    if filter != Filter::None && head.status == 200 {
        let mut body: Vec<u8> = raw[end..].to_vec();
        let mut idle = Instant::now();
        loop {
            if body.len() > limits.max_buffered * 2 || closed.load(Ordering::SeqCst) || started.elapsed() > limits.total || idle.elapsed() > limits.idle {
                return refuse(limits, conn, api, &Refusal::new(502, "The model list is too large or took too long."));
            }
            match up.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    body.extend_from_slice(&chunk[..n]);
                    idle = Instant::now();
                }
                Err(e) if timed_out(&e) => {}
                Err(_) => break,
            }
        }
        let body = if head.chunked() { http::dechunk(&body, limits.max_buffered) } else { Some(body) };
        let encoded = head.header("content-encoding").is_some_and(|e| !e.eq_ignore_ascii_case("identity"));
        let narrowed = match (body, encoded) {
            (Some(body), false) if body.len() <= limits.max_buffered => match filter {
                Filter::Tags => policy::filter_tags(&body),
                Filter::V1Models => match judge {
                    Some(judge) => policy::filter_v1_models(&body, &|id| judge(id).is_ok()),
                    None => Err("no judge".to_string()),
                },
                Filter::None => Ok(body),
            },
            _ => Err("the list could not be read whole".to_string()),
        };
        return match narrowed {
            Ok(list) => {
                let _ = conn.write_all(&http::response(200, "application/json", &list));
            }
            Err(_) => refuse(limits, conn, api, &Refusal::new(502, "The model list could not be narrowed to local models, so it was not passed on.")),
        };
    }
    // Streamed: the head, then every byte as it arrives.
    if conn.write_all(&http::passthrough_head(&head)).is_err() || conn.write_all(&raw[end..]).is_err() {
        return;
    }
    let mut idle = Instant::now();
    loop {
        if closed.load(Ordering::SeqCst) || started.elapsed() > limits.total || idle.elapsed() > limits.idle {
            return;
        }
        match up.read(&mut chunk) {
            Ok(0) => return,
            Ok(n) => {
                idle = Instant::now();
                if conn.write_all(&chunk[..n]).is_err() {
                    return;
                }
            }
            Err(e) if timed_out(&e) => {
                if client_gone(conn) {
                    return;
                }
            }
            Err(_) => return,
        }
    }
}
