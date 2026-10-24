//! Gemini and Antigravity's stored conversations. Like OpenCode, these CLIs
//! choose their session ids: read the newest main conversation in the tab's
//! folder, created since launch for a fresh tab. Never read the user's home.
//!
//! Gemini writes JSON (newer versions JSONL with patches/rewinds) under
//! `.gemini/tmp/<project>/chats`. Antigravity (1.3.3–1.4.5) writes SQLite
//! trajectories: `steps.step_payload` is a CortexStep protobuf, not plain
//! text. Its embedded descriptor defines user_input (19).user_response (2),
//! planner_response (20).response (1), and metadata (5).created_at (1). Only
//! these fields are decoded; tool output, thoughts, config and context never
//! become chat.
//!
//! Antigravity has no session hook. The Reader's Resume menu lists a folder's
//! conversations and records the one it takes a tab onto in the tab's
//! live-session record; the tab reads it, and is relaunched with
//! `--conversation <id>`, until it begins another conversation.

use std::io::Read;
use std::path::Path;

use rusqlite::Connection;
use crate::services::agent_sqlite::{Limits, open_read};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::services::agent_chats::FolderChat;
use crate::services::agent_transcript::{AgentTranscript, transcript_entry};
use crate::services::home_io::{HomeDir, HomeFile};
use crate::terminal::PtyOptions;

const MAX_FILES: usize = 512;
const MAX_BYTES: u64 = 64 * 1024 * 1024;
const MAX_STEP_BYTES: usize = 6 * 1024 * 1024;

/// The tab's conversation: the folder's newest main one (begun since `since`
/// when given). Antigravity's `own` is the one the Resume menu took the tab
/// onto and when ([`recorded_conversation`]), read until it begins another.
pub fn transcript(cmd: &str, home: &Path, directory: &str, since: Option<i64>, own: Option<(&str, i64)>, version: Option<&str>, limit: usize) -> AgentTranscript {
    let read = if cmd == "gemini" {
        gemini(home, directory, since, version, limit)
    } else {
        antigravity(home, directory, since, own, version, limit)
    };
    read.unwrap_or_else(|| AgentTranscript::unavailable("no_transcript"))
}

fn bounded_read(file: &HomeFile, cap: u64) -> Option<String> {
    let file = file.open_read()?;
    if file.metadata().ok()?.len() > cap { return None; }
    let mut text = String::new();
    file.take(cap + 1).read_to_string(&mut text).ok()?;
    (text.len() as u64 <= cap).then_some(text)
}

fn epoch(text: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(text).ok().map(|time| time.timestamp_millis())
}

fn key(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

fn stamp(file: &HomeFile) -> Option<String> {
    let meta = file.open_read()?.metadata().ok()?;
    let modified = meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_nanos();
    Some(format!("{}:{modified}", meta.len()))
}

fn empty(version: String, previous: Option<&str>) -> AgentTranscript {
    AgentTranscript { available: true, unchanged: previous == Some(version.as_str()), version: Some(version), ..Default::default() }
}

fn finish(mut read: AgentTranscript, limit: usize) -> AgentTranscript {
    if read.entries.len() > limit {
        read.truncated = true;
        read.entries.drain(..read.entries.len() - limit);
    }
    read
}

fn gemini(home: &Path, directory: &str, since: Option<i64>, version: Option<&str>, limit: usize) -> Option<AgentTranscript> {
    let root = HomeDir::open_existing(home, ".gemini")?;
    let tmp = root.open_subdir("tmp")?;
    let mut directories = vec![directory.to_string()];
    if let Ok(real) = std::fs::canonicalize(directory) {
        let real = real.to_string_lossy().into_owned();
        if !directories.contains(&real) { directories.push(real); }
    }
    let hashes: Vec<String> = directories.iter().map(|dir| format!("{:x}", Sha256::digest(dir.as_bytes()))).collect();
    let mut identifiers = hashes.clone();
    // Recent Gemini releases map project paths to short slugs in this registry.
    if let Some(registry) = root.file("projects.json").and_then(|file| bounded_read(&file, 1024 * 1024))
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok()) {
        for dir in &directories {
            if let Some(slug) = registry.get("projects").and_then(|projects| projects.get(dir)).and_then(Value::as_str) {
                identifiers.push(slug.to_string());
            }
        }
    }
    let mut candidates = Vec::new();
    for identifier in identifiers {
        let Some(chats) = tmp.open_subdir(&identifier).and_then(|dir| dir.open_subdir("chats")) else { continue; };
        for name in chats.names().into_iter().rev().take(MAX_FILES) {
            if !name.ends_with(".json") && !name.ends_with(".jsonl") { continue; }
            let Some(file) = chats.file(&name) else { continue; };
            let Some(meta) = file.open_read().and_then(|file| file.metadata().ok()) else { continue; };
            if meta.len() <= MAX_BYTES { candidates.push((meta.modified().ok(), file, name.ends_with(".jsonl"), format!("{identifier}:{name}"))); }
        }
    }
    candidates.sort_by_key(|candidate| std::cmp::Reverse(candidate.0));
    let mut budget = MAX_BYTES;
    for (_, file, jsonl, name) in candidates.into_iter().take(MAX_FILES) {
        let current = format!("gemini:{}:{}:{since:?}:{limit}", key(&format!("{directory}:{name}")), stamp(&file)?);
        if version == Some(current.as_str()) { return Some(empty(current, version)); }
        let len = file.open_read()?.metadata().ok()?.len();
        budget = budget.checked_sub(len)?;
        let Some(raw) = bounded_read(&file, len) else { continue; };
        let Some(record) = gemini_record(&raw, jsonl) else { continue; };
        if !record.get("projectHash").and_then(Value::as_str).is_some_and(|hash| hashes.iter().any(|known| known == hash))
            || record.get("kind").and_then(Value::as_str) == Some("subagent") { continue; }
        if since.is_some_and(|since| record.get("startTime").and_then(Value::as_str).and_then(epoch).is_none_or(|start| start < since)) { continue; }
        record.get("sessionId")?.as_str()?;
        let mut read = empty(current, version);
        if read.unchanged { return Some(read); }
        for message in record.get("messages")?.as_array()? {
            let role = match message.get("type").and_then(Value::as_str) {
                Some("user") => "prompt",
                // An `error` record is Gemini's own notice (a quota limit, a
                // refused request); `info` and `warning` are chrome.
                Some("gemini" | "error") => "answer",
                _ => continue,
            };
            let content = message.get("displayContent").filter(|value| !value.is_null()).or_else(|| message.get("content"));
            let text = content.map(part_text).unwrap_or_default();
            let at = message.get("timestamp").and_then(Value::as_str).map(str::to_string);
            read.entries.extend(transcript_entry(role, &text, at));
            if role == "answer" {
                if let Some(model) = message.get("model").and_then(Value::as_str) { read.model = Some(model.to_string()); }
            }
        }
        return Some(finish(read, limit));
    }
    Some(empty(format!("gemini:new:{}:{since:?}:{limit}", key(directory)), version))
}

