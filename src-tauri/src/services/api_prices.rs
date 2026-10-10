//! What a provider answer cost: per-model API prices and the arithmetic that
//! turns a reported usage into US dollars (`docs/api_chat_plan.md`, Part C,
//! C3 — the spending limit).
//!
//! **The prices are an estimate**, from the vendors' public pricing pages as
//! fetched on **2026-10-04**:
//!
//! - Anthropic: <https://platform.claude.com/docs/en/about-claude/pricing>
//!   (standard first-party rates; batch, Bedrock and Vertex do not apply —
//!   the proxy only talks to `api.anthropic.com`). Long-context pricing for
//!   Sonnet 4 / 4.5 (2× input, 1.5× output past 200K input tokens) is from
//!   the earlier version of that page; the 2026-10-04 page lists 1M context at
//!   standard pricing for 4.6 and later only. Haiku 5.5 ($0.10/$0.50, and
//!   $0.50/$2.50 for prompts over 100K) is from the Claude Code 2.1.293
//!   changelog (2026-10-08); its cache rates are assumed to take the same
//!   multiples of input as every other model here.
//! - Gemini: <https://ai.google.dev/gemini-api/docs/pricing> ("Last updated
//!   2026-10-01 UTC"; paid tier, Standard — not batch, flex or priority).
//!   Grounding with Google Search, read off the same page on 2026-10-04:
//!   Gemini 3.x "$14 per 1,000 [search] requests", Gemini 2.5 "$35 / 1,000
//!   grounded prompts"; Google Maps grounding the same or less ($14 per 1,000
//!   queries, $25 per 1,000 grounded prompts). The free allowances (5,000 a
//!   month for 3.x, 1,500 a day for 2.5) are not deducted — an overcount. An
//!   unknown model pays $35 per 1,000 for *every* query, the dearest reading
//!   of both units ([`GROUNDING_CEILING_USD`]). The search queries are counted
//!   by `api_meter` from `groundingMetadata.webSearchQueries`, as Anthropic
//!   web search is from `server_tool_use`, and kept in the ledger's
//!   `web_searches`.
//!
//! Not priced (the ledger undercounts these): Gemini context-cache storage
//! per hour (the explicit cache API is not forwarded), Anthropic code
//! execution hours (free beside web search/fetch, otherwise a free monthly
//! allowance), Anthropic refusal-fallback repricing. A vendor price change needs this table edited.
//!
//! **An unknown model** is priced at its provider's most expensive known rate
//! for each kind of token ([`fallback`]: the maximum over the table's current
//! chat models, long-context tier included) and flagged, so a model newer
//! than this table can only overcount. Model ids are matched after
//! [`normalize`]: case, `models/` and `anthropic.` prefixes, Vertex `@…`
//! versions, `-latest`, dated suffixes (`-20250929`), Gemini numbered and
//! dated preview suffixes (`-001`, `-preview-09-2025`).
//!
//! `AppHandle`-free and pure.

use super::agent_api_keys::Provider;

/// The day the tables below were read off the vendors' pricing pages
/// (shown in Manage CLIs).
pub const PRICES_DATE: &str = "2026-10-04";

/// Prompt size past which a long-context rate applies (Gemini Pro tiers,
/// Anthropic Sonnet 4 / 4.5).
pub const LONG_CONTEXT: u64 = 200_000;

/// Anthropic web search: $10 per 1,000 searches.
const WEB_SEARCH_USD: f64 = 10.0 / 1000.0;
/// Gemini 3.x Google Search grounding: $14 per 1,000 search queries.
const GROUNDING_QUERY_USD: f64 = 14.0 / 1000.0;
/// Gemini 2.5 Google Search grounding: $35 per 1,000 grounded prompts.
const GROUNDING_PROMPT_USD: f64 = 35.0 / 1000.0;
/// What an unknown Gemini model pays per search query: the highest
/// documented grounding rate ($35 per 1,000), applied per query rather than
/// per prompt — a conservative ceiling over both units.
pub const GROUNDING_CEILING_USD: f64 = GROUNDING_PROMPT_USD;
/// Anthropic fast mode (`usage.speed == "fast"`): Opus 5.5 $8/$40 over
/// $4/$20, Opus 5 and 4.8 $10/$50 over $5/$25 — twice the rate, cache
/// multipliers on top.
const FAST_MODE: f64 = 2.0;
/// Anthropic US-only inference (`usage.inference_geo == "us"`): 1.1× on every
/// token category.
const US_GEO: f64 = 1.1;

