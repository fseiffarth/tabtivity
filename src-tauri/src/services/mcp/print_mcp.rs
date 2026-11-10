//! **The print MCP** — `print_request` / `print_status` / `print_cancel`,
//! served to a local project-agent tab as the server `<slug>-print` on
//! `/mcp/print` (`Caller::Printer`). Rationale: `docs/context/print_mcp.md`.
//!
//! An agent asks for a PDF of its project to be printed. Nothing prints until
//! the user approves: the request shows in the Print Manager tab and as a
//! toast, and **Review** opens the window's own print preview on exactly the
//! bytes the agent named, with the agent's options preset, where Print reads
//! "Approve & print" beside Reject. Approve hands the PDF to the system print
//! dialog (`commands::print_native`), so the printer is still chosen there.
//! There is no apply level: every print is a click.
//!
//! **What is approved is what was asked for.** The file is read once, at the
//! request, from the project folder `projects.json` records (never the
//! in-folder `project.json`), one checked name at a time with no link on the
//! way (`mobile_control::files::open_served`), sniffed as a PDF and kept in
//! memory ([`MAX_PDF_BYTES`]). The preview and the printer get that snapshot,
//! so an agent cannot swap the file between the card and the click.
//!
//! Shape copied from its siblings: wired like markup (`services::markup_mcp`),
//! refusals like git push — every refusal is a normal tool result with a fixed
//! `category` (`invalid`, `file_not_found`, `not_pdf`, `too_large`, `budget`,
//! `pending_limit`, `off`, `not_found`) and one `message`. The audit ring keeps
//! session, tool and category, never the file or the note ([`audited`]).
//!
//! State is in memory only. A request ends when printed, rejected, withdrawn,
//! after 24 h ([`RETENTION`]), or when its session is gone (tab closed,
//! respawned or revoked); its bytes are dropped the moment it ends, and the
//! record itself (for `print_status`) after [`RETENTION`].
//!
//! **Window only.** Approval needs the window's preview and the machine's
//! printers, so only the window's listener grants the lane
//! (`root_mcp::Runtime::serves_print`); a tab the Mobile host or a server
//! daemon spawned gets no token.
//!
//! `AppHandle`-free: the window learns of changes through a hook the command
//! layer installs ([`set_change_hook`], `commands::print_mcp`).

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};

use crate::services::markup_mcp;
use crate::services::mobile_control::files;
use crate::services::root_mcp::{Caller, Session};
use app_core::sync::LockExt;

pub const SERVER_NAME: &str = concat!(crate::app_slug!(), "-print");
/// What the window listens to; rung by the hook on every change.
pub const CHANGED_EVENT: &str = "print-mcp-changed";

pub const TOOL_REQUEST: &str = "print_request";
pub const TOOL_STATUS: &str = "print_status";
pub const TOOL_CANCEL: &str = "print_cancel";
pub const TOOLS: &[&str] = &[TOOL_REQUEST, TOOL_STATUS, TOOL_CANCEL];

pub const INSTRUCTIONS: &str = concat!("Printing for the project this tab works in, always approved by the user. print_request asks to print one PDF of the project (a path relative to the project folder) with optional copies, pages, grayscale, two-sided, pages per sheet or booklet and a short note; it returns at once with an id and status `pending`. The user reviews it in ", crate::app_name!(), "'s print preview and presses Approve & print (then picks the printer in the system print dialog) or Reject. Poll print_status for the outcome; do not ask again while it is pending. print_cancel withdraws a pending request. Only PDFs print: build one first (LaTeX, pandoc, a script). Every refusal is a normal result with a fixed `category` and a `message`. Budget: ten requests per tab per hour, at most two pending.");

/// The largest PDF a request snapshots — the viewer's own gate.
pub const MAX_PDF_BYTES: u64 = 24 * 1024 * 1024;
pub const MAX_FILE_CHARS: usize = 1024;
pub const MAX_NOTE_CHARS: usize = 300;
pub const MAX_RANGE_CHARS: usize = 100;
pub const MAX_COPIES: u32 = 99;
/// What `pagesPerSheet` may be: the preview's N-up choices.
pub const PAGES_PER_SHEET: &[u32] = &[1, 2, 4, 6, 9, 16];
pub const REQUESTS_PER_HOUR: usize = 10;
/// Pending requests per tab; a third is refused (`pending_limit`).
pub const MAX_PENDING_PER_TAB: usize = 2;
/// Pending requests in this process, all tabs: bounds the snapshots held.
pub const MAX_PENDING_TOTAL: usize = 8;
pub const RETENTION: Duration = Duration::from_secs(24 * 3600);
const MAX_RECORDS: usize = 200;
/// How many requests `print_status` lists without an id.
const STATUS_LIST: usize = 10;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Pending,
    /// The user approved and the system dialog took the job (or, on Windows,
    /// opened — the OS owns the rest and reports nothing back).
    Printed,
    Rejected,
    Withdrawn,
    Expired,
    /// The tab's session ended before the user decided.
    Closed,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    pub copies: u32,
    /// A page range as the preview's custom field takes it ("1-3, 5"); `None`
    /// is every page.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pages: Option<String>,
    pub grayscale: bool,
    /// `none` / `long` / `short`; `None` leaves the user's own setting.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duplex: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pages_per_sheet: Option<u32>,
    pub booklet: bool,
}

