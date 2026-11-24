//! Claude Code's trace spans as a second, separate source of token counts
//! (experimental `claude_otel_tokens`; plan and measurements in
//! `docs/claude_otel_tokens_plan.md`).
//!
//! Claude 2.1.331 puts `gen_ai.usage.*`, `gen_ai.response.model` and
//! `gen_ai.operation.name` on its `claude_code.llm_request` spans, one span per
//! API request, side requests (titles, compaction) included. With the flag on, a
//! local Claude tab is launched with an OTLP/HTTP JSON trace exporter aimed at a
//! receiver of this module on `127.0.0.1`, and each span's counts are filed
//! under the leaf [`CLI`] (`tokens.<kind>.claude_otel.<model>`) beside the
//! transcript-derived `claude` rows of `services::token_stats` — **never added
//! into them**: the two sources are disjoint keys, so no total can count a
//! request twice, and the recap shows both for comparison.
//!
//! **Only counts leave the span.** The parser reads six numeric attributes, the
//! model, the session id, the agent marker and the end time; nothing else of the
//! body is kept, so a prompt, a response or a tool's input that a user's own
//! `OTEL_LOG_*` opt-in puts on a span never reaches the ledger.
//!
//! **Authority.** The receiver is bound to loopback only, answers a browser
//! (`Origin`) or another `Host` with 403, and takes a span only with the tab's
//! bearer token: the token names the scope (project, box, root) the span is
//! filed under, so a tab can file nothing under another's. The token travels
//! like the API proxy's: under an app-named carrier that `agent_exec` maps to
//! the exporter's header variable just before the agent runs (never a tmux
//! argv), the variable itself on Windows.
//!
//! **Lifetime.** One listener per run, started by the first launch that needs
//! it ([`ensure_started`]), on a random port (not remembered: an agent a tmux
//! session kept alive across a restart then exports to a dead port instead of
//! to whoever took a remembered one), ended by [`stop_for_exit`]. Tokens end
//! with their tab ([`on_tab_gone`]). The ledger is flushed to
//! `claude_otel_tokens.json` every few seconds and at exit.
//!
//! AppHandle-free and unit-tested against spans captured from the real CLI
//! (`scripts/verify-cli/claude/otel.py`).

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use app_core::sync::LockExt;
use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Router;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::schema::usage_stats::UsageStats;
use crate::services::agent_session::clean_model_name;
use crate::services::token_stats::{token_key, SPLIT, SUB};
use crate::storage;

/// The leaf the span source's counters are filed under: the third segment of
/// `tokens.<kind>.<cli>.<model>`, next to `claude`.
pub const CLI: &str = "claude_otel";
/// The ledger's file name inside the state dir.
pub const LEDGER_FILE: &str = "claude_otel_tokens.json";
/// The one path the receiver serves.
pub const TRACES_PATH: &str = "/v1/traces";
/// The exporter variable that carries the bearer header.
pub const HEADERS_VAR: &str = "OTEL_EXPORTER_OTLP_TRACES_HEADERS";
/// Its carrier on Linux and macOS (`agent_exec::CARRIER_PREFIX` + the name,
/// listed in `agent_exec::targets` and `tmux_local::SECRET_ENV`).
pub const CARRIER: &str = crate::app_env!("AGENT_SECRET_OTEL_EXPORTER_OTLP_TRACES_HEADERS");

/// The span name this module counts.
const LLM_REQUEST: &str = "claude_code.llm_request";
/// A span names its counts in `gen_ai.*` since Claude 2.1.331; the plain names
/// beside them are older and exclude the cache from `input_tokens`.
const A_GEN_IN: &str = "gen_ai.usage.input_tokens";
const A_GEN_OUT: &str = "gen_ai.usage.output_tokens";
const A_GEN_CACHE_R: &str = "gen_ai.usage.cache_read.input_tokens";
const A_GEN_CACHE_W: &str = "gen_ai.usage.cache_write.input_tokens";
const A_PLAIN_IN: &str = "input_tokens";
const A_PLAIN_OUT: &str = "output_tokens";
const A_PLAIN_CACHE_R: &str = "cache_read_tokens";
const A_PLAIN_CACHE_W: &str = "cache_creation_tokens";
const A_RESPONSE_MODEL: &str = "gen_ai.response.model";
const A_REQUEST_MODEL: &str = "gen_ai.request.model";
const A_MODEL: &str = "model";
const A_SESSION: &str = "session.id";
const A_CONVERSATION: &str = "gen_ai.conversation.id";
const A_AGENT: &str = "agent_id";