/// One Anthropic model's rates, USD per million tokens.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AnthropicRates {
    pub input: f64,
    pub cache_write_5m: f64,
    pub cache_write_1h: f64,
    pub cache_read: f64,
    pub output: f64,
    /// A long-context tier: past its prompt size, input-side rates and output
    /// take its multipliers (Sonnet 4 / 4.5, Haiku 5.5).
    pub long: Option<LongTier>,
    /// Retired on the first-party API: priced if seen, left out of the
    /// unknown-model fallback.
    pub retired: bool,
}

/// An Anthropic long-context tier: a prompt of more than `past` input tokens
/// (cache included) pays `input`× on every input-side rate and `output`× on
/// output.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LongTier {
    pub past: u64,
    pub input: f64,
    pub output: f64,
}

/// Sonnet 4 / 4.5: past [`LONG_CONTEXT`], input-side rates double and output
/// costs 1.5×.
const SONNET_4_LONG: LongTier = LongTier { past: LONG_CONTEXT, input: 2.0, output: 1.5 };
/// Haiku 5.5: past 100K, $0.50/$2.50 over $0.10/$0.50.
const HAIKU_5_5_LONG: LongTier = LongTier { past: 100_000, input: 5.0, output: 5.0 };

const fn anthropic(input: f64, cache_write_5m: f64, cache_write_1h: f64, cache_read: f64, output: f64) -> AnthropicRates {
    AnthropicRates { input, cache_write_5m, cache_write_1h, cache_read, output, long: None, retired: false }
}

const OPUS_4X: AnthropicRates = anthropic(5.0, 6.25, 10.0, 0.50, 25.0);
const OPUS_4_OLD: AnthropicRates = AnthropicRates { retired: true, ..anthropic(15.0, 18.75, 30.0, 1.50, 75.0) };
const SONNET_5X: AnthropicRates = anthropic(2.0, 2.50, 4.0, 0.20, 10.0);
const SONNET_4X: AnthropicRates = anthropic(3.0, 3.75, 6.0, 0.30, 15.0);
const FABLE_5_1: AnthropicRates = anthropic(10.0, 12.50, 20.0, 0.25, 50.0);
const FABLE_5: AnthropicRates = anthropic(10.0, 12.50, 20.0, 1.0, 50.0);

/// Anthropic first-party prices (2026-10-04), by the model id the Messages
/// API reports.
const ANTHROPIC: &[(&str, AnthropicRates)] = &[
    ("claude-fable-5-1", FABLE_5_1),
    ("claude-mythos-5-1", FABLE_5_1),
    ("claude-fable-5", FABLE_5),
    ("claude-mythos-5", FABLE_5),
    ("claude-opus-5-5", anthropic(4.0, 5.0, 8.0, 0.20, 20.0)),
    ("claude-opus-5", OPUS_4X),
    ("claude-opus-4-8", OPUS_4X),
    ("claude-opus-4-7", OPUS_4X),
    ("claude-opus-4-6", OPUS_4X),
    ("claude-opus-4-5", OPUS_4X),
    ("claude-opus-4-1", OPUS_4_OLD),
    ("claude-opus-4", OPUS_4_OLD),
    ("claude-opus-4-0", OPUS_4_OLD),
    ("claude-sonnet-5-5", SONNET_5X),
    ("claude-sonnet-5", SONNET_5X),
    ("claude-sonnet-4-6", SONNET_4X),
    ("claude-sonnet-4-5", AnthropicRates { long: Some(SONNET_4_LONG), ..SONNET_4X }),
    ("claude-sonnet-4", AnthropicRates { long: Some(SONNET_4_LONG), retired: true, ..SONNET_4X }),
    ("claude-sonnet-4-0", AnthropicRates { long: Some(SONNET_4_LONG), retired: true, ..SONNET_4X }),
    ("claude-haiku-5-5", AnthropicRates { long: Some(HAIKU_5_5_LONG), ..anthropic(0.10, 0.125, 0.20, 0.01, 0.50) }),
    ("claude-haiku-4-5", anthropic(1.0, 1.25, 2.0, 0.10, 5.0)),
    ("claude-3-5-haiku", AnthropicRates { retired: true, ..anthropic(0.80, 1.0, 1.60, 0.08, 4.0) }),
];

/// How a Gemini model's Google Search (or Maps) grounding is billed.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Grounding {
    /// USD per search query the model ran (Gemini 3.x).
    PerQuery(f64),
    /// USD per answer that was grounded at all, however many queries
    /// (Gemini 2.5: "grounded prompts").
    PerPrompt(f64),
}

