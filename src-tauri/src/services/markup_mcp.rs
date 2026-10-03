//! **The markup questions MCP** — `markup_ask` / `markup_withdraw`, served
//! to a local project-agent tab as the server `<slug>-markup` on
//! `/mcp/markup` (`Caller::Marker`). Plan: `docs/markup_questions_mcp_plan.md`.
//!
//! An agent reading a PDF markup round asks the user about an ambiguous mark;
//! the questions show up as choosable options inside that tab's markup view
//! (desktop and phone), each pinned to a page and the words it quotes. The ask
//! does **not** block: it returns `shown` at once and the agent ends its turn.
//! The user's answer comes back as a prompt typed into the tab — the desktop
//! builds it here ([`answer`]) and queues it the way the markup Submit does.
//!
//! Shape of the lane, copied from its siblings: wired like help
//! (`services::help_mcp`), refusals like git push (`services::git_push_mcp`):
//! every refusal is a normal tool result with a fixed `category` (`invalid`,
//! `file_not_found`, `budget`, `off`) and one `message`. The audit ring keeps
//! session, tool and category of every tool call and refusal, never the text
//! ([`audited`]).
//!
//! State is in memory only and keyed by `(project, schedule target)` — the
//! stable target both viewers resolve to. One open ask per key: a new ask
//! supersedes the open one. An ask ends when answered, withdrawn, dismissed,
//! after 24 h ([`RETENTION`]), and when its session is gone (tab closed,
//! respawned or revoked). A `file` is resolved under the project folder that
//! `projects.json` records, never the in-folder `project.json`, and stored
//! project-relative.
//!
//! `AppHandle`-free: the window learns of changes through a hook the command
//! layer installs ([`set_change_hook`], `commands::markup_mcp`).

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::mobile_control::{files, markup, outbox};
use super::root_mcp::{Caller, Session};

pub const SERVER_NAME: &str = concat!(crate::app_slug!(), "-markup");
/// Rung (no payload) whenever an ask opens, closes or expires.
pub const CHANGED_EVENT: &str = "markup-mcp-changed";
/// The agent CLIs named the server on their own command line
/// (`root_mcp::apply_markup_to_spawn_with`); tool-tagged local Vibe models get
/// it through Vibe's env layer. Every other agent CLI gets the env pair only.
pub const WIRED_CLIS: &[&str] = &["claude", "codex"];

pub const TOOL_ASK: &str = "markup_ask";
pub const TOOL_WITHDRAW: &str = "markup_withdraw";
/// The tools, in the order `tools/list` gives them.
pub const TOOLS: &[&str] = &[TOOL_ASK, TOOL_WITHDRAW];

pub const INSTRUCTIONS: &str = concat!("Questions about the user's PDF markup, shown inside ", crate::app_name!(), "'s markup view of this tab. When a mark leaves you a choice, call markup_ask with up to four questions, each with 2–6 options, the 1-based page and a short quote of the page's own words the mark is on; the user taps an answer beside the PDF. markup_ask returns at once — the user's answer arrives as your next prompt, so end your turn after asking. A new ask replaces this tab's open one; markup_withdraw takes one back. Every refusal is a normal result with a fixed `category` and a `message`. Budget: twenty asks per tab per hour.");

/// Bounds, in characters after cleaning (`file` in bytes).
pub const MAX_QUESTIONS: usize = 4;
pub const MAX_QUESTION_CHARS: usize = 400;
pub const MAX_HEADER_CHARS: usize = 24;
pub const MIN_OPTIONS: usize = 2;
pub const MAX_OPTIONS: usize = 6;
pub const MAX_LABEL_CHARS: usize = 80;
pub const MAX_DESCRIPTION_CHARS: usize = 200;
pub const MAX_QUOTE_CHARS: usize = 200;
/// A typed **Other…** answer.
pub const MAX_OTHER_CHARS: usize = 500;
pub const MAX_FILE_BYTES: usize = 1024;
/// The highest page a question may name (the markup's own page bound).
pub const MAX_PAGE: u32 = 100_000;
/// `markup_ask` calls per tab per rolling hour, taken before any work.
pub const ASKS_PER_HOUR: usize = 20;
/// How long an ask lives, open or closed.
pub const RETENTION: Duration = Duration::from_secs(24 * 3600);
/// Records kept at most; the oldest closed ones go first.
const MAX_RECORDS: usize = 1000;
/// A question's text in the answer prompt when the whole would not fit.
const CLIPPED_QUESTION_CHARS: usize = 120;

// ── Store ───────────────────────────────────────────────────────────────────

/// One question as validated and cleaned; what the views render.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    pub question: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub header: Option<String>,
    pub options: Vec<Choice>,
    pub multi_select: bool,
    /// 1-based.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quote: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Choice {
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State { Open, Answered, Superseded, Withdrawn, Dismissed }

#[derive(Clone, Debug)]
struct Ask {
    id: String,
    /// The `Session::id` that asked; the ask dies with it.
    session: String,
    project: String,
    target: String,
    /// Project-relative, as resolved at ask time.
    file: Option<String>,
    questions: Vec<Question>,
    created: Instant,
    created_at: String,
    state: State,
    /// Set when answered: what [`reopen`] must be shown to undo exactly that
    /// answer when its prompt could not be delivered.
    receipt: Option<String>,
}

/// An open ask as the views get it: no session, tab or project id.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AskView {
    pub id: String,
    /// Project-relative path the ask is bound to; `None` shows on every file.
    pub file: Option<String>,
    /// The file's leaf name — what the phone is shown instead of the path.
    pub file_name: Option<String>,
    pub created_at: String,
    pub questions: Vec<Question>,
}

fn store() -> &'static Mutex<Vec<Ask>> {
    static STORE: OnceLock<Mutex<Vec<Ask>>> = OnceLock::new();
    STORE.get_or_init(Default::default)
}

/// Set once by the command layer; called after any change of the open asks,
/// so the window learns of it without an `AppHandle` here.
static CHANGE_HOOK: OnceLock<Box<dyn Fn() + Send + Sync>> = OnceLock::new();
pub fn set_change_hook(hook: Box<dyn Fn() + Send + Sync>) { let _ = CHANGE_HOOK.set(hook); }
fn changed() { if let Some(hook) = CHANGE_HOOK.get() { hook(); } }

/// Drop day-old records and every record whose session no longer holds a
/// token; cap the store. Whether an **open** ask went (the views change).
fn prune(list: &mut Vec<Ask>) -> bool {
    let open_before = list.iter().filter(|a| a.state == State::Open).count();
    list.retain(|a| a.created.elapsed() < RETENTION && super::root_mcp::session_alive(&a.session));
    while list.len() > MAX_RECORDS {
        let at = list.iter().position(|a| a.state != State::Open).unwrap_or(0);
        list.remove(at);
    }
    list.iter().filter(|a| a.state == State::Open).count() != open_before
}

/// Prune now and ring the hook when an open ask went — after a tab's token
/// was revoked (PTY exit, MCP session access). Whether anything changed.
pub fn sweep() -> bool {
    let gone = prune(&mut store().lock().unwrap_or_else(|p| p.into_inner()));
    if gone { changed(); }
    gone
}

fn view(ask: &Ask) -> AskView {
    AskView {
        id: ask.id.clone(),
        file: ask.file.clone(),
        file_name: ask.file.as_deref().map(|f| f.rsplit('/').next().unwrap_or(f).to_string()),
        created_at: ask.created_at.clone(),
        questions: ask.questions.clone(),
    }
}

