//! The root console's MCP listener — the `AppHandle` half of
//! `services::root_mcp`, which holds the design and everything testable.
//!
//! One loopback HTTP route, `POST /mcp`, speaking MCP's streamable-HTTP
//! transport in its simplest legal form: one JSON-RPC message in, one JSON
//! reply out (or `202` for a notification). No SSE stream and no session id —
//! every tool is a single read or write of Tabtivity's own files, so there is
//! nothing to stream and nothing to remember between calls.

use axum::{
    extract::{State, Request},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::services::root_mcp::{self, Runtime, Stores};
use crate::storage;
use crate::services::root_mcp_security::{self as security, Access, Policy};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use std::pin::Pin;
use std::task::{Context, Poll};
use std::future::Future;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

/// Bounds sockets as well as requests: idle/slow headers otherwise consume
/// connections before the handler has a chance to authenticate anything.
struct BoundedListener {
    tcp: tokio::net::TcpListener,
    slots: Arc<tokio::sync::Semaphore>,
}
struct BoundedStream {
    tcp: tokio::net::TcpStream,
    _slot: tokio::sync::OwnedSemaphorePermit,
    expires: Pin<Box<tokio::time::Sleep>>,
    /// A socket that has sent nothing yet frees its slot after [`IDLE_OPEN`],
    /// long before the 30 s a request may take: thirty-two idle loopback
    /// connections must not hold admission for half a minute.
    idle: Pin<Box<tokio::time::Sleep>>,
    seen_bytes: bool,
}
/// How long an accepted socket may stay silent before it is dropped.
const IDLE_OPEN: Duration = Duration::from_secs(5);
/// The whole lifetime of one socket, request and reply included.
const SOCKET_LIFETIME: Duration = Duration::from_secs(30);
/// How many sockets may be open at once.
const SOCKETS: usize = 32;
impl BoundedStream {
    fn new(tcp: tokio::net::TcpStream, slot: tokio::sync::OwnedSemaphorePermit) -> Self {
        BoundedStream { tcp, _slot: slot, expires: Box::pin(tokio::time::sleep(SOCKET_LIFETIME)),
            idle: Box::pin(tokio::time::sleep(IDLE_OPEN)), seen_bytes: false }
    }
}
impl axum::serve::Listener for BoundedListener {
    type Io = BoundedStream;
    type Addr = std::net::SocketAddr;
    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            let slot = self.slots.clone().acquire_owned().await.expect("listener semaphore stays open");
            match self.tcp.accept().await {
                Ok((tcp, addr)) => return (BoundedStream::new(tcp, slot), addr),
                Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
            }
        }
    }
    fn local_addr(&self) -> std::io::Result<Self::Addr> { self.tcp.local_addr() }
}
impl AsyncRead for BoundedStream {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        if self.expires.as_mut().poll(cx).is_ready() || (!self.seen_bytes && self.idle.as_mut().poll(cx).is_ready()) {
            return Poll::Ready(Err(std::io::ErrorKind::TimedOut.into()));
        }
        let before = buf.filled().len();
        let polled = Pin::new(&mut self.tcp).poll_read(cx, buf);
        if buf.filled().len() > before {
            self.seen_bytes = true;
        }
        polled
    }
}
impl AsyncWrite for BoundedStream {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<std::io::Result<usize>> {
        if self.expires.as_mut().poll(cx).is_ready() { return Poll::Ready(Err(std::io::ErrorKind::TimedOut.into())); }
        Pin::new(&mut self.tcp).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> { Pin::new(&mut self.tcp).poll_flush(cx) }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> { Pin::new(&mut self.tcp).poll_shutdown(cx) }
}

/// The window's cue that a root agent wrote a calendar row. Payload:
/// `services::root_mcp::Change`.
const CHANGED_EVENT: &str = "root-mcp-changed";
/// The set of live MCP sessions changed: a token was handed out, revoked or
/// re-granted. No payload; the settings fold re-reads `root_mcp_security_status`.
pub const SESSIONS_EVENT: &str = "root-mcp-sessions-changed";

/// What a lane changed, for whoever shows it: the window turns it into its
/// Tauri event; the Mobile host pokes an open window over its control socket.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Notice {
    /// A schedule proposal was made or a row changed (`agent_tasks.json`).
    Schedules,
    /// A push or release proposal changed (`services::git_push_mcp`).
    GitPush,
}
pub type NoticeSink = Arc<dyn Fn(Notice) + Send + Sync>;

#[derive(Clone)]
struct ServerState {
    /// The window's handle: the root lane's mail and events. `None` in the
    /// Mobile host, whose listener serves the schedule, push and help lanes
    /// only (`docs/headless_mcp_plan.md`) — `/mcp` is not even routed there.
    app: Option<AppHandle>,
    port: u16,
    /// The process's token store, the only one this listener accepts.
    store: &'static root_mcp::TokenStore,
    notify: NoticeSink,
}

static REQUESTS: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
/// How long a request may wait for a worker slot. With the 5 s upload and the
/// 15 s of work it stays inside a socket's 30 s lifetime.
const PERMIT_WAIT: Duration = Duration::from_secs(8);

