//! The gateway's HTTP surface (hosted plan §3.1, §4.1–§4.3).
//!
//! * `POST /api/v1/pair` — the code is `user:digits`; forwarded with the
//!   digits to that account's daemon, which checks the invite the helper
//!   wrote. A `201` records the device id under that account (refused if the
//!   id already routes elsewhere). Forwarded only while the account has an
//!   invite pending or was active lately: otherwise it answers exactly like
//!   an unknown account, and never starts an idle daemon.
//! * `POST /api/v1/auth/challenge`, `/auth/session` — routed by the device
//!   id's owner; the daemon checks the signature. A `200` session also gets
//!   the routing cookie.
//! * Everything else with a valid routing cookie whose device still routes
//!   → that account's daemon, WebSocket upgrades included, with the
//!   `x-gateway-*` headers set by the gateway alone.
//! * Without one: `/api/*` is `401`, `/desktop*` a sign-in page, other `GET`s
//!   the PWA's files from disk.
//! * `/gateway/v1/{audit,policy,status}` — the gateway's own small API.
//! * `/gateway/v1/oidc[/start|/callback]` — sign-in through an identity
//!   provider pairs a device in place of an invite (P5, [`crate::oidc`]).
//! * `/gateway/v1/agent-keys[/<cli>[/users|/delivery|/budget|/renew-token]]` —
//!   the administrator's agent API keys (plan §5.4): listed, offered,
//!   withdrawn, given their users, switched to the broker, budgeted and their
//!   users' broker tokens renewed, all through the key keeper
//!   ([`crate::keeper`]); a key goes in, never comes back out.
//! * The user-content listener: `/content/<user>/<ticket>` → that user's
//!   daemon's `/content/<ticket>`, cookies stripped.
//!
//! Every response of the gateway's own carries the phone's security
//! headers; forwarded answers carry the daemon's. Rate limits: [`crate::rate`].

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError, RwLock};
use std::time::{Duration, Instant, SystemTime};

use axum::body::{Body, Bytes};
use axum::extract::connect_info::{ConnectInfo, Connected};
use axum::extract::{DefaultBodyLimit, Extension, Path as RoutePath, Request, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tokio::task::AbortHandle;

use crate::audit::{AuditLog, Row};
use crate::config::GatewayConfig;
use crate::cookie::{self, RoutingKey};
use crate::db::{self, Account, Db, DbError, Role};
use crate::policy::Policy;
use crate::rate::Limits;
use crate::{keys_wire, proxy, statics, wire};

/// Largest body the gateway itself reads (pair, challenge, session, policy).
const MAX_OWN_BODY: usize = 64 * 1024;
/// How long after its last routed request an account still takes a pair
/// without a pending invite (a signed-in user pairing a second device with a
/// code their own daemon made). Its daemon is up then anyway.
const ACTIVE_FOR: Duration = Duration::from_secs(15 * 60);
/// How often the account table is re-read for revocations.
const RELOAD_EVERY: Duration = Duration::from_secs(2);
/// Connections the app listener holds at once (every account's phones and
/// browsers together; each forwarded one costs a second descriptor for the
/// daemon's socket — the unit's `LimitNOFILE` leaves room for both).
pub const MAX_CONNECTIONS: usize = 2048;
/// The user-content listener: short-lived ticket fetches.
pub const MAX_CONTENT_CONNECTIONS: usize = 256;

/// The TCP peer of a gateway connection (the [`Connected`] info of
/// [`crate::limits::GuardedListener`]).
#[derive(Debug, Clone, Copy)]
pub struct PeerAddr(pub std::net::SocketAddr);

impl Connected<axum::serve::IncomingStream<'_, crate::limits::GuardedListener>> for PeerAddr {
    fn connect_info(stream: axum::serve::IncomingStream<'_, crate::limits::GuardedListener>) -> Self {
        PeerAddr(*stream.remote_addr())
    }
}

/// Where a request came from, for the per-source windows ([`crate::rate::source_of`]).
#[derive(Debug, Clone)]
pub struct Source(pub String);

