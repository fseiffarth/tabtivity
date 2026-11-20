//! Agent token counts per CLI, model and scope — the `tokens.*` keys of the
//! usage recap (`docs/done/token_stats_plan.md`, `docs/cli_caching_plan.md`).
//!
//! **Derived from the CLIs' own records, never counted live.** Every local
//! agent tab's `$HOME` is an Tabtivity-owned agent home (`services::agent_home`),
//! and Claude, Codex and OpenCode already write per-message usage there
//! (OpenCode as rows of its `opencode.db`, read through `agent_sqlite`). Reading it at
//! the source, like the recap's time, network and git numbers, means a crashed
//! tab, a `/clear` or a resume can never make the counts drift.
//!
//! The one piece of stored state is a **rebuildable scan cache**
//! (`token_stats.json`): Claude deletes transcripts after `cleanupPeriodDays`,
//! so a month view would shrink as files vanish. The cache keeps a cursor per
//! source file (how far it was read, plus what that file contributed to the
//! hour/day buckets), and when a file disappears its contribution moves to
//! `retired` instead of being dropped — that is how history outlives the
//! CLI's cleanup. Losing the cache only costs a full re-read of what is left.
//!
//! **Hostile input.** Homes are agent-writable. Every file is opened through
//! `services::home_io` (no-follow `openat` walk), lines over [`Limits::max_line`]
//! are skipped without being buffered whole, counts are bounded per message,
//! timestamps from the future are ignored, and one scan reads at most
//! [`Limits::max_bytes`] / [`Limits::max_files`] — past that it returns what it
//! has with `partial: true` and the next scan carries on from the cursors.
//! Only counts, model names, CLI and scope ids reach the buckets; the cache
//! holds home-relative file keys for its cursors and nothing else.
//!
//! AppHandle-free and unit-tested against fixtures.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use app_core::sync::LockExt;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::schema::usage_stats::{metric, Counters, UsageStats};
use crate::services::agent_home;
use crate::services::agent_session::clean_model_name;
use crate::services::agent_sqlite;
use crate::services::codex_store;
use crate::services::home_io::{HomeDir, HomeFile, Meta};
use crate::storage;

/// File name of the scan cache inside the state dir.
pub const CACHE_FILE: &str = "token_stats.json";
/// Bumped whenever the cursor semantics change; a cache of another version is
/// discarded and rebuilt from whatever transcripts are still on disk.
const CACHE_VERSION: u32 = 1;

/// The agent leaves (as the recap's `agent.*` keys spell them) whose records
/// this module can read. The frontend uses it to tell "not reported" from
/// "none used".
pub const CLAUDE: &str = "claude";
pub const CODEX: &str = "codex";
pub const OPENCODE: &str = "opencode";
pub const GEMINI: &str = "gemini";
pub const COPILOT: &str = "copilot";
pub const SOURCES: [&str; 5] = [CLAUDE, CODEX, OPENCODE, GEMINI, COPILOT];

/// The model a record names when it names none we can use.
const UNKNOWN_MODEL: &str = "unknown";
/// What Claude writes as the model of turns no model produced (an API error,
/// a local command's echo).
const SYNTHETIC_MODEL: &str = "<synthetic>";

/// The split kinds, in the order every `[u64; 4]` here uses them.
const SPLIT: [&str; 4] = [
    metric::TOKENS_IN,
    metric::TOKENS_CACHE_W,
    metric::TOKENS_CACHE_R,
    metric::TOKENS_OUT,
];

/// The cache writes by lifetime, `[5 min, 1 h]` — a detail of
/// `TOKENS_CACHE_W` for the CLIs that report it (Claude).
const LIFETIME: [&str; 2] = [metric::TOKENS_CACHE_W5M, metric::TOKENS_CACHE_W1H];

/// What subagents used, in [`SPLIT`] order — a detail of the split, filed as
/// well as (not instead of) the split kinds.
const SUB: [&str; 4] = [
    metric::TOKENS_SUB_IN,
    metric::TOKENS_SUB_CACHE_W,
    metric::TOKENS_SUB_CACHE_R,
    metric::TOKENS_SUB_OUT,
];

/// One message never legitimately carries more than this per field; a bigger
/// (or negative, or non-numeric) value is a forged record and is ignored.
const MAX_PER_MESSAGE: u64 = 1_000_000_000;
/// Codex's running totals and the SQLite fallback are cumulative per thread,
/// so they get a looser bound — still far below anything that could saturate.
const MAX_TOTAL: u64 = 1_000_000_000_000_000;
/// A record stamped more than a day ahead of the clock is ignored.
const FUTURE_SLACK_MS: i64 = 86_400_000;
/// Claude writes one message on several consecutive lines (one per content
/// block); measured on 1300 live transcripts, the duplicates are always
/// adjacent. A few keys of margin keep the cursor small.
const DEDUPE_WINDOW: usize = 4;
/// At most this many files are listed per scan. Past it the listing is
/// incomplete, so nothing is retired (a file not listed is not a file gone).
const MAX_LISTED: usize = 100_000;
/// At most this many SQLite fallback rows are read per home.
const MAX_DB_THREADS: i64 = 20_000;
/// Bound on the remembered Codex thread ids that have a rollout.
const MAX_ROLLOUT_THREADS: usize = 200_000;
/// Longest dedupe key kept; an id longer than any real one is cut, not stored.
const MAX_KEY_CHARS: usize = 160;

/// How much one scan may do.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// A line longer than this is skipped. Claude's tool-result lines run to
    /// megabytes and never carry usage.
    pub max_line: usize,
    /// Bytes read per scan, across every file.
    pub max_bytes: u64,
    /// Files opened for reading per scan.
    pub max_files: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            max_line: 1 << 20,
            max_bytes: 512 << 20,
            max_files: 4096,
        }
    }
}

/// What a scan found: every scope's token counters at hour and day
/// granularity (the [`UsageStats`] shape the recap already folds), and whether
/// the scan stopped at its budget before reading everything.
#[derive(Debug, Clone, Default)]
pub struct TokenStats {
    pub stats: UsageStats,
    pub partial: bool,
}

/// `tokens.<kind>.<cli>.<model>`.
pub fn token_key(prefix: &str, cli: &str, model: &str) -> String {
    metric::sub(&metric::sub(prefix, cli), model)
}

/// Split a token key back into `(prefix, cli, model)`; the model is everything
/// after the third `.`, dots and all. `None` for any other key.
pub fn parse_token_key(key: &str) -> Option<(&str, &str, &str)> {
    let mut parts = key.splitn(4, '.');
    let (ns, kind, cli, model) = (parts.next()?, parts.next()?, parts.next()?, parts.next()?);
    if ns != "tokens" || cli.is_empty() || model.is_empty() {
        return None;
    }
    let prefix = &key[..ns.len() + 1 + kind.len()];
    let known = SPLIT.contains(&prefix)
        || LIFETIME.contains(&prefix)
        || SUB.contains(&prefix)
        || prefix == metric::TOKENS_TOTAL;
    known.then_some((prefix, cli, model))
}

// ── The cache ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Kind {
    /// A Claude transcript (main session or subagent).
    Claude,
    /// A Codex rollout.
    Codex,
    /// One Codex thread counted from `threads.tokens_used` because it has no
    /// rollout.
    CodexDb,
    /// One message table of a home's OpenCode store.
    OpenCode,
    /// A Gemini CLI session file, folded whole whenever it changes.
    Gemini,
    /// The usage table of a home's Copilot CLI store.
    Copilot,
}

/// A Claude message already counted, kept so its repeat lines add nothing.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Recent {
    key: String,
    hour: String,
    model: String,
    /// What has been counted for it so far, in [`SPLIT`] order.
    n: [u64; 4],
    /// Its cache writes counted so far by lifetime, in [`LIFETIME`] order.
    #[serde(default)]
    w: [u64; 2],
}

/// How far one source has been read, and what it contributed.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Cursor {
    kind: Kind,
    /// The scope the contribution is filed under.
    scope: String,
    /// `(device, inode)` of the file read; a change means it was replaced.
    #[serde(default)]
    ino: Option<(u64, u64)>,
    /// Byte offset after the last line consumed.
    #[serde(default)]
    offset: u64,
    /// The file's length when it was last read; equal means nothing new.
    #[serde(default)]
    len: u64,
    /// The offset is inside an oversized line still being skipped.
    #[serde(default)]
    skipping: bool,
    /// Claude: the last messages counted, so a split one is not counted twice.
    #[serde(default)]
    recent: VecDeque<Recent>,
    /// Codex: the last `total_token_usage` seen, `[input, cached, cache_write, output]`.
    #[serde(default)]
    total: Option<[u64; 4]>,
    /// Codex: the model of the last `turn_context`, and the session meta's.
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    meta_model: Option<String>,
    /// Codex SQLite fallback: the `tokens_used` already counted.
    #[serde(default)]
    counted: u64,
    /// OpenCode: `(time_created, id)` of the last row read, in the order the
    /// table is read. Copilot: `(id, "")`.
    #[serde(default)]
    mark: Option<(i64, String)>,
    /// OpenCode: messages still streaming when read (`id` → `time_created`),
    /// looked up again by id until they finish.
    #[serde(default)]
    pending: BTreeMap<String, i64>,
    /// Claude: the contribution carries the cache-lifetime and subagent
    /// details. A cursor from before them is read again from the start once.
    #[serde(default)]
    detail: bool,
    /// This source's share of the buckets, filed under `scope`.
    #[serde(default)]
    contribution: UsageStats,
}

impl Cursor {
    fn new(kind: Kind, scope: &str) -> Self {
        Cursor {
            kind,
            scope: scope.to_string(),
            ino: None,
            offset: 0,
            len: 0,
            skipping: false,
            recent: VecDeque::new(),
            total: None,
            model: None,
            meta_model: None,
            counted: 0,
            mark: None,
            pending: BTreeMap::new(),
            detail: true,
            contribution: UsageStats::default(),
        }
    }

    /// File the contribution under `scope` — a home whose project was removed
    /// folds into the root scope, and back if the project returns.
    fn adopt_scope(&mut self, scope: &str) {
        if self.scope != scope {
            rekey(&mut self.contribution, &self.scope, scope);
            self.scope = scope.to_string();
        }
    }

