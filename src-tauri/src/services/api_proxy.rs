//! The provider API proxy: the real key never enters an agent process
//! (`docs/api_chat_plan.md`, Part C, C2).
//!
//! A user's provider key (`agent_api_keys`, OS keychain) stays inside
//! Tabtivity. A keyed agent spawn gets two things instead:
//!
//! - a **proxy token**: 32 random bytes, held in memory only, bound to one
//!   provider, one scope and one tab ([`Grant`]). It travels to the CLI as a C1
//!   carrier (`agent_exec`), under the variable the CLI sends as its credential
//!   (`ANTHROPIC_AUTH_TOKEN`, `GEMINI_API_KEY`);
//! - the CLI's **base-URL variable** (`ANTHROPIC_BASE_URL`,
//!   `GOOGLE_GEMINI_BASE_URL`), plain, pointing at this loopback listener under
//!   the provider's own prefix (`http://127.0.0.1:<port>/anthropic`).
//!
//! The listener takes the token off the request, checks it, and forwards the
//! request to the provider's one fixed HTTPS API host ([`upstream_host`]) with
//! the real key in the provider's own header — only on a path that provider's
//! CLIs need ([`path_allowed`]), with a bounded body, never following a
//! redirect, and with the response (Server-Sent Events included) passed back
//! chunk by chunk as it arrives. A token that leaks — a project's CLI config
//! that redirects the base URL, a prompt-injected `env` dump — is worthless off
//! this machine and dies with its tab.
//!
//! **Its own listener**, not a route on the MCP listener (`commands::root_mcp`):
//! that one is shaped for one small JSON-RPC message per socket — 30 s socket
//! lifetime, `Connection: close`, a 1 MiB-class body bound, JSON-only — and a
//! model turn streams for minutes with request bodies of several MiB.
//!
//! **Lifetime.** A token is revoked when its tab ends ([`on_tab_gone`], from
//! `agent_fence::on_tab_gone`, which every tab teardown reaches). A tab running
//! in a local tmux session outlives its PTY (a project switch or window reload
//! kills only the tmux client), so its grant is bound to the session and
//! revoked once that session is gone ([`sweep_tmux`]). A respawn of the same
//! tab gets the same token back ([`issue`]), which is what keeps a re-attached
//! agent working. Everything is revoked and the listener stopped in the
//! `RunEvent::Exit` teardown ([`stop_for_exit`]); a clean quit also ends
//! Tabtivity's tmux sessions, so no agent outlives its proxy then. After a
//! crash a re-attached keyed agent holds a dead token: restart the CLI.
//!
//! **Never logged:** keys, tokens, bodies, query strings. Nothing here logs a
//! request at all.
//!
//! `AppHandle`-free; the server runs on Tauri's async runtime. The only way
//! to point it at another upstream is the `cfg(test)` [`Upstream::Test`]
//! variant, which no project or agent can reach.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use axum::body::{Body, Bytes};
use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::Response;
use axum::Router;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

use super::agent_api_keys::Provider;

/// Largest request body forwarded. Anthropic's own Messages limit is 32 MB; a
/// long Claude conversation with images runs to several MiB.
const MAX_BODY: usize = 32 * 1024 * 1024;
/// How long the agent may take to upload a request body.
const BODY_WAIT: Duration = Duration::from_secs(60);
/// Upstream connect bound.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// Upstream silence bound per read. Claude aborts a stream after five quiet
/// minutes itself; the provider's SSE pings keep a live one under this.
const READ_IDLE: Duration = Duration::from_secs(600);
/// Sockets open at once.
const SOCKETS: usize = 64;
/// How long an accepted socket may stay silent before it is dropped.
const IDLE_OPEN: Duration = Duration::from_secs(10);
/// A keychain read that found nothing is retried after this, not per request.
const MISSING_KEY_RETRY: Duration = Duration::from_secs(15);

/// The provider's one API host. HTTPS only; nothing else is ever dialled.
pub fn upstream_host(provider: Provider) -> &'static str {
    match provider {
        Provider::Anthropic => "api.anthropic.com",
        Provider::Gemini => "generativelanguage.googleapis.com",
    }
}

// ---------------------------------------------------------------------------
// Grants

/// What a proxy token stands for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Grant {
    pub provider: Provider,
    /// The agent home's scope (`agent_home::scope_of`).
    pub scope: String,
    /// The PTY id of the tab.
    pub tab: String,
    /// The local tmux session the agent runs in, when it does: the grant then
    /// lives as long as that session, not the PTY.
    pub tmux: Option<String>,
}