/// One request never legitimately carries more than this per field.
const MAX_PER_REQUEST: u64 = 1_000_000_000;
/// Spans read from one POST.
const MAX_SPANS_PER_BODY: usize = 4_000;
/// A request body (and, once unzipped, its content) is refused past this.
const MAX_BODY: usize = 4 << 20;
/// A span stamped further than this ahead of (or behind) the clock is filed at
/// the clock instead.
const FUTURE_SLACK_MS: i64 = 86_400_000;
const PAST_SLACK_MS: i64 = 2 * 86_400_000;
/// Span ids remembered for redelivery.
const SEEN_SPANS: usize = 8_192;
/// Sessions kept in the ledger.
const MAX_SESSIONS: usize = 5_000;
/// Longest session id taken.
const MAX_SESSION_CHARS: usize = 80;
const UNKNOWN_MODEL: &str = "unknown";
/// Concurrent requests served; one more is answered 503.
const MAX_IN_FLIGHT: usize = 8;
/// How long a request may take to send its body.
const BODY_WAIT: Duration = Duration::from_secs(10);
/// How often a changed ledger is written.
const FLUSH_EVERY: Duration = Duration::from_secs(5);
const LEDGER_VERSION: u32 = 1;

// ── Parsing ────────────────────────────────────────────────────────────────

/// One `claude_code.llm_request` span, reduced to what the ledger keeps.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LlmRequest {
    /// `<traceId>:<spanId>`: what a redelivered span is recognised by.
    pub key: String,
    /// Claude's session id (`session.id`; a subagent's span names its parent
    /// session too).
    pub session: String,
    /// The response model, else the request model; `unknown` when neither is a
    /// usable name.
    pub model: String,
    /// `[fresh input, cache write, cache read, output]`, the order of
    /// `token_stats::SPLIT`. Fresh input is what the request's total input
    /// leaves after the cache's part.
    pub n: [u64; 4],
    /// The span ended inside a subagent (it carries `agent_id`).
    pub sub: bool,
    /// When it ended, epoch ms, if the span said.
    pub end_ms: Option<i64>,
}

/// Why a body was refused whole.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParseError {
    /// Not JSON, or not an OTLP traces document.
    NotTraces,
}

/// The value of attribute `key` on an OTLP/JSON span, if the span has it.
fn attr<'a>(span: &'a Value, key: &str) -> Option<&'a Value> {
    span.get("attributes")?
        .as_array()?
        .iter()
        .find(|kv| kv.get("key").and_then(Value::as_str) == Some(key))?
        .get("value")
}

/// An OTLP integer: proto3 JSON writes an int64 as a string, other writers as
/// a number or an integral double. Anything else, a negative or a count past
/// [`MAX_PER_REQUEST`] is not a count.
fn count_of(value: &Value) -> Option<u64> {
    let n = if let Some(v) = value.get("intValue") {
        match v {
            Value::String(s) => s.trim().parse::<u64>().ok()?,
            other => other.as_u64()?,
        }
    } else if let Some(d) = value.get("doubleValue").and_then(Value::as_f64) {
        if !d.is_finite() || d < 0.0 || d.fract() != 0.0 || d > MAX_PER_REQUEST as f64 {
            return None;
        }
        d as u64
    } else {
        return None;
    };
    (n <= MAX_PER_REQUEST).then_some(n)
}

fn string_of(value: &Value) -> Option<&str> {
    value.get("stringValue").and_then(Value::as_str)
}

fn count_attr(span: &Value, key: &str) -> Option<u64> {
    attr(span, key).and_then(count_of)
}