struct Request {
    id: String,
    session: String,
    tab: String,
    project: String,
    /// Project-relative, as resolved at the request.
    file: String,
    bytes: Option<Arc<Vec<u8>>>,
    size: u64,
    sha256: String,
    options: Options,
    note: Option<String>,
    created: Instant,
    created_at: String,
    state: State,
}

/// A request as the window shows it. Only the desktop window reads these
/// (`commands::print_mcp`, class `client`); nothing here crosses the phone.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestView {
    pub id: String,
    pub tab: String,
    pub project_id: String,
    pub file: String,
    pub size: u64,
    pub sha256: String,
    pub options: Options,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub created_at: String,
    pub state: State,
}

fn store() -> &'static Mutex<Vec<Request>> {
    static STORE: OnceLock<Mutex<Vec<Request>>> = OnceLock::new();
    STORE.get_or_init(Default::default)
}

static CHANGE_HOOK: OnceLock<Box<dyn Fn() + Send + Sync>> = OnceLock::new();
pub fn set_change_hook(hook: Box<dyn Fn() + Send + Sync>) { let _ = CHANGE_HOOK.set(hook); }
fn changed() { if let Some(hook) = CHANGE_HOOK.get() { hook(); } }

/// End what has run out: a pending request past [`RETENTION`] expires, one
/// whose session is gone closes (both drop their bytes), and any record past
/// [`RETENTION`] goes. Whether a pending request ended.
fn prune(list: &mut Vec<Request>) -> bool {
    let mut ended = false;
    for request in list.iter_mut().filter(|r| r.state == State::Pending) {
        let next = if request.created.elapsed() >= RETENTION { Some(State::Expired) }
            else if !crate::services::root_mcp::session_alive(&request.session) { Some(State::Closed) }
            else { None };
        if let Some(state) = next {
            request.state = state;
            request.bytes = None;
            ended = true;
        }
    }
    list.retain(|r| r.created.elapsed() < RETENTION);
    let over = list.len().saturating_sub(MAX_RECORDS);
    if over > 0 {
        // Oldest finished records first; a pending one is never dropped here
        // (there are at most MAX_PENDING_TOTAL of them).
        let mut dropped = 0;
        list.retain(|r| {
            if dropped < over && r.state != State::Pending { dropped += 1; false } else { true }
        });
    }
    ended
}

/// Run [`prune`] and ring the window when a pending request ended — called
/// when a tab's session ends (`terminal` exit path) and on every list.
pub fn sweep() -> bool {
    let ended = prune(&mut store().lock_ok());
    if ended { changed(); }
    ended
}

fn view(request: &Request) -> RequestView {
    RequestView {
        id: request.id.clone(), tab: request.tab.clone(), project_id: request.project.clone(),
        file: request.file.clone(), size: request.size, sha256: request.sha256.clone(),
        options: request.options.clone(), note: request.note.clone(),
        created_at: request.created_at.clone(), state: request.state,
    }
}

