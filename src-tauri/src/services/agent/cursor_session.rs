//! Cursor CLI's stored chats: the Reader's Chat and Diffs views, the Resume
//! menu and a restored tab's resume. Read from 2026.11.22's store, outside the
//! app, against the user's login (`docs/third_party_update_checklist.md`).
//!
//! Cursor keeps one folder per chat in the tab's agent home,
//! `.cursor/chats/<md5 of the working folder>/<chat id>/`, holding
//! `meta.json` (`cwd`, `createdAtMs`, `updatedAtMs`, `hasConversation`; written
//! at launch, before any prompt) and `store.db`, a SQLite content-addressed
//! blob store (`blobs(id, data)`, one `meta` row). The row names the latest
//! root blob, a protobuf whose repeated field 1 lists the conversation's
//! message blobs in order (system, `<user_info>`, then per turn the prompt, the
//! assistant's messages and the tool results — JSON in the AI-SDK shape) and
//! whose field 8 lists one blob per turn, with the prompt as typed and its
//! time. What is read: the prompts (the text inside `<user_query>`), the
//! assistant's text parts, and — for the Diffs — the diff a `Write` or
//! `StrReplace` result carries and the content a delete removed. Reasoning
//! (stored empty), tool calls and their other results, and the user's
//! `<user_info>` block never become chat. This build retries a turn once or
//! more ("Your previous response was interrupted. Continue from where you left
//! off.", then the answer again): that synthetic prompt is stepped over and an
//! answer repeating the one before it is dropped.
//!
//! A subagent's chat is a folder of its own beside the others with a
//! `store.db` and no `meta.json`, so it is never listed or taken for a tab's
//! chat. Its chat is not read (`no_subagent`): the parent's `Task` call is a
//! dynamic tool call, not an entry.
//!
//! Which chat is a tab's own. Cursor's `sessionStart` hook fires only for a
//! fresh launch, so the record comes from `beforeSubmitPrompt` ([`hook`]),
//! which carries the chat each prompt goes into — also the new one after a
//! `/clear`. At each spawn where the hook is registered, a host-only launch note
//! (`live_sessions/<uid>.cursor`) says the tab ran with it. The rule
//! ([`resolve`], the one Muse uses): the restore's `--continue` becomes
//! `--resume <id>` when
//!
//! - noted at an earlier spawn, and the record names a chat of the folder —
//!   the record is the tab's, whatever began since;
//! - not noted (a tab from before the hook), and a record: while the tab began
//!   no chat since the record (the Resume menu's pick);
//!
//! noted with no record, and the hook proven in the scope, the tab never took a
//! prompt: fresh (a `--continue` into another tab's chat is dropped); otherwise
//! `--continue` stays, dropped when the folder has no chat with a conversation
//! (`--continue` there prints "No previous chats found." and exits).
//!
//! The Reader reads the recorded chat while the tab is noted; otherwise the
//! folder's newest chat begun since the tab launched (any, once restored), or
//! since the record, else the recorded one.
//!
//! The store is written by the agent: every read is bounded (bytes, rows,
//! blobs, text) and goes through `agent_sqlite`'s opener.

mod hook;

pub use hook::{register_in_home, write_script as write_hook};

use std::path::Path;

use rusqlite::Connection;
use serde_json::Value;

use crate::services::agent_changes::{AgentChanges, FileChange};
use crate::services::agent_chats::FolderChat;
use crate::services::agent_session::{is_uuid_shaped, live_sessions_dir, project_live_sessions_dir, TAB_AGENT_ENV};
use crate::services::agent_sqlite::{self, Limits};
use crate::services::agent_transcript::{prompt_cut_off, transcript_entry, AgentTranscript};
use crate::services::home_io::HomeDir;
use crate::terminal::PtyOptions;

/// Where the chats sit in an agent home (no `XDG_*` change in a tab).
const STORE: &str = ".cursor/chats";
/// Chats looked at, newest first: a folder's own are found among these.
const MAX_CHATS: usize = 512;
/// Entries read from the folder's directory at most (a hostile one is capped).
const MAX_FOLDER_ENTRIES: usize = 4096;
/// The largest `meta.json` read.
const MAX_META_BYTES: u64 = 64 * 1024;
/// Message blobs one read follows from the root.
const MAX_MESSAGES: usize = 50_000;
/// Turn blobs one read follows.
const MAX_TURNS: usize = 10_000;
/// The largest blob one read takes (a tool result holding a whole file); a
/// larger one is stepped over.
const MAX_BLOB_BYTES: i64 = 8 * 1024 * 1024;
/// The most bytes of blobs one read takes together.
const MAX_READ_BYTES: u64 = 128 * 1024 * 1024;
/// The largest `meta` value (hex of its JSON).
const MAX_META_ROW: usize = 128 * 1024;
/// Protobuf fields walked in one blob.
const MAX_FIELDS: usize = 200_000;

