//! The key broker (hosted plan §5.4, P5): the administrator's API key used
//! on behalf of users without ever handing it to them.
//!
//! * **Who runs it**: `<slug>-gateway broker`, as `<slug>-auth` — the key
//!   keeper's account — in `<slug>-keybroker.service`. It reads the keeper's
//!   state (the key, `meta.json`, `tokens.json`) and writes only the month
//!   counts (`<cli>/usage/<user>.json`). Unlike the keeper it needs the
//!   network: it calls the provider.
//! * **Where**: `127.0.0.1:<keys_wire::BROKER_PORT>`, one path prefix per CLI
//!   (`/claude/v1/messages`). Fenced agents share the host's network
//!   namespace and reach it; so can every local process, which is why every
//!   request must carry a **per-user broker token** (the keeper's, handed to
//!   a listed user's daemon in place of the key). A request with an `Origin`
//!   header (a browser page) is refused outright.
//! * **What it forwards**: only the provider paths an agent needs
//!   ([`allowed`]: messages, token counting, the model list), only a fixed
//!   set of request headers, the token replaced by the key. A streamed
//!   response passes back as it arrives.
//! * **Budgets**: before a request is forwarded, the user's billed tokens of
//!   the month ([`keys_wire::billed`]) are checked against their budget (the
//!   user's own, else the key's default, else none); over it → `403`. The
//!   cap is soft by the requests already in flight.
//! * **Usage**: every `messages` answer is metered from the provider's own
//!   `usage` fields (the JSON answer, or the stream's `message_start` /
//!   `message_delta` events) and added to the user's month — also when the
//!   client goes away mid-stream (what was seen until then, the streamed
//!   text standing in for an output count that never came). A JSON answer is
//!   metered whole before it is handed over.
//! * **Revocation**: the token is looked up per request, so taking a user off
//!   the key's list, a renewed token, a withdrawn key or a switch to direct
//!   delivery stops the next request (`401`; Claude then runs its helper
//!   again and gets the user's current answer).
//! * **Audit**: `audit.jsonl` beside the keeper's rows — a user's use at most
//!   once per [`AUDIT_EVERY`] per CLI, and a budget refusal likewise. Never a
//!   key, a token or a prompt.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, Path as RoutePath, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;
use serde_json::{json, Value};
use subtle::ConstantTimeEq;

use crate::audit::{AuditLog, Row};
use crate::keeper::{self, Tokens, UsageFile};
use crate::keys_wire::{self, Usage};

/// The largest request body forwarded (images and long contexts included).
pub const MAX_BODY: usize = 32 * 1024 * 1024;
/// Requests in flight at once, every user together.
pub const MAX_IN_FLIGHT: usize = 256;
/// Requests in flight at once per user.
pub const MAX_PER_USER: usize = 16;
/// A user's use (and a budget refusal) is audited at most this often.
pub const AUDIT_EVERY: u64 = 10 * 60;
/// A non-streamed answer is metered when it is no larger than this.
const MAX_METERED_JSON: usize = 8 * 1024 * 1024;
/// Bytes of streamed text per output token, for a stream that ended before
/// the provider's final count (a conservative guess: English runs nearer
/// four, so an interrupted answer is billed a little high, never free).
const BYTES_PER_TOKEN_ESTIMATE: u64 = 3;
pub const VERB_USED: &str = "agent-key-brokered";
pub const VERB_OVER_BUDGET: &str = "agent-key-over-budget";

/// Request headers passed on to the provider; everything else (cookies,
/// the client's own credentials, forwarding headers) stays behind.
const PASS_REQUEST: &[&str] = &["anthropic-version", "anthropic-beta", "content-type", "accept", "user-agent", "x-stainless-retry-count", "x-stainless-timeout"];
/// Answer headers passed back.
const PASS_RESPONSE: &[&str] = &["content-type", "request-id", "retry-after", "x-should-retry", "cache-control"];

/// Is `method rest` (the path after `/<cli>/`) one an agent of `cli` needs?
pub fn allowed(cli: &str, method: &Method, rest: &str) -> bool {
    match cli {
        "claude" => match (method, rest) {
            (&Method::POST, "v1/messages" | "v1/messages/count_tokens") => true,
            (&Method::GET, "v1/models") => true,
            // A model id; `.` and `..` would be dot segments the URL parser
            // resolves (`v1/models/..` is `v1/`), so they are no id.
            (&Method::GET, model) => model.strip_prefix("v1/models/").is_some_and(|id| !id.is_empty() && id != "." && id != ".." && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'@'))),
            _ => false,
        },
        _ => false,
    }
}