/// The pending requests, oldest first — what the window lists.
pub fn pending() -> Vec<RequestView> {
    let mut list = store().lock_ok();
    let ended = prune(&mut list);
    let views = list.iter().filter(|r| r.state == State::Pending).map(view).collect();
    drop(list);
    if ended { changed(); }
    views
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecideError { Gone }
impl DecideError {
    pub fn code(self) -> &'static str { match self { Self::Gone => "gone" } }
}

/// The snapshot a pending request holds — what the preview shows and the
/// printer gets. `Gone` once it ended.
pub fn pdf(id: &str) -> Result<Arc<Vec<u8>>, DecideError> {
    let mut list = store().lock_ok();
    let ended = prune(&mut list);
    let found = list.iter().find(|r| r.id == id && r.state == State::Pending).and_then(|r| r.bytes.clone());
    drop(list);
    if ended { changed(); }
    found.ok_or(DecideError::Gone)
}

/// The user's decision on a pending request: [`State::Printed`] (approved and
/// handed to the print system) or [`State::Rejected`]. Anything else, or a
/// request that is no longer pending, is `Gone`.
pub fn decide(id: &str, outcome: State) -> Result<(), DecideError> {
    if !matches!(outcome, State::Printed | State::Rejected) { return Err(DecideError::Gone); }
    let mut list = store().lock_ok();
    prune(&mut list);
    let Some(request) = list.iter_mut().find(|r| r.id == id && r.state == State::Pending) else {
        drop(list);
        changed();
        return Err(DecideError::Gone);
    };
    request.state = outcome;
    request.bytes = None;
    drop(list);
    changed();
    Ok(())
}

// ── Arguments ───────────────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RequestArgs {
    file: String,
    copies: Option<u32>,
    pages: Option<String>,
    grayscale: Option<bool>,
    duplex: Option<String>,
    pages_per_sheet: Option<u32>,
    booklet: Option<bool>,
    note: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct IdArgs { id: String }

#[derive(serde::Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct StatusArgs { id: Option<String> }

/// A page range the preview's custom field reads: digits, `,`, `-` and
/// spaces; at least one page; every bound ≥ 1 and in order.
fn valid_range(spec: &str) -> bool {
    if spec.is_empty() || spec.chars().count() > MAX_RANGE_CHARS
        || !spec.chars().all(|c| c.is_ascii_digit() || matches!(c, ',' | '-' | ' ')) {
        return false;
    }
    let mut any = false;
    for part in spec.split(',').map(str::trim) {
        if part.is_empty() { continue; }
        let mut bounds = part.splitn(2, '-').map(str::trim);
        let lo = bounds.next().and_then(|n| n.parse::<u32>().ok());
        let hi = match bounds.next() { None => lo, Some(n) => n.parse::<u32>().ok() };
        match (lo, hi) {
            (Some(lo), Some(hi)) if lo >= 1 && hi >= lo => any = true,
            _ => return false,
        }
    }
    any
}

struct Parsed { file: String, options: Options, note: Option<String> }

fn parse_request(args: &Value) -> Result<Parsed, String> {
    let args: RequestArgs = serde_json::from_value(args.clone()).map_err(|e| format!("invalid arguments: {e}"))?;
    let file = args.file.trim().to_string();
    if file.is_empty() || file.chars().count() > MAX_FILE_CHARS {
        return Err(format!("`file` must be a project path of at most {MAX_FILE_CHARS} characters"));
    }
    let copies = args.copies.unwrap_or(1);
    if !(1..=MAX_COPIES).contains(&copies) { return Err(format!("`copies` must be 1–{MAX_COPIES}")); }
    let pages = match args.pages.map(|p| p.trim().to_string()).filter(|p| !p.is_empty() && p != "all") {
        Some(spec) if !valid_range(&spec) => return Err("`pages` must be a range such as \"1-3, 5\"".into()),
        other => other,
    };
    let duplex = match args.duplex.as_deref() {
        None => None,
        Some(d @ ("none" | "long" | "short")) => Some(d.to_string()),
        Some(_) => return Err("`duplex` must be none, long or short".into()),
    };
    if let Some(n) = args.pages_per_sheet {
        if !PAGES_PER_SHEET.contains(&n) { return Err("`pagesPerSheet` must be 1, 2, 4, 6, 9 or 16".into()); }
    }
    let booklet = args.booklet.unwrap_or(false);
    if booklet && args.pages_per_sheet.is_some_and(|n| n != 2) {
        return Err("a booklet is two pages per side: leave `pagesPerSheet` out".into());
    }
    let note = match args.note.map(|n| markup_mcp::clean(&n)).filter(|n| !n.is_empty()) {
        Some(n) if n.chars().count() > MAX_NOTE_CHARS => return Err(format!("`note` is at most {MAX_NOTE_CHARS} characters")),
        other => other,
    };
    Ok(Parsed {
        file,
        options: Options { copies, pages, grayscale: args.grayscale.unwrap_or(false), duplex, pages_per_sheet: args.pages_per_sheet, booklet },
        note,
    })
}

/// Why a file could not be snapshotted.
#[derive(Debug, PartialEq, Eq)]
pub enum ReadError { NotFound, NotPdf, TooLarge }

/// `file` (project-relative, or absolute below the project) as the
/// project-relative path and the PDF's bytes: resolved by the markup lane's
/// strict rules (`markup_mcp::resolve_file`), opened one checked name at a
/// time with no link on the way, sniffed as a PDF and capped.
pub fn read_pdf(root: &Path, file: &str) -> Result<(String, Vec<u8>), ReadError> {
    let rel = markup_mcp::resolve_file(root, file, true).map_err(|_| ReadError::NotFound)?;
    let served = files::open_served(root, &rel).map_err(|_| ReadError::NotFound)?;
    if served.kind != "application/pdf" { return Err(ReadError::NotPdf); }
    if served.meta.len() > MAX_PDF_BYTES { return Err(ReadError::TooLarge); }
    let mut bytes = Vec::with_capacity(served.meta.len() as usize);
    use std::io::Read;
    served.file.take(MAX_PDF_BYTES + 1).read_to_end(&mut bytes).map_err(|_| ReadError::NotFound)?;
    if bytes.len() as u64 > MAX_PDF_BYTES { return Err(ReadError::TooLarge); }
    if !bytes.starts_with(b"%PDF-") { return Err(ReadError::NotPdf); }
    Ok((rel, bytes))
}

// ── Budget ──────────────────────────────────────────────────────────────────

fn rates() -> &'static Mutex<HashMap<String, VecDeque<Instant>>> {
    static RATES: OnceLock<Mutex<HashMap<String, VecDeque<Instant>>>> = OnceLock::new();
    RATES.get_or_init(Default::default)
}
/// [`REQUESTS_PER_HOUR`] `print_request` calls per tab, rolling.
fn admit_rate(tab: &str) -> bool {
    let mut map = rates().lock_ok();
    map.retain(|_, calls| { calls.retain(|at| at.elapsed() < Duration::from_secs(3600)); !calls.is_empty() });
    let calls = map.entry(tab.to_string()).or_default();
    if calls.len() >= REQUESTS_PER_HOUR { return false; }
    calls.push_back(Instant::now());
    true
}