    fn add(&mut self, hour: &str, prefix: &str, cli: &str, model: &str, n: u64) {
        self.contribution.add(&self.scope, hour, &token_key(prefix, cli, model), n);
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Cache {
    #[serde(default)]
    version: u32,
    /// Key: `<home dir name>/<path relative to the home>` (a Codex fallback
    /// thread: `<home>/.codex#thread:<id>`). The inode lives in the cursor.
    #[serde(default)]
    files: BTreeMap<String, Cursor>,
    /// What sources that no longer exist contributed.
    #[serde(default)]
    retired: UsageStats,
    /// Per home: the earliest seeded-marker mtime seen (epoch ms). Kept so an
    /// agent deleting the marker — which re-seeds and re-stamps it — cannot
    /// push the cutoff past history that was genuinely made in that home.
    #[serde(default)]
    seed_cutoff_ms: BTreeMap<String, i64>,
    /// Codex thread ids that have (or had) a rollout; the SQLite fallback
    /// skips them so a thread is never counted by both routes.
    #[serde(default)]
    rollout_threads: BTreeSet<String>,
}

fn load_cache(path: &Path) -> Cache {
    match storage::read_json::<Cache>(path) {
        Ok(cache) if cache.version == CACHE_VERSION => cache,
        // Absent, unreadable or another version: rebuild from the sources.
        _ => Cache {
            version: CACHE_VERSION,
            ..Cache::default()
        },
    }
}

// ── Bucket plumbing ────────────────────────────────────────────────────────

type Buckets = HashMap<String, HashMap<String, Counters>>;

/// Saturating sum of `src` into `dst`, hours and days separately (a day
/// bucket can outlive its hours).
fn merge_into(dst: &mut UsageStats, src: &UsageStats) {
    for (to, from) in [(&mut dst.hours, &src.hours), (&mut dst.days, &src.days)] {
        for (bucket, by_scope) in from {
            for (scope, counters) in by_scope {
                let slot = to.entry(bucket.clone()).or_default().entry(scope.clone()).or_default();
                add_counters(slot, counters);
            }
        }
    }
}

fn add_counters(to: &mut Counters, from: &Counters) {
    for (key, n) in from {
        let slot = to.entry(key.clone()).or_insert(0);
        *slot = slot.saturating_add(*n);
    }
}

/// Move every counter filed under `from` to `to`.
fn rekey(stats: &mut UsageStats, from: &str, to: &str) {
    let levels: [&mut Buckets; 2] = [&mut stats.hours, &mut stats.days];
    for level in levels {
        for by_scope in level.values_mut() {
            if let Some(counters) = by_scope.remove(from) {
                add_counters(by_scope.entry(to.to_string()).or_default(), &counters);
            }
        }
    }
}

// ── Record parsing ─────────────────────────────────────────────────────────

/// `(UTC hour bucket, epoch ms)` of an RFC 3339 stamp, or `None` when it is
/// unparseable, before the epoch, or more than a day in the future.
fn stamp(ts: &str, now_ms: i64) -> Option<(String, i64)> {
    let ms = chrono::DateTime::parse_from_rfc3339(ts).ok()?.timestamp_millis();
    stamp_ms(ms, now_ms)
}

fn stamp_ms(ms: i64, now_ms: i64) -> Option<(String, i64)> {
    if ms < 0 || ms > now_ms.saturating_add(FUTURE_SLACK_MS) {
        return None;
    }
    let at = chrono::DateTime::from_timestamp_millis(ms)?;
    Some((at.format("%Y-%m-%dT%H").to_string(), ms))
}

/// A per-message count: a non-negative integer no bigger than
/// [`MAX_PER_MESSAGE`], else nothing.
fn count(value: Option<&Value>) -> u64 {
    value
        .and_then(Value::as_u64)
        .filter(|n| *n <= MAX_PER_MESSAGE)
        .unwrap_or(0)
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

fn model_or_unknown(raw: Option<&str>) -> String {
    raw.and_then(clean_model_name)
        .unwrap_or_else(|| UNKNOWN_MODEL.to_string())
}

#[derive(Deserialize)]
struct ClaudeRecord {
    timestamp: Option<String>,
    #[serde(rename = "requestId")]
    request_id: Option<String>,
    message: Option<ClaudeMessage>,
}

#[derive(Deserialize)]
struct ClaudeMessage {
    id: Option<String>,
    model: Option<Value>,
    usage: Option<Value>,
}

/// What identifies one Claude API message across its repeated lines.
fn dedupe_key(id: Option<&str>, request: Option<&str>) -> Option<String> {
    let (id, request) = (id.unwrap_or(""), request.unwrap_or(""));
    if id.is_empty() && request.is_empty() {
        return None;
    }
    Some(format!("{id}\u{1f}{request}").chars().take(MAX_KEY_CHARS).collect())
}

/// Fold one line of a Claude transcript into its cursor.
///
/// The same message is written once per content block with the same id; its
/// `output_tokens` can still grow across those lines (the first is written
/// mid-stream — 1 in 30 duplicates on live transcripts), so each field counts
/// the largest value seen for the message, not the first and not the sum.
fn claude_line(cursor: &mut Cursor, cutoff_ms: Option<i64>, now_ms: i64, sub: bool, line: &[u8]) {
    if !contains(line, b"\"usage\"") {
        return;
    }
    let Ok(record) = serde_json::from_slice::<ClaudeRecord>(line) else {
        return;
    };
    let Some(message) = record.message else { return };
    let Some(usage) = message.usage.as_ref().and_then(Value::as_object) else {
        return;
    };
    let raw_model = message.model.as_ref().and_then(Value::as_str);
    if raw_model == Some(SYNTHETIC_MODEL) {
        return;
    }
    let Some((hour, ms)) = record.timestamp.as_deref().and_then(|t| stamp(t, now_ms)) else {
        return;
    };
    // Seeded history: the user's pre-Tabtivity transcripts copied into this home.
    if cutoff_ms.is_some_and(|cutoff| ms < cutoff) {
        return;
    }
    let n = [
        count(usage.get("input_tokens")),
        count(usage.get("cache_creation_input_tokens")),
        count(usage.get("cache_read_input_tokens")),
        count(usage.get("output_tokens")),
    ];
    let lifetimes = usage.get("cache_creation");
    let w = [
        count(lifetimes.and_then(|c| c.get("ephemeral_5m_input_tokens"))),
        count(lifetimes.and_then(|c| c.get("ephemeral_1h_input_tokens"))),
    ];
    let key = dedupe_key(message.id.as_deref(), record.request_id.as_deref());
    if let Some(seen) = key
        .as_ref()
        .and_then(|key| cursor.recent.iter_mut().find(|r| &r.key == key))
    {
        let grow = |new: u64, old: &mut u64| {
            let delta = new.saturating_sub(*old);
            *old = (*old).max(new);
            delta
        };
        let mut dn = [0; 4];
        for ((d, new), old) in dn.iter_mut().zip(n).zip(seen.n.iter_mut()) {
            *d = grow(new, old);
        }
        let mut dw = [0; 2];
        for ((d, new), old) in dw.iter_mut().zip(w).zip(seen.w.iter_mut()) {
            *d = grow(new, old);
        }
        let (hour, model) = (seen.hour.clone(), seen.model.clone());
        claude_add(cursor, &hour, &model, dn, dw, sub);
        return;
    }
    let model = model_or_unknown(raw_model);
    claude_add(cursor, &hour, &model, n, w, sub);
    if let Some(key) = key {
        cursor.recent.push_back(Recent { key, hour, model, n, w });
        while cursor.recent.len() > DEDUPE_WINDOW {
            cursor.recent.pop_front();
        }
    }
}

/// File one Claude message's counts: the split, its cache writes by lifetime,
/// and — from a subagent's transcript — the split again as the subagents' part.
fn claude_add(cursor: &mut Cursor, hour: &str, model: &str, n: [u64; 4], w: [u64; 2], sub: bool) {
    for (prefix, value) in SPLIT.iter().zip(n) {
        cursor.add(hour, prefix, CLAUDE, model, value);
    }
    for (prefix, value) in LIFETIME.iter().zip(w) {
        cursor.add(hour, prefix, CLAUDE, model, value);
    }
    if sub {
        for (prefix, value) in SUB.iter().zip(n) {
            cursor.add(hour, prefix, CLAUDE, model, value);
        }
    }
}

#[derive(Deserialize)]
struct CodexRecord {
    timestamp: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
    payload: Option<CodexPayload>,
}

#[derive(Deserialize)]
struct CodexPayload {
    #[serde(rename = "type")]
    kind: Option<Value>,
    model: Option<Value>,
    info: Option<Value>,
}

/// `total_token_usage` as `[input, cached, cache_write, output]`. Input and
/// output must be there; the cache fields are absent in older releases.
fn codex_total(usage: &Value) -> Option<[u64; 4]> {
    let field = |name: &str, required: bool| -> Option<u64> {
        match usage.get(name) {
            None if !required => Some(0),
            value => value?.as_u64().filter(|n| *n <= MAX_TOTAL),
        }
    };
    Some([
        field("input_tokens", true)?,
        field("cached_input_tokens", false)?,
        field("cache_write_input_tokens", false)?,
        field("output_tokens", true)?,
    ])
}

/// Fold one line of a Codex rollout into its cursor.
///
/// Codex can repeat a `token_count` without a new turn, so what counts is the
/// **delta of `total_token_usage`** between consecutive events; a total that
/// goes down (a new thread in the same file) restarts from zero. Codex's
/// `input_tokens` includes the cached part (OpenAI semantics), so fresh input
/// is what is left after the cache read and write are taken out.
fn codex_line(
    cursor: &mut Cursor,
    now_ms: i64,
    line: &[u8],
    db_model: &mut dyn FnMut() -> Option<String>,
) {
    if !contains(line, b"token_count")
        && !contains(line, b"turn_context")
        && !contains(line, b"session_meta")
    {
        return;
    }
    let Ok(record) = serde_json::from_slice::<CodexRecord>(line) else {
        return;
    };
    let Some(payload) = record.payload else { return };
    let named_model = || payload.model.as_ref().and_then(Value::as_str).and_then(clean_model_name);
    match record.kind.as_deref() {
        Some("turn_context") => {
            if let Some(model) = named_model() {
                cursor.model = Some(model);
            }
        }
        Some("session_meta") => {
            if let Some(model) = named_model() {
                cursor.meta_model = Some(model);
            }
        }
        Some("event_msg") if payload.kind.as_ref().and_then(Value::as_str) == Some("token_count") => {
            let Some(total) = payload
                .info
                .as_ref()
                .and_then(|info| info.get("total_token_usage"))
                .and_then(codex_total)
            else {
                return;
            };
            let previous = cursor.total.unwrap_or_default();
            let reset = total.iter().zip(previous).any(|(now, before)| *now < before);
            let base = if reset { [0; 4] } else { previous };
            cursor.total = Some(total);
            let Some((hour, _)) = record.timestamp.as_deref().and_then(|t| stamp(t, now_ms)) else {
                return;
            };
            let delta: Vec<u64> = total
                .iter()
                .zip(base)
                .map(|(now, before)| Some(now - before).filter(|d| *d <= MAX_PER_MESSAGE).unwrap_or(0))
                .collect();
            let (input, cached, cache_write, output) = (delta[0], delta[1], delta[2], delta[3]);
            if input == 0 && cached == 0 && cache_write == 0 && output == 0 {
                return;
            }
            let fresh = input.saturating_sub(cached).saturating_sub(cache_write);
            let model = cursor
                .model
                .clone()
                .or_else(|| cursor.meta_model.clone())
                .or_else(db_model)
                .unwrap_or_else(|| UNKNOWN_MODEL.to_string());
            for (prefix, value) in SPLIT.iter().zip([fresh, cache_write, cached, output]) {
                cursor.add(&hour, prefix, CODEX, &model, value);
            }
        }
        _ => {}
    }
}

// ── Streaming ──────────────────────────────────────────────────────────────

/// Bytes and files one scan may still read.
struct Budget {
    bytes: u64,
    files: usize,
}

impl Budget {
    fn exhausted(&self) -> bool {
        self.bytes == 0 || self.files == 0
    }

    fn spend(&mut self, n: usize) {
        self.bytes = self.bytes.saturating_sub(n as u64);
    }
}

/// Where a file's reading stands.
struct LinePos {
    offset: u64,
    /// Inside an oversized line: discard up to the next newline.
    skipping: bool,
}

/// Feed `on_line` every complete line of `reader` (positioned at
/// `pos.offset`) that fits in `max_line`, advancing `pos` past each one.
/// Returns whether the byte budget ran out first.
///
/// A line longer than `max_line` costs at most `max_line + 1` bytes of `buf`:
/// the rest is consumed from the reader's own buffer and dropped, and the
/// skip survives a scan boundary through `pos.skipping`. A last line with no
/// newline yet is left unread — the CLI is still writing it. A read error
/// stops early with everything before it accounted for.
fn read_lines<R: BufRead>(
    reader: &mut R,
    pos: &mut LinePos,
    max_line: usize,
    budget: &mut Budget,
    buf: &mut Vec<u8>,
    mut on_line: impl FnMut(&[u8]),
) -> bool {
    loop {
        if budget.bytes == 0 {
            return true;
        }
        if pos.skipping {
            let Ok(available) = reader.fill_buf() else { return false };
            if available.is_empty() {
                return false;
            }
            let room = usize::try_from(budget.bytes).unwrap_or(usize::MAX).min(available.len());
            let (used, done) = match available[..room].iter().position(|b| *b == b'\n') {
                Some(i) => (i + 1, true),
                None => (room, false),
            };
            reader.consume(used);
            pos.offset += used as u64;
            budget.spend(used);
            pos.skipping = !done;
            continue;
        }
        buf.clear();
        let limit = max_line as u64 + 1;
        let Ok(n) = reader.by_ref().take(limit).read_until(b'\n', buf) else {
            return false;
        };
        if n == 0 {
            return false;
        }
        if buf.last() == Some(&b'\n') {
            pos.offset += n as u64;
            budget.spend(n);
            on_line(&buf[..n - 1]);
        } else if n > max_line {
            pos.offset += n as u64;
            budget.spend(n);
            pos.skipping = true;
        } else {
            return false;
        }
    }
}

// ── Listing ────────────────────────────────────────────────────────────────

/// Counts listed files against [`MAX_LISTED`].
struct Lister {
    listed: usize,
    complete: bool,
}

impl Lister {
    fn admit(&mut self) -> bool {
        if self.listed >= MAX_LISTED {
            self.complete = false;
            return false;
        }
        self.listed += 1;
        true
    }
}

/// A single path component as a directory listing gives it; anything that
/// `home_io` would split or refuse is skipped rather than reinterpreted.
fn plain_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\\'])
}

const CLAUDE_PROJECTS: &str = ".claude/projects";
const CODEX_SESSIONS: &str = ".codex/sessions";
const CODEX_DB_KEY: &str = ".codex#thread:";

/// `<home>/.claude/projects/<slug>/<session>.jsonl` and
/// `<slug>/<session>/subagents/agent-<id>.jsonl`, home-relative.
fn list_claude(home: &Path, lister: &mut Lister) -> Vec<String> {
    let mut out = Vec::new();
    let Some(projects) = HomeDir::open_existing(home, CLAUDE_PROJECTS) else {
        return out;
    };
    for slug in projects.names().into_iter().filter(|n| plain_name(n)) {
        let slug_rel = format!("{CLAUDE_PROJECTS}/{slug}");
        // Opened by handle: a symlinked slug dir is refused here.
        let Some(slug_dir) = HomeDir::open_existing(home, &slug_rel) else {
            continue;
        };
        for name in slug_dir.names().into_iter().filter(|n| plain_name(n)) {
            if name.ends_with(".jsonl") {
                if !lister.admit() {
                    return out;
                }
                out.push(format!("{slug_rel}/{name}"));
                continue;
            }
            let sub_rel = format!("{slug_rel}/{name}/subagents");
            let Some(sub) = HomeDir::open_existing(home, &sub_rel) else {
                continue;
            };
            for agent in sub.names().into_iter().filter(|n| plain_name(n) && n.ends_with(".jsonl")) {
                if !lister.admit() {
                    return out;
                }
                out.push(format!("{sub_rel}/{agent}"));
            }
        }
    }
    out
}

/// `<home>/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, home-relative.
fn list_codex(home: &Path, lister: &mut Lister) -> Vec<String> {
    let mut out = Vec::new();
    let digits = |n: &String| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit());
    let Some(sessions) = HomeDir::open_existing(home, CODEX_SESSIONS) else {
        return out;
    };
    for year in sessions.names().into_iter().filter(digits) {
        let year_rel = format!("{CODEX_SESSIONS}/{year}");
        let Some(year_dir) = HomeDir::open_existing(home, &year_rel) else { continue };
        for month in year_dir.names().into_iter().filter(digits) {
            let month_rel = format!("{year_rel}/{month}");
            let Some(month_dir) = HomeDir::open_existing(home, &month_rel) else { continue };
            for day in month_dir.names().into_iter().filter(digits) {
                let day_rel = format!("{month_rel}/{day}");
                let Some(day_dir) = HomeDir::open_existing(home, &day_rel) else { continue };
                for name in day_dir.names() {
                    if !(plain_name(&name) && name.starts_with("rollout-") && name.ends_with(".jsonl")) {
                        continue;
                    }
                    if !lister.admit() {
                        return out;
                    }
                    out.push(format!("{day_rel}/{name}"));
                }
            }
        }
    }
    out
}

/// The thread id a rollout's name ends in (`rollout-<ts>-<uuid>.jsonl`).
fn rollout_thread_id(rel: &str) -> Option<String> {
    let stem = rel.rsplit('/').next()?.strip_suffix(".jsonl")?;
    if !stem.is_ascii() || stem.len() < 36 {
        return None;
    }
    let id = &stem[stem.len() - 36..];
    let shaped = id.char_indices().all(|(i, c)| match i {
        8 | 13 | 18 | 23 => c == '-',
        _ => c.is_ascii_hexdigit(),
    });
    shaped.then(|| id.to_ascii_lowercase())
}

/// A thread id as the SQLite store gives it, fit to be a cache key.
fn plain_thread_id(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// The home's Codex thread store, if it sits in a real `.codex` directory as a
/// regular file (never through a link the agent planted).
fn codex_db(home: &Path) -> Option<PathBuf> {
    let dir = HomeDir::open_existing(home, ".codex")?;
    let db = codex_store::state_db_in(dir.path())?;
    let name = db.file_name()?.to_str()?;
    let meta = dir.file(name)?.metadata()?;
    (meta.is_file && !meta.is_symlink).then_some(db)
}

/// One `threads` row of the SQLite fallback.
struct DbThread {
    id: String,
    tokens: u64,
    updated_ms: i64,
    model: Option<String>,
}

/// The threads of a Codex store that used tokens, read-only and best-effort
/// like the rest of `codex_store`. `None` when the store cannot be read or has
/// another shape — which must not read as "every thread is gone".
fn codex_db_threads(db: &Path) -> Option<Vec<DbThread>> {
    let conn = codex_store::open(db)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, tokens_used, coalesce(updated_at_ms, updated_at * 1000), model
               FROM threads WHERE tokens_used > 0 ORDER BY id LIMIT ?1",
        )
        .ok()?;
    let rows = stmt
        .query_map([MAX_DB_THREADS], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .ok()?;
    Some(
        rows.filter_map(Result::ok)
            .filter_map(|(id, tokens, updated, model)| {
                let tokens = u64::try_from(tokens).ok().filter(|n| *n <= MAX_TOTAL)?;
                Some(DbThread {
                    id,
                    tokens,
                    updated_ms: updated?,
                    model,
                })
            })
            .collect(),
    )
}

// ── OpenCode ───────────────────────────────────────────────────────────────

/// OpenCode's store below its home, as `opencode_store` reads it.
const OPENCODE_DB: &str = ".local/share/opencode/opencode.db";
/// Rows per query, and the most read per table in one scan (past it the scan
/// is partial and the next one carries on from the mark).
const OPENCODE_BATCH: i64 = 5_000;
const MAX_OPENCODE_ROWS: i64 = 50_000;
/// At most this many unfinished messages are remembered per table; one past
/// it is dropped (never counted, never counted twice).
const MAX_PENDING: usize = 256;
/// An unfinished message this old is given up on: a turn OpenCode never
/// closed.
const PENDING_MAX_AGE_MS: i64 = 7 * 86_400_000;
/// Rows younger than this are left for a later scan. OpenCode stamps a row as
/// it inserts it, but two OpenCodes writing one store can commit a few seconds
/// out of stamp order; a mark that ran ahead of a row not yet committed would
/// skip it for good.
const OPENCODE_SETTLE_MS: i64 = 60_000;

/// One OpenCode message table. Both formats keep the same `tokens` object
/// (`input` without the cache, `output` without `reasoning`) on an assistant
/// message, finished once `time.completed` is set.
struct OpenCodeTable {
    /// Cache-key suffix.
    tag: &'static str,
    table: &'static str,
    /// SQL that is true for an assistant message.
    assistant: &'static str,
    /// JSON path of the model id in `data`.
    model: &'static str,
}

const OPENCODE_TABLES: [OpenCodeTable; 2] = [
    // OpenCode 2: the kind is a column.
    OpenCodeTable {
        tag: "v2",
        table: "session_message",
        assistant: "type = 'assistant'",
        model: "$.model.id",
    },
    // OpenCode 1: the role is inside `data`.
    OpenCodeTable {
        tag: "v1",
        table: "message",
        assistant: "json_valid(data) AND json_extract(data, '$.role') = 'assistant'",
        model: "$.modelID",
    },
];

fn table_exists(conn: &rusqlite::Connection, table: &str) -> bool {
    conn.query_row("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1", [table], |_| Ok(()))
        .is_ok()
}

/// The columns [`OpenCodeRow`] reads, from the assistant rows of `table` that
/// match `filter`. Rows whose id or stamp has another SQL type, or an id longer
/// than a cache key may be, are never returned; malformed JSON reads as null.
fn opencode_sql(table: &OpenCodeTable, filter: &str) -> String {
    let field = |path: &str| format!("CASE WHEN json_valid(data) THEN json_extract(data, '{path}') END");
    format!(
        "SELECT id, time_created, {}, {}, {}, {}, {}, {}, {} FROM {} \
         WHERE {} AND typeof(id) = 'text' AND length(id) <= {MAX_KEY_CHARS} \
         AND typeof(time_created) = 'integer' AND {filter}",
        field("$.time.completed"),
        field(table.model),
        field("$.tokens.input"),
        field("$.tokens.output"),
        field("$.tokens.reasoning"),
        field("$.tokens.cache.read"),
        field("$.tokens.cache.write"),
        table.table,
        table.assistant,
    )
}

/// One assistant message as the store has it now.
struct OpenCodeRow {
    id: String,
    created: i64,
    finished: bool,
    model: Option<String>,
    /// In [`SPLIT`] order; reasoning is billed as output and counted there.
    n: [u64; 4],
}

fn opencode_row(row: &rusqlite::Row) -> rusqlite::Result<OpenCodeRow> {
    use rusqlite::types::Value as Sql;
    let value = |i: usize| row.get::<_, Sql>(i);
    let int = |v: Sql| match v {
        Sql::Integer(n) => u64::try_from(n).ok().filter(|n| *n <= MAX_PER_MESSAGE).unwrap_or(0),
        _ => 0,
    };
    let id = match value(0)? {
        Sql::Text(id) => id,
        _ => String::new(),
    };
    let created = match value(1)? {
        Sql::Integer(n) => n,
        _ => 0,
    };
    let finished = matches!(value(2)?, Sql::Integer(_) | Sql::Real(_));
    let model = match value(3)? {
        Sql::Text(model) => Some(model),
        _ => None,
    };
    let (input, output, reasoning) = (int(value(4)?), int(value(5)?), int(value(6)?));
    let (read, write) = (int(value(7)?), int(value(8)?));
    Ok(OpenCodeRow {
        id,
        created,
        finished,
        model,
        n: [input, write, read, output.saturating_add(reasoning)],
    })
}

/// Count `row` if it finished; `false` when it is still streaming.
fn opencode_count(cursor: &mut Cursor, row: &OpenCodeRow, now_ms: i64) -> bool {
    if !row.finished {
        return false;
    }
    if let Some((hour, _)) = stamp_ms(row.created, now_ms) {
        let model = model_or_unknown(row.model.as_deref());
        for (prefix, n) in SPLIT.iter().zip(row.n) {
            cursor.add(&hour, prefix, OPENCODE, &model, n);
        }
    }
    true
}

/// Remember an unfinished message, within the bounds.
fn opencode_pend(cursor: &mut Cursor, id: String, created: i64, now_ms: i64) {
    if now_ms.saturating_sub(created) < PENDING_MAX_AGE_MS && cursor.pending.len() < MAX_PENDING {
        cursor.pending.insert(id, created);
    }
}

/// Bring one table's cursor up to date: first the messages that were still
/// streaming, then every row past the mark in `(time_created, id)` order, up
/// to [`OPENCODE_SETTLE_MS`] ago. A row stamped in the future is left for
/// later rather than moving the mark beyond every real one. Returns whether
/// the table was read to its end.
fn opencode_table(conn: &rusqlite::Connection, table: &OpenCodeTable, cursor: &mut Cursor, now_ms: i64) -> bool {
    let pending = std::mem::take(&mut cursor.pending);
    if !pending.is_empty() {
        let Ok(mut stmt) = conn.prepare(&opencode_sql(table, "id = ?1")) else {
            cursor.pending = pending;
            return false;
        };
        for (id, created) in pending {
            match stmt.query_row([&id], opencode_row) {
                Ok(row) => {
                    if !opencode_count(cursor, &row, now_ms) {
                        opencode_pend(cursor, id, created, now_ms);
                    }
                }
                // Deleted with its session: nothing more to count.
                Err(rusqlite::Error::QueryReturnedNoRows) => {}
                Err(_) => opencode_pend(cursor, id, created, now_ms),
            }
        }
    }
    let sql = opencode_sql(
        table,
        "(time_created > ?1 OR (time_created = ?1 AND id > ?2)) AND time_created <= ?3 \
         ORDER BY time_created, id LIMIT ?4",
    );
    let Ok(mut stmt) = conn.prepare(&sql) else { return false };
    let horizon = now_ms.saturating_sub(OPENCODE_SETTLE_MS);
    let mut read = 0;
    loop {
        let (after, after_id) = cursor.mark.clone().unwrap_or((i64::MIN, String::new()));
        let rows = stmt
            .query_map(rusqlite::params![after, after_id, horizon, OPENCODE_BATCH], opencode_row)
            .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>());
        // Interrupted (the deadline) or unreadable: the mark stays put.
        let Ok(rows) = rows else { return false };
        let got = rows.len() as i64;
        for row in rows {
            if !opencode_count(cursor, &row, now_ms) {
                opencode_pend(cursor, row.id.clone(), row.created, now_ms);
            }
            cursor.mark = Some((row.created, row.id));
        }
        read += got;
        if got < OPENCODE_BATCH {
            return true;
        }
        if read >= MAX_OPENCODE_ROWS {
            return false;
        }
    }
}

// ── Copilot CLI ────────────────────────────────────────────────────────────

/// Copilot CLI's store below its home, and the table that logs every model
/// call with its tokens.
const COPILOT_DB: &str = ".copilot/session-store.db";
const COPILOT_TABLE: &str = "assistant_usage_events";

/// Count the usage rows past the mark. A row is written once, when its call
/// is done, under an `AUTOINCREMENT` id, so the id alone is the cursor.
/// `input_tokens` includes the cache read and write (as the call's billing
/// detail splits it); `output_tokens` includes reasoning. Returns whether the
/// table was read to its end.
fn copilot_table(conn: &rusqlite::Connection, cursor: &mut Cursor, now_ms: i64) -> bool {
    use rusqlite::types::Value as Sql;
    let Ok(mut stmt) = conn.prepare(
        "SELECT id, created_at, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens \
         FROM assistant_usage_events WHERE id > ?1 ORDER BY id LIMIT ?2",
    ) else {
        return false;
    };
    let mut read = 0;
    loop {
        let after = cursor.mark.as_ref().map_or(0, |(id, _)| *id);
        let rows = stmt
            .query_map(rusqlite::params![after, OPENCODE_BATCH], |row| {
                let value = |i: usize| row.get::<_, Sql>(i);
                let int = |v: Sql| match v {
                    Sql::Integer(n) => u64::try_from(n).ok().filter(|n| *n <= MAX_PER_MESSAGE).unwrap_or(0),
                    _ => 0,
                };
                let text = |v: Sql| match v {
                    Sql::Text(t) => Some(t),
                    _ => None,
                };
                let id = match value(0)? {
                    Sql::Integer(n) => n,
                    _ => after,
                };
                Ok((
                    id,
                    text(value(1)?),
                    text(value(2)?),
                    [int(value(3)?), int(value(4)?), int(value(5)?), int(value(6)?)],
                ))
            })
            .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>());
        let Ok(rows) = rows else { return false };
        let got = rows.len() as i64;
        for (id, at, model, [input, output, read_n, write]) in rows {
            if id <= after {
                continue;
            }
            cursor.mark = Some((id, String::new()));
            let Some((hour, _)) = at.as_deref().and_then(|t| stamp(t, now_ms)) else { continue };
            let model = model_or_unknown(model.as_deref());
            let fresh = input.saturating_sub(read_n).saturating_sub(write);
            for (prefix, value) in SPLIT.iter().zip([fresh, write, read_n, output]) {
                cursor.add(&hour, prefix, COPILOT, &model, value);
            }
        }
        read += got;
        if got < OPENCODE_BATCH {
            return true;
        }
        if read >= MAX_OPENCODE_ROWS {
            return false;
        }
    }
}