/// A session id as Claude writes it (a UUID, or a short slug in a test):
/// ASCII letters, digits, `-` and `_`, bounded. Anything else is not stored.
fn session_ok(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_SESSION_CHARS && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn span_id_ok(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The counts of one span, in `SPLIT` order, or `None` when it carries none.
fn counts_of(span: &Value) -> Option<[u64; 4]> {
    let gen_ai = [A_GEN_IN, A_GEN_OUT, A_GEN_CACHE_R, A_GEN_CACHE_W].iter().any(|k| attr(span, k).is_some());
    let (cache_r, cache_w, out, fresh) = if gen_ai {
        // `gen_ai.usage.input_tokens` includes both cache parts: take them out.
        let total_in = count_attr(span, A_GEN_IN).unwrap_or(0);
        let cache_r = count_attr(span, A_GEN_CACHE_R).unwrap_or(0);
        let cache_w = count_attr(span, A_GEN_CACHE_W).unwrap_or(0);
        let fresh = total_in.saturating_sub(cache_r).saturating_sub(cache_w);
        (cache_r, cache_w, count_attr(span, A_GEN_OUT).unwrap_or(0), fresh)
    } else if let Some(plain) = count_attr(span, A_PLAIN_IN) {
        // Before the `gen_ai.*` names, `input_tokens` was the fresh part.
        (
            count_attr(span, A_PLAIN_CACHE_R).unwrap_or(0),
            count_attr(span, A_PLAIN_CACHE_W).unwrap_or(0),
            count_attr(span, A_PLAIN_OUT).unwrap_or(0),
            plain,
        )
    } else {
        return None;
    };
    let n = [fresh, cache_w, cache_r, out];
    n.iter().any(|v| *v > 0).then_some(n)
}

/// Epoch ms of an OTLP nanosecond stamp (a string of digits in proto3 JSON).
fn end_ms(span: &Value) -> Option<i64> {
    let ns = match span.get("endTimeUnixNano")? {
        Value::String(s) => s.trim().parse::<u128>().ok()?,
        other => u128::from(other.as_u64()?),
    };
    i64::try_from(ns / 1_000_000).ok()
}

/// Every counted `claude_code.llm_request` span of an OTLP/HTTP JSON traces
/// body. Other spans (the interaction, the tools) are not read at all, and no
/// attribute outside the list above is looked at. A span that is malformed, has
/// no counts or names no usable session is skipped; the body is refused whole
/// only when it is not a traces document.
pub fn parse_traces(body: &[u8]) -> Result<Vec<LlmRequest>, ParseError> {
    let doc: Value = serde_json::from_slice(body).map_err(|_| ParseError::NotTraces)?;
    let resources = doc.get("resourceSpans").and_then(Value::as_array).ok_or(ParseError::NotTraces)?;
    let mut out = Vec::new();
    let mut seen = 0usize;
    'all: for resource in resources {
        for scope in resource.get("scopeSpans").and_then(Value::as_array).into_iter().flatten() {
            for span in scope.get("spans").and_then(Value::as_array).into_iter().flatten() {
                seen += 1;
                if seen > MAX_SPANS_PER_BODY {
                    break 'all;
                }
                if span.get("name").and_then(Value::as_str) != Some(LLM_REQUEST) {
                    continue;
                }
                if let Some(request) = request_of(span) {
                    out.push(request);
                }
            }
        }
    }
    Ok(out)
}

fn request_of(span: &Value) -> Option<LlmRequest> {
    let trace = span.get("traceId").and_then(Value::as_str).filter(|s| span_id_ok(s))?;
    let id = span.get("spanId").and_then(Value::as_str).filter(|s| span_id_ok(s))?;
    let n = counts_of(span)?;
    let session = attr(span, A_SESSION)
        .and_then(string_of)
        .or_else(|| attr(span, A_CONVERSATION).and_then(string_of))
        .filter(|s| session_ok(s))?;
    let model = [A_RESPONSE_MODEL, A_REQUEST_MODEL, A_MODEL]
        .iter()
        .filter_map(|key| attr(span, key).and_then(string_of))
        .find_map(clean_model_name)
        .unwrap_or_else(|| UNKNOWN_MODEL.to_string());
    Some(LlmRequest {
        key: format!("{trace}:{id}"),
        session: session.to_string(),
        model,
        n,
        sub: attr(span, A_AGENT).is_some(),
        end_ms: end_ms(span),
    })
}

// ── The ledger ─────────────────────────────────────────────────────────────

/// What one session has used, by the spans.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionUse {
    /// The scope its first span was filed under.
    pub scope: String,
    pub first_ms: i64,
    pub last_ms: i64,
    pub requests: u64,
    /// `[fresh input, cache write, cache read, output]`, subagents included.
    pub n: [u64; 4],
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Stored {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    stats: UsageStats,
    #[serde(default)]
    sessions: BTreeMap<String, SessionUse>,
}

/// What an ingest did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Ingest {
    pub counted: usize,
    /// Spans already counted (an exporter retry after a lost answer).
    pub duplicates: usize,
}