pub struct Broker {
    dir: PathBuf,
    /// CLI id → the provider origin it forwards to.
    upstreams: HashMap<&'static str, String>,
    client: reqwest::Client,
    audit: AuditLog,
    /// Month counts, one writer at a time.
    write: Mutex<()>,
    /// `(verb, user, cli)` → when it was last audited.
    audited: Mutex<HashMap<(&'static str, String, String), u64>>,
    in_flight: Arc<tokio::sync::Semaphore>,
    per_user: Mutex<HashMap<String, usize>>,
}

/// The process-wide rustls provider (`reqwest`'s `rustls-no-provider`):
/// installed once, before the first client is built.
pub fn ensure_crypto() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

impl Broker {
    /// A broker over the keeper's state `dir`, forwarding to each
    /// [`keys_wire::BROKER_CLIS`] upstream unless `upstreams` names another
    /// (tests: a fake provider on loopback).
    pub fn new(dir: PathBuf, upstreams: HashMap<&'static str, String>) -> Result<Self, String> {
        ensure_crypto();
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(10 * 60))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| format!("http client: {e}"))?;
        let mut all: HashMap<&'static str, String> = keys_wire::BROKER_CLIS.iter().map(|c| (c.id, c.upstream.to_string())).collect();
        all.extend(upstreams);
        Ok(Broker {
            audit: AuditLog::in_dir(&dir),
            dir,
            upstreams: all,
            client,
            write: Mutex::default(),
            audited: Mutex::default(),
            in_flight: Arc::new(tokio::sync::Semaphore::new(MAX_IN_FLIGHT)),
            per_user: Mutex::default(),
        })
    }

    /// The user whose token `token` is for `cli`, compared in constant time
    /// against every token of the CLI.
    fn user_of(&self, cli: &str, token: &str) -> Option<String> {
        let Tokens { tokens } = keeper::tokens_in(&self.dir, cli);
        let mut found = None;
        for (user, known) in &tokens {
            if known.len() == token.len() && bool::from(known.as_bytes().ct_eq(token.as_bytes())) {
                found = Some(user.clone());
            }
        }
        found
    }

    fn due(&self, verb: &'static str, user: &str, cli: &str) -> bool {
        let now = crate::now();
        let mut audited = self.audited.lock().unwrap_or_else(PoisonError::into_inner);
        let slot = audited.entry((verb, user.to_string(), cli.to_string())).or_insert(0);
        let due = now.saturating_sub(*slot) >= AUDIT_EVERY;
        if due {
            *slot = now;
        }
        due
    }

    /// Add `usage` to `user`'s month of `cli` (the newest
    /// [`keeper::USAGE_MONTHS`] months are kept).
    pub fn record(&self, cli: &str, user: &str, usage: &Usage) {
        let _guard = self.write.lock().unwrap_or_else(PoisonError::into_inner);
        let path = keeper::usage_path(&self.dir, cli, user);
        let result = (|| -> std::io::Result<()> {
            if let Some(dir) = path.parent() {
                if std::fs::symlink_metadata(dir).is_err() {
                    use std::os::unix::fs::DirBuilderExt;
                    std::fs::DirBuilder::new().mode(0o700).recursive(true).create(dir)?;
                }
            }
            let mut file: UsageFile = keeper::usage_in(&self.dir, cli, user);
            file.months.entry(keys_wire::month_of(crate::now())).or_default().add(usage);
            while file.months.len() > keeper::USAGE_MONTHS {
                let Some(oldest) = file.months.keys().next().cloned() else { break };
                file.months.remove(&oldest);
            }
            let bytes = serde_json::to_vec(&file).map_err(std::io::Error::other)?;
            crate::write_atomic(&path, &bytes, 0o600)
        })();
        if let Err(e) = result {
            eprintln!("broker: usage {cli}/{user}: {e}");
        }
    }

    fn billed_this_month(&self, cli: &str, user: &str) -> u64 {
        keeper::usage_in(&self.dir, cli, user).months.get(&keys_wire::month_of(crate::now())).map(keys_wire::billed).unwrap_or(0)
    }

    fn take_user_slot(self: &Arc<Self>, user: &str) -> Option<UserSlot> {
        let mut map = self.per_user.lock().unwrap_or_else(PoisonError::into_inner);
        let used = map.entry(user.to_string()).or_insert(0);
        if *used >= MAX_PER_USER {
            return None;
        }
        *used += 1;
        Some(UserSlot { broker: self.clone(), user: user.to_string() })
    }
}

