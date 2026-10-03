//! The gateway's HTTP surface (hosted plan §3.1, §4.1–§4.3).
//!
//! * `POST /api/v1/pair` — the code is `user:digits`; forwarded with the
//!   digits to that account's daemon, which checks the invite the helper
//!   wrote. A `201` records the device id under that account (refused if the
//!   id already routes elsewhere).
//! * `POST /api/v1/auth/challenge`, `/auth/session` — routed by the device
//!   id's owner; the daemon checks the signature. A `200` session also gets
//!   the routing cookie.
//! * Everything else with a valid routing cookie whose device still routes
//!   → that account's daemon, WebSocket upgrades included, with the
//!   `x-gateway-*` headers set by the gateway alone.
//! * Without one: `/api/*` is `401`, `/desktop*` a sign-in page, other `GET`s
//!   the PWA's files from disk.
//! * `/gateway/v1/{audit,policy,status}` — the gateway's own small API.
//! * The user-content listener: `/content/<user>/<ticket>` → that user's
//!   daemon's `/content/<ticket>`, cookies stripped.
//!
//! Every response of the gateway's own carries the phone's security
//! headers; forwarded answers carry the daemon's.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError, RwLock};
use std::time::{Duration, Instant, SystemTime};

use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, Path as RoutePath, Request, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tokio::task::AbortHandle;

use crate::audit::{AuditLog, Row};
use crate::config::GatewayConfig;
use crate::cookie::{self, RoutingKey};
use crate::db::{self, Account, Db, DbError, Role};
use crate::policy::Policy;
use crate::{proxy, statics, wire};

/// Largest body the gateway itself reads (pair, challenge, session, policy).
const MAX_OWN_BODY: usize = 64 * 1024;
/// Pairing attempts per minute, server-wide (each daemon limits its own too).
const PAIR_PER_MINUTE: u32 = 20;
/// Challenge + session requests per minute, server-wide.
const AUTH_PER_MINUTE: u32 = 240;
/// How often the account table is re-read for revocations.
const RELOAD_EVERY: Duration = Duration::from_secs(2);

struct Window {
    started: Instant,
    count: u32,
}

impl Window {
    fn new() -> Self {
        Self { started: Instant::now(), count: 0 }
    }

    /// Count one; `false` once `limit` is passed inside the minute.
    fn admit(&mut self, limit: u32) -> bool {
        if self.started.elapsed() >= Duration::from_secs(60) {
            *self = Window::new();
        }
        self.count += 1;
        self.count <= limit
    }
}

struct LiveSocket {
    user: String,
    device: String,
    handle: AbortHandle,
}

pub struct Gateway {
    pub config: GatewayConfig,
    key: RoutingKey,
    pub audit: AuditLog,
    db: RwLock<Arc<Db>>,
    db_stamp: Mutex<Option<SystemTime>>,
    live: Mutex<HashMap<u64, LiveSocket>>,
    next_live: AtomicU64,
    pair_window: Mutex<Window>,
    auth_window: Mutex<Window>,
}

pub type Shared = Arc<Gateway>;

impl Gateway {
    pub fn open(config: GatewayConfig) -> Result<Shared, String> {
        std::fs::create_dir_all(&config.state_dir).map_err(|e| format!("{}: {e}", config.state_dir.display()))?;
        let key = RoutingKey::load_or_create(&config.state_dir).map_err(|e| format!("routing key: {e}"))?;
        let db = Db::load(&config.state_dir).map_err(|e| e.to_string())?;
        let audit = AuditLog::in_dir(&config.state_dir);
        let stamp = db_stamp(&config);
        Ok(Arc::new(Gateway {
            config,
            key,
            audit,
            db: RwLock::new(Arc::new(db)),
            db_stamp: Mutex::new(stamp),
            live: Mutex::default(),
            next_live: AtomicU64::new(1),
            pair_window: Mutex::new(Window::new()),
            auth_window: Mutex::new(Window::new()),
        }))
    }