fn part_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts.iter().map(part_text).collect::<Vec<_>>().join(""),
        Value::Object(part) if part.get("thought") != Some(&Value::Bool(true)) => part.get("text").and_then(Value::as_str).unwrap_or("").to_string(),
        _ => String::new(),
    }
}

fn gemini_record(raw: &str, jsonl: bool) -> Option<Value> {
    if !jsonl { return serde_json::from_str(raw).ok(); }
    let mut record = serde_json::Map::new();
    let mut messages: Vec<Value> = Vec::new();
    for line in raw.lines().filter(|line| !line.trim().is_empty()) {
        // A partial last append is retried on the next read; earlier damage
        // must not manufacture a different conversation.
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            if raw.ends_with(line) { break; }
            return None;
        };
        if let Some(rewind) = value.get("$rewindTo").and_then(Value::as_str) {
            messages.truncate(messages.iter().position(|message| message.get("id").and_then(Value::as_str) == Some(rewind)).unwrap_or(0));
        } else if let Some(patch) = value.get("$patch") {
            let updates: Vec<&Value> = std::iter::once(patch).chain(patch.get("updates").and_then(Value::as_array).into_iter().flatten()).collect();
            for update in updates {
                if let (Some(id), Some(content)) = (update.get("id").and_then(Value::as_str), update.get("content")) {
                    if let Some(message) = messages.iter_mut().find(|message| message.get("id").and_then(Value::as_str) == Some(id)) { message["content"] = content.clone(); }
                }
            }
            if let Some(ids) = patch.get("removeIds").and_then(Value::as_array) {
                messages.retain(|message| !ids.contains(&message["id"]));
            }
            if let Some(ids) = patch.get("orderIds").and_then(Value::as_array) {
                let mut ordered = Vec::new();
                for id in ids {
                    if let Some(index) = messages.iter().position(|message| message.get("id") == Some(id)) { ordered.push(messages.remove(index)); }
                }
                messages.extend(ordered);
            }
        } else if value.get("sessionId").is_some() || value.get("$set").is_some() {
            let metadata = value.get("$set").unwrap_or(&value).as_object()?;
            for (key, value) in metadata {
                if key == "messages" { messages = value.as_array()?.clone(); }
                else { record.insert(key.clone(), value.clone()); }
            }
        } else if value.get("id").and_then(Value::as_str).is_some() {
            if let Some(old) = messages.iter_mut().find(|message| message.get("id") == value.get("id")) { *old = value; }
            else { messages.push(value); }
        }
    }
    record.insert("messages".into(), Value::Array(messages));
    Some(Value::Object(record))
}