struct UserSlot {
    broker: Arc<Broker>,
    user: String,
}

impl Drop for UserSlot {
    fn drop(&mut self) {
        let mut map = self.broker.per_user.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(used) = map.get_mut(&self.user) {
            *used = used.saturating_sub(1);
            if *used == 0 {
                map.remove(&self.user);
            }
        }
    }
}

/// The provider's error shape, so the CLI shows the message.
fn refuse(status: StatusCode, kind: &str, message: &str) -> Response {
    let body = json!({ "type": "error", "error": { "type": kind, "message": message } });
    (status, [(header::CONTENT_TYPE, "application/json"), (header::CACHE_CONTROL, "no-store")], body.to_string()).into_response()
}

fn token_of(headers: &HeaderMap) -> Option<String> {
    if let Some(key) = headers.get("x-api-key").and_then(|v| v.to_str().ok()) {
        return Some(key.trim().to_string());
    }
    let auth = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let token = auth.strip_prefix("Bearer ").or_else(|| auth.strip_prefix("bearer "))?;
    Some(token.trim().to_string())
}

/// The token counts in one `usage` object of the provider's answer; each
/// field the larger of what was seen (a stream's `message_delta` repeats the
/// running output count).
fn take_usage(into: &mut Usage, usage: &Value) {
    let field = |name: &str| usage.get(name).and_then(Value::as_u64);
    let keep = |slot: &mut u64, value: Option<u64>| {
        if let Some(value) = value {
            *slot = (*slot).max(value);
        }
    };
    keep(&mut into.input, field("input_tokens"));
    keep(&mut into.output, field("output_tokens"));
    keep(&mut into.cache_write, field("cache_creation_input_tokens"));
    keep(&mut into.cache_read, field("cache_read_input_tokens"));
}

/// Meters one `messages` answer as it streams past and records it when the
/// answer is done or dropped (a client gone mid-stream still pays for what
/// the provider produced until then).
///
/// A stream's output count arrives only in its closing `message_delta`, so
/// a client that stops reading just before it would have had every word for
/// one token. Until that count is seen, the text the stream carried
/// (`content_block_delta`s) stands in for it, estimated at
/// [`BYTES_PER_TOKEN_ESTIMATE`].
pub struct Meter {
    broker: Arc<Broker>,
    cli: String,
    user: String,
    sse: bool,
    /// The unfinished line of a stream, or the whole JSON answer.
    pending: Vec<u8>,
    usage: Usage,
    overflow: bool,
    /// Bytes of streamed content seen (text, tool input, thinking).
    streamed: u64,
    /// The stream's closing count (`message_delta` with `usage`) was seen.
    counted: bool,
}

impl Meter {
    fn new(broker: Arc<Broker>, cli: &str, user: &str, sse: bool) -> Self {
        Meter { broker, cli: cli.into(), user: user.into(), sse, pending: Vec::new(), usage: Usage::default(), overflow: false, streamed: 0, counted: false }
    }