struct LiveSocket {
    user: String,
    device: String,
    /// The role the gateway named when the socket opened: the daemon fixes a
    /// socket's role at its upgrade, so a role change must close it.
    role: Role,
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
    limits: Mutex<Limits>,
    /// Last routed request per account (bounded by the table).
    active: Mutex<HashMap<String, Instant>>,
    /// OIDC sign-ins in flight and the provider's endpoints (P5).
    oidc: crate::oidc::Flow,
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
            limits: Mutex::new(Limits::new(Instant::now())),
            active: Mutex::default(),
            oidc: crate::oidc::Flow::new()?,
        }))
    }

    pub fn db(&self) -> Arc<Db> {
        self.db.read().unwrap_or_else(PoisonError::into_inner).clone()
    }

    /// Re-read the table when the file changed, then close the sockets of
    /// devices that no longer route or whose account's role changed. A
    /// corrupt table keeps the last good one.
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
            let role_now = db.account(&socket.user).map(|a| a.role);
            if !db.routes(&socket.user, &socket.device) || role_now != Some(socket.role) {
                socket.handle.abort();
                return false;
            }
            true
        });
    }

    fn register_live(&self, user: &str, device: &str, role: Role, handle: AbortHandle) {
        let id = self.next_live.fetch_add(1, Ordering::Relaxed);
        self.live.lock().unwrap_or_else(PoisonError::into_inner).insert(id, LiveSocket { user: user.into(), device: device.into(), role, handle });
    }

    fn limits(&self) -> std::sync::MutexGuard<'_, Limits> {
        self.limits.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn mark_active(&self, user: &str) {
        self.active.lock().unwrap_or_else(PoisonError::into_inner).insert(user.to_string(), Instant::now());
    }

    /// May a pair for `account` reach its daemon? Only while the helper's
    /// invite is pending, or while the account is in use (a routed request
    /// lately, or a live socket) — then its daemon is running already.
    fn pairable(&self, account: &Account) -> bool {
        if account.invite_until > crate::now() {
            return true;
        }
        let recent = self.active.lock().unwrap_or_else(PoisonError::into_inner).get(&account.name).is_some_and(|t| t.elapsed() < ACTIVE_FOR);
        recent || self.live.lock().unwrap_or_else(PoisonError::into_inner).values().any(|s| s.user == account.name && !s.handle.is_finished())
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
                gw.register_live(&account.name, device, account.role, splice.abort_handle());
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

async fn pair(State(gw): State<Shared>, Extension(source): Extension<Source>, headers: HeaderMap, body: Bytes) -> Response {
    if !exact_origin(&gw, &headers) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    let stranger = |gw: &Gateway, user: &str, error: &str| {
        if !gw.limits().pair_stranger(&source.0, Instant::now()) {
            return api_error(StatusCode::TOO_MANY_REQUESTS, "rate_limited");
        }
        gw.audit.record(Row::new(user, None, "pair", "refused"));
        api_error(StatusCode::BAD_REQUEST, error)
    };
    let Ok(Value::Object(mut fields)) = serde_json::from_slice::<Value>(&body) else {
        return stranger(&gw, "-", "invalid_request");
    };
    // An unknown account, and one with no invite pending that is not in
    // use, answer exactly like a wrong code — and reach no daemon.
    let Some((user, code)) = fields.get("code").and_then(Value::as_str).and_then(wire::split_routed_code).map(|(u, c)| (u.to_string(), c.to_string())) else {
        return stranger(&gw, "-", "invalid_pairing_code");
    };
    let Some(account) = gw.db().account(&user).cloned() else {
        return stranger(&gw, "-", "invalid_pairing_code");
    };
    if !gw.pairable(&account) {
        return stranger(&gw, &account.name, "invalid_pairing_code");
    }
    if !gw.limits().pair_known(&source.0, &account.name, Instant::now()) {
        return api_error(StatusCode::TOO_MANY_REQUESTS, "rate_limited");
    }
    let device_name = fields.get("device_name").and_then(Value::as_str).unwrap_or_default().to_string();
    fields.insert("code".into(), Value::String(code));
    // An identity provider's token reaches a daemon only from the OIDC
    // callback, after its state, binder cookie and code exchange — never
    // riding along with an invite code.
    fields.remove("oidc_token");
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

/// `challenge` and `session`: routed by the device's owner. A device id no
/// account owns is a stranger's request: counted by source and in the shared
/// stranger window, never against a paired device's budget.
async fn by_device(gw: &Gateway, source: &Source, path: &str, headers: &HeaderMap, body: &Bytes) -> Result<(Account, String, Request), Response> {
    if !exact_origin(gw, headers) {
        return Err(api_error(StatusCode::FORBIDDEN, "invalid_origin"));
    }
    let device = serde_json::from_slice::<Value>(body).ok().and_then(|v| v.get("device_id").and_then(Value::as_str).map(str::to_string));
    let known = device.filter(|d| wire::valid_device_id(d)).and_then(|d| gw.db().owner_of(&d).cloned().map(|a| (a, d)));
    let Some((account, device)) = known else {
        if !gw.limits().auth_stranger(&source.0, Instant::now()) {
            return Err(api_error(StatusCode::TOO_MANY_REQUESTS, "rate_limited"));
        }
        return Err(api_error(StatusCode::BAD_REQUEST, "unknown_device"));
    };
    if !gw.limits().auth_known(&device, &account.name, Instant::now()) {
        return Err(api_error(StatusCode::TOO_MANY_REQUESTS, "rate_limited"));
    }
    Ok((account, device, json_request(gw, path, body.to_vec(), headers)))
}

async fn challenge(State(gw): State<Shared>, Extension(source): Extension<Source>, headers: HeaderMap, body: Bytes) -> Response {
    match by_device(&gw, &source, "/api/v1/auth/challenge", &headers, &body).await {
        Ok((account, device, request)) => forward(&gw, &account, Some(&device), request).await,
        Err(response) => response,
    }
}

async fn session(State(gw): State<Shared>, Extension(source): Extension<Source>, headers: HeaderMap, body: Bytes) -> Response {
    let (account, device, request) = match by_device(&gw, &source, "/api/v1/auth/session", &headers, &body).await {
        Ok(routed) => routed,
        Err(response) => return response,
    };
    let mut response = forward(&gw, &account, Some(&device), request).await;
    if response.status() == StatusCode::OK {
        let value = gw.key.mint(&account.name, &device, crate::now() + cookie::TTL);
        if let Ok(v) = HeaderValue::from_str(&cookie::set_cookie(&value)) {
            response.headers_mut().append(header::SET_COOKIE, v);
        }
        gw.mark_active(&account.name);
        gw.audit.record(Row::new(&account.name, Some(&device), "login", "ok"));
    } else {
        gw.audit.record(Row::new(&account.name, Some(&device), "login", "refused"));
    }
    response
}

// ── OIDC sign-in (P5) ─────────────────────────────────────────────────────

fn redirect_uri(gw: &Gateway) -> String {
    format!("{}/gateway/v1/oidc/callback", gw.config.origin)
}

/// Whether the server offers a provider sign-in, and its label (public: the
/// pairing screen asks before anyone is signed in).
async fn oidc_info(State(gw): State<Shared>) -> Response {
    let body = match crate::oidc::OidcConfig::load(&gw.config.state_dir) {
        Some(config) => json!({ "enabled": true, "name": config.name }),
        None => json!({ "enabled": false }),
    };
    (StatusCode::OK, [(header::CACHE_CONTROL, "no-store")], Json(body)).into_response()
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct OidcStartBody {
    public_key: String,
    device_name: String,
}

/// Start a provider sign-in that pairs this browser's key: the binder
/// cookie, and the provider's URL to send the browser to.
async fn oidc_start(State(gw): State<Shared>, Extension(source): Extension<Source>, headers: HeaderMap, body: Bytes) -> Response {
    if !exact_origin(&gw, &headers) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    // Nobody is known yet: every start counts against the stranger windows.
    if !gw.limits().pair_stranger(&source.0, Instant::now()) {
        return api_error(StatusCode::TOO_MANY_REQUESTS, "rate_limited");
    }
    let Some(config) = crate::oidc::OidcConfig::load(&gw.config.state_dir) else {
        return api_error(StatusCode::NOT_FOUND, "oidc_off");
    };
    let Ok(OidcStartBody { public_key, device_name }) = serde_json::from_slice::<OidcStartBody>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    if device_name.trim().is_empty() {
        return api_error(StatusCode::BAD_REQUEST, "device_name_required");
    }
    let provider = match gw.oidc.provider(&config).await {
        Ok(provider) => provider,
        Err(error) => {
            eprintln!("gateway: oidc discovery: {error}");
            return api_error(StatusCode::BAD_GATEWAY, "provider_unreachable");
        }
    };
    match gw.oidc.begin(&config, &provider, &redirect_uri(&gw), &public_key, &device_name, crate::now()) {
        Ok((binder, url)) => {
            let mut response = (StatusCode::OK, [(header::CACHE_CONTROL, "no-store")], Json(json!({ "url": url }))).into_response();
            if let Ok(v) = HeaderValue::from_str(&crate::oidc::binder_cookie(&binder)) {
                response.headers_mut().append(header::SET_COOKIE, v);
            }
            response
        }
        Err(code) => api_error(StatusCode::BAD_REQUEST, code),
    }
}

/// Back to the start page with an outcome the pairing screen reads, the
/// binder cookie cleared.
fn oidc_back(outcome: &str, device: Option<&str>) -> Response {
    let mut location = format!("/?oidc={outcome}");
    if let Some(device) = device {
        location.push_str("&device=");
        location.push_str(device);
    }
    let mut response = (StatusCode::SEE_OTHER, [(header::LOCATION, location.as_str()), (header::CACHE_CONTROL, "no-store")]).into_response();
    if let Ok(v) = HeaderValue::from_str(&crate::oidc::clear_binder_cookie()) {
        response.headers_mut().append(header::SET_COOKIE, v);
    }
    response
}

#[derive(serde::Deserialize)]
struct OidcCallback {
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    state: Option<String>,
}

/// The provider's redirect back: the pending sign-in of *this* browser (its
/// binder cookie), the code exchanged, the ID token routed by the linked
/// account to its daemon, which verifies it and pairs the key.
async fn oidc_callback(State(gw): State<Shared>, Extension(source): Extension<Source>, headers: HeaderMap, axum::extract::Query(query): axum::extract::Query<OidcCallback>) -> Response {
    if !gw.limits().pair_stranger(&source.0, Instant::now()) {
        return oidc_back("busy", None);
    }
    let Some(state) = query.state else { return oidc_back("refused", None) };
    // No binder cookie is another browser (or one that dropped it): like a
    // wrong one, it spends the sign-in and says where it was started.
    let binder = cookie_values(&headers).iter().find_map(|c| crate::oidc::binder_from(c).map(str::to_string)).unwrap_or_default();
    let Some(pending) = gw.oidc.take(&state, &binder, crate::now()) else { return oidc_back("expired", None) };
    // The provider's own error (cancelled, denied) carries no code.
    let Some(code) = query.code.filter(|c| !c.is_empty() && c.len() <= 4096) else { return oidc_back("refused", None) };
    let Some(config) = crate::oidc::OidcConfig::load(&gw.config.state_dir) else { return oidc_back("refused", None) };
    let token = match gw.oidc.provider(&config).await {
        Ok(provider) => gw.oidc.exchange(&config, &provider, &redirect_uri(&gw), &code, &pending.verifier).await,
        Err(error) => Err(error),
    };
    let token = match token {
        Ok(token) => token,
        Err(error) => {
            eprintln!("gateway: oidc: {error}");
            return oidc_back("provider", None);
        }
    };
    // Read only to route: the token came straight from the token endpoint
    // over TLS, and the account's daemon checks its signature before it
    // trusts anything in it.
    let account = crate::oidc_wire::claims_unverified(&token)
        .filter(|claims| claims.get("iss").and_then(Value::as_str) == Some(config.issuer.as_str()))
        .and_then(|claims| gw.db().account_for_claims(&claims).cloned());
    let Some(account) = account else {
        gw.audit.record(Row::new("-", None, "pair-oidc", "unknown"));
        return oidc_back("unknown", None);
    };
    let body = json!({ "oidc_token": token, "device_name": pending.device_name, "public_key": pending.public_key });
    let request = json_request(&gw, "/api/v1/pair", serde_json::to_vec(&body).unwrap_or_default(), &headers);
    let (status, _, response_body) = buffered(forward(&gw, &account, None, request).await).await;
    let device_id = serde_json::from_slice::<Value>(&response_body).ok().and_then(|v| v.get("device_id").and_then(Value::as_str).map(str::to_string));
    let (StatusCode::CREATED, Some(device_id)) = (status, device_id) else {
        gw.audit.record(Row::new(&account.name, None, "pair-oidc", "refused"));
        return oidc_back("refused", None);
    };
    match db::update(&gw.config.state_dir, |db| db.add_device(&account.name, &device_id, &pending.device_name, crate::now())) {
        Ok(()) => {
            gw.reload();
            gw.audit.record(Row::new(&account.name, Some(&device_id), "pair-oidc", "ok"));
            oidc_back("paired", Some(&device_id))
        }
        Err(error) => {
            eprintln!("gateway: oidc pair for {}: {error}", account.name);
            gw.audit.record(Row::new(&account.name, None, "pair-oidc", "refused"));
            oidc_back("refused", None)
        }
    }
}

const SIGN_IN_PAGE: &str = "<!doctype html><meta charset=utf-8><meta name=viewport content=\"width=device-width\"><title>Sign in</title>\
<body style=\"font-family:system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#222;background:#fff\">\
<h1>Sign in first</h1><p>This browser is not paired with your account yet. Open <a href=\"/\">the start page</a>, \
pair it with the invite code your administrator gave you (<code>name:12345678</code>), then come back to <a href=\"/desktop/\">/desktop/</a>.</p>";

async fn routed_or_static(State(gw): State<Shared>, request: Request) -> Response {
    let path = request.uri().path().to_string();
    if let Some((account, device)) = gw.routed(request.headers()) {
        gw.mark_active(&account.name);
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

/// The administrator's agent API keys as the key keeper holds them: per
/// offered CLI, when, by whom, who may fetch it and who did lately — and the
/// account names the panel picks users from. Never a key.
async fn agent_keys_get(State(gw): State<Shared>, headers: HeaderMap) -> Response {
    let Some((account, _)) = gw.routed(&headers) else {
        return api_error(StatusCode::UNAUTHORIZED, "unauthenticated");
    };
    if account.role != Role::Admin {
        return api_error(StatusCode::FORBIDDEN, "admin");
    }
    match crate::keeper::ask(&gw.config.keeper_socket, &keys_wire::Request::Status).await {
        Ok(reply) if reply.ok => {
            let accounts: Vec<String> = gw.db().accounts.iter().map(|a| a.name.clone()).collect();
            (StatusCode::OK, [(header::CACHE_CONTROL, "no-store")], Json(json!({ "keys": reply.status, "accounts": accounts }))).into_response()
        }
        Ok(reply) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": "keeper", "detail": reply.error }))).into_response(),
        Err(error) => {
            eprintln!("gateway: key keeper: {error}");
            api_error(StatusCode::BAD_GATEWAY, "keeper_unreachable")
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct KeyBody {
    key: String,
}

/// Offer (`PUT`, body `{"key": …}`) or withdraw (`DELETE`) the key of one
/// CLI. Admin only, exact origin; audited here (who, which CLI) and by the
/// keeper. The body is never logged.
async fn agent_key_change(gw: &Gateway, cli: &str, headers: &HeaderMap, key: Option<Bytes>) -> Response {
    if !exact_origin(gw, headers) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    let Some((account, device)) = gw.routed(headers) else {
        return api_error(StatusCode::UNAUTHORIZED, "unauthenticated");
    };
    if account.role != Role::Admin {
        gw.audit.record(Row::new(&account.name, Some(&device), "agent-key", "refused"));
        return api_error(StatusCode::FORBIDDEN, "admin");
    }
    if !keys_wire::valid_cli_id(cli) {
        return api_error(StatusCode::BAD_REQUEST, "invalid_cli");
    }
    let request = match key {
        Some(body) => {
            let Ok(KeyBody { key }) = serde_json::from_slice::<KeyBody>(&body) else {
                return api_error(StatusCode::BAD_REQUEST, "invalid_request");
            };
            let key = key.trim().to_string();
            if !keys_wire::valid_key(&key) {
                return api_error(StatusCode::BAD_REQUEST, "invalid_key");
            }
            keys_wire::Request::Set { cli: cli.to_string(), key, by: account.name.clone() }
        }
        None => keys_wire::Request::Remove { cli: cli.to_string(), by: account.name.clone() },
    };
    let verb = if matches!(request, keys_wire::Request::Set { .. }) { "agent-key-set" } else { "agent-key-remove" };
    match crate::keeper::ask(&gw.config.keeper_socket, &request).await {
        Ok(reply) if reply.ok => {
            gw.audit.record(Row::new(&account.name, Some(&device), verb, "ok").resource(cli));
            (StatusCode::OK, Json(json!({ "ok": true }))).into_response()
        }
        Ok(reply) => {
            gw.audit.record(Row::new(&account.name, Some(&device), verb, "failed").resource(cli));
            (StatusCode::BAD_GATEWAY, Json(json!({ "error": "keeper", "detail": reply.error }))).into_response()
        }
        Err(error) => {
            eprintln!("gateway: key keeper: {error}");
            gw.audit.record(Row::new(&account.name, Some(&device), verb, "failed").resource(cli));
            api_error(StatusCode::BAD_GATEWAY, "keeper_unreachable")
        }
    }
}

async fn agent_key_put(State(gw): State<Shared>, RoutePath(cli): RoutePath<String>, headers: HeaderMap, body: Bytes) -> Response {
    agent_key_change(&gw, &cli, &headers, Some(body)).await
}

async fn agent_key_delete(State(gw): State<Shared>, RoutePath(cli): RoutePath<String>, headers: HeaderMap) -> Response {
    agent_key_change(&gw, &cli, &headers, None).await
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct UsersBody {
    users: Vec<String>,
}

/// Who may use one CLI's key (`PUT`, body `{"users": [names]}`): accounts
/// of this gateway only. Admin only, exact origin; audited here (who, which
/// CLI) and by the keeper (each user added or removed).
async fn agent_key_users(State(gw): State<Shared>, RoutePath(cli): RoutePath<String>, headers: HeaderMap, body: Bytes) -> Response {
    if !exact_origin(&gw, &headers) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    let Some((account, device)) = gw.routed(&headers) else {
        return api_error(StatusCode::UNAUTHORIZED, "unauthenticated");
    };
    if account.role != Role::Admin {
        gw.audit.record(Row::new(&account.name, Some(&device), "agent-key-users", "refused"));
        return api_error(StatusCode::FORBIDDEN, "admin");
    }
    if !keys_wire::valid_cli_id(&cli) {
        return api_error(StatusCode::BAD_REQUEST, "invalid_cli");
    }
    let Ok(UsersBody { users }) = serde_json::from_slice::<UsersBody>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    if users.len() > keys_wire::MAX_USERS {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    }
    let unknown: Vec<String> = {
        let db = gw.db();
        users.iter().filter(|u| !db.accounts.iter().any(|a| &a.name == *u)).cloned().collect()
    };
    // A name may stay on the list after its account was removed
    // (`user-remove`); the panel sends the list back with it, so such a name
    // is accepted as long as it is already there — it never blocks allowing
    // or removing someone else. A name that is neither an account nor on the
    // list is refused.
    if !unknown.is_empty() {
        let listed: Vec<String> = match crate::keeper::ask(&gw.config.keeper_socket, &keys_wire::Request::Status).await {
            Ok(reply) if reply.ok => reply.status.into_iter().find(|k| k.cli == cli).map(|k| k.allowed).unwrap_or_default(),
            _ => Vec::new(),
        };
        if !unknown.iter().all(|u| listed.contains(u)) {
            return api_error(StatusCode::BAD_REQUEST, "unknown_user");
        }
    }
    let request = keys_wire::Request::Users { cli: cli.clone(), users, by: account.name.clone() };
    match crate::keeper::ask(&gw.config.keeper_socket, &request).await {
        Ok(reply) if reply.ok => {
            gw.audit.record(Row::new(&account.name, Some(&device), "agent-key-users", "ok").resource(&cli));
            (StatusCode::OK, Json(json!({ "ok": true }))).into_response()
        }
        Ok(reply) => {
            gw.audit.record(Row::new(&account.name, Some(&device), "agent-key-users", "failed").resource(&cli));
            (StatusCode::BAD_GATEWAY, Json(json!({ "error": "keeper", "detail": reply.error }))).into_response()
        }
        Err(error) => {
            eprintln!("gateway: key keeper: {error}");
            gw.audit.record(Row::new(&account.name, Some(&device), "agent-key-users", "failed").resource(&cli));
            api_error(StatusCode::BAD_GATEWAY, "keeper_unreachable")
        }
    }
}

/// Admin only, exact origin, a valid CLI id: who is asking, or the refusal.
// A refusal is the answer itself; boxing it would only move the size around.
#[allow(clippy::result_large_err)]
fn admin_for_key(gw: &Gateway, cli: &str, headers: &HeaderMap, verb: &str) -> Result<(Account, String), Response> {
    if !exact_origin(gw, headers) {
        return Err(api_error(StatusCode::FORBIDDEN, "invalid_origin"));
    }
    let Some((account, device)) = gw.routed(headers) else {
        return Err(api_error(StatusCode::UNAUTHORIZED, "unauthenticated"));
    };
    if account.role != Role::Admin {
        gw.audit.record(Row::new(&account.name, Some(&device), verb, "refused"));
        return Err(api_error(StatusCode::FORBIDDEN, "admin"));
    }
    if !keys_wire::valid_cli_id(cli) {
        return Err(api_error(StatusCode::BAD_REQUEST, "invalid_cli"));
    }
    Ok((account, device))
}

/// Send an administrator's change to the keeper; audited here (who, which
/// CLI) and by the keeper.
async fn keeper_change(gw: &Gateway, account: &Account, device: &str, verb: &str, cli: &str, request: keys_wire::Request) -> Response {
    match crate::keeper::ask(&gw.config.keeper_socket, &request).await {
        Ok(reply) if reply.ok => {
            gw.audit.record(Row::new(&account.name, Some(device), verb, "ok").resource(cli));
            (StatusCode::OK, Json(json!({ "ok": true }))).into_response()
        }
        Ok(reply) => {
            gw.audit.record(Row::new(&account.name, Some(device), verb, "failed").resource(cli));
            (StatusCode::BAD_GATEWAY, Json(json!({ "error": "keeper", "detail": reply.error }))).into_response()
        }
        Err(error) => {
            eprintln!("gateway: key keeper: {error}");
            gw.audit.record(Row::new(&account.name, Some(device), verb, "failed").resource(cli));
            api_error(StatusCode::BAD_GATEWAY, "keeper_unreachable")
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct DeliveryBody {
    broker: bool,
}

/// Deliver one CLI's key through the broker or directly (`PUT`, body
/// `{"broker": bool}`; plan §5.4, P5).
async fn agent_key_delivery(State(gw): State<Shared>, RoutePath(cli): RoutePath<String>, headers: HeaderMap, body: Bytes) -> Response {
    const VERB: &str = "agent-key-delivery";
    let (account, device) = match admin_for_key(&gw, &cli, &headers, VERB) {
        Ok(who) => who,
        Err(response) => return response,
    };
    let Ok(DeliveryBody { broker }) = serde_json::from_slice::<DeliveryBody>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    let request = keys_wire::Request::Delivery { cli: cli.clone(), broker, by: account.name.clone() };
    keeper_change(&gw, &account, &device, VERB, &cli, request).await
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct BudgetBody {
    #[serde(default)]
    user: Option<String>,
    tokens: Option<u64>,
}

/// A monthly budget in billed tokens for one user of a brokered key, or the
/// key's default (`PUT`, body `{"user"?: name, "tokens": n | null}`).
async fn agent_key_budget(State(gw): State<Shared>, RoutePath(cli): RoutePath<String>, headers: HeaderMap, body: Bytes) -> Response {
    const VERB: &str = "agent-key-budget";
    let (account, device) = match admin_for_key(&gw, &cli, &headers, VERB) {
        Ok(who) => who,
        Err(response) => return response,
    };
    let Ok(BudgetBody { user, tokens }) = serde_json::from_slice::<BudgetBody>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    if user.as_deref().is_some_and(|u| !wire::valid_account_name(u)) {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    }
    let request = keys_wire::Request::Budget { cli: cli.clone(), user, tokens, by: account.name.clone() };
    keeper_change(&gw, &account, &device, VERB, &cli, request).await
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct RenewBody {
    user: String,
}

/// Drop one user's broker token (`POST`, body `{"user": name}`): their
/// running agents are cut off at the next request, the key stays.
async fn agent_key_renew(State(gw): State<Shared>, RoutePath(cli): RoutePath<String>, headers: HeaderMap, body: Bytes) -> Response {
    const VERB: &str = "agent-key-token-renew";
    let (account, device) = match admin_for_key(&gw, &cli, &headers, VERB) {
        Ok(who) => who,
        Err(response) => return response,
    };
    let Ok(RenewBody { user }) = serde_json::from_slice::<RenewBody>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    if !wire::valid_account_name(&user) {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    }
    let request = keys_wire::Request::RenewToken { cli: cli.clone(), user, by: account.name.clone() };
    keeper_change(&gw, &account, &device, VERB, &cli, request).await
}

/// Per account, with no content: name, role, how many devices route, and
/// whether its daemon socket exists. Admins only. The socket is looked at,
/// never connected to: a connect is what socket activation starts a daemon
/// (and its tmux) on, and systemd's socket answers whether or not the
/// daemon runs.
async fn status(State(gw): State<Shared>, headers: HeaderMap) -> Response {
    let Some((account, _)) = gw.routed(&headers) else {
        return api_error(StatusCode::UNAUTHORIZED, "unauthenticated");
    };
    if account.role != Role::Admin {
        return api_error(StatusCode::FORBIDDEN, "admin");
    }
    let mut rows = Vec::new();
    for a in gw.db().accounts.iter() {
        let socket = std::fs::symlink_metadata(gw.socket_of(&a.name)).is_ok_and(|m| std::os::unix::fs::FileTypeExt::is_socket(&m.file_type()));
        rows.push(json!({ "name": a.name, "role": a.role.as_str(), "devices": a.devices.len(), "socket": if socket { "present" } else { "missing" } }));
    }
    (StatusCode::OK, [(header::CACHE_CONTROL, "no-store")], Json(json!({ "accounts": rows, "live_sockets": gw.live_count() }))).into_response()
}

async fn health() -> Response {
    Json(json!({ "ok": true })).into_response()
}

/// Only the public host is answered; the phone's headers on the gateway's own
/// responses (a forwarded answer already carries the daemon's).
async fn host_and_headers(State((gw, content)): State<(Shared, bool)>, mut request: Request, next: Next) -> Response {
    let want = if content { gw.config.content_origin.as_deref().map(crate::config::host_of) } else { Some(gw.config.public_host()) };
    let host = request.headers().get(header::HOST).and_then(|v| v.to_str().ok());
    if want.is_none() || host != want {
        return StatusCode::NOT_FOUND.into_response();
    }
    let peer = request
        .extensions()
        .get::<ConnectInfo<PeerAddr>>()
        .map(|c| c.0 .0)
        .or_else(|| request.extensions().get::<ConnectInfo<std::net::SocketAddr>>().map(|c| c.0));
    let forwarded = request.headers().get("x-forwarded-for").and_then(|v| v.to_str().ok());
    let source = Source(crate::rate::source_of(peer, forwarded));
    request.extensions_mut().insert(source);
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
        .route("/gateway/v1/oidc", get(oidc_info))
        .route("/gateway/v1/oidc/start", post(oidc_start))
        .route("/gateway/v1/oidc/callback", get(oidc_callback))
        .route("/gateway/v1/audit", get(own_audit))
        .route("/gateway/v1/policy", get(policy_get).put(policy_put))
        .route("/gateway/v1/status", get(status))
        .route("/gateway/v1/agent-keys", get(agent_keys_get))
        .route("/gateway/v1/agent-keys/{cli}", put(agent_key_put).delete(agent_key_delete))
        .route("/gateway/v1/agent-keys/{cli}/users", put(agent_key_users))
        .route("/gateway/v1/agent-keys/{cli}/delivery", put(agent_key_delivery))
        .route("/gateway/v1/agent-keys/{cli}/budget", put(agent_key_budget))
        .route("/gateway/v1/agent-keys/{cli}/renew-token", post(agent_key_renew))
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
            if let Err(error) = axum::serve(crate::limits::GuardedListener::with_capacity(content_listener, MAX_CONTENT_CONNECTIONS), app.into_make_service_with_connect_info::<PeerAddr>()).await {
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
    axum::serve(crate::limits::GuardedListener::with_capacity(listener, MAX_CONNECTIONS), router(gw).into_make_service_with_connect_info::<PeerAddr>()).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests;