// ── Gemini CLI ─────────────────────────────────────────────────────────────

/// Gemini CLI's per-project folders below its home; each has a `chats`
/// folder of session files, and subagents a folder per parent session in it.
const GEMINI_TMP: &str = ".gemini/tmp";
/// A session file larger than this is not read.
const GEMINI_MAX_FILE: u64 = 64 << 20;

/// `<home>/.gemini/tmp/<project>/chats/<session>.jsonl`, the subagents'
/// `chats/<parent>/<id>.jsonl`, and legacy `chats/<session>.json` files that
/// have no `.jsonl` beside them, home-relative. Gemini migrates a legacy file
/// on resume by appending its whole content to `<name>.jsonl` and leaves the
/// `.json` behind: those are returned apart, as superseded, so what they
/// counted is dropped rather than retired and counted again.
fn list_gemini(home: &Path, lister: &mut Lister) -> (Vec<String>, Vec<String>) {
    let mut out = Vec::new();
    let mut superseded = Vec::new();
    let Some(tmp) = HomeDir::open_existing(home, GEMINI_TMP) else {
        return (out, superseded);
    };
    for project in tmp.names().into_iter().filter(|n| plain_name(n)) {
        let chats_rel = format!("{GEMINI_TMP}/{project}/chats");
        let Some(chats) = HomeDir::open_existing(home, &chats_rel) else { continue };
        let names: HashSet<String> = chats.names().into_iter().filter(|n| plain_name(n)).collect();
        let mut sorted: Vec<&String> = names.iter().collect();
        sorted.sort();
        for name in sorted {
            if name.ends_with(".json") && names.contains(&format!("{name}l")) {
                superseded.push(format!("{chats_rel}/{name}"));
                continue;
            }
            if name.ends_with(".jsonl") || name.ends_with(".json") {
                if !lister.admit() {
                    return (out, superseded);
                }
                out.push(format!("{chats_rel}/{name}"));
                continue;
            }
            let sub_rel = format!("{chats_rel}/{name}");
            let Some(sub) = HomeDir::open_existing(home, &sub_rel) else { continue };
            for agent in sub.names().into_iter().filter(|n| plain_name(n) && n.ends_with(".jsonl")) {
                if !lister.admit() {
                    return (out, superseded);
                }
                out.push(format!("{sub_rel}/{agent}"));
            }
        }
    }
    (out, superseded)
}