// ── protobuf ────────────────────────────────────────────────────────────────

/// One field of a protobuf message, as far as this reader needs: a varint or
/// a length-delimited string of bytes (fixed-width fields are stepped over).
enum Wire<'a> {
    Varint(u64),
    Bytes(&'a [u8]),
}

fn varint(buf: &[u8]) -> Option<(u64, usize)> {
    let mut value = 0u64;
    for (at, byte) in buf.iter().take(10).enumerate() {
        value |= u64::from(byte & 0x7f) << (7 * at);
        if byte & 0x80 == 0 {
            return Some((value, at + 1));
        }
    }
    None
}

/// The fields of `buf` in order, up to the first one that does not parse.
fn fields(buf: &[u8]) -> Vec<(u32, Wire<'_>)> {
    let mut out = Vec::new();
    let mut at = 0;
    while at < buf.len() && out.len() < MAX_FIELDS {
        let Some((key, used)) = varint(&buf[at..]) else { break };
        at += used;
        let field = u32::try_from(key >> 3).unwrap_or(0);
        match key & 7 {
            0 => {
                let Some((value, used)) = varint(&buf[at..]) else { break };
                at += used;
                out.push((field, Wire::Varint(value)));
            }
            1 => at += 8,
            5 => at += 4,
            2 => {
                let Some((len, used)) = varint(&buf[at..]) else { break };
                at += used;
                let Some(end) = usize::try_from(len).ok().and_then(|len| at.checked_add(len)).filter(|end| *end <= buf.len()) else { break };
                out.push((field, Wire::Bytes(&buf[at..end])));
                at = end;
            }
            _ => break,
        }
    }
    out
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn from_hex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) || !text.is_ascii() {
        return None;
    }
    (0..text.len()).step_by(2).map(|at| u8::from_str_radix(&text[at..at + 2], 16).ok()).collect()
}

/// A blob id as a field names it: 32 raw bytes.
fn blob_id(bytes: &[u8]) -> Option<String> {
    (bytes.len() == 32).then(|| to_hex(bytes))
}

// ── the store ───────────────────────────────────────────────────────────────

/// A chat's database, in its folder.
const STORE_DB: &str = "store.db";

/// One chat folder of the store, before its database is read.
struct Chat {
    id: String,
    dir: HomeDir,
    created: i64,
    updated: i64,
    /// `meta.json` says a prompt went into it.
    conversation: bool,
}

impl Chat {
    /// Whether the database is there: not before the chat's first prompt.
    fn has_store(&self) -> bool {
        self.dir.file(STORE_DB).is_some_and(|file| file.exists())
    }
}

/// A folder path as Cursor keys it: no trailing separator.
fn normal(dir: &str) -> &str {
    let trimmed = dir.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() { dir } else { trimmed }
}

/// The folder keys of `directory` the store may use: its path as given, and
/// the canonical one when that differs.
fn folder_keys(directory: &str) -> (Vec<String>, Option<std::path::PathBuf>) {
    let canonical = std::fs::canonicalize(directory).ok();
    let mut keys = vec![crate::services::agent_history::md5_hex(directory)];
    if let Some(real) = canonical.as_ref().and_then(|p| p.to_str()) {
        let key = crate::services::agent_history::md5_hex(real);
        if !keys.contains(&key) {
            keys.push(key);
        }
    }
    (keys, canonical)
}

