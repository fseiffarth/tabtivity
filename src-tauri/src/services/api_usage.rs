//! The monthly spending limit on provider API keys (`docs/api_chat_plan.md`,
//! Part C, C3): the ledger of what keyed agent tabs spent through the API
//! proxy, and the limit the proxy enforces.
//!
//! **Ledger** — `<state_dir>/agent-api-usage.json`, no secrets: the UTC
//! calendar month, and per provider the US dollars spent (priced by
//! `api_prices`, an estimate) and per model the tokens and requests. Held in
//! memory, written atomically at most every [`FLUSH_DELAY`] after a change
//! (never per chunk) and once more in the `RunEvent::Exit` teardown
//! (`api_proxy::stop_for_exit`). Tolerant on the way in:
//!
//! - a missing file is an empty month;
//! - a file that does not parse, or cannot be read, is moved aside
//!   (`agent-api-usage.corrupt.json`, so the next write does not destroy its
//!   counts) and the month restarts from zero **with a note**
//!   ([`Ledger::restarted`]) that Manage CLIs shows — never silently. Only
//!   Tabtivity writes the file: a fenced agent sees an empty state dir (Linux)
//!   or cannot write it (macOS);
//! - a ledger whose month lies ahead of the clock (the clock went back) keeps
//!   counting into that month instead of being reset.
//!
//! **Limit** — `Settings::agent_api_limits` (provider id → USD per month),
//! read from `settings.json` and re-read when the file changes
//! ([`limit_for`]). Saving a key requires one (`agent_api_key_set`); a key
//! saved before limits existed has none, and its provider is refused until
//! one is set ([`Verdict::NoLimit`]). Once spent ≥ limit
//! ([`Verdict::Reached`]) the proxy refuses new billed requests; answers
//! already streaming finish, so the month can overshoot by what the turns in
//! flight at that moment cost.
//!
//! `AppHandle`-free.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use chrono::{DateTime, Datelike, Utc};
use serde::{Deserialize, Serialize};

use super::agent_api_keys::Provider;
use super::api_prices::Charge;

/// A change reaches the file at most this long after it was made.
pub const FLUSH_DELAY: Duration = Duration::from_secs(5);
/// Highest monthly limit accepted, USD.
pub const MAX_LIMIT: f64 = 1_000_000.0;
/// Models kept apart per provider per month; more are summed under
/// [`OTHER_MODELS`].
const MAX_MODELS: usize = 32;
const OTHER_MODELS: &str = "(other)";
/// Longest model name kept.
const MAX_MODEL_NAME: usize = 80;

/// Tokens and cost of one model in one month.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ModelUsage {
    pub input: u64,
    pub output: u64,
    pub cache_write: u64,
    pub cache_read: u64,
    pub web_searches: u64,
    pub requests: u64,
    pub usd: f64,
    /// Not in the price table: priced at the provider's highest rate.
    pub unknown: bool,
}

/// One provider's month.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ProviderUsage {
    pub spent_usd: f64,
    pub models: BTreeMap<String, ModelUsage>,
}

/// The month before the current one, kept for reference.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PreviousMonth {
    pub month: String,
    pub spent_usd: BTreeMap<String, f64>,
}

/// `agent-api-usage.json`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Ledger {
    pub version: u32,
    /// `YYYY-MM`, UTC.
    pub month: String,
    /// By provider id.
    pub providers: BTreeMap<String, ProviderUsage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous: Option<PreviousMonth>,
    /// When this month's count restarted because the file could not be read
    /// (RFC 3339); cleared at the next month.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restarted: Option<String>,
}

pub fn month_of(now: DateTime<Utc>) -> String {
    format!("{:04}-{:02}", now.year(), now.month())
}

/// The first day of the month after `month` (`YYYY-MM-01`), when the count
/// starts again.
pub fn resets_on(month: &str) -> String {
    let parsed = month
        .split_once('-')
        .and_then(|(y, m)| Some((y.parse::<i32>().ok()?, m.parse::<u32>().ok()?)))
        .filter(|(_, m)| (1..=12).contains(m));
    match parsed {
        Some((y, 12)) => format!("{:04}-01-01", y + 1),
        Some((y, m)) => format!("{y:04}-{:02}-01", m + 1),
        None => String::new(),
    }
}