/// The span source's counters and per-session totals. Not shared: the
/// receiver wraps one in a mutex.
#[derive(Debug, Default)]
pub struct Ledger {
    stored: Stored,
    /// Recent span keys, oldest first, and the same as a set.
    seen: VecDeque<String>,
    seen_set: HashSet<String>,
    dirty: bool,
}

fn hour_of(ms: i64) -> Option<String> {
    chrono::DateTime::from_timestamp_millis(ms).map(|at| at.format("%Y-%m-%dT%H").to_string())
}

impl Ledger {
    /// The ledger saved at `path`; empty when there is none or it is another version.
    pub fn load(path: &Path) -> Ledger {
        let stored = match storage::read_json::<Stored>(path) {
            Ok(stored) if stored.version == LEDGER_VERSION => stored,
            _ => Stored { version: LEDGER_VERSION, ..Stored::default() },
        };
        Ledger { stored, ..Ledger::default() }
    }

    /// Write the ledger when it changed since the last write.
    pub fn save(&mut self, path: &Path) -> Result<(), String> {
        if !self.dirty {
            return Ok(());
        }
        self.stored.version = LEDGER_VERSION;
        self.stored.stats.prune();
        storage::write_json_atomic(path, &self.stored).map_err(|e| e.to_string())?;
        self.dirty = false;
        Ok(())
    }

    /// File `requests` under `scope`. A span key seen before (within the last
    /// [`SEEN_SPANS`]) adds nothing.
    pub fn ingest(&mut self, scope: &str, requests: &[LlmRequest], now_ms: i64) -> Ingest {
        let mut done = Ingest::default();
        for request in requests {
            if self.seen_set.contains(&request.key) {
                done.duplicates += 1;
                continue;
            }
            self.seen_set.insert(request.key.clone());
            self.seen.push_back(request.key.clone());
            while self.seen.len() > SEEN_SPANS {
                if let Some(old) = self.seen.pop_front() {
                    self.seen_set.remove(&old);
                }
            }
            let at = request
                .end_ms
                .filter(|ms| *ms >= now_ms - PAST_SLACK_MS && *ms <= now_ms + FUTURE_SLACK_MS)
                .unwrap_or(now_ms);
            let Some(hour) = hour_of(at) else { continue };
            for (prefix, value) in SPLIT.iter().zip(request.n) {
                self.stored.stats.add(scope, &hour, &token_key(prefix, CLI, &request.model), value);
            }
            if request.sub {
                for (prefix, value) in SUB.iter().zip(request.n) {
                    self.stored.stats.add(scope, &hour, &token_key(prefix, CLI, &request.model), value);
                }
            }
            let session = self.stored.sessions.entry(request.session.clone()).or_insert_with(|| SessionUse {
                scope: scope.to_string(),
                first_ms: at,
                ..SessionUse::default()
            });
            session.last_ms = session.last_ms.max(at);
            session.requests = session.requests.saturating_add(1);
            for (total, value) in session.n.iter_mut().zip(request.n) {
                *total = total.saturating_add(value);
            }
            done.counted += 1;
        }
        if done.counted > 0 {
            self.trim_sessions();
            self.dirty = true;
        }
        done
    }

    fn trim_sessions(&mut self) {
        while self.stored.sessions.len() > MAX_SESSIONS {
            let Some(oldest) = self
                .stored
                .sessions
                .iter()
                .min_by_key(|(_, s)| s.last_ms)
                .map(|(id, _)| id.clone())
            else {
                return;
            };
            self.stored.sessions.remove(&oldest);
        }
    }