/// One Gemini model's rates, USD per million tokens.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GeminiRates {
    /// Text / image / video input.
    pub input: f64,
    /// Output, thinking included.
    pub output: f64,
    /// Implicit or explicit cache hits.
    pub cache_read: f64,
    /// Audio input where the model prices it apart.
    pub audio_input: Option<f64>,
    /// Rates for prompts past [`LONG_CONTEXT`] tokens: input, output, cache.
    pub long: Option<(f64, f64, f64)>,
    /// From this UTC month on (`YYYY-MM`), every rate doubles (Gemini
    /// 3.6–3.8 Flash: "through December 31, 2026 … starting January 1, 2027").
    pub doubles_from: Option<&'static str>,
    /// Image, speech or embedding model: priced, but not a chat model, so it
    /// stays out of the unknown-model fallback. Image models are priced at
    /// their image-output rate for every output token (an overcount for
    /// text parts).
    pub media: bool,
    /// Search grounding (not doubled by [`GeminiRates::doubles_from`]: the
    /// page schedules the token rates only).
    pub grounding: Grounding,
}

const fn gemini(input: f64, output: f64, cache_read: f64) -> GeminiRates {
    GeminiRates {
        input,
        output,
        cache_read,
        audio_input: None,
        long: None,
        doubles_from: None,
        media: false,
        grounding: Grounding::PerQuery(GROUNDING_QUERY_USD),
    }
}

/// A Gemini 2.5 model: grounding per grounded prompt.
const fn gemini_2_5(r: GeminiRates) -> GeminiRates {
    GeminiRates { grounding: Grounding::PerPrompt(GROUNDING_PROMPT_USD), ..r }
}

const fn gemini_media(input: f64, output: f64) -> GeminiRates {
    GeminiRates { media: true, ..gemini(input, output, input) }
}

const FLASH_PROMO: GeminiRates = GeminiRates { doubles_from: Some("2027-01"), ..gemini(0.75, 3.75, 0.075) };
const PRO_3_1: GeminiRates = GeminiRates { long: Some((4.0, 18.0, 0.40)), ..gemini(2.0, 12.0, 0.20) };

/// Gemini API prices (page updated 2026-10-01, read 2026-10-04), by model id.
/// Live, transcription and video models are absent: their APIs are not
/// forwarded.
const GEMINI: &[(&str, GeminiRates)] = &[
    ("gemini-3.8-flash", FLASH_PROMO),
    ("gemini-3.7-flash", FLASH_PROMO),
    ("gemini-3.6-flash", FLASH_PROMO),
    ("gemini-3.5-flash", gemini(1.50, 9.0, 0.15)),
    ("gemini-3.5-flash-lite", gemini(0.30, 2.50, 0.03)),
    ("gemini-3.1-flash-lite", GeminiRates { audio_input: Some(0.50), ..gemini(0.25, 1.50, 0.025) }),
    ("gemini-3.1-pro-preview", PRO_3_1),
    ("gemini-3.1-pro-preview-customtools", PRO_3_1),
    ("gemini-3-flash-preview", GeminiRates { audio_input: Some(1.0), ..gemini(0.50, 3.0, 0.05) }),
    ("gemini-2.5-pro", gemini_2_5(GeminiRates { long: Some((2.50, 15.0, 0.25)), ..gemini(1.25, 10.0, 0.125) })),
    ("gemini-2.5-flash", gemini_2_5(GeminiRates { audio_input: Some(1.0), ..gemini(0.30, 2.50, 0.03) })),
    ("gemini-2.5-flash-lite", gemini_2_5(GeminiRates { audio_input: Some(0.30), ..gemini(0.10, 0.40, 0.01) })),
    ("gemini-3.1-flash-image", gemini_media(0.50, 60.0)),
    ("gemini-3.1-flash-lite-image", gemini_media(0.25, 30.0)),
    ("gemini-3-pro-image", gemini_media(2.0, 120.0)),
    // $0.039 per image at 1,290 tokens an image.
    ("gemini-2.5-flash-image", gemini_2_5(gemini_media(0.30, 30.24))),
    ("gemini-3.8-flash-tts", GeminiRates { doubles_from: Some("2027-01"), ..gemini_media(0.50, 9.0) }),
    ("gemini-3.8-flash-lite-tts", GeminiRates { doubles_from: Some("2027-01"), ..gemini_media(0.50, 6.0) }),
    ("gemini-3.1-flash-tts-preview", gemini_media(1.0, 20.0)),
    ("gemini-2.5-flash-preview-tts", gemini_2_5(gemini_media(0.50, 10.0))),
    ("gemini-2.5-pro-preview-tts", gemini_2_5(gemini_media(1.0, 20.0))),
    ("gemini-embedding-2", gemini_media(0.20, 0.0)),
];