    pub fn db(&self) -> Arc<Db> {
        self.db.read().unwrap_or_else(PoisonError::into_inner).clone()
    }

    /// Re-read the table when the file changed, then close the sockets of
    /// devices that no longer route. A corrupt table keeps the last good one.
    pub fn reload(&self) {
        let stamp = db_stamp(&self.config);
        let mut last = self.db_stamp.lock().unwrap_or_else(PoisonError::into_inner);
        if *last != stamp {
            match Db::load(&self.config.state_dir) {
                Ok(db) => {
                    *self.db.write().unwrap_or_else(PoisonError::into_inner) = Arc::new(db);
                    *last = stamp;
                }
                Err(error) => eprintln!("gateway: keeping the last account table: {error}"),
            }
        }
        drop(last);
        self.sweep_live();
    }

    fn sweep_live(&self) {
        let db = self.db();
        self.live.lock().unwrap_or_else(PoisonError::into_inner).retain(|_, socket| {
            if socket.handle.is_finished() {
                return false;
            }
            if !db.routes(&socket.user, &socket.device) {
                socket.handle.abort();
                return false;
            }
            true
        });
    }

    fn register_live(&self, user: &str, device: &str, handle: AbortHandle) {
        let id = self.next_live.fetch_add(1, Ordering::Relaxed);
        self.live.lock().unwrap_or_else(PoisonError::into_inner).insert(id, LiveSocket { user: user.into(), device: device.into(), handle });
    }

    pub fn live_count(&self) -> usize {
        self.live.lock().unwrap_or_else(PoisonError::into_inner).values().filter(|s| !s.handle.is_finished()).count()
    }

    /// The account and device a request's routing cookie names, if both
    /// still route.
    fn routed(&self, headers: &HeaderMap) -> Option<(Account, String)> {
        let value = cookie_values(headers).into_iter().find_map(|h| cookie::from_cookie_header(&h).map(str::to_string))?;
        let (user, device) = self.key.verify(&value, crate::now())?;
        let db = self.db();
        if !db.routes(&user, &device) {
            return None;
        }
        Some((db.account(&user)?.clone(), device))
    }

    fn socket_of(&self, user: &str) -> std::path::PathBuf {
        wire::socket_path(&self.config.socket_dir, user)
    }
}

fn db_stamp(config: &GatewayConfig) -> Option<SystemTime> {
    std::fs::metadata(Db::path_in(&config.state_dir)).and_then(|m| m.modified()).ok()
}

fn cookie_values(headers: &HeaderMap) -> Vec<String> {
    headers.get_all(header::COOKIE).iter().filter_map(|v| v.to_str().ok().map(str::to_string)).collect()
}

fn api_error(status: StatusCode, code: &str) -> Response {
    (status, [(header::CACHE_CONTROL, "no-store")], Json(json!({ "error": code }))).into_response()
}

fn exact_origin(gw: &Gateway, headers: &HeaderMap) -> bool {
    headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) == Some(gw.config.origin.as_str())
}

/// The request as the daemon gets it: no client-sent `x-gateway-*`, no
/// routing cookie, then the gateway's own headers.
fn prepare(mut request: Request, account: &Account, device: Option<&str>) -> Request {
    let headers = request.headers_mut();
    let spoofed: Vec<HeaderName> = headers.keys().filter(|k| k.as_str().starts_with(wire::HEADER_PREFIX)).cloned().collect();
    for name in spoofed {
        headers.remove(name);
    }
    let cookies = cookie_values(headers);
    headers.remove(header::COOKIE);
    if let Some(rest) = cookie::without_routing_cookie(&cookies.join("; ")) {
        if let Ok(value) = HeaderValue::from_str(&rest) {
            headers.insert(header::COOKIE, value);
        }
    }
    if let Ok(v) = HeaderValue::from_str(&account.name) {
        headers.insert(wire::USER_HEADER, v);
    }
    headers.insert(wire::ROLE_HEADER, HeaderValue::from_static(account.role.as_str()));
    if let Some(Ok(v)) = device.map(HeaderValue::from_str) {
        headers.insert(wire::DEVICE_HEADER, v);
    }
    request
}