    pub fn feed(&mut self, chunk: &[u8]) {
        if !self.sse {
            if self.pending.len() + chunk.len() > MAX_METERED_JSON {
                self.overflow = true;
                self.pending.clear();
            } else if !self.overflow {
                self.pending.extend_from_slice(chunk);
            }
            return;
        }
        self.pending.extend_from_slice(chunk);
        while let Some(end) = self.pending.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=end).collect();
            self.line(&line);
        }
        // An event line is never this long; drop a runaway one.
        if self.pending.len() > 1024 * 1024 {
            self.pending.clear();
        }
    }

    fn line(&mut self, line: &[u8]) {
        let Some(data) = line.strip_prefix(b"data:") else { return };
        let Ok(event) = serde_json::from_slice::<Value>(data.trim_ascii()) else { return };
        match event.get("type").and_then(Value::as_str) {
            Some("message_start") => {
                if let Some(usage) = event.get("message").and_then(|m| m.get("usage")) {
                    take_usage(&mut self.usage, usage);
                }
            }
            Some("message_delta") => {
                if let Some(usage) = event.get("usage") {
                    take_usage(&mut self.usage, usage);
                    self.counted = true;
                }
            }
            Some("content_block_delta") => {
                if let Some(delta) = event.get("delta") {
                    for field in ["text", "partial_json", "thinking"] {
                        if let Some(text) = delta.get(field).and_then(Value::as_str) {
                            self.streamed = self.streamed.saturating_add(text.len() as u64);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    pub fn usage(&self) -> &Usage {
        &self.usage
    }
}

impl Drop for Meter {
    fn drop(&mut self) {
        if !self.sse && !self.overflow {
            if let Some(usage) = serde_json::from_slice::<Value>(&self.pending).ok().as_ref().and_then(|v| v.get("usage")) {
                take_usage(&mut self.usage, usage);
            }
        }
        if self.sse && !self.pending.is_empty() {
            let rest = std::mem::take(&mut self.pending);
            self.line(&rest);
        }
        if self.sse && !self.counted {
            self.usage.output = self.usage.output.max(self.streamed.div_ceil(BYTES_PER_TOKEN_ESTIMATE));
        }
        self.usage.requests = 1;
        self.broker.record(&self.cli, &self.user, &self.usage);
    }
}

async fn handle(State(broker): State<Arc<Broker>>, RoutePath((cli, rest)): RoutePath<(String, String)>, method: Method, uri: Uri, headers: HeaderMap, body: Bytes) -> Response {
    // A browser page on any site can send to loopback; nothing here is for one.
    if headers.contains_key(header::ORIGIN) {
        return refuse(StatusCode::FORBIDDEN, "permission_error", "the key broker does not answer browsers");
    }
    let Some(upstream) = keys_wire::broker_cli(&cli).and_then(|c| broker.upstreams.get(c.id)).cloned() else {
        return refuse(StatusCode::NOT_FOUND, "not_found_error", "no such CLI at the key broker");
    };
    if !allowed(&cli, &method, &rest) {
        return refuse(StatusCode::NOT_FOUND, "not_found_error", "the key broker does not forward this request");
    }
    let Some(token) = token_of(&headers) else {
        return refuse(StatusCode::UNAUTHORIZED, "authentication_error", "no broker token");
    };
    let Some(user) = broker.user_of(&cli, &token) else {
        return refuse(StatusCode::UNAUTHORIZED, "authentication_error", "this broker token is not valid (renewed, withdrawn, or you were taken off the key's list)");
    };
    let Some(meta) = keeper::meta_in(&broker.dir, &cli).filter(|m| m.broker && m.users.contains(&user)) else {
        return refuse(StatusCode::UNAUTHORIZED, "authentication_error", "the administrator no longer offers you this key through the broker");
    };
    let Ok(Some(key)) = keeper::read_key_in(&broker.dir, &cli) else {
        return refuse(StatusCode::UNAUTHORIZED, "authentication_error", "the administrator no longer offers this key");
    };
    let metered = method == Method::POST && rest == "v1/messages";
    if metered {
        if let Some(budget) = meta.budget_of(&user) {
            let billed = broker.billed_this_month(&cli, &user);
            if billed >= budget {
                if broker.due(VERB_OVER_BUDGET, &user, &cli) {
                    broker.audit.record(Row::new(&user, None, VERB_OVER_BUDGET, "refused").resource(&cli));
                }
                return refuse(StatusCode::FORBIDDEN, "permission_error", &format!("your monthly budget on the administrator's key is used up ({billed} of {budget} tokens); ask the administrator, or switch to your own login in Settings → Manage CLIs"));
            }
        }
    }
    let Ok(_permit) = broker.in_flight.clone().try_acquire_owned() else {
        return refuse(StatusCode::TOO_MANY_REQUESTS, "rate_limit_error", "the key broker is busy");
    };
    let Some(slot) = broker.take_user_slot(&user) else {
        return refuse(StatusCode::TOO_MANY_REQUESTS, "rate_limit_error", "too many requests of yours in flight at the key broker");
    };
    let mut url = format!("{}/{rest}", upstream.trim_end_matches('/'));
    if let Some(query) = uri.query() {
        url.push('?');
        url.push_str(query);
    }
    let mut out = reqwest::header::HeaderMap::new();
    for name in PASS_REQUEST {
        if let Some(value) = headers.get(*name) {
            out.insert(HeaderName::from_static(name), value.clone());
        }
    }
    let Ok(mut key_value) = HeaderValue::from_str(&key) else {
        return refuse(StatusCode::BAD_GATEWAY, "api_error", "the administrator's key cannot be sent");
    };
    key_value.set_sensitive(true);
    out.insert(HeaderName::from_static("x-api-key"), key_value);
    drop(key);
    let mut answer = match broker.client.request(method.clone(), &url).headers(out).body(body).send().await {
        Ok(answer) => answer,
        Err(e) => {
            eprintln!("broker: {cli}: upstream: {}", e.without_url());
            return refuse(StatusCode::BAD_GATEWAY, "api_error", "the provider could not be reached");
        }
    };
    if broker.due(VERB_USED, &user, &cli) {
        broker.audit.record(Row::new(&user, None, VERB_USED, "ok").resource(&cli));
    }
    let status = answer.status();
    let mut response_headers = HeaderMap::new();
    for name in PASS_RESPONSE {
        if let Some(value) = answer.headers().get(*name) {
            response_headers.insert(HeaderName::from_static(name), value.clone());
        }
    }
    let sse = answer.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).is_some_and(|v| v.starts_with("text/event-stream"));
    let mut meter = (metered && status.is_success()).then(|| Meter::new(broker.clone(), &cli, &user, sse));
    if let Some(mut json) = meter.take_if(|_| !sse) {
        // A JSON answer names its `usage` last: were it streamed through, a
        // client could read the content and leave before the count. It is
        // metered whole first, then handed over.
        let mut whole = Vec::new();
        loop {
            match answer.chunk().await {
                Ok(Some(chunk)) if whole.len() + chunk.len() <= MAX_METERED_JSON => {
                    json.feed(&chunk);
                    whole.extend_from_slice(&chunk);
                }
                Ok(Some(_)) => return refuse(StatusCode::BAD_GATEWAY, "api_error", "the provider's answer is too large for the key broker"),
                Ok(None) => break,
                Err(e) => {
                    eprintln!("broker: {cli}: upstream: {}", e.without_url());
                    return refuse(StatusCode::BAD_GATEWAY, "api_error", "the provider's answer broke off");
                }
            }
        }
        drop(json);
        drop((slot, _permit));
        let mut response = Response::new(Body::from(whole));
        *response.status_mut() = status;
        *response.headers_mut() = response_headers;
        return response;
    }
    let state = (answer, meter, slot, _permit);
    let stream = futures_util::stream::unfold(Some(state), |state| async move {
        let (mut answer, mut meter, slot, permit) = state?;
        match answer.chunk().await {
            Ok(Some(chunk)) => {
                if let Some(meter) = meter.as_mut() {
                    meter.feed(&chunk);
                }
                Some((Ok::<Bytes, std::io::Error>(chunk), Some((answer, meter, slot, permit))))
            }
            Ok(None) => None,
            Err(e) => Some((Err(std::io::Error::other(e.without_url())), None)),
        }
    });
    let mut response = Response::new(Body::from_stream(stream));
    *response.status_mut() = status;
    *response.headers_mut() = response_headers;
    response
}

pub fn router(broker: Arc<Broker>) -> Router {
    Router::new().route("/{cli}/{*rest}", any(handle)).layer(DefaultBodyLimit::max(MAX_BODY)).with_state(broker)
}

/// The loopback port systemd holds for the broker (`LISTEN_PID` is this
/// process, `LISTEN_FDS` ≥ 1, fd 3), or `None`. Socket activation is what
/// keeps the port from being squatted: were the broker down and the port
/// free, any local account could listen there and collect the tokens other
/// users' agents send.
pub fn activation_listener() -> Result<Option<tokio::net::TcpListener>, String> {
    use std::os::unix::io::FromRawFd;
    let for_us = std::env::var("LISTEN_PID").ok().and_then(|p| p.trim().parse::<u32>().ok()) == Some(std::process::id());
    let count = std::env::var("LISTEN_FDS").ok().and_then(|n| n.trim().parse::<i32>().ok()).unwrap_or(0);
    if !for_us || count < 1 {
        return Ok(None);
    }
    // SAFETY: F_SETFD on the descriptor systemd passed this process.
    if unsafe { libc::fcntl(3, libc::F_SETFD, libc::FD_CLOEXEC) } != 0 {
        return Err(format!("activation socket: {}", std::io::Error::last_os_error()));
    }
    // SAFETY: systemd hands this process fd 3 as its listening socket.
    let listener = unsafe { std::net::TcpListener::from_raw_fd(3) };
    listener.set_nonblocking(true).map_err(|e| format!("activation socket: {e}"))?;
    if !listener.local_addr().is_ok_and(|a| a.ip().is_loopback()) {
        return Err("the broker's socket must be on loopback".into());
    }
    tokio::net::TcpListener::from_std(listener).map(Some).map_err(|e| format!("activation socket: {e}"))
}

/// Serve `listener` (loopback) until it fails.
pub async fn serve(broker: Arc<Broker>, listener: tokio::net::TcpListener) -> Result<(), String> {
    axum::serve(listener, router(broker)).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests;