/// `raw` as the table spells model ids. See the module docs for what is
/// stripped.
pub fn normalize(provider: Provider, raw: &str) -> String {
    let mut id = raw.trim().to_ascii_lowercase();
    match provider {
        Provider::Anthropic => {
            if let Some(rest) = id.strip_prefix("anthropic.") {
                id = rest.to_string();
            }
            if let Some(at) = id.find(['@', '[']) {
                id.truncate(at);
            }
            // Bedrock's `-v1:0`.
            if let Some(v) = id.rfind("-v") {
                if id[v + 2..].bytes().all(|b| b.is_ascii_digit() || b == b':') && id.len() > v + 2 {
                    id.truncate(v);
                }
            }
            strip_suffix_in_place(&mut id, "-latest");
            // `-20250929`
            if let Some(dash) = id.rfind('-') {
                let tail = &id[dash + 1..];
                if tail.len() == 8 && tail.bytes().all(|b| b.is_ascii_digit()) {
                    id.truncate(dash);
                }
            }
        }
        Provider::Gemini => {
            if let Some(rest) = id.strip_prefix("models/") {
                id = rest.to_string();
            }
            strip_suffix_in_place(&mut id, "-latest");
        }
    }
    id
}

fn strip_suffix_in_place(id: &mut String, suffix: &str) {
    if id.ends_with(suffix) {
        id.truncate(id.len() - suffix.len());
    }
}

/// Gemini ids with a version tail the table does not list: `-001`,
/// `-preview-09-2025`, `-preview-05-06`, `-exp-0827` — the stem without it.
fn gemini_stem(id: &str) -> Option<&str> {
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let (head, last) = id.rsplit_once('-')?;
    if digits(last) && last.len() == 3 {
        return Some(head);
    }
    // `<stem>-preview-MM-YYYY` / `<stem>-preview-MM-DD` / `<stem>-exp-MMDD`
    for marker in ["-preview-", "-exp-"] {
        if let Some(at) = id.rfind(marker) {
            let tail = &id[at + marker.len()..];
            if !tail.is_empty() && tail.split('-').all(digits) {
                return Some(&id[..at]);
            }
        }
    }
    None
}

/// Anthropic's rates for `model` and whether the table knows it.
pub fn anthropic_rates(model: &str) -> (AnthropicRates, bool) {
    let id = normalize(Provider::Anthropic, model);
    match ANTHROPIC.iter().find(|(m, _)| *m == id) {
        Some((_, r)) => (*r, true),
        None => (anthropic_fallback(), false),
    }
}

/// Gemini's rates for `model` in UTC month `month` (`YYYY-MM`) and whether
/// the table knows it.
pub fn gemini_rates(model: &str, month: &str) -> (GeminiRates, bool) {
    let id = normalize(Provider::Gemini, model);
    let found = GEMINI
        .iter()
        .find(|(m, _)| *m == id)
        .or_else(|| gemini_stem(&id).and_then(|stem| GEMINI.iter().find(|(m, _)| *m == stem)));
    match found {
        Some((_, r)) => (in_month(*r, month), true),
        None => (gemini_fallback(month), false),
    }
}

/// `r` with a scheduled raise applied once `month` reached it.
fn in_month(r: GeminiRates, month: &str) -> GeminiRates {
    match r.doubles_from {
        Some(from) if month >= from => GeminiRates {
            input: r.input * 2.0,
            output: r.output * 2.0,
            cache_read: r.cache_read * 2.0,
            audio_input: r.audio_input.map(|a| a * 2.0),
            long: r.long.map(|(i, o, c)| (i * 2.0, o * 2.0, c * 2.0)),
            doubles_from: None,
            media: r.media,
            grounding: r.grounding,
        },
        _ => r,
    }
}

/// The most expensive known rate per token kind over Anthropic's current
/// (not retired) models.
fn anthropic_fallback() -> AnthropicRates {
    let current = || ANTHROPIC.iter().map(|(_, r)| r).filter(|r| !r.retired);
    let max = |f: fn(&AnthropicRates) -> f64| current().map(f).fold(0.0, f64::max);
    AnthropicRates {
        input: max(|r| r.input),
        cache_write_5m: max(|r| r.cache_write_5m),
        cache_write_1h: max(|r| r.cache_write_1h),
        cache_read: max(|r| r.cache_read),
        output: max(|r| r.output),
        long: None,
        retired: false,
    }
}

/// The most expensive known rate per token kind over Gemini's chat models
/// (long-context tier and `month`'s raises included).
fn gemini_fallback(month: &str) -> GeminiRates {
    let chat: Vec<GeminiRates> = GEMINI.iter().filter(|(_, r)| !r.media).map(|(_, r)| in_month(*r, month)).collect();
    let max = |f: &dyn Fn(&GeminiRates) -> f64| chat.iter().map(f).fold(0.0, f64::max);
    let input = max(&|r| r.long.map_or(r.input, |l| l.0.max(r.input)));
    GeminiRates {
        input,
        output: max(&|r| r.long.map_or(r.output, |l| l.1.max(r.output))),
        cache_read: max(&|r| r.long.map_or(r.cache_read, |l| l.2.max(r.cache_read))),
        audio_input: Some(max(&|r| r.audio_input.unwrap_or(0.0)).max(input)),
        long: None,
        doubles_from: None,
        media: false,
        grounding: Grounding::PerQuery(GROUNDING_CEILING_USD),
    }
}