/// Whether an ask bound to `asked` belongs on the view showing `shown` (both
/// project-relative). Equal paths, or — when either is an outbox file — the
/// same leaf without the send stamps, so the outbox copy the phone marked and
/// the project file it was sent from match each other.
pub fn same_file(asked: &str, shown: &str) -> bool {
    if asked == shown { return true; }
    let in_outbox = |rel: &str| rel.strip_prefix(outbox::OUTBOX_DIR).and_then(|r| r.strip_prefix('/')).is_some();
    if !in_outbox(asked) && !in_outbox(shown) { return false; }
    let leaf = |rel: &str| outbox::sent_name(rel.rsplit('/').next().unwrap_or(rel)).to_string();
    leaf(asked) == leaf(shown)
}

/// Which file a markup view shows, for [`list`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shown<'a> {
    /// No view in particular: every open ask.
    All,
    /// This project-relative path.
    File(&'a str),
    /// A path that does not resolve under the project: only the asks bound
    /// to no file.
    Elsewhere,
}

/// The open asks of one tab's target for the view showing `shown`. An ask
/// without a file shows on every view.
pub fn list(project: &str, target: &str, shown: Shown) -> Vec<AskView> {
    let mut asks = store().lock().unwrap_or_else(|p| p.into_inner());
    let gone = prune(&mut asks);
    let out = asks.iter()
        .filter(|a| a.state == State::Open && a.project == project && a.target == target)
        .filter(|a| match (a.file.as_deref(), shown) {
            (None, _) | (_, Shown::All) => true,
            (Some(file), Shown::File(shown)) => same_file(file, shown),
            (Some(_), Shown::Elsewhere) => false,
        })
        .map(view)
        .collect();
    drop(asks);
    if gone { changed(); }
    out
}

// ── Answers ─────────────────────────────────────────────────────────────────

/// One question's answer as a viewer sends it: option indices (0-based, into
/// that question's `options`) and/or a typed **Other…** text.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Answer {
    #[serde(default)]
    pub options: Vec<usize>,
    #[serde(default)]
    pub other: Option<String>,
}

/// Why an answer or a dismissal was not taken. Wire codes for the frontend.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AnswerError {
    /// A newer ask of the same tab replaced this one.
    Superseded,
    /// Already answered (another view was faster).
    Answered,
    /// Withdrawn, dismissed, expired, its tab gone — or never this target's.
    Gone,
    /// The answers do not fit the questions.
    Invalid,
}
impl AnswerError {
    pub fn code(self) -> &'static str {
        match self {
            AnswerError::Superseded => "superseded",
            AnswerError::Answered => "answered",
            AnswerError::Gone => "gone",
            AnswerError::Invalid => "invalid_answer",
        }
    }
}

/// Find the ask `id` of this target and check it is still open.
fn open_index(list: &[Ask], project: &str, target: &str, id: &str) -> Result<usize, AnswerError> {
    let at = list.iter().position(|a| a.id == id && a.project == project && a.target == target).ok_or(AnswerError::Gone)?;
    match list[at].state {
        State::Open => Ok(at),
        State::Answered => Err(AnswerError::Answered),
        State::Superseded => Err(AnswerError::Superseded),
        State::Withdrawn | State::Dismissed => Err(AnswerError::Gone),
    }
}

/// One question's answer as the prompt words it, or `Invalid`.
fn answer_text(question: &Question, answer: &Answer) -> Result<String, AnswerError> {
    let other = match answer.other.as_deref() {
        None => None,
        Some(text) => {
            let text = clean(text);
            if text.is_empty() || text.chars().count() > MAX_OTHER_CHARS { return Err(AnswerError::Invalid); }
            Some(text)
        }
    };
    let mut picked = answer.options.clone();
    picked.sort_unstable();
    picked.dedup();
    if picked.len() != answer.options.len() || picked.iter().any(|&i| i >= question.options.len()) {
        return Err(AnswerError::Invalid);
    }
    let count = picked.len() + usize::from(other.is_some());
    if count == 0 || (!question.multi_select && count != 1) { return Err(AnswerError::Invalid); }
    let mut parts: Vec<String> = picked.iter().map(|&i| question.options[i].label.clone()).collect();
    if let Some(other) = other { parts.push(format!("Other: {other}")); }
    Ok(parts.join("; "))
}

/// A taken answer: the prompt to queue into the tab, and the receipt that
/// lets [`reopen`] undo this very answer when the prompt could not be queued.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Answered {
    pub prompt: String,
    pub receipt: String,
}

fn mint_receipt() -> String {
    super::root_mcp::mint_token().map(|t| t[..16].to_string())
        .unwrap_or_else(|| format!("{:x}", chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()))
}

/// The user's answer to the open ask `id`: checks every answer against its
/// question, marks the ask answered and returns the prompt to queue into the
/// tab. A refused answer changes nothing.
pub fn answer(project: &str, target: &str, id: &str, answers: &[Answer]) -> Result<Answered, AnswerError> {
    let mut asks = store().lock().unwrap_or_else(|p| p.into_inner());
    let gone = prune(&mut asks);
    let result = (|| {
        let at = open_index(&asks, project, target, id)?;
        let ask = &asks[at];
        if answers.len() != ask.questions.len() { return Err(AnswerError::Invalid); }
        let lines = ask.questions.iter().zip(answers)
            .map(|(q, a)| answer_text(q, a).map(|text| (q.question.clone(), text)))
            .collect::<Result<Vec<_>, _>>()?;
        let prompt = answer_prompt(ask.file.as_deref(), &lines);
        let receipt = mint_receipt();
        asks[at].state = State::Answered;
        asks[at].receipt = Some(receipt.clone());
        Ok(Answered { prompt, receipt })
    })();
    drop(asks);
    if gone || result.is_ok() { changed(); }
    result
}

/// Undo the answer `receipt` names because its prompt never reached the tab:
/// the ask is open again, so the card stays usable and a retry is not told
/// `answered`. Only that answer is undone — another view's answer
/// (`answered`), an ask a newer one of this tab has replaced since
/// (`superseded`), one the agent withdrew after it was answered
/// (`answered`: `markup_withdraw` spends the receipt), or one withdrawn,
/// expired or whose tab is gone (`gone`) stays closed. Reopening an ask already open again is not an error.
pub fn reopen(project: &str, target: &str, id: &str, receipt: &str) -> Result<(), AnswerError> {
    let mut asks = store().lock().unwrap_or_else(|p| p.into_inner());
    let gone = prune(&mut asks);
    let result = (|| {
        let at = asks.iter().position(|a| a.id == id && a.project == project && a.target == target).ok_or(AnswerError::Gone)?;
        match asks[at].state {
            State::Open => return Ok(false),
            State::Answered if asks[at].receipt.as_deref() == Some(receipt) => {}
            State::Answered => return Err(AnswerError::Answered),
            State::Superseded => return Err(AnswerError::Superseded),
            State::Withdrawn | State::Dismissed => return Err(AnswerError::Gone),
        }
        // A newer ask of this tab came in after the answer: it is the open one.
        if asks[at + 1..].iter().any(|a| a.project == project && a.target == target) {
            return Err(AnswerError::Superseded);
        }
        asks[at].state = State::Open;
        asks[at].receipt = None;
        Ok(true)
    })();
    drop(asks);
    if gone || result == Ok(true) { changed(); }
    result.map(|_| ())
}

/// **Answer in chat instead**: close the open ask `id` without a prompt.
/// Dismissing one already closed is not an error — the card is gone either way.
pub fn dismiss(project: &str, target: &str, id: &str) -> Result<(), AnswerError> {
    let mut asks = store().lock().unwrap_or_else(|p| p.into_inner());
    let gone = prune(&mut asks);
    let closed = match open_index(&asks, project, target, id) {
        Ok(at) => { asks[at].state = State::Dismissed; true }
        Err(_) => false,
    };
    drop(asks);
    if gone || closed { changed(); }
    Ok(())
}