/// One chat folder, when its `meta.json` says it began in `directory`.
fn chat_in(folder: &HomeDir, id: &str, directory: &str, canonical: Option<&Path>) -> Option<Chat> {
    let dir = folder.open_subdir(id)?;
    let bytes = dir.file("meta.json")?.read_capped(MAX_META_BYTES)?;
    let meta: Value = serde_json::from_slice(&bytes).ok()?;
    let cwd = meta.get("cwd")?.as_str()?;
    if Path::new(normal(cwd)) != Path::new(directory) && canonical != Some(Path::new(normal(cwd))) {
        return None;
    }
    let ms = |key: &str| meta.get(key).and_then(Value::as_i64).unwrap_or(0);
    Some(Chat {
        id: id.to_string(),
        dir,
        created: ms("createdAtMs"),
        updated: ms("updatedAtMs"),
        conversation: meta.get("hasConversation").and_then(Value::as_bool) == Some(true),
    })
}

/// The folder's chats (at most [`MAX_CHATS`]), most recently used first.
fn folder_chats_all(home: &Path, directory: &str) -> Vec<Chat> {
    let directory = normal(directory);
    let Some(root) = HomeDir::open_existing(home, STORE) else { return Vec::new() };
    let (keys, canonical) = folder_keys(directory);
    let mut out = Vec::new();
    for key in keys {
        let Some(folder) = root.open_subdir(&key) else { continue };
        for id in folder.names_capped(MAX_FOLDER_ENTRIES).into_iter().filter(|name| is_uuid_shaped(name)) {
            if let Some(chat) = chat_in(&folder, &id, directory, canonical.as_deref()) {
                out.push(chat);
            }
        }
    }
    out.sort_by(|a, b| b.updated.cmp(&a.updated).then_with(|| a.id.cmp(&b.id)));
    out.truncate(MAX_CHATS);
    out
}

/// The folder's chat `id`.
fn folder_chat_of(home: &Path, directory: &str, id: &str) -> Option<Chat> {
    if !is_uuid_shaped(id) {
        return None;
    }
    let directory = normal(directory);
    let root = HomeDir::open_existing(home, STORE)?;
    let (keys, canonical) = folder_keys(directory);
    keys.iter().find_map(|key| chat_in(&root.open_subdir(key)?, id, directory, canonical.as_deref()))
}

/// How a blob read filters on the message role.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Take {
    Any,
    /// Tool results only.
    Tools,
    /// Everything but tool results.
    NoTools,
}

/// One open `store.db`, with what it has been asked for so far.
struct Store {
    conn: Connection,
    spent: u64,
}

impl Store {
    /// `None` for a chat with no `store.db` (before its first prompt) and for
    /// one that cannot be opened.
    fn open(chat: &Chat) -> Option<Self> {
        let file = chat.dir.file(STORE_DB)?;
        let conn = agent_sqlite::open_read(&file, Limits::STORE, &["blobs", "meta"])?;
        Some(Store { conn, spent: 0 })
    }

    /// The `meta` row's JSON.
    fn meta(&self) -> Option<Value> {
        let hex: String = self.conn.query_row("SELECT value FROM meta WHERE key = '0'", [], |row| row.get(0)).ok()?;
        if hex.len() > MAX_META_ROW {
            return None;
        }
        serde_json::from_slice(&from_hex(&hex)?).ok()
    }

    fn blob(&mut self, id: &str, take: Take) -> Option<Vec<u8>> {
        if self.spent >= MAX_READ_BYTES {
            return None;
        }
        let mode = match take {
            Take::Any => 0,
            Take::Tools => 1,
            Take::NoTools => 2,
        };
        let mut stmt = self
            .conn
            .prepare_cached(
                "SELECT data FROM blobs WHERE id = ?1 AND length(data) <= ?2 \
                 AND (?3 = 0 OR ((instr(substr(data, 1, 64), CAST('\"role\":\"tool\"' AS BLOB)) > 0) = (?3 = 1)))",
            )
            .ok()?;
        let data: Vec<u8> = stmt.query_row(rusqlite::params![id, MAX_BLOB_BYTES, mode], |row| row.get(0)).ok()?;
        self.spent += data.len() as u64;
        Some(data)
    }

    fn json(&mut self, id: &str, take: Take) -> Option<Value> {
        let data = self.blob(id, take)?;
        (data.first() == Some(&b'{')).then(|| serde_json::from_slice(&data).ok()).flatten()
    }
}

/// What the `meta` row's root blob lists.
struct Root {
    /// The root blob's id: it changes with every message written.
    id: String,
    /// The conversation's message blobs, in order.
    messages: Vec<String>,
    /// One blob per turn.
    turns: Vec<String>,
}

