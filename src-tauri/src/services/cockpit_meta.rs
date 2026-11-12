//! Agent-authored tab metadata: `TabEntry.extra["cockpitMeta"]`, written only
//! by the host on behalf of an agent's own `/mcp/cockpit` calls
//! (`services::cockpit_mcp`). Design: `docs/cockpit_mcp_extensions_plan.md`
//! (fixed decisions), as built: `docs/context/cockpit_mcp.md`.
//!
//! Shape: `{v: 1, revision, activity?: {text, setAt, spawn}, handoff?:
//! {summary, checks, remaining, setAt}, results?: {items: [{label,
//! relativePath}], setAt}, progress?: {steps: [{id, label, state}], setAt,
//! spawn, ended?}, blocker?: {text, setAt, spawn}, verification?: {entries:
//! [{label, outcome, note?}], setAt}, attention?: {id, question, setAt, spawn,
//! dismissed?}, milestones?: [{requestId, text, at}], …later keys}`. `setAt` is the host's
//! clock (ms since the epoch). The key is absent until an agent first writes;
//! once present it stays (cleared fields leave `revision` behind), so a
//! revision never repeats and a stale `expectedRevision` can never match a
//! later state.
//!
//! **Host-owned.** `workspace::merge` hands a kept tab the held copy's value
//! whatever a client sent and strips it from a created tab, so a stale desktop
//! snapshot cannot erase it and no browser/phone save can author it.
//! `workspace::edit_in` is the one writer, and stamps the tab's
//! `updatedVersion`, so every change moves the workspace version.
//!
//! Everything here is agent-supplied text: bounded, plain, never executed or
//! interpreted. The `spawn` nonce is not a secret; it only tells a later spawn
//! which activity is not its own.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::schema::project::TabEntry;
use crate::services::workspace;

/// `TabEntry.extra`: the metadata object.
pub const KEY: &str = "cockpitMeta";
pub const SCHEMA_VERSION: u64 = 1;
/// Activity subtitle, in characters (one line).
pub const ACTIVITY_MAX_CHARS: usize = 160;
/// Each handoff field, in characters.
pub const HANDOFF_FIELD_MAX_CHARS: usize = 1_000;
/// The three handoff fields together, in characters.
pub const HANDOFF_TOTAL_MAX_CHARS: usize = 3_000;
/// Result references an agent may list.
pub const RESULTS_MAX_ITEMS: usize = 8;
/// A result's label, in characters.
pub const RESULT_LABEL_MAX_CHARS: usize = 120;
/// A result's project-relative path, in characters.
pub const RESULT_PATH_MAX_CHARS: usize = 512;
/// Progress steps an agent may list.
pub const PROGRESS_MAX_STEPS: usize = 8;
/// A progress step's id, in characters (`[a-z0-9_-]`).
pub const PROGRESS_ID_MAX_CHARS: usize = 40;
/// A progress step's label, in characters.
pub const PROGRESS_LABEL_MAX_CHARS: usize = 120;
/// The blocker line, in characters (one line).
pub const BLOCKER_MAX_CHARS: usize = 300;
/// Verification entries an agent may list.
pub const VERIFICATION_MAX_ENTRIES: usize = 8;
/// A verification entry's label, in characters.
pub const VERIFICATION_LABEL_MAX_CHARS: usize = 120;
/// A verification entry's note, in characters (newlines allowed).
pub const VERIFICATION_NOTE_MAX_CHARS: usize = 300;
/// The attention question, in characters (newlines allowed).
pub const ATTENTION_MAX_CHARS: usize = 500;
/// A milestone's text, in characters (one line).
pub const MILESTONE_MAX_CHARS: usize = 200;
/// A milestone's request id, in characters (`[A-Za-z0-9_-]`).
pub const MILESTONE_ID_MAX_CHARS: usize = 64;
/// Milestones kept (oldest dropped past this).
pub const MILESTONES_MAX: usize = 20;
/// The longest attention id a dismissal may name (the host mints 32).
pub const ATTENTION_ID_MAX_CHARS: usize = 64;
/// The whole stored object as JSON, in bytes.
pub const META_MAX_BYTES: usize = 32 * 1024;
/// What the host's own markers (`dismissed`, `ended`, a longer revision) may
/// add above [`META_MAX_BYTES`]; the bound limits the agent, not the host.
pub const HOST_ALLOWANCE_BYTES: usize = 256;
/// How long an activity line, a blocker or a progress report counts as current
/// (a progress report older than this is history, never running).
pub const ACTIVITY_TTL_MS: u64 = 30 * 60 * 1000;
/// How long an attention question stays open without the user's dismissal.
pub const ATTENTION_TTL_MS: u64 = 24 * 60 * 60 * 1000;
/// A `setAt` further ahead of the clock than this is a moved-back clock, not
/// a fresh line.
const FUTURE_SLACK_MS: u64 = 60 * 1000;