    /// The span source's counters, every scope.
    pub fn stats(&self) -> &UsageStats {
        &self.stored.stats
    }

    /// What the spans say one session used.
    pub fn session(&self, id: &str) -> Option<&SessionUse> {
        self.stored.sessions.get(id)
    }
}

// ── The receiver ───────────────────────────────────────────────────────────

/// What a token is for.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Grant {
    scope: String,
    tab: String,
}

struct Shared {
    port: u16,
    path: PathBuf,
    ledger: Mutex<Ledger>,
    /// `sha256(token)` → grant.
    grants: Mutex<HashMap<String, Grant>>,
    slots: tokio::sync::Semaphore,
    stopping: AtomicBool,
    shutdown: tokio::sync::Notify,
}

/// One running receiver.
pub struct Server {
    shared: Arc<Shared>,
    handle: Mutex<Option<tokio::task::JoinHandle<()>>>,
    flusher: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl Server {
    /// Bind `127.0.0.1` on a free port and serve, with the ledger kept in
    /// `state_dir`. Must run where a tokio runtime is reachable
    /// (`app_core::rt`).
    pub fn start_in(state_dir: &Path) -> std::io::Result<Server> {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
        listener.set_nonblocking(true)?;
        let addr = listener.local_addr()?;
        if !addr.ip().is_loopback() {
            return Err(std::io::Error::other("claude_otel: the receiver is not on loopback"));
        }
        let path = state_dir.join(LEDGER_FILE);
        let shared = Arc::new(Shared {
            port: addr.port(),
            ledger: Mutex::new(Ledger::load(&path)),
            path,
            grants: Mutex::new(HashMap::new()),
            slots: tokio::sync::Semaphore::new(MAX_IN_FLIGHT),
            stopping: AtomicBool::new(false),
            shutdown: tokio::sync::Notify::new(),
        });
        let serving = shared.clone();
        let handle = app_core::rt::spawn(async move {
            let Ok(listener) = tokio::net::TcpListener::from_std(listener) else { return };
            let router = Router::new().fallback(receive).with_state(serving.clone());
            let stop = serving.clone();
            let served = axum::serve(listener, router)
                .with_graceful_shutdown(async move { stop.shutdown.notified().await })
                .await;
            if let Err(e) = served {
                eprintln!("[claude-otel] receiver stopped: {e}");
            }
        });
        let ticking = shared.clone();
        let flusher = app_core::rt::spawn(async move {
            while !ticking.stopping.load(Ordering::Acquire) {
                tokio::time::sleep(FLUSH_EVERY).await;
                let shared = ticking.clone();
                let _ = app_core::rt::spawn_blocking(move || shared.flush()).await;
            }
        });
        Ok(Server { shared, handle: Mutex::new(Some(handle)), flusher: Mutex::new(Some(flusher)) })
    }

    pub fn port(&self) -> u16 {
        self.shared.port
    }

    /// The endpoint an exporter is pointed at.
    pub fn endpoint(&self) -> String {
        format!("http://127.0.0.1:{}{TRACES_PATH}", self.shared.port)
    }

    /// A new bearer token filing spans under `scope` for `tab`. `None` only
    /// without system randomness.
    pub fn issue(&self, scope: &str, tab: &str) -> Option<String> {
        let grant = Grant { scope: scope.to_string(), tab: tab.to_string() };
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).ok()?;
        let token = crate::digest::hex(&bytes);
        // Held only as its hash. A respawn of the tab gets a token of its own;
        // the earlier one stays good for the agent that still carries it, and
        // both end with the tab ([`Server::revoke_tab`]).
        self.shared.grants.lock_ok().insert(crate::digest::sha256_hex(token.as_bytes()), grant);
        Some(token)
    }

    /// End every token of `tab`.
    pub fn revoke_tab(&self, tab: &str) {
        self.shared.grants.lock_ok().retain(|_, g| g.tab != tab);
    }

    /// What the spans have counted so far, every scope.
    pub fn snapshot(&self) -> UsageStats {
        self.shared.ledger.lock_ok().stats().clone()
    }

    /// What the spans say one session used.
    pub fn session(&self, id: &str) -> Option<SessionUse> {
        self.shared.ledger.lock_ok().session(id).cloned()
    }