/// The output rate `model` is priced at (USD per million tokens; an unknown
/// model at the fallback), to tell the dearer of two models apart.
pub fn output_rate(provider: Provider, model: &str) -> f64 {
    match provider {
        Provider::Anthropic => anthropic_rates(model).0.output,
        // No month: the scheduled raises double a whole entry, so they do
        // not change which of two models is dearer by much.
        Provider::Gemini => {
            let r = gemini_rates(model, "").0;
            r.long.map_or(r.output, |l| l.1.max(r.output))
        }
    }
}

/// Context windows (input tokens a request can hold), read 2026-10-05: the
/// Claude API model table (1M on every current model but Haiku 4.5; Sonnet
/// 4 / 4.5 reach 1M with the long-context beta, so the larger is taken) and
/// the Gemini model pages ("Input token limit" 1,048,576 on the chat models).
/// `api_meter` reserves a model's whole window for a request that names
/// input by reference (#2343). Anthropic models listed here hold 200K; every
/// other Anthropic model in [`ANTHROPIC`] holds 1M.
const ANTHROPIC_200K: &[&str] = &[
    "claude-opus-4-5",
    "claude-opus-4-1",
    "claude-opus-4",
    "claude-opus-4-0",
    "claude-haiku-4-5",
    "claude-3-5-haiku",
];
const ANTHROPIC_WINDOW: u64 = 1_000_000;
const ANTHROPIC_SMALL_WINDOW: u64 = 200_000;
/// Every Gemini model in [`GEMINI`] is taken at the chat models' window; the
/// image, speech and embedding models hold less (an overcount for them).
const GEMINI_WINDOW: u64 = 1_048_576;

/// The context window of `model`, in input tokens. An unknown model is taken
/// at its provider's largest known window.
pub fn context_window(provider: Provider, model: &str) -> u64 {
    match provider {
        Provider::Anthropic => {
            let id = normalize(Provider::Anthropic, model);
            let known = ANTHROPIC.iter().any(|(m, _)| *m == id);
            if known && ANTHROPIC_200K.contains(&id.as_str()) {
                ANTHROPIC_SMALL_WINDOW
            } else {
                ANTHROPIC_WINDOW
            }
        }
        Provider::Gemini => GEMINI_WINDOW,
    }
}

/// One answer's Anthropic usage, as reported (`usage` of `message_start`,
/// `message_delta` or a non-streaming message; counts are cumulative).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AnthropicUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub cache_read_input_tokens: u64,
    /// `cache_creation.ephemeral_5m_input_tokens` / `…_1h_…`, when reported.
    pub cache_5m: Option<u64>,
    pub cache_1h: Option<u64>,
    /// `server_tool_use.web_search_requests`.
    pub web_search_requests: u64,
    /// `speed == "fast"`.
    pub fast: bool,
    /// `inference_geo == "us"`.
    pub us_only: bool,
}

/// One answer's Gemini `usageMetadata` (cumulative over a stream).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GeminiUsage {
    pub prompt_token_count: u64,
    pub candidates_token_count: u64,
    pub cached_content_token_count: u64,
    pub thoughts_token_count: u64,
    pub tool_use_prompt_token_count: u64,
    /// `promptTokensDetails` entries with `modality == "AUDIO"`.
    pub audio_prompt_tokens: u64,
    /// Google Search queries the answer ran (`groundingMetadata.webSearchQueries`,
    /// counted by `api_meter`).
    pub search_queries: u64,
    /// The answer was grounded (search queries, or grounding metadata
    /// without any — Maps grounding, a per-prompt bill).
    pub grounded: bool,
}

/// What one answer cost, by the table.
#[derive(Debug, Clone, PartialEq)]
pub struct Charge {
    /// The model as reported (or asked for), not normalized.
    pub model: String,
    /// The table knew the model; `false` = priced at the fallback rate.
    pub known: bool,
    pub input: u64,
    pub output: u64,
    pub cache_write: u64,
    pub cache_read: u64,
    pub web_searches: u64,
    pub usd: f64,
}

const PER_TOKEN: f64 = 1.0 / 1_000_000.0;