/// What a refused read or write is told about stored metadata that this build
/// cannot read (not an object, another schema version, a wrong field type).
pub const CORRUPT: &str = "corrupt_meta";
/// The stored object would pass [`META_MAX_BYTES`].
pub const TOO_LARGE: &str = "too_large";
/// The caller's `expectedRevision` is not the stored revision.
pub const CONFLICT: &str = "conflict";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub text: String,
    pub set_at: u64,
    /// The issuing spawn's nonce (`Binding.spawn`); not a secret.
    pub spawn: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Handoff {
    pub summary: String,
    pub checks: String,
    pub remaining: String,
    pub set_at: u64,
}

/// One result reference: a label and a path relative to the project folder.
/// A reference, not a capability — nothing reads the file until the user
/// opens it (`services::cockpit_results`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultItem {
    pub label: String,
    pub relative_path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Results {
    pub items: Vec<ResultItem>,
    pub set_at: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepState {
    Pending,
    Active,
    Done,
}

impl StepState {
    const ALL: [Self; 3] = [Self::Pending, Self::Active, Self::Done];
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Active => "active",
            Self::Done => "done",
        }
    }
    /// The state [`as_str`](Self::as_str) names `name`; only those strings.
    fn from_name(name: &str) -> Option<Self> { Self::ALL.into_iter().find(|s| s.as_str() == name) }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProgressStep {
    pub id: String,
    pub label: String,
    pub state: StepState,
}

/// The steps an agent reported, with the spawn that reported them. Kept as
/// history: once its spawn is gone (`ended`) or it is older than the
/// freshness bound it is a past report, never a running one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub steps: Vec<ProgressStep>,
    pub set_at: u64,
    /// The issuing spawn's nonce; not a secret.
    pub spawn: String,
    /// Set by the host when a later spawn (or a reopen) took over the tab.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub ended: bool,
}

/// What the agent says is in its way. Transient exactly like [`Activity`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Blocker {
    pub text: String,
    pub set_at: u64,
    pub spawn: String,
}

/// What the agent states about a check. A statement, never a result the host
/// observed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckOutcome {
    Passed,
    Failed,
    Pending,
    NotRun,
}

impl CheckOutcome {
    const ALL: [Self; 4] = [Self::Passed, Self::Failed, Self::Pending, Self::NotRun];
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Passed => "passed",
            Self::Failed => "failed",
            Self::Pending => "pending",
            Self::NotRun => "not_run",
        }
    }
    /// The outcome [`as_str`](Self::as_str) names `name`; only those strings.
    fn from_name(name: &str) -> Option<Self> { Self::ALL.into_iter().find(|o| o.as_str() == name) }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VerificationEntry {
    pub label: String,
    pub outcome: CheckOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Verification {
    pub entries: Vec<VerificationEntry>,
    /// When the agent reported them (host clock), not when anything ran.
    pub set_at: u64,
}

/// One question the agent says it needs the user for. The id is the host's,
/// new for every changed question; `dismissed` is the user's (a narrow command,
/// never a client save). It asks nothing of the app: no answer, no approval.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attention {
    pub id: String,
    pub question: String,
    pub set_at: u64,
    /// The issuing spawn's nonce; not a secret.
    pub spawn: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub dismissed: bool,
}

