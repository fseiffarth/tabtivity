//! The browser desktop client's transport — hosted plan §3.5 and §10 P2
//! (`docs/tabtivity_hosted_plan.md`), served by the Mobile sidecar.
//!
//! The desktop React app, built with `src/main-web.tsx`, runs in an ordinary
//! browser and reaches the backend through one WebSocket per page instead of
//! Tauri's IPC. This module is that socket's server side and the routes around
//! it:
//!
//! * `GET /desktop/`, `/desktop/{*path}` — the web bundle (`web-dist/`, read
//!   from disk: `<ENV_PREFIX>WEB_DIST`, else the dev checkout's `web-dist/`,
//!   else `<control_dir>/web-dist`); the SPA fallback never covers `assets/`.
//! * `GET /desktop/login?token=…` — the one way in: the token lives in
//!   `<control_dir>/web-client.token` (`0600`, the same trust as the admin
//!   socket next to it — the state dir is masked inside every agent fence), and
//!   a right answer sets the session cookie (`brand::DESKTOP_SESSION_COOKIE`,
//!   `HttpOnly; SameSite=Strict`) and redirects to the app.
//! * `GET /api/v1/desktop/ws` — the socket. Frames (text, JSON):
//!   `→ {t:"call", id, cmd, args}` / `← {t:"ret", id, ok | err}`,
//!   `→ {t:"sub"|"unsub", name}` / `← {t:"event", name, payload}`,
//!   `→ {t:"emit", name, payload}` (rebroadcast to the user's other clients),
//!   `← {t:"hello", client, protocol, capabilities}` first. Binary frames
//!   (`[u8 kind][u32be id][payload]`) carry a raw call body in (`KIND_CALL`:
//!   `[u32be hlen][header JSON {cmd, headers}][bytes]` — `write_file_bytes`)
//!   and a raw answer out (`KIND_RET`: the bytes — `read_file_bytes`), so a
//!   file never crosses as a JSON number array.
//! * `GET /content/{ticket}` on the **user-content origin** — a second
//!   listener on the next port — serves a file by short-lived ticket with
//!   `Content-Security-Policy: sandbox` and active types as attachments, so a
//!   project's HTML never runs on the app's own origin.
//!
//! **Localhost only (P2).** Every route here refuses a request whose `Host` is
//! not a loopback literal on the expected port, and the socket also requires
//! an exact loopback `Origin`; a request forwarded by Tailscale Serve carries
//! the tailnet host and is answered 404. Nothing of this is reachable beyond
//! the machine until the CSP review and the §11 security review are done.
//!
//! **Who the caller is.** Every call runs with `Caller::Client(<id>)`, the
//! connection's id (`web-<n>`), which is also the "window label" the terminal
//! router keys viewer registrations by; a reconnect within [`RESUME_GRACE`]
//! (`?resume=<id>`) keeps the id — also when the server has not yet noticed
//! the old link die, in which case the stale connection is superseded — so a
//! page that lost its link keeps its PTYs and views. A client gone for longer
//! has its views dropped and the PTYs it spawned killed (they are tmux attach
//! clients; the sessions live on); a PTY id another page re-spawned meanwhile
//! has moved to that page and is left alone. The role is [`Role::Admin`]:
//! P2's one user owns the box; P3 assigns roles.
//!
//! **Backpressure.** Each client has a bounded event queue. A full queue drops
//! the event — terminal output is shed oldest-first the way `pty_bridge` sheds
//! it (TUIs repaint; `pty_scrollback` catches a pane up) — and counts it;
//! answers to calls travel on their own channel, bounded by the number of
//! calls in flight ([`MAX_CALLS_IN_FLIGHT`]), so a slow screen never loses a
//! `ret`.

use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, PoisonError,
    },
    time::{Duration, Instant},
};

use app_core::{Caller, ClientId, CoreCtx, EventSink};
use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path as RoutePath, Query, State,
    },
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Redirect, Response},
    routing::get,
    Router,
};
use base64ct::{Base64UrlUnpadded, Encoding};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio::sync::{mpsc, Semaphore};

use crate::services::core_dispatch::{self, Role};

/// The frame protocol version, in `hello` and `server_capabilities`.
pub const PROTOCOL: u32 = 1;
/// Frames queued per client before events are shed.
pub const EVENT_QUEUE: usize = 512;
/// Calls one client may have unanswered; the (n+1)th waits.
pub const MAX_CALLS_IN_FLIGHT: usize = 256;
/// The largest frame a client may send: a `write_file_bytes` body plus its
/// header, matched to the viewer's own read limit (`fs::MAX_BINARY_VIEW_BYTES`).
pub const MAX_INBOUND_FRAME: usize = 256 * 1024 * 1024 + 64 * 1024;
/// How long a disconnected client keeps its id, views and PTYs.
pub const RESUME_GRACE: Duration = Duration::from_secs(90);
/// How long a content ticket may be fetched.
pub const TICKET_TTL: Duration = Duration::from_secs(5 * 60);
/// The most tickets held at once; the oldest goes when a new one is minted.
const MAX_TICKETS: usize = 256;
/// Login failures tolerated per [`FAILURE_WINDOW`] before every attempt waits.
const MAX_LOGIN_FAILURES: usize = 10;
const FAILURE_WINDOW: Duration = Duration::from_secs(60);
/// A session idles out like the phone's (`auth::SESSION_IDLE`) and ends at
/// `auth::SESSION_MAX` whatever happens.
const SESSION_IDLE: Duration = Duration::from_secs(super::auth::SESSION_IDLE);
const SESSION_MAX: Duration = Duration::from_secs(super::auth::SESSION_MAX);
/// WebSocket ping cadence; a client that answers none in two rounds is gone.
const PING_INTERVAL: Duration = Duration::from_secs(20);

/// Binary frame kinds, byte 0.
pub const KIND_CALL: u8 = 1;
pub const KIND_RET: u8 = 2;

/// The login token's file name under the control dir.
pub const TOKEN_FILE: &str = "web-client.token";
/// The commands the transport answers itself, before the dispatcher.
pub const CAPABILITIES_CMD: &str = "server_capabilities";
pub const FILE_TICKET_CMD: &str = "desktop_file_ticket";
/// A picked server file as a single-use grant for the mail file commands
/// (`services::pick_grants`): `{path} → {grant}`.
pub const FILE_GRANT_CMD: &str = "desktop_file_grant";

// ── Clients and events ───────────────────────────────────────────────────

/// One frame on its way to a client.
#[derive(Clone, Debug)]
pub enum Outbound {
    Text(Arc<str>),
    Binary(Arc<[u8]>),
}

struct ClientLink {
    tx: mpsc::Sender<Outbound>,
    subs: HashSet<String>,
    /// Events dropped on a full queue, for the journal and the tests.
    dropped: u64,
}

/// The connected browser clients, as the core's [`EventSink`]: an event
/// reaches every client that subscribed to its name, already serialized once.
#[derive(Default)]
pub struct WebEvents {
    clients: Mutex<HashMap<ClientId, ClientLink>>,
}

impl WebEvents {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<ClientId, ClientLink>> {
        self.clients.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn attach(&self, client: &ClientId, tx: mpsc::Sender<Outbound>) {
        self.lock().insert(client.clone(), ClientLink { tx, subs: HashSet::new(), dropped: 0 });
    }

    /// Forget the client; returns how many events it lost to a full queue.
    pub fn detach(&self, client: &ClientId) -> u64 {
        self.lock().remove(client).map(|l| l.dropped).unwrap_or(0)
    }

    pub fn subscribe(&self, client: &ClientId, name: &str) {
        if let Some(link) = self.lock().get_mut(client) {
            link.subs.insert(name.to_string());
        }
    }

    pub fn unsubscribe(&self, client: &ClientId, name: &str) {
        if let Some(link) = self.lock().get_mut(client) {
            link.subs.remove(name);
        }
    }

    pub fn connected(&self) -> Vec<ClientId> {
        self.lock().keys().cloned().collect()
    }

