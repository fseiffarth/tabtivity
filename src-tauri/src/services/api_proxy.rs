//! The provider API proxy: the real key never enters an agent process
//! (`docs/api_chat_plan.md`, Part C, C2).
//!
//! A user's provider key (`agent_api_keys`: the OS keychain, or on a hosted
//! server the per-user vault) — or a server administrator's key, which this
//! user's daemon asks the key keeper for (`server::agent_keys::for_proxy`,
//! #2389) — stays inside Tabtivity. A keyed agent spawn gets two things instead:
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
//! the real key in the provider's own header (an administrator's key that
//! goes through the server's key broker: to the broker's loopback URL, with
//! this user's broker token instead — the broker swaps it for the key) — only on a path that provider's
//! CLIs need ([`path_allowed`]), with a bounded body, never following a
//! redirect, and with the response (Server-Sent Events included) passed back
//! chunk by chunk as it arrives. A token that leaks — a project's CLI config
//! that redirects the base URL, a prompt-injected `env` dump — is worthless off
//! this machine and dies with its tab.
//!
//! **Its own listener**, not a route on the MCP listener (`commands::root_mcp`):
//! that one is shaped for one small JSON-RPC message per socket — 30 s socket
//! lifetime, `Connection: close`, a 1 MiB-class body bound, JSON-only — and a
//! model turn streams for minutes with request bodies of several MiB. It runs
//! in the app's own process, so its bounds protect the app: 64 sockets, a
//! socket with no request in flight dropped after [`IDLE_WAIT`], an unread
//! answer after [`WRITE_STALL`], [`MAX_BODY`] per request and
//! [`MAX_BUFFERED`] held over all of them.
//!
//! **Lifetime.** A token is revoked when its tab ends ([`on_tab_gone`], from
//! `agent_fence::on_tab_gone`, which every tab teardown reaches). A tab running
//! in a local tmux session outlives its PTY (a project switch or window reload
//! kills only the tmux client), so its grant is bound to the session and
//! revoked once that session is gone: killed by Tabtivity
//! ([`on_tmux_session_gone`]), or found gone by [`sweep_tmux`] (after a tab's
//! PTY ends, and once a minute while such a grant is held). A rename moves
//! the binding ([`on_tmux_renamed`]). A respawn of the same tab gets the same
//! token back ([`issue`]), which is what keeps a re-attached agent working.
//! Everything is revoked and the listener stopped in the `RunEvent::Exit`
//! teardown ([`stop_for_exit`]); a clean quit also ends Tabtivity's tmux
//! sessions, so no agent outlives its proxy then. After a crash a re-attached
//! keyed agent holds a dead token: restart the CLI. The listener binds the
//! port of the last run again when it can, so such an agent's requests (and
//! its conversation) reach this proxy's refusal, not whatever else on the
//! machine took the port.
//!
//! **Who can use a token.** Any local process that holds one — loopback is
//! open to every user of the machine, so the token alone is the credential:
//! 256 random bits, only in the tab's environment (readable by its own user
//! alone) and the carrier on the user's own tmux server, never on an argv or
//! disk. Tokens are looked up in a `HashMap` keyed by the token: SipHash with
//! a random per-process key, so a lookup's timing says nothing an attacker
//! can steer toward a live token.
//!
//! **Never logged:** keys, tokens, bodies, query strings. Nothing here logs a
//! request at all.
//!
//! `AppHandle`-free; the server runs on Tauri's async runtime. The only way
//! to point it at another upstream is the `cfg(test)` [`Upstream::Test`]
//! variant, which no project or agent can reach.

use std::collections::{HashMap, HashSet};
use app_core::sync::LockExt;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, AtomicUsize, Ordering};
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
/// Request bodies held in memory at once, over every socket: 64 sockets of
/// [`MAX_BODY`] each would be 2 GiB in the app's own process.
const MAX_BUFFERED: usize = 256 * 1024 * 1024;
/// Sockets open at once.
const SOCKETS: usize = 64;
/// How long a socket with no request in flight may take to deliver the next
/// request's head (after the accept, or after the last answer ended) before it
/// is dropped: an idle keep-alive or a trickled head does not hold a slot.
const IDLE_WAIT: Duration = Duration::from_secs(60);
/// How long the client may leave an answer's bytes unread.
const WRITE_STALL: Duration = READ_IDLE;
/// A keychain read that found nothing is retried after this, not per request.
const MISSING_KEY_RETRY: Duration = Duration::from_secs(15);

/// The provider's one API host. HTTPS only; nothing else is ever dialled.
pub fn upstream_host(provider: Provider) -> &'static str {
    match provider {
        Provider::Anthropic => "api.anthropic.com",
        Provider::Gemini => "generativelanguage.googleapis.com",
        Provider::OpenAi => "api.openai.com",
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
    /// The CLI whose hosted-server administrator's key this grant forwards
    /// with (`server::agent_keys`), instead of the user's own key. Such a
    /// request is not charged to the user's own limit: a brokered key is
    /// budgeted at the broker, a direct one has none (§5.4).
    pub admin: Option<&'static str>,
}

/// A grant and when it was first issued: a tmux-bound one is spared by the
/// sweep for [`SWEEP_GRACE`] after that, since the session it names is only
/// created once the spawn that carries its token starts.
struct Held {
    grant: Grant,
    since: Instant,
}

fn grants() -> &'static Mutex<HashMap<String, Held>> {
    static GRANTS: OnceLock<Mutex<HashMap<String, Held>>> = OnceLock::new();
    GRANTS.get_or_init(Default::default)
}

fn mint() -> Option<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).ok()?;
    Some(crate::digest::hex(&bytes))
}

/// A grant for `tab` with no key, upstream or tmux session behind it, as
/// [`issue`] hands a spawn — for other modules' teardown tests.
#[cfg(test)]
pub(crate) fn issue_for_test(scope: &str, tab: &str) -> Option<String> {
    issue_grant(Grant { provider: Provider::Anthropic, scope: scope.to_string(), tab: tab.to_string(), tmux: None, admin: None })
}

/// The token for `grant`: the one it already holds (a respawn of the same tab
/// re-attaches the agent that still carries it), else a new one. `None` only
/// without system randomness.
fn issue_grant(grant: Grant) -> Option<String> {
    let mut map = grants().lock_ok();
    if let Some((token, _)) = map.iter().find(|(_, h)| h.grant == grant) {
        return Some(token.clone());
    }
    let token = mint()?;
    map.insert(token.clone(), Held { grant, since: Instant::now() });
    Some(token)
}

/// A proxy token and the base URL for a keyed spawn, or `None` when the proxy
/// is not running in this process (the `--agent-shim` process never runs it,
/// so a CLI typed into a shell tab stays on its own login) or, for the user's
/// own key (`admin` `None`), the provider has no key saved. Reads the keychain
/// only on a cold cache; an administrator's key is not fetched here — the
/// spawn checked its offer (`server::agent_keys::admin_for_spawn`) and every
/// request asks again. `tmux` is the local session the agent will run in —
/// [`tmux_binding`] of the tab's session name, so a tab whose session name no
/// tmux will ever create is not kept past its PTY.
pub fn issue(provider: Provider, admin: Option<&'static str>, scope: &str, tab: &str, tmux: Option<&str>) -> Option<(String, String)> {
    let base = base_url(provider)?;
    if admin.is_none() {
        key_for(provider)?;
    }
    let token = issue_grant(Grant {
        provider,
        scope: scope.to_string(),
        tab: tab.to_string(),
        tmux: tmux.map(str::to_string),
        admin,
    })?;
    Some((token, base))
}

/// The tmux session a spawn's grant is bound to: the tab's `tmux_session`,
/// but only where a local tmux runs it (`tmux_local::wrap_pty_options_local`
/// is a no-op without one — Windows, no tmux installed). A grant bound to a
/// session that never exists would outlive its tab: the sweep cannot tell
/// "no tmux" from "tmux failed this once" and leaves such grants alone.
pub fn tmux_binding(session: Option<&str>) -> Option<String> {
    session
        .filter(|_| crate::services::tmux_local::tmux_available())
        .map(str::to_string)
}

fn lookup(token: &str) -> Option<Grant> {
    grants().lock_ok().get(token).map(|h| h.grant.clone())
}

/// Whether a proxy token is live. For the spawn path's tests and diagnostics;
/// never logs it.
pub fn token_live(token: &str) -> bool {
    grants().lock_ok().contains_key(token)
}

/// A tab ended (closed, its process exited, or the app is quitting). Its
/// grants without a tmux session go now; the ones bound to a tmux session go
/// once that session is gone — checked off this thread, which may be a PTY
/// teardown path.
pub fn on_tab_gone(tab: &str) {
    let mut tmux_bound = false;
    grants().lock_ok().retain(|_, h| {
        if h.grant.tab != tab {
            return true;
        }
        tmux_bound |= h.grant.tmux.is_some();
        h.grant.tmux.is_some()
    });
    if tmux_bound && !STOPPING.load(Ordering::Acquire) {
        std::thread::spawn(sweep_tmux);
    }
}

/// A local tmux session was killed on purpose (`local_tmux_kill`: a tab's
/// explicit close, the Sessions view): its grants go now, not at the next
/// sweep.
pub fn on_tmux_session_gone(session: &str) {
    grants().lock_ok().retain(|_, h| h.grant.tmux.as_deref() != Some(session));
}

/// A local tmux session was renamed (`local_tmux_rename`): its agent keeps
/// running, so its grants follow the new name rather than being swept as gone.
pub fn on_tmux_renamed(old: &str, new: &str) {
    for held in grants().lock_ok().values_mut() {
        if held.grant.tmux.as_deref() == Some(old) {
            held.grant.tmux = Some(new.to_string());
        }
    }
}

/// Revoke every grant whose tmux session no longer exists. A `tmux` that
/// cannot be run at all leaves the grants alone (a later sweep or the quit
/// revokes them); one that answers "no server" means every session is gone.
/// Runs after a tmux-bound tab's PTY ends and once a minute while any
/// tmux-bound grant is held (a session can also end with no PTY attached — a
/// phone-started one, a `tmux kill-session` typed elsewhere).
pub fn sweep_tmux() {
    if !grants().lock_ok().values().any(|h| h.grant.tmux.is_some()) {
        return;
    }
    let Some(live) = live_tmux_sessions() else { return };
    retain_live(&mut grants().lock_ok(), &live, Instant::now());
}

/// How long a fresh tmux-bound grant is spared by the sweep: its session is
/// created only when the spawn's tmux client starts.
const SWEEP_GRACE: Duration = Duration::from_secs(60);
/// How often held tmux-bound grants are checked against the live sessions.
const SWEEP_EVERY: Duration = Duration::from_secs(60);

fn retain_live(map: &mut HashMap<String, Held>, live: &HashSet<String>, now: Instant) {
    map.retain(|_, h| {
        h.grant.tmux.as_ref().is_none_or(|s| live.contains(s))
            || now.saturating_duration_since(h.since) < SWEEP_GRACE
    });
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
    grants().lock_ok().clear();
}

// ---------------------------------------------------------------------------
// Keys (cached in memory; the keychain read is off the request path)

/// The largest Anthropic 400 answer read whole to see whether it asks for a
/// workspace ([`Refusal::NoWorkspace`]); a longer one is passed on as is.
const MAX_PEEKED_ERROR: u64 = 64 * 1024;

/// The request header naming the workspace an Anthropic key that is not
/// scoped to one runs in.
const WORKSPACE_HEADER: &str = "anthropic-workspace-id";

/// A user's own key and the workspace its requests name
/// (`agent_api_keys::get_workspace`), if any.
#[derive(Clone)]
pub struct StoredKey {
    pub key: String,
    pub workspace: Option<String>,
}

enum Cached {
    Key(StoredKey),
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
    stored_for(provider).map(|stored| stored.key)
}

/// [`key_for`] with the workspace stored beside the key (read with it).
pub fn stored_for(provider: Provider) -> Option<StoredKey> {
    match keys().lock_ok().get(&provider) {
        Some(Cached::Key(k)) => return Some(k.clone()),
        Some(Cached::Missing(at)) if at.elapsed() < MISSING_KEY_RETRY => return None,
        _ => {}
    }
    let generation = KEY_GENERATION.load(Ordering::Acquire);
    let read = super::agent_api_keys::get_key(provider)
        .map(|key| StoredKey { key, workspace: super::agent_api_keys::get_workspace(provider) });
    let mut cache = keys().lock_ok();
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
    let mut cache = keys().lock_ok();
    KEY_GENERATION.fetch_add(1, Ordering::AcqRel);
    cache.remove(&provider);
}

/// An administrator's key (or broker token) as the keeper last answered it
/// for a CLI, trusted for [`ADMIN_KEY_FRESH`]: a turn makes several requests,
/// and the keeper serves every user of the server. A withdraw, a removal from
/// the key's list or the user's switch back reaches a running agent within
/// that time; a 401 from upstream (a rotated key, a renewed token) drops it
/// at once.
struct AdminCached {
    key: zeroize::Zeroizing<String>,
    broker: Option<String>,
    at: Instant,
}

const ADMIN_KEY_FRESH: Duration = Duration::from_secs(60);

fn admin_keys() -> &'static Mutex<HashMap<&'static str, AdminCached>> {
    static ADMIN: OnceLock<Mutex<HashMap<&'static str, AdminCached>>> = OnceLock::new();
    ADMIN.get_or_init(Default::default)
}

/// `cli`'s administrator key and broker URL for this user, from the cache or
/// the keeper. `Err` with the refusal the request gets.
fn admin_key_for(cli: &'static str) -> Result<(zeroize::Zeroizing<String>, Option<String>), Refusal> {
    if let Some(held) = admin_keys().lock_ok().get(cli).filter(|h| h.at.elapsed() < ADMIN_KEY_FRESH) {
        return Ok((held.key.clone(), held.broker.clone()));
    }
    match super::server::agent_keys::for_proxy(cli) {
        Ok(Some(found)) => {
            let answer = (found.key.clone(), found.broker.clone());
            admin_keys().lock_ok().insert(cli, AdminCached { key: found.key, broker: found.broker, at: Instant::now() });
            Ok(answer)
        }
        Ok(None) => {
            admin_keys().lock_ok().remove(cli);
            Err(Refusal::AdminWithdrawn)
        }
        Err(_) => Err(Refusal::AdminUnavailable),
    }
}