fn grants() -> &'static Mutex<HashMap<String, Grant>> {
    static GRANTS: OnceLock<Mutex<HashMap<String, Grant>>> = OnceLock::new();
    GRANTS.get_or_init(Default::default)
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn mint() -> Option<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).ok()?;
    Some(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// The token for `grant`: the one it already holds (a respawn of the same tab
/// re-attaches the agent that still carries it), else a new one. `None` only
/// without system randomness.
fn issue_grant(grant: Grant) -> Option<String> {
    let mut map = lock(grants());
    if let Some((token, _)) = map.iter().find(|(_, g)| **g == grant) {
        return Some(token.clone());
    }
    let token = mint()?;
    map.insert(token.clone(), grant);
    Some(token)
}

/// A proxy token and the base URL for a keyed spawn, or `None` when the proxy
/// is not running in this process (the `--agent-shim` process never runs it,
/// so a CLI typed into a shell tab stays on its own login) or the provider has
/// no key saved. Reads the keychain only on a cold cache.
pub fn issue(provider: Provider, scope: &str, tab: &str, tmux: Option<&str>) -> Option<(String, String)> {
    let base = base_url(provider)?;
    key_for(provider)?;
    let token = issue_grant(Grant {
        provider,
        scope: scope.to_string(),
        tab: tab.to_string(),
        tmux: tmux.map(str::to_string),
    })?;
    Some((token, base))
}

fn lookup(token: &str) -> Option<Grant> {
    lock(grants()).get(token).cloned()
}

/// Whether a proxy token is live. For the spawn path's tests and diagnostics;
/// never logs it.
pub fn token_live(token: &str) -> bool {
    lock(grants()).contains_key(token)
}

/// A tab ended (closed, its process exited, or the app is quitting). Its
/// grants without a tmux session go now; the ones bound to a tmux session go
/// once that session is gone — checked off this thread, which may be a PTY
/// teardown path.
pub fn on_tab_gone(tab: &str) {
    let mut tmux_bound = false;
    lock(grants()).retain(|_, g| {
        if g.tab != tab {
            return true;
        }
        tmux_bound |= g.tmux.is_some();
        g.tmux.is_some()
    });
    if tmux_bound && !STOPPING.load(Ordering::Acquire) {
        std::thread::spawn(sweep_tmux);
    }
}

/// Revoke every grant whose tmux session no longer exists. A `tmux` that
/// cannot be run at all leaves the grants alone (a later sweep or the quit
/// revokes them); one that answers "no server" means every session is gone.
pub fn sweep_tmux() {
    let Some(live) = live_tmux_sessions() else { return };
    retain_live(&mut lock(grants()), &live);
}

fn retain_live(map: &mut HashMap<String, Grant>, live: &HashSet<String>) {
    map.retain(|_, g| g.tmux.as_ref().is_none_or(|s| live.contains(s)));
}

fn live_tmux_sessions() -> Option<HashSet<String>> {
    let out = crate::paths::command_no_window("tmux")
        .args(["ls", "-F", "#{session_name}"])
        .output()
        .ok()?;
    if !out.status.success() {
        return Some(HashSet::new());
    }
    Some(String::from_utf8_lossy(&out.stdout).lines().map(str::to_string).collect())
}

fn revoke_all() {
    lock(grants()).clear();
}

// ---------------------------------------------------------------------------
// Keys (cached in memory; the keychain read is off the request path)

enum Cached {
    Key(String),
    Missing(Instant),
}

fn keys() -> &'static Mutex<HashMap<Provider, Cached>> {
    static KEYS: OnceLock<Mutex<HashMap<Provider, Cached>>> = OnceLock::new();
    KEYS.get_or_init(Default::default)
}

/// Bumped by every [`forget_key`], so a keychain read that started before it
/// does not put the old answer back.
static KEY_GENERATION: AtomicU64 = AtomicU64::new(0);

/// `provider`'s key: from memory, else the keychain (bounded at 4 s, never
/// prompting), remembered. A miss is remembered for [`MISSING_KEY_RETRY`] so a
/// locked keyring is not asked once per request.
pub fn key_for(provider: Provider) -> Option<String> {
    match lock(keys()).get(&provider) {
        Some(Cached::Key(k)) => return Some(k.clone()),
        Some(Cached::Missing(at)) if at.elapsed() < MISSING_KEY_RETRY => return None,
        _ => {}
    }
    let generation = KEY_GENERATION.load(Ordering::Acquire);
    let read = super::agent_api_keys::get_key(provider);
    let mut cache = lock(keys());
    if KEY_GENERATION.load(Ordering::Acquire) == generation {
        cache.insert(
            provider,
            match &read {
                Some(k) => Cached::Key(k.clone()),
                None => Cached::Missing(Instant::now()),
            },
        );
    }
    read
}

/// The key was saved or removed: the next use reads the keychain again.
/// Removing a key therefore stops running keyed tabs too, at their next
/// request.
pub fn forget_key(provider: Provider) {
    let mut cache = lock(keys());
    KEY_GENERATION.fetch_add(1, Ordering::AcqRel);
    cache.remove(&provider);
}

// ---------------------------------------------------------------------------
// Runtime

static PORT: AtomicU16 = AtomicU16::new(0);
static STOPPING: AtomicBool = AtomicBool::new(false);
static SHUTDOWN: tokio::sync::Notify = tokio::sync::Notify::const_new();
static SERVER: Mutex<Option<tauri::async_runtime::JoinHandle<()>>> = Mutex::new(None);

/// The listener is up in this process.
pub fn running() -> bool {
    PORT.load(Ordering::Acquire) != 0 && !STOPPING.load(Ordering::Acquire)
}

/// The base URL a CLI is pointed at for `provider`.
pub fn base_url(provider: Provider) -> Option<String> {
    running().then(|| base_url_on(PORT.load(Ordering::Acquire), provider))
}

fn base_url_on(port: u16, provider: Provider) -> String {
    format!("http://127.0.0.1:{port}/{}", provider.id())
}

/// Whether `url` is a proxy base URL for `provider` (any port: a value an
/// earlier run handed out counts too).
pub fn is_proxy_base(url: &str, provider: Provider) -> bool {
    url.strip_prefix("http://127.0.0.1:")
        .and_then(|rest| rest.split_once('/'))
        .is_some_and(|(port, path)| !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) && path == provider.id())
}

/// Where requests go. Production has exactly one answer per provider; the
/// test variant does not exist outside `cfg(test)`.
#[derive(Clone)]
enum Upstream {
    Provider,
    #[cfg(test)]
    Test(String),
}

impl Upstream {
    fn base(&self, provider: Provider) -> String {
        match self {
            Upstream::Provider => format!("https://{}", upstream_host(provider)),
            #[cfg(test)]
            Upstream::Test(base) => base.clone(),
        }
    }
}

/// Where a request's key comes from: the cache over the keychain, or (tests)
/// a fixed answer.
#[derive(Clone)]
enum KeySource {
    Keychain,
    #[cfg(test)]
    Fixed(Option<&'static str>),
}

impl KeySource {
    async fn key(&self, provider: Provider) -> Option<String> {
        match self {
            KeySource::Keychain => tauri::async_runtime::spawn_blocking(move || key_for(provider))
                .await
                .ok()
                .flatten(),
            #[cfg(test)]
            KeySource::Fixed(k) => k.map(str::to_string),
        }
    }
}

#[derive(Clone)]
struct ProxyState {
    port: u16,
    upstream: Upstream,
    keys: KeySource,
    client: reqwest::Client,
    max_body: usize,
}

fn client(https_only: bool) -> Result<reqwest::Client, String> {
    crate::services::mail_engine::install_crypto_provider();
    reqwest::Client::builder()
        // The key must never follow a redirect to another host.
        .redirect(reqwest::redirect::Policy::none())
        .https_only(https_only)
        // The body passes through as the provider sent it; the request asks
        // for no encoding (`accept-encoding` is not forwarded), so C3 reads
        // usage from plain bytes.
        .no_gzip()
        .no_brotli()
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(READ_IDLE)
        .build()
        .map_err(|e| format!("API proxy: {e}"))
}

/// Bind the listener and serve until [`stop_for_exit`]. Called once from
/// `setup`; a failure leaves keyed CLIs on their own logins (no token, no base
/// URL is handed out while [`running`] is false) — the safe direction.
pub fn start() {
    let handle = tauri::async_runtime::spawn(async {
        let client = match client(true) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[api-proxy] {e}");
                return;
            }
        };
        let listener = match tokio::net::TcpListener::bind(("127.0.0.1", 0)).await {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[api-proxy] bind failed: {e}");
                return;
            }
        };
        let Ok(addr) = listener.local_addr() else { return };
        let state = ProxyState {
            port: addr.port(),
            upstream: Upstream::Provider,
            keys: KeySource::Keychain,
            client,
            max_body: MAX_BODY,
        };
        PORT.store(addr.port(), Ordering::Release);
        if let Err(e) = serve(listener, state, async { SHUTDOWN.notified().await }).await {
            eprintln!("[api-proxy] server stopped: {e}");
        }
        PORT.store(0, Ordering::Release);
    });
    *lock(&SERVER) = Some(handle);
}

