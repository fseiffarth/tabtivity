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
//!   array a plain `streamGenerateContent` sends, or a whole JSON answer —
//!   and the Google Search queries a candidate's `groundingMetadata` lists in
//!   `webSearchQueries` (grounding is billed per query or per grounded
//!   prompt, never in `usageMetadata`; `api_prices` prices it).
//! - **OpenAI:** Responses `usage` and `model` at the root (JSON/compaction)
//!   or in an SSE event's `response`; input includes cached input and output
//!   includes reasoning. A stream without final usage is estimated as above.
//!   Hosted-tool calls (web search, file search, code interpreter, image
//!   generation) are read from the answer's output items — an `output` entry,
//!   an SSE `response.output_item.*` `item` — told apart by their `id` (a code
//!   interpreter session by its `container_id`) so an item repeated by the
//!   stream and by its final `response.completed` counts once; each is
//!   charged its per-call fee (`api_prices`) and the request's worst case
//!   (the tools its body lists, `max_tool_calls` or an assumed count) is held
//!   before it is sent. A request the fees or the bill could escape is
//!   refused before it is sent ([`openai_refusal`]): `background: true`
//!   (billed after the answer, unbounded), a priced `service_tier`, or a body
//!   that does not parse as one JSON object.
//!
//! A key of that name anywhere else — inside a tool call's arguments, in the
//! text of an answer (escaped in a string) — is not read. Usage counts are
//! cumulative in both APIs (`message_delta` repeats the running output total;
//! every streamed Gemini chunk repeats the running totals), so each field
//! keeps the largest value seen: nothing is counted twice. Search queries are
//! told apart by a keyed hash of their text per candidate; a query counts as
//! often as the one response listing it most often lists it, so a stream that
//! repeats its grounding metadata is not counted twice and one that splits
//! it over chunks is counted whole. What was reported before a stream broke
//! off (or the client left) is charged.
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
//! any tokenizer yields), up to a context window. A Gemini request that may
//! ground ([`may_ground`]: a Search or Maps grounding tool anywhere in its
//! body, or a body that does not parse) is charged at least
//! [`GROUNDING_QUERIES_ESTIMATE`] search queries. An overcount on purpose:
//! a turn the user cancels costs a little more here than it did.
//!
//! **Before the request is sent**, [`Meter::worst_case`] prices the same
//! estimate at its ceiling — the whole output cap, input as 1-hour cache
//! writes (Anthropic's dearest input kind), the grounding estimate — so the
//! proxy can hold it against the monthly limit while the request is in
//! flight (`api_usage::Book::reserve`). A body that names input by
//! reference ([`names_input_by_reference`]: an Anthropic document or image
//! `url`/`file` source or web fetch/search tool, a Gemini `fileData`,
//! `cachedContent`, URL context, file search or grounding tool) has the
//! model's whole context window held as input (`api_prices::context_window`):
//! the provider bills what it fetches, which the body's size does not bound.
//!
//! Memory is bounded per answer: a nesting stack of [`MAX_DEPTH`] frames, a
//! [`MAX_STRING`]-byte window on the current string, and a [`MAX_CAPTURE`]
//! copy of the one usage object being read. In SSE mode a line break resets
//! the scanner, so a malformed event cannot confuse the next one.
//!
//! `AppHandle`-free and pure.

use std::collections::hash_map::{DefaultHasher, RandomState};
use std::collections::{HashMap, HashSet};
use std::hash::{BuildHasher, Hasher};

use super::agent_api_keys::Provider;
use super::api_prices::{AnthropicUsage, Charge, GeminiUsage, OpenAiUsage};

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
/// Search queries charged for a Gemini answer that may have grounded but
/// did not deliver its grounding metadata (cut off, client gone, unreadable),
/// and held for one in flight. Grounded Gemini answers run a handful of
/// queries; ten is an assumption above that, like the output rate bounds.
pub const GROUNDING_QUERIES_ESTIMATE: u64 = 10;
/// Distinct search queries told apart per answer; past this every further
/// query counts as new (an overcount, never a miss).
const MAX_DISTINCT_QUERIES: usize = 256;
/// Gemini tool keys billed per search query or grounded prompt, compared in
/// ASCII lowercase with `_` dropped (Gemini reads both spellings).
const GROUNDING_TOOLS: &[&str] = &["googlesearch", "googlesearchretrieval", "googlemaps", "enterprisewebsearch"];

/// Hosted-tool calls an OpenAI request may make, held before it is sent when
/// its body lists the tool and names no `max_tool_calls`. Assumptions above
/// a turn's usual count, like [`GROUNDING_QUERIES_ESTIMATE`]; a container is
/// one session, however many calls run in it.
const WEB_SEARCH_CALLS_ESTIMATE: u64 = 10;
const FILE_SEARCH_CALLS_ESTIMATE: u64 = 10;
const CONTAINERS_ESTIMATE: u64 = 1;
const IMAGE_CALLS_ESTIMATE: u64 = 4;
/// `max_tool_calls` is trusted up to this.
const MAX_TOOL_CALLS: u64 = 1000;
/// Distinct tool items told apart per answer; past this every further one
/// counts as new.
const MAX_DISTINCT_TOOLS: usize = 1024;

/// Keys the scanner cares about.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Key {
    Usage,
    Response,
    UsageMetadata,
    Message,
    Model,
    ModelVersion,
    Candidates,
    GroundingMetadata,
    WebSearchQueries,
    Output,
    Item,
    Type,
    Id,
    ContainerId,
    Other,
}

fn classify(s: &[u8]) -> Key {
    match s {
        b"usage" => Key::Usage,
        b"response" => Key::Response,
        b"usageMetadata" => Key::UsageMetadata,
        b"message" => Key::Message,
        b"model" => Key::Model,
        b"modelVersion" => Key::ModelVersion,
        b"candidates" => Key::Candidates,
        b"groundingMetadata" => Key::GroundingMetadata,
        b"webSearchQueries" => Key::WebSearchQueries,
        b"output" => Key::Output,
        b"item" => Key::Item,
        b"type" => Key::Type,
        b"id" => Key::Id,
        b"container_id" => Key::ContainerId,
        _ => Key::Other,
    }
}

#[derive(Clone, Copy, Debug)]
struct Frame {
    object: bool,
    /// The key this container is the value of (`Other` for an array element
    /// or a top-level value).
    key: Key,
    /// Array: the element now being read (0-based).
    items: u32,
}

/// A candidate's `groundingMetadata` being read (Gemini).
#[derive(Debug)]
struct GroundingOpen {
    /// Its frame's index in the stack.
    depth: usize,
    /// The candidate's position in `candidates`.
    candidate: u32,
    /// Keyed hashes of the `webSearchQueries` strings, in order.
    queries: Vec<u64>,
    /// Queries past [`MAX_DISTINCT_QUERIES`] in this object.
    extra: u64,
    /// The object holds any key at all.
    had_key: bool,
}

/// An OpenAI hosted tool whose per-call fee is charged.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum ToolKind {
    WebSearch,
    FileSearch,
    CodeInterpreter,
    ImageGeneration,
}

fn tool_kind(item_type: &[u8]) -> Option<ToolKind> {
    match item_type {
        b"web_search_call" => Some(ToolKind::WebSearch),
        b"file_search_call" => Some(ToolKind::FileSearch),
        b"code_interpreter_call" => Some(ToolKind::CodeInterpreter),
        b"image_generation_call" => Some(ToolKind::ImageGeneration),
        _ => None,
    }
}

/// An OpenAI output item being read.
#[derive(Debug)]
struct ItemOpen {
    /// Its frame's index in the stack.
    depth: usize,
    kind: Option<ToolKind>,
    /// Keyed hashes of its `id` and `container_id`.
    id: Option<u64>,
    container: Option<u64>,
}