// ── MCP ─────────────────────────────────────────────────────────────────────

const INVALID: &str = "invalid";
const FILE_NOT_FOUND: &str = "file_not_found";
const NOT_PDF: &str = "not_pdf";
const TOO_LARGE: &str = "too_large";
const BUDGET: &str = "budget";
const PENDING_LIMIT: &str = "pending_limit";
const OFF: &str = "off";
const NOT_FOUND: &str = "not_found";

fn refused(category: &'static str, message: impl Into<String>) -> Value {
    json!({"status": "refused", "category": category, "message": message.into()})
}

/// The fixed category of a refused call, for the audit ring.
pub fn refusal_reason(reply: &Value) -> Option<&'static str> {
    if reply.get("error").is_some() || reply["result"]["isError"] == true { return Some("invalid_or_unavailable"); }
    let structured = &reply["result"]["structuredContent"];
    (structured["status"] == "refused").then(|| match structured["category"].as_str() {
        Some(FILE_NOT_FOUND) => FILE_NOT_FOUND,
        Some(NOT_PDF) => NOT_PDF,
        Some(TOO_LARGE) => TOO_LARGE,
        Some(BUDGET) => BUDGET,
        Some(PENDING_LIMIT) => PENDING_LIMIT,
        Some(OFF) => OFF,
        Some(NOT_FOUND) => NOT_FOUND,
        _ => INVALID,
    })
}

/// Every tool call and everything refused; not the handshake (as markup).
pub fn audited(message: &Value, reason: Option<&str>) -> bool {
    reason.is_some() || message["method"] == "tools/call"
}

pub fn tools() -> Value {
    let object = |properties: Value, required: Value| json!({"type":"object","properties":properties,"required":required,"additionalProperties":false});
    json!([
        {"name": TOOL_REQUEST,
         "description": concat!("Ask to print a PDF of this project. Nothing prints until the user approves it in ", crate::app_name!(), "'s print preview (then picks the printer in the system print dialog). Returns at once with an id and status `pending`; poll print_status for `printed` / `rejected`. Only PDFs: build one first. Budget: ten per hour, at most two pending."),
         "inputSchema": object(json!({
            "file": {"type":"string","maxLength":MAX_FILE_CHARS,"description":"The PDF, relative to the project folder (e.g. \"build/report.pdf\")."},
            "copies": {"type":"integer","minimum":1,"maximum":MAX_COPIES,"description":"Copies, collated (default 1)."},
            "pages": {"type":"string","maxLength":MAX_RANGE_CHARS,"description":"Pages to print, e.g. \"1-3, 5\" (default all)."},
            "grayscale": {"type":"boolean","description":"Print in grayscale (default false)."},
            "duplex": {"type":"string","enum":["none","long","short"],"description":"Two-sided: none, long edge or short edge (default: the user's setting)."},
            "pagesPerSheet": {"type":"integer","enum":PAGES_PER_SHEET,"description":"Pages on one side of a sheet (default 1)."},
            "booklet": {"type":"boolean","description":"Print as a folded booklet (two pages per side, short-edge two-sided)."},
            "note": {"type":"string","maxLength":MAX_NOTE_CHARS,"description":"Optional: one line for the user on why or what (shown on the request)."}
         }), json!(["file"]))},
        {"name": TOOL_STATUS,
         "description": "This tab's print requests and their state (pending, printed, rejected, withdrawn, expired, closed): one by id, or the latest ten.",
         "inputSchema": object(json!({"id":{"type":"string","maxLength":64,"description":"The id print_request returned (optional)."}}), json!([])),
         "annotations": {"readOnlyHint": true}},
        {"name": TOOL_CANCEL,
         "description": "Withdraw this tab's pending print request (it disappears from the user's list). `not_found` when it is not pending.",
         "inputSchema": object(json!({"id":{"type":"string","maxLength":64,"description":"The id print_request returned."}}), json!(["id"])),
         "annotations": {"idempotentHint": true}}
    ])
}