/// One entry of the agent's bounded history; `at` is the host's clock.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Milestone {
    pub request_id: String,
    pub text: String,
    pub at: u64,
}

/// The handoff fields an agent supplies (the host adds `setAt`).
#[derive(Debug, Clone, PartialEq)]
pub struct HandoffText {
    pub summary: String,
    pub checks: String,
    pub remaining: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Meta {
    pub v: u64,
    #[serde(default)]
    pub revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activity: Option<Activity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handoff: Option<Handoff>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub results: Option<Results>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<Progress>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocker: Option<Blocker>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verification: Option<Verification>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attention: Option<Attention>,
    /// Oldest first, newest last, at most [`MILESTONES_MAX`].
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub milestones: Vec<Milestone>,
    /// The label the tab's agent last gave it through `tab_rename`. While the
    /// tab still carries it, the next conversation (after a `/clear`) may
    /// rename the tab again; a label the user set never matches. Not a note:
    /// it takes no revision.
    #[serde(default, rename = "agentLabel", skip_serializing_if = "Option::is_none")]
    pub agent_label: Option<String>,
    /// Keys a later build adds ride through every rewrite untouched.
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

impl Default for Meta {
    fn default() -> Self {
        Self {
            v: SCHEMA_VERSION, revision: 0, activity: None, handoff: None, results: None,
            progress: None, blocker: None, verification: None, attention: None, milestones: Vec::new(),
            agent_label: None, rest: Map::new(),
        }
    }
}

/// Whether an activity stamped `set_at` still counts as current at `now`.
pub fn is_fresh(set_at: u64, now: u64) -> bool {
    stamped_within(set_at, now, ACTIVITY_TTL_MS)
}

/// Whether an attention question stamped `set_at` is still open at `now`
/// (24 hours, the same clock-moved-back guard).
pub fn attention_is_live(set_at: u64, now: u64) -> bool {
    stamped_within(set_at, now, ATTENTION_TTL_MS)
}

/// Whether a stamp `set_at` is under `ttl` old at `now`; one from further than
/// [`FUTURE_SLACK_MS`] ahead (a clock moved back) is not.
fn stamped_within(set_at: u64, now: u64, ttl: u64) -> bool {
    set_at <= now.saturating_add(FUTURE_SLACK_MS) && now.saturating_sub(set_at) < ttl
}

/// 128 random bits as hex, from `fill`; `None` when `fill` fails. A failed
/// generator must never leave an all-zero nonce or id (it would join every
/// spawn and break the dismissal compare-and-swap), so the failure is the
/// caller's to handle. `fill` is a parameter only so a test can fail it.
fn mint_with(fill: impl FnOnce(&mut [u8]) -> bool) -> Option<String> {
    let mut bytes = [0u8; 16];
    fill(&mut bytes).then(|| crate::digest::hex(&bytes))
}

/// A fresh 128-bit nonce naming one spawn generation (hex). `None` when the
/// system has no randomness: no grant is made for that spawn.
pub fn mint_spawn() -> Option<String> {
    mint_with(|bytes| getrandom::fill(bytes).is_ok())
}

/// A fresh id for one attention question (same entropy as a spawn nonce).
/// `None` when the system has no randomness: the ask is refused.
pub fn mint_attention_id() -> Option<String> {
    mint_spawn()
}

/// The tab's metadata; `Default` when it has none.
pub fn read(tab: &TabEntry) -> Result<Meta, &'static str> {
    match tab.extra.get(KEY) {
        None | Some(Value::Null) => Ok(Meta::default()),
        Some(value) => {
            let meta = Meta::deserialize(value).map_err(|_| CORRUPT)?;
            if meta.v == SCHEMA_VERSION { Ok(meta) } else { Err(CORRUPT) }
        }
    }
}

/// Store `meta` on the tab, refusing before any mutation when it would pass
/// the size bound (JSON bytes, so multi-byte text counts for what it costs).
/// For what the agent writes.
pub fn store(tab: &mut TabEntry, meta: &Meta) -> Result<(), &'static str> {
    store_within(tab, meta, META_MAX_BYTES)
}

