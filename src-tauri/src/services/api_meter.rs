//! Reads the usage a provider reports out of an answer as the API proxy
//! relays it (`docs/api_chat_plan.md`, Part C, C3), chunk by chunk, without
//! keeping the answer.
//!
//! A turn can stream for minutes and carry megabytes of text, tool input or
//! inline images; only a few hundred bytes of it say what it cost. A small
//! streaming JSON scanner ([`Scanner`]) follows the structure of the bytes —
//! strings and escapes, nesting, keys — through any chunk boundary, and keeps
//! only:
//!
//! - **Anthropic:** the `usage` object of the answer's top-level message
//!   (non-streaming JSON, or an SSE `message_delta`) or of its `message`
//!   (SSE `message_start`), and the `model` beside it;
//! - **Gemini:** `usageMetadata` and `modelVersion` of each top-level
//!   response object — an SSE event (`alt=sse`), an element of the JSON
//!   array a plain `streamGenerateContent` sends, or a whole JSON answer.
//!
//! A key of that name anywhere else — inside a tool call's arguments, in the
//! text of an answer (escaped in a string) — is not read. Usage counts are
//! cumulative in both APIs (`message_delta` repeats the running output total;
//! every streamed Gemini chunk repeats the running totals), so each field
//! keeps the largest value seen: nothing is counted twice. What was reported
//! before a stream broke off (or the client left) is charged.
//!
//! **An answer that never reported its final count** — the client left or
//! the stream broke before Anthropic's `message_delta` (or before Gemini's
//! stream ended), the client left before the answer even began, or a usage
//! object could not be read — is charged an **estimate** on top of what was
//! reported, never nothing: the provider bills what it generated whether or
//! not it was relayed (thinking that is not shown included), and an agent
//! holding a token could otherwise read an answer and hang up before its
//! count to spend for free. Output is bounded by time — [`End::elapsed`] at
//! a rate above the provider's fastest current model
//! ([`ANTHROPIC_TOKENS_PER_SEC`], [`GEMINI_TOKENS_PER_SEC`]) — and by the
//! request's own `max_tokens` (Anthropic) or the provider's output cap;
//! input not yet reported is the request body's bytes / 3 (more tokens than
//! any tokenizer yields), up to a context window. An overcount on purpose:
//! a turn the user cancels costs a little more here than it did.
//!
//! Memory is bounded per answer: a nesting stack of [`MAX_DEPTH`] frames, a
//! [`MAX_STRING`]-byte window on the current string, and a [`MAX_CAPTURE`]
//! copy of the one usage object being read. In SSE mode a line break resets
//! the scanner, so a malformed event cannot confuse the next one.
//!
//! `AppHandle`-free and pure.

use super::agent_api_keys::Provider;
use super::api_prices::{AnthropicUsage, Charge, GeminiUsage};

/// Nesting tracked frame by frame; deeper levels are only counted.
const MAX_DEPTH: usize = 64;
/// A usage object larger than this is not one (dropped, not read).
const MAX_CAPTURE: usize = 16 * 1024;
/// Bytes of a string kept to recognise a key or a model id.
const MAX_STRING: usize = 128;

/// Output tokens per second of an answer that did not report its final
/// count, above any current model of the provider (fast mode included).
pub const ANTHROPIC_TOKENS_PER_SEC: u64 = 300;
pub const GEMINI_TOKENS_PER_SEC: u64 = 600;
/// Output an Anthropic request may produce when its body names no readable
/// `max_tokens` (the largest any current model takes).
const ANTHROPIC_MAX_OUTPUT: u64 = 128_000;
/// Output plus thinking a Gemini request may produce (65,536 output tokens
/// and a 32,768-token thinking budget). The request's own settings are not
/// trusted here: Gemini also reads them under their snake_case names.
const GEMINI_MAX_OUTPUT: u64 = 65_536 + 32_768;
/// Input a request can hold at most (the providers' context windows).
const ANTHROPIC_MAX_INPUT: u64 = 1_000_000;
const GEMINI_MAX_INPUT: u64 = 2_000_000;

/// Keys the scanner cares about.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Key {
    Usage,
    UsageMetadata,
    Message,
    Model,
    ModelVersion,
    Other,
}

fn classify(s: &[u8]) -> Key {
    match s {
        b"usage" => Key::Usage,
        b"usageMetadata" => Key::UsageMetadata,
        b"message" => Key::Message,
        b"model" => Key::Model,
        b"modelVersion" => Key::ModelVersion,
        _ => Key::Other,
    }
}

#[derive(Clone, Copy, Debug)]
struct Frame {
    object: bool,
    /// The key this container is the value of (`Other` for an array element
    /// or a top-level value).
    key: Key,
}

/// What the scanner found.
#[derive(Debug, PartialEq)]
enum Found {
    /// A usage object's raw bytes, and whether it sits at the answer's root
    /// (Anthropic: a `message_delta` or a whole message — the final count).
    Usage(Vec<u8>, bool),
    /// A model id.
    Model(String),
    /// A usage object that could not be read whole (larger than
    /// [`MAX_CAPTURE`], or cut by an SSE line break): the count is not known.
    Lost,
}

#[derive(Debug, Default)]
struct Scanner {
    stack: Vec<Frame>,
    /// Levels past [`MAX_DEPTH`].
    deeper: usize,
    in_string: bool,
    escape: bool,
    /// The current string's first [`MAX_STRING`] bytes.
    string: Vec<u8>,
    string_long: bool,
    string_escaped: bool,
    /// The current string is an object key.
    string_is_key: bool,
    /// The current string is the value of this key.
    string_value_of: Option<Key>,
    /// The next token in the top object is a key.
    expect_key: bool,
    /// The last key read, until its `:`.
    last_key: Option<Key>,
    /// The key whose value starts next.
    pending: Option<Key>,
    /// The usage object being copied, the depth it was opened at, and
    /// whether that is the answer's root.
    capture: Option<(Vec<u8>, usize, bool)>,
}