/// Cut `text` to at most `max` bytes on a character boundary, marking the cut.
fn clip(text: &str, max: usize) -> String {
    if text.len() <= max { return text.to_string(); }
    let room = max.saturating_sub('…'.len_utf8());
    let mut out: String = text.char_indices().take_while(|(i, c)| i + c.len_utf8() <= room).map(|(_, c)| c).collect();
    out.push('…');
    out
}

fn clip_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max { return text.to_string(); }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// The answer prompt: English, deterministic, one line per question, capped
/// at the markup budget (`markup::MAX_PROMPT_BYTES`). It never starts with a
/// CLI command character — the fixed first line sees to that. Every piece was
/// cleaned to one line when it was stored or answered.
pub fn answer_prompt(file: Option<&str>, lines: &[(String, String)]) -> String {
    let head = match file {
        Some(file) => format!("My answers to your markup questions on `{file}`:"),
        None => "My answers to your markup questions:".to_string(),
    };
    let render = |question: &dyn Fn(&str) -> String, answer: &dyn Fn(&str, usize) -> String| {
        let mut out = head.clone();
        for (n, (q, a)) in lines.iter().enumerate() {
            let prefix = format!("\n{}. {} → ", n + 1, question(q));
            let text = answer(a, prefix.len());
            out.push_str(&prefix);
            out.push_str(&text);
        }
        out
    };
    let full = render(&|q| q.to_string(), &|a, _| a.to_string());
    if full.len() <= markup::MAX_PROMPT_BYTES { return full; }
    // Too long: shorten the questions first (the answers are what matters),
    // then share what is left evenly between the answers.
    let short = render(&|q| clip_chars(q, CLIPPED_QUESTION_CHARS), &|a, _| a.to_string());
    if short.len() <= markup::MAX_PROMPT_BYTES { return short; }
    let per_line = markup::MAX_PROMPT_BYTES.saturating_sub(head.len()) / lines.len().max(1);
    render(&|q| clip_chars(q, CLIPPED_QUESTION_CHARS), &|a, used| clip(a, per_line.saturating_sub(used)))
}

// ── Validation ──────────────────────────────────────────────────────────────