/// What the scanner found.
#[derive(Debug, PartialEq)]
enum Found {
    /// A hosted-tool call item (OpenAI).
    Tool { kind: ToolKind, id: Option<u64>, container: Option<u64> },
    /// A usage object's raw bytes, and whether it sits at the answer's root
    /// (Anthropic: a `message_delta` or a whole message — the final count).
    Usage(Vec<u8>, bool),
    /// A model id.
    Model(String),
    /// A usage object that could not be read whole (larger than
    /// [`MAX_CAPTURE`], or cut by an SSE line break): the count is not known.
    Lost,
    /// A candidate's whole `groundingMetadata` (Gemini).
    Grounding { candidate: u32, queries: Vec<u64>, extra: u64, had_key: bool },
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
    /// The grounding metadata being read.
    grounding: Option<GroundingOpen>,
    /// The OpenAI output item being read.
    item: Option<ItemOpen>,
    /// The current string is an output item's `id` or `container_id`: its
    /// hash so far.
    id_hash: Option<DefaultHasher>,
    /// The current string is a search query: its hash so far.
    query_hash: Option<DefaultHasher>,
    /// Hash keys for search queries, random per answer (an answer cannot
    /// pick two queries that collide) and kept across resets.
    keys: RandomState,
}

impl Scanner {
    fn reset(&mut self) {
        *self = Scanner { keys: self.keys.clone(), ..Scanner::default() };
    }

    /// Whether a string starting now is an element of the open grounding
    /// metadata's `webSearchQueries`.
    fn at_query(&self) -> bool {
        let Some(g) = &self.grounding else { return false };
        self.deeper == 0
            && self.stack.len() == g.depth + 2
            && self.stack.last().is_some_and(|f| !f.object && f.key == Key::WebSearchQueries)
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
        if matches!(key, Key::Type | Key::Id | Key::ContainerId) {
            // A direct child of the open output item.
            return provider == Provider::OpenAi
                && self.deeper == 0
                && self.item.as_ref().is_some_and(|i| self.stack.len() == i.depth + 1);
        }
        let Some(rest) = self.below_root() else { return false };
        match provider {
            Provider::OpenAi => matches!(key, Key::Usage | Key::Model)
                && (rest.is_empty() || matches!(rest, [Frame { object: true, key: Key::Response, .. }])),
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
                if self.capture.is_some() || self.grounding.is_some() || self.item.is_some() {
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
            if let Some(h) = self.query_hash.as_mut() {
                h.write_u8(b);
            }
            if let Some(h) = self.id_hash.as_mut() {
                h.write_u8(b);
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
                self.query_hash = (!self.string_is_key && self.at_query()).then(|| self.keys.build_hasher());
                self.id_hash = matches!(self.string_value_of, Some(Key::Id | Key::ContainerId)).then(|| self.keys.build_hasher());
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
                if self.deeper == 0 {
                    if let Some(top) = self.stack.last_mut().filter(|f| !f.object) {
                        top.items = top.items.saturating_add(1);
                    }
                }
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
                // `candidates[i].groundingMetadata` of a top-level response.
                if object && key == Key::GroundingMetadata && provider == Provider::Gemini && self.grounding.is_none() {
                    let candidate = match self.below_root() {
                        Some([list, item]) if !list.object && list.key == Key::Candidates && item.object => Some(list.items),
                        _ => None,
                    };
                    if let Some(candidate) = candidate {
                        self.grounding = Some(GroundingOpen {
                            depth: self.stack.len(),
                            candidate,
                            queries: Vec::new(),
                            extra: 0,
                            had_key: false,
                        });
                    }
                }
                // An output item of an OpenAI answer: `output[i]`,
                // `response.output[i]` or an event's `item`.
                if object && provider == Provider::OpenAi && self.item.is_none() {
                    let at_item = match self.below_root() {
                        Some([]) => key == Key::Item,
                        Some([list]) => !list.object && list.key == Key::Output,
                        Some([resp, list]) => resp.object && resp.key == Key::Response && !list.object && list.key == Key::Output,
                        _ => false,
                    };
                    if at_item {
                        self.item = Some(ItemOpen { depth: self.stack.len(), kind: None, id: None, container: None });
                    }
                }
                if self.stack.len() < MAX_DEPTH {
                    self.stack.push(Frame { object, key, items: 0 });
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
                if self.deeper == 0 && self.grounding.as_ref().is_some_and(|g| g.depth == self.stack.len()) {
                    if let Some(g) = self.grounding.take() {
                        found.push(Found::Grounding { candidate: g.candidate, queries: g.queries, extra: g.extra, had_key: g.had_key });
                    }
                }
                if self.deeper == 0 && self.item.as_ref().is_some_and(|i| i.depth == self.stack.len()) {
                    if let Some(ItemOpen { kind: Some(kind), id, container, .. }) = self.item.take() {
                        found.push(Found::Tool { kind, id, container });
                    }
                    self.item = None;
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
        if let Some(hash) = self.query_hash.take().map(|h| h.finish()) {
            if let Some(g) = self.grounding.as_mut() {
                if g.queries.len() < MAX_DISTINCT_QUERIES {
                    g.queries.push(hash);
                } else {
                    g.extra = g.extra.saturating_add(1);
                }
            }
        }
        if self.string_is_key {
            let depth = self.stack.len();
            if let Some(g) = self.grounding.as_mut().filter(|g| depth == g.depth + 1) {
                g.had_key = true;
            }
            self.last_key = Some(if self.string_long || self.string_escaped { Key::Other } else { classify(&self.string) });
        } else if let Some(Key::Model | Key::ModelVersion) = self.string_value_of {
            if !self.string_long && !self.string_escaped && !self.string.is_empty() {
                found.push(Found::Model(String::from_utf8_lossy(&self.string).into_owned()));
            }
        } else if let Some(key @ (Key::Type | Key::Id | Key::ContainerId)) = self.string_value_of {
            let hash = self.id_hash.take().map(|h| h.finish());
            if let Some(item) = self.item.as_mut() {
                match key {
                    Key::Type if !self.string_long && !self.string_escaped => item.kind = tool_kind(&self.string),
                    Key::Id => item.id = hash,
                    Key::ContainerId => item.container = hash,
                    _ => {}
                }
            }
        }
        self.id_hash = None;
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
        Provider::OpenAi => matches!(path, "/v1/responses" | "/v1/responses/compact").then_some(Billing::Usage { model: None }),
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
    /// Gemini answer: the request may ground ([`may_ground`]).
    may_ground: bool,
    /// The request names input by reference ([`names_input_by_reference`]).
    by_reference: bool,
    /// OpenAI: the hosted-tool calls the body's tools may make.
    tools: ToolCalls,
}

/// OpenAI hosted-tool call counts.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct ToolCalls {
    web_search: u64,
    file_search: u64,
    containers: u64,
    images: u64,
}

/// Whether a Gemini request body may ask for Search or Maps grounding: one
/// of [`GROUNDING_TOOLS`] is a key anywhere in it (every occurrence is seen,
/// duplicates and escaped spellings included), or it does not parse as JSON.
pub fn may_ground(body: &[u8]) -> bool {
    use serde::de::DeserializeSeed;
    let mut found = false;
    let mut de = serde_json::Deserializer::from_slice(body);
    let parsed = KeyScan(&mut found).deserialize(&mut de).and_then(|()| de.end()).is_ok();
    found || !parsed
}

/// Anthropic `type` values that name input the body does not hold: a
/// document or image `source` of type `url` or `file`, and the web fetch and
/// web search server tools (`web_fetch_20260209`, `web_search_20250305`, …),
/// whose results join the input during the turn.
fn anthropic_reference_type(value: &str) -> bool {
    matches!(value, "url" | "file") || value.starts_with("web_fetch") || value.starts_with("web_search")
}

/// Gemini keys (ASCII lowercase, `_` dropped) that name input by reference:
/// `fileData` / `file_uri` parts, a `cachedContent`, and the URL context,
/// file search and grounding tools, whose fetched content joins the input.
const GEMINI_REFERENCE_KEYS: &[&str] = &[
    "filedata",
    "fileuri",
    "cachedcontent",
    "urlcontext",
    "filesearch",
    "googlesearch",
    "googlesearchretrieval",
    "googlemaps",
    "enterprisewebsearch",
    "retrieval",
];

/// Whether a request body names input it does not hold (#2343): input the
/// provider bills on top of the body, up to the model's context window.
/// Anthropic: a `type` of `url` or `file` (a document or image source), a
/// `file_id`, or a web fetch/search tool. Gemini: one of
/// [`GEMINI_REFERENCE_KEYS`]. Keys are matched anywhere in the body, every
/// occurrence and spelling seen (as [`may_ground`]); a body that does not
/// parse counts as one that does.
pub fn names_input_by_reference(provider: Provider, body: &[u8]) -> bool {
    use serde::de::DeserializeSeed;
    let mut found = false;
    let mut de = serde_json::Deserializer::from_slice(body);
    let parsed = RefScan { provider, found: &mut found, type_value: false }
        .deserialize(&mut de)
        .and_then(|()| de.end())
        .is_ok();
    found || !parsed
}

/// Walks a JSON value for [`names_input_by_reference`]; `type_value` marks
/// the value of a `type` key.
struct RefScan<'a> {
    provider: Provider,
    found: &'a mut bool,
    type_value: bool,
}

impl<'de> serde::de::DeserializeSeed<'de> for RefScan<'_> {
    type Value = ();
    fn deserialize<D: serde::Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_any(self)
    }
}

impl<'de> serde::de::Visitor<'de> for RefScan<'_> {
    type Value = ();
    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("a JSON value")
    }
    fn visit_bool<E>(self, _: bool) -> Result<(), E> {
        Ok(())
    }
    fn visit_i64<E>(self, _: i64) -> Result<(), E> {
        Ok(())
    }
    fn visit_u64<E>(self, _: u64) -> Result<(), E> {
        Ok(())
    }
    fn visit_f64<E>(self, _: f64) -> Result<(), E> {
        Ok(())
    }
    fn visit_str<E>(self, value: &str) -> Result<(), E> {
        if self.type_value && self.provider == Provider::Anthropic && anthropic_reference_type(value) {
            *self.found = true;
        }
        if self.type_value && self.provider == Provider::OpenAi
            && (value.starts_with("web_search") || matches!(value, "file_search" | "mcp" | "code_interpreter" | "image_generation" | "item_reference"))
        {
            *self.found = true;
        }
        Ok(())
    }
    fn visit_unit<E>(self) -> Result<(), E> {
        Ok(())
    }
    fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
        let (provider, found) = (self.provider, self.found);
        while seq.next_element_seed(RefScan { provider, found: &mut *found, type_value: false })?.is_some() {}
        Ok(())
    }
    fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        let (provider, found) = (self.provider, self.found);
        while let Some(key) = map.next_key::<String>()? {
            let key: String = key.chars().filter(|c| *c != '_').map(|c| c.to_ascii_lowercase()).collect();
            let hit = match provider {
                Provider::OpenAi => matches!(key.as_str(), "previousresponseid" | "fileid" | "fileurl" | "imageurl" | "encryptedcontent" | "conversation"),
                Provider::Anthropic => key == "fileid",
                Provider::Gemini => GEMINI_REFERENCE_KEYS.contains(&key.as_str()),
            };
            if hit {
                *found = true;
            }
            map.next_value_seed(RefScan { provider, found: &mut *found, type_value: key == "type" })?;
        }
        Ok(())
    }
}