impl Scanner {
    fn reset(&mut self) {
        *self = Scanner::default();
    }

    /// The frames below the answer's top-level object: `None` when the
    /// scanner is not inside one it can name (too deep, or an array that is
    /// not the outer one).
    fn below_root(&self) -> Option<&[Frame]> {
        if self.deeper > 0 {
            return None;
        }
        let rest = match self.stack.first()? {
            Frame { object: true, .. } => &self.stack[1..],
            // A JSON array of responses (Gemini without `alt=sse`).
            Frame { object: false, .. } => {
                if !self.stack.get(1)?.object {
                    return None;
                }
                &self.stack[2..]
            }
        };
        Some(rest)
    }

    /// Whether `key`'s value, starting now, is one `provider` reports usage
    /// or the model in.
    fn wanted(&self, provider: Provider, key: Key) -> bool {
        let Some(rest) = self.below_root() else { return false };
        match provider {
            Provider::Anthropic => {
                matches!(key, Key::Usage | Key::Model)
                    && (rest.is_empty() || (rest.len() == 1 && rest[0].object && rest[0].key == Key::Message))
            }
            Provider::Gemini => matches!(key, Key::UsageMetadata | Key::ModelVersion) && rest.is_empty(),
        }
    }

    fn feed(&mut self, provider: Provider, sse: bool, bytes: &[u8], found: &mut Vec<Found>) {
        for &b in bytes {
            if sse && (b == b'\n' || b == b'\r') {
                if self.capture.is_some() {
                    found.push(Found::Lost);
                }
                self.reset();
                continue;
            }
            if let Some((buf, _, _)) = self.capture.as_mut() {
                buf.push(b);
                if buf.len() > MAX_CAPTURE {
                    self.capture = None;
                    found.push(Found::Lost);
                }
            }
            self.step(provider, b, found);
        }
    }

    fn step(&mut self, provider: Provider, b: u8, found: &mut Vec<Found>) {
        if self.in_string {
            if self.escape {
                self.escape = false;
            } else if b == b'\\' {
                self.escape = true;
                self.string_escaped = true;
            } else if b == b'"' {
                self.in_string = false;
                self.end_string(found);
                return;
            }
            if self.string.len() < MAX_STRING {
                self.string.push(b);
            } else {
                self.string_long = true;
            }
            return;
        }
        // Outside any JSON value: only the start of one matters (SSE field
        // names, `data:`, whitespace).
        if self.stack.is_empty() && self.deeper == 0 && b != b'{' && b != b'[' {
            return;
        }
        match b {
            b'"' => {
                let top_object = self.stack.last().is_some_and(|f| f.object) && self.deeper == 0;
                self.in_string = true;
                self.escape = false;
                self.string.clear();
                self.string_long = false;
                self.string_escaped = false;
                self.string_is_key = top_object && self.expect_key;
                self.string_value_of = if self.string_is_key {
                    None
                } else {
                    self.pending.take().filter(|k| self.wanted(provider, *k))
                };
            }
            b':' => {
                if self.stack.last().is_some_and(|f| f.object) {
                    self.pending = self.last_key.take();
                    self.expect_key = false;
                }
            }
            b',' => {
                self.pending = None;
                self.last_key = None;
                self.expect_key = self.stack.last().is_some_and(|f| f.object) && self.deeper == 0;
            }
            b'{' | b'[' => {
                let object = b == b'{';
                let key = self.pending.take().unwrap_or(Key::Other);
                if object
                    && self.capture.is_none()
                    && matches!(key, Key::Usage | Key::UsageMetadata)
                    && self.wanted(provider, key)
                {
                    let root = self.below_root().is_some_and(<[Frame]>::is_empty);
                    self.capture = Some((vec![b'{'], self.stack.len(), root));
                }
                if self.stack.len() < MAX_DEPTH {
                    self.stack.push(Frame { object, key });
                } else {
                    self.deeper += 1;
                }
                self.expect_key = object;
                self.last_key = None;
            }
            b'}' | b']' => {
                if self.deeper > 0 {
                    self.deeper -= 1;
                } else {
                    self.stack.pop();
                }
                self.pending = None;
                self.last_key = None;
                self.expect_key = false;
                if self.deeper == 0 && self.capture.as_ref().is_some_and(|(_, depth, _)| *depth == self.stack.len()) {
                    if let Some((buf, _, root)) = self.capture.take() {
                        found.push(Found::Usage(buf, root));
                    }
                }
                if self.stack.is_empty() && self.deeper == 0 {
                    self.reset();
                }
            }
            _ => {
                // A scalar value (number, literal) consumes the pending key.
                if !b.is_ascii_whitespace() {
                    self.pending = None;
                }
            }
        }
    }

    fn end_string(&mut self, found: &mut Vec<Found>) {
        if self.string_is_key {
            self.last_key = Some(if self.string_long || self.string_escaped { Key::Other } else { classify(&self.string) });
        } else if let Some(Key::Model | Key::ModelVersion) = self.string_value_of {
            if !self.string_long && !self.string_escaped && !self.string.is_empty() {
                found.push(Found::Model(String::from_utf8_lossy(&self.string).into_owned()));
            }
        }
        self.string_value_of = None;
        self.pending = None;
    }
}

/// Which relayed requests cost money, and how to read their answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Billing {
    /// A model answer with reported usage. `model` is the one the request
    /// path names (Gemini), used when the answer names none.
    Usage { model: Option<String> },
    /// An embedding request: Gemini reports no usage for it, so its input is
    /// estimated from the request body (`body_bytes / 3` tokens — more tokens
    /// than any text tokenizer yields, so an overcount) unless usage arrives.
    /// No output.
    Embedding { model: Option<String> },
}