/// The upstream refused `cli`'s administrator key: ask the keeper anew next.
fn forget_admin_key(cli: &str) {
    admin_keys().lock_ok().remove(cli);
}

// ---------------------------------------------------------------------------
// Runtime

static PORT: AtomicU16 = AtomicU16::new(0);
static STOPPING: AtomicBool = AtomicBool::new(false);
static SHUTDOWN: tokio::sync::Notify = tokio::sync::Notify::const_new();
static SERVER: Mutex<Option<tokio::task::JoinHandle<()>>> = Mutex::new(None);

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
    /// An administrator's key (and broker URL) for every admin grant; the
    /// user's own key for the rest.
    #[cfg(test)]
    FixedAdmin { own: Option<&'static str>, admin: Option<(&'static str, Option<String>)> },
    /// A user's key stored with the workspace it names.
    #[cfg(test)]
    FixedInWorkspace(&'static str, &'static str),
}

impl KeySource {
    async fn key(&self, provider: Provider) -> Option<StoredKey> {
        #[cfg(test)]
        let own = |k: &Option<&str>| k.map(|key| StoredKey { key: key.to_string(), workspace: None });
        match self {
            KeySource::Keychain => app_core::rt::spawn_blocking(move || stored_for(provider))
                .await
                .ok()
                .flatten(),
            #[cfg(test)]
            KeySource::Fixed(k) => own(k),
            #[cfg(test)]
            KeySource::FixedAdmin { own: k, .. } => own(k),
            #[cfg(test)]
            KeySource::FixedInWorkspace(key, workspace) => {
                Some(StoredKey { key: key.to_string(), workspace: Some(workspace.to_string()) })
            }
        }
    }

    /// The key (or broker token) and broker URL an administrator-keyed grant
    /// of `cli` forwards with.
    async fn admin(&self, cli: &'static str) -> Result<(zeroize::Zeroizing<String>, Option<String>), Refusal> {
        match self {
            KeySource::Keychain => app_core::rt::spawn_blocking(move || admin_key_for(cli))
                .await
                .unwrap_or(Err(Refusal::AdminUnavailable)),
            #[cfg(test)]
            KeySource::Fixed(_) | KeySource::FixedInWorkspace(..) => Err(Refusal::AdminWithdrawn),
            #[cfg(test)]
            KeySource::FixedAdmin { admin, .. } => admin
                .clone()
                .map(|(key, broker)| (zeroize::Zeroizing::new(key.to_string()), broker))
                .ok_or(Refusal::AdminWithdrawn),
        }
    }
}

/// The spending limit (C3, `api_usage`): the ledger answers are charged to,
/// and where the monthly limit comes from.
#[derive(Clone)]
struct Budget {
    book: Arc<super::api_usage::Book>,
    limits: Limits,
}

#[derive(Clone)]
enum Limits {
    /// `Settings::agent_api_token_limits`.
    Settings,
    #[cfg(test)]
    Fixed(Option<u64>),
}

impl Budget {
    /// The app's ledger and the limits in `settings.json`.
    fn app() -> Self {
        Budget { book: super::api_usage::book(), limits: Limits::Settings }
    }

    fn limit(&self, provider: Provider) -> Option<u64> {
        match &self.limits {
            Limits::Settings => super::api_usage::limit_for(provider),
            #[cfg(test)]
            Limits::Fixed(l) => *l,
        }
    }

    /// Why a billed request for `provider` is refused now, if it is: no
    /// limit, or spent + what requests in flight hold reached it.
    fn refusal(&self, provider: Provider) -> Option<Refusal> {
        let verdict = self.book.verdict(provider, self.limit(provider), chrono::Utc::now());
        Self::refusal_for(verdict)
    }

    /// Hold `tokens`, the request's worst case in billed tokens, against the
    /// limit while it is in flight (gap 9).
    fn reserve(&self, provider: Provider, tokens: u64) -> Result<super::api_usage::Reservation, Refusal> {
        self.book
            .reserve(provider, tokens, self.limit(provider), chrono::Utc::now())
            .map_err(|verdict| Self::refusal_for(verdict).unwrap_or(Refusal::WouldPass))
    }

    fn refusal_for(verdict: super::api_usage::Verdict) -> Option<Refusal> {
        match verdict {
            super::api_usage::Verdict::Open => None,
            super::api_usage::Verdict::NoLimit => Some(Refusal::NoBudget),
            // Spent alone reached it: the plain message. Otherwise requests
            // in flight, or this one's worst case, would pass it.
            super::api_usage::Verdict::Reached { spent, limit } if spent >= limit => Some(Refusal::BudgetReached),
            super::api_usage::Verdict::Reached { .. } => Some(Refusal::WouldPass),
        }
    }
}

#[derive(Clone)]
struct ProxyState {
    port: u16,
    upstream: Upstream,
    keys: KeySource,
    budget: Budget,
    client: reqwest::Client,
    /// For the server's key broker only: plain HTTP on loopback, which the
    /// provider client (HTTPS only) refuses. Never any other host — the
    /// broker URL is checked to be loopback (`server::agent_keys`).
    loopback: reqwest::Client,
    max_body: usize,
    /// Request body bytes held right now, over every socket.
    buffered: Arc<AtomicUsize>,
    max_buffered: usize,
    /// [`IDLE_WAIT`]; shorter in tests.
    idle_wait: Duration,
}

impl ProxyState {
    fn new(port: u16, upstream: Upstream, keys: KeySource, budget: Budget, client: reqwest::Client, loopback: reqwest::Client) -> Self {
        ProxyState {
            port,
            upstream,
            keys,
            budget,
            client,
            loopback,
            max_body: MAX_BODY,
            buffered: Arc::new(AtomicUsize::new(0)),
            max_buffered: MAX_BUFFERED,
            idle_wait: IDLE_WAIT,
        }
    }
}

fn client(https_only: bool) -> Result<reqwest::Client, String> {
    crate::services::mail_engine::install_crypto_provider();
    reqwest::Client::builder()
        // The key must never follow a redirect to another host.
        .redirect(reqwest::redirect::Policy::none())
        .https_only(https_only)
        // The body passes through as the provider sent it; the request asks
        // for `accept-encoding: identity` (the client's own is not
        // forwarded), so C3 reads usage from plain bytes.
        .no_gzip()
        .no_brotli()
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(READ_IDLE)
        .build()
        .map_err(|e| format!("API proxy: {e}"))
}

/// How long [`check_key`] waits for the provider before saving untested.
const KEY_CHECK_WAIT: Duration = Duration::from_secs(10);

/// What [`check_key`] found out about a key the provider did not refuse.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyCheck {
    /// Save it, with the workspace its requests name (`Some` only for an
    /// Anthropic key that is not scoped to one).
    Save { workspace: Option<String> },
    /// An Anthropic key that is not scoped to a workspace, and none was
    /// chosen: every request has to name one (`anthropic-workspace-id`). The
    /// workspaces the key listed, for the user to pick from — empty when it
    /// could list none, and the user types the id instead.
    PickWorkspace(Vec<Workspace>),
}

/// An Anthropic workspace a key can name.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
}

/// Ask the provider about `key` before Manage CLIs saves it: `Err` only when
/// it definitely refused it — a Claude subscription token by its prefix, a
/// refused model listing (free, the key in the provider's own header), or a
/// chosen workspace the key cannot use. An unreachable provider (offline)
/// lets the key be saved untested. An Anthropic key that is not scoped to a
/// workspace (Anthropic answers its listing with a 400 naming the
/// `anthropic-workspace-id` header) is saved with `workspace` once that one
/// answers, or with the only workspace it lists; otherwise the user picks.
pub async fn check_key(provider: Provider, key: &str, workspace: Option<&str>) -> Result<KeyCheck, String> {
    check_key_at(&Upstream::Provider.base(provider), provider, key, workspace, true).await
}

async fn check_key_at(
    base: &str,
    provider: Provider,
    key: &str,
    workspace: Option<&str>,
    https_only: bool,
) -> Result<KeyCheck, String> {
    if provider == Provider::Anthropic && key.starts_with("sk-ant-oat") {
        return Err("this is a Claude subscription token, not an API key — create an API key in the Anthropic Console (it starts with sk-ant-api)".into());
    }
    let workspace = workspace.filter(|_| provider == Provider::Anthropic);
    if workspace.is_some_and(|w| !super::agent_api_keys::workspace_shape_ok(w)) {
        return Err("not a workspace id (it starts with wrkspc_)".into());
    }
    let untested = KeyCheck::Save { workspace: workspace.map(str::to_string) };
    let Ok(client) = client(https_only) else {
        return Ok(untested);
    };
    let path = match provider {
        Provider::Anthropic | Provider::OpenAi => "/v1/models",
        Provider::Gemini => "/v1beta/models",
    };
    let Some((status, body)) = ask_with_key(&client, base, path, provider, key, workspace).await? else {
        return Ok(untested);
    };
    // Gemini answers a bad key with a 400 naming the reason.
    let rejected = status == StatusCode::UNAUTHORIZED
        || (provider == Provider::Gemini && status == StatusCode::BAD_REQUEST && body.contains("API_KEY_INVALID"));
    if rejected {
        let who = match provider {
            Provider::Anthropic => "Anthropic",
            Provider::Gemini => "Google",
            Provider::OpenAi => "OpenAI",
        };
        return Err(format!("{who} rejected this API key (wrong, revoked, or not an API key) — it was not saved"));
    }
    if provider != Provider::Anthropic {
        return Ok(untested);
    }
    if let Some(id) = workspace {
        return match status {
            StatusCode::NOT_FOUND | StatusCode::FORBIDDEN => Err(format!(
                "this key cannot use workspace {id}: it does not exist, or the key's account is not a member of it — it was not saved"
            )),
            StatusCode::BAD_REQUEST => Err(format!("Anthropic refused workspace {id} for this key — it was not saved")),
            _ => Ok(untested),
        };
    }
    if !(status == StatusCode::BAD_REQUEST && body.contains("anthropic-workspace-id")) {
        return Ok(untested);
    }
    let listed = list_workspaces(&client, base, key).await;
    if let [only] = listed.as_slice() {
        if let Ok(Some((status, _))) = ask_with_key(&client, base, path, provider, key, Some(&only.id)).await {
            if status.is_success() {
                return Ok(KeyCheck::Save { workspace: Some(only.id.clone()) });
            }
        }
    }
    Ok(KeyCheck::PickWorkspace(listed))
}

/// The model ids `provider`'s stored key may call, as the provider's own
/// listing answers it (free, the key in the provider's own header and its
/// workspace beside it): `None` with no key, no answer in
/// [`KEY_CHECK_WAIT`], a refusal or a body that is no listing
/// (`opencode_models::listed_ids`).
pub async fn key_models(provider: Provider) -> Option<Vec<String>> {
    let stored = app_core::rt::spawn_blocking(move || stored_for(provider)).await.ok().flatten()?;
    key_models_at(&Upstream::Provider.base(provider), provider, &stored, true).await
}

async fn key_models_at(base: &str, provider: Provider, stored: &StoredKey, https_only: bool) -> Option<Vec<String>> {
    let client = client(https_only).ok()?;
    // One page: every provider lists far fewer models than these bounds.
    let path = match provider {
        Provider::Anthropic => "/v1/models?limit=1000",
        Provider::OpenAi => "/v1/models",
        Provider::Gemini => "/v1beta/models?pageSize=1000",
    };
    let (status, body) =
        ask_with_key(&client, base, path, provider, &stored.key, stored.workspace.as_deref()).await.ok().flatten()?;
    if !status.is_success() {
        return None;
    }
    super::opencode_models::listed_ids(provider, &body)
}

/// A GET of `path` with `key` in the provider's own header (and, for
/// Anthropic, the version and `workspace`): its status and body, `None` when
/// the provider did not answer in [`KEY_CHECK_WAIT`].
async fn ask_with_key(
    client: &reqwest::Client,
    base: &str,
    path: &str,
    provider: Provider,
    key: &str,
    workspace: Option<&str>,
) -> Result<Option<(StatusCode, String)>, String> {
    let value = if provider == Provider::OpenAi { format!("Bearer {key}") } else { key.to_string() };
    let Ok(mut value) = HeaderValue::from_str(&value) else {
        return Err("not a usable API key".into());
    };
    value.set_sensitive(true);
    let mut request = client.get(format!("{base}{path}")).header(auth_header(provider), value);
    if provider == Provider::Anthropic {
        request = request.header("anthropic-version", "2023-06-01");
    }
    if let Some(id) = workspace {
        request = request.header(WORKSPACE_HEADER, id);
    }
    let answer = async {
        let response = request.send().await.ok()?;
        let status = response.status();
        Some((status, response.text().await.unwrap_or_default()))
    };
    Ok(tokio::time::timeout(KEY_CHECK_WAIT, answer).await.ok().flatten())
}

/// The workspaces an Anthropic key that is not scoped to one can name, Default
/// included and archived ones left out — empty when it may not list them.
async fn list_workspaces(client: &reqwest::Client, base: &str, key: &str) -> Vec<Workspace> {
    #[derive(serde::Deserialize)]
    struct Listed {
        id: String,
        #[serde(default)]
        name: String,
        #[serde(default)]
        archived_at: Option<String>,
    }
    #[derive(serde::Deserialize)]
    struct Page {
        data: Vec<Listed>,
    }
    let path = "/v1/organizations/workspaces?include_default=true&limit=100";
    let Ok(Some((status, body))) = ask_with_key(client, base, path, Provider::Anthropic, key, None).await else {
        return Vec::new();
    };
    if !status.is_success() {
        return Vec::new();
    }
    serde_json::from_str::<Page>(&body)
        .map(|page| {
            page.data
                .into_iter()
                .filter(|w| w.archived_at.is_none() && super::agent_api_keys::workspace_shape_ok(&w.id))
                .map(|w| Workspace { name: if w.name.is_empty() { w.id.clone() } else { w.name }, id: w.id })
                .collect()
        })
        .unwrap_or_default()
}