    /// Queue `frame` for every client `pick` selects. A full queue drops the
    /// frame for that client only.
    fn fan_out(&self, frame: Outbound, pick: impl Fn(&ClientId, &ClientLink) -> bool) {
        let mut clients = self.lock();
        for (id, link) in clients.iter_mut() {
            if !pick(id, link) {
                continue;
            }
            if link.tx.try_send(frame.clone()).is_err() {
                link.dropped += 1;
            }
        }
    }

    /// Rebroadcast a frontend `emit` to the user's other clients.
    pub fn rebroadcast(&self, from: &ClientId, event: &str, payload: &Value) {
        let frame = event_frame(event, &payload.to_string());
        self.fan_out(frame, |id, link| id != from && link.subs.contains(event));
    }
}

/// `{"t":"event","name":…,"payload":…}` with the payload spliced in as it is.
fn event_frame(event: &str, payload: &str) -> Outbound {
    let name = serde_json::to_string(event).unwrap_or_else(|_| "\"\"".into());
    Outbound::Text(format!("{{\"t\":\"event\",\"name\":{name},\"payload\":{payload}}}").into())
}

impl EventSink for WebEvents {
    fn emit_json(&self, event: &str, payload: String) {
        // Nobody listening is the common case for most names; skip the frame.
        if !self.lock().values().any(|l| l.subs.contains(event)) {
            return;
        }
        self.fan_out(event_frame(event, &payload), |_, link| link.subs.contains(event));
    }

    fn emit_json_to(&self, client: &ClientId, event: &str, payload: String) {
        self.fan_out(event_frame(event, &payload), |id, link| id == client && link.subs.contains(event));
    }
}

// ── Sessions ─────────────────────────────────────────────────────────────

struct Session {
    created: Instant,
    expires: Instant,
}

/// The browser sessions. Separate from the phone's `AuthStore`: a different
/// cookie, a different way in (the token file, not a device key), and nothing
/// of it must ever be accepted by a phone route or vice versa.
#[derive(Default)]
pub struct WebSessions {
    sessions: HashMap<String, Session>,
    failures: VecDeque<Instant>,
}

impl WebSessions {
    /// A new session token (base64url of 32 random bytes).
    pub fn login(&mut self) -> Result<String, String> {
        let token = random_token()?;
        let now = Instant::now();
        self.sessions.insert(token.clone(), Session { created: now, expires: now + SESSION_IDLE });
        Ok(token)
    }

    /// Is `token` a live session? Slides the idle deadline.
    pub fn touch(&mut self, token: &str) -> bool {
        let now = Instant::now();
        let Some(session) = self.sessions.get_mut(token) else { return false };
        if session.expires <= now {
            self.sessions.remove(token);
            return false;
        }
        session.expires = (now + SESSION_IDLE).min(session.created + SESSION_MAX);
        true
    }

    /// Note a failed login; `true` when the caller must be refused outright
    /// because too many failed recently.
    pub fn note_failure(&mut self) -> bool {
        let now = Instant::now();
        while self.failures.front().is_some_and(|t| now.duration_since(*t) > FAILURE_WINDOW) {
            self.failures.pop_front();
        }
        self.failures.push_back(now);
        self.failures.len() > MAX_LOGIN_FAILURES
    }

    pub fn locked_out(&self) -> bool {
        let now = Instant::now();
        self.failures.iter().filter(|t| now.duration_since(**t) <= FAILURE_WINDOW).count() > MAX_LOGIN_FAILURES
    }

    pub fn logout(&mut self, token: &str) {
        self.sessions.remove(token);
    }
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut bytes);
    Ok(Base64UrlUnpadded::encode_string(&bytes))
}

/// The login token: read from `<control_dir>/web-client.token`, minted (`0600`)
/// when there is none yet. The desktop window and the sidecar both call this,
/// so whichever runs first writes the file the other reads.
pub fn login_token(control_dir: &Path) -> Result<String, String> {
    let path = control_dir.join(TOKEN_FILE);
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let existing = existing.trim();
        if existing.len() >= 32 {
            return Ok(existing.to_string());
        }
    }
    std::fs::create_dir_all(control_dir).map_err(|e| format!("create {}: {e}", control_dir.display()))?;
    let token = random_token()?;
    write_private(&path, token.as_bytes())?;
    Ok(token)
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .map_err(|e| format!("write {}: {e}", path.display()))?;
        file.write_all(bytes).map_err(|e| format!("write {}: {e}", path.display()))
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, bytes).map_err(|e| format!("write {}: {e}", path.display()))
    }
}

/// The sign-in URL for this machine's browser.
pub fn login_url(port: u16, token: &str) -> String {
    format!("http://127.0.0.1:{port}/desktop/login?token={token}")
}

// ── Content tickets ──────────────────────────────────────────────────────

struct Ticket {
    path: String,
    project_id: Option<String>,
    download: bool,
    expires: Instant,
}

#[derive(Default)]
pub struct Tickets {
    map: HashMap<String, Ticket>,
}

impl Tickets {
    fn mint(&mut self, path: String, project_id: Option<String>, download: bool) -> Result<String, String> {
        let now = Instant::now();
        self.map.retain(|_, t| t.expires > now);
        if self.map.len() >= MAX_TICKETS {
            if let Some(oldest) = self.map.iter().min_by_key(|(_, t)| t.expires).map(|(k, _)| k.clone()) {
                self.map.remove(&oldest);
            }
        }
        let id = random_token()?;
        self.map.insert(id.clone(), Ticket { path, project_id, download, expires: now + TICKET_TTL });
        Ok(id)
    }

    fn get(&self, id: &str) -> Option<(String, Option<String>, bool)> {
        let t = self.map.get(id)?;
        (t.expires > Instant::now()).then(|| (t.path.clone(), t.project_id.clone(), t.download))
    }
}

// ── State ────────────────────────────────────────────────────────────────

/// A client gone within the grace window: what it owned, to adopt or reap.
struct Parked {
    ptys: HashSet<String>,
    since: Instant,
}

/// A connected client: the connection holding its id (a page that comes back
/// with `?resume=` before the server noticed the old link die takes the id
/// over, and the stale connection must then neither detach nor park it) and
/// the PTYs it spawned.
struct Live {
    generation: u64,
    ptys: Arc<Mutex<HashSet<String>>>,
}

#[derive(Clone)]
pub struct WebClientState {
    /// `MobileHostSettings.browser_client`: off → every route here is a 404.
    pub enabled: bool,
    /// The system context whose sink is [`WebEvents`]; a call's context is
    /// `with_caller(Client(id))` of it.
    pub ctx: CoreCtx,
    pub events: Arc<WebEvents>,
    pub sessions: Arc<Mutex<WebSessions>>,
    pub tickets: Arc<Mutex<Tickets>>,
    /// The login token; `None` when the file could not be read or written
    /// (the login route then refuses everything).
    pub token: Option<Arc<str>>,
    /// Where the web bundle is read from, if a bundle was found.
    pub bundle: Option<PathBuf>,
    /// The app's port and the user-content origin's.
    pub port: u16,
    pub content_port: u16,
    parked: Arc<Mutex<HashMap<ClientId, Parked>>>,
    live: Arc<Mutex<HashMap<ClientId, Live>>>,
    next_client: Arc<AtomicU64>,
    next_generation: Arc<AtomicU64>,
}

impl WebClientState {
    /// `ctx` is the host's system context built over `events`.
    pub fn new(enabled: bool, ctx: CoreCtx, events: Arc<WebEvents>, control_dir: &Path, port: u16, bundle: Option<PathBuf>) -> Self {
        let token = match login_token(control_dir) {
            Ok(token) => Some(Arc::from(token.as_str())),
            Err(error) => {
                eprintln!("desktop client: no login token: {error}");
                None
            }
        };
        Self {
            enabled,
            ctx,
            events,
            sessions: Arc::default(),
            tickets: Arc::default(),
            token,
            bundle,
            port,
            content_port: content_port_for(port),
            parked: Arc::default(),
            live: Arc::default(),
            next_client: Arc::new(AtomicU64::new(1)),
            next_generation: Arc::new(AtomicU64::new(1)),
        }
    }