/// Whether a request on `path` (below the provider prefix) is billed, and how.
/// Token counting and model reads cost nothing.
pub fn billing(provider: Provider, method: &str, path: &str) -> Option<Billing> {
    if method != "POST" {
        return None;
    }
    match provider {
        Provider::Anthropic => (path == "/v1/messages").then_some(Billing::Usage { model: None }),
        Provider::Gemini => {
            // `/v1beta/models/<model>:<method>`
            let tail = path.rsplit('/').next()?;
            let (model, verb) = tail.split_once(':')?;
            let model = Some(model.to_string()).filter(|m| !m.is_empty());
            match verb {
                "generateContent" | "streamGenerateContent" => Some(Billing::Usage { model }),
                "embedContent" | "batchEmbedContents" => Some(Billing::Embedding { model }),
                _ => None,
            }
        }
    }
}

/// How an answer ended, for [`Meter::charge`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct End {
    /// The provider's body ended cleanly (not a broken read, not a client
    /// that left, not an answer that never began).
    pub complete: bool,
    /// From the request's send to the end.
    pub elapsed: std::time::Duration,
}

/// What the request body says about the most the answer can cost.
#[derive(Debug, Clone, Default)]
struct RequestFacts {
    body_bytes: usize,
    /// Anthropic `max_tokens`.
    max_output: Option<u64>,
    /// Anthropic `model`: priced when the answer names none.
    model: Option<String>,
    /// Anthropic `speed: "fast"` / `inference_geo: "us"`.
    fast: bool,
    us_only: bool,
}

/// The few fields of an Anthropic request body the estimate reads. A body
/// that does not parse (or repeats a field) leaves them all unset — the
/// dearer reading.
#[derive(serde::Deserialize)]
struct AnthropicRequest {
    max_tokens: Option<u64>,
    model: Option<String>,
    speed: Option<String>,
    inference_geo: Option<String>,
}

/// One relayed answer's meter.
#[derive(Debug)]
pub struct Meter {
    provider: Provider,
    billing: Billing,
    sse: bool,
    scanner: Scanner,
    model: Option<String>,
    anthropic: AnthropicUsage,
    gemini: GeminiUsage,
    saw_usage: bool,
    /// Anthropic: a usage object at the answer's root arrived (the final
    /// count of a `message_delta` or a whole message).
    final_usage: bool,
    /// A usage object could not be read: the reported count is incomplete.
    lost: bool,
    /// The answer's status arrived.
    answered: bool,
    /// The answer's status is 2xx (an error answer costs nothing).
    success: bool,
    request: RequestFacts,
}

impl Meter {
    pub fn new(provider: Provider, billing: Billing) -> Self {
        Meter {
            provider,
            billing,
            sse: false,
            scanner: Scanner::default(),
            model: None,
            anthropic: AnthropicUsage::default(),
            gemini: GeminiUsage::default(),
            saw_usage: false,
            final_usage: false,
            lost: false,
            answered: false,
            success: true,
            request: RequestFacts::default(),
        }
    }

    pub fn provider(&self) -> Provider {
        self.provider
    }

    /// The answer's status and content type, before its first chunk:
    /// `text/event-stream` is read line by line.
    pub fn answer(&mut self, status: u16, content_type: Option<&str>) {
        self.answered = true;
        self.success = (200..300).contains(&status);
        self.sse = content_type.is_some_and(|ct| ct.trim_start().to_ascii_lowercase().starts_with("text/event-stream"));
    }

    /// The request body, read for what bounds an estimate: its size, and
    /// (Anthropic) `max_tokens`, `model`, `speed`, `inference_geo`.
    pub fn request(&mut self, body: &[u8]) {
        self.request = RequestFacts { body_bytes: body.len(), ..RequestFacts::default() };
        if self.provider == Provider::Anthropic {
            if let Ok(r) = serde_json::from_slice::<AnthropicRequest>(body) {
                self.request.max_output = r.max_tokens;
                self.request.model = r.model.filter(|m| !m.is_empty() && m.len() <= MAX_STRING);
                self.request.fast = r.speed.as_deref() == Some("fast");
                self.request.us_only = r.inference_geo.as_deref() == Some("us");
            }
        }
    }

    pub fn feed(&mut self, chunk: &[u8]) {
        let mut found = Vec::new();
        self.scanner.feed(self.provider, self.sse, chunk, &mut found);
        for f in found {
            match f {
                // One answer naming two models (a server-side fallback):
                // the dearer one prices it.
                Found::Model(m) => {
                    let dearer = match self.model.as_deref() {
                        Some(old) => super::api_prices::output_rate(self.provider, &m) > super::api_prices::output_rate(self.provider, old),
                        None => true,
                    };
                    if dearer {
                        self.model = Some(m);
                    }
                }
                Found::Usage(bytes, root) => match serde_json::from_slice::<serde_json::Value>(&bytes) {
                    Ok(v) => {
                        self.merge(&v);
                        self.final_usage |= root;
                    }
                    Err(_) => self.lost = true,
                },
                Found::Lost => self.lost = true,
            }
        }
    }