/// Where the port of the last run is remembered (not a secret): binding it
/// again keeps a tmux-held agent that outlived a crash talking to this proxy
/// (which refuses its dead token with a readable error) rather than to
/// whatever else on the machine may have taken the port meanwhile — its
/// requests carry the conversation.
fn port_file() -> std::path::PathBuf {
    crate::storage::state_dir().join("api-proxy-port")
}

/// A loopback listener on the remembered port, else on any free one.
fn bind_listener(preferred: Option<u16>) -> std::io::Result<std::net::TcpListener> {
    let listener = preferred
        .filter(|p| *p != 0)
        .and_then(|p| std::net::TcpListener::bind(("127.0.0.1", p)).ok())
        .map_or_else(|| std::net::TcpListener::bind(("127.0.0.1", 0)), Ok)?;
    listener.set_nonblocking(true)?;
    Ok(listener)
}

/// Bind the listener and serve until [`stop_for_exit`]. Called once from
/// `setup`; a failure leaves keyed CLIs on their own logins (no token, no base
/// URL is handed out while [`running`] is false) — the safe direction. The
/// bind happens here, synchronously, so the first restored tab already finds
/// the proxy running.
pub fn start() {
    let (client, loopback) = match (client(true), client(false)) {
        (Ok(c), Ok(l)) => (c, l),
        (Err(e), _) | (_, Err(e)) => {
            eprintln!("[api-proxy] {e}");
            return;
        }
    };
    let preferred = std::fs::read_to_string(port_file()).ok().and_then(|s| s.trim().parse::<u16>().ok());
    let listener = match bind_listener(preferred) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[api-proxy] bind failed: {e}");
            return;
        }
    };
    let Ok(addr) = listener.local_addr() else { return };
    let port = addr.port();
    if preferred != Some(port) {
        let _ = std::fs::write(port_file(), port.to_string());
    }
    PORT.store(port, Ordering::Release);
    let handle = app_core::rt::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(listener) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[api-proxy] listener: {e}");
                PORT.store(0, Ordering::Release);
                return;
            }
        };
        let state = ProxyState::new(port, Upstream::Provider, KeySource::Keychain, Budget::app(), client, loopback);
        if let Err(e) = serve(listener, state, async { SHUTDOWN.notified().await }).await {
            eprintln!("[api-proxy] server stopped: {e}");
        }
        PORT.store(0, Ordering::Release);
    });
    *SERVER.lock_ok() = Some(handle);
    // Grants bound to a tmux session that ended with no PTY attached.
    app_core::rt::spawn(async {
        while !STOPPING.load(Ordering::Acquire) {
            tokio::time::sleep(SWEEP_EVERY).await;
            if !STOPPING.load(Ordering::Acquire) {
                let _ = app_core::rt::spawn_blocking(sweep_tmux).await;
            }
        }
    });
}

/// `RunEvent::Exit`: hand out nothing more, revoke every token, stop accepting
/// and give streams in flight a short bounded drain. Idempotent.
pub fn stop_for_exit() {
    STOPPING.store(true, Ordering::Release);
    revoke_all();
    SHUTDOWN.notify_waiters();
    SHUTDOWN.notify_one();
    if let Some(handle) = SERVER.lock_ok().take() {
        app_core::rt::block_on(async {
            let _ = tokio::time::timeout(Duration::from_secs(2), handle).await;
        });
    }
    PORT.store(0, Ordering::Release);
    // What the drained answers cost (C3), past the throttle.
    super::api_usage::flush_for_exit();
}

async fn serve(
    listener: tokio::net::TcpListener,
    state: ProxyState,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    let idle_wait = state.idle_wait;
    let router = Router::new().fallback(handle).with_state(state);
    let listener = BoundedListener {
        tcp: listener,
        slots: Arc::new(tokio::sync::Semaphore::new(SOCKETS)),
        idle_wait,
    };
    axum::serve(listener, router.into_make_service_with_connect_info::<Conn>())
        .with_graceful_shutdown(shutdown)
        .await
}

/// Caps open sockets and bounds how long one may hold its slot doing nothing:
/// between requests (the next request's head must arrive within
/// [`IDLE_WAIT`] of the last answer's end, or of the accept) and while the
/// client does not read an answer ([`WRITE_STALL`]). No total lifetime and no
/// bound while a request is in flight — a model turn streams for minutes; the
/// body wait and the upstream read bound cover that.
struct BoundedListener {
    tcp: tokio::net::TcpListener,
    slots: Arc<tokio::sync::Semaphore>,
    idle_wait: Duration,
}

/// One connection's state, shared between its socket and the requests on it.
struct ConnState {
    /// Requests on this connection whose answer has not ended.
    busy: AtomicUsize,
    /// When `busy` last dropped to zero (or the accept).
    idle_since: Mutex<tokio::time::Instant>,
    idle_wait: Duration,
}

/// The handler's view of its connection (`ConnectInfo`).
#[derive(Clone)]
struct Conn(Arc<ConnState>);

impl axum::extract::connect_info::Connected<axum::serve::IncomingStream<'_, BoundedListener>> for Conn {
    fn connect_info(stream: axum::serve::IncomingStream<'_, BoundedListener>) -> Self {
        Conn(stream.io().conn.clone())
    }
}

/// Marks a request in flight on its connection until dropped — held by the
/// answer's body stream, so a streaming turn is never cut by the idle bound.
struct Busy(Arc<ConnState>);

impl Busy {
    fn new(conn: &Arc<ConnState>) -> Self {
        conn.busy.fetch_add(1, Ordering::AcqRel);
        Busy(conn.clone())
    }
}

impl Drop for Busy {
    fn drop(&mut self) {
        if self.0.busy.fetch_sub(1, Ordering::AcqRel) == 1 {
            *self.0.idle_since.lock_ok() = tokio::time::Instant::now();
        }
    }
}

struct BoundedStream {
    tcp: tokio::net::TcpStream,
    _slot: tokio::sync::OwnedSemaphorePermit,
    conn: Arc<ConnState>,
    idle: Pin<Box<tokio::time::Sleep>>,
    stall: Option<Pin<Box<tokio::time::Sleep>>>,
}

impl axum::serve::Listener for BoundedListener {
    type Io = BoundedStream;
    type Addr = std::net::SocketAddr;
    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            let slot = self.slots.clone().acquire_owned().await.expect("listener semaphore stays open");
            match self.tcp.accept().await {
                Ok((tcp, addr)) => {
                    let now = tokio::time::Instant::now();
                    let conn = Arc::new(ConnState {
                        busy: AtomicUsize::new(0),
                        idle_since: Mutex::new(now),
                        idle_wait: self.idle_wait,
                    });
                    let idle = Box::pin(tokio::time::sleep_until(now + self.idle_wait));
                    return (BoundedStream { tcp, _slot: slot, conn, idle, stall: None }, addr);
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
        if self.conn.busy.load(Ordering::Acquire) == 0 {
            let deadline = *self.conn.idle_since.lock_ok() + self.conn.idle_wait;
            if self.idle.deadline() != deadline {
                self.idle.as_mut().reset(deadline);
            }
            if self.idle.as_mut().poll(cx).is_ready() {
                return Poll::Ready(Err(std::io::ErrorKind::TimedOut.into()));
            }
        }
        Pin::new(&mut self.tcp).poll_read(cx, buf)
    }
}

impl BoundedStream {
    /// A write the client has not taken for [`WRITE_STALL`] ends the socket.
    fn stalled<T>(&mut self, cx: &mut Context<'_>, polled: Poll<std::io::Result<T>>) -> Poll<std::io::Result<T>> {
        if polled.is_ready() {
            self.stall = None;
            return polled;
        }
        let stall = self.stall.get_or_insert_with(|| Box::pin(tokio::time::sleep(WRITE_STALL)));
        if stall.as_mut().poll(cx).is_ready() {
            return Poll::Ready(Err(std::io::ErrorKind::TimedOut.into()));
        }
        Poll::Pending
    }
}

impl AsyncWrite for BoundedStream {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<std::io::Result<usize>> {
        let polled = Pin::new(&mut self.tcp).poll_write(cx, buf);
        self.stalled(cx, polled)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        let polled = Pin::new(&mut self.tcp).poll_flush(cx);
        self.stalled(cx, polled)
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
    /// The provider answered the user's own key with a 401: the stored key is
    /// wrong, revoked, or not an API key at all (a subscription token).
    KeyRejected,
    /// Anthropic wants the user's own key to name a workspace (a key that is
    /// not scoped to one, saved before a workspace was asked for).
    NoWorkspace,
    /// The provider's host could not be reached.
    Upstream,
    /// Too many request bodies held at once ([`MAX_BUFFERED`]).
    Busy,
    /// This month's spending limit for the provider is reached (C3).
    BudgetReached,
    /// Not reached yet, but what requests in flight hold plus this request's
    /// worst-case cost would pass it (gap 9).
    WouldPass,
    /// A key is saved but no monthly limit (a key from before limits
    /// existed): refused until one is set.
    NoBudget,
    /// An administrator-keyed grant whose key is no longer this user's: the
    /// administrator withdrew it or took them off its list, or they switched
    /// the CLI back to their own login.
    AdminWithdrawn,
    /// The key keeper could not be asked for the administrator's key.
    AdminUnavailable,
}

impl Refusal {
    fn status(self) -> StatusCode {
        match self {
            Refusal::Unauthorized | Refusal::NoKey | Refusal::KeyRejected | Refusal::AdminWithdrawn => StatusCode::UNAUTHORIZED,
            Refusal::Forbidden => StatusCode::FORBIDDEN,
            Refusal::NotFound => StatusCode::NOT_FOUND,
            Refusal::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            Refusal::BodyTimeout => StatusCode::REQUEST_TIMEOUT,
            Refusal::BadBody | Refusal::NoWorkspace => StatusCode::BAD_REQUEST,
            Refusal::Upstream => StatusCode::BAD_GATEWAY,
            Refusal::Busy | Refusal::AdminUnavailable => StatusCode::SERVICE_UNAVAILABLE,
            Refusal::BudgetReached | Refusal::WouldPass | Refusal::NoBudget => StatusCode::TOO_MANY_REQUESTS,
        }
    }

    fn message(self, provider: Option<Provider>) -> &'static str {
        match self {
            Refusal::BudgetReached => match provider {
                Some(Provider::OpenAi) => concat!(crate::app_name!(), " monthly API budget for OpenAI reached — raise it in Manage CLIs → API keys, or wait for next month"),
                Some(Provider::Gemini) => concat!(
                    crate::app_name!(),
                    " monthly API budget for Google Gemini reached — raise it in Manage CLIs → API keys, or wait for next month"
                ),
                _ => concat!(
                    crate::app_name!(),
                    " monthly API budget for Anthropic reached — raise it in Manage CLIs → API keys, or wait for next month"
                ),
            },
            Refusal::WouldPass => match provider {
                Some(Provider::OpenAi) => concat!(crate::app_name!(), " monthly API budget for OpenAI: this request could cost more than is left of it (requests still in flight count until they end) — wait for them, raise it in Manage CLIs → API keys, or wait for next month"),
                Some(Provider::Gemini) => concat!(
                    crate::app_name!(),
                    " monthly API budget for Google Gemini: this request could cost more than is left of it",
                    " (requests still in flight count until they end) — wait for them, raise it in Manage CLIs → API keys,",
                    " or wait for next month"
                ),
                _ => concat!(
                    crate::app_name!(),
                    " monthly API budget for Anthropic: this request could cost more than is left of it",
                    " (requests still in flight count until they end) — wait for them, raise it in Manage CLIs → API keys,",
                    " or wait for next month"
                ),
            },
            Refusal::NoBudget => match provider {
                Some(Provider::OpenAi) => concat!(crate::app_name!(), " has no monthly API budget set for OpenAI — set one in Manage CLIs → API keys"),
                Some(Provider::Gemini) => concat!(
                    crate::app_name!(),
                    " has no monthly API budget set for Google Gemini — set one in Manage CLIs → API keys"
                ),
                _ => concat!(
                    crate::app_name!(),
                    " has no monthly API budget set for Anthropic — set one in Manage CLIs → API keys"
                ),
            },
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
                " has no API key saved for this provider (or its key store is locked): add one in Manage CLIs → API keys"
            ),
            // Never naming the header: Claude turns an error that mentions
            // it into "Not logged in · Please run /login".
            Refusal::KeyRejected => match provider {
                Some(Provider::OpenAi) => concat!("OpenAI rejected the API key saved in ", crate::app_name!(), " (wrong, revoked, or not an API key) — replace it in Manage CLIs → API keys"),
                Some(Provider::Gemini) => concat!("Google rejected the Gemini API key saved in ", crate::app_name!(), " (wrong, revoked, or not an API key) — replace it in Manage CLIs → API keys"),
                _ => concat!(
                    "Anthropic rejected the API key saved in ", crate::app_name!(),
                    " (wrong, revoked, or a subscription token instead of a Console API key) — replace it in Manage CLIs → API keys"
                ),
            },
            Refusal::NoWorkspace => concat!(
                "the Anthropic API key saved in ", crate::app_name!(),
                " is not scoped to a workspace, and none is chosen for it — remove it in Manage CLIs → API keys and save it again to pick one"
            ),
            Refusal::Upstream => concat!(crate::app_name!(), " API proxy: the provider's API could not be reached"),
            Refusal::Busy => concat!(crate::app_name!(), " API proxy: too many large requests at once; try again"),
            Refusal::AdminWithdrawn => concat!(
                "the administrator no longer offers you this API key (withdrawn, or you were taken off its list), or you switched this CLI",
                " back to your own login — open a new tab after choosing in Manage CLIs"
            ),
            Refusal::AdminUnavailable => concat!(crate::app_name!(), " API proxy: the administrator's API key could not be fetched; try again"),
        }
    }