/// Runs before body collection or JSON parsing. Kept independent of Tauri for
/// adversarial transport tests using real request bodies.
async fn admit(request: Request, port: u16, store: &root_mcp::TokenStore) -> Result<(root_mcp::Session, Value, tokio::sync::OwnedSemaphorePermit, tokio::sync::OwnedSemaphorePermit), StatusCode> {
    if !matches!(request.version(), axum::http::Version::HTTP_10 | axum::http::Version::HTTP_11) {
        return Err(StatusCode::HTTP_VERSION_NOT_SUPPORTED);
    }
    let headers = request.headers();
    if headers.contains_key(header::ORIGIN) { return Err(StatusCode::FORBIDDEN); }
    let authority = headers.get(header::HOST).and_then(|v| v.to_str().ok())
        .or_else(|| request.uri().authority().map(|a| a.as_str()));
    let local = format!("127.0.0.1:{port}");
    let guest = format!("{}:{}", root_mcp::READER_GUEST_HOST, root_mcp::READER_GUEST_PORT);
    if headers.get_all(header::HOST).iter().count() > 1
        || !authority.is_some_and(|a| a == local || a == guest) {
        return Err(StatusCode::FORBIDDEN);
    }
    if headers.get_all(header::AUTHORIZATION).iter().count() != 1 { return Err(StatusCode::UNAUTHORIZED); }
    let session = store.authenticate(headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()))
        .ok_or(StatusCode::UNAUTHORIZED)?;
    if !path_serves(request.uri().path(), session.identity.caller) { return Err(StatusCode::UNAUTHORIZED); }
    if authority == Some(guest.as_str()) && session.identity.caller != root_mcp::Caller::Reader {
        return Err(StatusCode::FORBIDDEN);
    }
    if !headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok())
        .is_some_and(|s| s.split(';').next().is_some_and(|s| s.trim().eq_ignore_ascii_case("application/json"))) {
        return Err(StatusCode::UNSUPPORTED_MEDIA_TYPE);
    }
    if !session.admit_rate() { return Err(StatusCode::TOO_MANY_REQUESTS); }
    // Queue briefly rather than refuse: a CLI fires its parallel tool calls at
    // once, and a `429` reads to it as a broken server, not as "one moment".
    // The rate limit above and the socket bound still cap what can queue.
    let permits = async {
        let own = session.permits.clone().acquire_owned().await.ok()?;
        let global = REQUESTS.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(8))).clone()
            .acquire_owned().await.ok()?;
        Some((global, own))
    };
    let (global, own) = tokio::time::timeout(PERMIT_WAIT, permits).await
        .ok().flatten().ok_or(StatusCode::TOO_MANY_REQUESTS)?;
    let body = tokio::time::timeout(Duration::from_secs(5), axum::body::to_bytes(request.into_body(), security::MAX_BODY))
        .await.map_err(|_| StatusCode::REQUEST_TIMEOUT)?
        .map_err(|_| StatusCode::PAYLOAD_TOO_LARGE)?;
    let message: Value = serde_json::from_slice(&body).map_err(|_| StatusCode::BAD_REQUEST)?;
    // A batch (a top-level array) is admitted so it can be answered in JSON-RPC
    // terms below (`-32600`), not with a bare 400 the client cannot read.
    if !message.is_object() && !message.is_array() { return Err(StatusCode::BAD_REQUEST); }
    session.check().map_err(|_| StatusCode::UNAUTHORIZED)?;
    Ok((session, message, global, own))
}

/// The fixed category an admission failure is written down as; nothing the
/// request carried.
fn admission_reason(status: StatusCode) -> Option<&'static str> {
    Some(match status {
        StatusCode::UNAUTHORIZED => "unauthorized",
        StatusCode::FORBIDDEN => "forbidden_origin_or_host",
        StatusCode::HTTP_VERSION_NOT_SUPPORTED => "http_version",
        StatusCode::UNSUPPORTED_MEDIA_TYPE => "media_type",
        // Authenticated by then: the session's own audit row is the record.
        _ => return None,
    })
}