/// `RunEvent::Exit`: hand out nothing more, revoke every token, stop accepting
/// and give streams in flight a short bounded drain. Idempotent.
pub fn stop_for_exit() {
    STOPPING.store(true, Ordering::Release);
    revoke_all();
    SHUTDOWN.notify_waiters();
    SHUTDOWN.notify_one();
    if let Some(handle) = lock(&SERVER).take() {
        tauri::async_runtime::block_on(async {
            let _ = tokio::time::timeout(Duration::from_secs(2), handle).await;
        });
    }
    PORT.store(0, Ordering::Release);
}

async fn serve(
    listener: tokio::net::TcpListener,
    state: ProxyState,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    let router = Router::new().fallback(handle).with_state(state);
    let listener = BoundedListener { tcp: listener, slots: Arc::new(tokio::sync::Semaphore::new(SOCKETS)) };
    axum::serve(listener, router).with_graceful_shutdown(shutdown).await
}

/// Caps open sockets and drops one that stays silent after accept; no total
/// lifetime (a model turn streams for minutes).
struct BoundedListener {
    tcp: tokio::net::TcpListener,
    slots: Arc<tokio::sync::Semaphore>,
}

struct BoundedStream {
    tcp: tokio::net::TcpStream,
    _slot: tokio::sync::OwnedSemaphorePermit,
    idle: Pin<Box<tokio::time::Sleep>>,
    seen_bytes: bool,
}

impl axum::serve::Listener for BoundedListener {
    type Io = BoundedStream;
    type Addr = std::net::SocketAddr;
    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            let slot = self.slots.clone().acquire_owned().await.expect("listener semaphore stays open");
            match self.tcp.accept().await {
                Ok((tcp, addr)) => {
                    let idle = Box::pin(tokio::time::sleep(IDLE_OPEN));
                    return (BoundedStream { tcp, _slot: slot, idle, seen_bytes: false }, addr);
                }
                Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
            }
        }
    }
    fn local_addr(&self) -> std::io::Result<Self::Addr> {
        self.tcp.local_addr()
    }
}

impl AsyncRead for BoundedStream {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        if !self.seen_bytes && self.idle.as_mut().poll(cx).is_ready() {
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
        Pin::new(&mut self.tcp).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.tcp).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.tcp).poll_shutdown(cx)
    }
}

// ---------------------------------------------------------------------------
// Requests

/// Why the proxy answered itself instead of forwarding.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Refusal {
    /// No token, an unknown or revoked one, or one of another provider.
    Unauthorized,
    /// A browser request (`Origin`) or another `Host` than the listener's.
    Forbidden,
    /// A path the provider's CLIs do not need.
    NotFound,
    TooLarge,
    BodyTimeout,
    BadBody,
    /// The token is good, but no key is saved (removed, or the keyring is
    /// locked).
    NoKey,
    /// The provider's host could not be reached.
    Upstream,
}

impl Refusal {
    fn status(self) -> StatusCode {
        match self {
            Refusal::Unauthorized | Refusal::NoKey => StatusCode::UNAUTHORIZED,
            Refusal::Forbidden => StatusCode::FORBIDDEN,
            Refusal::NotFound => StatusCode::NOT_FOUND,
            Refusal::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            Refusal::BodyTimeout => StatusCode::REQUEST_TIMEOUT,
            Refusal::BadBody => StatusCode::BAD_REQUEST,
            Refusal::Upstream => StatusCode::BAD_GATEWAY,
        }
    }

    fn message(self) -> &'static str {
        match self {
            Refusal::Unauthorized => concat!(
                "this tab's ", crate::app_name!(),
                " API proxy token is unknown or was revoked; open a new tab to get a new one"
            ),
            Refusal::Forbidden => concat!(crate::app_name!(), " API proxy: browser or foreign-host request refused"),
            Refusal::NotFound => concat!(crate::app_name!(), " API proxy: this API path is not forwarded"),
            Refusal::TooLarge => concat!(crate::app_name!(), " API proxy: request body too large"),
            Refusal::BodyTimeout => concat!(crate::app_name!(), " API proxy: request body took too long"),
            Refusal::BadBody => concat!(crate::app_name!(), " API proxy: request body could not be read"),
            Refusal::NoKey => concat!(
                crate::app_name!(),
                " has no API key saved for this provider (or the keyring is locked): add one in Manage CLIs → API keys"
            ),
            Refusal::Upstream => concat!(crate::app_name!(), " API proxy: the provider's API could not be reached"),
        }
    }

    /// Whether the CLI should try again: only for a transport failure.
    fn retryable(self) -> bool {
        matches!(self, Refusal::Upstream)
    }
}

