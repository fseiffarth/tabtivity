//! Agent token counts per CLI, model and scope — the `tokens.*` keys of the
//! usage recap (`docs/token_stats_plan.md`).
//!
//! **Derived from the CLIs' own records, never counted live.** Every local
//! agent tab's `$HOME` is an Tabtivity-owned agent home (`services::agent_home`),
//! and Claude and Codex already write per-message usage there. Reading it at
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
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::schema::usage_stats::{metric, Counters, UsageStats};
use crate::services::agent_home;
use crate::services::agent_session::clean_model_name;
use crate::services::codex_store;
use crate::services::home_io::{HomeDir, HomeFile};
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
pub const SOURCES: [&str; 2] = [CLAUDE, CODEX];

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
    let known = SPLIT.contains(&prefix) || prefix == metric::TOKENS_TOTAL;
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
}

/// A Claude message already counted, kept so its repeat lines add nothing.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Recent {
    key: String,
    hour: String,
    model: String,
    /// What has been counted for it so far, in [`SPLIT`] order.
    n: [u64; 4],
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
fn claude_line(cursor: &mut Cursor, cutoff_ms: Option<i64>, now_ms: i64, line: &[u8]) {
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
    let key = dedupe_key(message.id.as_deref(), record.request_id.as_deref());
    if let Some(seen) = key
        .as_ref()
        .and_then(|key| cursor.recent.iter_mut().find(|r| &r.key == key))
    {
        for ((prefix, new), old) in SPLIT.iter().zip(n).zip(seen.n.iter_mut()) {
            if new > *old {
                let delta = new - *old;
                *old = new;
                let k = token_key(prefix, CLAUDE, &seen.model);
                cursor.contribution.add(&cursor.scope, &seen.hour, &k, delta);
            }
        }
        return;
    }
    let model = model_or_unknown(raw_model);
    for (prefix, value) in SPLIT.iter().zip(n) {
        cursor.add(&hour, prefix, CLAUDE, &model, value);
    }
    if let Some(key) = key {
        cursor.recent.push_back(Recent { key, hour, model, n });
        while cursor.recent.len() > DEDUPE_WINDOW {
            cursor.recent.pop_front();
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
    use rusqlite::{Connection, OpenFlags};

    let conn = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
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
            || meta.len < cursor.offset;
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
        let exhausted = match kind {
            Kind::Claude => read_lines(&mut reader, &mut pos, max_line, &mut self.budget, &mut self.buf, |line| {
                claude_line(cursor, ctx.claude_cutoff_ms, now_ms, line)
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
            Kind::CodexDb => false,
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
                let kept: Vec<String> = self
                    .cache
                    .files
                    .range(prefix.clone()..)
                    .take_while(|(key, _)| key.starts_with(&prefix))
                    .map(|(key, _)| key.clone())
                    .collect();
                self.seen.extend(kept);
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

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or(0)
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
    scan_with(state_dir, scopes, Limits::default(), now_ms())
}

/// [`scan`] with explicit limits and clock.
pub fn scan_with(state_dir: &Path, scopes: &[String], limits: Limits, now_ms: i64) -> TokenStats {
    // Two recap windows opening at once must not interleave their cursors.
    let _guard = SCAN_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = state_dir.join(CACHE_FILE);
    let mut cache = load_cache(&path);
    // A scope's local-model home counts toward the scope, like its own.
    let by_home: HashMap<PathBuf, &str> = scopes
        .iter()
        .flat_map(|id| {
            [agent_home::scope_home_in(state_dir, id), agent_home::local_model_home_in(state_dir, id)]
                .map(|home| (home, id.as_str()))
        })
        .collect();
    let host = agent_home::host_home_in(state_dir);

    let mut homes = Vec::new();
    for dir in agent_home::existing_homes_in(state_dir) {
        let Some(name) = dir.file_name().and_then(|n| n.to_str()).map(str::to_string) else {
            continue;
        };
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
}