async fn handle(State(state): State<ServerState>, request: Request) -> Response {
    let started = Instant::now();
    let (session, message, global, own) = match admit(request, state.port, state.store).await {
        Ok(admitted) => admitted,
        Err(status) => {
            if let Some(reason) = admission_reason(status) { security::audit_admission(reason); }
            return status.into_response();
        }
    };
    let tool = message["params"]["name"].as_str().unwrap_or("").to_string();
    let audit_session = session.clone();
    if message.is_array() {
        security::audit_reason(&audit_session, "", "refused", started.elapsed(), Some("batch"));
        return Json(root_mcp::rpc_error(Value::Null, -32600, "batch requests are not supported: one message per request")).into_response();
    }
    if session.identity.caller == root_mcp::Caller::Helper {
        // The help identity (`services::help_mcp`): the compiled-in corpus and
        // nothing else. The switch is read per request, like the root one, so
        // "off" refuses tabs that already hold a token. Help calls are not
        // written to the audit ring: every agent tab may ask, and 500 rows of
        // doc lookups must not push the root tools' records out. Admission
        // failures above are still recorded.
        if !root_mcp::help_enabled_in(&storage::state_dir().join("settings.json")) || session.check().is_err() {
            return StatusCode::FORBIDDEN.into_response();
        }
        let reply = tokio::task::spawn_blocking(move || {
            let (_global, _own) = (global, own);
            crate::services::help_mcp::handle_message(&session, &message)
        }).await;
        return match reply {
            Ok(Some(reply)) => Json(reply).into_response(),
            Ok(None) => StatusCode::ACCEPTED.into_response(),
            Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        };
    }
    if session.identity.caller == root_mcp::Caller::Scheduler {
        if session.identity.project.as_deref().is_none_or(|p| crate::services::schedule_mcp::level(p).is_err()) || session.check().is_err() {
            security::audit_reason(&session, &tool, "denied", started.elapsed(), Some("policy_disabled"));
            return StatusCode::FORBIDDEN.into_response();
        }
        // Arguments and the hourly budget are checked *before* the usage
        // probe: a malformed or over-budget `after_usage_reset` call is refused
        // without spawning the agent CLI, so the probe cannot be run unbounded.
        let admission = crate::services::schedule_mcp::admit(&session, &message);
        let reset = if admission.is_ok() && message["method"] == "tools/call" && message["params"]["name"] == "schedule_prompt"
            && message["params"]["arguments"]["when"]["type"] == "after_usage_reset" {
            let agent = session.identity.schedule_target.as_ref().map(|b| b.agent.clone()).unwrap_or_default();
            let report = tokio::time::timeout(Duration::from_secs(8), crate::commands::agents::agent_usage(agent, Some(false))).await.ok();
            report.and_then(|r| r.raw).as_deref().and_then(|raw| crate::services::schedule_usage::next_reset(raw, chrono::Utc::now()))
        } else { None };
        let outcome = tokio::task::spawn_blocking(move || {
            let (_global, _own) = (global, own);
            crate::services::schedule_mcp::handle_admitted(&session, &message, reset, admission)
        }).await;
        let Ok((reply, changed)) = outcome else { return StatusCode::INTERNAL_SERVER_ERROR.into_response() };
        let failed = reply.as_ref().is_some_and(|r| r.get("error").is_some() || r["result"]["isError"] == true);
        security::audit_reason(&audit_session, &tool, if failed { "refused" } else { "allowed" }, started.elapsed(), reply.as_ref().and_then(crate::services::schedule_mcp::refusal_reason));
        if changed { (state.notify)(Notice::Schedules); }
        return match reply { Some(reply) => Json(reply).into_response(), None => StatusCode::ACCEPTED.into_response() };
    }
    if session.identity.caller == root_mcp::Caller::Pusher {
        // The push lane (`services::git_push_mcp`): the global switch is read
        // per request, so "off" refuses tabs that already hold a token. The
        // project's own level is *not* a refusal here — `off` is answered as a
        // tool result naming the setting, so the agent can relay it.
        if !crate::services::git_push_mcp::enabled() || session.check().is_err() {
            security::audit_reason(&session, &tool, "denied", started.elapsed(), Some("policy_disabled"));
            return StatusCode::FORBIDDEN.into_response();
        }
        let outcome = tokio::task::spawn_blocking(move || {
            let (_global, _own) = (global, own);
            crate::services::git_push_mcp::handle_message(&session, &message)
        }).await;
        let Ok((reply, changed)) = outcome else { return StatusCode::INTERNAL_SERVER_ERROR.into_response() };
        let reason = reply.as_ref().and_then(crate::services::git_push_mcp::refusal_reason);
        let failed = reason.is_some() || reply.as_ref().is_some_and(|r| r.get("error").is_some() || r["result"]["isError"] == true);
        security::audit_reason(&audit_session, &tool, if failed { "refused" } else { "allowed" }, started.elapsed(), reason);
        if changed { (state.notify)(Notice::GitPush); }
        return match reply { Some(reply) => Json(reply).into_response(), None => StatusCode::ACCEPTED.into_response() };
    }
    // The root lane is the window's: its mail, review and session controls
    // live there. The Mobile host does not route `/mcp` and holds no root,
    // local-model or reader token, so this is a second wall, not the first.
    let Some(app) = state.app.clone() else {
        security::audit_reason(&session, &tool, "denied", started.elapsed(), Some("window_required"));
        return StatusCode::FORBIDDEN.into_response();
    };
    let mail = app
        .try_state::<crate::commands::mail::MailState>()
        .map(|s| crate::commands::mail::AgentMail(s.inner().clone()));
    let outcome = tokio::task::spawn_blocking(move || {
        // Permits live in the worker: an HTTP disconnect cannot free capacity
        // while blocking work is still running.
        let (_global, _own) = (global, own);
        // From admission, not arrival: time spent queued is not time worked.
        let deadline = Instant::now() + Duration::from_secs(15);
        let caller = &session.identity;
        let state = storage::state_dir();
        let calendar = crate::commands::calendar::calendar_path();
        let projects = state.join("projects.json");
        let settings = state.join("settings.json");
        // The switches, read per request: an agent spawned while the tools
        // were on (or not yet local-only) still holds its token, and "off" has
        // to mean off for it too, without closing its tab.
        let policy = Policy::load(&settings).map_err(|_| Refusal::Unavailable)?;
        if session.check().is_err() { return Err(Refusal::Revoked); }
        if !policy.serves(caller.caller) { return Err(Refusal::Off); }
        // A reader is served only while its box is actually narrow, checked
        // per call: widening mid-session refuses the *next* read.
        let reader_refusal = (caller.caller == root_mcp::Caller::Reader)
            .then(|| crate::commands::vm::mail_reader_refusal(caller.project.as_deref()))
            .flatten();
        Ok(root_mcp::handle_message(
            &Stores {
                calendar: &calendar,
                projects: &projects,
                settings: &settings,
                state: &state,
                caller: caller.caller,
                mail: mail.as_ref().map(|m| m as &dyn crate::services::root_mcp_mail::MailAccess),
                reader_refusal: reader_refusal.as_deref(),
                policy, access: session.access.clone(), session: Some(&session),
                deadline: Some(deadline),
            },
            &caller.tab,
            &message,
        ))
    })
    .await;
    let Ok(outcome) = outcome else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let (reply, effects) = match outcome {
        Ok(served) => served,
        Err(refusal) => {
            security::audit_reason(&audit_session, &tool, "denied", started.elapsed(), Some(refusal.reason()));
            return (refusal.status(), refusal.text()).into_response();
        }
    };
    let failed = reply.as_ref().is_some_and(|r| r.get("error").is_some() || r["result"]["isError"] == true);
    security::audit(&audit_session, &tool, if failed { "refused" } else { "allowed" }, started.elapsed());
    // One event per row: a board move can reindex a whole column.
    for change in effects.changes {
        let _ = app.emit(CHANGED_EVENT, change);
    }
    if security::tool(&tool).is_some_and(|t| t.write) {
        let _ = app.emit("root-mcp-review-changed",
            crate::services::root_mcp_review::pending_count(&storage::state_dir()));
    }
    match reply {
        Some(reply) => Json(reply).into_response(),
        None => StatusCode::ACCEPTED.into_response(),
    }
}

/// Why a request that authenticated is not served, each with its own words:
/// the agent relays them to the user, and "switched off in Settings" is wrong
/// advice for a session the user just revoked.
#[derive(Clone, Copy)]
enum Refusal { Unavailable, Off, Revoked }
impl Refusal {
    fn status(self) -> StatusCode {
        match self { Refusal::Revoked => StatusCode::UNAUTHORIZED, _ => StatusCode::SERVICE_UNAVAILABLE }
    }
    fn text(self) -> &'static str {
        match self {
            Refusal::Unavailable => concat!(crate::app_name!(), "'s MCP settings are unavailable; the tools stay off until they can be read"),
            Refusal::Off => concat!(crate::app_name!(), "'s tools are switched off in ", crate::app_name!(), "'s Settings; the user has to turn them on first"),
            Refusal::Revoked => concat!("this tab's MCP access was revoked or changed in ", crate::app_name!(), "'s MCP session access; retry once (a changed grant applies to the next call), and if it stays refused the tab has to be reopened to get the tools back"),
        }
    }
    fn reason(self) -> &'static str {
        match self { Refusal::Unavailable => "settings_unavailable", Refusal::Off => "switched_off", Refusal::Revoked => "revoked" }
    }
}

async fn close_connection(mut response: Response) -> Response {
    // A new socket per RPC avoids expiring a reused connection in the middle
    // of a later write. Loopback setup is cheap and HTTP clients reconnect.
    response.headers_mut().insert(header::CONNECTION, axum::http::HeaderValue::from_static("close"));
    response
}

/// Bind the listener and publish its runtime. Called once from `setup`; a
/// failure leaves root agents exactly as capable as any other agent, which is
/// the safe direction to fail in.
/// Raised by [`stop_for_exit`]; the listener stops accepting on it.
static SHUTDOWN: tokio::sync::Notify = tokio::sync::Notify::const_new();
static SERVER: std::sync::Mutex<Option<tauri::async_runtime::JoinHandle<()>>> = std::sync::Mutex::new(None);