    fn lock_sessions(&self) -> std::sync::MutexGuard<'_, WebSessions> {
        self.sessions.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn lock_parked(&self) -> std::sync::MutexGuard<'_, HashMap<ClientId, Parked>> {
        self.parked.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn lock_live(&self) -> std::sync::MutexGuard<'_, HashMap<ClientId, Live>> {
        self.live.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// A new connection's client id and generation. `resume` names the id a
    /// page held before its link dropped: a parked id is adopted with the
    /// PTYs it owned; an id the server still counts as connected (its close
    /// never arrived — the usual case for a link that died, not closed) is
    /// taken over, and the stale connection, superseded, ends on its own
    /// (its link is replaced in [`WebEvents`]) without parking anything.
    fn register(&self, resume: Option<String>) -> (ClientId, u64) {
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed);
        // Lock order everywhere: parked before live.
        let mut parked = self.lock_parked();
        let mut live = self.lock_live();
        let resumed = resume.and_then(|id| {
            let id = ClientId::new(id);
            if let Some(p) = parked.remove(&id) {
                return Some((id, Arc::new(Mutex::new(p.ptys))));
            }
            live.get(&id).map(|l| (id.clone(), l.ptys.clone()))
        });
        let (client, ptys) = resumed.unwrap_or_else(|| {
            (ClientId::new(format!("web-{}", self.next_client.fetch_add(1, Ordering::Relaxed))), Arc::default())
        });
        live.insert(client.clone(), Live { generation, ptys });
        (client, generation)
    }

    /// The connection `generation` of `client` ended. `true` when it still
    /// held the id: the id is parked with its PTYs for [`RESUME_GRACE`]. `false`
    /// when a resumed connection took the id over meanwhile — then nothing
    /// is parked and the caller must not detach the (new) link either.
    fn release(&self, client: &ClientId, generation: u64) -> bool {
        let mut parked = self.lock_parked();
        let mut live = self.lock_live();
        match live.get(client) {
            Some(l) if l.generation == generation => {}
            _ => return false,
        }
        let owned = live
            .remove(client)
            .map(|l| std::mem::take(&mut *l.ptys.lock().unwrap_or_else(PoisonError::into_inner)))
            .unwrap_or_default();
        parked.insert(client.clone(), Parked { ptys: owned, since: Instant::now() });
        true
    }

    /// `client` spawned PTY `id`: it owns it now, alone. PTY ids are tab ids,
    /// the same in every page of the workspace — a reloaded page (a new
    /// client) or a sibling page re-spawns the ids a parked client still
    /// lists, and the parked set's reap must not take the live page's PTY.
    fn note_spawned(&self, client: &ClientId, id: String) {
        let mut parked = self.lock_parked();
        let live = self.lock_live();
        for p in parked.values_mut() {
            p.ptys.remove(&id);
        }
        for (other, l) in live.iter() {
            if other != client {
                l.ptys.lock().unwrap_or_else(PoisonError::into_inner).remove(&id);
            }
        }
        if let Some(l) = live.get(client) {
            l.ptys.lock().unwrap_or_else(PoisonError::into_inner).insert(id);
        }
    }

    fn note_killed(&self, client: &ClientId, id: &str) {
        if let Some(l) = self.lock_live().get(client) {
            l.ptys.lock().unwrap_or_else(PoisonError::into_inner).remove(id);
        }
    }

    /// The PTY ids `client` owns right now (connected or parked).
    #[cfg(test)]
    fn owned_ptys(&self, client: &ClientId) -> Vec<String> {
        let mut out: Vec<String> = match self.lock_live().get(client) {
            Some(l) => l.ptys.lock().unwrap_or_else(PoisonError::into_inner).iter().cloned().collect(),
            None => self.lock_parked().get(client).map(|p| p.ptys.iter().cloned().collect()).unwrap_or_default(),
        };
        out.sort();
        out
    }

    /// The session cookie's token, if the request carries a live one.
    fn authenticate(&self, headers: &HeaderMap) -> Option<String> {
        let token = session_cookie(headers)?;
        self.lock_sessions().touch(&token).then_some(token)
    }
}

/// The user-content origin's port: the next one up (plan §3.5 asks for a
/// separate origin; on loopback a second port is the one unambiguous way).
pub fn content_port_for(port: u16) -> u16 {
    port.checked_add(1).unwrap_or(port - 1)
}

/// Where the web bundle is: `<ENV_PREFIX>WEB_DIST`, else the dev checkout's
/// `web-dist/`, else `<control_dir>/web-dist`. `None` when none holds an
/// `index.html`.
pub fn bundle_dir(control_dir: &Path) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(dir) = crate::brand::env("WEB_DIST") {
        candidates.push(PathBuf::from(dir));
    }
    if let Some(root) = crate::services::dev_build::SOURCE_ROOT {
        candidates.push(Path::new(root).join("web-dist"));
    }
    candidates.push(control_dir.join("web-dist"));
    candidates.into_iter().find(|dir| dir.join("index.html").is_file())
}

// ── Guards ───────────────────────────────────────────────────────────────

/// The host part of a `Host`/`Origin` value when it is a loopback literal on
/// `port` — `127.0.0.1`, `localhost` or `[::1]` — else `None`.
fn loopback_host_on(value: &str, port: u16) -> Option<&str> {
    let (host, host_port) = value.rsplit_once(':')?;
    if host_port.parse::<u16>().ok()? != port {
        return None;
    }
    matches!(host, "127.0.0.1" | "localhost" | "[::1]").then_some(host)
}

/// The request came in on loopback, by its `Host` header.
pub fn loopback_request(headers: &HeaderMap, port: u16) -> bool {
    headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|host| loopback_host_on(host, port).is_some())
}

/// The `Origin`, when present, is `http://<the same loopback host>`.
pub fn loopback_origin(headers: &HeaderMap, port: u16) -> bool {
    let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else {
        return true;
    };
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or("");
    let Some(stripped) = origin.strip_prefix("http://") else { return false };
    loopback_host_on(stripped, port).is_some() && stripped == host
}

fn session_cookie(headers: &HeaderMap) -> Option<String> {
    let cookies = headers.get(header::COOKIE)?.to_str().ok()?;
    let name = crate::brand::DESKTOP_SESSION_COOKIE;
    cookies.split(';').find_map(|part| {
        let (k, v) = part.trim().split_once('=')?;
        (k == name).then(|| v.to_string())
    })
}

fn not_found() -> Response<Body> {
    StatusCode::NOT_FOUND.into_response()
}

fn page(status: StatusCode, body: String) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(body))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// Server-side pages the app itself cannot show (it is not loaded yet). Plain
/// English, like the sidecar's "Mobile assets are not built" page.
fn sign_in_page() -> Response<Body> {
    page(
        StatusCode::UNAUTHORIZED,
        concat!(
            "<!doctype html><meta charset=utf-8><title>",
            crate::app_name!(),
            "</title><main style=\"font:16px system-ui;margin:3em auto;max-width:36em\"><h1>Sign in</h1>",
            "<p>This browser is not signed in. Open the sign-in link from <b>Settings → Mobile → Browser access</b> in the ",
            crate::app_name!(),
            " window, or run <code>cat &lt;state dir&gt;/mobile-control/",
            "web-client.token</code> and open <code>http://127.0.0.1:&lt;port&gt;/desktop/login?token=…</code>.</p></main>"
        )
        .to_string(),
    )
}

fn no_bundle_page() -> Response<Body> {
    page(
        StatusCode::OK,
        concat!(
            "<!doctype html><meta charset=utf-8><title>",
            crate::app_name!(),
            "</title><main style=\"font:16px system-ui;margin:3em auto;max-width:36em\"><h1>Web bundle not built</h1>",
            "<p>Run <code>npm run web:bundle</code> in the checkout (served from its <code>web-dist/</code>), or set <code>",
            crate::app_upper!(),
            "_WEB_DIST</code> to a built bundle.</p></main>"
        )
        .to_string(),
    )
}

// ── Routes ───────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct LoginQuery {
    #[serde(default)]
    token: String,
}

#[derive(Deserialize)]
struct WsQuery {
    #[serde(default)]
    resume: Option<String>,
}

/// The app's routes, merged into the host router.
pub fn routes(state: WebClientState) -> Router {
    Router::new()
        .route("/desktop", get(redirect_to_app))
        .route("/desktop/", get(index))
        .route("/desktop/login", get(login))
        .route("/desktop/{*path}", get(asset))
        .route("/api/v1/desktop/ws", get(socket))
        .with_state(state)
}