fn valid_month(month: &str) -> bool {
    month.len() == 7 && !resets_on(month).is_empty()
}

impl Ledger {
    const VERSION: u32 = 1;

    /// Move to `now`'s month if it is later than the ledger's. Returns whether
    /// anything changed.
    pub fn roll(&mut self, now: DateTime<Utc>) -> bool {
        let current = month_of(now);
        if !valid_month(&self.month) {
            // A file without a usable month keeps its counts (an overcount
            // at worst) under the current month.
            self.month = current;
            self.version = Self::VERSION;
            return true;
        }
        if self.month >= current {
            return false;
        }
        let spent = self.providers.iter().map(|(p, u)| (p.clone(), u.spent_usd)).collect();
        self.previous = Some(PreviousMonth { month: std::mem::take(&mut self.month), spent_usd: spent });
        self.providers.clear();
        self.restarted = None;
        self.month = current;
        self.version = Self::VERSION;
        true
    }

    pub fn spent(&self, provider: Provider) -> f64 {
        self.providers.get(provider.id()).map_or(0.0, |u| u.spent_usd)
    }

    pub fn add(&mut self, provider: Provider, charge: &Charge) {
        let usage = self.providers.entry(provider.id().to_string()).or_default();
        usage.spent_usd += charge.usd.max(0.0);
        let mut name = model_name(&charge.model);
        if !usage.models.contains_key(&name) && usage.models.len() >= MAX_MODELS {
            name = OTHER_MODELS.to_string();
        }
        let m = usage.models.entry(name).or_default();
        // Saturating: a ledger file's counts are read back as they were.
        m.input = m.input.saturating_add(charge.input);
        m.output = m.output.saturating_add(charge.output);
        m.cache_write = m.cache_write.saturating_add(charge.cache_write);
        m.cache_read = m.cache_read.saturating_add(charge.cache_read);
        m.web_searches = m.web_searches.saturating_add(charge.web_searches);
        m.requests = m.requests.saturating_add(1);
        m.usd += charge.usd.max(0.0);
        m.unknown |= !charge.known;
    }

    /// The models of `provider` priced at the fallback rate this month.
    pub fn unknown_models(&self, provider: Provider) -> Vec<String> {
        self.providers
            .get(provider.id())
            .map(|u| u.models.iter().filter(|(_, m)| m.unknown).map(|(n, _)| n.clone()).collect())
            .unwrap_or_default()
    }
}

/// A model name fit for the ledger: bounded, plain characters only.
fn model_name(raw: &str) -> String {
    let name: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':' | '/' | '@' | '(' | ')'))
        .take(MAX_MODEL_NAME)
        .collect();
    if name.is_empty() { "(unknown)".to_string() } else { name }
}

/// What the proxy may do with a billed request for a provider.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Verdict {
    Open,
    /// No limit is set (a key saved before limits existed): refused until
    /// one is.
    NoLimit,
    Reached { spent: f64, limit: f64 },
}

impl Verdict {
    pub fn of(spent: f64, limit: Option<f64>) -> Self {
        match limit.filter(|l| valid_limit(*l)) {
            None => Verdict::NoLimit,
            Some(limit) if spent >= limit => Verdict::Reached { spent, limit },
            Some(_) => Verdict::Open,
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Verdict::Open => "open",
            Verdict::NoLimit => "noLimit",
            Verdict::Reached { .. } => "reached",
        }
    }
}

pub fn valid_limit(usd: f64) -> bool {
    usd.is_finite() && usd > 0.0 && usd <= MAX_LIMIT
}

// ---------------------------------------------------------------------------
// The book: the ledger in memory, its file, the throttled writer.

struct BookState {
    ledger: Ledger,
    loaded: bool,
    dirty: bool,
    flush_scheduled: bool,
}