fn root(store: &mut Store) -> Option<Root> {
    let id = store.meta()?.get("latestRootBlobId")?.as_str()?.to_string();
    if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let blob = store.blob(&id, Take::Any)?;
    let mut messages = Vec::new();
    let mut turns = Vec::new();
    for (field, wire) in fields(&blob) {
        let Wire::Bytes(bytes) = wire else { continue };
        match field {
            1 if messages.len() < MAX_MESSAGES => messages.extend(blob_id(bytes)),
            8 if turns.len() < MAX_TURNS => turns.extend(blob_id(bytes)),
            _ => {}
        }
    }
    Some(Root { id, messages, turns })
}

/// A turn's prompt as typed, and when (epoch ms): the turn blob's first
/// sub-message names the user step blob, whose field 1 is the text and field
/// 25 the time.
fn turn_prompt(store: &mut Store, turn: &str) -> Option<(String, Option<i64>)> {
    let blob = store.blob(turn, Take::Any)?;
    let message = fields(&blob).into_iter().find_map(|(field, wire)| match wire {
        Wire::Bytes(bytes) if field == 1 => Some(bytes.to_vec()),
        _ => None,
    })?;
    let step = fields(&message).into_iter().find_map(|(field, wire)| match wire {
        Wire::Bytes(bytes) if field == 1 => blob_id(bytes),
        _ => None,
    })?;
    let step = store.blob(&step, Take::Any)?;
    let mut text = None;
    let mut at = None;
    for (field, wire) in fields(&step) {
        match (field, wire) {
            (1, Wire::Bytes(bytes)) if text.is_none() => text = std::str::from_utf8(bytes).ok().map(str::to_string),
            (25, Wire::Varint(ms)) => at = i64::try_from(ms).ok(),
            _ => {}
        }
    }
    Some((text?, at))
}

// ── the conversation ────────────────────────────────────────────────────────

/// The user's prompt inside a user message's text: between `<user_query>` and
/// its closing tag. A message with no such block is Cursor's own (an attachment
/// reminder), not a prompt.
fn user_query(text: &str) -> Option<&str> {
    let start = text.find("<user_query>")? + "<user_query>".len();
    let end = text.rfind("</user_query>").filter(|end| *end >= start)?;
    Some(text[start..end].trim())
}

/// The parts of a message's `content` that are text, joined.
fn text_parts(message: &Value) -> String {
    let Some(parts) = message.get("content").and_then(Value::as_array) else { return String::new() };
    parts
        .iter()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
}

/// One turn of the chat: a prompt or an answer.
struct Turn {
    role: &'static str,
    text: String,
}

/// The chat's prompts and answers in order, and the model it last ran on.
fn turns(store: &mut Store, root: &Root) -> (Vec<Turn>, Option<String>) {
    let mut out: Vec<Turn> = Vec::new();
    let mut model = None;
    for id in &root.messages {
        let Some(message) = store.json(id, Take::NoTools) else { continue };
        match message.get("role").and_then(Value::as_str) {
            Some("user") => {
                // A string is `<user_info>` or the retry's synthetic prompt.
                if let Some(prompt) = user_query(&text_parts(&message)).filter(|prompt| !prompt.is_empty()) {
                    out.push(Turn { role: "prompt", text: prompt.to_string() });
                }
            }
            Some("assistant") => {
                if let Some(name) = message
                    .get("content")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|part| part.get("providerOptions")?.get("cursor")?.get("modelName")?.as_str())
                    .next_back()
                {
                    model = Some(name.to_string());
                }
                let text = text_parts(&message);
                // The retry answers the same words again.
                if !text.trim().is_empty() && !out.last().is_some_and(|last| last.role == "answer" && last.text == text) {
                    out.push(Turn { role: "answer", text });
                }
            }
            _ => {}
        }
    }
    (out, model)
}

fn iso(ms: i64) -> String {
    crate::services::prompt_blame::epoch_ms_to_iso(ms)
}

fn empty(version: String, previous: Option<&str>) -> AgentTranscript {
    AgentTranscript { available: true, unchanged: previous == Some(version.as_str()), version: Some(version), ..Default::default() }
}

