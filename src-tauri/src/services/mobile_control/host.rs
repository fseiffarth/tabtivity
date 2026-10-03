use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
    sync::{Arc, Mutex, PoisonError},
    time::{Duration, Instant},
};

use axum::{
    body::{Body, Bytes},
    extract::{ws::WebSocketUpgrade, DefaultBodyLimit, Path, Query, State},
    http::{header, HeaderMap, HeaderValue, Request, Response, StatusCode, Uri},
    middleware::{self, Next},
    response::IntoResponse,
    routing::{get, post, put},
    Json, Router,
};
use base64ct::{Base64UrlUnpadded, Encoding};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::services::desktop_images;
use crate::terminal::PtyOptions;

use super::{
    admin,
    alarms,
    auth::AuthStore,
    config::{verify_tailscale_serve, HostConfig},
    discovery::{shells_open, Catalog, CatalogCache, PublicTab, ResolvedTab, ScopeKind, TabPrompt, TabSchedules},
    files,
    headless,
    inbox,
    markup,
    outbox,
    limits,
    protocol::{
        clean_tab_color, git_dot, CalendarAction, CreateTabKind, CreateTabRequest, DesktopRequest, DesktopResponse,
        MailMarkAction, MobileCollectedPrompt, MobileMarkupFile, MobilePromptInput, MobileSchedule,
        MobileScheduleInput, PromptMutation, ScheduleMutation,
        TabPlace, TodoAction, MAX_CONTROL_MESSAGE, MAX_INPUT_FRAME, MAX_MAIL_REPLY_BYTES,
        MAX_TAB_LABEL,
    },
    pty_bridge::{self, TerminalRegistry},
    scheduler,
    push::{AgentTabRef, PushPrefs},
    sign_in,
    live_pwa, MOBILE_ASSETS,
};


/// Most prompts one agent tab publishes to the phone, and the most characters
/// of each. The phone's project overview draws every one of them under every
/// agent card on a 5s poll, so this is a list to read at a glance, not a
/// transcript — the Focus view is where the whole conversation lives.
const MAX_TAB_PROMPTS: usize = 5;
/// Longest composer prompt a phone reports as sent, in bytes. A prompt is typed
/// or dictated; a pasted log beyond this is still sent to the session, only
/// not recorded in its history.
const MAX_SENT_PROMPT: usize = 16 * 1024;
const MAX_TAB_PROMPT_CHARS: usize = 240;

/// The one page another page may frame: the sealed pdf.js frame the markup
/// view renders PDF pages in (`mobile-web/pdf-frame.html`). It is loaded as
/// `<iframe sandbox="allow-scripts">` — an opaque origin with no cookie, no
/// storage and no API — and its own policy lets it run its script and draw,
/// and nothing else: no network, no forms, framed only by the PWA itself.
const PDF_FRAME_PATH: &str = "/pdf-frame.html";

const MOBILE_PERMISSIONS_POLICY: &str =
    "camera=(), microphone=(self), on-device-speech-recognition=(self), geolocation=(), payment=(), usb=()";

#[derive(Clone)]
struct HostState {
    config: HostConfig,
    auth: Arc<Mutex<AuthStore>>,
    catalog: Arc<Mutex<CatalogCache>>,
    terminal_registry: TerminalRegistry,
    /// How a tab is started with no window (headless owner plan, H1b).
    spawner: HeadlessSpawner,
    /// The headless git dots and agent readings, per project, so the phone's
    /// polls cost a git spawn or a transcript walk once per `READING_TTL`.
    readings: Arc<Mutex<headless::ReadingCache>>,
    /// The owner's reach into the tmux server with no window (headless owner
    /// plan, H3): a phone's prompt, undo and close type into or end the tab's
    /// session through it. Production is `scheduler::TmuxRunner` on the
    /// default socket; a test swaps in a recorder.
    runner: Arc<dyn scheduler::Runner>,
    /// The phone prompts the owner holds with no window, which the
    /// scheduler types into the CLI's queue at once (`scheduler::PhoneHolds`).
    holds: Arc<scheduler::PhoneHolds>,
}

/// The owner's spawn seam (headless owner plan, H1b): `launch` starts a
/// prepared tab detached under its tmux name, `installed` says which agent
/// CLIs the ＋ sheet may offer. Production is `launch_prep::prepare` plus
/// `tmux_local::spawn_detached_with` on the default tmux server — the same
/// launch assembly and the same server the window uses, so the window later
/// attaches to what the sidecar started — and the registry's install probe.
/// A test swaps in a recorder.
#[derive(Clone)]
struct HeadlessSpawner {
    launch: headless::HeadlessLaunch,
    installed: Arc<dyn Fn(&str) -> bool + Send + Sync>,
}

impl Default for HeadlessSpawner {
    fn default() -> Self {
        Self {
            launch: Arc::new(|opts: PtyOptions| {
                Box::pin(async move {
                    let prepared = crate::services::launch_prep::prepare(opts, None, None).await?;
                    #[cfg(unix)]
                    {
                        crate::services::tmux_local::spawn_detached_with(&prepared.opts, None)?;
                        prepared.commit();
                        Ok(())
                    }
                    #[cfg(not(unix))]
                    {
                        let _ = prepared;
                        Err("a tab with no window needs tmux, which this platform has none of".to_string())
                    }
                })
            }),
            installed: Arc::new(crate::commands::agents::binary_is_installed),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PairBody {
    code: String,
    device_name: String,
    public_key: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ChallengeBody {
    device_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionBody {
    device_id: String,
    nonce: String,
    signature: String,
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct ProjectQuery {
    view: Option<String>,
    q: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct MailQuery {
    offset: Option<u32>,
}

/// Body of a mail flag write. `offset` names the folder page that issued the
/// opaque message id, exactly as the read routes take it in the query.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MailMarkBody {
    action: MailMarkAction,
    #[serde(default)]
    offset: u32,
}

/// Body of a phone reply: the text and nothing else. Recipient, subject and
/// threading are the desktop's to derive from the original message.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MailReplyBody {
    body: String,
    #[serde(default)]
    offset: u32,
}

/// Body of an alert row's ✓. The opaque row handle and nothing else: what the
/// row *is* — mail, meeting or card — and what resolving it does are the
/// desktop's, not the sidecar's, so there is no action to name here.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AlertResolveBody {
    alert_id: String,
}

/// A phone's Web Push subscription: `PushSubscription.toJSON()`'s endpoint and
/// keys, and what the phone wants to be told (`push::PushPrefs`).
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PushBody {
    endpoint: String,
    p256dh: String,
    auth: String,
    #[serde(flatten)]
    prefs: PushPrefs,
}

/// A same-origin URL the phone is about to open outside the app.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OpenTicketBody {
    url: String,
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct CalendarQuery {
    month: Option<String>,
}

fn api_error(status: StatusCode, code: &str) -> (StatusCode, Json<serde_json::Value>) {
    (status, Json(json!({ "error": code })))
}

fn exact_origin(headers: &HeaderMap, state: &HostState) -> bool {
    headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) == Some(state.config.origin.as_str())
}

fn cookie_token(headers: &HeaderMap) -> Option<&str> {
    session_cookie_in(&crate::brand::PAIR, headers.get(header::COOKIE)?.to_str().ok()?)
}

/// The session token in a `Cookie` header: the cookie under its current name,
/// else under the name an older build's host set (counted as a legacy hit).
fn session_cookie_in<'a>(pair: &crate::brand::Pair, cookies: &'a str) -> Option<&'a str> {
    let named = |wanted: &str| {
        cookies.split(';').find_map(|part| {
            let (name, value) = part.trim().split_once('=')?;
            (name == wanted).then_some(value)
        })
    };
    if let Some(token) = named(&pair.cur(crate::brand::Name::SESSION_COOKIE)) {
        return Some(token);
    }
    let token = named(&pair.legacy(crate::brand::Name::SESSION_COOKIE)?)?;
    crate::brand::legacy_hit("session-cookie");
    Some(token)
}

/// The terminal subprotocol to answer a WebSocket upgrade with, given what
/// the client offered: the current one, else the one an older build of the
/// phone app still offers (counted as a legacy hit). A phone keeps running
/// its cached app until the service worker has updated.
fn terminal_protocol_in(pair: &crate::brand::Pair, offered: &str) -> Option<String> {
    let offers = |wanted: &str| offered.split(',').any(|v| v.trim() == wanted);
    let current = pair.cur(crate::brand::Name::TERMINAL_PROTOCOL);
    if offers(&current) {
        return Some(current);
    }
    let old = pair.legacy(crate::brand::Name::TERMINAL_PROTOCOL)?;
    if !offers(&old) {
        return None;
    }
    crate::brand::legacy_hit("terminal-protocol");
    Some(old)
}

fn authenticate(
    headers: &HeaderMap,
    state: &HostState,
) -> Result<String, (StatusCode, Json<serde_json::Value>)> {
    let token = cookie_token(headers)
        .ok_or_else(|| api_error(StatusCode::UNAUTHORIZED, "authentication_required"))?;
    state
        .auth
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        // Every authenticated request slides the session (`auth::SESSION_IDLE`).
        .touch(token)
        .ok_or_else(|| api_error(StatusCode::UNAUTHORIZED, "authentication_required"))
}

/// What an open ticket is bound to: the path and the query without its own
/// `ticket` pair, in the order the phone wrote them.
fn ticket_target(uri: &Uri) -> String {
    let query: Vec<&str> = uri
        .query()
        .unwrap_or_default()
        .split('&')
        .filter(|pair| !pair.is_empty() && !pair.starts_with("ticket="))
        .collect();
    if query.is_empty() {
        uri.path().to_string()
    } else {
        format!("{}?{}", uri.path(), query.join("&"))
    }
}

/// `authenticate`, or — for a file's bytes, which the phone opens in the
/// browser's own tab where the strict cookie does not follow — an open ticket
/// in the query that was issued for exactly this URL.
fn authenticate_or_ticket(
    headers: &HeaderMap,
    state: &HostState,
    uri: &Uri,
) -> Result<String, (StatusCode, Json<serde_json::Value>)> {
    let cookie = authenticate(headers, state);
    if cookie.is_ok() {
        return cookie;
    }
    let ticket = uri
        .query()
        .unwrap_or_default()
        .split('&')
        .find_map(|pair| pair.strip_prefix("ticket="));
    match ticket {
        Some(ticket) => state
            .auth
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .redeem_ticket(ticket, &ticket_target(uri))
            .ok_or_else(|| api_error(StatusCode::UNAUTHORIZED, "authentication_required")),
        None => cookie,
    }
}

/// `POST /api/v1/open-ticket` `{ url }` — the same URL with a short-lived
/// `ticket` added (`AuthStore::open_ticket`), for the phone to open a PDF in
/// the browser's viewer. Only the file routes that call
/// `authenticate_or_ticket` honour it.
async fn open_ticket(
    State(state): State<HostState>,
    headers: HeaderMap,
    Json(body): Json<OpenTicketBody>,
) -> impl IntoResponse {
    if let Err(error) = mutation_guard(&headers, &state) {
        return error;
    }
    let Some(token) = cookie_token(&headers) else {
        return api_error(StatusCode::UNAUTHORIZED, "authentication_required");
    };
    let uri = match body.url.parse::<Uri>() {
        Ok(uri) if uri.scheme().is_none() && uri.authority().is_none() && uri.path().starts_with("/api/v1/") => uri,
        _ => return api_error(StatusCode::BAD_REQUEST, "invalid_url"),
    };
    let target = ticket_target(&uri);
    match state.auth.lock().unwrap_or_else(PoisonError::into_inner).open_ticket(token, &target) {
        Ok(ticket) => {
            let joiner = if target.contains('?') { '&' } else { '?' };
            (StatusCode::OK, Json(json!({ "url": format!("{target}{joiner}ticket={ticket}") })))
        }
        Err(_) => api_error(StatusCode::UNAUTHORIZED, "authentication_required"),
    }
}

/// Run a catalog read without holding an async worker for it. A read past the
/// TTL forks `tmux ls` (bounded by `discovery::TMUX_LS_TIMEOUT`, but seconds
/// against a hung tmux server) and every other read waits on the catalog mutex
/// behind it; done inline on the workers, a few such requests parked all of
/// them and the sidecar stopped answering anything — pings and terminal output
/// included. `block_in_place` hands this worker's other tasks to a fresh one
/// first. It is only legal on the multi-threaded runtime the sidecar runs on;
/// anywhere else (the current-thread runtime of a test) the read runs inline.
fn off_worker<T>(read: impl FnOnce() -> T) -> T {
    match tokio::runtime::Handle::try_current() {
        Ok(handle) if handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread => {
            tokio::task::block_in_place(read)
        }
        _ => read(),
    }
}

fn catalog(state: &HostState) -> Result<Catalog, (StatusCode, Json<serde_json::Value>)> {
    let key = state.auth.lock().unwrap_or_else(PoisonError::into_inner).host_key().to_vec();
    off_worker(|| {
        state
            .catalog
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .load(&state.config.state_dir, &key)
    })
    .map_err(|_| api_error(StatusCode::SERVICE_UNAVAILABLE, "catalog_unavailable"))
}

/// The create-tab poll is waiting for a tab the desktop has just been asked to
/// open, so by definition it is not in the cached snapshot yet.
fn catalog_fresh(state: &HostState) -> Result<Catalog, (StatusCode, Json<serde_json::Value>)> {
    let key = state.auth.lock().unwrap_or_else(PoisonError::into_inner).host_key().to_vec();
    off_worker(|| {
        state
            .catalog
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .load_fresh(&state.config.state_dir, &key)
    })
    .map_err(|_| api_error(StatusCode::SERVICE_UNAVAILABLE, "catalog_unavailable"))
}

/// The host key the desktop mints its opaque ids with — the same
/// `mobile-control/host.key` — so an id minted here resolves there.
fn host_key(state: &HostState) -> Vec<u8> {
    state.auth.lock().unwrap_or_else(PoisonError::into_inner).host_key().to_vec()
}

/// Whether a desktop answer means no window is open: the persisted-state
/// kinds are then answered from the state dir instead (`headless`, headless
/// owner plan H0). A desktop that answered anything else — including its
/// own error — is present, and its answer stands.
fn desktop_down(response: &Result<DesktopResponse, String>) -> bool {
    match response {
        Err(_) => true,
        Ok(DesktopResponse::Error { code, .. }) => code == "desktop_unavailable",
        Ok(_) => false,
    }
}

/// The scope's state-dir session file, which the headless tab edits lock.
fn scope_session_file(state: &HostState, raw_id: &str) -> PathBuf {
    headless::session_file(&state.config.state_dir, raw_id)
}

/// Milliseconds since the epoch, the desktop's close stamp.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A tab edit applied to the session file because no window was open to
/// apply it to a store (headless owner plan, H3): the catalog is re-read so
/// the answer is the row as stored, as the desktop path answers it.
fn headless_tab_edit(
    state: &HostState,
    raw_id: &str,
    tab_id: &str,
    tmux_session: &str,
    edited: Result<crate::schema::session::TerminalSession, String>,
    fallback: serde_json::Value,
) -> (StatusCode, Json<serde_json::Value>) {
    match edited {
        Ok(_) => {
            catalog_stale(state);
            poke_window(state, Some(raw_id), &["workspace"]);
            let row = catalog_fresh(state)
                .ok()
                .and_then(|next| next.tab(tab_id).map(|(_, tab)| tab.public.clone()));
            match row {
                Some(mut row) => {
                    row.viewer_busy = state.terminal_registry.is_busy(tmux_session);
                    (StatusCode::OK, Json(json!({ "tab": row, "desktop_available": false })))
                }
                None => {
                    let mut answer = fallback;
                    answer["desktop_available"] = json!(false);
                    (StatusCode::OK, Json(answer))
                }
            }
        }
        Err(code) => headless_tab_error(&code),
    }
}

fn headless_tab_error(code: &str) -> (StatusCode, Json<serde_json::Value>) {
    if code == crate::services::workspace::TAB_NOT_FOUND {
        api_error(StatusCode::NOT_FOUND, "tab_not_found")
    } else {
        eprintln!("mobile: a tab edit with no window failed: {code}");
        api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable")
    }
}

/// Tell a window — should one be open after all — that the owner wrote a
/// slice behind its back (headless owner plan, H3). The owner only writes
/// when the desktop did not answer, so this normally reaches nothing; it is
/// the net for a window that was wedged past its deadline and recovered.
/// Fire-and-forget, never awaited by the phone's request.
fn poke_window(state: &HostState, raw_id: Option<&str>, slices: &[&str]) {
    let socket = state.config.control_dir.join("desktop-control.sock");
    let request = DesktopRequest::Refresh {
        request_id: Base64UrlUnpadded::encode_string(&random_16()),
        project_id: raw_id.map(str::to_string),
        slices: slices.iter().map(|s| s.to_string()).collect(),
    };
    tokio::spawn(async move {
        let _ = admin::desktop_call(&socket, &request).await;
    });
}

/// A project's git dot with no window (`headless::git_dot_for`), cached per
/// project for `READING_TTL`; the probe runs off the async thread.
async fn headless_git_dot(state: &HostState, raw_id: &str, root: &std::path::Path) -> Option<&'static str> {
    let now = Instant::now();
    if let Some(dot) = state.readings.lock().unwrap_or_else(PoisonError::into_inner).git(raw_id, now) {
        return dot;
    }
    let dir = root.to_path_buf();
    let dot = tokio::task::spawn_blocking(move || headless::git_dot_for(&dir)).await.ok().flatten();
    state.readings.lock().unwrap_or_else(PoisonError::into_inner).set_git(raw_id, dot, Instant::now());
    dot
}

/// A project's agent readings with no window, from the cache while fresh.
fn headless_readings(state: &HostState, project: &super::discovery::ResolvedProject) -> headless::TurnReadings {
    state
        .readings
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .readings(&state.config.state_dir, project, Instant::now())
}

/// Today as the desktop-local `YYYY-MM-DD` the board's date columns read.
fn local_today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

/// Drop the cached catalog after a change the desktop has already written to
/// disk, so the next read cannot answer from before it.
fn catalog_stale(state: &HostState) {
    state
        .catalog
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .invalidate();
}

async fn security_headers(request: Request<Body>, next: Next) -> Response<Body> {
    let sensitive = request.uri().path().starts_with("/api/") || request.uri().path() == "/healthz";
    let frame = request.uri().path() == PDF_FRAME_PATH;
    let mut response = next.run(request).await;
    // The sealed frame answers its own framing rules (`pdf_frame`); a miss
    // there falls back to everyone else's.
    let framed = frame && response.status() == StatusCode::OK;
    let headers = response.headers_mut();
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    if !framed {
        headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    }
    headers.insert(
        header::STRICT_TRANSPORT_SECURITY,
        HeaderValue::from_static("max-age=31536000"),
    );
    if sensitive {
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    headers.insert(
        "permissions-policy",
        HeaderValue::from_static(MOBILE_PERMISSIONS_POLICY),
    );
    if !framed {
        headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"));
    }
    response
}

/// The sealed frame's policy. Inside a sandbox the document's origin is
/// opaque, and whether `'self'` still matches the server it came from differs
/// between engines — so the server is also named outright, from the `Host`
/// the request came in on (a host name, nothing else, or it is left out).
fn pdf_frame_policy(host: Option<&HeaderValue>) -> String {
    let named = host
        .and_then(|value| value.to_str().ok())
        .filter(|host| {
            !host.is_empty()
                && host.len() <= 255
                && host.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b':'))
        })
        .map(|host| format!(" https://{host}"))
        .unwrap_or_default();
    format!(
        "default-src 'none'; script-src 'self'{named}; style-src 'unsafe-inline'; img-src blob: data:; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'{named}"
    )
}

/// `GET /pdf-frame.html` — the sealed frame (`PDF_FRAME_PATH`), with its own
/// framing rules. Only the frame's own bytes: a bundle without it is a 404,
/// never the app shell under a framable policy.
async fn pdf_frame(headers: HeaderMap) -> Response<Body> {
    let found = match live_pwa::current() {
        Some(live) => live.get(PDF_FRAME_PATH),
        None => MOBILE_ASSETS
            .iter()
            .find(|(asset, _, _)| *asset == PDF_FRAME_PATH)
            .map(|(_, bytes, mime)| (bytes::Bytes::from_static(bytes), *mime)),
    };
    let Some((bytes, mime)) = found else {
        return StatusCode::NOT_FOUND.into_response();
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::X_FRAME_OPTIONS, "SAMEORIGIN")
        .header(header::CONTENT_SECURITY_POLICY, pdf_frame_policy(headers.get(header::HOST)))
        .body(Body::from(bytes))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

async fn health() -> impl IntoResponse {
    Json(json!({ "ok": true }))
}

async fn pair(
    State(state): State<HostState>,
    headers: HeaderMap,
    Json(body): Json<PairBody>,
) -> impl IntoResponse {
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    match state
        .auth
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .pair(&body.code, &body.device_name, &body.public_key)
    {
        Ok(device_id) => (StatusCode::CREATED, Json(json!({ "device_id": device_id }))),
        Err(code) => api_error(StatusCode::BAD_REQUEST, &code),
    }
}

async fn challenge(
    State(state): State<HostState>,
    headers: HeaderMap,
    Json(body): Json<ChallengeBody>,
) -> impl IntoResponse {
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    match state.auth.lock().unwrap_or_else(PoisonError::into_inner).challenge(&body.device_id) {
        Ok((nonce, payload, expires_at)) => (
            StatusCode::OK,
            Json(json!({ "nonce": nonce, "payload": payload, "expires_at": expires_at })),
        ),
        Err(code) => api_error(StatusCode::BAD_REQUEST, &code),
    }
}

async fn login(
    State(state): State<HostState>,
    headers: HeaderMap,
    Json(body): Json<SessionBody>,
) -> Response<Body> {
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin").into_response();
    }
    match state
        .auth
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .login(&body.device_id, &body.nonce, &body.signature)
    {
        Ok((token, expires_at)) => {
            let mut response =
                Json(json!({ "ok": true, "expires_at": expires_at })).into_response();
            let cookie = format!("{}={token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=43200", crate::brand::SESSION_COOKIE);
            response
                .headers_mut()
                .insert(header::SET_COOKIE, HeaderValue::from_str(&cookie).unwrap());
            response
        }
        Err(code) => api_error(StatusCode::UNAUTHORIZED, &code).into_response(),
    }
}

async fn logout(State(state): State<HostState>, headers: HeaderMap) -> Response<Body> {
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin").into_response();
    }
    if let Some(token) = cookie_token(&headers) {
        state.auth.lock().unwrap_or_else(PoisonError::into_inner).logout(token);
    }
    let mut response = Json(json!({ "ok": true })).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_static(
            concat!("__Host-", crate::app_slug!(), "_session=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0"),
        ),
    );
    // A cookie an older build's host set is expired as well; there is none
    // to name while the name is unchanged.
    if let Some(old) = crate::brand::PAIR.legacy(crate::brand::Name::SESSION_COOKIE) {
        if let Ok(expired) =
            HeaderValue::from_str(&format!("{old}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0"))
        {
            response.headers_mut().append(header::SET_COOKIE, expired);
        }
    }
    response
}

async fn status(State(state): State<HostState>, headers: HeaderMap) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    // A live probe, not a file check: the socket file outlives a desktop exit
    // (and every crash), and on Windows the nominal path is never a file.
    let desktop_available =
        admin::desktop_reachable(&state.config.control_dir.join("desktop-control.sock")).await;
    let settings = std::fs::read(state.config.state_dir.join("settings.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
    let show_untested_tags = settings
        .as_ref()
        .and_then(|settings| settings.get("show_untested_tags").and_then(|value| value.as_bool()))
        .unwrap_or(false);
    // The desktop's theme, for a phone that follows it. Only a short plain
    // name crosses: the phone checks it against the themes it knows.
    let color_scheme = settings
        .as_ref()
        .and_then(|settings| settings.get("color_scheme").and_then(|value| value.as_str()))
        .filter(|scheme| scheme.len() <= 32 && scheme.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'))
        .unwrap_or("light_lavender")
        .to_string();
    (
        StatusCode::OK,
        Json(
            json!({ "desktop_available": desktop_available, "host": state.config.host.display_name, "show_untested_tags": show_untested_tags, "color_scheme": color_scheme }),
        ),
    )
}

async fn projects(
    State(state): State<HostState>,
    headers: HeaderMap,
    Query(query): Query<ProjectQuery>,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    let Ok(catalog) = catalog(&state) else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "catalog_unavailable");
    };
    let q = query.q.unwrap_or_default();
    if q.len() > 80 {
        return api_error(StatusCode::BAD_REQUEST, "query_too_long");
    }
    let q = q.to_lowercase();
    let view = query.view.as_deref().unwrap_or("active");
    if view != "active" && view != "search" {
        return api_error(StatusCode::BAD_REQUEST, "invalid_view");
    }
    let listed = catalog
        .projects
        .into_iter()
        .filter(|p| {
            if view == "search" {
                !q.is_empty() && p.public.label.to_lowercase().contains(&q)
            } else {
                p.public.live_sessions > 0
                    || p.public.status == "current"
                    || p.public.status == "active"
            }
        })
        .collect::<Vec<_>>();
    // Each row's git dot, from the desktop's own pills. Only asked when a
    // project is listed; a closed or older desktop leaves every row without one.
    let git = if listed.iter().any(|p| p.public.kind == ScopeKind::Project) {
        let desktop_socket = state.config.control_dir.join("desktop-control.sock");
        let request_id = Base64UrlUnpadded::encode_string(&random_16());
        match admin::desktop_call(&desktop_socket, &DesktopRequest::GitStates { request_id }).await {
            Ok(DesktopResponse::GitStates { states }) => states
                .into_iter()
                .filter_map(|row| git_dot(&row.state).map(|dot| (row.project_id, dot)))
                .collect::<HashMap<_, _>>(),
            // No window: probe the dots here (headless owner plan, H1b).
            response if desktop_down(&response) => {
                let mut dots = HashMap::new();
                for p in listed.iter().filter(|p| p.public.kind == ScopeKind::Project) {
                    if let Some(dot) = headless_git_dot(&state, &p.raw_id, &p.root).await {
                        dots.insert(p.raw_id.clone(), dot);
                    }
                }
                dots
            }
            _ => HashMap::new(),
        }
    } else {
        HashMap::new()
    };
    let mut rows = listed
        .into_iter()
        .map(|p| {
            let mut public = p.public;
            if public.kind == ScopeKind::Project {
                public.git = git.get(&p.raw_id).copied();
            }
            public
        })
        .collect::<Vec<_>>();
    rows.sort_by_key(|p| {
        (
            std::cmp::Reverse(p.live_sessions > 0),
            std::cmp::Reverse(p.last_activity.unwrap_or(0)),
            p.label.to_lowercase(),
        )
    });
    (StatusCode::OK, Json(json!({ "projects": rows })))
}

/// One agent tab of any project, the way the phone's cross-project activity
/// list needs it: the ordinary tab row, plus the project it lives in. The list
/// is flat by design — a label on its own would not say where a session is —
/// and both project fields are the same opaque id and display label the project
/// list already publishes.
#[derive(Serialize)]
struct ActivityRow {
    #[serde(flatten)]
    tab: PublicTab,
    project_id: String,
    project_label: String,
}

/// Where a status sorts in the activity list. A session waiting on a decision is
/// blocked on the reader and comes first; a finished or interrupted one is the
/// least urgent. Anything else never reaches this list.
fn activity_rank(status: &str) -> u8 {
    match status {
        "question" => 0,
        "working" => 1,
        _ => 2,
    }
}

/// `GET /api/v1/activity` — every agent tab the desktop reports as working,
/// waiting on a decision, or done, across every project this phone may reach,
/// in one flat list. One desktop round trip serves the whole list: a per-project
/// `Catalog` call would be one round trip per project on every poll.
async fn activity(State(state): State<HostState>, headers: HeaderMap) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    let Ok(catalog_snapshot) = catalog(&state) else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "catalog_unavailable");
    };
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    let (desktop_available, statuses, prompts) = match admin::desktop_call(
        &desktop_socket,
        &DesktopRequest::Activity { request_id },
    )
    .await
    {
        Ok(DesktopResponse::Activity { statuses, prompts }) => (true, statuses, prompts),
        // No window: the hooks' turn records and the tabs' transcripts
        // (headless owner plan, H1b).
        response if desktop_down(&response) => {
            let readings = headless::activity(&state.config.state_dir, &catalog_snapshot);
            (false, readings.statuses, readings.prompts)
        }
        _ => (false, vec![], vec![]),
    };
    // Tmux session names are unique across the whole server, so one map covers
    // every project's tabs.
    let statuses = statuses
        .into_iter()
        .map(|status| (status.tmux_session.clone(), status))
        .collect::<HashMap<_, _>>();
    let mut prompts = prompt_rows(prompts);
    let mut rows = Vec::new();
    for project in &catalog_snapshot.projects {
        for resolved in &project.tabs {
            if resolved.public.kind != "agent" {
                continue;
            }
            let Some(status) = statuses.get(&resolved.tmux_name) else {
                continue;
            };
            let mut tab = resolved.public.clone();
            tab.agent_status = Some(status.status.clone());
            tab.agent_model = status.model.clone();
            tab.agent_plan = status.plan;
            tab.agent_goal = status.goal;
            tab.agent_subagents = status.subagents;
            tab.working_at = status.working_at;
            tab.done_at = status.done_at;
            tab.viewer_busy = state.terminal_registry.is_busy(&resolved.tmux_name);
            tab.prompts = prompts.remove(&resolved.tmux_name).unwrap_or_default();
            rows.push(ActivityRow {
                tab,
                project_id: project.public.id.clone(),
                project_label: project.public.label.clone(),
            });
        }
    }
    rows.sort_by(|a, b| {
        activity_rank(a.tab.agent_status.as_deref().unwrap_or_default())
            .cmp(&activity_rank(
                b.tab.agent_status.as_deref().unwrap_or_default(),
            ))
            .then(b.tab.last_activity.cmp(&a.tab.last_activity))
            .then(a.tab.label.to_lowercase().cmp(&b.tab.label.to_lowercase()))
    });
    (
        StatusCode::OK,
        Json(json!({ "tabs": rows, "desktop_available": desktop_available })),
    )
}

async fn project(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    let Ok(catalog_snapshot) = catalog(&state) else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "catalog_unavailable");
    };
    let Some(project) = catalog_snapshot.project(&project_id) else {
        return api_error(StatusCode::NOT_FOUND, "project_not_found");
    };
    let mut tabs = project
        .tabs
        .iter()
        .map(|t| {
            let mut row = t.public.clone();
            row.viewer_busy = state.terminal_registry.is_busy(&t.tmux_name);
            row
        })
        .collect::<Vec<_>>();
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    // `desktop_available` is whether the desktop *answered*, not whether its
    // socket file exists: that file outlives an exit (and every crash), so the
    // phone was told the desktop was there for as long as it stayed closed —
    // and on Windows the nominal path is never a file, so it was never told.
    // A closed desktop refuses the connect at once, on both.
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    let (desktop_available, agents, statuses, schedules, prompts, timings, closed, git) = match admin::desktop_call(
        &desktop_socket,
        &DesktopRequest::Catalog {
            request_id,
            project_id: Some(project.raw_id.clone()),
        },
    )
    .await
    {
        Ok(DesktopResponse::Catalog {
            agents,
            statuses,
            schedules,
            prompts,
            timings,
            closed,
            git,
        }) => (true, agents, statuses, schedules, prompts, timings, closed, git),
        // No window: the same rows off the state dir (headless owner plan,
        // H1b); the closed row is what the owner closed (H3).
        response if desktop_down(&response) => {
            let state_dir = &state.config.state_dir;
            let agents = headless::agents(state_dir, &host_key(&state), &*state.spawner.installed)
                .into_iter()
                .map(|choice| choice.public)
                .collect();
            let readings = headless_readings(&state, project);
            let schedules = headless::schedule_summaries(state_dir, &project.raw_id, &project.tabs, chrono::Local::now());
            let git = if project.public.kind == ScopeKind::Project {
                headless_git_dot(&state, &project.raw_id, &project.root).await.map(str::to_string)
            } else {
                None
            };
            let closed = headless::closed_tabs(state_dir, &project.raw_id);
            (false, agents, readings.statuses, schedules, readings.prompts, readings.timings, closed, git)
        }
        _ => (false, vec![], vec![], vec![], vec![], vec![], vec![], None),
    };
    let mut public = project.public.clone();
    if public.kind == ScopeKind::Project {
        public.git = git.as_deref().and_then(git_dot);
    }
    let closed = closed_tab_rows(closed);
    let mut timings = timings
        .into_iter()
        .map(|timing| (timing.tmux_session.clone(), timing))
        .collect::<HashMap<_, _>>();
    let statuses = statuses
        .into_iter()
        .map(|status| (status.tmux_session.clone(), status))
        .collect::<HashMap<_, _>>();
    let mut schedules = schedules
        .into_iter()
        .map(|row| {
            (
                row.tmux_session,
                TabSchedules {
                    total: row.total,
                    enabled: row.enabled,
                    next: row.next,
                    upcoming: row
                        .upcoming
                        .into_iter()
                        .map(|prompt| TabPrompt {
                            text: prompt.text,
                            at: prompt.at,
                        })
                        .collect(),
                },
            )
        })
        .collect::<HashMap<_, _>>();
    let mut prompts = prompt_rows(prompts);
    for (tab, resolved) in tabs.iter_mut().zip(&project.tabs) {
        if tab.kind == "agent" {
            if let Some(status) = statuses.get(&resolved.tmux_name) {
                tab.agent_status = Some(status.status.clone());
                tab.agent_model = status.model.clone();
                tab.agent_plan = status.plan;
                tab.agent_goal = status.goal;
                tab.agent_subagents = status.subagents;
                tab.working_at = status.working_at;
                tab.done_at = status.done_at;
            } else if let Some(timing) = timings.remove(&resolved.tmux_name) {
                // A read turn has no status, but it still sorts by when it ran
                // and still names its model.
                tab.agent_model = timing.model;
                tab.agent_plan = timing.plan;
                tab.agent_goal = timing.goal;
                tab.agent_subagents = timing.subagents;
                tab.working_at = timing.working_at;
                tab.done_at = timing.done_at;
            }
            tab.schedules = schedules.remove(&resolved.tmux_name);
            // Published whether or not the tab has a status: a quiet session's
            // last prompt is the reading its card exists to carry.
            tab.prompts = prompts.remove(&resolved.tmux_name).unwrap_or_default();
        }
    }
    (
        StatusCode::OK,
        Json(
            json!({ "project": public, "tabs": tabs, "desktop_available": desktop_available, "agents": agents, "closed": closed,
                // Whether this project's 📁 answers (`files.rs`): the host-wide
                // switch, and a project rather than a box or the root console.
                "files": project.public.kind == ScopeKind::Project && files::files_open(&state.config.state_dir),
                // Whether the phone may offer a new shell (`shells_open`).
                "shells": shells_open(&state.config.state_dir) }),
        ),
    )
}

/// Most closed agent tabs one project lists for a reopen — the desktop keeps
/// ten; the phone's row shows a handful.
const MAX_CLOSED_TABS: usize = 10;

/// A closed tab's opaque id as the desktop mints it (a UUID): short and plain,
/// so it can be echoed back in a reopen without widening what a phone sends.
fn closed_tab_id_ok(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// The desktop's closed-tab rows, bounded again on the way out like the prompt
/// rows below: at most `MAX_CLOSED_TABS`, ids of the minted shape only, labels
/// and agent names cut to what a tab label may be.
fn closed_tab_rows(rows: Vec<super::protocol::ClosedAgentTab>) -> Vec<serde_json::Value> {
    rows.into_iter()
        .filter(|row| closed_tab_id_ok(&row.id))
        .take(MAX_CLOSED_TABS)
        .map(|row| {
            let clean = |text: &str| -> String {
                text.chars().filter(|c| !c.is_control()).take(MAX_TAB_LABEL).collect()
            };
            json!({
                "id": row.id,
                "label": clean(&row.label),
                "agent": clean(&row.agent),
                "closed_at": row.closed_at,
            })
        })
        .collect()
}

/// The desktop's per-tab prompt rows, keyed by tmux name and bounded again on
/// the way out. The desktop already caps both the count and the length, but
/// this is the browser boundary and the far side is somebody else's build: the
/// caps are re-applied here so a desktop one version ahead cannot widen what
/// reaches the phone.
fn prompt_rows(rows: Vec<super::protocol::AgentTabPrompts>) -> HashMap<String, Vec<TabPrompt>> {
    rows.into_iter()
        .map(|row| {
            let prompts = row
                .prompts
                .into_iter()
                .rev()
                .take(MAX_TAB_PROMPTS)
                .map(|prompt| TabPrompt {
                    text: prompt.text.chars().take(MAX_TAB_PROMPT_CHARS).collect(),
                    at: prompt.at,
                })
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            (row.tmux_session, prompts)
        })
        .collect()
}

fn random_16() -> [u8; 16] {
    let mut bytes = [0; 16];
    let _ = getrandom::fill(&mut bytes);
    bytes
}

async fn create_tab(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
    body: Bytes,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    // Parsed only after the request is authenticated and same-origin: as a
    // `Json<T>` extractor this ran first, so an unauthenticated caller got a
    // 422 naming the fields of the desktop-bridge protocol.
    let Ok(mut request) = serde_json::from_slice::<CreateTabRequest>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    // `like_tab` names a tmux session, which only the sidecar may: the tab
    // route below sets it from an opaque tab id.
    if request.project_id != project_id
        || request.idempotency_key.len() < 16
        || request.idempotency_key.len() > 128
        || request.like_tab.is_some()
        || !request.launch_shape_ok()
    {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    }
    // The catalog would never list the new shell, so the create would only
    // time out after leaving an unreachable tab on the desktop.
    if matches!(request.kind, CreateTabKind::Shell) && !shells_open(&state.config.state_dir) {
        return api_error(StatusCode::FORBIDDEN, "shells_off");
    }
    let Ok(catalog_snapshot) = catalog(&state) else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "catalog_unavailable");
    };
    let Some(project) = catalog_snapshot.project(&project_id) else {
        return api_error(StatusCode::NOT_FOUND, "project_not_found");
    };
    request.project_id = project.raw_id.clone();
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let response = admin::desktop_call(&desktop_socket, &DesktopRequest::Create { request_id, request: request.clone() }).await;
    if desktop_down(&response) {
        // No window: the owner mints and starts the tab (headless owner
        // plan, H1b); the window attaches to it when it next opens.
        return create_headless(&state, &project_id, &request).await;
    }
    answer_created(&state, &project_id, response).await
}

/// A create answered by the owner with no window: `headless::create_tab`
/// through the host's spawn seam, then the new row once the catalog lists
/// it (not `available` — no window is attached, and in a test no tmux
/// server runs — so the row is read straight from the session file).
async fn create_headless(
    state: &HostState,
    project_id: &str,
    request: &CreateTabRequest,
) -> (StatusCode, Json<serde_json::Value>) {
    let Ok(snapshot) = catalog(state) else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "catalog_unavailable");
    };
    let Some(project) = snapshot.project(project_id) else {
        return api_error(StatusCode::NOT_FOUND, "project_not_found");
    };
    let state_dir = &state.config.state_dir;
    let agents = headless::agents(state_dir, &host_key(state), &*state.spawner.installed);
    let created = headless::create_tab(state_dir, &host_key(state), project, request, &agents, &state.spawner.launch).await;
    match created {
        Ok(created) => {
            poke_window(state, Some(&project.raw_id), &["workspace"]);
            answer_headless_created(state, project_id, &created).await
        }
        Err(refusal) => headless_create_error(refusal),
    }
}

/// The new row once the catalog lists a tab the owner just minted and
/// started (a create or a reopen with no window).
async fn answer_headless_created(
    state: &HostState,
    project_id: &str,
    created: &headless::HeadlessCreated,
) -> (StatusCode, Json<serde_json::Value>) {
    for _ in 0..8 {
        if let Ok(next) = catalog_fresh(state) {
            if let Some(tab) = next
                .project(project_id)
                .and_then(|p| p.tabs.iter().find(|t| t.tmux_name == created.tmux_session))
            {
                return (
                    StatusCode::CREATED,
                    Json(json!({ "tab": tab.public, "desktop_available": false })),
                );
            }
        }
        tokio::time::sleep(Duration::from_millis(125)).await;
    }
    api_error(StatusCode::GATEWAY_TIMEOUT, "launch_pending")
}

fn headless_create_error(refusal: headless::CreateRefusal) -> (StatusCode, Json<serde_json::Value>) {
    if let headless::CreateRefusal::LaunchFailed(why) | headless::CreateRefusal::Persist(why) = &refusal {
        eprintln!("mobile: a create with no window failed ({}): {why}", refusal.code());
    }
    api_error(
        match refusal {
            headless::CreateRefusal::DesktopUnavailable => StatusCode::SERVICE_UNAVAILABLE,
            headless::CreateRefusal::LaunchFailed(_) | headless::CreateRefusal::Persist(_) => StatusCode::BAD_GATEWAY,
            headless::CreateRefusal::UnknownAgent => StatusCode::BAD_REQUEST,
        },
        refusal.code(),
    )
}

/// Ask the desktop for the tab `request` describes (a sign-in tab, which
/// needs the window) and answer with its row once the catalog lists it.
/// `project_id` is the scope's public id, which the new row is looked up
/// under; the request already carries the raw one.
async fn create_through_desktop(
    state: &HostState,
    project_id: &str,
    request: CreateTabRequest,
) -> (StatusCode, Json<serde_json::Value>) {
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    created_through_desktop(state, project_id, &DesktopRequest::Create { request_id, request }).await
}

/// Send a request the desktop answers with `Created` (a create, a reopen) and
/// answer with the new tab's row once the catalog lists it.
async fn created_through_desktop(
    state: &HostState,
    project_id: &str,
    request: &DesktopRequest,
) -> (StatusCode, Json<serde_json::Value>) {
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let response = admin::desktop_call(&desktop_socket, request).await;
    answer_created(state, project_id, response).await
}

/// The phone's answer to a desktop `Created` (or the desktop's refusal).
async fn answer_created(
    state: &HostState,
    project_id: &str,
    response: Result<DesktopResponse, String>,
) -> (StatusCode, Json<serde_json::Value>) {
    match response {
        Ok(DesktopResponse::Created { tmux_session }) => {
            for _ in 0..40 {
                if let Ok(next) = catalog_fresh(state) {
                    if let Some(tab) = next.project(project_id).and_then(|p| {
                        p.tabs
                            .iter()
                            .find(|t| t.tmux_name == tmux_session && t.public.available)
                    }) {
                        return (StatusCode::CREATED, Json(json!({ "tab": tab.public })));
                    }
                }
                tokio::time::sleep(Duration::from_millis(125)).await;
            }
            api_error(StatusCode::GATEWAY_TIMEOUT, "launch_pending")
        }
        Ok(DesktopResponse::Error { code, .. }) => api_error(
            match code.as_str() {
                "desktop_unavailable" => StatusCode::SERVICE_UNAVAILABLE,
                "nothing_to_reopen" => StatusCode::CONFLICT,
                _ => StatusCode::BAD_REQUEST,
            },
            &code,
        ),
        _ => api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
    }
}

/// What a phone may send with a reopen: nothing (the newest closed tab), or the
/// opaque id of one row of the project's `closed` list.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReopenTabRequest {
    #[serde(default)]
    closed_id: Option<String>,
}

/// `POST /api/v1/projects/{project_id}/tabs/reopen` — bring back an agent tab
/// closed in this project (on either surface), on the resume args a restart
/// would give it. The desktop holds the closed tabs; only the opaque id minted
/// at close crosses, never a session id. Answers like a create, with the
/// reopened tab's row; `409 nothing_to_reopen` once it is gone.
async fn reopen_tab(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
    body: Bytes,
) -> impl IntoResponse {
    if let Err(error) = mutation_guard(&headers, &state) {
        return error;
    }
    let request = if body.is_empty() {
        ReopenTabRequest::default()
    } else {
        match serde_json::from_slice::<ReopenTabRequest>(&body) {
            Ok(request) => request,
            Err(_) => return api_error(StatusCode::BAD_REQUEST, "invalid_request"),
        }
    };
    if request.closed_id.as_deref().is_some_and(|id| !closed_tab_id_ok(id)) {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    }
    let Ok(catalog_snapshot) = catalog(&state) else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "catalog_unavailable");
    };
    let Some(project) = catalog_snapshot.project(&project_id) else {
        return api_error(StatusCode::NOT_FOUND, "project_not_found");
    };
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let response = admin::desktop_call(
        &desktop_socket,
        &DesktopRequest::ReopenTab {
            request_id,
            project_id: project.raw_id.clone(),
            closed_id: request.closed_id.clone(),
        },
    )
    .await;
    if desktop_down(&response) {
        // No window: the owner reopens what it closed (headless owner plan,
        // H3) and starts it detached, as its create does.
        let reopened = headless::reopen_tab(&state.config.state_dir, project, request.closed_id.as_deref(), &state.spawner.launch).await;
        return match reopened {
            Ok(Some(created)) => {
                poke_window(&state, Some(&project.raw_id), &["workspace"]);
                answer_headless_created(&state, &project_id, &created).await
            }
            Ok(None) => api_error(StatusCode::CONFLICT, "nothing_to_reopen"),
            Err(refusal) => headless_create_error(refusal),
        };
    }
    answer_created(&state, &project_id, response).await
}

/// `GET /api/v1/projects/{project_id}/launch-options` — what the ＋ sheet can
/// start an agent in: the project's linked worktrees (opaque ids, directory
/// and branch names — never a path) and each agent's cloud launches.
async fn launch_options(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    let Ok(catalog_snapshot) = catalog(&state) else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "catalog_unavailable");
    };
    let Some(project) = catalog_snapshot.project(&project_id) else {
        return api_error(StatusCode::NOT_FOUND, "project_not_found");
    };
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    let response = admin::desktop_call(
        &desktop_socket,
        &DesktopRequest::LaunchOptions {
            request_id,
            project_id: project.raw_id.clone(),
        },
    )
    .await;
    if desktop_down(&response) {
        // No window: the ＋ sheet offers what the owner can start — the
        // project folder, a shell or a plain agent (headless owner plan,
        // H3). Worktrees, cloud sessions, sign-ins and local models wait for
        // the window, so none is listed.
        return (
            StatusCode::OK,
            Json(json!({ "worktrees": [], "cloud": [], "sign_in": [], "local": null, "desktop_available": false })),
        );
    }
    match response {
        Ok(DesktopResponse::LaunchOptions {
            worktrees,
            cloud,
            sign_in,
            local,
        }) => (
            StatusCode::OK,
            Json(json!({ "worktrees": worktrees, "cloud": cloud, "sign_in": sign_in, "local": local })),
        ),
        Ok(DesktopResponse::Error { code, .. }) => api_error(
            if code == "desktop_unavailable" {
                StatusCode::SERVICE_UNAVAILABLE
            } else {
                StatusCode::BAD_REQUEST
            },
            &code,
        ),
        _ => api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
    }
}

async fn activate_project(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    let Ok(catalog_snapshot) = catalog(&state) else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "catalog_unavailable");
    };
    let Some(project) = catalog_snapshot.project(&project_id) else {
        return api_error(StatusCode::NOT_FOUND, "project_not_found");
    };
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    let response = admin::desktop_call(
        &desktop_socket,
        &DesktopRequest::Activate {
            request_id,
            project_id: project.raw_id.clone(),
        },
    )
    .await;
    if desktop_down(&response) {
        // No window: the registry entry is marked active under the file's
        // lock, and the next window restores it open (headless owner plan,
        // H3). A box or the root console has no such status.
        if project.public.kind != ScopeKind::Project {
            return api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable");
        }
        return match headless::activate(&state.config.state_dir, &project.raw_id) {
            Ok(()) => {
                catalog_stale(&state);
                poke_window(&state, Some(&project.raw_id), &["projects"]);
                (StatusCode::OK, Json(json!({ "status": "activated", "desktop_available": false })))
            }
            Err(why) => {
                eprintln!("mobile: an activate with no window failed: {why}");
                api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable")
            }
        };
    }
    match response {
        Ok(DesktopResponse::Activated) => (StatusCode::OK, Json(json!({ "status": "activated" }))),
        Ok(DesktopResponse::Error { code, .. }) => api_error(
            if code == "desktop_unavailable" {
                StatusCode::SERVICE_UNAVAILABLE
            } else {
                StatusCode::BAD_REQUEST
            },
            &code,
        ),
        _ => api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
    }
}

/// The board through the window when one is open; with none, read and
/// written off `calendar.json` (`headless`, `headless_board`), marked
/// `desktop_available: false`.
async fn todo(State(state): State<HostState>, headers: HeaderMap) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    let response = admin::desktop_call(&desktop_socket, &DesktopRequest::Todo { request_id }).await;
    if desktop_down(&response) {
        let key = host_key(&state);
        return match headless::todo_board(&state.config.state_dir, &key, &local_today()) {
            Ok(board) => (
                StatusCode::OK,
                Json(json!({ "board": board, "desktop_available": false })),
            ),
            Err(_) => api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
        };
    }
    match response {
        Ok(DesktopResponse::Todo { board }) => (StatusCode::OK, Json(json!({ "board": board }))),
        Ok(DesktopResponse::Error { code, .. }) => api_error(
            if code == "desktop_unavailable" {
                StatusCode::SERVICE_UNAVAILABLE
            } else {
                StatusCode::BAD_REQUEST
            },
            &code,
        ),
        _ => api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
    }
}

/// Alerts stay behind the live desktop bridge, just like the board and mail:
/// the desktop owns the alert setting, source gates, recurrence expansion, and
/// muted rows. The wire snapshot is deliberately display-only.
async fn alerts(State(state): State<HostState>, headers: HeaderMap) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    match admin::desktop_call(&desktop_socket, &DesktopRequest::Alerts { request_id }).await {
        Ok(DesktopResponse::Alerts { alerts }) => {
            (StatusCode::OK, Json(json!({ "alerts": alerts })))
        }
        Ok(DesktopResponse::Error { code, .. }) => api_error(
            if code == "desktop_unavailable" {
                StatusCode::SERVICE_UNAVAILABLE
            } else {
                StatusCode::BAD_REQUEST
            },
            &code,
        ),
        _ => api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
    }
}

/// Press one alert row's ✓ — the same three resolutions the desktop strip's own
/// button performs (`lib/alertDone`), reached by the opaque row handle the
/// snapshot published. Origin-checked like every other write; the sidecar
/// validates only the handle's shape, because what it *means* is the desktop's
/// alone. The answer is a fresh alerts snapshot, the way a board write answers
/// with the board.
async fn alerts_resolve(
    State(state): State<HostState>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    let Ok(request) = serde_json::from_slice::<AlertResolveBody>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    if request.alert_id.is_empty() || request.alert_id.len() > 128 {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    }
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    match admin::desktop_call(
        &desktop_socket,
        &DesktopRequest::AlertResolve {
            request_id,
            alert_id: request.alert_id,
        },
    )
    .await
    {
        Ok(DesktopResponse::Alerts { alerts }) => {
            (StatusCode::OK, Json(json!({ "alerts": alerts })))
        }
        Ok(DesktopResponse::Error { code, .. }) => api_error(
            if code == "desktop_unavailable" {
                StatusCode::SERVICE_UNAVAILABLE
            } else {
                StatusCode::BAD_REQUEST
            },
            &code,
        ),
        _ => api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
    }
}

/// This device's push state and the key it must subscribe with. The endpoint
/// goes back only to the device that registered it, so the phone can tell a
/// browser-rotated subscription from the one on file.
///
/// A row the push service declared gone is `lapsed`, not `subscribed`: nothing
/// is sent to it, but its choices and the dead endpoint are still answered, so
/// the phone's silent refresh re-subscribes with them (`refreshPush`) instead
/// of leaving notices off. A phone bundle that predates the field reads
/// `subscribed: false` and behaves as it always did.
fn push_state(state: &HostState, device_id: &str) -> (StatusCode, Json<serde_json::Value>) {
    let auth = state.auth.lock().unwrap_or_else(PoisonError::into_inner);
    let push = auth.push();
    let subscription = push.subscription(device_id);
    (
        StatusCode::OK,
        Json(json!({
            "vapid_public_key": push.public_key(),
            "subscribed": subscription.is_some_and(|s| !s.lapsed),
            "lapsed": subscription.is_some_and(|s| s.lapsed),
            "details": subscription.is_some_and(|s| s.details),
            "calendar": subscription.is_some_and(|s| s.calendar),
            "agents": subscription.map(|s| s.agents).unwrap_or_default(),
            "endpoint": subscription.map(|s| s.endpoint.clone()),
        })),
    )
}

async fn push_get(State(state): State<HostState>, headers: HeaderMap) -> impl IntoResponse {
    match authenticate(&headers, &state) {
        Ok(device_id) => push_state(&state, &device_id),
        Err(error) => error,
    }
}

/// Subscribe this phone to push notices. The only route that makes the host
/// talk to anything off the tailnet, so the endpoint must name a push vendor
/// (`push::endpoint_origin`) before it is stored.
async fn push_put(
    State(state): State<HostState>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    let device_id = match authenticate(&headers, &state) {
        Ok(device_id) => device_id,
        Err(error) => return error,
    };
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    let Ok(request) = serde_json::from_slice::<PushBody>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    let stored = state
        .auth
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .push_subscribe(&device_id, &request.endpoint, &request.p256dh, &request.auth, request.prefs);
    if stored.is_err() {
        return api_error(StatusCode::BAD_REQUEST, "invalid_push_subscription");
    }
    push_state(&state, &device_id)
}

async fn push_delete(State(state): State<HostState>, headers: HeaderMap) -> impl IntoResponse {
    let device_id = match authenticate(&headers, &state) {
        Ok(device_id) => device_id,
        Err(error) => return error,
    };
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    if state
        .auth
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .push_unsubscribe(&device_id)
        .is_err()
    {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "push_unavailable");
    }
    push_state(&state, &device_id)
}

/// The agent tab a tmux session is, as the phone knows it — for an agent-turn
/// notice (`AdminRequest::AgentTurn`). Only a tab the catalog already offers a
/// phone resolves, so a notice can never name one the phone could not open.
fn agent_tab_ref(state: &HostState, tmux_session: &str) -> Option<AgentTabRef> {
    let catalog = catalog(state).ok()?;
    catalog.projects.iter().find_map(|project| {
        project
            .tabs
            .iter()
            .find(|tab| tab.tmux_name == tmux_session && tab.public.kind == "agent")
            .map(|tab| AgentTabRef {
                project_id: project.public.id.clone(),
                project_label: project.public.label.clone(),
                tab_id: tab.public.id.clone(),
                tab_label: tab.public.label.clone(),
                attached: state.terminal_registry.is_watched(tmux_session),
            })
    })
}

fn valid_calendar_month(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 7
        && bytes[4] == b'-'
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[5..].iter().all(u8::is_ascii_digit)
        && (bytes[5] - b'0') * 10 + (bytes[6] - b'0') >= 1
        && (bytes[5] - b'0') * 10 + (bytes[6] - b'0') <= 12
}

/// Like the board, Mobile's calendar is a live desktop snapshot. This keeps
/// recurrence, checked-calendar visibility, CalDAV state and calendar.json
/// ownership in the existing desktop store.
async fn calendar(
    State(state): State<HostState>,
    headers: HeaderMap,
    Query(query): Query<CalendarQuery>,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    let Some(month) = query.month.filter(|value| valid_calendar_month(value)) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_month");
    };
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    let response = admin::desktop_call(
        &desktop_socket,
        &DesktopRequest::Calendar { request_id, month: month.clone() },
    )
    .await;
    if desktop_down(&response) {
        // No window: the month is expanded off `calendar.json` here, read-only.
        let key = host_key(&state);
        return match headless::calendar_month(&state.config.state_dir, &key, &month) {
            Ok(calendar) => (
                StatusCode::OK,
                Json(json!({ "calendar": calendar, "desktop_available": false })),
            ),
            Err(_) => api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
        };
    }
    match response {
        Ok(DesktopResponse::Calendar { calendar }) => {
            (StatusCode::OK, Json(json!({ "calendar": calendar })))
        }
        Ok(DesktopResponse::Error { code, .. }) => api_error(
            if code == "desktop_unavailable" {
                StatusCode::SERVICE_UNAVAILABLE
            } else {
                StatusCode::BAD_REQUEST
            },
            &code,
        ),
        _ => api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
    }
}

fn valid_calendar_action(action: &CalendarAction) -> bool {
    match action {
        CalendarAction::CreateEvent { event } | CalendarAction::UpdateEvent { event, .. } => {
            !event.calendar_id.is_empty()
                && event.calendar_id.len() <= 128
                && !event.title.trim().is_empty()
                && event.title.len() <= 300
                && event.start.len() <= 32
                && event.end.len() <= 32
                && event.location.len() <= 1_000
                && event.notes.len() <= 16 * 1024
                && event.conference.len() <= 2_000
                && event.category.len() <= 80
                && event.status.len() <= 32
        }
        CalendarAction::DeleteEvent { event_id } => !event_id.is_empty() && event_id.len() <= 128,
        CalendarAction::CreateCalendar { name, color } => {
            !name.trim().is_empty() && name.len() <= 160 && color.len() <= 64
        }
        CalendarAction::UpdateCalendar {
            calendar_id,
            name,
            color,
            ..
        } => {
            !calendar_id.is_empty()
                && calendar_id.len() <= 128
                && !name.trim().is_empty()
                && name.len() <= 160
                && color.len() <= 64
        }
        CalendarAction::DeleteCalendar { calendar_id } => {
            !calendar_id.is_empty() && calendar_id.len() <= 128
        }
    }
}

/// Calendar writes go through the window when one is open (CalDAV pushes
/// from there); with none, a local calendar is written here under CAS.
async fn calendar_mutate(
    State(state): State<HostState>,
    headers: HeaderMap,
    Query(query): Query<CalendarQuery>,
    body: Bytes,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    let Ok(action) = serde_json::from_slice::<CalendarAction>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    let Some(month) = query.month.filter(|value| valid_calendar_month(value)) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_month");
    };
    if !valid_calendar_action(&action) {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    }
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    let response = admin::desktop_call(
        &desktop_socket,
        &DesktopRequest::CalendarMutate {
            request_id,
            month: month.clone(),
            action: action.clone(),
        },
    )
    .await;
    if desktop_down(&response) {
        // No window: the write is one CAS transaction on `calendar.json`
        // (headless owner plan, H3); a CalDAV-backed calendar still needs
        // the window, which pushes from the write.
        let key = host_key(&state);
        return match super::headless_board::calendar_mutate(&state.config.state_dir, &key, action) {
            Ok(()) => {
                poke_window(&state, None, &["calendar"]);
                match headless::calendar_month(&state.config.state_dir, &key, &month) {
                    Ok(calendar) => (StatusCode::OK, Json(json!({ "calendar": calendar, "desktop_available": false }))),
                    Err(_) => api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
                }
            }
            Err(super::headless_board::Refused(code)) => api_error(
                match code {
                    "event_not_found" => StatusCode::NOT_FOUND,
                    "desktop_unavailable" => StatusCode::SERVICE_UNAVAILABLE,
                    _ => StatusCode::BAD_REQUEST,
                },
                code,
            ),
        };
    }
    match response {
        Ok(DesktopResponse::Calendar { calendar }) => {
            (StatusCode::OK, Json(json!({ "calendar": calendar })))
        }
        Ok(DesktopResponse::Error { code, .. }) => api_error(
            if code == "desktop_unavailable" {
                StatusCode::SERVICE_UNAVAILABLE
            } else {
                StatusCode::BAD_REQUEST
            },
            &code,
        ),
        _ => api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
    }
}

async fn todo_mutate(
    State(state): State<HostState>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    let Ok(action) = serde_json::from_slice::<TodoAction>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    let valid = match &action {
        TodoAction::Create { task } => valid_todo_task(task),
        TodoAction::Move {
            task_id, column, ..
        } => !task_id.is_empty() && task_id.len() <= 128 && column.len() <= 128,
        TodoAction::Update { task_id, task } => {
            !task_id.is_empty() && task_id.len() <= 128 && valid_todo_task(task)
        }
        TodoAction::Toggle { task_id } | TodoAction::Delete { task_id } => {
            !task_id.is_empty() && task_id.len() <= 128
        }
        TodoAction::ColumnCreate { name } => !name.trim().is_empty() && name.len() <= 160,
        TodoAction::ColumnRename { column_id, name } => {
            !column_id.is_empty()
                && column_id.len() <= 128
                && !name.trim().is_empty()
                && name.len() <= 160
        }
        TodoAction::ColumnMove { column_id, delta } => {
            !column_id.is_empty() && column_id.len() <= 128 && matches!(delta, -1 | 1)
        }
        TodoAction::ColumnDelete { column_id } => !column_id.is_empty() && column_id.len() <= 128,
    };
    if !valid {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    }
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    let response = admin::desktop_call(
        &desktop_socket,
        &DesktopRequest::TodoMutate { request_id, action: action.clone() },
    )
    .await;
    if desktop_down(&response) {
        // No window: the board write is one CAS transaction on
        // `calendar.json` under the desktop's own rules (headless owner
        // plan, H3), answered with the board as stored.
        let key = host_key(&state);
        let projects = headless::project_names(&state.config.state_dir);
        return match super::headless_board::todo_mutate(&state.config.state_dir, &key, &projects, action) {
            Ok(()) => {
                poke_window(&state, None, &["calendar"]);
                match headless::todo_board(&state.config.state_dir, &key, &local_today()) {
                    Ok(board) => (StatusCode::OK, Json(json!({ "board": board, "desktop_available": false }))),
                    Err(_) => api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
                }
            }
            Err(super::headless_board::Refused(code)) => api_error(
                match code {
                    "task_not_found" => StatusCode::NOT_FOUND,
                    "desktop_unavailable" => StatusCode::SERVICE_UNAVAILABLE,
                    _ => StatusCode::BAD_REQUEST,
                },
                code,
            ),
        };
    }
    match response {
        Ok(DesktopResponse::Todo { board }) => (StatusCode::OK, Json(json!({ "board": board }))),
        Ok(DesktopResponse::Error { code, .. }) => api_error(
            if code == "desktop_unavailable" {
                StatusCode::SERVICE_UNAVAILABLE
            } else {
                StatusCode::BAD_REQUEST
            },
            &code,
        ),
        _ => api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
    }
}

fn valid_todo_task(task: &crate::services::mobile_control::protocol::TodoTaskInput) -> bool {
    !task.title.trim().is_empty()
        && task.title.len() <= 300
        && task.notes.len() <= 16 * 1024
        && task.due.as_ref().is_none_or(|due| due.len() <= 32)
        && task.priority <= 9
        && task.percent <= 100
        && task.column.len() <= 128
        && task.calendar_id.len() <= 128
        && task.project_id.as_ref().is_none_or(|id| id.len() <= 128)
        && task.tags.len() <= 50
        && task
            .tags
            .iter()
            .all(|tag| !tag.trim().is_empty() && tag.len() <= 80)
        && task.subtasks.len() <= 100
        && task.subtasks.iter().all(|step| {
            step.id.len() <= 128 && !step.title.trim().is_empty() && step.title.len() <= 300
        })
}

fn valid_mail_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn mail_response(
    response: Result<DesktopResponse, String>,
) -> (StatusCode, Json<serde_json::Value>) {
    match response {
        Ok(DesktopResponse::Mail { mail }) => (StatusCode::OK, Json(json!({ "mail": mail }))),
        Ok(DesktopResponse::Error { code, .. }) => api_error(
            if code == "desktop_unavailable" {
                StatusCode::SERVICE_UNAVAILABLE
            } else if code.ends_with("_not_found") {
                StatusCode::NOT_FOUND
            } else if code.ends_with("_disabled") {
                // The desktop setting is off: a refusal the phone should read
                // as "not allowed here", not as a malformed request.
                StatusCode::FORBIDDEN
            } else {
                StatusCode::BAD_REQUEST
            },
            &code,
        ),
        _ => api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
    }
}

/// Mail stays behind the live desktop for the same reason the board does: the
/// desktop already owns the unlocked/encrypted MailState. The sidecar receives
/// only the bounded, read-only snapshot defined in `protocol`.
async fn mail_overview(State(state): State<HostState>, headers: HeaderMap) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    mail_response(
        admin::desktop_call(
            &desktop_socket,
            &DesktopRequest::MailOverview { request_id },
        )
        .await,
    )
}

async fn mail_folder(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(folder_id): Path<String>,
    Query(query): Query<MailQuery>,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    let offset = query.offset.unwrap_or(0);
    if !valid_mail_id(&folder_id) || offset > 100_000 {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    }
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    mail_response(
        admin::desktop_call(
            &desktop_socket,
            &DesktopRequest::MailFolder {
                request_id,
                folder_id,
                offset,
            },
        )
        .await,
    )
}

async fn mail_message(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path((folder_id, message_id)): Path<(String, String)>,
    Query(query): Query<MailQuery>,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    let offset = query.offset.unwrap_or(0);
    if !valid_mail_id(&folder_id) || !valid_mail_id(&message_id) || offset > 100_000 {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    }
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    mail_response(
        admin::desktop_call(
            &desktop_socket,
            &DesktopRequest::MailMessage {
                request_id,
                folder_id,
                message_id,
                offset,
            },
        )
        .await,
    )
}

/// The two mail mutations. Both are origin-checked like every other write,
/// validated here only for shape, and gated **on the desktop**: the sidecar
/// cannot read mail settings and must not start to. The desktop answers with
/// the refreshed folder page so the phone's list is right without a second
/// round trip.
async fn mail_mark(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path((folder_id, message_id)): Path<(String, String)>,
    body: Bytes,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    let Ok(mark) = serde_json::from_slice::<MailMarkBody>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    if !valid_mail_id(&folder_id) || !valid_mail_id(&message_id) || mark.offset > 100_000 {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    }
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    mail_response(
        admin::desktop_call(
            &desktop_socket,
            &DesktopRequest::MailMark {
                request_id,
                folder_id,
                message_id,
                offset: mark.offset,
                action: mark.action,
            },
        )
        .await,
    )
}

async fn mail_reply(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path((folder_id, message_id)): Path<(String, String)>,
    body: Bytes,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    let Ok(reply) = serde_json::from_slice::<MailReplyBody>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    if !valid_mail_id(&folder_id) || !valid_mail_id(&message_id) || reply.offset > 100_000 {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    }
    if reply.body.trim().is_empty() {
        return api_error(StatusCode::BAD_REQUEST, "empty_reply");
    }
    if reply.body.len() > MAX_MAIL_REPLY_BYTES {
        return api_error(StatusCode::PAYLOAD_TOO_LARGE, "reply_too_long");
    }
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    mail_response(
        admin::desktop_call(
            &desktop_socket,
            &DesktopRequest::MailReply {
                request_id,
                folder_id,
                message_id,
                offset: reply.offset,
                body: reply.body,
            },
        )
        .await,
    )
}

async fn tab(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(tab_id): Path<String>,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    let Ok(catalog) = catalog(&state) else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "catalog_unavailable");
    };
    let Some((_, tab)) = catalog.tab(&tab_id) else {
        return api_error(StatusCode::NOT_FOUND, "tab_not_found");
    };
    let mut row = tab.public.clone();
    row.viewer_busy = state.terminal_registry.is_busy(&tab.tmux_name);
    (StatusCode::OK, Json(json!({ "tab": row })))
}

/// A phone-supplied tab label. Anything the catalog would later truncate, or
/// that would smuggle control characters into a terminal title, is refused here
/// rather than stored and quietly re-rendered as something else.
fn clean_tab_label(raw: &str) -> Option<String> {
    let label = raw.trim();
    if label.is_empty()
        || label.chars().count() > MAX_TAB_LABEL
        || label.chars().any(char::is_control)
    {
        return None;
    }
    Some(label.to_string())
}

/// `PUT /api/v1/tabs/{id}` — rename one agent tab. The desktop owns the write
/// (the tab layout is its state, not the sidecar's), so this is a bridge call;
/// the fresh catalog read afterwards is what makes the new label visible to the
/// caller in the same response instead of one poll later.
async fn rename_tab(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(tab_id): Path<String>,
    body: Bytes,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct RenameBody {
        label: String,
    }
    let Ok(request) = serde_json::from_slice::<RenameBody>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    let Some(label) = clean_tab_label(&request.label) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_label");
    };
    let (project_id, tmux_session) = match agent_tab_target(&state, &tab_id) {
        Ok(target) => target,
        Err(error) => return error,
    };
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    let response = admin::desktop_call(
        &desktop_socket,
        &DesktopRequest::RenameTab {
            request_id,
            project_id: project_id.clone(),
            tmux_session: tmux_session.clone(),
            label: label.clone(),
        },
    )
    .await;
    if desktop_down(&response) {
        // No window: the rename lands in the session file through the
        // workspace service, and the desktop's next sync keeps it.
        let edited = crate::services::workspace::rename_tab_in(&scope_session_file(&state, &project_id), &project_id, &tmux_session, &label);
        return headless_tab_edit(&state, &project_id, &tab_id, &tmux_session, edited, json!({ "label": label }));
    }
    match response {
        Ok(DesktopResponse::Renamed { label }) => {
            let row = catalog_fresh(&state)
                .ok()
                .and_then(|next| next.tab(&tab_id).map(|(_, tab)| tab.public.clone()));
            match row {
                Some(mut row) => {
                    row.viewer_busy = state.terminal_registry.is_busy(&tmux_session);
                    (StatusCode::OK, Json(json!({ "tab": row })))
                }
                // The desktop persists asynchronously, so a catalog that has not
                // caught up yet is not a failed rename; answer with what the
                // desktop stored and let the screen's poll bring the rest.
                None => (StatusCode::OK, Json(json!({ "label": label }))),
            }
        }
        Ok(DesktopResponse::Error { code, .. }) => api_error(
            match code.as_str() {
                "desktop_unavailable" => StatusCode::SERVICE_UNAVAILABLE,
                "tab_not_found" => StatusCode::NOT_FOUND,
                _ => StatusCode::BAD_REQUEST,
            },
            &code,
        ),
        _ => api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
    }
}

/// `PUT /api/v1/tabs/{id}/color` — paint one tab, agent or shell, with a colour
/// from the palette, or clear it with `null`/`""`.
///
/// Its own route rather than a field on the rename above, for two reasons that
/// both matter: the rename is agent-only (`agent_tab_target`) while a colour is
/// for any tab the phone lists, and that body is `deny_unknown_fields`, so a
/// phone sending a colour to an older sidecar would have had its *rename*
/// refused whole. The desktop owns the write, as with every tab-layout change.
async fn color_tab(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(tab_id): Path<String>,
    body: Bytes,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct ColorBody {
        #[serde(default)]
        color: Option<String>,
    }
    let Ok(request) = serde_json::from_slice::<ColorBody>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    let Ok(color) = clean_tab_color(request.color.as_deref()) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_color");
    };
    let (project_id, tmux_session) = match tab_target(&state, &tab_id, false) {
        Ok(target) => target,
        Err(error) => return error,
    };
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    let response = admin::desktop_call(
        &desktop_socket,
        &DesktopRequest::ColorTab {
            request_id,
            project_id: project_id.clone(),
            tmux_session: tmux_session.clone(),
            color: color.clone(),
        },
    )
    .await;
    if desktop_down(&response) {
        let edited = crate::services::workspace::color_tab_in(&scope_session_file(&state, &project_id), &project_id, &tmux_session, color.as_deref());
        return headless_tab_edit(&state, &project_id, &tab_id, &tmux_session, edited, json!({ "color": color }));
    }
    match response {
        Ok(DesktopResponse::Colored { color }) => {
            let row = catalog_fresh(&state)
                .ok()
                .and_then(|next| next.tab(&tab_id).map(|(_, tab)| tab.public.clone()));
            match row {
                Some(mut row) => {
                    row.viewer_busy = state.terminal_registry.is_busy(&tmux_session);
                    (StatusCode::OK, Json(json!({ "tab": row })))
                }
                // The desktop persists asynchronously, so a catalog that has not
                // caught up is not a failed write — answer with what it stored,
                // exactly as the rename route does.
                None => (StatusCode::OK, Json(json!({ "color": color }))),
            }
        }
        Ok(DesktopResponse::Error { code, .. }) => api_error(
            match code.as_str() {
                "desktop_unavailable" => StatusCode::SERVICE_UNAVAILABLE,
                "tab_not_found" => StatusCode::NOT_FOUND,
                _ => StatusCode::BAD_REQUEST,
            },
            &code,
        ),
        _ => api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
    }
}

/// `POST /api/v1/tabs/{id}/prompt` — the phone's composer sent `message` to
/// this agent tab. The words went to tmux through the terminal socket; this
/// hands them to the desktop, which records them in the tab's prompt history
/// (`DesktopRequest::TabPrompt`). The phone does not wait on it for anything:
/// a failed report costs a row in a list, never the prompt.
async fn sent_prompt(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(tab_id): Path<String>,
    body: Bytes,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct PromptBody {
        message: String,
    }
    let Ok(request) = serde_json::from_slice::<PromptBody>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    let message = request.message.trim();
    if message.is_empty() || message.len() > MAX_SENT_PROMPT {
        return api_error(StatusCode::BAD_REQUEST, "invalid_prompt");
    }
    let (project_id, tmux_session) = match agent_tab_target(&state, &tab_id) {
        Ok(target) => target,
        Err(error) => return error,
    };
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    let response = admin::desktop_call(
        &desktop_socket,
        &DesktopRequest::TabPrompt {
            request_id,
            project_id: project_id.clone(),
            tmux_session,
            message: message.to_string(),
        },
    )
    .await;
    if desktop_down(&response) {
        // No window: the owner writes the history row (headless owner plan,
        // H3); the words already reached the tab through the terminal socket.
        let Ok((_, tab)) = agent_tab(&state, &tab_id) else {
            return api_error(StatusCode::NOT_FOUND, "tab_not_found");
        };
        return match headless::record_prompt(&state.config.state_dir, &project_id, &tab, message) {
            Ok(recorded) => {
                if recorded {
                    poke_window(&state, Some(&project_id), &["prompts"]);
                }
                (StatusCode::OK, Json(json!({ "recorded": recorded, "desktop_available": false })))
            }
            Err(why) => {
                eprintln!("mobile: recording a phone prompt with no window failed: {why}");
                api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable")
            }
        };
    }
    match response {
        Ok(DesktopResponse::Seen) => (StatusCode::OK, Json(json!({ "recorded": true }))),
        Ok(DesktopResponse::Error { code, .. }) => api_error(
            match code.as_str() {
                "desktop_unavailable" => StatusCode::SERVICE_UNAVAILABLE,
                "tab_not_found" => StatusCode::NOT_FOUND,
                _ => StatusCode::BAD_REQUEST,
            },
            &code,
        ),
        _ => api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
    }
}

/// The words of a held prompt, as a route reads them off the body: trimmed,
/// and bounded like a sent prompt.
fn held_message(body: &Bytes) -> Result<String, (StatusCode, Json<serde_json::Value>)> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct HeldBody {
        message: String,
    }
    let Ok(request) = serde_json::from_slice::<HeldBody>(body) else {
        return Err(api_error(StatusCode::BAD_REQUEST, "invalid_request"));
    };
    let message = request.message.trim();
    if message.is_empty() || message.len() > MAX_SENT_PROMPT {
        return Err(api_error(StatusCode::BAD_REQUEST, "invalid_prompt"));
    }
    Ok(message.to_string())
}

/// A held prompt's id is a rule id the desktop minted (a UUID); anything
/// else never reaches it.
fn valid_held_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// Ask the window to hold or edit a phone prompt; with no window the owner
/// does it (`headless` — `fallback` answers the held id), marks the rule as a
/// phone hold for its own scheduler and pokes a window that may be opening.
async fn held_call(
    state: &HostState,
    request: DesktopRequest,
    fallback: impl FnOnce() -> Result<String, String>,
) -> (StatusCode, Json<serde_json::Value>) {
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let response = admin::desktop_call(&desktop_socket, &request).await;
    let code = if desktop_down(&response) {
        match fallback() {
            Ok(held_id) => {
                state.holds.hold(&held_id);
                if let DesktopRequest::HoldPrompt { project_id, .. } | DesktopRequest::EditHeldPrompt { project_id, .. } = &request {
                    poke_window(state, Some(project_id), &["schedules"]);
                }
                return (StatusCode::OK, Json(json!({ "id": held_id, "desktop_available": false })));
            }
            Err(code) if matches!(code.as_str(), "tab_not_found" | "held_gone" | "held_busy" | "invalid_prompt") => code,
            Err(why) => {
                // A file the owner could not write: the phone types the words.
                eprintln!("mobile: holding a phone prompt with no window failed: {why}");
                "desktop_unavailable".to_string()
            }
        }
    } else {
        match response {
            Ok(DesktopResponse::Held { held_id }) => return (StatusCode::OK, Json(json!({ "id": held_id }))),
            Ok(DesktopResponse::Error { code, .. }) => code,
            _ => "desktop_unavailable".to_string(),
        }
    };
    api_error(
        match code.as_str() {
            "desktop_unavailable" => StatusCode::SERVICE_UNAVAILABLE,
            "tab_not_found" => StatusCode::NOT_FOUND,
            "held_gone" | "held_busy" => StatusCode::CONFLICT,
            _ => StatusCode::BAD_REQUEST,
        },
        &code,
    )
}

/// `POST /api/v1/tabs/{id}/held` — the phone's composer sent `message` while
/// the agent was at work: the desktop holds it and delivers it at the tab's
/// next safe idle point (`DesktopRequest::HoldPrompt`), so it stays editable
/// until then. Answered with the id to edit it by. A refusal costs nothing:
/// the phone then types the words itself, as it does for an idle agent.
async fn hold_prompt(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(tab_id): Path<String>,
    body: Bytes,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    let message = match held_message(&body) {
        Ok(message) => message,
        Err(error) => return error,
    };
    let (project_id, tab) = match agent_tab(&state, &tab_id) {
        Ok(target) => target,
        Err(error) => return error,
    };
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    let state_dir = state.config.state_dir.clone();
    let (status, body) = held_call(
        &state,
        DesktopRequest::HoldPrompt {
            request_id,
            project_id: project_id.clone(),
            tmux_session: tab.tmux_name.clone(),
            message: message.clone(),
        },
        || headless::hold_prompt(&state_dir, &project_id, &tab, &message, chrono::Local::now()),
    )
    .await;
    (if status == StatusCode::OK { StatusCode::CREATED } else { status }, body)
}

/// `PUT /api/v1/tabs/{id}/held/{held_id}` — new words for a prompt the desktop
/// still holds. `409 held_gone` once the agent has it, `409 held_busy` while
/// it is being typed (`DesktopRequest::EditHeldPrompt`).
async fn edit_held_prompt(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path((tab_id, held_id)): Path<(String, String)>,
    body: Bytes,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    if !valid_held_id(&held_id) {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    }
    let message = match held_message(&body) {
        Ok(message) => message,
        Err(error) => return error,
    };
    let (project_id, tab) = match agent_tab(&state, &tab_id) {
        Ok(target) => target,
        Err(error) => return error,
    };
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    let state_dir = state.config.state_dir.clone();
    held_call(
        &state,
        DesktopRequest::EditHeldPrompt {
            request_id,
            project_id: project_id.clone(),
            tmux_session: tab.tmux_name.clone(),
            held_id: held_id.clone(),
            message: message.clone(),
        },
        || headless::edit_held_prompt(&state_dir, &project_id, &tab, &held_id, &message).map(|()| held_id.clone()),
    )
    .await
}

/// `POST /api/v1/tabs/{id}/sign-in-callback` — the address the phone's browser
/// ended on after an agent CLI's sign-in redirected it to `localhost`, handed
/// to the listener that CLI is waiting on here (`sign_in`). The tab only
/// scopes who may ask: the address is checked on its own terms, and the
/// answer carries the listener's status and nothing it sent.
async fn sign_in_callback(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(tab_id): Path<String>,
    body: Bytes,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct CallbackBody {
        url: String,
    }
    let Ok(request) = serde_json::from_slice::<CallbackBody>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    if let Err(error) = agent_tab_target(&state, &tab_id) {
        return error;
    }
    let callback = match sign_in::parse_callback(&request.url, state.config.host.port) {
        Ok(callback) => callback,
        Err(code) => return api_error(StatusCode::BAD_REQUEST, code),
    };
    match sign_in::deliver(&callback).await {
        Ok(status) => (StatusCode::OK, Json(json!({ "delivered": true, "status": status }))),
        Err(code) => api_error(StatusCode::BAD_GATEWAY, code),
    }
}

/// `POST /api/v1/tabs/{id}/sign-in` — open a sign-in tab for the CLI this
/// agent tab runs, beside it: the CLI's own login command in the flow a phone
/// can finish (`src/lib/agents/signInLaunch.ts`), chosen by the desktop from
/// the tab's command. The phone names the tab by opaque id and the way in
/// (`alternate`); the tmux name it resolves to goes to the desktop alone.
async fn sign_in_tab(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(tab_id): Path<String>,
    body: Bytes,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct SignInBody {
        #[serde(default)]
        alternate: bool,
        idempotency_key: String,
    }
    let Ok(body) = serde_json::from_slice::<SignInBody>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    if body.idempotency_key.len() < 16 || body.idempotency_key.len() > 128 {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    }
    let Ok(catalog_snapshot) = catalog(&state) else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "catalog_unavailable");
    };
    let Some((project, tab)) = catalog_snapshot.tab(&tab_id) else {
        return api_error(StatusCode::NOT_FOUND, "tab_not_found");
    };
    if tab.public.kind != "agent" {
        return api_error(StatusCode::BAD_REQUEST, "agent_tab_required");
    }
    let request = CreateTabRequest {
        project_id: project.raw_id.clone(),
        kind: CreateTabKind::Agent,
        agent_id: None,
        mode: None,
        worktree: None,
        cloud: None,
        task: None,
        sign_in: Some(if body.alternate { "alternate" } else { "default" }.to_string()),
        like_tab: Some(tab.tmux_name.clone()),
        local: None,
        idempotency_key: body.idempotency_key,
    };
    let project_id = project.public.id.clone();
    create_through_desktop(&state, &project_id, request).await
}

/// `PUT /api/v1/tabs/{id}/order` — move one tab next to another, the phone's
/// half of the desktop Agents view's drag reorder (#264). Both tabs are named
/// by opaque id and must live in the same scope: the order being permuted is
/// one scope's tab layout, and a tab cannot be dropped into a project it is not
/// in. The desktop owns that layout, so this is a bridge call like the rename
/// and the colour above it, and the answer is the scope's new order read back
/// out of the catalog — the phone rearranged its list on the drop, and this is
/// what it reconciles against.
async fn order_tab(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(tab_id): Path<String>,
    body: Bytes,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct OrderBody {
        anchor: String,
        place: TabPlace,
    }
    let Ok(request) = serde_json::from_slice::<OrderBody>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    if request.anchor == tab_id {
        return api_error(StatusCode::BAD_REQUEST, "invalid_anchor");
    }
    let (project_id, tmux_session) = match tab_target(&state, &tab_id, false) {
        Ok(target) => target,
        Err(error) => return error,
    };
    let (anchor_project, anchor_tmux) = match tab_target(&state, &request.anchor, false) {
        Ok(target) => target,
        Err(error) => return error,
    };
    // Two scopes have two layouts and no shared order to express a move in.
    if anchor_project != project_id {
        return api_error(StatusCode::BAD_REQUEST, "tab_scope_mismatch");
    }
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    let after = matches!(request.place, TabPlace::After);
    let response = admin::desktop_call(
        &desktop_socket,
        &DesktopRequest::ReorderTab {
            request_id,
            project_id: project_id.clone(),
            tmux_session: tmux_session.clone(),
            anchor_tmux_session: anchor_tmux.clone(),
            place: request.place,
        },
    )
    .await;
    if desktop_down(&response) {
        // No window: the move lands in the session file's order, which is
        // the order the catalog publishes and the phone reconciles against.
        let edited = crate::services::workspace::reorder_tab_in(&scope_session_file(&state, &project_id), &project_id, &tmux_session, &anchor_tmux, after);
        return match edited {
            Ok(_) => {
                catalog_stale(&state);
                poke_window(&state, Some(&project_id), &["workspace"]);
                let tabs: Vec<String> = catalog_fresh(&state)
                    .ok()
                    .and_then(|next| {
                        next.tab(&tab_id)
                            .map(|(project, _)| project.tabs.iter().map(|t| t.public.id.clone()).collect())
                    })
                    .unwrap_or_default();
                (StatusCode::OK, Json(json!({ "tabs": tabs, "desktop_available": false })))
            }
            Err(code) => headless_tab_error(&code),
        };
    }
    match response {
        Ok(DesktopResponse::Reordered) => {
            // The desktop persists before it answers, so a fresh read is the new
            // order; a catalog that somehow has not caught up answers with what
            // it has rather than failing a write that did happen, exactly as the
            // colour route does.
            let tabs: Vec<String> = catalog_fresh(&state)
                .ok()
                .and_then(|next| {
                    next.tab(&tab_id)
                        .map(|(project, _)| project.tabs.iter().map(|t| t.public.id.clone()).collect())
                })
                .unwrap_or_default();
            (StatusCode::OK, Json(json!({ "tabs": tabs })))
        }
        Ok(DesktopResponse::Error { code, .. }) => api_error(
            match code.as_str() {
                "desktop_unavailable" => StatusCode::SERVICE_UNAVAILABLE,
                "tab_not_found" => StatusCode::NOT_FOUND,
                _ => StatusCode::BAD_REQUEST,
            },
            &code,
        ),
        _ => api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
    }
}

/// `DELETE /api/v1/tabs/{id}` — close one tab from the phone, agent or shell.
/// The desktop owns the tab layout, so this is a bridge call, and it closes the
/// way the desktop's own × does: the tab leaves the Tabtivity window while the
/// tmux session behind it keeps running, reattachable from the desktop's
/// Sessions view. Only the opaque tab id crosses; the raw project id and the
/// tmux name stay on the desktop/sidecar link.
async fn close_tab(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(tab_id): Path<String>,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    let (project_id, tmux_session) = match tab_target(&state, &tab_id, false) {
        Ok(target) => target,
        Err(error) => return error,
    };
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    let response = admin::desktop_call(
        &desktop_socket,
        &DesktopRequest::CloseTab {
            request_id,
            project_id: project_id.clone(),
            tmux_session: tmux_session.clone(),
        },
    )
    .await;
    if desktop_down(&response) {
        // No window: the tab leaves the set in the session file (an agent tab
        // is remembered for a reopen), then its session ends the way the
        // desktop's × ends a local session the tab minted — the subtree
        // reaped, the launcher dropped (`Runner::kill`). An attach tab's
        // session is not the tab's to end: it stays running.
        return match crate::services::workspace::close_tab_in(&scope_session_file(&state, &project_id), &project_id, &tmux_session, now_ms()) {
            Ok(closed) => {
                catalog_stale(&state);
                poke_window(&state, Some(&project_id), &["workspace"]);
                if crate::services::workspace::owns_tmux_session(&closed) {
                    let runner = state.runner.clone();
                    let ended = tokio::task::spawn_blocking(move || runner.kill(&tmux_session)).await;
                    if let Ok(Err(why)) = ended {
                        eprintln!("mobile: a close with no window left the session running: {why}");
                    }
                }
                (StatusCode::OK, Json(json!({ "closed": true, "desktop_available": false })))
            }
            Err(code) => headless_tab_error(&code),
        };
    }
    match response {
        // The desktop rewrites the session file before it answers, so the only
        // thing that could still be carrying the closed tab is this cache —
        // dropped here rather than read back, because nothing in this reply
        // depends on the new catalog and the next poll is a second away.
        Ok(DesktopResponse::Closed) => {
            catalog_stale(&state);
            (StatusCode::OK, Json(json!({ "closed": true })))
        }
        Ok(DesktopResponse::Error { code, .. }) => api_error(
            match code.as_str() {
                "desktop_unavailable" => StatusCode::SERVICE_UNAVAILABLE,
                "tab_not_found" => StatusCode::NOT_FOUND,
                _ => StatusCode::BAD_REQUEST,
            },
            &code,
        ),
        _ => api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
    }
}

fn schedule_desktop_error(
    response: Result<DesktopResponse, String>,
) -> (StatusCode, Json<serde_json::Value>) {
    match response {
        Ok(DesktopResponse::Schedules {
            schedules,
            time_zone,
            next_runs,
        }) => (
            StatusCode::OK,
            Json(json!({
                "schedules": schedules
                    .into_iter()
                    .map(MobileSchedule::from)
                    .collect::<Vec<_>>(),
                "time_zone": time_zone,
                "next_runs": next_runs,
            })),
        ),
        Ok(DesktopResponse::Error { code, .. }) => api_error(
            if code == "tab_not_found" {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::BAD_REQUEST
            },
            &code,
        ),
        _ => api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
    }
}

/// Resolve an opaque tab id to the (raw project id, tmux name) pair the
/// desktop bridge addresses a tab by. `agent_only` is what the schedule,
/// prompt-send and rename routes need — those surfaces exist for agent tabs
/// alone — while the close route serves every tab the phone lists, shell
/// included. Neither value is ever serialized back to the phone.
fn tab_target(
    state: &HostState,
    tab_id: &str,
    agent_only: bool,
) -> Result<(String, String), (StatusCode, Json<serde_json::Value>)> {
    let catalog = catalog(state)?;
    let Some((project, tab)) = catalog.tab(tab_id) else {
        return Err(api_error(StatusCode::NOT_FOUND, "tab_not_found"));
    };
    if agent_only && tab.public.kind != "agent" {
        return Err(api_error(StatusCode::BAD_REQUEST, "agent_tab_required"));
    }
    Ok((project.raw_id.clone(), tab.tmux_name.clone()))
}

fn agent_tab_target(
    state: &HostState,
    tab_id: &str,
) -> Result<(String, String), (StatusCode, Json<serde_json::Value>)> {
    tab_target(state, tab_id, true)
}

/// [`agent_tab_target`] keeping the whole catalog record — what answering a
/// tab's schedules or transcript with no window open needs (its schedule
/// binding, command and folder), none of which is ever serialized back.
fn agent_tab(
    state: &HostState,
    tab_id: &str,
) -> Result<(String, ResolvedTab), (StatusCode, Json<serde_json::Value>)> {
    let catalog = catalog(state)?;
    let Some((project, tab)) = catalog.tab(tab_id) else {
        return Err(api_error(StatusCode::NOT_FOUND, "tab_not_found"));
    };
    if tab.public.kind != "agent" {
        return Err(api_error(StatusCode::BAD_REQUEST, "agent_tab_required"));
    }
    Ok((project.raw_id.clone(), tab.clone()))
}

async fn schedules(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(tab_id): Path<String>,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    let (project_id, tab) = match agent_tab(&state, &tab_id) {
        Ok(target) => target,
        Err(error) => return error,
    };
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    let response = admin::desktop_call(
        &desktop_socket,
        &DesktopRequest::Schedules {
            request_id,
            project_id: project_id.clone(),
            tmux_session: tab.tmux_name.clone(),
        },
    )
    .await;
    if desktop_down(&response) {
        // No window: the rows come off `agent_tasks.json`, read-only. A tab
        // the desktop never bound to a schedule target has no rows yet.
        let listed = match tab.schedule_target_id.as_deref() {
            Some(target) => headless::schedules(&state.config.state_dir, &project_id, target, chrono::Local::now()),
            None => Ok(headless::TabSchedules {
                schedules: Vec::new(),
                time_zone: headless::local_time_zone(),
                next_runs: Default::default(),
            }),
        };
        return match listed {
            Ok(listed) => (
                StatusCode::OK,
                Json(json!({
                    "schedules": listed.schedules.into_iter().map(MobileSchedule::from).collect::<Vec<_>>(),
                    "time_zone": listed.time_zone,
                    "next_runs": listed.next_runs,
                    "desktop_available": false,
                })),
            ),
            Err(_) => api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
        };
    }
    schedule_desktop_error(response)
}

/// `?refresh=1` — ask the desktop to run the agent's CLI again rather than
/// answering from its own short-lived cache. Anything else reads as "no".
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct AgentStatusQuery {
    refresh: Option<String>,
}

/// `GET /api/v1/tabs/{tab_id}/status` — the phone's status button on an agent
/// tab. The desktop answers with what the session is doing plus the panel its
/// CLI prints for `/usage`; reading that panel may spawn the CLI once in print
/// mode, which is why this request carries a longer deadline than the other
/// control calls (`DesktopRequest::response_timeout`).
async fn agent_status(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(tab_id): Path<String>,
    Query(query): Query<AgentStatusQuery>,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    let (project_id, tmux_session) = match agent_tab_target(&state, &tab_id) {
        Ok(target) => target,
        Err(error) => return error,
    };
    let refresh = matches!(query.refresh.as_deref(), Some("1" | "true"));
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    let response = admin::desktop_call(
        &desktop_socket,
        &DesktopRequest::AgentStatus {
            request_id,
            project_id,
            tmux_session,
            refresh,
        },
    )
    .await;
    if desktop_down(&response) {
        // No window: the state and today's tally off the files; the CLI's
        // usage panel needs the window (headless owner plan, H3).
        let Ok(snapshot) = catalog(&state) else {
            return api_error(StatusCode::SERVICE_UNAVAILABLE, "catalog_unavailable");
        };
        let Some((project, tab)) = snapshot.tab(&tab_id) else {
            return api_error(StatusCode::NOT_FOUND, "tab_not_found");
        };
        let report = headless::agent_status(&state.config.state_dir, project, tab);
        return (StatusCode::OK, Json(json!({ "report": report, "desktop_available": false })));
    }
    match response {
        Ok(DesktopResponse::AgentStatus { report }) => (
            StatusCode::OK,
            Json(json!({ "report": report })),
        ),
        Ok(DesktopResponse::Error { code, .. }) => api_error(
            if code == "tab_not_found" {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::BAD_REQUEST
            },
            &code,
        ),
        _ => api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
    }
}

/// `?version=` is the fingerprint the phone last saw; `?limit=` how many of
/// the newest turns it wants; `?subagent=` the handle on an `agent` entry,
/// whose conversation is read instead. Anything else is refused.
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct TranscriptQuery {
    version: Option<String>,
    limit: Option<usize>,
    subagent: Option<String>,
}

/// `GET /api/v1/tabs/{tab_id}/transcript` — the stored conversation behind
/// an agent tab, for the phone's Focus view. The desktop reads the CLI's own
/// transcript (`services::agent_transcript`) and answers with its prompts and
/// answers, or with why it cannot (`available: false`); a phone that hands
/// back the `version` it last saw is answered `unchanged`.
async fn agent_transcript(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(tab_id): Path<String>,
    Query(query): Query<TranscriptQuery>,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    // A handle is a digest the desktop minted; anything else is not one.
    if query
        .subagent
        .as_deref()
        .is_some_and(|token| !crate::services::agent_transcript::is_subagent_token(token))
    {
        return api_error(StatusCode::BAD_REQUEST, "invalid_subagent");
    }
    let (project_id, tab) = match agent_tab(&state, &tab_id) {
        Ok(target) => target,
        Err(error) => return error,
    };
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    let response = admin::desktop_call(
        &desktop_socket,
        &DesktopRequest::AgentTranscript {
            request_id,
            project_id: project_id.clone(),
            tmux_session: tab.tmux_name.clone(),
            subagent: query.subagent.clone(),
            version: query.version.clone(),
            limit: query.limit,
        },
    )
    .await;
    if desktop_down(&response) {
        // No window: the CLI's own transcript is read here, off the tab record.
        let transcript = tokio::task::spawn_blocking(move || {
            headless::transcript(
                &project_id,
                &tab,
                query.subagent.as_deref(),
                query.version.as_deref(),
                query.limit,
            )
        })
        .await
        .unwrap_or_else(|_| crate::services::agent_transcript::AgentTranscript::unavailable("read_failed"));
        return (
            StatusCode::OK,
            Json(json!({ "transcript": phone_transcript(transcript), "desktop_available": false })),
        );
    }
    match response {
        Ok(DesktopResponse::AgentTranscript { transcript }) => (
            StatusCode::OK,
            Json(json!({ "transcript": phone_transcript(transcript) })),
        ),
        Ok(DesktopResponse::Error { code, .. }) => api_error(
            if code == "tab_not_found" {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::BAD_REQUEST
            },
            &code,
        ),
        _ => api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
    }
}

/// A transcript as the phone may see it: the shell commands the desktop
/// Reader shows beside its working row are command lines, which never cross
/// the browser API.
fn phone_transcript(
    mut transcript: crate::services::agent_transcript::AgentTranscript,
) -> crate::services::agent_transcript::AgentTranscript {
    transcript.shells.clear();
    transcript
}

async fn schedule_mutation(
    state: &HostState,
    tab_id: &str,
    action: ScheduleMutation,
) -> (StatusCode, Json<serde_json::Value>) {
    let (project_id, tab) = match agent_tab(state, tab_id) {
        Ok(target) => target,
        Err(error) => return error,
    };
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    let response = admin::desktop_call(
        &desktop_socket,
        &DesktopRequest::ScheduleMutate {
            request_id,
            project_id: project_id.clone(),
            tmux_session: tab.tmux_name.clone(),
            action: action.clone(),
        },
    )
    .await;
    if desktop_down(&response) {
        // No window: the rule lands in `agent_tasks.json` under its lock
        // (headless owner plan, H3); the sidecar's own scheduler fires it.
        let Some(target) = tab.schedule_target_id.as_deref() else {
            return api_error(StatusCode::NOT_FOUND, "tab_not_found");
        };
        return match headless::schedule_mutate(&state.config.state_dir, &project_id, target, action, chrono::Local::now()) {
            Ok(listed) => {
                poke_window(state, Some(&project_id), &["schedules"]);
                (
                    StatusCode::OK,
                    Json(json!({
                        "schedules": listed.schedules.into_iter().map(MobileSchedule::from).collect::<Vec<_>>(),
                        "time_zone": listed.time_zone,
                        "next_runs": listed.next_runs,
                        "desktop_available": false,
                    })),
                )
            }
            Err(code) if code == "schedule_not_found" => api_error(StatusCode::NOT_FOUND, &code),
            Err(why) => {
                eprintln!("mobile: a schedule write with no window failed: {why}");
                api_error(StatusCode::BAD_REQUEST, "invalid_request")
            }
        };
    }
    schedule_desktop_error(response)
}

async fn schedule_create(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(tab_id): Path<String>,
    body: Bytes,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    let Ok(schedule) = serde_json::from_slice::<MobileScheduleInput>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    let (status, body) =
        schedule_mutation(&state, &tab_id, ScheduleMutation::Create { schedule }).await;
    (
        if status == StatusCode::OK {
            StatusCode::CREATED
        } else {
            status
        },
        body,
    )
}

async fn schedule_update(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path((tab_id, schedule_id)): Path<(String, String)>,
    body: Bytes,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    let Ok(schedule) = serde_json::from_slice::<MobileScheduleInput>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    schedule_mutation(
        &state,
        &tab_id,
        ScheduleMutation::Update {
            schedule_id,
            schedule,
        },
    )
    .await
}

async fn schedule_delete(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path((tab_id, schedule_id)): Path<(String, String)>,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    schedule_mutation(&state, &tab_id, ScheduleMutation::Delete { schedule_id }).await
}

// ── Project prompt collection ────────────────────────────────────────────────
// Prompts are project-scoped and tab-free, so the routes hang off the opaque
// project id; only `send` names a tab, and that tab must be an agent tab of
// the same project. The desktop owns ids, timestamps and "now".

fn prompt_desktop_error(
    response: Result<DesktopResponse, String>,
) -> (StatusCode, Json<serde_json::Value>) {
    match response {
        Ok(DesktopResponse::Prompts { prompts }) => {
            let prompts = prompts
                .into_iter()
                .map(MobileCollectedPrompt::from)
                .collect::<Vec<_>>();
            (StatusCode::OK, Json(json!({ "prompts": prompts })))
        }
        Ok(DesktopResponse::Error { code, .. }) => api_error(
            match code.as_str() {
                "tab_not_found" | "prompt_not_found" => StatusCode::NOT_FOUND,
                "desktop_unavailable" => StatusCode::SERVICE_UNAVAILABLE,
                _ => StatusCode::BAD_REQUEST,
            },
            &code,
        ),
        _ => api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
    }
}

fn prompt_project(
    state: &HostState,
    project_id: &str,
) -> Result<String, (StatusCode, Json<serde_json::Value>)> {
    let catalog = catalog(state)?;
    let Some(project) = catalog.project(project_id) else {
        return Err(api_error(StatusCode::NOT_FOUND, "project_not_found"));
    };
    Ok(project.raw_id.clone())
}

async fn prompts(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    let project_id = match prompt_project(&state, &project_id) {
        Ok(raw) => raw,
        Err(error) => return error,
    };
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let response = admin::desktop_call(
        &desktop_socket,
        &DesktopRequest::Prompts {
            request_id,
            project_id: project_id.clone(),
        },
    )
    .await;
    if desktop_down(&response) {
        // No window: the rows come off `agent_prompts.json`, read-only.
        return match headless::prompts(&state.config.state_dir, &project_id) {
            Ok(prompts) => (
                StatusCode::OK,
                Json(json!({
                    "prompts": prompts.into_iter().map(MobileCollectedPrompt::from).collect::<Vec<_>>(),
                    "desktop_available": false,
                })),
            ),
            Err(_) => api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
        };
    }
    prompt_desktop_error(response)
}

/// Authentication and origin come before the body is even parsed, so an
/// anonymous or cross-origin request learns nothing from a validation error.
fn mutation_guard(
    headers: &HeaderMap,
    state: &HostState,
) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    authenticate(headers, state)?;
    if !exact_origin(headers, state) {
        return Err(api_error(StatusCode::FORBIDDEN, "invalid_origin"));
    }
    Ok(())
}

async fn prompt_mutation(
    state: &HostState,
    project_id: &str,
    action: PromptMutation,
) -> (StatusCode, Json<serde_json::Value>) {
    let project_id = match prompt_project(state, project_id) {
        Ok(raw) => raw,
        Err(error) => return error,
    };
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let response = admin::desktop_call(
        &desktop_socket,
        &DesktopRequest::PromptMutate {
            request_id,
            project_id: project_id.clone(),
            action: action.clone(),
        },
    )
    .await;
    if desktop_down(&response) {
        // No window: the prompt lands in `agent_prompts.json` under its lock;
        // a send is queued as a one-time rule the sidecar's scheduler fires
        // (headless owner plan, H3).
        let target = match &action {
            PromptMutation::Send { tmux_session, .. } => {
                let Ok(snapshot) = catalog(state) else {
                    return api_error(StatusCode::SERVICE_UNAVAILABLE, "catalog_unavailable");
                };
                let Some(tab) = snapshot
                    .projects
                    .iter()
                    .filter(|p| p.raw_id == project_id)
                    .flat_map(|p| p.tabs.iter())
                    .find(|t| &t.tmux_name == tmux_session)
                else {
                    return api_error(StatusCode::NOT_FOUND, "tab_not_found");
                };
                let Some(schedule_target_id) = tab.schedule_target_id.clone() else {
                    return api_error(StatusCode::NOT_FOUND, "tab_not_found");
                };
                Some(headless::SendTarget {
                    schedule_target_id,
                    label: tab.public.label.clone(),
                    session_id: tab.session_id.clone(),
                    agent: tab.cmd.clone(),
                })
            }
            _ => None,
        };
        return match headless::prompt_mutate(&state.config.state_dir, &project_id, action, target, chrono::Local::now()) {
            Ok(prompts) => {
                poke_window(state, Some(&project_id), &["prompts", "schedules"]);
                (
                    StatusCode::OK,
                    Json(json!({
                        "prompts": prompts.into_iter().map(MobileCollectedPrompt::from).collect::<Vec<_>>(),
                        "desktop_available": false,
                    })),
                )
            }
            Err(code) if code == "prompt_not_found" || code == "tab_not_found" => api_error(StatusCode::NOT_FOUND, &code),
            Err(why) => {
                eprintln!("mobile: a prompt write with no window failed: {why}");
                api_error(StatusCode::BAD_REQUEST, "invalid_request")
            }
        };
    }
    prompt_desktop_error(response)
}

async fn prompt_create(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
    body: Bytes,
) -> impl IntoResponse {
    if let Err(error) = mutation_guard(&headers, &state) {
        return error;
    }
    let Ok(prompt) = serde_json::from_slice::<MobilePromptInput>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    let (status, body) =
        prompt_mutation(&state, &project_id, PromptMutation::Create { prompt }).await;
    (
        if status == StatusCode::OK {
            StatusCode::CREATED
        } else {
            status
        },
        body,
    )
}

async fn prompt_update(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path((project_id, prompt_id)): Path<(String, String)>,
    body: Bytes,
) -> impl IntoResponse {
    if let Err(error) = mutation_guard(&headers, &state) {
        return error;
    }
    let Ok(prompt) = serde_json::from_slice::<MobilePromptInput>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    prompt_mutation(
        &state,
        &project_id,
        PromptMutation::Update { prompt_id, prompt },
    )
    .await
}

async fn prompt_delete(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path((project_id, prompt_id)): Path<(String, String)>,
) -> impl IntoResponse {
    if let Err(error) = mutation_guard(&headers, &state) {
        return error;
    }
    prompt_mutation(&state, &project_id, PromptMutation::Delete { prompt_id }).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PromptSendBody {
    tab_id: String,
}

async fn prompt_send(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path((project_id, prompt_id)): Path<(String, String)>,
    body: Bytes,
) -> impl IntoResponse {
    if let Err(error) = mutation_guard(&headers, &state) {
        return error;
    }
    let Ok(send) = serde_json::from_slice::<PromptSendBody>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    // The tab is resolved here, before the generic mutation path, so a tab id
    // from another project can never aim a prompt across projects.
    let tmux_session = {
        let catalog = match catalog(&state) {
            Ok(catalog) => catalog,
            Err(error) => return error,
        };
        let Some((tab_project, tab)) = catalog.tab(&send.tab_id) else {
            return api_error(StatusCode::NOT_FOUND, "tab_not_found");
        };
        if tab.public.kind != "agent" {
            return api_error(StatusCode::BAD_REQUEST, "agent_tab_required");
        }
        if catalog.project(&project_id).map(|project| project.raw_id.as_str())
            != Some(tab_project.raw_id.as_str())
        {
            return api_error(StatusCode::NOT_FOUND, "tab_not_found");
        }
        tab.tmux_name.clone()
    };
    prompt_mutation(
        &state,
        &project_id,
        PromptMutation::Send {
            prompt_id,
            tmux_session,
        },
    )
    .await
}

/// `POST /api/v1/tabs/{id}/undo-clear` — the phone's Undo after a Clear: the
/// desktop types the resume of the conversation the tab's last `/clear` ended
/// (`DesktopRequest::UndoClear`). The session id never reaches the phone; a
/// session that has moved on answers `409 nothing_to_undo`.
async fn undo_clear(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(tab_id): Path<String>,
) -> impl IntoResponse {
    if let Err(error) = mutation_guard(&headers, &state) {
        return error;
    }
    let (project_id, tmux_session) = match agent_tab_target(&state, &tab_id) {
        Ok(target) => target,
        Err(error) => return error,
    };
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    let response = admin::desktop_call(
        &desktop_socket,
        &DesktopRequest::UndoClear {
            request_id,
            project_id: project_id.clone(),
            tmux_session,
        },
    )
    .await;
    if desktop_down(&response) {
        // No window: the owner takes the clear back (headless owner plan,
        // H3) — Claude's resume typed into the session, the others
        // relaunched onto the cleared conversation.
        return undo_clear_headless(&state, &tab_id).await;
    }
    match response {
        Ok(DesktopResponse::Seen) => (StatusCode::OK, Json(json!({ "undone": true }))),
        Ok(DesktopResponse::Error { code, .. }) => api_error(
            match code.as_str() {
                "desktop_unavailable" | "tab_not_ready" => StatusCode::SERVICE_UNAVAILABLE,
                "tab_not_found" => StatusCode::NOT_FOUND,
                "nothing_to_undo" | "remote_tab" => StatusCode::CONFLICT,
                _ => StatusCode::BAD_REQUEST,
            },
            &code,
        ),
        _ => api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
    }
}

/// `undo_clear` with no window: the plan `agent_session::undo_clear_plan`
/// makes for the tab (read off the process's own state dir — the same one
/// in production) applied through the host's runner and spawn seam.
async fn undo_clear_headless(state: &HostState, tab_id: &str) -> (StatusCode, Json<serde_json::Value>) {
    let Ok(snapshot) = catalog(state) else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "catalog_unavailable");
    };
    let Some((project, tab)) = snapshot.tab(tab_id) else {
        return api_error(StatusCode::NOT_FOUND, "tab_not_found");
    };
    if project.public.kind == ScopeKind::Root {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable");
    }
    let Some(uid) = tab.session_id.clone().filter(|id| !id.is_empty()) else {
        return api_error(StatusCode::CONFLICT, "nothing_to_undo");
    };
    let (agent, raw_id) = (tab.cmd.clone(), project.raw_id.clone());
    let plan = tokio::task::spawn_blocking(move || crate::services::agent_session::undo_clear_plan(&agent, Some(&raw_id), &uid))
        .await
        .ok()
        .flatten();
    match headless::apply_undo_plan(&state.config.state_dir, project, tab, plan, state.runner.clone(), &state.spawner.launch).await {
        Ok(headless::UndoOutcome::Undone) => (StatusCode::OK, Json(json!({ "undone": true, "desktop_available": false }))),
        Ok(headless::UndoOutcome::NothingToUndo) => api_error(StatusCode::CONFLICT, "nothing_to_undo"),
        Ok(headless::UndoOutcome::TabNotReady) => api_error(StatusCode::SERVICE_UNAVAILABLE, "tab_not_ready"),
        Err(why) => {
            eprintln!("mobile: an undo with no window failed: {why}");
            api_error(StatusCode::SERVICE_UNAVAILABLE, "tab_not_ready")
        }
    }
}

/// Tell the desktop a phone had this agent tab on screen, so its activity
/// store marks the tab's output read (see `clearAttention`). Fire-and-forget:
/// nothing in the terminal path may wait on the desktop, which is why this
/// spawns rather than awaits — a wedged bridge would otherwise hold the
/// WebSocket attach for the full control-call deadline.
fn mark_tab_seen(state: &HostState, project_id: Option<String>, tmux_session: String, uid: Option<&str>) {
    let Some(project_id) = project_id else {
        return;
    };
    // Remembered on disk too (H3): the headless readings answer from files,
    // and a turn the phone watched finish must not come back as `done` once
    // the window is closed.
    if let Some(uid) = uid {
        headless::mark_seen(&state.config.state_dir, uid, now_ms() / 1000);
    }
    let socket = state.config.control_dir.join("desktop-control.sock");
    tokio::spawn(async move {
        // No `exists()` pre-check: a closed desktop refuses the connect at
        // once, and on Windows the nominal socket path is never a file, so the
        // check silently dropped every report there.
        let request_id = Base64UrlUnpadded::encode_string(&random_16());
        let _ = admin::desktop_call(
            &socket,
            &DesktopRequest::TabSeen {
                request_id,
                project_id,
                tmux_session,
            },
        )
        .await;
    });
}

/// Tell the desktop a phone typed into this agent tab, so its activity store
/// counts the session as commanded and classifies what follows (see
/// `noteUserInput`). Fire-and-forget for the same reason `mark_tab_seen` is:
/// nothing in the terminal path may wait on the desktop.
fn mark_tab_input(socket: &std::path::Path, project_id: Option<String>, tmux_session: String) {
    let Some(project_id) = project_id else {
        return;
    };
    let socket = socket.to_path_buf();
    tokio::spawn(async move {
        let request_id = Base64UrlUnpadded::encode_string(&random_16());
        let _ = admin::desktop_call(
            &socket,
            &DesktopRequest::TabInput {
                request_id,
                project_id,
                tmux_session,
            },
        )
        .await;
    });
}

async fn terminal(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(tab_id): Path<String>,
    ws: WebSocketUpgrade,
) -> Response<Body> {
    if authenticate(&headers, &state).is_err() {
        return api_error(StatusCode::UNAUTHORIZED, "authentication_required").into_response();
    }
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin").into_response();
    }
    let offered = headers
        .get(header::SEC_WEBSOCKET_PROTOCOL)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let Some(protocol) = terminal_protocol_in(&crate::brand::PAIR, offered) else {
        return api_error(StatusCode::BAD_REQUEST, "terminal_protocol_required").into_response();
    };
    let Ok(catalog) = catalog(&state) else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "catalog_unavailable").into_response();
    };
    let Some((tab_project, tab)) = catalog.tab(&tab_id) else {
        return api_error(StatusCode::NOT_FOUND, "tab_not_found").into_response();
    };
    if !tab.public.available {
        return api_error(StatusCode::GONE, "session_gone").into_response();
    }
    // Only an agent tab carries a status the phone can retire; a shell raises
    // none, so it never needs the desktop told about it.
    let seen_project = (tab.public.kind == "agent").then(|| tab_project.raw_id.clone());
    // Deliberately no `session_busy` pre-check: the bridge now displaces a
    // stale viewer instead, so a phone that was backgrounded before its
    // `detached` frame flushed does not lock the user out of their own agent
    // until the idle reaper (`pty_bridge::IDLE_TIMEOUT`) fires. A genuinely live viewer that
    // refuses to yield still produces `session_busy`, from the bridge.
    let tmux = tab.tmux_name.clone();
    let registry = state.terminal_registry.clone();
    let auth = state.auth.clone();
    let token = cookie_token(&headers).unwrap_or_default().to_string();
    let state_dir = state.config.state_dir.clone();
    let catalog = state.catalog.clone();
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let seen_tmux = tmux.clone();
    let seen_uid = tab.session_id.clone();
    let seen_state = state.clone();
    let input_socket = desktop_socket.clone();
    let input_project = seen_project.clone();
    let input_tmux = tmux.clone();
    // `DefaultBodyLimit` does not reach WebSocket frames, and tungstenite's
    // default is 64 MiB — so `MAX_INPUT_FRAME` was only checked *after* the
    // server had already buffered a thousandfold more than it allows.
    ws.protocols([protocol])
        .max_message_size(MAX_INPUT_FRAME)
        .max_frame_size(MAX_INPUT_FRAME)
        .on_upgrade(move |socket| async move {
            // Opening the tab on the phone reads its output, exactly as
            // switching to it on the desktop does — and closing it again is the
            // last moment the screen was in front of somebody. Both edges are
            // stamped, so a turn that finished while the phone was watching
            // does not come back as an unread `done` the moment it detaches.
            // A page going hidden and coming back are the same two edges with
            // the socket left open, and the bridge stamps those (and the
            // detach, unless the page was hidden by then): a turn that
            // finishes in a pocket is still unread when the phone comes out.
            let seen = move || {
                mark_tab_seen(&seen_state, seen_project.clone(), seen_tmux.clone(), seen_uid.as_deref())
            };
            seen();
            let _ = pty_bridge::attach(
                socket,
                tmux,
                registry,
                auth,
                token,
                state_dir,
                tab_id,
                catalog,
                move || {
                    mark_tab_input(&input_socket, input_project.clone(), input_tmux.clone());
                },
                seen,
            )
            .await;
        })
}

#[derive(Deserialize)]
struct InboxQuery {
    /// The phone's file name — a query parameter because a header cannot
    /// carry a non-Latin-1 name and the phone's photo library is not ASCII.
    #[serde(default)]
    name: String,
}

/// `POST /api/v1/tabs/{tab_id}/inbox` — the composer's **+ → From this phone**.
/// The raw body is the file; it lands in the tab's project under
/// `.tabtivity/inbox/` and the phone gets the project-relative reference back to
/// put after an `@`. The tab names the project and nothing else: a session
/// that has ended can still receive a file for the next one. See
/// `inbox.rs` for why a relative reference may cross the boundary.
async fn inbox_upload(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(tab_id): Path<String>,
    Query(query): Query<InboxQuery>,
    body: Bytes,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    let Ok(catalog) = catalog(&state) else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "catalog_unavailable");
    };
    let Some((project, _)) = catalog.tab(&tab_id) else {
        return api_error(StatusCode::NOT_FOUND, "tab_not_found");
    };
    let root = project.root.clone();
    drop(catalog);
    store_in_project_inbox(root, query.name, body).await
}

/// `POST /api/v1/projects/{project_id}/inbox` — the project screen's
/// **＋ → Send a file**: the same drop box as `inbox_upload`, named by the
/// project, because that screen has no tab to name — a project whose tabs are
/// all closed can still be sent a document for the next session.
async fn project_inbox_upload(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
    Query(query): Query<InboxQuery>,
    body: Bytes,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    match project_drop_box_root(&state, &project_id) {
        Ok(root) => store_in_project_inbox(root, query.name, body).await,
        Err(error) => error,
    }
}

/// One project-inbox write, answered with the stored name, the project-relative
/// reference and the size — never the root it was written under.
async fn store_in_project_inbox(
    root: PathBuf,
    name: String,
    body: Bytes,
) -> (StatusCode, Json<serde_json::Value>) {
    // The write is synchronous filesystem work of up to MAX_INBOX_FILE bytes;
    // keep it off the connection executor.
    let stored = tokio::task::spawn_blocking(move || inbox::store(&root, &name, &body))
        .await
        .unwrap_or_else(|error| Err(inbox::InboxError::Io(error.to_string())));
    match stored {
        Ok(stored) => (
            StatusCode::CREATED,
            Json(json!({ "attachment": {
                "name": stored.name,
                "reference": stored.reference,
                "size": stored.size,
            } })),
        ),
        Err(error) => inbox_error(error),
    }
}

/// An inbox write's refusal as the phone's status — one vocabulary for the
/// project inbox and the global one.
fn inbox_error(error: inbox::InboxError) -> (StatusCode, Json<serde_json::Value>) {
    api_error(
        match error {
            inbox::InboxError::Empty => StatusCode::BAD_REQUEST,
            inbox::InboxError::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            inbox::InboxError::Full => StatusCode::INSUFFICIENT_STORAGE,
            inbox::InboxError::Unavailable => StatusCode::CONFLICT,
            inbox::InboxError::Io(_) => StatusCode::INTERNAL_SERVER_ERROR,
        },
        error.code(),
    )
}

/// `POST /api/v1/inbox` — the phone's **Send to desktop**: a file that belongs
/// to no project. It lands in Tabtivity's own `<state_dir>/inbox/`, never in a
/// project folder, and the desktop's header lists it from there. The answer
/// carries the stored name and size only — there is nothing to reference.
async fn global_inbox_upload(
    State(state): State<HostState>,
    headers: HeaderMap,
    Query(query): Query<InboxQuery>,
    body: Bytes,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    let state_dir = state.config.state_dir.clone();
    let stored =
        tokio::task::spawn_blocking(move || inbox::store_global(&state_dir, &query.name, &body))
            .await
            .unwrap_or_else(|error| Err(inbox::InboxError::Io(error.to_string())));
    match stored {
        Ok(stored) => (
            StatusCode::CREATED,
            Json(json!({ "file": { "name": stored.name, "size": stored.size } })),
        ),
        Err(error) => inbox_error(error),
    }
}

/// The project an inbox-bound request is for, by its tab — the tab names the
/// project and nothing else, exactly as `inbox_upload` reads it.
fn inbox_project(
    state: &HostState,
    tab_id: &str,
) -> Result<String, (StatusCode, Json<serde_json::Value>)> {
    let catalog = catalog(state)?;
    let Some((project, _)) = catalog.tab(tab_id) else {
        return Err(api_error(StatusCode::NOT_FOUND, "tab_not_found"));
    };
    Ok(project.raw_id.clone())
}

/// The desktop's refusal of a desktop-image request, as the phone's status.
/// The inbox codes map exactly as `inbox_upload` maps them, so the phone
/// reads one vocabulary for both ways of filling the inbox.
fn desktop_image_error(code: &str) -> (StatusCode, Json<serde_json::Value>) {
    api_error(
        match code {
            "tab_not_found" | "project_ineligible" | "image_not_found" => StatusCode::NOT_FOUND,
            "no_clipboard_image" | "project_unavailable" => StatusCode::CONFLICT,
            "file_too_large" => StatusCode::PAYLOAD_TOO_LARGE,
            "inbox_full" => StatusCode::INSUFFICIENT_STORAGE,
            "desktop_unavailable" => StatusCode::SERVICE_UNAVAILABLE,
            _ => StatusCode::BAD_REQUEST,
        },
        code,
    )
}

/// `GET /api/v1/tabs/{tab_id}/desktop-images` — the composer's **+ → From the
/// desktop**: what the desktop would copy into this tab's project inbox (its
/// clipboard image, recent screenshots and pictures). Opaque ids and folder
/// labels only; the desktop keeps every path.
async fn desktop_images(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(tab_id): Path<String>,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    let project_id = match inbox_project(&state, &tab_id) {
        Ok(raw) => raw,
        Err(error) => return error,
    };
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let response = admin::desktop_call(
        &desktop_socket,
        &DesktopRequest::DesktopImages {
            request_id,
            project_id,
        },
    )
    .await;
    if desktop_down(&response) {
        // No window: the folders are listed here, without the clipboard
        // (headless owner plan, H3).
        let state_dir = state.config.state_dir.clone();
        let images = tokio::task::spawn_blocking(move || headless::desktop_images(&state_dir)).await.unwrap_or_default();
        return (StatusCode::OK, Json(json!({ "images": images, "desktop_available": false })));
    }
    match response {
        Ok(DesktopResponse::DesktopImages { images }) => {
            (StatusCode::OK, Json(json!({ "images": images })))
        }
        Ok(DesktopResponse::Error { code, .. }) => desktop_image_error(&code),
        _ => api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
    }
}

#[derive(Deserialize)]
struct AttachDesktopImageBody {
    image_id: String,
}

/// `POST /api/v1/tabs/{tab_id}/desktop-images` — copy one listed image into
/// the tab's project inbox. Answers like `inbox_upload`: the stored name, the
/// project-relative `.tabtivity/inbox/<file>` reference, the size.
async fn attach_desktop_image(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(tab_id): Path<String>,
    body: Bytes,
) -> impl IntoResponse {
    if let Err(error) = mutation_guard(&headers, &state) {
        return error;
    }
    let Ok(request) = serde_json::from_slice::<AttachDesktopImageBody>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    if !desktop_images::valid_id(&request.image_id) {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    }
    let project_id = match inbox_project(&state, &tab_id) {
        Ok(raw) => raw,
        Err(error) => return error,
    };
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let response = admin::desktop_call(
        &desktop_socket,
        &DesktopRequest::AttachDesktopImage {
            request_id,
            project_id,
            image_id: request.image_id.clone(),
        },
    )
    .await;
    if desktop_down(&response) {
        // No window: the file is copied into the project's inbox here.
        let Ok(snapshot) = catalog(&state) else {
            return api_error(StatusCode::SERVICE_UNAVAILABLE, "catalog_unavailable");
        };
        let Some((project, _)) = snapshot.tab(&tab_id) else {
            return api_error(StatusCode::NOT_FOUND, "tab_not_found");
        };
        let (state_dir, root, image_id) = (state.config.state_dir.clone(), project.root.clone(), request.image_id);
        let attached = tokio::task::spawn_blocking(move || headless::attach_desktop_image(&state_dir, &root, &image_id))
            .await
            .unwrap_or_else(|_| Err("write_failed".to_string()));
        return match attached {
            Ok(attachment) => (StatusCode::CREATED, Json(json!({ "attachment": attachment, "desktop_available": false }))),
            Err(code) => desktop_image_error(&code),
        };
    }
    match response {
        Ok(DesktopResponse::Attached { attachment }) => (
            StatusCode::CREATED,
            Json(json!({ "attachment": attachment })),
        ),
        Ok(DesktopResponse::Error { code, .. }) => desktop_image_error(&code),
        _ => api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
    }
}

/// The project root an outbox request reads from, by its tab — the tab names
/// the project and nothing else, exactly as `inbox_upload` reads it: a
/// session that has ended still shows what it left for the phone.
fn outbox_root(
    state: &HostState,
    tab_id: &str,
) -> Result<PathBuf, (StatusCode, Json<serde_json::Value>)> {
    let catalog = catalog(state)?;
    let Some((project, _)) = catalog.tab(tab_id) else {
        return Err(api_error(StatusCode::NOT_FOUND, "tab_not_found"));
    };
    Ok(project.root.clone())
}

/// The same root by the project itself, for the project screen's outbox and
/// its ＋ → Send a file. Both drop boxes belong to the project, not to one of
/// its sessions: a project whose tabs are all closed — or one that never had
/// an agent tab — still has them, and that screen has no tab to name.
fn project_drop_box_root(
    state: &HostState,
    project_id: &str,
) -> Result<PathBuf, (StatusCode, Json<serde_json::Value>)> {
    let catalog = catalog(state)?;
    let Some(project) = catalog.project(project_id) else {
        return Err(api_error(StatusCode::NOT_FOUND, "project_not_found"));
    };
    Ok(project.root.clone())
}

fn outbox_error(error: outbox::OutboxError) -> (StatusCode, Json<serde_json::Value>) {
    api_error(
        match error {
            outbox::OutboxError::Unavailable => StatusCode::CONFLICT,
            outbox::OutboxError::NotFound => StatusCode::NOT_FOUND,
            outbox::OutboxError::Io(_) => StatusCode::INTERNAL_SERVER_ERROR,
        },
        error.code(),
    )
}

/// `GET /api/v1/tabs/{tab_id}/outbox` — the files the agent left in the
/// project's `.tabtivity/outbox/` for the phone to see (`outbox.rs`): leaf name,
/// kind, size and mtime, newest first. Read from disk by the sidecar itself,
/// like the inbox write — no desktop round trip, and no path in the answer.
async fn outbox_list(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(tab_id): Path<String>,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    let catalog = match catalog(&state) {
        Ok(catalog) => catalog,
        Err(error) => return error,
    };
    let Some((project, tab)) = catalog.tab(&tab_id) else {
        return api_error(StatusCode::NOT_FOUND, "tab_not_found");
    };
    // Every file is listed — the gallery holds them all — but only what this
    // tab sent is marked `from_tab`, the files its chat shows.
    outbox_listing(project.root.clone(), tab.session_id.clone()).await
}

/// `GET /api/v1/projects/{project_id}/outbox` — the same listing by the
/// project, for the project screen's shelf under the tab cards.
async fn project_outbox_list(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    match project_drop_box_root(&state, &project_id) {
        Ok(root) => outbox_listing(root, None).await,
        Err(error) => error,
    }
}

async fn outbox_listing(
    root: PathBuf,
    tab: Option<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    // A directory walk that opens every candidate: off the connection executor.
    let listed = tokio::task::spawn_blocking(move || outbox::list_for(&root, tab.as_deref()))
        .await
        .unwrap_or_else(|error| Err(outbox::OutboxError::Io(error.to_string())));
    match listed {
        Ok(files) => (StatusCode::OK, Json(json!({ "files": files }))),
        Err(error) => outbox_error(error),
    }
}

/// `GET /api/v1/tabs/{tab_id}/outbox/{name}` — one listed file's bytes,
/// typed by what its header says it is, never by its name. Loaded by an
/// `<img>` on the PWA's own origin, so the session cookie is the credential
/// and the CSP's `img-src 'self'` is what lets it render; the middleware's
/// `nosniff` and `no-store` apply as to every `/api/` answer. Anything the
/// listing would not offer — a symlink, an oversized file, a name with a
/// separator — is `file_not_found`, not a different error.
async fn outbox_file(
    State(state): State<HostState>,
    headers: HeaderMap,
    uri: Uri,
    Path((tab_id, name)): Path<(String, String)>,
    Query(query): Query<HashMap<String, String>>,
) -> Response<Body> {
    if let Err(error) = authenticate_or_ticket(&headers, &state, &uri) {
        return error.into_response();
    }
    let root = match outbox_root(&state, &tab_id) {
        Ok(root) => root,
        Err(error) => return error.into_response(),
    };
    outbox_bytes(root, name, query.get("download").is_some_and(|v| v == "1")).await
}

/// `GET /api/v1/projects/{project_id}/outbox/{name}` — the same bytes by the
/// project, so the shelf's thumbnails load without naming a session.
async fn project_outbox_file(
    State(state): State<HostState>,
    headers: HeaderMap,
    uri: Uri,
    Path((project_id, name)): Path<(String, String)>,
    Query(query): Query<HashMap<String, String>>,
) -> Response<Body> {
    if let Err(error) = authenticate_or_ticket(&headers, &state, &uri) {
        return error.into_response();
    }
    let root = match project_drop_box_root(&state, &project_id) {
        Ok(root) => root,
        Err(error) => return error.into_response(),
    };
    outbox_bytes(root, name, query.get("download").is_some_and(|v| v == "1")).await
}

/// `DELETE /api/v1/tabs/{tab_id}/outbox/{name}` — drop one of the files the
/// desktop published to this phone.
///
/// What the reader can see, the reader can clear: nothing prunes
/// `.tabtivity/outbox/`, and a picture that has been looked at could only be
/// removed from a shell on the desktop until now. Only a leaf the listing
/// handed out is deletable (`outbox::remove` re-proves it exactly as a read
/// does), and the exact-origin check every mutating route here carries applies
/// — a `GET` is the session cookie alone, a delete is not.
async fn outbox_delete(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path((tab_id, name)): Path<(String, String)>,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    match outbox_root(&state, &tab_id) {
        Ok(root) => outbox_removal(root, name).await,
        Err(error) => error,
    }
}

/// `DELETE /api/v1/projects/{project_id}/outbox/{name}` — the same removal by
/// the project, for the shelf on the project screen, whose files outlive every
/// session they were sent from.
async fn project_outbox_delete(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path((project_id, name)): Path<(String, String)>,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    match project_drop_box_root(&state, &project_id) {
        Ok(root) => outbox_removal(root, name).await,
        Err(error) => error,
    }
}

async fn outbox_removal(root: PathBuf, name: String) -> (StatusCode, Json<serde_json::Value>) {
    if !outbox::valid_name(&name) {
        return api_error(StatusCode::NOT_FOUND, "file_not_found");
    }
    let removed = tokio::task::spawn_blocking(move || outbox::remove(&root, &name))
        .await
        .unwrap_or_else(|error| Err(outbox::OutboxError::Io(error.to_string())));
    match removed {
        Ok(()) => (StatusCode::OK, Json(json!({ "removed": true }))),
        // The shared code for an I/O error here is `read_failed`, which the
        // phone words as "could not be loaded" — not what a delete failed at.
        Err(outbox::OutboxError::Io(_)) => {
            api_error(StatusCode::INTERNAL_SERVER_ERROR, "delete_failed")
        }
        Err(error) => outbox_error(error),
    }
}

async fn outbox_bytes(root: PathBuf, name: String, download: bool) -> Response<Body> {
    if !outbox::valid_name(&name) {
        return api_error(StatusCode::NOT_FOUND, "file_not_found").into_response();
    }
    // Saved under the name it was sent as, not the stamped leaf.
    let filename = outbox::sent_name(&name).to_string();
    let read = tokio::task::spawn_blocking(move || outbox::read(&root, &name))
        .await
        .unwrap_or_else(|error| Err(outbox::OutboxError::Io(error.to_string())));
    file_response(read, &filename, download)
}

/// A drop-box read as the phone gets it: typed by the bytes, inline unless it
/// is bytes the phone cannot show or a download was asked for.
fn file_response(
    read: Result<(Vec<u8>, &'static str), outbox::OutboxError>,
    filename: &str,
    download: bool,
) -> Response<Body> {
    match read {
        Ok((bytes, kind)) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, kind)
            .header(header::CONTENT_LENGTH, bytes.len())
            .header(header::CONTENT_DISPOSITION, if kind == "application/octet-stream" || download { format!("attachment; filename=\"{filename}\"") } else { "inline".into() })
            .body(Body::from(bytes))
            .unwrap_or_else(|_| {
                api_error(StatusCode::INTERNAL_SERVER_ERROR, "read_failed").into_response()
            }),
        Err(error) => outbox_error(error).into_response(),
    }
}

/// `GET /api/v1/tabs/{tab_id}/inbox?names=a,b` — what the phone sent into this
/// tab's project inbox, described for the chat's previews: the leaves are the
/// ones its own `@` references name (the composer's, the chat's), each typed
/// by its bytes (`inbox::describe`). Leaves the inbox does not hold are left
/// out. No listing of the whole inbox: the phone asks only for what it wrote.
async fn inbox_described(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(tab_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    let root = match outbox_root(&state, &tab_id) {
        Ok(root) => root,
        Err(error) => return error,
    };
    let names = query.get("names").cloned().unwrap_or_default();
    let described = tokio::task::spawn_blocking(move || {
        let names: Vec<&str> = names.split(',').filter(|name| !name.is_empty()).collect();
        inbox::describe(&root, &names)
    })
    .await
    .unwrap_or_else(|error| Err(outbox::OutboxError::Io(error.to_string())));
    match described {
        Ok(files) => (StatusCode::OK, Json(json!({ "files": files }))),
        Err(error) => outbox_error(error),
    }
}

/// `GET /api/v1/tabs/{tab_id}/inbox/{name}` — the bytes of one file the phone
/// sent into this tab's project inbox, for its picture in the chat and the
/// composer. Served exactly as an outbox file is (`outbox_bytes`): typed by
/// its header, a symlink or an unlisted name is `file_not_found`.
async fn inbox_file(
    State(state): State<HostState>,
    headers: HeaderMap,
    uri: Uri,
    Path((tab_id, name)): Path<(String, String)>,
    Query(query): Query<HashMap<String, String>>,
) -> Response<Body> {
    if let Err(error) = authenticate_or_ticket(&headers, &state, &uri) {
        return error.into_response();
    }
    let root = match outbox_root(&state, &tab_id) {
        Ok(root) => root,
        Err(error) => return error.into_response(),
    };
    if !inbox::valid_stored_name(&name) {
        return api_error(StatusCode::NOT_FOUND, "file_not_found").into_response();
    }
    let download = query.get("download").is_some_and(|v| v == "1");
    let filename = outbox::sent_name(&name).to_string();
    let read = tokio::task::spawn_blocking(move || inbox::read(&root, &name))
        .await
        .unwrap_or_else(|error| Err(outbox::OutboxError::Io(error.to_string())));
    file_response(read, &filename, download)
}

/// `POST /api/v1/tabs/{tab_id}/markup` — the markup view's **Submit**
/// (`markup.rs`): the marks of a PDF or picture the phone marked up, whose
/// layer PNGs already went through this tab's inbox. Bakes a PDF's marked copy
/// into the same inbox and answers the prompt the phone sends into the chat.
/// The source is named by a sealed file token of this tab's project or an
/// outbox leaf, read only; the answer carries project-relative references and
/// never the root.
async fn markup_submit(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(tab_id): Path<String>,
    body: Bytes,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    let Ok(request) = serde_json::from_slice::<markup::MarkupRequest>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, markup::MarkupError::Invalid.code());
    };
    if let Err(error) = markup::validate(&request) {
        return api_error(StatusCode::BAD_REQUEST, error.code());
    }
    let (root, raw_id, kind, send_back) = {
        let catalog = match catalog(&state) {
            Ok(catalog) => catalog,
            Err(error) => return error,
        };
        let Some((project, tab)) = catalog.tab(&tab_id) else {
            return api_error(StatusCode::NOT_FOUND, "tab_not_found");
        };
        // A tab with a session id is one `tabtivity-send` can answer into.
        (project.root.clone(), project.raw_id.clone(), project.public.kind, tab.session_id.is_some())
    };
    let source = match &request.source {
        markup::MarkupSource::Files(token) => {
            // The file browser's own gates: the host-wide switch, projects only.
            if !files::files_open(&state.config.state_dir) {
                return api_error(StatusCode::NOT_FOUND, "files_off");
            }
            if kind != ScopeKind::Project {
                return api_error(StatusCode::NOT_FOUND, "files_unavailable");
            }
            match files_rel(&state, &raw_id, Some(token)) {
                Ok(rel) => markup::ResolvedSource::Files(rel),
                Err(error) => return error,
            }
        }
        markup::MarkupSource::Outbox(name) => markup::ResolvedSource::Outbox(name.clone()),
    };
    // Reads, a bake bounded by its own deadline, and an inbox write.
    let submitted = tokio::task::spawn_blocking(move || markup::submit(&root, &source, &request, send_back)).await;
    match submitted {
        Ok(Ok(done)) => (StatusCode::OK, Json(json!({ "prompt": done.prompt, "marked": done.marked }))),
        Ok(Err(markup::MarkupError::Files(error))) => files_error(error),
        Ok(Err(markup::MarkupError::Outbox(error))) => outbox_error(error),
        Ok(Err(error @ markup::MarkupError::Unsupported)) => api_error(StatusCode::UNSUPPORTED_MEDIA_TYPE, error.code()),
        Ok(Err(error)) => api_error(StatusCode::BAD_REQUEST, error.code()),
        Err(_) => api_error(StatusCode::INTERNAL_SERVER_ERROR, "markup_failed"),
    }
}

// ── Markup questions (`services::markup_mcp`, the phone's half) ──────────────

/// Longest body a markup answer may carry: four **Other…** texts of 500
/// characters, four bytes each at worst, the option indices and the ask id.
const MAX_MARKUP_ANSWER_BODY: usize = 16 * 1024;

/// `?source=files:<token>` (a project file's sealed token) or
/// `?source=outbox:<leaf>` — the file the phone's markup view shows. Left out
/// by the Focus banner, which asks for every open ask of the tab.
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct MarkupQuestionsQuery {
    source: Option<String>,
}

/// An ask id as `services::markup_mcp` mints it: `ask-` and hex digits.
fn valid_ask_id(id: &str) -> bool {
    id.len() <= 64
        && id
            .strip_prefix("ask-")
            .is_some_and(|hex| !hex.is_empty() && hex.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// A refusal as a route answers it.
type ApiRefusal = (StatusCode, Json<serde_json::Value>);

/// The agent tab a markup question route names — its raw project id and
/// record — and, given the view's `source`, the project-relative path of the
/// file it shows: a files token unsealed under the file browser's own gates
/// (as the markup Submit does), or an outbox leaf (`markup::validate_source`).
/// Only that path goes on to the desktop; nothing of it comes back.
fn markup_tab(
    state: &HostState,
    tab_id: &str,
    source: Option<&str>,
) -> Result<(String, ResolvedTab, Option<String>), ApiRefusal> {
    let catalog = catalog(state)?;
    let Some((project, tab)) = catalog.tab(tab_id) else {
        return Err(api_error(StatusCode::NOT_FOUND, "tab_not_found"));
    };
    if tab.public.kind != "agent" {
        return Err(api_error(StatusCode::BAD_REQUEST, "agent_tab_required"));
    }
    let (raw_id, kind, tab) = (project.raw_id.clone(), project.public.kind, tab.clone());
    let Some(source) = source else {
        return Ok((raw_id, tab, None));
    };
    let source = match source.split_once(':') {
        Some(("files", token)) => markup::MarkupSource::Files(token.to_string()),
        Some(("outbox", leaf)) => markup::MarkupSource::Outbox(leaf.to_string()),
        _ => return Err(api_error(StatusCode::BAD_REQUEST, "invalid_source")),
    };
    if markup::validate_source(&source).is_err() {
        return Err(api_error(StatusCode::BAD_REQUEST, "invalid_source"));
    }
    let rel = match source {
        markup::MarkupSource::Files(token) => {
            if !files::files_open(&state.config.state_dir) {
                return Err(api_error(StatusCode::NOT_FOUND, "files_off"));
            }
            if kind != ScopeKind::Project {
                return Err(api_error(StatusCode::NOT_FOUND, "files_unavailable"));
            }
            let rel = files_rel(state, &raw_id, Some(&token))?;
            if rel.is_empty() {
                // The root folder's own token names no file.
                return Err(api_error(StatusCode::BAD_REQUEST, "invalid_source"));
            }
            rel
        }
        markup::MarkupSource::Outbox(leaf) => format!("{}/{leaf}", outbox::OUTBOX_DIR),
    };
    Ok((raw_id, tab, Some(rel)))
}

/// The name the phone is shown for an ask's file: its bare leaf, without the
/// send stamps an outbox copy carries — whatever the desktop answered, no
/// folder crosses.
fn markup_file_name(name: &str) -> Option<String> {
    let leaf = outbox::sent_name(name.rsplit(['/', '\\']).next().unwrap_or(name));
    (!leaf.is_empty()).then(|| leaf.to_string())
}

/// A markup question refusal under the status the phone reads it by. The
/// ask's own refusals are conflicts: the card re-lists and goes on.
fn markup_desktop_error(code: &str) -> ApiRefusal {
    api_error(
        match code {
            "desktop_unavailable" => StatusCode::SERVICE_UNAVAILABLE,
            "tab_not_found" => StatusCode::NOT_FOUND,
            "superseded" | "answered" | "gone" | "delivery_failed" | "not_delivered" => StatusCode::CONFLICT,
            _ => StatusCode::BAD_REQUEST,
        },
        code,
    )
}

/// Ask the window. The asks live in its process, beside the root MCP
/// listener that took them; with no window there is no listener and so no
/// ask, and the owner has nothing to answer from (headless owner plan) — a
/// closed desktop is `desktop_unavailable`, which the phone reads as "no
/// card". Never an error the phone would show.
async fn markup_call(state: &HostState, request: DesktopRequest) -> Result<DesktopResponse, ApiRefusal> {
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let response = admin::desktop_call(&desktop_socket, &request).await;
    if desktop_down(&response) {
        return Err(api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"));
    }
    match response {
        Ok(DesktopResponse::Error { code, .. }) => Err(markup_desktop_error(&code)),
        Ok(answer) => Ok(answer),
        Err(_) => Err(api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable")),
    }
}

/// `GET /api/v1/tabs/{tab_id}/markup/questions[?source=…]` — the agent tab's
/// open markup question (`services::markup_mcp`) for the phone's markup card,
/// or every open one for the Focus banner. Each ask carries its random id,
/// its questions and its file's leaf name — never a path.
async fn markup_questions(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(tab_id): Path<String>,
    Query(query): Query<MarkupQuestionsQuery>,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    let (project_id, tab, path) = match markup_tab(&state, &tab_id, query.source.as_deref()) {
        Ok(target) => target,
        Err(error) => return error,
    };
    let banner = path.is_none();
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    let request = DesktopRequest::MarkupQuestions { request_id, project_id: project_id.clone(), tmux_session: tab.tmux_name.clone(), path };
    match markup_call(&state, request).await {
        Ok(DesktopResponse::MarkupQuestions { asks }) => {
            let mut asks: Vec<_> = asks.into_iter().filter(|ask| valid_ask_id(&ask.id)).collect();
            // The path never crosses; for the Focus banner (no source) a
            // project file the drawer could open is handed over as its row.
            let paths: Vec<Option<String>> = asks
                .iter_mut()
                .map(|ask| {
                    ask.file_row = None;
                    ask.file_name = ask.file_name.as_deref().and_then(markup_file_name);
                    ask.path.take()
                })
                .collect();
            if banner {
                let rows = markup_banner_files(&state, &tab_id, &project_id, paths).await;
                for (ask, row) in asks.iter_mut().zip(rows) {
                    ask.file_row = row;
                }
            }
            (StatusCode::OK, Json(json!({ "asks": asks })))
        }
        Ok(_) => api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
        Err(error) => error,
    }
}

/// The Focus banner's file rows: each ask's project-relative path sealed as
/// the files drawer would row it (`files::entry`), with its folder's token
/// and folder trail. Only while the drawer is open for the project
/// (`files_scope`), never for an outbox copy (the phone finds those in its
/// own gallery), and `None` for a file the drawer would not list.
async fn markup_banner_files(state: &HostState, tab_id: &str, raw_id: &str, paths: Vec<Option<String>>) -> Vec<Option<MobileMarkupFile>> {
    let none = || vec![None; paths.len()];
    if paths.iter().all(Option::is_none) || !files::files_open(&state.config.state_dir) {
        return none();
    }
    let Ok(catalog) = catalog(state) else { return none() };
    let Some((project, _)) = catalog.tab(tab_id) else { return none() };
    if project.public.kind != ScopeKind::Project || project.raw_id != raw_id {
        return none();
    }
    let root = project.root.clone();
    let raw_id = raw_id.to_string();
    let key = state.auth.lock().unwrap_or_else(PoisonError::into_inner).host_key().to_vec();
    let outbox_dir = format!("{}/", outbox::OUTBOX_DIR);
    tokio::task::spawn_blocking(move || {
        paths
            .into_iter()
            .map(|path| {
                let rel = path.filter(|rel| !rel.starts_with(&outbox_dir))?;
                let entry = files::entry(&root, &rel, &key, &raw_id)?;
                let place = rel.rsplit_once('/').map(|(parent, _)| parent.to_string()).unwrap_or_default();
                let folder = (!place.is_empty()).then(|| files::seal(&key, &raw_id, &place));
                Some(MobileMarkupFile {
                    token: entry.token,
                    name: entry.name,
                    kind: entry.kind.to_string(),
                    size: entry.size,
                    modified: entry.modified,
                    folder,
                    place,
                })
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// `POST /api/v1/tabs/{tab_id}/markup/answer` — `{ ask_id, answers: [{
/// options: number[], other? }] }`, one per question in order. The desktop
/// checks it against the ask, builds the prompt and queues it into the tab;
/// the phone never sends prompt text here. `409` with the ask's code when it
/// does not take the answer (`superseded`, `answered`, `gone`), or when the
/// prompt could not be queued (`delivery_failed`: the ask is open again).
async fn markup_answer(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(tab_id): Path<String>,
    body: Bytes,
) -> impl IntoResponse {
    use crate::services::markup_mcp::{MAX_OPTIONS, MAX_OTHER_CHARS, MAX_QUESTIONS};
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct AnswerBody {
        ask_id: String,
        answers: Vec<super::protocol::MobileMarkupAnswer>,
    }
    let Ok(request) = serde_json::from_slice::<AnswerBody>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    if !valid_ask_id(&request.ask_id) {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    }
    let shaped = !request.answers.is_empty()
        && request.answers.len() <= MAX_QUESTIONS
        && request.answers.iter().all(|answer| {
            answer.options.len() <= MAX_OPTIONS
                && answer.options.iter().all(|&index| (index as usize) < MAX_OPTIONS)
                && answer.other.as_deref().is_none_or(|text| {
                    text.chars().count() <= MAX_OTHER_CHARS && !text.chars().any(char::is_control)
                })
        });
    if !shaped {
        return api_error(StatusCode::BAD_REQUEST, "invalid_answer");
    }
    let (project_id, tab, _) = match markup_tab(&state, &tab_id, None) {
        Ok(target) => target,
        Err(error) => return error,
    };
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    let request = DesktopRequest::MarkupAnswer {
        request_id,
        project_id,
        tmux_session: tab.tmux_name.clone(),
        ask_id: request.ask_id,
        answers: request.answers,
    };
    match markup_call(&state, request).await {
        Ok(DesktopResponse::Seen) => (StatusCode::OK, Json(json!({ "answered": true }))),
        Ok(_) => api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
        Err(error) => error,
    }
}

/// `POST /api/v1/tabs/{tab_id}/markup/dismiss` — `{ ask_id }`: **Answer in
/// chat instead**. The ask closes everywhere; nothing is typed. Idempotent.
async fn markup_dismiss(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(tab_id): Path<String>,
    body: Bytes,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct DismissBody {
        ask_id: String,
    }
    let Ok(request) = serde_json::from_slice::<DismissBody>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    if !valid_ask_id(&request.ask_id) {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    }
    let (project_id, tab, _) = match markup_tab(&state, &tab_id, None) {
        Ok(target) => target,
        Err(error) => return error,
    };
    let request_id = Base64UrlUnpadded::encode_string(&random_16());
    let request = DesktopRequest::MarkupDismiss { request_id, project_id, tmux_session: tab.tmux_name.clone(), ask_id: request.ask_id };
    match markup_call(&state, request).await {
        Ok(DesktopResponse::Seen) => (StatusCode::OK, Json(json!({ "dismissed": true }))),
        Ok(_) => api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
        Err(error) => error,
    }
}

/// The root and raw id a file-browser request reads by (`files.rs`). Closed —
/// `files_off` — unless the host-wide switch is on, read per request; a box
/// or the root console is `files_unavailable`.
fn files_scope(
    state: &HostState,
    project_id: &str,
) -> Result<(PathBuf, String), (StatusCode, Json<serde_json::Value>)> {
    if !files::files_open(&state.config.state_dir) {
        return Err(api_error(StatusCode::NOT_FOUND, "files_off"));
    }
    let catalog = catalog(state)?;
    let Some(project) = catalog.project(project_id) else {
        return Err(api_error(StatusCode::NOT_FOUND, "project_not_found"));
    };
    if project.public.kind != ScopeKind::Project {
        return Err(api_error(StatusCode::NOT_FOUND, "files_unavailable"));
    }
    Ok((project.root.clone(), project.raw_id.clone()))
}

fn files_error(error: files::FilesError) -> (StatusCode, Json<serde_json::Value>) {
    api_error(
        match error {
            files::FilesError::Unavailable => StatusCode::CONFLICT,
            files::FilesError::NotFound => StatusCode::NOT_FOUND,
            files::FilesError::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            files::FilesError::Io(_) => StatusCode::INTERNAL_SERVER_ERROR,
        },
        error.code(),
    )
}

/// The relative path a request's token seals, or `file_not_found` — a forged,
/// replayed or stale token reads exactly like a path that is not there.
fn files_rel(
    state: &HostState,
    raw_id: &str,
    token: Option<&String>,
) -> Result<String, (StatusCode, Json<serde_json::Value>)> {
    let Some(token) = token else {
        return Ok(String::new());
    };
    let key = state.auth.lock().unwrap_or_else(PoisonError::into_inner).host_key().to_vec();
    files::unseal(&key, raw_id, token).ok_or_else(|| api_error(StatusCode::NOT_FOUND, "file_not_found"))
}

/// `GET /api/v1/projects/{project_id}/files[?dir=<token>]` — one folder of the
/// project, read-only: sealed tokens, leaf names, kind, size, mtime. No `dir`
/// is the project root. No path appears in the answer.
async fn project_files_list(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    let (root, raw_id) = match files_scope(&state, &project_id) {
        Ok(scope) => scope,
        Err(error) => return error,
    };
    let rel = match files_rel(&state, &raw_id, query.get("dir")) {
        Ok(rel) => rel,
        Err(error) => return error,
    };
    let key = state.auth.lock().unwrap_or_else(PoisonError::into_inner).host_key().to_vec();
    // A directory walk that opens every kept file to type it: off the executor.
    let listed = tokio::task::spawn_blocking(move || files::list(&root, &rel, &key, &raw_id))
        .await
        .unwrap_or_else(|error| Err(files::FilesError::Io(error.to_string())));
    match listed {
        Ok(listing) => (StatusCode::OK, Json(json!(listing))),
        Err(error) => files_error(error),
    }
}

/// `GET /api/v1/projects/{project_id}/files/raw?f=<token>[&download=1]` — one
/// file's bytes, typed by its head as the outbox types them (active formats are
/// inert text), for the same viewer. Read-only: there is no write route.
async fn project_files_raw(
    State(state): State<HostState>,
    headers: HeaderMap,
    uri: Uri,
    Path(project_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Response<Body> {
    if let Err(error) = authenticate_or_ticket(&headers, &state, &uri) {
        return error.into_response();
    }
    let (root, raw_id) = match files_scope(&state, &project_id) {
        Ok(scope) => scope,
        Err(error) => return error.into_response(),
    };
    let Some(token) = query.get("f") else {
        return api_error(StatusCode::NOT_FOUND, "file_not_found").into_response();
    };
    let rel = match files_rel(&state, &raw_id, Some(token)) {
        Ok(rel) => rel,
        Err(error) => return error.into_response(),
    };
    let leaf = rel.rsplit('/').next().unwrap_or_default().to_string();
    let read = tokio::task::spawn_blocking(move || files::read(&root, &rel))
        .await
        .unwrap_or_else(|error| Err(files::FilesError::Io(error.to_string())));
    let download = query.get("download").is_some_and(|v| v == "1");
    match read {
        Ok((bytes, kind)) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, kind)
            .header(header::CONTENT_LENGTH, bytes.len())
            .header(
                header::CONTENT_DISPOSITION,
                if kind == "application/octet-stream" || download {
                    attachment_disposition(&leaf)
                } else {
                    "inline".into()
                },
            )
            .body(Body::from(bytes))
            .unwrap_or_else(|_| {
                api_error(StatusCode::INTERNAL_SERVER_ERROR, "read_failed").into_response()
            }),
        Err(error) => files_error(error).into_response(),
    }
}

/// `attachment` with the leaf as the saved name. A project file's name is any
/// UTF-8 (unlike an outbox leaf), so it goes as RFC 6266's `filename*`, with a
/// plain-ASCII `filename` beside it for a browser that reads only that.
fn attachment_disposition(name: &str) -> String {
    let ascii: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' })
        .collect();
    let mut encoded = String::new();
    for byte in name.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    format!("attachment; filename=\"{ascii}\"; filename*=UTF-8''{encoded}")
}

async fn static_asset(Path(path): Path<String>) -> Response<Body> {
    asset_response(&format!("/{path}"))
}
async fn index() -> Response<Body> {
    asset_response("/index.html")
}

fn asset_response(path: &str) -> Response<Body> {
    let requested = if path == "/" { "/index.html" } else { path };
    // A dev build may have a newer bundle published beside it than the one it
    // was compiled with (`live_pwa`). It answers everything or nothing — the
    // two bundles are never mixed, because each names its own hashed entry.
    match live_pwa::current() {
        Some(live) => serve_asset(requested, |name| live.get(name)),
        None => serve_asset(requested, |name| {
            MOBILE_ASSETS
                .iter()
                .find(|(asset, _, _)| *asset == name)
                .map(|(_, bytes, mime)| (bytes::Bytes::from_static(bytes), *mime))
        }),
    }
}

/// The serving rules, over whichever bundle is in play.
fn serve_asset<F>(requested: &str, lookup: F) -> Response<Body>
where
    F: Fn(&str) -> Option<(bytes::Bytes, &'static str)>,
{
    // The SPA fallback must not cover hashed build output. Serving index.html
    // for `/assets/index-OLD.js` — with a one-year `immutable` header chosen
    // from the *requested* path — poisoned the service worker's cache with HTML
    // stored under a JavaScript URL after every upgrade.
    let hit = match lookup(requested) {
        Some(found) => Some((requested, found)),
        // The SPA fallback covers app routes only. A miss under `/assets/` or
        // `/api/` must be a plain 404: serving the shell for an unknown
        // endpoint turned a removed or mistyped route into a 200 full of HTML
        // that the client then tried to parse as JSON.
        None if requested.starts_with("/assets/") || requested.starts_with("/api/") => None,
        None => lookup("/index.html").map(|found| ("/index.html", found)),
    };
    let Some((name, (bytes, mime))) = hit else {
        return StatusCode::NOT_FOUND.into_response();
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(
            header::CACHE_CONTROL,
            // Keyed off what is actually being served, not what was asked for.
            if name.starts_with("/assets/") {
                "public, max-age=31536000, immutable"
            } else {
                "no-cache"
            },
        )
        .body(Body::from(bytes))
        .unwrap()
}

/// The whole HTTP surface in one place, so tests can drive every route
/// through the same middleware stack the sidecar serves.
fn router(state: HostState) -> Router {
    Router::new()
        .route("/healthz", get(health))
        .route("/api/v1/pair", post(pair))
        .route("/api/v1/auth/challenge", post(challenge))
        .route("/api/v1/auth/session", post(login).delete(logout))
        .route("/api/v1/status", get(status))
        .route("/api/v1/todo", get(todo).post(todo_mutate))
        .route("/api/v1/alerts", get(alerts).post(alerts_resolve))
        .route("/api/v1/calendar", get(calendar).post(calendar_mutate))
        .route("/api/v1/push", get(push_get).put(push_put).delete(push_delete))
        .route("/api/v1/mail", get(mail_overview))
        .route("/api/v1/mail/folders/{folder_id}", get(mail_folder))
        .route(
            "/api/v1/mail/folders/{folder_id}/messages/{message_id}",
            get(mail_message),
        )
        .route(
            "/api/v1/mail/folders/{folder_id}/messages/{message_id}/mark",
            post(mail_mark),
        )
        .route(
            "/api/v1/mail/folders/{folder_id}/messages/{message_id}/reply",
            post(mail_reply),
        )
        .route("/api/v1/activity", get(activity))
        .route("/api/v1/projects", get(projects))
        .route("/api/v1/projects/{project_id}", get(project))
        .route(
            "/api/v1/projects/{project_id}/activate",
            post(activate_project),
        )
        .route("/api/v1/projects/{project_id}/tabs", post(create_tab))
        .route("/api/v1/projects/{project_id}/tabs/reopen", post(reopen_tab))
        .route(
            "/api/v1/projects/{project_id}/launch-options",
            get(launch_options),
        )
        .route(
            "/api/v1/projects/{project_id}/prompts",
            get(prompts).post(prompt_create),
        )
        .route(
            "/api/v1/projects/{project_id}/prompts/{prompt_id}",
            put(prompt_update).delete(prompt_delete),
        )
        .route(
            "/api/v1/projects/{project_id}/prompts/{prompt_id}/send",
            post(prompt_send),
        )
        .route(
            "/api/v1/tabs/{tab_id}",
            get(tab).put(rename_tab).delete(close_tab),
        )
        .route("/api/v1/tabs/{tab_id}/color", put(color_tab))
        .route("/api/v1/tabs/{tab_id}/order", put(order_tab))
        .route("/api/v1/tabs/{tab_id}/prompt", post(sent_prompt))
        .route("/api/v1/tabs/{tab_id}/held", post(hold_prompt))
        .route("/api/v1/tabs/{tab_id}/held/{held_id}", put(edit_held_prompt))
        .route("/api/v1/tabs/{tab_id}/undo-clear", post(undo_clear))
        .route("/api/v1/tabs/{tab_id}/sign-in", post(sign_in_tab))
        .route("/api/v1/tabs/{tab_id}/sign-in-callback", post(sign_in_callback))
        .route(
            "/api/v1/tabs/{tab_id}/schedules",
            get(schedules).post(schedule_create),
        )
        .route(
            "/api/v1/tabs/{tab_id}/schedules/{schedule_id}",
            put(schedule_update).delete(schedule_delete),
        )
        .route("/api/v1/tabs/{tab_id}/status", get(agent_status))
        .route("/api/v1/tabs/{tab_id}/transcript", get(agent_transcript))
        .route("/api/v1/tabs/{tab_id}/terminal", get(terminal))
        // The phone's drop box takes a whole photo; every other body stays at
        // the control-message limit below (the inner layer wins).
        .route(
            "/api/v1/tabs/{tab_id}/inbox",
            get(inbox_described).merge(post(inbox_upload).layer(DefaultBodyLimit::max(inbox::MAX_INBOX_FILE))),
        )
        .route("/api/v1/tabs/{tab_id}/inbox/{name}", get(inbox_file))
        .route(
            "/api/v1/projects/{project_id}/inbox",
            post(project_inbox_upload).layer(DefaultBodyLimit::max(inbox::MAX_INBOX_FILE)),
        )
        .route(
            "/api/v1/inbox",
            post(global_inbox_upload).layer(DefaultBodyLimit::max(inbox::MAX_INBOX_FILE)),
        )
        // Vectors only — the layer pictures went up through the inbox.
        .route(
            "/api/v1/tabs/{tab_id}/markup",
            post(markup_submit).layer(DefaultBodyLimit::max(markup::MAX_MARKUP_BODY)),
        )
        .route("/api/v1/tabs/{tab_id}/markup/questions", get(markup_questions))
        .route(
            "/api/v1/tabs/{tab_id}/markup/answer",
            post(markup_answer).layer(DefaultBodyLimit::max(MAX_MARKUP_ANSWER_BODY)),
        )
        .route(
            "/api/v1/tabs/{tab_id}/markup/dismiss",
            post(markup_dismiss).layer(DefaultBodyLimit::max(1024)),
        )
        .route(
            "/api/v1/tabs/{tab_id}/desktop-images",
            get(desktop_images).post(attach_desktop_image),
        )
        .route("/api/v1/open-ticket", post(open_ticket))
        .route("/api/v1/tabs/{tab_id}/outbox", get(outbox_list))
        .route(
            "/api/v1/tabs/{tab_id}/outbox/{name}",
            get(outbox_file).delete(outbox_delete),
        )
        .route("/api/v1/projects/{project_id}/files", get(project_files_list))
        .route("/api/v1/projects/{project_id}/files/raw", get(project_files_raw))
        .route(
            "/api/v1/projects/{project_id}/outbox",
            get(project_outbox_list),
        )
        .route(
            "/api/v1/projects/{project_id}/outbox/{name}",
            get(project_outbox_file).delete(project_outbox_delete),
        )
        .route(PDF_FRAME_PATH, get(pdf_frame))
        .route("/", get(index))
        .route("/{*path}", get(static_asset))
        .layer(DefaultBodyLimit::max(MAX_CONTROL_MESSAGE))
        .layer(middleware::from_fn(security_headers))
        .with_state(state)
}

pub async fn run(state_dir: PathBuf) -> Result<(), String> {
    let config = HostConfig::load(&state_dir)?;
    verify_tailscale_serve(&config.origin, config.host.port)?;
    let auth = Arc::new(Mutex::new(AuthStore::open(
        &config.control_dir,
        config.origin.clone(),
    )?));
    let state = HostState {
        config: config.clone(),
        auth: auth.clone(),
        catalog: Arc::new(Mutex::new(CatalogCache::default())),
        terminal_registry: TerminalRegistry::default(),
        spawner: HeadlessSpawner::default(),
        readings: Arc::new(Mutex::new(headless::ReadingCache::default())),
        runner: Arc::new(scheduler::TmuxRunner::new(&state_dir, None)),
        holds: Arc::default(),
    };
    let (shutdown_tx, mut shutdown_rx) = tokio::sync::watch::channel(false);
    // A Serve verification failure must be a real service failure. A clean
    // graceful shutdown would satisfy systemd's `Restart=on-failure` policy,
    // leaving Mobile permanently down after a transient tailscaled restart.
    // Keep the reason separate from an intentional AdminRequest::Shutdown so
    // only the former exits non-zero and is restarted.
    let serve_failure = Arc::new(Mutex::new(None::<String>));
    let admin_path = config.control_dir.join("admin.sock");
    let admin_origin = Some(config.origin.clone());
    let port = config.host.port;
    let lookup_state = state.clone();
    let admin_context = admin::AdminContext {
        auth,
        port,
        origin: admin_origin,
        shutdown: shutdown_tx.clone(),
        agent_tab: Some(Arc::new(move |tmux: &str| agent_tab_ref(&lookup_state, tmux))),
    };
    tokio::spawn(async move {
        let _ = admin::serve(&admin_path, admin_context).await;
    });
    // The owner's timers (headless owner plan, H2): scheduled prompts fire
    // from here while no window holds the timer lease, through the same
    // launch seam the headless create uses. Ends with the server.
    tokio::spawn(scheduler::run(
        state.config.state_dir.clone(),
        state.spawner.launch.clone(),
        state.holds.clone(),
        shutdown_tx.subscribe(),
    ));
    tokio::spawn(alarms::run(state.config.state_dir.clone(), state.auth.clone(), shutdown_tx.subscribe()));
    let publisher_shutdown = shutdown_tx.clone();
    let publisher_origin = config.origin.clone();
    let publisher_failure = serve_failure.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(30));
        interval.tick().await;
        loop {
            interval.tick().await;
            if let Err(error) = verify_tailscale_serve(&publisher_origin, port) {
                *publisher_failure.lock().unwrap_or_else(PoisonError::into_inner) = Some(error);
                let _ = publisher_shutdown.send(true);
                break;
            }
        }
    });
    let app = router(state);
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .map_err(|e| format!("bind {address}: {e}"))?;
    axum::serve(limits::GuardedListener::new(listener), app)
        .with_graceful_shutdown(async move {
            while !*shutdown_rx.borrow() {
                if shutdown_rx.changed().await.is_err() {
                    break;
                }
            }
        })
        .await
        .map_err(|e| e.to_string())?;
    if let Some(error) = serve_failure.lock().unwrap_or_else(PoisonError::into_inner).take() {
        return Err(format!("Tailscale Serve verification failed: {error}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::brand::SLUG;
    use super::*;

    /// The host accepts the names an older phone app or an older host used,
    /// counts them, and prefers the current ones.
    #[test]
    fn old_protocol_names_are_accepted_and_counted() {
        use crate::brand::{Name, LEGACY, PAIR};
        use crate::services::brand_migration::{hits, testing::RENAMED};
        let _ = hits::taken();
        let old_protocol = LEGACY.name(Name::TERMINAL_PROTOCOL);
        assert_eq!(terminal_protocol_in(&RENAMED, &old_protocol), Some(old_protocol.clone()));
        assert_eq!(hits::taken(), ["terminal-protocol"]);
        assert_eq!(
            terminal_protocol_in(&RENAMED, &format!("{old_protocol}, newname-terminal.v1")).as_deref(),
            Some("newname-terminal.v1")
        );
        assert_eq!(terminal_protocol_in(&RENAMED, "something-else"), None);
        assert!(hits::taken().is_empty());

        let old_cookie = format!("theme=dark; {}=tok-old", LEGACY.name(Name::SESSION_COOKIE));
        assert_eq!(session_cookie_in(&RENAMED, &old_cookie), Some("tok-old"));
        assert_eq!(hits::taken(), ["session-cookie"]);
        let both = format!("{old_cookie}; __Host-newname_session=tok-new");
        assert_eq!(session_cookie_in(&RENAMED, &both), Some("tok-new"));
        assert_eq!(session_cookie_in(&RENAMED, "theme=dark"), None);
        assert!(hits::taken().is_empty());

        // The production pair: one name each, as before.
        let current = super::super::protocol::TERMINAL_PROTOCOL;
        assert_eq!(terminal_protocol_in(&PAIR, current).as_deref(), Some(current));
        assert_eq!(
            session_cookie_in(&PAIR, &format!("{}=tok", crate::brand::SESSION_COOKIE)),
            Some("tok")
        );
    }

    use axum::body::to_bytes;
    use p256::{
        ecdsa::{signature::Signer, Signature, SigningKey},
        pkcs8::EncodePublicKey,
    };
    use serde_json::Value;
    use tower::ServiceExt;

    use crate::services::mobile_control::config::MobileHostSettings;

    const ORIGIN: &str = "https://desk.example.ts.net";
    /// A raw project id and a filesystem path the phone must never be able to
    /// read back out of any response.
    const RAW_BOX: &str = "b-mobile";
    const RAW_PROJECT: &str = "raw-project-id-7f3";

    struct Fixture {
        _dir: tempfile::TempDir,
        root: PathBuf,
        state: HostState,
        /// What the owner typed into or ended (H3); the host's `runner`.
        runner: Arc<RunnerRecorder>,
    }

    /// The host's tmux reach, recorded: no server runs in a test, so nothing
    /// is probed unless a test says so, and what would have been typed or
    /// ended is written down instead.
    #[derive(Default)]
    struct RunnerRecorder {
        probe: Mutex<Option<scheduler::SessionProbe>>,
        delivered: Mutex<Vec<(String, Vec<scheduler::Submission>)>>,
        killed: Mutex<Vec<String>>,
    }

    impl scheduler::Runner for RunnerRecorder {
        fn probe(&self, _tmux: &str) -> Option<scheduler::SessionProbe> {
            *self.probe.lock().unwrap()
        }
        fn deliver(&self, tmux: &str, submissions: &[scheduler::Submission]) -> Result<(), String> {
            self.delivered.lock().unwrap().push((tmux.to_string(), submissions.to_vec()));
            Ok(())
        }
        fn kill(&self, tmux: &str) -> Result<(), String> {
            self.killed.lock().unwrap().push(tmux.to_string());
            Ok(())
        }
    }

    impl Fixture {
        /// A host with no project catalog at all.
        fn bare() -> Self {
            let dir = tempfile::tempdir().expect("state dir");
            let state_dir = dir.path().to_path_buf();
            let control_dir = state_dir.join("mobile-control");
            let auth = AuthStore::open(&control_dir, ORIGIN.to_string()).expect("auth store");
            let root = state_dir.join("work");
            std::fs::create_dir_all(&root).expect("project root");
            let runner = Arc::new(RunnerRecorder::default());
            Self {
                _dir: dir,
                root,
                runner: runner.clone(),
                state: HostState {
                    config: HostConfig {
                        state_dir,
                        control_dir,
                        host: MobileHostSettings {
                            display_name: "Desk".into(),
                            ..MobileHostSettings::default()
                        },
                        origin: ORIGIN.into(),
                    },
                    auth: Arc::new(Mutex::new(auth)),
                    catalog: Arc::new(Mutex::new(CatalogCache::default())),
                    terminal_registry: TerminalRegistry::default(),
                    spawner: HeadlessSpawner::default(),
                    readings: Arc::new(Mutex::new(headless::ReadingCache::default())),
                    runner,
                    holds: Arc::default(),
                },
            }
        }

        /// A host with one opted-in project holding one resumable agent tab.
        fn with_project() -> Self {
            let fixture = Self::bare();
            let state_dir = &fixture.state.config.state_dir;
            std::fs::write(
                state_dir.join("projects.json"),
                serde_json::to_vec(&serde_json::json!([{
                    "id": RAW_PROJECT,
                    "name": "Aurora",
                    "status": "active",
                    "directory": fixture.root.to_string_lossy(),
                    concat!(crate::app_slug!(), "_mobile_access"): true,
                }]))
                .expect("projects fixture"),
            )
            .expect("write projects");
            let sessions = state_dir.join("sessions").join(RAW_PROJECT);
            std::fs::create_dir_all(&sessions).expect("session dir");
            std::fs::write(
                sessions.join("terminals.json"),
                serde_json::to_vec(&serde_json::json!({
                    "tabLayout": [{
                        "label": "Claude",
                        "cmd": "claude",
                        "cwd": fixture.root.to_string_lossy(),
                        "kind": "agent",
                        "sessionId": "9d0f-session",
                        "tmuxSession": format!("{SLUG}-{RAW_PROJECT}--agent-abcdef123"),
                    }]
                }))
                .expect("session fixture"),
            )
            .expect("write session");
            fixture
        }

        /// A host with one opted-in project (Mobile OFF on the project itself)
        /// that is the member of one opted-in box holding one shell tab in the
        /// member's tree and one in the box folder, plus one box with Mobile off.
        fn with_box() -> Self {
            let fixture = Self::bare();
            let state_dir = &fixture.state.config.state_dir;
            // Shell tabs are off the phone unless switched on.
            std::fs::write(
                state_dir.join("settings.json"),
                serde_json::json!({ crate::brand::MOBILE_HOST_KEY: { "enabled": true, "shell_tabs": true } }).to_string(),
            )
            .expect("write settings");
            let folder = state_dir.join("boxes").join("paper");
            std::fs::create_dir_all(&folder).expect("box folder");
            std::fs::write(
                state_dir.join("projects.json"),
                serde_json::to_vec(&serde_json::json!([{
                    "id": RAW_PROJECT,
                    "name": "Aurora",
                    "status": "inactive",
                    "directory": fixture.root.to_string_lossy(),
                }]))
                .expect("projects fixture"),
            )
            .expect("write projects");
            std::fs::write(
                state_dir.join("boxes.json"),
                serde_json::to_vec(&serde_json::json!([
                    { "id": RAW_BOX, "name": "Paper", "member_ids": [RAW_PROJECT],
                      "folder": folder.to_string_lossy(), concat!(crate::app_slug!(), "_mobile_access"): true },
                    { "id": "b-off", "name": "Private", "member_ids": [RAW_PROJECT],
                      "folder": folder.to_string_lossy() },
                ]))
                .expect("boxes fixture"),
            )
            .expect("write boxes");
            let sessions = state_dir.join("sessions").join(format!("box_{RAW_BOX}"));
            std::fs::create_dir_all(&sessions).expect("session dir");
            std::fs::write(
                sessions.join("terminals.json"),
                serde_json::to_vec(&serde_json::json!({
                    "tabLayout": [{
                        "label": "Box shell",
                        "cmd": "bash",
                        "cwd": folder.to_string_lossy(),
                        "kind": "shell",
                        "tmuxSession": format!("{SLUG}-box_{RAW_BOX}--shell-abcdef123"),
                    }, {
                        "label": "Aurora shell",
                        "cmd": "bash",
                        "cwd": fixture.root.to_string_lossy(),
                        "kind": "shell",
                        "tmuxSession": format!("{SLUG}-box_{RAW_BOX}--shell-bcdef1234"),
                    }]
                }))
                .expect("session fixture"),
            )
            .expect("write session");
            fixture
        }

        async fn send(&self, request: Request<Body>) -> (StatusCode, HeaderMap, String) {
            let response = router(self.state.clone())
                .oneshot(request)
                .await
                .expect("router response");
            let status = response.status();
            let headers = response.headers().clone();
            let body = to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("response body");
            (status, headers, String::from_utf8_lossy(&body).into_owned())
        }

        /// The real pair → challenge → sign → session flow, returning the
        /// session cookie and the paired device id.
        async fn pair_device(&self, signing: &SigningKey) -> (String, String) {
            let code = self
                .state
                .auth
                .lock()
                .unwrap()
                .create_pairing_code()
                .expect("pairing code")
                .0;
            let public_key = Base64UrlUnpadded::encode_string(
                signing
                    .verifying_key()
                    .to_public_key_der()
                    .expect("public key der")
                    .as_bytes(),
            );
            let (status, _, body) = self
                .send(post_json(
                    "/api/v1/pair",
                    ORIGIN,
                    &serde_json::json!({
                        "code": code,
                        "device_name": "Phone",
                        "public_key": public_key,
                    }),
                ))
                .await;
            assert_eq!(status, StatusCode::CREATED, "pair failed: {body}");
            let device_id = json(&body)["device_id"].as_str().expect("device id").into();

            let (status, _, body) = self
                .send(post_json(
                    "/api/v1/auth/challenge",
                    ORIGIN,
                    &serde_json::json!({ "device_id": device_id }),
                ))
                .await;
            assert_eq!(status, StatusCode::OK, "challenge failed: {body}");
            let challenge = json(&body);
            let nonce = challenge["nonce"].as_str().expect("nonce").to_string();
            let payload = challenge["payload"].as_str().expect("payload").to_string();

            let (status, headers, body) = self
                .send(post_json(
                    "/api/v1/auth/session",
                    ORIGIN,
                    &serde_json::json!({
                        "device_id": device_id,
                        "nonce": nonce,
                        "signature": sign(signing, &payload),
                    }),
                ))
                .await;
            assert_eq!(status, StatusCode::OK, "login failed: {body}");
            (set_cookie(&headers), device_id)
        }
    }

    fn signing_key(seed: u8) -> SigningKey {
        SigningKey::from_slice(&[seed; 32]).expect("test signing key")
    }

    fn sign(signing: &SigningKey, payload: &str) -> String {
        let signature: Signature = signing.sign(payload.as_bytes());
        Base64UrlUnpadded::encode_string(&signature.to_bytes())
    }

    fn json(body: &str) -> Value {
        serde_json::from_str(body).unwrap_or_else(|_| panic!("not JSON: {body}"))
    }

    fn set_cookie(headers: &HeaderMap) -> String {
        headers
            .get(header::SET_COOKIE)
            .and_then(|v| v.to_str().ok())
            .expect("Set-Cookie")
            .to_string()
    }

    fn cookie_pair(set_cookie: &str) -> String {
        set_cookie
            .split(';')
            .next()
            .expect("cookie pair")
            .trim()
            .to_string()
    }

    fn get_request(uri: &str) -> Request<Body> {
        Request::builder()
            .uri(uri)
            .body(Body::empty())
            .expect("request")
    }

    fn get_as(uri: &str, cookie: &str) -> Request<Body> {
        Request::builder()
            .uri(uri)
            .header(header::COOKIE, cookie_pair(cookie))
            .body(Body::empty())
            .expect("request")
    }

    fn post_json(uri: &str, origin: &str, body: &Value) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri(uri)
            .header(header::ORIGIN, origin)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::to_vec(body).expect("body")))
            .expect("request")
    }

    /// Every route that serves project, tab, mail, calendar or task data.
    const AUTHENTICATED_GETS: &[&str] = &[
        "/api/v1/status",
        "/api/v1/todo",
        "/api/v1/alerts",
        "/api/v1/calendar",
        "/api/v1/push",
        "/api/v1/mail",
        "/api/v1/mail/folders/anything",
        "/api/v1/mail/folders/anything/messages/anything",
        "/api/v1/activity",
        "/api/v1/projects",
        "/api/v1/projects/anything",
        "/api/v1/tabs/anything",
        "/api/v1/tabs/anything/schedules",
        "/api/v1/tabs/anything/transcript",
        "/api/v1/projects/anything/prompts",
        "/api/v1/tabs/anything/desktop-images",
        "/api/v1/tabs/anything/markup/questions",
    ];

    /// The desktop bounds the tail before it sends one; this bounds it again at
    /// the browser boundary, and keeps the newest end — a card that dropped the
    /// last prompt to keep the first five would show a session's morning.
    #[test]
    fn a_tab_publishes_the_newest_prompts_of_its_tail_and_no_more() {
        use crate::services::mobile_control::protocol::{AgentTabPrompt, AgentTabPrompts};
        let rows = prompt_rows(vec![AgentTabPrompts {
            tmux_session: concat!(crate::app_slug!(), "-p_paper--agent-123456789").into(),
            prompts: (0..12)
                .map(|n| AgentTabPrompt {
                    text: format!("prompt {n}"),
                    at: Some(format!("2026-09-17T08:{n:02}:00Z")),
                })
                .collect(),
        }]);
        let prompts = &rows[concat!(crate::app_slug!(), "-p_paper--agent-123456789")];
        assert_eq!(prompts.len(), MAX_TAB_PROMPTS);
        // Oldest first, ending on the newest the desktop sent.
        assert_eq!(prompts[0].text, "prompt 7");
        assert_eq!(prompts[MAX_TAB_PROMPTS - 1].text, "prompt 11");
    }

    #[test]
    fn a_long_prompt_is_cut_before_it_reaches_the_phone() {
        use crate::services::mobile_control::protocol::{AgentTabPrompt, AgentTabPrompts};
        let rows = prompt_rows(vec![AgentTabPrompts {
            tmux_session: concat!(crate::app_slug!(), "-p_paper--agent-123456789").into(),
            prompts: vec![AgentTabPrompt {
                // Multi-byte on purpose: the cut counts characters, so a byte
                // slice here would panic mid-character.
                text: "ä".repeat(MAX_TAB_PROMPT_CHARS + 40),
                at: None,
            }],
        }]);
        let prompts = &rows[concat!(crate::app_slug!(), "-p_paper--agent-123456789")];
        assert_eq!(prompts[0].text.chars().count(), MAX_TAB_PROMPT_CHARS);
        assert!(prompts[0].at.is_none());
    }

    #[test]
    fn mobile_policy_allows_only_same_origin_microphone_capture() {
        assert!(MOBILE_PERMISSIONS_POLICY.contains("microphone=(self)"));
        assert!(MOBILE_PERMISSIONS_POLICY.contains("on-device-speech-recognition=(self)"));
        assert!(MOBILE_PERMISSIONS_POLICY.contains("camera=()"));
        assert!(!MOBILE_PERMISSIONS_POLICY.contains("microphone=()"));
        assert!(!MOBILE_PERMISSIONS_POLICY.contains("microphone=(*"));
    }

    fn push_request(method: &str, origin: &str, cookie: &str, body: &Value) -> Request<Body> {
        Request::builder()
            .method(method)
            .uri("/api/v1/push")
            .header(header::ORIGIN, origin)
            .header(header::COOKIE, cookie_pair(cookie))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::to_vec(body).expect("body")))
            .expect("request")
    }

    /// A phone subscribes only from the exact origin, only to a push vendor's
    /// endpoint, and loses the subscription the moment it is revoked.
    #[tokio::test]
    async fn push_subscriptions_are_origin_checked_vendor_only_and_die_with_the_device() {
        let host = Fixture::bare();
        let (cookie, device_id) = host.pair_device(&signing_key(44)).await;
        let (status, _, body) = host.send(get_as("/api/v1/push", &cookie)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let state = json(&body);
        assert_eq!(state["subscribed"], false);
        let vapid = Base64UrlUnpadded::decode_vec(state["vapid_public_key"].as_str().expect("key"))
            .expect("base64url key");
        assert_eq!(vapid.len(), 65);

        use p256::elliptic_curve::sec1::ToEncodedPoint;
        let phone = p256::SecretKey::from_slice(&[5u8; 32]).expect("phone key");
        let subscription = |endpoint: &str| {
            serde_json::json!({
                "endpoint": endpoint,
                "p256dh": Base64UrlUnpadded::encode_string(
                    phone.public_key().to_encoded_point(false).as_bytes(),
                ),
                "auth": Base64UrlUnpadded::encode_string(&[3u8; 16]),
                "details": true,
                "calendar": true,
                "agents": "questions",
            })
        };
        let good = subscription("https://fcm.googleapis.com/fcm/send/phone");
        let (status, _, _) = host
            .send(push_request("PUT", "https://evil.example", &cookie, &good))
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _, _) = host
            .send(push_request("PUT", ORIGIN, &cookie, &subscription("https://evil.example/push")))
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        let (status, _, body) = host.send(push_request("PUT", ORIGIN, &cookie, &good)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(json(&body)["subscribed"], true);
        assert_eq!(json(&body)["details"], true);
        assert_eq!(json(&body)["agents"], "questions");
        assert_eq!(json(&body)["lapsed"], false);

        // The push service says the endpoint is gone: the phone is told it
        // lapsed, with the choices it made and the endpoint that died — what
        // its silent refresh re-subscribes from.
        host.state
            .auth
            .lock()
            .unwrap()
            .push_lapse_endpoint("https://fcm.googleapis.com/fcm/send/phone");
        let (_, _, body) = host.send(get_as("/api/v1/push", &cookie)).await;
        let lapsed = json(&body);
        assert_eq!(lapsed["subscribed"], false);
        assert_eq!(lapsed["lapsed"], true);
        assert_eq!(lapsed["agents"], "questions");
        assert_eq!(lapsed["details"], true);
        assert_eq!(lapsed["endpoint"], "https://fcm.googleapis.com/fcm/send/phone");
        // Registering a fresh subscription brings it back…
        let fresh = subscription("https://fcm.googleapis.com/fcm/send/phone-2");
        let (status, _, body) = host.send(push_request("PUT", ORIGIN, &cookie, &fresh)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(json(&body)["subscribed"], true);
        assert_eq!(json(&body)["lapsed"], false);
        // …and an explicit unsubscribe removes even a lapsed record.
        host.state
            .auth
            .lock()
            .unwrap()
            .push_lapse_endpoint("https://fcm.googleapis.com/fcm/send/phone-2");
        let (status, _, body) = host
            .send(push_request("DELETE", ORIGIN, &cookie, &serde_json::json!({})))
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(json(&body)["subscribed"], false);
        assert_eq!(json(&body)["lapsed"], false);
        let (status, _, _) = host.send(push_request("PUT", ORIGIN, &cookie, &good)).await;
        assert_eq!(status, StatusCode::OK);
        host.state
            .auth
            .lock()
            .unwrap()
            .push_lapse_endpoint("https://fcm.googleapis.com/fcm/send/phone");

        host.state.auth.lock().unwrap().revoke(&device_id).expect("revoke");
        assert!(host.state.auth.lock().unwrap().push().subscription(&device_id).is_none());
    }

    #[tokio::test]
    async fn every_data_route_refuses_an_unauthenticated_request() {
        let host = Fixture::with_project();
        for uri in AUTHENTICATED_GETS {
            let (status, _, body) = host.send(get_request(uri)).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{uri} answered: {body}");
            assert_eq!(json(&body)["error"], "authentication_required", "{uri}");
        }
    }

    #[tokio::test]
    async fn mutating_routes_refuse_an_unauthenticated_request() {
        let host = Fixture::with_project();
        let create = serde_json::json!({
            "project_id": "anything",
            "kind": "shell",
            "idempotency_key": "0123456789abcdef",
        });
        for uri in [
            "/api/v1/projects/anything/tabs",
            "/api/v1/projects/anything/activate",
            "/api/v1/todo",
            "/api/v1/alerts",
            "/api/v1/calendar",
            "/api/v1/tabs/anything/schedules",
            "/api/v1/tabs/anything/inbox",
            "/api/v1/projects/anything/inbox",
            "/api/v1/inbox",
            "/api/v1/tabs/anything/desktop-images",
            "/api/v1/tabs/anything/prompt",
            "/api/v1/tabs/anything/held",
            "/api/v1/tabs/anything/sign-in-callback",
            "/api/v1/tabs/anything/sign-in",
            "/api/v1/projects/anything/prompts",
            "/api/v1/projects/anything/prompts/anything/send",
            "/api/v1/mail/folders/anything/messages/anything/mark",
            "/api/v1/mail/folders/anything/messages/anything/reply",
        ] {
            let (status, _, body) = host.send(post_json(uri, ORIGIN, &create)).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{uri} answered: {body}");
        }
        // The rename route is the one mutation that is a PUT on a GET path.
        let put = Request::builder()
            .method("PUT")
            .uri("/api/v1/tabs/anything")
            .header(header::ORIGIN, ORIGIN)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                serde_json::to_vec(&serde_json::json!({ "label": "x" })).expect("body"),
            ))
            .expect("request");
        let (status, _, body) = host.send(put).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "answered: {body}");
        let edit = Request::builder()
            .method("PUT")
            .uri("/api/v1/tabs/anything/held/anything")
            .header(header::ORIGIN, ORIGIN)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                serde_json::to_vec(&serde_json::json!({ "message": "x" })).expect("body"),
            ))
            .expect("request");
        let (status, _, body) = host.send(edit).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "held edit answered: {body}");
    }

    #[tokio::test]
    async fn schedule_editor_requires_the_desktop_bridge_and_leaks_no_raw_target() {
        let host = Fixture::with_project();
        let cookie = host.pair_device(&signing_key(12)).await.0;
        let (_, _, projects_body) = host.send(get_as("/api/v1/projects", &cookie)).await;
        let project_id = json(&projects_body)["projects"][0]["id"]
            .as_str()
            .expect("opaque project id")
            .to_string();
        let (_, _, project_body) = host
            .send(get_as(&format!("/api/v1/projects/{project_id}"), &cookie))
            .await;
        let tab_id = json(&project_body)["tabs"][0]["id"]
            .as_str()
            .expect("opaque tab id")
            .to_string();

        // No window: the list is answered off the file — nothing filed for a
        // tab with no schedule binding yet — and flagged so the phone shows it
        // read-only. Nothing raw crosses either way.
        let (status, _, body) = host
            .send(get_as(&format!("/api/v1/tabs/{tab_id}/schedules"), &cookie))
            .await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        let answer = json(&body);
        assert_eq!(answer["desktop_available"], false);
        assert_eq!(answer["schedules"], serde_json::json!([]));
        assert!(!body.contains(RAW_PROJECT));
        assert!(!body.contains(&host.root.to_string_lossy().to_string()));
        assert!(!body.contains("scheduleTargetId"));
        assert!(!body.contains(crate::brand::TMUX_PREFIX));

        // A tab the desktop never bound to a schedule target has nowhere to
        // file a rule: the owner answers "no such tab" rather than inventing
        // a binding (H3).
        let create = Request::builder()
            .method("POST")
            .uri(format!("/api/v1/tabs/{tab_id}/schedules"))
            .header(header::ORIGIN, ORIGIN)
            .header(header::COOKIE, cookie_pair(&cookie))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                serde_json::to_vec(&serde_json::json!({
                    "enabled": true,
                    "message": "Review",
                    "rule": { "type": "daily", "time": "09:00" },
                }))
                .expect("body"),
            ))
            .expect("request");
        let (status, _, body) = host.send(create).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "answered: {body}");
        assert_eq!(json(&body)["error"], "tab_not_found");
        assert!(!body.contains(crate::brand::TMUX_PREFIX));
    }

    /// A host whose spawn seam records what it is asked to start (and starts
    /// nothing), with every agent CLI "installed".
    fn headless_host(launch: headless::HeadlessLaunch) -> Fixture {
        let mut host = Fixture::with_project();
        // Shell tabs are off the phone unless switched on; the owner mints
        // shells too, so the fixture opts in.
        std::fs::write(
            host.state.config.state_dir.join("settings.json"),
            serde_json::json!({ crate::brand::MOBILE_HOST_KEY: { "enabled": true, "shell_tabs": true } }).to_string(),
        )
        .expect("write settings");
        host.state.spawner = HeadlessSpawner { launch, installed: Arc::new(|_| true) };
        host
    }

    /// A same-origin, authenticated JSON request of any method.
    fn request_as(method: &str, uri: &str, cookie: &str, body: Option<Value>) -> Request<Body> {
        Request::builder()
            .method(method)
            .uri(uri)
            .header(header::ORIGIN, ORIGIN)
            .header(header::COOKIE, cookie_pair(cookie))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.map(|b| serde_json::to_vec(&b).expect("body")).unwrap_or_default()))
            .expect("request")
    }

    /// The opaque project id and the agent tab id of the `with_project` host.
    async fn project_and_tab(host: &Fixture, cookie: &str) -> (String, String) {
        let (_, _, projects_body) = host.send(get_as("/api/v1/projects", cookie)).await;
        let project_id = json(&projects_body)["projects"][0]["id"].as_str().unwrap_or_else(|| panic!("project id: {projects_body}")).to_string();
        let (_, _, project_body) = host.send(get_as(&format!("/api/v1/projects/{project_id}"), cookie)).await;
        let tab_id = json(&project_body)["tabs"][0]["id"].as_str().expect("tab id").to_string();
        (project_id, tab_id)
    }

    /// H3 (headless owner plan §3): with no window open, the phone's tab
    /// edits — rename, colour, close, reopen — are the owner's: they land in
    /// the session file through the workspace service, answered as stored
    /// and flagged; a close ends the tab's session and remembers an agent
    /// tab; a reopen brings it back as a new tab started detached on its
    /// resume args. Nothing raw crosses.
    #[tokio::test]
    async fn tab_edits_close_and_reopen_are_the_owners_with_no_window() {
        let recorded: Arc<Mutex<Vec<PtyOptions>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = recorded.clone();
        let host = headless_host(Arc::new(move |opts: PtyOptions| {
            sink.lock().unwrap().push(opts);
            Box::pin(async { Ok(()) })
        }));
        let cookie = host.pair_device(&signing_key(51)).await.0;
        let (project_id, tab_id) = project_and_tab(&host, &cookie).await;
        let session_file = host.state.config.state_dir.join("sessions").join(RAW_PROJECT).join("terminals.json");
        let leaks = |body: &str| {
            assert!(!body.contains(RAW_PROJECT), "raw project id leaked: {body}");
            assert!(!body.contains(crate::brand::TMUX_PREFIX), "tmux name leaked: {body}");
            assert!(!body.contains("9d0f-session"), "session id leaked: {body}");
            assert!(!body.contains(&host.root.to_string_lossy().to_string()), "path leaked: {body}");
        };

        let (status, _, body) = host
            .send(request_as("PUT", &format!("/api/v1/tabs/{tab_id}"), &cookie, Some(json!({ "label": "  Review  " }))))
            .await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        assert_eq!(json(&body)["desktop_available"], false);
        assert_eq!(json(&body)["tab"]["label"], "Review", "the row as stored, trimmed");
        leaks(&body);
        let (status, _, body) = host
            .send(request_as("PUT", &format!("/api/v1/tabs/{tab_id}/color"), &cookie, Some(json!({ "color": "teal" }))))
            .await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        assert_eq!(json(&body)["tab"]["color"], "teal");
        leaks(&body);
        let stored: crate::schema::session::TerminalSession = crate::storage::read_json(&session_file).expect("session");
        assert!(crate::services::workspace::is_owned(&stored));
        assert_eq!(stored.tab_layout[0].label, "Review"); // project-tree-read: ok — the state-dir session file.
        assert_eq!(stored.tab_layout[0].extra["color"], "teal"); // project-tree-read: ok — same.

        // Closing: the tab is gone from the file and the catalog, its session
        // was ended, and the project lists it under "Recently closed".
        let (status, _, body) = host.send(request_as("DELETE", &format!("/api/v1/tabs/{tab_id}"), &cookie, None)).await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        assert_eq!(json(&body)["closed"], true);
        assert_eq!(host.runner.killed.lock().unwrap().as_slice(), [format!("{}{RAW_PROJECT}--agent-abcdef123", crate::brand::TMUX_PREFIX)]);
        let (_, _, body) = host.send(get_as(&format!("/api/v1/projects/{project_id}"), &cookie)).await;
        let detail = json(&body);
        assert_eq!(detail["tabs"].as_array().map(Vec::len), Some(0), "{body}");
        assert_eq!(detail["closed"].as_array().map(Vec::len), Some(1), "{body}");
        assert_eq!(detail["closed"][0]["label"], "Review");
        assert_eq!(detail["closed"][0]["agent"], "claude");
        let closed_id = detail["closed"][0]["id"].as_str().expect("closed id").to_string();
        leaks(&body);
        let (status, _, body) = host.send(request_as("DELETE", &format!("/api/v1/tabs/{tab_id}"), &cookie, None)).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "answered: {body}");

        // Reopening by that id: a new tab on the resume args a restart would
        // give it, started through the spawn seam, listed, and gone from the
        // closed row; a second reopen has nothing left.
        let (status, _, body) = host
            .send(request_as("POST", &format!("/api/v1/projects/{project_id}/tabs/reopen"), &cookie, Some(json!({ "closed_id": closed_id }))))
            .await;
        assert_eq!(status, StatusCode::CREATED, "answered: {body}");
        let answer = json(&body);
        assert_eq!(answer["desktop_available"], false);
        assert_eq!(answer["tab"]["label"], "Review");
        assert_ne!(answer["tab"]["id"], tab_id, "a new tab");
        leaks(&body);
        let spawned = recorded.lock().unwrap().clone();
        assert_eq!(spawned.len(), 1);
        assert_eq!(spawned[0].cmd, "claude");
        assert_eq!(spawned[0].args, vec!["--resume".to_string(), "9d0f-session".to_string()]);
        assert!(spawned[0].tmux_session.as_deref().is_some_and(|n| n.starts_with(&format!("{}{RAW_PROJECT}--agent-", crate::brand::TMUX_PREFIX))));
        assert_ne!(spawned[0].tmux_session.as_deref(), Some(&*format!("{}{RAW_PROJECT}--agent-abcdef123", crate::brand::TMUX_PREFIX)), "a fresh session name");
        let stored: crate::schema::session::TerminalSession = crate::storage::read_json(&session_file).expect("session");
        assert_eq!(stored.tab_layout.len(), 1); // project-tree-read: ok — the state-dir session file.
        assert_eq!(stored.tab_layout[0].session_id.as_deref(), Some("9d0f-session")); // project-tree-read: ok — same.
        let (_, _, body) = host.send(get_as(&format!("/api/v1/projects/{project_id}"), &cookie)).await;
        assert_eq!(json(&body)["closed"], json!([]));
        assert_eq!(json(&body)["tabs"][0]["label"], "Review");
        let (status, _, body) = host
            .send(request_as("POST", &format!("/api/v1/projects/{project_id}/tabs/reopen"), &cookie, None))
            .await;
        assert_eq!(status, StatusCode::CONFLICT, "answered: {body}");
        assert_eq!(json(&body)["error"], "nothing_to_reopen");
    }

    /// Bind the `with_project` host's agent tab to schedule target `tgt-1`.
    fn bind_schedule_target(host: &Fixture) {
        std::fs::write(
            host.state.config.state_dir.join("sessions").join(RAW_PROJECT).join("terminals.json"),
            serde_json::to_vec(&json!({
                "tabLayout": [{
                    "label": "Claude",
                    "cmd": "claude",
                    "cwd": host.root.to_string_lossy(),
                    "kind": "agent",
                    "sessionId": "9d0f-session",
                    "scheduleTargetId": "tgt-1",
                    "tmuxSession": format!("{}{RAW_PROJECT}--agent-abcdef123", crate::brand::TMUX_PREFIX),
                }]
            }))
            .expect("session fixture"),
        )
        .expect("write session");
    }

    /// With no window open the owner holds a prompt the phone sent mid-turn:
    /// a send-now rule on the tab's binding, marked for its scheduler to type
    /// at once, and editable until delivered — nothing raw crossing.
    #[tokio::test]
    async fn a_phone_prompt_is_held_and_edited_by_the_owner_with_no_window() {
        let host = Fixture::with_project();
        bind_schedule_target(&host);
        let state_dir = host.state.config.state_dir.clone();
        let cookie = host.pair_device(&signing_key(57)).await.0;
        let (_, tab_id) = project_and_tab(&host, &cookie).await;
        let held_uri = format!("/api/v1/tabs/{tab_id}/held");

        let (status, _, body) = host
            .send(request_as("POST", &held_uri, &cookie, Some(json!({ "message": "also update the docs" }))))
            .await;
        assert_eq!(status, StatusCode::CREATED, "answered: {body}");
        assert_eq!(json(&body)["desktop_available"], false);
        assert!(!body.contains("tgt-1") && !body.contains(RAW_PROJECT), "{body}");
        let held_id = json(&body)["id"].as_str().expect("held id").to_string();
        assert!(host.state.holds.due(&held_id), "marked for the scheduler");
        let rules = crate::services::agent_tasks::list_at(&state_dir, RAW_PROJECT, "tgt-1").expect("rules");
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].id, held_id);
        assert_eq!(rules[0].message, "also update the docs");

        let (status, _, body) = host
            .send(request_as("PUT", &format!("{held_uri}/{held_id}"), &cookie, Some(json!({ "message": "update the docs and the tests" }))))
            .await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        assert_eq!(json(&body)["id"], held_id);
        let rules = crate::services::agent_tasks::list_at(&state_dir, RAW_PROJECT, "tgt-1").expect("rules");
        assert_eq!(rules[0].message, "update the docs and the tests");

        let (status, _, body) = host
            .send(request_as("PUT", &format!("{held_uri}/gone-1"), &cookie, Some(json!({ "message": "x" }))))
            .await;
        assert_eq!(status, StatusCode::CONFLICT, "answered: {body}");
        assert_eq!(json(&body)["error"], "held_gone");
        let (status, _, body) = host
            .send(request_as("POST", &held_uri, &cookie, Some(json!({ "message": "/clear" }))))
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "a command is typed by the phone: {body}");
        assert_eq!(json(&body)["error"], "invalid_prompt");
    }

    /// H3 (the plan's exit, the writes half): with no window open, the
    /// phone edits a to-do card and a calendar event (CAS on
    /// `calendar.json`), writes and removes a schedule and a collected
    /// prompt, sends a prompt now (a one-time rule the sidecar's scheduler
    /// fires, the prompt retired to the history), records a composer prompt,
    /// asks for the tab's status and the ＋ sheet's options, and attaches a
    /// desktop image — every answer flagged, nothing raw crossing.
    #[tokio::test]
    async fn writes_with_side_effects_are_the_owners_with_no_window() {
        let host = Fixture::with_project();
        bind_schedule_target(&host);
        let state_dir = host.state.config.state_dir.clone();
        let cookie = host.pair_device(&signing_key(54)).await.0;
        let (project_id, tab_id) = project_and_tab(&host, &cookie).await;
        let leaks = |body: &str| {
            assert!(!body.contains(RAW_PROJECT), "raw project id leaked: {body}");
            assert!(!body.contains("tgt-1"), "schedule target leaked: {body}");
            assert!(!body.contains(crate::brand::TMUX_PREFIX), "tmux name leaked: {body}");
            assert!(!body.contains("9d0f-session"), "session id leaked: {body}");
            assert!(!body.contains(&host.root.to_string_lossy().to_string()), "path leaked: {body}");
        };

        // The board: a card is created into the intake column, ticked, and
        // the answer is the board as stored.
        let (_, _, body) = host.send(get_as("/api/v1/todo", &cookie)).await;
        let board = json(&body)["board"].clone();
        let intake = board["columns"].as_array().unwrap().iter().find(|c| c["intake"] == true).unwrap()["id"].as_str().unwrap().to_string();
        let calendar_id = board["calendars"][0]["id"].as_str().expect("calendar id").to_string();
        let card = json!({ "title": "From the phone", "notes": "", "priority": 0, "percent": 0, "column": intake,
            "calendar_id": calendar_id, "project_id": project_id, "tags": [], "subtasks": [] });
        let (status, _, body) = host
            .send(request_as("POST", "/api/v1/todo", &cookie, Some(json!({ "type": "create", "task": card }))))
            .await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        let answer = json(&body);
        assert_eq!(answer["desktop_available"], false);
        assert_eq!(answer["board"]["tasks"][0]["title"], "From the phone");
        assert_eq!(answer["board"]["tasks"][0]["project_id"], project_id);
        let task_id = answer["board"]["tasks"][0]["id"].as_str().expect("task id").to_string();
        leaks(&body);
        let (status, _, body) = host
            .send(request_as("POST", "/api/v1/todo", &cookie, Some(json!({ "type": "toggle", "task_id": task_id }))))
            .await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        assert_eq!(json(&body)["board"]["tasks"][0]["done"], true);
        let (status, _, body) = host
            .send(request_as("POST", "/api/v1/todo", &cookie, Some(json!({ "type": "toggle", "task_id": "not-a-card" }))))
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "answered: {body}");

        // The calendar: an event is created, then deleted, on the month.
        let event = json!({ "calendar_id": calendar_id, "start": "2026-07-15T10:00", "end": "2026-07-15T11:00", "all_day": false,
            "title": "Defense", "location": "", "notes": "", "conference": "", "category": "", "status": "" });
        let (status, _, body) = host
            .send(request_as("POST", "/api/v1/calendar?month=2026-07", &cookie, Some(json!({ "type": "create_event", "event": event }))))
            .await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        let month = json(&body);
        assert_eq!(month["desktop_available"], false);
        assert_eq!(month["calendar"]["events"][0]["title"], "Defense");
        let event_id = month["calendar"]["events"][0]["id"].as_str().expect("event id").to_string();
        let data = crate::commands::calendar::read_data(&state_dir.join("calendar.json")).expect("calendar");
        assert_eq!(data.events.len(), 1);
        assert!(!body.contains(&data.events[0].id), "raw event id leaked: {body}");
        let (status, _, body) = host
            .send(request_as("POST", "/api/v1/calendar?month=2026-07", &cookie, Some(json!({ "type": "delete_event", "event_id": event_id }))))
            .await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        assert_eq!(json(&body)["calendar"]["events"], json!([]));

        // Schedules: a rule is created, edited (keeping prefix commands the
        // phone never sees), and removed.
        std::fs::write(
            state_dir.join("agent_tasks.json"),
            json!({ "version": 1, "projects": { RAW_PROJECT: { "tgt-1": { "schedules": [
                { "id": "sched-1", "enabled": true, "message": "Nightly review", "preface": ["/clear"], "rule": { "type": "daily", "time": "09:00" } }
            ] } } } })
            .to_string(),
        )
        .expect("tasks fixture");
        let (status, _, body) = host
            .send(request_as(
                "POST",
                &format!("/api/v1/tabs/{tab_id}/schedules"),
                &cookie,
                Some(json!({ "enabled": true, "message": "Morning plan", "rule": { "type": "daily", "time": "08:00" } })),
            ))
            .await;
        assert_eq!(status, StatusCode::CREATED, "answered: {body}");
        let listed = json(&body);
        assert_eq!(listed["desktop_available"], false);
        assert_eq!(listed["schedules"].as_array().map(Vec::len), Some(2));
        let created = listed["schedules"].as_array().unwrap().iter().find(|s| s["message"] == "Morning plan").unwrap()["id"].as_str().unwrap().to_string();
        assert!(listed["next_runs"][&created].as_str().is_some_and(|k| k.ends_with("T08:00")));
        leaks(&body);
        let (status, _, body) = host
            .send(request_as(
                "PUT",
                &format!("/api/v1/tabs/{tab_id}/schedules/sched-1"),
                &cookie,
                Some(json!({ "enabled": false, "message": "Nightly review, later", "rule": { "type": "daily", "time": "21:00" } })),
            ))
            .await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        let stored = crate::services::agent_tasks::list_at(&state_dir, RAW_PROJECT, "tgt-1").expect("rules");
        let nightly = stored.iter().find(|r| r.id == "sched-1").expect("kept");
        assert_eq!(nightly.message, "Nightly review, later");
        assert!(!nightly.enabled);
        assert_eq!(nightly.preface, ["/clear"], "the desktop's prefix commands survive a phone edit");
        let (status, _, body) = host
            .send(request_as("DELETE", &format!("/api/v1/tabs/{tab_id}/schedules/{created}"), &cookie, None))
            .await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        assert_eq!(json(&body)["schedules"].as_array().map(Vec::len), Some(1));
        let (status, _, body) = host
            .send(request_as("PUT", &format!("/api/v1/tabs/{tab_id}/schedules/gone"), &cookie, Some(json!({ "enabled": true, "message": "x", "rule": { "type": "daily", "time": "08:00" } }))))
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "answered: {body}");

        // Collected prompts: created, edited, sent now (a one-time rule at
        // this minute under the prompt's id; the prompt retired to the
        // history), and one deleted.
        let (status, _, body) = host
            .send(request_as("POST", &format!("/api/v1/projects/{project_id}/prompts"), &cookie, Some(json!({ "message": "Write the intro" }))))
            .await;
        assert_eq!(status, StatusCode::CREATED, "answered: {body}");
        let answer = json(&body);
        assert_eq!(answer["desktop_available"], false);
        let prompt_id = answer["prompts"][0]["id"].as_str().expect("prompt id").to_string();
        let (status, _, body) = host
            .send(request_as("PUT", &format!("/api/v1/projects/{project_id}/prompts/{prompt_id}"), &cookie, Some(json!({ "message": "Write the intro, briefly" }))))
            .await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        assert_eq!(json(&body)["prompts"][0]["message"], "Write the intro, briefly");
        let (status, _, body) = host
            .send(request_as("POST", &format!("/api/v1/projects/{project_id}/prompts/{prompt_id}/send"), &cookie, Some(json!({ "tab_id": tab_id }))))
            .await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        assert_eq!(json(&body)["prompts"], json!([]), "retired to the history");
        let rules = crate::services::agent_tasks::list_at(&state_dir, RAW_PROJECT, "tgt-1").expect("rules");
        let queued = rules.iter().find(|r| r.id == prompt_id).expect("a one-time rule under the prompt's id");
        assert!(matches!(&queued.rule, crate::schema::agent_tasks::AgentScheduleRule::Once { at } if at.len() == 16));
        assert_eq!(queued.message, "Write the intro, briefly");
        let history = crate::services::agent_prompts::list_at(&state_dir, RAW_PROJECT).expect("prompts");
        assert!(history.is_empty());
        let (status, _, body) = host
            .send(request_as("POST", &format!("/api/v1/projects/{project_id}/prompts"), &cookie, Some(json!({ "message": "Throwaway" }))))
            .await;
        assert_eq!(status, StatusCode::CREATED, "answered: {body}");
        let other = json(&body)["prompts"][0]["id"].as_str().expect("prompt id").to_string();
        let (status, _, body) = host
            .send(request_as("DELETE", &format!("/api/v1/projects/{project_id}/prompts/{other}"), &cookie, None))
            .await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        assert_eq!(json(&body)["prompts"], json!([]));

        // The composer's prompt is recorded on the history; a session
        // command is not.
        let (status, _, body) = host
            .send(request_as("POST", &format!("/api/v1/tabs/{tab_id}/prompt"), &cookie, Some(json!({ "message": "  Summarize the diff  " }))))
            .await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        assert_eq!(json(&body)["recorded"], true);
        let (status, _, body) = host
            .send(request_as("POST", &format!("/api/v1/tabs/{tab_id}/prompt"), &cookie, Some(json!({ "message": "/clear" }))))
            .await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        assert_eq!(json(&body)["recorded"], false);
        let file: serde_json::Value = serde_json::from_slice(&std::fs::read(state_dir.join("agent_prompts.json")).expect("prompts file")).expect("json");
        let rows = file["history"][RAW_PROJECT].as_array().expect("history rows");
        assert!(rows.iter().any(|row| row["message"] == "Summarize the diff" && row["tab_label"] == "Claude" && row["result"] == "delivered"), "{file}");
        assert!(rows.iter().any(|row| row["message"] == "Write the intro, briefly"), "the send-now was retired here: {file}");
        assert!(!rows.iter().any(|row| row["message"] == "/clear"));

        // Nothing to undo for a tab whose hook recorded no clear.
        let (status, _, body) = host.send(request_as("POST", &format!("/api/v1/tabs/{tab_id}/undo-clear"), &cookie, None)).await;
        assert_eq!(status, StatusCode::CONFLICT, "answered: {body}");
        assert_eq!(json(&body)["error"], "nothing_to_undo");

        // The tab's status: state and tally off the files, no usage panel.
        let (status, _, body) = host.send(get_as(&format!("/api/v1/tabs/{tab_id}/status"), &cookie)).await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        let report = json(&body)["report"].clone();
        assert_eq!(report["state"], "idle");
        assert_eq!(report["label"], "Claude");
        assert_eq!(report["project"], "Aurora");
        assert_eq!(report["usage"]["supported"], false);
        assert_eq!(report["usage"]["error"], "desktop_unavailable");
        leaks(&body);

        // The ＋ sheet's options: only what the owner can start.
        let (status, _, body) = host.send(get_as(&format!("/api/v1/projects/{project_id}/launch-options"), &cookie)).await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        let options = json(&body);
        assert_eq!(options["desktop_available"], false);
        assert_eq!(options["worktrees"], json!([]));
        assert_eq!(options["sign_in"], json!([]));

        // Desktop images: a file in Tabtivity's own screenshot folder is listed
        // (no clipboard) and attached into the project inbox.
        let shots = state_dir.join("screenshots-pending");
        std::fs::create_dir_all(&shots).expect("shots dir");
        std::fs::write(shots.join("shot.png"), b"\x89PNG\r\n\x1a\nnot really").expect("shot");
        let (status, _, body) = host.send(get_as(&format!("/api/v1/tabs/{tab_id}/desktop-images"), &cookie)).await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        let images = json(&body);
        assert_eq!(images["desktop_available"], false);
        let shot = images["images"].as_array().unwrap().iter().find(|i| i["name"] == "shot.png").expect("the screenshot is listed");
        assert!(!images["images"].as_array().unwrap().iter().any(|i| i["id"] == "clipboard"));
        let image_id = shot["id"].as_str().unwrap().to_string();
        assert!(!body.contains("screenshots-pending"), "folder path leaked: {body}");
        let (status, _, body) = host
            .send(request_as("POST", &format!("/api/v1/tabs/{tab_id}/desktop-images"), &cookie, Some(json!({ "image_id": image_id }))))
            .await;
        assert_eq!(status, StatusCode::CREATED, "answered: {body}");
        let attached = json(&body)["attachment"].clone();
        assert!(attached["reference"].as_str().is_some_and(|r| r.starts_with(concat!(".", crate::app_slug!(), "/inbox/"))), "{body}");
        assert!(host.root.join(attached["reference"].as_str().unwrap()).is_file());
        let (status, _, body) = host
            .send(request_as("POST", &format!("/api/v1/tabs/{tab_id}/desktop-images"), &cookie, Some(json!({ "image_id": "clipboard" }))))
            .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "answered: {body}");
    }

    /// H3: the owner's undo of a Claude `/clear` types the resume into the
    /// running session, and a relaunch plan ends the session and starts the
    /// tab again on its resume args; a tab whose session is gone is not
    /// ready.
    #[tokio::test]
    async fn an_undo_with_no_window_types_or_relaunches() {
        use crate::services::agent_session::UndoClearPlan;
        let recorded: Arc<Mutex<Vec<PtyOptions>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = recorded.clone();
        let host = headless_host(Arc::new(move |opts: PtyOptions| {
            sink.lock().unwrap().push(opts);
            Box::pin(async { Ok(()) })
        }));
        let snapshot = catalog(&host.state).expect("catalog");
        let project = snapshot.project(&snapshot.projects[0].public.id).expect("project");
        let tab = &project.tabs[0];
        let runner: Arc<dyn scheduler::Runner> = host.runner.clone();
        let state_dir = host.state.config.state_dir.clone();

        let outcome = headless::apply_undo_plan(&state_dir, project, tab, Some(UndoClearPlan::Type { command: "/resume abc".into() }), runner.clone(), &host.state.spawner.launch).await;
        assert_eq!(outcome, Ok(headless::UndoOutcome::TabNotReady), "no session to type into");
        *host.runner.probe.lock().unwrap() = Some(scheduler::SessionProbe { created: 1, activity: 1 });
        let outcome = headless::apply_undo_plan(&state_dir, project, tab, Some(UndoClearPlan::Type { command: "/resume abc".into() }), runner.clone(), &host.state.spawner.launch).await;
        assert_eq!(outcome, Ok(headless::UndoOutcome::Undone));
        let typed = host.runner.delivered.lock().unwrap().clone();
        assert_eq!(typed.len(), 1);
        assert_eq!(typed[0].0, tab.tmux_name);
        assert_eq!(typed[0].1, vec![scheduler::Submission { text: "/resume abc".into(), bracketed: false }]);

        let outcome = headless::apply_undo_plan(&state_dir, project, tab, Some(UndoClearPlan::Relaunch), runner.clone(), &host.state.spawner.launch).await;
        assert_eq!(outcome, Ok(headless::UndoOutcome::Undone));
        assert_eq!(host.runner.killed.lock().unwrap().as_slice(), std::slice::from_ref(&tab.tmux_name));
        let spawned = recorded.lock().unwrap().clone();
        assert_eq!(spawned.len(), 1);
        assert_eq!(spawned[0].tmux_session.as_deref(), Some(tab.tmux_name.as_str()));
        assert_eq!(spawned[0].args, vec!["--resume".to_string(), "9d0f-session".to_string()]);
        assert_eq!(headless::apply_undo_plan(&state_dir, project, tab, None, runner, &host.state.spawner.launch).await, Ok(headless::UndoOutcome::NothingToUndo));
    }

    /// H3: activating a stopped project with no window marks its registry
    /// entry active under the file's lock, so the next window opens it; a
    /// box has no such status and still needs the window.
    #[tokio::test]
    async fn activating_a_project_with_no_window_marks_the_registry() {
        let host = Fixture::with_project();
        let registry = host.state.config.state_dir.join("projects.json");
        let mut list: Vec<Value> = serde_json::from_slice(&std::fs::read(&registry).expect("registry")).expect("json");
        list[0]["status"] = json!("inactive");
        std::fs::write(&registry, serde_json::to_vec(&list).expect("registry")).expect("write registry");
        let cookie = host.pair_device(&signing_key(52)).await.0;
        // A stopped project is off the phone's default list; the search
        // view still finds it.
        let (_, _, projects_body) = host.send(get_as("/api/v1/projects", &cookie)).await;
        assert_eq!(json(&projects_body)["projects"], json!([]));
        let (_, _, projects_body) = host.send(get_as("/api/v1/projects?view=search&q=aur", &cookie)).await;
        let project_id = json(&projects_body)["projects"][0]["id"].as_str().unwrap_or_else(|| panic!("project id: {projects_body}")).to_string();
        let (_, _, body) = host.send(get_as(&format!("/api/v1/projects/{project_id}"), &cookie)).await;
        assert_eq!(json(&body)["project"]["status"], "inactive");
        let (status, _, body) = host
            .send(request_as("POST", &format!("/api/v1/projects/{project_id}/activate"), &cookie, None))
            .await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        assert_eq!(json(&body)["desktop_available"], false);
        let list: Vec<Value> = serde_json::from_slice(&std::fs::read(&registry).expect("registry")).expect("json");
        assert_eq!(list[0]["status"], "active");
        assert_eq!(list[0]["name"], "Aurora", "the rest of the entry survived");
        let (_, _, body) = host.send(get_as(&format!("/api/v1/projects/{project_id}"), &cookie)).await;
        assert_eq!(json(&body)["project"]["status"], "active");
        let (_, _, projects_body) = host.send(get_as("/api/v1/projects", &cookie)).await;
        assert_eq!(json(&projects_body)["projects"][0]["id"], project_id, "listed again");

        let host = Fixture::with_box();
        let cookie = host.pair_device(&signing_key(53)).await.0;
        let (_, _, projects_body) = host.send(get_as("/api/v1/projects", &cookie)).await;
        let box_id = json(&projects_body)["projects"][0]["id"].as_str().expect("box id").to_string();
        let (status, _, body) = host
            .send(request_as("POST", &format!("/api/v1/projects/{box_id}/activate"), &cookie, None))
            .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "answered: {body}");
        assert!(!body.contains(RAW_BOX));
    }

    fn create_request(project_id: &str, cookie: &str, body: Value) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri(format!("/api/v1/projects/{project_id}/tabs"))
            .header(header::ORIGIN, ORIGIN)
            .header(header::COOKIE, cookie_pair(cookie))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::to_vec(&body).expect("body")))
            .expect("request")
    }

    /// H1b exit (headless owner plan §3, H1): with no window, a phone's create
    /// is the owner's — the tab is minted into the session file (id, tmux
    /// name, schedule binding, request hash, session uuid), started detached
    /// through the spawn seam under that name, and listed by the catalog; a
    /// repeat of the request opens nothing twice; what needs the window is
    /// still refused; and nothing raw crosses.
    #[tokio::test]
    async fn a_create_with_no_window_is_minted_spawned_and_listed_by_the_owner() {
        let recorded: Arc<Mutex<Vec<PtyOptions>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = recorded.clone();
        let host = headless_host(Arc::new(move |opts: PtyOptions| {
            sink.lock().unwrap().push(opts);
            Box::pin(async { Ok(()) })
        }));
        let cookie = host.pair_device(&signing_key(41)).await.0;
        let (_, _, projects_body) = host.send(get_as("/api/v1/projects", &cookie)).await;
        let project_id = json(&projects_body)["projects"][0]["id"].as_str().expect("project id").to_string();
        let (status, _, body) = host.send(get_as(&format!("/api/v1/projects/{project_id}"), &cookie)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let detail = json(&body);
        assert_eq!(detail["desktop_available"], false);
        assert_eq!(detail["closed"], json!([]));
        let claude = detail["agents"]
            .as_array()
            .expect("agents")
            .iter()
            .find(|a| a["label"] == "Claude")
            .expect("Claude is offered with no window")["id"]
            .as_str()
            .expect("agent id")
            .to_string();
        let request = json!({
            "project_id": project_id,
            "kind": "agent",
            "agent_id": claude,
            "idempotency_key": "h1b-exit-0123456789abcdef",
        });
        let (status, _, body) = host.send(create_request(&project_id, &cookie, request.clone())).await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        let answer = json(&body);
        assert_eq!(answer["desktop_available"], false);
        assert_eq!(answer["tab"]["kind"], "agent");
        assert_eq!(answer["tab"]["label"], "Claude");
        assert_eq!(answer["tab"]["available"], false, "no tmux server runs here");
        let tab_id = answer["tab"]["id"].as_str().expect("tab id").to_string();

        // The owner minted the tab into the session file.
        let session_path = host.state.config.state_dir.join("sessions").join(RAW_PROJECT).join("terminals.json");
        let session: Value = serde_json::from_slice(&std::fs::read(&session_path).expect("session")).expect("json");
        let tabs = session["tabLayout"].as_array().expect("tabs");
        assert_eq!(tabs.len(), 2, "{session}");
        let minted = &tabs[1];
        assert!(minted["id"].as_str().is_some_and(|id| !id.is_empty()), "{minted}");
        let tmux = minted["tmuxSession"].as_str().expect("tmux name").to_string();
        assert!(tmux.starts_with(&format!("{}{RAW_PROJECT}--agent-", crate::brand::TMUX_PREFIX)), "{tmux}");
        let target = minted["scheduleTargetId"].as_str().expect("schedule binding").to_string();
        assert!(minted["mobileRequestHash"].as_str().is_some());
        let uid = minted["sessionId"].as_str().expect("session uuid").to_string();
        assert_eq!(minted["args"], json!(["--session-id", uid]));
        assert_eq!(minted["env"][crate::app_env!("TAB_UID")], uid);
        assert!(session["workspaceVersion"].as_u64().is_some_and(|v| v >= 2), "{session}");
        let leaks = |body: &str| {
            assert!(!body.contains(RAW_PROJECT), "raw project id leaked: {body}");
            assert!(!body.contains(crate::brand::TMUX_PREFIX), "tmux name leaked: {body}");
            assert!(!body.contains(&uid), "session id leaked: {body}");
            assert!(!body.contains(&target), "schedule target leaked: {body}");
            assert!(!body.contains(&host.root.to_string_lossy().to_string()), "path leaked: {body}");
        };
        leaks(&body);

        // The spawn seam was handed the tab's launch under that name.
        let spawned = recorded.lock().unwrap().clone();
        assert_eq!(spawned.len(), 1);
        let opts = &spawned[0];
        assert_eq!(opts.tmux_session.as_deref(), Some(tmux.as_str()));
        assert_eq!(opts.id, format!("headless:{tmux}"));
        assert_eq!(opts.cmd, "claude");
        assert_eq!(opts.args, vec!["--session-id".to_string(), uid.clone()]);
        assert!(opts.agent);
        assert_eq!(opts.project_id.as_deref(), Some(RAW_PROJECT));
        assert!(std::path::Path::new(&opts.cwd).ends_with("work"), "{}", opts.cwd);
        assert_eq!(opts.env.get(crate::app_env!("TAB_UID")), Some(&uid));
        assert_eq!(opts.schedule_target_id.as_deref(), Some(target.as_str()));

        // The same request again answers the same tab and starts nothing.
        let (status, _, body) = host.send(create_request(&project_id, &cookie, request)).await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        assert_eq!(json(&body)["tab"]["id"], tab_id);
        assert_eq!(recorded.lock().unwrap().len(), 1);
        let session: Value = serde_json::from_slice(&std::fs::read(&session_path).expect("session")).expect("json");
        assert_eq!(session["tabLayout"].as_array().expect("tabs").len(), 2);

        // The catalog lists it, and the activity list knows the project.
        let (_, _, body) = host.send(get_as(&format!("/api/v1/projects/{project_id}"), &cookie)).await;
        assert!(json(&body)["tabs"].as_array().expect("tabs").iter().any(|t| t["id"] == tab_id), "{body}");
        leaks(&body);
        let (status, _, body) = host.send(get_as("/api/v1/activity", &cookie)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(json(&body)["desktop_available"], false);
        leaks(&body);

        // What needs the window is still refused, and a shell is the owner's too.
        let (status, _, body) = host
            .send(create_request(
                &project_id,
                &cookie,
                json!({ "project_id": project_id, "kind": "agent", "agent_id": claude, "cloud": "new", "task": "x", "idempotency_key": "h1b-cloud-0123456789abcdef" }),
            ))
            .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
        assert_eq!(json(&body)["error"], "desktop_unavailable");
        let (status, _, body) = host
            .send(create_request(
                &project_id,
                &cookie,
                json!({ "project_id": project_id, "kind": "shell", "idempotency_key": "h1b-shell-0123456789abcdef" }),
            ))
            .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        assert_eq!(json(&body)["tab"]["kind"], "shell");
        let shell = recorded.lock().unwrap().last().cloned().expect("shell spawn");
        assert_eq!(shell.cmd, "");
        assert!(!shell.agent);
        assert!(shell.tmux_session.as_deref().is_some_and(|n| n.starts_with(&format!("{}{RAW_PROJECT}--shell-", crate::brand::TMUX_PREFIX))));
    }

    /// A headless launch that fails leaves no tab behind: the record is taken
    /// back out and the phone hears `launch_failed`.
    #[tokio::test]
    async fn a_headless_launch_that_fails_takes_the_minted_tab_back_out() {
        let host = headless_host(Arc::new(|_: PtyOptions| Box::pin(async { Err("tmux is not installed".to_string()) })));
        let cookie = host.pair_device(&signing_key(42)).await.0;
        let (_, _, projects_body) = host.send(get_as("/api/v1/projects", &cookie)).await;
        let project_id = json(&projects_body)["projects"][0]["id"].as_str().expect("project id").to_string();
        let (status, _, body) = host
            .send(create_request(
                &project_id,
                &cookie,
                json!({ "project_id": project_id, "kind": "shell", "idempotency_key": "h1b-fail-0123456789abcdef" }),
            ))
            .await;
        assert_eq!(status, StatusCode::BAD_GATEWAY, "{body}");
        assert_eq!(json(&body)["error"], "launch_failed");
        assert!(!body.contains(crate::brand::TMUX_PREFIX), "{body}");
        let session_path = host.state.config.state_dir.join("sessions").join(RAW_PROJECT).join("terminals.json");
        let session: Value = serde_json::from_slice(&std::fs::read(&session_path).expect("session")).expect("json");
        assert_eq!(session["tabLayout"].as_array().expect("tabs").len(), 1, "{session}");
        let (_, _, body) = host.send(get_as(&format!("/api/v1/projects/{project_id}"), &cookie)).await;
        assert_eq!(json(&body)["tabs"].as_array().expect("tabs").len(), 1);
    }

    /// Headless owner plan, H0: with no window open, the persisted-state kinds
    /// — board, month, schedules, prompts, transcript — are answered off the
    /// state dir with the desktop's own opaque ids, flagged
    /// `desktop_available: false`.
    #[tokio::test]
    async fn persisted_state_is_answered_off_the_files_with_no_window() {
        let host = Fixture::with_project();
        let state_dir = host.state.config.state_dir.clone();
        std::fs::write(
            state_dir.join("sessions").join(RAW_PROJECT).join("terminals.json"),
            serde_json::to_vec(&serde_json::json!({
                "tabLayout": [{
                    "label": "Claude",
                    "cmd": "claude",
                    "cwd": host.root.to_string_lossy(),
                    "kind": "agent",
                    "sessionId": "9d0f-session",
                    "scheduleTargetId": "tgt-1",
                    "tmuxSession": format!("{SLUG}-{RAW_PROJECT}--agent-abcdef123"),
                }]
            }))
            .expect("session fixture"),
        )
        .expect("write session");
        std::fs::write(
            state_dir.join("agent_tasks.json"),
            serde_json::json!({
                "version": 1,
                "projects": { RAW_PROJECT: { "tgt-1": { "schedules": [
                    { "id": "sched-1", "enabled": true, "message": "Nightly review", "preface": ["/clear"],
                      "rule": { "type": "daily", "time": "09:00" } }
                ] } } }
            })
            .to_string(),
        )
        .expect("tasks fixture");
        std::fs::write(
            state_dir.join("agent_prompts.json"),
            serde_json::json!({
                "version": 1,
                "projects": { RAW_PROJECT: [
                    { "id": "prompt-1", "message": "Write the intro", "created_at": "2026-07-01T09:00:00Z",
                      "updated_at": "2026-07-01T09:00:00Z", "target": "tgt-1" }
                ] }
            })
            .to_string(),
        )
        .expect("prompts fixture");
        let calendar = state_dir.join("calendar.json");
        let task = crate::commands::calendar::create_task_at(
            &calendar,
            crate::schema::calendar::CalendarTask {
                title: "Ship it".into(),
                project_id: RAW_PROJECT.into(),
                ..Default::default()
            },
        )
        .expect("task");
        let event = crate::commands::calendar::create_event_at(
            &calendar,
            crate::schema::calendar::CalendarEvent {
                title: "Defense".into(),
                start: "2026-07-15T10:00".into(),
                end: "2026-07-15T11:00".into(),
                ..Default::default()
            },
        )
        .expect("event");
        let cookie = host.pair_device(&signing_key(31)).await.0;
        let (_, _, projects_body) = host.send(get_as("/api/v1/projects", &cookie)).await;
        let project_id = json(&projects_body)["projects"][0]["id"].as_str().expect("project id").to_string();
        let (_, _, project_body) = host.send(get_as(&format!("/api/v1/projects/{project_id}"), &cookie)).await;
        let tab_id = json(&project_body)["tabs"][0]["id"].as_str().expect("tab id").to_string();
        let leaks = |body: &str| {
            assert!(!body.contains(RAW_PROJECT), "raw project id leaked: {body}");
            assert!(!body.contains(&task.id), "raw task id leaked: {body}");
            assert!(!body.contains(&event.id), "raw event id leaked: {body}");
            assert!(!body.contains("tgt-1"), "schedule target leaked: {body}");
            assert!(!body.contains(crate::brand::TMUX_PREFIX), "tmux name leaked: {body}");
            assert!(!body.contains(&host.root.to_string_lossy().to_string()), "path leaked: {body}");
        };

        let (status, _, body) = host.send(get_as("/api/v1/todo", &cookie)).await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        let board = json(&body);
        assert_eq!(board["desktop_available"], false);
        assert_eq!(board["board"]["tasks"][0]["title"], "Ship it");
        assert_eq!(board["board"]["tasks"][0]["column"], "backlog");
        assert_eq!(board["board"]["tasks"][0]["project_id"], project_id, "the project chip carries the catalog's id");
        assert_eq!(board["board"]["projects"][0]["name"], "Aurora");
        leaks(&body);

        let (status, _, body) = host.send(get_as("/api/v1/calendar?month=2026-07", &cookie)).await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        let month = json(&body);
        assert_eq!(month["desktop_available"], false);
        assert_eq!(month["calendar"]["month"], "2026-07");
        assert_eq!(month["calendar"]["events"][0]["title"], "Defense");
        assert_eq!(month["calendar"]["events"][0]["start"], "2026-07-15T10:00");
        leaks(&body);

        let (status, _, body) = host.send(get_as(&format!("/api/v1/tabs/{tab_id}/schedules"), &cookie)).await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        let schedules = json(&body);
        assert_eq!(schedules["desktop_available"], false);
        assert_eq!(schedules["schedules"][0]["id"], "sched-1");
        assert_eq!(schedules["schedules"][0]["message"], "Nightly review");
        assert!(schedules["schedules"][0].get("preface").is_none(), "prefix commands stay desktop-side");
        assert!(schedules["next_runs"]["sched-1"].as_str().is_some_and(|k| k.ends_with("T09:00")));
        assert!(schedules["time_zone"].as_str().is_some_and(|z| !z.is_empty()));
        leaks(&body);

        let (status, _, body) = host.send(get_as(&format!("/api/v1/projects/{project_id}/prompts"), &cookie)).await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        let prompts = json(&body);
        assert_eq!(prompts["desktop_available"], false);
        assert_eq!(prompts["prompts"][0]["message"], "Write the intro");
        assert!(prompts["prompts"][0].get("target").is_none(), "the target binding stays desktop-side");
        leaks(&body);

        let (status, _, body) = host.send(get_as(&format!("/api/v1/tabs/{tab_id}/transcript"), &cookie)).await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        let transcript = json(&body);
        assert_eq!(transcript["desktop_available"], false);
        assert_eq!(transcript["transcript"]["available"], false, "no such session on this machine");
        leaks(&body);

        // Writes are still the window's: the sidecar never touches the files.
        let create = Request::builder()
            .method("POST")
            .uri("/api/v1/todo")
            .header(header::ORIGIN, ORIGIN)
            .header(header::COOKIE, cookie_pair(&cookie))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                serde_json::to_vec(&serde_json::json!({
                    "type": "create",
                    "task": { "title": "New", "priority": 0, "percent": 0, "column": "backlog",
                              "calendar_id": board["board"]["calendars"][0]["id"] }
                }))
                .expect("body"),
            ))
            .expect("request");
        // A write with no window is the owner's now (H3): one CAS commit on
        // the file, answered with the board as stored.
        let (status, _, body) = host.send(create).await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        assert_eq!(json(&body)["desktop_available"], false);
        assert_eq!(
            crate::commands::calendar::read_data(&calendar).expect("calendar").tasks.len(),
            2,
            "the card was written"
        );
        leaks(&body);
    }

    #[test]
    fn successful_schedule_response_exposes_only_phone_fields() {
        use crate::schema::{AgentScheduleLastRun, AgentScheduleResult, AgentScheduleRule};

        let (status, Json(body)) = schedule_desktop_error(Ok(DesktopResponse::Schedules {
            schedules: vec![crate::schema::ScheduledAgentPrompt {
                id: "schedule-1".into(),
                enabled: true,
                message: "Review".into(),
                rule: AgentScheduleRule::Daily { time: "09:00".into() },
                preface: vec!["/clear".into()],
                last: Some(AgentScheduleLastRun {
                    occurrence: "2026-09-24T09:00".into(),
                    result: AgentScheduleResult::Delivered,
                    at: "2026-09-24T09:01:00Z".into(),
                }),
                origin: Some(crate::schema::agent_tasks::ScheduleOrigin {
                    by: crate::schema::agent_tasks::ScheduleAuthor::Agent,
                    session: "raw-session-id".into(),
                    at: "2026-09-23T08:00:00Z".into(),
                    from_delivery: None,
                }),
            }],
            time_zone: "Europe/Berlin".into(),
            next_runs: Default::default(),
        }));
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["schedules"], serde_json::json!([{
            "id": "schedule-1",
            "enabled": true,
            "message": "Review",
            "rule": { "type": "daily", "time": "09:00" },
            "last": {
                "occurrence": "2026-09-24T09:00",
                "result": "delivered",
                "at": "2026-09-24T09:01:00Z",
            },
        }]));
    }

    #[test]
    fn successful_prompt_response_omits_internal_target() {
        let (status, Json(body)) = prompt_desktop_error(Ok(DesktopResponse::Prompts {
            prompts: vec![crate::schema::agent_prompts::ProjectAgentPrompt {
                id: "prompt-1".into(),
                message: "Review".into(),
                created_at: "2026-09-23T08:00:00Z".into(),
                updated_at: "2026-09-24T08:00:00Z".into(),
                tags: vec!["review".into()],
                target: Some("raw-schedule-target-id".into()),
            }],
        }));
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["prompts"], serde_json::json!([{
            "id": "prompt-1",
            "message": "Review",
            "created_at": "2026-09-23T08:00:00Z",
            "updated_at": "2026-09-24T08:00:00Z",
            "tags": ["review"],
        }]));
    }

    #[tokio::test]
    async fn the_activity_list_answers_an_empty_list_when_no_desktop_classifies_tabs() {
        let host = Fixture::with_project();
        let cookie = host.pair_device(&signing_key(21)).await.0;
        let (status, _, body) = host.send(get_as("/api/v1/activity", &cookie)).await;
        // A closed desktop is not an error here: the phone shows the list empty
        // and says why, the same way the project overview does.
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        assert_eq!(json(&body)["desktop_available"], false);
        assert_eq!(json(&body)["tabs"].as_array().expect("tabs").len(), 0);
        assert!(!body.contains(RAW_PROJECT));
        assert!(!body.contains(crate::brand::TMUX_PREFIX));
    }

    #[test]
    fn the_activity_list_puts_a_waiting_session_first_and_a_finished_one_last() {
        assert!(activity_rank("question") < activity_rank("working"));
        assert!(activity_rank("working") < activity_rank("done"));
    }

    #[test]
    fn closed_tab_rows_cross_bounded_and_only_with_minted_ids() {
        use super::super::protocol::ClosedAgentTab;
        let row = |id: &str, label: &str| ClosedAgentTab {
            id: id.into(),
            label: label.into(),
            agent: "claude".into(),
            closed_at: 1,
        };
        let mut rows = vec![
            row("../../etc", "bad id"),
            row("5c1d2f0e-8a1b-4c2d-9e3f-0a1b2c3d4e5f", "claude\u{1b}[2J 1"),
        ];
        rows.extend((0..20).map(|i| row(&format!("id-{i}"), "x")));
        let out = closed_tab_rows(rows);
        assert_eq!(out.len(), MAX_CLOSED_TABS);
        assert_eq!(out[0]["id"], "5c1d2f0e-8a1b-4c2d-9e3f-0a1b2c3d4e5f");
        assert_eq!(out[0]["label"], "claude[2J 1");
        assert!(out.iter().all(|r| r["id"] != "../../etc"));
        assert!(!closed_tab_id_ok(&"a".repeat(65)));
        assert!(!closed_tab_id_ok(""));
    }

    #[test]
    fn a_tab_label_is_refused_before_it_can_be_silently_truncated_or_smuggled() {
        assert_eq!(clean_tab_label("  Review  ").as_deref(), Some("Review"));
        assert_eq!(clean_tab_label("   "), None);
        assert!(clean_tab_label(&"x".repeat(MAX_TAB_LABEL)).is_some());
        assert_eq!(clean_tab_label(&"x".repeat(MAX_TAB_LABEL + 1)), None);
        // A control character would reach a terminal title verbatim.
        assert_eq!(clean_tab_label("Claude\u{1b}]0;pwned\u{7}"), None);
        assert_eq!(clean_tab_label("Claude\nrm -rf"), None);
        // The cap counts characters, not bytes: an emoji name is not 4x longer.
        assert!(clean_tab_label(&"\u{1f680}".repeat(MAX_TAB_LABEL)).is_some());
    }

    #[test]
    fn a_tab_colour_is_a_palette_id_or_nothing() {
        // The palette's ids pass; whitespace is trimmed the way a label is.
        assert_eq!(clean_tab_color(Some("teal")), Ok(Some("teal".into())));
        assert_eq!(clean_tab_color(Some("  indigo  ")), Ok(Some("indigo".into())));
        // Two ways of saying "clear it", both accepted: an absent body field and
        // an empty one. This is the phone's None chip.
        assert_eq!(clean_tab_color(None), Ok(None));
        assert_eq!(clean_tab_color(Some("")), Ok(None));
        // Anything else is refused, NOT read as a clear — a colour this build
        // does not know is a version seam, not a request to remove one.
        assert!(clean_tab_color(Some("chartreuse")).is_err());
        // And nothing that is not an id can reach a style attribute.
        assert!(clean_tab_color(Some("#ff0000")).is_err());
        assert!(clean_tab_color(Some("red; background:url(x)")).is_err());
        assert!(clean_tab_color(Some("Red")).is_err());
    }

    #[tokio::test]
    async fn a_sign_in_callback_reaches_only_a_local_listener_for_a_known_agent_tab() {
        let host = Fixture::with_project();
        let cookie = host.pair_device(&signing_key(31)).await.0;
        let (_, _, projects_body) = host.send(get_as("/api/v1/projects", &cookie)).await;
        let project_id = json(&projects_body)["projects"][0]["id"].as_str().expect("project id").to_string();
        let (_, _, project_body) = host.send(get_as(&format!("/api/v1/projects/{project_id}"), &cookie)).await;
        let tab_id = json(&project_body)["tabs"][0]["id"].as_str().expect("tab id").to_string();
        let press = |tab: &str, origin: &'static str, url: &str| {
            Request::builder()
                .method("POST")
                .uri(format!("/api/v1/tabs/{tab}/sign-in-callback"))
                .header(header::ORIGIN, origin)
                .header(header::COOKIE, cookie_pair(&cookie))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(serde_json::to_vec(&json!({ "url": url })).expect("body")))
                .expect("request")
        };
        let good = "http://localhost:1455/auth/callback?code=c&state=s";

        let (status, _, _) = host.send(press(&tab_id, "https://evil.example", good)).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _, body) = host.send(press("not-a-tab", ORIGIN, good)).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "answered: {body}");
        let (status, _, body) = host
            .send(press(&tab_id, ORIGIN, "http://example.com:1455/cb?code=c&state=s"))
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "answered: {body}");
        assert_eq!(json(&body)["error"], "callback_not_local");

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let (mut socket, _) = listener.accept().await.expect("accept");
            let mut request = vec![0u8; 4096];
            let _ = socket.read(&mut request).await;
            let _ = socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nsecret")
                .await;
        });
        let (status, _, body) = host
            .send(press(&tab_id, ORIGIN, &format!("http://127.0.0.1:{port}/cb?code=c&state=s")))
            .await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        assert_eq!(json(&body)["delivered"], true);
        assert!(!body.contains("secret"), "the listener's page stays on the desktop: {body}");
    }

    #[tokio::test]
    async fn a_sign_in_tab_is_asked_for_by_tab_id_and_never_names_a_session() {
        let host = Fixture::with_project();
        let cookie = host.pair_device(&signing_key(32)).await.0;
        let (_, _, projects_body) = host.send(get_as("/api/v1/projects", &cookie)).await;
        let project_id = json(&projects_body)["projects"][0]["id"].as_str().expect("project id").to_string();
        let (_, _, project_body) = host.send(get_as(&format!("/api/v1/projects/{project_id}"), &cookie)).await;
        let tab_id = json(&project_body)["tabs"][0]["id"].as_str().expect("tab id").to_string();
        let press = |uri: String, origin: &'static str, body: Value| {
            Request::builder()
                .method("POST")
                .uri(uri)
                .header(header::ORIGIN, origin)
                .header(header::COOKIE, cookie_pair(&cookie))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(serde_json::to_vec(&body).expect("body")))
                .expect("request")
        };
        let route = format!("/api/v1/tabs/{tab_id}/sign-in");
        let key = "0123456789abcdef";

        let (status, _, _) = host
            .send(press(route.clone(), "https://evil.example", json!({ "idempotency_key": key })))
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _, body) = host
            .send(press("/api/v1/tabs/not-a-tab/sign-in".into(), ORIGIN, json!({ "idempotency_key": key })))
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "answered: {body}");
        // The phone names the tab and the way in, nothing else.
        let (status, _, body) = host
            .send(press(route.clone(), ORIGIN, json!({ "idempotency_key": key, "cmd": "sh" })))
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "answered: {body}");
        let (status, _, body) = host
            .send(press(route.clone(), ORIGIN, json!({ "idempotency_key": "short" })))
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "answered: {body}");

        // Well formed, with no desktop window: unavailable, and nothing the
        // desktop is addressed by comes back.
        let (status, _, body) = host
            .send(press(route, ORIGIN, json!({ "idempotency_key": key, "alternate": true })))
            .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "answered: {body}");
        assert_eq!(json(&body)["error"], "desktop_unavailable");
        assert!(!body.contains(RAW_PROJECT));
        assert!(!body.contains(crate::brand::TMUX_PREFIX));

        // The create route will not take the session name from the phone.
        let (status, _, body) = host
            .send(press(
                format!("/api/v1/projects/{project_id}/tabs"),
                ORIGIN,
                json!({
                    "project_id": project_id,
                    "kind": "agent",
                    "like_tab": concat!(crate::app_slug!(), "-anything"),
                    "sign_in": "default",
                    "idempotency_key": key,
                }),
            ))
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "answered: {body}");
        assert_eq!(json(&body)["error"], "invalid_request");
    }

    #[tokio::test]
    async fn finishing_an_alert_needs_a_same_origin_and_a_usable_row_handle() {
        let host = Fixture::with_project();
        let cookie = host.pair_device(&signing_key(28)).await.0;
        let press = |origin: &'static str, body: Value| {
            Request::builder()
                .method("POST")
                .uri("/api/v1/alerts")
                .header(header::ORIGIN, origin)
                .header(header::COOKIE, cookie_pair(&cookie))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(serde_json::to_vec(&body).expect("body")))
                .expect("request")
        };

        // Origin is checked before the handle and before any desktop call.
        let (status, _, body) = host
            .send(press("https://evil.example", json!({ "alert_id": "row" })))
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "answered: {body}");

        // The sidecar validates the handle's shape and nothing else: an empty
        // one, and a body that tries to name the act instead of the row.
        let (status, _, body) = host.send(press(ORIGIN, json!({ "alert_id": "" }))).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "answered: {body}");
        assert_eq!(json(&body)["error"], "invalid_request");
        let (status, _, body) = host
            .send(press(ORIGIN, json!({ "alert_id": "row", "action": "delete" })))
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "answered: {body}");

        // A well-formed press with no desktop window is unavailable, not a
        // refusal the phone should read as "that alert is gone".
        let (status, _, body) = host.send(press(ORIGIN, json!({ "alert_id": "row" }))).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "answered: {body}");
        assert_eq!(json(&body)["error"], "desktop_unavailable");
    }

    #[tokio::test]
    async fn renaming_a_tab_needs_the_desktop_bridge_a_same_origin_and_a_usable_label() {
        let host = Fixture::with_project();
        let cookie = host.pair_device(&signing_key(16)).await.0;
        let (_, _, projects_body) = host.send(get_as("/api/v1/projects", &cookie)).await;
        let project_id = json(&projects_body)["projects"][0]["id"]
            .as_str()
            .expect("opaque project id")
            .to_string();
        let (_, _, project_body) = host
            .send(get_as(&format!("/api/v1/projects/{project_id}"), &cookie))
            .await;
        let tab_id = json(&project_body)["tabs"][0]["id"]
            .as_str()
            .expect("opaque tab id")
            .to_string();

        let rename = |origin: &'static str, label: &str| {
            Request::builder()
                .method("PUT")
                .uri(format!("/api/v1/tabs/{tab_id}"))
                .header(header::ORIGIN, origin)
                .header(header::COOKIE, cookie_pair(&cookie))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    serde_json::to_vec(&serde_json::json!({ "label": label })).expect("body"),
                ))
                .expect("request")
        };

        // Origin is checked before the label and before any desktop call.
        let (status, _, body) = host.send(rename("https://evil.example", "Owned")).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "answered: {body}");

        let (status, _, body) = host.send(rename(ORIGIN, "   ")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "answered: {body}");
        assert_eq!(json(&body)["error"], "invalid_label");

        // A well-formed rename with no desktop window is the owner's (H3): it
        // lands in the session file, is answered as stored and flagged, and
        // still leaks neither the raw project id nor the tmux name.
        let (status, _, body) = host.send(rename(ORIGIN, "Release review")).await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        assert_eq!(json(&body)["desktop_available"], false);
        assert_eq!(json(&body)["tab"]["label"], "Release review");
        assert!(!body.contains(RAW_PROJECT));
        assert!(!body.contains(crate::brand::TMUX_PREFIX));
    }

    #[tokio::test]
    async fn closing_a_tab_serves_every_kind_and_needs_the_desktop_bridge() {
        // A box holding shell tabs: closing is the one tab route that is not
        // agent-only, so the fixture is deliberately a kind the schedule and
        // rename routes refuse.
        let host = Fixture::with_box();
        let cookie = host.pair_device(&signing_key(21)).await.0;
        let (_, _, projects_body) = host.send(get_as("/api/v1/projects", &cookie)).await;
        let project_id = json(&projects_body)["projects"][0]["id"]
            .as_str()
            .expect("opaque box id")
            .to_string();
        let (_, _, project_body) = host
            .send(get_as(&format!("/api/v1/projects/{project_id}"), &cookie))
            .await;
        let tab = json(&project_body)["tabs"][0].clone();
        assert_eq!(tab["kind"], "shell");
        let tab_id = tab["id"].as_str().expect("opaque tab id").to_string();

        let close = |origin: &'static str, cookie: Option<&str>| {
            let mut request = Request::builder()
                .method("DELETE")
                .uri(format!("/api/v1/tabs/{tab_id}"))
                .header(header::ORIGIN, origin);
            if let Some(cookie) = cookie {
                request = request.header(header::COOKIE, cookie_pair(cookie));
            }
            request.body(Body::empty()).expect("request")
        };

        // Authentication, then origin, before anything is resolved or called.
        let (status, _, body) = host.send(close(ORIGIN, None)).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "answered: {body}");
        let (status, _, body) = host.send(close("https://evil.example", Some(&cookie))).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "answered: {body}");

        // A well-formed close with no desktop window is the owner's (H3): the
        // tab leaves the session file and its session is ended — and the
        // answer leaks neither the raw ids nor the tmux name.
        let (status, _, body) = host.send(close(ORIGIN, Some(&cookie))).await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        assert_eq!(json(&body)["closed"], true);
        assert_eq!(json(&body)["desktop_available"], false);
        assert!(!body.contains(RAW_BOX));
        assert!(!body.contains(RAW_PROJECT));
        assert!(!body.contains(crate::brand::TMUX_PREFIX));
        assert_eq!(
            host.runner.killed.lock().unwrap().as_slice(),
            [format!("{SLUG}-box_{RAW_BOX}--shell-abcdef123")],
            "the session behind the closed tab was ended"
        );
        let (_, _, project_body) = host
            .send(get_as(&format!("/api/v1/projects/{project_id}"), &cookie))
            .await;
        assert_eq!(json(&project_body)["tabs"].as_array().map(Vec::len), Some(1), "{project_body}");
        let tab_id = json(&project_body)["tabs"][0]["id"].as_str().expect("remaining tab").to_string();

        // The agent-only routes are unchanged by that: the same shell tab is
        // still refused a schedule.
        let (status, _, body) = host
            .send(get_as(&format!("/api/v1/tabs/{tab_id}/schedules"), &cookie))
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "answered: {body}");
        assert_eq!(json(&body)["error"], "agent_tab_required");

        // An unknown tab is a 404 rather than a desktop call.
        let (status, _, body) = host
            .send(
                Request::builder()
                    .method("DELETE")
                    .uri("/api/v1/tabs/not-a-tab")
                    .header(header::ORIGIN, ORIGIN)
                    .header(header::COOKIE, cookie_pair(&cookie))
                    .body(Body::empty())
                    .expect("request"),
            )
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "answered: {body}");
    }

    #[tokio::test]
    async fn moving_a_tab_names_both_rows_by_id_and_needs_the_desktop_bridge() {
        // The box fixture, for its two tabs: a move is the one tab route that
        // takes a second row, and both must resolve to the same scope.
        let host = Fixture::with_box();
        let cookie = host.pair_device(&signing_key(31)).await.0;
        let (_, _, projects_body) = host.send(get_as("/api/v1/projects", &cookie)).await;
        let project_id = json(&projects_body)["projects"][0]["id"]
            .as_str()
            .expect("opaque box id")
            .to_string();
        let (_, _, project_body) = host
            .send(get_as(&format!("/api/v1/projects/{project_id}"), &cookie))
            .await;
        let tabs = json(&project_body)["tabs"].clone();
        let tab_id = tabs[0]["id"].as_str().expect("opaque tab id").to_string();
        let anchor_id = tabs[1]["id"].as_str().expect("opaque tab id").to_string();

        let move_to = |origin: &'static str, cookie: Option<&str>, anchor: &str, place: &str| {
            let mut request = Request::builder()
                .method("PUT")
                .uri(format!("/api/v1/tabs/{tab_id}/order"))
                .header(header::ORIGIN, origin)
                .header(header::CONTENT_TYPE, "application/json");
            if let Some(cookie) = cookie {
                request = request.header(header::COOKIE, cookie_pair(cookie));
            }
            request
                .body(Body::from(
                    serde_json::to_vec(&serde_json::json!({ "anchor": anchor, "place": place }))
                        .expect("body"),
                ))
                .expect("request")
        };

        // Authentication, then origin, before either row is resolved.
        let (status, _, body) = host.send(move_to(ORIGIN, None, &anchor_id, "after")).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "answered: {body}");
        let (status, _, body) = host
            .send(move_to("https://evil.example", Some(&cookie), &anchor_id, "after"))
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "answered: {body}");

        // A side this build does not know, and a tab dropped on itself, are
        // both refused before any desktop call.
        let (status, _, body) = host
            .send(move_to(ORIGIN, Some(&cookie), &anchor_id, "above"))
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "answered: {body}");
        assert_eq!(json(&body)["error"], "invalid_request");
        let (status, _, body) = host.send(move_to(ORIGIN, Some(&cookie), &tab_id, "after")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "answered: {body}");
        assert_eq!(json(&body)["error"], "invalid_anchor");

        // An anchor that is not a tab is a 404, not a move against a guess.
        let (status, _, body) = host
            .send(move_to(ORIGIN, Some(&cookie), "not-a-tab", "before"))
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "answered: {body}");
        assert_eq!(json(&body)["error"], "tab_not_found");

        // A well-formed move with no desktop window is the owner's (H3): the
        // session file's order is the phone's, and the answer says nothing
        // about the raw ids or the tmux names.
        let (status, _, body) = host
            .send(move_to(ORIGIN, Some(&cookie), &anchor_id, "after"))
            .await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        assert_eq!(json(&body)["desktop_available"], false);
        assert_eq!(json(&body)["tabs"], serde_json::json!([anchor_id, tab_id]), "the moved tab now follows its anchor");
        assert!(!body.contains(RAW_BOX));
        assert!(!body.contains(RAW_PROJECT));
        assert!(!body.contains(crate::brand::TMUX_PREFIX));
    }

    #[tokio::test]
    async fn mail_writes_check_origin_and_shape_before_the_desktop_bridge() {
        let host = Fixture::bare();
        let cookie = host.pair_device(&signing_key(17)).await.0;
        let post = |uri: &str, origin: &'static str, body: Value| {
            Request::builder()
                .method("POST")
                .uri(uri.to_string())
                .header(header::ORIGIN, origin)
                .header(header::COOKIE, cookie_pair(&cookie))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(serde_json::to_vec(&body).expect("body")))
                .expect("request")
        };
        let mark = "/api/v1/mail/folders/folder-1/messages/message-1/mark";
        let reply = "/api/v1/mail/folders/folder-1/messages/message-1/reply";

        // Origin first, before the body is even parsed.
        let (status, _, body) = host
            .send(post(mark, "https://evil.example", serde_json::json!({ "action": "seen" })))
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "answered: {body}");
        assert_eq!(json(&body)["error"], "invalid_origin");

        // Only the four flag verbs exist: no delete, no move, no free-form flag.
        for action in ["deleted", "move", "\\Seen", ""] {
            let (status, _, body) = host
                .send(post(mark, ORIGIN, serde_json::json!({ "action": action })))
                .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{action} answered: {body}");
            assert_eq!(json(&body)["error"], "invalid_request", "{action}");
        }
        // Ids are validated exactly as the read routes validate them.
        let (status, _, body) = host
            .send(post(
                "/api/v1/mail/folders/../messages/message-1/mark",
                ORIGIN,
                serde_json::json!({ "action": "seen" }),
            ))
            .await;
        assert!(
            status == StatusCode::BAD_REQUEST || status == StatusCode::NOT_FOUND,
            "answered: {body}"
        );

        // A reply carries text and nothing else: no recipient, subject or
        // headers are accepted from the phone.
        let (status, _, body) = host
            .send(post(
                reply,
                ORIGIN,
                serde_json::json!({ "body": "Thanks", "to": "someone@example.test" }),
            ))
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "answered: {body}");
        let (status, _, body) = host
            .send(post(reply, ORIGIN, serde_json::json!({ "body": "   " })))
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "answered: {body}");
        assert_eq!(json(&body)["error"], "empty_reply");
        let (status, _, body) = host
            .send(post(
                reply,
                ORIGIN,
                serde_json::json!({ "body": "x".repeat(MAX_MAIL_REPLY_BYTES + 1) }),
            ))
            .await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "answered: {body}");

        // Well-formed writes with no desktop window are unavailable, not
        // silently accepted: the sidecar never touches mail itself.
        for (uri, body) in [
            (mark, serde_json::json!({ "action": "flag", "offset": 25 })),
            (reply, serde_json::json!({ "body": "On my way." })),
        ] {
            let (status, _, answer) = host.send(post(uri, ORIGIN, body)).await;
            assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{uri} answered: {answer}");
            assert_eq!(json(&answer)["error"], "desktop_unavailable", "{uri}");
        }
    }

    #[tokio::test]
    async fn prompt_collection_requires_the_desktop_bridge_and_checks_origin() {
        let host = Fixture::with_project();
        let cookie = host.pair_device(&signing_key(14)).await.0;
        let (_, _, projects_body) = host.send(get_as("/api/v1/projects", &cookie)).await;
        let project_id = json(&projects_body)["projects"][0]["id"]
            .as_str()
            .expect("opaque project id")
            .to_string();
        let (_, _, project_body) = host
            .send(get_as(&format!("/api/v1/projects/{project_id}"), &cookie))
            .await;
        let tab_id = json(&project_body)["tabs"][0]["id"]
            .as_str()
            .expect("opaque tab id")
            .to_string();

        // No window: the (empty) collection is answered off the file and
        // flagged read-only; nothing raw crosses.
        let (status, _, body) = host
            .send(get_as(&format!("/api/v1/projects/{project_id}/prompts"), &cookie))
            .await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        assert_eq!(json(&body)["desktop_available"], false);
        assert_eq!(json(&body)["prompts"], serde_json::json!([]));
        assert!(!body.contains(RAW_PROJECT));

        let (status, _, body) = host
            .send(get_as("/api/v1/projects/nope/prompts", &cookie))
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "answered: {body}");

        // A mutation from a foreign origin is refused before any desktop call.
        let create = Request::builder()
            .method("POST")
            .uri(format!("/api/v1/projects/{project_id}/prompts"))
            .header(header::ORIGIN, "https://evil.example")
            .header(header::COOKIE, cookie_pair(&cookie))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                serde_json::to_vec(&serde_json::json!({ "message": "Review" })).expect("body"),
            ))
            .expect("request");
        let (status, _, answer) = host.send(create).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "answered: {answer}");

        // Sending names a tab of this project; a shell tab is not a target.
        let send = Request::builder()
            .method("POST")
            .uri(format!("/api/v1/projects/{project_id}/prompts/anything/send"))
            .header(header::ORIGIN, ORIGIN)
            .header(header::COOKIE, cookie_pair(&cookie))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                serde_json::to_vec(&serde_json::json!({ "tab_id": tab_id })).expect("body"),
            ))
            .expect("request");
        let (status, _, answer) = host.send(send).await;
        assert!(
            status == StatusCode::BAD_REQUEST || status == StatusCode::NOT_FOUND,
            "answered {status}: {answer}"
        );
        assert!(!answer.contains(RAW_PROJECT));
        assert!(!answer.contains("tmux"));
    }

    #[tokio::test]
    async fn a_session_cookie_must_carry_the_exact_host_prefixed_name() {
        let host = Fixture::bare();
        let cookie = host.pair_device(&signing_key(9)).await.0;
        let token = cookie_pair(&cookie)
            .split_once('=')
            .expect("token")
            .1
            .to_string();

        let (status, ..) = host.send(get_as("/api/v1/status", &cookie)).await;
        assert_eq!(status, StatusCode::OK);

        // The same token under an unprefixed name carries none of the
        // `__Host-` guarantees and must not authenticate.
        let request = Request::builder()
            .uri("/api/v1/status")
            .header(header::COOKIE, format!("{SLUG}_session={token}"))
            .body(Body::empty())
            .expect("request");
        let (status, _, body) = host.send(request).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "answered: {body}");
    }

    #[tokio::test]
    async fn mutating_routes_require_the_exact_serve_origin() {
        let host = Fixture::bare();
        let cookie = host.pair_device(&signing_key(11)).await.0;
        let body = serde_json::json!({ "device_id": "anything" });
        // A prefix of the real origin, a suffix of it, and no header at all.
        for origin in [
            "https://desk.example.ts.net.evil.example",
            "https://evil.example",
            "http://desk.example.ts.net",
            "null",
        ] {
            let (status, _, answer) = host.send(post_json("/api/v1/auth/challenge", origin, &body)).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{origin} answered: {answer}");
            assert_eq!(json(&answer)["error"], "invalid_origin", "{origin}");
        }
        let request = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/challenge")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::to_vec(&body).expect("body")))
            .expect("request");
        let (status, ..) = host.send(request).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "a missing Origin is not exact");

        // An authenticated mutation is refused on origin too, not just on session.
        let create = Request::builder()
            .method("POST")
            .uri("/api/v1/projects/anything/tabs")
            .header(header::ORIGIN, "https://evil.example")
            .header(header::COOKIE, cookie_pair(&cookie))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                serde_json::to_vec(&serde_json::json!({
                    "project_id": "anything",
                    "kind": "shell",
                    "idempotency_key": "0123456789abcdef",
                }))
                .expect("body"),
            ))
            .expect("request");
        let (status, _, answer) = host.send(create).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "answered: {answer}");

        let schedule = Request::builder()
            .method("POST")
            .uri("/api/v1/tabs/anything/schedules")
            .header(header::ORIGIN, "https://evil.example")
            .header(header::COOKIE, cookie_pair(&cookie))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                serde_json::to_vec(&serde_json::json!({
                    "enabled": true,
                    "message": "Review",
                    "rule": { "type": "daily", "time": "09:00" },
                }))
                .expect("body"),
            ))
            .expect("request");
        let (status, _, answer) = host.send(schedule).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "answered: {answer}");
    }

    #[tokio::test]
    async fn a_paired_login_issues_a_hardened_session_cookie() {
        let host = Fixture::bare();
        let (cookie, _) = host.pair_device(&signing_key(13)).await;
        for attribute in [
            concat!("__Host-", crate::app_slug!(), "_session="),
            "Path=/",
            "Secure",
            "HttpOnly",
            "SameSite=Strict",
        ] {
            assert!(cookie.contains(attribute), "{attribute} missing from {cookie}");
        }
        let (status, headers, _) = host.send(get_as("/api/v1/status", &cookie)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers[header::CACHE_CONTROL], "no-store");
    }

    #[tokio::test]
    async fn a_signature_from_another_key_never_logs_in() {
        let host = Fixture::bare();
        let device = host.pair_device(&signing_key(17)).await.1;
        let (_, _, body) = host
            .send(post_json(
                "/api/v1/auth/challenge",
                ORIGIN,
                &serde_json::json!({ "device_id": device }),
            ))
            .await;
        let challenge = json(&body);
        let (status, _, answer) = host
            .send(post_json(
                "/api/v1/auth/session",
                ORIGIN,
                &serde_json::json!({
                    "device_id": device,
                    "nonce": challenge["nonce"],
                    // Correct payload, wrong device key.
                    "signature": sign(&signing_key(18), challenge["payload"].as_str().unwrap()),
                }),
            ))
            .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "answered: {answer}");
        assert_eq!(json(&answer)["error"], "invalid_signature");
    }

    #[tokio::test]
    async fn a_captured_challenge_cannot_be_replayed() {
        let host = Fixture::bare();
        let signing = signing_key(19);
        let device = host.pair_device(&signing).await.1;
        let (_, _, body) = host
            .send(post_json(
                "/api/v1/auth/challenge",
                ORIGIN,
                &serde_json::json!({ "device_id": device }),
            ))
            .await;
        let challenge = json(&body);
        let login = serde_json::json!({
            "device_id": device,
            "nonce": challenge["nonce"],
            "signature": sign(&signing, challenge["payload"].as_str().unwrap()),
        });
        let (first, ..) = host.send(post_json("/api/v1/auth/session", ORIGIN, &login)).await;
        assert_eq!(first, StatusCode::OK);
        let (second, _, answer) = host.send(post_json("/api/v1/auth/session", ORIGIN, &login)).await;
        assert_eq!(second, StatusCode::UNAUTHORIZED, "replay answered: {answer}");
        assert_eq!(json(&answer)["error"], "invalid_challenge");
    }

    #[tokio::test]
    async fn revoking_a_device_kills_its_live_session() {
        let host = Fixture::bare();
        let (cookie, device) = host.pair_device(&signing_key(23)).await;
        let (status, ..) = host.send(get_as("/api/v1/status", &cookie)).await;
        assert_eq!(status, StatusCode::OK);

        host.state.auth.lock().unwrap().revoke(&device).expect("revoke");

        let (status, _, body) = host.send(get_as("/api/v1/status", &cookie)).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "a lost phone kept access: {body}");
    }

    #[tokio::test]
    async fn logging_out_clears_the_cookie_and_the_session() {
        let host = Fixture::bare();
        let cookie = host.pair_device(&signing_key(29)).await.0;
        let request = Request::builder()
            .method("DELETE")
            .uri("/api/v1/auth/session")
            .header(header::ORIGIN, ORIGIN)
            .header(header::COOKIE, cookie_pair(&cookie))
            .body(Body::empty())
            .expect("request");
        let (status, headers, _) = host.send(request).await;
        assert_eq!(status, StatusCode::OK);
        assert!(set_cookie(&headers).contains("Max-Age=0"));

        let (status, ..) = host.send(get_as("/api/v1/status", &cookie)).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn a_pairing_flood_is_rate_limited_at_the_http_edge() {
        let host = Fixture::bare();
        host.state
            .auth
            .lock()
            .unwrap()
            .create_pairing_code()
            .expect("pairing code");
        let guess = serde_json::json!({
            "code": "00000000",
            "device_name": "Attacker",
            "public_key": "not-a-key",
        });
        let mut limited = false;
        // One more than the pairing budget in `auth::PAIR_ATTEMPT_BUDGET`.
        for _ in 0..11 {
            let (status, _, body) = host.send(post_json("/api/v1/pair", ORIGIN, &guess)).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "answered: {body}");
            limited |= json(&body)["error"] == "too_many_attempts";
        }
        assert!(limited, "the pair flood was never rate limited");
    }

    #[tokio::test]
    async fn an_oversized_control_body_never_reaches_a_handler() {
        let host = Fixture::bare();
        let request = Request::builder()
            .method("POST")
            .uri("/api/v1/pair")
            .header(header::ORIGIN, ORIGIN)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(vec![b'x'; MAX_CONTROL_MESSAGE + 1]))
            .expect("request");
        let (status, ..) = host.send(request).await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn every_response_carries_the_hardened_security_headers() {
        let host = Fixture::bare();
        for uri in ["/healthz", "/api/v1/status", "/"] {
            let (_, headers, _) = host.send(get_request(uri)).await;
            assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff", "{uri}");
            assert_eq!(headers[header::X_FRAME_OPTIONS], "DENY", "{uri}");
            assert!(
                headers[header::CONTENT_SECURITY_POLICY]
                    .to_str()
                    .unwrap()
                    .contains("frame-ancestors 'none'"),
                "{uri}"
            );
            assert_eq!(headers["permissions-policy"], MOBILE_PERMISSIONS_POLICY, "{uri}");
        }
        // Only the API and health probe are no-store; the shell is revalidated.
        let (_, api, _) = host.send(get_request("/api/v1/status")).await;
        assert_eq!(api[header::CACHE_CONTROL], "no-store");
        let (_, shell, _) = host.send(get_request("/")).await;
        assert_eq!(shell[header::CACHE_CONTROL], "no-cache");
    }

    #[tokio::test]
    async fn an_unknown_api_path_is_not_answered_with_the_app_shell() {
        let host = Fixture::bare();
        let (status, headers, body) = host.send(get_request("/api/v1/does-not-exist")).await;
        let content_type = headers
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string();
        assert!(
            !content_type.contains("text/html"),
            "an /api/ miss served the SPA shell ({status}): {content_type}"
        );
        assert_eq!(status, StatusCode::NOT_FOUND, "answered: {body}");
    }

    #[tokio::test]
    async fn the_catalog_hands_the_phone_opaque_ids_and_no_paths() {
        let host = Fixture::with_project();
        let cookie = host.pair_device(&signing_key(31)).await.0;

        let (status, _, body) = host
            .send(get_as("/api/v1/projects?view=search&q=aurora", &cookie))
            .await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        assert!(body.contains("Aurora"), "the display label is missing: {body}");
        assert!(!body.contains(RAW_PROJECT), "a raw project id leaked: {body}");
        assert!(
            !body.contains(&host.root.to_string_lossy().to_string()),
            "a filesystem path leaked: {body}"
        );

        let opaque = json(&body)["projects"][0]["id"]
            .as_str()
            .expect("opaque project id")
            .to_string();

        // The opaque id resolves; the raw one the desktop uses does not.
        let (status, ..) = host
            .send(get_as(&format!("/api/v1/projects/{opaque}"), &cookie))
            .await;
        assert_eq!(status, StatusCode::OK);
        let (status, _, body) = host
            .send(get_as(&format!("/api/v1/projects/{RAW_PROJECT}"), &cookie))
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "a raw id resolved: {body}");
    }

    /// #31aa: a box with Mobile on is a row of the phone's list — kind `box`,
    /// always active, opaque id, no path, no raw id — and its own tabs come
    /// back under it, including the one running in a member's tree. The
    /// member's own Mobile switch is off, so the member is *not* a row; the
    /// box's switch reaches the box's tabs and nothing of the member's own.
    #[tokio::test]
    async fn a_mobile_enabled_box_is_listed_as_a_box_scope_with_its_own_tabs() {
        let host = Fixture::with_box();
        let cookie = host.pair_device(&signing_key(33)).await.0;

        let (status, _, body) = host.send(get_as("/api/v1/projects?view=active", &cookie)).await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        let rows = json(&body)["projects"].as_array().cloned().unwrap_or_default();
        assert_eq!(rows.len(), 1, "one box, no member of its own: {body}");
        assert_eq!(rows[0]["label"], "Paper");
        assert_eq!(rows[0]["kind"], "box");
        assert_eq!(rows[0]["status"], "active");
        assert!(!body.contains(RAW_BOX), "a raw box id leaked: {body}");
        assert!(!body.contains(RAW_PROJECT), "a raw project id leaked: {body}");
        assert!(!body.contains("Private"), "a box with Mobile off is listed: {body}");
        assert!(
            !body.contains(&host.root.to_string_lossy().to_string()),
            "a filesystem path leaked: {body}"
        );

        let opaque = rows[0]["id"].as_str().expect("opaque box id").to_string();
        let (status, _, body) = host
            .send(get_as(&format!("/api/v1/projects/{opaque}"), &cookie))
            .await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        let detail = json(&body);
        assert_eq!(detail["project"]["kind"], "box");
        let labels: Vec<String> = detail["tabs"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|tab| tab["label"].as_str().unwrap_or_default().to_string())
            .collect();
        assert_eq!(labels, vec!["Box shell", "Aurora shell"], "{body}");
        assert!(!body.contains("box_"), "a session-dir or tmux name leaked: {body}");
    }

    #[tokio::test]
    async fn a_tab_without_a_live_session_is_reported_gone() {
        let host = Fixture::with_project();
        let cookie = host.pair_device(&signing_key(37)).await.0;
        let (status, _, body) = host
            .send(get_as("/api/v1/projects?view=search&q=aurora", &cookie))
            .await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        let opaque = json(&body)["projects"][0]["id"].as_str().unwrap().to_string();
        let (_, _, body) = host
            .send(get_as(&format!("/api/v1/projects/{opaque}"), &cookie))
            .await;
        let tab = &json(&body)["tabs"][0];
        assert_eq!(tab["kind"], "agent");
        assert_eq!(
            tab["available"], false,
            "a tab with no tmux session must not be attachable: {body}"
        );
        assert!(!body.contains(concat!(crate::app_slug!(), "-raw-project")), "a tmux name leaked: {body}");
    }

    #[tokio::test]
    async fn a_create_request_for_another_project_is_refused_before_any_state_is_read() {
        let host = Fixture::with_project();
        let cookie = host.pair_device(&signing_key(41)).await.0;
        let request = |body: Value| {
            Request::builder()
                .method("POST")
                .uri("/api/v1/projects/target/tabs")
                .header(header::ORIGIN, ORIGIN)
                .header(header::COOKIE, cookie_pair(&cookie))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(serde_json::to_vec(&body).expect("body")))
                .expect("request")
        };
        // The body's project id disagrees with the path's.
        let (status, _, answer) = host
            .send(request(serde_json::json!({
                "project_id": "somewhere-else",
                "kind": "shell",
                "idempotency_key": "0123456789abcdef",
            })))
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "answered: {answer}");
        assert_eq!(json(&answer)["error"], "invalid_request");

        // A shell, while shells are off the phone (the default), is refused
        // before the catalog is asked.
        let (status, _, answer) = host
            .send(request(serde_json::json!({
                "project_id": "target",
                "kind": "shell",
                "idempotency_key": "0123456789abcdef",
            })))
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "answered: {answer}");
        assert_eq!(json(&answer)["error"], "shells_off");

        // An unknown project resolves to nothing rather than to a raw id.
        std::fs::write(
            host.state.config.state_dir.join("settings.json"),
            serde_json::json!({ crate::brand::MOBILE_HOST_KEY: { "enabled": true, "shell_tabs": true } }).to_string(),
        )
        .expect("settings");
        let (status, _, answer) = host
            .send(request(serde_json::json!({
                "project_id": "target",
                "kind": "shell",
                "idempotency_key": "0123456789abcdef",
            })))
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "answered: {answer}");
    }

    /// The opaque id of the fixture project's one tab, as the phone sees it.
    async fn fixture_tab_id(host: &Fixture, cookie: &str) -> String {
        let (_, _, body) = host
            .send(get_as("/api/v1/projects?view=search&q=aurora", cookie))
            .await;
        let opaque = json(&body)["projects"][0]["id"].as_str().unwrap().to_string();
        let (_, _, body) = host
            .send(get_as(&format!("/api/v1/projects/{opaque}"), cookie))
            .await;
        json(&body)["tabs"][0]["id"].as_str().unwrap().to_string()
    }

    fn inbox_request(tab_id: &str, name: &str, cookie: &str, bytes: Vec<u8>) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri(format!("/api/v1/tabs/{tab_id}/inbox?name={name}"))
            .header(header::ORIGIN, ORIGIN)
            .header(header::COOKIE, cookie_pair(cookie))
            .header(header::CONTENT_TYPE, "image/jpeg")
            .body(Body::from(bytes))
            .expect("request")
    }

    #[tokio::test]
    async fn desktop_images_need_the_bridge_a_known_tab_a_same_origin_and_a_listed_id() {
        let host = Fixture::with_project();
        let cookie = host.pair_device(&signing_key(31)).await.0;
        let tab_id = fixture_tab_id(&host, &cookie).await;
        let attach = |tab: &str, origin: &str, body: Value| {
            Request::builder()
                .method("POST")
                .uri(format!("/api/v1/tabs/{tab}/desktop-images"))
                .header(header::ORIGIN, origin)
                .header(header::COOKIE, cookie_pair(&cookie))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(serde_json::to_vec(&body).expect("body")))
                .expect("request")
        };

        // No desktop window: the folders are listed here, flagged (H3), and
        // neither the raw project id nor the project path leaks out.
        let (status, _, body) = host
            .send(get_as(&format!("/api/v1/tabs/{tab_id}/desktop-images"), &cookie))
            .await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        assert_eq!(json(&body)["desktop_available"], false);
        assert!(!body.contains(RAW_PROJECT));
        assert!(!body.contains(host.root.to_str().unwrap()));

        let (status, _, body) = host
            .send(get_as("/api/v1/tabs/not-a-tab/desktop-images", &cookie))
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "answered: {body}");

        // Origin, then the id's shape, before any desktop call — a path-shaped
        // id is refused as malformed, never resolved.
        let clipboard = serde_json::json!({ "image_id": "clipboard" });
        let (status, _, body) = host
            .send(attach(&tab_id, "https://evil.example", clipboard.clone()))
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "answered: {body}");
        for bad in ["", "../../etc/passwd", "/home/x/shot.png", "0123", "not-hex-but-32-characters-long!!"] {
            let (status, _, body) = host
                .send(attach(&tab_id, ORIGIN, serde_json::json!({ "image_id": bad })))
                .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{bad:?} answered: {body}");
            assert_eq!(json(&body)["error"], "invalid_request");
        }
        let (status, _, body) = host
            .send(attach(&tab_id, ORIGIN, serde_json::json!({ "nope": 1 })))
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "answered: {body}");

        let (status, _, body) = host.send(attach(&tab_id, ORIGIN, clipboard.clone())).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "answered: {body}");
        assert_eq!(json(&body)["error"], "desktop_unavailable");
        let (status, _, body) = host.send(attach("not-a-tab", ORIGIN, clipboard)).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "answered: {body}");
        // Nothing reached the inbox without a desktop to copy from.
        assert!(!host.root.join(inbox::INBOX_DIR).exists());
    }

    #[tokio::test]
    async fn the_outbox_lists_and_serves_the_agents_images_by_leaf_only() {
        let host = Fixture::with_project();
        let cookie = host.pair_device(&signing_key(33)).await.0;
        let tab_id = fixture_tab_id(&host, &cookie).await;
        let list = format!("/api/v1/tabs/{tab_id}/outbox");

        // No outbox yet: an empty strip, not an error.
        let (status, _, body) = host.send(get_as(&list, &cookie)).await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        assert_eq!(json(&body)["files"], serde_json::json!([]));

        let png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR-body".to_vec();
        let dir = host.root.join(outbox::OUTBOX_DIR);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("plot.png"), &png).unwrap();
        std::fs::write(dir.join("notes.png"), b"not a picture at all").unwrap();

        let (status, _, body) = host.send(get_as(&list, &cookie)).await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        let images = json(&body)["files"].clone();
        assert_eq!(images.as_array().map(Vec::len), Some(2), "{body}");
        let image = images.as_array().unwrap().iter().find(|file| file["name"] == "plot.png").unwrap();
        assert_eq!(image["kind"], "image/png");
        assert_eq!(image["size"], png.len());
        assert!(image["modified"].as_u64().unwrap() > 0);
        assert!(!body.contains(RAW_PROJECT));
        assert!(!body.contains(host.root.to_str().unwrap()));

        // The bytes come back typed by their header, on the session cookie
        // alone — this is what an `<img>` on the PWA's origin sends.
        let (status, headers, body) = host
            .send(get_as(&format!("{list}/plot.png"), &cookie))
            .await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        assert_eq!(headers.get(header::CONTENT_TYPE).unwrap(), "image/png");
        assert_eq!(headers.get("x-content-type-options").unwrap(), "nosniff");
        // The fixture reads bodies as lossy UTF-8, which mangles the PNG's
        // 0x89; the declared length and the tail prove the bytes came through.
        assert_eq!(headers.get(header::CONTENT_LENGTH).unwrap(), png.len().to_string().as_str());
        assert!(body.ends_with("IHDR-body"), "{body:?}");

        std::fs::write(dir.join("archive.zip"), b"PK\0\x01").unwrap();
        std::fs::write(dir.join("20260930-101530-20260930-101010-deck.zip"), b"PK\0\x01").unwrap();
        for (name, kind, disposition) in [
            ("notes.png", "text/plain; charset=utf-8", "inline"),
            ("plot.png?download=1", "image/png", "attachment; filename=\"plot.png\""),
            ("archive.zip", "application/octet-stream", "attachment; filename=\"archive.zip\""),
            ("20260930-101530-20260930-101010-deck.zip", "application/octet-stream", "attachment; filename=\"deck.zip\""),
        ] {
            let (status, headers, _) = host.send(get_as(&format!("{list}/{name}"), &cookie)).await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(headers.get(header::CONTENT_TYPE).unwrap(), kind);
            assert_eq!(headers.get(header::CONTENT_DISPOSITION).unwrap(), disposition);
        }

        // Not an image by its bytes, a traversal, an unlisted name: all one
        // answer, so the phone cannot probe the tree by its error codes.
        for refused in ["..%2F..%2Fproject.json", "gone.png", ".hidden.png"] {
            let (status, _, body) = host
                .send(get_as(&format!("{list}/{refused}"), &cookie))
                .await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{refused} answered: {body}");
            assert_eq!(json(&body)["error"], "file_not_found");
        }

        let (status, _, body) = host
            .send(get_as("/api/v1/tabs/not-a-tab/outbox", &cookie))
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "answered: {body}");
        let (status, _, _) = host
            .send(get_as("/api/v1/tabs/not-a-tab/outbox/plot.png", &cookie))
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _, _) = host
            .send(get_as(&format!("{list}/plot.png"), "not-a-session"))
            .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn the_inbox_reads_back_what_the_phone_sent_by_leaf_only() {
        let host = Fixture::with_project();
        let cookie = host.pair_device(&signing_key(34)).await.0;
        let tab_id = fixture_tab_id(&host, &cookie).await;
        let base = format!("/api/v1/tabs/{tab_id}/inbox");

        let (status, _, body) = host.send(get_as(&format!("{base}?names=a.png"), &cookie)).await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        assert_eq!(json(&body)["files"], serde_json::json!([]));

        let png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR-body".to_vec();
        let photo = inbox::store(&host.root, "photo.png", &png).unwrap();
        let note = inbox::store(&host.root, "note.txt", b"hello").unwrap();
        let (status, _, body) = host
            .send(get_as(&format!("{base}?names={},gone.png,..%2Fx,{}", photo.name, note.name), &cookie))
            .await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        let files = json(&body)["files"].clone();
        let kinds: Vec<_> = files.as_array().unwrap().iter().map(|f| (f["name"].as_str().unwrap().to_string(), f["kind"].as_str().unwrap().to_string(), f["original"].as_str().unwrap().to_string())).collect();
        assert_eq!(kinds, vec![
            (photo.name.clone(), "image/png".to_string(), "photo.png".to_string()),
            (note.name.clone(), "text/plain; charset=utf-8".to_string(), "note.txt".to_string()),
        ]);
        assert!(!body.contains(host.root.to_str().unwrap()));

        let (status, headers, body) = host.send(get_as(&format!("{base}/{}", photo.name), &cookie)).await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        assert_eq!(headers.get(header::CONTENT_TYPE).unwrap(), "image/png");
        assert_eq!(headers.get(header::CONTENT_DISPOSITION).unwrap(), "inline");
        assert!(body.ends_with("IHDR-body"), "{body:?}");

        for refused in ["..%2F..%2Fproject.json", "gone.png", ".hidden.png"] {
            let (status, _, body) = host.send(get_as(&format!("{base}/{refused}"), &cookie)).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{refused} answered: {body}");
            assert_eq!(json(&body)["error"], "file_not_found");
        }
        let (status, _, _) = host.send(get_as("/api/v1/tabs/not-a-tab/inbox?names=a.png", &cookie)).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _, _) = host.send(get_as(&format!("{base}/{}", photo.name), "not-a-session")).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn the_outbox_answers_by_the_project_too_for_the_screen_that_has_no_tab() {
        let host = Fixture::with_project();
        let cookie = host.pair_device(&signing_key(34)).await.0;
        let (_, _, body) = host
            .send(get_as("/api/v1/projects?view=search&q=aurora", &cookie))
            .await;
        let project_id = json(&body)["projects"][0]["id"]
            .as_str()
            .expect("opaque project id")
            .to_string();
        let list = format!("/api/v1/projects/{project_id}/outbox");

        // No outbox yet: an empty shelf, not an error — as by the tab.
        let (status, _, body) = host.send(get_as(&list, &cookie)).await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        assert_eq!(json(&body)["files"], serde_json::json!([]));

        let png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR-body".to_vec();
        let dir = host.root.join(outbox::OUTBOX_DIR);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("plot.png"), &png).unwrap();

        let (status, _, body) = host.send(get_as(&list, &cookie)).await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        assert_eq!(json(&body)["files"][0]["name"], "plot.png");
        assert_eq!(json(&body)["files"][0]["kind"], "image/png");
        assert!(!body.contains(RAW_PROJECT));
        assert!(!body.contains(host.root.to_str().unwrap()));

        let (status, headers, body) = host
            .send(get_as(&format!("{list}/plot.png"), &cookie))
            .await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        assert_eq!(headers.get(header::CONTENT_TYPE).unwrap(), "image/png");
        assert_eq!(
            headers.get(header::CONTENT_LENGTH).unwrap(),
            png.len().to_string().as_str()
        );
        let (_, headers, _) = host
            .send(get_as(&format!("{list}/plot.png?download=1"), &cookie))
            .await;
        assert_eq!(
            headers.get(header::CONTENT_DISPOSITION).unwrap(),
            "attachment; filename=\"plot.png\""
        );

        // Traversal and unlisted names read the same here as by the tab, and an
        // unknown project is not a way to learn which ids exist.
        for refused in ["..%2F..%2Fproject.json", "gone.png"] {
            let (status, _, body) = host
                .send(get_as(&format!("{list}/{refused}"), &cookie))
                .await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{refused} answered: {body}");
            assert_eq!(json(&body)["error"], "file_not_found");
        }
        let (status, _, body) = host
            .send(get_as("/api/v1/projects/not-a-project/outbox", &cookie))
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "answered: {body}");
        assert_eq!(json(&body)["error"], "project_not_found");
        let (status, _, _) = host
            .send(get_as("/api/v1/projects/not-a-project/outbox/plot.png", &cookie))
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _, _) = host.send(get_as(&list, "not-a-session")).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn the_file_browser_is_off_by_default_and_reads_by_sealed_token_only() {
        let host = Fixture::with_project();
        let cookie = host.pair_device(&signing_key(35)).await.0;
        let (_, _, body) = host
            .send(get_as("/api/v1/projects?view=search&q=aurora", &cookie))
            .await;
        let project_id = json(&body)["projects"][0]["id"]
            .as_str()
            .expect("opaque project id")
            .to_string();
        let base = format!("/api/v1/projects/{project_id}/files");
        std::fs::create_dir_all(host.root.join("src")).unwrap();
        std::fs::write(host.root.join("src/main.rs"), "fn main() {}\n").unwrap();
        std::fs::write(host.root.join(".env"), "HIDDEN=1").unwrap();

        // The switch is off: the detail says so and both routes are closed.
        let (_, _, body) = host.send(get_as(&format!("/api/v1/projects/{project_id}"), &cookie)).await;
        assert_eq!(json(&body)["files"], false);
        let (status, _, body) = host.send(get_as(&base, &cookie)).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "answered: {body}");
        assert_eq!(json(&body)["error"], "files_off");

        std::fs::write(
            host.state.config.state_dir.join("settings.json"),
            serde_json::json!({ concat!(crate::app_slug!(), "_mobile_host"): { "enabled": true, "project_files": true } }).to_string(),
        )
        .unwrap();
        let (_, _, body) = host.send(get_as(&format!("/api/v1/projects/{project_id}"), &cookie)).await;
        assert_eq!(json(&body)["files"], true);

        let (status, _, body) = host.send(get_as(&base, &cookie)).await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        let root = json(&body);
        assert_eq!(root["entries"][0]["name"], "src");
        assert_eq!(root["entries"][0]["kind"], "dir");
        assert!(!body.contains(".env"), "hidden names are not listed: {body}");
        assert!(!body.contains(RAW_PROJECT));
        assert!(!body.contains(host.root.to_str().unwrap()));
        let src = root["entries"][0]["token"].as_str().unwrap().to_string();

        let (status, _, body) = host.send(get_as(&format!("{base}?dir={src}"), &cookie)).await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        assert!(!body.contains("src/"), "no path in the answer: {body}");
        let file = json(&body)["entries"][0].clone();
        assert_eq!(file["name"], "main.rs");
        let token = file["token"].as_str().unwrap().to_string();

        let (status, headers, body) = host.send(get_as(&format!("{base}/raw?f={token}"), &cookie)).await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        assert_eq!(body, "fn main() {}\n");
        assert_eq!(headers.get(header::CONTENT_TYPE).unwrap(), "text/plain; charset=utf-8");
        assert_eq!(headers.get(header::CONTENT_DISPOSITION).unwrap(), "inline");
        let (_, headers, _) = host.send(get_as(&format!("{base}/raw?f={token}&download=1"), &cookie)).await;
        assert_eq!(
            headers.get(header::CONTENT_DISPOSITION).unwrap(),
            "attachment; filename=\"main.rs\"; filename*=UTF-8''main.rs"
        );

        // A folder's token is not a file, a forged token is not a path, and
        // there is nothing to write with.
        for refused in [format!("{base}/raw?f={src}"), format!("{base}/raw?f=AAAA"), format!("{base}/raw"), format!("{base}?dir=AAAA")] {
            let (status, _, body) = host.send(get_as(&refused, &cookie)).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{refused} answered: {body}");
            assert_eq!(json(&body)["error"], "file_not_found");
        }
        let (status, _, _) = host.send(get_as(&base, "not-a-session")).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, _, _) = host.send(get_as("/api/v1/projects/not-a-project/files", &cookie)).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn only_the_pdf_frame_may_be_framed_and_only_by_the_pwa() {
        let host = Fixture::bare();
        let request = Request::builder()
            .uri(PDF_FRAME_PATH)
            .header(header::HOST, "phone.example.ts.net")
            .body(Body::empty())
            .unwrap();
        let (status, headers, _) = host.send(request).await;
        if status == StatusCode::OK {
            assert_eq!(headers[header::X_FRAME_OPTIONS], "SAMEORIGIN");
            let policy = headers[header::CONTENT_SECURITY_POLICY].to_str().unwrap().to_string();
            assert!(policy.contains("default-src 'none'"), "{policy}");
            assert!(policy.contains("connect-src 'none'"), "{policy}");
            assert!(policy.contains("frame-ancestors 'self' https://phone.example.ts.net"), "{policy}");
            assert!(!policy.contains("wasm-unsafe-eval") && !policy.contains("unsafe-eval"), "{policy}");
        } else {
            // A bundle built without the frame: a plain miss, never the shell
            // under a framable policy.
            assert_eq!(status, StatusCode::NOT_FOUND);
            assert_eq!(headers[header::X_FRAME_OPTIONS], "DENY");
        }
        for uri in ["/", "/index.html", "/pdf-frame.html/x", "/assets/pdf-frame.js", "/api/v1/status"] {
            let (_, headers, _) = host.send(get_request(uri)).await;
            assert_eq!(headers[header::X_FRAME_OPTIONS], "DENY", "{uri}");
            assert!(headers[header::CONTENT_SECURITY_POLICY].to_str().unwrap().contains("frame-ancestors 'none'"), "{uri}");
        }
        // A host header that is not a host name is left out of the policy.
        let forged = HeaderValue::from_static("evil.example; script-src *");
        assert!(!pdf_frame_policy(Some(&forged)).contains("evil"));
        assert!(pdf_frame_policy(None).contains("script-src 'self';"));
    }

    #[tokio::test]
    async fn a_markup_submit_bakes_a_copy_into_the_inbox_and_answers_a_prompt() {
        let host = Fixture::with_project();
        let cookie = host.pair_device(&signing_key(63)).await.0;
        let tab_id = fixture_tab_id(&host, &cookie).await;
        let (_, _, body) = host.send(get_as("/api/v1/projects?view=search&q=aurora", &cookie)).await;
        let project_id = json(&body)["projects"][0]["id"].as_str().unwrap().to_string();
        std::fs::create_dir_all(host.root.join("docs")).unwrap();
        let pdf = super::super::markup_pdf::tests::classic_pdf(&[0, 90], false);
        std::fs::write(host.root.join("docs/draft.pdf"), &pdf).unwrap();
        let before = std::fs::metadata(host.root.join("docs/draft.pdf")).unwrap().modified().unwrap();
        let png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR-layer".to_vec();
        let (status, _, body) = host.send(inbox_request(&tab_id, "draft-p2-layer.png", &cookie, png)).await;
        assert_eq!(status, StatusCode::CREATED, "answered: {body}");
        let layer = json(&body)["attachment"]["reference"].as_str().unwrap().to_string();
        let submit = |origin: &str, body: Vec<u8>| {
            Request::builder()
                .method("POST")
                .uri(format!("/api/v1/tabs/{tab_id}/markup"))
                .header(header::ORIGIN, origin)
                .header(header::COOKIE, cookie_pair(&cookie))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body))
                .unwrap()
        };
        let marks = serde_json::json!([{ "kind": "ink", "color": "red", "width": 2, "points": [[10, 10, 0.5], [40, 30, 0.7]] },
            { "kind": "text", "color": "blue", "at": [20, 50], "size": 14, "text": "smaller" }]);
        let request_for = |source: Value| serde_json::to_vec(&serde_json::json!({
            "source": source,
            "pages": [{ "n": 2, "size": [800, 600], "layer": layer, "marks": marks }],
        })).unwrap();

        // The file browser's switch gates a file source, as it gates reading.
        let (status, _, body) = host.send(submit(ORIGIN, request_for(serde_json::json!({ "files": "AAAA" })))).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "answered: {body}");
        assert_eq!(json(&body)["error"], "files_off");
        std::fs::write(
            host.state.config.state_dir.join("settings.json"),
            serde_json::json!({ concat!(crate::app_slug!(), "_mobile_host"): { "enabled": true, "project_files": true } }).to_string(),
        )
        .unwrap();
        let (_, _, body) = host.send(get_as(&format!("/api/v1/projects/{project_id}/files"), &cookie)).await;
        let docs = json(&body)["entries"].as_array().unwrap().iter()
            .find(|entry| entry["name"] == "docs").unwrap()["token"].as_str().unwrap().to_string();
        let (_, _, body) = host.send(get_as(&format!("/api/v1/projects/{project_id}/files?dir={docs}"), &cookie)).await;
        let token = json(&body)["entries"][0]["token"].as_str().unwrap().to_string();

        let (status, _, body) = host.send(submit(ORIGIN, request_for(serde_json::json!({ "files": token })))).await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        let answer = json(&body);
        let prompt = answer["prompt"].as_str().unwrap();
        let marked = answer["marked"].as_str().unwrap();
        assert!(prompt.starts_with("I marked these changes by hand on `docs/draft.pdf`."), "{prompt}");
        assert!(prompt.contains(&format!("Page 2: @{layer}")), "{prompt}");
        assert!(prompt.contains("- p2: \"smaller\""), "{prompt}");
        assert!(marked.starts_with(concat!(".", crate::app_slug!(), "/inbox/")) && marked.ends_with("-draft-marked.pdf"), "{marked}");
        assert!(!body.contains(&host.root.to_string_lossy().to_string()), "a filesystem path leaked: {body}");
        let copy = std::fs::read(host.root.join(marked)).unwrap();
        assert!(copy.starts_with(&pdf) && copy.len() > pdf.len());
        assert_eq!(std::fs::read(host.root.join("docs/draft.pdf")).unwrap(), pdf, "the source is never written");
        assert_eq!(std::fs::metadata(host.root.join("docs/draft.pdf")).unwrap().modified().unwrap(), before);

        // A forged token, an outbox leaf with a separator, a bad origin and an
        // oversized body are all refused before anything is written.
        let (status, _, body) = host.send(submit(ORIGIN, request_for(serde_json::json!({ "files": "AAAA" })))).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "answered: {body}");
        assert_eq!(json(&body)["error"], "file_not_found");
        for leaf in ["../draft.pdf", "a/b.pdf", ".hidden.pdf"] {
            let (status, _, body) = host.send(submit(ORIGIN, request_for(serde_json::json!({ "outbox": leaf })))).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{leaf} answered: {body}");
            assert_eq!(json(&body)["error"], "invalid_markup");
        }
        let (status, ..) = host.send(submit("https://elsewhere.example", request_for(serde_json::json!({ "files": token })))).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, ..) = host.send(submit(ORIGIN, vec![b' '; markup::MAX_MARKUP_BODY + 1])).await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
        let (status, _, body) = host.send(submit(ORIGIN, b"{\"source\":1}".to_vec())).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "answered: {body}");
        let inbox: Vec<_> = std::fs::read_dir(host.root.join(inbox::INBOX_DIR)).unwrap().flatten().collect();
        assert_eq!(inbox.len(), 2, "the layer and one marked copy");
    }

    /// The markup questions routes: with no window, a quiet
    /// `desktop_unavailable` (the phone shows no card); with one, the view's
    /// source goes to the desktop as a project-relative path, the asks come
    /// back with a bare leaf name and nothing else of the path, and an answer
    /// crosses as indices and typed text only — shaped here before it goes.
    #[cfg(unix)]
    #[tokio::test]
    async fn markup_questions_cross_as_leaf_names_and_answers_as_indices() {
        let host = Fixture::with_project();
        let cookie = host.pair_device(&signing_key(64)).await.0;
        let (_, tab_id) = project_and_tab(&host, &cookie).await;
        let questions = format!("/api/v1/tabs/{tab_id}/markup/questions");
        let answer_uri = format!("/api/v1/tabs/{tab_id}/markup/answer");
        let dismiss_uri = format!("/api/v1/tabs/{tab_id}/markup/dismiss");
        let ask = "ask-0123456789abcdef";
        let good = json!({ "ask_id": ask, "answers": [{ "options": [1] }, { "options": [0, 2], "other": "both" }] });

        // No window: no asks to read, nothing to answer.
        let (status, _, body) = host.send(get_as(&questions, &cookie)).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "answered: {body}");
        assert_eq!(json(&body)["error"], "desktop_unavailable");
        let (status, _, body) = host.send(request_as("POST", &answer_uri, &cookie, Some(good.clone()))).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "answered: {body}");

        // Refused before the desktop is asked.
        let outbox_leaf = "20261003-101500-draft.pdf";
        for (uri, code) in [
            (format!("{questions}?source=elsewhere:x"), "invalid_source"),
            (format!("{questions}?source=outbox:..%2Fdraft.pdf"), "invalid_source"),
            (format!("{questions}?source=files:"), "invalid_source"),
            (format!("{questions}?source=files:AAAA"), "files_off"),
        ] {
            let (status, _, body) = host.send(get_as(&uri, &cookie)).await;
            assert!(status.is_client_error(), "{uri} answered {status}: {body}");
            assert_eq!(json(&body)["error"], code, "{uri}");
        }
        for (bad, code) in [
            (json!({ "ask_id": "held-1", "answers": [{ "options": [0] }] }), "invalid_request"),
            (json!({ "ask_id": ask, "answers": [{ "options": [0] }], "prompt": "typed here" }), "invalid_request"),
            (json!({ "ask_id": ask, "answers": [] }), "invalid_answer"),
            (json!({ "ask_id": ask, "answers": [{ "options": [6] }] }), "invalid_answer"),
            (json!({ "ask_id": ask, "answers": [{ "options": [], "other": "a\nb" }] }), "invalid_answer"),
            (json!({ "ask_id": ask, "answers": [{ "other": "x".repeat(501) }] }), "invalid_answer"),
            (json!({ "ask_id": ask, "answers": vec![json!({ "options": [0] }); 5] }), "invalid_answer"),
        ] {
            let (status, _, body) = host.send(request_as("POST", &answer_uri, &cookie, Some(bad.clone()))).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{bad} answered: {body}");
            assert_eq!(json(&body)["error"], code, "{bad}");
        }
        let mut foreign = request_as("POST", &answer_uri, &cookie, Some(good.clone()));
        foreign.headers_mut().insert(header::ORIGIN, HeaderValue::from_static("https://elsewhere.example"));
        let (status, ..) = host.send(foreign).await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        let socket = host.state.config.control_dir.join("desktop-control.sock");
        let listener = tokio::net::UnixListener::bind(&socket).expect("bind");
        let seen: Arc<Mutex<Vec<DesktopRequest>>> = Arc::default();
        let log = seen.clone();
        let desktop = tokio::spawn(async move {
            let mut answered = 0;
            while answered < 6 {
                let (mut stream, _) = listener.accept().await.expect("accept");
                // A reachability probe connects and sends nothing.
                let Ok(request) = admin::read_frame::<DesktopRequest>(&mut stream).await else {
                    continue;
                };
                let response: DesktopResponse = match &request {
                    DesktopRequest::MarkupQuestions { .. } => serde_json::from_value(json!({
                        "status": "markup_questions",
                        "asks": [
                            { "id": ask, "path": "docs/paper/draft.pdf", "file_name": "docs/paper/20261003-101500-draft.pdf",
                              "questions": [{ "question": "Figure or paragraph?", "options": [{ "label": "Figure" }, { "label": "Paragraph" }], "page": 2, "quote": "Figure 2" }] },
                            { "id": "not-an-ask-id", "questions": [] },
                        ],
                    }))
                    .expect("asks"),
                    DesktopRequest::MarkupAnswer { .. } if answered == 3 => DesktopResponse::Error { code: "superseded".into(), message: "replaced".into() },
                    DesktopRequest::MarkupAnswer { .. } | DesktopRequest::MarkupDismiss { .. } => DesktopResponse::Seen,
                    other => panic!("unexpected request {other:?}"),
                };
                log.lock().unwrap().push(request);
                admin::write_frame(&mut stream, &response).await.expect("answer");
                answered += 1;
            }
        });

        let (status, _, body) = host.send(get_as(&format!("{questions}?source=outbox:{outbox_leaf}"), &cookie)).await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        let asks = json(&body)["asks"].clone();
        assert_eq!(asks.as_array().unwrap().len(), 1, "the malformed id is dropped: {body}");
        assert_eq!(asks[0]["file_name"], "draft.pdf");
        assert_eq!(asks[0]["questions"][0]["page"], 2);
        assert!(!body.contains("docs/") && !body.contains("\"file\"") && !body.contains(RAW_PROJECT), "{body}");
        // The Focus banner, drawer off: no row, and still no path.
        let (status, _, body) = host.send(get_as(&questions, &cookie)).await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        assert!(json(&body)["asks"][0].get("file_row").is_none(), "{body}");
        assert!(!body.contains("docs/") && !body.contains("\"path\""), "{body}");

        let (status, _, body) = host.send(request_as("POST", &answer_uri, &cookie, Some(good.clone()))).await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        assert_eq!(json(&body)["answered"], true);
        let (status, _, body) = host.send(request_as("POST", &answer_uri, &cookie, Some(good))).await;
        assert_eq!(status, StatusCode::CONFLICT, "answered: {body}");
        assert_eq!(json(&body)["error"], "superseded");
        let (status, _, body) = host.send(request_as("POST", &dismiss_uri, &cookie, Some(json!({ "ask_id": ask })))).await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        assert_eq!(json(&body)["dismissed"], true);

        // Drawer on, the file there: the banner gets its sealed row — the
        // folder trail and tokens, never the path or the root.
        std::fs::create_dir_all(host.root.join("docs/paper")).unwrap();
        std::fs::write(host.root.join("docs/paper/draft.pdf"), b"%PDF-1.4\n%%EOF\n").unwrap();
        std::fs::write(
            host.state.config.state_dir.join("settings.json"),
            serde_json::json!({ concat!(crate::app_slug!(), "_mobile_host"): { "enabled": true, "project_files": true } }).to_string(),
        )
        .unwrap();
        let (status, _, body) = host.send(get_as(&questions, &cookie)).await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        let file = json(&body)["asks"][0]["file_row"].clone();
        assert_eq!(file["name"], "draft.pdf", "{body}");
        assert_eq!(file["place"], "docs/paper");
        assert_eq!(file["kind"], "application/pdf");
        let key = host.state.auth.lock().unwrap().host_key().to_vec();
        assert_eq!(files::unseal(&key, RAW_PROJECT, file["token"].as_str().unwrap()).as_deref(), Some("docs/paper/draft.pdf"));
        assert_eq!(files::unseal(&key, RAW_PROJECT, file["folder"].as_str().unwrap()).as_deref(), Some("docs/paper"));
        assert!(!body.contains("\"path\"") && !body.contains(RAW_PROJECT) && !body.contains(host.root.to_str().unwrap()), "{body}");
        desktop.await.expect("fake desktop");

        let seen = seen.lock().unwrap();
        let DesktopRequest::MarkupQuestions { project_id, path, .. } = &seen[0] else { panic!("{:?}", seen[0]) };
        assert_eq!(project_id, RAW_PROJECT);
        assert_eq!(path.as_deref(), Some(format!("{}/{outbox_leaf}", outbox::OUTBOX_DIR).as_str()));
        assert!(matches!(&seen[1], DesktopRequest::MarkupQuestions { path: None, .. }));
        let DesktopRequest::MarkupAnswer { ask_id, answers, .. } = &seen[2] else { panic!("{:?}", seen[2]) };
        assert_eq!(ask_id, ask);
        assert_eq!(answers[1].options, vec![0, 2]);
        assert_eq!(answers[1].other.as_deref(), Some("both"));
        assert!(matches!(&seen[4], DesktopRequest::MarkupDismiss { .. }));
    }

    /// The browser's own PDF viewer fetches without the strict session cookie;
    /// a ticket minted over the session opens that one URL and nothing else.
    #[tokio::test]
    async fn an_open_ticket_reads_its_one_file_without_the_cookie() {
        let host = Fixture::with_project();
        let cookie = host.pair_device(&signing_key(36)).await.0;
        let (_, _, body) = host
            .send(get_as("/api/v1/projects?view=search&q=aurora", &cookie))
            .await;
        let project_id = json(&body)["projects"][0]["id"].as_str().unwrap().to_string();
        let base = format!("/api/v1/projects/{project_id}/files");
        std::fs::write(host.root.join("paper.pdf"), "%PDF-1.7\n%%EOF\n").unwrap();
        std::fs::write(host.root.join("other.pdf"), "%PDF-1.7\n%%EOF\n").unwrap();
        std::fs::write(
            host.state.config.state_dir.join("settings.json"),
            serde_json::json!({ concat!(crate::app_slug!(), "_mobile_host"): { "enabled": true, "project_files": true } }).to_string(),
        )
        .unwrap();
        let (_, _, body) = host.send(get_as(&base, &cookie)).await;
        let token_of = |name: &str| {
            json(&body)["entries"].as_array().unwrap().iter()
                .find(|entry| entry["name"] == name).unwrap()["token"].as_str().unwrap().to_string()
        };
        let (paper, other) = (token_of("paper.pdf"), token_of("other.pdf"));
        let url = format!("{base}/raw?f={paper}");
        let mint = |origin: &str, cookie: &str, url: &str| Request::builder()
            .method("POST")
            .uri("/api/v1/open-ticket")
            .header(header::ORIGIN, origin)
            .header(header::COOKIE, cookie_pair(cookie))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::json!({ "url": url }).to_string()))
            .unwrap();

        let (status, _, body) = host.send(mint(ORIGIN, &cookie, &url)).await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        let opened = json(&body)["url"].as_str().unwrap().to_string();
        assert!(opened.starts_with(&format!("{url}&ticket=")), "{opened}");
        let anonymous = |uri: &str| Request::builder().uri(uri).body(Body::empty()).unwrap();
        let (status, headers, body) = host.send(anonymous(&opened)).await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        assert_eq!(headers.get(header::CONTENT_TYPE).unwrap(), "application/pdf");
        let (status, _, _) = host.send(anonymous(&format!("{opened}&download=1"))).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "the ticket names the exact URL");
        let ticket = opened.rsplit("ticket=").next().unwrap();
        let (status, _, _) = host.send(anonymous(&format!("{base}/raw?f={other}&ticket={ticket}"))).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "not another file");
        let (status, _, _) = host.send(anonymous(&format!("{base}?ticket={ticket}"))).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "not the listing");

        // Minting needs the session and the exact origin, and only for the API.
        let (status, _, _) = host.send(mint(ORIGIN, "not-a-session", &url)).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, _, _) = host.send(mint("https://evil.example", &cookie, &url)).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        for refused in ["https://evil.example/api/v1/x", "/index.html"] {
            let (status, _, _) = host.send(mint(ORIGIN, &cookie, refused)).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
        }
    }

    #[tokio::test]
    async fn a_phone_file_lands_in_the_project_inbox_and_only_a_relative_reference_returns() {
        let host = Fixture::with_project();
        let cookie = host.pair_device(&signing_key(43)).await.0;
        let tab_id = fixture_tab_id(&host, &cookie).await;

        // Larger than a control message: the inbox route has its own limit.
        let bytes = vec![0xAB; MAX_CONTROL_MESSAGE * 4];
        let (status, _, body) = host
            .send(inbox_request(&tab_id, "IMG_0042.jpg", &cookie, bytes.clone()))
            .await;
        assert_eq!(status, StatusCode::CREATED, "answered: {body}");
        let attachment = &json(&body)["attachment"];
        let reference = attachment["reference"].as_str().expect("reference");
        assert!(reference.starts_with(concat!(".", crate::app_slug!(), "/inbox/")), "{reference}");
        assert!(reference.ends_with("-IMG_0042.jpg"), "{reference}");
        assert_eq!(attachment["size"], bytes.len());
        assert!(
            !body.contains(&host.root.to_string_lossy().to_string()),
            "a filesystem path leaked: {body}"
        );
        assert_eq!(std::fs::read(host.root.join(reference)).unwrap(), bytes);
    }

    #[tokio::test]
    async fn an_inbox_upload_is_bounded_and_scoped_to_a_known_tab() {
        let host = Fixture::with_project();
        let cookie = host.pair_device(&signing_key(47)).await.0;
        let tab_id = fixture_tab_id(&host, &cookie).await;

        let (status, ..) = host
            .send(inbox_request(&tab_id, "huge.bin", &cookie, vec![0; inbox::MAX_INBOX_FILE + 1]))
            .await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);

        let (status, _, body) = host
            .send(inbox_request(&tab_id, "empty.txt", &cookie, vec![]))
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "answered: {body}");
        assert_eq!(json(&body)["error"], "empty_file");

        let (status, _, body) = host
            .send(inbox_request("not-a-tab", "a.txt", &cookie, b"x".to_vec()))
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "answered: {body}");

        // Wrong origin: refused before anything is written.
        let request = Request::builder()
            .method("POST")
            .uri(format!("/api/v1/tabs/{tab_id}/inbox?name=a.txt"))
            .header(header::ORIGIN, "https://elsewhere.example")
            .header(header::COOKIE, cookie_pair(&cookie))
            .body(Body::from(b"x".to_vec()))
            .expect("request");
        let (status, ..) = host.send(request).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(!host.root.join(inbox::INBOX_DIR).exists(), "a refused upload wrote to disk");
    }

    #[tokio::test]
    async fn a_file_sent_from_the_project_screen_lands_in_that_projects_inbox() {
        let host = Fixture::with_project();
        let cookie = host.pair_device(&signing_key(61)).await.0;
        let (_, _, projects_body) = host.send(get_as("/api/v1/projects", &cookie)).await;
        let project_id = json(&projects_body)["projects"][0]["id"]
            .as_str()
            .expect("opaque project id")
            .to_string();
        let send = |project: &str, origin: &str, bytes: Vec<u8>| {
            Request::builder()
                .method("POST")
                .uri(format!("/api/v1/projects/{project}/inbox?name=notes.pdf"))
                .header(header::ORIGIN, origin)
                .header(header::COOKIE, cookie_pair(&cookie))
                .body(Body::from(bytes))
                .expect("request")
        };

        // Wrong origin: refused before anything is written.
        let (status, ..) = host
            .send(send(&project_id, "https://elsewhere.example", b"x".to_vec()))
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(!host.root.join(inbox::INBOX_DIR).exists(), "a refused upload wrote to disk");

        let (status, _, body) = host.send(send("not-a-project", ORIGIN, b"x".to_vec())).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "answered: {body}");

        // Larger than a control message: the route carries the inbox's limit.
        let bytes = vec![0xEF; MAX_CONTROL_MESSAGE * 4];
        let (status, _, body) = host.send(send(&project_id, ORIGIN, bytes.clone())).await;
        assert_eq!(status, StatusCode::CREATED, "answered: {body}");
        let reference = json(&body)["attachment"]["reference"]
            .as_str()
            .expect("reference")
            .to_string();
        assert!(reference.starts_with(concat!(".", crate::app_slug!(), "/inbox/")), "{reference}");
        assert!(reference.ends_with("-notes.pdf"), "{reference}");
        assert!(
            !body.contains(&host.root.to_string_lossy().to_string()),
            "a filesystem path leaked: {body}"
        );
        assert_eq!(std::fs::read(host.root.join(&reference)).unwrap(), bytes);

        let (status, ..) = host
            .send(send(&project_id, ORIGIN, vec![0; inbox::MAX_INBOX_FILE + 1]))
            .await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn a_file_sent_to_the_desktop_lands_in_the_global_inbox_not_a_project() {
        let host = Fixture::with_project();
        let cookie = host.pair_device(&signing_key(59)).await.0;
        let send = |name: &str, origin: &str, bytes: Vec<u8>| {
            Request::builder()
                .method("POST")
                .uri(format!("/api/v1/inbox?name={name}"))
                .header(header::ORIGIN, origin)
                .header(header::COOKIE, cookie_pair(&cookie))
                .body(Body::from(bytes))
                .expect("request")
        };
        let state_dir = host.state.config.state_dir.clone();
        let inbox_dir = state_dir.join(inbox::GLOBAL_INBOX_DIR);

        // Wrong origin: refused before anything is written.
        let (status, ..) = host.send(send("a.txt", "https://elsewhere.example", b"x".to_vec())).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(!inbox_dir.exists(), "a refused upload wrote to disk");

        let bytes = vec![0xCD; MAX_CONTROL_MESSAGE * 4];
        let (status, _, body) = host.send(send("ticket.pdf", ORIGIN, bytes.clone())).await;
        assert_eq!(status, StatusCode::CREATED, "answered: {body}");
        let name = json(&body)["file"]["name"].as_str().expect("name").to_string();
        assert!(name.ends_with("-ticket.pdf"), "{name}");
        assert!(json(&body)["file"].get("reference").is_none());
        assert!(!body.contains(&state_dir.to_string_lossy().to_string()), "a path leaked: {body}");
        assert_eq!(std::fs::read(inbox_dir.join(&name)).unwrap(), bytes);
        assert!(!host.root.join(inbox::INBOX_DIR).exists(), "a global file reached a project");

        let (status, _, body) = host.send(send("empty.txt", ORIGIN, vec![])).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(json(&body)["error"], "empty_file");
        let (status, ..) = host
            .send(send("huge.bin", ORIGIN, vec![0; inbox::MAX_INBOX_FILE + 1]))
            .await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn desktop_availability_is_what_answers_not_what_file_was_left_behind() {
        let host = Fixture::with_project();
        let cookie = host.pair_device(&signing_key(53)).await.0;
        let socket = host.state.config.control_dir.join("desktop-control.sock");

        // The file a desktop leaves when it exits — or crashes. `exists()` read
        // it as a desktop for as long as the desktop stayed closed.
        std::fs::write(&socket, b"").expect("stale socket file");
        let (status, _, body) = host.send(get_as("/api/v1/status", &cookie)).await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        assert_eq!(json(&body)["desktop_available"], false, "{body}");
        let (_, _, body) = host
            .send(get_as("/api/v1/projects?view=search&q=aurora", &cookie))
            .await;
        let opaque = json(&body)["projects"][0]["id"].as_str().unwrap().to_string();
        let (status, _, body) = host
            .send(get_as(&format!("/api/v1/projects/{opaque}"), &cookie))
            .await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        assert_eq!(json(&body)["desktop_available"], false, "{body}");
        assert!(!body.contains(RAW_PROJECT));

        // Something listening there is a desktop.
        std::fs::remove_file(&socket).expect("remove stale file");
        let listener = tokio::net::UnixListener::bind(&socket).expect("bind");
        let (status, _, body) = host.send(get_as("/api/v1/status", &cookie)).await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        assert_eq!(json(&body)["desktop_available"], true, "{body}");
        drop(listener);
    }

    #[tokio::test]
    async fn status_tracks_the_untested_tag_display_preference() {
        let host = Fixture::with_project();
        let cookie = host.pair_device(&signing_key(91)).await.0;
        let settings = host.state.config.state_dir.join("settings.json");

        let (status, _, body) = host.send(get_as("/api/v1/status", &cookie)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(json(&body)["show_untested_tags"], false);

        std::fs::write(&settings, br#"{"show_untested_tags":true}"#).expect("settings");
        let (status, _, body) = host.send(get_as("/api/v1/status", &cookie)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(json(&body)["show_untested_tags"], true);
    }

    #[tokio::test]
    async fn status_reports_the_desktop_theme_for_a_phone_that_follows_it() {
        let host = Fixture::with_project();
        let cookie = host.pair_device(&signing_key(92)).await.0;
        let settings = host.state.config.state_dir.join("settings.json");

        // Unset is the desktop's own default.
        let (_, _, body) = host.send(get_as("/api/v1/status", &cookie)).await;
        assert_eq!(json(&body)["color_scheme"], "light_lavender");

        std::fs::write(&settings, br#"{"color_scheme":"light_lavender"}"#).expect("settings");
        let (_, _, body) = host.send(get_as("/api/v1/status", &cookie)).await;
        assert_eq!(json(&body)["color_scheme"], "light_lavender");

        // Anything that is not a plain theme name never crosses.
        std::fs::write(&settings, br#"{"color_scheme":"<b>/etc/passwd</b>"}"#).expect("settings");
        let (_, _, body) = host.send(get_as("/api/v1/status", &cookie)).await;
        assert_eq!(json(&body)["color_scheme"], "light_lavender");
    }

    /// The desktop pill's git dot reaches the list row and the project screen
    /// under the opaque id; the desktop's raw id and any level the phone does
    /// not know stay behind.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_projects_git_dot_crosses_by_opaque_id_and_known_levels_only() {
        use crate::services::mobile_control::protocol::ProjectGitState;
        let host = Fixture::with_project();
        let cookie = host.pair_device(&signing_key(54)).await.0;
        let socket = host.state.config.control_dir.join("desktop-control.sock");
        let listener = tokio::net::UnixListener::bind(&socket).expect("bind");
        let desktop = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().await.expect("accept");
                let request: DesktopRequest = admin::read_frame(&mut stream).await.expect("request");
                let response = match request {
                    DesktopRequest::GitStates { .. } => DesktopResponse::GitStates {
                        states: vec![
                            ProjectGitState { project_id: RAW_PROJECT.into(), state: "unpushed".into() },
                            ProjectGitState { project_id: "not-listed".into(), state: "dirty".into() },
                        ],
                    },
                    DesktopRequest::Catalog { .. } => serde_json::from_value(json!({
                        "status": "catalog", "agents": [], "git": "a-level-from-the-future",
                    }))
                    .expect("catalog"),
                    other => panic!("unexpected request {other:?}"),
                };
                admin::write_frame(&mut stream, &response).await.expect("answer");
            }
        });

        let (status, _, body) = host.send(get_as("/api/v1/projects", &cookie)).await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        let row = &json(&body)["projects"][0];
        assert_eq!(row["git"], "unpushed", "{body}");
        assert!(!body.contains(RAW_PROJECT) && !body.contains("not-listed"), "{body}");

        let opaque = row["id"].as_str().unwrap().to_string();
        let (status, _, body) = host
            .send(get_as(&format!("/api/v1/projects/{opaque}"), &cookie))
            .await;
        assert_eq!(status, StatusCode::OK, "answered: {body}");
        assert!(json(&body)["project"].get("git").is_none(), "unknown level dropped: {body}");
        desktop.await.expect("fake desktop");
    }

    /// A write the desktop applied, whose refreshed list was too large to
    /// relay, reaches the phone under its own code on every list-answering
    /// write route. Not a 2xx: the body has no list, and a phone bundle that
    /// does not know the code must land in its error path rather than read a
    /// board out of nothing. Not a 503 either, which the phone reads as a
    /// closed desktop. The phone tells it from a failed write by the code and
    /// reloads through the read route (`reloadIfApplied` in `api.ts`).
    #[cfg(unix)]
    #[tokio::test]
    async fn an_applied_write_with_an_unrelayable_answer_keeps_its_own_code() {
        let host = Fixture::with_project();
        let cookie = host.pair_device(&signing_key(55)).await.0;
        let (_, _, body) = host.send(get_as("/api/v1/projects", &cookie)).await;
        let project = json(&body)["projects"][0]["id"].as_str().unwrap().to_string();
        let writes: Vec<(String, Value)> = vec![
            ("/api/v1/todo".into(), json!({ "type": "toggle", "task_id": "t1" })),
            ("/api/v1/alerts".into(), json!({ "alert_id": "row" })),
            (
                "/api/v1/calendar?month=2026-09".into(),
                json!({ "type": "delete_event", "event_id": "e1" }),
            ),
            (
                "/api/v1/mail/folders/f1/messages/m1/mark".into(),
                json!({ "action": "seen" }),
            ),
            (
                "/api/v1/mail/folders/f1/messages/m1/reply".into(),
                json!({ "body": "Thanks" }),
            ),
            (format!("/api/v1/projects/{project}/prompts"), json!({ "message": "Review" })),
        ];

        let socket = host.state.config.control_dir.join("desktop-control.sock");
        let listener = tokio::net::UnixListener::bind(&socket).expect("bind");
        let expected = writes.len();
        let desktop = tokio::spawn(async move {
            let mut answered = 0;
            while answered < expected {
                let (mut stream, _) = listener.accept().await.expect("accept");
                // A reachability probe connects and sends nothing.
                let Ok(request) = admin::read_frame::<DesktopRequest>(&mut stream).await else {
                    continue;
                };
                assert!(request.is_mutation(), "not a mutation: {request:?}");
                let response = DesktopResponse::Error {
                    code: admin::APPLIED_RESPONSE_TOO_LARGE.into(),
                    message: String::new(),
                };
                admin::write_frame(&mut stream, &response).await.expect("answer");
                answered += 1;
            }
        });

        for (uri, body) in &writes {
            let request = Request::builder()
                .method("POST")
                .uri(uri)
                .header(header::ORIGIN, ORIGIN)
                .header(header::COOKIE, cookie_pair(&cookie))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(serde_json::to_vec(body).expect("body")))
                .expect("request");
            let (status, _, answer) = host.send(request).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{uri} answered: {answer}");
            assert_eq!(
                json(&answer)["error"],
                admin::APPLIED_RESPONSE_TOO_LARGE,
                "{uri} answered: {answer}"
            );
        }
        desktop.await.expect("fake desktop");
    }
}

#[cfg(test)]
mod validator_tests {
    use super::{valid_calendar_month, valid_mail_id};

    /// The month path segment is exactly `YYYY-MM` with a real month number;
    /// anything looser would reach the desktop's calendar store unvalidated.
    #[test]
    fn a_calendar_month_is_exactly_yyyy_mm_with_a_real_month() {
        assert!(valid_calendar_month("2026-09"));
        assert!(valid_calendar_month("2026-01"));
        assert!(valid_calendar_month("2026-12"));
        assert!(!valid_calendar_month("2026-00"));
        assert!(!valid_calendar_month("2026-13"));
        assert!(!valid_calendar_month("2026-9"));
        assert!(!valid_calendar_month("2026/09"));
        assert!(!valid_calendar_month("2026-09-01"));
        assert!(!valid_calendar_month("202a-09"));
        assert!(!valid_calendar_month(""));
        assert!(!valid_calendar_month("２０２６-09"), "fullwidth digits are 3 bytes each");
    }

    /// A mail id is an opaque handle: bounded, ASCII, and never a path.
    #[test]
    fn a_mail_id_is_a_bounded_opaque_ascii_handle() {
        assert!(valid_mail_id("m_7f3-AbC"));
        assert!(valid_mail_id(&"a".repeat(128)));
        assert!(!valid_mail_id(&"a".repeat(129)));
        assert!(!valid_mail_id(""));
        assert!(!valid_mail_id("../etc"));
        assert!(!valid_mail_id("id with space"));
        assert!(!valid_mail_id("id.json"));
        assert!(!valid_mail_id("ünïcode"));
    }
}