/// [`store`] for the host's own bookkeeping (a dismissal, an `ended` marker):
/// the bound limits what the agent writes, so a record the agent filled to it
/// still takes the few bytes of a marker. The allowance is fixed and far
/// above one marker, so nothing the host adds can grow without limit.
fn store_host(tab: &mut TabEntry, meta: &Meta) -> Result<(), &'static str> {
    store_within(tab, meta, META_MAX_BYTES + HOST_ALLOWANCE_BYTES)
}

fn store_within(tab: &mut TabEntry, meta: &Meta, limit: usize) -> Result<(), &'static str> {
    let value = serde_json::to_value(meta).map_err(|_| CORRUPT)?;
    let size = serde_json::to_vec(&value).map_err(|_| CORRUPT)?.len();
    if size > limit {
        return Err(TOO_LARGE);
    }
    tab.extra.insert(KEY.to_string(), value);
    Ok(())
}

/// Note on a tab its agent just renamed that the agent gave it `label`. Best
/// effort: unreadable metadata, or a record the note would push past the size
/// bound, keeps the rename and drops the note.
pub fn stamp_agent_label(tab: &mut TabEntry, label: &str) {
    let Ok(mut meta) = read(tab) else { return };
    meta.agent_label = Some(label.to_string());
    let _ = store(tab, &meta);
}

/// Whether `label` is the one the tab's agent last gave it.
pub fn label_is_agents(meta: &Meta, label: &str) -> bool {
    meta.agent_label.as_deref() == Some(label)
}

/// Remove whatever a client or a record brought. For a tab the host did not
/// hold before.
pub fn strip(tab: &mut TabEntry) {
    tab.extra.remove(KEY);
}

/// Make `next` carry exactly the held tab's metadata: inserted or removed to
/// match, whatever `next` had.
pub fn carry(next: &mut TabEntry, held: &TabEntry) {
    match held.extra.get(KEY) {
        Some(value) => {
            next.extra.insert(KEY.to_string(), value.clone());
        }
        None => {
            next.extra.remove(KEY);
        }
    }
}

/// What a spawn other than `spawn` issued stops being live: its activity,
/// blocker and attention question go, its progress stays as an ended (past) report. The historical
/// notes (handoff, results, verification) are untouched. Whether anything
/// changed.
fn retire_other_spawns(meta: &mut Meta, spawn: &str) -> bool {
    let mut changed = false;
    if meta.activity.as_ref().is_some_and(|a| a.spawn != spawn) {
        meta.activity = None;
        changed = true;
    }
    if meta.blocker.as_ref().is_some_and(|b| b.spawn != spawn) {
        meta.blocker = None;
        changed = true;
    }
    if let Some(p) = meta.progress.as_mut().filter(|p| p.spawn != spawn && !p.ended) {
        p.ended = true;
        changed = true;
    }
    // A question belongs to the spawn that asked it: the one that replaced
    // that agent (or a reopen) is not asking it.
    if meta.attention.as_ref().is_some_and(|a| a.spawn != spawn) {
        meta.attention = None;
        changed = true;
    }
    changed
}

/// Drop what is spawn-bound from a record that is about to become a new tab
/// (a reopen), leaving the historical notes (an old progress report stays, as
/// a past one). Unreadable metadata stays as it is.
pub fn drop_transient(tab: &mut TabEntry) {
    if let Ok(mut meta) = read(tab) {
        // No spawn matches the empty nonce: every spawn-bound field is old.
        if retire_other_spawns(&mut meta, "") {
            meta.revision = meta.revision.saturating_add(1);
            let _ = store_host(tab, &meta);
        }
    }
}

// ── Validation ──────────────────────────────────────────────────────────────