/// The chat's transcript; `went_by` is what else the read went by, part of its version.
fn read(chat: &Chat, went_by: &str, version: Option<&str>, limit: usize) -> Option<AgentTranscript> {
    let tag = crate::digest::sha256_hex(went_by.as_bytes());
    // Before its first prompt a chat has no database.
    let Some(mut store) = Store::open(chat) else {
        return (!chat.has_store()).then(|| empty(format!("cursor:{}:new:{limit}:{tag}", chat.id), version));
    };
    let Some(root) = root(&mut store) else {
        return Some(empty(format!("cursor:{}:none:{limit}:{tag}", chat.id), version));
    };
    let current = format!("cursor:{}:{}:{limit}:{tag}", chat.id, root.id);
    let mut out = empty(current, version);
    if out.unchanged {
        return Some(out);
    }
    let (turns, model) = turns(&mut store, &root);
    out.model = model;
    // The typed prompts' times line up with the prompts only when there are as many.
    let times: Vec<Option<i64>> = if turns.iter().filter(|t| t.role == "prompt").count() == root.turns.len() {
        root.turns.iter().map(|turn| turn_prompt(&mut store, turn).and_then(|(_, at)| at)).collect()
    } else {
        Vec::new()
    };
    let mut prompt = 0;
    for turn in turns {
        let at = (turn.role == "prompt").then(|| {
            prompt += 1;
            times.get(prompt - 1).copied().flatten().map(iso)
        });
        out.entries.extend(transcript_entry(turn.role, &turn.text, at.flatten()));
    }
    if out.entries.len() > limit {
        let drop = out.entries.len() - limit;
        out.truncated = true;
        out.cut_prompt = prompt_cut_off(&out.entries, drop);
        out.entries.drain(..drop);
    }
    Some(out)
}

// ── the tab's own chat ──────────────────────────────────────────────────────

/// A tab's live-session record: the chat it names, when it was written
/// (epoch ms), and whether the tab ran with the hook since (its launch note),
/// which makes the record the tab's own whatever began since.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recorded {
    pub id: String,
    pub at: i64,
    pub noted: bool,
}

/// The record of the tab `uid`, for the Reader and the Resume menu.
pub fn recorded(project_id: Option<&str>, uid: &str) -> Option<Recorded> {
    let (id, at) = crate::services::google_chat::recorded_conversation(project_id, uid)?;
    Some(Recorded { id, at, noted: noted_in(&live_sessions_dir(), uid) })
}

/// Which of the folder's chats (`found`, most recently used first) the tab
/// reads: the one its `own` record names, when the tab is noted; else the
/// newest begun since `since` — and since the moment of its record, the chat
/// the Resume menu last took it onto — and with a conversation, else that one.
/// With no `since` at all (a restored tab) the most recently used. `None`: a
/// tab before its first chat.
fn tab_chat<'a>(found: &'a [Chat], since: Option<i64>, own: Option<&Recorded>) -> Option<&'a Chat> {
    if let Some(own) = own.filter(|own| own.noted) {
        if let Some(chat) = found.iter().find(|c| c.id == own.id) {
            return Some(chat);
        }
    }
    let own = own.filter(|own| found.iter().any(|c| c.id == own.id));
    let since = match own {
        Some(own) => Some(since.map_or(own.at, |since| since.max(own.at))),
        None => since,
    };
    let candidates = found.iter().filter(|c| c.conversation);
    let newest = match since {
        Some(since) => candidates.filter(|c| c.created >= since).max_by_key(|c| c.created),
        None => candidates.max_by_key(|c| c.updated),
    };
    newest.or_else(|| own.and_then(|own| found.iter().find(|c| c.id == own.id)))
}

/// The tab's chat in `directory`: see [`tab_chat`].
pub fn transcript(home: &Path, directory: &str, since: Option<i64>, own: Option<&Recorded>, version: Option<&str>, limit: usize) -> AgentTranscript {
    let found = folder_chats_all(home, directory);
    let read = match tab_chat(&found, since, own) {
        Some(chat) => read(chat, &format!("{since:?}:{own:?}"), version, limit),
        None => Some(empty(format!("cursor:new:{}:{since:?}:{limit}", crate::digest::sha256_hex(directory.as_bytes())), version)),
    };
    read.unwrap_or_else(|| AgentTranscript::unavailable("no_transcript"))
}

/// The folder's earlier chat `id`, picked in the Resume menu.
pub fn chat(home: &Path, directory: &str, id: &str, version: Option<&str>, limit: usize) -> AgentTranscript {
    folder_chat_of(home, directory, id)
        .and_then(|chat| read(&chat, "chat", version, limit))
        .unwrap_or_else(|| AgentTranscript::unavailable("no_transcript"))
}