    fn merge(&mut self, v: &serde_json::Value) {
        let n = |v: &serde_json::Value, k: &str| v.get(k).and_then(serde_json::Value::as_u64);
        let max = |slot: &mut u64, value: Option<u64>| {
            if let Some(value) = value {
                *slot = (*slot).max(value);
            }
        };
        let max_opt = |slot: &mut Option<u64>, value: Option<u64>| {
            if let Some(value) = value {
                *slot = Some(slot.unwrap_or(0).max(value));
            }
        };
        self.saw_usage = true;
        match self.provider {
            Provider::Anthropic => {
                let u = &mut self.anthropic;
                max(&mut u.input_tokens, n(v, "input_tokens"));
                max(&mut u.output_tokens, n(v, "output_tokens"));
                max(&mut u.cache_creation_input_tokens, n(v, "cache_creation_input_tokens"));
                max(&mut u.cache_read_input_tokens, n(v, "cache_read_input_tokens"));
                if let Some(cc) = v.get("cache_creation") {
                    max_opt(&mut u.cache_5m, n(cc, "ephemeral_5m_input_tokens"));
                    max_opt(&mut u.cache_1h, n(cc, "ephemeral_1h_input_tokens"));
                }
                if let Some(st) = v.get("server_tool_use") {
                    max(&mut u.web_search_requests, n(st, "web_search_requests"));
                }
                if v.get("speed").and_then(serde_json::Value::as_str) == Some("fast") {
                    u.fast = true;
                }
                if v.get("inference_geo").and_then(serde_json::Value::as_str) == Some("us") {
                    u.us_only = true;
                }
            }
            Provider::Gemini => {
                let u = &mut self.gemini;
                max(&mut u.prompt_token_count, n(v, "promptTokenCount"));
                max(&mut u.candidates_token_count, n(v, "candidatesTokenCount"));
                max(&mut u.cached_content_token_count, n(v, "cachedContentTokenCount"));
                max(&mut u.thoughts_token_count, n(v, "thoughtsTokenCount"));
                max(&mut u.tool_use_prompt_token_count, n(v, "toolUsePromptTokenCount"));
                let audio = v
                    .get("promptTokensDetails")
                    .and_then(serde_json::Value::as_array)
                    .map(|details| {
                        details
                            .iter()
                            .filter(|d| d.get("modality").and_then(serde_json::Value::as_str) == Some("AUDIO"))
                            .filter_map(|d| n(d, "tokenCount"))
                            .sum::<u64>()
                    });
                max(&mut u.audio_prompt_tokens, audio);
            }
        }
    }