/// A refusal in the provider's own error shape, so the CLI shows its message.
fn refuse(provider: Option<Provider>, refusal: Refusal) -> Response {
    let status = refusal.status();
    let message = refusal.message();
    let body = match provider {
        Some(Provider::Gemini) => serde_json::json!({
            "error": { "code": status.as_u16(), "message": message, "status": match refusal {
                Refusal::Unauthorized | Refusal::NoKey => "UNAUTHENTICATED",
                Refusal::Forbidden => "PERMISSION_DENIED",
                Refusal::NotFound => "NOT_FOUND",
                Refusal::TooLarge | Refusal::BadBody => "INVALID_ARGUMENT",
                Refusal::BodyTimeout => "DEADLINE_EXCEEDED",
                Refusal::Upstream => "UNAVAILABLE",
            } }
        }),
        // Anthropic's shape; also for a path naming no provider.
        _ => serde_json::json!({
            "type": "error",
            "error": { "type": match refusal {
                Refusal::Unauthorized | Refusal::NoKey => "authentication_error",
                Refusal::Forbidden => "permission_error",
                Refusal::NotFound => "not_found_error",
                Refusal::TooLarge => "request_too_large",
                Refusal::BodyTimeout | Refusal::BadBody => "invalid_request_error",
                Refusal::Upstream => "api_error",
            }, "message": message }
        }),
    };
    let mut response = Response::new(Body::from(body.to_string()));
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    // Claude reads this before retrying; a dead token stays dead.
    headers.insert(
        "x-should-retry",
        HeaderValue::from_static(if refusal.retryable() { "true" } else { "false" }),
    );
    response
}

/// `/<provider>/<rest>` → the provider and `/<rest>`.
fn split_route(path: &str) -> Option<(Provider, &str)> {
    let rest = path.strip_prefix('/')?;
    let (id, tail) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    Some((Provider::from_id(id)?, tail))
}

/// Whether `path` (below the provider prefix) is one the provider's CLIs need,
/// for `method`. Every segment is plain: no empty, `.` or `..` segment, no
/// percent-encoding, nothing but `[A-Za-z0-9._:-]`.
fn path_allowed(provider: Provider, method: &Method, path: &str) -> bool {
    let Some(rest) = path.strip_prefix('/') else { return false };
    let segs: Vec<&str> = rest.split('/').collect();
    let plain = |s: &str| {
        !s.is_empty()
            && s != "."
            && s != ".."
            && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b':'))
    };
    if !segs.iter().all(|s| plain(s)) {
        return false;
    }
    let post = *method == Method::POST;
    let get = *method == Method::GET;
    match provider {
        // Claude Code: `POST /v1/messages?beta=true`, optional token counting,
        // model discovery when switched on (code.claude.com gateway guide).
        Provider::Anthropic => match segs.as_slice() {
            ["v1", "messages"] | ["v1", "messages", "count_tokens"] => post,
            ["v1", "models"] | ["v1", "models", _] => get && !segs.last().is_some_and(|s| s.contains(':')),
            _ => false,
        },
        // Gemini CLI through `@google/genai`: `models/<m>:<method>`.
        Provider::Gemini => match segs.as_slice() {
            [version, "models"] if is_gemini_version(version) => get,
            [version, "models", model] if is_gemini_version(version) => match model.split_once(':') {
                None => get,
                Some((name, verb)) => {
                    post && !name.is_empty()
                        && matches!(
                            verb,
                            "generateContent" | "streamGenerateContent" | "countTokens" | "embedContent" | "batchEmbedContents"
                        )
                }
            },
            _ => false,
        },
    }
}

fn is_gemini_version(v: &str) -> bool {
    matches!(v, "v1" | "v1beta")
}

/// The token the request presents: in `x-api-key`, `Authorization: Bearer`,
/// `x-goog-api-key` or a `key=` query parameter — every one present must carry
/// the same value, and none may repeat.
fn presented_token(headers: &HeaderMap, query: Option<&str>) -> Option<String> {
    let mut found: Vec<String> = Vec::new();
    for name in ["x-api-key", "x-goog-api-key", "authorization"] {
        let mut values = headers.get_all(name).iter();
        let Some(value) = values.next() else { continue };
        if values.next().is_some() {
            return None;
        }
        let value = value.to_str().ok()?.trim();
        let value = if name == "authorization" {
            value.strip_prefix("Bearer ").or_else(|| value.strip_prefix("bearer "))?.trim()
        } else {
            value
        };
        found.push(value.to_string());
    }
    for pair in query.unwrap_or("").split('&') {
        if let Some(value) = pair.strip_prefix("key=") {
            found.push(value.to_string());
        }
    }
    let first = found.first()?.clone();
    (!first.is_empty() && found.iter().all(|v| *v == first)).then_some(first)
}

/// The query string without its `key` parameter (the token, for a client
/// that sends it there).
fn forwarded_query(query: Option<&str>) -> String {
    let kept: Vec<&str> = query
        .unwrap_or("")
        .split('&')
        .filter(|p| !p.is_empty() && *p != "key" && !p.starts_with("key="))
        .collect();
    if kept.is_empty() {
        String::new()
    } else {
        format!("?{}", kept.join("&"))
    }
}

/// Request headers never forwarded: the agent's credentials (replaced by the
/// real key), hop-by-hop headers, the client's own encodings and browser or
/// proxy hints. The rest — `anthropic-version`, `anthropic-beta`, the CLI's
/// own headers — passes unchanged, as the provider's gateway guide asks.
const DROP_REQUEST: &[&str] = &[
    "host",
    "authorization",
    "proxy-authorization",
    "x-api-key",
    "x-goog-api-key",
    "cookie",
    "connection",
    "keep-alive",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "content-length",
    "accept-encoding",
    "expect",
    "origin",
    "referer",
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-real-ip",
];

/// Response headers never passed back: hop-by-hop ones and cookies.
const DROP_RESPONSE: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "content-length",
    "set-cookie",
];

fn copy_headers(from: &HeaderMap, drop: &[&str]) -> HeaderMap {
    let mut out = HeaderMap::new();
    for (name, value) in from {
        if !drop.contains(&name.as_str()) {
            out.append(name.clone(), value.clone());
        }
    }
    out
}

/// The provider's own credential header, carrying the real key.
fn auth_header(provider: Provider) -> &'static str {
    match provider {
        Provider::Anthropic => "x-api-key",
        Provider::Gemini => "x-goog-api-key",
    }
}

fn host_ok(headers: &HeaderMap, port: u16) -> bool {
    let mut hosts = headers.get_all(header::HOST).iter();
    match (hosts.next(), hosts.next()) {
        (Some(host), None) => host.to_str().is_ok_and(|h| h == format!("127.0.0.1:{port}")),
        _ => false,
    }
}