/// The cost of an Anthropic answer from `model`.
pub fn price_anthropic(model: &str, u: &AnthropicUsage) -> Charge {
    let (r, known) = anthropic_rates(model);
    // Saturating throughout: the counts come off the wire.
    let cache_write = u.cache_creation_input_tokens.max(u.cache_5m.unwrap_or(0).saturating_add(u.cache_1h.unwrap_or(0)));
    // Without a TTL breakdown every write counts as a 1-hour write (the dearer
    // one); with one, a remainder it does not explain does too.
    let w5 = u.cache_5m.unwrap_or(0).min(cache_write);
    let w1h = cache_write - w5;
    let total_in = u.input_tokens.saturating_add(cache_write).saturating_add(u.cache_read_input_tokens);
    let (in_mult, out_mult) = match r.long {
        Some(t) if total_in > t.past => (t.input, t.output),
        _ => (1.0, 1.0),
    };
    let tokens = u.input_tokens as f64 * r.input * in_mult
        + w5 as f64 * r.cache_write_5m * in_mult
        + w1h as f64 * r.cache_write_1h * in_mult
        + u.cache_read_input_tokens as f64 * r.cache_read * in_mult
        + u.output_tokens as f64 * r.output * out_mult;
    let mut mult = 1.0;
    if u.fast {
        mult *= FAST_MODE;
    }
    if u.us_only {
        mult *= US_GEO;
    }
    Charge {
        model: model.to_string(),
        known,
        input: u.input_tokens,
        output: u.output_tokens,
        cache_write,
        cache_read: u.cache_read_input_tokens,
        web_searches: u.web_search_requests,
        usd: tokens * PER_TOKEN * mult + u.web_search_requests as f64 * WEB_SEARCH_USD,
    }
}