    /// Whether the CLI should try again: only for a transport failure or a
    /// momentary memory bound.
    fn retryable(self) -> bool {
        matches!(self, Refusal::Upstream | Refusal::Busy | Refusal::AdminUnavailable)
    }
}

/// A refusal in the provider's own error shape, so the CLI shows its message.
fn refuse(provider: Option<Provider>, refusal: Refusal) -> Response {
    let status = refusal.status();
    let message = refusal.message(provider);
    let body = match provider {
        Some(Provider::OpenAi) => serde_json::json!({
            "error": { "message": message, "type": if status == StatusCode::TOO_MANY_REQUESTS { "insufficient_quota" } else { "invalid_request_error" },
                "code": if status == StatusCode::TOO_MANY_REQUESTS { "insufficient_quota" } else { "api_proxy_error" }, "param": null }
        }),
        Some(Provider::Gemini) => serde_json::json!({
            "error": { "code": status.as_u16(), "message": message, "status": match refusal {
                Refusal::Unauthorized | Refusal::NoKey | Refusal::KeyRejected | Refusal::AdminWithdrawn => "UNAUTHENTICATED",
                Refusal::Forbidden => "PERMISSION_DENIED",
                Refusal::NotFound => "NOT_FOUND",
                Refusal::TooLarge | Refusal::BadBody | Refusal::NoWorkspace => "INVALID_ARGUMENT",
                Refusal::BodyTimeout => "DEADLINE_EXCEEDED",
                Refusal::Upstream | Refusal::Busy | Refusal::AdminUnavailable => "UNAVAILABLE",
                Refusal::BudgetReached | Refusal::WouldPass | Refusal::NoBudget => "RESOURCE_EXHAUSTED",
            } }
        }),
        // Anthropic's shape; also for a path naming no provider.
        _ => serde_json::json!({
            "type": "error",
            "error": { "type": match refusal {
                Refusal::Unauthorized | Refusal::NoKey | Refusal::KeyRejected | Refusal::AdminWithdrawn => "authentication_error",
                Refusal::Forbidden => "permission_error",
                Refusal::NotFound => "not_found_error",
                Refusal::TooLarge => "request_too_large",
                Refusal::BodyTimeout | Refusal::BadBody | Refusal::NoWorkspace => "invalid_request_error",
                Refusal::Upstream | Refusal::Busy | Refusal::AdminUnavailable => "api_error",
                Refusal::BudgetReached | Refusal::WouldPass | Refusal::NoBudget => "rate_limit_error",
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
        // Responses inference and compaction; no files, batches or stored
        // responses can be read through a tab's token.
        Provider::OpenAi => match segs.as_slice() {
            ["v1", "responses"] | ["v1", "responses", "compact"] => post,
            ["v1", "models"] => get,
            _ => false,
        },
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

/// The query parameters forwarded, by exact (unencoded) name: what the
/// provider's CLIs send — Claude's `?beta=true` and model-list paging, Gemini's
/// `alt=sse` and model-list paging. Everything else stays here: the token's
/// `key` (in any spelling — `%6Bey` is `key` to the provider), and anything
/// that would change what the request does there (Google's `$httpMethod`,
/// `access_token`, `$callback`).
fn query_allowed(provider: Provider, name: &str) -> bool {
    match provider {
        Provider::Anthropic => matches!(name, "beta" | "limit" | "after_id" | "before_id"),
        Provider::Gemini => matches!(name, "alt" | "pageSize" | "pageToken"),
        Provider::OpenAi => false,
    }
}

/// The query string to forward: only [`query_allowed`] parameters, in order.
fn forwarded_query(provider: Provider, query: Option<&str>) -> String {
    let kept: Vec<&str> = query
        .unwrap_or("")
        .split('&')
        .filter(|p| query_allowed(provider, p.split_once('=').map_or(p, |(name, _)| name)))
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
    // Google honours these in place of the method, which would step around
    // the per-path method allowlist.
    "x-http-method-override",
    "x-http-method",
    "x-method-override",
    // Google trims the answer to these fields: a mask without
    // `groundingMetadata` (or with part of `usageMetadata`) would leave a
    // complete answer the meter reads as cheaper than it was. (The `fields`
    // query parameter is not on the query allowlist.)
    "x-goog-fieldmask",
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
        Provider::OpenAi => "authorization",
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
    // The request is in flight on its socket until its answer ends (the
    // relayed body holds this), so the idle bound never cuts a stream.
    let busy = parts
        .extensions
        .get::<axum::extract::ConnectInfo<Conn>>()
        .map(|c| Busy::new(&c.0 .0));
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
    // The key and where it goes: the user's own to the provider; an
    // administrator's to the provider, or (brokered) this user's broker
    // token to the server's key broker.
    let (key, broker, workspace) = match grant.admin {
        None => match state.keys.key(provider).await {
            Some(stored) => (zeroize::Zeroizing::new(stored.key), None, stored.workspace),
            None => return refuse(Some(provider), Refusal::NoKey),
        },
        Some(cli) => match state.keys.admin(cli).await {
            Ok((key, broker)) => (key, broker, None),
            Err(refusal) => return refuse(Some(provider), refusal),
        },
    };
    let credential = zeroize::Zeroizing::new(if provider == Provider::OpenAi { format!("Bearer {}", key.as_str()) } else { key.to_string() });
    let Ok(mut key_value) = HeaderValue::from_str(&credential) else {
        return refuse(Some(provider), Refusal::NoKey);
    };
    key_value.set_sensitive(true);
    // The spending limit (C3): only a request that costs money on the user's
    // own key is metered and can be refused; token counting and model reads
    // pass, and an administrator's key is budgeted at the broker or not at
    // all (§5.4), never against the user's own limit.
    let mut meter = super::api_meter::billing(provider, parts.method.as_str(), rest)
        .filter(|_| grant.admin.is_none())
        .map(|billing| super::api_meter::Meter::new(provider, billing));
    if meter.is_some() {
        if let Some(refusal) = state.budget.refusal(provider) {
            return refuse(Some(provider), refusal);
        }
    }
    let read = read_body(body, state.max_body, &state.buffered, state.max_buffered);
    let (body, held) = match tokio::time::timeout(BODY_WAIT, read).await {
        Err(_) => return refuse(Some(provider), Refusal::BodyTimeout),
        Ok(Err(refusal)) => return refuse(Some(provider), refusal),
        Ok(Ok(read)) => read,
    };
    // Hold the request's worst-case cost against the limit until its answer
    // is charged (gap 9): checked against what was spent and what every
    // other request in flight holds — also answers that ended while the body
    // was read.
    let mut reservation = None;
    if let Some(meter) = meter.as_mut() {
        meter.request(&body);
        let worst = meter.worst_case_billed(&super::api_usage::month_of(chrono::Utc::now()));
        match state.budget.reserve(provider, worst) {
            Ok(held) => reservation = Some(held),
            Err(refusal) => return refuse(Some(provider), refusal),
        }
    }
    let base = broker.clone().unwrap_or_else(|| state.upstream.base(provider));
    let url = format!("{base}{rest}{}", forwarded_query(provider, query));
    let mut headers = copy_headers(&parts.headers, DROP_REQUEST);
    headers.insert(auth_header(provider), key_value);
    // A key that is not scoped to a workspace runs in the one chosen when it
    // was saved, whatever the CLI named.
    if let Some(value) = workspace.as_deref().and_then(|w| HeaderValue::from_str(w).ok()) {
        headers.insert(WORKSPACE_HEADER, value);
    }
    // Plain bytes, said outright: a request with no `accept-encoding` lets a
    // server pick any coding, and the meter reads usage from plain bytes (a
    // compressed answer would still be charged — as an estimate).
    headers.insert(header::ACCEPT_ENCODING, HeaderValue::from_static("identity"));
    // From here a billed request is charged however it ends — also when the
    // client leaves before the answer begins (this future is dropped then).
    let mut metered = Pending(meter.map(|meter| Metered {
        meter,
        book: state.budget.book.clone(),
        started: Instant::now(),
        reservation,
    }));
    let client = if broker.is_some() { &state.loopback } else { &state.client };
    let upstream = client.request(parts.method, url).headers(headers).body(body).send().await;
    // The body has been sent (or never will be): its bytes leave the budget.
    drop(held);
    let upstream = match upstream {
        Ok(upstream) => upstream,
        Err(e) => {
            // No connection: nothing reached the provider (dropping the meter
            // releases its reservation). Any later failure may follow a
            // request the provider took, so it is charged.
            if e.is_connect() {
                metered.0 = None;
            }
            return refuse(Some(provider), Refusal::Upstream);
        }
    };
    if let Some(cli) = grant.admin.filter(|_| upstream.status() == StatusCode::UNAUTHORIZED) {
        // A rotated key or a renewed broker token: the next request asks the
        // keeper anew.
        forget_admin_key(cli);
    }
    if grant.admin.is_none() && upstream.status() == StatusCode::UNAUTHORIZED {
        // The user's own key was refused. Said in the proxy's words: the
        // provider's (Anthropic's "invalid x-api-key") reads in Claude as
        // "Not logged in". An error answer costs nothing; the next request
        // reads the keychain again, in case the key was replaced there.
        if let Some(mut metered) = metered.0.take() {
            metered.meter.answer(StatusCode::UNAUTHORIZED.as_u16(), None);
            metered.settle(true);
        }
        forget_key(provider);
        return refuse(Some(provider), Refusal::KeyRejected);
    }
    if grant.admin.is_none()
        && workspace.is_none()
        && provider == Provider::Anthropic
        && upstream.status() == StatusCode::BAD_REQUEST
        && upstream.content_length().is_some_and(|n| n <= MAX_PEEKED_ERROR)
    {
        // Anthropic's answer to a key that has to name a workspace: said in
        // the proxy's words, with where to choose one. Any other 400 goes
        // back as it came. An error answer costs nothing.
        let status = upstream.status();
        let headers = copy_headers(upstream.headers(), DROP_RESPONSE);
        let body = tokio::time::timeout(BODY_WAIT, upstream.bytes()).await.ok().and_then(Result::ok).unwrap_or_default();
        if let Some(mut metered) = metered.0.take() {
            metered.meter.answer(status.as_u16(), None);
            metered.settle(true);
        }
        if String::from_utf8_lossy(&body).contains(WORKSPACE_HEADER) {
            return refuse(Some(provider), Refusal::NoWorkspace);
        }
        let mut response = Response::new(Body::from(body));
        *response.status_mut() = status;
        *response.headers_mut() = headers;
        return response;
    }
    relay(upstream, Tap::new(grant, busy, metered.0.take()))
}

/// A billed request between its send and its answer: charged an estimate if
/// dropped here (`api_meter`'s estimate for an answer that never began).
struct Pending(Option<Metered>);

impl Drop for Pending {
    fn drop(&mut self) {
        if let Some(metered) = self.0.take() {
            metered.settle(false);
        }
    }
}

/// Request body bytes counted against [`ProxyState::buffered`] until dropped.
struct HeldBody(Arc<AtomicUsize>, usize);

impl HeldBody {
    fn add(&mut self, n: usize, max: usize) -> bool {
        let before = self.0.fetch_add(n, Ordering::AcqRel);
        self.1 += n;
        before + n <= max
    }
}

impl Drop for HeldBody {
    fn drop(&mut self) {
        self.0.fetch_sub(self.1, Ordering::AcqRel);
    }
}

/// The request body, refused past `max` bytes (counted as it arrives, so a
/// body without a length is bounded too) or once every socket's bodies
/// together would pass `max_buffered`.
async fn read_body(
    body: Body,
    max: usize,
    buffered: &Arc<AtomicUsize>,
    max_buffered: usize,
) -> Result<(Bytes, HeldBody), Refusal> {
    use futures_util::StreamExt;
    let mut stream = body.into_data_stream();
    let mut out = Vec::new();
    let mut held = HeldBody(buffered.clone(), 0);
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| Refusal::BadBody)?;
        if out.len() + chunk.len() > max {
            return Err(Refusal::TooLarge);
        }
        if !held.add(chunk.len(), max_buffered) {
            return Err(Refusal::Busy);
        }
        out.extend_from_slice(&chunk);
    }
    Ok((Bytes::from(out), held))
}

/// How a relayed answer ended, for the ledger.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StreamEnd {
    /// The provider's body ended cleanly.
    Complete,
    /// Reading from the provider failed mid-body (reset, idle bound).
    Failed,
    /// The client went away before the end (or the app is quitting): what the
    /// provider sent so far may already be billed.
    Aborted,
}

/// A billed answer's meter, the ledger it is charged to, when its request
/// was sent, and its hold on the limit while in flight — released when this
/// drops, settled or not, so no path leaks it.
struct Metered {
    meter: super::api_meter::Meter,
    book: Arc<super::api_usage::Book>,
    started: Instant,
    reservation: Option<super::api_usage::Reservation>,
}

impl Metered {
    /// Charge what the answer reported — and, unless it ended `complete`
    /// with its final count, the estimate on top (`api_meter`); then release
    /// the reservation (after the charge, so the request never counts as
    /// neither).
    fn settle(mut self, complete: bool) {
        let now = chrono::Utc::now();
        let end = super::api_meter::End { complete, elapsed: self.started.elapsed() };
        if let Some(charge) = self.meter.charge(&super::api_usage::month_of(now), end) {
            self.book.record(self.meter.provider(), &charge, now);
        }
        drop(self.reservation.take());
    }
}

/// One relayed answer's tap: every chunk to [`usage_tap`], and exactly one
/// [`usage_end`] — on a clean end, a failed read, or (on drop) an abort.
struct Tap {
    grant: Grant,
    ended: bool,
    metered: Option<Metered>,
    _busy: Option<Busy>,
}

impl Tap {
    fn new(grant: Grant, busy: Option<Busy>, metered: Option<Metered>) -> Self {
        Tap { grant, ended: false, metered, _busy: busy }
    }

    /// The answer's status and content type, before its body.
    fn answer(&mut self, status: StatusCode, headers: &HeaderMap) {
        if let Some(Metered { meter, .. }) = self.metered.as_mut() {
            let content_type = headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok());
            meter.answer(status.as_u16(), content_type);
        }
    }

    fn chunk(&mut self, bytes: &Bytes) {
        usage_tap(&self.grant, self.metered.as_mut().map(|m| &mut m.meter), bytes);
    }

    fn end(&mut self, how: StreamEnd) {
        if !std::mem::replace(&mut self.ended, true) {
            usage_end(&self.grant, self.metered.take(), how);
        }
    }
}

impl Drop for Tap {
    fn drop(&mut self) {
        self.end(StreamEnd::Aborted);
    }
}

/// The provider's answer, passed back as it arrives: status, headers (less
/// hop-by-hop ones), and the body chunk by chunk — never collected first, or a
/// streaming CLI stalls.
fn relay(upstream: reqwest::Response, tap: Tap) -> Response {
    let status = upstream.status();
    let headers = copy_headers(upstream.headers(), DROP_RESPONSE);
    let mut tap = tap;
    tap.answer(status, upstream.headers());
    let stream = futures_util::stream::unfold(Some((upstream, tap)), |state| async move {
        let (mut upstream, mut tap) = state?;
        match upstream.chunk().await {
            Ok(Some(bytes)) => {
                tap.chunk(&bytes);
                Some((Ok::<Bytes, reqwest::Error>(bytes), Some((upstream, tap))))
            }
            Ok(None) => {
                tap.end(StreamEnd::Complete);
                None
            }
            Err(e) => {
                tap.end(StreamEnd::Failed);
                Some((Err(e), None))
            }
        }
    });
    let mut response = Response::new(Body::from_stream(stream));
    *response.status_mut() = status;
    *response.headers_mut() = headers;
    response
}

/// The spending limit's seam (C3): every response chunk of a granted request
/// that reached the provider, in order, as the provider sent it (no content
/// encoding — `accept-encoding: identity` is asked and the client decompresses
/// nothing), error answers included. A billed request's meter reads
/// Anthropic's `message_start` / `message_delta` usage and Gemini's
/// `usageMetadata` out of them (`api_meter`), keeping nothing else.
fn usage_tap(_grant: &Grant, meter: Option<&mut super::api_meter::Meter>, chunk: &Bytes) {
    #[cfg(test)]
    tests::record_tap(_grant, None);
    if let Some(meter) = meter {
        meter.feed(chunk);
    }
}

/// The answer ended — cleanly, by a failed read, or by the client going away.
/// Exactly once per answer [`usage_tap`] saw. What the provider reported so
/// far is charged in every case, and an answer that ended before its final
/// count an estimate on top: an aborted stream is billed by the provider.
fn usage_end(_grant: &Grant, metered: Option<Metered>, how: StreamEnd) {
    #[cfg(test)]
    tests::record_tap(_grant, Some(how));
    if let Some(metered) = metered {
        metered.settle(how == StreamEnd::Complete);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    // Fake test keys and tokens, never a real-looking provider shape.
    const FAKE_KEY: &str = "sk-test-proxy-fake";

    fn grant(provider: Provider, tab: &str, tmux: Option<&str>) -> Grant {
        Grant { provider, scope: "p1".into(), tab: tab.into(), tmux: tmux.map(str::to_string), admin: None }
    }

    #[test]
    fn routes_split_on_the_provider_prefix() {
        assert_eq!(split_route("/anthropic/v1/messages"), Some((Provider::Anthropic, "/v1/messages")));
        assert_eq!(split_route("/gemini/v1beta/models"), Some((Provider::Gemini, "/v1beta/models")));
        assert_eq!(split_route("/anthropic"), Some((Provider::Anthropic, "")));
        assert_eq!(split_route("/openai/v1/responses"), Some((Provider::OpenAi, "/v1/responses")));
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
    fn only_the_query_parameters_a_cli_sends_travel_on() {
        use Provider::*;
        assert_eq!(forwarded_query(Gemini, Some("alt=sse&key=abc")), "?alt=sse");
        assert_eq!(forwarded_query(Gemini, Some("key=abc")), "");
        assert_eq!(forwarded_query(Anthropic, Some("beta=true")), "?beta=true");
        assert_eq!(forwarded_query(Anthropic, None), "");
        assert_eq!(forwarded_query(Anthropic, Some("limit=100&after_id=m")), "?limit=100&after_id=m");
        assert_eq!(forwarded_query(Gemini, Some("pageSize=5&pageToken=x")), "?pageSize=5&pageToken=x");
        // The token in any spelling the provider would decode as `key`, a
        // method override, another credential, a JSONP callback: dropped.
        for q in ["%6Bey=abc", "Key=abc", "key", "$httpMethod=DELETE", "access_token=x", "$callback=f", "monkey=1"] {
            assert_eq!(forwarded_query(Gemini, Some(q)), "", "{q}");
            assert_eq!(forwarded_query(Anthropic, Some(q)), "", "{q}");
        }
        // One provider's parameters are not the other's.
        assert_eq!(forwarded_query(Anthropic, Some("alt=sse")), "");
        assert_eq!(forwarded_query(Gemini, Some("beta=true")), "");
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
            ("proxy-authorization", "Basic t"),
            ("x-http-method-override", "DELETE"),
            ("x-http-method", "DELETE"),
            ("x-method-override", "DELETE"),
            ("x-goog-fieldmask", "candidates.content,usageMetadata.promptTokenCount"),
            ("origin", "https://example.org"),
            ("te", "trailers"),
            ("transfer-encoding", "chunked"),
            ("content-length", "1"),
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
        let start = Instant::now();
        let held = |g: Grant| Held { grant: g, since: start };
        let mut map = HashMap::from([
            ("t1".to_string(), held(grant(Provider::Anthropic, "p1:tmux", Some("app-p1--a")))),
            ("t2".to_string(), held(grant(Provider::Anthropic, "p1:plain", None))),
        ]);
        let later = start + SWEEP_GRACE;
        retain_live(&mut map, &HashSet::from(["app-p1--a".to_string()]), later);
        assert_eq!(map.len(), 2);
        // A fresh grant outlives a sweep that runs before its session exists.
        retain_live(&mut map, &HashSet::new(), start + Duration::from_secs(1));
        assert_eq!(map.len(), 2, "within the grace");
        retain_live(&mut map, &HashSet::new(), later);
        assert!(map.contains_key("t2") && !map.contains_key("t1"));
    }

    #[test]
    fn a_killed_session_takes_its_grants_and_a_renamed_one_keeps_them() {
        let killed = issue_grant(grant(Provider::Anthropic, "p1:killed", Some("c2-sess-killed"))).unwrap();
        let renamed = issue_grant(grant(Provider::Anthropic, "p1:renamed", Some("c2-sess-old"))).unwrap();
        let other = issue_grant(grant(Provider::Anthropic, "p1:other", Some("c2-sess-other"))).unwrap();
        on_tmux_session_gone("c2-sess-killed");
        assert!(!token_live(&killed));
        on_tmux_renamed("c2-sess-old", "c2-sess-new");
        assert_eq!(lookup(&renamed).unwrap().tmux.as_deref(), Some("c2-sess-new"));
        assert_eq!(lookup(&other).unwrap().tmux.as_deref(), Some("c2-sess-other"));
        // A respawn of the renamed tab binds the new name and gets its token.
        assert_eq!(issue_grant(grant(Provider::Anthropic, "p1:renamed", Some("c2-sess-new"))).unwrap(), renamed);
        grants().lock_ok().retain(|t, _| *t != renamed && *t != other);
    }

    #[test]
    fn no_session_name_no_tmux_binding() {
        assert_eq!(tmux_binding(None), None);
        let bound = tmux_binding(Some("c2-sess"));
        assert_eq!(bound.is_some(), crate::services::tmux_local::tmux_available());
    }

    #[test]
    fn a_closed_tmux_tab_keeps_its_grant_for_the_sweep() {
        let token = issue_grant(grant(Provider::Gemini, "p1:kept", Some("not-a-real-session-c2"))).unwrap();
        // The PTY went, the session may not have: the grant stays until a
        // sweep finds the session gone — not within the grace a fresh grant
        // has, so the sweep this spawns leaves it.
        on_tab_gone("p1:kept");
        assert!(token_live(&token));
        grants().lock_ok().remove(&token);
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
        assert!(keys().lock_ok().get(&Provider::Gemini).is_none());
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
                seen.requests.lock_ok().push((
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
                            // A closed `release` breaks the stream off mid-body.
                            1 => match release.acquire().await {
                                Ok(permit) => {
                                    permit.forget();
                                    Some((Ok(Bytes::from_static(SSE_REST.as_bytes())), 2))
                                }
                                Err(_) => Some((Err(std::io::Error::other("stub broke off")), 2)),
                            },
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
        proxy_with(upstream, key, |s| s.max_body = max_body).await.0
    }

    /// A proxy on a free port, its state adjusted by `tune`; the port and the
    /// body budget's counter.
    async fn proxy_with(
        upstream: String,
        key: Option<&'static str>,
        tune: impl FnOnce(&mut ProxyState),
    ) -> (u16, Arc<AtomicUsize>) {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut state =
            ProxyState::new(port, Upstream::Test(upstream), KeySource::Fixed(key), test_budget(ROOMY), client(false).unwrap(), client(false).unwrap());
        tune(&mut state);
        let buffered = state.buffered.clone();
        tokio::spawn(serve(listener, state, std::future::pending()));
        (port, buffered)
    }

    /// What [`usage_tap`] / [`usage_end`] saw, per tab: `None` a chunk,
    /// `Some(end)` an end.
    type TapLog = Mutex<Vec<(String, Option<StreamEnd>)>>;

    fn taps() -> &'static TapLog {
        static TAPS: OnceLock<TapLog> = OnceLock::new();
        TAPS.get_or_init(Default::default)
    }

    pub(super) fn record_tap(grant: &Grant, end: Option<StreamEnd>) {
        taps().lock_ok().push((grant.tab.clone(), end));
    }

    fn taps_of(tab: &str) -> Vec<Option<StreamEnd>> {
        taps().lock_ok().iter().filter(|(t, _)| t == tab).map(|(_, e)| *e).collect()
    }

    /// Waits up to 5 s for `tab`'s answer to end; its tap record.
    async fn ended(tab: &str) -> Vec<Option<StreamEnd>> {
        for _ in 0..100 {
            let seen = taps_of(tab);
            if seen.iter().any(Option::is_some) {
                return seen;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        taps_of(tab)
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

        {
            let requests = seen.requests.lock_ok();
            let (method, uri, headers, body) = &requests[0];
            assert_eq!(method, "POST");
            assert_eq!(uri, "/v1/messages?beta=true");
            assert_eq!(headers["x-api-key"], FAKE_KEY);
            assert!(headers.get("authorization").is_none());
            assert_eq!(headers["accept-encoding"], "identity", "the client's gzip is not forwarded");
            assert_eq!(headers["anthropic-version"], "2023-06-01");
            assert_eq!(headers["anthropic-beta"], "claude-code-20250219");
            assert_eq!(body, br#"{"model":"claude-test","stream":true}"#);
            for (_, value) in headers.iter() {
                assert!(!value.to_str().unwrap_or("").contains(&token), "the token never travels on");
            }
        }
        // C3's seam saw every chunk and exactly one clean end.
        let tapped = ended("e2e:stream").await;
        assert_eq!(tapped.last(), Some(&Some(StreamEnd::Complete)));
        assert_eq!(tapped.iter().filter(|e| e.is_some()).count(), 1, "{tapped:?}");
        assert!(tapped.len() >= 3, "{tapped:?}");
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
        let requests = seen.requests.lock_ok();
        let (_, uri, headers, _) = &requests[0];
        assert_eq!(uri, "/v1beta/models/gemini-test:streamGenerateContent?alt=sse");
        assert_eq!(headers["x-goog-api-key"], FAKE_KEY);
        drop(requests);
        on_tab_gone("e2e:gemini");
    }

    async fn stream_request(port: u16, tab: &str) -> (reqwest::Response, String) {
        let token = issue_grant(grant(Provider::Anthropic, tab, None)).unwrap();
        let response = plain_client()
            .post(format!("{}/v1/messages", base_url_on(port, Provider::Anthropic)))
            .header("authorization", format!("Bearer {token}"))
            .body("{}")
            .send()
            .await
            .unwrap();
        (response, token)
    }

    #[tokio::test]
    async fn an_answer_the_client_drops_or_the_provider_breaks_off_still_ends_once() {
        let seen = Arc::new(Seen::default());
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        let upstream = stub_upstream(seen.clone(), release.clone()).await;
        let port = proxy(upstream, Some(FAKE_KEY), MAX_BODY).await;

        // The client reads the first event and goes away.
        let (mut response, _) = stream_request(port, "e2e:aborted").await;
        assert!(response.chunk().await.unwrap().is_some());
        drop(response);
        assert_eq!(ended("e2e:aborted").await, vec![None, Some(StreamEnd::Aborted)]);

        // The provider breaks the stream off after the first event.
        let (mut response, _) = stream_request(port, "e2e:failed").await;
        assert!(response.chunk().await.unwrap().is_some());
        release.close();
        while let Ok(Some(_)) = response.chunk().await {}
        assert_eq!(ended("e2e:failed").await, vec![None, Some(StreamEnd::Failed)]);
        on_tab_gone("e2e:aborted");
        on_tab_gone("e2e:failed");
    }

    #[tokio::test]
    async fn request_bodies_held_at_once_are_bounded() {
        let seen = Arc::new(Seen::default());
        let release = Arc::new(tokio::sync::Semaphore::new(1024));
        let upstream = stub_upstream(seen.clone(), release).await;
        let (port, buffered) = proxy_with(upstream, Some(FAKE_KEY), |s| {
            s.max_body = 4096;
            s.max_buffered = 1000;
        })
        .await;
        let token = issue_grant(grant(Provider::Anthropic, "e2e:budget", None)).unwrap();
        let url = format!("{}/v1/messages", base_url_on(port, Provider::Anthropic));
        let c = plain_client();
        let r = c.post(&url).header("x-api-key", token.clone()).body(vec![b'x'; 2000]).send().await.unwrap();
        assert_eq!(r.status(), 503);
        assert_eq!(r.headers()["x-should-retry"], "true");
        assert_eq!(seen.hits.load(Ordering::SeqCst), 0);
        assert_eq!(buffered.load(Ordering::SeqCst), 0, "a refused body leaves the budget");
        let r = c.post(&url).header("x-api-key", token).body(vec![b'x'; 500]).send().await.unwrap();
        assert_eq!(r.status(), 200);
        let _ = r.bytes().await.unwrap();
        assert_eq!(seen.hits.load(Ordering::SeqCst), 1);
        assert_eq!(buffered.load(Ordering::SeqCst), 0, "a forwarded body leaves the budget");
        on_tab_gone("e2e:budget");
    }

    /// Reads from `tcp` until EOF or an error; whether that came within `wait`.
    async fn closes_within(tcp: &mut tokio::net::TcpStream, wait: Duration) -> bool {
        use tokio::io::AsyncReadExt;
        let mut buf = [0u8; 4096];
        tokio::time::timeout(wait, async {
            loop {
                match tcp.read(&mut buf).await {
                    Ok(0) | Err(_) => return,
                    Ok(_) => {}
                }
            }
        })
        .await
        .is_ok()
    }

    #[tokio::test]
    async fn idle_sockets_are_dropped_but_a_stream_in_flight_is_not() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let seen = Arc::new(Seen::default());
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        let upstream = stub_upstream(seen.clone(), release.clone()).await;
        // The bound runs from the accept, so even the honest request at the end
        // must send its head within it: 300 ms was too short for a loaded CI
        // runner, which reset that request.
        let idle = Duration::from_secs(1);
        let (port, _) = proxy_with(upstream, Some(FAKE_KEY), |s| s.idle_wait = idle).await;

        // A socket that never sends a request.
        let mut silent = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        assert!(closes_within(&mut silent, Duration::from_secs(5)).await);

        // A head trickled byte by byte does not reset the bound: the whole
        // trickle would take 3.6 bounds, and the socket closes well before.
        let mut trickle = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let started = Instant::now();
        for b in b"GET /anthropic/v1/models HTTP/1.1\r\n" {
            if trickle.write_all(&[*b]).await.is_err() {
                break;
            }
            tokio::time::sleep(idle / 10).await;
        }
        assert!(closes_within(&mut trickle, Duration::from_secs(5)).await);
        assert!(started.elapsed() < idle * 3, "took {:?}", started.elapsed());

        // A kept-alive socket after its answer.
        let mut kept = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        kept.write_all(format!("GET /anthropic/v1/models HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n").as_bytes())
            .await
            .unwrap();
        let mut head = vec![0u8; 4096];
        let n = kept.read(&mut head).await.unwrap();
        assert!(String::from_utf8_lossy(&head[..n]).starts_with("HTTP/1.1 401"));
        assert!(closes_within(&mut kept, Duration::from_secs(5)).await);

        // A stream quiet for longer than the bound runs to its end.
        let (mut response, _) = stream_request(port, "e2e:idle").await;
        assert!(response.chunk().await.unwrap().is_some());
        tokio::time::sleep(idle * 3).await;
        release.add_permits(1);
        let mut rest = Vec::new();
        while let Some(chunk) = response.chunk().await.unwrap() {
            rest.extend_from_slice(&chunk);
        }
        assert_eq!(rest, SSE_REST.as_bytes());
        on_tab_gone("e2e:idle");
    }

    #[test]
    fn the_remembered_port_is_bound_again_when_free() {
        let free = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = free.local_addr().unwrap().port();
        drop(free);
        let again = bind_listener(Some(port)).unwrap();
        assert_eq!(again.local_addr().unwrap().port(), port);
        // Taken meanwhile: any free port instead.
        let other = bind_listener(Some(port)).unwrap();
        assert_ne!(other.local_addr().unwrap().port(), port);
        assert_ne!(bind_listener(None).unwrap().local_addr().unwrap().port(), 0);
    }

    const OPENAI_SSE: &str = concat!(
        "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_stub\",\"object\":\"response\",\"status\":\"in_progress\",\"output\":[],\"usage\":null}}\n\n",
        "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"item_id\":\"msg_stub\",\"output_index\":0,\"content_index\":0,\"delta\":\"STUB-REPLY-OK\"}\n\n",
        "event: response.output_item.done\ndata: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"id\":\"msg_stub\",\"type\":\"message\",\"role\":\"assistant\",\"status\":\"completed\",\"content\":[{\"type\":\"output_text\",\"text\":\"STUB-REPLY-OK\",\"annotations\":[]}]}}\n\n",
        "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_stub\",\"object\":\"response\",\"status\":\"completed\",\"model\":\"gpt-6.1-sol\",\"output\":[],\"usage\":{\"total_tokens\":1300,\"input_tokens\":1000,\"input_tokens_details\":{\"cached_tokens\":800},\"output_tokens\":300,\"output_tokens_details\":{\"reasoning_tokens\":200}}}}\n\n",
    );

    async fn openai_stub(seen: Arc<Seen>) -> String {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new().fallback(move |req: Request| {
            let seen = seen.clone();
            async move {
                let (parts, body) = req.into_parts();
                let body = axum::body::to_bytes(body, MAX_BODY).await.unwrap();
                seen.hits.fetch_add(1, Ordering::SeqCst);
                seen.requests.lock_ok().push((parts.method.to_string(), parts.uri.to_string(), parts.headers, body.to_vec()));
                let mut response = Response::new(Body::from(OPENAI_SSE));
                response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
                response
            }
        });
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn openai_swaps_bearer_auth_meters_responses_and_enforces_the_budget() {
        let seen = Arc::new(Seen::default());
        let upstream = openai_stub(seen.clone()).await;
        let budget = test_budget(ROOMY);
        let book = budget.book.clone();
        let (port, _) = proxy_with(upstream, Some(FAKE_KEY), |s| s.budget = budget).await;
        let token = issue_grant(grant(Provider::OpenAi, "e2e:openai", None)).unwrap();
        let url = format!("{}/v1/responses", base_url_on(port, Provider::OpenAi));
        let client = plain_client();
        let response = client.post(&url).bearer_auth(&token).body(r#"{"model":"gpt-6.1-sol","stream":true}"#).send().await.unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(response.text().await.unwrap(), OPENAI_SSE);
        let models = charged(&book, Provider::OpenAi).await;
        assert_eq!(models["gpt-6.1-sol"].billed, 580);
        {
            let requests = seen.requests.lock_ok();
            let (method, path, headers, _) = &requests[0];
            assert_eq!((method.as_str(), path.as_str()), ("POST", "/v1/responses"));
            assert_eq!(headers["authorization"], format!("Bearer {FAKE_KEY}"));
            assert!(!headers.values().any(|v| v.as_bytes().windows(token.len()).any(|w| w == token.as_bytes())));
        }
        book.record(Provider::OpenAi, &spent_charge(20_000_000), chrono::Utc::now());
        let response = client.post(&url).bearer_auth(&token).body("{}").send().await.unwrap();
        assert_eq!(response.status(), 429);
        let json: serde_json::Value = serde_json::from_slice(&response.bytes().await.unwrap()).unwrap();
        assert_eq!(json["error"]["code"], "insufficient_quota");
        assert!(json["error"]["message"].as_str().unwrap().contains("OpenAI"));
        assert_eq!(seen.hits.load(Ordering::SeqCst), 1);
        for path in ["/v1/files", "/v1/chat/completions", "/v1/responses/resp_other", "/v1/batches"] {
            assert!(!path_allowed(Provider::OpenAi, &Method::POST, path), "{path}");
        }
        assert!(path_allowed(Provider::OpenAi, &Method::POST, "/v1/responses/compact"));
        on_tab_gone("e2e:openai");
        assert_eq!(client.post(&url).bearer_auth(&token).body("{}").send().await.unwrap().status(), 401);
    }

    /// Isolated real-CLI check, with a scratch home and a loopback fake
    /// provider only. C2_PROBE_CODEX names the installed executable.
    #[tokio::test]
    #[ignore]
    async fn codex_cli_talks_to_the_proxy() {
        let codex = std::env::var_os("C2_PROBE_CODEX").expect("C2_PROBE_CODEX executable");
        let seen = Arc::new(Seen::default());
        let upstream = openai_stub(seen.clone()).await;
        let port = proxy(upstream, Some(FAKE_KEY), MAX_BODY).await;
        let token = issue_grant(grant(Provider::OpenAi, "e2e:codex-cli", None)).unwrap();
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir(home.path().join(".codex")).unwrap();
        let mut command = tokio::process::Command::new(codex);
        command.env_clear().env("HOME", home.path()).env("CODEX_HOME", home.path().join(".codex"))
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("OPENAI_API_KEY", &token)
            .args(super::super::agent_api_keys::codex_proxy_args(&base_url_on(port, Provider::OpenAi)))
            .args(["exec", "--skip-git-repo-check", "-m", "gpt-6.1-sol", "Reply hi without tools."])
            .current_dir(home.path()).kill_on_drop(true);
        let output = tokio::time::timeout(Duration::from_secs(45), command.output()).await.unwrap().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        assert!(String::from_utf8_lossy(&output.stdout).contains("STUB-REPLY-OK"));
        let requests = seen.requests.lock_ok();
        assert!(requests.iter().any(|(m, path, _, _)| m == "POST" && path == "/v1/responses"));
        for (_, _, headers, _) in requests.iter() {
            assert_eq!(headers["authorization"], format!("Bearer {FAKE_KEY}"));
        }
        assert!(!home.path().join(".codex").join("auth.json").exists(), "no login file was written");
        on_tab_gone("e2e:codex-cli");
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
        let requests = seen.requests.lock_ok();
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

    // ---- a hosted server administrator's key (#2389) -----------------------

    fn admin_grant(tab: &str) -> Grant {
        Grant { admin: Some("claude"), ..grant(Provider::Anthropic, tab, None) }
    }

    /// Direct delivery: the request goes to the provider with the
    /// administrator's key, the user's own key is not needed, and nothing is
    /// charged to (or refused by) the user's own limit.
    #[tokio::test]
    async fn an_admin_grant_forwards_with_the_administrators_key_outside_the_own_limit() {
        let seen = Arc::new(Seen::default());
        let release = Arc::new(tokio::sync::Semaphore::new(16));
        let upstream = stub_upstream(seen.clone(), release).await;
        let budget = test_budget(None);
        let book = budget.book.clone();
        let (port, _) = proxy_with(upstream, None, |s| {
            s.keys = KeySource::FixedAdmin { own: None, admin: Some(("fake-admin-key", None)) };
            s.budget = budget;
        })
        .await;
        let token = issue_grant(admin_grant("e2e:admin-direct")).unwrap();
        let r = plain_client()
            .post(format!("{}/v1/messages", base_url_on(port, Provider::Anthropic)))
            .header("authorization", format!("Bearer {token}"))
            .body(r#"{"model":"claude-test","max_tokens":10}"#)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200, "no own key and no own limit, still forwarded");
        let _ = r.bytes().await.unwrap();
        {
            let requests = seen.requests.lock_ok();
            let (_, uri, headers, _) = &requests[0];
            assert_eq!(uri, "/v1/messages");
            assert_eq!(headers["x-api-key"], "fake-admin-key");
        }
        ended("e2e:admin-direct").await;
        assert_eq!(book.billed(Provider::Anthropic, chrono::Utc::now()), 0, "never on the user's own ledger");
        assert!(book.snapshot(chrono::Utc::now()).providers.is_empty());
        on_tab_gone("e2e:admin-direct");
    }

    /// Brokered delivery: the request goes to the broker's URL (plain HTTP on
    /// loopback) with the user's broker token, never to the provider.
    #[tokio::test]
    async fn a_brokered_admin_grant_goes_to_the_broker_with_the_users_token() {
        let seen = Arc::new(Seen::default());
        let release = Arc::new(tokio::sync::Semaphore::new(16));
        let broker = stub_upstream(seen.clone(), release).await;
        let provider_seen = Arc::new(Seen::default());
        let provider = stub_upstream(provider_seen.clone(), Arc::new(tokio::sync::Semaphore::new(16))).await;
        let (port, _) = proxy_with(provider, None, |s| {
            s.keys = KeySource::FixedAdmin { own: None, admin: Some(("broker-fake-token", Some(format!("{broker}/claude")))) };
        })
        .await;
        let token = issue_grant(admin_grant("e2e:admin-broker")).unwrap();
        let r = plain_client()
            .post(format!("{}/v1/messages?beta=true", base_url_on(port, Provider::Anthropic)))
            .header("authorization", format!("Bearer {token}"))
            .body("{}")
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200);
        let _ = r.bytes().await.unwrap();
        {
            let requests = seen.requests.lock_ok();
            let (_, uri, headers, _) = &requests[0];
            assert_eq!(uri, "/claude/v1/messages?beta=true");
            assert_eq!(headers["x-api-key"], "broker-fake-token");
            for (_, value) in headers.iter() {
                assert!(!value.to_str().unwrap_or("").contains(&token), "the proxy token never travels on");
            }
        }
        assert_eq!(provider_seen.hits.load(Ordering::SeqCst), 0, "the provider is never called directly");
        on_tab_gone("e2e:admin-broker");
    }

    /// Withdrawn (or the user switched back): refused in the provider's
    /// shape, naming the way back, and nothing reaches the provider. An own
    /// grant on the same proxy is not affected.
    #[tokio::test]
    async fn a_withdrawn_admin_key_is_refused_and_an_own_grant_still_works() {
        let seen = Arc::new(Seen::default());
        let release = Arc::new(tokio::sync::Semaphore::new(16));
        let upstream = stub_upstream(seen.clone(), release).await;
        let (port, _) = proxy_with(upstream, None, |s| {
            s.keys = KeySource::FixedAdmin { own: Some(FAKE_KEY), admin: None };
        })
        .await;
        let token = issue_grant(admin_grant("e2e:admin-gone")).unwrap();
        let url = format!("{}/v1/messages", base_url_on(port, Provider::Anthropic));
        let r = plain_client().post(&url).header("x-api-key", token).body("{}").send().await.unwrap();
        assert_eq!(r.status(), 401);
        assert_eq!(r.headers()["x-should-retry"], "false");
        let json: serde_json::Value = serde_json::from_slice(&r.bytes().await.unwrap()).unwrap();
        assert_eq!(json["error"]["type"], "authentication_error");
        assert!(json["error"]["message"].as_str().unwrap().contains("no longer offers you"));
        assert_eq!(seen.hits.load(Ordering::SeqCst), 0);
        on_tab_gone("e2e:admin-gone");
        let own = issue_grant(grant(Provider::Anthropic, "e2e:own-beside", None)).unwrap();
        let r = plain_client().post(format!("{url}/count_tokens")).header("x-api-key", own).body("{}").send().await.unwrap();
        assert_eq!(r.status(), 200);
        let _ = r.bytes().await.unwrap();
        on_tab_gone("e2e:own-beside");
    }

    // ---- the spending limit (C3) ------------------------------------------

    /// A memory-only ledger with a fixed monthly limit in billed tokens.
    fn test_budget(limit: Option<u64>) -> Budget {
        Budget { book: Arc::new(super::super::api_usage::Book::new(None)), limits: Limits::Fixed(limit) }
    }

    /// Plenty of room: no test request comes near it.
    const ROOMY: Option<u64> = Some(20_000_000);

    /// A charge of `billed` billed tokens.
    fn spent_charge(billed: u64) -> super::super::api_prices::Charge {
        super::super::api_prices::Charge {
            model: "claude-opus-5-5".into(),
            known: true,
            output: billed,
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn a_streamed_answer_is_charged_to_the_ledger_once_it_ends() {
        let seen = Arc::new(Seen::default());
        let release = Arc::new(tokio::sync::Semaphore::new(16));
        let upstream = stub_upstream(seen.clone(), release).await;
        let budget = test_budget(ROOMY);
        let book = budget.book.clone();
        let (port, _) = proxy_with(upstream, Some(FAKE_KEY), |s| s.budget = budget).await;
        let token = issue_grant(grant(Provider::Anthropic, "e2e:metered", None)).unwrap();
        let url = format!("{}/v1/messages", base_url_on(port, Provider::Anthropic));
        let r = plain_client().post(&url).header("x-api-key", token.clone()).body("{}").send().await.unwrap();
        let _ = r.bytes().await.unwrap();
        ended("e2e:metered").await;
        let ledger = book.snapshot(chrono::Utc::now());
        let models = &ledger.providers["anthropic"].models;
        // The stub's model is not in the table: highest Anthropic rate, flagged.
        let m = &models["claude-stub"];
        assert!(m.unknown);
        assert_eq!((m.input, m.output, m.requests), (5, 3, 1));
        // Billed tokens are what the limit counts; the dollars an estimate.
        assert_eq!(m.billed, crate::services::server::keys_wire::billed_tokens(m.input, m.cache_write, m.output, m.cache_read));
        assert_eq!(ledger.billed(Provider::Anthropic), m.billed);
        assert!((ledger.spent_usd(Provider::Anthropic) - (5.0 * 10.0 + 3.0 * 50.0) / 1e6).abs() < 1e-12);
        // Token counting costs nothing and is not metered.
        let r = plain_client()
            .post(format!("{url}/count_tokens"))
            .header("x-api-key", token)
            .body("{}")
            .send()
            .await
            .unwrap();
        let _ = r.bytes().await.unwrap();
        ended("e2e:metered").await;
        assert_eq!(book.snapshot(chrono::Utc::now()).providers["anthropic"].models["claude-stub"].requests, 1);
        on_tab_gone("e2e:metered");
    }

    #[tokio::test]
    async fn a_refused_own_key_is_answered_in_the_proxys_words_and_costs_nothing() {
        // Anthropic's answer to a bad key. Passed on, its "x-api-key" made
        // Claude show "Not logged in · Please run /login".
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new().fallback(|| async {
            let body = r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#;
            let mut r = Response::new(Body::from(body));
            *r.status_mut() = StatusCode::UNAUTHORIZED;
            r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
            r
        });
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let budget = test_budget(ROOMY);
        let book = budget.book.clone();
        let (port, _) = proxy_with(format!("http://{addr}"), Some(FAKE_KEY), |s| s.budget = budget).await;
        let token = issue_grant(grant(Provider::Anthropic, "e2e:key-rejected", None)).unwrap();
        let url = format!("{}/v1/messages", base_url_on(port, Provider::Anthropic));
        let r = plain_client().post(&url).header("x-api-key", token).body("{}").send().await.unwrap();
        assert_eq!(r.status(), 401);
        assert_eq!(r.headers()["x-should-retry"], "false");
        let text = r.text().await.unwrap();
        assert!(!text.to_lowercase().contains("x-api-key"), "{text}");
        let json: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(json["error"]["type"], "authentication_error");
        assert!(json["error"]["message"].as_str().unwrap().contains("Anthropic rejected the API key"));
        assert_eq!(book.snapshot(chrono::Utc::now()).billed(Provider::Anthropic), 0);
        on_tab_gone("e2e:key-rejected");
    }

    /// A provider that answers every request with `status` and `body`, and
    /// records the credential header it was sent.
    async fn answering(status: StatusCode, body: &'static str, seen: Arc<Seen>) -> String {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new().fallback(move |req: Request| {
            let seen = seen.clone();
            async move {
                seen.requests.lock_ok().push((req.method().to_string(), req.uri().to_string(), req.headers().clone(), Vec::new()));
                let mut r = Response::new(Body::from(body));
                *r.status_mut() = status;
                r
            }
        });
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn a_key_is_checked_with_the_provider_before_it_is_saved() {
        let seen = Arc::new(Seen::default());
        let refusing = answering(StatusCode::UNAUTHORIZED, r#"{"type":"error"}"#, seen.clone()).await;
        let err = check_key_at(&refusing, Provider::Anthropic, FAKE_KEY, None, false).await.unwrap_err();
        assert!(err.contains("Anthropic rejected"), "{err}");
        {
            let requests = seen.requests.lock_ok();
            let (method, uri, headers, _) = &requests[0];
            assert_eq!((method.as_str(), uri.as_str()), ("GET", "/v1/models"));
            assert_eq!(headers["x-api-key"], FAKE_KEY);
        }
        let err = check_key_at(&refusing, Provider::OpenAi, FAKE_KEY, None, false).await.unwrap_err();
        assert!(err.contains("OpenAI rejected"), "{err}");
        assert_eq!(seen.requests.lock_ok()[1].2["authorization"], format!("Bearer {FAKE_KEY}"));

        let gemini_bad = answering(StatusCode::BAD_REQUEST, r#"{"error":{"details":[{"reason":"API_KEY_INVALID"}]}}"#, seen.clone()).await;
        assert!(check_key_at(&gemini_bad, Provider::Gemini, FAKE_KEY, None, false).await.is_err());
        // Another 400 is not a verdict on the key.
        let gemini_other = answering(StatusCode::BAD_REQUEST, r#"{"error":{}}"#, seen.clone()).await;
        assert!(check_key_at(&gemini_other, Provider::Gemini, FAKE_KEY, None, false).await.is_ok());

        let accepting = answering(StatusCode::OK, r#"{"data":[]}"#, seen.clone()).await;
        assert!(check_key_at(&accepting, Provider::Anthropic, FAKE_KEY, None, false).await.is_ok());
        // Offline: saved untested.
        let gone = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap().local_addr().unwrap();
        assert!(check_key_at(&format!("http://{gone}"), Provider::Anthropic, FAKE_KEY, None, false).await.is_ok());
    }

    #[tokio::test]
    async fn a_keys_model_listing_is_read_in_the_providers_own_shape() {
        let seen = Arc::new(Seen::default());
        let stored = StoredKey { key: FAKE_KEY.to_string(), workspace: Some(WS_A.to_string()) };
        let gemini = answering(StatusCode::OK, r#"{"models":[{"name":"models/gemini-3.5-flash"}]}"#, seen.clone()).await;
        assert_eq!(key_models_at(&gemini, Provider::Gemini, &stored, false).await.unwrap(), ["gemini-3.5-flash"]);
        assert_eq!(seen.requests.lock_ok()[0].1, "/v1beta/models?pageSize=1000");
        assert_eq!(seen.requests.lock_ok()[0].2["x-goog-api-key"], FAKE_KEY);
        let anthropic = answering(StatusCode::OK, r#"{"data":[{"id":"claude-opus-5-5"}]}"#, seen.clone()).await;
        assert_eq!(key_models_at(&anthropic, Provider::Anthropic, &stored, false).await.unwrap(), ["claude-opus-5-5"]);
        assert_eq!(seen.requests.lock_ok()[1].2[WORKSPACE_HEADER], WS_A);
        let refused = answering(StatusCode::UNAUTHORIZED, r#"{"data":[{"id":"x"}]}"#, seen.clone()).await;
        assert!(key_models_at(&refused, Provider::OpenAi, &stored, false).await.is_none());
        let gone = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap().local_addr().unwrap();
        assert!(key_models_at(&format!("http://{gone}"), Provider::OpenAi, &stored, false).await.is_none());
    }

    /// Anthropic for a key that is not scoped to a workspace: a listing
    /// without `anthropic-workspace-id` is a 400 naming the header, with one
    /// it answers for a workspace in `members` and is a 404 for another; the
    /// key lists `listed` (a JSON `data` array).
    async fn unscoped_anthropic(members: &'static [&'static str], listed: &'static str, seen: Arc<Seen>) -> String {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new().fallback(move |req: Request| {
            let seen = seen.clone();
            async move {
                seen.requests.lock_ok().push((req.method().to_string(), req.uri().to_string(), req.headers().clone(), Vec::new()));
                let (status, body) = if req.uri().path() == "/v1/organizations/workspaces" {
                    (StatusCode::OK, format!(r#"{{"data":{listed},"has_more":false}}"#))
                } else {
                    match req.headers().get(WORKSPACE_HEADER).and_then(|v| v.to_str().ok()) {
                        None => (StatusCode::BAD_REQUEST, r#"{"type":"error","error":{"type":"invalid_request_error","message":"This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header"}}"#.to_string()),
                        Some(id) if members.contains(&id) => (StatusCode::OK, r#"{"data":[]}"#.to_string()),
                        Some(_) => (StatusCode::NOT_FOUND, r#"{"type":"error","error":{"type":"not_found_error"}}"#.to_string()),
                    }
                };
                let mut r = Response::new(Body::from(body));
                *r.status_mut() = status;
                r
            }
        });
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}")
    }

    const WS_A: &str = "wrkspc_01AAAAAAAAAAAAAAAAAAAAAAAA";
    const WS_B: &str = "wrkspc_01BBBBBBBBBBBBBBBBBBBBBBBB";

    #[tokio::test]
    async fn an_unscoped_anthropic_key_gets_its_only_workspace() {
        let seen = Arc::new(Seen::default());
        let listed = r#"[{"id":"wrkspc_01AAAAAAAAAAAAAAAAAAAAAAAA","name":"Default","archived_at":null},
            {"id":"wrkspc_01BBBBBBBBBBBBBBBBBBBBBBBB","name":"Old","archived_at":"2026-01-01T00:00:00Z"}]"#;
        let base = unscoped_anthropic(&[WS_A], listed, seen.clone()).await;
        let found = check_key_at(&base, Provider::Anthropic, FAKE_KEY, None, false).await.unwrap();
        assert_eq!(found, KeyCheck::Save { workspace: Some(WS_A.to_string()) });
        let requests = seen.requests.lock_ok();
        assert_eq!(requests[1].1, "/v1/organizations/workspaces?include_default=true&limit=100");
        assert_eq!(requests[1].2["x-api-key"], FAKE_KEY);
        assert_eq!(requests[2].2[WORKSPACE_HEADER], WS_A);
    }

    #[tokio::test]
    async fn an_unscoped_anthropic_key_with_several_workspaces_asks_which() {
        let seen = Arc::new(Seen::default());
        let listed = r#"[{"id":"wrkspc_01AAAAAAAAAAAAAAAAAAAAAAAA","name":"Default"},{"id":"wrkspc_01BBBBBBBBBBBBBBBBBBBBBBBB","name":"Claude Code"}]"#;
        let base = unscoped_anthropic(&[WS_A], listed, seen.clone()).await;
        let found = check_key_at(&base, Provider::Anthropic, FAKE_KEY, None, false).await.unwrap();
        assert_eq!(
            found,
            KeyCheck::PickWorkspace(vec![
                Workspace { id: WS_A.into(), name: "Default".into() },
                Workspace { id: WS_B.into(), name: "Claude Code".into() },
            ])
        );
        // The picked one is checked; one the key cannot use is refused.
        let picked = check_key_at(&base, Provider::Anthropic, FAKE_KEY, Some(WS_A), false).await.unwrap();
        assert_eq!(picked, KeyCheck::Save { workspace: Some(WS_A.to_string()) });
        let err = check_key_at(&base, Provider::Anthropic, FAKE_KEY, Some(WS_B), false).await.unwrap_err();
        assert!(err.contains(WS_B), "{err}");
        let err = check_key_at(&base, Provider::Anthropic, FAKE_KEY, Some("wrkspc_x\r\ny: z"), false).await.unwrap_err();
        assert!(err.contains("not a workspace id"), "{err}");
    }

    #[tokio::test]
    async fn an_unscoped_key_that_cannot_list_workspaces_asks_for_an_id() {
        let seen = Arc::new(Seen::default());
        let base = unscoped_anthropic(&[WS_A], "null", seen).await;
        let found = check_key_at(&base, Provider::Anthropic, FAKE_KEY, None, false).await.unwrap();
        assert_eq!(found, KeyCheck::PickWorkspace(Vec::new()));
    }

    #[tokio::test]
    async fn a_stored_workspace_is_named_on_every_request() {
        let seen = Arc::new(Seen::default());
        let base = unscoped_anthropic(&[WS_A], "[]", seen.clone()).await;
        let (port, _) = proxy_with(base, None, |s| s.keys = KeySource::FixedInWorkspace(FAKE_KEY, WS_A)).await;
        let token = issue_grant(grant(Provider::Anthropic, "e2e:workspace", None)).unwrap();
        let url = format!("{}/v1/models", base_url_on(port, Provider::Anthropic));
        let r = plain_client()
            .get(&url)
            .header("x-api-key", token)
            .header(WORKSPACE_HEADER, WS_B)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200);
        let headers = &seen.requests.lock_ok()[0].2;
        assert_eq!(headers["x-api-key"], FAKE_KEY);
        assert_eq!(headers.get_all(WORKSPACE_HEADER).iter().collect::<Vec<_>>(), vec![WS_A]);
        on_tab_gone("e2e:workspace");
    }

    #[tokio::test]
    async fn a_key_without_its_workspace_is_answered_in_the_proxys_words() {
        let seen = Arc::new(Seen::default());
        let base = unscoped_anthropic(&[WS_A], "[]", seen).await;
        let budget = test_budget(ROOMY);
        let book = budget.book.clone();
        let (port, _) = proxy_with(base, Some(FAKE_KEY), |s| s.budget = budget).await;
        let token = issue_grant(grant(Provider::Anthropic, "e2e:no-workspace", None)).unwrap();
        let url = format!("{}/v1/messages", base_url_on(port, Provider::Anthropic));
        let r = plain_client().post(&url).header("x-api-key", token).body("{}").send().await.unwrap();
        assert_eq!(r.status(), 400);
        assert_eq!(r.headers()["x-should-retry"], "false");
        let json: serde_json::Value = serde_json::from_str(&r.text().await.unwrap()).unwrap();
        assert_eq!(json["error"]["type"], "invalid_request_error");
        assert!(json["error"]["message"].as_str().unwrap().contains("save it again to pick one"));
        assert_eq!(book.snapshot(chrono::Utc::now()).billed(Provider::Anthropic), 0);
        on_tab_gone("e2e:no-workspace");
    }

    #[tokio::test]
    async fn a_claude_subscription_token_is_refused_without_asking_anthropic() {
        let seen = Arc::new(Seen::default());
        let accepting = answering(StatusCode::OK, "{}", seen.clone()).await;
        let err = check_key_at(&accepting, Provider::Anthropic, "sk-ant-oat01-xyz", None, false).await.unwrap_err();
        assert!(err.contains("subscription token"), "{err}");
        assert!(seen.requests.lock_ok().is_empty());
    }

    #[tokio::test]
    async fn at_the_limit_billed_requests_are_refused_in_the_provider_shape() {
        let seen = Arc::new(Seen::default());
        let release = Arc::new(tokio::sync::Semaphore::new(16));
        let upstream = stub_upstream(seen.clone(), release).await;
        let budget = test_budget(Some(20_000));
        budget.book.record(Provider::Anthropic, &spent_charge(20_000), chrono::Utc::now());
        budget.book.record(Provider::Gemini, &spent_charge(25_000), chrono::Utc::now());
        let (port, _) = proxy_with(upstream.clone(), Some(FAKE_KEY), |s| s.budget = budget).await;
        let token = issue_grant(grant(Provider::Anthropic, "e2e:limit", None)).unwrap();
        let anthropic = base_url_on(port, Provider::Anthropic);
        let c = plain_client();
        let r = c.post(format!("{anthropic}/v1/messages")).header("x-api-key", token.clone()).body("{}").send().await.unwrap();
        assert_eq!(r.status(), 429);
        assert_eq!(r.headers()["x-should-retry"], "false");
        let json: serde_json::Value = serde_json::from_slice(&r.bytes().await.unwrap()).unwrap();
        assert_eq!(json["type"], "error");
        assert_eq!(json["error"]["type"], "rate_limit_error");
        let message = json["error"]["message"].as_str().unwrap();
        assert!(message.starts_with(crate::app_name!()), "{message}");
        assert!(message.contains("budget for Anthropic reached") && message.contains("Manage CLIs"), "{message}");
        assert_eq!(seen.hits.load(Ordering::SeqCst), 0, "the provider saw nothing");
        // What costs nothing still passes.
        let r = c.post(format!("{anthropic}/v1/messages/count_tokens")).header("x-api-key", token).body("{}").send().await.unwrap();
        assert_eq!(r.status(), 200);
        let _ = r.bytes().await.unwrap();
        assert_eq!(seen.hits.load(Ordering::SeqCst), 1);
        on_tab_gone("e2e:limit");

        // Gemini's shape.
        let token = issue_grant(grant(Provider::Gemini, "e2e:limit-gemini", None)).unwrap();
        let r = c
            .post(format!("{}/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse", base_url_on(port, Provider::Gemini)))
            .header("x-goog-api-key", token)
            .body("{}")
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 429);
        let json: serde_json::Value = serde_json::from_slice(&r.bytes().await.unwrap()).unwrap();
        assert_eq!(json["error"]["status"], "RESOURCE_EXHAUSTED");
        assert_eq!(json["error"]["code"], 429);
        assert!(json["error"]["message"].as_str().unwrap().contains("Google Gemini"));
        on_tab_gone("e2e:limit-gemini");

        // A key without a limit (saved by an earlier build): refused until set.
        let (port, _) = proxy_with(upstream, Some(FAKE_KEY), |s| s.budget = test_budget(None)).await;
        let token = issue_grant(grant(Provider::Anthropic, "e2e:nolimit", None)).unwrap();
        let r = c
            .post(format!("{}/v1/messages", base_url_on(port, Provider::Anthropic)))
            .header("x-api-key", token)
            .body("{}")
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 429);
        let json: serde_json::Value = serde_json::from_slice(&r.bytes().await.unwrap()).unwrap();
        assert!(json["error"]["message"].as_str().unwrap().contains("no monthly API budget"));
        assert_eq!(seen.hits.load(Ordering::SeqCst), 1);
        on_tab_gone("e2e:nolimit");
    }

    /// The ledger's models of `provider` once a charge landed.
    async fn charged(book: &super::super::api_usage::Book, provider: Provider) -> std::collections::BTreeMap<String, super::super::api_usage::ModelUsage> {
        for _ in 0..100 {
            let ledger = book.snapshot(chrono::Utc::now());
            if let Some(u) = ledger.providers.get(provider.id()).filter(|u| !u.models.is_empty()) {
                return u.models.clone();
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        Default::default()
    }

    #[tokio::test]
    async fn a_client_that_hangs_up_before_the_final_count_is_charged_an_estimate() {
        let seen = Arc::new(Seen::default());
        // The stub sends `message_start` and holds the rest back.
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        let upstream = stub_upstream(seen.clone(), release).await;
        let budget = test_budget(ROOMY);
        let book = budget.book.clone();
        let (port, _) = proxy_with(upstream, Some(FAKE_KEY), |s| s.budget = budget).await;
        let token = issue_grant(grant(Provider::Anthropic, "e2e:hangup", None)).unwrap();
        let mut response = plain_client()
            .post(format!("{}/v1/messages", base_url_on(port, Provider::Anthropic)))
            .header("x-api-key", token)
            .body(r#"{"model":"claude-opus-5-5","max_tokens":64000,"stream":true}"#)
            .send()
            .await
            .unwrap();
        assert!(response.chunk().await.unwrap().is_some());
        tokio::time::sleep(Duration::from_millis(1100)).await;
        drop(response);
        let models = charged(&book, Provider::Anthropic).await;
        let m = &models["claude-stub"];
        assert_eq!(m.input, 5, "message_start's input as reported");
        assert!(m.output >= super::super::api_meter::ANTHROPIC_TOKENS_PER_SEC, "output by time, not message_start's 1: {}", m.output);
        on_tab_gone("e2e:hangup");
    }

    #[tokio::test]
    async fn a_client_that_leaves_before_the_answer_begins_is_charged_an_estimate() {
        // An upstream that takes the request and never answers (a long
        // non-streaming turn).
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new().fallback(|req: Request| async move {
            let _ = axum::body::to_bytes(req.into_body(), usize::MAX).await;
            std::future::pending::<Response>().await
        });
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let budget = test_budget(ROOMY);
        let book = budget.book.clone();
        let (port, _) = proxy_with(format!("http://{addr}"), Some(FAKE_KEY), |s| s.budget = budget).await;
        let token = issue_grant(grant(Provider::Anthropic, "e2e:left", None)).unwrap();
        let body = format!(r#"{{"model":"claude-opus-5-5","max_tokens":100,"messages":[{{"role":"user","content":"{}"}}]}}"#, "x".repeat(3000));
        let sent = plain_client()
            .post(format!("{}/v1/messages", base_url_on(port, Provider::Anthropic)))
            .header("x-api-key", token)
            .body(body.clone())
            .timeout(Duration::from_millis(1500))
            .send()
            .await;
        assert!(sent.is_err(), "no answer ever came");
        let models = charged(&book, Provider::Anthropic).await;
        let m = &models["claude-opus-5-5"];
        assert_eq!(m.input, (body.len() as u64).div_ceil(3));
        assert_eq!(m.output, 100, "time-bounded, capped at the request's max_tokens");
        assert!(!m.unknown);
        on_tab_gone("e2e:left");
    }

    /// Waits up to 5 s for `provider`'s reservations to come to `tokens`.
    async fn reserved_comes_to(book: &super::super::api_usage::Book, provider: Provider, tokens: u64) -> u64 {
        for _ in 0..100 {
            if book.reserved(provider) == tokens {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        book.reserved(provider)
    }

    #[tokio::test]
    async fn requests_in_flight_hold_the_limit_until_they_end_however_they_end() {
        let seen = Arc::new(Seen::default());
        // The stub sends `message_start` and holds the rest until released.
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        let upstream = stub_upstream(seen.clone(), release.clone()).await;
        let body = r#"{"model":"claude-opus-5-5","max_tokens":40000,"stream":true}"#;
        let worst = {
            let mut m = super::super::api_meter::Meter::new(Provider::Anthropic, super::super::api_meter::Billing::Usage { model: None });
            m.request(body.as_bytes());
            m.worst_case_billed(&super::super::api_usage::month_of(chrono::Utc::now()))
        };
        // Room for two worst cases, not three.
        let held_one = worst;
        let budget = test_budget(Some(worst * 5 / 2));
        let book = budget.book.clone();
        let (port, _) = proxy_with(upstream, Some(FAKE_KEY), |s| s.budget = budget).await;
        let token = issue_grant(grant(Provider::Anthropic, "e2e:inflight", None)).unwrap();
        let url = format!("{}/v1/messages", base_url_on(port, Provider::Anthropic));
        let c = plain_client();
        let send = || c.post(&url).header("x-api-key", token.clone()).body(body).send();
        let mut a = send().await.unwrap();
        let mut b = send().await.unwrap();
        assert!(a.chunk().await.unwrap().is_some() && b.chunk().await.unwrap().is_some());
        assert_eq!(book.reserved(Provider::Anthropic), 2 * held_one);
        // A third is refused before the provider sees it, though nothing is
        // spent yet.
        let r = send().await.unwrap();
        assert_eq!(r.status(), 429);
        assert_eq!(r.headers()["x-should-retry"], "false");
        let json: serde_json::Value = serde_json::from_slice(&r.bytes().await.unwrap()).unwrap();
        assert_eq!(json["error"]["type"], "rate_limit_error");
        let message = json["error"]["message"].as_str().unwrap();
        assert!(message.starts_with(crate::app_name!()) && message.contains("in flight"), "{message}");
        assert_eq!(seen.hits.load(Ordering::SeqCst), 2);
        assert_eq!(book.billed(Provider::Anthropic, chrono::Utc::now()), 0);

        // One ends cleanly: its hold is released and its real cost charged.
        release.add_permits(1);
        assert_eq!(reserved_comes_to(&book, Provider::Anthropic, held_one).await, held_one);
        let models = charged(&book, Provider::Anthropic).await;
        assert_eq!(models["claude-stub"].requests, 1);
        assert_eq!((models["claude-stub"].input, models["claude-stub"].output), (5, 3));

        // Now one more fits; its client hangs up: released too.
        let mut d = send().await.unwrap();
        assert_eq!(d.status(), 200);
        assert!(d.chunk().await.unwrap().is_some());
        assert_eq!(book.reserved(Provider::Anthropic), 2 * held_one);
        drop(d);
        assert_eq!(reserved_comes_to(&book, Provider::Anthropic, held_one).await, held_one);

        // The provider breaks the last one off: released.
        release.close();
        assert_eq!(reserved_comes_to(&book, Provider::Anthropic, 0).await, 0);
        // Both read to their end (one completed, one broke off).
        let _ = a.bytes().await;
        let _ = b.bytes().await;
        assert_eq!(book.snapshot(chrono::Utc::now()).providers["anthropic"].models["claude-stub"].requests, 3);
        on_tab_gone("e2e:inflight");

        // A provider that cannot be reached: nothing charged, nothing held.
        let dead = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let dead_addr = dead.local_addr().unwrap();
        drop(dead);
        let budget = test_budget(ROOMY);
        let book = budget.book.clone();
        let (port, _) = proxy_with(format!("http://{dead_addr}"), Some(FAKE_KEY), |s| s.budget = budget).await;
        let token = issue_grant(grant(Provider::Anthropic, "e2e:inflight-dead", None)).unwrap();
        let r = plain_client()
            .post(format!("{}/v1/messages", base_url_on(port, Provider::Anthropic)))
            .header("x-api-key", token)
            .body(body)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 502);
        assert_eq!(book.reserved(Provider::Anthropic), 0);
        assert_eq!(book.billed(Provider::Anthropic, chrono::Utc::now()), 0);
        on_tab_gone("e2e:inflight-dead");
    }
}