/// The user-content origin's routes, served on [`WebClientState::content_port`].
pub fn content_routes(state: WebClientState) -> Router {
    Router::new().route("/content/{ticket}", get(content)).with_state(state)
}

/// The refusal every route here starts with: off, or not loopback → 404.
fn guard(state: &WebClientState, headers: &HeaderMap) -> Option<Response<Body>> {
    (!state.enabled || !loopback_request(headers, state.port)).then(not_found)
}

async fn redirect_to_app(State(state): State<WebClientState>, headers: HeaderMap) -> Response<Body> {
    if let Some(refused) = guard(&state, &headers) {
        return refused;
    }
    Redirect::permanent("/desktop/").into_response()
}

async fn login(State(state): State<WebClientState>, headers: HeaderMap, Query(query): Query<LoginQuery>) -> Response<Body> {
    if let Some(refused) = guard(&state, &headers) {
        return refused;
    }
    let Some(expected) = state.token.as_deref() else {
        return page(StatusCode::SERVICE_UNAVAILABLE, "<!doctype html><p>No login token is available.</p>".into());
    };
    if state.lock_sessions().locked_out() {
        return page(StatusCode::TOO_MANY_REQUESTS, "<!doctype html><p>Too many sign-in attempts. Wait a minute.</p>".into());
    }
    let ok = query.token.len() == expected.len() && bool::from(query.token.as_bytes().ct_eq(expected.as_bytes()));
    if !ok {
        state.lock_sessions().note_failure();
        return page(StatusCode::FORBIDDEN, "<!doctype html><p>That sign-in link is not valid.</p>".into());
    }
    let token = match state.lock_sessions().login() {
        Ok(token) => token,
        Err(error) => return page(StatusCode::INTERNAL_SERVER_ERROR, format!("<!doctype html><p>{error}</p>")),
    };
    let cookie = format!(
        "{}={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={}",
        crate::brand::DESKTOP_SESSION_COOKIE,
        super::auth::SESSION_MAX
    );
    let mut response = Redirect::to("/desktop/").into_response();
    if let Ok(value) = HeaderValue::from_str(&cookie) {
        response.headers_mut().insert(header::SET_COOKIE, value);
    }
    response
}

async fn index(State(state): State<WebClientState>, headers: HeaderMap) -> Response<Body> {
    if let Some(refused) = guard(&state, &headers) {
        return refused;
    }
    if state.authenticate(&headers).is_none() {
        return sign_in_page();
    }
    serve_bundle(&state, "index.html")
}

async fn asset(State(state): State<WebClientState>, headers: HeaderMap, RoutePath(path): RoutePath<String>) -> Response<Body> {
    if let Some(refused) = guard(&state, &headers) {
        return refused;
    }
    // Hashed assets are public code; the shell itself asks for a session.
    if !path.starts_with("assets/") && state.authenticate(&headers).is_none() {
        return sign_in_page();
    }
    serve_bundle(&state, &path)
}

/// A bundle file, or the shell for an app route (never for a missing asset).
fn serve_bundle(state: &WebClientState, requested: &str) -> Response<Body> {
    let Some(dir) = state.bundle.as_deref() else { return no_bundle_page() };
    let Some(rel) = safe_relative(requested) else { return not_found() };
    let candidate = dir.join(&rel);
    let (name, path) = if candidate.is_file() {
        (rel.clone(), candidate)
    } else if requested.starts_with("assets/") {
        return not_found();
    } else {
        ("index.html".to_string(), dir.join("index.html"))
    };
    let Ok(bytes) = std::fs::read(&path) else { return not_found() };
    let mime = mime_guess::from_path(&name).first_or_octet_stream().to_string();
    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(
            header::CACHE_CONTROL,
            if name.starts_with("assets/") { "public, max-age=31536000, immutable" } else { "no-cache" },
        );
    if name == "index.html" {
        // The shell's inline scripts (the theme pre-paint) are allowed by hash,
        // as Tauri does for the desktop; `host::security_headers` reads this.
        if let Ok(value) = HeaderValue::from_str(&inline_script_hashes(&bytes).join(" ")) {
            builder = builder.header(INLINE_SCRIPT_HASHES, value);
        }
    }
    builder
        .body(Body::from(bytes))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// Internal header `serve_bundle` hands the CSP middleware; stripped there.
pub const INLINE_SCRIPT_HASHES: &str = "x-app-inline-script-hashes";

/// `'sha256-…'` for every inline `<script>` in `html`.
pub fn inline_script_hashes(html: &[u8]) -> Vec<String> {
    let text = String::from_utf8_lossy(html);
    let mut out = Vec::new();
    let mut rest: &str = &text;
    while let Some(start) = rest.find("<script") {
        let after = &rest[start..];
        let Some(open_end) = after.find('>') else { break };
        let tag = &after[..open_end];
        let body_start = open_end + 1;
        let Some(close) = after[body_start..].find("</script>") else { break };
        if !tag.contains("src=") {
            let body = &after[body_start..body_start + close];
            let digest = Sha256::digest(body.as_bytes());
            out.push(format!("'sha256-{}'", base64ct::Base64::encode_string(&digest)));
        }
        rest = &after[body_start + close..];
    }
    out
}

/// `requested` as a relative path with no `..`, no absolute step and no empty
/// component — or `None`.
fn safe_relative(requested: &str) -> Option<String> {
    let trimmed = requested.trim_start_matches('/');
    if trimmed.is_empty() {
        return Some("index.html".into());
    }
    let mut parts = Vec::new();
    for part in trimmed.split('/') {
        if part.is_empty() || part == "." || part == ".." || part.contains('\\') || part.contains('\0') {
            return None;
        }
        parts.push(part);
    }
    Some(parts.join("/"))
}

async fn socket(
    State(state): State<WebClientState>,
    headers: HeaderMap,
    Query(query): Query<WsQuery>,
    ws: WebSocketUpgrade,
) -> Response<Body> {
    if let Some(refused) = guard(&state, &headers) {
        return refused;
    }
    if !loopback_origin(&headers, state.port) || headers.get(header::ORIGIN).is_none() {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(session) = state.authenticate(&headers) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let offered = headers
        .get(header::SEC_WEBSOCKET_PROTOCOL)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let wanted = crate::brand::DESKTOP_PROTOCOL;
    if !offered.split(',').any(|p| p.trim() == wanted) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    ws.protocols([wanted])
        .max_message_size(MAX_INBOUND_FRAME)
        .max_frame_size(MAX_INBOUND_FRAME)
        .on_upgrade(move |socket| serve_socket(socket, state, session, query.resume))
}

// ── The socket ───────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
enum Inbound {
    Call {
        id: u64,
        cmd: String,
        #[serde(default)]
        args: Value,
    },
    Sub {
        name: String,
    },
    Unsub {
        name: String,
    },
    Emit {
        name: String,
        #[serde(default)]
        payload: Value,
    },
}

#[derive(Deserialize)]
struct RawCallHeader {
    cmd: String,
    #[serde(default)]
    headers: HashMap<String, String>,
}

/// What one call answers with, on its way to the writer.
enum Answer {
    Text(String),
    Binary(Vec<u8>),
}

fn ret_frame(id: u64, out: &Result<Value, Value>) -> String {
    match out {
        Ok(v) => json!({ "t": "ret", "id": id, "ok": v }).to_string(),
        Err(e) => json!({ "t": "ret", "id": id, "err": e }).to_string(),
    }
}

fn binary_frame(kind: u8, id: u64, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(5 + payload.len());
    out.push(kind);
    out.extend_from_slice(&(id as u32).to_be_bytes());
    out.extend_from_slice(payload);
    out
}

/// `[u8 kind][u32be id][payload]` → `(kind, id, payload)`.
pub fn parse_binary_frame(bytes: &[u8]) -> Option<(u8, u64, &[u8])> {
    if bytes.len() < 5 {
        return None;
    }
    let id = u32::from_be_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]) as u64;
    Some((bytes[0], id, &bytes[5..]))
}

