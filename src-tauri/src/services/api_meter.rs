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
    /// A usage object's raw bytes.
    Usage(Vec<u8>),
    /// A model id.
    Model(String),
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
    /// The usage object being copied, and the depth it was opened at.
    capture: Option<(Vec<u8>, usize)>,
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
                self.reset();
                continue;
            }
            if let Some((buf, _)) = self.capture.as_mut() {
                buf.push(b);
                if buf.len() > MAX_CAPTURE {
                    self.capture = None;
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
                    self.capture = Some((vec![b'{'], self.stack.len()));
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
                if self.deeper == 0 && self.capture.as_ref().is_some_and(|(_, depth)| *depth == self.stack.len()) {
                    if let Some((buf, _)) = self.capture.take() {
                        found.push(Found::Usage(buf));
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
    Embedding { model: Option<String>, body_bytes: usize },
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
                "embedContent" | "batchEmbedContents" => Some(Billing::Embedding { model, body_bytes: 0 }),
                _ => None,
            }
        }
    }
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
    /// Only a 2xx answer is charged an estimate.
    success: bool,
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
            success: true,
        }
    }

    /// The answer's status and content type, before its first chunk:
    /// `text/event-stream` is read line by line.
    pub fn answer(&mut self, status: u16, content_type: Option<&str>) {
        self.success = (200..300).contains(&status);
        self.sse = content_type.is_some_and(|ct| ct.trim_start().to_ascii_lowercase().starts_with("text/event-stream"));
    }

    /// The request body's size, for an embedding estimate.
    pub fn request_body(&mut self, bytes: usize) {
        if let Billing::Embedding { body_bytes, .. } = &mut self.billing {
            *body_bytes = bytes;
        }
    }

    pub fn feed(&mut self, chunk: &[u8]) {
        let mut found = Vec::new();
        self.scanner.feed(self.provider, self.sse, chunk, &mut found);
        for f in found {
            match f {
                Found::Model(m) => self.model = Some(m),
                Found::Usage(bytes) => {
                    if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                        self.merge(&v);
                    }
                }
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
    /// reported nothing (an error, a refusal before any usage).
    pub fn charge(&self, month: &str) -> Option<Charge> {
        let hint = match &self.billing {
            Billing::Usage { model } | Billing::Embedding { model, .. } => model.as_deref(),
        };
        let model = self.model.as_deref().or(hint).unwrap_or("(unknown)");
        let charge = match self.provider {
            Provider::Anthropic => {
                if !self.saw_usage {
                    return None;
                }
                super::api_prices::price_anthropic(model, &self.anthropic)
            }
            Provider::Gemini => {
                let mut usage = self.gemini.clone();
                if let Billing::Embedding { body_bytes, .. } = self.billing {
                    if self.success && usage.prompt_token_count == 0 {
                        usage.prompt_token_count = (body_bytes as u64).div_ceil(3);
                    }
                }
                if !self.saw_usage && usage.prompt_token_count == 0 {
                    return None;
                }
                super::api_prices::price_gemini(model, &usage, month)
            }
        };
        let nothing = charge.usd <= 0.0 && charge.input == 0 && charge.output == 0 && charge.cache_read == 0;
        (!nothing).then_some(charge)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MONTH: &str = "2026-10";

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
            assert_eq!(m.charge(MONTH).as_ref(), Some(expect), "split at {i}");
        }
        for i in (0..body.len()).step_by(7) {
            for j in (i..body.len()).step_by(11) {
                let m = metered(provider, billing.clone(), content_type, &[&body[..i], &body[i..j], &body[j..]]);
                assert_eq!(m.charge(MONTH).as_ref(), Some(expect), "split at {i}/{j}");
            }
        }
        // Byte by byte.
        let mut m = Meter::new(provider, billing);
        m.answer(200, Some(content_type));
        for b in body {
            m.feed(std::slice::from_ref(b));
        }
        assert_eq!(m.charge(MONTH).as_ref(), Some(expect), "byte by byte");
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
        let cut = ANTHROPIC_SSE.find("event: message_delta").unwrap();
        let m = metered(Provider::Anthropic, Billing::Usage { model: None }, "text/event-stream", &[&ANTHROPIC_SSE.as_bytes()[..cut]]);
        let c = m.charge(MONTH).unwrap();
        assert_eq!((c.input, c.output, c.cache_read), (1000, 1, 3000));
        // An error answer reports nothing.
        let mut m = Meter::new(Provider::Anthropic, Billing::Usage { model: None });
        m.answer(429, Some("application/json"));
        m.feed(br#"{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}"#);
        assert_eq!(m.charge(MONTH), None);
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
        assert_eq!(m.charge(MONTH), Some(expect));
    }

    #[test]
    fn gemini_model_comes_from_the_answer_else_the_path() {
        let body = br#"{"usageMetadata":{"promptTokenCount":1000000}}"#;
        let m = metered(Provider::Gemini, Billing::Usage { model: Some("gemini-2.5-flash".into()) }, "application/json", &[body]);
        let c = m.charge(MONTH).unwrap();
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
        m.request_body(3_000_000);
        m.answer(200, Some("application/json"));
        m.feed(br#"{"embedding":{"values":[0.1,0.2]}}"#);
        let c = m.charge(MONTH).unwrap();
        assert_eq!(c.input, 1_000_000);
        assert!((c.usd - 0.20).abs() < 1e-9);
        // A refused embedding costs nothing.
        let mut m = Meter::new(Provider::Gemini, billing(Provider::Gemini, "POST", "/v1/models/x:embedContent").unwrap());
        m.request_body(3_000_000);
        m.answer(400, Some("application/json"));
        assert_eq!(m.charge(MONTH), None);
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
        let c = m.charge(MONTH).unwrap();
        assert!((c.usd - 0.30).abs() < 1e-9);
        let mut m = Meter::new(Provider::Anthropic, Billing::Usage { model: None });
        m.answer(200, Some("application/json"));
        m.feed(b"{\"usage\":{\"pad\":\"");
        m.feed(&vec![b'x'; MAX_CAPTURE * 2]);
        m.feed(b"\",\"input_tokens\":5}}");
        assert!(m.scanner.capture.is_none());
        assert_eq!(m.charge(MONTH), None, "an oversized usage object is not read");
    }

    #[test]
    fn a_broken_sse_line_does_not_confuse_the_next() {
        let body = concat!(
            "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":\n",
            "data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":1000000}}\n\n",
        );
        let m = metered(Provider::Anthropic, Billing::Usage { model: None }, "text/event-stream", &[body.as_bytes()]);
        let c = m.charge(MONTH).unwrap();
        assert_eq!((c.input, c.output), (0, 1_000_000));
        // The model never arrived: priced (and flagged) as unknown.
        assert!(!c.known);
        assert!((c.usd - 50.0).abs() < 1e-9);
    }
}