/// Whether `id` is one of the chats Cursor began in `directory`.
pub fn folder_chat(home: &Path, directory: &str, id: &str) -> bool {
    folder_chat_of(home, directory, id).is_some()
}

/// The folder's chats for the Resume menu: from the `offset`-th on, at most
/// `limit` that a prompt went into, of at most `scanned` looked at.
pub fn folder_chats(home: &Path, directory: &str, offset: usize, limit: usize, scanned: usize) -> Option<(Vec<FolderChat>, Option<usize>)> {
    let found = folder_chats_all(home, directory);
    let mut chats = Vec::new();
    let mut at = offset;
    while at < found.len() && chats.len() < limit && at - offset < scanned {
        let chat = &found[at];
        at += 1;
        if !chat.conversation {
            continue;
        }
        let Some(mut store) = Store::open(chat) else { continue };
        let Some(root) = root(&mut store) else { continue };
        // The prompts as typed come from the turn blobs (two reads for the
        // first and last); a store whose turns cannot be read falls back to
        // the conversation's own prompts.
        let typed = root.turns.first().and_then(|turn| turn_prompt(&mut store, turn)).filter(|(text, _)| !text.trim().is_empty());
        let (first, first_at, last) = match typed {
            Some((first, at)) => {
                let last = root
                    .turns
                    .last()
                    .filter(|_| root.turns.len() > 1)
                    .and_then(|turn| turn_prompt(&mut store, turn))
                    .map(|(text, _)| text)
                    .filter(|text| !text.trim().is_empty() && *text != first);
                (first, at, last)
            }
            None => {
                let (all, _) = turns(&mut store, &root);
                let mut prompts = all.into_iter().filter(|t| t.role == "prompt").map(|t| t.text);
                let Some(first) = prompts.next() else { continue };
                let last = prompts.next_back().filter(|text| *text != first);
                (first, None, last)
            }
        };
        chats.push(FolderChat {
            id: chat.id.clone(),
            title: first,
            last,
            started: first_at.or((chat.created > 0).then_some(chat.created)).map(iso),
            updated: u64::try_from(chat.updated).unwrap_or(0),
        });
    }
    Some((chats, (at < found.len()).then_some(at)))
}

/// The chat the tab `uid` in `directory` is in by its record: see [`tab_chat`].
pub fn recorded_tab_session(home: &Path, directory: &str, project_id: Option<&str>, uid: &str) -> Option<String> {
    let record = recorded(project_id, uid)?;
    recorded_among(&folder_chats_all(home, directory), &record)
}

/// [`recorded_tab_session`] over the folder's chats already listed.
fn recorded_among(found: &[Chat], own: &Recorded) -> Option<String> {
    tab_chat(found, None, Some(own)).map(|c| c.id.clone()).filter(|id| *id == own.id)
}

// ── the diffs ───────────────────────────────────────────────────────────────

/// The changes the chat's tool results recorded, oldest first: the diff a
/// `Write` or `StrReplace` applied, or the content a delete removed. A call that
/// failed has no `success` and lists nothing.
fn chat_changes_of(store: &mut Store, root: &Root) -> Vec<FileChange> {
    let mut out = Vec::new();
    for id in &root.messages {
        let Some(message) = store.json(id, Take::Tools) else { continue };
        let result = message.get("providerOptions").and_then(|o| o.get("cursor")).and_then(|c| c.get("highLevelToolCallResult"));
        let Some(result) = result.filter(|r| r.get("isError").and_then(Value::as_bool) != Some(true)) else { continue };
        let Some(success) = result.get("output").and_then(|o| o.get("success")) else { continue };
        let Some(path) = success.get("path").and_then(Value::as_str).filter(|p| !p.is_empty()) else { continue };
        if let Some(diff) = success.get("diffString").and_then(Value::as_str) {
            let hunks = crate::services::agent_changes::hunks_only(diff);
            if hunks.is_empty() {
                continue;
            }
            let add = diff.starts_with("--- /dev/null");
            // A new file's hunk opens `-1,0`; the line before nothing is 0.
            let hunks = if add { hunks.replacen("@@ -1,0 +1", "@@ -0,0 +1", 1) } else { hunks.to_string() };
            out.push(crate::services::agent_changes::change(path, if add { "add" } else { "edit" }, hunks, None));
        } else if let Some(removed) = success.get("prevContent").and_then(Value::as_str).filter(|_| success.get("deletedFile").is_some()) {
            out.push(crate::services::agent_changes::whole_file(path, "delete", removed, None));
        }
    }
    out
}