/// A raw call's payload: `[u32be hlen][header JSON][body]`.
fn parse_raw_call(payload: &[u8]) -> Option<(RawCallHeader, &[u8])> {
    if payload.len() < 4 {
        return None;
    }
    let hlen = u32::from_be_bytes([payload[0], payload[1], payload[2], payload[3]]) as usize;
    let header = payload.get(4..4 + hlen)?;
    let header: RawCallHeader = serde_json::from_slice(header).ok()?;
    Some((header, &payload[4 + hlen..]))
}

/// The PTY id a `pty_spawn` call names, for the client's ownership record.
fn spawned_pty_id(cmd: &str, args: &Value) -> Option<String> {
    (cmd == "pty_spawn").then(|| args.get("opts")?.get("id")?.as_str().map(str::to_string)).flatten()
}

fn killed_pty_id(cmd: &str, args: &Value) -> Option<String> {
    (cmd == "pty_kill").then(|| args.get("id")?.as_str().map(str::to_string)).flatten()
}

/// One client's connection, from `hello` to the grace timer after it closes.
async fn serve_socket(socket: WebSocket, state: WebClientState, session: String, resume: Option<String>) {
    // Resume keeps the id (and with it the terminal router's view keys and the
    // PTYs) when the page that lost its link is back inside the grace window
    // — or before the server even noticed the old link die.
    let (client, generation) = state.register(resume);
    let (event_tx, mut event_rx) = mpsc::channel::<Outbound>(EVENT_QUEUE);
    let (answer_tx, mut answer_rx) = mpsc::unbounded_channel::<Answer>();
    // Replaces a superseded connection's link: its event channel closes and
    // its loop below ends.
    state.events.attach(&client, event_tx);
    let (mut ws_tx, mut ws_rx) = socket.split();
    let hello = json!({
        "t": "hello",
        "client": client.as_str(),
        "protocol": PROTOCOL,
        "capabilities": core_dispatch::capabilities(Role::Admin, PROTOCOL),
    })
    .to_string();
    if ws_tx.send(Message::Text(hello.into())).await.is_err() {
        end_connection(&state, &client, generation);
        return;
    }
    let calls = Arc::new(Semaphore::new(MAX_CALLS_IN_FLIGHT));
    let call_ctx = state.ctx.with_caller(Caller::Client(client.clone()));
    let mut ping = tokio::time::interval(PING_INTERVAL);
    ping.tick().await;
    let mut unanswered_pings: u8 = 0;
    loop {
        tokio::select! {
            inbound = ws_rx.next() => {
                match inbound {
                    Some(Ok(Message::Text(text))) => {
                        let frame: Inbound = match serde_json::from_str(&text) {
                            Ok(frame) => frame,
                            Err(_) => continue,
                        };
                        match frame {
                            Inbound::Call { id, cmd, args } => {
                                let Ok(permit) = calls.clone().acquire_owned().await else { break };
                                let ctx = call_ctx.clone();
                                let state = state.clone();
                                let client = client.clone();
                                let tx = answer_tx.clone();
                                tokio::spawn(async move {
                                    let answer = handle_call(&state, &ctx, &client, id, &cmd, args).await;
                                    let _ = tx.send(answer);
                                    drop(permit);
                                });
                            }
                            Inbound::Sub { name } => state.events.subscribe(&client, &name),
                            Inbound::Unsub { name } => state.events.unsubscribe(&client, &name),
                            Inbound::Emit { name, payload } => state.events.rebroadcast(&client, &name, &payload),
                        }
                    }
                    Some(Ok(Message::Binary(bytes))) => {
                        let Some((kind, id, payload)) = parse_binary_frame(&bytes) else { continue };
                        if kind != KIND_CALL {
                            continue;
                        }
                        let Some((header, body)) = parse_raw_call(payload) else {
                            let _ = answer_tx.send(Answer::Text(ret_frame(id, &Err(Value::String("malformed raw call".into())))));
                            continue;
                        };
                        let Ok(permit) = calls.clone().acquire_owned().await else { break };
                        let ctx = call_ctx.clone();
                        let tx = answer_tx.clone();
                        let body = body.to_vec();
                        tokio::spawn(async move {
                            let answer = handle_raw_call(&ctx, id, header, &body).await;
                            let _ = tx.send(answer);
                            drop(permit);
                        });
                    }
                    Some(Ok(Message::Pong(_))) => unanswered_pings = 0,
                    Some(Ok(Message::Ping(_))) => {}
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                }
            }
            event = event_rx.recv() => {
                let Some(event) = event else { break };
                let message = match event {
                    Outbound::Text(text) => Message::Text(text.to_string().into()),
                    Outbound::Binary(bytes) => Message::Binary(bytes.to_vec().into()),
                };
                if ws_tx.send(message).await.is_err() { break; }
            }
            answer = answer_rx.recv() => {
                let Some(answer) = answer else { break };
                let message = match answer {
                    Answer::Text(text) => Message::Text(text.into()),
                    Answer::Binary(bytes) => Message::Binary(bytes.into()),
                };
                if ws_tx.send(message).await.is_err() { break; }
            }
            _ = ping.tick() => {
                // The session must still be live, and the peer must answer.
                if !state.lock_sessions().touch(&session) { break; }
                if unanswered_pings >= 2 { break; }
                unanswered_pings += 1;
                if ws_tx.send(Message::Ping(Vec::new().into())).await.is_err() { break; }
            }
        }
    }
    end_connection(&state, &client, generation);
}

/// A connection ended: park what the client owned and reap it unless it is
/// back in time — or, when a resumed connection already took the id over,
/// nothing at all (the id, its link, views and PTYs are the new connection's).
fn end_connection(state: &WebClientState, client: &ClientId, generation: u64) {
    if !state.release(client, generation) {
        return;
    }
    let dropped = state.events.detach(client);
    if dropped > 0 {
        eprintln!("desktop client {client}: {dropped} events shed on a full queue");
    }
    let state = state.clone();
    let client = client.clone();
    tokio::spawn(async move {
        tokio::time::sleep(RESUME_GRACE).await;
        reap_if_still_parked(&state, &client);
    });
}

/// After the grace window: drop the client's terminal views and kill the PTYs
/// it spawned (tmux attach clients; the sessions stay), unless it came back.
fn reap_if_still_parked(state: &WebClientState, client: &ClientId) {
    let parked = {
        let mut parked = state.lock_parked();
        match parked.get(client) {
            Some(p) if p.since.elapsed() >= RESUME_GRACE => parked.remove(client),
            _ => None,
        }
    };
    let Some(parked) = parked else { return };
    crate::terminal::route_drop_window_views(client.as_str());
    if let Some(registry) = state.ctx.state.try_get::<crate::commands::terminal::RegistryState>() {
        let mut taken = Vec::new();
        {
            let mut registry = registry.lock().unwrap_or_else(PoisonError::into_inner);
            for id in &parked.ptys {
                if let Some(pty) = registry.take(id) {
                    taken.push(pty);
                }
            }
        }
        crate::terminal::teardown_taken(taken);
    }
}