/// What a print tool call needs that is not in the message.
pub struct Context<'a> {
    pub enabled: bool,
    pub root: &'a dyn Fn() -> Option<PathBuf>,
}

fn new_id() -> String {
    format!("print-{}", crate::services::root_mcp::mint_token().map(|t| t[..16].to_string())
        .unwrap_or_else(|| format!("{:x}", chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default())))
}

fn call_request(session: &Session, project: &str, ctx: &Context, args: &Value) -> Value {
    if !ctx.enabled {
        return refused(OFF, concat!("Agent printing is switched off in ", crate::app_name!(), "'s Settings → Manage CLIs. Tell the user which file to print instead."));
    }
    let parsed = match parse_request(args) { Ok(p) => p, Err(e) => return refused(INVALID, e) };
    {
        let mut list = store().lock_ok();
        prune(&mut list);
        let tab_pending = list.iter().filter(|r| r.state == State::Pending && r.tab == session.identity.tab).count();
        let all_pending = list.iter().filter(|r| r.state == State::Pending).count();
        if tab_pending >= MAX_PENDING_PER_TAB || all_pending >= MAX_PENDING_TOTAL {
            return refused(PENDING_LIMIT, format!("At most {MAX_PENDING_PER_TAB} print requests per tab wait for the user. Poll print_status, or print_cancel one."));
        }
    }
    if !admit_rate(&session.identity.tab) {
        let mut value = refused(BUDGET, format!("At most {REQUESTS_PER_HOUR} print requests per tab per hour."));
        value["retryAfterSecs"] = json!(3600);
        return value;
    }
    let Some(root) = (ctx.root)() else {
        return refused(FILE_NOT_FOUND, "This project's folder is not on this machine, so nothing in it can be printed here.");
    };
    let (file, bytes) = match read_pdf(&root, &parsed.file) {
        Ok(found) => found,
        Err(ReadError::NotFound) => return refused(FILE_NOT_FOUND, "No such file in this project. Give `file` relative to the project folder; hidden files and links are not followed."),
        Err(ReadError::NotPdf) => return refused(NOT_PDF, "Only PDFs can be printed. Build a PDF first (LaTeX, pandoc, a script) and request that."),
        Err(ReadError::TooLarge) => return refused(TOO_LARGE, format!("The PDF is larger than {} MB.", MAX_PDF_BYTES / (1024 * 1024))),
    };
    let id = new_id();
    let size = bytes.len() as u64;
    let sha256 = crate::digest::sha256_hex(&bytes);
    let mut list = store().lock_ok();
    prune(&mut list);
    // Checked again under the lock the push takes: two calls racing past the
    // first check must not both land.
    let tab_pending = list.iter().filter(|r| r.state == State::Pending && r.tab == session.identity.tab).count();
    if tab_pending >= MAX_PENDING_PER_TAB || list.iter().filter(|r| r.state == State::Pending).count() >= MAX_PENDING_TOTAL {
        return refused(PENDING_LIMIT, format!("At most {MAX_PENDING_PER_TAB} print requests per tab wait for the user. Poll print_status, or print_cancel one."));
    }
    list.push(Request {
        id: id.clone(), session: session.id.clone(), tab: session.identity.tab.clone(), project: project.to_string(),
        file: file.clone(), bytes: Some(Arc::new(bytes)), size, sha256, options: parsed.options, note: parsed.note,
        created: Instant::now(), created_at: chrono::Local::now().to_rfc3339(), state: State::Pending,
    });
    prune(&mut list);
    drop(list);
    changed();
    json!({"id": id, "status": "pending", "file": file,
        "message": "Waiting for the user's approval in the print preview. Poll print_status for the outcome; do not ask again meanwhile."})
}