fn changes_of(chat: &Chat, went_by: &str, version: Option<&str>, limit: usize) -> AgentChanges {
    let tag = crate::digest::sha256_hex(went_by.as_bytes());
    let Some(mut store) = Store::open(chat) else {
        // Nothing written yet — a chat before its first prompt.
        return if chat.has_store() { AgentChanges::unavailable("read_failed") } else { AgentChanges { available: true, ..Default::default() } };
    };
    let Some(root) = root(&mut store) else { return AgentChanges { available: true, ..Default::default() } };
    let current = format!("cursor-changes:{}:{}:{limit}:{tag}", chat.id, root.id);
    if version == Some(current.as_str()) {
        return AgentChanges { available: true, version: Some(current), unchanged: true, ..Default::default() };
    }
    AgentChanges::read(current, chat_changes_of(&mut store, &root), false, limit)
}

/// The tab's own chat's changes in `directory`: see [`tab_chat`].
pub fn changes(home: &Path, directory: &str, since: Option<i64>, own: Option<&Recorded>, version: Option<&str>, limit: usize) -> AgentChanges {
    let found = folder_chats_all(home, directory);
    match tab_chat(&found, since, own) {
        Some(chat) => changes_of(chat, &format!("{since:?}:{own:?}"), version, limit),
        None => AgentChanges { available: true, ..Default::default() },
    }
}

/// The changes of the folder's earlier chat `id`.
pub fn chat_changes(home: &Path, directory: &str, id: &str, version: Option<&str>, limit: usize) -> AgentChanges {
    match folder_chat_of(home, directory, id) {
        Some(chat) => changes_of(&chat, "chat", version, limit),
        None => AgentChanges::unavailable("no_transcript"),
    }
}

/// What a Reader of this tab's chat watches: the folder's directory for the
/// next chat (a `/clear`), and the store of the chat it reads, a database and
/// its `-wal`.
pub fn watch_targets(home: &Path, directory: &str, since: Option<i64>, own: Option<&Recorded>) -> Vec<crate::services::transcript_watch::Target> {
    use crate::services::transcript_watch::{Rule, Target};
    let found = folder_chats_all(home, directory);
    let mut targets = Vec::new();
    // Cursor keys the folder as it ran in it: the path as given or its canonical
    // one (a project folder reached through a link).
    let (keys, _) = folder_keys(normal(directory));
    let chats = home.join(".cursor").join("chats");
    for key in keys {
        let root = chats.join(key);
        if root.is_dir() {
            targets.push(Target { dir: root, rule: Rule::Created });
        }
    }
    if let Some(chat) = tab_chat(&found, since, own) {
        let dir = chat.dir.path().to_path_buf();
        if dir.join("store.db").is_file() {
            targets.push(Target { dir, rule: Rule::Prefix("store.db".to_string()) });
        }
    }
    targets
}

/// [`watch_targets`] for the folder's chat `id`, picked in the Resume menu.
pub fn chat_watch_targets(home: &Path, directory: &str, id: &str) -> Vec<crate::services::transcript_watch::Target> {
    use crate::services::transcript_watch::{Rule, Target};
    let Some(chat) = folder_chat_of(home, directory, id) else { return Vec::new() };
    let dir = chat.dir.path().to_path_buf();
    if dir.join("store.db").is_file() { vec![Target { dir, rule: Rule::Prefix("store.db".to_string()) }] } else { Vec::new() }
}

// ── the launch ──────────────────────────────────────────────────────────────

/// Suffix of the host-only launch note beside the tab's record.
const LAUNCH_SUFFIX: &str = ".cursor";

fn launch_note(uid: &str) -> String {
    format!("{uid}{LAUNCH_SUFFIX}")
}

/// Whether the tab `uid` was spawned with the hook registered (its note in
/// `dir`, the shared root no fence or container can write).
fn noted_in(dir: &Path, uid: &str) -> bool {
    is_uuid_shaped(uid)
        && crate::services::home_io::read_record(&dir.join(launch_note(uid)))
            .and_then(|raw| raw.trim().strip_prefix("launch ").map(|at| at.parse::<i64>().is_ok()))
            .unwrap_or(false)
}

