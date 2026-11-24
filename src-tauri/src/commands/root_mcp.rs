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
    routing::{get, post},
    Json, Router,
};
use app_core::sync::LockExt;
use serde::Serialize;
use serde_json::Value;

use crate::services::root_mcp::{self, Runtime, Stores};
use crate::storage;
use crate::services::root_mcp_security::{self as security, Access, Policy};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use std::pin::Pin;
use std::task::{Context, Poll};
use std::future::Future;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use app_core::CoreCtx;
use crate::tauri_host::Ctx;

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
/// The client end of one accepted connection, with what the listener found
/// out about it: each revived session's peer verdict
/// ([`root_mcp::root_mcp_reattach::peer_in_session`]), asked once per
/// connection rather than per request. A fresh one per connection
/// (`into_make_service_with_connect_info`).
#[derive(Clone, Debug)]
struct Peer {
    addr: std::net::SocketAddr,
    verdicts: Arc<std::sync::Mutex<std::collections::HashMap<String, PeerTree>>>,
}
use root_mcp::root_mcp_reattach::PeerTree;
impl axum::extract::connect_info::Connected<axum::serve::IncomingStream<'_, BoundedListener>> for Peer {
    fn connect_info(stream: axum::serve::IncomingStream<'_, BoundedListener>) -> Self {
        Peer { addr: *stream.remote_addr(), verdicts: Arc::default() }
    }
}

/// Where the connection `peer` stands to the revived session `id` (bound to
/// the mux session `session`); only [`PeerTree::Inside`] may use it: on Linux
/// only its own pane tree, and never without a known peer (`Unknown`).
/// Elsewhere a revived session is not checked (its git and tabs lanes were
/// never revived there).
async fn revived_peer(peer: Option<Peer>, port: u16, id: &str, session: &str) -> PeerTree {
    if !root_mcp::root_mcp_reattach::PEER_CHECK {
        return PeerTree::Inside;
    }
    let Some(peer) = peer else { return PeerTree::Unknown };
    if let Some(verdict) = peer.verdicts.lock_ok().get(id) {
        return *verdict;
    }
    let (addr, session) = (peer.addr, session.to_string());
    let verdict = tokio::task::spawn_blocking(move || root_mcp::root_mcp_reattach::peer_in_session(addr, port, &session))
        .await
        .unwrap_or(PeerTree::Unknown);
    peer.verdicts.lock_ok().insert(id.to_string(), verdict);
    verdict
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
/// re-granted, and the settings fold re-reads `root_mcp_security_status`.
/// No payload, except `{ "staleTab": "<PTY id>" }` when a running tab's
/// tools were found dead after its launch ([`Notice::TabStale`]): the
/// terminal's stale card (`stores/agents/mcpStale`) raises it.
pub const SESSIONS_EVENT: &str = "root-mcp-sessions-changed";

/// What a lane changed, for whoever shows it: the window turns it into its
/// Tauri event; the Mobile host pokes an open window over its control socket.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Notice {
    /// A schedule proposal was made or a row changed (`agent_tasks.json`).
    Schedules,
    /// A push or release proposal changed (`services::git_push_mcp`).
    GitPush,
    /// A markup ask or tick of a tab this process spawned opened, closed or
    /// went (`services::markup_mcp`): the window's markup views re-read.
    Markup,
    /// A committed self-rename: re-read this scope without changing focus.
    Workspace { scope: String, version: u64 },
    /// The running tab `tab` (its PTY id) was flagged stale after its launch
    /// ([`root_mcp::mark_tab_stale`]): a revived token of it was refused. The
    /// window rings [`SESSIONS_EVENT`] with `{ "staleTab": tab }`.
    TabStale { tab: String },
}
pub type NoticeSink = Arc<dyn Fn(Notice) + Send + Sync>;

#[derive(Clone)]
struct ServerState {
    /// The context of a process with no other listener to defer to — the
    /// window, or a server daemon (no window at all): the root and reader
    /// lanes' mail and events. `None` in a desktop's Mobile host, whose
    /// listener serves the schedule, push, help, web and markup lanes
    /// (`docs/headless_mcp_plan.md`) — `/mcp` is not even routed there. The
    /// markup lane needs no context: its views are the window's commands and
    /// the phone routes, which reach the host's store (phase 1b).
    ctx: Option<CoreCtx>,
    port: u16,
    /// The process's token store, the only one this listener accepts.
    store: &'static root_mcp::TokenStore,
    notify: NoticeSink,
}

static REQUESTS: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
/// The web lane's own global pool. A web call holds its permits for up to 15 s
/// of network I/O (the other lanes' calls are local and short), so on the
/// shared pool of 8 a handful of concurrent chats would starve root, schedule,
/// push, markup and help calls into `429`. A web token waits only here.
static WEB_REQUESTS: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
const REQUEST_SLOTS: usize = 8;
const WEB_REQUEST_SLOTS: usize = 8;

/// The global pool a caller's requests are counted in.
fn request_pool(caller: root_mcp::Caller) -> Arc<tokio::sync::Semaphore> {
    let (pool, slots) = if caller == root_mcp::Caller::Web { (&WEB_REQUESTS, WEB_REQUEST_SLOTS) } else { (&REQUESTS, REQUEST_SLOTS) };
    pool.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(slots))).clone()
}
/// How long a request may wait for a worker slot. With the 5 s upload and the
/// 15 s of work it stays inside a socket's 30 s lifetime.
const PERMIT_WAIT: Duration = Duration::from_secs(8);

type Admitted = (root_mcp::Session, Value, tokio::sync::OwnedSemaphorePermit, tokio::sync::OwnedSemaphorePermit);

/// [`admit_with`] with nobody told of a tab gone stale: the transport tests.
#[cfg(test)]
async fn admit(request: Request, port: u16, store: &root_mcp::TokenStore) -> Result<Admitted, StatusCode> {
    let quiet: NoticeSink = Arc::new(|_| {});
    admit_with(request, port, store, &quiet).await
}

/// Runs before body collection or JSON parsing. Kept independent of Tauri for
/// adversarial transport tests using real request bodies. `notify` hears of a
/// tab this admission flagged stale ([`Notice::TabStale`]).
async fn admit_with(request: Request, port: u16, store: &root_mcp::TokenStore, notify: &NoticeSink) -> Result<Admitted, StatusCode> {
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
    let bearer = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok());
    // A token of the previous run's session that a reattach may still revive
    // (`root_mcp_reattach`) is told to come back, not refused: a `401` can
    // send a CLI into a sign-in flow for a server that answers in a moment.
    let session = store.authenticate(bearer).ok_or_else(|| {
        if root_mcp::root_mcp_reattach::pending_bearer(bearer) { StatusCode::SERVICE_UNAVAILABLE } else { StatusCode::UNAUTHORIZED }
    })?;
    if !path_serves(request.uri().path(), session.identity.caller) { return Err(StatusCode::UNAUTHORIZED); }
    // A token revived from a previous run (`root_mcp_reattach`) answers only
    // its own session's processes: whoever squatted the port while the app
    // was down may hold it too. Freshly minted tokens are not checked.
    if let Some(revived_into) = session.revived.as_deref() {
        let peer = request.extensions().get::<axum::extract::ConnectInfo<Peer>>().map(|info| info.0.clone());
        let verdict = revived_peer(peer, port, &session.id, revived_into).await;
        if verdict != PeerTree::Inside {
            // Nobody could be seen holding the socket: most likely the tab's
            // own CLI made itself non-dumpable, and every call it makes is
            // refused. Its tools are dead, so the tab says so (the card and
            // Reconnect) instead of listing them as live.
            if root_mcp::root_mcp_reattach::refusal_marks_stale(verdict) && root_mcp::mark_tab_stale(&session.identity.tab) {
                eprintln!("[root-mcp] a revived token's client could not be identified (a non-dumpable process?): its tab now reads stale");
                notify(Notice::TabStale { tab: session.identity.tab.clone() });
            }
            return Err(StatusCode::UNAUTHORIZED);
        }
    }
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
        let global = request_pool(session.identity.caller).acquire_owned().await.ok()?;
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
        StatusCode::SERVICE_UNAVAILABLE => "revival_pending",
        // Authenticated by then: the session's own audit row is the record.
        _ => return None,
    })
}