/// One text call: the transport's own commands first, then the dispatcher.
async fn handle_call(state: &WebClientState, ctx: &CoreCtx, client: &ClientId, id: u64, cmd: &str, args: Value) -> Answer {
    match cmd {
        CAPABILITIES_CMD => {
            let caps = serde_json::to_value(core_dispatch::capabilities(Role::Admin, PROTOCOL)).map_err(|e| Value::String(e.to_string()));
            return Answer::Text(ret_frame(id, &caps));
        }
        FILE_TICKET_CMD => {
            let path = args.get("path").and_then(Value::as_str).unwrap_or("").to_string();
            let project_id = args.get("projectId").and_then(Value::as_str).map(str::to_string);
            let download = args.get("download").and_then(Value::as_bool).unwrap_or(false);
            if path.is_empty() {
                return Answer::Text(ret_frame(id, &Err(Value::String("desktop_file_ticket: missing path".into()))));
            }
            let ticket = state.tickets.lock().unwrap_or_else(PoisonError::into_inner).mint(path, project_id, download);
            let out = ticket.map(|t| json!({ "url": format!("http://127.0.0.1:{}/content/{t}", state.content_port) })).map_err(Value::String);
            return Answer::Text(ret_frame(id, &out));
        }
        FILE_GRANT_CMD => {
            let path = args.get("path").and_then(Value::as_str).unwrap_or("").to_string();
            if path.is_empty() {
                return Answer::Text(ret_frame(id, &Err(Value::String("desktop_file_grant: missing path".into()))));
            }
            let out = match (ctx.state.try_get::<crate::services::pick_grants::PickGrantsState>(), random_token()) {
                (Some(grants), Ok(grant)) => {
                    let grant = grants.lock().unwrap_or_else(PoisonError::into_inner).grant(std::path::PathBuf::from(path), grant);
                    Ok(json!({ "grant": grant }))
                }
                (None, _) => Err(Value::String("desktop_file_grant: this host keeps no grants".into())),
                (_, Err(e)) => Err(Value::String(e)),
            };
            return Answer::Text(ret_frame(id, &out));
        }
        "read_file_bytes" => {
            let path = args.get("path").and_then(Value::as_str).unwrap_or("").to_string();
            let project_id = args.get("projectId").and_then(Value::as_str).map(str::to_string);
            return match crate::commands::fs::read_file_bytes_for(ctx, path, project_id).await {
                Ok(bytes) => Answer::Binary(binary_frame(KIND_RET, id, &bytes)),
                Err(e) => Answer::Text(ret_frame(id, &Err(Value::String(e)))),
            };
        }
        _ => {}
    }
    let spawned = spawned_pty_id(cmd, &args);
    let killed = killed_pty_id(cmd, &args);
    let out = core_dispatch::dispatch(ctx, Role::Admin, cmd, args).await;
    if out.is_ok() {
        if let Some(pty) = spawned {
            state.note_spawned(client, pty);
        }
        if let Some(pty) = killed {
            state.note_killed(client, &pty);
        }
    }
    Answer::Text(ret_frame(id, &out))
}

/// A raw-body call (`KIND_CALL`): only `write_file_bytes` takes one.
async fn handle_raw_call(ctx: &CoreCtx, id: u64, header: RawCallHeader, body: &[u8]) -> Answer {
    if header.cmd != "write_file_bytes" {
        return Answer::Text(ret_frame(id, &Err(Value::String(format!("`{}` takes no raw body", header.cmd)))));
    }
    let decode = |name: &str| -> Option<String> {
        let raw = header.headers.get(name)?;
        Some(percent_decode(raw))
    };
    let Some(path) = decode(crate::brand::FILE_PATH_HEADER).filter(|p| !p.is_empty()) else {
        return Answer::Text(ret_frame(id, &Err(Value::String("write_file_bytes: missing path".into()))));
    };
    let project_id = decode(crate::brand::FILE_PROJECT_HEADER).filter(|p| !p.is_empty());
    let out = crate::commands::fs::write_file_bytes_for(ctx, path, body, project_id)
        .await
        .map(|()| Value::Null)
        .map_err(Value::String);
    Answer::Text(ret_frame(id, &out))
}