fn status_row(request: &Request) -> Value {
    json!({"id": request.id, "file": request.file, "state": request.state, "createdAt": request.created_at})
}

fn call_status(session: &Session, args: &Value) -> Value {
    let args: StatusArgs = if args.is_null() { StatusArgs::default() } else {
        match serde_json::from_value(args.clone()) { Ok(a) => a, Err(e) => return refused(INVALID, format!("invalid arguments: {e}")) }
    };
    let mut list = store().lock_ok();
    let ended = prune(&mut list);
    let mine = |r: &&Request| r.tab == session.identity.tab;
    let value = match args.id {
        Some(id) => match list.iter().filter(mine).find(|r| r.id == id) {
            Some(request) => json!({"status": "ok", "requests": [status_row(request)]}),
            None => refused(NOT_FOUND, "No print request of this tab has that id (records last 24 hours)."),
        },
        None => {
            let rows: Vec<Value> = list.iter().filter(mine).rev().take(STATUS_LIST).map(status_row).collect();
            json!({"status": "ok", "requests": rows})
        }
    };
    drop(list);
    if ended { changed(); }
    value
}

fn call_cancel(session: &Session, args: &Value) -> Value {
    let args: IdArgs = match serde_json::from_value(args.clone()) { Ok(a) => a, Err(e) => return refused(INVALID, format!("invalid arguments: {e}")) };
    let mut list = store().lock_ok();
    let ended = prune(&mut list);
    let found = list.iter_mut().find(|r| r.id == args.id && r.tab == session.identity.tab && r.state == State::Pending);
    let withdrawn = found.map(|request| { request.state = State::Withdrawn; request.bytes = None; }).is_some();
    drop(list);
    if ended || withdrawn { changed(); }
    if withdrawn { json!({"status": "withdrawn"}) } else { refused(NOT_FOUND, "No pending print request of this tab has that id.") }
}

/// One JSON-RPC message from a [`Caller::Printer`] session against the live
/// switch and `projects.json`; `None` for a notification.
pub fn handle_message(session: &Session, message: &Value) -> Option<Value> {
    let root = || session.identity.project.as_deref().and_then(markup_mcp::project_root);
    handle_with(session, message, &Context { enabled: enabled(), root: &root })
}

/// Whether the switch is on (`Settings::print_mcp`, absent = on). An
/// unreadable file answers off: spawn and request agree.
pub fn enabled_in(settings: &Path) -> bool {
    crate::storage::read_json::<crate::schema::Settings>(settings).is_ok_and(|s| s.print_mcp())
}
pub fn enabled() -> bool { enabled_in(&crate::storage::settings_path()) }