/// `RunEvent::Exit`: stop accepting, give the workers in flight a short bounded
/// drain, and remove every per-tab copy — nothing of the endpoint outlives a
/// clean quit. Idempotent; a no-op when the listener never started.
pub fn stop_for_exit() {
    SHUTDOWN.notify_waiters();
    SHUTDOWN.notify_one();
    let handle = SERVER.lock().unwrap_or_else(|p| p.into_inner()).take();
    if let Some(handle) = handle {
        tauri::async_runtime::block_on(async {
            let _ = tokio::time::timeout(Duration::from_secs(2), handle).await;
        });
    }
    crate::services::root_mcp_review::sweep_sandboxes(&storage::state_dir());
}

pub fn start(app: AppHandle) {
    // Copies a crash left behind: no tab is live yet, so every one of them goes.
    crate::services::root_mcp_review::sweep_sandboxes(&storage::state_dir());
    // Push proposals change state on worker threads; the service stays
    // AppHandle-free and rings this instead.
    let push_events = app.clone();
    crate::services::git_push_mcp::set_change_hook(Box::new(move || {
        let _ = push_events.emit(crate::services::git_push_mcp::CHANGED_EVENT, ());
    }));
    let events = app.clone();
    let notify: NoticeSink = Arc::new(move |notice| {
        let _ = match notice {
            Notice::Schedules => events.emit("agent-schedules-changed", ()),
            Notice::GitPush => events.emit(crate::services::git_push_mcp::CHANGED_EVENT, ()),
        };
    });
    let handle = tauri::async_runtime::spawn(async move {
        let served = match bind(LOOPBACK).await {
            Ok(listener) => serve(listener, Some(app), notify, async { SHUTDOWN.notified().await }),
            Err(error) => Err(error),
        };
        match served {
            Ok((_, server)) => server.await,
            Err(error) => eprintln!("[root-mcp] {error}"),
        }
    });
    *SERVER.lock().unwrap_or_else(|p| p.into_inner()) = Some(handle);
}

/// The Mobile host's listener (`docs/headless_mcp_plan.md`): the schedule,
/// push and help lanes for the tabs it spawns with no window open, on its own
/// loopback port and token store; never the root lane. Bound before this
/// returns, so a spawn after it is wired; the server runs until `shutdown`
/// turns true. When the first bind fails, the error is returned (for the
/// journal) and a task keeps retrying with [`bind_retry_delay`] until a bind
/// succeeds or the host shuts down — tabs spawned meanwhile go without tools.
pub async fn start_headless(
    notify: NoticeSink,
    shutdown: tokio::sync::watch::Receiver<bool>,
) -> Result<u16, String> {
    start_headless_on(LOOPBACK, notify, shutdown).await
}

/// Any free loopback port.
const LOOPBACK: std::net::SocketAddr = std::net::SocketAddr::new(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST), 0);

/// [`start_headless`] on a chosen address (a test occupies one).
async fn start_headless_on(
    addr: std::net::SocketAddr,
    notify: NoticeSink,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) -> Result<u16, String> {
    let first = match bind(addr).await {
        Ok(listener) => serve(listener, None, notify.clone(), until_true(shutdown.clone())),
        Err(error) => Err(error),
    };
    match first {
        Ok((port, server)) => {
            tokio::spawn(server);
            Ok(port)
        }
        Err(error) => {
            tokio::spawn(async move {
                let mut attempt = 0;
                loop {
                    tokio::select! {
                        _ = tokio::time::sleep(bind_retry_delay(attempt)) => {}
                        changed = shutdown.changed() => {
                            if changed.is_err() || *shutdown.borrow() { return; }
                            continue;
                        }
                    }
                    attempt = attempt.saturating_add(1);
                    let Ok(listener) = bind(addr).await else { continue };
                    if let Ok((port, server)) = serve(listener, None, notify.clone(), until_true(shutdown.clone())) {
                        eprintln!("[root-mcp] bound on port {port} after {attempt} retries");
                        server.await;
                        return;
                    }
                }
            });
            Err(error)
        }
    }
}

/// How long the Mobile host waits before its `attempt`-th bind retry: 5 s,
/// doubling, at most five minutes.
fn bind_retry_delay(attempt: u32) -> Duration {
    Duration::from_secs(5u64.saturating_mul(1u64 << attempt.min(6)).min(300))
}

/// Resolves once `flag` turns true (or its sender is gone).
async fn until_true(mut flag: tokio::sync::watch::Receiver<bool>) {
    while !*flag.borrow() {
        if flag.changed().await.is_err() {
            break;
        }
    }
}

/// The routes a listener answers: the three side lanes everywhere, the root
/// lane only where there is a window to serve it.
fn router(state: ServerState) -> Router {
    let mut router = Router::new()
        .route("/mcp/schedule", post(handle))
        .route("/mcp/git", post(handle))
        .route("/mcp/help", post(handle));
    if state.app.is_some() {
        router = router.route("/mcp", post(handle));
    }
    router.layer(axum::middleware::map_response(close_connection)).with_state(state)
}

async fn bind(addr: std::net::SocketAddr) -> Result<tokio::net::TcpListener, String> {
    tokio::net::TcpListener::bind(addr).await.map_err(|e| format!("bind failed: {e}"))
}

/// Publish a bound listener as this process's [`Runtime`] and hand back its
/// port and the server, which stops on `shutdown`.
fn serve(
    listener: tokio::net::TcpListener,
    app: Option<AppHandle>,
    notify: NoticeSink,
    shutdown: impl std::future::Future<Output = ()> + Send + 'static,
) -> Result<(u16, impl std::future::Future<Output = ()> + Send), String> {
    let port = listener.local_addr().map_err(|e| format!("bind failed: {e}"))?.port();
    root_mcp::set_runtime(Runtime { port, serves_root: app.is_some() });
    let router = router(ServerState { app, port, store: root_mcp::tokens(), notify });
    let listener = BoundedListener { tcp: listener, slots: Arc::new(tokio::sync::Semaphore::new(SOCKETS)) };
    Ok((port, async move {
        if let Err(error) = axum::serve(listener, router).with_graceful_shutdown(shutdown).await {
            eprintln!("[root-mcp] server stopped: {error}");
        }
    }))
}