/// One Gemini message's tokens in [`SPLIT`] order. `input` is the prompt with
/// its cached part included; tool-use prompt tokens are fresh input too, and
/// thoughts are billed as output. Implicit caching has no write.
fn gemini_tokens(tokens: &Value) -> Option<[u64; 4]> {
    let fields = tokens.as_object()?;
    let field = |name: &str| count(fields.get(name));
    let input = field("input");
    let cached = field("cached").min(input);
    Some([
        (input - cached).saturating_add(field("tool")),
        0,
        cached,
        field("output").saturating_add(field("thoughts")),
    ])
}

/// What one session file counts: message id → `(hour, model, tokens)`.
type GeminiMessages = HashMap<String, (String, String, [u64; 4])>;

/// Fold one message record into `out` when it is a model turn with tokens.
fn gemini_message(message: &Value, now_ms: i64, out: &mut GeminiMessages) {
    if message.get("type").and_then(Value::as_str) != Some("gemini") {
        return;
    }
    let Some(id) = message.get("id").and_then(Value::as_str).filter(|id| !id.is_empty()) else {
        return;
    };
    let Some(n) = message.get("tokens").and_then(gemini_tokens) else { return };
    let Some((hour, _)) = message.get("timestamp").and_then(Value::as_str).and_then(|t| stamp(t, now_ms)) else {
        return;
    };
    let model = model_or_unknown(message.get("model").and_then(Value::as_str));
    out.insert(id.chars().take(MAX_KEY_CHARS).collect(), (hour, model, n));
}

/// Every counted message of a session file: a legacy JSON object's
/// `messages`, or the records of a JSONL file (message lines, and the
/// `messages` a metadata line carries). A rewind or removal does not take a
/// message back out — its tokens were spent. `None` when the file could not
/// be read.
fn gemini_messages(handle: std::fs::File, legacy: bool, len: u64, max_line: usize, now_ms: i64) -> Option<GeminiMessages> {
    let mut out = GeminiMessages::new();
    let mut fold = |value: &Value| {
        let messages = value.get("$set").unwrap_or(value).get("messages").and_then(Value::as_array);
        for message in messages.into_iter().flatten() {
            gemini_message(message, now_ms, &mut out);
        }
        if value.get("id").is_some() {
            gemini_message(value, now_ms, &mut out);
        }
    };
    if legacy {
        let mut text = Vec::new();
        handle.take(len).read_to_end(&mut text).ok()?;
        fold(&serde_json::from_slice::<Value>(&text).ok()?);
    } else {
        let mut reader = BufReader::new(handle);
        let mut pos = LinePos { offset: 0, skipping: false };
        let mut budget = Budget { bytes: len, files: 1 };
        let mut buf = Vec::new();
        read_lines(&mut reader, &mut pos, max_line, &mut budget, &mut buf, |line| {
            if !contains(line, b"\"tokens\"") {
                return;
            }
            if let Ok(value) = serde_json::from_slice::<Value>(line) {
                fold(&value);
            }
        });
    }
    Some(out)
}

// ── The scan ───────────────────────────────────────────────────────────────

/// One home, as the scan sees it.
struct HomeCtx {
    dir: PathBuf,
    /// The home's directory name — the first segment of its cache keys.
    name: String,
    scope: String,
    /// Claude records older than this are seeded history.
    claude_cutoff_ms: Option<i64>,
    codex_db: Option<PathBuf>,
}

struct Scan<'a> {
    cache: &'a mut Cache,
    limits: Limits,
    now_ms: i64,
    budget: Budget,
    lister: Lister,
    /// Cache keys whose source still exists.
    seen: HashSet<String>,
    partial: bool,
    buf: Vec<u8>,
}

impl Scan<'_> {
    fn home(&mut self, ctx: &HomeCtx) {
        for rel in list_claude(&ctx.dir, &mut self.lister) {
            self.file(ctx, &rel, Kind::Claude);
        }
        for rel in list_codex(&ctx.dir, &mut self.lister) {
            if let Some(id) = rollout_thread_id(&rel) {
                if self.cache.rollout_threads.len() < MAX_ROLLOUT_THREADS {
                    self.cache.rollout_threads.insert(id);
                }
            }
            self.file(ctx, &rel, Kind::Codex);
        }
        self.codex_fallback(ctx);
        self.opencode(ctx);
        self.copilot(ctx);
        let (gemini, superseded) = list_gemini(&ctx.dir, &mut self.lister);
        for rel in superseded {
            // Its `.jsonl` holds every message it did: counted there.
            self.cache.files.remove(&format!("{}/{rel}", ctx.name));
        }
        for rel in gemini {
            self.gemini_file(ctx, &rel);
        }
    }

    /// Read what is new in one source file.
    fn file(&mut self, ctx: &HomeCtx, rel: &str, kind: Kind) {
        let key = format!("{}/{rel}", ctx.name);
        self.seen.insert(key.clone());
        let Some(file) = HomeFile::open_existing(&ctx.dir, rel) else { return };
        let Some(meta) = file.metadata() else { return };
        // A symlinked transcript is not followed — not even to a file inside
        // the home, which would then count twice.
        if meta.is_symlink || !meta.is_file {
            return;
        }
        let cursor = self
            .cache
            .files
            .entry(key)
            .or_insert_with(|| Cursor::new(kind, &ctx.scope));
        cursor.adopt_scope(&ctx.scope);
        let replaced = cursor.kind != kind
            || (cursor.ino.is_some() && meta.ino.is_some() && cursor.ino != meta.ino)
            || meta.len < cursor.offset
            // Counted before the lifetime and subagent details existed.
            || (kind == Kind::Claude && !cursor.detail);
        if replaced {
            // Shorter, or another file under the old name: drop what it
            // contributed and read it again from the start.
            *cursor = Cursor::new(kind, &ctx.scope);
        }
        if meta.len == cursor.len {
            return;
        }
        if self.budget.exhausted() {
            self.partial = true;
            return;
        }
        let Some(handle) = file.open_read() else { return };
        self.budget.files -= 1;
        let mut reader = BufReader::new(handle);
        if reader.seek(SeekFrom::Start(cursor.offset)).is_err() {
            return;
        }
        cursor.ino = meta.ino;
        let mut pos = LinePos {
            offset: cursor.offset,
            skipping: cursor.skipping,
        };
        let (max_line, now_ms) = (self.limits.max_line, self.now_ms);
        // `<slug>/<session>/subagents/agent-<id>.jsonl` (see `list_claude`).
        let sub = rel.contains("/subagents/");
        let exhausted = match kind {
            Kind::Claude => read_lines(&mut reader, &mut pos, max_line, &mut self.budget, &mut self.buf, |line| {
                claude_line(cursor, ctx.claude_cutoff_ms, now_ms, sub, line)
            }),
            Kind::Codex => {
                // The thread store is opened only when a rollout names no
                // model at all, and then once per file.
                let mut looked_up: Option<Option<String>> = None;
                let thread = rollout_thread_id(rel);
                let mut db_model = || {
                    looked_up
                        .get_or_insert_with(|| {
                            let db = ctx.codex_db.as_deref()?;
                            codex_store::thread_model(db, thread.as_deref()?)
                        })
                        .clone()
                };
                read_lines(&mut reader, &mut pos, max_line, &mut self.budget, &mut self.buf, |line| {
                    codex_line(cursor, now_ms, line, &mut db_model)
                })
            }
            Kind::CodexDb | Kind::OpenCode | Kind::Gemini | Kind::Copilot => false,
        };
        cursor.offset = pos.offset;
        cursor.skipping = pos.skipping;
        // Stopped early: remember where, so the next scan sees work left.
        cursor.len = if exhausted { pos.offset } else { meta.len };
        if exhausted {
            self.partial = true;
        }
    }

    /// Threads of the home's Codex store that have no rollout, counted from
    /// `threads.tokens_used` — a single total with no split, bucketed when the
    /// thread was last updated.
    fn codex_fallback(&mut self, ctx: &HomeCtx) {
        let prefix = format!("{}/{CODEX_DB_KEY}", ctx.name);
        let rows = ctx.codex_db.as_deref().and_then(codex_db_threads);
        let Some(rows) = rows else {
            if ctx.codex_db.is_some() {
                // Locked or reshaped for now: keep what was counted.
                self.keep_seen(&prefix);
            }
            return;
        };
        for row in rows {
            let id = row.id.to_ascii_lowercase();
            if !plain_thread_id(&id) {
                continue;
            }
            let key = format!("{prefix}{id}");
            if self.cache.rollout_threads.contains(&id) {
                // The rollout counts this thread, split and all.
                self.cache.files.remove(&key);
                continue;
            }
            self.seen.insert(key.clone());
            let Some((hour, _)) = stamp_ms(row.updated_ms, self.now_ms) else {
                continue;
            };
            let cursor = self
                .cache
                .files
                .entry(key)
                .or_insert_with(|| Cursor::new(Kind::CodexDb, &ctx.scope));
            cursor.adopt_scope(&ctx.scope);
            if row.tokens > cursor.counted {
                let delta = row.tokens - cursor.counted;
                cursor.counted = row.tokens;
                let model = model_or_unknown(row.model.as_deref());
                cursor.add(&hour, metric::TOKENS_TOTAL, CODEX, &model, delta);
            }
        }
    }

    /// The assistant messages of the home's OpenCode store that finished since
    /// the last scan, one cursor per message table.
    fn opencode(&mut self, ctx: &HomeCtx) {
        let tables: Vec<&str> = OPENCODE_TABLES.iter().map(|t| t.table).collect();
        let Some((conn, meta)) = self.open_store(ctx, OPENCODE_DB, &tables) else { return };
        let now_ms = self.now_ms;
        for table in &OPENCODE_TABLES {
            if !table_exists(&conn, table.table) {
                continue;
            }
            let cursor = self.store_cursor(ctx, OPENCODE_DB, table.tag, Kind::OpenCode, &meta);
            if !opencode_table(&conn, table, cursor, now_ms) {
                self.partial = true;
            }
        }
    }

    /// The model calls the home's Copilot CLI logged since the last scan.
    fn copilot(&mut self, ctx: &HomeCtx) {
        let Some((conn, meta)) = self.open_store(ctx, COPILOT_DB, &[COPILOT_TABLE]) else { return };
        if !table_exists(&conn, COPILOT_TABLE) {
            return;
        }
        let now_ms = self.now_ms;
        let cursor = self.store_cursor(ctx, COPILOT_DB, "usage", Kind::Copilot, &meta);
        if !copilot_table(&conn, cursor, now_ms) {
            self.partial = true;
        }
    }

    /// A SQLite store an agent keeps at `rel` in the home, opened read-only
    /// through `agent_sqlite`, with its file's metadata. `None` when there is
    /// nothing to read now: a store that is gone lets its cursors retire, one
    /// that is locked or unreadable keeps them.
    fn open_store(&mut self, ctx: &HomeCtx, rel: &str, tables: &[&str]) -> Option<(rusqlite::Connection, Meta)> {
        let prefix = format!("{}/{rel}#", ctx.name);
        // SQLite's NOFOLLOW refuses a link anywhere in the path it is handed,
        // so the home — Tabtivity's own, where a link in its prefix (macOS's
        // `/var` → `/private/var` temp dir) is not the agent's doing — is
        // resolved first, as `HomeFile::open_below` does; below it, a link is
        // still refused component by component.
        #[cfg(unix)]
        let home = std::fs::canonicalize(&ctx.dir).ok()?;
        #[cfg(not(unix))]
        let home = ctx.dir.clone();
        let file = HomeFile::open_existing(&home, rel)?;
        let meta = match file.lstat() {
            Ok(meta) => meta,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
            Err(_) => {
                self.keep_seen(&prefix);
                return None;
            }
        };
        // Never through a link, not even to a store inside the home.
        if meta.is_symlink || !meta.is_file {
            return None;
        }
        match agent_sqlite::open_read(&file, agent_sqlite::Limits::STORE, tables) {
            Some(conn) => Some((conn, meta)),
            None => {
                self.keep_seen(&prefix);
                None
            }
        }
    }

    /// The cursor of one table (`tag`) of the store at `rel`, marked seen,
    /// filed under the home's scope, and started over when the store file was
    /// replaced.
    fn store_cursor(&mut self, ctx: &HomeCtx, rel: &str, tag: &str, kind: Kind, meta: &Meta) -> &mut Cursor {
        let key = format!("{}/{rel}#{tag}", ctx.name);
        self.seen.insert(key.clone());
        let cursor = self.cache.files.entry(key).or_insert_with(|| Cursor::new(kind, &ctx.scope));
        cursor.adopt_scope(&ctx.scope);
        let replaced = cursor.kind != kind || (cursor.ino.is_some() && meta.ino.is_some() && cursor.ino != meta.ino);
        if replaced {
            *cursor = Cursor::new(kind, &ctx.scope);
        }
        cursor.ino = meta.ino;
        cursor
    }

    /// Re-read one Gemini session file whenever it changed and put what it
    /// holds in place of what it contributed before. Gemini appends a message
    /// again in full whenever it changes (its tool calls finish, its tokens
    /// arrive), possibly far down the file, so the file is folded as a whole:
    /// each message id counted once, with the tokens of its last record that
    /// has any. A file only partly readable in this scan's budget is left as
    /// it was for the next one.
    fn gemini_file(&mut self, ctx: &HomeCtx, rel: &str) {
        let key = format!("{}/{rel}", ctx.name);
        self.seen.insert(key.clone());
        let Some(file) = HomeFile::open_existing(&ctx.dir, rel) else { return };
        let Some(meta) = file.metadata() else { return };
        if meta.is_symlink || !meta.is_file || meta.len > GEMINI_MAX_FILE {
            return;
        }
        let cursor = self
            .cache
            .files
            .entry(key)
            .or_insert_with(|| Cursor::new(Kind::Gemini, &ctx.scope));
        cursor.adopt_scope(&ctx.scope);
        let replaced = cursor.kind != Kind::Gemini || (cursor.ino.is_some() && meta.ino.is_some() && cursor.ino != meta.ino);
        if !replaced && meta.len == cursor.len {
            return;
        }
        if self.budget.files == 0 || self.budget.bytes < meta.len {
            self.partial = true;
            return;
        }
        let Some(handle) = file.open_read() else { return };
        self.budget.files -= 1;
        self.budget.spend(usize::try_from(meta.len).unwrap_or(usize::MAX));
        let legacy = rel.ends_with(".json");
        let Some(messages) = gemini_messages(handle, legacy, meta.len, self.limits.max_line, self.now_ms) else {
            return;
        };
        let mut fresh = Cursor::new(Kind::Gemini, &ctx.scope);
        for (hour, model, n) in messages.into_values() {
            for (prefix, value) in SPLIT.iter().zip(n) {
                fresh.add(&hour, prefix, GEMINI, &model, value);
            }
        }
        fresh.ino = meta.ino;
        fresh.len = meta.len;
        *cursor = fresh;
    }

    /// Count every cached source under `prefix` as still there.
    fn keep_seen(&mut self, prefix: &str) {
        let kept: Vec<String> = self
            .cache
            .files
            .range(prefix.to_string()..)
            .take_while(|(key, _)| key.starts_with(prefix))
            .map(|(key, _)| key.clone())
            .collect();
        self.seen.extend(kept);
    }

    /// Move the contribution of every source that is gone into `retired`.
    fn retire_unseen(&mut self) {
        if !self.lister.complete {
            return;
        }
        let gone: Vec<String> = self
            .cache
            .files
            .keys()
            .filter(|key| !self.seen.contains(*key))
            .cloned()
            .collect();
        for key in gone {
            if let Some(cursor) = self.cache.files.remove(&key) {
                merge_into(&mut self.cache.retired, &cursor.contribution);
            }
        }
    }
}