/// [`handle_message`] with its world passed in. Any other class, a revoked
/// session or one without its project binding is refused here too, whatever
/// the route said.
pub fn handle_with(session: &Session, message: &Value, ctx: &Context) -> Option<Value> {
    let error = |id: Value, code: i64, text: &str| Some(json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":text}}));
    if message["jsonrpc"] != "2.0" || !message["method"].is_string()
        || message.get("id").is_some_and(|id| !id.is_string() && !id.is_i64() && !id.is_u64())
        || message.get("params").is_some_and(|p| !p.is_object()) {
        return error(Value::Null, -32600, "invalid request");
    }
    let id = message.get("id").cloned()?;
    if session.identity.caller != Caller::Printer || session.check().is_err() { return error(id, -32000, "access refused"); }
    let Some(project) = session.identity.project.as_deref() else { return error(id, -32000, "access refused") };
    let ok = |value: Value| Some(json!({"jsonrpc":"2.0","id":id,"result":value}));
    match message["method"].as_str().unwrap_or_default() {
        "initialize" => ok(json!({"protocolVersion":"2025-03-26","capabilities":{"tools":{}},
            "serverInfo":{"name":SERVER_NAME,"version":env!("CARGO_PKG_VERSION")},"instructions":INSTRUCTIONS})),
        "ping" => ok(json!({})),
        "tools/list" => ok(json!({"tools": tools()})),
        "tools/call" => {
            let name = message["params"]["name"].as_str().unwrap_or_default();
            let args = message["params"].get("arguments").cloned().unwrap_or(Value::Null);
            if !crate::services::root_mcp_security::tool(name).is_some_and(|t| t.serves(Caller::Printer)) {
                return ok(json!({"content":[{"type":"text","text":"unknown tool"}],"isError":true}));
            }
            let value = match name {
                TOOL_REQUEST => call_request(session, project, ctx, &args),
                TOOL_STATUS => call_status(session, &args),
                _ => call_cancel(session, &args),
            };
            ok(json!({"content":[{"type":"text","text":value.to_string()}],"structuredContent":value,"isError":false}))
        }
        _ => error(id, -32601, "method not found"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::root_mcp::test_session_bound;

    fn root() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join("build")).unwrap();
        std::fs::write(root.join("build").join("report.pdf"), b"%PDF-1.7\nhello").unwrap();
        std::fs::write(root.join("notes.txt"), b"plain text").unwrap();
        (dir, root)
    }

    fn call(session: &Session, ctx: &Context, tool: &str, args: Value) -> Value {
        let msg = json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":tool,"arguments":args}});
        let reply = handle_with(session, &msg, ctx).expect("a reply");
        reply["result"]["structuredContent"].clone()
    }

    #[test]
    fn page_ranges_are_checked() {
        for ok in ["1", "1-3", "1-3, 5", " 2 - 4 ,7", "5,"] { assert!(valid_range(ok), "{ok}"); }
        for bad in ["", "0", "3-1", "a", "1-2-3", "-2", ",", "1;2", &"1,".repeat(60)] { assert!(!valid_range(bad), "{bad}"); }
    }

    #[test]
    fn arguments_are_validated_before_anything_is_read() {
        let (_dir, root) = root();
        let (_, s) = test_session_bound(Caller::Printer, "print-args", "p", "t");
        let find = move || Some(root.clone());
        let ctx = Context { enabled: true, root: &find };
        for args in [
            json!({}),
            json!({"file": ""}),
            json!({"file": "build/report.pdf", "copies": 0}),
            json!({"file": "build/report.pdf", "copies": 100}),
            json!({"file": "build/report.pdf", "pages": "x"}),
            json!({"file": "build/report.pdf", "duplex": "both"}),
            json!({"file": "build/report.pdf", "pagesPerSheet": 3}),
            json!({"file": "build/report.pdf", "booklet": true, "pagesPerSheet": 4}),
            json!({"file": "build/report.pdf", "printer": "x"}),
            json!({"file": "build/report.pdf", "note": "n".repeat(MAX_NOTE_CHARS + 1)}),
        ] {
            assert_eq!(call(&s, &ctx, TOOL_REQUEST, args.clone())["category"], INVALID, "{args}");
        }
    }

    #[test]
    fn only_a_pdf_of_the_project_is_snapshotted() {
        let (_dir, root) = root();
        let (_, s) = test_session_bound(Caller::Printer, "print-files", "p", "t");
        let find = { let root = root.clone(); move || Some(root.clone()) };
        let ctx = Context { enabled: true, root: &find };
        assert_eq!(call(&s, &ctx, TOOL_REQUEST, json!({"file": "missing.pdf"}))["category"], FILE_NOT_FOUND);
        assert_eq!(call(&s, &ctx, TOOL_REQUEST, json!({"file": "../outside.pdf"}))["category"], FILE_NOT_FOUND);
        assert_eq!(call(&s, &ctx, TOOL_REQUEST, json!({"file": "notes.txt"}))["category"], NOT_PDF);
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join("build").join("report.pdf"), root.join("link.pdf")).unwrap();
            assert_eq!(call(&s, &ctx, TOOL_REQUEST, json!({"file": "link.pdf"}))["category"], FILE_NOT_FOUND, "no link is followed");
        }
        let none = || None;
        let away = Context { enabled: true, root: &none };
        assert_eq!(call(&s, &away, TOOL_REQUEST, json!({"file": "build/report.pdf"}))["category"], FILE_NOT_FOUND);
    }

    #[test]
    fn off_refuses_and_no_other_class_is_served() {
        let (_dir, root) = root();
        let find = move || Some(root.clone());
        let (_, s) = test_session_bound(Caller::Printer, "print-off", "p", "t");
        let off = Context { enabled: false, root: &find };
        assert_eq!(call(&s, &off, TOOL_REQUEST, json!({"file": "build/report.pdf"}))["category"], OFF);
        let (_, marker) = test_session_bound(Caller::Marker, "print-marker", "p", "t");
        let msg = json!({"jsonrpc":"2.0","id":1,"method":"tools/list"});
        let on = Context { enabled: true, root: &find };
        assert!(handle_with(&marker, &msg, &on).unwrap().get("error").is_some());
        for name in TOOLS {
            let tool = crate::services::root_mcp_security::tool(name).unwrap();
            assert!(tool.serves(Caller::Printer), "{name}");
            for other in [Caller::Agent, Caller::LocalModel, Caller::Reader, Caller::Scheduler, Caller::Pusher, Caller::Helper, Caller::Marker, Caller::Web, Caller::Cockpit] {
                assert!(!tool.serves(other), "{name} must not serve {other:?}");
            }
        }
    }

    #[test]
    fn a_request_waits_for_the_user_and_keeps_its_snapshot() {
        let (_dir, root) = root();
        let (_, s) = test_session_bound(Caller::Printer, "print-flow", "proj-flow", "t");
        let find = { let root = root.clone(); move || Some(root.clone()) };
        let ctx = Context { enabled: true, root: &find };
        let reply = call(&s, &ctx, TOOL_REQUEST, json!({"file": "build/report.pdf", "copies": 2, "pages": "1-2", "duplex": "long", "note": "for the meeting"}));
        assert_eq!(reply["status"], "pending", "{reply}");
        let id = reply["id"].as_str().unwrap().to_string();
        // The agent rewrites the file after asking: the snapshot stays.
        std::fs::write(root.join("build").join("report.pdf"), b"%PDF-1.7\nswapped").unwrap();
        assert_eq!(pdf(&id).unwrap().as_slice(), b"%PDF-1.7\nhello");
        let shown = pending().into_iter().find(|r| r.id == id).expect("listed");
        assert_eq!(shown.file, "build/report.pdf");
        assert_eq!(shown.project_id, "proj-flow");
        assert_eq!(shown.options.copies, 2);
        assert_eq!(shown.options.duplex.as_deref(), Some("long"));
        assert_eq!(shown.note.as_deref(), Some("for the meeting"));
        assert_eq!(call(&s, &ctx, TOOL_STATUS, json!({"id": id}))["requests"][0]["state"], "pending");
        decide(&id, State::Printed).unwrap();
        assert_eq!(call(&s, &ctx, TOOL_STATUS, json!({"id": id}))["requests"][0]["state"], "printed");
        assert_eq!(pdf(&id), Err(DecideError::Gone), "the bytes go with the decision");
        assert_eq!(decide(&id, State::Rejected), Err(DecideError::Gone), "decided once");
        assert!(pending().iter().all(|r| r.id != id));
    }

    #[test]
    fn pending_requests_are_capped_per_tab_and_cancel_is_the_tabs_own() {
        let (_dir, root) = root();
        let (_, s) = test_session_bound(Caller::Printer, "print-cap", "p", "t");
        let (_, other) = test_session_bound(Caller::Printer, "print-cap-other", "p", "t");
        let find = move || Some(root.clone());
        let ctx = Context { enabled: true, root: &find };
        let a = call(&s, &ctx, TOOL_REQUEST, json!({"file": "build/report.pdf"}))["id"].as_str().unwrap().to_string();
        let b = call(&s, &ctx, TOOL_REQUEST, json!({"file": "build/report.pdf"}))["id"].as_str().unwrap().to_string();
        assert_eq!(call(&s, &ctx, TOOL_REQUEST, json!({"file": "build/report.pdf"}))["category"], PENDING_LIMIT);
        assert_eq!(call(&other, &ctx, TOOL_CANCEL, json!({"id": a}))["category"], NOT_FOUND, "another tab's request");
        assert_eq!(call(&other, &ctx, TOOL_STATUS, json!({"id": a}))["category"], NOT_FOUND);
        assert_eq!(call(&s, &ctx, TOOL_CANCEL, json!({"id": a}))["status"], "withdrawn");
        assert_eq!(call(&s, &ctx, TOOL_CANCEL, json!({"id": a}))["category"], NOT_FOUND, "only pending ones");
        assert_eq!(pdf(&a), Err(DecideError::Gone));
        let listed = call(&s, &ctx, TOOL_STATUS, json!({}));
        assert_eq!(listed["requests"][0]["id"], b.as_str(), "newest first: {listed}");
        decide(&b, State::Rejected).unwrap();
    }

    #[test]
    fn a_closed_session_closes_its_pending_requests() {
        let (_dir, root) = root();
        let (token, s) = test_session_bound(Caller::Printer, "print-closed", "p", "t");
        let find = move || Some(root.clone());
        let ctx = Context { enabled: true, root: &find };
        let id = call(&s, &ctx, TOOL_REQUEST, json!({"file": "build/report.pdf"}))["id"].as_str().unwrap().to_string();
        crate::services::root_mcp::revoke_token(&token);
        sweep();
        assert!(pending().iter().all(|r| r.id != id));
        assert_eq!(pdf(&id), Err(DecideError::Gone));
    }
}