fn database(file: &HomeFile) -> Option<Connection> {
    let limits = Limits { deadline: std::time::Duration::from_millis(500), max_len: MAX_STEP_BYTES as i32, busy: std::time::Duration::from_millis(100) };
    open_read(file, limits, &["steps", "conversation_summaries"])
}

/// Antigravity's store in an agent home: the conversations' summaries and the
/// folder of their own databases.
struct AgyStore {
    summaries: Connection,
    conversations: HomeDir,
}

fn agy_store(home: &Path) -> Option<AgyStore> {
    // SQLite's NOFOLLOW refuses a link at *any* component of the path, the
    // home's own prefix included (a symlinked /home or temp dir), and the home
    // is Tabtivity's (`home_io` opens its root by name for the same reason):
    // resolved once here, so only a link inside the home is refused.
    #[cfg(unix)]
    let home = &std::fs::canonicalize(home).ok()?;
    let root = HomeDir::open_existing(home, ".gemini/antigravity-cli")?;
    Some(AgyStore { summaries: database(&root.file("conversation_summaries.db")?)?, conversations: root.open_subdir("conversations")? })
}

/// The main conversations Antigravity ran in `directory`, newest first.
fn agy_folder(store: &AgyStore, directory: &str) -> Option<Vec<String>> {
    let canonical = std::fs::canonicalize(directory).ok();
    let mut query = store.summaries.prepare("SELECT conversation_id, workspace_uris FROM conversation_summaries WHERE parent_conversation_id = '' ORDER BY last_modified_time DESC LIMIT 512").ok()?;
    let rows = query.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))).ok()?;
    let mut ids = Vec::new();
    for row in rows {
        let (id, workspaces) = row.ok()?;
        if !crate::services::agent_session::is_uuid_shaped(&id) { continue; }
        let workspaces: Vec<String> = serde_json::from_str(&workspaces).ok()?;
        if workspaces.iter().any(|uri| url::Url::parse(uri).ok().and_then(|uri| uri.to_file_path().ok())
            .is_some_and(|path| path == Path::new(directory) || canonical.as_deref() == Some(path.as_path()))) {
            ids.push(id);
        }
    }
    Some(ids)
}

/// A conversation's database, `None` when it has none (a summary row of a
/// conversation never begun).
fn agy_conversation(store: &AgyStore, id: &str) -> Option<(HomeFile, Connection)> {
    let file = store.conversations.file(&format!("{id}.db"))?;
    let conn = database(&file)?;
    Some((file, conn))
}

/// When the conversation's first prompt went (epoch ms).
fn agy_started(conn: &Connection) -> Option<i64> {
    let first: Vec<u8> = conn.query_row("SELECT step_payload FROM steps WHERE step_type = 14 ORDER BY idx LIMIT 1", [], |row| row.get(0)).ok()?;
    step_time(&first)
}

/// Which of the folder's conversations (`ids`, newest first) the tab reads:
/// the newest one begun since `since` — and since the moment of its `own`
/// record, the conversation the Resume menu last took it onto — else that
/// one. `None`: a tab before its first prompt.
fn agy_tab_conversation(store: &AgyStore, ids: &[String], since: Option<i64>, own: Option<(&str, i64)>) -> Option<String> {
    let own = own.filter(|(id, _)| ids.iter().any(|known| known == id));
    let since = match own {
        Some((_, at)) => Some(since.map_or(at, |since| since.max(at))),
        None => since,
    };
    ids.iter()
        .find(|id| {
            let Some((_, conn)) = agy_conversation(store, id) else { return false };
            since.is_none_or(|since| agy_started(&conn).is_some_and(|start| start >= since))
        })
        .cloned()
        .or_else(|| own.map(|(id, _)| id.to_string()))
}

fn antigravity(home: &Path, directory: &str, since: Option<i64>, own: Option<(&str, i64)>, version: Option<&str>, limit: usize) -> Option<AgentTranscript> {
    let store = agy_store(home)?;
    let ids = agy_folder(&store, directory)?;
    match agy_tab_conversation(&store, &ids, since, own) {
        Some(id) => agy_read(&store, &id, &format!("{since:?}:{own:?}"), version, limit),
        None => Some(empty(format!("agy:new:{}:{since:?}:{limit}", key(directory)), version)),
    }
}