/// Agent text, made safe to keep: trimmed, within `max` characters, no control
/// or invisible/bidi formatting characters. Newlines are ordinary in a
/// `multiline` note (CRLF is folded to LF) and refused otherwise. `None` for
/// anything refused, and for empty text unless `allow_empty`.
pub fn clean_text(raw: &str, max: usize, multiline: bool, allow_empty: bool) -> Option<String> {
    let folded;
    let raw = if multiline && raw.contains('\r') {
        folded = raw.replace("\r\n", "\n");
        folded.as_str()
    } else {
        raw
    };
    let text = raw.trim();
    let plain = |c: char| !c.is_control() || (multiline && c == '\n');
    (text.chars().count() <= max
        && (allow_empty || !text.is_empty())
        && text.chars().all(plain)
        && crate::services::root_mcp_mail::strip_invisible(text) == text)
    .then(|| text.to_string())
}

pub fn clean_activity(raw: &str) -> Option<String> {
    clean_text(raw, ACTIVITY_MAX_CHARS, false, false)
}

/// A result's label: the same plain single line as a tab label, in characters.
pub fn clean_result_label(raw: &str) -> Option<String> {
    clean_text(raw, RESULT_LABEL_MAX_CHARS, false, false)
}

pub fn clean_handoff(summary: &str, checks: &str, remaining: &str) -> Option<HandoffText> {
    let summary = clean_text(summary, HANDOFF_FIELD_MAX_CHARS, true, false)?;
    let checks = clean_text(checks, HANDOFF_FIELD_MAX_CHARS, true, true)?;
    let remaining = clean_text(remaining, HANDOFF_FIELD_MAX_CHARS, true, true)?;
    let total = summary.chars().count() + checks.chars().count() + remaining.chars().count();
    (total <= HANDOFF_TOTAL_MAX_CHARS).then_some(HandoffText { summary, checks, remaining })
}

/// The blocker line: the same plain single line as an activity, longer.
pub fn clean_blocker(raw: &str) -> Option<String> {
    clean_text(raw, BLOCKER_MAX_CHARS, false, false)
}

/// The attention question: a note that may span lines, 500 characters.
pub fn clean_attention(raw: &str) -> Option<String> {
    clean_text(raw, ATTENTION_MAX_CHARS, true, false)
}

/// A milestone's one plain line, 200 characters.
pub fn clean_milestone(raw: &str) -> Option<String> {
    clean_text(raw, MILESTONE_MAX_CHARS, false, false)
}

/// A milestone's request id: 1-64 characters of `[A-Za-z0-9_-]`, as supplied.
pub fn valid_request_id(id: &str) -> bool {
    let n = id.chars().count();
    (1..=MILESTONE_ID_MAX_CHARS).contains(&n) && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
}

/// A progress step id: 1–40 characters of `[a-z0-9_-]`, as supplied.
fn valid_step_id(id: &str) -> bool {
    let n = id.chars().count();
    (1..=PROGRESS_ID_MAX_CHARS).contains(&n) && id.chars().all(|c| matches!(c, 'a'..='z' | '0'..='9' | '_' | '-'))
}

/// The steps an agent supplied, each exactly `{id, label, state}`: at most 8,
/// unique ids, labels as plain lines, a known state and at most one `active`.
/// `None` for anything else. An empty list is valid (it clears).
pub fn clean_progress(list: &[Value]) -> Option<Vec<ProgressStep>> {
    if list.len() > PROGRESS_MAX_STEPS {
        return None;
    }
    let mut steps: Vec<ProgressStep> = Vec::with_capacity(list.len());
    for item in list {
        let fields = item.as_object()?;
        if fields.len() != 3 {
            return None;
        }
        let id = fields.get("id")?.as_str()?;
        let state = StepState::from_name(fields.get("state")?.as_str()?)?;
        let label = clean_text(fields.get("label")?.as_str()?, PROGRESS_LABEL_MAX_CHARS, false, false)?;
        if !valid_step_id(id) || steps.iter().any(|s| s.id == id) {
            return None;
        }
        steps.push(ProgressStep { id: id.to_string(), label, state });
    }
    (steps.iter().filter(|s| s.state == StepState::Active).count() <= 1).then_some(steps)
}