#[derive(Serialize)]
pub struct RootMcpStatus {
    /// The listener is up, so a root agent opened now gets the tools.
    pub running: bool,
    /// The global switch (`Settings::root_mcp`). Off → no agent gets the tools
    /// and the endpoint refuses the ones that already hold the token.
    pub enabled: bool,
    pub tools: Vec<&'static str>,
    /// Agent CLIs that can call the tools (`root_mcp::WIRED_CLIS`); the rest
    /// get the endpoint's env pair and nothing that uses it.
    pub wired_clis: &'static [&'static str],
    /// Some agent could read mail now — a contained reader (`Settings::root_mcp_mail`
    /// on, neither local-only switch on) or a local-model tab
    /// (`Settings::root_mcp_mail_local_read`) — and at least one mail account is
    /// open to agents (`MailAiPrefs::agent_access`): the badge's mail mark.
    pub mail_open: bool,
    /// With `mail_open`, the widest `MailAiPrefs::agent_scope` among those
    /// accounts: `Marked` (a few marked messages) or `All` (a whole account).
    /// Only a reader reads a whole account; a local-model tab alone is `Marked`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mail_scope: Option<crate::schema::mail::MailAgentScope>,
    /// A root agent started now would run inside the fence, so the staged-write
    /// review is a gate it cannot walk around. False (fence switched off, or a
    /// platform with none) means the agent shares the user's files and can edit
    /// the calendar store or the review setting itself — the review strip is
    /// then a courtesy, and the badge has to say so rather than imply a gate.
    pub review_enforced: bool,
    /// A root agent started now could read the projects: fenced with
    /// `Settings::root_fence_projects_readable` on, or unfenced. What the mail
    /// `attach` argument needs; a running tab keeps what it was spawned with.
    pub projects_readable: bool,
    /// The help server (`services::help_mcp`), for the intro/Settings chip.
    pub help: HelpMcpStatus,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelpMcpStatus {
    /// A local agent tab opened now gets the help server: the listener is up
    /// and `Settings::help_mcp` is not switched off.
    pub enabled: bool,
    /// CLIs named the server on their command line; tool-tagged local Vibe
    /// models get it too. Other agent CLIs get the env pair only.
    pub wired_clis: &'static [&'static str],
    /// Topics compiled into this build.
    pub topics: usize,
}

/// What the overlay's rights badge shows. Deliberately carries neither the port
/// nor the token — the renderer has no use for either.
#[tauri::command]
pub fn root_mcp_status() -> RootMcpStatus {
    let settings = storage::state_dir().join("settings.json");
    let reader = root_mcp::serves(&settings, root_mcp::Caller::Reader);
    let local = crate::services::root_mcp_security::Policy::load(&settings)
        .is_ok_and(|p| p.serves(root_mcp::Caller::LocalModel) && p.reads_mail(root_mcp::Caller::LocalModel));
    let open = (reader || local) && crate::commands::mail::any_account_open_to_agents();
    let review_enforced = crate::services::agent_fence::enforced_here();
    RootMcpStatus {
        running: root_mcp::runtime().is_some(),
        enabled: root_mcp::enabled(),
        tools: root_mcp::tool_names(),
        wired_clis: root_mcp::WIRED_CLIS,
        mail_open: open,
        mail_scope: if reader {
            crate::commands::mail::widest_agent_scope()
        } else {
            open.then_some(crate::schema::mail::MailAgentScope::Marked)
        },
        review_enforced,
        projects_readable: !review_enforced
            || crate::storage::read_json::<crate::schema::Settings>(&settings)
                .is_ok_and(|s| s.root_fence_projects_readable()),
        help: HelpMcpStatus {
            enabled: root_mcp::runtime().is_some() && root_mcp::help_enabled_in(&settings),
            wired_clis: crate::services::help_mcp::WIRED_CLIS,
            topics: crate::services::help_mcp::index().topics.len(),
        },
    }
}