/// Forward to `account`'s daemon; a `101` registers its splice under
/// `(account, device)` so a revocation closes it.
async fn forward(gw: &Gateway, account: &Account, device: Option<&str>, request: Request) -> Response {
    let stream = match proxy::connect(&gw.socket_of(&account.name), account.uid).await {
        Ok(stream) => stream,
        Err(error) => {
            eprintln!("gateway: {}: {error}", account.name);
            return api_error(StatusCode::BAD_GATEWAY, "daemon_unavailable");
        }
    };
    match proxy::forward(stream, prepare(request, account, device)).await {
        Ok((response, splice)) => {
            if let (Some(splice), Some(device)) = (splice, device) {
                gw.register_live(&account.name, device, splice.abort_handle());
            }
            response
        }
        Err(error) => {
            eprintln!("gateway: {}: {error}", account.name);
            api_error(StatusCode::BAD_GATEWAY, "daemon_unavailable")
        }
    }
}

/// A buffered answer: `(status, headers, body)`.
async fn buffered(response: Response) -> (StatusCode, HeaderMap, Bytes) {
    let (parts, body) = response.into_parts();
    let bytes = match http_body_util::Limited::new(body, MAX_OWN_BODY).collect().await {
        Ok(collected) => collected.to_bytes(),
        Err(_) => Bytes::new(),
    };
    (parts.status, parts.headers, bytes)
}

fn json_request(gw: &Gateway, path: &str, body: Vec<u8>, headers: &HeaderMap) -> Request {
    let mut builder = axum::http::Request::builder()
        .method(Method::POST)
        .uri(path)
        .header(header::HOST, gw.config.public_host())
        .header(header::ORIGIN, gw.config.origin.as_str())
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(agent) = headers.get(header::USER_AGENT) {
        builder = builder.header(header::USER_AGENT, agent);
    }
    builder.body(Body::from(body)).expect("a fixed request is valid")
}

fn rebuild(status: StatusCode, headers: HeaderMap, body: Bytes) -> Response {
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = status;
    *response.headers_mut() = headers;
    response
}

async fn pair(State(gw): State<Shared>, headers: HeaderMap, body: Bytes) -> Response {
    if !exact_origin(&gw, &headers) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    if !gw.pair_window.lock().unwrap_or_else(PoisonError::into_inner).admit(PAIR_PER_MINUTE) {
        return api_error(StatusCode::TOO_MANY_REQUESTS, "rate_limited");
    }
    let Ok(Value::Object(mut fields)) = serde_json::from_slice::<Value>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    // An unknown account answers exactly like a wrong code.
    let Some((user, code)) = fields.get("code").and_then(Value::as_str).and_then(wire::split_routed_code).map(|(u, c)| (u.to_string(), c.to_string())) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_pairing_code");
    };
    let Some(account) = gw.db().account(&user).cloned() else {
        gw.audit.record(Row::new("-", None, "pair", "refused"));
        return api_error(StatusCode::BAD_REQUEST, "invalid_pairing_code");
    };
    let device_name = fields.get("device_name").and_then(Value::as_str).unwrap_or_default().to_string();
    fields.insert("code".into(), Value::String(code));
    let request = json_request(&gw, "/api/v1/pair", serde_json::to_vec(&fields).unwrap_or_default(), &headers);
    let (status, response_headers, response_body) = buffered(forward(&gw, &account, None, request).await).await;
    if status != StatusCode::CREATED {
        gw.audit.record(Row::new(&account.name, None, "pair", "refused"));
        return rebuild(status, response_headers, response_body);
    }
    let device_id = serde_json::from_slice::<Value>(&response_body).ok().and_then(|v| v.get("device_id").and_then(Value::as_str).map(str::to_string));
    let Some(device_id) = device_id else {
        gw.audit.record(Row::new(&account.name, None, "pair", "refused"));
        return api_error(StatusCode::BAD_GATEWAY, "daemon_unavailable");
    };
    match db::update(&gw.config.state_dir, |db| db.add_device(&account.name, &device_id, &device_name, crate::now())) {
        Ok(()) => {
            gw.reload();
            gw.audit.record(Row::new(&account.name, Some(&device_id), "pair", "ok"));
            rebuild(status, response_headers, response_body)
        }
        Err(error) => {
            eprintln!("gateway: pair for {}: {error}", account.name);
            gw.audit.record(Row::new(&account.name, None, "pair", "refused"));
            api_error(if error == DbError::DeviceTaken { StatusCode::CONFLICT } else { StatusCode::INTERNAL_SERVER_ERROR }, "pairing_failed")
        }
    }
}