    /// Stop accepting, drain briefly, write the ledger. Idempotent.
    pub fn stop(&self) {
        self.shared.stopping.store(true, Ordering::Release);
        self.shared.grants.lock_ok().clear();
        self.shared.shutdown.notify_waiters();
        self.shared.shutdown.notify_one();
        if let Some(flusher) = self.flusher.lock_ok().take() {
            flusher.abort();
        }
        if let Some(handle) = self.handle.lock_ok().take() {
            app_core::rt::block_on(async move {
                // A kept-alive exporter connection would hold a graceful
                // shutdown open: after the bound the task is ended outright.
                let mut handle = handle;
                if tokio::time::timeout(Duration::from_secs(2), &mut handle).await.is_err() {
                    handle.abort();
                }
            });
        }
        self.shared.flush();
    }
}

impl Shared {
    fn flush(&self) {
        if let Err(e) = self.ledger.lock_ok().save(&self.path) {
            eprintln!("[claude-otel] write {}: {e}", self.path.display());
        }
    }

    fn grant_for(&self, headers: &HeaderMap) -> Option<Grant> {
        let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
        let token = value.strip_prefix("Bearer ")?.trim();
        if token.is_empty() || token.len() > 200 {
            return None;
        }
        self.grants.lock_ok().get(&crate::digest::sha256_hex(token.as_bytes())).cloned()
    }

    fn host_ok(&self, headers: &HeaderMap) -> bool {
        let mut hosts = headers.get_all(header::HOST).iter();
        match (hosts.next().and_then(|h| h.to_str().ok()), hosts.next()) {
            (Some(host), None) => host == format!("127.0.0.1:{}", self.port) || host == format!("localhost:{}", self.port),
            _ => false,
        }
    }
}

fn answer(status: StatusCode, body: &'static str) -> Response {
    (status, [(header::CONTENT_TYPE, "application/json")], body).into_response()
}

/// A gzip body, unzipped to at most [`MAX_BODY`] bytes; `None` past that or
/// when it is not gzip.
fn gunzip(bytes: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let read = flate2::read::GzDecoder::new(bytes).take(MAX_BODY as u64 + 1).read_to_end(&mut out).ok()?;
    (read <= MAX_BODY).then_some(out)
}

async fn receive(State(shared): State<Arc<Shared>>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    // A browser page (any `Origin`) or a request for another name is refused
    // before anything else is looked at.
    if parts.headers.contains_key(header::ORIGIN) || !shared.host_ok(&parts.headers) {
        return answer(StatusCode::FORBIDDEN, "{}");
    }
    if parts.uri.path() != TRACES_PATH {
        return answer(StatusCode::NOT_FOUND, "{}");
    }
    if parts.method != Method::POST {
        return answer(StatusCode::METHOD_NOT_ALLOWED, "{}");
    }
    let Some(grant) = shared.grant_for(&parts.headers) else {
        return answer(StatusCode::UNAUTHORIZED, "{}");
    };
    let content_type = parts.headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("");
    if !content_type.trim_start().to_ascii_lowercase().starts_with("application/json") {
        // The exporter is configured for http/json; protobuf is not read.
        return answer(StatusCode::UNSUPPORTED_MEDIA_TYPE, "{}");
    }
    let declared = parts
        .headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<usize>().ok());
    if declared.is_some_and(|n| n > MAX_BODY) {
        return answer(StatusCode::PAYLOAD_TOO_LARGE, "{}");
    }
    let Ok(_slot) = shared.slots.try_acquire() else {
        return answer(StatusCode::SERVICE_UNAVAILABLE, "{}");
    };
    let bytes = match tokio::time::timeout(BODY_WAIT, axum::body::to_bytes(body, MAX_BODY)).await {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(_)) => return answer(StatusCode::PAYLOAD_TOO_LARGE, "{}"),
        Err(_) => return answer(StatusCode::REQUEST_TIMEOUT, "{}"),
    };
    let encoding = parts.headers.get(header::CONTENT_ENCODING).and_then(|v| v.to_str().ok()).unwrap_or("identity");
    let json = match encoding.trim().to_ascii_lowercase().as_str() {
        "" | "identity" => bytes.to_vec(),
        "gzip" => match gunzip(&bytes) {
            Some(plain) => plain,
            None => return answer(StatusCode::BAD_REQUEST, "{}"),
        },
        _ => return answer(StatusCode::UNSUPPORTED_MEDIA_TYPE, "{}"),
    };
    let Ok(requests) = parse_traces(&json) else {
        return answer(StatusCode::BAD_REQUEST, "{}");
    };
    if !requests.is_empty() {
        let now = crate::clock::now_ms() as i64;
        shared.ledger.lock_ok().ingest(&grant.scope, &requests, now);
    }
    answer(StatusCode::OK, "{}")
}