async fn handle(State(state): State<ServerState>, request: Request) -> Response {
    let started = Instant::now();
    let (session, message, global, own) = match admit_with(request, state.port, state.store, &state.notify).await {
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
    // The project switched this session's lane off since it was granted
    // (`services::project_lanes`): read per request, so a running tab loses
    // the lane without a restart. Never a help session: its token holds no
    // project.
    if crate::services::project_lanes::refuses(&session.identity) {
        security::audit_reason(&audit_session, &tool, "denied", started.elapsed(), Some("project_off"));
        return StatusCode::FORBIDDEN.into_response();
    }
    if session.identity.caller == root_mcp::Caller::Web {
        // The assistant's web lane (`services::web_lane`): the guarded fetch
        // and the search, nothing else. This branch always returns, so a web
        // token never falls through to a registry below. The switch is read
        // per call and answered as a normal `off` result. Calls and refusals
        // are audited as session, tool and a fixed category only — never the
        // URL or the query (the audit ring takes neither) — but not the
        // handshake every new chat sends. The permits stay held across the
        // fetch; a tab that outlives its token is refused at `check`.
        if session.check().is_err() {
            security::audit_reason(&audit_session, &tool, "denied", started.elapsed(), Some("revoked"));
            return StatusCode::UNAUTHORIZED.into_response();
        }
        let reply = {
            let (_global, _own) = (global, own);
            crate::services::web_lane::handle_message(&session, &message).await
        };
        let reason = reply.as_ref().and_then(crate::services::web_lane::refusal_reason);
        if crate::services::web_lane::audited(&message, reason) {
            audit_lane(&audit_session, &tool, started, reason);
        }
        return lane_reply(reply);
    }
    if session.identity.caller == root_mcp::Caller::Cockpit {
        let outcome = app_core::rt::spawn_blocking(move || {
            let (_global, _own) = (global, own);
            let reply = crate::services::cockpit_mcp::handle_message(&session, &message);
            let patch = reply.as_ref().and_then(|reply| crate::services::cockpit_mcp::refresh_patch(&session, reply));
            let reason = reply.as_ref().and_then(crate::services::cockpit_mcp::refusal_reason);
            (reply, patch, reason, message["method"] == "tools/call")
        }).await;
        let Ok((reply, patch, reason, audited)) = outcome else { return StatusCode::INTERNAL_SERVER_ERROR.into_response() };
        if audited {
            audit_lane(&audit_session, &tool, started, reason);
        }
        if let Some((scope, version)) = patch { (state.notify)(Notice::Workspace { scope, version }); }
        return lane_reply(reply);
    }
    if session.identity.caller == root_mcp::Caller::Helper {
        // The help identity (`services::help_mcp`): the compiled-in corpus and
        // nothing else. The switch is read per request, like the root one, so
        // "off" refuses tabs that already hold a token. Help calls are not
        // written to the audit ring: every agent tab may ask, and 500 rows of
        // doc lookups must not push the root tools' records out. Admission
        // failures above are still recorded.
        if !root_mcp::help_enabled_in(&storage::settings_path()) || session.check().is_err() {
            return StatusCode::FORBIDDEN.into_response();
        }
        let reply = app_core::rt::spawn_blocking(move || {
            let (_global, _own) = (global, own);
            crate::services::help_mcp::handle_message(&session, &message)
        }).await;
        return match reply {
            Ok(reply) => lane_reply(reply),
            Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        };
    }
    if session.identity.caller == root_mcp::Caller::Marker {
        // The markup lane (`services::markup_mcp`): the switch is read per
        // call and answered as a normal `off` result, so the agent can tell
        // the user where to turn it on. Tool calls and refusals are audited
        // like push — session, tool and a fixed category, never the text —
        // but not the handshake every new tab sends (`markup_mcp::audited`).
        if session.check().is_err() {
            security::audit_reason(&session, &tool, "denied", started.elapsed(), Some("revoked"));
            return StatusCode::UNAUTHORIZED.into_response();
        }
        let outcome = app_core::rt::spawn_blocking(move || {
            let (_global, _own) = (global, own);
            let reply = crate::services::markup_mcp::handle_message(&session, &message);
            let reason = reply.as_ref().and_then(crate::services::markup_mcp::refusal_reason);
            (reply, reason, crate::services::markup_mcp::audited(&message, reason))
        }).await;
        let Ok((reply, reason, audited)) = outcome else { return StatusCode::INTERNAL_SERVER_ERROR.into_response() };
        if audited {
            audit_lane(&audit_session, &tool, started, reason);
        }
        return lane_reply(reply);
    }
    if session.identity.caller == root_mcp::Caller::Printer {
        // The print lane (`services::print_mcp`): as markup — the switch is
        // read per call and answered as a normal `off` result; tool calls and
        // refusals are audited by session, tool and fixed category, never the
        // file or the note.
        if session.check().is_err() {
            security::audit_reason(&session, &tool, "denied", started.elapsed(), Some("revoked"));
            return StatusCode::UNAUTHORIZED.into_response();
        }
        let outcome = app_core::rt::spawn_blocking(move || {
            let (_global, _own) = (global, own);
            let reply = crate::services::print_mcp::handle_message(&session, &message);
            let reason = reply.as_ref().and_then(crate::services::print_mcp::refusal_reason);
            (reply, reason, crate::services::print_mcp::audited(&message, reason))
        }).await;
        let Ok((reply, reason, audited)) = outcome else { return StatusCode::INTERNAL_SERVER_ERROR.into_response() };
        if audited {
            audit_lane(&audit_session, &tool, started, reason);
        }
        return lane_reply(reply);
    }
    if session.identity.caller == root_mcp::Caller::Tabs {
        // The tab messages lane (`services::tabs_mcp`): as print — the switch
        // is read per call and answered as a normal `off` result; tool calls
        // and refusals are audited by session, tool and fixed category, never
        // the text, a label or a handle.
        if session.check().is_err() {
            security::audit_reason(&session, &tool, "denied", started.elapsed(), Some("revoked"));
            return StatusCode::UNAUTHORIZED.into_response();
        }
        let outcome = app_core::rt::spawn_blocking(move || {
            let (_global, _own) = (global, own);
            let reply = crate::services::tabs_mcp::handle_message(&session, &message);
            let reason = reply.as_ref().and_then(crate::services::tabs_mcp::refusal_reason);
            (reply, reason, crate::services::tabs_mcp::audited(&message, reason))
        }).await;
        let Ok((reply, reason, audited)) = outcome else { return StatusCode::INTERNAL_SERVER_ERROR.into_response() };
        if audited {
            audit_lane(&audit_session, &tool, started, reason);
        }
        return lane_reply(reply);
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
        let outcome = app_core::rt::spawn_blocking(move || {
            let (_global, _own) = (global, own);
            crate::services::schedule_mcp::handle_admitted(&session, &message, reset, admission)
        }).await;
        let Ok((reply, changed)) = outcome else { return StatusCode::INTERNAL_SERVER_ERROR.into_response() };
        let failed = reply.as_ref().is_some_and(|r| r.get("error").is_some() || r["result"]["isError"] == true);
        security::audit_reason(&audit_session, &tool, if failed { "refused" } else { "allowed" }, started.elapsed(), reply.as_ref().and_then(crate::services::schedule_mcp::refusal_reason));
        if changed { (state.notify)(Notice::Schedules); }
        return lane_reply(reply);
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
        let outcome = app_core::rt::spawn_blocking(move || {
            let (_global, _own) = (global, own);
            crate::services::git_push_mcp::handle_message(&session, &message)
        }).await;
        let Ok((reply, changed)) = outcome else { return StatusCode::INTERNAL_SERVER_ERROR.into_response() };
        let reason = reply.as_ref().and_then(crate::services::git_push_mcp::refusal_reason);
        let failed = reason.is_some() || reply.as_ref().is_some_and(|r| r.get("error").is_some() || r["result"]["isError"] == true);
        security::audit_reason(&audit_session, &tool, if failed { "refused" } else { "allowed" }, started.elapsed(), reason);
        if changed { (state.notify)(Notice::GitPush); }
        return lane_reply(reply);
    }
    // The root lane is served where its mail, review and session controls
    // live: the window, or a server daemon (its browser client). A desktop's
    // Mobile host does not route `/mcp` and holds no root, local-model or
    // reader token, so this is a second wall, not the first.
    let Some(ctx) = state.ctx.clone() else {
        security::audit_reason(&session, &tool, "denied", started.elapsed(), Some("window_required"));
        return StatusCode::FORBIDDEN.into_response();
    };
    let mail = ctx
        .state
        .try_get::<crate::commands::mail::MailState>()
        .map(|s| crate::commands::mail::AgentMail(s.clone()));
    let outcome = app_core::rt::spawn_blocking(move || {
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
    let reason = reply.as_ref().and_then(root_mcp::refusal_reason);
    audit_lane(&audit_session, &tool, started, reason);
    // One event per row: a board move can reindex a whole column.
    for change in effects.changes {
        ctx.emit(CHANGED_EVENT, change);
    }
    if security::tool(&tool).is_some_and(|t| t.write) {
        ctx.emit("root-mcp-review-changed",
            crate::services::root_mcp_review::pending_count(&storage::state_dir()));
    }
    lane_reply(reply)
}

/// A lane's JSON-RPC reply, or `202 Accepted` with no body for a notification.
fn lane_reply(reply: Option<Value>) -> Response {
    match reply {
        Some(reply) => Json(reply).into_response(),
        None => StatusCode::ACCEPTED.into_response(),
    }
}

/// One served request in the audit ring: `refused` under its fixed `reason`,
/// `allowed` without one.
fn audit_lane(session: &root_mcp::Session, tool: &str, started: Instant, reason: Option<&'static str>) {
    security::audit_reason(session, tool, if reason.is_some() { "refused" } else { "allowed" }, started.elapsed(), reason);
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

/// `GET /mcp/grant/<hash>`: `204` when this listener's store holds the session
/// whose id (SHA-256 of its token) is `hash` and it is not revoked, `404`
/// otherwise. Unauthenticated by design: the asker is a launch that holds no
/// token, only the hash a tmux session was stamped with. It answers nothing
/// but that bit, about a value an asker cannot guess. A browser's request (an
/// `Origin`), a Host that is not this listener's loopback address (DNS
/// rebinding) and a path that is not a hash are all refused alike.
async fn grant_held(
    State(state): State<ServerState>,
    axum::extract::Path(hash): axum::extract::Path<String>,
    headers: axum::http::HeaderMap,
) -> StatusCode {
    if headers.contains_key(header::ORIGIN) { return StatusCode::FORBIDDEN; }
    let local = format!("127.0.0.1:{}", state.port);
    let host_ok = headers.get_all(header::HOST).iter().count() == 1
        && headers.get(header::HOST).and_then(|v| v.to_str().ok()).is_some_and(|h| h == local);
    if !host_ok { return StatusCode::FORBIDDEN; }
    let hash_shaped = hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if hash_shaped && state.store.holds_session(&hash) { StatusCode::NO_CONTENT } else { StatusCode::NOT_FOUND }
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
static SERVER: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>> = std::sync::Mutex::new(None);

/// `RunEvent::Exit`: stop accepting, give the workers in flight a short bounded
/// drain, and remove every per-tab copy — nothing of the endpoint outlives a
/// clean quit. Idempotent; a no-op when the listener never started.
pub fn stop_for_exit() {
    SHUTDOWN.notify_waiters();
    SHUTDOWN.notify_one();
    let handle = SERVER.lock_ok().take();
    if let Some(handle) = handle {
        app_core::rt::block_on(async {
            let _ = tokio::time::timeout(Duration::from_secs(2), handle).await;
        });
    }
    crate::services::root_mcp_review::sweep_sandboxes(&storage::state_dir());
    // The quit ends every session the app made (`kill_app_sessions`): no
    // agent is left to revive, so its token hashes leave the disk too.
    root_mcp::root_mcp_reattach::on_clean_quit();
}

pub fn start(ctx: CoreCtx) {
    // The tabs the Mobile host spawns keep their markup asks in its memory;
    // the window's markup commands read them over its admin socket.
    crate::commands::markup_mcp::use_host_peer(crate::services::mobile_control::config::admin_socket(&storage::state_dir()));
    let notify = serve_everything(&ctx, Arc::new(|_| {}));
    // Bound here, synchronously, and the runtime published with it: a tab
    // restored a moment later finds the listener and gets its lanes, and its
    // URLs name the port of the last run again (`bind_window`).
    let bound = match bind_window() {
        Ok(bound) => bound,
        Err(error) => {
            eprintln!("[root-mcp] {error}");
            return;
        }
    };
    let served = serve(bound.listener, Some(ctx), true, notify, async { SHUTDOWN.notified().await });
    // The reattach record, opened before any tab is restored: revival needs
    // the remembered port bound on the first try (`root_mcp_reattach`).
    if let Ok((port, _)) = served.as_ref() {
        open_reattach_record(&storage::state_dir(), reattach::Role::Window, *port, bound.first_try, bound.lost);
    }
    let handle = app_core::rt::spawn(async move {
        match served {
            Ok((_, server)) => {
                let heartbeat = tokio::spawn(reattach_heartbeat());
                server.await;
                heartbeat.abort();
            }
            Err(error) => eprintln!("[root-mcp] {error}"),
        }
    });
    *SERVER.lock_ok() = Some(handle);
}

use crate::services::root_mcp::root_mcp_reattach as reattach;

/// Open and install this process's reattach record for the listener just
/// published on `port` (its nonce is the runtime's).
fn open_reattach_record(state: &std::path::Path, role: reattach::Role, port: u16, first_try: bool, lost: Option<u16>) {
    let Some(runtime) = root_mcp::runtime().filter(|r| r.port == port) else { return };
    reattach::install(reattach::Listener::open(
        role.record(state),
        port,
        runtime.generation.clone(),
        first_try,
        lost,
        reattach::now_secs(),
    ));
}

/// The record's `last_alive`, every [`reattach::HEARTBEAT`] while the
/// listener serves; the first beat (at once) drops the rows of sessions that
/// ended while the app was down.
async fn reattach_heartbeat() {
    let mut beat = tokio::time::interval(reattach::HEARTBEAT);
    loop {
        beat.tick().await;
        let _ = tokio::task::spawn_blocking(reattach::heartbeat_now).await;
    }
}

/// Where the window's port is remembered (not a secret): `<state_dir>/root_mcp/port`.
/// An agent that outlives a crash in its tmux session keeps this port in its
/// MCP URLs, so binding it again keeps them pointing at this program rather
/// than at whatever took the port meanwhile. The tokens are not remembered
/// (`docs/done/mcp_reattach_plan.md`): such an agent's tools stay refused until it
/// is reconnected.
fn port_file() -> std::path::PathBuf {
    storage::state_dir().join("root_mcp").join("port")
}

/// The window's port of an earlier run.
fn remembered_port() -> Option<u16> {
    std::fs::read_to_string(port_file()).ok().and_then(|s| s.trim().parse::<u16>().ok()).filter(|p| *p != 0)
}

/// A loopback listener on `preferred` when it can be bound, else on any free
/// port other than `avoid` ([`bind_avoiding`]). Whether the preferred port
/// was the one bound.
fn bind_preferred(preferred: Option<u16>, avoid: Option<u16>) -> std::io::Result<(std::net::TcpListener, bool)> {
    let kept = preferred
        .and_then(|p| std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, p)).ok());
    let was_kept = kept.is_some();
    let listener = match kept {
        Some(listener) => listener,
        None => bind_avoiding(|| std::net::TcpListener::bind(LOOPBACK), avoid)?,
    };
    listener.set_nonblocking(true)?;
    Ok((listener, was_kept))
}

/// A listener bound for the window or the Mobile host, and what the reattach
/// record needs to know of the bind.
struct Bound {
    listener: std::net::TcpListener,
    /// The remembered port was bound on the first try: only then can a
    /// running agent's lanes be revived (`root_mcp_reattach`).
    first_try: bool,
    /// The remembered port, when someone else held it.
    lost: Option<u16>,
}

/// The window's listener: its remembered port when free. When someone else
/// holds it the holder is looked up and said (gap 50b's lesson: a stale agent's
/// requests go to whoever holds its port), and the new port is remembered.
/// The fallback avoids the Mobile host's remembered port.
fn bind_window() -> Result<Bound, String> {
    let preferred = remembered_port();
    let (listener, kept) = bind_preferred(preferred, read_port(&host_port_file(&storage::state_dir())))
        .map_err(|e| format!("bind failed: {e}"))?;
    let port = listener.local_addr().map_err(|e| format!("bind failed: {e}"))?.port();
    if !kept {
        if let Some(taken) = preferred {
            report_taken_port(taken, port);
        }
        let file = port_file();
        if let Err(error) = storage::write_private_atomic_mode(&file, port.to_string().as_bytes(), 0o600) {
            eprintln!("[root-mcp] could not remember port {port}: {error}");
        }
    }
    Ok(Bound { listener, first_try: kept, lost: preferred.filter(|_| !kept) })
}

/// Where the Mobile host's port is remembered: `<state>/root_mcp/host-port`
/// (fixed decision 7). Never the window's: see [`bind_host`].
fn host_port_file(state: &std::path::Path) -> std::path::PathBuf {
    state.join("root_mcp").join("host-port")
}

fn read_port(file: &std::path::Path) -> Option<u16> {
    std::fs::read_to_string(file).ok().and_then(|s| s.trim().parse::<u16>().ok()).filter(|p| *p != 0)
}

/// The Mobile host's listener on `addr`, or for a free-port `addr` its own
/// remembered port first (`host-port` under `state`) — never the window's
/// remembered one, which a free-port bind avoids too ([`bind`]). The new
/// port is remembered when it changed.
fn bind_host(addr: std::net::SocketAddr, state: &std::path::Path) -> Result<Bound, String> {
    let window = remembered_port();
    let file = host_port_file(state);
    let preferred = read_port(&file).filter(|p| addr.port() == 0 && Some(*p) != window);
    let kept = preferred.and_then(|p| {
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, p)).ok()?;
        listener.set_nonblocking(true).ok()?;
        Some(listener)
    });
    let first_try = kept.is_some();
    let listener = match kept {
        Some(listener) => listener,
        None => bind(addr)?,
    };
    let port = listener.local_addr().map_err(|e| format!("bind failed: {e}"))?.port();
    if !first_try && addr.port() == 0 {
        if let Err(error) = storage::write_private_atomic_mode(&file, port.to_string().as_bytes(), 0o600) {
            eprintln!("[root-mcp] could not remember the host's port {port}: {error}");
        }
    }
    Ok(Bound { listener, first_try, lost: preferred.filter(|_| !first_try) })
}

/// The remembered port is held by another listener: say who, once.
fn report_taken_port(taken: u16, now: u16) {
    #[cfg(unix)]
    // SAFETY: getuid has no preconditions.
    let own = unsafe { libc::getuid() };
    #[cfg(not(unix))]
    let own = u32::MAX;
    let occupants = crate::services::loopback_owner::occupants(taken);
    match crate::services::api_proxy_port::classify(&occupants, own) {
        Some(holder) => eprintln!("[root-mcp] port {taken} is held by {holder:?}; serving on {now}"),
        None => eprintln!("[root-mcp] port {taken} is held by another instance of this program; serving on {now}"),
    }
}

/// What a listener that serves every lane sets up first — the window's, and
/// a server daemon's ([`start_headless`] with a context): the review copies
/// a crash left behind are swept (no tab of this process holds a token yet,
/// so every one goes; they are rebuilt from the log on the next call), push
/// proposals and markup asks ring their events through `ctx` (the services
/// stay AppHandle-free), and `notify` — a caller's own sink, called first —
/// is wrapped to ring the schedule and push events too.
/// [`SESSIONS_EVENT`]'s payload for a tab flagged stale ([`Notice::TabStale`]).
fn stale_payload(tab: &str) -> Value {
    serde_json::json!({ "staleTab": tab })
}

fn serve_everything(ctx: &CoreCtx, notify: NoticeSink) -> NoticeSink {
    crate::services::root_mcp_review::sweep_sandboxes(&storage::state_dir());
    let push_events = ctx.clone();
    crate::services::git_push_mcp::set_change_hook(Box::new(move || {
        push_events.emit(crate::services::git_push_mcp::CHANGED_EVENT, ());
    }));
    crate::commands::markup_mcp::install_change_hook(ctx);
    #[cfg(feature = "desktop")]
    crate::commands::print_mcp::install_change_hook(ctx);
    #[cfg(feature = "desktop")]
    crate::commands::tabs_mcp::install_change_hook(ctx);
    let events = ctx.clone();
    Arc::new(move |notice| {
        notify(notice.clone());
        match notice {
            Notice::Schedules => events.emit("agent-schedules-changed", ()),
            Notice::GitPush => events.emit(crate::services::git_push_mcp::CHANGED_EVENT, ()),
            // The markup hook installed above rings its own event.
            Notice::Markup => {}
            Notice::Workspace { scope, version } => events.emit(crate::commands::projects::WORKSPACE_PATCH_EVENT,
                serde_json::json!({ "scope": scope, "version": version, "ops": [] })),
            Notice::TabStale { tab } => events.emit(SESSIONS_EVENT, stale_payload(&tab)),
        };
    })
}

/// The Mobile host's listener (`docs/headless_mcp_plan.md`): the schedule,
/// push, help, web and markup lanes for the tabs it spawns with no window
/// open, on its own loopback port and token store. `server` is the host's
/// context when it is a server daemon: there is no window to defer to, so the
/// listener serves every lane the window would — root and reader too — and
/// rings their events to the browser clients ([`serve_everything`]). A
/// desktop's Mobile host passes `None` and never serves those: a second root
/// listener would sweep the window's review copies. Its markup asks stay in
/// its own memory and reach an open window through `notify` ([`Notice::Markup`])
/// and the window's reads of its admin socket. Bound before this
/// returns, so a spawn after it is wired; the server runs until `shutdown`
/// turns true. When the first bind fails, the error is returned (for the
/// journal) and a task keeps retrying with [`bind_retry_delay`] until a bind
/// succeeds or the host shuts down — tabs spawned meanwhile go without tools.
pub async fn start_headless(
    notify: NoticeSink,
    server: Option<&CoreCtx>,
    shutdown: tokio::sync::watch::Receiver<bool>,
) -> Result<u16, String> {
    let notify = match server {
        Some(ctx) => serve_everything(ctx, notify),
        None => {
            markup_mcp_changes(notify.clone());
            notify
        }
    };
    // The host's own remembered port and reattach record live in the state
    // dir; a test of the host never touches the developer's.
    let memory = (!cfg!(test)).then(storage::state_dir);
    start_headless_on(LOOPBACK, notify, server.cloned(), shutdown, memory).await
}

/// A desktop's Mobile host: whenever one of its tabs' asks or ticks changes,
/// say so to `notify` (which pokes an open window).
fn markup_mcp_changes(notify: NoticeSink) {
    crate::services::markup_mcp::set_change_hook(markup_notice_hook(notify));
}

fn markup_notice_hook(notify: NoticeSink) -> Box<dyn Fn() + Send + Sync> {
    Box::new(move || notify(Notice::Markup))
}

/// Any free loopback port.
const LOOPBACK: std::net::SocketAddr = std::net::SocketAddr::new(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST), 0);