/// `challenge` and `session`: routed by the device's owner.
async fn by_device(gw: &Gateway, path: &str, headers: &HeaderMap, body: &Bytes) -> Result<(Account, String, Request), Response> {
    if !exact_origin(gw, headers) {
        return Err(api_error(StatusCode::FORBIDDEN, "invalid_origin"));
    }
    if !gw.auth_window.lock().unwrap_or_else(PoisonError::into_inner).admit(AUTH_PER_MINUTE) {
        return Err(api_error(StatusCode::TOO_MANY_REQUESTS, "rate_limited"));
    }
    let device = serde_json::from_slice::<Value>(body).ok().and_then(|v| v.get("device_id").and_then(Value::as_str).map(str::to_string));
    let Some(device) = device.filter(|d| wire::valid_device_id(d)) else {
        return Err(api_error(StatusCode::BAD_REQUEST, "unknown_device"));
    };
    let Some(account) = gw.db().owner_of(&device).cloned() else {
        return Err(api_error(StatusCode::BAD_REQUEST, "unknown_device"));
    };
    Ok((account, device, json_request(gw, path, body.to_vec(), headers)))
}

async fn challenge(State(gw): State<Shared>, headers: HeaderMap, body: Bytes) -> Response {
    match by_device(&gw, "/api/v1/auth/challenge", &headers, &body).await {
        Ok((account, device, request)) => forward(&gw, &account, Some(&device), request).await,
        Err(response) => response,
    }
}

async fn session(State(gw): State<Shared>, headers: HeaderMap, body: Bytes) -> Response {
    let (account, device, request) = match by_device(&gw, "/api/v1/auth/session", &headers, &body).await {
        Ok(routed) => routed,
        Err(response) => return response,
    };
    let mut response = forward(&gw, &account, Some(&device), request).await;
    if response.status() == StatusCode::OK {
        let value = gw.key.mint(&account.name, &device, crate::now() + cookie::TTL);
        if let Ok(v) = HeaderValue::from_str(&cookie::set_cookie(&value)) {
            response.headers_mut().append(header::SET_COOKIE, v);
        }
        gw.audit.record(Row::new(&account.name, Some(&device), "login", "ok"));
    } else {
        gw.audit.record(Row::new(&account.name, Some(&device), "login", "refused"));
    }
    response
}

const SIGN_IN_PAGE: &str = "<!doctype html><meta charset=utf-8><meta name=viewport content=\"width=device-width\"><title>Sign in</title>\
<body style=\"font-family:system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#222;background:#fff\">\
<h1>Sign in first</h1><p>This browser is not paired with your account yet. Open <a href=\"/\">the start page</a>, \
pair it with the invite code your administrator gave you (<code>name:12345678</code>), then come back to <a href=\"/desktop/\">/desktop/</a>.</p>";