// ── This run's receiver ────────────────────────────────────────────────────

static CURRENT: Mutex<Option<Arc<Server>>> = Mutex::new(None);
static STOPPED: AtomicBool = AtomicBool::new(false);
static ALLOWED: AtomicBool = AtomicBool::new(false);

/// Let this process run the receiver. Called once by the window's `setup`:
/// the Mobile host's sidecar launches tabs through the same code but must not
/// run a second receiver over the same ledger file, so its tabs get no
/// exporter.
pub fn allow_receiver() {
    ALLOWED.store(true, Ordering::Release);
}

/// The running receiver, started by the first caller. `None` in a process that
/// may not run one, after [`stop_for_exit`], or when it cannot start.
pub fn ensure_started() -> Option<Arc<Server>> {
    let mut current = CURRENT.lock_ok();
    if let Some(server) = current.as_ref() {
        return Some(server.clone());
    }
    if STOPPED.load(Ordering::Acquire) || !ALLOWED.load(Ordering::Acquire) {
        return None;
    }
    match Server::start_in(&storage::state_dir()) {
        Ok(server) => {
            let server = Arc::new(server);
            *current = Some(server.clone());
            Some(server)
        }
        Err(e) => {
            eprintln!("[claude-otel] receiver not started: {e}");
            None
        }
    }
}

fn running() -> Option<Arc<Server>> {
    CURRENT.lock_ok().clone()
}

/// A tab ended: its tokens go with it.
pub fn on_tab_gone(tab: &str) {
    if let Some(server) = running() {
        server.revoke_tab(tab);
    }
}

/// `RunEvent::Exit`: stop the receiver, end every token, write the ledger.
/// Nothing starts again in this process.
pub fn stop_for_exit() {
    STOPPED.store(true, Ordering::Release);
    if let Some(server) = CURRENT.lock_ok().take() {
        server.stop();
    }
}

/// The span source's counters for the recap: this run's in memory when the
/// receiver is up, else the saved ledger.
pub fn snapshot(state_dir: &Path) -> UsageStats {
    match running() {
        Some(server) => server.snapshot(),
        None => Ledger::load(&state_dir.join(LEDGER_FILE)).stats().clone(),
    }
}

/// Fold the span source into `stats` (the transcript-derived counters of
/// `token_stats`). Disjoint keys: the span source is the leaf [`CLI`], so
/// nothing already in `stats` is touched or added to.
pub fn fold_into(stats: &mut UsageStats, spans: &UsageStats) {
    crate::services::token_stats::merge_into(stats, spans);
}

/// Whether the experiment is on (`Settings::claude_otel_tokens`), read per call.
pub fn enabled() -> bool {
    storage::read_json::<crate::schema::Settings>(&storage::settings_path())
        .map(|s| s.claude_otel_tokens())
        .unwrap_or(false)
}

// ── The launch ─────────────────────────────────────────────────────────────

/// The variables that already say something about Claude's own telemetry. One
/// of them in the spawn's or Tabtivity's environment means the user's setup is
/// theirs: nothing is added.
fn telemetry_var(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    upper.starts_with("OTEL_")
        || matches!(upper.as_str(), "CLAUDE_CODE_ENABLE_TELEMETRY" | "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA" | "ENABLE_ENHANCED_TELEMETRY_BETA" | "ENABLE_BETA_TRACING_DETAILED" | "BETA_TRACING_ENDPOINT")
        || upper == CARRIER.to_ascii_uppercase()
}