    /// What the answer cost, priced in UTC month `month`; `None` when it
    /// cost nothing (an error answer, or nothing reported or estimated). An
    /// answer whose final count did not arrive is charged the estimate in
    /// the module docs on top of what it reported.
    pub fn charge(&self, month: &str, end: End) -> Option<Charge> {
        if self.answered && !self.success {
            return None;
        }
        let path_model = match &self.billing {
            Billing::Usage { model } | Billing::Embedding { model } => model.as_deref(),
        };
        let model = self.model.as_deref().or(path_model).or(self.request.model.as_deref()).unwrap_or("(unknown)");
        // Anthropic's final count is `message_delta`'s (or a whole
        // message's), however the body ended after it; Gemini's is the last
        // chunk's, known only from a clean end.
        let settled = !self.lost
            && match self.provider {
                Provider::Anthropic => self.final_usage,
                Provider::Gemini => self.saw_usage && end.complete,
            };
        let (max_input, max_output, per_sec) = match self.provider {
            Provider::Anthropic => {
                (ANTHROPIC_MAX_INPUT, self.request.max_output.unwrap_or(ANTHROPIC_MAX_OUTPUT), ANTHROPIC_TOKENS_PER_SEC)
            }
            Provider::Gemini => (GEMINI_MAX_INPUT, GEMINI_MAX_OUTPUT, GEMINI_TOKENS_PER_SEC),
        };
        let input_estimate = (self.request.body_bytes as u64).div_ceil(3).min(max_input);
        let output_estimate = match self.billing {
            Billing::Embedding { .. } => 0,
            Billing::Usage { .. } => ((end.elapsed.as_secs_f64() * per_sec as f64).ceil() as u64).min(max_output),
        };
        let charge = match self.provider {
            Provider::Anthropic => {
                let mut u = self.anthropic.clone();
                if !settled {
                    if u.input_tokens == 0 && u.cache_creation_input_tokens == 0 && u.cache_read_input_tokens == 0 {
                        u.input_tokens = input_estimate;
                    }
                    u.output_tokens = u.output_tokens.max(output_estimate);
                    u.fast |= self.request.fast;
                    u.us_only |= self.request.us_only;
                }
                super::api_prices::price_anthropic(model, &u)
            }
            Provider::Gemini => {
                let mut u = self.gemini.clone();
                if !settled {
                    if u.prompt_token_count == 0 {
                        u.prompt_token_count = input_estimate;
                    }
                    let reported = u.candidates_token_count.saturating_add(u.thoughts_token_count);
                    if output_estimate > reported {
                        u.candidates_token_count = output_estimate - u.thoughts_token_count.min(output_estimate);
                    }
                }
                super::api_prices::price_gemini(model, &u, month)
            }
        };
        let nothing = charge.usd <= 0.0 && charge.input == 0 && charge.output == 0 && charge.cache_read == 0;
        (!nothing).then_some(charge)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    const MONTH: &str = "2026-10";
    /// A clean end.
    const DONE: End = End { complete: true, elapsed: Duration::ZERO };

    /// An end that was not clean, `secs` after the send.
    fn cut(secs: u64) -> End {
        End { complete: false, elapsed: Duration::from_secs(secs) }
    }

    fn metered(provider: Provider, billing: Billing, content_type: &str, chunks: &[&[u8]]) -> Meter {
        let mut m = Meter::new(provider, billing);
        m.answer(200, Some(content_type));
        for c in chunks {
            m.feed(c);
        }
        m
    }

    /// Every way to cut `body` into two and three pieces gives `expect`.
    fn every_split(provider: Provider, billing: Billing, content_type: &str, body: &[u8], expect: &Charge) {
        for i in 0..=body.len() {
            let m = metered(provider, billing.clone(), content_type, &[&body[..i], &body[i..]]);
            assert_eq!(m.charge(MONTH, DONE).as_ref(), Some(expect), "split at {i}");
        }
        for i in (0..body.len()).step_by(7) {
            for j in (i..body.len()).step_by(11) {
                let m = metered(provider, billing.clone(), content_type, &[&body[..i], &body[i..j], &body[j..]]);
                assert_eq!(m.charge(MONTH, DONE).as_ref(), Some(expect), "split at {i}/{j}");
            }
        }
        // Byte by byte.
        let mut m = Meter::new(provider, billing);
        m.answer(200, Some(content_type));
        for b in body {
            m.feed(std::slice::from_ref(b));
        }
        assert_eq!(m.charge(MONTH, DONE).as_ref(), Some(expect), "byte by byte");
    }

    const ANTHROPIC_SSE: &str = concat!(
        "event: message_start\r\n",
        "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"type\":\"message\",\"role\":\"assistant\",",
        "\"model\":\"claude-opus-5-5\",\"content\":[],\"stop_reason\":null,",
        "\"usage\":{\"input_tokens\":1000,\"cache_creation_input_tokens\":2000,\"cache_read_input_tokens\":3000,",
        "\"cache_creation\":{\"ephemeral_5m_input_tokens\":2000,\"ephemeral_1h_input_tokens\":0},\"output_tokens\":1}}}\r\n\r\n",
        "event: content_block_start\n",
        "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"t\",\"name\":\"x\",\"input\":{}}}\n\n",
        "event: content_block_delta\n",
        // A fake usage inside the tool input (a string here) and inside text.
        "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",",
        "\"partial_json\":\"{\\\"usage\\\":{\\\"output_tokens\\\":1}}\"}}\n\n",
        "event: ping\ndata: {\"type\": \"ping\"}\n\n",
        "event: message_delta\n",
        "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":500,",
        "\"server_tool_use\":{\"web_search_requests\":2}}}\n\n",
        "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
    );

    fn anthropic_expected() -> Charge {
        let usage = AnthropicUsage {
            input_tokens: 1000,
            output_tokens: 500,
            cache_creation_input_tokens: 2000,
            cache_read_input_tokens: 3000,
            cache_5m: Some(2000),
            cache_1h: Some(0),
            web_search_requests: 2,
            ..Default::default()
        };
        super::super::api_prices::price_anthropic("claude-opus-5-5", &usage)
    }

    #[test]
    fn anthropic_sse_usage_is_read_through_any_chunk_boundary() {
        let expect = anthropic_expected();
        assert_eq!(expect.output, 500, "message_delta's cumulative total, not 1 + 500");
        assert!(expect.known);
        every_split(Provider::Anthropic, Billing::Usage { model: None }, "text/event-stream; charset=utf-8", ANTHROPIC_SSE.as_bytes(), &expect);
    }

    #[test]
    fn anthropic_json_usage_ignores_usage_keys_inside_content() {
        let body = concat!(
            "{\"id\":\"msg_1\",\"type\":\"message\",\"model\":\"claude-haiku-4-5-20251001\",",
            "\"content\":[{\"type\":\"tool_use\",\"id\":\"t\",\"name\":\"x\",\"input\":{\"usage\":{\"input_tokens\":1},",
            "\"model\":\"claude-cheap\"}},{\"type\":\"text\",\"text\":\"a \\\"usage\\\": {} b\"}],",
            "\"usage\":{\"input_tokens\":2000000,\"output_tokens\":1000000}}"
        );
        let expect = super::super::api_prices::price_anthropic(
            "claude-haiku-4-5-20251001",
            &AnthropicUsage { input_tokens: 2_000_000, output_tokens: 1_000_000, ..Default::default() },
        );
        assert!((expect.usd - 7.0).abs() < 1e-9);
        every_split(Provider::Anthropic, Billing::Usage { model: None }, "application/json", body.as_bytes(), &expect);
    }

    #[test]
    fn an_answer_that_broke_off_is_charged_what_it_reported() {
        let at = ANTHROPIC_SSE.find("event: message_delta").unwrap();
        let m = metered(Provider::Anthropic, Billing::Usage { model: None }, "text/event-stream", &[&ANTHROPIC_SSE.as_bytes()[..at]]);
        let c = m.charge(MONTH, cut(0)).unwrap();
        assert_eq!((c.input, c.output, c.cache_read), (1000, 1, 3000));
        // Even a body that ended "cleanly" without its final count is not
        // settled by `message_start`'s placeholder output.
        let c = m.charge(MONTH, End { complete: true, elapsed: Duration::from_secs(10) }).unwrap();
        assert_eq!((c.input, c.output), (1000, 3000));
        // An error answer reports nothing.
        let mut m = Meter::new(Provider::Anthropic, Billing::Usage { model: None });
        m.answer(429, Some("application/json"));
        m.feed(br#"{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}"#);
        assert_eq!(m.charge(MONTH, DONE), None);
    }

    const GEMINI_SSE: &str = concat!(
        "data: {\"candidates\": [{\"content\": {\"parts\": [{\"functionCall\": {\"name\": \"f\", \"args\": ",
        "{\"usageMetadata\": {\"promptTokenCount\": 1}}}}],\"role\": \"model\"}}],",
        "\"usageMetadata\": {\"promptTokenCount\": 300000,\"candidatesTokenCount\": 10,\"totalTokenCount\": 300010,",
        "\"promptTokensDetails\": [{\"modality\": \"TEXT\",\"tokenCount\": 300000}]},",
        "\"modelVersion\": \"gemini-2.5-pro\",\"responseId\": \"r1\"}\r\n\r\n",
        "data: {\"candidates\": [{\"content\": {\"parts\": [{\"text\": \"more\"}],\"role\": \"model\"}}],",
        "\"usageMetadata\": {\"promptTokenCount\": 300000,\"candidatesTokenCount\": 40,\"cachedContentTokenCount\": 100000,",
        "\"thoughtsTokenCount\": 60,\"totalTokenCount\": 300100},",
        "\"modelVersion\": \"gemini-2.5-pro\",\"responseId\": \"r1\"}\r\n\r\n",
    );

    fn gemini_expected() -> Charge {
        let usage = GeminiUsage {
            prompt_token_count: 300_000,
            candidates_token_count: 40,
            cached_content_token_count: 100_000,
            thoughts_token_count: 60,
            ..Default::default()
        };
        super::super::api_prices::price_gemini("gemini-2.5-pro", &usage, MONTH)
    }

    #[test]
    fn gemini_cumulative_usage_is_not_counted_twice() {
        let expect = gemini_expected();
        assert_eq!((expect.input, expect.output, expect.cache_read), (200_000, 100, 100_000));
        let billing = Billing::Usage { model: Some("gemini-cheap-hint".into()) };
        every_split(Provider::Gemini, billing, "text/event-stream", GEMINI_SSE.as_bytes(), &expect);
    }

    #[test]
    fn gemini_json_array_streams_and_single_answers_are_read_too() {
        let events: Vec<&str> = GEMINI_SSE.split("\r\n\r\n").filter(|e| !e.is_empty()).map(|e| e.trim_start_matches("data: ")).collect();
        // Pretty-printed array, as a plain `streamGenerateContent` sends it.
        let array = format!("[{},\r\n{}\n]", events[0], events[1]).replace(", ", ",\n  ");
        let expect = gemini_expected();
        every_split(Provider::Gemini, Billing::Usage { model: None }, "application/json; charset=UTF-8", array.as_bytes(), &expect);
        // `generateContent`: one object.
        let m = metered(Provider::Gemini, Billing::Usage { model: None }, "application/json", &[events[1].as_bytes()]);
        assert_eq!(m.charge(MONTH, DONE), Some(expect));
    }

    #[test]
    fn gemini_model_comes_from_the_answer_else_the_path() {
        let body = br#"{"usageMetadata":{"promptTokenCount":1000000}}"#;
        let m = metered(Provider::Gemini, Billing::Usage { model: Some("gemini-2.5-flash".into()) }, "application/json", &[body]);
        let c = m.charge(MONTH, DONE).unwrap();
        assert_eq!(c.model, "gemini-2.5-flash");
        assert!((c.usd - 0.30).abs() < 1e-9);
    }

    #[test]
    fn billing_names_only_requests_that_cost_money() {
        assert_eq!(billing(Provider::Anthropic, "POST", "/v1/messages"), Some(Billing::Usage { model: None }));
        assert_eq!(billing(Provider::Anthropic, "POST", "/v1/messages/count_tokens"), None);
        assert_eq!(billing(Provider::Anthropic, "GET", "/v1/models"), None);
        assert_eq!(
            billing(Provider::Gemini, "POST", "/v1beta/models/gemini-2.5-pro:streamGenerateContent"),
            Some(Billing::Usage { model: Some("gemini-2.5-pro".into()) })
        );
        assert_eq!(billing(Provider::Gemini, "POST", "/v1beta/models/gemini-2.5-pro:countTokens"), None);
        assert_eq!(billing(Provider::Gemini, "GET", "/v1beta/models/gemini-2.5-pro"), None);
        assert!(matches!(
            billing(Provider::Gemini, "POST", "/v1/models/gemini-embedding-2:embedContent"),
            Some(Billing::Embedding { .. })
        ));
    }

    #[test]
    fn an_embedding_is_estimated_from_its_body_unless_usage_arrives() {
        let mut m = Meter::new(Provider::Gemini, billing(Provider::Gemini, "POST", "/v1/models/gemini-embedding-2:embedContent").unwrap());
        m.request(&vec![b' '; 3_000_000]);
        m.answer(200, Some("application/json"));
        m.feed(br#"{"embedding":{"values":[0.1,0.2]}}"#);
        let c = m.charge(MONTH, DONE).unwrap();
        assert_eq!(c.input, 1_000_000);
        assert!((c.usd - 0.20).abs() < 1e-9);
        // A refused embedding costs nothing.
        let mut m = Meter::new(Provider::Gemini, billing(Provider::Gemini, "POST", "/v1/models/x:embedContent").unwrap());
        m.request(&vec![b' '; 3_000_000]);
        m.answer(400, Some("application/json"));
        assert_eq!(m.charge(MONTH, DONE), None);
    }

    #[test]
    fn memory_stays_bounded_on_long_and_deep_answers() {
        let mut m = Meter::new(Provider::Gemini, Billing::Usage { model: None });
        m.answer(200, Some("application/json"));
        // A 4 MiB inline image, a usage object too large to be one, and deep
        // nesting before the real usage.
        m.feed(b"{\"candidates\":[{\"content\":{\"parts\":[{\"inlineData\":{\"data\":\"");
        for _ in 0..64 {
            m.feed(&[b'A'; 65536]);
        }
        m.feed(b"\"}}]}}],\"x\":");
        m.feed(&b"[".repeat(200));
        m.feed(&b"]".repeat(200));
        assert!(m.scanner.string.len() <= MAX_STRING);
        assert!(m.scanner.stack.len() <= MAX_DEPTH);
        m.feed(br#","usageMetadata":{"promptTokenCount":1000000,"candidatesTokenCount":0},"modelVersion":"gemini-2.5-flash"}"#);
        let c = m.charge(MONTH, DONE).unwrap();
        assert!((c.usd - 0.30).abs() < 1e-9);
        let mut m = Meter::new(Provider::Anthropic, Billing::Usage { model: None });
        m.answer(200, Some("application/json"));
        m.feed(b"{\"usage\":{\"pad\":\"");
        m.feed(&vec![b'x'; MAX_CAPTURE * 2]);
        m.feed(b"\",\"input_tokens\":5}}");
        assert!(m.scanner.capture.is_none());
        assert_eq!(m.charge(MONTH, DONE), None, "an oversized usage object is not read");
    }

    #[test]
    fn a_broken_sse_line_does_not_confuse_the_next() {
        let body = concat!(
            "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":\n",
            "data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":1000000}}\n\n",
        );
        let m = metered(Provider::Anthropic, Billing::Usage { model: None }, "text/event-stream", &[body.as_bytes()]);
        let c = m.charge(MONTH, DONE).unwrap();
        assert_eq!((c.input, c.output), (0, 1_000_000));
        // The model never arrived: priced (and flagged) as unknown.
        assert!(!c.known);
        assert!((c.usd - 50.0).abs() < 1e-9);
    }

    // ---- adversarial answers and early ends (C3 review) -------------------

    fn anthropic_meter(request: &str) -> Meter {
        let mut m = Meter::new(Provider::Anthropic, Billing::Usage { model: None });
        m.request(request.as_bytes());
        m
    }

    #[test]
    fn hanging_up_before_the_final_count_is_charged_by_time_up_to_max_tokens() {
        let start = ANTHROPIC_SSE.find("event: content_block_start").unwrap();
        let mut m = anthropic_meter(r#"{"model":"claude-opus-5-5","max_tokens":8000,"stream":true}"#);
        m.answer(200, Some("text/event-stream"));
        m.feed(&ANTHROPIC_SSE.as_bytes()[..start]);
        // 10 s at the bound: 3,000 output tokens, more than reported.
        let c = m.charge(MONTH, cut(10)).unwrap();
        assert_eq!((c.input, c.output), (1000, 10 * ANTHROPIC_TOKENS_PER_SEC));
        // Never past the request's own `max_tokens`.
        assert_eq!(m.charge(MONTH, cut(3600)).unwrap().output, 8000);
        // The same stream through to `message_delta` costs what it says.
        let mut m = anthropic_meter(r#"{"model":"claude-opus-5-5","max_tokens":8000}"#);
        m.answer(200, Some("text/event-stream"));
        m.feed(ANTHROPIC_SSE.as_bytes());
        assert_eq!(m.charge(MONTH, cut(3600)).unwrap().output, 500, "a final count is not estimated over");
    }

    #[test]
    fn a_request_the_client_left_before_its_answer_began_is_charged() {
        // No status ever arrived (a non-streaming turn, or the wait for the
        // first byte): input from the body, output by time, priced as the
        // request's model in its requested speed.
        let body = format!(r#"{{"model":"claude-haiku-4-5","max_tokens":64000,"speed":"fast","messages":[{{"role":"user","content":"{}"}}]}}"#, "x".repeat(2_000_000));
        let m = anthropic_meter(&body);
        let c = m.charge(MONTH, cut(20)).unwrap();
        assert_eq!(c.model, "claude-haiku-4-5");
        assert_eq!(c.input, (body.len() as u64).div_ceil(3));
        assert_eq!(c.output, 20 * ANTHROPIC_TOKENS_PER_SEC);
        let plain = super::super::api_prices::price_anthropic(
            "claude-haiku-4-5",
            &AnthropicUsage { input_tokens: c.input, output_tokens: c.output, ..Default::default() },
        );
        assert!((c.usd - plain.usd * 2.0).abs() < 1e-9, "fast mode from the request");
        // A body too large for any context window is capped at one.
        let m = anthropic_meter(&"x".repeat(30_000_000));
        assert_eq!(m.charge(MONTH, cut(0)).unwrap().input, ANTHROPIC_MAX_INPUT);
        // An answer that never began and a body that names no model: the
        // highest rate.
        assert!(!m.charge(MONTH, cut(0)).unwrap().known);
    }

    #[test]
    fn a_body_that_repeats_max_tokens_gets_the_largest_cap() {
        let m = anthropic_meter(r#"{"max_tokens":10,"max_tokens":128000,"model":"claude-opus-5-5"}"#);
        assert_eq!(m.request.max_output, None);
        assert_eq!(m.charge(MONTH, cut(3600)).unwrap().output, ANTHROPIC_MAX_OUTPUT);
        // Nor does a float, a string or a negative number lower it.
        for body in [r#"{"max_tokens":10.0}"#, r#"{"max_tokens":"10"}"#, r#"{"max_tokens":-1}"#, "not json"] {
            assert_eq!(anthropic_meter(body).request.max_output, None, "{body}");
        }
    }

    #[test]
    fn an_error_answer_costs_nothing_however_it_ends() {
        let mut m = anthropic_meter(r#"{"max_tokens":64000}"#);
        m.answer(400, Some("application/json"));
        m.feed(br#"{"type":"error","error":{"type":"invalid_request_error","message":"no"}}"#);
        assert_eq!(m.charge(MONTH, cut(60)), None);
    }

    #[test]
    fn an_unreadable_usage_object_leaves_the_answer_unsettled() {
        // Too large to capture, on a body that ended cleanly: estimated, not
        // free and not trusted.
        let mut m = anthropic_meter(r#"{"max_tokens":100000}"#);
        m.answer(200, Some("application/json"));
        m.feed(b"{\"model\":\"claude-opus-5-5\",\"usage\":{\"pad\":\"");
        m.feed(&vec![b'x'; MAX_CAPTURE * 2]);
        m.feed(b"\",\"input_tokens\":5,\"output_tokens\":7}}");
        let c = m.charge(MONTH, End { complete: true, elapsed: Duration::from_secs(4) }).unwrap();
        assert_eq!(c.output, 4 * ANTHROPIC_TOKENS_PER_SEC);
        // A usage object an SSE line break cuts in two.
        let mut m = anthropic_meter(r#"{"max_tokens":100000}"#);
        m.answer(200, Some("text/event-stream"));
        m.feed(b"data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":\n2}}\n\n");
        assert!(m.lost);
        assert_eq!(m.charge(MONTH, End { complete: true, elapsed: Duration::from_secs(1) }).unwrap().output, ANTHROPIC_TOKENS_PER_SEC);
    }

    #[test]
    fn model_text_cannot_forge_sse_framing_or_usage() {
        // The model writes a fake end of event and a fake final count (with a
        // huge number, so reading it at all would show) into its text; JSON
        // escapes the line breaks, so the scanner never leaves the string.
        let body = concat!(
            "event: message_start\n",
            "data: {\"type\":\"message_start\",\"message\":{\"model\":\"claude-opus-5-5\",\"usage\":{\"input_tokens\":10,\"output_tokens\":1}}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":",
            "\"\\\\\\\"}\\n\\nevent: message_delta\\ndata: {\\\"type\\\":\\\"message_delta\\\",\\\"usage\\\":{\\\"output_tokens\\\":99999999}}\\n\\n\\\\\"}}\n\n",
            "event: message_delta\n",
            "data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":20}}\n\n",
        );
        let m = metered(Provider::Anthropic, Billing::Usage { model: None }, "text/event-stream", &[body.as_bytes()]);
        let c = m.charge(MONTH, DONE).unwrap();
        assert_eq!((c.input, c.output), (10, 20));
        assert!(c.known);
    }

    #[test]
    fn deep_tool_input_and_repeated_keys_do_not_hide_the_root_usage() {
        // Non-streaming: tool input is real JSON the model shapes, nested far
        // past the tracked depth, with `usage` and `model` keys at every level.
        let mut body = String::from("{\"model\":\"claude-opus-5-5\",\"content\":[{\"type\":\"tool_use\",\"input\":");
        for _ in 0..(MAX_DEPTH * 3) {
            body.push_str("{\"usage\":{\"output_tokens\":0},\"model\":\"claude-haiku-4-5\",\"k\":[");
        }
        for _ in 0..(MAX_DEPTH * 3) {
            body.push_str("]}");
        }
        body.push_str("}],\"usage\":{\"input_tokens\":3,\"output_tokens\":4},\"usage\":{\"input_tokens\":2,\"output_tokens\":9}}");
        let m = metered(Provider::Anthropic, Billing::Usage { model: None }, "application/json", &[body.as_bytes()]);
        let c = m.charge(MONTH, DONE).unwrap();
        assert_eq!(c.model, "claude-opus-5-5");
        // Repeated root keys: each field's largest value.
        assert_eq!((c.input, c.output), (3, 9));
    }

    #[test]
    fn two_models_in_one_answer_price_it_at_the_dearer() {
        // A server-side fallback: the answer starts on one model, ends on another.
        let body = concat!(
            "data: {\"type\":\"message_start\",\"message\":{\"model\":\"claude-fable-5-1\",\"usage\":{\"input_tokens\":1000000,\"output_tokens\":1}}}\n\n",
            "data: {\"type\":\"message_delta\",\"model\":\"claude-opus-4-8\",\"usage\":{\"output_tokens\":1000000}}\n\n",
        );
        let m = metered(Provider::Anthropic, Billing::Usage { model: None }, "text/event-stream", &[body.as_bytes()]);
        let c = m.charge(MONTH, DONE).unwrap();
        assert_eq!(c.model, "claude-fable-5-1");
        assert!((c.usd - 60.0).abs() < 1e-9);
    }

    #[test]
    fn gemini_hung_up_on_during_silent_thinking_is_charged() {
        // `alt=sse`, nothing arrived yet (thinking streams no chunk).
        let mut m = Meter::new(Provider::Gemini, Billing::Usage { model: Some("gemini-2.5-pro".into()) });
        m.request(&[b' '; 30_000]);
        m.answer(200, Some("text/event-stream"));
        let c = m.charge(MONTH, cut(30)).unwrap();
        assert_eq!((c.input, c.output), (10_000, 30 * GEMINI_TOKENS_PER_SEC));
        assert!(c.known);
        // A stream cut after chunks: what they reported, the output at least
        // the time bound, thinking counted within it.
        let first = GEMINI_SSE.find("\r\n\r\n").unwrap();
        let mut m = Meter::new(Provider::Gemini, Billing::Usage { model: None });
        m.answer(200, Some("text/event-stream"));
        m.feed(&GEMINI_SSE.as_bytes()[..first + 4]);
        let c = m.charge(MONTH, cut(1)).unwrap();
        assert_eq!((c.input, c.output), (300_000, GEMINI_TOKENS_PER_SEC));
        assert_eq!(m.charge(MONTH, cut(3600)).unwrap().output, GEMINI_MAX_OUTPUT);
    }

    #[test]
    fn escaped_or_overlong_model_ids_are_not_taken() {
        let long = "m".repeat(MAX_STRING + 1);
        for model in ["claude-haiku-4-\\u0035", long.as_str()] {
            let body = format!(r#"{{"model":"{model}","usage":{{"input_tokens":1000000}}}}"#);
            let m = metered(Provider::Anthropic, Billing::Usage { model: None }, "application/json", &[body.as_bytes()]);
            let c = m.charge(MONTH, DONE).unwrap();
            assert!(!c.known, "{model}");
            assert!((c.usd - 10.0).abs() < 1e-9, "{model}");
        }
    }
}