/// The ledger of one process. [`book`] is the app's; tests make their own.
pub struct Book {
    /// `None`: memory only.
    path: Option<PathBuf>,
    state: Mutex<BookState>,
    /// Held across snapshot and write, so an older snapshot never lands
    /// after a newer one.
    writing: Mutex<()>,
    /// The exit flush ran: a charge that lands after it (an answer cut off
    /// by the quit) is written at once, not by a thread the exit outruns.
    closing: std::sync::atomic::AtomicBool,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

impl Book {
    pub fn new(path: Option<PathBuf>) -> Self {
        Book {
            path,
            state: Mutex::new(BookState { ledger: Ledger::default(), loaded: false, dirty: false, flush_scheduled: false }),
            writing: Mutex::new(()),
            closing: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// The ledger, loaded on first use and rolled to `now`'s month.
    fn with<R>(&self, now: DateTime<Utc>, f: impl FnOnce(&mut BookState) -> R) -> R {
        let mut state = lock(&self.state);
        if !state.loaded {
            state.loaded = true;
            if let Some(path) = &self.path {
                let (ledger, changed) = load(path, now);
                state.ledger = ledger;
                state.dirty |= changed;
            }
        }
        if state.ledger.roll(now) {
            state.dirty = true;
        }
        f(&mut state)
    }

    pub fn spent(&self, provider: Provider, now: DateTime<Utc>) -> f64 {
        self.with(now, |s| s.ledger.spent(provider))
    }

    /// A copy of the ledger as of `now`.
    pub fn snapshot(&self, now: DateTime<Utc>) -> Ledger {
        self.with(now, |s| s.ledger.clone())
    }

    /// Charge `provider` for one answer, and have the file follow within
    /// [`FLUSH_DELAY`].
    pub fn record(self: &Arc<Self>, provider: Provider, charge: &Charge, now: DateTime<Utc>) {
        let schedule = self.with(now, |s| {
            s.ledger.add(provider, charge);
            s.dirty = true;
            !std::mem::replace(&mut s.flush_scheduled, true)
        });
        if self.closing.load(std::sync::atomic::Ordering::Acquire) {
            self.flush();
            return;
        }
        if schedule && self.path.is_some() {
            let book = Arc::clone(self);
            let spawned = std::thread::Builder::new().name("api-usage-flush".into()).spawn(move || {
                std::thread::sleep(FLUSH_DELAY);
                book.flush();
            });
            if spawned.is_err() {
                lock(&self.state).flush_scheduled = false;
            }
        }
    }

    /// Write the ledger if it changed. A failed write keeps it pending for
    /// the next change or the exit flush.
    pub fn flush(&self) {
        let Some(path) = &self.path else { return };
        let _writing = lock(&self.writing);
        let ledger = {
            let mut s = lock(&self.state);
            s.flush_scheduled = false;
            if !s.dirty || !s.loaded {
                return;
            }
            s.dirty = false;
            s.ledger.clone()
        };
        if let Err(e) = crate::storage::write_json_atomic(path, &ledger) {
            eprintln!("[api-usage] could not write the usage ledger: {e}");
            lock(&self.state).dirty = true;
        }
    }
}

/// The ledger at `path`, and whether it must be written back (moved aside,
/// rolled, or new).
fn load(path: &Path, now: DateTime<Utc>) -> (Ledger, bool) {
    match std::fs::read(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (Ledger::default(), false),
        Ok(bytes) => match serde_json::from_slice::<Ledger>(&bytes) {
            Ok(ledger) => (ledger, false),
            Err(_) => (restarted(path, now, true), true),
        },
        // Unreadable (permissions, I/O): counted from zero, said so, and kept
        // aside like a corrupt one, so the next write does not replace it.
        Err(_) => (restarted(path, now, true), true),
    }
}

fn restarted(path: &Path, now: DateTime<Utc>, move_aside: bool) -> Ledger {
    if move_aside {
        let aside = path.with_file_name("agent-api-usage.corrupt.json");
        if std::fs::rename(path, &aside).is_ok() {
            eprintln!("[api-usage] the usage ledger could not be read; kept as {}", aside.display());
        }
    }
    Ledger {
        version: Ledger::VERSION,
        month: month_of(now),
        restarted: Some(now.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
        ..Ledger::default()
    }
}

pub fn ledger_path() -> PathBuf {
    crate::storage::state_dir().join("agent-api-usage.json")
}

/// The app's book, over `<state_dir>/agent-api-usage.json`.
pub fn book() -> Arc<Book> {
    static BOOK: OnceLock<Arc<Book>> = OnceLock::new();
    BOOK.get_or_init(|| Arc::new(Book::new(Some(ledger_path())))).clone()
}

/// The exit teardown's write; later charges are written as they land.
pub fn flush_for_exit() {
    let book = book();
    book.closing.store(true, std::sync::atomic::Ordering::Release);
    book.flush();
}

// ---------------------------------------------------------------------------
// Limits

/// Every valid limit in `settings`, by provider id.
pub fn limits_in(settings: &crate::schema::Settings) -> BTreeMap<String, f64> {
    settings
        .agent_api_limits
        .iter()
        .flatten()
        .filter(|(p, usd)| Provider::from_id(p).is_some() && valid_limit(**usd))
        .map(|(p, usd)| (p.clone(), *usd))
        .collect()
}

type Stamp = Option<(SystemTime, u64)>;
/// The file's stamp, when it was read, and its limits.
type CachedLimits = (Stamp, std::time::Instant, BTreeMap<String, f64>);

/// A cached read of the limits is trusted this long even when the file's
/// stamp did not change (a write within the stamp's resolution keeping the
/// size is then seen within this time).
const LIMITS_FRESH: Duration = Duration::from_secs(10);

/// `provider`'s monthly limit from `settings.json`, re-read when the file's
/// modification time or size changed, or [`LIMITS_FRESH`] after the last
/// read (the proxy asks per request).
pub fn limit_for(provider: Provider) -> Option<f64> {
    static CACHE: Mutex<Option<CachedLimits>> = Mutex::new(None);
    let path = crate::storage::state_dir().join("settings.json");
    let stamp: Stamp = std::fs::metadata(&path).ok().and_then(|m| Some((m.modified().ok()?, m.len())));
    let mut cache = lock(&CACHE);
    let fresh = matches!(&*cache, Some((s, read, _)) if stamp.is_some() && *s == stamp && read.elapsed() < LIMITS_FRESH);
    if !fresh {
        let settings: crate::schema::Settings = crate::storage::read_json(&path).unwrap_or_default();
        *cache = Some((stamp, std::time::Instant::now(), limits_in(&settings)));
    }
    cache.as_ref().and_then(|(_, _, l)| l.get(provider.id()).copied())
}

/// What the proxy may do with `provider`'s next billed request now.
pub fn verdict(provider: Provider) -> Verdict {
    Verdict::of(book().spent(provider, Utc::now()), limit_for(provider))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(y: i32, m: u32, d: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, m, d, 12, 0, 0).unwrap()
    }

    fn charge(model: &str, usd: f64, known: bool) -> Charge {
        Charge { model: model.into(), known, input: 10, output: 20, cache_write: 3, cache_read: 4, web_searches: 1, usd }
    }

    #[test]
    fn months_and_reset_dates() {
        assert_eq!(month_of(at(2026, 10, 4)), "2026-10");
        assert_eq!(resets_on("2026-10"), "2026-11-01");
        assert_eq!(resets_on("2026-12"), "2027-01-01");
        assert_eq!(resets_on("garbage"), "");
        assert_eq!(resets_on("2026-13"), "");
    }

    #[test]
    fn the_ledger_round_trips_and_adds_up() {
        let mut l = Ledger::default();
        l.roll(at(2026, 10, 4));
        l.add(Provider::Anthropic, &charge("claude-opus-5-5", 1.5, true));
        l.add(Provider::Anthropic, &charge("claude-opus-5-5", 0.5, true));
        l.add(Provider::Anthropic, &charge("claude-new", 2.0, false));
        l.add(Provider::Gemini, &charge("gemini-2.5-pro", 0.25, true));
        assert!((l.spent(Provider::Anthropic) - 4.0).abs() < 1e-9);
        assert_eq!(l.unknown_models(Provider::Anthropic), ["claude-new"]);
        let m = &l.providers["anthropic"].models["claude-opus-5-5"];
        assert_eq!((m.input, m.output, m.cache_write, m.cache_read, m.web_searches, m.requests), (20, 40, 6, 8, 2, 2));
        let json = serde_json::to_string(&l).unwrap();
        assert!(!json.contains("restarted"));
        let back: Ledger = serde_json::from_str(&json).unwrap();
        assert_eq!(back, l);
        // Unknown fields from a newer build and missing ones from an older
        // one are both fine.
        let older: Ledger = serde_json::from_str(r#"{"month":"2026-10","providers":{"gemini":{"spent_usd":1.0}},"future":1}"#).unwrap();
        assert!((older.spent(Provider::Gemini) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn model_names_are_bounded_in_kind_and_number() {
        let mut l = Ledger::default();
        l.roll(at(2026, 10, 4));
        l.add(Provider::Gemini, &charge(&format!("evil\n\"name{}", "x".repeat(500)), 0.1, false));
        let name = l.providers["gemini"].models.keys().next().unwrap().clone();
        assert!(name.len() <= MAX_MODEL_NAME && name.starts_with("evilname"), "{name}");
        for i in 0..100 {
            l.add(Provider::Gemini, &charge(&format!("m{i}"), 0.01, true));
        }
        let models = &l.providers["gemini"].models;
        assert_eq!(models.len(), MAX_MODELS + 1);
        assert!(models.contains_key(OTHER_MODELS));
    }

    #[test]
    fn a_new_month_starts_from_zero_and_the_clock_going_back_resets_nothing() {
        let mut l = Ledger::default();
        l.roll(at(2026, 10, 4));
        l.add(Provider::Anthropic, &charge("m", 3.0, true));
        l.restarted = Some("x".into());
        assert!(!l.roll(at(2026, 10, 31)));
        assert!(!l.roll(at(2026, 9, 30)), "an earlier clock keeps the month");
        assert!((l.spent(Provider::Anthropic) - 3.0).abs() < 1e-9);
        assert!(l.roll(at(2026, 11, 1)));
        assert_eq!(l.month, "2026-11");
        assert_eq!(l.spent(Provider::Anthropic), 0.0);
        assert_eq!(l.restarted, None);
        let prev = l.previous.as_ref().unwrap();
        assert_eq!(prev.month, "2026-10");
        assert!((prev.spent_usd["anthropic"] - 3.0).abs() < 1e-9);
        // A year boundary.
        let mut l = Ledger { month: "2026-12".into(), ..Default::default() };
        assert!(l.roll(at(2027, 1, 1)));
        assert_eq!(l.month, "2027-01");
        // No usable month: counts kept under the current one.
        let mut l = Ledger { month: "??".into(), ..Default::default() };
        l.add(Provider::Gemini, &charge("m", 1.0, true));
        assert!(l.roll(at(2026, 10, 4)));
        assert_eq!(l.month, "2026-10");
        assert!((l.spent(Provider::Gemini) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn verdicts() {
        assert_eq!(Verdict::of(0.0, None), Verdict::NoLimit);
        assert_eq!(Verdict::of(0.0, Some(0.0)), Verdict::NoLimit);
        assert_eq!(Verdict::of(0.0, Some(f64::NAN)), Verdict::NoLimit);
        assert_eq!(Verdict::of(19.99, Some(20.0)), Verdict::Open);
        assert_eq!(Verdict::of(20.0, Some(20.0)), Verdict::Reached { spent: 20.0, limit: 20.0 });
        assert!(!valid_limit(-1.0) && !valid_limit(f64::INFINITY) && !valid_limit(MAX_LIMIT * 2.0));
    }

    #[test]
    fn the_book_writes_on_flush_and_reads_its_file_back() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agent-api-usage.json");
        let book = Arc::new(Book::new(Some(path.clone())));
        let now = at(2026, 10, 4);
        book.record(Provider::Anthropic, &charge("claude-opus-5-5", 1.25, true), now);
        // Throttled: nothing on disk until the flush.
        assert!(!path.exists());
        book.flush();
        let on_disk: Ledger = crate::storage::read_json(&path).unwrap();
        assert!((on_disk.spent(Provider::Anthropic) - 1.25).abs() < 1e-9);
        assert_eq!(on_disk.month, "2026-10");
        // A fresh book (the next run) picks it up.
        let again = Book::new(Some(path.clone()));
        assert!((again.spent(Provider::Anthropic, now) - 1.25).abs() < 1e-9);
        // And the next month starts from zero, writing the rollover back.
        assert_eq!(again.spent(Provider::Anthropic, at(2026, 11, 2)), 0.0);
        again.flush();
        let on_disk: Ledger = crate::storage::read_json(&path).unwrap();
        assert_eq!(on_disk.month, "2026-11");
        assert_eq!(on_disk.previous.unwrap().month, "2026-10");
        // The scheduled flush lands by itself.
        book.record(Provider::Gemini, &charge("gemini-2.5-pro", 0.5, true), now);
        std::thread::sleep(FLUSH_DELAY + Duration::from_millis(500));
        let on_disk: Ledger = crate::storage::read_json(&path).unwrap();
        assert!((on_disk.spent(Provider::Gemini) - 0.5).abs() < 1e-9);
    }

    #[test]
    fn a_corrupt_file_is_kept_aside_and_the_restart_is_said() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agent-api-usage.json");
        std::fs::write(&path, b"{\"month\":\"2026-10\",\"providers\":{tru").unwrap();
        let book = Book::new(Some(path.clone()));
        let now = at(2026, 10, 4);
        let snap = book.snapshot(now);
        assert_eq!(snap.spent(Provider::Anthropic), 0.0);
        assert_eq!(snap.restarted.as_deref(), Some("2026-10-04T12:00:00Z"));
        let aside = dir.path().join("agent-api-usage.corrupt.json");
        assert_eq!(std::fs::read(&aside).unwrap(), b"{\"month\":\"2026-10\",\"providers\":{tru");
        book.flush();
        let on_disk: Ledger = crate::storage::read_json(&path).unwrap();
        assert!(on_disk.restarted.is_some());
        // A missing file is just an empty month, no note.
        let fresh = Book::new(Some(dir.path().join("none.json")));
        assert_eq!(fresh.snapshot(now).restarted, None);
    }

    #[test]
    fn after_the_exit_flush_a_charge_is_written_at_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agent-api-usage.json");
        let book = Arc::new(Book::new(Some(path.clone())));
        let now = at(2026, 10, 4);
        book.closing.store(true, std::sync::atomic::Ordering::Release);
        book.record(Provider::Anthropic, &charge("claude-opus-5-5", 2.0, true), now);
        let on_disk: Ledger = crate::storage::read_json(&path).unwrap();
        assert!((on_disk.spent(Provider::Anthropic) - 2.0).abs() < 1e-9);
    }

    #[test]
    fn counts_read_back_near_the_top_saturate_instead_of_wrapping() {
        let mut ledger = Ledger::default();
        let mut big = charge("m", 1.0, true);
        big.input = u64::MAX - 1;
        ledger.add(Provider::Anthropic, &big);
        ledger.add(Provider::Anthropic, &big);
        assert_eq!(ledger.providers["anthropic"].models["m"].input, u64::MAX);
        assert!((ledger.spent(Provider::Anthropic) - 2.0).abs() < 1e-9);
    }

    #[test]
    fn limits_come_from_settings_and_only_valid_ones_count() {
        let s: crate::schema::Settings =
            serde_json::from_str(r#"{"agent_api_limits":{"anthropic":20,"gemini":-1,"openai":5}}"#).unwrap();
        let limits = limits_in(&s);
        assert_eq!(limits.len(), 1);
        assert_eq!(limits["anthropic"], 20.0);
    }
}