/// The cost of a Gemini answer from `model` in UTC month `month`.
pub fn price_gemini(model: &str, u: &GeminiUsage, month: &str) -> Charge {
    let (r, known) = gemini_rates(model, month);
    let (input_rate, output_rate, cache_rate) = match r.long {
        Some(long) if u.prompt_token_count > LONG_CONTEXT => long,
        _ => (r.input, r.output, r.cache_read),
    };
    let cached = u.cached_content_token_count.min(u.prompt_token_count);
    let uncached = u.prompt_token_count - cached;
    let audio = u.audio_prompt_tokens.min(uncached);
    let text = (uncached - audio).saturating_add(u.tool_use_prompt_token_count);
    let audio_rate = r.audio_input.unwrap_or(input_rate).max(input_rate);
    let output = u.candidates_token_count.saturating_add(u.thoughts_token_count);
    // Grounding metadata without a query still is one grounded prompt.
    let searches = if u.grounded { u.search_queries.max(1) } else { u.search_queries };
    let grounding = match r.grounding {
        Grounding::PerQuery(usd) => searches as f64 * usd,
        Grounding::PerPrompt(usd) if searches > 0 => usd,
        Grounding::PerPrompt(_) => 0.0,
    };
    let usd = (text as f64 * input_rate
        + audio as f64 * audio_rate
        + cached as f64 * cache_rate
        + output as f64 * output_rate)
        * PER_TOKEN
        + grounding;
    Charge {
        model: model.to_string(),
        known,
        input: text.saturating_add(audio),
        output,
        cache_write: 0,
        cache_read: cached,
        web_searches: searches,
        usd,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn context_windows_by_model_and_the_largest_for_an_unknown_one() {
        assert_eq!(context_window(Provider::Anthropic, "claude-opus-5-5"), 1_000_000);
        assert_eq!(context_window(Provider::Anthropic, "claude-sonnet-4-5-20250929"), 1_000_000, "1M with the beta");
        assert_eq!(context_window(Provider::Anthropic, "claude-haiku-4-5-20251001"), 200_000);
        assert_eq!(context_window(Provider::Anthropic, "claude-opus-4-1"), 200_000);
        assert_eq!(context_window(Provider::Anthropic, "claude-next-9"), 1_000_000);
        assert_eq!(context_window(Provider::Gemini, "models/gemini-3.5-flash"), 1_048_576);
        assert_eq!(context_window(Provider::Gemini, "gemini-unknown"), 1_048_576);
        for (model, _) in ANTHROPIC {
            assert!(context_window(Provider::Anthropic, model) <= ANTHROPIC_WINDOW);
        }
        for id in ANTHROPIC_200K {
            assert!(ANTHROPIC.iter().any(|(m, _)| m == id), "{id} is a priced model");
        }
    }

    #[test]
    fn model_ids_match_through_their_decorations() {
        for raw in [
            "claude-sonnet-4-5",
            "claude-sonnet-4-5-20250929",
            "Claude-Sonnet-4-5-latest",
            "anthropic.claude-sonnet-4-5-20250929-v1:0",
            "claude-sonnet-4-5@20250929",
            "claude-sonnet-4-5[1m]",
        ] {
            let (r, known) = anthropic_rates(raw);
            assert!(known, "{raw}");
            assert_eq!(r.input, 3.0, "{raw}");
        }
        assert!(anthropic_rates("claude-opus-5-5").1);
        assert_eq!(anthropic_rates("claude-opus-4-1-20250805").0.output, 75.0);
        assert_eq!(anthropic_rates("claude-3-5-haiku-latest").0.input, 0.80);
        for raw in [
            "gemini-2.5-flash",
            "models/gemini-2.5-flash",
            "gemini-2.5-flash-001",
            "gemini-2.5-flash-preview-09-2025",
            "gemini-2.5-flash-preview-05-20",
        ] {
            let (r, known) = gemini_rates(raw, "2026-10");
            assert!(known, "{raw}");
            assert_eq!(r.input, 0.30, "{raw}");
        }
        // The table's own preview ids stay themselves.
        assert_eq!(gemini_rates("gemini-3.1-pro-preview", "2026-10").0.input, 2.0);
        assert!(gemini_rates("models/gemini-3-flash-preview", "2026-10").1);
        // A near miss is not a match: no prefix guessing.
        assert!(!anthropic_rates("claude-opus-4-9").1);
        assert!(!gemini_rates("gemini-2.5-flashy", "2026-10").1);
    }

    #[test]
    fn an_unknown_model_costs_the_most_expensive_known_rate() {
        let (r, known) = anthropic_rates("claude-next-model");
        assert!(!known);
        assert_eq!((r.input, r.output, r.cache_read), (10.0, 50.0, 1.0));
        assert_eq!((r.cache_write_5m, r.cache_write_1h), (12.5, 20.0));
        // Retired models do not raise the fallback.
        assert!(r.output < 75.0);
        let (g, known) = gemini_rates("gemini-9-ultra", "2026-10");
        assert!(!known);
        assert_eq!((g.input, g.output, g.cache_read), (4.0, 18.0, 0.40));
        // Image models stay out of it.
        assert!(g.output < 120.0);
        // Flagged in the charge.
        let c = price_anthropic("claude-next-model", &AnthropicUsage { input_tokens: 1_000_000, ..Default::default() });
        assert!(!c.known);
        assert!(close(c.usd, 10.0));
    }

    #[test]
    fn anthropic_prices_every_token_kind() {
        let u = AnthropicUsage {
            input_tokens: 1_000_000,
            output_tokens: 1_000_000,
            cache_creation_input_tokens: 3_000_000,
            cache_read_input_tokens: 1_000_000,
            cache_5m: Some(2_000_000),
            cache_1h: Some(1_000_000),
            web_search_requests: 3,
            ..Default::default()
        };
        // Opus 5.5: 4 + 20 + 2×5 + 8 + 0.20, plus 3 searches.
        let c = price_anthropic("claude-opus-5-5", &u);
        assert!(c.known);
        assert!(close(c.usd, 4.0 + 20.0 + 10.0 + 8.0 + 0.20 + 0.03), "{}", c.usd);
        assert_eq!((c.input, c.output, c.cache_write, c.cache_read, c.web_searches), (1_000_000, 1_000_000, 3_000_000, 1_000_000, 3));
        // No TTL breakdown: every write at the 1-hour rate.
        let u = AnthropicUsage { cache_creation_input_tokens: 1_000_000, ..Default::default() };
        assert!(close(price_anthropic("claude-opus-5-5", &u).usd, 8.0));
        // Fast mode doubles, US-only adds a tenth.
        let u = AnthropicUsage { input_tokens: 1_000_000, fast: true, us_only: true, ..Default::default() };
        assert!(close(price_anthropic("claude-opus-5-5", &u).usd, 4.0 * 2.0 * 1.1));
    }

    #[test]
    fn sonnet_4_5_long_context_costs_more_past_200k() {
        let short = AnthropicUsage { input_tokens: 200_000, output_tokens: 1000, ..Default::default() };
        let long = AnthropicUsage { input_tokens: 200_001, output_tokens: 1000, ..Default::default() };
        let base = price_anthropic("claude-sonnet-4-5", &short).usd;
        assert!(close(base, 0.6 + 0.015));
        assert!(close(price_anthropic("claude-sonnet-4-5", &long).usd, 200_001.0 * 6.0 / 1e6 + 1000.0 * 22.5 / 1e6));
        // 4.6 has none.
        assert!(close(price_anthropic("claude-sonnet-4-6", &long).usd, 200_001.0 * 3.0 / 1e6 + 1000.0 * 15.0 / 1e6));
    }

    #[test]
    fn haiku_5_5_is_known_and_costs_five_times_past_100k() {
        let short = AnthropicUsage { input_tokens: 90_000, cache_read_input_tokens: 10_000, output_tokens: 1000, ..Default::default() };
        let c = price_anthropic("claude-haiku-5-5", &short);
        assert!(c.known, "the new default Haiku must not fall back to the dearest rate");
        assert!(close(c.usd, 90_000.0 * 0.10 / 1e6 + 10_000.0 * 0.01 / 1e6 + 1000.0 * 0.50 / 1e6));
        // Cache counts toward the 100K.
        let long = AnthropicUsage { cache_read_input_tokens: 10_001, ..short };
        assert!(close(
            price_anthropic("claude-haiku-5-5", &long).usd,
            90_000.0 * 0.50 / 1e6 + 10_001.0 * 0.05 / 1e6 + 1000.0 * 2.50 / 1e6
        ));
        assert_eq!(context_window(Provider::Anthropic, "claude-haiku-5-5"), 1_000_000);
    }

    #[test]
    fn gemini_prices_tiers_cache_thoughts_and_audio() {
        // 2.5 Pro under and over 200K.
        let u = GeminiUsage { prompt_token_count: 100_000, candidates_token_count: 1000, thoughts_token_count: 1000, ..Default::default() };
        let c = price_gemini("gemini-2.5-pro", &u, "2026-10");
        assert!(close(c.usd, 100_000.0 * 1.25 / 1e6 + 2000.0 * 10.0 / 1e6));
        assert_eq!(c.output, 2000);
        let u = GeminiUsage { prompt_token_count: 300_000, cached_content_token_count: 100_000, candidates_token_count: 1000, ..Default::default() };
        let c = price_gemini("gemini-2.5-pro", &u, "2026-10");
        assert!(close(c.usd, 200_000.0 * 2.5 / 1e6 + 100_000.0 * 0.25 / 1e6 + 1000.0 * 15.0 / 1e6));
        assert_eq!((c.input, c.cache_read), (200_000, 100_000));
        // Audio at its own rate, tool-use prompt as input.
        let u = GeminiUsage { prompt_token_count: 1_000_000, audio_prompt_tokens: 400_000, tool_use_prompt_token_count: 100_000, ..Default::default() };
        let c = price_gemini("gemini-2.5-flash", &u, "2026-10");
        assert!(close(c.usd, 700_000.0 * 0.30 / 1e6 + 400_000.0 * 1.0 / 1e6));
    }

    #[test]
    fn gemini_grounding_is_priced_per_query_or_per_prompt() {
        let u = GeminiUsage { prompt_token_count: 1_000_000, search_queries: 3, grounded: true, ..Default::default() };
        // Gemini 3.x: $14 per 1,000 queries, recorded as web searches.
        let c = price_gemini("gemini-3.5-flash", &u, "2026-10");
        assert!(close(c.usd, 1.50 + 3.0 * 0.014), "{}", c.usd);
        assert_eq!(c.web_searches, 3);
        // Not doubled with the promotional token rates.
        let c = price_gemini("gemini-3.8-flash", &u, "2027-01");
        assert!(close(c.usd, 1.50 + 3.0 * 0.014), "{}", c.usd);
        // Gemini 2.5: $35 per grounded prompt, however many queries.
        assert!(close(price_gemini("gemini-2.5-flash", &u, "2026-10").usd, 0.30 + 0.035));
        // An unknown model: $35 per 1,000 for every query.
        let c = price_gemini("gemini-9-ultra", &u, "2026-10");
        assert!(close(c.usd, 4.0 + 3.0 * 0.035), "{}", c.usd);
        // Grounded without a query (Maps): one.
        let u = GeminiUsage { grounded: true, ..Default::default() };
        let c = price_gemini("gemini-3.5-flash", &u, "2026-10");
        assert!(close(c.usd, 0.014));
        assert_eq!(c.web_searches, 1);
        assert!(close(price_gemini("gemini-2.5-pro", &u, "2026-10").usd, 0.035));
        // Not grounded: nothing.
        assert_eq!(price_gemini("gemini-2.5-pro", &GeminiUsage::default(), "2026-10").usd, 0.0);
    }

    #[test]
    fn gemini_promotional_rates_end_on_schedule() {
        let u = GeminiUsage { prompt_token_count: 1_000_000, candidates_token_count: 1_000_000, ..Default::default() };
        assert!(close(price_gemini("gemini-3.8-flash", &u, "2026-12").usd, 0.75 + 3.75));
        assert!(close(price_gemini("gemini-3.8-flash", &u, "2027-01").usd, 1.50 + 7.50));
        assert!(close(price_gemini("gemini-3.5-flash", &u, "2027-01").usd, 1.50 + 9.0));
    }
}