/// The conversation `id`'s prompts and answers; `salt` is what else the
/// read went by, part of its version.
fn agy_read(store: &AgyStore, id: &str, salt: &str, version: Option<&str>, limit: usize) -> Option<AgentTranscript> {
    let (file, conn) = agy_conversation(store, id)?;
    let mut current = format!("agy:{id}:{}:{}:{limit}", stamp(&file)?, key(salt));
    // SQLite can keep new turns only in the WAL until a checkpoint.
    if let Some(wal) = store.conversations.file(&format!("{id}.db-wal")).and_then(|file| stamp(&file)) {
        current.push_str(&format!(":{wal}"));
    }
    let mut read = empty(current, version);
    if read.unchanged { return Some(read); }
    let mut query = conn.prepare("SELECT step_type, step_payload FROM steps WHERE step_type IN (14, 15) AND status = 3 ORDER BY idx DESC LIMIT ?1").ok()?;
    let rows = query.query_map([4001], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))).ok()?;
    let mut budget = MAX_BYTES as usize;
    for (index, row) in rows.enumerate() {
        let (kind, payload) = row.ok()?;
        if index == 4000 || payload.len() > budget { read.truncated = true; break; }
        budget -= payload.len();
        let role = if kind == 14 { "prompt" } else { "answer" };
        read.entries.extend(transcript_entry(role, step_text(kind, &payload).unwrap_or(""), step_time(&payload).map(crate::services::prompt_blame::epoch_ms_to_iso)));
    }
    read.entries.reverse();
    Some(finish(read, limit))
}

/// A user input's (14) or planner response's (15) text.
fn step_text(kind: i64, payload: &[u8]) -> Option<&str> {
    let message = proto_bytes(payload, if kind == 14 { 19 } else { 20 })?;
    proto_bytes(message, if kind == 14 { 2 } else { 1 }).and_then(|text| std::str::from_utf8(text).ok())
}

/// The earlier conversation `id` of `directory`, picked in the Reader's
/// Resume menu (`services::agent_chats`): `no_transcript` unless it is one of
/// the folder's.
pub fn antigravity_chat(home: &Path, directory: &str, id: &str, version: Option<&str>, limit: usize) -> AgentTranscript {
    let read = agy_store(home).and_then(|store| {
        agy_folder(&store, directory)?.iter().any(|known| known == id).then_some(())?;
        agy_read(&store, id, "chat", version, limit)
    });
    read.unwrap_or_else(|| AgentTranscript::unavailable("no_transcript"))
}

/// Whether `id` is one of the main conversations Antigravity ran in `directory`.
pub fn antigravity_folder_chat(home: &Path, directory: &str, id: &str) -> bool {
    agy_store(home).and_then(|store| agy_folder(&store, directory)).is_some_and(|ids| ids.iter().any(|known| known == id))
}

/// The folder's chats for the Resume menu, as `opencode_store::folder_chats`
/// lists OpenCode's: from the `offset`-th conversation on, at most `limit`
/// that a prompt went into, of at most `scanned` read.
pub fn antigravity_chats(home: &Path, directory: &str, offset: usize, limit: usize, scanned: usize) -> Option<(Vec<FolderChat>, Option<usize>)> {
    let store = agy_store(home)?;
    let ids = agy_folder(&store, directory)?;
    let mut chats = Vec::new();
    let mut at = offset;
    while at < ids.len() && chats.len() < limit && at - offset < scanned {
        let id = &ids[at];
        at += 1;
        let Some((file, conn)) = agy_conversation(&store, id) else { continue };
        let prompt = |order: &str| -> Option<(String, Option<i64>)> {
            let payload: Vec<u8> = conn.query_row(&format!("SELECT step_payload FROM steps WHERE step_type = 14 AND status = 3 ORDER BY idx {order} LIMIT 1"), [], |row| row.get(0)).ok()?;
            let text = step_text(14, &payload)?.to_string();
            (!text.trim().is_empty()).then(|| (text, step_time(&payload)))
        };
        let Some((title, started)) = prompt("ASC") else { continue };
        let last = prompt("DESC").map(|(text, _)| text).filter(|text| *text != title);
        let modified = |file: &HomeFile| file.open_read().and_then(|file| file.metadata().ok()?.modified().ok());
        let updated = [Some(file), store.conversations.file(&format!("{id}.db-wal"))].iter().flatten()
            .filter_map(modified).max()
            .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |at| at.as_millis() as u64);
        chats.push(FolderChat { id: id.clone(), title, last, started: started.map(crate::services::prompt_blame::epoch_ms_to_iso), updated });
    }
    Some((chats, (at < ids.len()).then_some(at)))
}

/// The conversation the Resume menu last took the Antigravity tab `uid` onto
/// (`agent_session::resume_chat_plan`), and when: its live-session record,
/// which no hook of Antigravity's writes.
pub fn recorded_conversation(project_id: Option<&str>, uid: &str) -> Option<(String, i64)> {
    use crate::services::agent_session::{is_uuid_shaped, live_record_dir, read_live_session_in};
    let dir = live_record_dir(project_id, uid)?;
    let id = read_live_session_in(&dir, uid).filter(|id| is_uuid_shaped(id))?;
    let at = std::fs::metadata(dir.join(uid)).ok()?.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some((id, i64::try_from(at.as_millis()).ok()?))
}