/// The earliest seeded-marker mtime this home has shown (epoch ms).
fn seed_cutoff(cache: &mut Cache, home: &Path, name: &str) -> Option<i64> {
    let marker_ms = HomeFile::open_existing(home, agent_home::SEEDED_MARKER)
        .and_then(|f| f.open_read())
        .and_then(|f| f.metadata().ok())
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|d| i64::try_from(d.as_millis()).ok());
    let earliest = match (marker_ms, cache.seed_cutoff_ms.get(name).copied()) {
        (Some(now), Some(before)) => Some(now.min(before)),
        (now, before) => now.or(before),
    };
    if let Some(ms) = earliest {
        cache.seed_cutoff_ms.insert(name.to_string(), ms);
    }
    earliest
}

static SCAN_LOCK: Mutex<()> = Mutex::new(());

/// Bring the cache up to date with every agent home under `state_dir` and
/// return the token counters of every scope.
///
/// `scopes` are the known scope ids (projects, `box:<id>`s, the root); each
/// one's homes are [`agent_home::scope_home_in`] and its local-model home
/// ([`agent_home::local_model_home_in`]). A home of no known scope (a
/// removed project) and the Host session's home count as the root scope.
pub fn scan(state_dir: &Path, scopes: &[String]) -> TokenStats {
    scan_with(state_dir, scopes, Limits::default(), crate::clock::now_ms() as i64)
}