async fn handle(State(state): State<ProxyState>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let Some((provider, rest)) = split_route(parts.uri.path()) else {
        return refuse(None, Refusal::NotFound);
    };
    if parts.headers.contains_key(header::ORIGIN) || !host_ok(&parts.headers, state.port) {
        return refuse(Some(provider), Refusal::Forbidden);
    }
    let query = parts.uri.query();
    let grant = presented_token(&parts.headers, query)
        .and_then(|t| lookup(&t))
        .filter(|g| g.provider == provider);
    let Some(grant) = grant else {
        return refuse(Some(provider), Refusal::Unauthorized);
    };
    if !path_allowed(provider, &parts.method, rest) {
        return refuse(Some(provider), Refusal::NotFound);
    }
    let Some(key) = state.keys.key(provider).await else {
        return refuse(Some(provider), Refusal::NoKey);
    };
    let Ok(key_value) = HeaderValue::from_str(&key) else {
        return refuse(Some(provider), Refusal::NoKey);
    };
    let body = match tokio::time::timeout(BODY_WAIT, read_body(body, state.max_body)).await {
        Err(_) => return refuse(Some(provider), Refusal::BodyTimeout),
        Ok(Err(refusal)) => return refuse(Some(provider), refusal),
        Ok(Ok(bytes)) => bytes,
    };
    let url = format!("{}{}{}", state.upstream.base(provider), rest, forwarded_query(query));
    let mut headers = copy_headers(&parts.headers, DROP_REQUEST);
    headers.insert(auth_header(provider), key_value);
    let upstream = state.client.request(parts.method, url).headers(headers).body(body).send().await;
    let Ok(upstream) = upstream else {
        return refuse(Some(provider), Refusal::Upstream);
    };
    relay(upstream, Arc::new(grant))
}

/// The request body, refused past `max` bytes (counted as it arrives, so a
/// body without a length is bounded too).
async fn read_body(body: Body, max: usize) -> Result<Bytes, Refusal> {
    use futures_util::StreamExt;
    let mut stream = body.into_data_stream();
    let mut out = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| Refusal::BadBody)?;
        if out.len() + chunk.len() > max {
            return Err(Refusal::TooLarge);
        }
        out.extend_from_slice(&chunk);
    }
    Ok(Bytes::from(out))
}

/// The provider's answer, passed back as it arrives: status, headers (less
/// hop-by-hop ones), and the body chunk by chunk — never collected first, or a
/// streaming CLI stalls.
fn relay(upstream: reqwest::Response, grant: Arc<Grant>) -> Response {
    let status = upstream.status();
    let headers = copy_headers(upstream.headers(), DROP_RESPONSE);
    let stream = futures_util::stream::unfold(Some(upstream), move |state| {
        let grant = grant.clone();
        async move {
            let mut upstream = state?;
            match upstream.chunk().await {
                Ok(Some(bytes)) => {
                    usage_tap(&grant, &bytes);
                    Some((Ok::<Bytes, reqwest::Error>(bytes), Some(upstream)))
                }
                Ok(None) => {
                    usage_end(&grant);
                    None
                }
                Err(e) => Some((Err(e), None)),
            }
        }
    });
    let mut response = Response::new(Body::from_stream(stream));
    *response.status_mut() = status;
    *response.headers_mut() = headers;
    response
}

/// C3's seam (the spending limit): every response chunk of a granted request,
/// in order, as the provider sent it (no content encoding — none is asked
/// for). Anthropic's `message_start` / `message_delta` usage and Gemini's
/// `usageMetadata` arrive here. Nothing reads them yet.
fn usage_tap(_grant: &Grant, _chunk: &Bytes) {}