async fn routed_or_static(State(gw): State<Shared>, request: Request) -> Response {
    let path = request.uri().path().to_string();
    if let Some((account, device)) = gw.routed(request.headers()) {
        let logout = request.method() == Method::DELETE && path == "/api/v1/auth/session";
        let mut response = forward(&gw, &account, Some(&device), request).await;
        if logout {
            if let Ok(v) = HeaderValue::from_str(&cookie::clear_cookie()) {
                response.headers_mut().append(header::SET_COOKIE, v);
            }
            gw.audit.record(Row::new(&account.name, Some(&device), "logout", "ok"));
        }
        return response;
    }
    if path.starts_with("/api/") {
        return api_error(StatusCode::UNAUTHORIZED, "unauthenticated");
    }
    if path == "/desktop" || path.starts_with("/desktop/") {
        return (StatusCode::UNAUTHORIZED, [(header::CONTENT_TYPE, "text/html; charset=utf-8"), (header::CACHE_CONTROL, "no-store")], SIGN_IN_PAGE).into_response();
    }
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return StatusCode::NOT_FOUND.into_response();
    }
    let root = gw.config.pwa_dir.clone();
    match tokio::task::spawn_blocking(move || statics::lookup(&root, &path)).await.ok().flatten() {
        Some((_, bytes, mime, cache)) => ([(header::CONTENT_TYPE, mime.as_str()), (header::CACHE_CONTROL, cache)], bytes).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn own_audit(State(gw): State<Shared>, headers: HeaderMap) -> Response {
    let Some((account, _)) = gw.routed(&headers) else {
        return api_error(StatusCode::UNAUTHORIZED, "unauthenticated");
    };
    (StatusCode::OK, [(header::CACHE_CONTROL, "no-store")], Json(json!({ "rows": gw.audit.rows_for(&account.name, 500) }))).into_response()
}

async fn policy_get(State(gw): State<Shared>, headers: HeaderMap) -> Response {
    let Some((account, _)) = gw.routed(&headers) else {
        return api_error(StatusCode::UNAUTHORIZED, "unauthenticated");
    };
    match Policy::load(&gw.config.policy_path()) {
        Ok(policy) => (StatusCode::OK, [(header::CACHE_CONTROL, "no-store")], Json(json!({ "policy": policy, "role": account.role.as_str() }))).into_response(),
        Err(error) => {
            eprintln!("gateway: policy: {error}");
            api_error(StatusCode::INTERNAL_SERVER_ERROR, "policy_unreadable")
        }
    }
}

async fn policy_put(State(gw): State<Shared>, headers: HeaderMap, body: Bytes) -> Response {
    if !exact_origin(&gw, &headers) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    let Some((account, device)) = gw.routed(&headers) else {
        return api_error(StatusCode::UNAUTHORIZED, "unauthenticated");
    };
    if account.role != Role::Admin {
        gw.audit.record(Row::new(&account.name, Some(&device), "policy", "refused"));
        return api_error(StatusCode::FORBIDDEN, "admin");
    }
    let Ok(policy) = serde_json::from_slice::<Policy>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    if let Err(error) = policy.validate() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "invalid_policy", "detail": error }))).into_response();
    }
    let bytes = serde_json::to_vec_pretty(&policy).unwrap_or_default();
    match crate::write_atomic(&gw.config.policy_path(), &bytes, 0o644) {
        Ok(()) => {
            gw.audit.record(Row::new(&account.name, Some(&device), "policy", "ok"));
            (StatusCode::OK, Json(json!({ "policy": policy }))).into_response()
        }
        Err(error) => {
            eprintln!("gateway: policy: {error}");
            api_error(StatusCode::INTERNAL_SERVER_ERROR, "policy_unwritable")
        }
    }
}

/// Per account, with no content: name, role, how many devices route, and
/// whether its daemon socket answers. Admins only.
async fn status(State(gw): State<Shared>, headers: HeaderMap) -> Response {
    let Some((account, _)) = gw.routed(&headers) else {
        return api_error(StatusCode::UNAUTHORIZED, "unauthenticated");
    };
    if account.role != Role::Admin {
        return api_error(StatusCode::FORBIDDEN, "admin");
    }
    let mut rows = Vec::new();
    for a in gw.db().accounts.iter() {
        let up = proxy::connect(&gw.socket_of(&a.name), a.uid).await.is_ok();
        rows.push(json!({ "name": a.name, "role": a.role.as_str(), "devices": a.devices.len(), "daemon": if up { "up" } else { "down" } }));
    }
    (StatusCode::OK, [(header::CACHE_CONTROL, "no-store")], Json(json!({ "accounts": rows, "live_sockets": gw.live_count() }))).into_response()
}