/// The conversation the tab `uid` in `directory` is in by its record — the
/// one the Resume menu took it onto, while it began none since — for the
/// menu's This chat mark and the next launch.
pub fn recorded_tab_conversation(home: &Path, directory: &str, project_id: Option<&str>, uid: &str) -> Option<String> {
    let (own, at) = recorded_conversation(project_id, uid)?;
    let store = agy_store(home)?;
    let ids = agy_folder(&store, directory)?;
    agy_tab_conversation(&store, &ids, None, Some((&own, at))).filter(|id| *id == own)
}

/// Resolve an Antigravity tab's launch: one restored on `--continue` (the
/// most recent conversation) goes back with `--conversation <id>` to the one
/// the Resume menu took it onto, while it began none since. Remote and
/// local-model tabs are left as they are.
pub fn resolve(mut opts: PtyOptions) -> PtyOptions {
    let remote = !opts.local_only
        && opts.project_id.as_deref().is_some_and(|id| crate::services::remote::remote_target_for(id).is_some());
    if remote || opts.local_model || !opts.args.iter().any(|arg| arg == "--continue" || arg == "-c") {
        return opts;
    }
    let Some(uid) = opts.env.get(crate::app_env!("TAB_UID")).cloned() else { return opts };
    if !Path::new(&opts.cwd).is_absolute() { return opts; }
    let home = crate::services::agent_home::scope_home(opts.project_id.as_deref());
    let Some(id) = recorded_tab_conversation(&home, &opts.cwd, opts.project_id.as_deref(), &uid) else { return opts };
    opts.args = continued_onto(&opts.args, &id);
    opts
}

/// `args` with `--continue`/`-c` replaced by `--conversation <id>`.
fn continued_onto(args: &[String], id: &str) -> Vec<String> {
    let mut out: Vec<String> = args.iter().filter(|arg| *arg != "--continue" && *arg != "-c").cloned().collect();
    out.push("--conversation".into());
    out.push(id.into());
    out
}

fn step_time(payload: &[u8]) -> Option<i64> {
    let timestamp = proto_bytes(proto_bytes(payload, 5)?, 1)?;
    let seconds = proto_uint(timestamp, 1)?;
    let nanos = proto_uint(timestamp, 2).unwrap_or(0);
    i64::try_from(seconds).ok()?.checked_mul(1000)?.checked_add(i64::try_from(nanos / 1_000_000).ok()?)
}

/// Bounded protobuf wire reader: no recursion, allocations, or guesses at
/// text in unrelated fields. Unknown scalar/byte fields are skipped.
fn varint(bytes: &mut &[u8]) -> Option<u64> {
    let mut value = 0;
    for shift in (0..70).step_by(7) {
        let (&byte, rest) = bytes.split_first()?;
        *bytes = rest;
        if shift == 63 && byte > 1 { return None; }
        value |= u64::from(byte & 127) << shift;
        if byte < 128 { return Some(value); }
    }
    None
}

fn proto_field(mut bytes: &[u8], wanted: u64) -> Option<(u64, &[u8])> {
    while !bytes.is_empty() {
        let key = varint(&mut bytes)?;
        if key >> 3 == 0 { return None; }
        let (number, wire) = (key >> 3, key & 7);
        let scalar = bytes;
        let length = match wire {
            0 => { varint(&mut bytes)?; scalar.len() - bytes.len() },
            1 => 8,
            2 => usize::try_from(varint(&mut bytes)?).ok()?,
            5 => 4,
            _ => return None,
        };
        let value = if wire == 0 { scalar.get(..length)? } else { bytes.get(..length)? };
        if number == wanted { return Some((wire, value)); }
        if wire != 0 { bytes = bytes.get(length..)?; }
    }
    None
}

fn proto_bytes(bytes: &[u8], field: u64) -> Option<&[u8]> {
    let (wire, value) = proto_field(bytes, field)?;
    (wire == 2).then_some(value)
}