fn note_launch_in(dir: &Path, uid: &str) -> std::io::Result<()> {
    crate::services::agent_session::write_live_record(dir, &launch_note(uid), &format!("launch {}", crate::clock::now_ms()))
}

/// Whether the hook has recorded in the scope: its proof in the shared root
/// (a host-run Cursor) or in the scope's own slice (fenced or contained).
fn hook_proven(project_id: Option<&str>) -> bool {
    let slice = project_live_sessions_dir(project_id.unwrap_or(crate::storage::ROOT_SCOPE));
    [live_sessions_dir(), slice].iter().any(|dir| proven_in(dir))
}

fn proven_in(dir: &Path) -> bool {
    std::fs::symlink_metadata(dir.join(hook::PROOF)).is_ok_and(|meta| meta.is_file())
}

/// Resolve a Cursor tab's launch: register the hook in the tab's home, name
/// the tab's agent for it, note the launch, and aim a `--continue` by the rule
/// in this module's head. Remote, local-model and assistant tabs are left as
/// they are.
pub fn resolve(opts: PtyOptions) -> PtyOptions {
    let remote = !opts.local_only
        && opts.project_id.as_deref().is_some_and(|id| crate::services::remote::remote_target_for(id).is_some());
    if remote || opts.local_model || opts.assistant.is_some() || !Path::new(&opts.cwd).is_absolute() {
        return opts;
    }
    let project_id = opts.project_id.clone();
    let home = crate::services::agent_home::scope_home(project_id.as_deref());
    let registered = register_in_home(&home);
    resolve_in(
        opts,
        &home,
        &live_sessions_dir(),
        registered,
        |uid| crate::services::google_chat::recorded_conversation(project_id.as_deref(), uid),
        || hook_proven(project_id.as_deref()),
    )
}

/// Testable core of [`resolve`]: `notes` holds the launch notes, `record`
/// reads a tab's record, `proven` says whether the hook has recorded in the
/// scope.
fn resolve_in(
    mut opts: PtyOptions,
    home: &Path,
    notes: &Path,
    registered: bool,
    record: impl Fn(&str) -> Option<(String, i64)>,
    proven: impl Fn() -> bool,
) -> PtyOptions {
    opts.env.insert(TAB_AGENT_ENV.to_string(), "cursor-agent".to_string());
    let uid = opts.env.get(crate::app_env!("TAB_UID")).filter(|uid| is_uuid_shaped(uid)).cloned();
    // Read before this spawn's own note is written: an earlier spawn's.
    let noted = uid.as_deref().is_some_and(|uid| noted_in(notes, uid));
    if let Some(at) = continue_at(&opts.args) {
        // One listing of the folder serves both the record and the fallback.
        let found = folder_chats_all(home, &opts.cwd);
        let record = uid.as_deref().and_then(&record).map(|(id, at)| Recorded { id, at, noted });
        let own = record.as_ref().and_then(|record| recorded_among(&found, record));
        let fresh = own.is_none() && noted && proven();
        opts.args = resumed_onto(&opts.args, at, own.as_deref(), || !fresh && found.iter().any(|c| c.conversation));
    }
    // Without the hook registered the tab can record nothing, so it is not
    // told apart from a tab from before the hook.
    if let (true, Some(uid)) = (registered, uid.as_deref()) {
        if let Err(e) = note_launch_in(notes, uid) {
            eprintln!("cursor_session: launch note: {e}");
        }
    }
    opts
}

/// Where the restore's `--continue` is in `args`.
fn continue_at(args: &[String]) -> Option<usize> {
    args.iter().position(|arg| arg == "--continue")
}

/// `args` with the `--continue` at `at` aimed at `own`, kept when the folder
/// has a chat, else dropped (`--continue` with none exits).
fn resumed_onto(args: &[String], at: usize, own: Option<&str>, folder_has_one: impl FnOnce() -> bool) -> Vec<String> {
    let mut out = args.to_vec();
    match own {
        Some(id) => {
            out[at] = "--resume".to_string();
            out.insert(at + 1, id.to_string());
        }
        None if folder_has_one() => {}
        None => {
            out.remove(at);
        }
    }
    out
}

#[cfg(test)]
mod tests;