/// Walks a JSON value, setting the flag at a grounding tool key.
struct KeyScan<'a>(&'a mut bool);

impl<'de> serde::de::DeserializeSeed<'de> for KeyScan<'_> {
    type Value = ();
    fn deserialize<D: serde::Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_any(self)
    }
}

impl<'de> serde::de::Visitor<'de> for KeyScan<'_> {
    type Value = ();
    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("a JSON value")
    }
    fn visit_bool<E>(self, _: bool) -> Result<(), E> {
        Ok(())
    }
    fn visit_i64<E>(self, _: i64) -> Result<(), E> {
        Ok(())
    }
    fn visit_u64<E>(self, _: u64) -> Result<(), E> {
        Ok(())
    }
    fn visit_f64<E>(self, _: f64) -> Result<(), E> {
        Ok(())
    }
    fn visit_str<E>(self, _: &str) -> Result<(), E> {
        Ok(())
    }
    fn visit_unit<E>(self) -> Result<(), E> {
        Ok(())
    }
    fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
        let found = self.0;
        while seq.next_element_seed(KeyScan(&mut *found))?.is_some() {}
        Ok(())
    }
    fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        let found = self.0;
        while let Some(key) = map.next_key::<String>()? {
            let key: String = key.chars().filter(|c| *c != '_').map(|c| c.to_ascii_lowercase()).collect();
            if GROUNDING_TOOLS.contains(&key.as_str()) {
                *found = true;
            }
            map.next_value_seed(KeyScan(&mut *found))?;
        }
        Ok(())
    }
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

/// The fields of an OpenAI request body the meter reads. A body that does
/// not parse as one object, or repeats or mistypes one of these, is refused
/// ([`openai_refusal`]).
#[derive(serde::Deserialize)]
struct OpenAiRequest {
    model: Option<String>,
    max_output_tokens: Option<u64>,
    max_tool_calls: Option<u64>,
    background: Option<serde_json::Value>,
    service_tier: Option<serde_json::Value>,
}

/// Why a metered OpenAI request is not forwarded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenAiRefusal {
    /// The body is not one JSON object with well-formed meter fields.
    Unparsable,
    /// `background: true`: the answer returns before any usage exists and is
    /// billed in full later, past the monthly limit.
    Background,
    /// A `service_tier` other than `auto`, `default` or `flex`: Fast
    /// (`priority`) and Ultrafast bill at a multiple of standard, which
    /// differs by model and is not in the price table.
    ServiceTier,
}

/// Whether a metered OpenAI request must be refused before it is sent.
pub fn openai_refusal(body: &[u8]) -> Option<OpenAiRefusal> {
    let Ok(r) = serde_json::from_slice::<OpenAiRequest>(body) else {
        return Some(OpenAiRefusal::Unparsable);
    };
    if !matches!(r.background, None | Some(serde_json::Value::Bool(false))) {
        return Some(OpenAiRefusal::Background);
    }
    match r.service_tier {
        None => None,
        Some(serde_json::Value::String(tier)) if matches!(tier.to_ascii_lowercase().as_str(), "auto" | "default" | "flex") => None,
        Some(_) => Some(OpenAiRefusal::ServiceTier),
    }
}

/// The hosted tools a request body lists: a `type` of `web_search*`,
/// `file_search`, `code_interpreter` or `image_generation` anywhere in it
/// (every occurrence seen, as [`names_input_by_reference`]; more than the
/// tools array can only overcount).
#[derive(Debug, Clone, Copy, Default)]
struct ToolFlags {
    web_search: bool,
    file_search: bool,
    code_interpreter: bool,
    image_generation: bool,
}

struct ToolScan<'a> {
    flags: &'a mut ToolFlags,
    type_value: bool,
}

impl<'de> serde::de::DeserializeSeed<'de> for ToolScan<'_> {
    type Value = ();
    fn deserialize<D: serde::Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_any(self)
    }
}

impl<'de> serde::de::Visitor<'de> for ToolScan<'_> {
    type Value = ();
    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("a JSON value")
    }
    fn visit_bool<E>(self, _: bool) -> Result<(), E> {
        Ok(())
    }
    fn visit_i64<E>(self, _: i64) -> Result<(), E> {
        Ok(())
    }
    fn visit_u64<E>(self, _: u64) -> Result<(), E> {
        Ok(())
    }
    fn visit_f64<E>(self, _: f64) -> Result<(), E> {
        Ok(())
    }
    fn visit_str<E>(self, value: &str) -> Result<(), E> {
        if self.type_value {
            let value = value.to_ascii_lowercase();
            if value.starts_with("web_search") {
                self.flags.web_search = true;
            }
            match value.as_str() {
                "file_search" => self.flags.file_search = true,
                "code_interpreter" => self.flags.code_interpreter = true,
                "image_generation" => self.flags.image_generation = true,
                _ => {}
            }
        }
        Ok(())
    }
    fn visit_unit<E>(self) -> Result<(), E> {
        Ok(())
    }
    fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
        let flags = self.flags;
        while seq.next_element_seed(ToolScan { flags: &mut *flags, type_value: false })?.is_some() {}
        Ok(())
    }
    fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        let flags = self.flags;
        while let Some(key) = map.next_key::<String>()? {
            map.next_value_seed(ToolScan { flags: &mut *flags, type_value: key == "type" })?;
        }
        Ok(())
    }
}

