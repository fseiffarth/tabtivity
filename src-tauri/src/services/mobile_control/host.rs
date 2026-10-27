use std::{
    collections::HashMap,
    future::Future,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
    pin::Pin,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use app_core::sync::LockExt;

use axum::{
    body::{Body, Bytes},
    extract::{ws::WebSocketUpgrade, DefaultBodyLimit, Path, Query, State},
    http::{header, HeaderMap, HeaderValue, Request, Response, StatusCode, Uri},
    middleware::{self, Next},
    response::IntoResponse,
    routing::{delete, get, post, put},
    Json, Router,
};
use base64ct::{Base64UrlUnpadded, Encoding};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::commands::projects::PhoneProjectRefusal;
use crate::services::desktop_images;
use crate::services::markup_rounds;
use crate::terminal::PtyOptions;

use super::{
    admin,
    alarms,
    auth::AuthStore,
    chat_changes,
    chat_uncommitted,
    config::{verify_tailscale_serve, HostConfig},
    discovery::{shells_open, terminals_support, AgentCounts, Catalog, CatalogCache, PublicTab, ResolvedTab, ScopeKind, TabPrompt, TabSchedules},
    files,
    git_overview,
    headless,
    host_files,
    host_live,
    inbox,
    local_models,
    markup,
    outbox,
    limits,
    protocol::{
        clean_tab_color, git_dot, CalendarAction, CreateTabKind, CreateTabRequest, DesktopRequest, DesktopResponse,
        LocalModelAction, MailMarkAction, MobileCollectedPrompt, MobileMarkupFile, MobileMarkupTick, MobilePromptInput, MobileSchedule,
        MobileScheduleInput, PromptMutation, ScheduleMutation,
        TabPlace, TodoAction, MAX_CONTROL_MESSAGE, MAX_INPUT_FRAME, MAX_MAIL_REPLY_BYTES,
        MAX_TAB_LABEL,
    },
    pty_bridge::{self, TerminalRegistry},
    scheduler,
    uploads,
    push::{AgentTabRef, PushPrefs},
    sign_in,
    web_client, MOBILE_ASSETS,
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
    /// The browser desktop client (hosted plan §10 P2): its sessions, its
    /// connected clients as the core's event sink, and the `CoreCtx` its
    /// calls are dispatched with.
    web: web_client::WebClientState,
    /// The phone's git overviews, per project, for `git_overview::TTL`.
    git_overview: Arc<Mutex<git_overview::Cache>>,
    /// Each project's worktrees as its tab cards name them, for
    /// `git_overview::SPOT_TTL`.
    worktree_spots: Arc<Mutex<git_overview::SpotCache>>,
    /// The remote side of the 📁 library: one SFTP session per host over the
    /// desktop's master, while the phone browses (`host_files`).
    host_files: Arc<host_files::HostFiles>,
    /// Asks `host_live`'s refresher for a round now.
    host_kick: host_live::HostLiveKick,
}

/// The owner's spawn seam (headless owner plan, H1b): `launch` starts a
/// prepared tab detached under its tmux name, `installed` says which agent
/// CLIs the ＋ sheet may offer. Production is `launch_prep::prepare` plus
/// `tmux_local::spawn_detached_with` on the default tmux server — the same
/// launch assembly and the same server the window uses, so the window later
/// attaches to what the sidecar started — and the registry's install probe.
/// `new_project` makes a phone's new project
/// (`projects::create_project_for_phone`) from its name and the asking
/// phone's device id. A test swaps in a recorder.
#[derive(Clone)]
struct HeadlessSpawner {
    launch: headless::HeadlessLaunch,
    installed: Arc<dyn Fn(&str) -> bool + Send + Sync>,
    new_project: NewProject,
    /// What the desktop's own new-chat menu would offer the chat assistant
    /// (`commands::assistant::assistant_options`: the CLIs and their login,
    /// Ollama's models). The phone's launch ids are derived from it and
    /// resolved against it; a test swaps in a fixed answer.
    assistant_options: AssistantOptionsSeam,
}

type NewProject = Arc<dyn Fn(&str, &str) -> Result<String, PhoneProjectRefusal> + Send + Sync>;

type AssistantOptionsSeam = Arc<
    dyn Fn() -> Pin<Box<dyn Future<Output = Result<crate::commands::assistant::AssistantOptions, String>> + Send>>
        + Send
        + Sync,
>;

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
            installed: Arc::new(crate::services::agent_registry::binary_is_installed),
            new_project: Arc::new(crate::commands::projects::create_project_for_phone),
            assistant_options: Arc::new(|| Box::pin(crate::commands::assistant::assistant_options())),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PairBody {
    #[serde(default)]
    code: String,
    device_name: String,
    public_key: String,
    /// An identity provider's ID token in place of a code (a hosted server,
    /// routed here by the gateway's OIDC callback; plan P5).
    #[serde(default)]
    oidc_token: Option<String>,
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

/// `POST /projects/{id}/activate?tab=<tab id>`: the tab the phone is about to
/// open, so a scope that starts its chats lazily can start that one.
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct ActivateQuery {
    tab: Option<String>,
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

/// Whether the user switched AI off (`services::ai_switch`) — the same
/// `settings.json` the window writes.
fn ai_is_off(state: &HostState) -> bool {
    crate::services::ai_switch::is_off_at(&state.config.state_dir.join("settings.json"))
}

/// `403 ai_off` while AI is off, for a route that would type into an agent
/// or start a model.
fn ai_off_guard(state: &HostState) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    if ai_is_off(state) {
        Err(api_error(StatusCode::FORBIDDEN, crate::services::ai_switch::AI_OFF))
    } else {
        Ok(())
    }
}

fn exact_origin(headers: &HeaderMap, state: &HostState) -> bool {
    headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) == Some(state.config.origin.as_str())
}

fn cookie_token(headers: &HeaderMap) -> Option<&str> {
    session_cookie_in(&crate::brand::PAIR, headers.get(header::COOKIE)?.to_str().ok()?)
}

/// The phone store's session token in a request, for the browser transport
/// behind the gateway (`web_client::ServerLink`).
pub fn device_session_cookie(headers: &HeaderMap) -> Option<&str> {
    cookie_token(headers)
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

/// The paired phone a request comes from — the device behind its session
/// cookie or open ticket. Minted only by `authenticate`,
/// `authenticate_or_ticket` and `mutation_guard`, and the key to every
/// catalog read a phone route makes (`catalog`, `catalog_fresh`): a route
/// cannot look a scope up without saying whose request it is, so a scope
/// whose per-phone list leaves this phone out answers like an unknown id.
struct Phone(String);

impl Phone {
    fn device_id(&self) -> &str {
        &self.0
    }
}

fn authenticate(
    headers: &HeaderMap,
    state: &HostState,
) -> Result<Phone, (StatusCode, Json<serde_json::Value>)> {
    let token = cookie_token(headers)
        .ok_or_else(|| api_error(StatusCode::UNAUTHORIZED, "authentication_required"))?;
    state
        .auth
        .lock_ok()
        // Every authenticated request slides the session (`auth::SESSION_IDLE`).
        .touch(token)
        .map(Phone)
        .ok_or_else(|| api_error(StatusCode::UNAUTHORIZED, "authentication_required"))
}

/// `authenticate`, then refuse a phone the desktop keeps out of `section`
/// (`auth::HIDEABLE_SECTIONS`): every route of that section answers the same
/// 403, whatever it would have read or written.
fn section_guard(
    headers: &HeaderMap,
    state: &HostState,
    section: &str,
) -> Result<Phone, (StatusCode, Json<serde_json::Value>)> {
    let phone = authenticate(headers, state)?;
    if state
        .auth
        .lock_ok()
        .hides(phone.device_id(), section)
    {
        return Err(api_error(StatusCode::FORBIDDEN, "section_hidden"));
    }
    Ok(phone)
}

/// The section an alert row belongs to: a card is the board's, an event the
/// calendar's, a mail the mail's.
fn alert_section(kind: &str) -> Option<&'static str> {
    match kind {
        "task" => Some("todo"),
        "event" => Some("calendar"),
        "mail" => Some("mail"),
        _ => None,
    }
}

/// Drop the alert rows of the sections this phone is kept out of.
fn open_alerts(hidden: &[String], mut alerts: super::protocol::MobileAlertsSnapshot) -> super::protocol::MobileAlertsSnapshot {
    alerts
        .items
        .retain(|item| alert_section(&item.kind).is_none_or(|section| !hidden.iter().any(|h| h == section)));
    alerts
}

fn hidden_sections(state: &HostState, phone: &Phone) -> Vec<String> {
    state
        .auth
        .lock_ok()
        .hidden_sections(phone.device_id())
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
) -> Result<Phone, (StatusCode, Json<serde_json::Value>)> {
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
            .lock_ok()
            .redeem_ticket(ticket, &ticket_target(uri))
            .map(Phone)
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
    match state.auth.lock_ok().open_ticket(token, &target) {
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

/// The catalog as `phone` may see it: every scope whose per-phone list
/// leaves it out is gone (`Catalog::for_device`).
fn catalog(state: &HostState, phone: &Phone) -> Result<Catalog, (StatusCode, Json<serde_json::Value>)> {
    catalog_unfiltered(state).map(|catalog| catalog.for_device(phone.device_id()))
}

/// Every opted-in scope, whichever phones it is open to. Not for a phone's
/// request: only the agent-notice lookup (`agent_tab_ref`), which carries the
/// scope's list on to the push filter.
fn catalog_unfiltered(state: &HostState) -> Result<Catalog, (StatusCode, Json<serde_json::Value>)> {
    let key = state.auth.lock_ok().host_key().to_vec();
    off_worker(|| {
        state
            .catalog
            .lock_ok()
            .load(&state.config.state_dir, &key)
    })
    .map_err(|_| api_error(StatusCode::SERVICE_UNAVAILABLE, "catalog_unavailable"))
}

/// The create-tab poll is waiting for a tab the desktop has just been asked to
/// open, so by definition it is not in the cached snapshot yet.
fn catalog_fresh(state: &HostState, phone: &Phone) -> Result<Catalog, (StatusCode, Json<serde_json::Value>)> {
    let key = state.auth.lock_ok().host_key().to_vec();
    off_worker(|| {
        state
            .catalog
            .lock_ok()
            .load_fresh(&state.config.state_dir, &key)
    })
    .map(|catalog| catalog.for_device(phone.device_id()))
    .map_err(|_| api_error(StatusCode::SERVICE_UNAVAILABLE, "catalog_unavailable"))
}

/// The host key the desktop mints its opaque ids with — the same
/// `mobile-control/host.key` — so an id minted here resolves there.
fn host_key(state: &HostState) -> Vec<u8> {
    state.auth.lock_ok().host_key().to_vec()
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

use crate::clock::now_ms;

/// A tab edit applied to the session file because no window was open to
/// apply it to a store (headless owner plan, H3): the catalog is re-read so
/// the answer is the row as stored, as the desktop path answers it.
fn headless_tab_edit(
    state: &HostState,
    phone: &Phone,
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
            let row = catalog_fresh(state, phone)
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
    poke_desktop(&state.config.control_dir, raw_id, slices);
}

/// [`poke_window`] from where there is no `HostState`: the MCP listener's
/// notices (`docs/headless_mcp_plan.md`) — a schedule proposal a headless
/// tab made shows in an open window at once. Must run inside the runtime.
fn poke_desktop(control_dir: &std::path::Path, raw_id: Option<&str>, slices: &[&str]) {
    let socket = control_dir.join("desktop-control.sock");
    let request = DesktopRequest::Refresh {
        request_id: new_request_id(),
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
    if let Some(dot) = state.readings.lock_ok().git(raw_id, now) {
        return dot;
    }
    let dir = root.to_path_buf();
    let dot = tokio::task::spawn_blocking(move || headless::git_dot_for(&dir)).await.ok().flatten();
    state.readings.lock_ok().set_git(raw_id, dot, Instant::now());
    dot
}

/// A project's agent readings with no window, from the cache while fresh.
fn headless_readings(state: &HostState, project: &super::discovery::ResolvedProject) -> headless::TurnReadings {
    state
        .readings
        .lock_ok()
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
        .lock_ok()
        .invalidate();
}

async fn security_headers(State(secure): State<bool>, request: Request<Body>, next: Next) -> Response<Body> {
    let sensitive = request.uri().path().starts_with("/api/") || request.uri().path() == "/healthz";
    let frame = request.uri().path() == PDF_FRAME_PATH;
    // The browser desktop client's pages get the desktop's CSP with its
    // socket allowed (`web_client::page_csp`), not the phone's.
    let desktop = request.uri().path() == "/desktop" || request.uri().path().starts_with("/desktop/");
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
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
    // A handler that chose its own policy (`inbox_file`) keeps it.
    if sensitive && !headers.contains_key(header::CACHE_CONTROL) {
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    headers.insert(
        "permissions-policy",
        HeaderValue::from_static(MOBILE_PERMISSIONS_POLICY),
    );
    if desktop {
        let hashes = headers
            .remove(web_client::INLINE_SCRIPT_HASHES)
            .and_then(|v| v.to_str().ok().map(str::to_string))
            .unwrap_or_default();
        let csp = web_client::page_csp(host.as_deref().unwrap_or("127.0.0.1"), &hashes, secure);
        if let Ok(value) = HeaderValue::from_str(&csp) {
            headers.insert(header::CONTENT_SECURITY_POLICY, value);
        }
    } else if !framed {
        // `img-src blob:`: the files library's covers are drawn on the phone
        // and shown as object URLs (`mobile-web/src/thumbs.ts`).
        headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"));
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
    let Some((bytes, mime)) = embedded_asset(PDF_FRAME_PATH) else {
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
    if let Some(token) = body.oidc_token.as_deref() {
        // The provider's sign-in instead of a code: this daemon checks the
        // token itself (signature, issuer, audience, its own binding, the
        // nonce bound to this very key) before the store registers it.
        let control_dir = state.auth.lock_ok().control_dir().to_path_buf();
        if let Err(reason) = crate::services::server::oidc::check(&control_dir, token, &body.public_key).await {
            eprintln!("pair: identity provider sign-in refused: {reason}");
            return api_error(StatusCode::BAD_REQUEST, "invalid_oidc");
        }
        return match state.auth.lock_ok().pair_verified(&body.device_name, &body.public_key) {
            Ok(device_id) => (StatusCode::CREATED, Json(json!({ "device_id": device_id }))),
            Err(code) => api_error(StatusCode::BAD_REQUEST, &code),
        };
    }
    match state
        .auth
        .lock_ok()
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
    match state.auth.lock_ok().challenge(&body.device_id) {
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
        .lock_ok()
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
        state.auth.lock_ok().logout(token);
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
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
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
            json!({ "desktop_available": desktop_available, "host": state.config.host.display_name, "show_untested_tags": show_untested_tags, "color_scheme": color_scheme, "hidden_sections": hidden_sections(&state, &phone), "ai_off": ai_is_off(&state) }),
        ),
    )
}

async fn projects(
    State(state): State<HostState>,
    headers: HeaderMap,
    Query(query): Query<ProjectQuery>,
) -> impl IntoResponse {
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    let Ok(catalog_snapshot) = catalog(&state, &phone) else {
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
    let listed = catalog_snapshot
        .projects
        .iter()
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
    // Each row's agent tabs by state, from the readings the activity list
    // uses. Tmux session names are unique server-wide, so one map serves all.
    let agent_statuses = if listed.iter().any(|p| p.tabs.iter().any(|t| t.public.kind == "agent")) {
        let (_, statuses, _) = activity_readings(&state, &catalog_snapshot).await;
        statuses
            .into_iter()
            .map(|status| (status.tmux_session, status.status))
            .collect::<HashMap<_, _>>()
    } else {
        HashMap::new()
    };
    // Each row's git dot, from the desktop's own pills. Only asked when a
    // project is listed; a closed or older desktop leaves every row without one.
    let git = if listed.iter().any(|p| is_git_project(p)) {
        let desktop_socket = state.config.control_dir.join("desktop-control.sock");
        let request_id = new_request_id();
        match admin::desktop_call(&desktop_socket, &DesktopRequest::GitStates { request_id }).await {
            Ok(DesktopResponse::GitStates { states }) => states
                .into_iter()
                .filter_map(|row| git_dot(&row.state).map(|dot| (row.project_id, dot)))
                .collect::<HashMap<_, _>>(),
            // No window: probe the dots here (headless owner plan, H1b).
            response if desktop_down(&response) => {
                let mut dots = HashMap::new();
                for p in listed.iter().filter(|p| is_git_project(p)) {
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
            let mut public = p.public.clone();
            if is_git_project(p) {
                public.git = git.get(&p.raw_id).copied();
            }
            let mut agents = AgentCounts::default();
            for tab in p.tabs.iter().filter(|t| t.public.kind == "agent") {
                if let Some(status) = agent_statuses.get(&tab.tmux_name) {
                    agents.add(status);
                }
            }
            public.agents = agents.any().then_some(agents);
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

/// Every agent tab's status and prompt rows in one desktop round trip, and
/// whether the desktop answered. Without a window they come from the hooks'
/// turn records and the tabs' transcripts (headless owner plan, H1b).
async fn activity_readings(
    state: &HostState,
    catalog_snapshot: &Catalog,
) -> (bool, Vec<super::protocol::AgentTabStatus>, Vec<super::protocol::AgentTabPrompts>) {
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = new_request_id();
    match admin::desktop_call(&desktop_socket, &DesktopRequest::Activity { request_id }).await {
        Ok(DesktopResponse::Activity { statuses, prompts }) => (true, statuses, prompts),
        response if desktop_down(&response) => {
            let readings = headless::activity(&state.config.state_dir, catalog_snapshot);
            (false, readings.statuses, readings.prompts)
        }
        _ => (false, vec![], vec![]),
    }
}

/// `GET /api/v1/activity` — every agent tab the desktop reports as working,
/// waiting on a decision, or done, across every project this phone may reach,
/// in one flat list. One desktop round trip serves the whole list: a per-project
/// `Catalog` call would be one round trip per project on every poll.
async fn activity(State(state): State<HostState>, headers: HeaderMap) -> impl IntoResponse {
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    let Ok(catalog_snapshot) = catalog(&state, &phone) else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "catalog_unavailable");
    };
    let (desktop_available, statuses, prompts) = activity_readings(&state, &catalog_snapshot).await;
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
            tab.turn_started_at = status.turn_started_at;
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
        Json(json!({ "tabs": rows, "desktop_available": desktop_available, "ai_off": ai_is_off(&state) })),
    )
}

/// What a phone sends to make a new project: its name, nothing else.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NewProjectBody {
    name: String,
}

/// `POST /api/v1/projects` — a new, empty project from the phone, always a
/// folder in the projects folder and open to this phone alone
/// (`projects::create_project_for_phone`). No import, and no path crosses:
/// the phone sends a name and gets the new row back. It works with the window
/// closed (the registry is a file the owner writes); an open window is told
/// to re-read it.
async fn new_project(State(state): State<HostState>, headers: HeaderMap, body: Bytes) -> impl IntoResponse {
    let phone = match mutation_guard(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    let Ok(request) = serde_json::from_slice::<NewProjectBody>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    let create = state.spawner.new_project.clone();
    let device = phone.device_id().to_string();
    let raw_id = match off_worker(move || create(&request.name, &device)) {
        Ok(raw_id) => raw_id,
        Err(refusal) => {
            if let PhoneProjectRefusal::Failed(why) | PhoneProjectRefusal::Unavailable(why) = &refusal {
                eprintln!("mobile: a phone's new project was not created ({}): {why}", refusal.code());
            }
            let status = match refusal {
                PhoneProjectRefusal::InvalidName => StatusCode::BAD_REQUEST,
                PhoneProjectRefusal::Exists => StatusCode::CONFLICT,
                PhoneProjectRefusal::Unavailable(_) => StatusCode::SERVICE_UNAVAILABLE,
                PhoneProjectRefusal::Failed(_) => StatusCode::INTERNAL_SERVER_ERROR,
            };
            return api_error(status, refusal.code());
        }
    };
    poke_window(&state, None, &["projects"]);
    for _ in 0..8 {
        if let Ok(next) = catalog_fresh(&state, &phone) {
            if let Some(project) = next.projects.iter().find(|p| p.raw_id == raw_id) {
                return (StatusCode::CREATED, Json(json!({ "project": project.public })));
            }
        }
        tokio::time::sleep(Duration::from_millis(125)).await;
    }
    api_error(StatusCode::GATEWAY_TIMEOUT, "project_pending")
}

async fn project(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
) -> impl IntoResponse {
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    let Ok(catalog_snapshot) = catalog(&state, &phone) else {
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
    let request_id = new_request_id();
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
            let git = if is_git_project(project) {
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
    if is_git_project(project) {
        public.git = git.as_deref().and_then(git_dot);
    }
    // The assistant scope starts chats from its own launches, never a plain
    // agent: the ＋ sheet's agent list would only offer what the create refuses.
    let agents = if public.kind == ScopeKind::Assistant { Vec::new() } else { agents };
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
                tab.turn_started_at = status.turn_started_at;
            } else if let Some(timing) = timings.remove(&resolved.tmux_name) {
                // A read turn has no status, but it still sorts by when it ran
                // and still names its model.
                tab.agent_model = timing.model;
                tab.agent_plan = timing.plan;
                tab.agent_goal = timing.goal;
                tab.agent_subagents = timing.subagents;
                tab.working_at = timing.working_at;
                tab.done_at = timing.done_at;
                tab.turn_started_at = timing.turn_started_at;
            }
            tab.schedules = schedules.remove(&resolved.tmux_name);
            // Published whether or not the tab has a status: a quiet session's
            // last prompt is the reading its card exists to carry.
            tab.prompts = prompts.remove(&resolved.tmux_name).unwrap_or_default();
        }
    }
    if is_git_project(project) {
        for (tab, (worktree, subagents)) in tabs.iter_mut().zip(project_tab_worktrees(&state, project).await) {
            tab.worktree = worktree;
            tab.subagent_worktrees = subagents;
        }
    }
    (
        StatusCode::OK,
        Json(
            json!({ "project": public, "tabs": tabs, "desktop_available": desktop_available, "agents": agents, "closed": closed,
                // Whether this project's 📁 answers (`files.rs`): the host-wide
                // switch, and a project with a folder rather than a box, the
                // root console or a project the phone has no folder of.
                "files": is_git_project(project) && files::files_open(&state.config.state_dir),
                // Whether the 📁 has a remote side too (`host_files`): the same
                // switch, and a remote project's primary host. Never which host.
                "host_files": has_host_files(project) && files::files_open(&state.config.state_dir),
                // Whether the scope has a folder at all, and what the phone may
                // create in it (`all`, `agents` or `none`): the phone words the
                // reason and offers only what these allow, never a project type.
                "folder": project.has_folder(),
                "create": project.create,
                // Whether the phone may offer a new shell (`shells_open`).
                "shells": shells_open(&state.config.state_dir),
                // `tmux` where tabs attach through tmux; `unsupported` on a
                // host with none (Windows), where the phone hides ＋, Schedule
                // and Mark up's Submit (`terminals_support`).
                "terminals": terminals_support() }),
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

/// A fresh id for one desktop round trip — the key the window files the
/// pending answer under, so two requests must never share one. When the OS RNG
/// fails it is empty, and [`admin::desktop_call`] refuses an empty id with an
/// error answer instead of sending it: the request fails, and never takes
/// another request's reply (as the all-zero id it used to fall back to did).
fn new_request_id() -> String {
    super::auth::random_bytes::<16>()
        .map(|bytes| Base64UrlUnpadded::encode_string(&bytes))
        .unwrap_or_default()
}

async fn create_tab(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
    body: Bytes,
) -> impl IntoResponse {
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
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
    // routes below set it from an opaque tab id (and `teleport` rides only
    // with it).
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
    if matches!(request.kind, CreateTabKind::Agent) {
        if let Err(error) = ai_off_guard(&state) {
            return error;
        }
    }
    let Ok(catalog_snapshot) = catalog(&state, &phone) else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "catalog_unavailable");
    };
    let Some(project) = catalog_snapshot.project(&project_id) else {
        return api_error(StatusCode::NOT_FOUND, "project_not_found");
    };
    // A chat of the assistant scope names its launch and nothing else, and no
    // other scope takes one: the scope has no plain agent, no shell, no
    // worktree. (`launch_shape_ok` already kept the other fields out.)
    if (project.public.kind == ScopeKind::Assistant) != request.assistant.is_some() {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    }
    if let Err(error) = creatable(project, &request.kind) {
        return error;
    }
    // An agent on one of the project's hosts: the opaque machine id becomes
    // the window's location word, and only while the desktop holds that
    // host's master — the window rides it, and never dials or prompts for a
    // phone.
    let on_host = request.host.is_some();
    if let Some(asked) = request.host.take() {
        let key = host_key(&state);
        let Some(machine) = project
            .machines
            .iter()
            .find(|machine| machine.runnable && machine_id(&key, &project.raw_id, machine) == asked)
        else {
            return api_error(StatusCode::BAD_REQUEST, "host_not_found");
        };
        if !master_up(&state, &machine.spec).await {
            return api_error(StatusCode::CONFLICT, "host_offline");
        }
        request.host = Some(machine.location.clone());
    }
    request.project_id = project.raw_id.clone();
    let request_id = new_request_id();
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let response = admin::desktop_call(&desktop_socket, &DesktopRequest::Create { request_id, request: request.clone() }).await;
    if desktop_down(&response) {
        // The owner starts tabs on this machine only: a host tab is the
        // window's to spawn over its own connection.
        if on_host {
            return api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable");
        }
        // No window: the owner mints and starts the tab (headless owner
        // plan, H1b); the window attaches to it when it next opens.
        return create_headless(&state, &phone, &project_id, &request).await;
    }
    if on_host {
        return answer_created_on_host(&state, &phone, &project_id, response).await;
    }
    answer_created(&state, &phone, &project_id, response).await
}

/// The phone's opaque id for one of `raw_id`'s machines
/// (`ResolvedProject::machines`), as `launch-options` lists it and a create
/// names it back.
fn machine_id(host_key: &[u8], raw_id: &str, machine: &super::discovery::HostMachine) -> String {
    super::discovery::key_id(host_key, "host", &[raw_id, &machine.location])
}

/// Whether the desktop holds a live SSH master for `spec`'s host: the socket
/// the refresher last found, else `ssh -G`'s answer (kept by `host_files`),
/// then `ssh -O check` on it — the strict reading, so anything short of the
/// master answering is no.
async fn master_up(state: &HostState, spec: &crate::schema::project::RemoteSpec) -> bool {
    let known = state.catalog.lock_ok().host_control_path(spec);
    let Some(path) = state.host_files.control_path(spec, known).await else {
        return false;
    };
    tokio::task::spawn_blocking(move || crate::services::ssh_exec::master_alive(&path, host_live::PROBE_TIMEOUT))
        .await
        .unwrap_or(false)
}

/// The machines a phone-made agent of `project` may start on, for the ＋
/// sheet: each runnable one under its opaque id, with whether the desktop
/// is connected to it now. Empty for a project with none (a local one, a
/// remote one that does not persist its host sessions).
async fn phone_machines(state: &HostState, project: &super::discovery::ResolvedProject) -> Vec<serde_json::Value> {
    let key = host_key(state);
    let runnable: Vec<_> = project.machines.iter().filter(|machine| machine.runnable).collect();
    let connected = futures_util::future::join_all(runnable.iter().map(|machine| master_up(state, &machine.spec))).await;
    runnable
        .into_iter()
        .zip(connected)
        .map(|(machine, connected)| {
            json!({
                "id": machine_id(&key, &project.raw_id, machine),
                "label": machine.label,
                "primary": machine.primary,
                "connected": connected,
            })
        })
        .collect()
}

/// The launches a phone's assistant handle may resolve to right now: what the
/// desktop's new-chat menu would offer (`assistant_options`), as opaque ids.
/// Empty when the options cannot be read (the flag is off, say), which no
/// handle resolves against.
async fn assistant_choices(state: &HostState) -> Vec<super::assistant::Choice> {
    match (state.spawner.assistant_options)().await {
        Ok(options) => super::assistant::choices(&host_key(state), &options),
        Err(_) => Vec::new(),
    }
}

/// A create answered by the owner with no window: `headless::create_tab`
/// through the host's spawn seam, then the new row once the catalog lists
/// it (not `available` — no window is attached, and in a test no tmux
/// server runs — so the row is read straight from the session file).
async fn create_headless(
    state: &HostState,
    phone: &Phone,
    project_id: &str,
    request: &CreateTabRequest,
) -> (StatusCode, Json<serde_json::Value>) {
    let Ok(snapshot) = catalog(state, phone) else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "catalog_unavailable");
    };
    let Some(project) = snapshot.project(project_id) else {
        return api_error(StatusCode::NOT_FOUND, "project_not_found");
    };
    let state_dir = &state.config.state_dir;
    let agents = headless::agents(state_dir, &host_key(state), &*state.spawner.installed);
    let assistant = if request.assistant.is_some() { assistant_choices(state).await } else { Vec::new() };
    let created = headless::create_tab(state_dir, &host_key(state), project, request, &agents, &assistant, &state.spawner.launch).await;
    match created {
        Ok(created) => {
            poke_window(state, Some(&project.raw_id), &["workspace"]);
            answer_headless_created(state, phone, project_id, &created).await
        }
        Err(refusal) => headless_create_error(refusal),
    }
}

/// The new row once the catalog lists a tab the owner just minted and
/// started (a create or a reopen with no window).
async fn answer_headless_created(
    state: &HostState,
    phone: &Phone,
    project_id: &str,
    created: &headless::HeadlessCreated,
) -> (StatusCode, Json<serde_json::Value>) {
    for _ in 0..8 {
        if let Ok(next) = catalog_fresh(state, phone) {
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
    // The AI switch refused the spawn (`launch_prep::prepare`): the phone's
    // own `ai_off`, not a launch failure.
    if let headless::CreateRefusal::LaunchFailed(why) = &refusal {
        if why.rsplit(": ").next() == Some(crate::services::ai_switch::AI_OFF) {
            return api_error(StatusCode::FORBIDDEN, crate::services::ai_switch::AI_OFF);
        }
    }
    if let headless::CreateRefusal::LaunchFailed(why) | headless::CreateRefusal::Persist(why) = &refusal {
        eprintln!("mobile: a create with no window failed ({}): {why}", refusal.code());
    }
    api_error(
        match refusal {
            headless::CreateRefusal::DesktopUnavailable => StatusCode::SERVICE_UNAVAILABLE,
            headless::CreateRefusal::LaunchFailed(_) | headless::CreateRefusal::Persist(_) => StatusCode::BAD_GATEWAY,
            headless::CreateRefusal::UnknownAgent | headless::CreateRefusal::Assistant(_) => StatusCode::BAD_REQUEST,
            headless::CreateRefusal::NotAttachable => StatusCode::CONFLICT,
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
    phone: &Phone,
    project_id: &str,
    request: CreateTabRequest,
) -> (StatusCode, Json<serde_json::Value>) {
    let request_id = new_request_id();
    created_through_desktop(state, phone, project_id, &DesktopRequest::Create { request_id, request }).await
}

/// Send a request the desktop answers with `Created` (a create, a reopen) and
/// answer with the new tab's row once the catalog lists it.
async fn created_through_desktop(
    state: &HostState,
    phone: &Phone,
    project_id: &str,
    request: &DesktopRequest,
) -> (StatusCode, Json<serde_json::Value>) {
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let response = admin::desktop_call(&desktop_socket, request).await;
    answer_created(state, phone, project_id, response).await
}

/// The phone's answer to a desktop `Created` (or the desktop's refusal).
async fn answer_created(
    state: &HostState,
    phone: &Phone,
    project_id: &str,
    response: Result<DesktopResponse, String>,
) -> (StatusCode, Json<serde_json::Value>) {
    match response {
        Ok(DesktopResponse::Created { tmux_session }) => {
            for _ in 0..40 {
                if let Ok(next) = catalog_fresh(state, phone) {
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
                "nothing_to_reopen" | "not_attachable" => StatusCode::CONFLICT,
                _ => StatusCode::BAD_REQUEST,
            },
            &code,
        ),
        _ => api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
    }
}

/// [`answer_created`] for a tab the window started on a remote host. Its
/// row turns available only once `host_live` has seen the session in the
/// host's tmux, so this waits longer and asks the refresher for a round
/// every [`HOST_KICK_EVERY`] polls instead of waiting out its period. The
/// phone's `TAB_CREATE_TIMEOUT` stays above the desktop's answer plus this
/// (`MobileApiDeadlines.test.ts`).
async fn answer_created_on_host(
    state: &HostState,
    phone: &Phone,
    project_id: &str,
    response: Result<DesktopResponse, String>,
) -> (StatusCode, Json<serde_json::Value>) {
    let Ok(DesktopResponse::Created { tmux_session }) = response else {
        return answer_created(state, phone, project_id, response).await;
    };
    for round in 0..HOST_CREATED_POLLS {
        if round % HOST_KICK_EVERY == 0 {
            state.host_kick.notify_one();
        }
        if let Ok(next) = catalog_fresh(state, phone) {
            if let Some(tab) = next
                .project(project_id)
                .and_then(|p| p.tabs.iter().find(|t| t.tmux_name == tmux_session && t.public.available))
            {
                return (StatusCode::CREATED, Json(json!({ "tab": tab.public })));
            }
        }
        tokio::time::sleep(Duration::from_millis(HOST_CREATED_PAUSE_MS)).await;
    }
    api_error(StatusCode::GATEWAY_TIMEOUT, "launch_pending")
}

/// [`answer_created_on_host`]'s budget: 64 polls 125 ms apart (8 s), a
/// refresher round asked for every 12th (1.5 s).
const HOST_CREATED_POLLS: u32 = 64;
const HOST_CREATED_PAUSE_MS: u64 = 125;
const HOST_KICK_EVERY: u32 = 12;

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
    let phone = match mutation_guard(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    // Only agent tabs are kept for Reopen: none starts while AI is off.
    if let Err(error) = ai_off_guard(&state) {
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
    let Ok(catalog_snapshot) = catalog(&state, &phone) else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "catalog_unavailable");
    };
    let Some(project) = catalog_snapshot.project(&project_id) else {
        return api_error(StatusCode::NOT_FOUND, "project_not_found");
    };
    // A reopen starts an agent tab like a create does.
    if let Err(error) = creatable(project, &CreateTabKind::Agent) {
        return error;
    }
    let request_id = new_request_id();
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
                answer_headless_created(&state, &phone, &project_id, &created).await
            }
            Ok(None) => api_error(StatusCode::CONFLICT, "nothing_to_reopen"),
            Err(refusal) => headless_create_error(refusal),
        };
    }
    answer_created(&state, &phone, &project_id, response).await
}

/// The linked worktree each of the project's tabs works in, in tab order, for
/// its card — and the worktrees its subagents at work are in, other than that
/// one. Only agent tabs are named: where the agent is now and where its
/// subagents are come off its transcript (`agent_transcript::live_folders`,
/// window or not); a tab with none yet is where it launched. Git is asked only
/// when one of those folders is outside the project folder — a tab there is in
/// its own checkout by definition — so a project without worktrees never
/// spawns git on the screen's poll.
async fn project_tab_worktrees(
    state: &HostState,
    project: &super::discovery::ResolvedProject,
) -> Vec<(Option<git_overview::TabWorktree>, Vec<git_overview::SubagentWorktree>)> {
    let tabs: Vec<(bool, Option<String>, String, String)> = project
        .tabs
        .iter()
        .map(|tab| {
            let session = tab.session_id.clone().filter(|id| !id.is_empty() && !tab.local_model);
            // A host tab's folders are on the host: no worktree here is its.
            (tab.public.kind == "agent" && !tab.place.on_host(), session, tab.cmd.clone(), tab.cwd.clone())
        })
        .collect();
    let launched: Vec<(String, Vec<String>)> =
        tabs.iter().map(|(agent, _, _, cwd)| (if *agent { cwd.clone() } else { String::new() }, Vec::new())).collect();
    let raw_id = project.raw_id.clone();
    let folders = tokio::task::spawn_blocking(move || {
        tabs.into_iter()
            .map(|(agent, session, cmd, cwd)| {
                if !agent {
                    return (String::new(), Vec::new());
                }
                let live = session
                    .map(|uid| crate::services::agent_transcript::live_folders(&cmd, Some(&raw_id), &uid))
                    .unwrap_or_default();
                (live.cwd.unwrap_or(cwd), live.subagents)
            })
            .collect::<Vec<_>>()
    })
    .await
    .unwrap_or(launched);
    let all: Vec<&str> = folders
        .iter()
        .flat_map(|(cwd, subagents)| std::iter::once(cwd.as_str()).chain(subagents.iter().map(String::as_str)))
        .collect();
    let spots = worktree_spots_for(state, project, &all).await;
    let Some(spots) = spots else {
        return vec![(None, Vec::new()); folders.len()];
    };
    let mut named = git_overview::tab_worktrees(&spots, &all).into_iter();
    folders
        .iter()
        .map(|(_, subagents)| {
            let own = named.next().flatten();
            let others = git_overview::subagent_worktrees(own.as_ref(), named.by_ref().take(subagents.len()));
            (own, others)
        })
        .collect()
}

/// The project's worktrees as tab spots, for naming `cwds` — `None` when
/// none of them is outside the project folder, without asking git. The list
/// is one hardened `git worktree list`, cached per project for
/// `git_overview::SPOT_TTL`, and taken again at once when a folder is in no
/// worktree of the cached one (`SpotCache::first_miss`): a subagent's new
/// worktree is named on the next poll.
async fn worktree_spots_for(
    state: &HostState,
    project: &super::discovery::ResolvedProject,
    cwds: &[&str],
) -> Option<Vec<git_overview::WorktreeSpot>> {
    let elsewhere: Vec<&str> = cwds
        .iter()
        .copied()
        .filter(|cwd| !cwd.is_empty() && std::path::Path::new(cwd) != project.root)
        .collect();
    if elsewhere.is_empty() {
        return None;
    }
    let cached = state
        .worktree_spots
        .lock_ok()
        .get(&project.raw_id, Instant::now());
    if let Some(spots) = cached {
        let unplaced: Vec<&str> = elsewhere.iter().copied().filter(|cwd| git_overview::unplaced(&spots, cwd)).collect();
        let retry = !unplaced.is_empty()
            && state
                .worktree_spots
                .lock_ok()
                .first_miss(&project.raw_id, &unplaced);
        if !retry {
            return Some(spots);
        }
    }
    let root = project.root.clone();
    let spots = tokio::task::spawn_blocking(move || git_overview::worktree_spots(&root))
        .await
        .unwrap_or_default();
    state
        .worktree_spots
        .lock_ok()
        .set(&project.raw_id, spots.clone(), Instant::now());
    Some(spots)
}

/// `GET /api/v1/projects/{project_id}/git` — the project's worktrees, branches
/// and remote branches for the phone's Git sheet (`git_overview`). Answered
/// here, window open or not: every fact is a hardened local git read. A box or
/// the root console is `not_a_project`. Read-only; cached per project for
/// `git_overview::TTL`.
async fn project_git(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
) -> impl IntoResponse {
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    let Ok(catalog_snapshot) = catalog(&state, &phone) else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "catalog_unavailable");
    };
    let Some(project) = catalog_snapshot.project(&project_id) else {
        return api_error(StatusCode::NOT_FOUND, "project_not_found");
    };
    if !is_git_project(project) {
        return api_error(StatusCode::NOT_FOUND, "not_a_project");
    }
    let raw_id = project.raw_id.clone();
    if let Some(cached) = state
        .git_overview
        .lock_ok()
        .get(&raw_id, Instant::now())
    {
        return (StatusCode::OK, Json(json!(cached)));
    }
    let root = project.root.clone();
    let key = host_key(&state);
    // A host tab runs in the host's tree, which no local worktree counts.
    let tab_cwds: Vec<String> = project.tabs.iter().filter(|tab| !tab.place.on_host()).map(|tab| tab.cwd.clone()).collect();
    let Ok(overview) = tokio::task::spawn_blocking(move || git_overview::probe(&root, &key, &tab_cwds)).await else {
        return api_error(StatusCode::INTERNAL_SERVER_ERROR, "git_failed");
    };
    state
        .git_overview
        .lock_ok()
        .set(&raw_id, overview.clone(), Instant::now());
    (StatusCode::OK, Json(json!(overview)))
}

/// `GET /api/v1/projects/{project_id}/launch-options` — what the ＋ sheet can
/// start an agent in: the project's linked worktrees (opaque ids, directory
/// and branch names — never a path) and each agent's cloud launches.
async fn launch_options(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
) -> impl IntoResponse {
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    let Ok(catalog_snapshot) = catalog(&state, &phone) else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "catalog_unavailable");
    };
    let Some(project) = catalog_snapshot.project(&project_id) else {
        return api_error(StatusCode::NOT_FOUND, "project_not_found");
    };
    if project.public.kind == ScopeKind::Assistant {
        // Answered here, window or not: the options are the desktop's own
        // command run in this process, and the scope has no worktree, cloud
        // session, sign-in tab or local-model agent to ask the window about.
        return match (state.spawner.assistant_options)().await {
            Ok(options) => (
                StatusCode::OK,
                Json(json!({
                    "worktrees": [],
                    "cloud": [],
                    "sign_in": [],
                    "local": null,
                    "assistant": super::assistant::phone_options(&host_key(&state), &options),
                })),
            ),
            Err(_) => api_error(StatusCode::SERVICE_UNAVAILABLE, "assistant_unavailable"),
        };
    }
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = new_request_id();
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
        // H3). Worktrees, cloud sessions, sign-ins, local models and API-key
        // agents wait for the window, so none is listed.
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
            api_key,
        }) => {
            // Where an agent may start besides the mirror: the sidecar's own
            // list, since only it knows the masters the desktop holds.
            let hosts = if matches!(project.create, super::discovery::CreateVerdict::None) {
                Vec::new()
            } else {
                phone_machines(&state, project).await
            };
            (
                StatusCode::OK,
                Json(json!({ "worktrees": worktrees, "cloud": cloud, "sign_in": sign_in, "local": local, "api_key": api_key, "hosts": hosts })),
            )
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

async fn activate_project(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
    Query(query): Query<ActivateQuery>,
) -> impl IntoResponse {
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    let Ok(catalog_snapshot) = catalog(&state, &phone) else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "catalog_unavailable");
    };
    let Some(project) = catalog_snapshot.project(&project_id) else {
        return api_error(StatusCode::NOT_FOUND, "project_not_found");
    };
    // A named tab must be one of this scope's own; its tmux name is what the
    // window knows it by.
    let mut chat_running = false;
    let tmux_session = match query.tab.as_deref() {
        None => None,
        Some(tab_id) => match catalog_snapshot.tab(tab_id) {
            // The phone's "restart for phone": a host tab is never the
            // window's to wrap, so the desktop is not switched for one.
            Some((owner, tab)) if owner.raw_id == project.raw_id && tab.place.on_host() => {
                return api_error(StatusCode::CONFLICT, "tab_on_host");
            }
            Some((owner, tab)) if owner.raw_id == project.raw_id => {
                chat_running = tab.public.available;
                Some(tab.tmux_name.clone())
            }
            _ => return api_error(StatusCode::NOT_FOUND, "tab_not_found"),
        },
    };
    // Opening a chat that is not running starts it: not while AI is off.
    if project.public.kind == ScopeKind::Assistant && tmux_session.is_some() && !chat_running {
        if let Err(error) = ai_off_guard(&state) {
            return error;
        }
    }
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = new_request_id();
    let response = admin::desktop_call(
        &desktop_socket,
        &DesktopRequest::Activate {
            request_id,
            project_id: project.raw_id.clone(),
            tmux_session: tmux_session.clone(),
        },
    )
    .await;
    if desktop_down(&response) {
        // No window: the registry entry is marked active under the file's
        // lock, and the next window restores it open (headless owner plan,
        // H3). A box or the root console has no such status.
        // A chat of the assistant's scope the phone is opening: its process
        // ends with its CLI (no shell is left behind), and no window means
        // nobody to start it again, so the owner does, detached, like the
        // create did. One that is running is left alone.
        if project.public.kind == ScopeKind::Assistant {
            let Some(tmux) = tmux_session.as_deref() else {
                return api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable");
            };
            if !chat_running {
                if let Err(refusal) = headless::start_chat(&state.config.state_dir, project, tmux, &state.spawner.launch).await {
                    return headless_create_error(refusal);
                }
                catalog_stale(&state);
                poke_window(&state, Some(&project.raw_id), &["workspace"]);
            }
            return (StatusCode::OK, Json(json!({ "status": "activated", "desktop_available": false })));
        }
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
    if let Err(error) = section_guard(&headers, &state, "todo") {
        return error;
    }
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = new_request_id();
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
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = new_request_id();
    match admin::desktop_call(&desktop_socket, &DesktopRequest::Alerts { request_id }).await {
        Ok(DesktopResponse::Alerts { alerts }) => {
            let alerts = open_alerts(&hidden_sections(&state, &phone), alerts);
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
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
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
    // The handle is opaque, so a phone kept out of a section has its row's
    // kind looked up first: a ✓ on a row it was never shown is refused.
    let hidden = hidden_sections(&state, &phone);
    if !hidden.is_empty() {
        let request_id = new_request_id();
        match admin::desktop_call(&desktop_socket, &DesktopRequest::Alerts { request_id }).await {
            Ok(DesktopResponse::Alerts { alerts }) => {
                if !open_alerts(&hidden, alerts)
                    .items
                    .iter()
                    .any(|item| item.alert_id.as_deref() == Some(request.alert_id.as_str()))
                {
                    return api_error(StatusCode::FORBIDDEN, "section_hidden");
                }
            }
            _ => return api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
        }
    }
    let request_id = new_request_id();
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
            let alerts = open_alerts(&hidden, alerts);
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
    let auth = state.auth.lock_ok();
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
        Ok(phone) => push_state(&state, phone.device_id()),
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
        Ok(phone) => phone.0,
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
        .lock_ok()
        .push_subscribe(&device_id, &request.endpoint, &request.p256dh, &request.auth, request.prefs);
    if stored.is_err() {
        return api_error(StatusCode::BAD_REQUEST, "invalid_push_subscription");
    }
    push_state(&state, &device_id)
}

// ── The device-released secrets key (hosted plan §6.8) ──────────────────────
//
// A server daemon only (`vault::vault()`); the desktop's sidecar answers
// `available: false` and the phone does nothing more. See `server::vault`.

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SecretsEnrolBody {
    ecdh_public_key: String,
    signature: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SecretsFinishBody {
    id: String,
    transport: String,
    nonce: String,
    sealed: String,
}

async fn secrets_state(State(state): State<HostState>, headers: HeaderMap) -> impl IntoResponse {
    let device_id = match authenticate(&headers, &state) {
        Ok(phone) => phone.device_id().to_string(),
        Err(error) => return error,
    };
    let Some(vault) = crate::services::server::vault::vault() else {
        return (StatusCode::OK, Json(json!({ "available": false })));
    };
    let enrolled = state.auth.lock_ok().secrets_device_keys().iter().any(|k| k.id == device_id);
    let status = vault.status();
    // The identity a device compares with the one it pinned: a mismatch is
    // the cue to re-pin with the recovery code, never to trust it silently.
    let identity = if status.set_up { vault.identity_public().ok() } else { None };
    (
        StatusCode::OK,
        Json(json!({
            "available": true,
            "setUp": status.set_up,
            "unlocked": status.unlocked,
            "enrolled": enrolled,
            "recoveryCode": status.recovery_code,
            // A device was revoked since the code was made: make a new one.
            "newCodeRecommended": status.new_code_recommended,
            // The mailbox's re-key after a revoke, while one is under way.
            "mailRekey": crate::services::mail_rekey::status(&vault.mail_dir()),
            "identity": identity,
        })),
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SecretsChallengeBody {
    action: String,
}

/// A nonce for a signed secrets action (set-up, a new recovery code).
async fn secrets_challenge(State(state): State<HostState>, headers: HeaderMap, body: Bytes) -> impl IntoResponse {
    let device_id = match authenticate(&headers, &state) {
        Ok(phone) => phone.device_id().to_string(),
        Err(error) => return error,
    };
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    if crate::services::server::vault::vault().is_none() {
        return api_error(StatusCode::NOT_FOUND, "not_a_server");
    }
    let Ok(request) = serde_json::from_slice::<SecretsChallengeBody>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    match state.auth.lock_ok().action_challenge(&device_id, &request.action) {
        Ok((nonce, expires_at)) => (StatusCode::OK, Json(json!({ "nonce": nonce, "expiresAt": expires_at }))),
        Err(code) if code == "rate_limited" => api_error(StatusCode::TOO_MANY_REQUESTS, &code),
        Err(code) => api_error(StatusCode::BAD_REQUEST, &code),
    }
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct SignedActionBody {
    #[serde(default)]
    nonce: Option<String>,
    #[serde(default)]
    signature: Option<String>,
}

/// The pairing key's signature over an action nonce (user decision
/// 2026-10-03): a session cookie alone is refused with `signature_required`.
fn check_signed_action(state: &HostState, device_id: &str, action: &str, body: &[u8]) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    let request = serde_json::from_slice::<SignedActionBody>(body).map_err(|_| api_error(StatusCode::BAD_REQUEST, "invalid_request"))?;
    let (Some(nonce), Some(signature)) = (request.nonce, request.signature) else {
        return Err(api_error(StatusCode::FORBIDDEN, "signature_required"));
    };
    state
        .auth
        .lock_ok()
        .verify_action(device_id, action, &nonce, &signature)
        .map_err(|code| api_error(StatusCode::FORBIDDEN, &code))
}

/// What a device needs to re-pin a changed identity key with its recovery
/// code (`Vault::repin_offer`); the code itself never comes here.
async fn secrets_repin(State(state): State<HostState>, headers: HeaderMap) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    let Some(vault) = crate::services::server::vault::vault() else {
        return api_error(StatusCode::NOT_FOUND, "not_a_server");
    };
    match vault.repin_offer(&state.config.origin) {
        Ok(offer) => (StatusCode::OK, Json(serde_json::to_value(offer).unwrap_or_default())),
        Err(code) if code == "not_set_up" || code == "recovery_outdated" => api_error(StatusCode::CONFLICT, &code),
        Err(error) => {
            eprintln!("secrets: re-pin offer: {error}");
            api_error(StatusCode::INTERNAL_SERVER_ERROR, "identity_unavailable")
        }
    }
}

async fn secrets_enrol(State(state): State<HostState>, headers: HeaderMap, body: Bytes) -> impl IntoResponse {
    let device_id = match authenticate(&headers, &state) {
        Ok(phone) => phone.device_id().to_string(),
        Err(error) => return error,
    };
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    let Some(vault) = crate::services::server::vault::vault() else {
        return api_error(StatusCode::NOT_FOUND, "not_a_server");
    };
    let Ok(request) = serde_json::from_slice::<SecretsEnrolBody>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    let keys = {
        let mut auth = state.auth.lock_ok();
        if let Err(code) = auth.enrol_secrets_key(&device_id, &request.ecdh_public_key, &request.signature) {
            return api_error(StatusCode::BAD_REQUEST, &code);
        }
        auth.secrets_device_keys()
    };
    let identity = match vault.identity_public() {
        Ok(identity) => identity,
        Err(error) => {
            eprintln!("secrets: identity key: {error}");
            return api_error(StatusCode::INTERNAL_SERVER_ERROR, "identity_unavailable");
        }
    };
    // Enrolled while K is held: wrapped at once; otherwise at the next release.
    vault.wrap_missing(&keys);
    (StatusCode::OK, Json(json!({ "identity": identity })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SecretsRecoverBody {
    code: String,
}

/// Mint K and answer its recovery code — the only time it is ever shown.
/// Signed by the device's pairing key ([`check_signed_action`]).
async fn secrets_setup(State(state): State<HostState>, headers: HeaderMap, body: Bytes) -> Response<Body> {
    let device_id = match authenticate(&headers, &state) {
        Ok(phone) => phone.device_id().to_string(),
        Err(error) => return error.into_response(),
    };
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin").into_response();
    }
    let Some(vault) = crate::services::server::vault::vault() else {
        return api_error(StatusCode::NOT_FOUND, "not_a_server").into_response();
    };
    if let Err(error) = check_signed_action(&state, &device_id, "secrets-setup", &body) {
        return error.into_response();
    }
    let keys = state.auth.lock_ok().secrets_device_keys();
    match vault.set_up(&keys) {
        Ok(code) => {
            let mut response = Json(json!({ "code": code.as_str() })).into_response();
            response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            response
        }
        Err(error) => api_error(StatusCode::CONFLICT, &error).into_response(),
    }
}

/// A fresh recovery code while unlocked; the old one stops working. Signed
/// by the device's pairing key ([`check_signed_action`]).
async fn secrets_new_recovery_code(State(state): State<HostState>, headers: HeaderMap, body: Bytes) -> Response<Body> {
    let device_id = match authenticate(&headers, &state) {
        Ok(phone) => phone.device_id().to_string(),
        Err(error) => return error.into_response(),
    };
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin").into_response();
    }
    let Some(vault) = crate::services::server::vault::vault() else {
        return api_error(StatusCode::NOT_FOUND, "not_a_server").into_response();
    };
    if let Err(error) = check_signed_action(&state, &device_id, "secrets-recovery-code", &body) {
        return error.into_response();
    }
    match vault.new_recovery_code() {
        Ok(code) => {
            let mut response = Json(json!({ "code": code.as_str() })).into_response();
            response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            response
        }
        Err(error) => api_error(StatusCode::CONFLICT, &error).into_response(),
    }
}

async fn secrets_recover(State(state): State<HostState>, headers: HeaderMap, body: Bytes) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    let Some(vault) = crate::services::server::vault::vault() else {
        return api_error(StatusCode::NOT_FOUND, "not_a_server");
    };
    let Ok(request) = serde_json::from_slice::<SecretsRecoverBody>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    let code = zeroize::Zeroizing::new(request.code);
    let keys = state.auth.lock_ok().secrets_device_keys();
    match vault.recover(&code, &keys) {
        Ok(()) => (StatusCode::OK, Json(json!({ "state": "unlocked" }))),
        Err(_) => api_error(StatusCode::BAD_REQUEST, "invalid_recovery_code"),
    }
}

async fn secrets_unlock_start(State(state): State<HostState>, headers: HeaderMap) -> impl IntoResponse {
    let device_id = match authenticate(&headers, &state) {
        Ok(phone) => phone.device_id().to_string(),
        Err(error) => return error,
    };
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    let Some(vault) = crate::services::server::vault::vault() else {
        return api_error(StatusCode::NOT_FOUND, "not_a_server");
    };
    match vault.start_unlock(&state.config.origin, &device_id) {
        Ok(start) => (StatusCode::OK, Json(serde_json::to_value(start).unwrap_or_default())),
        Err(code) => api_error(StatusCode::TOO_MANY_REQUESTS, &code),
    }
}

async fn secrets_unlock_finish(State(state): State<HostState>, headers: HeaderMap, body: Bytes) -> impl IntoResponse {
    let device_id = match authenticate(&headers, &state) {
        Ok(phone) => phone.device_id().to_string(),
        Err(error) => return error,
    };
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    let Some(vault) = crate::services::server::vault::vault() else {
        return api_error(StatusCode::NOT_FOUND, "not_a_server");
    };
    let Ok(request) = serde_json::from_slice::<SecretsFinishBody>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    let keys = state.auth.lock_ok().secrets_device_keys();
    // The ECDH and the wrap are a few microseconds; the listeners (mail
    // reopening) run on their own threads.
    match vault.finish_unlock(&device_id, &request.id, &request.transport, &request.nonce, &request.sealed, &keys) {
        Ok(()) => (StatusCode::OK, Json(json!({ "state": "unlocked" }))),
        Err(code) => api_error(StatusCode::BAD_REQUEST, &code),
    }
}

async fn push_delete(State(state): State<HostState>, headers: HeaderMap) -> impl IntoResponse {
    let device_id = match authenticate(&headers, &state) {
        Ok(phone) => phone.0,
        Err(error) => return error,
    };
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    if state
        .auth
        .lock_ok()
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
///
/// Not a phone's request, so it reads the unfiltered catalog and hands the
/// scope's per-phone list on: the push filter sends only to those phones.
fn agent_tab_ref(state: &HostState, tmux_session: &str) -> Option<AgentTabRef> {
    let catalog = catalog_unfiltered(state).ok()?;
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
                devices: project.devices.clone(),
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
    if let Err(error) = section_guard(&headers, &state, "calendar") {
        return error;
    }
    let Some(month) = query.month.filter(|value| valid_calendar_month(value)) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_month");
    };
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = new_request_id();
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
    if let Err(error) = section_guard(&headers, &state, "calendar") {
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
    let request_id = new_request_id();
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
    if let Err(error) = section_guard(&headers, &state, "todo") {
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
    let request_id = new_request_id();
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

/// The window's answer to a local-models request, as the phone gets it: the
/// list rebuilt by `local_models::sanitize` under `ok`, a refusal as its code
/// alone (`local_models::refusal`), and anything else — no window, a wedged
/// one, an answer of another kind — as `desktop_unavailable`, which the phone
/// reads as "open the app on the desktop". There is no headless answer.
fn local_models_response(
    response: Result<DesktopResponse, String>,
    ok: StatusCode,
) -> (StatusCode, Json<serde_json::Value>) {
    match response {
        Ok(DesktopResponse::LocalModels { server, can_start, start_failed, models }) => {
            (ok, Json(local_models::sanitize(&server, can_start, start_failed, &models)))
        }
        Ok(DesktopResponse::Error { code, .. }) => {
            let (status, code) = local_models::refusal(&code);
            api_error(status, code)
        }
        _ => api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
    }
}

/// Whether the phone's Local models are closed to this request: the switch is
/// off, or — on a server daemon — the phone's account is not the
/// administrator's, whose shared Ollama it is (hosted plan §3.3; the role is
/// the gateway's header, which only the gateway can send). Closed, the phone
/// leaves the section out.
fn local_models_closed(state: &HostState, headers: &HeaderMap) -> bool {
    let not_admin = state.web.on_server()
        && crate::services::server::gateway_role_in(headers) != crate::services::core_dispatch::Role::Admin;
    not_admin || !local_models::local_models_open(&state.config.state_dir)
}

/// A Local models request answered: by the window on a desktop, by this
/// process on a server daemon, which has none (`local_models::answer_here`).
async fn local_models_call(state: &HostState, request: DesktopRequest) -> Result<DesktopResponse, String> {
    if state.web.on_server() {
        let action = match request {
            DesktopRequest::LocalModelMutate { action, .. } => Some(action),
            _ => None,
        };
        return Ok(local_models::answer_here(state.web.ctx.clone(), &state.config.state_dir, action).await);
    }
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    admin::desktop_call(&desktop_socket, &request).await
}

/// `GET /api/v1/local-models` — the desktop's installed Ollama models, their
/// residency and the server's state. Host-wide; the switch is read per
/// request and, when off, answers before the desktop is asked.
async fn local_models_list(State(state): State<HostState>, headers: HeaderMap) -> impl IntoResponse {
    if let Err(error) = authenticate(&headers, &state) {
        return error;
    }
    if local_models_closed(&state, &headers) {
        return api_error(StatusCode::FORBIDDEN, "local_models_disabled");
    }
    let request_id = new_request_id();
    local_models_response(local_models_call(&state, DesktopRequest::LocalModels { request_id }).await, StatusCode::OK)
}

/// `POST /api/v1/local-models` `{ action: load | unload | start, model? }`.
/// Guarded like every write; then the switch, then the action — a pull, a
/// delete or anything else unnamed is `unsupported_action` and never reaches
/// the desktop. The answer is the fresh list: 202 for a load or a start,
/// which run on in the window after it answers, 200 for an unload.
async fn local_models_mutate(
    State(state): State<HostState>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    if let Err(error) = mutation_guard(&headers, &state) {
        return error;
    }
    if local_models_closed(&state, &headers) {
        return api_error(StatusCode::FORBIDDEN, "local_models_disabled");
    }
    let Ok(body) = serde_json::from_slice::<serde_json::Value>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    let action = match local_models::parse_action(&body) {
        Ok(action) => action,
        Err(code) => return api_error(StatusCode::BAD_REQUEST, code),
    };
    let ok = match action {
        LocalModelAction::Unload { .. } => StatusCode::OK,
        LocalModelAction::Load { .. } | LocalModelAction::Start => {
            if let Err(error) = ai_off_guard(&state) {
                return error;
            }
            StatusCode::ACCEPTED
        }
    };
    let request_id = new_request_id();
    local_models_response(local_models_call(&state, DesktopRequest::LocalModelMutate { request_id, action }).await, ok)
}

/// Mail stays behind the live desktop for the same reason the board does: the
/// desktop already owns the unlocked/encrypted MailState. The sidecar receives
/// only the bounded, read-only snapshot defined in `protocol`.
async fn mail_overview(State(state): State<HostState>, headers: HeaderMap) -> impl IntoResponse {
    if let Err(error) = section_guard(&headers, &state, "mail") {
        return error;
    }
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = new_request_id();
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
    if let Err(error) = section_guard(&headers, &state, "mail") {
        return error;
    }
    let offset = query.offset.unwrap_or(0);
    if !valid_mail_id(&folder_id) || offset > 100_000 {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    }
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = new_request_id();
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
    if let Err(error) = section_guard(&headers, &state, "mail") {
        return error;
    }
    let offset = query.offset.unwrap_or(0);
    if !valid_mail_id(&folder_id) || !valid_mail_id(&message_id) || offset > 100_000 {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    }
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = new_request_id();
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
    if let Err(error) = section_guard(&headers, &state, "mail") {
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
    let request_id = new_request_id();
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
    if let Err(error) = section_guard(&headers, &state, "mail") {
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
    let request_id = new_request_id();
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
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    let Ok(catalog) = catalog(&state, &phone) else {
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
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
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
    let (project_id, tmux_session) = match agent_tab_target(&state, &phone, &tab_id) {
        Ok(target) => target,
        Err(error) => return error,
    };
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = new_request_id();
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
        return headless_tab_edit(&state, &phone, &project_id, &tab_id, &tmux_session, edited, json!({ "label": label }));
    }
    match response {
        Ok(DesktopResponse::Renamed { label }) => {
            let row = catalog_fresh(&state, &phone)
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
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
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
    let (project_id, tmux_session) = match tab_target(&state, &phone, &tab_id, false) {
        Ok(target) => target,
        Err(error) => return error,
    };
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = new_request_id();
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
        return headless_tab_edit(&state, &phone, &project_id, &tab_id, &tmux_session, edited, json!({ "color": color }));
    }
    match response {
        Ok(DesktopResponse::Colored { color }) => {
            let row = catalog_fresh(&state, &phone)
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
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    if let Err(error) = ai_off_guard(&state) {
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
    let (project_id, tmux_session) = match agent_tab_target(&state, &phone, &tab_id) {
        Ok(target) => target,
        Err(error) => return error,
    };
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = new_request_id();
    let response = admin::desktop_call(
        &desktop_socket,
        &DesktopRequest::TabPrompt {
            request_id,
            project_id: project_id.clone(),
            tmux_session,
            message: message.to_string(),
            device_id: Some(phone.device_id().to_string()),
        },
    )
    .await;
    if desktop_down(&response) {
        // No window: the owner writes the history row (headless owner plan,
        // H3); the words already reached the tab through the terminal socket.
        let Ok((_, tab)) = agent_tab(&state, &phone, &tab_id) else {
            return api_error(StatusCode::NOT_FOUND, "tab_not_found");
        };
        return match headless::record_prompt(&state.config.state_dir, &project_id, &tab, message, Some(phone.device_id())) {
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
            Err(code) if matches!(code.as_str(), "tab_not_found" | "held_gone" | "held_busy" | "invalid_prompt" | "tab_on_host") => code,
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
            "held_gone" | "held_busy" | "tab_on_host" => StatusCode::CONFLICT,
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
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    if let Err(error) = ai_off_guard(&state) {
        return error;
    }
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    let message = match held_message(&body) {
        Ok(message) => message,
        Err(error) => return error,
    };
    let (project_id, tab) = match agent_tab(&state, &phone, &tab_id) {
        Ok(target) => target,
        Err(error) => return error,
    };
    let request_id = new_request_id();
    let state_dir = state.config.state_dir.clone();
    let (status, body) = held_call(
        &state,
        DesktopRequest::HoldPrompt {
            request_id,
            project_id: project_id.clone(),
            tmux_session: tab.tmux_name.clone(),
            message: message.clone(),
            device_id: Some(phone.device_id().to_string()),
        },
        // With no window the owner types only into local tmux: a host tab's
        // prompt has nobody to deliver it.
        || {
            not_on_host(&tab).map_err(|_| "tab_on_host".to_string())?;
            headless::hold_prompt(&state_dir, &project_id, &tab, &message, Some(phone.device_id()), chrono::Local::now())
        },
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
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    if let Err(error) = ai_off_guard(&state) {
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
    let (project_id, tab) = match agent_tab(&state, &phone, &tab_id) {
        Ok(target) => target,
        Err(error) => return error,
    };
    let request_id = new_request_id();
    let state_dir = state.config.state_dir.clone();
    held_call(
        &state,
        DesktopRequest::EditHeldPrompt {
            request_id,
            project_id: project_id.clone(),
            tmux_session: tab.tmux_name.clone(),
            held_id: held_id.clone(),
            message: message.clone(),
            device_id: Some(phone.device_id().to_string()),
        },
        || {
            not_on_host(&tab).map_err(|_| "tab_on_host".to_string())?;
            headless::edit_held_prompt(&state_dir, &project_id, &tab, &held_id, &message, Some(phone.device_id())).map(|()| held_id.clone())
        },
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
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
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
    // The listener is on this machine; a host tab's CLI waits on the host's.
    match agent_tab(&state, &phone, &tab_id) {
        Ok((_, tab)) => {
            if let Err(error) = not_on_host(&tab) {
                return error;
            }
        }
        Err(error) => return error,
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
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
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
    let Ok(catalog_snapshot) = catalog(&state, &phone) else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "catalog_unavailable");
    };
    let Some((project, tab)) = catalog_snapshot.tab(&tab_id) else {
        return api_error(StatusCode::NOT_FOUND, "tab_not_found");
    };
    if tab.public.kind != "agent" {
        return api_error(StatusCode::BAD_REQUEST, "agent_tab_required");
    }
    // A sign-in tab starts a local agent: it would sign this machine's CLI
    // in, not the host's.
    if let Err(error) = not_on_host(tab) {
        return error;
    }
    // A chat runs on the CLI's shared login, and the scope starts nothing but
    // chats: there is no sign-in tab to open beside one.
    if project.public.kind == ScopeKind::Assistant {
        return api_error(StatusCode::BAD_REQUEST, "unsupported_sign_in");
    }
    if let Err(error) = creatable(project, &CreateTabKind::Agent) {
        return error;
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
        teleport: None,
        local: None,
        assistant: None,
        api_key: false,
        host: None,
        idempotency_key: body.idempotency_key,
    };
    let project_id = project.public.id.clone();
    create_through_desktop(&state, &phone, &project_id, request).await
}

/// `POST /api/v1/tabs/{id}/teleport` — pull the session a cloud tab started
/// into a new agent tab beside it, in a fresh linked worktree (Claude's
/// `--teleport <session>`): teleport checks out the session's branch, which in
/// the project folder would move every other tab there onto it. The phone
/// names the cloud tab by opaque id and the session by the id that tab
/// printed; the desktop builds the command line and the worktree.
async fn teleport_tab(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(tab_id): Path<String>,
    body: Bytes,
) -> impl IntoResponse {
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct TeleportBody {
        session: String,
        idempotency_key: String,
    }
    let Ok(body) = serde_json::from_slice::<TeleportBody>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    if body.idempotency_key.len() < 16
        || body.idempotency_key.len() > 128
        || !super::protocol::is_cloud_session_id(&body.session)
    {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    }
    if let Err(error) = ai_off_guard(&state) {
        return error;
    }
    let Ok(catalog_snapshot) = catalog(&state, &phone) else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "catalog_unavailable");
    };
    let Some((project, tab)) = catalog_snapshot.tab(&tab_id) else {
        return api_error(StatusCode::NOT_FOUND, "tab_not_found");
    };
    if tab.public.kind != "agent" || !tab.public.cloud {
        return api_error(StatusCode::BAD_REQUEST, "cloud_tab_required");
    }
    if let Err(error) = creatable(project, &CreateTabKind::Agent) {
        return error;
    }
    let request = CreateTabRequest {
        project_id: project.raw_id.clone(),
        kind: CreateTabKind::Agent,
        agent_id: None,
        mode: None,
        worktree: None,
        cloud: None,
        task: None,
        sign_in: None,
        like_tab: Some(tab.tmux_name.clone()),
        teleport: Some(body.session),
        local: None,
        assistant: None,
        api_key: false,
        host: None,
        idempotency_key: body.idempotency_key,
    };
    let project_id = project.public.id.clone();
    create_through_desktop(&state, &phone, &project_id, request).await
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
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
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
    let (project_id, tmux_session) = match tab_target(&state, &phone, &tab_id, false) {
        Ok(target) => target,
        Err(error) => return error,
    };
    let (anchor_project, anchor_tmux) = match tab_target(&state, &phone, &request.anchor, false) {
        Ok(target) => target,
        Err(error) => return error,
    };
    // Two scopes have two layouts and no shared order to express a move in.
    if anchor_project != project_id {
        return api_error(StatusCode::BAD_REQUEST, "tab_scope_mismatch");
    }
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = new_request_id();
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
                let tabs: Vec<String> = catalog_fresh(&state, &phone)
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
            let tabs: Vec<String> = catalog_fresh(&state, &phone)
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
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    let (project_id, tmux_session) = match tab_target(&state, &phone, &tab_id, false) {
        Ok(target) => target,
        Err(error) => return error,
    };
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = new_request_id();
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
                    // Its MCP tokens go with it (`docs/headless_mcp_plan.md`).
                    crate::services::root_mcp::revoke_tab(&format!("{}{tmux_session}", headless::LAUNCH_ID_PREFIX));
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
    phone: &Phone,
    tab_id: &str,
    agent_only: bool,
) -> Result<(String, String), (StatusCode, Json<serde_json::Value>)> {
    let catalog = catalog(state, phone)?;
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
    phone: &Phone,
    tab_id: &str,
) -> Result<(String, String), (StatusCode, Json<serde_json::Value>)> {
    tab_target(state, phone, tab_id, true)
}

/// [`agent_tab_target`] keeping the whole catalog record — what answering a
/// tab's schedules or transcript with no window open needs (its schedule
/// binding, command and folder), none of which is ever serialized back.
fn agent_tab(
    state: &HostState,
    phone: &Phone,
    tab_id: &str,
) -> Result<(String, ResolvedTab), (StatusCode, Json<serde_json::Value>)> {
    let catalog = catalog(state, phone)?;
    let Some((project, tab)) = catalog.tab(tab_id) else {
        return Err(api_error(StatusCode::NOT_FOUND, "tab_not_found"));
    };
    if tab.public.kind != "agent" {
        return Err(api_error(StatusCode::BAD_REQUEST, "agent_tab_required"));
    }
    Ok((project.raw_id.clone(), tab.clone()))
}

/// A scope with no folder the phone may use has nothing read from it, written
/// into it or probed with git on a phone's behalf — no files, outbox, inbox,
/// upload, markup, desktop-image or uncommitted-changes route. That is the
/// chat assistant's scope (a work folder and no project folder; a chat's own
/// files live in the CLI's transcript), a remote project whose mirror is not
/// there yet and a VM project with none: their `root` names nothing that
/// exists (`ResolvedProject::folder`). Every folder-shaped route asks this one
/// test, never the scope's kind (a box and the root console have a folder).
fn has_folder(project: &super::discovery::ResolvedProject) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    if !project.has_folder() {
        return Err(api_error(StatusCode::NOT_FOUND, "not_a_project"));
    }
    Ok(())
}

/// A tab that runs on its remote project's host has nothing on this machine
/// for a route to act on — its inbox, a sign-in, a desktop switch to it — so
/// such a route answers `409 tab_on_host` and the phone hides the control
/// (`docs/mobile_remote_host_tabs_plan.md`).
fn not_on_host(tab: &ResolvedTab) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    if tab.place.on_host() {
        return Err(api_error(StatusCode::CONFLICT, "tab_on_host"));
    }
    Ok(())
}

/// A real project folder: the scopes git is asked about (the dot, worktrees,
/// the Git sheet) and the 📁 drawer lists. A box and the root console have a
/// folder and are not projects; a project the phone has no folder of is not
/// either.
fn is_git_project(project: &super::discovery::ResolvedProject) -> bool {
    project.public.kind == ScopeKind::Project && project.has_folder()
}

/// The create gate, made once for every route that starts a tab before it
/// branches to the window or to the owner: the scope's verdict
/// (`ResolvedProject::create`) against the kind of tab asked for. The tabs of a
/// remote host, a container or a VM have no local tmux session the phone can
/// attach to, so a new one there would run where nobody can reach it
/// (`docs/mobile_every_project_type_plan.md`, phase 1).
fn creatable(
    project: &super::discovery::ResolvedProject,
    kind: &CreateTabKind,
) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    use super::discovery::CreateVerdict;
    let allowed = match project.create {
        CreateVerdict::All => true,
        CreateVerdict::Agents => matches!(kind, CreateTabKind::Agent),
        CreateVerdict::None => false,
    };
    if allowed {
        Ok(())
    } else {
        Err(api_error(StatusCode::CONFLICT, "not_attachable"))
    }
}

/// The chat assistant's scope takes no schedules and no collected prompts
/// (`docs/assistant_plan.md`: a chat is typed into, never scheduled, and its
/// words stay in the CLI's transcript): `project_id` is the raw scope id of a
/// tab or scope the catalog resolved, which is `assistant` for no other scope.
fn no_schedules_here(project_id: &str) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    if super::discovery::is_assistant_scope_id(project_id) {
        return Err(api_error(StatusCode::NOT_FOUND, "not_a_project"));
    }
    Ok(())
}

async fn schedules(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(tab_id): Path<String>,
) -> impl IntoResponse {
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    let (project_id, tab) = match agent_tab(&state, &phone, &tab_id) {
        Ok(target) => target,
        Err(error) => return error,
    };
    if let Err(error) = no_schedules_here(&project_id) {
        return error;
    }
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = new_request_id();
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
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    let (project_id, tmux_session) = match agent_tab_target(&state, &phone, &tab_id) {
        Ok(target) => target,
        Err(error) => return error,
    };
    let refresh = matches!(query.refresh.as_deref(), Some("1" | "true"));
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = new_request_id();
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
        let Ok(snapshot) = catalog(&state, &phone) else {
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
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    // A handle is a digest the desktop minted; anything else is not one.
    if query
        .subagent
        .as_deref()
        .is_some_and(|token| !crate::services::agent_transcript::is_subagent_token(token))
    {
        return api_error(StatusCode::BAD_REQUEST, "invalid_subagent");
    }
    let (project_id, tab) = match agent_tab(&state, &phone, &tab_id) {
        Ok(target) => target,
        Err(error) => return error,
    };
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = new_request_id();
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
        let transcript = phone_transcript(&state, &phone, &tab_id, transcript).await;
        return (
            StatusCode::OK,
            Json(json!({ "transcript": transcript, "desktop_available": false })),
        );
    }
    match response {
        Ok(DesktopResponse::AgentTranscript { transcript }) => (
            StatusCode::OK,
            Json(json!({ "transcript": phone_transcript(&state, &phone, &tab_id, transcript).await })),
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

/// `GET /api/v1/tabs/{tab_id}/uncommitted` — the files the agent tab's
/// conversation changed that are still not committed, for the chat screen's
/// Commit chip (`chat_uncommitted`). Answered here, window open or not: the
/// CLI's own transcript and hardened local git reads. Read-only; cached per
/// tab for `chat_uncommitted::TTL`.
async fn tab_uncommitted(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(tab_id): Path<String>,
) -> impl IntoResponse {
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    let Ok(snapshot) = catalog(&state, &phone) else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "catalog_unavailable");
    };
    let Some((project, tab)) = snapshot.tab(&tab_id) else {
        return api_error(StatusCode::NOT_FOUND, "tab_not_found");
    };
    if let Err(error) = has_folder(project) {
        return error;
    }
    if tab.public.kind != "agent" {
        return api_error(StatusCode::BAD_REQUEST, "agent_tab_required");
    }
    if let Some(cached) = chat_uncommitted::cached(&tab_id, Instant::now()) {
        return (StatusCode::OK, Json(json!(cached)));
    }
    let raw_id = project.raw_id.clone();
    let roots = if project.roots.is_empty() { vec![project.root.clone()] } else { project.roots.clone() };
    let tab = tab.clone();
    let Ok(answer) = tokio::task::spawn_blocking(move || chat_uncommitted::for_tab(&raw_id, &roots, &tab)).await else {
        return api_error(StatusCode::INTERNAL_SERVER_ERROR, "git_failed");
    };
    chat_uncommitted::remember(&tab_id, answer.clone(), Instant::now());
    (StatusCode::OK, Json(json!(answer)))
}

/// `?version=` is the fingerprint the phone last saw, `?subagent=` the handle
/// of the subagent whose changes are read, `?limit=` how many of the newest.
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct ChangesQuery {
    version: Option<String>,
    limit: Option<usize>,
    subagent: Option<String>,
}

/// `GET /api/v1/tabs/{tab_id}/changes` — the diffs the agent tab's
/// conversation (or `subagent`'s) recorded, for the chat screen's Diffs view
/// (`chat_changes`). File content, so behind the "Project files on the phone"
/// switch like the file library; answered here, window open or not, from the
/// CLI's own transcript. Read-only; paths cross checkout-relative.
async fn tab_changes(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(tab_id): Path<String>,
    Query(query): Query<ChangesQuery>,
) -> impl IntoResponse {
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    if !files::files_open(&state.config.state_dir) {
        return api_error(StatusCode::NOT_FOUND, "files_off");
    }
    if query
        .subagent
        .as_deref()
        .is_some_and(|token| !crate::services::agent_transcript::is_subagent_token(token))
    {
        return api_error(StatusCode::BAD_REQUEST, "invalid_subagent");
    }
    let Ok(snapshot) = catalog(&state, &phone) else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "catalog_unavailable");
    };
    let Some((project, tab)) = snapshot.tab(&tab_id) else {
        return api_error(StatusCode::NOT_FOUND, "tab_not_found");
    };
    if let Err(error) = has_folder(project) {
        return error;
    }
    if tab.public.kind != "agent" {
        return api_error(StatusCode::BAD_REQUEST, "agent_tab_required");
    }
    if let Err(error) = not_on_host(tab) {
        return error;
    }
    let raw_id = project.raw_id.clone();
    let roots = if project.roots.is_empty() { vec![project.root.clone()] } else { project.roots.clone() };
    let tab = tab.clone();
    let Ok(answer) = tokio::task::spawn_blocking(move || {
        chat_changes::for_tab(&raw_id, &roots, &tab, query.subagent.as_deref(), query.version.as_deref(), query.limit)
    })
    .await
    else {
        return api_error(StatusCode::INTERNAL_SERVER_ERROR, "read_failed");
    };
    (StatusCode::OK, Json(json!(answer)))
}

/// A transcript as the phone may see it: the shell commands the desktop
/// Reader shows beside its working row are command lines, and the folders the
/// agent and its subagents work in are paths, neither of which crosses the
/// browser API. The running shells do, as the agent's own few words on each
/// and whether it is in the background; their command lines are emptied. A subagent's folder in a linked worktree of the tab's project
/// crosses as that worktree's name and branch instead (`worktree` on its
/// `agent` entry), as the tab cards name it.
/// The running shells keep what the agent said they do and whether they run in
/// the background; the command line, and that it was cut, stay on the desktop.
fn empty_shell_commands(transcript: &mut crate::services::agent_transcript::AgentTranscript) {
    for shell in &mut transcript.shells {
        shell.command.clear();
        shell.cut = false;
    }
}

async fn phone_transcript(
    state: &HostState,
    phone: &Phone,
    tab_id: &str,
    mut transcript: crate::services::agent_transcript::AgentTranscript,
) -> serde_json::Value {
    empty_shell_commands(&mut transcript);
    transcript.context_card = None;
    transcript.cwd = None;
    transcript.running_cwds.clear();
    let entry_cwds: Vec<String> = transcript.entries.iter_mut().map(|entry| entry.cwd.take().unwrap_or_default()).collect();
    let mut named: Vec<Option<git_overview::TabWorktree>> = Vec::new();
    let project = (entry_cwds.iter().any(|cwd| !cwd.is_empty()))
        .then(|| catalog(state, phone).ok())
        .flatten()
        .and_then(|catalog| catalog.tab(tab_id).map(|(project, _)| project.clone()))
        .filter(is_git_project);
    if let Some(project) = project {
        let all: Vec<&str> = entry_cwds.iter().map(String::as_str).collect();
        if let Some(spots) = worktree_spots_for(state, &project, &all).await {
            named = git_overview::tab_worktrees(&spots, &all);
        }
    }
    let mut value = json!(transcript);
    if let Some(entries) = value.get_mut("entries").and_then(serde_json::Value::as_array_mut) {
        for (entry, worktree) in entries.iter_mut().zip(named) {
            if let Some(worktree) = worktree {
                entry["worktree"] = json!(worktree);
            }
        }
    }
    value
}

async fn schedule_mutation(
    state: &HostState,
    phone: &Phone,
    tab_id: &str,
    action: ScheduleMutation,
) -> (StatusCode, Json<serde_json::Value>) {
    let (project_id, tab) = match agent_tab(state, phone, tab_id) {
        Ok(target) => target,
        Err(error) => return error,
    };
    if let Err(error) = no_schedules_here(&project_id) {
        return error;
    }
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = new_request_id();
    let response = admin::desktop_call(
        &desktop_socket,
        &DesktopRequest::ScheduleMutate {
            request_id,
            project_id: project_id.clone(),
            tmux_session: tab.tmux_name.clone(),
            action: action.clone(),
            device_id: Some(phone.device_id().to_string()),
        },
    )
    .await;
    if desktop_down(&response) {
        // No window: the rule lands in `agent_tasks.json` under its lock
        // (headless owner plan, H3); the sidecar's own scheduler fires it —
        // into local tmux only, so not for a host tab.
        if let Err(error) = not_on_host(&tab) {
            return error;
        }
        let Some(target) = tab.schedule_target_id.as_deref() else {
            return api_error(StatusCode::NOT_FOUND, "tab_not_found");
        };
        return match headless::schedule_mutate(&state.config.state_dir, &project_id, target, action, Some(phone.device_id()), chrono::Local::now()) {
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
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    let Ok(schedule) = serde_json::from_slice::<MobileScheduleInput>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    let (status, body) =
        schedule_mutation(&state, &phone, &tab_id, ScheduleMutation::Create { schedule }).await;
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
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    let Ok(schedule) = serde_json::from_slice::<MobileScheduleInput>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    schedule_mutation(
        &state,
        &phone,
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
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    schedule_mutation(&state, &phone, &tab_id, ScheduleMutation::Delete { schedule_id }).await
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
    phone: &Phone,
    project_id: &str,
) -> Result<String, (StatusCode, Json<serde_json::Value>)> {
    let catalog = catalog(state, phone)?;
    let Some(project) = catalog.project(project_id) else {
        return Err(api_error(StatusCode::NOT_FOUND, "project_not_found"));
    };
    no_schedules_here(&project.raw_id)?;
    Ok(project.raw_id.clone())
}

async fn prompts(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
) -> impl IntoResponse {
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    let project_id = match prompt_project(&state, &phone, &project_id) {
        Ok(raw) => raw,
        Err(error) => return error,
    };
    let request_id = new_request_id();
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
) -> Result<Phone, (StatusCode, Json<serde_json::Value>)> {
    let phone = authenticate(headers, state)?;
    if !exact_origin(headers, state) {
        return Err(api_error(StatusCode::FORBIDDEN, "invalid_origin"));
    }
    Ok(phone)
}

async fn prompt_mutation(
    state: &HostState,
    phone: &Phone,
    project_id: &str,
    action: PromptMutation,
) -> (StatusCode, Json<serde_json::Value>) {
    let project_id = match prompt_project(state, phone, project_id) {
        Ok(raw) => raw,
        Err(error) => return error,
    };
    let request_id = new_request_id();
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let response = admin::desktop_call(
        &desktop_socket,
        &DesktopRequest::PromptMutate {
            request_id,
            project_id: project_id.clone(),
            action: action.clone(),
            device_id: Some(phone.device_id().to_string()),
        },
    )
    .await;
    if desktop_down(&response) {
        // No window: the prompt lands in `agent_prompts.json` under its lock;
        // a send is queued as a one-time rule the sidecar's scheduler fires
        // (headless owner plan, H3).
        let target = match &action {
            PromptMutation::Send { tmux_session, .. } => {
                let Ok(snapshot) = catalog(state, phone) else {
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
                // The send-now is a rule the sidecar types into local tmux.
                if let Err(error) = not_on_host(tab) {
                    return error;
                }
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
        return match headless::prompt_mutate(&state.config.state_dir, &project_id, action, target, Some(phone.device_id()), chrono::Local::now()) {
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
    let phone = match mutation_guard(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    let Ok(prompt) = serde_json::from_slice::<MobilePromptInput>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    let (status, body) =
        prompt_mutation(&state, &phone, &project_id, PromptMutation::Create { prompt }).await;
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
    let phone = match mutation_guard(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    let Ok(prompt) = serde_json::from_slice::<MobilePromptInput>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    prompt_mutation(
        &state,
        &phone,
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
    let phone = match mutation_guard(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    prompt_mutation(&state, &phone, &project_id, PromptMutation::Delete { prompt_id }).await
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
    let phone = match mutation_guard(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    if let Err(error) = ai_off_guard(&state) {
        return error;
    }
    let Ok(send) = serde_json::from_slice::<PromptSendBody>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    // The tab is resolved here, before the generic mutation path, so a tab id
    // from another project can never aim a prompt across projects.
    let tmux_session = {
        let catalog = match catalog(&state, &phone) {
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
        &phone,
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
    let phone = match mutation_guard(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    if let Err(error) = ai_off_guard(&state) {
        return error;
    }
    let (project_id, tmux_session) = match agent_tab_target(&state, &phone, &tab_id) {
        Ok(target) => target,
        Err(error) => return error,
    };
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let request_id = new_request_id();
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
        return undo_clear_headless(&state, &phone, &tab_id).await;
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
async fn undo_clear_headless(state: &HostState, phone: &Phone, tab_id: &str) -> (StatusCode, Json<serde_json::Value>) {
    let Ok(snapshot) = catalog(state, phone) else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "catalog_unavailable");
    };
    let Some((project, tab)) = snapshot.tab(tab_id) else {
        return api_error(StatusCode::NOT_FOUND, "tab_not_found");
    };
    if project.public.kind == ScopeKind::Root {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable");
    }
    // The owner's undo types into, or relaunches, a local session.
    if let Err(error) = not_on_host(tab) {
        return error;
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

/// The phone's answer to a worktree request the desktop refused, or that no
/// window was there to answer: the move is the window's (it stops and
/// respawns the tab's pane), so with none open there is nothing to do.
fn worktree_desktop_error(response: Result<DesktopResponse, String>) -> (StatusCode, Json<serde_json::Value>) {
    match response {
        Ok(DesktopResponse::Error { code, .. }) => api_error(
            match code.as_str() {
                "desktop_unavailable" | "tab_not_ready" => StatusCode::SERVICE_UNAVAILABLE,
                "tab_not_found" | "worktree_not_found" | "model_not_found" => StatusCode::NOT_FOUND,
                "not_movable" | "tab_busy" | "move_failed" | "not_assistant_chat" | "switch_failed" => StatusCode::CONFLICT,
                _ => StatusCode::BAD_REQUEST,
            },
            &code,
        ),
        _ => api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
    }
}

/// `GET /api/v1/tabs/{id}/worktrees` — the folders the facts row's ⎇ branch
/// chip can move this agent tab to (`DesktopRequest::TabWorktrees`): the
/// project folder and its linked worktrees by opaque id, which one the tab is
/// in, and whether its CLI takes the conversation along. No path crosses.
async fn tab_worktrees(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(tab_id): Path<String>,
) -> impl IntoResponse {
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    let (project_id, tmux_session) = match agent_tab_target(&state, &phone, &tab_id) {
        Ok(target) => target,
        Err(error) => return error,
    };
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let response = admin::desktop_call(
        &desktop_socket,
        &DesktopRequest::TabWorktrees {
            request_id: new_request_id(),
            project_id,
            tmux_session,
        },
    )
    .await;
    match response {
        Ok(DesktopResponse::TabWorktrees { worktrees, current, carries }) => (
            StatusCode::OK,
            Json(json!({ "worktrees": worktrees, "current": current, "carries": carries })),
        ),
        other => worktree_desktop_error(other),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MoveWorktreeBody {
    worktree: String,
}

/// `POST /api/v1/tabs/{id}/worktree` with `{ "worktree": "<id>" }` — move
/// the agent tab to that worktree (`DesktopRequest::MoveWorktree`): the
/// desktop stops its CLI, takes the conversation along where the CLI allows
/// and respawns the tab there. Answers `{ "moved": "carried" | "fresh" }`; a
/// failed move (`409 move_failed`) left the tab in its old folder.
async fn move_tab_worktree(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(tab_id): Path<String>,
    body: Bytes,
) -> impl IntoResponse {
    let phone = match mutation_guard(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    // The move respawns the agent's CLI.
    if let Err(error) = ai_off_guard(&state) {
        return error;
    }
    let Ok(MoveWorktreeBody { worktree }) = serde_json::from_slice::<MoveWorktreeBody>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    if worktree.is_empty() || worktree.len() > 128 {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    }
    let (project_id, tmux_session) = match agent_tab_target(&state, &phone, &tab_id) {
        Ok(target) => target,
        Err(error) => return error,
    };
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let response = admin::desktop_call(
        &desktop_socket,
        &DesktopRequest::MoveWorktree {
            request_id: new_request_id(),
            project_id,
            tmux_session,
            worktree,
        },
    )
    .await;
    match response {
        Ok(DesktopResponse::WorktreeMoved { moved }) => (StatusCode::OK, Json(json!({ "moved": moved }))),
        other => worktree_desktop_error(other),
    }
}

/// `GET /api/v1/tabs/{id}/assistant-models` — the models a Tabby chat can be
/// switched to (`DesktopRequest::AssistantModels`) and the one it runs, for the
/// facts row's model chip. Names only; `409 not_assistant_chat` for a tab of
/// any other scope, where the CLI's own `/model` does it.
async fn assistant_models(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(tab_id): Path<String>,
) -> impl IntoResponse {
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    let (project_id, tmux_session) = match agent_tab_target(&state, &phone, &tab_id) {
        Ok(target) => target,
        Err(error) => return error,
    };
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let response = admin::desktop_call(
        &desktop_socket,
        &DesktopRequest::AssistantModels {
            request_id: new_request_id(),
            project_id,
            tmux_session,
        },
    )
    .await;
    match response {
        Ok(DesktopResponse::AssistantModels { models, rows, current }) => {
            (StatusCode::OK, Json(json!({ "models": models, "rows": rows, "current": current })))
        }
        other => worktree_desktop_error(other),
    }
}

/// The CLI build a phone's model sheet on `tab_id` lists the remembered rows
/// of (`services::model_rows`): its registry id and executable. Only for an
/// agent tab whose CLI runs on this machine — not a remote, container or VM
/// project's, not a host tab's, not a local-model tab's (its model is fixed).
fn model_rows_cli(
    state: &HostState,
    phone: &Phone,
    tab_id: &str,
) -> Result<(&'static str, crate::services::agent_versions::VersionSource), (StatusCode, Json<serde_json::Value>)> {
    let catalog = catalog(state, phone)?;
    let Some((project, tab)) = catalog.tab(tab_id) else {
        return Err(api_error(StatusCode::NOT_FOUND, "tab_not_found"));
    };
    if tab.public.kind != "agent" {
        return Err(api_error(StatusCode::BAD_REQUEST, "agent_tab_required"));
    }
    if project.host != super::discovery::ProjectHost::Local || tab.place.on_host() || tab.local_model {
        return Err(api_error(StatusCode::CONFLICT, "not_this_machine"));
    }
    crate::services::agent_registry::installed_source(&tab.cmd).ok_or_else(|| api_error(StatusCode::NOT_FOUND, "unknown_agent"))
}

/// `GET /api/v1/tabs/{id}/model-rows` — `{ title?, rows }`, the rows the tab's
/// CLI build's own model picker drew last time, for the phone's model sheet to
/// list while the session draws its picker (`rows` empty when none).
async fn model_rows(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(tab_id): Path<String>,
) -> impl IntoResponse {
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    let (cli, source) = match model_rows_cli(&state, &phone, &tab_id) {
        Ok(cli) => cli,
        Err(error) => return error,
    };
    let store = crate::services::model_rows::store_path_in(&state.config.state_dir);
    let rows = crate::services::model_rows::rows_in(&store, cli, Some(&source)).unwrap_or_default();
    (StatusCode::OK, Json(json!(rows)))
}

/// `POST /api/v1/tabs/{id}/model-rows` with `{ title?, rows }` — keep the rows
/// the phone just read off the tab's live model picker for its CLI build.
async fn remember_model_rows(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(tab_id): Path<String>,
    body: Bytes,
) -> impl IntoResponse {
    let phone = match mutation_guard(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    let Ok(rows) = serde_json::from_slice::<crate::services::model_rows::Rows>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    let (cli, source) = match model_rows_cli(&state, &phone, &tab_id) {
        Ok(cli) => cli,
        Err(error) => return error,
    };
    let store = crate::services::model_rows::store_path_in(&state.config.state_dir);
    match crate::services::model_rows::remember_rows_in(&store, cli, Some(&source), rows) {
        Ok(()) => (StatusCode::OK, Json(json!({ "kept": true }))),
        Err(why) => {
            eprintln!("mobile: keeping a model list failed: {why}");
            api_error(StatusCode::INTERNAL_SERVER_ERROR, "write_failed")
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SwitchModelBody {
    model: String,
}

/// `POST /api/v1/tabs/{id}/assistant-model` with `{ "model": "<name>" }` —
/// switch a Tabby chat to that model (`DesktopRequest::SwitchAssistantModel`):
/// the desktop restarts the chat's CLI on it and resumes the conversation.
/// Answers `{ "switched": true }`; `409 tab_busy` while the chat is at work,
/// `404 model_not_found` for a name the desktop did not list.
async fn switch_assistant_model(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(tab_id): Path<String>,
    body: Bytes,
) -> impl IntoResponse {
    let phone = match mutation_guard(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    // The switch respawns the chat's CLI.
    if let Err(error) = ai_off_guard(&state) {
        return error;
    }
    let Ok(SwitchModelBody { model }) = serde_json::from_slice::<SwitchModelBody>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    if model.is_empty() || model.len() > 128 || !crate::services::local_drivers::model_name_ok(&model) {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    }
    let (project_id, tmux_session) = match agent_tab_target(&state, &phone, &tab_id) {
        Ok(target) => target,
        Err(error) => return error,
    };
    let desktop_socket = state.config.control_dir.join("desktop-control.sock");
    let response = admin::desktop_call(
        &desktop_socket,
        &DesktopRequest::SwitchAssistantModel {
            request_id: new_request_id(),
            project_id,
            tmux_session,
            model,
        },
    )
    .await;
    match response {
        Ok(DesktopResponse::Seen) => (StatusCode::OK, Json(json!({ "switched": true }))),
        other => worktree_desktop_error(other),
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
        let request_id = new_request_id();
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
/// nothing in the terminal path may wait on the desktop. `interrupt`: the input
/// was a bare Esc or Ctrl+C.
fn mark_tab_input(socket: &std::path::Path, project_id: Option<String>, tmux_session: String, interrupt: bool) {
    let Some(project_id) = project_id else {
        return;
    };
    let socket = socket.to_path_buf();
    tokio::spawn(async move {
        let request_id = new_request_id();
        let _ = admin::desktop_call(
            &socket,
            &DesktopRequest::TabInput {
                request_id,
                project_id,
                tmux_session,
                interrupt,
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
    let Ok(phone) = authenticate(&headers, &state) else {
        return api_error(StatusCode::UNAUTHORIZED, "authentication_required").into_response();
    };
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
    let Ok(catalog) = catalog(&state, &phone) else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "catalog_unavailable").into_response();
    };
    let Some((tab_project, tab)) = catalog.tab(&tab_id) else {
        return api_error(StatusCode::NOT_FOUND, "tab_not_found").into_response();
    };
    let target = match terminal_target(tab, |path| crate::services::ssh_exec::master_alive(&path, host_live::PROBE_TIMEOUT)).await {
        Ok(target) => target,
        Err((status, code)) => return api_error(status, code).into_response(),
    };
    // Only an agent tab carries a status the phone can retire; a shell raises
    // none, so it never needs the desktop told about it.
    let seen_project = (tab.public.kind == "agent").then(|| tab_project.raw_id.clone());
    // Deliberately no `session_busy` pre-check: the bridge now displaces a
    // stale viewer instead, so a phone that was backgrounded before its
    // `detached` frame flushed does not lock the user out of their own agent
    // until the idle reaper (`pty_bridge::IDLE_TIMEOUT`) fires. A genuinely live viewer that
    // refuses to yield still produces `session_busy`, from the bridge.
    // Everything but a shell runs an AI: its input obeys the AI switch.
    let ai = tab.public.kind != "shell";
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
                target,
                registry,
                auth,
                token,
                state_dir,
                tab_id,
                catalog,
                ai,
                move |interrupt| {
                    mark_tab_input(&input_socket, input_project.clone(), input_tmux.clone(), interrupt);
                },
                seen,
            )
            .await;
        })
}

/// What a terminal upgrade for `tab` attaches to, or why it may not. A host
/// tab rides the desktop's master for its host: none found by the last round
/// is `409 host_offline`, and the master is asked again here — a foreground
/// act, window or not (`master_alive`, off the async workers, under a
/// deadline) — since with no window the round trusted the socket file alone.
async fn terminal_target(
    tab: &ResolvedTab,
    master_alive: impl FnOnce(std::path::PathBuf) -> bool + Send + 'static,
) -> Result<pty_bridge::AttachTarget, (StatusCode, &'static str)> {
    let name = tab.tmux_name.clone();
    if !tab.place.on_host() {
        return if tab.public.available { Ok(pty_bridge::AttachTarget::Local { name }) } else { Err((StatusCode::GONE, "session_gone")) };
    }
    let Some(ssh) = tab.place.host_ssh() else {
        return Err((StatusCode::CONFLICT, "host_offline"));
    };
    if !tab.public.available {
        return Err((StatusCode::GONE, "session_gone"));
    }
    let path = ssh.control_path.clone();
    if !tokio::task::spawn_blocking(move || master_alive(path)).await.unwrap_or(false) {
        return Err((StatusCode::CONFLICT, "host_offline"));
    }
    Ok(pty_bridge::AttachTarget::Host { name, ssh })
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
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    let Ok(catalog) = catalog(&state, &phone) else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "catalog_unavailable");
    };
    let Some((project, tab)) = catalog.tab(&tab_id) else {
        return api_error(StatusCode::NOT_FOUND, "tab_not_found");
    };
    // The mirror's inbox is not one a host agent can read.
    if let Err(error) = not_on_host(tab) {
        return error;
    }
    if let Err(error) = has_folder(project) {
        return error;
    }
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
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    match project_drop_box_root(&state, &phone, &project_id) {
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
    phone: &Phone,
    tab_id: &str,
) -> Result<String, (StatusCode, Json<serde_json::Value>)> {
    let catalog = catalog(state, phone)?;
    let Some((project, tab)) = catalog.tab(tab_id) else {
        return Err(api_error(StatusCode::NOT_FOUND, "tab_not_found"));
    };
    not_on_host(tab)?;
    has_folder(project)?;
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
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    let project_id = match inbox_project(&state, &phone, &tab_id) {
        Ok(raw) => raw,
        Err(error) => return error,
    };
    let request_id = new_request_id();
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
    let phone = match mutation_guard(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    let Ok(request) = serde_json::from_slice::<AttachDesktopImageBody>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    if !desktop_images::valid_id(&request.image_id) {
        return api_error(StatusCode::BAD_REQUEST, "invalid_request");
    }
    let project_id = match inbox_project(&state, &phone, &tab_id) {
        Ok(raw) => raw,
        Err(error) => return error,
    };
    let request_id = new_request_id();
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
        let Ok(snapshot) = catalog(&state, &phone) else {
            return api_error(StatusCode::SERVICE_UNAVAILABLE, "catalog_unavailable");
        };
        let Some((project, _)) = snapshot.tab(&tab_id) else {
            return api_error(StatusCode::NOT_FOUND, "tab_not_found");
        };
        if let Err(error) = has_folder(project) {
            return error;
        }
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
    phone: &Phone,
    tab_id: &str,
) -> Result<PathBuf, (StatusCode, Json<serde_json::Value>)> {
    let catalog = catalog(state, phone)?;
    let Some((project, _)) = catalog.tab(tab_id) else {
        return Err(api_error(StatusCode::NOT_FOUND, "tab_not_found"));
    };
    has_folder(project)?;
    Ok(project.root.clone())
}

/// The same root by the project itself, for the project screen's outbox and
/// its ＋ → Send a file. Both drop boxes belong to the project, not to one of
/// its sessions: a project whose tabs are all closed — or one that never had
/// an agent tab — still has them, and that screen has no tab to name.
fn project_drop_box_root(
    state: &HostState,
    phone: &Phone,
    project_id: &str,
) -> Result<PathBuf, (StatusCode, Json<serde_json::Value>)> {
    let catalog = catalog(state, phone)?;
    let Some(project) = catalog.project(project_id) else {
        return Err(api_error(StatusCode::NOT_FOUND, "project_not_found"));
    };
    has_folder(project)?;
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
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    let catalog = match catalog(&state, &phone) {
        Ok(catalog) => catalog,
        Err(error) => return error,
    };
    let Some((project, tab)) = catalog.tab(&tab_id) else {
        return api_error(StatusCode::NOT_FOUND, "tab_not_found");
    };
    if let Err(error) = has_folder(project) {
        return error;
    }
    // Every file is listed — the gallery holds them all — but only what this
    // tab sent is marked `from_tab`, the files its chat shows.
    let rows = row_seal(&state, project);
    outbox_listing(project.root.clone(), tab.session_id.clone(), rows).await
}

/// `GET /api/v1/projects/{project_id}/outbox` — the same listing by the
/// project, for the project screen's shelf under the tab cards.
async fn project_outbox_list(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
) -> impl IntoResponse {
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    let catalog = match catalog(&state, &phone) {
        Ok(catalog) => catalog,
        Err(error) => return error,
    };
    let Some(project) = catalog.project(&project_id) else {
        return api_error(StatusCode::NOT_FOUND, "project_not_found");
    };
    if let Err(error) = has_folder(project) {
        return error;
    }
    let rows = row_seal(&state, project);
    outbox_listing(project.root.clone(), None, rows).await
}

/// One outbox file as a listing hands it to the phone: the file's own fields
/// and, for a copy `tabtivity-send` made of a project file the files drawer
/// would list, that file's sealed row — the phone opens the project file in
/// its place, so its marks are the drawer's (one layer per project file, not
/// one per copy). The path the copy recorded never crosses.
#[derive(Serialize)]
struct ListedOutboxFile {
    #[serde(flatten)]
    file: outbox::OutboxFile,
    #[serde(skip_serializing_if = "Option::is_none")]
    file_row: Option<MobileMarkupFile>,
}

/// What a listing seals a copy's project file with — the project's raw id
/// and the host key — or `None` unless the drawer is open (`files_open`) and
/// the scope is a real project: the same gates as `markup_banner_files`.
fn row_seal(state: &HostState, project: &super::discovery::ResolvedProject) -> Option<(String, Vec<u8>)> {
    if !is_git_project(project) || !files::files_open(&state.config.state_dir) {
        return None;
    }
    let key = state.auth.lock_ok().host_key().to_vec();
    Some((project.raw_id.clone(), key))
}

async fn outbox_listing(
    root: PathBuf,
    tab: Option<String>,
    rows: Option<(String, Vec<u8>)>,
) -> (StatusCode, Json<serde_json::Value>) {
    // A directory walk that opens every candidate, and each copy's project
    // file proven and sealed: off the connection executor.
    let listed = tokio::task::spawn_blocking(move || {
        let files = outbox::list_for(&root, tab.as_deref())?;
        Ok::<_, outbox::OutboxError>(files
            .into_iter()
            .map(|file| {
                let file_row = rows.as_ref().zip(file.source.as_deref())
                    .and_then(|((raw_id, key), rel)| file_row(&root, rel, key, raw_id));
                ListedOutboxFile { file, file_row }
            })
            .collect::<Vec<_>>())
    })
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
/// `nosniff` applies as to every `/api/` answer, and `no-store` unless the
/// read names the file's version (`outbox_bytes`). Anything the
/// listing would not offer — a symlink, an oversized file, a name with a
/// separator — is `file_not_found`, not a different error.
async fn outbox_file(
    State(state): State<HostState>,
    headers: HeaderMap,
    uri: Uri,
    Path((tab_id, name)): Path<(String, String)>,
    Query(query): Query<HashMap<String, String>>,
) -> Response<Body> {
    let phone = match authenticate_or_ticket(&headers, &state, &uri) {
        Ok(phone) => phone,
        Err(error) => return error.into_response(),
    };
    let root = match outbox_root(&state, &phone, &tab_id) {
        Ok(root) => root,
        Err(error) => return error.into_response(),
    };
    outbox_bytes(root, name, &query).await
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
    let phone = match authenticate_or_ticket(&headers, &state, &uri) {
        Ok(phone) => phone,
        Err(error) => return error.into_response(),
    };
    let root = match project_drop_box_root(&state, &phone, &project_id) {
        Ok(root) => root,
        Err(error) => return error.into_response(),
    };
    outbox_bytes(root, name, &query).await
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
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    match outbox_root(&state, &phone, &tab_id) {
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
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    match project_drop_box_root(&state, &phone, &project_id) {
        Ok(root) => outbox_removal(root, name).await,
        Err(error) => error,
    }
}

/// `DELETE /api/v1/tabs/{tab_id}/outbox` — the gallery's Delete all: every
/// file the desktop published to the phone in this tab's project, to free the
/// space. Same gates as one file's removal; `outbox::remove_all` clears only
/// what a read would serve, past the listing's cap too.
async fn outbox_clear(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(tab_id): Path<String>,
) -> impl IntoResponse {
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    match outbox_root(&state, &phone, &tab_id) {
        Ok(root) => outbox_clearing(root).await,
        Err(error) => error,
    }
}

/// `DELETE /api/v1/projects/{project_id}/outbox` — the same Delete all by the
/// project, for the project screen's gallery.
async fn project_outbox_clear(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
) -> impl IntoResponse {
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    match project_drop_box_root(&state, &phone, &project_id) {
        Ok(root) => outbox_clearing(root).await,
        Err(error) => error,
    }
}

async fn outbox_clearing(root: PathBuf) -> (StatusCode, Json<serde_json::Value>) {
    let cleared = tokio::task::spawn_blocking(move || outbox::remove_all(&root))
        .await
        .unwrap_or_else(|error| Err(outbox::OutboxError::Io(error.to_string())));
    match cleared {
        Ok(cleared) => (StatusCode::OK, Json(json!({ "removed": cleared.files, "freed": cleared.bytes }))),
        Err(outbox::OutboxError::Io(_)) => {
            api_error(StatusCode::INTERNAL_SERVER_ERROR, "delete_failed")
        }
        Err(error) => outbox_error(error),
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

async fn outbox_bytes(root: PathBuf, name: String, query: &HashMap<String, String>) -> Response<Body> {
    if !outbox::valid_name(&name) {
        return api_error(StatusCode::NOT_FOUND, "file_not_found").into_response();
    }
    let download = query.get("download").is_some_and(|v| v == "1");
    // Saved under the name it was sent as, not the stamped leaf.
    let filename = outbox::sent_name(&name).to_string();
    let read = tokio::task::spawn_blocking(move || outbox::read(&root, &name))
        .await
        .unwrap_or_else(|error| Err(outbox::OutboxError::Io(error.to_string())));
    let mut response = file_response(read, &filename, download);
    // A leaf can be rewritten under its name, so only a read the phone named
    // by its version (`?v=<modified>-<size>`, `outboxFileUrl`) may be kept:
    // without it the chat's album, the viewer and its Share each pulled the
    // whole picture down the link again, side by side.
    if response.status() == StatusCode::OK && !download && query.contains_key("v") {
        response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static(INBOX_FILE_CACHE));
    }
    response
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
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    let root = match outbox_root(&state, &phone, &tab_id) {
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
    let phone = match authenticate_or_ticket(&headers, &state, &uri) {
        Ok(phone) => phone,
        Err(error) => return error.into_response(),
    };
    let root = match outbox_root(&state, &phone, &tab_id) {
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
    let mut response = file_response(read, &filename, download);
    // A leaf carries its arrival stamp and is never rewritten, so the phone
    // may keep its picture: without this every API answer is `no-store` and
    // each remount of the chat pulled the whole original down the link again.
    if response.status() == StatusCode::OK && !download {
        response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static(INBOX_FILE_CACHE));
    }
    response
}

/// How long the phone may keep an inbox picture (`inbox_file`) or a
/// versioned outbox one (`outbox_bytes`): this device only, a day.
const INBOX_FILE_CACHE: &str = "private, max-age=86400, immutable";

/// `POST /api/v1/tabs/{tab_id}/markup` — the markup view's **Submit**
/// (`markup.rs`): the marks of a PDF or picture the phone marked up, whose
/// layer PNGs already went through this tab's inbox. Bakes a PDF's marked copy
/// into the same inbox and answers the prompt the phone sends into the chat.
/// The source is named by a sealed file token of this tab's project or an
/// outbox leaf, read only; the answer carries project-relative references and
/// never the root.
///
/// A request with `mode: "apply"` (**Apply marks directly**,
/// `docs/done/pdf_markup_direct_apply_plan.md`) takes an undo snapshot of the
/// project's work tree first (`services::markup_rounds`, owned by this tab and
/// its project; a remote project gets none). The answer adds `mode` (what the
/// round got), `undo` (the snapshot's id) and `noUndo` (why a requested
/// `apply` runs as `list`).
async fn markup_submit(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(tab_id): Path<String>,
    body: Bytes,
) -> impl IntoResponse {
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
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
        let catalog = match catalog(&state, &phone) {
            Ok(catalog) => catalog,
            Err(error) => return error,
        };
        let Some((project, tab)) = catalog.tab(&tab_id) else {
            return api_error(StatusCode::NOT_FOUND, "tab_not_found");
        };
        // The marked copy lands in the mirror's inbox, out of a host agent's reach.
        if let Err(error) = not_on_host(tab) {
            return error;
        }
        if let Err(error) = has_folder(project) {
            return error;
        }
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
    let state_dir = state.config.state_dir.clone();
    let owner = markup_rounds::Owner::Phone { tab: tab_id.clone(), project: raw_id.clone() };
    // Reads, a bake bounded by its own deadline, an inbox write, and an
    // `apply` round's snapshot (git calls bounded by theirs).
    let submitted = tokio::task::spawn_blocking(move || {
        let undo = if crate::services::remote::remote_target_for(&raw_id).is_some() {
            Err(markup_rounds::NoUndo::Remote)
        } else {
            Ok(markup::UndoTarget { state_dir: &state_dir, owner })
        };
        markup::submit_with_undo(&root, &source, &request, send_back, undo)
    })
    .await;
    match submitted {
        Ok(Ok(done)) => (
            StatusCode::OK,
            Json(json!({
                "prompt": done.prompt,
                "marked": done.marked,
                "mode": done.mode,
                "undo": done.undo,
                "noUndo": done.no_undo.map(markup_rounds::NoUndo::code),
            })),
        ),
        Ok(Err(markup::MarkupError::Files(error))) => files_error(error),
        Ok(Err(markup::MarkupError::Outbox(error))) => outbox_error(error),
        Ok(Err(error @ markup::MarkupError::Unsupported)) => api_error(StatusCode::UNSUPPORTED_MEDIA_TYPE, error.code()),
        Ok(Err(error)) => api_error(StatusCode::BAD_REQUEST, error.code()),
        Err(_) => api_error(StatusCode::INTERNAL_SERVER_ERROR, "markup_failed"),
    }
}

// ── Markup undo (`services::markup_rounds`, the phone's half) ───────────────

/// The owner of the undo snapshot `undo_id` a phone route names: this tab, of
/// this tab's project. A malformed id is `round_not_found`, as another tab's
/// round is (`markup_rounds::load`).
fn markup_undo_owner(state: &HostState, phone: &Phone, tab_id: &str, undo_id: &str) -> Result<markup_rounds::Owner, ApiRefusal> {
    if !markup_rounds::valid_id(undo_id) {
        return Err(api_error(StatusCode::NOT_FOUND, markup_rounds::RoundError::NotFound.code()));
    }
    let catalog = catalog(state, phone)?;
    let Some((project, _)) = catalog.tab(tab_id) else {
        return Err(api_error(StatusCode::NOT_FOUND, "tab_not_found"));
    };
    has_folder(project)?;
    Ok(markup_rounds::Owner::Phone { tab: tab_id.to_string(), project: project.raw_id.clone() })
}

/// A refused settle, preview or undo under the status the phone reads it by:
/// `undo_conflict` (409) carries the project-relative files changed since
/// and how many more.
fn markup_undo_error(error: markup_rounds::RoundError) -> ApiRefusal {
    let code = error.code();
    match error {
        markup_rounds::RoundError::Conflict { files, more } => {
            (StatusCode::CONFLICT, Json(json!({ "error": code, "files": files, "more": more })))
        }
        markup_rounds::RoundError::NotFound => api_error(StatusCode::NOT_FOUND, code),
        markup_rounds::RoundError::Gone => api_error(StatusCode::GONE, code),
        markup_rounds::RoundError::NotReady => api_error(StatusCode::CONFLICT, code),
        markup_rounds::RoundError::Failed => api_error(StatusCode::INTERNAL_SERVER_ERROR, code),
    }
}

/// One undo call for a phone route, after its gates: off the async runtime.
async fn markup_undo_call<T: Serialize + Send + 'static>(
    state: &HostState,
    phone: &Phone,
    tab_id: &str,
    undo_id: String,
    call: fn(&std::path::Path, &str, &markup_rounds::Owner) -> Result<T, markup_rounds::RoundError>,
) -> ApiRefusal {
    let owner = match markup_undo_owner(state, phone, tab_id, &undo_id) {
        Ok(owner) => owner,
        Err(error) => return error,
    };
    let state_dir = state.config.state_dir.clone();
    match tokio::task::spawn_blocking(move || call(&state_dir, &undo_id, &owner)).await {
        Ok(Ok(answer)) => (StatusCode::OK, Json(json!(answer))),
        Ok(Err(error)) => markup_undo_error(error),
        Err(_) => api_error(StatusCode::INTERNAL_SERVER_ERROR, "markup_failed"),
    }
}

/// `POST /api/v1/tabs/{tab_id}/markup/undo/{undo_id}/settle` → `{}` — the
/// round's after-snapshot, each time its turn finishes (the last one wins).
async fn markup_undo_settle(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path((tab_id, undo_id)): Path<(String, String)>,
) -> impl IntoResponse {
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    let settle = |dir: &std::path::Path, id: &str, owner: &markup_rounds::Owner| {
        markup_rounds::settle(dir, id, owner).map(|()| serde_json::Map::new())
    };
    markup_undo_call(&state, &phone, &tab_id, undo_id, settle).await
}

/// `GET /api/v1/tabs/{tab_id}/markup/undo/{undo_id}` → `{ files: [{ path,
/// change }], more, pdf, outsideMore }` — what an undo would put back,
/// project-relative (settles first when the round has not). Files changed
/// outside the project folder are only counted (`outsideMore`): a phone may
/// be scoped to this project, and those names can be a sibling's.
async fn markup_undo_preview(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path((tab_id, undo_id)): Path<(String, String)>,
) -> impl IntoResponse {
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    let preview = |dir: &std::path::Path, id: &str, owner: &markup_rounds::Owner| {
        markup_rounds::preview(dir, id, owner).map(markup_rounds::Changes::outside_counted)
    };
    markup_undo_call(&state, &phone, &tab_id, undo_id, preview).await
}

/// `POST /api/v1/tabs/{tab_id}/markup/undo/{undo_id}` → `{ files, more, pdf,
/// outsideMore }` — puts the round's changes back, or 409 `undo_conflict`
/// with the files changed since and nothing touched. Outside the project
/// folder: a count only, as the preview.
async fn markup_undo(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path((tab_id, undo_id)): Path<(String, String)>,
) -> impl IntoResponse {
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    if !exact_origin(&headers, &state) {
        return api_error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    let undo = |dir: &std::path::Path, id: &str, owner: &markup_rounds::Owner| {
        markup_rounds::undo(dir, id, owner).map(markup_rounds::Changes::outside_counted)
    };
    markup_undo_call(&state, &phone, &tab_id, undo_id, undo).await
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

/// A tick as `services::markup_mcp` records it: a round id a view minted
/// (`markup::valid_round`) and a 1-based page and mark within its bounds.
fn valid_tick(tick: &MobileMarkupTick) -> bool {
    markup::valid_round(&tick.round)
        && (1..=crate::services::markup_mcp::MAX_PAGE).contains(&tick.page)
        && (1..=crate::services::markup_mcp::MAX_MARK).contains(&tick.mark)
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
    phone: &Phone,
    tab_id: &str,
    source: Option<&str>,
) -> Result<(String, ResolvedTab, Option<String>), ApiRefusal> {
    let catalog = catalog(state, phone)?;
    let Some((project, tab)) = catalog.tab(tab_id) else {
        return Err(api_error(StatusCode::NOT_FOUND, "tab_not_found"));
    };
    has_folder(project)?;
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
/// card". Never an error the phone would show. A server daemon has no window
/// and serves the markup lane itself (`Runtime::serves_markup`), so it
/// answers from its own asks ([`markup_here`]).
async fn markup_call(state: &HostState, request: DesktopRequest, tab: &ResolvedTab) -> Result<DesktopResponse, ApiRefusal> {
    let response = if state.web.on_server() {
        Ok(markup_here(state, request, tab).await)
    } else {
        let desktop_socket = state.config.control_dir.join("desktop-control.sock");
        admin::desktop_call(&desktop_socket, &request).await
    };
    if desktop_down(&response) {
        return Err(api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"));
    }
    match response {
        Ok(DesktopResponse::Error { code, .. }) => Err(markup_desktop_error(&code)),
        Ok(answer) => Ok(answer),
        Err(_) => Err(api_error(StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable")),
    }
}

/// A markup request answered in this process — a server daemon's, which
/// holds the asks its tabs made (`services::markup_mcp`). The window's bridge
/// steps (`MobileBridgeHost.tsx`: `markupQuestionsFor`,
/// `answerMarkupFromPhone`, `dismissMarkupFromPhone`) over the same
/// `markup_mcp_*` commands, keyed by the tab's schedule target; an answer's
/// prompt is held for the tab as a phone prompt is with no window
/// (`headless::hold_prompt`), and a hold that fails reopens the ask.
async fn markup_here(state: &HostState, request: DesktopRequest, tab: &ResolvedTab) -> DesktopResponse {
    use crate::commands::markup_mcp as commands;
    use crate::services::markup_mcp::Answer;
    use super::protocol::{MobileMarkupAsk, MobileMarkupChoice, MobileMarkupQuestion};
    let error = |code: &str, message: &str| DesktopResponse::Error { code: code.to_string(), message: message.to_string() };
    let Some(target) = tab.schedule_target_id.clone().filter(|id| !id.is_empty()) else {
        return error("tab_not_found", "Agent tab is unavailable");
    };
    let ask_codes = ["superseded", "answered", "gone", "invalid_answer"];
    match request {
        DesktopRequest::MarkupQuestions { project_id, path, .. } => {
            let banner = path.is_none();
            let asks = commands::markup_mcp_list(project_id.clone(), target.clone(), path.clone()).await;
            let ticks = commands::markup_mcp_ticks(project_id, target, path).await.unwrap_or_default();
            let Ok(asks) = asks else { return error("markup_failed", "The markup questions could not be read") };
            DesktopResponse::MarkupQuestions {
                ticks: ticks.into_iter().map(|t| MobileMarkupTick { round: t.round, page: t.page, mark: t.mark }).collect(),
                asks: asks
                    .into_iter()
                    .map(|ask| MobileMarkupAsk {
                        id: ask.id,
                        file_name: ask.file_name,
                        path: if banner { ask.file } else { None },
                        file_row: None,
                        questions: ask
                            .questions
                            .into_iter()
                            .map(|q| MobileMarkupQuestion {
                                question: q.question,
                                header: q.header,
                                options: q.options.into_iter().map(|o| MobileMarkupChoice { label: o.label, description: o.description }).collect(),
                                multi_select: q.multi_select,
                                page: q.page,
                                quote: q.quote,
                            })
                            .collect(),
                    })
                    .collect(),
            }
        }
        DesktopRequest::MarkupAnswer { project_id, ask_id, answers, device_id, .. } => {
            let answers: Vec<Answer> = answers
                .into_iter()
                .map(|a| Answer { options: a.options.into_iter().map(|i| i as usize).collect(), other: a.other })
                .collect();
            let taken = match commands::markup_mcp_answer(project_id.clone(), target.clone(), ask_id.clone(), answers) {
                Ok(taken) => taken,
                Err(code) if ask_codes.contains(&code.as_str()) => return error(&code, "The agent's questions did not take this answer"),
                Err(code) => return error(&code, "The answer could not be taken"),
            };
            let state_dir = state.config.state_dir.clone();
            let held = headless::hold_prompt(&state_dir, &project_id, tab, &taken.prompt, device_id.as_deref(), chrono::Local::now());
            match held {
                Ok(held_id) => {
                    state.holds.hold(&held_id);
                    DesktopResponse::Seen
                }
                Err(why) => {
                    eprintln!("mobile: holding a markup answer failed: {why}");
                    match commands::markup_mcp_reopen(project_id, target, ask_id, taken.receipt) {
                        Ok(()) => error("delivery_failed", "The answer could not be queued; the questions are open again"),
                        Err(_) => error("not_delivered", "The answer could not be queued, and the questions have closed"),
                    }
                }
            }
        }
        DesktopRequest::MarkupDismiss { project_id, ask_id, .. } => match commands::markup_mcp_dismiss(project_id, target, ask_id) {
            Ok(()) => DesktopResponse::Seen,
            Err(code) if ask_codes.contains(&code.as_str()) => error(&code, "The agent's questions are no longer open"),
            Err(code) => error(&code, "The questions could not be closed"),
        },
        _ => error("unknown_request", "Not a markup request"),
    }
}

/// `GET /api/v1/tabs/{tab_id}/markup/questions[?source=…]` — the agent tab's
/// open markup question (`services::markup_mcp`) for the phone's markup card,
/// or every open one for the Focus banner. Each ask carries its random id,
/// its questions and its file's leaf name — never a path. Beside them,
/// `ticks: [{ round, page, mark }]`: the marks the agent ticked off with
/// `markup_done` for the same file (every file's for the banner), which the
/// phone maps onto the marks it sent in that round.
async fn markup_questions(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(tab_id): Path<String>,
    Query(query): Query<MarkupQuestionsQuery>,
) -> impl IntoResponse {
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    let (project_id, tab, path) = match markup_tab(&state, &phone, &tab_id, query.source.as_deref()) {
        Ok(target) => target,
        Err(error) => return error,
    };
    let banner = path.is_none();
    let request_id = new_request_id();
    let request = DesktopRequest::MarkupQuestions { request_id, project_id: project_id.clone(), tmux_session: tab.tmux_name.clone(), path };
    match markup_call(&state, request, &tab).await {
        Ok(DesktopResponse::MarkupQuestions { asks, ticks }) => {
            let ticks: Vec<_> = ticks.into_iter().filter(valid_tick).collect();
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
                let rows = markup_banner_files(&state, &phone, &tab_id, &project_id, paths).await;
                for (ask, row) in asks.iter_mut().zip(rows) {
                    ask.file_row = row;
                }
            }
            (StatusCode::OK, Json(json!({ "asks": asks, "ticks": ticks })))
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
async fn markup_banner_files(state: &HostState, phone: &Phone, tab_id: &str, raw_id: &str, paths: Vec<Option<String>>) -> Vec<Option<MobileMarkupFile>> {
    let none = || vec![None; paths.len()];
    if paths.iter().all(Option::is_none) || !files::files_open(&state.config.state_dir) {
        return none();
    }
    let Ok(catalog) = catalog(state, phone) else { return none() };
    let Some((project, _)) = catalog.tab(tab_id) else { return none() };
    if !is_git_project(project) || project.raw_id != raw_id {
        return none();
    }
    let root = project.root.clone();
    let raw_id = raw_id.to_string();
    let key = state.auth.lock_ok().host_key().to_vec();
    tokio::task::spawn_blocking(move || {
        paths
            .into_iter()
            .map(|path| file_row(&root, &path?, &key, &raw_id))
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// The project file at root-relative `rel` as the files drawer would row it
/// (`files::entry`, which proves it: a regular file reached with no link on
/// the way, nothing the browser hides), sealed with its folder's token and
/// the folder trail the phone keys its markup layer by. `None` for anything
/// the drawer would not list, and for the outbox — a copy there is the
/// gallery's, not a project file.
fn file_row(root: &std::path::Path, rel: &str, key: &[u8], raw_id: &str) -> Option<MobileMarkupFile> {
    if rel.starts_with(&format!("{}/", outbox::OUTBOX_DIR)) {
        return None;
    }
    let entry = files::entry(root, rel, key, raw_id)?;
    let place = rel.rsplit_once('/').map(|(parent, _)| parent.to_string()).unwrap_or_default();
    // No randomness for the folder token: left out, like the entry itself.
    let folder = if place.is_empty() { None } else { Some(files::seal(key, raw_id, &place).ok()?) };
    Some(MobileMarkupFile {
        token: entry.token,
        name: entry.name,
        kind: entry.kind.to_string(),
        size: entry.size,
        modified: entry.modified,
        folder,
        place,
    })
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
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    if let Err(error) = ai_off_guard(&state) {
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
    let (project_id, tab, _) = match markup_tab(&state, &phone, &tab_id, None) {
        Ok(target) => target,
        Err(error) => return error,
    };
    let request_id = new_request_id();
    let request = DesktopRequest::MarkupAnswer {
        request_id,
        project_id,
        tmux_session: tab.tmux_name.clone(),
        ask_id: request.ask_id,
        answers: request.answers,
        device_id: Some(phone.device_id().to_string()),
    };
    match markup_call(&state, request, &tab).await {
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
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
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
    let (project_id, tab, _) = match markup_tab(&state, &phone, &tab_id, None) {
        Ok(target) => target,
        Err(error) => return error,
    };
    let request_id = new_request_id();
    let request = DesktopRequest::MarkupDismiss { request_id, project_id, tmux_session: tab.tmux_name.clone(), ask_id: request.ask_id };
    match markup_call(&state, request, &tab).await {
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
    phone: &Phone,
    project_id: &str,
) -> Result<(PathBuf, String), (StatusCode, Json<serde_json::Value>)> {
    if !files::files_open(&state.config.state_dir) {
        return Err(api_error(StatusCode::NOT_FOUND, "files_off"));
    }
    let catalog = catalog(state, phone)?;
    let Some(project) = catalog.project(project_id) else {
        return Err(api_error(StatusCode::NOT_FOUND, "project_not_found"));
    };
    if !is_git_project(project) {
        return Err(api_error(StatusCode::NOT_FOUND, "files_unavailable"));
    }
    Ok((project.root.clone(), project.raw_id.clone()))
}

/// Whether a scope has a remote side the 📁 library may show: a remote (not
/// VM) project whose primary host has an absolute `remote_path`. Never on
/// Windows, which holds no ControlMaster to ride.
fn has_host_files(project: &super::discovery::ResolvedProject) -> bool {
    !cfg!(target_os = "windows")
        && project.public.kind == ScopeKind::Project
        && project.host == super::discovery::ProjectHost::Remote
        && project.primary_host.as_ref().is_some_and(|spec| host_files::root_of(spec).is_some())
}

/// Whether a file-browser request asks for the remote side (`?on=host`).
fn on_host_side(query: &HashMap<String, String>) -> bool {
    query.get("on").is_some_and(|side| side == "host")
}

/// What a remote-side request reads by: the host, its master's socket as the
/// refresher last found it, and the project's raw id.
type HostFilesScope = (crate::schema::project::RemoteSpec, Option<PathBuf>, String);

/// The [`HostFilesScope`] of a remote-side request — behind the same switch as
/// the local side; a scope with no remote side is `files_unavailable`.
fn host_files_scope(
    state: &HostState,
    phone: &Phone,
    project_id: &str,
) -> Result<HostFilesScope, (StatusCode, Json<serde_json::Value>)> {
    if !files::files_open(&state.config.state_dir) {
        return Err(api_error(StatusCode::NOT_FOUND, "files_off"));
    }
    let catalog = catalog(state, phone)?;
    let Some(project) = catalog.project(project_id) else {
        return Err(api_error(StatusCode::NOT_FOUND, "project_not_found"));
    };
    let Some(spec) = project.primary_host.clone().filter(|_| has_host_files(project)) else {
        return Err(api_error(StatusCode::NOT_FOUND, "files_unavailable"));
    };
    let known = state.catalog.lock_ok().host_control_path(&spec);
    Ok((spec, known, project.raw_id.clone()))
}

/// [`files_rel`] for a remote-side token.
fn host_files_rel(
    state: &HostState,
    raw_id: &str,
    token: Option<&String>,
) -> Result<String, (StatusCode, Json<serde_json::Value>)> {
    let Some(token) = token else {
        return Ok(String::new());
    };
    let key = state.auth.lock_ok().host_key().to_vec();
    host_files::unseal(&key, raw_id, token).ok_or_else(|| api_error(StatusCode::NOT_FOUND, "file_not_found"))
}

fn files_error(error: files::FilesError) -> (StatusCode, Json<serde_json::Value>) {
    api_error(
        match error {
            files::FilesError::Unavailable | files::FilesError::HostOffline => StatusCode::CONFLICT,
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
    let key = state.auth.lock_ok().host_key().to_vec();
    files::unseal(&key, raw_id, token).ok_or_else(|| api_error(StatusCode::NOT_FOUND, "file_not_found"))
}

/// `GET /api/v1/projects/{project_id}/files[?dir=<token>]` — one folder of the
/// project, read-only: sealed tokens, leaf names, kind, size, mtime. No `dir`
/// is the project root. No path appears in the answer. `uploads` says whether
/// **Upload here** may write into this folder (`project_files_upload`): the
/// switch is on and no segment of the folder starts with a dot.
///
/// `&on=host` lists the remote side instead: the project's tree on its
/// primary host (`host_files`), with host-side tokens and never `uploads`.
async fn project_files_list(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    if on_host_side(&query) {
        let (spec, known, raw_id) = match host_files_scope(&state, &phone, &project_id) {
            Ok(scope) => scope,
            Err(error) => return error,
        };
        let rel = match host_files_rel(&state, &raw_id, query.get("dir")) {
            Ok(rel) => rel,
            Err(error) => return error,
        };
        let key = state.auth.lock_ok().host_key().to_vec();
        return match state.host_files.list(&spec, known, rel, key, raw_id).await {
            // Read-only: Upload here never writes to the host.
            Ok(listing) => {
                let mut answer = json!(listing);
                answer["uploads"] = json!(false);
                (StatusCode::OK, Json(answer))
            }
            Err(error) => files_error(error),
        };
    }
    let (root, raw_id) = match files_scope(&state, &phone, &project_id) {
        Ok(scope) => scope,
        Err(error) => return error,
    };
    let rel = match files_rel(&state, &raw_id, query.get("dir")) {
        Ok(rel) => rel,
        Err(error) => return error,
    };
    let key = state.auth.lock_ok().host_key().to_vec();
    let accepts = uploads::accepts(&rel);
    // A directory walk that opens every kept file to type it: off the executor.
    let listed = tokio::task::spawn_blocking(move || files::list(&root, &rel, &key, &raw_id))
        .await
        .unwrap_or_else(|error| Err(files::FilesError::Io(error.to_string())));
    match listed {
        Ok(listing) => {
            let mut answer = json!(listing);
            answer["uploads"] = json!(accepts && uploads::uploads_open(&state.config.state_dir));
            (StatusCode::OK, Json(answer))
        }
        Err(error) => files_error(error),
    }
}

/// `GET /api/v1/projects/{project_id}/files/search?q=<words>` — the project's
/// files and folders whose names hold every word, each with the sealed trail
/// of folders above it (`files::search`). Read-only, like the listing; no
/// path appears in the answer, only the leaf names the drawer would show.
/// `&on=host` searches the remote side by a bounded walk (`host_files`).
async fn project_files_search(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let phone = match authenticate(&headers, &state) {
        Ok(phone) => phone,
        Err(error) => return error,
    };
    let q = query.get("q").cloned().unwrap_or_default();
    if on_host_side(&query) {
        let (spec, known, raw_id) = match host_files_scope(&state, &phone, &project_id) {
            Ok(scope) => scope,
            Err(error) => return error,
        };
        if q.len() > files::MAX_QUERY {
            return api_error(StatusCode::BAD_REQUEST, "query_too_long");
        }
        let key = state.auth.lock_ok().host_key().to_vec();
        return match state.host_files.search(&spec, known, q, key, raw_id).await {
            Ok(found) => (StatusCode::OK, Json(json!(found))),
            Err(error) => files_error(error),
        };
    }
    let (root, raw_id) = match files_scope(&state, &phone, &project_id) {
        Ok(scope) => scope,
        Err(error) => return error,
    };
    if q.len() > files::MAX_QUERY {
        return api_error(StatusCode::BAD_REQUEST, "query_too_long");
    }
    let key = state.auth.lock_ok().host_key().to_vec();
    // A git listing or a walk of the whole tree: off the executor.
    let found = tokio::task::spawn_blocking(move || files::search(&root, &q, &key, &raw_id))
        .await
        .unwrap_or_else(|error| Err(files::FilesError::Io(error.to_string())));
    match found {
        Ok(found) => (StatusCode::OK, Json(json!(found))),
        Err(error) => files_error(error),
    }
}

/// `GET /api/v1/projects/{project_id}/files/raw?f=<token>[&download=1]` — one
/// file's bytes, typed by its head as the outbox types them (active formats are
/// inert text), for the same viewer. Read-only; the browser's one write is
/// `project_files_upload`, which only adds new files. `&on=host` reads a
/// remote-side token's file from the host (`host_files`).
async fn project_files_raw(
    State(state): State<HostState>,
    headers: HeaderMap,
    uri: Uri,
    Path(project_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Response<Body> {
    let phone = match authenticate_or_ticket(&headers, &state, &uri) {
        Ok(phone) => phone,
        Err(error) => return error.into_response(),
    };
    let no_token = || api_error(StatusCode::NOT_FOUND, "file_not_found").into_response();
    let read = if on_host_side(&query) {
        let (spec, known, raw_id) = match host_files_scope(&state, &phone, &project_id) {
            Ok(scope) => scope,
            Err(error) => return error.into_response(),
        };
        let Some(token) = query.get("f") else { return no_token() };
        let rel = match host_files_rel(&state, &raw_id, Some(token)) {
            Ok(rel) => rel,
            Err(error) => return error.into_response(),
        };
        let leaf = rel.rsplit('/').next().unwrap_or_default().to_string();
        (leaf, state.host_files.read(&spec, known, rel).await)
    } else {
        let (root, raw_id) = match files_scope(&state, &phone, &project_id) {
            Ok(scope) => scope,
            Err(error) => return error.into_response(),
        };
        let Some(token) = query.get("f") else { return no_token() };
        let rel = match files_rel(&state, &raw_id, Some(token)) {
            Ok(rel) => rel,
            Err(error) => return error.into_response(),
        };
        let leaf = rel.rsplit('/').next().unwrap_or_default().to_string();
        let read = tokio::task::spawn_blocking(move || files::read(&root, &rel))
            .await
            .unwrap_or_else(|error| Err(files::FilesError::Io(error.to_string())));
        (leaf, read)
    };
    let (leaf, read) = read;
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

#[derive(Deserialize)]
struct UploadQuery {
    /// The folder's sealed token from its listing; none is the project root.
    #[serde(default)]
    dir: Option<String>,
    /// The phone's file name — a query parameter for the reason `InboxQuery`
    /// gives.
    #[serde(default)]
    name: String,
}

/// An upload's refusal as the phone's status (`uploads::UploadError::code`).
fn upload_error(error: uploads::UploadError) -> (StatusCode, Json<serde_json::Value>) {
    api_error(
        match error {
            uploads::UploadError::Off | uploads::UploadError::NotFound => StatusCode::NOT_FOUND,
            uploads::UploadError::Refused => StatusCode::FORBIDDEN,
            uploads::UploadError::Empty => StatusCode::BAD_REQUEST,
            uploads::UploadError::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            uploads::UploadError::Full => StatusCode::INSUFFICIENT_STORAGE,
            uploads::UploadError::Unavailable => StatusCode::CONFLICT,
            uploads::UploadError::Io(_) => StatusCode::INTERNAL_SERVER_ERROR,
        },
        error.code(),
    )
}

/// The project a file-browser write names, after the guards every write
/// shares: a session, the exact origin, the browser's scope (`files_off`,
/// a phone outside the project's list reads `project_not_found`), and the
/// upload switch (`uploads_off`), read per request.
fn upload_scope(
    state: &HostState,
    headers: &HeaderMap,
    project_id: &str,
) -> Result<(Phone, PathBuf, String), (StatusCode, Json<serde_json::Value>)> {
    let phone = authenticate(headers, state)?;
    if !exact_origin(headers, state) {
        return Err(api_error(StatusCode::FORBIDDEN, "invalid_origin"));
    }
    let (root, raw_id) = files_scope(state, &phone, project_id)?;
    if !uploads::uploads_open(&state.config.state_dir) {
        return Err(upload_error(uploads::UploadError::Off));
    }
    Ok((phone, root, raw_id))
}

/// `POST /api/v1/projects/{project_id}/files/upload?name=<leaf>[&dir=<token>]`
/// — the drawer's **Upload here**: the raw body becomes a new file in the
/// folder the phone stands in, under the phone's name (a clash takes a
/// `-2` suffix; nothing is overwritten). Add-only, into an existing folder
/// with no dot segment, logged for the desktop's notice and both undos
/// (`uploads.rs`). The answer is the new file's listing row.
async fn project_files_upload(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
    Query(query): Query<UploadQuery>,
    body: Bytes,
) -> impl IntoResponse {
    let (phone, root, raw_id) = match upload_scope(&state, &headers, &project_id) {
        Ok(scope) => scope,
        Err(error) => return error,
    };
    let rel_dir = match files_rel(&state, &raw_id, query.dir.as_ref()) {
        Ok(rel) => rel,
        Err(error) => return error,
    };
    // The device label for the desktop's notice, and the key the answer's
    // row is sealed with.
    let (label, key) = {
        let auth = state.auth.lock_ok();
        let label = auth.devices().into_iter().find(|device| device.id == phone.device_id()).map(|device| device.name);
        (label, auth.host_key().to_vec())
    };
    let state_dir = state.config.state_dir.clone();
    // Up to MAX_INBOX_FILE bytes written and hashed under the sidecar-wide
    // log lock: off the connection executor.
    let landed = tokio::task::spawn_blocking(move || {
        uploads::store(&state_dir, &root, &raw_id, &rel_dir, &query.name, &body, label.as_deref())
            .map(|landed| files::entry(&root, &landed.rel, &key, &raw_id))
    })
    .await
    .unwrap_or_else(|error| Err(uploads::UploadError::Io(error.to_string())));
    match landed {
        Ok(Some(file)) => (StatusCode::CREATED, Json(json!({ "file": file }))),
        Ok(None) => upload_error(uploads::UploadError::NotFound),
        Err(error) => upload_error(error),
    }
}

/// `DELETE /api/v1/projects/{project_id}/files/upload?f=<token>` — the landed
/// row's **Undo**: deletes the file only while the upload log names it and it
/// is byte-for-byte what the phone sent; anything else is `file_not_found`.
/// Answers `{ "undone": true }`.
async fn project_files_upload_undo(
    State(state): State<HostState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let (_, root, raw_id) = match upload_scope(&state, &headers, &project_id) {
        Ok(scope) => scope,
        Err(error) => return error,
    };
    let Some(token) = query.get("f") else {
        return upload_error(uploads::UploadError::NotFound);
    };
    let rel = match files_rel(&state, &raw_id, Some(token)) {
        Ok(rel) => rel,
        Err(error) => return error,
    };
    let state_dir = state.config.state_dir.clone();
    // Re-hashes the file (up to MAX_INBOX_FILE bytes): off the executor.
    let undone = tokio::task::spawn_blocking(move || uploads::undo(&state_dir, &root, &raw_id, &rel))
        .await
        .unwrap_or_else(|error| Err(uploads::UploadError::Io(error.to_string())));
    match undone {
        // A body, not a 204: the phone's `api()` reads every answer as JSON.
        Ok(()) => (StatusCode::OK, Json(json!({ "undone": true }))),
        Err(error) => upload_error(error),
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
    serve_asset(requested, embedded_asset)
}

/// One file of the bundle compiled into this binary. Every build, dev builds
/// included, serves the phone app from here alone: nothing on disk can stand
/// in for it (threat recheck 2026-10-08, gap 20).
fn embedded_asset(name: &str) -> Option<(bytes::Bytes, &'static str)> {
    MOBILE_ASSETS
        .iter()
        .find(|(asset, _, _)| *asset == name)
        .map(|(_, bytes, mime)| (bytes::Bytes::from_static(bytes), *mime))
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
    // Behind the gateway the socket is `wss:`; the CSP names it so.
    let secure = state.web.secure();
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
        .route("/api/v1/secrets", get(secrets_state))
        .route("/api/v1/secrets/enrol", post(secrets_enrol))
        .route("/api/v1/secrets/unlock", post(secrets_unlock_start))
        .route("/api/v1/secrets/unlock/finish", post(secrets_unlock_finish))
        .route("/api/v1/secrets/challenge", post(secrets_challenge))
        .route("/api/v1/secrets/repin", post(secrets_repin))
        .route("/api/v1/secrets/setup", post(secrets_setup))
        .route("/api/v1/secrets/recover", post(secrets_recover))
        .route("/api/v1/secrets/recovery-code", post(secrets_new_recovery_code))
        .route("/api/v1/mail", get(mail_overview))
        // Host-wide, no project or path: list, and load / unload / start.
        // A body is one action and at most one model name.
        .route(
            "/api/v1/local-models",
            get(local_models_list).merge(post(local_models_mutate).layer(DefaultBodyLimit::max(1024))),
        )
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
        .route("/api/v1/projects", get(projects).post(new_project))
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
        .route("/api/v1/projects/{project_id}/git", get(project_git))
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
        .route("/api/v1/tabs/{tab_id}/worktrees", get(tab_worktrees))
        .route("/api/v1/tabs/{tab_id}/worktree", post(move_tab_worktree))
        .route("/api/v1/tabs/{tab_id}/assistant-models", get(assistant_models))
        .route("/api/v1/tabs/{tab_id}/model-rows", get(model_rows).post(remember_model_rows))
        .route("/api/v1/tabs/{tab_id}/assistant-model", post(switch_assistant_model))
        .route("/api/v1/tabs/{tab_id}/sign-in", post(sign_in_tab))
        .route("/api/v1/tabs/{tab_id}/teleport", post(teleport_tab))
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
        .route("/api/v1/tabs/{tab_id}/uncommitted", get(tab_uncommitted))
        .route("/api/v1/tabs/{tab_id}/changes", get(tab_changes))
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
            "/api/v1/tabs/{tab_id}/markup/undo/{undo_id}",
            get(markup_undo_preview).post(markup_undo).layer(DefaultBodyLimit::max(1024)),
        )
        .route(
            "/api/v1/tabs/{tab_id}/markup/undo/{undo_id}/settle",
            post(markup_undo_settle).layer(DefaultBodyLimit::max(1024)),
        )
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
        .route("/api/v1/tabs/{tab_id}/outbox", get(outbox_list).delete(outbox_clear))
        .route(
            "/api/v1/tabs/{tab_id}/outbox/{name}",
            get(outbox_file).delete(outbox_delete),
        )
        .route("/api/v1/projects/{project_id}/files", get(project_files_list))
        .route("/api/v1/projects/{project_id}/files/raw", get(project_files_raw))
        .route("/api/v1/projects/{project_id}/files/search", get(project_files_search))
        .route(
            "/api/v1/projects/{project_id}/files/upload",
            delete(project_files_upload_undo)
                .merge(post(project_files_upload).layer(DefaultBodyLimit::max(inbox::MAX_INBOX_FILE))),
        )
        .route(
            "/api/v1/projects/{project_id}/outbox",
            get(project_outbox_list).delete(project_outbox_clear),
        )
        .route(
            "/api/v1/projects/{project_id}/outbox/{name}",
            get(project_outbox_file).delete(project_outbox_delete),
        )
        .route(PDF_FRAME_PATH, get(pdf_frame))
        .route("/", get(index))
        .route("/{*path}", get(static_asset))
        .with_state(state.clone())
        // The browser desktop client's routes (`/desktop/*`, its socket) sit
        // under the same limits and headers; `/desktop/…` outranks the PWA's
        // catch-all by its static prefix.
        .merge(web_client::routes(state.web))
        .layer(DefaultBodyLimit::max(MAX_CONTROL_MESSAGE))
        .layer(middleware::from_fn(feature_gate))
        .layer(middleware::from_fn_with_state(secure, security_headers))
}

/// The phone's mail, calendar and todo routes answer `403 feature_off` while
/// the admin or the user switched the feature off (hosted plan §6.7; always
/// on outside server mode).
async fn feature_gate(request: Request<Body>, next: Next) -> Response<Body> {
    use crate::services::server::{feature_on, Feature};
    let path = request.uri().path();
    let gated = |prefix: &str| path == prefix || path.starts_with(&format!("{prefix}/"));
    let off = (gated("/api/v1/mail") && !feature_on(Feature::Mail))
        || (gated("/api/v1/calendar") && !feature_on(Feature::Calendar))
        || (gated("/api/v1/todo") && !feature_on(Feature::Todo));
    if off {
        return api_error(StatusCode::FORBIDDEN, "feature_off").into_response();
    }
    next.run(request).await
}

/// Where the host listens.
pub enum Listen {
    /// The Mobile sidecar: loopback on `port`, Tailscale Serve in front, the
    /// user-content origin on the next port.
    Loopback { port: u16 },
    /// The per-user server daemon (hosted plan §3.1): a unix socket only
    /// `peer_uid` — the gateway — may connect to; the gateway's public host is
    /// what `Host` carries, and `/content/*` is served on this socket too, for
    /// the gateway to forward from `content_origin` (none → no tickets).
    Unix { path: PathBuf, peer_uid: Option<u32>, content_origin: Option<String> },
}

/// How often [`sweep_mcp_tokens`] looks, and how many looks in a row a tab's
/// session must be missing before its tokens go.
const MCP_SWEEP_EVERY: Duration = Duration::from_secs(60);
const MCP_SWEEP_MISSES: u8 = 3;

/// Revoke the MCP tokens of tabs this host started whose tmux session is gone
/// (`docs/headless_mcp_plan.md`): the window closed the tab, or something
/// killed the session. A CLI that merely exits does not end it — the session
/// runs a login shell after it — so its tokens live as long as the session,
/// as a window tab's live as long as its PTY. The window revokes on its own
/// PTY's exit; here no PTY is ours, so the tmux server is asked. Several
/// misses in a row, so a briefly unreachable server does not cost a live tab
/// its tools; counted per token generation, so a tab the scheduler restarts
/// meanwhile keeps its new tokens.
async fn sweep_mcp_tokens(runner: Arc<dyn scheduler::Runner>, mut shutdown: tokio::sync::watch::Receiver<bool>) {
    let mut missed = HashMap::new();
    let mut every = tokio::time::interval(MCP_SWEEP_EVERY);
    // After a suspend, one look, not a burst that spends every miss at once.
    every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = every.tick() => {}
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() { return; }
                continue;
            }
        }
        let held = crate::services::root_mcp::token_generations();
        let probe = runner.clone();
        let tabs: Vec<String> = held.iter().map(|(tab, _)| tab.clone()).collect();
        let Ok(alive) = tokio::task::spawn_blocking(move || {
            tabs.into_iter().filter(|tab| headless_session_alive(tab, |tmux| probe.probe(tmux).is_some())).collect::<std::collections::HashSet<_>>()
        })
        .await
        else {
            continue;
        };
        for (_, sessions) in mcp_sweep_step(&mut missed, &held, |tab| alive.contains(tab)) {
            // Only the generation that was missing: a token registered after
            // this look's snapshot (a restart) has another session id.
            for id in sessions {
                let _ = crate::services::root_mcp::revoke_session(&id);
            }
        }
    }
}

/// Whether `tab`'s session may still be running: a headless launch id whose
/// tmux session answers, or an id this host cannot check (kept).
fn headless_session_alive(tab: &str, probe: impl Fn(&str) -> bool) -> bool {
    tab.strip_prefix(headless::LAUNCH_ID_PREFIX).is_none_or(probe)
}

/// One tab's tokens at one look: its id and the session ids it holds.
type Generation = (String, Vec<String>);

/// One look of the sweep: the generations whose tab's session has now been
/// missing [`MCP_SWEEP_MISSES`] looks in a row. `missed` carries the count
/// between looks, keyed by generation, and forgets what is no longer held —
/// a restarted tab's new tokens start from zero.
fn mcp_sweep_step(missed: &mut HashMap<Generation, u8>, held: &[Generation], alive: impl Fn(&str) -> bool) -> Vec<Generation> {
    missed.retain(|generation, _| held.contains(generation));
    let mut gone = Vec::new();
    for generation in held {
        if alive(&generation.0) {
            missed.remove(generation);
            continue;
        }
        let count = missed.entry(generation.clone()).or_insert(0);
        *count += 1;
        if *count >= MCP_SWEEP_MISSES {
            missed.remove(generation);
            gone.push(generation.clone());
        }
    }
    gone
}

pub async fn run(state_dir: PathBuf) -> Result<(), String> {
    let config = HostConfig::load(&state_dir)?;
    verify_tailscale_serve(&config.origin, config.host.port)?;
    let port = config.host.port;
    // The sidecar launches agents headlessly with no window to have run the
    // startup sweep of login files that fail their CLI's content check.
    crate::services::agent_auth::sweep_unadmissible();
    enable_background_relays();
    run_with(config, Listen::Loopback { port }).await
}

/// Whether [`run_with`] starts this process's background relays (below).
static BACKGROUND_RELAYS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Let [`run_with`] start the process-wide background work a host owns
/// beside its listener: the agent turn relay (`services::agent_turn`, for
/// the browser clients — the window's own relay feeds only the window) and,
/// in the server daemon, the usage samplers the window would run. Called by
/// the real entry points only (the sidecar's [`run`], the daemon's `main`):
/// a test serving a host must not watch or write the real state dir.
pub fn enable_background_relays() {
    BACKGROUND_RELAYS.store(true, std::sync::atomic::Ordering::Relaxed);
}

/// Start the relays [`enable_background_relays`] allowed. The turn relay
/// only reads the hooks' records and emits to this process's own clients, so
/// the window and the sidecar may each run one; the usage samplers write
/// `usage_stats`/net-usage files, so only a server (no window) runs them —
/// and the drop-box sweep, which the window runs otherwise.
fn start_background_relays(core_ctx: &app_core::CoreCtx, state_dir: &std::path::Path, browser_clients: bool, server: bool) {
    if !BACKGROUND_RELAYS.load(std::sync::atomic::Ordering::Relaxed) {
        return;
    }
    if browser_clients || server {
        crate::services::agent_turn::start(core_ctx.clone());
        // The browser Reader's transcript watches (`transcript-changed`), as
        // the window installs its own: this process's `agent_tab_transcript`
        // arms them, and without a sink the panel would only poll.
        let events = core_ctx.clone();
        crate::services::transcript_watch::install(move |id| events.emit("transcript-changed", id));
    }
    if server {
        if let Some(pool) = core_ctx.state.try_get::<crate::services::remote::RemotePoolState>() {
            crate::services::net_usage::start(pool.clone());
        }
        if let Some(watch) = core_ctx.state.try_get::<crate::services::usage_stats::UsageWatchState>() {
            crate::services::usage_stats::start(watch.clone());
        }
        super::drop_sweep::start(state_dir.to_path_buf());
    }
}

/// The host's whole life on `listen`: the sidecar's and the daemon's one body.
pub async fn run_with(config: HostConfig, listen: Listen) -> Result<(), String> {
    let state_dir = config.state_dir.clone();
    let auth = Arc::new(Mutex::new(AuthStore::open(
        &config.control_dir,
        config.origin.clone(),
    )?));
    // This process as a host of `app_core` (hosted plan §10 P2): the core's
    // runtime seam points at this runtime, TLS has its provider before any
    // client is built, and the browser clients are the event sink of a system
    // context over fresh singletons. The window's own singletons live in the
    // window's process; nothing here shares them.
    app_core::rt::install(tokio::runtime::Handle::current());
    crate::services::mail_engine::install_crypto_provider();
    let web_events = Arc::new(web_client::WebEvents::default());
    let core_ctx = app_core::CoreCtx::system(Arc::new(crate::standalone_core_state()), web_events.clone());
    let mut web = web_client::WebClientState::new(
        config.host.browser_client == Some(true),
        core_ctx.clone(),
        web_events,
        &config.control_dir,
        config.host.port,
        web_client::bundle_source(&config.control_dir),
    );
    if let Listen::Unix { content_origin, .. } = &listen {
        web = web.behind_gateway(web_client::ServerLink {
            public_host: crate::services::server::host_of(&config.origin),
            content_origin: content_origin.clone(),
            auth: auth.clone(),
        });
    }
    start_background_relays(&core_ctx, &config.state_dir, web.enabled, matches!(listen, Listen::Unix { .. }));
    if web.enabled {
        match (&web.bundle, web.has_token(), &listen) {
            (Some(bundle), _, Listen::Unix { .. }) => eprintln!("desktop client: serving {} at {}/desktop/ behind the gateway", bundle.label(), config.origin),
            (Some(bundle), true, Listen::Loopback { port }) => eprintln!(
                "desktop client: serving {} at http://127.0.0.1:{port}/desktop/ (sign in with the link in Settings → Mobile → Browser access, or the token in {})",
                bundle.label(),
                config.control_dir.join(web_client::TOKEN_FILE).display()
            ),
            (None, _, _) => eprintln!("desktop client: on, but no web bundle was found (npm run web:bundle)"),
            (_, false, _) => eprintln!("desktop client: on, but no login token could be written"),
        }
    }
    // The remote hosts' reachability (`host_live`): written by its refresher,
    // read by every catalog load.
    let host_live: host_live::SharedHostLive = Arc::default();
    let state = HostState {
        config: config.clone(),
        auth: auth.clone(),
        catalog: Arc::new(Mutex::new(CatalogCache::with_host_live(host_live.clone()))),
        terminal_registry: TerminalRegistry::default(),
        spawner: HeadlessSpawner::default(),
        readings: Arc::new(Mutex::new(headless::ReadingCache::default())),
        runner: Arc::new(scheduler::TmuxRunner::new(&state_dir, None)),
        holds: Arc::default(),
        web: web.clone(),
        git_overview: Arc::default(),
        worktree_spots: Arc::default(),
        host_files: Arc::default(),
        host_kick: Arc::default(),
    };
    let (shutdown_tx, mut shutdown_rx) = tokio::sync::watch::channel(false);
    // The user-content origin (plan §3.5): ticketed files on the next port,
    // a different origin from the app's, so a project's HTML never runs on
    // it. Only with the browser client on; a bind failure is reported, not
    // fatal — the app runs without "open outside".
    if web.enabled && matches!(listen, Listen::Loopback { .. }) {
        let content_address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), web.content_port);
        match tokio::net::TcpListener::bind(content_address).await {
            Ok(listener) => {
                let content_app = web_client::content_routes(web.clone());
                let mut content_shutdown = shutdown_tx.subscribe();
                tokio::spawn(async move {
                    let _ = axum::serve(limits::GuardedListener::new(listener), content_app)
                        .with_graceful_shutdown(async move {
                            while !*content_shutdown.borrow() {
                                if content_shutdown.changed().await.is_err() {
                                    break;
                                }
                            }
                        })
                        .await;
                });
            }
            Err(error) => eprintln!("desktop client: user-content origin: bind {content_address}: {error}"),
        }
    }
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
        state_dir: Some(state_dir.clone()),
    };
    tokio::spawn(async move {
        let _ = admin::serve(&admin_path, admin_context).await;
    });
    // The agent MCP servers of the tabs this host spawns with no window open
    // (`docs/headless_mcp_plan.md`): schedule, push and help on a listener of
    // its own, bound here, before the scheduler's first restart can need it.
    // A server daemon has no window at all, so its listener serves every
    // lane the window would — root, reader and markup too — with this host's
    // context: the browser client's review, session and markup commands and
    // the phone's markup routes (`markup_call`) read the same state here.
    // This process never reads the git token from the keychain.
    crate::services::git_push_mcp::serve_without_keyring();
    let notice_dir = config.control_dir.clone();
    let on_server = matches!(listen, Listen::Unix { .. });
    let listener = crate::commands::root_mcp::start_headless(
        Arc::new(move |notice| {
            if notice == crate::commands::root_mcp::Notice::Schedules {
                poke_desktop(&notice_dir, None, &["schedules"]);
            }
        }),
        on_server.then_some(&core_ctx),
        shutdown_tx.subscribe(),
    )
    .await;
    if let Err(error) = listener {
        eprintln!("mobile: the agent MCP servers are unavailable to tabs started here until a retry binds: {error}");
    }
    tokio::spawn(sweep_mcp_tokens(state.runner.clone(), shutdown_tx.subscribe()));
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
    // The host liveness refresher reads ssh's view of this user's masters:
    // the real entry points only, like the relays (a test serving a host
    // builds its snapshot by hand).
    if BACKGROUND_RELAYS.load(std::sync::atomic::Ordering::Relaxed) {
        tokio::spawn(host_live::run(state.config.state_dir.clone(), state.auth.clone(), host_live, state.host_kick.clone(), shutdown_tx.subscribe()));
    }
    if matches!(listen, Listen::Loopback { .. }) {
        let publisher_shutdown = shutdown_tx.clone();
        let publisher_origin = config.origin.clone();
        let publisher_failure = serve_failure.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(30));
            interval.tick().await;
            loop {
                interval.tick().await;
                if let Err(error) = verify_tailscale_serve(&publisher_origin, port) {
                    *publisher_failure.lock_ok() = Some(error);
                    let _ = publisher_shutdown.send(true);
                    break;
                }
            }
        });
    }
    let shutdown = async move {
        while !*shutdown_rx.borrow() {
            if shutdown_rx.changed().await.is_err() {
                break;
            }
        }
    };
    match listen {
        Listen::Loopback { port } => {
            let app = router(state);
            let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
            let listener = tokio::net::TcpListener::bind(address)
                .await
                .map_err(|e| format!("bind {address}: {e}"))?;
            axum::serve(limits::GuardedListener::new(listener), app)
                .with_graceful_shutdown(shutdown)
                .await
                .map_err(|e| e.to_string())?;
        }
        #[cfg(unix)]
        Listen::Unix { path, peer_uid, .. } => {
            // The content routes ride the same socket: the gateway forwards
            // `/content/*` from the user-content origin here.
            let app = router(state).merge(web_client::content_routes(web.clone()));
            let (listener, inherited) = bind_unix(&path)?;
            axum::serve(limits::PeerGatedUnixListener::new(listener, peer_uid), app)
                .with_graceful_shutdown(shutdown)
                .await
                .map_err(|e| e.to_string())?;
            // A socket systemd made (socket activation) is systemd's to keep.
            if !inherited {
                let _ = std::fs::remove_file(&path);
            }
        }
        #[cfg(not(unix))]
        Listen::Unix { .. } => return Err("the per-user daemon runs on Linux only".into()),
    }
    // Nothing outlives a clean stop: the PTYs browser clients spawned here
    // (tmux attach clients, mostly — the sessions live on) go with the
    // process, as the window's do at its exit.
    if let Some(registry) = core_ctx.state.try_get::<crate::terminal::RegistryState>() {
        registry.lock_ok().kill_all();
    }
    if let Some(error) = serve_failure.lock_ok().take() {
        return Err(format!("Tailscale Serve verification failed: {error}"));
    }
    Ok(())
}

/// Bind the daemon's socket. In a deployment the socket unit always makes
/// it (below); binding here is the unprivileged path tests and a hand-run
/// daemon use: a stale file is removed first and the new one is `0660`.
///
/// Under socket activation (`<slug>-serverd@.socket`) systemd already made
/// the socket — `root:<slug>-gw 0660` in a directory only root and the
/// gateway's group may enter — and passes it as fd 3; it is adopted as is
/// (`true`), never re-bound, and never removed at exit.
#[cfg(unix)]
fn bind_unix(path: &std::path::Path) -> Result<(tokio::net::UnixListener, bool), String> {
    use std::os::unix::fs::PermissionsExt;
    if let Some(fd) = crate::services::server::activation_fd(|k| std::env::var(k).ok(), std::process::id()) {
        let listener = adopt_activation_fd(fd)?;
        std::env::remove_var("LISTEN_PID");
        std::env::remove_var("LISTEN_FDS");
        std::env::remove_var("LISTEN_FDNAMES");
        return Ok((listener, true));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    match std::fs::remove_file(path) {
        Ok(()) | Err(_) => {}
    }
    let listener = tokio::net::UnixListener::bind(path).map_err(|e| format!("bind {}: {e}", path.display()))?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o660)).map_err(|e| format!("chmod {}: {e}", path.display()))?;
    Ok((listener, false))
}

/// Take over the listening socket systemd passed as `fd`. systemd hands it
/// over without `FD_CLOEXEC` (it had to survive the exec); left so, every
/// child this daemon spawns — git, an installer, a tmux that starts its own
/// server — would inherit the listening socket and could accept the
/// gateway's connections in the daemon's place. So it is set first.
#[cfg(unix)]
fn adopt_activation_fd(fd: i32) -> Result<tokio::net::UnixListener, String> {
    use std::os::unix::io::FromRawFd;
    // SAFETY: F_SETFD on the descriptor systemd passed this process.
    if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } != 0 {
        return Err(format!("activation socket: {}", std::io::Error::last_os_error()));
    }
    // SAFETY: systemd hands this process `fd` as its listening socket
    // (LISTEN_PID matched); nothing else in the process owns it.
    let std_listener = unsafe { std::os::unix::net::UnixListener::from_raw_fd(fd) };
    std_listener.set_nonblocking(true).map_err(|e| format!("activation socket: {e}"))?;
    tokio::net::UnixListener::from_std(std_listener).map_err(|e| format!("activation socket: {e}"))
}

#[cfg(test)]
mod tests;

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

#[cfg(test)]
mod embedded_bundle_tests {
    use super::*;
    use axum::body::to_bytes;

    /// Threat recheck 2026-10-08, gap 20: the phone app comes from the bundle
    /// compiled into the binary and nowhere else. The dev-only overlay that
    /// served `target/mobile-pwa/` (any agent could write there) is gone, and
    /// the generated asset table names no folder to read one from.
    #[tokio::test]
    async fn the_phone_app_is_served_from_the_binary_only() {
        let generated = include_str!(concat!(env!("OUT_DIR"), "/mobile_assets.rs"));
        assert_eq!(generated.matches("pub ").count(), 1, "only MOBILE_ASSETS is generated");
        assert!(generated.starts_with("pub static MOBILE_ASSETS:"));

        let embedded = |name: &str| {
            MOBILE_ASSETS.iter().find(|(asset, _, _)| *asset == name).map(|(_, bytes, _)| bytes.to_vec())
        };
        let body = |response: Response<Body>| async move {
            let status = response.status();
            (status, to_bytes(response.into_body(), usize::MAX).await.unwrap().to_vec())
        };
        let shell = embedded("/index.html").expect("an index is always embedded");
        for path in ["/", "/index.html", "/some/app/route"] {
            assert_eq!(body(asset_response(path)).await, (StatusCode::OK, shell.clone()), "{path}");
        }
        assert_eq!(body(asset_response("/assets/index-planted.js")).await.0, StatusCode::NOT_FOUND);
        let frame = body(pdf_frame(HeaderMap::new()).await).await;
        match embedded(PDF_FRAME_PATH) {
            Some(bytes) => assert_eq!(frame, (StatusCode::OK, bytes)),
            None => assert_eq!(frame.0, StatusCode::NOT_FOUND),
        }
    }
}