/// `encodeURIComponent` undone (what the frontend's `writeFileBytes` applies).
fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&raw[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ── The user-content origin ──────────────────────────────────────────────

/// File types a browser would execute or let script: served as attachments.
fn active_type(mime: &str) -> bool {
    mime.starts_with("text/html")
        || mime.starts_with("application/xhtml")
        || mime.starts_with("image/svg")
        || mime.ends_with("/xml")
        || mime.ends_with("+xml")
        || mime.starts_with("text/javascript")
        || mime.starts_with("application/javascript")
}

async fn content(State(state): State<WebClientState>, headers: HeaderMap, RoutePath(ticket): RoutePath<String>) -> Response<Body> {
    if !state.enabled || !loopback_request(&headers, state.content_port) {
        return not_found();
    }
    let Some((path, project_id, download)) = state.tickets.lock().unwrap_or_else(PoisonError::into_inner).get(&ticket) else {
        return not_found();
    };
    let name = Path::new(&path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
    let bytes = match crate::commands::fs::read_file_bytes_for(&state.ctx, path, project_id).await {
        Ok(bytes) => bytes,
        Err(_) => return not_found(),
    };
    let mime = mime_guess::from_path(&name).first_or_octet_stream().to_string();
    let disposition = if download || active_type(&mime) { "attachment" } else { "inline" };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CONTENT_SECURITY_POLICY, "sandbox; default-src 'none'")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CACHE_CONTROL, "private, no-store")
        .header(header::CONTENT_DISPOSITION, disposition_header(disposition, &name))
        .body(Body::from(bytes))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// `inline`/`attachment` with the file name in both ASCII and RFC 5987 forms
/// (the same escaping `host::attachment_disposition` uses).
fn disposition_header(kind: &str, name: &str) -> String {
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
    format!("{kind}; filename=\"{ascii}\"; filename*=UTF-8''{encoded}")
}

/// The CSP of the web bundle's pages: the desktop's (`tauri.conf.json`) with
/// the socket in `connect-src` and the shell's inline-script hashes.
pub fn page_csp(host: &str, inline_hashes: &str) -> String {
    let hashes = if inline_hashes.is_empty() { String::new() } else { format!(" {inline_hashes}") };
    format!(
        "default-src 'self'; script-src 'self' blob:{hashes}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self' ws://{host}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use app_core::CoreState;

    fn headers(host: &str, origin: Option<&str>) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(header::HOST, HeaderValue::from_str(host).unwrap());
        if let Some(o) = origin {
            h.insert(header::ORIGIN, HeaderValue::from_str(o).unwrap());
        }
        h
    }

    #[test]
    fn only_loopback_hosts_on_the_port_pass() {
        assert!(loopback_request(&headers("127.0.0.1:8742", None), 8742));
        assert!(loopback_request(&headers("localhost:8742", None), 8742));
        assert!(loopback_request(&headers("[::1]:8742", None), 8742));
        assert!(!loopback_request(&headers("127.0.0.1:8743", None), 8742));
        assert!(!loopback_request(&headers("127.0.0.1", None), 8742), "no port is not this port");
        assert!(!loopback_request(&headers("desk.example.ts.net", None), 8742), "Tailscale Serve's host");
        assert!(!loopback_request(&headers("desk.example.ts.net:8742", None), 8742));
        assert!(!loopback_request(&headers("127.0.0.1.evil.example:8742", None), 8742));
        assert!(!loopback_request(&HeaderMap::new(), 8742));
    }

    #[test]
    fn the_origin_must_match_the_host_exactly() {
        assert!(loopback_origin(&headers("127.0.0.1:8742", Some("http://127.0.0.1:8742")), 8742));
        assert!(!loopback_origin(&headers("127.0.0.1:8742", Some("http://localhost:8742")), 8742), "a different loopback spelling is a different origin");
        assert!(!loopback_origin(&headers("127.0.0.1:8742", Some("https://127.0.0.1:8742")), 8742));
        assert!(!loopback_origin(&headers("127.0.0.1:8742", Some("http://desk.example.ts.net")), 8742));
        assert!(loopback_origin(&headers("127.0.0.1:8742", None), 8742), "a plain GET carries no Origin");
    }

    #[test]
    fn bundle_paths_cannot_escape() {
        assert_eq!(safe_relative("assets/index-abc.js").as_deref(), Some("assets/index-abc.js"));
        assert_eq!(safe_relative("").as_deref(), Some("index.html"));
        assert_eq!(safe_relative("../secret"), None);
        assert_eq!(safe_relative("a//b"), None);
        assert_eq!(safe_relative("a/./b"), None);
        assert_eq!(safe_relative("a\\b"), None);
    }

    #[test]
    fn inline_scripts_are_hashed_and_external_ones_are_not() {
        let html = b"<html><head><script>var a=1;</script><script src=\"/assets/x.js\"></script><script type=\"module\">b()</script></head></html>";
        let hashes = inline_script_hashes(html);
        assert_eq!(hashes.len(), 2);
        let expected = format!("'sha256-{}'", base64ct::Base64::encode_string(&Sha256::digest(b"var a=1;")));
        assert_eq!(hashes[0], expected);
        assert!(page_csp("127.0.0.1:8742", &hashes.join(" ")).contains(&expected));
        assert!(page_csp("127.0.0.1:8742", "").contains("connect-src 'self' ws://127.0.0.1:8742;"));
    }

    #[test]
    fn frames_round_trip() {
        let frame = binary_frame(KIND_RET, 42, b"hello");
        assert_eq!(parse_binary_frame(&frame), Some((KIND_RET, 42, &b"hello"[..])));
        assert_eq!(parse_binary_frame(&[1, 2]), None);
        let header = serde_json::to_vec(&json!({ "cmd": "write_file_bytes", "headers": { "x": "a%20b" } })).unwrap();
        let mut payload = (header.len() as u32).to_be_bytes().to_vec();
        payload.extend_from_slice(&header);
        payload.extend_from_slice(b"BODY");
        let (parsed, body) = parse_raw_call(&payload).unwrap();
        assert_eq!(parsed.cmd, "write_file_bytes");
        assert_eq!(body, b"BODY");
        assert_eq!(percent_decode("a%20b%2Fc"), "a b/c");
        assert_eq!(percent_decode("plain"), "plain");
        assert_eq!(percent_decode("%zz"), "%zz");
        assert_eq!(ret_frame(7, &Ok(json!(1))), r#"{"id":7,"ok":1,"t":"ret"}"#);
        assert_eq!(ret_frame(7, &Err(json!("bad"))), r#"{"err":"bad","id":7,"t":"ret"}"#);
    }

    #[test]
    fn events_reach_only_subscribed_clients_and_a_full_queue_sheds() {
        let events = WebEvents::default();
        let a = ClientId::new("web-1");
        let b = ClientId::new("web-2");
        let (tx_a, mut rx_a) = mpsc::channel(2);
        let (tx_b, mut rx_b) = mpsc::channel(2);
        events.attach(&a, tx_a);
        events.attach(&b, tx_b);
        events.subscribe(&a, "terminal-output");
        let sink: &dyn EventSink = &events;
        sink.emit("terminal-output", json!({ "id": "p1", "data": "x" }));
        sink.emit("something-else", 1);
        let Some(Outbound::Text(frame)) = rx_a.try_recv().ok() else { panic!("a gets the event") };
        assert_eq!(&*frame, r#"{"t":"event","name":"terminal-output","payload":{"data":"x","id":"p1"}}"#);
        assert!(rx_b.try_recv().is_err(), "b never subscribed");
        // Two more fill a's queue of two; the third is shed and counted.
        sink.emit("terminal-output", 1);
        sink.emit("terminal-output", 2);
        sink.emit("terminal-output", 3);
        assert_eq!(events.detach(&a), 1);
        // A targeted emit reaches that client only, when subscribed.
        events.subscribe(&b, "done");
        sink.emit_to(&b, "done", ());
        sink.emit_to(&ClientId::new("web-9"), "done", ());
        assert!(matches!(rx_b.try_recv(), Ok(Outbound::Text(_))));
        assert!(rx_b.try_recv().is_err());
        // A rebroadcast skips its sender.
        events.rebroadcast(&b, "done", &json!(1));
        assert!(rx_b.try_recv().is_err());
        assert_eq!(events.connected(), vec![b.clone()]);
    }

    #[test]
    fn sessions_slide_lock_out_and_log_out() {
        let mut sessions = WebSessions::default();
        let token = sessions.login().unwrap();
        assert!(sessions.touch(&token));
        assert!(!sessions.touch("nope"));
        for _ in 0..MAX_LOGIN_FAILURES {
            assert!(!sessions.note_failure());
        }
        assert!(sessions.note_failure());
        assert!(sessions.locked_out());
        sessions.logout(&token);
        assert!(!sessions.touch(&token));
    }

    #[test]
    fn the_login_token_is_minted_once_and_kept_private() {
        let dir = tempfile::tempdir().unwrap();
        let control = dir.path().join("mobile-control");
        let first = login_token(&control).unwrap();
        let second = login_token(&control).unwrap();
        assert_eq!(first, second);
        assert!(first.len() >= 43);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(control.join(TOKEN_FILE)).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        assert_eq!(login_url(8742, "T"), "http://127.0.0.1:8742/desktop/login?token=T");
    }

    #[test]
    fn tickets_expire_and_name_their_file() {
        let mut tickets = Tickets::default();
        let id = tickets.mint("/tmp/x/report.html".into(), Some("p".into()), false).unwrap();
        assert_eq!(tickets.get(&id), Some(("/tmp/x/report.html".to_string(), Some("p".to_string()), false)));
        assert_eq!(tickets.get("other"), None);
        assert!(active_type("text/html"));
        assert!(active_type("image/svg+xml"));
        assert!(!active_type("application/pdf"));
        assert!(!active_type("image/png"));
        assert_eq!(content_port_for(8742), 8743);
    }

    #[test]
    fn bundle_dir_prefers_a_built_bundle() {
        let dir = tempfile::tempdir().unwrap();
        let control = dir.path().join("mobile-control");
        // Nothing built anywhere the test can see (the env override is unset
        // in tests, and a checkout's web-dist may or may not exist): the
        // control-dir fallback decides.
        std::fs::create_dir_all(control.join("web-dist")).unwrap();
        std::fs::write(control.join("web-dist/index.html"), "<!doctype html>").unwrap();
        let found = bundle_dir(&control).unwrap();
        assert!(found.join("index.html").is_file());
    }

    /// The router end to end, with a real listener: sign in, open the
    /// socket, call, subscribe, and get a binary answer.
    #[tokio::test]
    async fn the_socket_signs_in_calls_and_subscribes() {
        use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message as WsMessage};
        // reqwest is built `rustls-no-provider`: the host installs one before
        // any client exists (`host::run` does; this test stands in for it).
        crate::services::mail_engine::install_crypto_provider();
        let dir = tempfile::tempdir().unwrap();
        let control = dir.path().join("mobile-control");
        let events = Arc::new(WebEvents::default());
        let state_core = CoreState::new().manage(crate::services::remote::new_pool());
        let ctx = CoreCtx::system(Arc::new(state_core), events.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let state = WebClientState::new(true, ctx, events.clone(), &control, port, None);
        let token = state.token.clone().unwrap();
        let app = routes(state.clone());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let http = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap();
        let base = format!("http://127.0.0.1:{port}");

        // Not signed in: the shell asks for the link; a wrong token is refused.
        let r = http.get(format!("{base}/desktop/")).send().await.unwrap();
        assert_eq!(r.status(), 401);
        let r = http.get(format!("{base}/desktop/login?token=wrong")).send().await.unwrap();
        assert_eq!(r.status(), 403);
        // Through a non-loopback host nothing exists.
        let r = http.get(format!("{base}/desktop/login?token={token}")).header("host", "desk.example.ts.net").send().await.unwrap();
        assert_eq!(r.status(), 404);
        let r = http.get(format!("{base}/desktop/login?token={token}")).send().await.unwrap();
        assert_eq!(r.status(), 303);
        let cookie = r.headers().get(header::SET_COOKIE).unwrap().to_str().unwrap().to_string();
        assert!(cookie.contains("HttpOnly") && cookie.contains("SameSite=Strict"));
        let cookie_pair = cookie.split(';').next().unwrap().to_string();
        // Signed in, no bundle: the "not built" page, not a 404.
        let r = http.get(format!("{base}/desktop/")).header("cookie", &cookie_pair).send().await.unwrap();
        assert_eq!(r.status(), 200);
        assert!(r.text().await.unwrap().contains("web:bundle"));

        // The socket needs the cookie, an exact Origin and the subprotocol.
        let mut request = format!("ws://127.0.0.1:{port}/api/v1/desktop/ws").into_client_request().unwrap();
        request.headers_mut().insert("cookie", cookie_pair.parse().unwrap());
        request.headers_mut().insert("origin", format!("http://127.0.0.1:{port}").parse().unwrap());
        request.headers_mut().insert("sec-websocket-protocol", crate::brand::DESKTOP_PROTOCOL.parse().unwrap());
        let (mut ws, _) = tokio_tungstenite::connect_async(request).await.expect("upgrade");
        let hello: Value = match ws.next().await.unwrap().unwrap() {
            WsMessage::Text(t) => serde_json::from_str(&t).unwrap(),
            other => panic!("{other:?}"),
        };
        assert_eq!(hello["t"], "hello");
        assert_eq!(hello["client"], "web-1");
        assert_eq!(hello["capabilities"]["role"], "admin");
        assert!(hello["capabilities"]["commands"].as_array().unwrap().len() > 600);

        // A call is answered by id; a client command is refused by class.
        ws.send(WsMessage::Text(json!({ "t": "call", "id": 1, "cmd": "agent_is_installed", "args": { "id": "nope-cli" } }).to_string().into())).await.unwrap();
        ws.send(WsMessage::Text(json!({ "t": "call", "id": 2, "cmd": "clipboard_has_image" }).to_string().into())).await.unwrap();
        let mut rets = Vec::new();
        for _ in 0..2 {
            if let WsMessage::Text(t) = ws.next().await.unwrap().unwrap() {
                rets.push(serde_json::from_str::<Value>(&t).unwrap());
            }
        }
        rets.sort_by_key(|r| r["id"].as_u64());
        assert_eq!(rets[0]["ok"], false);
        assert_eq!(rets[1]["err"]["code"], "client");

        // Events arrive only after `sub`.
        events.emit_json("workspace:patch", r#"{"v":1}"#.into());
        ws.send(WsMessage::Text(json!({ "t": "sub", "name": "workspace:patch" }).to_string().into())).await.unwrap();
        ws.send(WsMessage::Text(json!({ "t": "call", "id": 3, "cmd": CAPABILITIES_CMD }).to_string().into())).await.unwrap();
        // The call's answer proves the sub frame was processed first.
        if let WsMessage::Text(t) = ws.next().await.unwrap().unwrap() {
            let v: Value = serde_json::from_str(&t).unwrap();
            assert_eq!(v["id"], 3);
            assert_eq!(v["ok"]["protocol"], PROTOCOL);
        }
        events.emit_json("workspace:patch", r#"{"v":2}"#.into());
        if let WsMessage::Text(t) = ws.next().await.unwrap().unwrap() {
            assert_eq!(t.as_str(), r#"{"t":"event","name":"workspace:patch","payload":{"v":2}}"#);
        }

        // A raw write then a binary read of the same file.
        let file = dir.path().join("note.txt");
        let header = serde_json::to_vec(&json!({ "cmd": "write_file_bytes", "headers": {
            crate::brand::FILE_PATH_HEADER: file.to_string_lossy(),
            crate::brand::FILE_PROJECT_HEADER: "",
        } })).unwrap();
        let mut payload = (header.len() as u32).to_be_bytes().to_vec();
        payload.extend_from_slice(&header);
        payload.extend_from_slice(b"bytes!");
        ws.send(WsMessage::Binary(binary_frame(KIND_CALL, 4, &payload).into())).await.unwrap();
        if let WsMessage::Text(t) = ws.next().await.unwrap().unwrap() {
            let v: Value = serde_json::from_str(&t).unwrap();
            assert_eq!(v["id"], 4);
            // The temp dir is outside every confined root, so the write is
            // refused — which is the confinement working through this path.
            assert!(v["err"].is_string(), "{v}");
        }
        ws.send(WsMessage::Text(json!({ "t": "call", "id": 5, "cmd": "read_file_bytes", "args": { "path": file.to_string_lossy() } }).to_string().into())).await.unwrap();
        if let WsMessage::Text(t) = ws.next().await.unwrap().unwrap() {
            let v: Value = serde_json::from_str(&t).unwrap();
            assert_eq!(v["id"], 5);
            assert!(v["err"].is_string());
        }
        // A ticket is minted for the content origin.
        ws.send(WsMessage::Text(json!({ "t": "call", "id": 6, "cmd": FILE_TICKET_CMD, "args": { "path": "/tmp/x.pdf" } }).to_string().into())).await.unwrap();
        if let WsMessage::Text(t) = ws.next().await.unwrap().unwrap() {
            let v: Value = serde_json::from_str(&t).unwrap();
            let url = v["ok"]["url"].as_str().unwrap();
            assert!(url.starts_with(&format!("http://127.0.0.1:{}/content/", content_port_for(port))), "{url}");
        }

        // The page's link died without the server noticing (no close frame
        // arrived); the page is back with `?resume=`: it takes its id over
        // and the stale connection is ended by the server.
        let mut request = format!("ws://127.0.0.1:{port}/api/v1/desktop/ws?resume=web-1").into_client_request().unwrap();
        request.headers_mut().insert("cookie", cookie_pair.parse().unwrap());
        request.headers_mut().insert("origin", format!("http://127.0.0.1:{port}").parse().unwrap());
        request.headers_mut().insert("sec-websocket-protocol", crate::brand::DESKTOP_PROTOCOL.parse().unwrap());
        let (mut ws2, _) = tokio_tungstenite::connect_async(request).await.expect("upgrade");
        let hello2: Value = match ws2.next().await.unwrap().unwrap() {
            WsMessage::Text(t) => serde_json::from_str(&t).unwrap(),
            other => panic!("{other:?}"),
        };
        assert_eq!(hello2["client"], "web-1", "the resumed page keeps its id");
        let stale = tokio::time::timeout(Duration::from_secs(5), ws.next()).await.expect("the stale socket ends");
        assert!(matches!(stale, None | Some(Ok(WsMessage::Close(_))) | Some(Err(_))), "{stale:?}");
        assert_eq!(state.events.connected(), vec![ClientId::new("web-1")], "one link, the new one");
        // The new connection is served; the id was not parked by the stale one.
        ws2.send(WsMessage::Text(json!({ "t": "call", "id": 7, "cmd": CAPABILITIES_CMD }).to_string().into())).await.unwrap();
        if let WsMessage::Text(t) = ws2.next().await.unwrap().unwrap() {
            let v: Value = serde_json::from_str(&t).unwrap();
            assert_eq!(v["id"], 7);
        }
        assert!(state.lock_parked().is_empty());
        ws2.close(None).await.unwrap();
    }

    #[test]
    fn pty_ownership_follows_the_spawn_and_a_resume_takes_a_live_id_over() {
        let dir = tempfile::tempdir().unwrap();
        let events = Arc::new(WebEvents::default());
        let ctx = CoreCtx::system(Arc::new(CoreState::new()), events.clone());
        let state = WebClientState::new(true, ctx, events, &dir.path().join("mobile-control"), 8742, None);
        let (a, gen_a) = state.register(None);
        assert_eq!(a.as_str(), "web-1");
        state.note_spawned(&a, "tab-1".into());
        state.note_spawned(&a, "tab-2".into());
        state.note_killed(&a, "tab-2");
        assert_eq!(state.owned_ptys(&a), ["tab-1"]);
        // The link ends: parked with its PTY.
        assert!(state.release(&a, gen_a));
        assert_eq!(state.owned_ptys(&a), ["tab-1"]);
        // A reloaded page is a new client that re-spawns the same tab id: the
        // PTY is its now, and the parked set's reap must not take it.
        let (b, gen_b) = state.register(None);
        assert_eq!(b.as_str(), "web-2");
        state.note_spawned(&b, "tab-1".into());
        assert!(state.owned_ptys(&a).is_empty());
        assert_eq!(state.owned_ptys(&b), ["tab-1"]);
        // The parked page comes back inside the grace window: its id again.
        let (a2, _) = state.register(Some("web-1".into()));
        assert_eq!(a2, a);
        assert!(state.lock_parked().is_empty());
        // b's link died unnoticed; the page is back with `?resume=` while the
        // server still counts the old connection live: it takes the id over.
        let (b2, gen_b2) = state.register(Some("web-2".into()));
        assert_eq!(b2, b);
        assert_ne!(gen_b2, gen_b);
        assert_eq!(state.owned_ptys(&b), ["tab-1"]);
        // The stale connection ends: superseded, it parks nothing.
        assert!(!state.release(&b, gen_b));
        assert!(state.lock_live().contains_key(&b));
        assert!(state.lock_parked().is_empty());
        // The connection that holds the id ends: parked, PTY and all.
        assert!(state.release(&b, gen_b2));
        assert_eq!(state.owned_ptys(&b), ["tab-1"]);
        // An id nobody holds is not resumable: a fresh client.
        let (c, _) = state.register(Some("web-99".into()));
        assert_eq!(c.as_str(), "web-3");
    }
}