/// `strip_invisible`, then whitespace collapsed: one line, no hidden text.
pub fn clean(text: &str) -> String {
    super::root_mcp_mail::strip_invisible(text).split_whitespace().collect::<Vec<_>>().join(" ")
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AskArgs {
    #[serde(default)]
    file: Option<String>,
    questions: Vec<QuestionArgs>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct QuestionArgs {
    question: String,
    #[serde(default)]
    header: Option<String>,
    options: Vec<OptionArgs>,
    #[serde(default)]
    multi_select: Option<bool>,
    #[serde(default)]
    page: Option<u32>,
    #[serde(default)]
    quote: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OptionArgs {
    label: String,
    #[serde(default)]
    description: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WithdrawArgs { id: String }

/// A required text: cleaned, non-empty, at most `max` characters.
fn required(field: &str, text: &str, max: usize) -> Result<String, String> {
    let text = clean(text);
    if text.is_empty() { return Err(format!("`{field}` is empty")); }
    if text.chars().count() > max { return Err(format!("`{field}` is longer than {max} characters")); }
    Ok(text)
}
/// An optional text: absent and blank are both `None`.
fn optional(field: &str, text: Option<&str>, max: usize) -> Result<Option<String>, String> {
    match text.map(clean).filter(|t| !t.is_empty()) {
        Some(t) if t.chars().count() > max => Err(format!("`{field}` is longer than {max} characters")),
        other => Ok(other),
    }
}

/// A validated `markup_ask`: the cleaned questions and the raw `file`.
struct Parsed { file: Option<String>, questions: Vec<Question> }

fn parse_ask(args: &Value) -> Result<Parsed, String> {
    let args: AskArgs = serde_json::from_value(args.clone()).map_err(|e| format!("invalid arguments: {e}"))?;
    if args.questions.is_empty() || args.questions.len() > MAX_QUESTIONS {
        return Err(format!("ask 1–{MAX_QUESTIONS} questions"));
    }
    let file = args.file.map(|f| f.trim().to_string()).filter(|f| !f.is_empty());
    if file.as_deref().is_some_and(|f| f.len() > MAX_FILE_BYTES) {
        return Err(format!("`file` is longer than {MAX_FILE_BYTES} bytes"));
    }
    let mut questions = Vec::with_capacity(args.questions.len());
    for q in args.questions {
        if q.options.len() < MIN_OPTIONS || q.options.len() > MAX_OPTIONS {
            return Err(format!("each question needs {MIN_OPTIONS}–{MAX_OPTIONS} options"));
        }
        let mut options: Vec<Choice> = Vec::with_capacity(q.options.len());
        for o in q.options {
            let label = required("label", &o.label, MAX_LABEL_CHARS)?;
            if options.iter().any(|c| c.label == label) { return Err(format!("two options are both labelled \"{label}\"")); }
            options.push(Choice { label, description: optional("description", o.description.as_deref(), MAX_DESCRIPTION_CHARS)? });
        }
        if q.page.is_some_and(|p| p == 0 || p > MAX_PAGE) { return Err(format!("`page` is 1-based, at most {MAX_PAGE}")); }
        questions.push(Question {
            question: required("question", &q.question, MAX_QUESTION_CHARS)?,
            header: optional("header", q.header.as_deref(), MAX_HEADER_CHARS)?,
            options,
            multi_select: q.multi_select.unwrap_or(false),
            page: q.page,
            quote: optional("quote", q.quote.as_deref(), MAX_QUOTE_CHARS)?,
        });
    }
    Ok(Parsed { file, questions })
}

/// Where `file` (as the markup prompt named it: project-relative, or an
/// absolute path below the project) sits in the project whose folder is
/// `root`, project-relative. Lexical and strict (`markup::resolve_local_source`:
/// plain names only, hidden names refused but the outbox), and — with
/// `prove` — the file must be a regular file reached with no link on the way
/// (`files` / `outbox`). Never a path a prompt could not quote.
pub fn resolve_file(root: &Path, file: &str, prove: bool) -> Result<String, String> {
    let file = file.strip_prefix("./").unwrap_or(file);
    if file.is_empty() || file.len() > MAX_FILE_BYTES || file.contains('\\')
        || file.chars().any(|c| c.is_control() || c == '`') {
        return Err("not a project path".into());
    }
    let path = Path::new(file);
    let absolute = if path.is_absolute() { path.to_path_buf() } else { root.join(path) };
    let source = markup::resolve_local_source(root, &absolute).map_err(|e| e.code().to_string())?;
    let rel = match &source {
        markup::ResolvedSource::Files(rel) => rel.clone(),
        markup::ResolvedSource::Outbox(leaf) => format!("{}/{leaf}", outbox::OUTBOX_DIR),
    };
    if prove {
        let found = match &source {
            markup::ResolvedSource::Files(rel) => files::exists(root, rel),
            markup::ResolvedSource::Outbox(leaf) => outbox::exists(root, leaf),
        };
        if !found { return Err("file_not_found".into()); }
    }
    Ok(rel)
}

// ── Budget ──────────────────────────────────────────────────────────────────

fn rates() -> &'static Mutex<HashMap<String, VecDeque<Instant>>> {
    static RATES: OnceLock<Mutex<HashMap<String, VecDeque<Instant>>>> = OnceLock::new();
    RATES.get_or_init(Default::default)
}
/// [`ASKS_PER_HOUR`] per tab, rolling; a refused call takes nothing.
fn admit_rate(tab: &str) -> bool {
    let mut map = rates().lock().unwrap_or_else(|p| p.into_inner());
    map.retain(|_, calls| { calls.retain(|at| at.elapsed() < Duration::from_secs(3600)); !calls.is_empty() });
    let calls = map.entry(tab.to_string()).or_default();
    if calls.len() >= ASKS_PER_HOUR { return false; }
    calls.push_back(Instant::now());
    true
}

// ── MCP ─────────────────────────────────────────────────────────────────────

/// The fixed refusal categories, the only thing the audit ring keeps.
const INVALID: &str = "invalid";
const FILE_NOT_FOUND: &str = "file_not_found";
const BUDGET: &str = "budget";
const OFF: &str = "off";

fn refused(category: &'static str, message: impl Into<String>) -> Value {
    json!({"status": "refused", "category": category, "message": message.into()})
}

/// The fixed category of a refused call, for the audit ring.
pub fn refusal_reason(reply: &Value) -> Option<&'static str> {
    if reply.get("error").is_some() || reply["result"]["isError"] == true { return Some("invalid_or_unavailable"); }
    let structured = &reply["result"]["structuredContent"];
    (structured["status"] == "refused").then(|| match structured["category"].as_str() {
        Some(FILE_NOT_FOUND) => FILE_NOT_FOUND,
        Some(BUDGET) => BUDGET,
        Some(OFF) => OFF,
        _ => INVALID,
    })
}

/// Whether a message of this lane goes into the audit ring (`reason`: its
/// [`refusal_reason`]): every tool call and everything refused. The handshake
/// every new tab sends — `initialize`, `tools/list`, `ping`, notifications —
/// is not written down, as the help lane writes none of its own: three rows
/// per spawned tab would push the root tools' records out of the ring.
/// Admission failures are recorded before the lane is reached.
pub fn audited(message: &Value, reason: Option<&str>) -> bool {
    reason.is_some() || message["method"] == "tools/call"
}

pub fn tools() -> Value {
    let object = |properties: Value, required: Value| json!({"type":"object","properties":properties,"required":required,"additionalProperties":false});
    let question = object(json!({
        "question": {"type":"string","maxLength":MAX_QUESTION_CHARS,"description":"The question, one sentence."},
        "header": {"type":"string","maxLength":MAX_HEADER_CHARS,"description":"Optional short chip label, e.g. \"Arrow p. 3\"."},
        "options": {"type":"array","minItems":MIN_OPTIONS,"maxItems":MAX_OPTIONS,"items":object(json!({
            "label": {"type":"string","maxLength":MAX_LABEL_CHARS,"description":"The choice, a few words."},
            "description": {"type":"string","maxLength":MAX_DESCRIPTION_CHARS,"description":"Optional: what choosing it means."}
        }), json!(["label"]))},
        "multiSelect": {"type":"boolean","description":"Whether the user may pick several options (default false)."},
        "page": {"type":"integer","minimum":1,"maximum":MAX_PAGE,"description":"The 1-based page the question is about."},
        "quote": {"type":"string","maxLength":MAX_QUOTE_CHARS,"description":"Up to 200 characters of that page's own words the mark is on, copied exactly; the question is pinned there."}
    }), json!(["question", "options"]));
    json!([
        {"name": TOOL_ASK,
         "description": concat!("Ask the user about their PDF markup. The questions appear beside the PDF in ", crate::app_name!(), "'s markup view of this tab, each pinned to its page and quoted words, with your options to tap (plus a typed Other… and Answer in chat instead). Returns at once with an id; the user's answer arrives as your next prompt — end your turn now. A new ask replaces this tab's open one. Budget: twenty asks per hour."),
         "inputSchema": object(json!({
            "file": {"type":"string","maxLength":MAX_FILE_BYTES,"description":"The marked file as the markup prompt named it (the path in backticks on its first line). Optional; without it the questions show on any file."},
            "questions": {"type":"array","minItems":1,"maxItems":MAX_QUESTIONS,"items":question}
         }), json!(["questions"]))},
        {"name": TOOL_WITHDRAW,
         "description": "Take back this tab's open markup_ask (it disappears from the markup view). `not_open` when it was already answered, replaced or dismissed.",
         "inputSchema": object(json!({"id":{"type":"string","maxLength":64,"description":"The id markup_ask returned."}}), json!(["id"])),
         "annotations": {"idempotentHint": true}}
    ])
}

/// What a `markup_ask` / `markup_withdraw` call needs that is not in the
/// message: the switch and the project folder (resolved only when a `file`
/// asks for it).
pub struct Context<'a> {
    pub enabled: bool,
    pub root: &'a dyn Fn() -> Option<PathBuf>,
}

fn call_ask(session: &Session, project: &str, target: &str, ctx: &Context, args: &Value) -> Value {
    if !ctx.enabled {
        return refused(OFF, concat!("Markup questions are switched off in ", crate::app_name!(), "'s Settings → Manage CLIs. Ask in the chat instead."));
    }
    let parsed = match parse_ask(args) { Ok(p) => p, Err(e) => return refused(INVALID, e) };
    if !admit_rate(&session.identity.tab) {
        let mut value = refused(BUDGET, format!("At most {ASKS_PER_HOUR} markup questions per tab per hour. Ask in the chat instead."));
        value["retryAfterSecs"] = json!(3600);
        return value;
    }
    let file = match parsed.file.as_deref() {
        None => None,
        Some(file) => {
            let Some(root) = (ctx.root)() else { return refused(FILE_NOT_FOUND, "This project's folder is not available on this machine; ask without `file`.") };
            match resolve_file(&root, file, true) {
                Ok(rel) => Some(rel),
                Err(_) => return refused(FILE_NOT_FOUND, "No such file in this project. Give `file` as the markup prompt named it (the path in backticks on its first line), or leave it out."),
            }
        }
    };
    let id = format!("ask-{}", super::root_mcp::mint_token().map(|t| t[..16].to_string())
        .unwrap_or_else(|| format!("{:x}", chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default())));
    let mut asks = store().lock().unwrap_or_else(|p| p.into_inner());
    prune(&mut asks);
    let mut replaced = None;
    for old in asks.iter_mut().filter(|a| a.state == State::Open && a.project == project && a.target == target) {
        old.state = State::Superseded;
        replaced = Some(old.id.clone());
    }
    asks.push(Ask {
        id: id.clone(), session: session.id.clone(), project: project.to_string(), target: target.to_string(),
        file, questions: parsed.questions, created: Instant::now(), created_at: chrono::Local::now().to_rfc3339(), state: State::Open,
        receipt: None,
    });
    prune(&mut asks);
    drop(asks);
    changed();
    let mut value = json!({"id": id, "status": "shown",
        "message": "Shown beside the PDF in the user's markup view. Their answer arrives as your next prompt — end your turn now."});
    if let Some(old) = replaced { value["replaced"] = json!(old); }
    value
}

fn call_withdraw(project: &str, target: &str, args: &Value) -> Value {
    let args: WithdrawArgs = match serde_json::from_value(args.clone()) { Ok(a) => a, Err(e) => return refused(INVALID, format!("invalid arguments: {e}")) };
    let mut asks = store().lock().unwrap_or_else(|p| p.into_inner());
    let gone = prune(&mut asks);
    let withdrawn = match open_index(&asks, project, target, &args.id) {
        Ok(at) => { asks[at].state = State::Withdrawn; true }
        Err(_) => {
            // Answered, its prompt maybe still on its way: the agent no longer
            // wants it, so a failed delivery must not bring the card back.
            if let Some(ask) = asks.iter_mut().find(|a| a.id == args.id && a.project == project && a.target == target && a.state == State::Answered) {
                ask.receipt = None;
            }
            false
        }
    };
    drop(asks);
    if gone || withdrawn { changed(); }
    json!({"status": if withdrawn { "withdrawn" } else { "not_open" }})
}

/// One JSON-RPC message from a [`Caller::Marker`] session against the live
/// switch and `projects.json`; `None` for a notification.
pub fn handle_message(session: &Session, message: &Value) -> Option<Value> {
    let root = || session.identity.project.as_deref().and_then(project_root);
    handle_with(session, message, &Context { enabled: enabled(), root: &root })
}

/// The local folder `projects.json` records for `project`; `None` for a
/// remote project or one without a folder.
pub fn project_root(project: &str) -> Option<PathBuf> {
    if super::remote::remote_target_for(project).is_some() { return None; }
    super::remote::project_directory(project).filter(|d| !d.is_empty()).map(PathBuf::from)
}

/// Whether the switch is on (`Settings::markup_mcp`, absent = on). An
/// unreadable file answers off: spawn and request agree.
pub fn enabled_in(settings: &Path) -> bool {
    crate::storage::read_json::<crate::schema::Settings>(settings).is_ok_and(|s| s.markup_mcp())
}
pub fn enabled() -> bool { enabled_in(&crate::storage::state_dir().join("settings.json")) }

/// [`handle_message`] with its world passed in. Any other class, a revoked
/// session or one without its project/target binding is refused here too,
/// whatever the route said.
pub fn handle_with(session: &Session, message: &Value, ctx: &Context) -> Option<Value> {
    let error = |id: Value, code: i64, text: &str| Some(json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":text}}));
    if message["jsonrpc"] != "2.0" || !message["method"].is_string()
        || message.get("id").is_some_and(|id| !id.is_string() && !id.is_i64() && !id.is_u64())
        || message.get("params").is_some_and(|p| !p.is_object()) {
        return error(Value::Null, -32600, "invalid request");
    }
    let id = message.get("id").cloned()?;
    if session.identity.caller != Caller::Marker || session.check().is_err() { return error(id, -32000, "access refused"); }
    let (Some(project), Some(target)) = (session.identity.project.as_deref(), session.identity.schedule_target.as_ref().map(|b| b.target.as_str())) else {
        return error(id, -32000, "access refused");
    };
    let ok = |value: Value| Some(json!({"jsonrpc":"2.0","id":id,"result":value}));
    match message["method"].as_str().unwrap_or_default() {
        "initialize" => ok(json!({"protocolVersion":"2025-03-26","capabilities":{"tools":{}},
            "serverInfo":{"name":SERVER_NAME,"version":env!("CARGO_PKG_VERSION")},"instructions":INSTRUCTIONS})),
        "ping" => ok(json!({})),
        "tools/list" => ok(json!({"tools": tools()})),
        "tools/call" => {
            let name = message["params"]["name"].as_str().unwrap_or_default();
            let args = message["params"].get("arguments").cloned().unwrap_or(json!({}));
            if !super::root_mcp_security::tool(name).is_some_and(|t| t.serves(Caller::Marker)) {
                return ok(json!({"content":[{"type":"text","text":"unknown tool"}],"isError":true}));
            }
            let value = match name {
                TOOL_ASK => call_ask(session, project, target, ctx, &args),
                _ => call_withdraw(project, target, &args),
            };
            ok(json!({"content":[{"type":"text","text":value.to_string()}],"structuredContent":value,"isError":false}))
        }
        _ => error(id, -32601, "method not found"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::root_mcp::{self, test_session_bound};

    fn ctx_on() -> Context<'static> { Context { enabled: true, root: &|| None } }

    fn call(session: &Session, name: &str, args: Value, ctx: &Context) -> Value {
        let msg = json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":name,"arguments":args}});
        let reply = handle_with(session, &msg, ctx).unwrap();
        assert_eq!(reply["result"]["isError"], false, "{reply}");
        reply["result"]["structuredContent"].clone()
    }

    fn q(question: &str, labels: &[&str]) -> Value {
        json!({"question": question, "options": labels.iter().map(|l| json!({"label": l})).collect::<Vec<_>>()})
    }

    /// A fresh tab bound to (project, target), unique per test.
    fn tab(name: &str) -> (Session, String, String) {
        let project = format!("p-{name}");
        let target = format!("t-{name}");
        let (_, s) = test_session_bound(Caller::Marker, &format!("{project}:{name}"), &project, &target);
        (s, project, target)
    }

    #[test]
    fn validation_bounds_are_enforced_before_anything_is_stored() {
        let (s, project, target) = tab("bounds");
        let ctx = ctx_on();
        let long = |n: usize| "é".repeat(n);
        let refusals = [
            json!({"questions": []}),
            json!({"questions": [q("a?", &["x", "y"]), q("b?", &["x", "y"]), q("c?", &["x", "y"]), q("d?", &["x", "y"]), q("e?", &["x", "y"])]}),
            json!({"questions": [q("a?", &["x"])]}),
            json!({"questions": [q("a?", &["1", "2", "3", "4", "5", "6", "7"])]}),
            json!({"questions": [q(&long(MAX_QUESTION_CHARS + 1), &["x", "y"])]}),
            json!({"questions": [q("   ", &["x", "y"])]}),
            json!({"questions": [q("\u{200b}\u{202e}", &["x", "y"])]}),
            json!({"questions": [q("a?", &["x", &long(MAX_LABEL_CHARS + 1)])]}),
            json!({"questions": [q("a?", &["same", " same "])]}),
            json!({"questions": [{"question": "a?", "header": long(MAX_HEADER_CHARS + 1), "options": [{"label":"x"},{"label":"y"}]}]}),
            json!({"questions": [{"question": "a?", "quote": long(MAX_QUOTE_CHARS + 1), "options": [{"label":"x"},{"label":"y"}]}]}),
            json!({"questions": [{"question": "a?", "page": 0, "options": [{"label":"x"},{"label":"y"}]}]}),
            json!({"questions": [{"question": "a?", "page": -2, "options": [{"label":"x"},{"label":"y"}]}]}),
            json!({"questions": [{"question": "a?", "options": [{"label":"x","description": long(MAX_DESCRIPTION_CHARS + 1)},{"label":"y"}]}]}),
            json!({"questions": [{"question": "a?", "options": [{"label":"x"},{"label":"y"}], "extra": 1}]}),
            json!({"questions": [q("a?", &["x", "y"])], "path": "/etc"}),
            json!({"file": "x".repeat(MAX_FILE_BYTES + 1), "questions": [q("a?", &["x", "y"])]}),
        ];
        for args in refusals {
            let out = call(&s, TOOL_ASK, args.clone(), &ctx);
            assert_eq!((out["status"].as_str(), out["category"].as_str()), (Some("refused"), Some(INVALID)), "{args}: {out}");
        }
        assert!(list(&project, &target, Shown::All).is_empty());
        // At the bounds, multibyte text counts characters, not bytes.
        let ok = json!({"questions": [{"question": long(MAX_QUESTION_CHARS), "header": long(MAX_HEADER_CHARS), "page": MAX_PAGE,
            "quote": long(MAX_QUOTE_CHARS), "multiSelect": true,
            "options": (0..MAX_OPTIONS).map(|i| json!({"label": format!("{i}{}", long(MAX_LABEL_CHARS - 1)), "description": long(MAX_DESCRIPTION_CHARS)})).collect::<Vec<_>>()}]});
        assert_eq!(call(&s, TOOL_ASK, ok, &ctx)["status"], "shown");
        root_mcp::revoke_tab(&s.identity.tab);
    }

    #[test]
    fn text_is_cleaned_to_one_visible_line() {
        let (s, project, target) = tab("clean");
        let args = json!({"questions": [{"question": "  Move\nthe \u{202e}figure\u{200b}?\t ", "header": " ", "quote": "a\u{0007}b",
            "options": [{"label": "The\u{2028}figure", "description": "  "}, {"label": "Text"}]}]});
        assert_eq!(call(&s, TOOL_ASK, args, &ctx_on())["status"], "shown");
        let asks = list(&project, &target, Shown::All);
        let q = &asks[0].questions[0];
        assert_eq!(q.question, "Move the figure?");
        assert_eq!(q.header, None, "blank is absent");
        assert_eq!(q.quote.as_deref(), Some("ab"));
        assert_eq!(q.options[0], Choice { label: "Thefigure".into(), description: None });
        assert!(!q.multi_select);
        root_mcp::revoke_tab(&s.identity.tab);
    }

    #[test]
    fn a_new_ask_supersedes_the_open_one_and_withdraw_is_per_target() {
        let (s, project, target) = tab("supersede");
        let (other, other_project, other_target) = tab("supersede-other");
        let first = call(&s, TOOL_ASK, json!({"questions": [q("a?", &["x", "y"])]}), &ctx_on());
        let theirs = call(&other, TOOL_ASK, json!({"questions": [q("b?", &["x", "y"])]}), &ctx_on());
        let second = call(&s, TOOL_ASK, json!({"questions": [q("c?", &["x", "y"])]}), &ctx_on());
        assert_eq!(second["replaced"], first["id"]);
        assert!(theirs.get("replaced").is_none());
        let open = list(&project, &target, Shown::All);
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].id, second["id"].as_str().unwrap());
        let first_id = first["id"].as_str().unwrap();
        assert_eq!(answer(&project, &target, first_id, &[Answer { options: vec![0], other: None }]), Err(AnswerError::Superseded));
        // Another tab cannot withdraw it, and its own id means nothing here.
        assert_eq!(call(&other, TOOL_WITHDRAW, json!({"id": second["id"]}), &ctx_on())["status"], "not_open");
        assert_eq!(list(&other_project, &other_target, Shown::All).len(), 1);
        assert_eq!(call(&s, TOOL_WITHDRAW, json!({"id": second["id"]}), &ctx_on())["status"], "withdrawn");
        assert_eq!(call(&s, TOOL_WITHDRAW, json!({"id": second["id"]}), &ctx_on())["status"], "not_open");
        assert!(list(&project, &target, Shown::All).is_empty());
        assert_eq!(answer(&project, &target, second["id"].as_str().unwrap(), &[Answer { options: vec![0], other: None }]), Err(AnswerError::Gone));
        root_mcp::revoke_tab(&s.identity.tab);
        root_mcp::revoke_tab(&other.identity.tab);
    }

    #[test]
    fn answers_are_checked_against_their_questions() {
        let (s, project, target) = tab("answers");
        let multi = json!({"question": "Which?", "multiSelect": true, "options": [{"label":"A"},{"label":"B"},{"label":"C"}]});
        let shown = call(&s, TOOL_ASK, json!({"questions": [q("One?", &["x", "y"]), multi]}), &ctx_on());
        let id = shown["id"].as_str().unwrap();
        let a = |options: Vec<usize>, other: Option<&str>| Answer { options, other: other.map(str::to_string) };
        let bad = [
            vec![a(vec![0], None)],                                   // one answer for two questions
            vec![a(vec![2], None), a(vec![0], None)],                 // out of range
            vec![a(vec![0, 1], None), a(vec![0], None)],              // single-select, two picks
            vec![a(vec![0], Some("also")), a(vec![0], None)],         // single-select, pick + other
            vec![a(vec![], None), a(vec![0], None)],                  // nothing picked
            vec![a(vec![0], None), a(vec![1, 1], None)],              // duplicate index
            vec![a(vec![0], None), a(vec![], Some(" \u{200b} "))],     // blank other
            vec![a(vec![0], None), a(vec![], Some(&"x".repeat(MAX_OTHER_CHARS + 1)))],
        ];
        for answers in bad {
            assert_eq!(answer(&project, &target, id, &answers), Err(AnswerError::Invalid), "{answers:?}");
        }
        assert_eq!(list(&project, &target, Shown::All).len(), 1, "a refused answer changes nothing");
        assert_eq!(answer("p-elsewhere", &target, id, &[a(vec![1], None), a(vec![2, 0], Some("D"))]), Err(AnswerError::Gone));
        let prompt = answer(&project, &target, id, &[a(vec![1], None), a(vec![2, 0], Some("  D\nplease "))]).unwrap().prompt;
        assert_eq!(prompt, "My answers to your markup questions:\n1. One? → y\n2. Which? → A; C; Other: D please");
        assert_eq!(answer(&project, &target, id, &[a(vec![1], None), a(vec![0], None)]), Err(AnswerError::Answered));
        assert!(list(&project, &target, Shown::All).is_empty());
        assert_eq!(answer(&project, &target, "ask-unknown", &[]), Err(AnswerError::Gone));
        root_mcp::revoke_tab(&s.identity.tab);
    }

    #[test]
    fn the_answer_prompt_is_golden_and_capped() {
        let lines = vec![
            ("Does the arrow on p. 3 move the paragraph or the figure?".to_string(), "The figure".to_string()),
            ("Which spelling?".to_string(), "Other: \"colour\", British throughout".to_string()),
        ];
        assert_eq!(answer_prompt(Some("docs/paper/draft.pdf"), &lines),
            "My answers to your markup questions on `docs/paper/draft.pdf`:\n1. Does the arrow on p. 3 move the paragraph or the figure? → The figure\n2. Which spelling? → Other: \"colour\", British throughout");
        // The worst case: four questions of four-byte characters at every bound.
        let wide = |n: usize| "𝔸".repeat(n);
        let answer: String = (0..MAX_OPTIONS).map(|_| wide(MAX_LABEL_CHARS)).chain([format!("Other: {}", wide(MAX_OTHER_CHARS))]).collect::<Vec<_>>().join("; ");
        let lines: Vec<_> = (0..MAX_QUESTIONS).map(|_| (wide(MAX_QUESTION_CHARS), answer.clone())).collect();
        let file = "d/".repeat(MAX_FILE_BYTES / 2 - 4) + "x.pdf";
        let prompt = answer_prompt(Some(&file), &lines);
        assert!(prompt.len() <= markup::MAX_PROMPT_BYTES, "{} bytes", prompt.len());
        assert!(prompt.starts_with("My answers") && prompt.lines().count() == 1 + MAX_QUESTIONS);
        assert!(prompt.lines().skip(1).all(|l| l.contains(" → ") && l.ends_with('…')), "every answer kept in part");
        // Long questions alone are shortened before any answer is.
        let lines: Vec<_> = (0..MAX_QUESTIONS).map(|_| (wide(MAX_QUESTION_CHARS), wide(500))).collect();
        let prompt = answer_prompt(None, &lines);
        assert!(prompt.len() <= markup::MAX_PROMPT_BYTES);
        assert!(prompt.lines().skip(1).all(|l| l.ends_with(&wide(500)) && l.contains('…')), "questions cut, answers whole");
    }

    #[test]
    fn the_budget_is_twenty_asks_per_tab_and_off_refuses() {
        let (s, project, target) = tab("budget");
        let off = Context { enabled: false, root: &|| None };
        let out = call(&s, TOOL_ASK, json!({"questions": [q("a?", &["x", "y"])]}), &off);
        assert_eq!(out["category"], OFF);
        // An invalid call costs nothing.
        for _ in 0..3 { assert_eq!(call(&s, TOOL_ASK, json!({"questions": []}), &ctx_on())["category"], INVALID); }
        for _ in 0..ASKS_PER_HOUR { assert_eq!(call(&s, TOOL_ASK, json!({"questions": [q("a?", &["x", "y"])]}), &ctx_on())["status"], "shown"); }
        let out = call(&s, TOOL_ASK, json!({"questions": [q("a?", &["x", "y"])]}), &ctx_on());
        assert_eq!((out["category"].as_str(), out["retryAfterSecs"].as_u64()), (Some(BUDGET), Some(3600)));
        assert_eq!(list(&project, &target, Shown::All).len(), 1, "one open ask per tab");
        let reply = json!({"result": {"isError": false, "structuredContent": out}});
        assert_eq!(refusal_reason(&reply), Some(BUDGET));
        assert_eq!(refusal_reason(&json!({"result": {"isError": false, "structuredContent": {"status": "shown"}}})), None);
        root_mcp::revoke_tab(&s.identity.tab);
    }

    #[test]
    fn files_resolve_under_the_project_and_bind_the_view() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join("docs/paper")).unwrap();
        std::fs::write(root.join("docs/paper/draft.pdf"), b"%PDF-1.4\n").unwrap();
        std::fs::create_dir_all(root.join(outbox::OUTBOX_DIR)).unwrap();
        std::fs::write(root.join(outbox::OUTBOX_DIR).join("20261003-120000-draft.pdf"), b"%PDF-1.4\n").unwrap();
        std::fs::write(root.join(".env"), b"secret").unwrap();
        assert_eq!(resolve_file(&root, "docs/paper/draft.pdf", true).unwrap(), "docs/paper/draft.pdf");
        assert_eq!(resolve_file(&root, "./docs/paper/draft.pdf", true).unwrap(), "docs/paper/draft.pdf");
        assert_eq!(resolve_file(&root, &root.join("docs/paper/draft.pdf").to_string_lossy(), true).unwrap(), "docs/paper/draft.pdf");
        let outboxed = format!("{}/20261003-120000-draft.pdf", outbox::OUTBOX_DIR);
        assert_eq!(resolve_file(&root, &outboxed, true).unwrap(), outboxed);
        for bad in ["docs/paper/missing.pdf", "../x.pdf", "docs/../docs/paper/draft.pdf", "/etc/passwd", ".env", ".git/config",
            "docs\\paper\\draft.pdf", "docs/`x`.pdf", "docs/a\nb.pdf", ""] {
            assert!(resolve_file(&root, bad, true).is_err(), "{bad}");
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join("docs/paper/draft.pdf"), root.join("docs/link.pdf")).unwrap();
            assert!(resolve_file(&root, "docs/link.pdf", true).is_err(), "no link at the leaf");
        }
        assert_eq!(resolve_file(&root, "docs/paper/missing.pdf", false).unwrap(), "docs/paper/missing.pdf", "a view's path need not exist");

        let (s, project, target) = tab("files");
        let root_for = root.clone();
        let find = move || Some(root_for.clone());
        let ctx = Context { enabled: true, root: &find };
        let out = call(&s, TOOL_ASK, json!({"file": "docs/nope.pdf", "questions": [q("a?", &["x", "y"])]}), &ctx);
        assert_eq!(out["category"], FILE_NOT_FOUND);
        let out = call(&s, TOOL_ASK, json!({"file": "docs/paper/draft.pdf", "questions": [q("a?", &["x", "y"])]}), &Context { enabled: true, root: &|| None });
        assert_eq!(out["category"], FILE_NOT_FOUND, "no local folder");
        assert_eq!(call(&s, TOOL_ASK, json!({"file": "docs/paper/draft.pdf", "questions": [q("a?", &["x", "y"])]}), &ctx)["status"], "shown");
        let shown = list(&project, &target, Shown::File("docs/paper/draft.pdf"));
        assert_eq!((shown[0].file.as_deref(), shown[0].file_name.as_deref()), (Some("docs/paper/draft.pdf"), Some("draft.pdf")));
        assert_eq!(list(&project, &target, Shown::File(&outboxed)).len(), 1, "the outbox copy matches by leaf");
        assert!(list(&project, &target, Shown::File("docs/other.pdf")).is_empty());
        assert_eq!(list(&project, &target, Shown::All).len(), 1);
        let prompt = answer(&project, &target, &shown[0].id, &[Answer { options: vec![1], other: None }]).unwrap().prompt;
        assert!(prompt.starts_with("My answers to your markup questions on `docs/paper/draft.pdf`:\n"));
        // An ask without a file shows on every view.
        call(&s, TOOL_ASK, json!({"questions": [q("a?", &["x", "y"])]}), &ctx);
        assert_eq!(list(&project, &target, Shown::File("docs/other.pdf")).len(), 1);
        root_mcp::revoke_tab(&s.identity.tab);
    }

    #[test]
    fn same_file_matches_outbox_copies_by_leaf_only() {
        let ob = |leaf: &str| format!("{}/{leaf}", outbox::OUTBOX_DIR);
        assert!(same_file("a/b.pdf", "a/b.pdf"));
        assert!(!same_file("a/b.pdf", "c/b.pdf"), "two project files never match by leaf");
        assert!(same_file("a/b.pdf", &ob("20261003-120000-b.pdf")));
        assert!(same_file(&ob("20261003-120000-20261003-120001-b.pdf"), "x/b.pdf"));
        assert!(!same_file(&ob("b.pdf"), "a/c.pdf"));
    }

    #[test]
    fn dismiss_closes_and_a_gone_session_takes_its_ask() {
        let (s, project, target) = tab("dismiss");
        let id = call(&s, TOOL_ASK, json!({"questions": [q("a?", &["x", "y"])]}), &ctx_on())["id"].as_str().unwrap().to_string();
        assert_eq!(dismiss(&project, &target, "ask-unknown"), Ok(()));
        assert_eq!(list(&project, &target, Shown::All).len(), 1);
        assert_eq!(dismiss(&project, &target, &id), Ok(()));
        assert!(list(&project, &target, Shown::All).is_empty());
        assert_eq!(answer(&project, &target, &id, &[Answer { options: vec![0], other: None }]), Err(AnswerError::Gone));
        // The tab closes (its token revoked): the open ask goes with it.
        call(&s, TOOL_ASK, json!({"questions": [q("b?", &["x", "y"])]}), &ctx_on());
        assert_eq!(list(&project, &target, Shown::All).len(), 1);
        root_mcp::revoke_tab(&s.identity.tab);
        sweep();
        assert!(list(&project, &target, Shown::All).is_empty());
        // A respawn of the same tab (a new session) does not inherit it either.
        let (s2, ..) = tab("dismiss");
        assert!(list(&project, &target, Shown::All).is_empty());
        root_mcp::revoke_tab(&s2.identity.tab);
    }

    #[test]
    fn reopen_undoes_only_the_answer_whose_prompt_was_not_delivered() {
        let (s, project, target) = tab("reopen");
        let pick = [Answer { options: vec![0], other: None }];
        let id = call(&s, TOOL_ASK, json!({"questions": [q("a?", &["x", "y"])]}), &ctx_on())["id"].as_str().unwrap().to_string();
        assert_eq!(reopen(&project, &target, &id, "nope"), Ok(()), "an open ask: nothing to undo");
        let first = answer(&project, &target, &id, &pick).unwrap();
        assert!(list(&project, &target, Shown::All).is_empty());
        // Another receipt, another target or an unknown id undo nothing.
        assert_eq!(reopen(&project, &target, &id, "not-the-receipt"), Err(AnswerError::Answered));
        assert_eq!(reopen("p-elsewhere", &target, &id, &first.receipt), Err(AnswerError::Gone));
        assert_eq!(reopen(&project, &target, "ask-unknown", &first.receipt), Err(AnswerError::Gone));
        assert!(list(&project, &target, Shown::All).is_empty());
        // The delivery failed: the card is back and the retry is taken.
        assert_eq!(reopen(&project, &target, &id, &first.receipt), Ok(()));
        assert_eq!(list(&project, &target, Shown::All).len(), 1);
        assert_eq!(reopen(&project, &target, &id, &first.receipt), Ok(()), "twice is harmless");
        let second = answer(&project, &target, &id, &pick).unwrap();
        assert_eq!(second.prompt, first.prompt);
        assert_ne!(second.receipt, first.receipt);
        assert_eq!(reopen(&project, &target, &id, &first.receipt), Err(AnswerError::Answered), "a spent receipt");
        // A newer ask came in meanwhile: the answered one stays closed.
        let newer = call(&s, TOOL_ASK, json!({"questions": [q("b?", &["x", "y"])]}), &ctx_on());
        assert!(newer.get("replaced").is_none(), "an answered ask is not replaced");
        assert_eq!(reopen(&project, &target, &id, &second.receipt), Err(AnswerError::Superseded));
        let open = list(&project, &target, Shown::All);
        assert_eq!((open.len(), open[0].id.as_str()), (1, newer["id"].as_str().unwrap()));
        // A withdrawn ask is not brought back either.
        let newer_id = newer["id"].as_str().unwrap();
        call(&s, TOOL_WITHDRAW, json!({"id": newer_id}), &ctx_on());
        assert_eq!(reopen(&project, &target, newer_id, "x"), Err(AnswerError::Gone));
        // Withdrawn while its answer was on the way: a failed delivery does
        // not bring it back.
        let last = call(&s, TOOL_ASK, json!({"questions": [q("c?", &["x", "y"])]}), &ctx_on())["id"].as_str().unwrap().to_string();
        let taken = answer(&project, &target, &last, &pick).unwrap();
        assert_eq!(call(&s, TOOL_WITHDRAW, json!({"id": last}), &ctx_on())["status"], "not_open");
        assert_eq!(reopen(&project, &target, &last, &taken.receipt), Err(AnswerError::Answered));
        assert!(list(&project, &target, Shown::All).is_empty());
        root_mcp::revoke_tab(&s.identity.tab);
        sweep();
        assert_eq!(reopen(&project, &target, &id, &second.receipt), Err(AnswerError::Gone), "the tab is gone");
    }

    #[test]
    fn asks_expire_after_a_day() {
        let (s, project, target) = tab("expiry");
        call(&s, TOOL_ASK, json!({"questions": [q("a?", &["x", "y"])]}), &ctx_on());
        {
            let mut asks = store().lock().unwrap();
            for a in asks.iter_mut().filter(|a| a.project == project) {
                a.created = Instant::now().checked_sub(RETENTION + Duration::from_secs(1)).unwrap();
            }
        }
        assert!(list(&project, &target, Shown::All).is_empty());
        root_mcp::revoke_tab(&s.identity.tab);
    }

    #[test]
    fn rpc_serves_only_a_bound_marker() {
        let msg = json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":TOOL_ASK,"arguments":{"questions":[q("a?", &["x","y"])]}}});
        for caller in [Caller::Agent, Caller::LocalModel, Caller::Reader, Caller::Scheduler, Caller::Pusher, Caller::Helper] {
            let (_, s) = test_session_bound(caller, "p-rpc:other", "p-rpc", "t-rpc");
            assert_eq!(handle_with(&s, &msg, &ctx_on()).unwrap()["error"]["message"], "access refused", "{caller:?}");
            root_mcp::revoke_tab(&s.identity.tab);
        }
        // A marker without its binding is refused too.
        let (_, unbound) = root_mcp::test_session(Caller::Marker);
        assert_eq!(handle_with(&unbound, &msg, &ctx_on()).unwrap()["error"]["message"], "access refused");
        root_mcp::revoke_tab(&unbound.identity.tab);
        let (s, ..) = tab("rpc");
        let tools = handle_with(&s, &json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}), &ctx_on()).unwrap();
        let names: Vec<_> = tools["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect();
        assert_eq!(names, TOOLS);
        let init = handle_with(&s, &json!({"jsonrpc":"2.0","id":1,"method":"initialize"}), &ctx_on()).unwrap();
        assert_eq!(init["result"]["serverInfo"]["name"], SERVER_NAME);
        let root_tool = json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"projects_list","arguments":{}}});
        assert_eq!(handle_with(&s, &root_tool, &ctx_on()).unwrap()["result"]["isError"], true);
        let help_tool = json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":crate::brand::HELP_TOOL_SEARCH,"arguments":{"query":"x"}}});
        assert_eq!(handle_with(&s, &help_tool, &ctx_on()).unwrap()["result"]["isError"], true);
        assert!(handle_with(&s, &json!({"jsonrpc":"2.0","method":"notifications/initialized"}), &ctx_on()).is_none());
        root_mcp::revoke_tab(&s.identity.tab);
        assert_eq!(handle_with(&s, &msg, &ctx_on()).unwrap()["error"]["message"], "access refused", "a closed tab");
    }

    #[test]
    fn the_audit_keeps_tool_calls_and_refusals_but_not_the_handshake() {
        let (s, ..) = tab("audit");
        let ctx = ctx_on();
        let audit = |message: Value| {
            let reply = handle_with(&s, &message, &ctx);
            audited(&message, reply.as_ref().and_then(refusal_reason))
        };
        for method in ["initialize", "tools/list", "ping"] {
            assert!(!audit(json!({"jsonrpc":"2.0","id":1,"method":method})), "{method}");
        }
        assert!(!audit(json!({"jsonrpc":"2.0","method":"notifications/initialized"})));
        assert!(audit(json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":TOOL_ASK,"arguments":{"questions":[q("a?", &["x","y"])]}}})));
        assert!(audit(json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":TOOL_WITHDRAW,"arguments":{"id":"ask-0"}}})));
        assert!(audit(json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":TOOL_ASK,"arguments":{"questions":[]}}})), "a refused call");
        assert!(audit(json!({"jsonrpc":"2.0","id":5,"method":"resources/list"})), "an unknown method");
        assert!(audit(json!({"jsonrpc":"1.0","id":6,"method":"ping"})), "a malformed request");
        root_mcp::revoke_tab(&s.identity.tab);
        assert!(audit(json!({"jsonrpc":"2.0","id":7,"method":"initialize"})), "a closed tab's handshake is a refusal");
    }

    #[test]
    fn registry_keeps_markup_to_its_own_class() {
        for name in TOOLS {
            let policy = super::super::root_mcp_security::tool(name).unwrap();
            assert!(policy.serves(Caller::Marker), "{name}");
            for other in [Caller::Agent, Caller::LocalModel, Caller::Reader, Caller::Scheduler, Caller::Pusher, Caller::Helper] {
                assert!(!policy.serves(other), "{name} {other:?}");
            }
        }
        for name in root_mcp::tool_names().iter().copied().chain(super::super::help_mcp::TOOLS.iter().copied()) {
            assert!(!super::super::root_mcp_security::tool(name).unwrap().serves(Caller::Marker), "{name}");
        }
    }
}