/// The response ended cleanly (C3: settle the turn's cost).
fn usage_end(_grant: &Grant) {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    // Fake test keys and tokens, never a real-looking provider shape.
    const FAKE_KEY: &str = "sk-test-proxy-fake";

    fn grant(provider: Provider, tab: &str, tmux: Option<&str>) -> Grant {
        Grant { provider, scope: "p1".into(), tab: tab.into(), tmux: tmux.map(str::to_string) }
    }

    #[test]
    fn routes_split_on_the_provider_prefix() {
        assert_eq!(split_route("/anthropic/v1/messages"), Some((Provider::Anthropic, "/v1/messages")));
        assert_eq!(split_route("/gemini/v1beta/models"), Some((Provider::Gemini, "/v1beta/models")));
        assert_eq!(split_route("/anthropic"), Some((Provider::Anthropic, "")));
        assert_eq!(split_route("/openai/v1/chat/completions"), None);
        assert_eq!(split_route("/"), None);
    }

    #[test]
    fn only_the_paths_a_cli_needs_are_forwarded() {
        use Provider::*;
        let (get, post) = (Method::GET, Method::POST);
        assert!(path_allowed(Anthropic, &post, "/v1/messages"));
        assert!(path_allowed(Anthropic, &post, "/v1/messages/count_tokens"));
        assert!(path_allowed(Anthropic, &get, "/v1/models"));
        assert!(path_allowed(Anthropic, &get, "/v1/models/claude-opus-5-5"));
        for (m, p) in [
            (&get, "/v1/messages"),
            (&post, "/v1/models"),
            (&post, "/v1/messages/batches"),
            (&post, "/v1/files"),
            (&post, "/api/hello"),
            (&Method::HEAD, "/api/hello"),
            (&post, "/v1/../v1/messages"),
            (&post, "/v1//messages"),
            (&post, "/v1/messages/"),
            (&post, "/v1/%6dessages"),
            (&post, "v1/messages"),
            (&post, ""),
        ] {
            assert!(!path_allowed(Anthropic, m, p), "{m} {p}");
        }
        assert!(path_allowed(Gemini, &post, "/v1beta/models/gemini-3-pro:streamGenerateContent"));
        assert!(path_allowed(Gemini, &post, "/v1/models/gemini-3-pro:countTokens"));
        assert!(path_allowed(Gemini, &get, "/v1beta/models"));
        assert!(path_allowed(Gemini, &get, "/v1beta/models/gemini-3-pro"));
        for (m, p) in [
            (&get, "/v1beta/models/gemini-3-pro:generateContent"),
            (&post, "/v1beta/models/gemini-3-pro:predict"),
            (&post, "/v1beta/models/:generateContent"),
            (&post, "/v1beta/tunedModels/x:generateContent"),
            (&post, "/v1beta/files"),
            (&post, "/v2/models/x:generateContent"),
            (&post, "/v1/messages"),
        ] {
            assert!(!path_allowed(Gemini, m, p), "{m} {p}");
        }
    }

    #[test]
    fn the_token_may_ride_any_credential_slot_but_only_one_value() {
        let h = |pairs: &[(&str, &str)]| {
            let mut m = HeaderMap::new();
            for (k, v) in pairs {
                m.append(axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(), HeaderValue::from_str(v).unwrap());
            }
            m
        };
        assert_eq!(presented_token(&h(&[("authorization", "Bearer abc")]), None).as_deref(), Some("abc"));
        assert_eq!(presented_token(&h(&[("x-api-key", "abc")]), None).as_deref(), Some("abc"));
        assert_eq!(presented_token(&h(&[("x-goog-api-key", "abc")]), None).as_deref(), Some("abc"));
        assert_eq!(presented_token(&h(&[]), Some("alt=sse&key=abc")).as_deref(), Some("abc"));
        assert_eq!(
            presented_token(&h(&[("authorization", "Bearer abc"), ("x-api-key", "abc")]), None).as_deref(),
            Some("abc")
        );
        assert_eq!(presented_token(&h(&[("authorization", "Bearer abc"), ("x-api-key", "xyz")]), None), None);
        assert_eq!(presented_token(&h(&[("x-api-key", "abc"), ("x-api-key", "abc")]), None), None);
        assert_eq!(presented_token(&h(&[("authorization", "Basic abc")]), None), None);
        assert_eq!(presented_token(&h(&[("x-api-key", "")]), None), None);
        assert_eq!(presented_token(&h(&[]), Some("beta=true")), None);
    }

    #[test]
    fn the_key_parameter_never_travels_on() {
        assert_eq!(forwarded_query(Some("alt=sse&key=abc")), "?alt=sse");
        assert_eq!(forwarded_query(Some("key=abc")), "");
        assert_eq!(forwarded_query(Some("beta=true")), "?beta=true");
        assert_eq!(forwarded_query(None), "");
        assert_eq!(forwarded_query(Some("monkey=1&key")), "?monkey=1");
    }

    #[test]
    fn credentials_and_hop_by_hop_headers_are_not_forwarded() {
        let mut m = HeaderMap::new();
        for (k, v) in [
            ("authorization", "Bearer t"),
            ("x-api-key", "t"),
            ("x-goog-api-key", "t"),
            ("host", "127.0.0.1:1"),
            ("accept-encoding", "gzip"),
            ("connection", "keep-alive"),
            ("cookie", "a=b"),
            ("anthropic-version", "2023-06-01"),
            ("anthropic-beta", "a,b"),
            ("x-claude-code-session-id", "s"),
            ("content-type", "application/json"),
        ] {
            m.append(axum::http::HeaderName::from_static(k), HeaderValue::from_static(v));
        }
        let out = copy_headers(&m, DROP_REQUEST);
        let names: Vec<&str> = out.keys().map(|k| k.as_str()).collect();
        assert_eq!(
            names,
            vec!["anthropic-version", "anthropic-beta", "x-claude-code-session-id", "content-type"]
        );
    }

    #[test]
    fn a_respawn_gets_its_token_back_and_a_closed_tab_loses_it() {
        let g = grant(Provider::Anthropic, "p1:respawn", None);
        let first = issue_grant(g.clone()).unwrap();
        assert_eq!(first.len(), 64);
        assert_eq!(issue_grant(g.clone()).unwrap(), first, "same tab, same token");
        let other = issue_grant(grant(Provider::Gemini, "p1:respawn", None)).unwrap();
        assert_ne!(other, first, "one token per provider");
        assert_eq!(lookup(&first), Some(g));
        on_tab_gone("p1:respawn");
        assert!(!token_live(&first) && !token_live(&other));
        assert_ne!(issue_grant(grant(Provider::Anthropic, "p1:respawn", None)).unwrap(), first);
        on_tab_gone("p1:respawn");
    }

    #[test]
    fn a_tmux_bound_grant_lives_as_long_as_its_session() {
        let mut map = HashMap::from([
            ("t1".to_string(), grant(Provider::Anthropic, "p1:tmux", Some("app-p1--a"))),
            ("t2".to_string(), grant(Provider::Anthropic, "p1:plain", None)),
        ]);
        retain_live(&mut map, &HashSet::from(["app-p1--a".to_string()]));
        assert_eq!(map.len(), 2);
        retain_live(&mut map, &HashSet::new());
        assert!(map.contains_key("t2") && !map.contains_key("t1"));
    }

    #[test]
    fn a_closed_tmux_tab_keeps_its_grant_for_the_sweep() {
        let token = issue_grant(grant(Provider::Gemini, "p1:kept", Some("not-a-real-session-c2"))).unwrap();
        // The PTY went, the session may not have: the grant stays until a
        // sweep finds the session gone (the spawned sweep may already have).
        STOPPING.store(true, Ordering::Release);
        on_tab_gone("p1:kept");
        STOPPING.store(false, Ordering::Release);
        assert!(token_live(&token));
        lock(grants()).remove(&token);
    }

    #[tokio::test]
    async fn refusals_speak_the_providers_error_shapes() {
        let body = |r: Response| async move {
            let status = r.status();
            let retry = r.headers().get("x-should-retry").cloned();
            let bytes = axum::body::to_bytes(r.into_body(), 1 << 16).await.unwrap();
            (status, retry, serde_json::from_slice::<serde_json::Value>(&bytes).unwrap())
        };
        let (status, retry, json) = body(refuse(Some(Provider::Anthropic), Refusal::Unauthorized)).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(retry.unwrap(), "false");
        assert_eq!(json["type"], "error");
        assert_eq!(json["error"]["type"], "authentication_error");
        let (status, _, json) = body(refuse(Some(Provider::Gemini), Refusal::NoKey)).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(json["error"]["status"], "UNAUTHENTICATED");
        assert_eq!(json["error"]["code"], 401);
        let (_, retry, _) = body(refuse(Some(Provider::Gemini), Refusal::Upstream)).await;
        assert_eq!(retry.unwrap(), "true");
    }

    #[test]
    fn production_dials_only_the_providers_https_host() {
        assert_eq!(Upstream::Provider.base(Provider::Anthropic), "https://api.anthropic.com");
        assert_eq!(Upstream::Provider.base(Provider::Gemini), "https://generativelanguage.googleapis.com");
        assert_eq!(base_url_on(4321, Provider::Gemini), "http://127.0.0.1:4321/gemini");
        assert!(is_proxy_base(&base_url_on(4321, Provider::Gemini), Provider::Gemini));
        assert!(!is_proxy_base(&base_url_on(4321, Provider::Gemini), Provider::Anthropic));
        assert!(!is_proxy_base("https://gateway.example/gemini", Provider::Gemini));
        assert!(!is_proxy_base("http://127.0.0.1:/gemini", Provider::Gemini));
    }

    #[test]
    fn a_forgotten_key_is_not_put_back_by_an_older_read() {
        // A read that started before `forget_key` must not repopulate.
        let generation = KEY_GENERATION.load(Ordering::Acquire);
        forget_key(Provider::Gemini);
        assert_ne!(KEY_GENERATION.load(Ordering::Acquire), generation);
        assert!(lock(keys()).get(&Provider::Gemini).is_none());
    }

    // ---- end to end, against an in-process stub upstream -----------------

    /// One request as the stub upstream saw it: method, URI, headers, body.
    type SeenRequest = (String, String, HeaderMap, Vec<u8>);

    /// What the stub upstream saw of each request.
    #[derive(Default)]
    struct Seen {
        requests: Mutex<Vec<SeenRequest>>,
        hits: AtomicUsize,
    }

    const SSE_FIRST: &str = concat!(
        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_stub\",",
        "\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-stub\",\"content\":[],",
        "\"stop_reason\":null,\"stop_sequence\":null,\"usage\":{\"input_tokens\":5,\"output_tokens\":1}}}\n\n",
    );
    const SSE_REST: &str = concat!(
        "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,",
        "\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,",
        "\"delta\":{\"type\":\"text_delta\",\"text\":\"STUB-REPLY-OK\"}}\n\n",
        "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
        "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\",",
        "\"stop_sequence\":null},\"usage\":{\"output_tokens\":3}}\n\n",
        "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
    );

    /// A stub provider: records the request, then streams [`SSE_FIRST`], waits
    /// for a `release` permit, then [`SSE_REST`].
    async fn stub_upstream(seen: Arc<Seen>, release: Arc<tokio::sync::Semaphore>) -> String {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new().fallback(move |req: Request| {
            let seen = seen.clone();
            let release = release.clone();
            async move {
                let (parts, body) = req.into_parts();
                let body = axum::body::to_bytes(body, usize::MAX).await.unwrap().to_vec();
                seen.hits.fetch_add(1, Ordering::SeqCst);
                lock(&seen.requests).push((
                    parts.method.to_string(),
                    parts.uri.to_string(),
                    parts.headers.clone(),
                    body,
                ));
                let stream = futures_util::stream::unfold(0u8, move |step| {
                    let release = release.clone();
                    async move {
                        match step {
                            0 => Some((Ok::<Bytes, std::io::Error>(Bytes::from_static(SSE_FIRST.as_bytes())), 1)),
                            1 => {
                                release.acquire().await.unwrap().forget();
                                Some((Ok(Bytes::from_static(SSE_REST.as_bytes())), 2))
                            }
                            _ => None,
                        }
                    }
                });
                let mut r = Response::new(Body::from_stream(stream));
                r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
                r.headers_mut().insert("request-id", HeaderValue::from_static("req_stub"));
                r
            }
        });
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}")
    }

    async fn proxy(upstream: String, key: Option<&'static str>, max_body: usize) -> u16 {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let state = ProxyState {
            port,
            upstream: Upstream::Test(upstream),
            keys: KeySource::Fixed(key),
            client: client(false).unwrap(),
            max_body,
        };
        tokio::spawn(serve(listener, state, std::future::pending()));
        port
    }

    fn plain_client() -> reqwest::Client {
        reqwest::Client::builder().no_proxy().build().unwrap()
    }

    #[tokio::test]
    async fn a_granted_request_reaches_the_provider_with_the_real_key_and_streams_back() {
        let seen = Arc::new(Seen::default());
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        let upstream = stub_upstream(seen.clone(), release.clone()).await;
        let port = proxy(upstream, Some(FAKE_KEY), MAX_BODY).await;
        let token = issue_grant(grant(Provider::Anthropic, "e2e:stream", None)).unwrap();
        let mut response = plain_client()
            .post(format!("{}/v1/messages?beta=true", base_url_on(port, Provider::Anthropic)))
            .header("authorization", format!("Bearer {token}"))
            .header("anthropic-version", "2023-06-01")
            .header("anthropic-beta", "claude-code-20250219")
            .header("accept-encoding", "gzip")
            .header("content-type", "application/json")
            .body(r#"{"model":"claude-test","stream":true}"#)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()["content-type"], "text/event-stream");
        assert_eq!(response.headers()["request-id"], "req_stub");
        // The first event arrives while the provider still holds the rest:
        // nothing is collected before it is passed on.
        let first = tokio::time::timeout(Duration::from_secs(10), response.chunk()).await.unwrap().unwrap().unwrap();
        assert_eq!(&first[..], SSE_FIRST.as_bytes());
        release.add_permits(1);
        let mut rest = Vec::new();
        while let Some(chunk) = response.chunk().await.unwrap() {
            rest.extend_from_slice(&chunk);
        }
        assert_eq!(rest, SSE_REST.as_bytes());

        let requests = lock(&seen.requests);
        let (method, uri, headers, body) = &requests[0];
        assert_eq!(method, "POST");
        assert_eq!(uri, "/v1/messages?beta=true");
        assert_eq!(headers["x-api-key"], FAKE_KEY);
        assert!(headers.get("authorization").is_none());
        assert!(headers.get("accept-encoding").is_none());
        assert_eq!(headers["anthropic-version"], "2023-06-01");
        assert_eq!(headers["anthropic-beta"], "claude-code-20250219");
        assert_eq!(body, br#"{"model":"claude-test","stream":true}"#);
        for (_, value) in headers.iter() {
            assert!(!value.to_str().unwrap_or("").contains(&token), "the token never travels on");
        }
        drop(requests);
        on_tab_gone("e2e:stream");
    }

    #[tokio::test]
    async fn the_proxy_refuses_before_the_provider_sees_anything() {
        let seen = Arc::new(Seen::default());
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        let upstream = stub_upstream(seen.clone(), release).await;
        let port = proxy(upstream.clone(), Some(FAKE_KEY), 1024).await;
        let anthropic = base_url_on(port, Provider::Anthropic);
        let gemini = base_url_on(port, Provider::Gemini);
        let token = issue_grant(grant(Provider::Anthropic, "e2e:refuse", None)).unwrap();
        let c = plain_client();
        let post = |url: String| c.post(url).header("x-api-key", token.clone()).body("{}");

        // Unknown token, no token, another provider's route.
        let r = c.post(format!("{anthropic}/v1/messages")).header("x-api-key", "not-a-token").send().await.unwrap();
        assert_eq!(r.status(), 401);
        let json: serde_json::Value = serde_json::from_slice(&r.bytes().await.unwrap()).unwrap();
        assert_eq!(json["error"]["type"], "authentication_error");
        assert_eq!(c.post(format!("{anthropic}/v1/messages")).send().await.unwrap().status(), 401);
        let r = post(format!("{gemini}/v1beta/models/x:generateContent")).send().await.unwrap();
        assert_eq!(r.status(), 401);
        let json: serde_json::Value = serde_json::from_slice(&r.bytes().await.unwrap()).unwrap();
        assert_eq!(json["error"]["status"], "UNAUTHENTICATED");
        // A path no CLI needs, a browser request, a rebinding Host.
        assert_eq!(post(format!("{anthropic}/v1/files")).send().await.unwrap().status(), 404);
        assert_eq!(c.head(format!("{anthropic}/api/hello")).send().await.unwrap().status(), 401);
        assert_eq!(
            post(format!("{anthropic}/v1/messages")).header("origin", "https://example.org").send().await.unwrap().status(),
            403
        );
        assert_eq!(
            post(format!("{anthropic}/v1/messages")).header("host", "evil.example:80").send().await.unwrap().status(),
            403
        );
        // A body past the bound.
        let r = c
            .post(format!("{anthropic}/v1/messages"))
            .header("x-api-key", token.clone())
            .body(vec![b'x'; 4096])
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 413);
        // Revoked with its tab.
        on_tab_gone("e2e:refuse");
        assert_eq!(post(format!("{anthropic}/v1/messages")).send().await.unwrap().status(), 401);
        assert_eq!(seen.hits.load(Ordering::SeqCst), 0, "the provider saw nothing");

        // A good token with no key saved: refused, with the reason.
        let port = proxy(upstream, None, 1024).await;
        let token = issue_grant(grant(Provider::Gemini, "e2e:nokey", None)).unwrap();
        let r = c
            .post(format!("{}/v1beta/models/x:generateContent?key={token}", base_url_on(port, Provider::Gemini)))
            .body("{}")
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 401);
        let json: serde_json::Value = serde_json::from_slice(&r.bytes().await.unwrap()).unwrap();
        assert!(json["error"]["message"].as_str().unwrap().contains("Manage CLIs"));
        assert_eq!(seen.hits.load(Ordering::SeqCst), 0);
        on_tab_gone("e2e:nokey");
    }

    #[tokio::test]
    async fn gemini_requests_carry_the_key_in_its_header_and_drop_the_query_token() {
        let seen = Arc::new(Seen::default());
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        release.add_permits(1);
        let upstream = stub_upstream(seen.clone(), release).await;
        let port = proxy(upstream, Some(FAKE_KEY), MAX_BODY).await;
        let token = issue_grant(grant(Provider::Gemini, "e2e:gemini", None)).unwrap();
        let r = plain_client()
            .post(format!(
                "{}/v1beta/models/gemini-test:streamGenerateContent?alt=sse&key={token}",
                base_url_on(port, Provider::Gemini)
            ))
            .header("x-goog-api-key", token.clone())
            .body("{}")
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200);
        let _ = r.bytes().await.unwrap();
        let requests = lock(&seen.requests);
        let (_, uri, headers, _) = &requests[0];
        assert_eq!(uri, "/v1beta/models/gemini-test:streamGenerateContent?alt=sse");
        assert_eq!(headers["x-goog-api-key"], FAKE_KEY);
        drop(requests);
        on_tab_gone("e2e:gemini");
    }

    /// A0-style check of the real Claude CLI against this proxy and a stub
    /// provider: no network, a fake key, a scratch `HOME`. Run by hand:
    /// `C2_PROBE_CLAUDE=<path to the claude binary> cargo test -- --ignored
    /// claude_cli_talks_to_the_proxy`. Off the tab record: the child gets a
    /// cleared environment.
    #[tokio::test]
    #[ignore]
    async fn claude_cli_talks_to_the_proxy() {
        let Some(claude) = std::env::var_os("C2_PROBE_CLAUDE") else { return };
        let seen = Arc::new(Seen::default());
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        // Every response streams through at once.
        release.add_permits(1024);
        let upstream = stub_upstream(seen.clone(), release.clone()).await;
        let port = proxy(upstream, Some(FAKE_KEY), MAX_BODY).await;
        let token = issue_grant(grant(Provider::Anthropic, "e2e:claude", None)).unwrap();
        let home = tempfile::tempdir().unwrap();
        let out = tokio::process::Command::new(claude)
            .env_clear()
            .env("HOME", home.path())
            .env("PATH", "/usr/bin:/bin")
            .env("ANTHROPIC_BASE_URL", base_url_on(port, Provider::Anthropic))
            .env("ANTHROPIC_AUTH_TOKEN", &token)
            .env("DISABLE_AUTOUPDATER", "1")
            .args(["-p", "say hi"])
            .current_dir(home.path())
            .output();
        let out = tokio::time::timeout(Duration::from_secs(120), out).await.unwrap().unwrap();
        eprintln!("exit: {:?}\nstdout: {}", out.status, String::from_utf8_lossy(&out.stdout));
        let requests = lock(&seen.requests);
        for (method, uri, headers, body) in requests.iter() {
            eprintln!(
                "upstream saw {method} {uri}; real key in its header: {}; bearer header present: {}; body {} bytes",
                headers.get("x-api-key").map(|v| v == FAKE_KEY).unwrap_or(false),
                headers.contains_key("authorization"),
                body.len()
            );
            assert_eq!(headers["x-api-key"], FAKE_KEY);
            assert!(!headers.contains_key("authorization"));
        }
        assert!(requests.iter().any(|(m, u, _, _)| m == "POST" && u.starts_with("/v1/messages")));
        drop(requests);
        on_tab_gone("e2e:claude");
    }
}