/// The verification entries an agent supplied: `{label, outcome, note?}`, at
/// most 8, a known outcome, a plain-line label and an optional note that may
/// span lines (an empty note is no note). `None` for anything else.
pub fn clean_verification(list: &[Value]) -> Option<Vec<VerificationEntry>> {
    if list.len() > VERIFICATION_MAX_ENTRIES {
        return None;
    }
    let mut entries = Vec::with_capacity(list.len());
    for item in list {
        let fields = item.as_object()?;
        if !fields.keys().all(|k| matches!(k.as_str(), "label" | "outcome" | "note")) {
            return None;
        }
        let outcome = CheckOutcome::from_name(fields.get("outcome")?.as_str()?)?;
        let label = clean_text(fields.get("label")?.as_str()?, VERIFICATION_LABEL_MAX_CHARS, false, false)?;
        let note = match fields.get("note") {
            None => None,
            Some(v) => Some(clean_text(v.as_str()?, VERIFICATION_NOTE_MAX_CHARS, true, true)?).filter(|n| !n.is_empty()),
        };
        entries.push(VerificationEntry { label, outcome, note });
    }
    Some(entries)
}

// ── Changes ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub enum Change {
    /// `None` clears the activity line.
    Activity { text: Option<String>, spawn: String },
    /// `None` clears the handoff.
    Handoff(Option<HandoffText>),
    /// Already validated items (`services::cockpit_results`); empty clears.
    Results(Vec<ResultItem>),
    /// Already validated steps ([`clean_progress`]); empty clears.
    Progress { steps: Vec<ProgressStep>, spawn: String },
    /// `None` clears the blocker.
    Blocker { text: Option<String>, spawn: String },
    /// Already validated entries ([`clean_verification`]); empty clears.
    Verification(Vec<VerificationEntry>),
    /// `None` clears the question; `id` is the host-minted id a changed
    /// question takes.
    Attention { question: Option<String>, id: String, spawn: String },
    /// Append-only, so it takes no `expectedRevision` (a repeated `request_id`
    /// among the retained entries is a no-op).
    Milestone { request_id: String, text: String },
}