/// [`start_headless`] on a chosen address (a test occupies one). `memory`:
/// the state dir the host remembers its port and keeps its reattach record
/// in (`host-port`, `reattach-host.json`); `None` remembers nothing.
async fn start_headless_on(
    addr: std::net::SocketAddr,
    notify: NoticeSink,
    ctx: Option<CoreCtx>,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
    memory: Option<std::path::PathBuf>,
) -> Result<u16, String> {
    let bound = match memory.as_deref() {
        Some(state) => bind_host(addr, state),
        None => bind(addr).map(|listener| Bound { listener, first_try: false, lost: None }),
    };
    let (first_try, lost) = bound.as_ref().map_or((false, None), |b| (b.first_try, b.lost));
    let first = match bound {
        Ok(bound) => serve(bound.listener, ctx.clone(), ctx.is_none(), notify.clone(), until_true(shutdown.clone())),
        Err(error) => Err(error),
    };
    // Its own record (fixed decision 7): a retried bind below is never a
    // first try, and opening it then purges the file.
    match first {
        Ok((port, server)) => {
            if let Some(state) = memory.as_deref() {
                open_reattach_record(state, reattach::Role::Host, port, first_try, lost);
            }
            let heartbeat = memory.is_some().then(|| tokio::spawn(reattach_heartbeat()));
            tokio::spawn(async move {
                server.await;
                if let Some(heartbeat) = heartbeat {
                    heartbeat.abort();
                }
            });
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
                    let Ok(listener) = bind(addr) else { continue };
                    if let Ok((port, server)) = serve(listener, ctx.clone(), ctx.is_none(), notify.clone(), until_true(shutdown.clone())) {
                        eprintln!("[root-mcp] bound on port {port} after {attempt} retries");
                        if let Some(state) = memory.as_deref() {
                            open_reattach_record(state, reattach::Role::Host, port, false, None);
                        }
                        let heartbeat = memory.is_some().then(|| tokio::spawn(reattach_heartbeat()));
                        server.await;
                        if let Some(heartbeat) = heartbeat {
                            heartbeat.abort();
                        }
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

/// The routes a listener answers: the schedule, push, help, web and markup
/// lanes everywhere, the root (and reader) lane where this process serves the
/// mail and controls it needs — the window, or a server daemon, which has no
/// window ([`ServerState::ctx`]).
fn router(state: ServerState) -> Router {
    let mut router = Router::new()
        .route("/mcp/schedule", post(handle))
        .route("/mcp/git", post(handle))
        .route("/mcp/help", post(handle))
        .route("/mcp/cockpit", post(handle))
        // The assistant's web lane is served by every listener, the window's
        // and the Mobile host's: a phone chat runs with no window.
        .route("/mcp/web", post(handle));
    // The markup lane holds its asks in this process's memory and needs no
    // context: its views are the window's commands (which read the Mobile
    // host's store over the admin socket) and the phone's routes.
    router = router.route("/mcp/markup", post(handle));
    // The print lane: only the window grants its tokens
    // (`Runtime::serves_print`), so elsewhere the route authenticates nobody.
    router = router.route("/mcp/print", post(handle));
    // The tab messages lane: only the window grants its tokens
    // (`Runtime::serves_tabs`), so elsewhere the route authenticates nobody.
    router = router.route("/mcp/tabs", post(handle));
    // The one unauthenticated route: whether this listener holds a grant, for
    // the launch that finds a session another process stamped
    // (`root_mcp_mark::probe_grant`).
    router = router.route("/mcp/grant/{hash}", get(grant_held));
    if state.ctx.is_some() {
        router = router.route("/mcp", post(handle));
    }
    router.layer(axum::middleware::map_response(close_connection)).with_state(state)
}

/// A non-blocking std listener on `addr`. The Mobile host's own port is never
/// the one the window remembers ([`bind_avoiding`]): a free-port bind is asked
/// again until it lands elsewhere.
fn bind(addr: std::net::SocketAddr) -> Result<std::net::TcpListener, String> {
    let avoid = remembered_port().filter(|_| addr.port() == 0);
    bind_avoiding(|| {
        let listener = std::net::TcpListener::bind(addr)?;
        listener.set_nonblocking(true)?;
        Ok(listener)
    }, avoid)
    .map_err(|e| format!("bind failed: {e}"))
}

/// The listener `bind` yields, asked again while it lands on `avoid`: the
/// window's remembered port, which a Mobile host that came up first would
/// otherwise take from the window (and from the agents that still name it).
/// Each rejected listener is held until the end, so the next ask cannot get the
/// same port again.
fn bind_avoiding(
    mut bind: impl FnMut() -> std::io::Result<std::net::TcpListener>,
    avoid: Option<u16>,
) -> std::io::Result<std::net::TcpListener> {
    let mut rejected = Vec::new();
    for _ in 0..16 {
        let listener = bind()?;
        if avoid != Some(listener.local_addr()?.port()) {
            return Ok(listener);
        }
        rejected.push(listener);
    }
    Err(std::io::Error::new(std::io::ErrorKind::AddrInUse, "no free port other than the window's remembered one"))
}

/// Publish a bound listener as this process's [`Runtime`] and hand back its
/// port and the server, which stops on `shutdown`. `serves_web`: this process
/// grants the assistant's web lane to the tabs it spawns — the window and a
/// desktop's Mobile host, never a server daemon (the assistant is not offered
/// on a hosted server in v1).
fn serve(
    listener: std::net::TcpListener,
    ctx: Option<CoreCtx>,
    serves_web: bool,
    notify: NoticeSink,
    shutdown: impl std::future::Future<Output = ()> + Send + 'static,
) -> Result<(u16, impl std::future::Future<Output = ()> + Send), String> {
    let port = listener.local_addr().map_err(|e| format!("bind failed: {e}"))?.port();
    let serves = ctx.is_some();
    root_mcp::set_runtime(Runtime {
        port, serves_root: serves, serves_markup: true, serves_web,
        generation: root_mcp::root_mcp_mark::new_nonce(),
    });
    let router = router(ServerState { ctx, port, store: root_mcp::tokens(), notify });
    Ok((port, async move {
        // The std listener was bound synchronously (so the runtime above is
        // published before any tab spawns); the reactor takes it over here.
        let tcp = match tokio::net::TcpListener::from_std(listener) {
            Ok(tcp) => tcp,
            Err(error) => {
                eprintln!("[root-mcp] listener: {error}");
                return;
            }
        };
        let listener = BoundedListener { tcp, slots: Arc::new(tokio::sync::Semaphore::new(SOCKETS)) };
        let service = router.into_make_service_with_connect_info::<Peer>();
        if let Err(error) = axum::serve(listener, service).with_graceful_shutdown(shutdown).await {
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
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn root_mcp_status() -> RootMcpStatus {
    let settings = storage::settings_path();
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
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn help_search(query: String, limit: Option<usize>) -> Result<Vec<crate::services::help_mcp::Hit>, String> {
    app_core::rt::blocking("root console", move || {
        let query: String = query.chars().take(crate::services::help_mcp::MAX_QUERY_BYTES).collect();
        crate::services::help_mcp::index().search(&query, limit.unwrap_or(crate::services::help_mcp::DEFAULT_RESULTS))
    }).await
}
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn help_read(topic_id: String, section: Option<String>) -> Result<crate::services::help_mcp::Read, String> {
    app_core::rt::try_blocking("root console", move || crate::services::help_mcp::index().read(&topic_id, section.as_deref()))
        .await
}
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn help_topics() -> Result<Vec<crate::services::help_mcp::TopicRef>, String> {
    app_core::rt::blocking("root console", || crate::services::help_mcp::index().list()).await
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
fn emit_review(ctx: &CoreCtx, changes: Vec<root_mcp::Change>) {
    for change in changes {
        ctx.emit(CHANGED_EVENT, change);
    }
    ctx.emit(
        "root-mcp-review-changed",
        crate::services::root_mcp_review::pending_count(&storage::state_dir()),
    );
}
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn root_mcp_review_list(
    ctx: Ctx,
) -> Result<Vec<crate::services::root_mcp_review::ReviewEntry>, String> {
    let (entries, before) = app_core::rt::try_blocking("root console", || {
        let before = crate::services::root_mcp_review::pending_count(&storage::state_dir());
        review_stores(crate::services::root_mcp_review::list).map(|entries| (entries, before))
    })
    .await?;
    let count = entries
        .iter()
        .filter(|p| p.proposal.status == "pending")
        .count();
    if count != before {
        ctx.emit("root-mcp-review-changed", count);
    }
    Ok(entries)
}
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn root_mcp_review_apply(
    ctx: Ctx,
    id: String,
    digest: String,
) -> Result<(), String> {
    let result = app_core::rt::blocking("root console", move || {
        review_stores(|s| crate::services::root_mcp_review::decide(s, &id, &digest, "apply"))
    })
    .await?;
    emit_review(&ctx, result?);
    Ok(())
}
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn root_mcp_review_reject(
    ctx: Ctx,
    id: String,
    digest: String,
) -> Result<(), String> {
    let result = app_core::rt::blocking("root console", move || {
        review_stores(|s| crate::services::root_mcp_review::decide(s, &id, &digest, "reject"))
    })
    .await?;
    emit_review(&ctx, result?);
    Ok(())
}
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn root_mcp_review_undo(
    ctx: Ctx,
    id: String,
    digest: String,
) -> Result<(), String> {
    let result = app_core::rt::blocking("root console", move || {
        review_stores(|s| crate::services::root_mcp_review::decide(s, &id, &digest, "undo"))
    })
    .await?;
    emit_review(&ctx, result?);
    Ok(())
}
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn root_mcp_review_apply_all(
    ctx: Ctx,
    approvals: Vec<crate::services::root_mcp_review::Approval>,
) -> Result<(), String> {
    let result = app_core::rt::blocking("root console", move || {
        review_stores(|s| crate::services::root_mcp_review::apply_all(s, &approvals))
    })
    .await?;
    emit_review(&ctx, result?);
    Ok(())
}

/// The `.ics` files root agents staged (`services::root_mcp_import`), text and
/// all: the window's parser reads them, and its importer runs on the user's ✓.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn root_mcp_import_list() -> Result<Vec<crate::services::root_mcp_import::StagedImport>, String> {
    app_core::rt::blocking("root console", || crate::services::root_mcp_import::list(&storage::state_dir()))
        .await
}
/// Imported or discarded: the staged copy goes either way.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn root_mcp_import_remove(ctx: Ctx, id: String) -> Result<(), String> {
    app_core::rt::try_blocking("root console", move || crate::services::root_mcp_import::remove(&storage::state_dir(), &id))
        .await?;
    emit_review(&ctx, Vec::new());
    Ok(())
}

#[derive(Serialize)]
pub struct SecurityStatus {
    sessions: Vec<root_mcp::SessionInfo>,
    audit: Vec<security::Audit>,
}
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn root_mcp_security_status() -> SecurityStatus {
    SecurityStatus { sessions: root_mcp::sessions(), audit: security::audit_rows() }
}
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn root_mcp_session_access(ctx: Ctx, id: String, access: Access) -> Result<(), String> {
    app_core::rt::try_blocking("root console", move || root_mcp::set_access(&id, access)).await?;
    ctx.emit(SESSIONS_EVENT, ());
    Ok(())
}
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn root_mcp_session_revoke(ctx: Ctx, id: String, remove_proposals: Option<bool>) -> Result<(), String> {
    // Invalidate first, before waiting on the review lock to clean the sandbox.
    let tab = root_mcp::revoke_session(&id)?;
    app_core::rt::try_blocking("root console", move || {
        crate::services::root_mcp_review::cleanup_tab(&storage::state_dir(), &tab);
        crate::services::agent_tasks::drain_mutations();
        if remove_proposals == Some(true) { crate::services::schedule_mcp::remove_proposals(&id)?; }
        // A push proposal is useless without the session that made it.
        if crate::services::git_push_mcp::remove_for_session(&id) { ctx.emit(crate::services::git_push_mcp::CHANGED_EVENT, ()); }
        // A markup question dies with its session (the sweep rings its event).
        crate::services::markup_mcp::sweep();
        ctx.emit("agent-schedules-changed", ());
        ctx.emit(SESSIONS_EVENT, ());
        Ok(())
    }).await
}

/// The push proposals of one project (the git bar's and the Agents view's
/// card), pruned of expired and orphaned ones. Pending cards the remote
/// already holds are settled by a background `ls-remote` the call starts
/// (gap 89): this is the only place that asks the remote about them.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn git_push_mcp_proposals(project_id: String) -> Result<Vec<crate::services::git_push_mcp::Proposal>, String> {
    app_core::rt::blocking("root console", move || {
        // The remote is asked about pending cards on a thread of its own (the
        // answer reaches the window as a change event), never from here.
        crate::services::git_push_mcp::settle_in_background(&project_id);
        crate::services::git_push_mcp::proposals_for(Some(&project_id), None)
    })
    .await
}
/// Push (approve) or dismiss a pending proposal. Approval re-checks the
/// bound SHA and the remote, confirms a first URL, then pushes; the reply is
/// the proposal in its final state.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn git_push_mcp_decide(ctx: Ctx, id: String, approve: bool) -> Result<crate::services::git_push_mcp::Proposal, String> {
    let result = app_core::rt::blocking("root console", move || crate::services::git_push_mcp::decide(&id, approve)).await?;
    ctx.emit(crate::services::git_push_mcp::CHANGED_EVENT, ());
    result
}
/// Close a finished (pushed, failed, dismissed, expired) proposal's card.
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn git_push_mcp_clear(ctx: Ctx, id: String) -> Result<crate::services::git_push_mcp::Proposal, String> {
    let result = crate::services::git_push_mcp::clear(&id);
    ctx.emit(crate::services::git_push_mcp::CHANGED_EVENT, ());
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
        // A positive list: only the classes that read the root registry are
        // named, so a class added later (the web lane was the fifth) defaults
        // to refused here instead of being served the root tools.
        "/mcp" => matches!(caller, root_mcp::Caller::Agent | root_mcp::Caller::LocalModel | root_mcp::Caller::Reader),
        "/mcp/schedule" => caller == root_mcp::Caller::Scheduler,
        "/mcp/git" => caller == root_mcp::Caller::Pusher,
        "/mcp/help" => caller == root_mcp::Caller::Helper,
        "/mcp/cockpit" => caller == root_mcp::Caller::Cockpit,
        "/mcp/markup" => caller == root_mcp::Caller::Marker,
        "/mcp/print" => caller == root_mcp::Caller::Printer,
        "/mcp/tabs" => caller == root_mcp::Caller::Tabs,
        "/mcp/web" => caller == root_mcp::Caller::Web,
        _ => false,
    }
}

#[cfg(test)]
mod security_tests {
    #[tokio::test]
    async fn cockpit_route_is_an_exclusive_lane() {
        use super::*;
        let (token, _) = root_mcp::test_session(root_mcp::Caller::Cockpit);
        assert!(admission(root_mcp::tokens(), "/mcp/cockpit", &token).await.is_ok());
        for path in ["/mcp", "/mcp/help", "/mcp/markup", "/mcp/schedule", "/mcp/git", "/mcp/web"] {
            assert_eq!(admission(root_mcp::tokens(), path, &token).await, Err(StatusCode::UNAUTHORIZED));
        }
        for caller in [root_mcp::Caller::Agent, root_mcp::Caller::Helper, root_mcp::Caller::Marker,
            root_mcp::Caller::Scheduler, root_mcp::Caller::Pusher, root_mcp::Caller::Web, root_mcp::Caller::Reader, root_mcp::Caller::LocalModel] {
            let (other, _) = root_mcp::test_session(caller);
            assert_eq!(admission(root_mcp::tokens(), "/mcp/cockpit", &other).await, Err(StatusCode::UNAUTHORIZED));
        }
    }

    /// The tab messages identity reaches `/mcp/tabs` and nothing else; no
    /// other class reaches `/mcp/tabs`.
    #[tokio::test]
    async fn tabs_route_is_an_exclusive_lane() {
        use super::*;
        let (token, tabs) = root_mcp::test_session(root_mcp::Caller::Tabs);
        assert!(admission(root_mcp::tokens(), "/mcp/tabs", &token).await.is_ok());
        for path in ["/mcp", "/mcp/help", "/mcp/markup", "/mcp/schedule", "/mcp/git", "/mcp/web", "/mcp/cockpit", "/mcp/print", "/mcp/tabs/x"] {
            assert_eq!(admission(root_mcp::tokens(), path, &token).await, Err(StatusCode::UNAUTHORIZED), "{path}");
        }
        for caller in [root_mcp::Caller::Agent, root_mcp::Caller::LocalModel, root_mcp::Caller::Reader, root_mcp::Caller::Scheduler,
            root_mcp::Caller::Pusher, root_mcp::Caller::Helper, root_mcp::Caller::Marker, root_mcp::Caller::Web,
            root_mcp::Caller::Cockpit, root_mcp::Caller::Printer] {
            let (other, session) = root_mcp::test_session(caller);
            assert_eq!(admission(root_mcp::tokens(), "/mcp/tabs", &other).await, Err(StatusCode::UNAUTHORIZED), "{caller:?}");
            root_mcp::revoke_tab(&session.identity.tab);
        }
        root_mcp::revoke_tab(&tabs.identity.tab);
        assert_eq!(admission(root_mcp::tokens(), "/mcp/tabs", &token).await, Err(StatusCode::UNAUTHORIZED), "a closed tab's token");
    }

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
    /// R3 (finding 1): a revived token is refused (`401`, before the body)
    /// with no known peer, and from a real connection whose session has no
    /// pane; the same token, freshly minted, is admitted as before.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_revived_token_from_an_unknown_peer_is_refused() {
        let post = |token: &str| Request::builder().method("POST").uri("/mcp/help").header("host", "127.0.0.1:8765")
            .header("content-type", "application/json").header("authorization", format!("Bearer {token}"))
            .body(axum::body::Body::from("not json")).unwrap();
        let (token, helper) = root_mcp::test_session(root_mcp::Caller::Helper);
        assert!(matches!(admit(post(&token), 8765, root_mcp::tokens()).await, Err(StatusCode::BAD_REQUEST)), "fresh: not checked");
        root_mcp::tokens().mark_revived_for_test(&helper.id, "r3-no-such-session");
        assert!(matches!(admit(post(&token), 8765, root_mcp::tokens()).await, Err(StatusCode::UNAUTHORIZED)), "no peer known");
        let peer = Peer { addr: "127.0.0.1:1".parse().unwrap(), verdicts: Arc::default() };
        let mut req = post(&token);
        req.extensions_mut().insert(axum::extract::ConnectInfo(peer.clone()));
        assert!(matches!(admit(req, 8765, root_mcp::tokens()).await, Err(StatusCode::UNAUTHORIZED)), "no pane, no socket");
        assert_eq!(peer.verdicts.lock_ok().get(&helper.id), Some(&PeerTree::Unknown), "cached for the connection");
        assert!(!root_mcp::tab_stale(&helper.identity.tab), "a pane that is gone flags nothing");
        root_mcp::revoke_tab(&helper.identity.tab);
    }

    /// A revived token refused because nobody can be seen holding the
    /// client socket (a non-dumpable CLI: `PeerTree::Hidden`) leaves the tab
    /// stale, so its card offers Reconnect and its hover card lists no tools,
    /// and the window hears it once (`root-mcp-sessions-changed` with
    /// `staleTab`). A refusal of an outsider seen outside the tree, or of an
    /// unknown peer, flags nothing.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_revived_token_from_a_hidden_peer_flags_its_tab_stale() {
        let post = |token: &str, verdict: Option<PeerTree>, id: &str| {
            let mut req = Request::builder().method("POST").uri("/mcp/help").header("host", "127.0.0.1:8765")
                .header("content-type", "application/json").header("authorization", format!("Bearer {token}"))
                .body(axum::body::Body::from("not json")).unwrap();
            if let Some(verdict) = verdict {
                // The check's answer for this connection, as `revived_peer` caches it.
                let peer = Peer { addr: "127.0.0.1:1".parse().unwrap(), verdicts: Arc::default() };
                peer.verdicts.lock_ok().insert(id.to_string(), verdict);
                req.extensions_mut().insert(axum::extract::ConnectInfo(peer));
            }
            req
        };
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let notify: NoticeSink = { let seen = seen.clone(); Arc::new(move |n| seen.lock().unwrap().push(n)) };
        let (token, helper) = root_mcp::test_session(root_mcp::Caller::Helper);
        let tab = helper.identity.tab.clone();
        root_mcp::tokens().mark_revived_for_test(&helper.id, "r3-hidden-session");
        assert_eq!(root_mcp::servers_of_tab(&tab), vec![crate::services::help_mcp::SERVER_NAME]);
        for verdict in [None, Some(PeerTree::Outside), Some(PeerTree::Unknown)] {
            let refused = admit_with(post(&token, verdict, &helper.id), 8765, root_mcp::tokens(), &notify).await;
            assert!(matches!(refused, Err(StatusCode::UNAUTHORIZED)), "{verdict:?}");
            assert!(!root_mcp::tab_stale(&tab), "{verdict:?}: no flag");
        }
        assert!(seen.lock().unwrap().is_empty());
        let refused = admit_with(post(&token, Some(PeerTree::Hidden), &helper.id), 8765, root_mcp::tokens(), &notify).await;
        assert!(matches!(refused, Err(StatusCode::UNAUTHORIZED)), "still refused");
        assert!(root_mcp::tab_stale(&tab), "flagged stale");
        assert!(root_mcp::servers_of_tab(&tab).is_empty(), "the hover card lists no live tools");
        assert_eq!(*seen.lock().unwrap(), vec![Notice::TabStale { tab: tab.clone() }]);
        let _ = admit_with(post(&token, Some(PeerTree::Hidden), &helper.id), 8765, root_mcp::tokens(), &notify).await;
        assert_eq!(seen.lock().unwrap().len(), 1, "told once");
        // From inside its tree the revived token still works (admitted as far
        // as the body, which is not JSON): the flag revokes nothing.
        let inside = admit_with(post(&token, Some(PeerTree::Inside), &helper.id), 8765, root_mcp::tokens(), &notify).await;
        assert!(matches!(inside, Err(StatusCode::BAD_REQUEST)));
        assert_eq!(stale_payload(&tab), serde_json::json!({ "staleTab": tab }));
        root_mcp::revoke_tab(&tab);
        root_mcp::forget_stale(&tab);
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
        for caller in [root_mcp::Caller::Agent, root_mcp::Caller::LocalModel, root_mcp::Caller::Reader, root_mcp::Caller::Scheduler, root_mcp::Caller::Pusher, root_mcp::Caller::Marker] {
            let (token, session) = root_mcp::test_session(caller);
            assert!(matches!(admit(post("/mcp/help", &token), 8765, root_mcp::tokens()).await, Err(StatusCode::UNAUTHORIZED)), "{caller:?}");
            root_mcp::revoke_tab(&session.identity.tab);
        }
    }
    /// The web identity reaches `/mcp/web` and nothing else — not the root
    /// registry, not another lane's route — and no other class reaches
    /// `/mcp/web`. Refused at admission, before the body; every route is a
    /// positive list over the classes, so each class reaches its own path.
    #[tokio::test]
    async fn web_route_is_its_own_lane() {
        let post = |path: &str, token: &str| Request::builder().method("POST").uri(path).header("host", "127.0.0.1:8765")
            .header("content-type", "application/json").header("authorization", format!("Bearer {token}"))
            .body(axum::body::Body::from("not json")).unwrap();
        let (token, web) = root_mcp::test_session(root_mcp::Caller::Web);
        for path in ["/mcp", "/mcp/schedule", "/mcp/git", "/mcp/help", "/mcp/markup", "/mcp/other", "/"] {
            assert!(!path_serves(path, root_mcp::Caller::Web), "{path}");
            assert!(matches!(admit(post(path, &token), 8765, root_mcp::tokens()).await, Err(StatusCode::UNAUTHORIZED)), "{path}");
        }
        assert!(path_serves("/mcp/web", root_mcp::Caller::Web));
        // Right lane: admitted as far as the body, which is not JSON.
        assert!(matches!(admit(post("/mcp/web", &token), 8765, root_mcp::tokens()).await, Err(StatusCode::BAD_REQUEST)));
        let mut req = post("/mcp/web", &token);
        req.headers_mut().insert(header::ORIGIN, "http://127.0.0.1:8765".parse().unwrap());
        assert!(matches!(admit(req, 8765, root_mcp::tokens()).await, Err(StatusCode::FORBIDDEN)));
        let mut req = post("/mcp/web", &token);
        req.headers_mut().insert(header::HOST, format!("{}:{}", root_mcp::READER_GUEST_HOST, root_mcp::READER_GUEST_PORT).parse().unwrap());
        assert!(matches!(admit(req, 8765, root_mcp::tokens()).await, Err(StatusCode::FORBIDDEN)), "the VM channel is the reader's alone");
        assert!(matches!(admit(post("/mcp/web", "0".repeat(64).as_str()), 8765, root_mcp::tokens()).await, Err(StatusCode::UNAUTHORIZED)));
        root_mcp::revoke_tab(&web.identity.tab);
        assert!(matches!(admit(post("/mcp/web", &token), 8765, root_mcp::tokens()).await, Err(StatusCode::UNAUTHORIZED)), "a closed tab's token");
        // The other direction: nobody else reaches `/mcp/web`, and the root
        // route serves exactly the three root-registry classes.
        for caller in [root_mcp::Caller::Agent, root_mcp::Caller::LocalModel, root_mcp::Caller::Reader, root_mcp::Caller::Scheduler, root_mcp::Caller::Pusher, root_mcp::Caller::Helper, root_mcp::Caller::Marker] {
            let (token, session) = root_mcp::test_session(caller);
            assert!(!path_serves("/mcp/web", caller), "{caller:?}");
            assert!(matches!(admit(post("/mcp/web", &token), 8765, root_mcp::tokens()).await, Err(StatusCode::UNAUTHORIZED)), "{caller:?}");
            let root = matches!(caller, root_mcp::Caller::Agent | root_mcp::Caller::LocalModel | root_mcp::Caller::Reader);
            assert_eq!(path_serves("/mcp", caller), root, "{caller:?}");
            root_mcp::revoke_tab(&session.identity.tab);
        }
    }
    /// The web lane end to end through the router and `handle`: a web token
    /// is answered as JSON-RPC (a refusal in a fixed category, never the
    /// URL), the handshake is not audited but a tool call is, and the row
    /// carries the tool and the category only.
    #[tokio::test]
    async fn the_web_lane_answers_through_the_router_and_audits_only_a_category() {
        use tower::ServiceExt;
        let state = ServerState { ctx: None, port: 8765, store: root_mcp::tokens(), notify: Arc::new(|_| {}) };
        let (token, web) = root_mcp::test_session(root_mcp::Caller::Web);
        let call = |body: &str| Request::builder().method("POST").uri("/mcp/web").header("host", "127.0.0.1:8765")
            .header("content-type", "application/json").header("authorization", format!("Bearer {token}"))
            .body(axum::body::Body::from(body.to_string())).unwrap();
        let answer = |response: Response| async move {
            let status = response.status();
            let bytes = axum::body::to_bytes(response.into_body(), 1 << 20).await.unwrap();
            (status, serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null))
        };
        let (status, list) = answer(router(state.clone()).oneshot(call(r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#)).await.unwrap()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(list["result"]["tools"].as_array().map(Vec::len), Some(2));
        let secret_url = "http://127.0.0.1:1/a-secret-path-to-a-private-service";
        let body = serde_json::json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"web_fetch","arguments":{"url": secret_url}}}).to_string();
        let (status, reply) = answer(router(state.clone()).oneshot(call(&body)).await.unwrap()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(reply["result"]["isError"], true);
        // Off in a test state (the flag is unset), or refused as not public if
        // a developer's own settings have the assistant on: both fixed.
        let category = reply["result"]["structuredContent"]["category"].as_str().unwrap().to_string();
        assert!(matches!(category.as_str(), "off" | "not_public"), "{category}");
        assert!(!reply.to_string().contains("a-secret-path"), "{reply}");
        // A notification is accepted without a body.
        let (status, _) = answer(router(state.clone()).oneshot(call(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#)).await.unwrap()).await;
        assert_eq!(status, StatusCode::ACCEPTED);
        // A batch is refused as JSON-RPC, not served.
        let (_, batch) = answer(router(state.clone()).oneshot(call(r#"[{"jsonrpc":"2.0","id":1,"method":"ping"}]"#)).await.unwrap()).await;
        assert_eq!(batch["error"]["code"], -32600);
        let rows: Vec<_> = security::audit_rows().into_iter().filter(|r| r.session == web.id).collect();
        let calls: Vec<_> = rows.iter().filter(|r| r.tool == "web_fetch").collect();
        assert_eq!(calls.len(), 1, "{}", serde_json::to_string(&rows).unwrap());
        assert_eq!((calls[0].outcome, calls[0].reason), ("refused", Some(if category == "off" { "off" } else { "not_public" })));
        assert!(rows.iter().all(|r| !serde_json::to_string(r).unwrap().contains("a-secret-path")), "no URL in the audit ring");
        assert!(rows.iter().all(|r| r.tool != "protocol" || r.reason.is_some()), "the handshake is not recorded");
        // A revoked tab's token stops at admission.
        root_mcp::revoke_tab(&web.identity.tab);
        let (status, _) = answer(router(state).oneshot(call(&body)).await.unwrap()).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    /// The markup identity reaches `/mcp/markup` and nothing else — the root
    /// route's negative list names it — and no other class reaches
    /// `/mcp/markup`. Refused at admission, before the body.
    #[tokio::test]
    async fn markup_route_is_its_own_lane() {
        let post = |path: &str, token: &str| Request::builder().method("POST").uri(path).header("host", "127.0.0.1:8765")
            .header("content-type", "application/json").header("authorization", format!("Bearer {token}"))
            .body(axum::body::Body::from("not json")).unwrap();
        let (token, marker) = root_mcp::test_session_bound(root_mcp::Caller::Marker, "p:markup-route", "p", "t");
        for path in ["/mcp", "/mcp/schedule", "/mcp/git", "/mcp/help", "/mcp/other"] {
            assert!(!path_serves(path, root_mcp::Caller::Marker), "{path}");
            assert!(matches!(admit(post(path, &token), 8765, root_mcp::tokens()).await, Err(StatusCode::UNAUTHORIZED)), "{path}");
        }
        assert!(matches!(admit(post("/mcp/markup", &token), 8765, root_mcp::tokens()).await, Err(StatusCode::BAD_REQUEST)));
        let mut req = post("/mcp/markup", &token);
        req.headers_mut().insert(header::ORIGIN, "http://127.0.0.1:8765".parse().unwrap());
        assert!(matches!(admit(req, 8765, root_mcp::tokens()).await, Err(StatusCode::FORBIDDEN)));
        let mut req = post("/mcp/markup", &token);
        req.headers_mut().insert(header::HOST, format!("{}:{}", root_mcp::READER_GUEST_HOST, root_mcp::READER_GUEST_PORT).parse().unwrap());
        assert!(matches!(admit(req, 8765, root_mcp::tokens()).await, Err(StatusCode::FORBIDDEN)));
        root_mcp::revoke_tab(&marker.identity.tab);
        assert!(matches!(admit(post("/mcp/markup", &token), 8765, root_mcp::tokens()).await, Err(StatusCode::UNAUTHORIZED)), "a closed tab's token");
        for caller in [root_mcp::Caller::Agent, root_mcp::Caller::LocalModel, root_mcp::Caller::Reader, root_mcp::Caller::Scheduler, root_mcp::Caller::Pusher, root_mcp::Caller::Helper] {
            let (token, session) = root_mcp::test_session(caller);
            assert!(!path_serves("/mcp/markup", caller), "{caller:?}");
            assert!(matches!(admit(post("/mcp/markup", &token), 8765, root_mcp::tokens()).await, Err(StatusCode::UNAUTHORIZED)), "{caller:?}");
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
        let runtime = Runtime { port: 8765, serves_root: false, serves_markup: false, serves_web: false, generation: "test-generation".into() };
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
        let error = start_headless_on(addr, Arc::new(|_| {}), None, stopped, None).await.unwrap_err();
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

    /// A desktop's Mobile host listener has no root lane at all: `/mcp` is
    /// not routed (404 before any handler), while the markup lane is
    /// (`docs/headless_mcp_plan.md`, phase 1b). A server daemon's routes
    /// every lane.
    #[tokio::test]
    async fn the_headless_router_does_not_route_the_root_lane() {
        use tower::ServiceExt;
        let state = ServerState { ctx: None, port: 8765, store: root_mcp::tokens(), notify: Arc::new(|_| {}) };
        let req = |path: &str| Request::builder().method("POST").uri(path).header("host", "127.0.0.1:8765")
            .header("content-type", "application/json").header("authorization", "Bearer x")
            .body(axum::body::Body::from("{}")).unwrap();
        let root = router(state.clone()).oneshot(req("/mcp")).await.unwrap();
        assert_eq!(root.status(), StatusCode::NOT_FOUND);
        for path in ["/mcp/schedule", "/mcp/git", "/mcp/help", "/mcp/web", "/mcp/markup"] {
            let side = router(state.clone()).oneshot(req(path)).await.unwrap();
            assert_eq!(side.status(), StatusCode::UNAUTHORIZED, "{path}");
        }
        // A server daemon's listener (its context, no window): every lane is
        // routed — admission answers.
        let events = Arc::new(crate::services::mobile_control::web_client::WebEvents::default());
        let ctx = CoreCtx::system(Arc::new(app_core::CoreState::new()), events);
        let server = ServerState { ctx: Some(ctx), ..state };
        for path in ["/mcp", "/mcp/markup", "/mcp/schedule", "/mcp/git", "/mcp/help", "/mcp/web"] {
            let served = router(server.clone()).oneshot(req(path)).await.unwrap();
            assert_eq!(served.status(), StatusCode::UNAUTHORIZED, "a server daemon serves {path}");
        }
    }

    /// A desktop's Mobile host tells its sink whenever a markup ask or tick of
    /// one of its tabs changes, which pokes an open window.
    #[test]
    fn the_hosts_markup_hook_notifies_its_sink() {
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = seen.clone();
        let hook = markup_notice_hook(Arc::new(move |notice| log.lock().unwrap().push(notice)));
        hook();
        hook();
        assert_eq!(*seen.lock().unwrap(), vec![Notice::Markup, Notice::Markup]);
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
        // The bytes cross a real socket: with the clock paused, an idle
        // runtime would jump it to the idle deadline before they land (seen on
        // macOS runners). Let real time run while they travel.
        tokio::time::resume();
        let n = stream.read(&mut buf).await.unwrap();
        tokio::time::pause();
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

    /// A web call holds its permits across up to 15 s of network I/O; with
    /// every web slot taken, the other lanes are admitted all the same.
    #[tokio::test]
    async fn a_busy_web_lane_cannot_starve_the_other_lanes() {
        assert!(!Arc::ptr_eq(&request_pool(root_mcp::Caller::Web), &request_pool(root_mcp::Caller::Agent)));
        let held = request_pool(root_mcp::Caller::Web).try_acquire_many_owned(WEB_REQUEST_SLOTS as u32).expect("web slots free");
        let body = || Body::from(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#);
        for caller in [root_mcp::Caller::Agent, root_mcp::Caller::Helper, root_mcp::Caller::Marker] {
            let (token, session) = root_mcp::test_session(caller);
            let mut req = request(&token, body());
            if caller != root_mcp::Caller::Agent {
                *req.uri_mut() = match caller { root_mcp::Caller::Helper => "/mcp/help", _ => "/mcp/markup" }.parse().unwrap();
            }
            let admitted = admit(req, 4321, root_mcp::tokens()).await;
            assert!(admitted.is_ok(), "{caller:?}: {:?}", admitted.err());
            root_mcp::revoke_tab(&session.identity.tab);
        }
        drop(held);
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

    // ── the stable port and the grant probe (docs/done/mcp_reattach_plan.md) ─────

    /// The remembered port is bound again when it is free. The port is
    /// freed before the bind, so a test running in parallel can take it in
    /// between: a lost race retries with a fresh port, and only a bind that
    /// never keeps a free port fails.
    #[test]
    fn the_remembered_port_is_bound_again_when_free() {
        for _ in 0..5 {
            let probe = std::net::TcpListener::bind(LOOPBACK).unwrap();
            let port = probe.local_addr().unwrap().port();
            drop(probe);
            let (listener, kept) = bind_preferred(Some(port), None).unwrap();
            if kept {
                assert_eq!(listener.local_addr().unwrap().port(), port);
                return;
            }
        }
        panic!("a freed port was never bound again in five tries");
    }

    /// An occupied remembered port falls back to a free one, and says it did
    /// not keep the port; no remembered port is a plain free bind.
    #[test]
    fn an_occupied_remembered_port_falls_back_to_a_free_one() {
        let holder = std::net::TcpListener::bind(LOOPBACK).unwrap();
        let taken = holder.local_addr().unwrap().port();
        let (listener, kept) = bind_preferred(Some(taken), None).unwrap();
        assert!(!kept);
        assert_ne!(listener.local_addr().unwrap().port(), taken);
        let (fresh, kept) = bind_preferred(None, None).unwrap();
        assert!(!kept && fresh.local_addr().unwrap().port() != 0);
    }

    /// The Mobile host never takes the window's remembered port: a bind that
    /// lands on it is rejected (and held, so the retry cannot land on it again).
    #[test]
    fn a_bind_that_lands_on_the_avoided_port_is_asked_again() {
        let avoided = std::net::TcpListener::bind(LOOPBACK).unwrap();
        let avoid = avoided.local_addr().unwrap().port();
        let other = std::net::TcpListener::bind(LOOPBACK).unwrap();
        let other_port = other.local_addr().unwrap().port();
        let mut answers = vec![other, avoided]; // popped from the end: the avoided port first
        let mut asked = 0;
        let got = bind_avoiding(|| { asked += 1; Ok(answers.pop().unwrap()) }, Some(avoid)).unwrap();
        assert_eq!((asked, got.local_addr().unwrap().port()), (2, other_port));
        // Nothing to avoid: the first answer stands.
        let first = std::net::TcpListener::bind(LOOPBACK).unwrap();
        let first_port = first.local_addr().unwrap().port();
        let got = bind_avoiding(|| Ok(first.try_clone().unwrap()), None).unwrap();
        assert_eq!(got.local_addr().unwrap().port(), first_port);
        // A listener that always lands on it gives up with an error.
        let stuck = std::net::TcpListener::bind(LOOPBACK).unwrap();
        let stuck_port = stuck.local_addr().unwrap().port();
        assert!(bind_avoiding(|| stuck.try_clone(), Some(stuck_port)).is_err());
    }

    /// The window's port file round-trips through the private writer.
    #[test]
    fn the_port_file_lives_under_the_root_mcp_state() {
        let file = port_file();
        assert!(file.ends_with(std::path::Path::new("root_mcp").join("port")), "{file:?}");
    }

    fn grant_request(hash: &str, port: u16, host: Option<&str>, origin: bool) -> Request {
        let mut builder = Request::builder().method("GET").uri(format!("/mcp/grant/{hash}"));
        if let Some(host) = host {
            builder = builder.header("host", host.replace("{port}", &port.to_string()));
        }
        if origin {
            builder = builder.header("origin", "http://evil.example");
        }
        builder.body(axum::body::Body::empty()).unwrap()
    }

    /// `GET /mcp/grant/<hash>`: 204 for a held session, 404 for any other
    /// hash, a revoked one and a malformed one; 403 for a browser's request or a
    /// foreign Host. No credentials are needed or read.
    #[tokio::test]
    async fn the_grant_probe_answers_held_or_not() {
        use tower::ServiceExt;
        let store: &'static root_mcp::TokenStore = Box::leak(Box::default());
        let token = root_mcp::mint_token().unwrap();
        let identity = root_mcp::Identity {
            tab: "probe:tab".into(), caller: root_mcp::Caller::Helper, project: None,
            schedule_target: None, push: None, endpoint: None, model: None,
        };
        store.register_for_test(token.clone(), identity);
        let hash = crate::digest::sha256_hex(token.as_bytes());
        let state = ServerState { ctx: None, port: 8765, store, notify: Arc::new(|_| {}) };
        let ask = |request: Request| {
            let app = router(state.clone());
            async move { app.oneshot(request).await.unwrap().status() }
        };
        let local = Some("127.0.0.1:{port}");
        assert_eq!(ask(grant_request(&hash, 8765, local, false)).await, StatusCode::NO_CONTENT);
        assert_eq!(ask(grant_request(&crate::digest::sha256_hex(b"other"), 8765, local, false)).await, StatusCode::NOT_FOUND);
        assert_eq!(ask(grant_request("../mcp", 8765, local, false)).await, StatusCode::NOT_FOUND, "not a hash");
        assert_eq!(ask(grant_request(&hash.to_uppercase(), 8765, local, false)).await, StatusCode::NOT_FOUND, "hex is lower case");
        assert_eq!(ask(grant_request(&hash, 8765, local, true)).await, StatusCode::FORBIDDEN, "a browser's request");
        assert_eq!(ask(grant_request(&hash, 8765, Some("attacker.invalid:8765"), false)).await, StatusCode::FORBIDDEN, "a rebound Host");
        assert_eq!(ask(grant_request(&hash, 8765, None, false)).await, StatusCode::FORBIDDEN, "no Host");
        // A revoked session is no longer held.
        store.revoke_for_test(&token);
        assert_eq!(ask(grant_request(&hash, 8765, local, false)).await, StatusCode::NOT_FOUND);
        // The route is on the Mobile host's router too (this one has no context).
        assert!(state.ctx.is_none());
    }

    /// The probe a launch makes ([`root_mcp::root_mcp_mark::probe_grant`])
    /// reaches a real listener's route over a socket.
    #[tokio::test]
    async fn the_probe_reaches_a_live_listener() {
        let store: &'static root_mcp::TokenStore = Box::leak(Box::default());
        let token = root_mcp::mint_token().unwrap();
        store.register_for_test(token.clone(), root_mcp::Identity {
            tab: "probe:live".into(), caller: root_mcp::Caller::Helper, project: None,
            schedule_target: None, push: None, endpoint: None, model: None,
        });
        let hash = crate::digest::sha256_hex(token.as_bytes());
        let tcp = std::net::TcpListener::bind(LOOPBACK).unwrap();
        tcp.set_nonblocking(true).unwrap();
        let port = tcp.local_addr().unwrap().port();
        let app = router(ServerState { ctx: None, port, store, notify: Arc::new(|_| {}) });
        let server = tokio::spawn(async move {
            let tcp = tokio::net::TcpListener::from_std(tcp).unwrap();
            let _ = axum::serve(BoundedListener { tcp, slots: Arc::new(tokio::sync::Semaphore::new(SOCKETS)) }, app).await;
        });
        let asked = hash.clone();
        let (held, unknown) = tokio::task::spawn_blocking(move || (
            root_mcp::root_mcp_mark::probe_grant(port, &asked),
            root_mcp::root_mcp_mark::probe_grant(port, &crate::digest::sha256_hex(b"nobody")),
        )).await.unwrap();
        assert!(held, "204 from the listener that holds it");
        assert!(!unknown);
        server.abort();
    }
}
