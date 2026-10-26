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
        // The remembered port was taken (or never existed): a keyed agent
        // that outlived a crash still names it, and would hand its
        // conversation to whoever holds it (gap 50b). Said, never silent.
        if let Some(taken) = preferred.filter(|p| *p != 0) {
            super::api_proxy_port::on_fallback(taken, port);
        }
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
    /// A metered OpenAI request whose body is not one JSON object the meter
    /// can read (gap 48).
    Unmeterable,
    /// A metered OpenAI request with `background: true`: billed after it
    /// returns, past the monthly limit (gap 48).
    Background,
    /// A metered OpenAI request for a priced `service_tier` (gap 48).
    ServiceTier,
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
            Refusal::BadBody | Refusal::NoWorkspace | Refusal::Unmeterable | Refusal::Background | Refusal::ServiceTier => StatusCode::BAD_REQUEST,
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
            Refusal::Unmeterable => concat!(
                crate::app_name!(),
                " API proxy: the request body is not one JSON object whose model, max_output_tokens, max_tool_calls,",
                " background and service_tier fields the monthly API budget can read (none repeated or of the wrong type)"
            ),
            Refusal::Background => concat!(
                crate::app_name!(),
                " API proxy: background responses are refused — they are billed after the request returns, which the",
                " monthly API budget cannot meter; send the request without \"background\": true"
            ),
            Refusal::ServiceTier => concat!(
                crate::app_name!(),
                " API proxy: this service_tier (Fast/priority, Ultrafast or unknown) bills at a rate the monthly API",
                " budget does not track; use \"auto\", \"default\" or \"flex\", or leave service_tier out (in Codex,",
                " turn Fast mode off)"
            ),
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
                Refusal::TooLarge | Refusal::BadBody | Refusal::NoWorkspace | Refusal::Unmeterable | Refusal::Background | Refusal::ServiceTier => {
                    "INVALID_ARGUMENT"
                }
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
                Refusal::BodyTimeout
                | Refusal::BadBody
                | Refusal::NoWorkspace
                | Refusal::Unmeterable
                | Refusal::Background
                | Refusal::ServiceTier => "invalid_request_error",
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
    // Which organization or project OpenAI bills is the saved key's own;
    // a header could point the request at another one the key can reach.
    "openai-organization",
    "openai-project",
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
        // OpenAI spend the meter cannot see is refused, not forwarded
        // (gap 48): a background response, a priced tier, a body it cannot
        // read.
        if provider == Provider::OpenAi {
            match super::api_meter::openai_refusal(&body) {
                Some(super::api_meter::OpenAiRefusal::Unparsable) => return refuse(Some(provider), Refusal::Unmeterable),
                Some(super::api_meter::OpenAiRefusal::Background) => return refuse(Some(provider), Refusal::Background),
                Some(super::api_meter::OpenAiRefusal::ServiceTier) => return refuse(Some(provider), Refusal::ServiceTier),
                None => {}
            }
        }
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
mod tests;