/// The variables a launch carries, in the order they are set. The bearer is
/// the last, under `carrier` (the variable's own name on Windows).
fn env_pairs(endpoint: &str, token: &str, carry: bool) -> Vec<(String, String)> {
    let mut pairs: Vec<(String, String)> = [
        ("CLAUDE_CODE_ENABLE_TELEMETRY", "1"),
        ("CLAUDE_CODE_ENHANCED_TELEMETRY_BETA", "1"),
        ("OTEL_TRACES_EXPORTER", "otlp"),
        ("OTEL_METRICS_EXPORTER", "none"),
        ("OTEL_LOGS_EXPORTER", "none"),
        ("OTEL_EXPORTER_OTLP_TRACES_PROTOCOL", "http/json"),
    ]
    .iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect();
    pairs.push(("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT".to_string(), endpoint.to_string()));
    pairs.push((if carry { CARRIER } else { HEADERS_VAR }.to_string(), format!("Authorization=Bearer%20{token}")));
    pairs
}

/// Everything about a spawn that decides whether it gets the exporter.
#[derive(Debug, Clone, Copy)]
pub struct Candidate<'a> {
    pub cmd: &'a str,
    pub args: &'a [String],
    pub local_model: bool,
    /// A project container (loopback is not this host's there).
    pub sandbox: bool,
}

/// Whether a spawn may get the exporter at all: a local Claude session (no
/// subcommand), not a local-model or container tab, and no telemetry setting
/// of the user's own in `env` (`ambient_telemetry`: or in Tabtivity's own
/// environment).
pub fn candidate(spawn: Candidate<'_>, env: &HashMap<String, String>, ambient_telemetry: bool) -> bool {
    crate::services::agent_api_keys::cli_of(spawn.cmd) == Some("claude")
        && !spawn.local_model
        && !spawn.sandbox
        && !crate::services::agent_api_keys::keyless_subcommand(spawn.cmd, spawn.args)
        && !ambient_telemetry
        && !env.keys().any(|k| telemetry_var(k))
}

/// The pure core of [`inject_launch`]: puts the exporter's variables in `env`
/// when the spawn is a candidate and `grant` yields an endpoint and a token.
/// Returns whether it did.
pub fn inject_env_with(
    spawn: Candidate<'_>,
    env: &mut HashMap<String, String>,
    carry: bool,
    ambient_telemetry: bool,
    grant: impl FnOnce() -> Option<(String, String)>,
) -> bool {
    if !candidate(spawn, env, ambient_telemetry) {
        return false;
    }
    let Some((endpoint, token)) = grant() else { return false };
    for (key, value) in env_pairs(&endpoint, &token, carry) {
        env.insert(key, value);
    }
    true
}

/// Give a local Claude spawn of `scope_id` the exporter, when the experiment
/// is on. Call where `claude_token::inject_launch` runs (while `opts` still
/// names the CLI), and not for a locked project's tab. Never on a hosted
/// server's daemon.
pub(crate) fn inject_launch(opts: &mut crate::terminal::PtyOptions, scope_id: &str) -> bool {
    if crate::services::server::is_server() || !enabled() {
        return false;
    }
    let local_model = crate::services::agent_api_keys::is_local_model(opts);
    // Anything of the telemetry family in Tabtivity's own environment is the
    // user's: a launch started from such a shell adds nothing.
    let ambient = std::env::vars_os().any(|(k, _)| telemetry_var(&k.to_string_lossy()));
    let spawn = Candidate { cmd: &opts.cmd, args: &opts.args, local_model, sandbox: opts.sandbox };
    let tab = &opts.id;
    inject_env_with(spawn, &mut opts.env, cfg!(unix), ambient, || {
        let server = ensure_started()?;
        Some((server.endpoint(), server.issue(scope_id, tab)?))
    })
}

/// A tmux older than 3.2 cannot carry the bearer: the carrier was dropped, so
/// the rest of the exporter's variables go with it (an exporter without its
/// token would only be refused). Returns whether anything was removed.
pub fn drop_with_carrier(env: &mut HashMap<String, String>) -> bool {
    if !env.contains_key(CARRIER) {
        return false;
    }
    env.remove(CARRIER);
    for (key, _) in env_pairs("", "", true) {
        env.remove(&key);
    }
    true
}

#[cfg(test)]
mod tests;