/// The most hosted-tool calls an OpenAI request body may make: what its
/// tools list, up to its `max_tool_calls` or the assumed counts.
fn openai_tool_calls(body: &[u8], max_tool_calls: Option<u64>) -> ToolCalls {
    use serde::de::DeserializeSeed;
    let mut flags = ToolFlags::default();
    let mut de = serde_json::Deserializer::from_slice(body);
    let parsed = ToolScan { flags: &mut flags, type_value: false }.deserialize(&mut de).and_then(|()| de.end()).is_ok();
    if !parsed {
        flags = ToolFlags { web_search: true, file_search: true, code_interpreter: true, image_generation: true };
    }
    let calls = |on: bool, assumed: u64| match (on, max_tool_calls) {
        (false, _) => 0,
        (true, Some(max)) => max.min(MAX_TOOL_CALLS),
        (true, None) => assumed,
    };
    ToolCalls {
        web_search: calls(flags.web_search, WEB_SEARCH_CALLS_ESTIMATE),
        file_search: calls(flags.file_search, FILE_SEARCH_CALLS_ESTIMATE),
        containers: calls(flags.code_interpreter, CONTAINERS_ESTIMATE).min(CONTAINERS_ESTIMATE),
        images: calls(flags.image_generation, IMAGE_CALLS_ESTIMATE),
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
    openai: OpenAiUsage,
    saw_usage: bool,
    /// Anthropic: a usage object at the answer's root arrived (the final
    /// count of a `message_delta` or a whole message).
    final_usage: bool,
    /// A usage object could not be read: the reported count is incomplete.
    lost: bool,
    /// Gemini search queries by (candidate, keyed query hash): the most
    /// times one response listed it.
    queries: HashMap<(u32, u64), u64>,
    /// Queries past [`MAX_DISTINCT_QUERIES`], each counted.
    extra_queries: u64,
    /// Grounding metadata arrived (with or without queries).
    grounded: bool,
    /// OpenAI hosted-tool items by (kind, keyed id): one per distinct item
    /// however often the stream repeats it.
    tool_items: HashSet<(ToolKind, u64)>,
    /// Items with no id, or past [`MAX_DISTINCT_TOOLS`], each counted.
    tool_extra: HashMap<ToolKind, u64>,
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
            openai: OpenAiUsage::default(),
            saw_usage: false,
            final_usage: false,
            lost: false,
            queries: HashMap::new(),
            extra_queries: 0,
            grounded: false,
            tool_items: HashSet::new(),
            tool_extra: HashMap::new(),
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

    /// The request body, read for what bounds an estimate: its size,
    /// (Anthropic) `max_tokens`, `model`, `speed`, `inference_geo`, and
    /// (Gemini answers) whether it may ground.
    pub fn request(&mut self, body: &[u8]) {
        self.request = RequestFacts { body_bytes: body.len(), ..RequestFacts::default() };
        if self.provider == Provider::OpenAi {
            if let Ok(r) = serde_json::from_slice::<OpenAiRequest>(body) {
                self.request.model = r.model.filter(|m| !m.is_empty() && m.len() <= MAX_STRING);
                self.request.max_output = r.max_output_tokens;
                self.request.tools = openai_tool_calls(body, r.max_tool_calls);
            } else {
                self.request.tools = openai_tool_calls(body, None);
            }
        }
        if self.provider == Provider::Gemini && matches!(self.billing, Billing::Usage { .. }) {
            self.request.may_ground = may_ground(body);
        }
        if matches!(self.billing, Billing::Usage { .. }) {
            self.request.by_reference = names_input_by_reference(self.provider, body);
        }
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
                        if self.provider != Provider::OpenAi {
                            self.final_usage |= root;
                        }
                    }
                    Err(_) => self.lost = true,
                },
                Found::Lost => self.lost = true,
                Found::Tool { kind, id, container } => {
                    let key = if kind == ToolKind::CodeInterpreter { container.or(id) } else { id };
                    match key {
                        Some(key) if self.tool_items.len() < MAX_DISTINCT_TOOLS => {
                            self.tool_items.insert((kind, key));
                        }
                        _ => *self.tool_extra.entry(kind).or_default() += 1,
                    }
                }
                Found::Grounding { candidate, queries, extra, had_key } => {
                    self.grounded |= had_key || !queries.is_empty() || extra > 0;
                    let mut listed: HashMap<u64, u64> = HashMap::new();
                    for q in queries {
                        *listed.entry(q).or_default() += 1;
                    }
                    for (q, n) in listed {
                        let room = self.queries.len() < MAX_DISTINCT_QUERIES;
                        match self.queries.get_mut(&(candidate, q)) {
                            Some(seen) => *seen = (*seen).max(n),
                            None if room => {
                                self.queries.insert((candidate, q), n);
                            }
                            None => self.extra_queries = self.extra_queries.saturating_add(n),
                        }
                    }
                    self.extra_queries = self.extra_queries.saturating_add(extra);
                }
            }
        }
    }

    /// Hosted-tool calls the answer's output items listed.
    fn tool_calls(&self) -> ToolCalls {
        let count = |kind: ToolKind| {
            let distinct = self.tool_items.iter().filter(|(k, _)| *k == kind).count() as u64;
            distinct.saturating_add(self.tool_extra.get(&kind).copied().unwrap_or(0))
        };
        ToolCalls {
            web_search: count(ToolKind::WebSearch),
            file_search: count(ToolKind::FileSearch),
            containers: count(ToolKind::CodeInterpreter),
            images: count(ToolKind::ImageGeneration),
        }
    }

    /// Search queries the answer's grounding metadata listed.
    fn search_queries(&self) -> u64 {
        self.queries.values().fold(self.extra_queries, |a, n| a.saturating_add(*n))
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
            Provider::OpenAi => {
                let u = &mut self.openai;
                max(&mut u.input, n(v, "input_tokens"));
                max(&mut u.output, n(v, "output_tokens"));
                if let Some(details) = v.get("input_tokens_details") {
                    max(&mut u.cached, n(details, "cached_tokens"));
                }
                // Null usage in response.created/in_progress is not captured;
                // a final Responses usage object reports both totals.
                self.final_usage = n(v, "input_tokens").is_some() && n(v, "output_tokens").is_some();
            }
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
        self.estimate(month, end, false)
    }

    /// The most the request can cost by the estimate in the module docs,
    /// priced in UTC month `month` — for before it is sent (after
    /// [`Meter::request`]): the whole output cap (Anthropic's `max_tokens`,
    /// else the provider's cap), input from the body's size as 1-hour cache
    /// writes (Anthropic) — the model's whole context window when the body
    /// names input by reference ([`names_input_by_reference`], #2343) —
    /// [`GROUNDING_QUERIES_ESTIMATE`] queries for a
    /// Gemini request that may ground.
    fn worst_charge(&self, month: &str) -> Option<Charge> {
        self.estimate(month, End { complete: false, elapsed: std::time::Duration::MAX }, true)
    }

    /// [`Self::worst_charge`] in billed tokens (`Charge::billed`, the monthly
    /// limit's unit, #2389): held against the limit while the request is in
    /// flight; the answer is then charged what it billed.
    pub fn worst_case_billed(&self, month: &str) -> u64 {
        self.worst_charge(month).map_or(0, |c| c.billed())
    }

    /// [`Self::worst_charge`] in USD, the estimate the tests pin the
    /// worst-case rules with.
    #[cfg(test)]
    pub fn worst_case(&self, month: &str) -> f64 {
        self.worst_charge(month).map_or(0.0, |c| c.usd)
    }

    fn estimate(&self, month: &str, end: End, worst: bool) -> Option<Charge> {
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
                Provider::OpenAi => self.final_usage,
                Provider::Anthropic => self.final_usage,
                Provider::Gemini => self.saw_usage && end.complete,
            };
        let (max_input, max_output, per_sec) = match self.provider {
            Provider::OpenAi => (1_050_000, self.request.max_output.unwrap_or(128_000), 1_000),
            Provider::Anthropic => {
                (ANTHROPIC_MAX_INPUT, self.request.max_output.unwrap_or(ANTHROPIC_MAX_OUTPUT), ANTHROPIC_TOKENS_PER_SEC)
            }
            Provider::Gemini => (GEMINI_MAX_INPUT, GEMINI_MAX_OUTPUT, GEMINI_TOKENS_PER_SEC),
        };
        let mut input_estimate = (self.request.body_bytes as u64).div_ceil(3).min(max_input);
        if worst && self.request.by_reference {
            // Input the body only names (a URL, file or cache, a fetch or
            // search tool's results) can fill the model's whole window.
            input_estimate = input_estimate.max(super::api_prices::context_window(self.provider, model));
        }
        let output_estimate = match self.billing {
            Billing::Embedding { .. } => 0,
            Billing::Usage { .. } => ((end.elapsed.as_secs_f64() * per_sec as f64).ceil() as u64).min(max_output),
        };
        let charge = match self.provider {
            Provider::OpenAi => {
                let mut u = self.openai.clone();
                let mut tools = self.tool_calls();
                if !settled {
                    if u.input == 0 { u.input = input_estimate; }
                    u.output = u.output.max(output_estimate);
                    // Calls the answer did not deliver (cut off, or not yet
                    // sent): what the body's tools may make.
                    let may = self.request.tools;
                    tools = ToolCalls {
                        web_search: tools.web_search.max(may.web_search),
                        file_search: tools.file_search.max(may.file_search),
                        containers: tools.containers.max(may.containers),
                        images: tools.images.max(may.images),
                    };
                }
                u.web_search_calls = tools.web_search;
                u.file_search_calls = tools.file_search;
                u.containers = tools.containers;
                u.image_generation_calls = tools.images;
                super::api_prices::price_openai(model, &u)
            }
            Provider::Anthropic => {
                let mut u = self.anthropic.clone();
                if !settled {
                    if u.input_tokens == 0 && u.cache_creation_input_tokens == 0 && u.cache_read_input_tokens == 0 {
                        if worst {
                            // Without a TTL breakdown: the 1-hour write rate.
                            u.cache_creation_input_tokens = input_estimate;
                        } else {
                            u.input_tokens = input_estimate;
                        }
                    }
                    u.output_tokens = u.output_tokens.max(output_estimate);
                    u.fast |= self.request.fast;
                    u.us_only |= self.request.us_only;
                }
                super::api_prices::price_anthropic(model, &u)
            }
            Provider::Gemini => {
                let mut u = self.gemini.clone();
                u.search_queries = self.search_queries();
                u.grounded = self.grounded;
                if !settled {
                    if self.request.may_ground {
                        u.search_queries = u.search_queries.max(GROUNDING_QUERIES_ESTIMATE);
                        u.grounded = true;
                    }
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

    #[test]
    fn openai_responses_usage_survives_every_stream_split_without_double_counting() {
        let usage = r#"{"input_tokens":1000,"input_tokens_details":{"cached_tokens":800},"output_tokens":300,"output_tokens_details":{"reasoning_tokens":200}}"#;
        let response = format!(r#"{{"model":"gpt-6.1-sol","output":[{{"usage":{{"input_tokens":999999}},"model":"fake"}}],"usage":{usage}}}"#);
        let expected = super::super::api_prices::price_openai("gpt-6.1-sol", &OpenAiUsage { input: 1000, cached: 800, output: 300, ..OpenAiUsage::default() });
        every_split(Provider::OpenAi, Billing::Usage { model: None }, "application/json", response.as_bytes(), &expected);
        let sse = format!("event: response.created\ndata: {{\"response\":{{\"usage\":null}}}}\n\nevent: response.completed\ndata: {{\"response\":{response}}}\n\n");
        every_split(Provider::OpenAi, Billing::Usage { model: None }, "text/event-stream", sse.as_bytes(), &expected);
    }

    #[test]
    fn openai_compaction_and_interrupted_responses_are_budgeted() {
        assert!(billing(Provider::OpenAi, "POST", "/v1/responses/compact").is_some());
        assert!(billing(Provider::OpenAi, "GET", "/v1/models").is_none());
        let mut meter = Meter::new(Provider::OpenAi, Billing::Usage { model: None });
        meter.request(br#"{"model":"gpt-6.1-sol","max_output_tokens":2000,"previous_response_id":"resp_example"}"#);
        assert!(meter.worst_case_billed(MONTH) >= 1_050_000 + 2000);
        meter.answer(200, Some("text/event-stream"));
        meter.feed(b"data: {\"response\":{\"usage\":null}}\n\n");
        let charge = meter.charge(MONTH, cut(1)).unwrap();
        assert_eq!(charge.output, 1000);
        assert!(charge.input > 0);
        meter.answer(401, Some("application/json"));
        assert!(meter.charge(MONTH, cut(1)).is_none());
        // Local function definitions cannot fetch extra input from OpenAI;
        // charging a whole context window for these would block small limits.
        assert!(!names_input_by_reference(Provider::OpenAi, br#"{"tools":[{"type":"function","name":"shell"}]}"#));
        assert!(names_input_by_reference(Provider::OpenAi, br#"{"tools":[{"type":"web_search"}]}"#));
    }
    fn openai_item(id: &str, kind: &str, extra: &str) -> String {
        format!(r#"{{"id":"{id}","type":"{kind}","status":"completed"{extra}}}"#)
    }

    /// Hosted-tool items: a web search, a file search, two code interpreter
    /// calls in one container, an image — and look-alikes that are not items
    /// (nested in a message, escaped in its text).
    fn openai_tool_items() -> Vec<String> {
        vec![
            openai_item("ws_1", "web_search_call", r#","action":{"type":"search","query":"x"}"#),
            openai_item("fs_1", "file_search_call", r#","queries":["a"]"#),
            openai_item("ci_1", "code_interpreter_call", r#","container_id":"cntr_1","code":"1""#),
            openai_item("ci_2", "code_interpreter_call", r#","container_id":"cntr_1","code":"2""#),
            openai_item("ig_1", "image_generation_call", r#","result":"AAAA""#),
            openai_item(
                "msg_1",
                "message",
                r#","content":[{"type":"web_search_call","id":"fake"},{"type":"output_text","text":"{\"type\":\"image_generation_call\",\"id\":\"fake2\"}"}]"#,
            ),
        ]
    }

    fn openai_tool_expected() -> Charge {
        super::super::api_prices::price_openai(
            "gpt-6.1-sol",
            &OpenAiUsage {
                input: 1000,
                cached: 800,
                output: 300,
                web_search_calls: 1,
                file_search_calls: 1,
                containers: 1,
                image_generation_calls: 1,
            },
        )
    }

    const OPENAI_USAGE: &str = r#""usage":{"input_tokens":1000,"input_tokens_details":{"cached_tokens":800},"output_tokens":300}"#;

    #[test]
    fn openai_tool_calls_are_charged_once_however_the_stream_repeats_and_splits_them() {
        let items = openai_tool_items();
        let expected = openai_tool_expected();
        assert!(expected.tool_tokens > 0 && expected.usd > 2.5);
        // SSE: each item added, done, then again inside `response.completed`.
        let mut sse = String::new();
        for (i, item) in items.iter().enumerate() {
            sse.push_str(&format!("event: response.output_item.added\ndata: {{\"type\":\"response.output_item.added\",\"output_index\":{i},\"item\":{item}}}\n\n"));
            sse.push_str(&format!("event: response.output_item.done\ndata: {{\"type\":\"response.output_item.done\",\"output_index\":{i},\"item\":{item}}}\n\n"));
        }
        sse.push_str(&format!(
            "event: response.completed\ndata: {{\"type\":\"response.completed\",\"response\":{{\"model\":\"gpt-6.1-sol\",\"output\":[{}],{OPENAI_USAGE}}}}}\n\n",
            items.join(",")
        ));
        every_split(Provider::OpenAi, Billing::Usage { model: None }, "text/event-stream", sse.as_bytes(), &expected);
        // Plain JSON.
        let json = format!(r#"{{"model":"gpt-6.1-sol","output":[{}],{OPENAI_USAGE}}}"#, items.join(","));
        every_split(Provider::OpenAi, Billing::Usage { model: None }, "application/json", json.as_bytes(), &expected);
        // The type after the id, and a line break cutting an item off.
        let late = r#"{"model":"gpt-6.1-sol","output":[{"status":"completed","id":"ws_9","type":"web_search_call"}],"usage":{"input_tokens":1,"output_tokens":1}}"#;
        let m = metered(Provider::OpenAi, Billing::Usage { model: None }, "application/json", &[late.as_bytes()]);
        assert_eq!(m.charge(MONTH, DONE).unwrap().web_searches, 1);
        let mut cut_item = Meter::new(Provider::OpenAi, Billing::Usage { model: None });
        cut_item.answer(200, Some("text/event-stream"));
        cut_item.feed(b"data: {\"item\":{\"id\":\"ws_1\",\"ty\n");
        assert!(cut_item.lost, "an item cut by a line break leaves the count unknown");
    }

    #[test]
    fn openai_tool_items_without_an_id_are_each_counted() {
        let body = r#"{"output":[{"type":"web_search_call"},{"type":"web_search_call"}],"usage":{"input_tokens":1,"output_tokens":1}}"#;
        let m = metered(Provider::OpenAi, Billing::Usage { model: None }, "application/json", &[body.as_bytes()]);
        assert_eq!(m.charge(MONTH, DONE).unwrap().web_searches, 2);
    }

    #[test]
    fn openai_tool_calls_the_body_allows_are_held_before_it_is_sent() {
        let worst = |body: &str| {
            let mut m = Meter::new(Provider::OpenAi, Billing::Usage { model: None });
            m.request(body.as_bytes());
            m.worst_case_billed(MONTH)
        };
        // Code interpreter and image generation also name input by reference
        // (a whole context window held): the same tools with no calls allowed
        // are the base, so only the fees differ. gpt-6.1-sol output is $10
        // per million: a dollar of fees is 100,000 tokens.
        let with = |tools: &str, max: Option<u64>| {
            let max = max.map_or(String::new(), |m| format!(r#""max_tool_calls":{m},"#));
            worst(&format!(r#"{{"model":"gpt-6.1-sol","max_output_tokens":1000,{max}"tools":{tools}}}"#))
        };
        let fees = |tools: &str, max: Option<u64>| with(tools, max) - with(tools, Some(0));
        let code = r#"[{"type":"code_interpreter","container":{"type":"auto"}}]"#;
        let image = r#"[{"type":"image_generation"}]"#;
        assert_eq!(fees(code, None), 192_000);
        assert_eq!(fees(image, None), 4 * 60_000);
        assert_eq!((fees(image, Some(1)), fees(image, Some(7))), (60_000, 420_000));
        // Never more than one container, however many calls are allowed.
        assert_eq!(fees(code, Some(50)), 192_000);
        // The tool's `type` is read wherever it sits, whichever of two it is.
        assert_eq!(fees(r#"[{"name":"f","type":"function","type":"image_generation"}]"#, None), 4 * 60_000);
        // A function tool holds nothing.
        let function = r#"[{"type":"function","name":"f"}]"#;
        assert!(with(function, Some(0)).abs_diff(with(function, None)) < 100, "only the body's few extra bytes differ");
        // A body that is no JSON may hold any of them.
        assert!(worst("not json") >= with(function, None) + 192_000 + 240_000);
        assert_eq!(
            openai_tool_calls(br#"{"tools":[{"type":"web_search_preview"},{"type":"file_search"}]}"#, None),
            ToolCalls { web_search: 10, file_search: 10, containers: 0, images: 0 }
        );
        assert_eq!(openai_tool_calls(br#"{"tools":[{"type":"function"}]}"#, None), ToolCalls::default());
    }

    #[test]
    fn an_openai_answer_cut_off_is_charged_the_tool_calls_its_request_may_have_made() {
        let mut m = Meter::new(Provider::OpenAi, Billing::Usage { model: None });
        m.request(br#"{"model":"gpt-6.1-sol","tools":[{"type":"web_search"}]}"#);
        m.answer(200, Some("text/event-stream"));
        m.feed(b"data: {\"response\":{\"usage\":null}}\n\n");
        assert_eq!(m.charge(MONTH, cut(1)).unwrap().web_searches, WEB_SEARCH_CALLS_ESTIMATE);
        // A settled answer is charged the calls it made, not the ceiling.
        let done = metered(Provider::OpenAi, Billing::Usage { model: None }, "application/json", &[
            br#"{"model":"gpt-6.1-sol","output":[{"id":"ws_1","type":"web_search_call"}],"usage":{"input_tokens":1,"output_tokens":1}}"#,
        ]);
        let mut done = done;
        done.request(br#"{"model":"gpt-6.1-sol","tools":[{"type":"web_search"}]}"#);
        assert_eq!(done.charge(MONTH, DONE).unwrap().web_searches, 1);
    }

    #[test]
    fn openai_requests_the_meter_cannot_see_are_refused() {
        let refusal = |body: &str| openai_refusal(body.as_bytes());
        assert_eq!(refusal(r#"{"model":"gpt-6.1-sol","stream":true}"#), None);
        assert_eq!(refusal("{}"), None);
        assert_eq!(refusal(r#"{"background":false,"service_tier":null,"max_output_tokens":null}"#), None);
        for tier in ["auto", "default", "flex", "FLEX"] {
            assert_eq!(refusal(&format!(r#"{{"service_tier":"{tier}"}}"#)), None, "{tier}");
        }
        for background in ["true", r#""true""#, "1", "{}"] {
            assert_eq!(refusal(&format!(r#"{{"model":"m","background":{background}}}"#)), Some(OpenAiRefusal::Background), "{background}");
        }
        for tier in [r#""priority""#, r#""Priority""#, r#""fast""#, r#""ultrafast""#, r#""scale""#, r#""""#, "1", "true"] {
            assert_eq!(refusal(&format!(r#"{{"service_tier":{tier}}}"#)), Some(OpenAiRefusal::ServiceTier), "{tier}");
        }
        // A body the meter cannot read: not JSON, not an object, trailing bytes,
        // a field repeated (the provider may read the first or the last), a
        // field of the wrong type.
        for body in [
            "",
            "not json",
            "[]",
            "null",
            r#"{"model":"m"} x"#,
            r#"{"background":true,"background":false}"#,
            r#"{"background":false,"background":true}"#,
            r#"{"service_tier":"auto","service_tier":"priority"}"#,
            r#"{"model":"a","model":"b"}"#,
            r#"{"model":3}"#,
            r#"{"max_output_tokens":-1}"#,
            r#"{"max_tool_calls":"many"}"#,
            r#"{"backgr\u006fund":true,"background":false}"#,
        ] {
            assert_eq!(refusal(body), Some(OpenAiRefusal::Unparsable), "{body}");
        }
        assert_eq!(refusal(r#"{"backgr\u006fund":true}"#), Some(OpenAiRefusal::Background));
    }

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

    // ---- Gemini Search grounding (gap 8) ----------------------------------

    fn grounded(model: &str, queries: u64) -> Charge {
        let usage = GeminiUsage {
            prompt_token_count: 1000,
            candidates_token_count: 100,
            search_queries: queries,
            grounded: true,
            ..Default::default()
        };
        super::super::api_prices::price_gemini(model, &usage, MONTH)
    }

    /// A `generateContent` answer whose model ran two searches, with decoy
    /// grounding keys in a function call's arguments and in the text.
    const GEMINI_GROUNDED: &str = concat!(
        "{\"candidates\": [{\"content\": {\"parts\": [",
        "{\"functionCall\": {\"name\": \"f\", \"args\": {\"groundingMetadata\": {\"webSearchQueries\": [\"x\", \"y\", \"z\"]}}}},",
        "{\"text\": \"\\\"groundingMetadata\\\": {\\\"webSearchQueries\\\": [\\\"t\\\"]}\"}],\"role\": \"model\"},",
        "\"groundingMetadata\": {\"webSearchQueries\": [\"weather bonn\", \"weather \\\"cologne\\\"\"],",
        "\"searchEntryPoint\": {\"renderedContent\": \"<div>[\\\"q\\\"]</div>\"},",
        "\"groundingChunks\": [{\"web\": {\"uri\": \"https://example.com/\", \"title\": \"t\"}}]}}],",
        "\"usageMetadata\": {\"promptTokenCount\": 1000, \"candidatesTokenCount\": 100},",
        "\"modelVersion\": \"gemini-3.5-flash\"}"
    );

    #[test]
    fn gemini_grounding_queries_in_a_plain_answer_are_charged() {
        let expect = grounded("gemini-3.5-flash", 2);
        assert_eq!(expect.web_searches, 2);
        assert!((expect.usd - (1000.0 * 1.50 + 100.0 * 9.0) / 1e6 - 2.0 * 0.014).abs() < 1e-12, "{}", expect.usd);
        every_split(Provider::Gemini, Billing::Usage { model: None }, "application/json", GEMINI_GROUNDED.as_bytes(), &expect);
        // A grounding object at the response's root is not a candidate's.
        let body = br#"{"groundingMetadata":{"webSearchQueries":["a"]},"usageMetadata":{"promptTokenCount":1000,"candidatesTokenCount":100},"modelVersion":"gemini-3.5-flash"}"#;
        let m = metered(Provider::Gemini, Billing::Usage { model: None }, "application/json", &[body]);
        assert_eq!(m.charge(MONTH, DONE).unwrap().web_searches, 0);
    }

    #[test]
    fn gemini_grounding_queries_in_a_stream_are_counted_once_each() {
        // Chunk 2 lists two queries; chunk 3 repeats them and adds a third;
        // a second candidate ran one of the same queries.
        let body = concat!(
            "data: {\"candidates\": [{\"content\": {\"parts\": [{\"text\": \"It\"}],\"role\": \"model\"},\"index\": 0}],",
            "\"usageMetadata\": {\"promptTokenCount\": 1000},\"modelVersion\": \"gemini-3.5-flash\"}\r\n\r\n",
            "data: {\"candidates\": [{\"content\": {\"parts\": [{\"text\": \" rains\"}],\"role\": \"model\"},\"index\": 0,",
            "\"groundingMetadata\": {\"webSearchQueries\": [\"rain bonn\", \"rain cologne\"]}}],",
            "\"usageMetadata\": {\"promptTokenCount\": 1000, \"candidatesTokenCount\": 50},\"modelVersion\": \"gemini-3.5-flash\"}\r\n\r\n",
            "data: {\"candidates\": [{\"content\": {\"parts\": [{\"text\": \".\"}],\"role\": \"model\"},\"index\": 0,",
            "\"groundingMetadata\": {\"webSearchQueries\": [\"rain bonn\", \"rain cologne\", \"rain aachen\"]}},",
            "{\"index\": 1, \"groundingMetadata\": {\"webSearchQueries\": [\"rain bonn\"]}}],",
            "\"usageMetadata\": {\"promptTokenCount\": 1000, \"candidatesTokenCount\": 100},\"modelVersion\": \"gemini-3.5-flash\"}\r\n\r\n",
        );
        let expect = grounded("gemini-3.5-flash", 4);
        every_split(Provider::Gemini, Billing::Usage { model: None }, "text/event-stream", body.as_bytes(), &expect);
        // One response naming a query twice ran it twice.
        let body = br#"{"candidates":[{"groundingMetadata":{"webSearchQueries":["a","a","b"]}}],"usageMetadata":{"promptTokenCount":1000,"candidatesTokenCount":100},"modelVersion":"gemini-3.5-flash"}"#;
        let m = metered(Provider::Gemini, Billing::Usage { model: None }, "application/json", &[body]);
        assert_eq!(m.charge(MONTH, DONE), Some(grounded("gemini-3.5-flash", 3)));
        // Grounding metadata without queries (Maps) is one grounded prompt.
        let body = br#"{"candidates":[{"groundingMetadata":{"groundingChunks":[{"maps":{"title":"x"}}]}}],"usageMetadata":{"promptTokenCount":1000,"candidatesTokenCount":100},"modelVersion":"gemini-2.5-flash"}"#;
        let m = metered(Provider::Gemini, Billing::Usage { model: None }, "application/json", &[body]);
        let c = m.charge(MONTH, DONE).unwrap();
        assert_eq!(c, grounded("gemini-2.5-flash", 0));
        assert_eq!(c.web_searches, 1);
        // Past the distinct-query bound every further query still counts.
        let many: Vec<String> = (0..MAX_DISTINCT_QUERIES + 10).map(|i| format!("\"q{i}\"")).collect();
        let body = format!(
            r#"{{"candidates":[{{"groundingMetadata":{{"webSearchQueries":[{}]}}}}],"modelVersion":"gemini-3.5-flash"}}"#,
            many.join(",")
        );
        let m = metered(Provider::Gemini, Billing::Usage { model: None }, "application/json", &[body.as_bytes()]);
        assert_eq!(m.charge(MONTH, DONE).unwrap().web_searches, (MAX_DISTINCT_QUERIES + 10) as u64);
    }

    fn gemini_meter(body: &str) -> Meter {
        let mut m = Meter::new(Provider::Gemini, Billing::Usage { model: Some("gemini-3.5-flash".into()) });
        m.request(body.as_bytes());
        m.answer(200, Some("text/event-stream"));
        m
    }

    #[test]
    fn a_cut_off_answer_that_may_have_grounded_is_charged_the_estimate() {
        let first = concat!(
            "data: {\"candidates\": [{\"content\": {\"parts\": [{\"text\": \"It\"}]},",
            "\"groundingMetadata\": {\"webSearchQueries\": [\"a\"]}}],",
            "\"usageMetadata\": {\"promptTokenCount\": 1000},\"modelVersion\": \"gemini-3.5-flash\"}\n\n",
        );
        let mut m = gemini_meter(r#"{"contents":[],"tools":[{"google_search":{}}]}"#);
        m.feed(first.as_bytes());
        assert_eq!(m.charge(MONTH, cut(1)).unwrap().web_searches, GROUNDING_QUERIES_ESTIMATE);
        // The same answer complete costs the queries it listed.
        let mut m = gemini_meter(r#"{"contents":[],"tools":[{"google_search":{}}]}"#);
        m.feed(first.as_bytes());
        assert_eq!(m.charge(MONTH, DONE).unwrap().web_searches, 1);
        // A request without a grounding tool gets no grounding estimate.
        let mut m = gemini_meter(r#"{"contents":[{"parts":[{"text":"googleSearch"}]}]}"#);
        m.feed(&first.as_bytes()[..40]);
        assert_eq!(m.charge(MONTH, cut(1)).unwrap().web_searches, 0);
        // Grounding metadata cut by a line break leaves the answer unsettled.
        let mut m = gemini_meter(r#"{"tools":[{"googleSearch":{}}]}"#);
        m.feed(b"data: {\"candidates\": [{\"groundingMetadata\": {\"webSearchQueries\": [\"a\"\n\n");
        m.feed(b"data: {\"usageMetadata\": {\"promptTokenCount\": 1000},\"modelVersion\": \"gemini-3.5-flash\"}\n\n");
        assert_eq!(m.charge(MONTH, DONE).unwrap().web_searches, GROUNDING_QUERIES_ESTIMATE);
    }

    #[test]
    fn grounding_tools_are_found_however_the_body_spells_them() {
        for body in [
            r#"{"tools":[{"googleSearch":{}}]}"#,
            r#"{"tools":[{"google_search_retrieval":{"dynamicRetrievalConfig":{}}}]}"#,
            r#"{"tools":[{"googleMaps":{}}]}"#,
            r#"{"tools":[{"googleSearch":{}}]}"#,
            r#"{"tools":[{"googleSearch":{}}],"tools":[]}"#,
            r#"{"tools":[],"tools":[{"GOOGLE_SEARCH":{}}]}"#,
            "not json",
            r#"{"tools":[]} trailing"#,
        ] {
            assert!(may_ground(body.as_bytes()), "{body}");
        }
        let deep = format!("{}{}", "[".repeat(200), "]".repeat(200));
        assert!(may_ground(deep.as_bytes()), "too deep to read is read as grounding");
        for body in [
            r#"{"contents":[{"parts":[{"text":"googleSearch"}]}]}"#,
            r#"{"tools":[{"functionDeclarations":[{"name":"google_search","parameters":{}}]}]}"#,
            r#"{"tools":[{"urlContext":{}},{"codeExecution":{}}],"generationConfig":{"maxOutputTokens":10}}"#,
        ] {
            assert!(!may_ground(body.as_bytes()), "{body}");
        }
    }

    // ---- the worst case held while in flight (gap 9) ----------------------

    #[test]
    fn the_worst_case_holds_the_output_cap_input_as_cache_writes_and_grounding() {
        let body = r#"{"model":"claude-opus-5-5","max_tokens":10000,"messages":[]}"#;
        let m = anthropic_meter(body);
        let input = (body.len() as u64).div_ceil(3);
        // Opus 5.5: 1-hour writes $8, output $20 per million.
        let expect = (input as f64 * 8.0 + 10_000.0 * 20.0) / 1e6;
        assert!((m.worst_case(MONTH) - expect).abs() < 1e-12, "{}", m.worst_case(MONTH));
        // No `max_tokens`, no model: the largest output at the top rate.
        let m = anthropic_meter("{}");
        assert!((m.worst_case(MONTH) - (1.0 * 20.0 + 128_000.0 * 50.0) / 1e6).abs() < 1e-12);
        // Fast mode doubles it.
        let m = anthropic_meter(r#"{"model":"claude-opus-5-5","max_tokens":10000,"speed":"fast"}"#);
        assert!(m.worst_case(MONTH) > 2.0 * 10_000.0 * 20.0 / 1e6);
        // Gemini: the provider's output cap, and the grounding estimate when
        // the request may ground.
        let plain = r#"{"contents":[]}"#;
        let mut m = Meter::new(Provider::Gemini, Billing::Usage { model: Some("gemini-3.5-flash".into()) });
        m.request(plain.as_bytes());
        let base = m.worst_case(MONTH);
        let input = (plain.len() as u64).div_ceil(3);
        assert!((base - (input as f64 * 1.50 + GEMINI_MAX_OUTPUT as f64 * 9.0) / 1e6).abs() < 1e-12, "{base}");
        let tools = r#"{"contents":[],"tools":[{"googleSearch":{}}]}"#;
        let mut m = Meter::new(Provider::Gemini, Billing::Usage { model: Some("gemini-3.5-flash".into()) });
        m.request(tools.as_bytes());
        // A grounding tool's results join the input too (#2343): the window.
        let expect = (1_048_576.0 * 1.50 + GEMINI_MAX_OUTPUT as f64 * 9.0) / 1e6 + GROUNDING_QUERIES_ESTIMATE as f64 * 0.014;
        assert!((m.worst_case(MONTH) - expect).abs() < 1e-9, "{}", m.worst_case(MONTH));
        // The answer itself is charged what it reports, not the worst case.
        let mut m = anthropic_meter(body);
        m.answer(200, Some("text/event-stream"));
        m.feed(ANTHROPIC_SSE.as_bytes());
        assert_eq!(m.charge(MONTH, DONE), Some(anthropic_expected()));
    }

    // ---- input named by reference (#2343) ---------------------------------

    #[test]
    fn input_by_reference_is_found_however_the_body_spells_it() {
        let anthropic = |body: &str| names_input_by_reference(Provider::Anthropic, body.as_bytes());
        let gemini = |body: &str| names_input_by_reference(Provider::Gemini, body.as_bytes());
        for body in [
            r#"{"messages":[{"role":"user","content":[{"type":"document","source":{"type":"url","url":"https://example.com/a.pdf"}}]}]}"#,
            r#"{"messages":[{"role":"user","content":[{"type":"image","source":{"type":"file","file_id":"file_1"}}]}]}"#,
            r#"{"messages":[{"role":"user","content":[{"type":"image","source":{"file_id":"file_1"}}]}]}"#,
            r#"{"tools":[{"type":"web_fetch_20260209","name":"web_fetch"}]}"#,
            r#"{"tools":[{"type":"web_search_20250305","name":"web_search"}]}"#,
            // A repeated key and an escaped spelling are seen too.
            r#"{"source":{"type":"url","type":"base64"}}"#,
            r#"{"source":{"type":"url"}}"#,
            "not json",
        ] {
            assert!(anthropic(body), "{body}");
        }
        for body in [
            r#"{"model":"claude-opus-5-5","max_tokens":10,"messages":[{"role":"user","content":"type url file_id"}]}"#,
            r#"{"messages":[{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AA=="}}]}]}"#,
            r#"{"tools":[{"name":"fetch","input_schema":{"type":"object","properties":{"url":{"type":"string"}}}}]}"#,
            r#"{"contents":[{"parts":[{"fileData":{"fileUri":"x"}}]}]}"#,
        ] {
            assert!(!anthropic(body), "{body}");
        }
        for body in [
            r#"{"contents":[{"parts":[{"fileData":{"mimeType":"application/pdf","fileUri":"https://generativelanguage.googleapis.com/v1beta/files/a"}}]}]}"#,
            r#"{"contents":[{"parts":[{"file_data":{"file_uri":"gs://b/a.pdf"}}]}]}"#,
            r#"{"cachedContent":"cachedContents/abc","contents":[]}"#,
            r#"{"tools":[{"urlContext":{}}]}"#,
            r#"{"tools":[{"url_context":{}}]}"#,
            r#"{"tools":[{"googleSearch":{}}]}"#,
            r#"{"tools":[{"google_search_retrieval":{}}]}"#,
            r#"{"tools":[{"fileSearch":{"fileSearchStoreNames":["s"]}}]}"#,
            "not json",
        ] {
            assert!(gemini(body), "{body}");
        }
        for body in [
            r#"{"contents":[{"parts":[{"text":"fileData cachedContent urlContext"}]}]}"#,
            r#"{"contents":[{"parts":[{"inlineData":{"mimeType":"image/png","data":"AA=="}}]}],"tools":[{"codeExecution":{}}]}"#,
            r#"{"tools":[{"functionDeclarations":[{"name":"url_context","parameters":{}}]}]}"#,
        ] {
            assert!(!gemini(body), "{body}");
        }
    }

    #[test]
    fn input_by_reference_holds_the_models_whole_window() {
        // Anthropic: the window as 1-hour cache writes, plus the output cap.
        let body = r#"{"model":"claude-opus-5-5","max_tokens":10000,"messages":[{"role":"user","content":[{"type":"document","source":{"type":"url","url":"https://example.com/a.pdf"}}]}]}"#;
        let m = anthropic_meter(body);
        let expect = (1_000_000.0 * 8.0 + 10_000.0 * 20.0) / 1e6;
        assert!((m.worst_case(MONTH) - expect).abs() < 1e-9, "{}", m.worst_case(MONTH));
        // A 200K model holds 200K.
        let body = r#"{"model":"claude-haiku-4-5","max_tokens":1000,"tools":[{"type":"web_fetch_20250910","name":"web_fetch"}],"messages":[]}"#;
        let m = anthropic_meter(body);
        let expect = (200_000.0 * 2.0 + 1_000.0 * 5.0) / 1e6;
        assert!((m.worst_case(MONTH) - expect).abs() < 1e-9, "{}", m.worst_case(MONTH));
        // The same request inline keeps today's reservation (body bytes / 3).
        let inline = r#"{"model":"claude-opus-5-5","max_tokens":10000,"messages":[{"role":"user","content":"read the pdf"}]}"#;
        let m = anthropic_meter(inline);
        let input = (inline.len() as u64).div_ceil(3);
        let expect = (input as f64 * 8.0 + 10_000.0 * 20.0) / 1e6;
        assert!((m.worst_case(MONTH) - expect).abs() < 1e-12);
        // Gemini: the window at the long-context rate past 200K (3.1 Pro).
        let cached = r#"{"cachedContent":"cachedContents/abc","contents":[]}"#;
        let mut m = Meter::new(Provider::Gemini, Billing::Usage { model: Some("gemini-3.1-pro-preview".into()) });
        m.request(cached.as_bytes());
        let expect = (1_048_576.0 * 4.0 + GEMINI_MAX_OUTPUT as f64 * 18.0) / 1e6;
        assert!((m.worst_case(MONTH) - expect).abs() < 1e-9, "{}", m.worst_case(MONTH));
        // The settled answer is still charged what it reports.
        let mut m = anthropic_meter(body);
        m.answer(200, Some("text/event-stream"));
        m.feed(ANTHROPIC_SSE.as_bytes());
        assert_eq!(m.charge(MONTH, DONE).map(|c| c.input), Some(anthropic_expected().input));
    }
}