/// The metadata after `change`, or `None` when the change is a no-op: a clear
/// of nothing, an identical handoff or result list, the same still-fresh
/// line from the same spawn (repeating a line never renews its expiry), the
/// same open or dismissed question, or a milestone already kept.
fn apply(meta: &Meta, change: &Change, now: u64) -> Option<Meta> {
    let mut next = meta.clone();
    match change {
        Change::Activity { text: None, .. } => {
            next.activity.take()?;
        }
        Change::Activity { text: Some(text), spawn } => {
            if meta.activity.as_ref().is_some_and(|a| a.text == *text && a.spawn == *spawn && is_fresh(a.set_at, now)) {
                return None;
            }
            next.activity = Some(Activity { text: text.clone(), set_at: now, spawn: spawn.clone() });
        }
        Change::Handoff(None) => {
            next.handoff.take()?;
        }
        Change::Handoff(Some(h)) => {
            if meta.handoff.as_ref().is_some_and(|c| c.summary == h.summary && c.checks == h.checks && c.remaining == h.remaining) {
                return None;
            }
            next.handoff = Some(Handoff { summary: h.summary.clone(), checks: h.checks.clone(), remaining: h.remaining.clone(), set_at: now });
        }
        Change::Results(items) if items.is_empty() => {
            next.results.take()?;
        }
        Change::Results(items) => {
            if meta.results.as_ref().is_some_and(|c| c.items == *items) {
                return None;
            }
            next.results = Some(Results { items: items.clone(), set_at: now });
        }
        Change::Progress { steps, .. } if steps.is_empty() => {
            next.progress.take()?;
        }
        Change::Progress { steps, spawn } => {
            // The same steps from the same live spawn do not renew the report;
            // an ended or stale one is published again.
            if meta.progress.as_ref().is_some_and(|p| p.steps == *steps && p.spawn == *spawn && !p.ended && is_fresh(p.set_at, now)) {
                return None;
            }
            next.progress = Some(Progress { steps: steps.clone(), set_at: now, spawn: spawn.clone(), ended: false });
        }
        Change::Blocker { text: None, .. } => {
            next.blocker.take()?;
        }
        Change::Blocker { text: Some(text), spawn } => {
            if meta.blocker.as_ref().is_some_and(|b| b.text == *text && b.spawn == *spawn && is_fresh(b.set_at, now)) {
                return None;
            }
            next.blocker = Some(Blocker { text: text.clone(), set_at: now, spawn: spawn.clone() });
        }
        Change::Verification(entries) if entries.is_empty() => {
            next.verification.take()?;
        }
        Change::Verification(entries) => {
            if meta.verification.as_ref().is_some_and(|c| c.entries == *entries) {
                return None;
            }
            next.verification = Some(Verification { entries: entries.clone(), set_at: now });
        }
        Change::Attention { question: None, .. } => {
            next.attention.take()?;
        }
        Change::Attention { question: Some(question), id, spawn } => {
            // The same question from the same spawn is not asked twice: not
            // while it is open, and not after the user dismissed it (a retry
            // must not resurface it). Only a changed question, or one that
            // lapsed unanswered, is a new item with a new id.
            if meta.attention.as_ref().is_some_and(|a| {
                a.question == *question && a.spawn == *spawn && (a.dismissed || attention_is_live(a.set_at, now))
            }) {
                return None;
            }
            next.attention = Some(Attention { id: id.clone(), question: question.clone(), set_at: now, spawn: spawn.clone(), dismissed: false });
        }
        Change::Milestone { request_id, text } => {
            if meta.milestones.iter().any(|m| m.request_id == *request_id) {
                return None;
            }
            next.milestones.push(Milestone { request_id: request_id.clone(), text: text.clone(), at: now });
            if next.milestones.len() > MILESTONES_MAX {
                let extra = next.milestones.len() - MILESTONES_MAX;
                next.milestones.drain(..extra);
            }
        }
    }
    next.revision = meta.revision.saturating_add(1);
    Some(next)
}

/// What a read or a change answers: the committed metadata and whether this
/// call changed it.
#[derive(Debug, Clone)]
pub struct Outcome {
    pub changed: bool,
    pub label: String,
    pub meta: Meta,
}

fn tab_mut<'a>(session: &'a mut crate::schema::session::TerminalSession, id: &str) -> Result<&'a mut TabEntry, String> {
    // project-tree-read: ok — the state-dir session file, read/edited by scope id (never the project tree).
    session.tab_layout.iter_mut().find(|t| workspace::tab_id(t) == Some(id)).ok_or_else(|| workspace::TAB_NOT_FOUND.to_string())
}

/// Apply `change` to the saved tab `id` under the workspace lock:
/// `expected` must be the stored revision (`conflict` otherwise), a no-op
/// writes nothing, and a change is one [`workspace::edit_in`] — so the
/// workspace version and the tab's `updatedVersion` move with the revision. A
/// closed tab is never recreated (`tab_not_found`); unreadable stored
/// metadata or session state fails with no write. `check` runs inside the
/// lock (revocation).
pub fn update_in(
    path: &Path, scope: &str, id: &str, expected: u64, now: u64, change: &Change,
    check: impl FnOnce() -> Result<(), String>,
) -> Result<Outcome, String> {
    let mut unchanged: Option<Outcome> = None;
    let stored = workspace::edit_in_if(path, scope, |session| {
        check()?;
        let tab = tab_mut(session, id)?;
        let meta = read(tab).map_err(str::to_string)?;
        // A milestone only appends and names its own idempotency key, so it
        // takes no revision (every other change compares under the lock).
        if meta.revision != expected && !matches!(change, Change::Milestone { .. }) {
            return Err(CONFLICT.into());
        }
        match apply(&meta, change, now) {
            None => {
                unchanged = Some(Outcome { changed: false, label: tab.label.clone(), meta });
                Ok(false)
            }
            Some(next) => store(tab, &next).map(|()| true).map_err(str::to_string),
        }
    })?;
    match stored {
        Some(mut session) => {
            let tab = tab_mut(&mut session, id)?;
            Ok(Outcome { changed: true, label: tab.label.clone(), meta: read(tab).map_err(str::to_string)? })
        }
        None => unchanged.ok_or_else(|| "storage_error".to_string()),
    }
}