fn proto_uint(bytes: &[u8], field: u64) -> Option<u64> {
    let (wire, mut value) = proto_field(bytes, field)?;
    if wire != 0 { return None; }
    varint(&mut value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn texts(read: &AgentTranscript) -> Vec<(&str, &str)> {
        read.entries.iter().map(|entry| (entry.kind.as_str(), entry.text.as_str())).collect()
    }

    fn gemini_file(home: &Path, directory: &str, name: &str, record: Value) {
        let hash = format!("{:x}", Sha256::digest(directory.as_bytes()));
        let chats = home.join(".gemini").join("tmp").join(&hash).join("chats");
        std::fs::create_dir_all(&chats).unwrap();
        std::fs::write(chats.join(name), serde_json::to_vec(&record).unwrap()).unwrap();
    }

    #[test]
    fn gemini_reads_messages_with_times_and_model_and_excludes_tools_and_thoughts() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("project");
        let directory = dir.to_str().unwrap();
        gemini_file(home.path(), directory, "session-one.json", json!({
            "sessionId": "session-one", "projectHash": format!("{:x}", Sha256::digest(directory.as_bytes())),
            "startTime": "2026-10-15T12:00:00Z", "messages": [
                {"type": "user", "timestamp": "2026-10-15T12:00:00Z", "content": "expanded private context", "displayContent": [{"text": "fix it"}]},
                {"type": "gemini", "timestamp": "2026-10-15T12:00:01Z", "model": "gemini-test", "content": [{"thought": true, "text": "private reasoning"}, {"text": "Fixed."}, {"functionCall": {"name": "read_file"}}], "toolCalls": [{"result": "tool output"}]},
                {"type": "info", "content": "startup logo"},
                {"type": "error", "timestamp": "2026-10-15T12:00:02Z", "content": "You have exhausted your capacity on this model."}
            ]
        }));
        let read = transcript("gemini", home.path(), directory, None, None, None, 60);
        assert!(read.available);
        assert_eq!(texts(&read), [("prompt", "fix it"), ("answer", "Fixed."), ("answer", "You have exhausted your capacity on this model.")]);
        assert_eq!(read.entries[0].at.as_deref(), Some("2026-10-15T12:00:00Z"));
        assert_eq!(read.model.as_deref(), Some("gemini-test"));
        assert!(!read.version.as_deref().unwrap().contains(directory));
        assert!(transcript("gemini", home.path(), directory, None, None, read.version.as_deref(), 60).unchanged);
        let tail = transcript("gemini", home.path(), directory, None, None, read.version.as_deref(), 1);
        assert!(!tail.unchanged);
        assert!(tail.truncated);
        assert_eq!(texts(&tail), [("answer", "You have exhausted your capacity on this model.")]);
        let fresh = transcript("gemini", home.path(), directory, Some(epoch("2026-10-15T13:00:00Z").unwrap()), None, None, 60);
        assert!(fresh.available && fresh.entries.is_empty());
        assert!(transcript("gemini", home.path(), home.path().to_str().unwrap(), None, None, None, 60).entries.is_empty());
    }

    #[test]
    fn gemini_reads_a_jsonl_session_from_the_project_slug_registry() {
        let home = tempfile::tempdir().unwrap();
        let directory = home.path().to_str().unwrap();
        let gemini = home.path().join(".gemini");
        let chats = gemini.join("tmp").join("project-slug").join("chats");
        std::fs::create_dir_all(&chats).unwrap();
        std::fs::write(gemini.join("projects.json"), json!({"projects": {directory: "project-slug"}}).to_string()).unwrap();
        let metadata = json!({"sessionId": "one", "projectHash": key(directory), "startTime": "2026-10-15T12:00:00Z"});
        let prompt = json!({"id": "p", "type": "user", "content": "fix it"});
        let answer = json!({"id": "a", "type": "gemini", "content": "Partial"});
        let patch = json!({"$patch": {"id": "a", "content": "Fixed."}});
        std::fs::write(chats.join("session-one.jsonl"), format!("{metadata}\n{prompt}\n{answer}\n{patch}\n")).unwrap();
        let read = transcript("gemini", home.path(), directory, None, None, None, 60);
        assert!(read.available);
        assert_eq!(texts(&read), [("prompt", "fix it"), ("answer", "Fixed.")]);
        assert!(!read.version.as_deref().unwrap().contains(directory));
    }

    #[test]
    fn gemini_replays_jsonl_patches_removals_order_and_rewinds() {
        let raw = [
            json!({"sessionId": "one", "projectHash": "hash", "startTime": "2026-10-15T12:00:00Z"}),
            json!({"id": "p", "type": "user", "content": "fix it"}),
            json!({"id": "a", "type": "gemini", "content": "Partial"}),
            json!({"$patch": {"updates": [{"id": "a", "content": "Complete"}]}}),
            json!({"id": "remove", "type": "gemini", "content": "discard"}),
            json!({"$patch": {"removeIds": ["remove"], "orderIds": ["a", "p"]}}),
            json!({"$rewindTo": "p"}),
            json!({"$set": {"lastUpdated": "2026-10-15T12:00:02Z"}}),
        ].iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
        let parsed = gemini_record(&(raw + "\n{\"partial\":"), true).unwrap();
        assert_eq!(parsed["messages"], json!([{"id": "a", "type": "gemini", "content": "Complete"}]));
        assert_eq!(parsed["lastUpdated"], "2026-10-15T12:00:02Z");
        assert!(gemini_record("{broken}\n{}\n", true).is_none());
    }

    fn uint(mut value: u64) -> Vec<u8> {
        let mut bytes = Vec::new();
        while value >= 128 { bytes.push((value as u8 & 127) | 128); value >>= 7; }
        bytes.push(value as u8);
        bytes
    }

    fn bytes(field: u64, value: &[u8]) -> Vec<u8> {
        [uint(field << 3 | 2), uint(value.len() as u64), value.to_vec()].concat()
    }

    fn step(kind: u64, text: &str, seconds: u64) -> Vec<u8> {
        let timestamp = [uint(8), uint(seconds)].concat();
        let metadata = bytes(1, &timestamp);
        let message = bytes(if kind == 14 { 2 } else { 1 }, text.as_bytes());
        [uint(8), uint(kind), bytes(5, &metadata), bytes(if kind == 14 { 19 } else { 20 }, &message)].concat()
    }

    fn agy_db(home: &Path, directory: &str) -> (Connection, Connection) {
        let root = home.join(".gemini").join("antigravity-cli");
        let conversations = root.join("conversations");
        std::fs::create_dir_all(&conversations).unwrap();
        let summaries = Connection::open(root.join("conversation_summaries.db")).unwrap();
        summaries.execute_batch("CREATE TABLE conversation_summaries (conversation_id TEXT, workspace_uris TEXT, last_modified_time TEXT, parent_conversation_id TEXT)").unwrap();
        summaries.execute("INSERT INTO conversation_summaries VALUES (?1, ?2, '2026-10-15', '')", rusqlite::params![
            "01234567-1234-1234-1234-0123456789ab",
            serde_json::to_string(&[url::Url::from_directory_path(directory).unwrap().to_string()]).unwrap()
        ]).unwrap();
        let conn = Connection::open(conversations.join("01234567-1234-1234-1234-0123456789ab.db")).unwrap();
        conn.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB)").unwrap();
        (summaries, conn)
    }

    fn insert(conn: &Connection, index: i64, kind: u64, status: i64, text: &str) {
        conn.execute("INSERT INTO steps VALUES (?1, ?2, ?3, ?4)", rusqlite::params![index, kind as i64, status, step(kind, text, 1_791_979_200 + index as u64)]).unwrap();
    }

    #[test]
    fn antigravity_reads_protobuf_messages_and_wal_updates_and_honours_folder_and_launch() {
        let home = tempfile::tempdir().unwrap();
        let directory = home.path().to_str().unwrap();
        let (_summaries, conn) = agy_db(home.path(), directory);
        insert(&conn, 0, 14, 3, "fix it");
        insert(&conn, 1, 15, 3, "Fixed.");
        insert(&conn, 2, 132, 3, "tool output");
        insert(&conn, 3, 15, 1, "partial answer");
        let read = transcript("agy", home.path(), directory, None, None, None, 60);
        assert!(read.available);
        assert_eq!(texts(&read), [("prompt", "fix it"), ("answer", "Fixed.")]);
        assert!(read.entries.iter().all(|entry| entry.at.is_some()));
        assert!(transcript("agy", home.path(), directory, None, None, read.version.as_deref(), 60).unchanged);
        conn.execute("UPDATE steps SET status = 3 WHERE idx = 3", []).unwrap();
        let updated = transcript("agy", home.path(), directory, None, None, read.version.as_deref(), 60);
        assert!(!updated.unchanged);
        assert_eq!(updated.entries.last().unwrap().text, "partial answer");
        let fresh = transcript("agy", home.path(), directory, Some(1_791_979_201_000), None, None, 60);
        assert!(fresh.available && fresh.entries.is_empty());
        let other = home.path().join("other");
        assert!(transcript("agy", home.path(), other.to_str().unwrap(), None, None, None, 60).entries.is_empty());
        let tail = transcript("agy", home.path(), directory, None, None, updated.version.as_deref(), 1);
        assert!(tail.truncated);
        assert_eq!(texts(&tail), [("answer", "partial answer")]);
    }

    /// A second conversation of `directory`, modified after the fixture's.
    fn agy_second(home: &Path, summaries: &Connection, directory: &str, id: &str) -> Connection {
        summaries.execute("INSERT INTO conversation_summaries VALUES (?1, ?2, '2026-10-16', '')", rusqlite::params![
            id, serde_json::to_string(&[url::Url::from_directory_path(directory).unwrap().to_string()]).unwrap()
        ]).unwrap();
        let conn = Connection::open(home.join(".gemini").join("antigravity-cli").join("conversations").join(format!("{id}.db"))).unwrap();
        conn.execute_batch("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB)").unwrap();
        conn
    }

    #[test]
    fn antigravity_lists_the_folders_conversations_and_reads_one_by_id() {
        const OLD: &str = "01234567-1234-1234-1234-0123456789ab";
        const NEW: &str = "11234567-1234-1234-1234-0123456789ab";
        let home = tempfile::tempdir().unwrap();
        let directory = home.path().to_str().unwrap();
        let (summaries, conn) = agy_db(home.path(), directory);
        insert(&conn, 0, 14, 3, "fix it");
        insert(&conn, 1, 15, 3, "Fixed.");
        insert(&conn, 2, 14, 3, "and the tests");
        let second = agy_second(home.path(), &summaries, directory, NEW);
        insert(&second, 10, 14, 3, "new question");
        // A summary of a conversation never begun has no database: skipped.
        summaries.execute("INSERT INTO conversation_summaries VALUES ('21234567-1234-1234-1234-0123456789ab', ?1, '2026-10-17', '')", rusqlite::params![
            serde_json::to_string(&[url::Url::from_directory_path(directory).unwrap().to_string()]).unwrap()
        ]).unwrap();
        let (chats, next) = antigravity_chats(home.path(), directory, 0, 10, 10).unwrap();
        let rows: Vec<_> = chats.iter().map(|c| (c.id.as_str(), c.title.as_str(), c.last.as_deref())).collect();
        assert_eq!(rows, [(NEW, "new question", None), (OLD, "fix it", Some("and the tests"))]);
        assert_eq!(next, None);
        assert!(chats.iter().all(|chat| chat.started.is_some() && chat.updated > 0));
        let (page, next) = antigravity_chats(home.path(), directory, 0, 1, 10).unwrap();
        assert_eq!((page.len(), next), (1, Some(2)));
        assert!(antigravity_folder_chat(home.path(), directory, OLD));
        assert!(!antigravity_folder_chat(home.path(), home.path().join("other").to_str().unwrap(), OLD));
        let read = antigravity_chat(home.path(), directory, OLD, None, 60);
        assert_eq!(texts(&read), [("prompt", "fix it"), ("answer", "Fixed."), ("prompt", "and the tests")]);
        assert!(antigravity_chat(home.path(), directory, OLD, read.version.as_deref(), 60).unchanged);
        assert_eq!(antigravity_chat(home.path(), home.path().join("other").to_str().unwrap(), OLD, None, 60).reason.as_deref(), Some("no_transcript"));
    }

    #[test]
    fn a_resumed_tab_reads_its_recorded_conversation_until_it_begins_another() {
        const OLD: &str = "01234567-1234-1234-1234-0123456789ab";
        const NEW: &str = "11234567-1234-1234-1234-0123456789ab";
        let home = tempfile::tempdir().unwrap();
        let directory = home.path().to_str().unwrap();
        let (summaries, conn) = agy_db(home.path(), directory);
        insert(&conn, 0, 14, 3, "old question");
        let second = agy_second(home.path(), &summaries, directory, NEW);
        insert(&second, 10, 14, 3, "new question");
        let recorded = 1_791_979_212_000;
        // The newer conversation began before the record: the recorded one is the tab's.
        let read = transcript("agy", home.path(), directory, None, Some((OLD, recorded)), None, 60);
        assert_eq!(texts(&read), [("prompt", "old question")]);
        let store = agy_store(home.path()).unwrap();
        let ids = agy_folder(&store, directory).unwrap();
        assert_eq!(agy_tab_conversation(&store, &ids, None, Some((OLD, recorded))).as_deref(), Some(OLD));
        // One begun since the record (a /new in the tab) takes over.
        assert_eq!(agy_tab_conversation(&store, &ids, None, Some((OLD, 1_791_979_209_000))).as_deref(), Some(NEW));
        // A record naming no conversation of the folder is no record.
        assert_eq!(agy_tab_conversation(&store, &ids, None, Some(("31234567-1234-1234-1234-0123456789ab", recorded))).as_deref(), Some(NEW));
        assert_eq!(agy_tab_conversation(&store, &ids, Some(1_791_979_211_000), None), None);
    }

    #[test]
    fn continuing_a_recorded_conversation_names_it() {
        let args = |list: &[&str]| list.iter().map(|arg| arg.to_string()).collect::<Vec<_>>();
        assert_eq!(continued_onto(&args(&["--model", "m", "--continue"]), "id"), args(&["--model", "m", "--conversation", "id"]));
        assert_eq!(continued_onto(&args(&["-c"]), "id"), args(&["--conversation", "id"]));
    }

    #[test]
    fn malformed_protobuf_never_reads_unrelated_fields_or_panics() {
        for payload in [&[][..], &[0], &[0xff; 20], &[10, 255], &[11, 0], &[10, 10, 1]] {
            assert!(proto_bytes(payload, 1).is_none());
            assert!(step_time(payload).is_none());
        }
        assert_eq!(proto_bytes(&bytes(3, b"private thinking"), 1), None);
    }

    #[cfg(unix)]
    #[test]
    fn gemini_does_not_follow_a_session_symlink() {
        let home = tempfile::tempdir().unwrap();
        let directory = home.path().to_str().unwrap();
        gemini_file(home.path(), directory, "session-one.json", json!({}));
        let hash = format!("{:x}", Sha256::digest(directory.as_bytes()));
        let path = home.path().join(".gemini").join("tmp").join(hash).join("chats").join("session-one.json");
        std::fs::remove_file(&path).unwrap();
        let outside = home.path().join("outside.json");
        std::fs::write(&outside, "private data").unwrap();
        std::os::unix::fs::symlink(outside, path).unwrap();
        let read = transcript("gemini", home.path(), directory, None, None, None, 60);
        assert!(read.available && read.entries.is_empty());
    }
}