/// [`scan`] with explicit limits and clock.
pub fn scan_with(state_dir: &Path, scopes: &[String], limits: Limits, now_ms: i64) -> TokenStats {
    // Two recap windows opening at once must not interleave their cursors.
    let _guard = SCAN_LOCK.lock_ok();
    let path = state_dir.join(CACHE_FILE);
    let mut cache = load_cache(&path);
    // A scope's local-model home counts toward the scope, like its own. The
    // chat assistant's is always one, whoever called: its homes are not a
    // removed project's and must not read as the root console's.
    let by_home: HashMap<PathBuf, &str> = scopes
        .iter()
        .map(String::as_str)
        .chain(std::iter::once(storage::ASSISTANT_SCOPE))
        .flat_map(|id| {
            [agent_home::scope_home_in(state_dir, id), agent_home::local_model_home_in(state_dir, id)]
                .map(|home| (home, id))
        })
        .collect();
    let host = agent_home::host_home_in(state_dir);

    let mut homes = Vec::new();
    for dir in agent_home::existing_homes_in(state_dir) {
        let Some(name) = dir.file_name().and_then(|n| n.to_str()).map(str::to_string) else {
            continue;
        };
        // The probe home's runs (a warm-up, `/usage`) are no scope's: counted
        // as the root console's they would credit tokens to a scope the user
        // never ran. They were never counted before the probe home existed.
        if agent_home::is_probe_home(&dir) {
            continue;
        }
        let scope = match by_home.get(&dir) {
            Some(id) if dir != host => (*id).to_string(),
            _ => storage::ROOT_SCOPE.to_string(),
        };
        let claude_cutoff_ms = seed_cutoff(&mut cache, &dir, &name);
        let codex_db = codex_db(&dir);
        homes.push(HomeCtx {
            dir,
            name,
            scope,
            claude_cutoff_ms,
            codex_db,
        });
    }

    let mut scan = Scan {
        cache: &mut cache,
        limits,
        now_ms,
        budget: Budget {
            bytes: limits.max_bytes,
            files: limits.max_files,
        },
        lister: Lister {
            listed: 0,
            complete: true,
        },
        seen: HashSet::new(),
        partial: false,
        buf: Vec::new(),
    };
    for ctx in &homes {
        scan.home(ctx);
    }
    scan.retire_unseen();
    let partial = scan.partial;

    cache.retired.prune();
    for cursor in cache.files.values_mut() {
        cursor.contribution.prune();
    }
    cache.version = CACHE_VERSION;
    if let Err(e) = storage::write_json_atomic(&path, &cache) {
        eprintln!("token_stats: write {}: {e}", path.display());
    }

    let mut stats = cache.retired.clone();
    for cursor in cache.files.values() {
        merge_into(&mut stats, &cursor.contribution);
    }
    stats.prune();
    TokenStats { stats, partial }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;

    const NOW: &str = "2026-10-01T12:00:00Z";

    fn now() -> i64 {
        chrono::DateTime::parse_from_rfc3339(NOW).unwrap().timestamp_millis()
    }

    fn claude(id: &str, req: &str, model: &str, ts: &str, n: [u64; 4]) -> String {
        let record = json!({
            "type": "assistant",
            "timestamp": ts,
            "requestId": req,
            "message": {
                "id": id,
                "model": model,
                "role": "assistant",
                "content": [{"type": "text", "text": "hello"}],
                "usage": {
                    "input_tokens": n[0],
                    "cache_creation_input_tokens": n[1],
                    "cache_read_input_tokens": n[2],
                    "output_tokens": n[3],
                    "output_tokens_details": {"thinking_tokens": 0}
                }
            }
        });
        format!("{record}\n")
    }

    fn turn_context(model: &str, ts: &str) -> String {
        format!("{}\n", json!({"timestamp": ts, "type": "turn_context", "payload": {"model": model, "cwd": "/x"}}))
    }

    /// `[input, cached, cache_write, output]` totals.
    fn token_count(ts: &str, t: [u64; 4]) -> String {
        let usage = json!({
            "input_tokens": t[0], "cached_input_tokens": t[1],
            "cache_write_input_tokens": t[2], "output_tokens": t[3],
            "reasoning_output_tokens": 0, "total_tokens": t[0] + t[3]
        });
        let record = json!({
            "timestamp": ts,
            "type": "event_msg",
            "payload": {"type": "token_count", "info": {"total_token_usage": usage, "last_token_usage": usage}}
        });
        format!("{record}\n")
    }

    const ROLLOUT: &str = "rollout-2026-09-30T10-00-00-01a0e229-bfa7-72f2-ae4b-de4b5d33e12f.jsonl";
    const ROLLOUT_ID: &str = "01a0e229-bfa7-72f2-ae4b-de4b5d33e12f";

    fn claude_path(state: &Path, scope: &str, rel: &str) -> PathBuf {
        agent_home::scope_home_in(state, scope)
            .join(".claude/projects/-home-u-p")
            .join(rel)
    }

    fn codex_path(state: &Path, scope: &str, name: &str) -> PathBuf {
        agent_home::scope_home_in(state, scope)
            .join(".codex/sessions/2026/09/30")
            .join(name)
    }

    fn write(path: &Path, lines: &[String]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, lines.concat()).unwrap();
    }

    fn append(path: &Path, lines: &[String]) {
        let mut file = std::fs::OpenOptions::new().append(true).open(path).unwrap();
        file.write_all(lines.concat().as_bytes()).unwrap();
    }

    fn scopes() -> Vec<String> {
        vec!["p1".into(), storage::ROOT_SCOPE.into()]
    }

    fn run(state: &Path) -> TokenStats {
        scan_with(state, &scopes(), Limits::default(), now())
    }

    /// `key` summed over every day of `scope` (every scope when empty).
    fn total(stats: &TokenStats, scope: &str, key: &str) -> u64 {
        stats
            .stats
            .daily_for(scope)
            .values()
            .filter_map(|c| c.get(key))
            .sum()
    }

    fn ck(prefix: &str, model: &str) -> String {
        token_key(prefix, CLAUDE, model)
    }

    fn xk(prefix: &str, model: &str) -> String {
        token_key(prefix, CODEX, model)
    }

    const OPUS: &str = "claude-opus-5";
    const T1: &str = "2026-09-30T10:15:00.000Z";
    const T2: &str = "2026-09-30T11:20:00.000Z";

    #[test]
    fn claude_duplicate_lines_count_once_at_their_largest() {
        let tmp = tempfile::tempdir().unwrap();
        let path = claude_path(tmp.path(), "p1", "s.jsonl");
        write(
            &path,
            &[
                // One message, three content blocks; the first line was written
                // mid-stream with a smaller output count.
                claude("msg_1", "req_1", OPUS, T1, [2, 100, 1000, 7]),
                claude("msg_1", "req_1", OPUS, T1, [2, 100, 1000, 188]),
                claude("msg_1", "req_1", OPUS, T1, [2, 100, 1000, 188]),
                claude("msg_2", "req_2", OPUS, T2, [3, 0, 1100, 50]),
            ],
        );
        let stats = run(tmp.path());
        assert_eq!(total(&stats, "p1", &ck(metric::TOKENS_IN, OPUS)), 5);
        assert_eq!(total(&stats, "p1", &ck(metric::TOKENS_CACHE_W, OPUS)), 100);
        assert_eq!(total(&stats, "p1", &ck(metric::TOKENS_CACHE_R, OPUS)), 2100);
        assert_eq!(total(&stats, "p1", &ck(metric::TOKENS_OUT, OPUS)), 238);
        // The growth is filed in the hour of the message, not of the repeat.
        let hours = stats.stats.hourly_for("p1");
        assert_eq!(hours["2026-09-30T10"][&ck(metric::TOKENS_OUT, OPUS)], 188);
        assert_eq!(hours["2026-09-30T11"][&ck(metric::TOKENS_OUT, OPUS)], 50);
        assert!(!stats.partial);
    }

    #[test]
    fn subagent_transcripts_count_for_the_same_scope() {
        let tmp = tempfile::tempdir().unwrap();
        write(&claude_path(tmp.path(), "p1", "s.jsonl"), &[claude("m1", "r1", OPUS, T1, [1, 0, 0, 10])]);
        write(
            &claude_path(tmp.path(), "p1", "s/subagents/agent-a1.jsonl"),
            &[claude("m2", "r2", "claude-haiku-5", T1, [1, 0, 0, 20])],
        );
        let stats = run(tmp.path());
        assert_eq!(total(&stats, "p1", &ck(metric::TOKENS_OUT, OPUS)), 10);
        assert_eq!(total(&stats, "p1", &ck(metric::TOKENS_OUT, "claude-haiku-5")), 20);
    }

    #[test]
    fn synthetic_and_usage_less_records_are_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        let no_usage = format!(
            "{}\n",
            json!({"type": "user", "timestamp": T1, "message": {"role": "user", "content": "usage"}})
        );
        write(
            &claude_path(tmp.path(), "p1", "s.jsonl"),
            &[claude("m1", "r1", SYNTHETIC_MODEL, T1, [5, 5, 5, 5]), no_usage],
        );
        let stats = run(tmp.path());
        assert!(stats.stats.days.is_empty(), "{:?}", stats.stats.days);
    }

    /// A local-model tab's records count toward its scope, not the root.
    #[test]
    fn a_local_model_home_counts_toward_its_scope() {
        let tmp = tempfile::tempdir().unwrap();
        let path = agent_home::local_model_home_in(tmp.path(), "p1").join(".claude/projects/-home-u-p/s.jsonl");
        write(&path, &[claude("m1", "r1", OPUS, T1, [1, 0, 0, 9])]);
        let stats = run(tmp.path());
        assert_eq!(total(&stats, "p1", &ck(metric::TOKENS_OUT, OPUS)), 9);
        assert_eq!(total(&stats, storage::ROOT_SCOPE, &ck(metric::TOKENS_OUT, OPUS)), 0);
    }

    #[test]
    fn records_older_than_the_seed_marker_are_seeded_history() {
        let tmp = tempfile::tempdir().unwrap();
        let home = agent_home::scope_home_in(tmp.path(), "p1");
        write(
            &claude_path(tmp.path(), "p1", "s.jsonl"),
            &[
                claude("old", "r1", OPUS, "2026-09-10T08:00:00Z", [1, 0, 0, 1000]),
                claude("new", "r2", OPUS, "2026-09-20T08:00:00Z", [1, 0, 0, 7]),
            ],
        );
        let marker = home.join(agent_home::SEEDED_MARKER);
        std::fs::write(&marker, b"").unwrap();
        let seeded_at = chrono::DateTime::parse_from_rfc3339("2026-09-15T00:00:00Z").unwrap();
        let at = std::time::UNIX_EPOCH + std::time::Duration::from_millis(seeded_at.timestamp_millis() as u64);
        std::fs::File::options().write(true).open(&marker).unwrap().set_modified(at).unwrap();
        let stats = run(tmp.path());
        assert_eq!(total(&stats, "p1", &ck(metric::TOKENS_OUT, OPUS)), 7);
    }

    #[test]
    fn codex_counts_total_deltas_and_restarts_on_a_reset() {
        let tmp = tempfile::tempdir().unwrap();
        write(
            &codex_path(tmp.path(), "p1", ROLLOUT),
            &[
                turn_context("gpt-6-sol", T1),
                token_count(T1, [100, 0, 0, 10]),
                // Repeated without a new turn: adds nothing.
                token_count(T1, [100, 0, 0, 10]),
                token_count(T1, [250, 0, 0, 30]),
                // A new thread in the same file: the total starts over.
                token_count(T2, [40, 0, 0, 4]),
            ],
        );
        let stats = run(tmp.path());
        let model = "gpt-6-sol";
        assert_eq!(total(&stats, "p1", &xk(metric::TOKENS_IN, model)), 250 + 40);
        assert_eq!(total(&stats, "p1", &xk(metric::TOKENS_OUT, model)), 30 + 4);
    }

    #[test]
    fn codex_input_is_normalized_to_fresh_input() {
        let tmp = tempfile::tempdir().unwrap();
        write(
            &codex_path(tmp.path(), "p1", ROLLOUT),
            &[
                turn_context("gpt-6-sol", T1),
                // input includes cached (read) and cache write.
                token_count(T1, [1000, 700, 200, 50]),
                token_count(T1, [1500, 1100, 200, 80]),
            ],
        );
        let stats = run(tmp.path());
        let m = "gpt-6-sol";
        assert_eq!(total(&stats, "p1", &xk(metric::TOKENS_IN, m)), 100 + 100);
        assert_eq!(total(&stats, "p1", &xk(metric::TOKENS_CACHE_R, m)), 1100);
        assert_eq!(total(&stats, "p1", &xk(metric::TOKENS_CACHE_W, m)), 200);
        assert_eq!(total(&stats, "p1", &xk(metric::TOKENS_OUT, m)), 80);
    }

    #[test]
    fn codex_model_falls_back_to_the_thread_store() {
        let tmp = tempfile::tempdir().unwrap();
        write(&codex_path(tmp.path(), "p1", ROLLOUT), &[token_count(T1, [10, 0, 0, 1])]);
        let db = agent_home::scope_home_in(tmp.path(), "p1").join(".codex/state_5.sqlite");
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute("CREATE TABLE threads (id TEXT PRIMARY KEY, model TEXT)", []).unwrap();
        conn.execute("INSERT INTO threads VALUES (?1, 'gpt-6-astra')", [ROLLOUT_ID]).unwrap();
        drop(conn);
        let stats = run(tmp.path());
        assert_eq!(total(&stats, "p1", &xk(metric::TOKENS_OUT, "gpt-6-astra")), 1);
    }

    fn fallback_store(db: &Path, rows: &[(&str, i64, &str)]) {
        let conn = rusqlite::Connection::open(db).unwrap();
        conn.execute(
            "CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, tokens_used INTEGER, \
             updated_at INTEGER, updated_at_ms INTEGER, model TEXT)",
            [],
        )
        .unwrap();
        let at = chrono::DateTime::parse_from_rfc3339(T2).unwrap().timestamp_millis();
        for (id, tokens, model) in rows {
            conn.execute(
                "INSERT OR REPLACE INTO threads VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![id, tokens, at / 1000, at, model],
            )
            .unwrap();
        }
    }

    #[test]
    fn codex_store_fallback_counts_only_threads_without_a_rollout() {
        let tmp = tempfile::tempdir().unwrap();
        write(
            &codex_path(tmp.path(), "p1", ROLLOUT),
            &[turn_context("gpt-6-sol", T1), token_count(T1, [100, 0, 0, 10])],
        );
        let db = agent_home::scope_home_in(tmp.path(), "p1").join(".codex/state_5.sqlite");
        let orphan = "01a07b65-415e-7423-a42f-5e229ed5ffac";
        fallback_store(&db, &[(ROLLOUT_ID, 999_999, "gpt-6-sol"), (orphan, 5000, "gpt-6-astra")]);
        let stats = run(tmp.path());
        assert_eq!(total(&stats, "p1", &xk(metric::TOKENS_TOTAL, "gpt-6-astra")), 5000);
        assert_eq!(total(&stats, "p1", &xk(metric::TOKENS_TOTAL, "gpt-6-sol")), 0);
        assert_eq!(total(&stats, "p1", &xk(metric::TOKENS_IN, "gpt-6-sol")), 100);
        // The thread grows: only the growth is added.
        fallback_store(&db, &[(orphan, 7000, "gpt-6-astra")]);
        let stats = run(tmp.path());
        assert_eq!(total(&stats, "p1", &xk(metric::TOKENS_TOTAL, "gpt-6-astra")), 7000);
    }

    #[test]
    fn appended_lines_are_the_only_ones_read_again() {
        let tmp = tempfile::tempdir().unwrap();
        let path = claude_path(tmp.path(), "p1", "s.jsonl");
        write(&path, &[claude("m1", "r1", OPUS, T1, [1, 0, 0, 10])]);
        assert_eq!(total(&run(tmp.path()), "p1", &ck(metric::TOKENS_OUT, OPUS)), 10);
        // A repeat of the last message straddling the scan boundary, then a new one.
        append(
            &path,
            &[
                claude("m1", "r1", OPUS, T1, [1, 0, 0, 10]),
                claude("m2", "r2", OPUS, T2, [1, 0, 0, 5]),
            ],
        );
        let stats = run(tmp.path());
        assert_eq!(total(&stats, "p1", &ck(metric::TOKENS_OUT, OPUS)), 15);
        assert_eq!(total(&stats, "p1", &ck(metric::TOKENS_IN, OPUS)), 2);
        // Nothing new: nothing changes.
        assert_eq!(total(&run(tmp.path()), "p1", &ck(metric::TOKENS_OUT, OPUS)), 15);
    }

    #[test]
    fn a_partly_written_last_line_waits_for_its_newline() {
        let tmp = tempfile::tempdir().unwrap();
        let path = claude_path(tmp.path(), "p1", "s.jsonl");
        let line = claude("m1", "r1", OPUS, T1, [1, 0, 0, 10]);
        let (head, tail) = line.split_at(40);
        write(&path, &[head.to_string()]);
        assert!(run(tmp.path()).stats.days.is_empty());
        append(&path, &[tail.to_string()]);
        assert_eq!(total(&run(tmp.path()), "p1", &ck(metric::TOKENS_OUT, OPUS)), 10);
    }

    #[test]
    fn a_truncated_file_is_recounted_without_doubling() {
        let tmp = tempfile::tempdir().unwrap();
        let path = claude_path(tmp.path(), "p1", "s.jsonl");
        write(
            &path,
            &[
                claude("m1", "r1", OPUS, T1, [1, 0, 0, 10]),
                claude("m2", "r2", OPUS, T1, [1, 0, 0, 20]),
            ],
        );
        assert_eq!(total(&run(tmp.path()), "p1", &ck(metric::TOKENS_OUT, OPUS)), 30);
        // Rewritten in place, shorter.
        write(&path, &[claude("m3", "r3", OPUS, T1, [1, 0, 0, 4])]);
        assert_eq!(total(&run(tmp.path()), "p1", &ck(metric::TOKENS_OUT, OPUS)), 4);
    }

    #[cfg(unix)]
    #[test]
    fn a_replaced_file_is_recounted_without_doubling() {
        let tmp = tempfile::tempdir().unwrap();
        let path = claude_path(tmp.path(), "p1", "s.jsonl");
        write(&path, &[claude("m1", "r1", OPUS, T1, [1, 0, 0, 10])]);
        assert_eq!(total(&run(tmp.path()), "p1", &ck(metric::TOKENS_OUT, OPUS)), 10);
        // A new inode under the old name, longer than the old file: the length
        // alone would read it as an append.
        let staged = path.with_extension("tmp");
        write(
            &staged,
            &[
                claude("m2", "r2", OPUS, T1, [1, 0, 0, 20]),
                claude("m3", "r3", OPUS, T1, [1, 0, 0, 30]),
            ],
        );
        std::fs::rename(&staged, &path).unwrap();
        assert_eq!(total(&run(tmp.path()), "p1", &ck(metric::TOKENS_OUT, OPUS)), 50);
    }

    #[test]
    fn a_deleted_file_keeps_its_contribution_in_retired() {
        let tmp = tempfile::tempdir().unwrap();
        let path = claude_path(tmp.path(), "p1", "s.jsonl");
        write(&path, &[claude("m1", "r1", OPUS, T1, [1, 0, 0, 10])]);
        write(&codex_path(tmp.path(), "p1", ROLLOUT), &[turn_context("gpt-6-sol", T1), token_count(T1, [9, 0, 0, 1])]);
        run(tmp.path());
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_file(codex_path(tmp.path(), "p1", ROLLOUT)).unwrap();
        let stats = run(tmp.path());
        assert_eq!(total(&stats, "p1", &ck(metric::TOKENS_OUT, OPUS)), 10);
        assert_eq!(total(&stats, "p1", &xk(metric::TOKENS_IN, "gpt-6-sol")), 9);
        let cache = load_cache(&tmp.path().join(CACHE_FILE));
        assert!(cache.files.is_empty());
        assert_eq!(cache.retired.daily_for("p1")["2026-09-30"][&ck(metric::TOKENS_OUT, OPUS)], 10);
        // And it stays retired, not counted again.
        assert_eq!(total(&run(tmp.path()), "p1", &ck(metric::TOKENS_OUT, OPUS)), 10);
    }

    #[test]
    fn an_oversized_line_is_skipped_without_being_buffered() {
        let max_line = 1024;
        let big = format!("{{\"usage\":\"{}\"}}\n", "x".repeat(1 << 20));
        let small = "{\"ok\":1}\n";
        let data = format!("{big}{small}");
        let mut reader = BufReader::new(data.as_bytes());
        let mut pos = LinePos { offset: 0, skipping: false };
        let mut budget = Budget { bytes: u64::MAX, files: 1 };
        let mut buf = Vec::new();
        let mut lines: Vec<Vec<u8>> = Vec::new();
        let exhausted = read_lines(&mut reader, &mut pos, max_line, &mut budget, &mut buf, |l| lines.push(l.to_vec()));
        assert!(!exhausted);
        assert_eq!(lines, vec![b"{\"ok\":1}".to_vec()]);
        assert_eq!(pos.offset, data.len() as u64);
        assert!(buf.capacity() <= 4 * max_line, "buffered {} bytes", buf.capacity());

        // Through a scan: the record after the oversized line still counts.
        let tmp = tempfile::tempdir().unwrap();
        let path = claude_path(tmp.path(), "p1", "s.jsonl");
        let padded = claude("m0", "r0", OPUS, T1, [1, 0, 0, 999]).replace("hello", &"y".repeat(8192));
        write(&path, &[padded, claude("m1", "r1", OPUS, T1, [1, 0, 0, 10])]);
        let limits = Limits { max_line, ..Limits::default() };
        let stats = scan_with(tmp.path(), &scopes(), limits, now());
        assert_eq!(total(&stats, "p1", &ck(metric::TOKENS_OUT, OPUS)), 10);
    }

    #[test]
    fn an_oversized_line_cut_by_the_budget_is_still_skipped_next_time() {
        let data = format!("{}\n{{\"ok\":1}}\n", "x".repeat(5000));
        let mut pos = LinePos { offset: 0, skipping: false };
        let mut lines = 0;
        let mut buf = Vec::new();
        for _ in 0..20 {
            let mut reader = BufReader::new(&data.as_bytes()[pos.offset as usize..]);
            let mut budget = Budget { bytes: 1500, files: 1 };
            if !read_lines(&mut reader, &mut pos, 1024, &mut budget, &mut buf, |_| lines += 1) {
                break;
            }
        }
        assert_eq!(lines, 1);
        assert_eq!(pos.offset, data.len() as u64);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_transcript_is_not_followed() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tmp.path().join("outside");
        write(&outside.join("real.jsonl"), &[claude("m1", "r1", OPUS, T1, [1, 0, 0, 10])]);
        let link = claude_path(tmp.path(), "p1", "evil.jsonl");
        std::fs::create_dir_all(link.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(outside.join("real.jsonl"), &link).unwrap();
        // A symlinked project dir too.
        let projects = agent_home::scope_home_in(tmp.path(), "p1").join(".claude/projects");
        std::os::unix::fs::symlink(&outside, projects.join("-linked")).unwrap();
        let stats = run(tmp.path());
        assert!(stats.stats.days.is_empty(), "{:?}", stats.stats.days);
    }

    #[test]
    fn models_with_dots_survive_the_key_round_trip() {
        let key = token_key(metric::TOKENS_CACHE_R, CODEX, "gpt-6.1-sol");
        assert_eq!(key, "tokens.cache_r.codex.gpt-6.1-sol");
        assert_eq!(parse_token_key(&key), Some((metric::TOKENS_CACHE_R, CODEX, "gpt-6.1-sol")));
        assert_eq!(parse_token_key("tokens.total.codex.a.b.c"), Some((metric::TOKENS_TOTAL, CODEX, "a.b.c")));
        assert_eq!(parse_token_key("agent.prompt.claude"), None);
        assert_eq!(parse_token_key("tokens.bogus.codex.m"), None);
        assert_eq!(parse_token_key("tokens.in.codex"), None);

        let tmp = tempfile::tempdir().unwrap();
        write(
            &codex_path(tmp.path(), "p1", ROLLOUT),
            &[turn_context("gpt-6.1-sol", T1), token_count(T1, [10, 0, 0, 3])],
        );
        let stats = run(tmp.path());
        assert_eq!(total(&stats, "p1", "tokens.out.codex.gpt-6.1-sol"), 3);
    }

    /// Several sources with splits that straddle every possible boundary.
    fn fixture(state: &Path) {
        write(
            &claude_path(state, "p1", "a.jsonl"),
            &[
                claude("m1", "r1", OPUS, T1, [1, 10, 100, 5]),
                claude("m1", "r1", OPUS, T1, [1, 10, 100, 9]),
                claude("m2", "r2", OPUS, T2, [2, 20, 200, 6]),
                claude("m2", "r2", OPUS, T2, [2, 20, 200, 6]),
                claude("m3", "r3", "claude-haiku-5", T2, [3, 0, 300, 7]),
            ],
        );
        write(
            &claude_path(state, "root", "b/subagents/agent-x.jsonl"),
            &[claude("m4", "r4", OPUS, T1, [4, 40, 400, 8])],
        );
        write(
            &codex_path(state, "p1", ROLLOUT),
            &[
                turn_context("gpt-6.1-sol", T1),
                token_count(T1, [100, 50, 0, 10]),
                token_count(T1, [100, 50, 0, 10]),
                token_count(T2, [300, 200, 10, 30]),
                turn_context("gpt-6-astra", T2),
                token_count(T2, [500, 300, 10, 70]),
            ],
        );
    }

    #[test]
    fn a_byte_budget_ends_partial_and_the_next_scans_reach_the_same_totals() {
        let whole = tempfile::tempdir().unwrap();
        fixture(whole.path());
        let expected = run(whole.path());
        assert!(!expected.partial);

        let sliced = tempfile::tempdir().unwrap();
        fixture(sliced.path());
        // One line per scan: every message and every running total crosses a
        // scan boundary somewhere.
        let limits = Limits { max_bytes: 1, ..Limits::default() };
        let mut scans = 0;
        let last = loop {
            let stats = scan_with(sliced.path(), &scopes(), limits, now());
            scans += 1;
            if !stats.partial || scans > 100 {
                break stats;
            }
        };
        assert!(!last.partial);
        assert!(scans > 5, "only {scans} scans");
        assert_eq!(last.stats.daily_for(""), expected.stats.daily_for(""));
        assert_eq!(last.stats.hourly_for(""), expected.stats.hourly_for(""));
        assert_eq!(last.stats.daily_for("root"), expected.stats.daily_for("root"));
    }

    #[test]
    fn a_file_budget_ends_partial_too() {
        let tmp = tempfile::tempdir().unwrap();
        fixture(tmp.path());
        let limits = Limits { max_files: 1, ..Limits::default() };
        assert!(scan_with(tmp.path(), &scopes(), limits, now()).partial);
    }

    #[test]
    fn host_and_orphaned_homes_count_as_the_root_scope() {
        let tmp = tempfile::tempdir().unwrap();
        let host = agent_home::host_home_in(tmp.path());
        write(
            &host.join(".claude/projects/-x/s.jsonl"),
            &[claude("m1", "r1", OPUS, T1, [1, 0, 0, 3])],
        );
        write(&claude_path(tmp.path(), "gone-project", "s.jsonl"), &[claude("m2", "r2", OPUS, T1, [1, 0, 0, 4])]);
        let stats = run(tmp.path());
        assert_eq!(total(&stats, "root", &ck(metric::TOKENS_OUT, OPUS)), 7);
        // The project comes back: its home's counts follow it.
        let stats = scan_with(
            tmp.path(),
            &[storage::ROOT_SCOPE.into(), "gone-project".into()],
            Limits::default(),
            now(),
        );
        assert_eq!(total(&stats, "root", &ck(metric::TOKENS_OUT, OPUS)), 3);
        assert_eq!(total(&stats, "gone-project", &ck(metric::TOKENS_OUT, OPUS)), 4);
    }

    #[test]
    fn the_probe_homes_runs_count_for_no_scope() {
        let tmp = tempfile::tempdir().unwrap();
        let probe = agent_home::probe_home_in(tmp.path());
        write(
            &probe.join(".claude/projects/-cron/s.jsonl"),
            &[claude("m1", "r1", OPUS, T1, [1, 0, 0, 9])],
        );
        let host = agent_home::host_home_in(tmp.path());
        write(&host.join(".claude/projects/-x/s.jsonl"), &[claude("m2", "r2", OPUS, T1, [1, 0, 0, 3])]);
        let stats = run(tmp.path());
        // The Host session's home is the root console's; the probe home's is nobody's.
        assert_eq!(total(&stats, "root", &ck(metric::TOKENS_OUT, OPUS)), 3);
    }

    #[test]
    fn forged_values_and_future_stamps_are_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        let negative = claude("m2", "r2", OPUS, T1, [1, 0, 0, 0]).replace("\"output_tokens\":0", "\"output_tokens\":-5");
        let text = claude("m3", "r3", OPUS, T1, [1, 0, 0, 0]).replace("\"output_tokens\":0", "\"output_tokens\":\"9\"");
        write(
            &claude_path(tmp.path(), "p1", "s.jsonl"),
            &[
                claude("m1", "r1", OPUS, T1, [1, 0, 0, 5_000_000_000]),
                negative,
                text,
                claude("m4", "r4", OPUS, "2026-10-05T00:00:00Z", [1, 0, 0, 77]),
                claude("m5", "r5", OPUS, "not a time", [1, 0, 0, 77]),
                "not json \"usage\"\n".to_string(),
                claude("m6", "r6", "bad model name", T1, [0, 0, 0, 2]),
            ],
        );
        let stats = run(tmp.path());
        assert_eq!(total(&stats, "p1", &ck(metric::TOKENS_OUT, OPUS)), 0);
        assert_eq!(total(&stats, "p1", &ck(metric::TOKENS_IN, OPUS)), 3);
        assert_eq!(total(&stats, "p1", &ck(metric::TOKENS_OUT, UNKNOWN_MODEL)), 2);
    }

    #[test]
    fn a_cache_of_another_version_is_rebuilt() {
        let tmp = tempfile::tempdir().unwrap();
        write(&claude_path(tmp.path(), "p1", "s.jsonl"), &[claude("m1", "r1", OPUS, T1, [1, 0, 0, 10])]);
        let stale = json!({
            "version": CACHE_VERSION + 1,
            "retired": {"days": {"2026-09-30": {"p1": {"tokens.out.claude.claude-opus-5": 1000}}}}
        });
        std::fs::write(tmp.path().join(CACHE_FILE), stale.to_string()).unwrap();
        assert_eq!(total(&run(tmp.path()), "p1", &ck(metric::TOKENS_OUT, OPUS)), 10);
    }

    #[test]
    fn rollout_names_yield_their_thread_id() {
        assert_eq!(rollout_thread_id(&format!("a/b/{ROLLOUT}")).as_deref(), Some(ROLLOUT_ID));
        assert_eq!(rollout_thread_id("rollout-short.jsonl"), None);
        assert_eq!(rollout_thread_id("rollout-2026-09-30T10-00-00-zzzzzzzz-bfa7-72f2-ae4b-de4b5d33e12f.jsonl"), None);
    }
    /// The chat assistant's homes are its own scope's, even when the caller's
    /// list of known scopes does not name it: never the root console's.
    #[test]
    fn the_assistant_scope_counts_apart_from_the_root() {
        let tmp = tempfile::tempdir().unwrap();
        for home in [
            agent_home::scope_home_in(tmp.path(), storage::ASSISTANT_SCOPE),
            agent_home::local_model_home_in(tmp.path(), storage::ASSISTANT_SCOPE),
        ] {
            write(&home.join(".claude/projects/-state-assistant-work-x/s.jsonl"), &[claude("m1", "r1", OPUS, T1, [1, 0, 0, 7])]);
        }
        let stats = run(tmp.path());
        assert_eq!(total(&stats, storage::ASSISTANT_SCOPE, &ck(metric::TOKENS_OUT, OPUS)), 14);
        assert_eq!(total(&stats, storage::ROOT_SCOPE, &ck(metric::TOKENS_OUT, OPUS)), 0);
    }

    // ── OpenCode ──

    fn ok(prefix: &str, model: &str) -> String {
        token_key(prefix, OPENCODE, model)
    }

    fn ms(ts: &str) -> i64 {
        chrono::DateTime::parse_from_rfc3339(ts).unwrap().timestamp_millis()
    }

    /// The scope's OpenCode store with both message tables, as OpenCode 2
    /// leaves a store it migrated from 1.
    fn oc_store(state: &Path, scope: &str) -> rusqlite::Connection {
        let db = agent_home::scope_home_in(state, scope).join(OPENCODE_DB);
        std::fs::create_dir_all(db.parent().unwrap()).unwrap();
        let conn = rusqlite::Connection::open(db).unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, \
             type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, \
             time_updated INTEGER NOT NULL, data TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, \
             time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);",
        )
        .unwrap();
        conn
    }

    /// `[input, output, reasoning, cache read, cache write]`.
    fn oc_tokens(n: [u64; 5]) -> serde_json::Value {
        json!({"input": n[0], "output": n[1], "reasoning": n[2], "cache": {"read": n[3], "write": n[4]}})
    }

    fn oc_v2(conn: &rusqlite::Connection, id: &str, kind: &str, at: i64, done: bool, model: &str, n: [u64; 5]) {
        let completed = if done { json!(at + 500) } else { json!(null) };
        let data = json!({"model": {"id": model, "providerID": "anthropic"}, "tokens": oc_tokens(n),
                          "time": {"created": at, "completed": completed}, "content": []});
        conn.execute(
            "INSERT OR REPLACE INTO session_message VALUES (?1, 's1', ?2, 1, ?3, ?3, ?4)",
            rusqlite::params![id, kind, at, data.to_string()],
        )
        .unwrap();
    }

    fn oc_v1(conn: &rusqlite::Connection, id: &str, data: &str, at: i64) {
        conn.execute(
            "INSERT OR REPLACE INTO message VALUES (?1, 's0', ?2, ?2, ?3)",
            rusqlite::params![id, at, data],
        )
        .unwrap();
    }

    const SONNET: &str = "claude-sonnet-5";

    #[test]
    fn opencode_is_a_source() {
        assert!(SOURCES.contains(&OPENCODE));
    }

    #[test]
    fn opencode_counts_finished_messages_with_reasoning_as_output() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = oc_store(tmp.path(), "p1");
        oc_v2(&conn, "m1", "assistant", ms(T1), true, SONNET, [10, 20, 5, 1000, 300]);
        oc_v2(&conn, "u1", "user", ms(T1), true, SONNET, [999, 999, 999, 999, 999]);
        oc_v1(
            &conn,
            "old1",
            &json!({"role": "assistant", "modelID": "gpt-6-sol", "tokens": oc_tokens([1, 2, 0, 40, 0]),
                    "time": {"created": ms(T1), "completed": ms(T1) + 9}})
            .to_string(),
            ms(T1),
        );
        // Malformed or non-assistant V1 rows are stepped over, not fatal.
        oc_v1(&conn, "bad", "{not json", ms(T1));
        oc_v1(&conn, "user", &json!({"role": "user", "tokens": oc_tokens([5; 5])}).to_string(), ms(T1));
        let stats = run(tmp.path());
        assert_eq!(total(&stats, "p1", &ok(metric::TOKENS_IN, SONNET)), 10);
        assert_eq!(total(&stats, "p1", &ok(metric::TOKENS_OUT, SONNET)), 25);
        assert_eq!(total(&stats, "p1", &ok(metric::TOKENS_CACHE_R, SONNET)), 1000);
        assert_eq!(total(&stats, "p1", &ok(metric::TOKENS_CACHE_W, SONNET)), 300);
        assert_eq!(total(&stats, "p1", &ok(metric::TOKENS_CACHE_R, "gpt-6-sol")), 40);
        assert_eq!(stats.stats.hourly_for("p1")["2026-09-30T10"][&ok(metric::TOKENS_IN, SONNET)], 10);
        assert!(!stats.partial);
    }

    #[test]
    fn opencode_reads_new_rows_once_and_streaming_ones_when_they_finish() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = oc_store(tmp.path(), "p1");
        oc_v2(&conn, "m1", "assistant", ms(T1), true, SONNET, [1, 10, 0, 0, 0]);
        oc_v2(&conn, "m2", "assistant", ms(T1) + 1, false, SONNET, [0, 3, 0, 0, 0]);
        assert_eq!(total(&run(tmp.path()), "p1", &ok(metric::TOKENS_OUT, SONNET)), 10);
        // m2 finishes with its final count; a later row and one sharing m2's
        // stamp (after it by id) arrive.
        oc_v2(&conn, "m2", "assistant", ms(T1) + 1, true, SONNET, [0, 7, 0, 0, 0]);
        oc_v2(&conn, "m3", "assistant", ms(T2), true, SONNET, [0, 100, 0, 0, 0]);
        oc_v2(&conn, "m2b", "assistant", ms(T1) + 1, true, SONNET, [0, 1000, 0, 0, 0]);
        let stats = run(tmp.path());
        assert_eq!(total(&stats, "p1", &ok(metric::TOKENS_OUT, SONNET)), 1117);
        // Nothing new: nothing added.
        assert_eq!(total(&run(tmp.path()), "p1", &ok(metric::TOKENS_OUT, SONNET)), 1117);
    }

    #[test]
    fn opencode_row_from_the_future_does_not_hide_later_ones() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = oc_store(tmp.path(), "p1");
        oc_v2(&conn, "future", "assistant", now() + 10 * 86_400_000, true, SONNET, [0, 50, 0, 0, 0]);
        oc_v2(&conn, "m1", "assistant", ms(T1), true, SONNET, [0, 10, 0, 0, 0]);
        assert_eq!(total(&run(tmp.path()), "p1", &ok(metric::TOKENS_OUT, SONNET)), 10);
        oc_v2(&conn, "m2", "assistant", ms(T2), true, SONNET, [0, 5, 0, 0, 0]);
        assert_eq!(total(&run(tmp.path()), "p1", &ok(metric::TOKENS_OUT, SONNET)), 15);
    }

    #[test]
    fn opencode_rows_are_read_once_settled() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = oc_store(tmp.path(), "p1");
        oc_v2(&conn, "m1", "assistant", now() - 1000, true, SONNET, [0, 10, 0, 0, 0]);
        let at = |t: i64| scan_with(tmp.path(), &scopes(), Limits::default(), t);
        assert_eq!(total(&at(now()), "p1", &ok(metric::TOKENS_OUT, SONNET)), 0);
        assert_eq!(total(&at(now() + OPENCODE_SETTLE_MS), "p1", &ok(metric::TOKENS_OUT, SONNET)), 10);
    }

    #[test]
    fn opencode_history_outlives_its_store() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = oc_store(tmp.path(), "p1");
        oc_v2(&conn, "m1", "assistant", ms(T1), true, SONNET, [0, 10, 0, 0, 0]);
        assert_eq!(total(&run(tmp.path()), "p1", &ok(metric::TOKENS_OUT, SONNET)), 10);
        drop(conn);
        std::fs::remove_file(agent_home::scope_home_in(tmp.path(), "p1").join(OPENCODE_DB)).unwrap();
        assert_eq!(total(&run(tmp.path()), "p1", &ok(metric::TOKENS_OUT, SONNET)), 10);
    }

    #[cfg(unix)]
    #[test]
    fn opencode_store_behind_a_link_is_not_read() {
        let tmp = tempfile::tempdir().unwrap();
        let elsewhere = tmp.path().join("elsewhere");
        let conn = oc_store(&elsewhere, "p1");
        oc_v2(&conn, "m1", "assistant", ms(T1), true, SONNET, [0, 10, 0, 0, 0]);
        let link = agent_home::scope_home_in(tmp.path(), "p1").join(OPENCODE_DB);
        std::fs::create_dir_all(link.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(agent_home::scope_home_in(&elsewhere, "p1").join(OPENCODE_DB), &link).unwrap();
        assert_eq!(total(&run(tmp.path()), "p1", &ok(metric::TOKENS_OUT, SONNET)), 0);
    }

    // ── Gemini CLI ──

    fn gk(prefix: &str, model: &str) -> String {
        token_key(prefix, GEMINI, model)
    }

    const FLASH: &str = "gemini-3.8-flash";

    fn gemini_path(state: &Path, scope: &str, rel: &str) -> PathBuf {
        agent_home::scope_home_in(state, scope).join(".gemini/tmp/proj/chats").join(rel)
    }

    /// `[input, cached, tool, output, thoughts]`.
    fn gemini_msg(id: &str, ts: &str, n: Option<[u64; 5]>) -> serde_json::Value {
        let mut message = json!({"id": id, "type": "gemini", "timestamp": ts, "model": FLASH, "content": "hi"});
        if let Some(n) = n {
            message["tokens"] = json!({"input": n[0], "cached": n[1], "tool": n[2], "output": n[3], "thoughts": n[4],
                                       "total": n[0] + n[2] + n[3] + n[4]});
        }
        message
    }

    fn line(value: serde_json::Value) -> String {
        format!("{value}\n")
    }

    #[test]
    fn gemini_counts_each_message_once_at_its_last_tokens() {
        let tmp = tempfile::tempdir().unwrap();
        let path = gemini_path(tmp.path(), "p1", "session-2026-09-30T10-15-abcd1234.jsonl");
        write(
            &path,
            &[
                line(json!({"sessionId": "abcd1234", "projectHash": "h", "startTime": T1})),
                line(json!({"id": "u1", "type": "user", "timestamp": T1, "content": "go",
                            "tokens": {"input": 999}})),
                line(gemini_msg("g1", T1, None)),
                line(gemini_msg("g1", T1, Some([1000, 800, 5, 20, 10]))),
                // Rewritten when its tool calls finish: the same message.
                line(gemini_msg("g1", T1, Some([1000, 800, 5, 20, 10]))),
                line(json!({"$rewindTo": "g1"})),
                line(gemini_msg("g2", T2, Some([2000, 1500, 0, 30, 0]))),
            ],
        );
        let stats = run(tmp.path());
        assert_eq!(total(&stats, "p1", &gk(metric::TOKENS_IN, FLASH)), 205 + 500);
        assert_eq!(total(&stats, "p1", &gk(metric::TOKENS_CACHE_R, FLASH)), 2300);
        assert_eq!(total(&stats, "p1", &gk(metric::TOKENS_CACHE_W, FLASH)), 0);
        assert_eq!(total(&stats, "p1", &gk(metric::TOKENS_OUT, FLASH)), 60);
        assert_eq!(stats.stats.hourly_for("p1")["2026-09-30T11"][&gk(metric::TOKENS_OUT, FLASH)], 30);
        // A new message: the file is folded again, nothing counted twice.
        append(&path, &[line(gemini_msg("g3", T2, Some([10, 0, 0, 1, 0])))]);
        let stats = run(tmp.path());
        assert_eq!(total(&stats, "p1", &gk(metric::TOKENS_OUT, FLASH)), 61);
        assert_eq!(total(&stats, "p1", &gk(metric::TOKENS_CACHE_R, FLASH)), 2300);
    }

    #[test]
    fn gemini_legacy_json_counts_unless_migrated_and_subagents_count() {
        let tmp = tempfile::tempdir().unwrap();
        let legacy = json!({"sessionId": "s", "messages": [gemini_msg("a", T1, Some([100, 0, 0, 7, 0]))]});
        std::fs::create_dir_all(gemini_path(tmp.path(), "p1", "")).unwrap();
        std::fs::write(gemini_path(tmp.path(), "p1", "session-old.json"), legacy.to_string()).unwrap();
        assert_eq!(total(&run(tmp.path()), "p1", &gk(metric::TOKENS_OUT, FLASH)), 7);

        // Resumed: Gemini appends the old conversation to `<name>.jsonl`.
        write(
            &gemini_path(tmp.path(), "p1", "session-old.jsonl"),
            &[line(json!({"$set": {"sessionId": "s", "messages": [gemini_msg("a", T1, Some([100, 0, 0, 7, 0]))]}}))],
        );
        write(
            &gemini_path(tmp.path(), "p1", "abcd1234/sub-1.jsonl"),
            &[line(gemini_msg("x", T1, Some([50, 0, 0, 3, 0])))],
        );
        let stats = run(tmp.path());
        assert_eq!(total(&stats, "p1", &gk(metric::TOKENS_OUT, FLASH)), 10);
        assert_eq!(total(&stats, "p1", &gk(metric::TOKENS_IN, FLASH)), 150);
    }

    #[test]
    fn gemini_and_copilot_are_sources() {
        assert!(SOURCES.contains(&GEMINI) && SOURCES.contains(&COPILOT));
    }

    // ── Copilot CLI ──

    fn copilot_store(state: &Path, scope: &str) -> rusqlite::Connection {
        let db = agent_home::scope_home_in(state, scope).join(COPILOT_DB);
        std::fs::create_dir_all(db.parent().unwrap()).unwrap();
        let conn = rusqlite::Connection::open(db).unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS assistant_usage_events (id INTEGER PRIMARY KEY AUTOINCREMENT, \
             session_id TEXT NOT NULL, turn_index INTEGER, model TEXT NOT NULL, input_tokens INTEGER, \
             output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, \
             reasoning_tokens INTEGER, created_at TEXT)",
        )
        .unwrap();
        conn
    }

    /// `[input (cache included), output, cache read, cache write]`.
    fn copilot_row(conn: &rusqlite::Connection, model: &str, ts: &str, n: [i64; 4]) {
        conn.execute(
            "INSERT INTO assistant_usage_events (session_id, turn_index, model, input_tokens, output_tokens, \
             cache_read_tokens, cache_write_tokens, reasoning_tokens, created_at) \
             VALUES ('s', 0, ?1, ?2, ?3, ?4, ?5, 0, ?6)",
            rusqlite::params![model, n[0], n[1], n[2], n[3], ts],
        )
        .unwrap();
    }

    #[test]
    fn copilot_counts_each_call_once_with_the_cache_taken_out_of_input() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = copilot_store(tmp.path(), "p1");
        let model = "gpt-5.6-terra";
        let key = |prefix: &str| token_key(prefix, COPILOT, model);
        copilot_row(&conn, model, T1, [17790, 71, 0, 17787]);
        copilot_row(&conn, model, T1, [17939, 16, 17787, 149]);
        let stats = run(tmp.path());
        assert_eq!(total(&stats, "p1", &key(metric::TOKENS_IN)), 6);
        assert_eq!(total(&stats, "p1", &key(metric::TOKENS_CACHE_W)), 17936);
        assert_eq!(total(&stats, "p1", &key(metric::TOKENS_CACHE_R)), 17787);
        assert_eq!(total(&stats, "p1", &key(metric::TOKENS_OUT)), 87);
        copilot_row(&conn, model, T2, [100, 4, 0, 0]);
        let stats = run(tmp.path());
        assert_eq!(total(&stats, "p1", &key(metric::TOKENS_OUT)), 91);
        assert_eq!(total(&stats, "p1", &key(metric::TOKENS_IN)), 106);
    }

    // ── Claude details ──

    /// A Claude line whose cache writes say their lifetime, `[5 min, 1 h]`.
    fn claude_w(id: &str, req: &str, ts: &str, n: [u64; 4], w: [u64; 2]) -> String {
        let mut record: serde_json::Value = serde_json::from_str(claude(id, req, OPUS, ts, n).trim()).unwrap();
        record["message"]["usage"]["cache_creation"] =
            json!({"ephemeral_5m_input_tokens": w[0], "ephemeral_1h_input_tokens": w[1]});
        format!("{record}\n")
    }

    #[test]
    fn claude_files_cache_lifetimes_and_the_subagents_part() {
        let tmp = tempfile::tempdir().unwrap();
        write(
            &claude_path(tmp.path(), "p1", "s.jsonl"),
            &[
                claude_w("m1", "r1", T1, [2, 300, 1000, 5], [0, 100]),
                // The same message again with its writes complete.
                claude_w("m1", "r1", T1, [2, 300, 1000, 9], [0, 300]),
            ],
        );
        write(
            &claude_path(tmp.path(), "p1", "s/subagents/agent-a1.jsonl"),
            &[claude_w("m2", "r2", T1, [1, 50, 400, 7], [50, 0])],
        );
        let stats = run(tmp.path());
        assert_eq!(total(&stats, "p1", &ck(metric::TOKENS_CACHE_W, OPUS)), 350);
        assert_eq!(total(&stats, "p1", &ck(metric::TOKENS_CACHE_W1H, OPUS)), 300);
        assert_eq!(total(&stats, "p1", &ck(metric::TOKENS_CACHE_W5M, OPUS)), 50);
        assert_eq!(total(&stats, "p1", &ck(metric::TOKENS_OUT, OPUS)), 16);
        assert_eq!(total(&stats, "p1", &ck(metric::TOKENS_SUB_IN, OPUS)), 1);
        assert_eq!(total(&stats, "p1", &ck(metric::TOKENS_SUB_CACHE_W, OPUS)), 50);
        assert_eq!(total(&stats, "p1", &ck(metric::TOKENS_SUB_CACHE_R, OPUS)), 400);
        assert_eq!(total(&stats, "p1", &ck(metric::TOKENS_SUB_OUT, OPUS)), 7);
    }

    #[test]
    fn claude_cursor_from_before_the_details_is_read_again_once() {
        let tmp = tempfile::tempdir().unwrap();
        write(&claude_path(tmp.path(), "p1", "s.jsonl"), &[claude_w("m1", "r1", T1, [2, 300, 0, 5], [0, 300])]);
        run(tmp.path());
        // Make the cache look like an older build's: no `detail`, no details.
        let path = tmp.path().join(CACHE_FILE);
        let mut cache: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        for cursor in cache["files"].as_object_mut().unwrap().values_mut() {
            cursor.as_object_mut().unwrap().remove("detail");
            let text = cursor["contribution"].to_string().replace("tokens.cache_w1h", "tokens.cache_w1h_gone");
            cursor["contribution"] = serde_json::from_str(&text).unwrap();
        }
        std::fs::write(&path, cache.to_string()).unwrap();
        let stats = run(tmp.path());
        assert_eq!(total(&stats, "p1", &ck(metric::TOKENS_CACHE_W, OPUS)), 300);
        assert_eq!(total(&stats, "p1", &ck(metric::TOKENS_CACHE_W1H, OPUS)), 300);
        assert_eq!(total(&stats, "p1", &ck(metric::TOKENS_OUT, OPUS)), 5);
        // Read once: the next scan adds nothing.
        assert_eq!(total(&run(tmp.path()), "p1", &ck(metric::TOKENS_OUT, OPUS)), 5);
    }

    #[test]
    fn detail_keys_parse() {
        let key = ck(metric::TOKENS_SUB_CACHE_R, "claude-opus-4.5");
        assert_eq!(parse_token_key(&key), Some((metric::TOKENS_SUB_CACHE_R, CLAUDE, "claude-opus-4.5")));
        assert!(parse_token_key(&ck(metric::TOKENS_CACHE_W5M, OPUS)).is_some());
    }
}