/// The tab's label and metadata, read under the shared lock with the same
/// recheck as a write.
pub fn read_in(path: &Path, id: &str, check: impl FnOnce() -> Result<(), String>) -> Result<Outcome, String> {
    let mut tab = workspace::read_tab_in(path, id, check)?;
    let meta = read(&tab).map_err(str::to_string)?;
    Ok(Outcome { changed: false, label: std::mem::take(&mut tab.label), meta })
}

/// At a new spawn's grant: drop the activity and blocker another spawn issued
/// and mark its progress as ended (one write, only when there is something to
/// change). Returns whether it wrote.
pub fn clear_other_spawns_in(path: &Path, scope: &str, id: &str, spawn: &str) -> Result<bool, String> {
    let stored = workspace::edit_in_if(path, scope, |session| {
        let tab = tab_mut(session, id)?;
        let mut meta = read(tab).map_err(str::to_string)?;
        if !retire_other_spawns(&mut meta, spawn) {
            return Ok(false);
        }
        meta.revision = meta.revision.saturating_add(1);
        store_host(tab, &meta).map(|()| true).map_err(str::to_string)
    })?;
    Ok(stored.is_some())
}

/// What the user's dismissal of an attention question came to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Dismissal {
    /// Marked dismissed now (one write).
    Dismissed,
    /// That question was already dismissed (nothing written).
    Unchanged,
    /// The tab has no question with that id any more - it was replaced, cleared
    /// or went with its spawn (nothing written).
    Stale,
}

/// The user's dismissal, a compare-and-swap on the attention `id` under the
/// workspace lock: only the question the window drew can be dismissed, and a
/// newer one stays. One [`workspace::edit_in`], so the revision and versions
/// move; nothing else of the tab changes. This writes the session file only:
/// other windows learn of it from the `workspace:patch` hint the caller sends
/// for the version [`dismiss_versioned_in`] answers (or on their next sync).
/// A closed tab is `tab_not_found`, unreadable metadata fails with no write.
/// The marker is the host's, so it is not held to the agent's size bound
/// ([`store_host`]).
pub fn dismiss_in(path: &Path, scope: &str, id: &str, attention_id: &str) -> Result<Dismissal, String> {
    dismiss_versioned_in(path, scope, id, attention_id).map(|(verdict, _)| verdict)
}

/// [`dismiss_in`] and, when it wrote, the workspace version it committed: what
/// the other windows are told to fetch.
pub fn dismiss_versioned_in(path: &Path, scope: &str, id: &str, attention_id: &str) -> Result<(Dismissal, Option<u64>), String> {
    if attention_id.is_empty() || attention_id.chars().count() > ATTENTION_ID_MAX_CHARS {
        return Ok((Dismissal::Stale, None));
    }
    let mut verdict = Dismissal::Stale;
    let stored = workspace::edit_in_if(path, scope, |session| {
        let tab = tab_mut(session, id)?;
        let mut meta = read(tab).map_err(str::to_string)?;
        match meta.attention.as_mut() {
            Some(a) if a.id == attention_id && a.dismissed => {
                verdict = Dismissal::Unchanged;
                Ok(false)
            }
            Some(a) if a.id == attention_id => {
                a.dismissed = true;
                meta.revision = meta.revision.saturating_add(1);
                verdict = Dismissal::Dismissed;
                store_host(tab, &meta).map(|()| true).map_err(str::to_string)
            }
            _ => Ok(false),
        }
    })?;
    Ok((verdict, stored.map(|session| workspace::version_of(&session))))
}

#[cfg(test)]
mod tests;