async fn health() -> Response {
    Json(json!({ "ok": true })).into_response()
}

/// Only the public host is answered; the phone's headers on the gateway's own
/// responses (a forwarded answer already carries the daemon's).
async fn host_and_headers(State((gw, content)): State<(Shared, bool)>, request: Request, next: Next) -> Response {
    let want = if content { gw.config.content_origin.as_deref().map(crate::config::host_of) } else { Some(gw.config.public_host()) };
    let host = request.headers().get(header::HOST).and_then(|v| v.to_str().ok());
    if want.is_none() || host != want {
        return StatusCode::NOT_FOUND.into_response();
    }
    let mut response = next.run(request).await;
    let upgraded = response.status() == StatusCode::SWITCHING_PROTOCOLS;
    let headers = response.headers_mut();
    if !headers.contains_key(header::CONTENT_SECURITY_POLICY) && !upgraded {
        headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(if content { "sandbox; default-src 'none'" } else { statics::PWA_CSP }));
        headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
        headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
        headers.insert(header::STRICT_TRANSPORT_SECURITY, HeaderValue::from_static("max-age=31536000"));
        headers.insert("permissions-policy", HeaderValue::from_static(statics::PERMISSIONS_POLICY));
    }
    response
}

pub fn router(gw: Shared) -> Router {
    let own = Router::new()
        .route("/healthz", get(health))
        .route("/api/v1/pair", post(pair))
        .route("/api/v1/auth/challenge", post(challenge))
        .route("/api/v1/auth/session", post(session).delete(routed_or_static))
        .route("/gateway/v1/audit", get(own_audit))
        .route("/gateway/v1/policy", get(policy_get).put(policy_put))
        .route("/gateway/v1/status", get(status))
        .layer(DefaultBodyLimit::max(MAX_OWN_BODY));
    own.fallback(routed_or_static)
        .with_state(gw.clone())
        .layer(middleware::from_fn_with_state((gw, false), host_and_headers))
}

async fn content(State(gw): State<Shared>, RoutePath((user, ticket)): RoutePath<(String, String)>, mut request: Request) -> Response {
    let Some(account) = gw.db().account(&user).cloned() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if ticket.is_empty() || !ticket.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')) {
        return StatusCode::NOT_FOUND.into_response();
    }
    request.headers_mut().remove(header::COOKIE);
    let Ok(uri) = format!("/content/{ticket}").parse() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    *request.uri_mut() = uri;
    forward(&gw, &account, None, request).await
}

pub fn content_router(gw: Shared) -> Router {
    Router::new()
        .route("/content/{user}/{ticket}", get(content))
        .with_state(gw.clone())
        .layer(middleware::from_fn_with_state((gw, true), host_and_headers))
}

/// The gateway's whole life: both listeners, the table watcher.
pub async fn serve(config: GatewayConfig) -> Result<(), String> {
    let gw = Gateway::open(config)?;
    let listener = tokio::net::TcpListener::bind(gw.config.listen).await.map_err(|e| format!("bind {}: {e}", gw.config.listen))?;
    if let Some(addr) = gw.config.content_listen {
        let content_listener = tokio::net::TcpListener::bind(addr).await.map_err(|e| format!("bind {addr}: {e}"))?;
        let app = content_router(gw.clone());
        tokio::spawn(async move {
            if let Err(error) = axum::serve(content_listener, app).await {
                eprintln!("gateway: content listener: {error}");
            }
        });
    }
    let watcher = gw.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(RELOAD_EVERY);
        loop {
            tick.tick().await;
            watcher.reload();
        }
    });
    eprintln!("gateway: {} on {} ({} accounts)", gw.config.origin, gw.config.listen, gw.db().accounts.len());
    axum::serve(listener, router(gw)).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests;