/// The window's own view of the help corpus (an intro / Settings "Ask" box):
/// the same index and bounds the `tabtivity-help` MCP server answers from.
/// Off the main thread: the first call builds the index.
#[tauri::command]
pub async fn help_search(query: String, limit: Option<usize>) -> Result<Vec<crate::services::help_mcp::Hit>, String> {
    tokio::task::spawn_blocking(move || {
        let query: String = query.chars().take(crate::services::help_mcp::MAX_QUERY_BYTES).collect();
        crate::services::help_mcp::index().search(&query, limit.unwrap_or(crate::services::help_mcp::DEFAULT_RESULTS))
    }).await.map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn help_read(topic_id: String, section: Option<String>) -> Result<crate::services::help_mcp::Read, String> {
    tokio::task::spawn_blocking(move || crate::services::help_mcp::index().read(&topic_id, section.as_deref()))
        .await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn help_topics() -> Result<Vec<crate::services::help_mcp::TopicRef>, String> {
    tokio::task::spawn_blocking(|| crate::services::help_mcp::index().list()).await.map_err(|e| e.to_string())
}

fn review_stores<T>(f: impl FnOnce(&Stores) -> Result<T, String>) -> Result<T, String> {
    let state = storage::state_dir();
    f(&Stores {
        calendar: &crate::commands::calendar::calendar_path(),
        projects: &state.join("projects.json"),
        settings: &state.join("settings.json"),
        state: &state,
        // Review decisions are the user's, made in the window: no caller class
        // and no mail are involved in applying a staged calendar row.
        caller: root_mcp::Caller::Agent,
        mail: None,
        reader_refusal: None,
        policy: Policy::load(&state.join("settings.json"))?,
        access: Access::initial(root_mcp::Caller::Agent), session: None, deadline: None,
    })
}
fn emit_review(app: &AppHandle, changes: Vec<root_mcp::Change>) {
    for change in changes {
        let _ = app.emit(CHANGED_EVENT, change);
    }
    let _ = app.emit(
        "root-mcp-review-changed",
        crate::services::root_mcp_review::pending_count(&storage::state_dir()),
    );
}
#[tauri::command]
pub async fn root_mcp_review_list(
    app: AppHandle,
) -> Result<Vec<crate::services::root_mcp_review::ReviewEntry>, String> {
    let (entries, before) = tokio::task::spawn_blocking(|| {
        let before = crate::services::root_mcp_review::pending_count(&storage::state_dir());
        review_stores(crate::services::root_mcp_review::list).map(|entries| (entries, before))
    })
    .await
    .map_err(|e| e.to_string())??;
    let count = entries
        .iter()
        .filter(|p| p.proposal.status == "pending")
        .count();
    if count != before {
        let _ = app.emit("root-mcp-review-changed", count);
    }
    Ok(entries)
}
#[tauri::command]
pub async fn root_mcp_review_apply(
    app: AppHandle,
    id: String,
    digest: String,
) -> Result<(), String> {
    let result = tokio::task::spawn_blocking(move || {
        review_stores(|s| crate::services::root_mcp_review::decide(s, &id, &digest, "apply"))
    })
    .await
    .map_err(|e| e.to_string())?;
    emit_review(&app, result?);
    Ok(())
}
#[tauri::command]
pub async fn root_mcp_review_reject(
    app: AppHandle,
    id: String,
    digest: String,
) -> Result<(), String> {
    let result = tokio::task::spawn_blocking(move || {
        review_stores(|s| crate::services::root_mcp_review::decide(s, &id, &digest, "reject"))
    })
    .await
    .map_err(|e| e.to_string())?;
    emit_review(&app, result?);
    Ok(())
}
#[tauri::command]
pub async fn root_mcp_review_undo(
    app: AppHandle,
    id: String,
    digest: String,
) -> Result<(), String> {
    let result = tokio::task::spawn_blocking(move || {
        review_stores(|s| crate::services::root_mcp_review::decide(s, &id, &digest, "undo"))
    })
    .await
    .map_err(|e| e.to_string())?;
    emit_review(&app, result?);
    Ok(())
}
#[tauri::command]
pub async fn root_mcp_review_apply_all(
    app: AppHandle,
    approvals: Vec<crate::services::root_mcp_review::Approval>,
) -> Result<(), String> {
    let result = tokio::task::spawn_blocking(move || {
        review_stores(|s| crate::services::root_mcp_review::apply_all(s, &approvals))
    })
    .await
    .map_err(|e| e.to_string())?;
    emit_review(&app, result?);
    Ok(())
}

/// The `.ics` files root agents staged (`services::root_mcp_import`), text and
/// all: the window's parser reads them, and its importer runs on the user's ✓.
#[tauri::command]
pub async fn root_mcp_import_list() -> Result<Vec<crate::services::root_mcp_import::StagedImport>, String> {
    tokio::task::spawn_blocking(|| crate::services::root_mcp_import::list(&storage::state_dir()))
        .await
        .map_err(|e| e.to_string())
}
/// Imported or discarded: the staged copy goes either way.
#[tauri::command]
pub async fn root_mcp_import_remove(app: AppHandle, id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || crate::services::root_mcp_import::remove(&storage::state_dir(), &id))
        .await
        .map_err(|e| e.to_string())??;
    emit_review(&app, Vec::new());
    Ok(())
}

#[derive(Serialize)]
pub struct SecurityStatus {
    sessions: Vec<root_mcp::SessionInfo>,
    audit: Vec<security::Audit>,
}
#[tauri::command]
pub fn root_mcp_security_status() -> SecurityStatus {
    SecurityStatus { sessions: root_mcp::sessions(), audit: security::audit_rows() }
}
#[tauri::command]
pub async fn root_mcp_session_access(app: AppHandle, id: String, access: Access) -> Result<(), String> {
    tokio::task::spawn_blocking(move || root_mcp::set_access(&id, access)).await.map_err(|e| e.to_string())??;
    let _ = app.emit(SESSIONS_EVENT, ());
    Ok(())
}
#[tauri::command]
pub async fn root_mcp_session_revoke(app: AppHandle, id: String, remove_proposals: Option<bool>) -> Result<(), String> {
    // Invalidate first, before waiting on the review lock to clean the sandbox.
    let tab = root_mcp::revoke_session(&id)?;
    tokio::task::spawn_blocking(move || {
        crate::services::root_mcp_review::cleanup_tab(&storage::state_dir(), &tab);
        crate::services::agent_tasks::drain_mutations();
        if remove_proposals == Some(true) { crate::services::schedule_mcp::remove_proposals(&id)?; }
        // A push proposal is useless without the session that made it.
        if crate::services::git_push_mcp::remove_for_session(&id) { let _ = app.emit(crate::services::git_push_mcp::CHANGED_EVENT, ()); }
        let _ = app.emit("agent-schedules-changed", ());
        let _ = app.emit(SESSIONS_EVENT, ());
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

/// The push proposals of one project (the git bar's and the Agents view's
/// card), pruned of expired and orphaned ones.
#[tauri::command]
pub fn git_push_mcp_proposals(project_id: String) -> Vec<crate::services::git_push_mcp::Proposal> {
    crate::services::git_push_mcp::proposals_for(Some(&project_id), None)
}
/// Push (approve) or dismiss a pending proposal. Approval re-checks the
/// bound SHA and the remote, confirms a first URL, then pushes; the reply is
/// the proposal in its final state.
#[tauri::command]
pub async fn git_push_mcp_decide(app: AppHandle, id: String, approve: bool) -> Result<crate::services::git_push_mcp::Proposal, String> {
    let result = tokio::task::spawn_blocking(move || crate::services::git_push_mcp::decide(&id, approve)).await.map_err(|e| e.to_string())?;
    let _ = app.emit(crate::services::git_push_mcp::CHANGED_EVENT, ());
    result
}
/// Close a finished (pushed, failed, dismissed, expired) proposal's card.
#[tauri::command]
pub fn git_push_mcp_clear(app: AppHandle, id: String) -> Result<crate::services::git_push_mcp::Proposal, String> {
    let result = crate::services::git_push_mcp::clear(&id);
    let _ = app.emit(crate::services::git_push_mcp::CHANGED_EVENT, ());
    result
}

/// Whether a listener over `store` admits `token` on `path`, as far as a
/// well-formed `ping` body — the question a test of another module asks
/// (`mobile_control::host`'s headless create).
#[cfg(test)]
pub(crate) async fn admission(store: &root_mcp::TokenStore, path: &str, token: &str) -> Result<(), StatusCode> {
    let request = Request::builder().method("POST").uri(path).header(header::HOST, "127.0.0.1:8765")
        .header(header::CONTENT_TYPE, "application/json").header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(axum::body::Body::from(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#)).expect("request");
    admit(request, 8765, store).await.map(|_| ())
}

fn path_serves(path: &str, caller: root_mcp::Caller) -> bool {
    match path {
        "/mcp" => !matches!(caller, root_mcp::Caller::Scheduler | root_mcp::Caller::Pusher | root_mcp::Caller::Helper),
        "/mcp/schedule" => caller == root_mcp::Caller::Scheduler,
        "/mcp/git" => caller == root_mcp::Caller::Pusher,
        "/mcp/help" => caller == root_mcp::Caller::Helper,
        _ => false,
    }
}

#[cfg(test)]
mod security_tests {
    #[tokio::test]
    async fn routes_refuse_wrong_token_class_before_reading_body() {
        for caller in [root_mcp::Caller::Agent, root_mcp::Caller::LocalModel, root_mcp::Caller::Reader, root_mcp::Caller::Scheduler, root_mcp::Caller::Pusher] {
            let (token, session) = root_mcp::test_session(caller);
            let wrong = if caller == root_mcp::Caller::Scheduler { "/mcp" } else { "/mcp/schedule" };
            let req = Request::builder().method("POST").uri(wrong).header("host", "127.0.0.1:8765")
                .header("authorization", format!("Bearer {token}"))
                .body(axum::body::Body::from("not json")).unwrap();
            assert!(matches!(admit(req, 8765, root_mcp::tokens()).await, Err(StatusCode::UNAUTHORIZED)));
            let own = match caller { root_mcp::Caller::Scheduler => "/mcp/schedule", root_mcp::Caller::Pusher => "/mcp/git", _ => "/mcp" };
            assert!(path_serves(own, caller));
            assert!(!path_serves("/mcp/git", caller) || caller == root_mcp::Caller::Pusher, "{caller:?}");
            root_mcp::revoke_tab(&session.identity.tab);
        }
    }
    /// The help identity reaches `/mcp/help` and nothing else; no other
    /// class reaches `/mcp/help`. Refused at admission, before the body.
    #[tokio::test]
    async fn help_route_is_its_own_lane() {
        let post = |path: &str, token: &str| Request::builder().method("POST").uri(path).header("host", "127.0.0.1:8765")
            .header("content-type", "application/json").header("authorization", format!("Bearer {token}"))
            .body(axum::body::Body::from("not json")).unwrap();
        let (token, helper) = root_mcp::test_session(root_mcp::Caller::Helper);
        for path in ["/mcp", "/mcp/schedule", "/mcp/other"] {
            assert!(matches!(admit(post(path, &token), 8765, root_mcp::tokens()).await, Err(StatusCode::UNAUTHORIZED)), "{path}");
        }
        // Right lane: admitted as far as the body, which is not JSON.
        assert!(matches!(admit(post("/mcp/help", &token), 8765, root_mcp::tokens()).await, Err(StatusCode::BAD_REQUEST)));
        // A browser Origin or a foreign Host never gets that far.
        let mut req = post("/mcp/help", &token);
        req.headers_mut().insert(header::ORIGIN, "http://127.0.0.1:8765".parse().unwrap());
        assert!(matches!(admit(req, 8765, root_mcp::tokens()).await, Err(StatusCode::FORBIDDEN)));
        let mut req = post("/mcp/help", &token);
        req.headers_mut().insert(header::HOST, format!("{}:{}", root_mcp::READER_GUEST_HOST, root_mcp::READER_GUEST_PORT).parse().unwrap());
        assert!(matches!(admit(req, 8765, root_mcp::tokens()).await, Err(StatusCode::FORBIDDEN)));
        assert!(matches!(admit(post("/mcp/help", "0".repeat(64).as_str()), 8765, root_mcp::tokens()).await, Err(StatusCode::UNAUTHORIZED)));
        root_mcp::revoke_tab(&helper.identity.tab);
        assert!(matches!(admit(post("/mcp/help", &token), 8765, root_mcp::tokens()).await, Err(StatusCode::UNAUTHORIZED)), "a closed tab's token");
        for caller in [root_mcp::Caller::Agent, root_mcp::Caller::LocalModel, root_mcp::Caller::Reader, root_mcp::Caller::Scheduler, root_mcp::Caller::Pusher] {
            let (token, session) = root_mcp::test_session(caller);
            assert!(matches!(admit(post("/mcp/help", &token), 8765, root_mcp::tokens()).await, Err(StatusCode::UNAUTHORIZED)), "{caller:?}");
            root_mcp::revoke_tab(&session.identity.tab);
        }
    }
    /// Two processes, two stores (`docs/headless_mcp_plan.md`): a listener
    /// admits only the tokens its own process minted. The window refuses a
    /// Mobile host's schedule and help tokens, and so does the Mobile host
    /// itself after a restart (a fresh store).
    #[tokio::test]
    async fn a_token_is_admitted_only_by_the_listener_whose_process_minted_it() {
        let host: &'static root_mcp::TokenStore = Box::leak(Box::default());
        let window: &'static root_mcp::TokenStore = Box::leak(Box::default());
        let runtime = Runtime { port: 8765, serves_root: false };
        let mut opts: crate::terminal::PtyOptions = serde_json::from_value(serde_json::json!({
            "id": "headless:t", "cmd": "claude", "args": [], "env": {}, "cwd": "/w", "cols": 80, "rows": 24,
            "local_only": false, "sandbox": false, "agent": true, "project_id": "p", "schedule_target_id": "target-1",
            "remote_host_id": null, "tmux_session": null, "tmux_attach": null, "host_bound_uid": null, "host_session": false,
        })).expect("options");
        root_mcp::grant_schedule(&mut opts, &runtime, host, &[]);
        root_mcp::grant_help(&mut opts, &runtime, host, &[]);
        let schedule = opts.env[root_mcp::SCHEDULE_TOKEN_ENV].clone();
        let help = opts.env[root_mcp::HELP_TOKEN_ENV].clone();
        assert_eq!(admission(host, "/mcp/schedule", &schedule).await, Ok(()));
        assert_eq!(admission(host, "/mcp/help", &help).await, Ok(()));
        let restarted: &'static root_mcp::TokenStore = Box::leak(Box::default());
        for other in [window, restarted] {
            assert_eq!(admission(other, "/mcp/schedule", &schedule).await, Err(StatusCode::UNAUTHORIZED));
            assert_eq!(admission(other, "/mcp/help", &help).await, Err(StatusCode::UNAUTHORIZED));
        }
        // Nor does the process-wide store know them.
        assert!(root_mcp::authenticate(Some(&format!("Bearer {schedule}"))).is_none());
    }

    /// A Mobile host whose first bind fails says so (a fixed prefix for the
    /// journal, no runtime published) and leaves a retry running that backs
    /// off to five minutes and ends with the host's shutdown.
    #[tokio::test]
    async fn a_failed_headless_bind_is_reported_and_retried_until_shutdown() {
        let taken = tokio::net::TcpListener::bind(LOOPBACK).await.unwrap();
        let addr = taken.local_addr().unwrap();
        let (stop, stopped) = tokio::sync::watch::channel(false);
        let error = start_headless_on(addr, Arc::new(|_| {}), stopped).await.unwrap_err();
        assert!(error.starts_with("bind failed:"), "{error}");
        assert!(root_mcp::runtime().is_none_or(|r| r.port != addr.port()), "nothing was published for the taken port");
        assert_eq!(bind_retry_delay(0), Duration::from_secs(5));
        assert_eq!(bind_retry_delay(1), Duration::from_secs(10));
        assert_eq!(bind_retry_delay(5), Duration::from_secs(160));
        assert_eq!(bind_retry_delay(6), Duration::from_secs(300));
        assert_eq!(bind_retry_delay(u32::MAX), Duration::from_secs(300));
        stop.send(true).unwrap();
        // The retry task sees the shutdown and ends without binding.
        tokio::task::yield_now().await;
        drop(taken);
    }

    /// The Mobile host's listener has no root lane at all: `/mcp` is not
    /// routed (404 before any handler), while the window's is.
    #[tokio::test]
    async fn the_headless_router_does_not_route_the_root_lane() {
        use tower::ServiceExt;
        let state = ServerState { app: None, port: 8765, store: root_mcp::tokens(), notify: Arc::new(|_| {}) };
        let req = |path: &str| Request::builder().method("POST").uri(path).header("host", "127.0.0.1:8765")
            .header("content-type", "application/json").header("authorization", "Bearer x")
            .body(axum::body::Body::from("{}")).unwrap();
        let root = router(state.clone()).oneshot(req("/mcp")).await.unwrap();
        assert_eq!(root.status(), StatusCode::NOT_FOUND);
        for path in ["/mcp/schedule", "/mcp/git", "/mcp/help"] {
            let side = router(state.clone()).oneshot(req(path)).await.unwrap();
            assert_eq!(side.status(), StatusCode::UNAUTHORIZED, "{path}");
        }
    }

    use super::*;
    use axum::body::Body;
    fn request(token: &str, body: Body) -> Request {
        Request::builder().method("POST").uri("/mcp")
            .header("host", "127.0.0.1:4321").header("content-type", "application/json")
            .header("authorization", format!("Bearer {token}")).body(body).unwrap()
    }
    fn pending() -> Body {
        Body::from_stream(futures_util::stream::pending::<Result<String, std::io::Error>>())
    }
    /// A socket that sends nothing frees its slot after `IDLE_OPEN`, not after
    /// the 30 s a real request may take; one that has sent bytes keeps its slot
    /// for the full lifetime.
    #[tokio::test(start_paused = true)]
    async fn idle_sockets_free_their_slot_early() {
        use tokio::io::AsyncReadExt;
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let slots = Arc::new(tokio::sync::Semaphore::new(1));
        let mut bounded = BoundedListener { tcp: listener, slots: slots.clone() };
        let _client = tokio::net::TcpStream::connect(addr).await.unwrap();
        let (mut stream, _) = axum::serve::Listener::accept(&mut bounded).await;
        assert_eq!(slots.available_permits(), 0);
        let started = tokio::time::Instant::now();
        let mut buf = [0u8; 8];
        let err = stream.read(&mut buf).await.unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::TimedOut);
        let waited = started.elapsed();
        assert!(waited >= IDLE_OPEN && waited < SOCKET_LIFETIME, "{waited:?}");
        drop(stream);
        assert_eq!(slots.available_permits(), 1, "the slot is free again");
        // Bytes seen: the idle clock no longer applies, only the lifetime does.
        let mut client = tokio::net::TcpStream::connect(addr).await.unwrap();
        let (mut stream, _) = axum::serve::Listener::accept(&mut bounded).await;
        tokio::io::AsyncWriteExt::write_all(&mut client, b"POST").await.unwrap();
        let n = stream.read(&mut buf).await.unwrap();
        assert_eq!(&buf[..n], b"POST");
        let started = tokio::time::Instant::now();
        let err = stream.read(&mut buf).await.unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::TimedOut);
        assert!(started.elapsed() >= SOCKET_LIFETIME - IDLE_OPEN, "{:?}", started.elapsed());
    }

    /// A JSON-RPC batch is admitted (it is JSON) and refused as JSON-RPC by
    /// the handler, never with a bare 400.
    #[tokio::test]
    async fn a_batch_is_admitted_for_a_json_rpc_refusal() {
        let (token, session) = root_mcp::test_session(root_mcp::Caller::Agent);
        let (_, message, ..) = admit(request(&token, Body::from(r#"[{"jsonrpc":"2.0","id":1,"method":"ping"}]"#)), 4321, root_mcp::tokens()).await.unwrap();
        assert!(message.is_array());
        assert_eq!(admit(request(&token, Body::from("\"just a string\"")), 4321, root_mcp::tokens()).await.err(), Some(StatusCode::BAD_REQUEST));
        root_mcp::revoke_tab(&session.identity.tab);
    }

    #[tokio::test(start_paused = true)]
    async fn transport_rejects_before_reading_unauthorized_bodies_and_bounds_valid_uploads() {
        let (token, session) = root_mcp::test_session(root_mcp::Caller::Agent);
        assert_eq!(admit(request("invalid", pending()), 4321, root_mcp::tokens()).await.err(), Some(StatusCode::UNAUTHORIZED));
        let mut origin = request(&token, pending());
        origin.headers_mut().insert("origin", "null".parse().unwrap());
        assert_eq!(admit(origin, 4321, root_mcp::tokens()).await.err(), Some(StatusCode::FORBIDDEN));
        let mut host = request(&token, pending());
        host.headers_mut().insert("host", "attacker.invalid:4321".parse().unwrap());
        assert_eq!(admit(host, 4321, root_mcp::tokens()).await.err(), Some(StatusCode::FORBIDDEN));
        assert_eq!(admit(request(&token, pending()), 4321, root_mcp::tokens()).await.err(), Some(StatusCode::REQUEST_TIMEOUT));
        assert_eq!(admit(request(&token, Body::from("x".repeat(security::MAX_BODY + 1))), 4321, root_mcp::tokens()).await.err(), Some(StatusCode::PAYLOAD_TOO_LARGE));
        let body = || Body::from(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#);
        let first = admit(request(&token, body()), 4321, root_mcp::tokens()).await.unwrap();
        let second = admit(request(&token, body()), 4321, root_mcp::tokens()).await.unwrap();
        assert_eq!(admit(request(&token, body()), 4321, root_mcp::tokens()).await.err(), Some(StatusCode::TOO_MANY_REQUESTS));
        drop((first, second));
        root_mcp::revoke_tab(&session.identity.tab);
        assert_eq!(admit(request(&token, body()), 4321, root_mcp::tokens()).await.err(), Some(StatusCode::UNAUTHORIZED));
    }
}
