//! The files an agent tab's conversation changed, as diffs — the desktop
//! Reader's Changes panel, beside the chat rather than in it.
//!
//! Every CLI the Reader reads records its edits in the same store as the
//! conversation, each with the diff it applied, so nothing is recomputed and
//! nothing on disk is read but that store:
//!
//! - Claude: the `toolUseResult` of an `Edit`/`MultiEdit`/`Write` call — the
//!   hunks it applied (`structuredPatch`, with line numbers), or a new file's
//!   whole `content` (`type: "create"`). A call turned down or failed has no
//!   such result, so only edits that landed are listed.
//! - Codex: the `FileChange` items of its `item_completed` events — per path,
//!   an `update` with its `unified_diff` (and `move_path`), or an `add` or
//!   `delete` with the file's content. A change not `completed` is left out.
//! - OpenCode: the completed `edit`, `multiedit`, `write` and `apply_patch`
//!   tool parts of the session (`services::opencode_store`) — the diff each
//!   puts in its metadata, or a written file's content.
//! - Copilot: the `tool.execution_complete` events whose `fileEdits` name what
//!   a built-in editing tool (`edit`, `create`, GPT models' `apply_patch`)
//!   committed — the git-style diff in `result.detailedContent`, one section
//!   per file in `fileEdits` order. A call that failed lists nothing.
//!
//! A diff is file content: it reaches the phone only through
//! `mobile_control::chat_changes`, behind the "Project files on the phone"
//! switch, its paths made checkout-relative. Read for the conversation on screen — the session's, or one subagent's —
//! resolved the way the Reader resolves it (`agent_transcript`).

use std::fmt::Write as _;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::services::agent_transcript;

/// How many changes an answer carries by default, and at most: the newest.
pub const DEFAULT_LIMIT: usize = 200;
const MAX_LIMIT: usize = 1000;
/// How much of a transcript's end is read, as the Reader reads it.
const TAIL_BYTES: u64 = 6 * 1024 * 1024;
/// Longest diff of one change; a longer one is cut at a line.
const MAX_DIFF_CHARS: usize = 200_000;

/// One file one call changed.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    /// The file, as the agent named it (absolute for every CLI read here).
    pub path: String,
    /// `edit` (hunks of an existing file), `add` (a new file, every line
    /// added), `delete` (every line removed) or `write` (an existing file
    /// written whole, its old content not recorded — every line shown added).
    pub kind: String,
    /// The change as unified-diff hunks, each opened by its `@@` line; line
    /// numbers only where the CLI recorded them.
    pub diff: String,
    pub added: u32,
    pub removed: u32,
    /// When the change was recorded (RFC 3339).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
    /// The diff was cut at its bound; `added`/`removed` still count it whole.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub cut: bool,
    /// Where the file was moved to, when the change renamed it (Codex).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub moved_to: Option<String>,
}

/// What `agent_tab_changes` answers: always a value, never an error.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentChanges {
    pub available: bool,
    /// Why not: `unsupported`, `no_session`, `no_subagent`, `read_failed`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Fingerprint of what the changes came from — passed back, it is
    /// answered `unchanged` while that has not moved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub unchanged: bool,
    /// Oldest first.
    #[serde(default)]
    pub changes: Vec<FileChange>,
    /// Earlier changes exist that this answer does not carry.
    #[serde(default)]
    pub truncated: bool,
    /// Armed on a watch, as `AgentTranscript::watched`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub watched: bool,
}

impl AgentChanges {
    pub fn unavailable(reason: &str) -> Self {
        Self {
            available: false,
            reason: Some(reason.to_string()),
            ..Default::default()
        }
    }

    fn unchanged(version: String) -> Self {
        Self {
            available: true,
            version: Some(version),
            unchanged: true,
            ..Default::default()
        }
    }

    /// A conversation with nothing recorded yet: available, no changes.
    fn empty() -> Self {
        Self {
            available: true,
            ..Default::default()
        }
    }

    pub(crate) fn read(version: String, mut changes: Vec<FileChange>, mut truncated: bool, limit: usize) -> Self {
        let limit = limit.clamp(1, MAX_LIMIT);
        if changes.len() > limit {
            changes.drain(..changes.len() - limit);
            truncated = true;
        }
        Self {
            available: true,
            reason: None,
            version: Some(version),
            unchanged: false,
            changes,
            truncated,
            watched: false,
        }
    }
}

/// The changes of the conversation the tab launched as `cmd` with launch id
/// `launch_id` holds — or, with `subagent`, of that subagent's own — the
/// arguments `agent_transcript::agent_session_transcript` takes.
#[allow(clippy::too_many_arguments)]
pub fn agent_session_changes(
    cmd: &str,
    project_id: Option<&str>,
    tab_dir: Option<&str>,
    since: Option<i64>,
    launch_id: &str,
    subagent: Option<&str>,
    version: Option<&str>,
    limit: usize,
) -> AgentChanges {
    if subagent.is_some_and(|token| !agent_transcript::is_subagent_token(token)) {
        return AgentChanges::unavailable("no_subagent");
    }
    if cmd == "opencode" {
        let db = crate::services::opencode_store::db_path_for(project_id);
        let (own, since) = crate::services::opencode_session::reader_session(project_id, Some(launch_id), since);
        return opencode_changes(&db, project_id, tab_dir, since, own.as_deref(), subagent, version, limit);
    }
    let kind = match cmd {
        "claude" => Store::Claude,
        "codex" => Store::Codex,
        "copilot" if copilot_is_remote(project_id) => return AgentChanges::unavailable("unsupported"),
        "copilot" => Store::Copilot,
        _ => return AgentChanges::unavailable("unsupported"),
    };
    match agent_transcript::conversation_file(cmd, project_id, launch_id, subagent) {
        Some(path) => read_changes(&path, kind, version, limit).unwrap_or_else(|| AgentChanges::unavailable("read_failed")),
        None if subagent.is_some() => AgentChanges::unavailable("no_subagent"),
        // Nothing written yet — a session before its first turn.
        None => AgentChanges::empty(),
    }
}

/// The changes of `chat`, an earlier conversation of the tab's folder picked
/// in the Reader's Resume menu — or of its `subagent` — as
/// [`agent_session_changes`] reads the tab's own.
#[allow(clippy::too_many_arguments)]
pub fn stored_chat_changes(
    cmd: &str,
    project_id: Option<&str>,
    tab_dir: Option<&str>,
    launch_id: &str,
    chat: &str,
    subagent: Option<&str>,
    version: Option<&str>,
    limit: usize,
) -> AgentChanges {
    if subagent.is_some_and(|token| !agent_transcript::is_subagent_token(token)) {
        return AgentChanges::unavailable("no_subagent");
    }
    if cmd == "opencode" {
        if !crate::services::agent_chats::is_folder_chat(cmd, project_id, tab_dir, launch_id, chat) {
            return AgentChanges::unavailable("no_transcript");
        }
        let db = crate::services::opencode_store::db_path_for(project_id);
        return opencode_changes(&db, project_id, tab_dir, None, Some(chat), subagent, version, limit);
    }
    let kind = match cmd {
        "claude" => Store::Claude,
        "codex" => Store::Codex,
        "copilot" => Store::Copilot,
        _ => return AgentChanges::unavailable("unsupported"),
    };
    match agent_transcript::stored_chat_file(cmd, project_id, tab_dir, launch_id, chat, subagent) {
        Some(path) => read_changes(&path, kind, version, limit).unwrap_or_else(|| AgentChanges::unavailable("read_failed")),
        None if subagent.is_some() => AgentChanges::unavailable("no_subagent"),
        None => AgentChanges::unavailable("no_transcript"),
    }
}

/// A local-model OpenCode tab's changes (`ollama launch opencode`): what
/// [`agent_session_changes`] answers for `opencode`, read from the scope's
/// local-model home, where the Reader reads that tab's conversation
/// (`agent_transcript::local_opencode_transcript`).
pub fn local_opencode_changes(
    project_id: Option<&str>,
    tab_dir: Option<&str>,
    since: Option<i64>,
    subagent: Option<&str>,
    version: Option<&str>,
    limit: usize,
) -> AgentChanges {
    if subagent.is_some_and(|token| !agent_transcript::is_subagent_token(token)) {
        return AgentChanges::unavailable("no_subagent");
    }
    let db = crate::services::opencode_store::local_model_db_path_for(project_id);
    opencode_changes(&db, project_id, tab_dir, since, None, subagent, version, limit)
}

/// Every file a tab's conversation changed, by the path its CLI named — the
/// phone's "not committed yet" count (`mobile_control::chat_uncommitted`)
/// checks these against `git status`. Unlike the Changes panel this reads
/// the whole transcript, not the Reader's tail, and a Claude session's
/// subagents' files with it; no diff is kept. `None` for a CLI whose edits
/// are not read here; an empty list for a session before its first edit.
/// What the agent changed through a shell command is not in any of these
/// records, so the list is a floor, never the whole tree's changes.
pub fn changed_paths(
    cmd: &str,
    project_id: Option<&str>,
    tab_dir: Option<&str>,
    since: Option<i64>,
    launch_id: Option<&str>,
    local_model: bool,
) -> Option<Vec<String>> {
    if cmd == "opencode" {
        let read = if local_model {
            local_opencode_changes(project_id, tab_dir, since, None, None, MAX_LIMIT)
        } else {
            agent_session_changes(cmd, project_id, tab_dir, since, launch_id.unwrap_or(""), None, None, MAX_LIMIT)
        };
        return read.available.then(|| paths_of(&read.changes).into_iter().collect());
    }
    let kind = match cmd {
        "claude" => Store::Claude,
        "codex" => Store::Codex,
        _ => return None,
    };
    if local_model {
        return None;
    }
    let Some(main) = launch_id.and_then(|id| agent_transcript::conversation_file(cmd, project_id, id, None)) else {
        // Nothing written yet — a session before its first turn.
        return Some(Vec::new());
    };
    let mut files = vec![main.clone()];
    if kind == Store::Claude {
        files.extend(claude_subagent_files(&main.with_extension("").join("subagents")));
    }
    let mut paths = std::collections::BTreeSet::new();
    for file in &files {
        paths.extend(scan_paths(file, kind)?);
    }
    Some(paths.into_iter().collect())
}

/// The most of one transcript [`scan_paths`] reads in one go: a longer file,
/// or a longer stretch appended since the last scan, is read from that far
/// before its end.
const MAX_SCAN_BYTES: u64 = 64 * 1024 * 1024;
/// How many subagent files of one session are read.
const MAX_SUBAGENT_FILES: usize = 200;
/// How many transcripts' scans are kept between reads.
const MAX_SCANNED: usize = 256;

/// Each transcript's scan so far: how far it was read (to the end of its last
/// whole line), and the files the changes up to there named.
#[derive(Clone, Default)]
struct Scanned {
    read_to: u64,
    paths: std::collections::BTreeSet<String>,
}

static SCANNED: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, Scanned>>> =
    std::sync::LazyLock::new(Default::default);

/// The files the transcript at `path` records a change to. A transcript only
/// grows, so each read goes on from where the last stopped; one that is
/// shorter than that was replaced and is read anew. `None` when it cannot be
/// read.
fn scan_paths(path: &Path, kind: Store) -> Option<std::collections::BTreeSet<String>> {
    use app_core::sync::LockExt;
    use std::io::{Read, Seek, SeekFrom};
    // The agent writes its transcript: never a link, a FIFO or another special
    // file (threat model gap 29).
    let mut file = crate::services::home_io::open_regular(path)?;
    let len = file.metadata().ok()?.len();
    let known = SCANNED.lock_ok().get(path).cloned().filter(|known| known.read_to <= len);
    let Scanned { read_to, mut paths } = known.unwrap_or_default();
    if read_to == len {
        return Some(paths);
    }
    let start = read_to.max(len.saturating_sub(MAX_SCAN_BYTES));
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::with_capacity((len - start) as usize);
    file.take(len - start).read_to_end(&mut buf).ok()?;
    // A line still being written is left for the next read.
    let whole = buf.iter().rposition(|&b| b == b'\n').map_or(0, |at| at + 1);
    let text = String::from_utf8_lossy(&buf[..whole]);
    let mut lines = text.lines();
    if start > read_to {
        // Whatever came before the seek point is missing from the first line.
        lines.next();
    }
    let mut changes = Vec::new();
    for line in lines {
        let candidate = match kind {
            Store::Claude => line.contains("\"toolUseResult\"") && line.contains("\"filePath\""),
            Store::Codex => line.contains("\"FileChange\""),
            Store::Copilot => line.contains("\"fileEdits\""),
        };
        if !candidate {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match kind {
            Store::Claude => changes.extend(claude_change(&value)),
            Store::Codex => codex_changes(&value, &mut changes),
            Store::Copilot => copilot_changes(&value, &mut changes),
        }
    }
    paths.extend(paths_of(&changes));
    let mut scanned = SCANNED.lock_ok();
    if scanned.len() >= MAX_SCANNED && !scanned.contains_key(path) {
        scanned.clear();
    }
    scanned.insert(path.to_path_buf(), Scanned { read_to: start + whole as u64, paths: paths.clone() });
    Some(paths)
}

/// Every file `changes` touched: each change's path, and where a move put it.
fn paths_of(changes: &[FileChange]) -> std::collections::BTreeSet<String> {
    changes
        .iter()
        .flat_map(|change| std::iter::once(change.path.clone()).chain(change.moved_to.clone()))
        .filter(|path| !path.is_empty())
        .collect()
}

/// A Claude session's subagent transcripts (`agent-<id>.jsonl` in `folder`,
/// and in each workflow run's folder under `folder/workflows`), at most
/// [`MAX_SUBAGENT_FILES`] of them, in name order.
fn claude_subagent_files(folder: &Path) -> Vec<std::path::PathBuf> {
    let agents = |dir: &Path| -> Vec<std::path::PathBuf> {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return Vec::new();
        };
        entries
            .flatten()
            .filter(|entry| {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                name.starts_with("agent-") && name.ends_with(".jsonl")
            })
            .map(|entry| entry.path())
            .collect()
    };
    let mut files = agents(folder);
    if let Ok(runs) = std::fs::read_dir(folder.join("workflows")) {
        // Real directories only: the agent writes them, a link is not followed.
        for run in runs.flatten().filter(|run| run.file_type().is_ok_and(|kind| kind.is_dir())) {
            files.extend(agents(&run.path()));
        }
    }
    files.sort();
    files.truncate(MAX_SUBAGENT_FILES);
    files
}

/// An OpenCode tab's changes, from the session the Reader reads for it in
/// the store `db`.
#[allow(clippy::too_many_arguments)]
fn opencode_changes(
    db: &Path,
    project_id: Option<&str>,
    tab_dir: Option<&str>,
    since: Option<i64>,
    own: Option<&str>,
    subagent: Option<&str>,
    version: Option<&str>,
    limit: usize,
) -> AgentChanges {
    let Some(dir) = tab_dir.filter(|dir| Path::new(dir).is_absolute()) else {
        return AgentChanges::unavailable("no_session");
    };
    if project_id.is_some_and(|id| crate::services::remote::remote_target_for(id).is_some()) {
        return AgentChanges::unavailable("unsupported");
    }
    if !db.is_file() {
        return AgentChanges::empty();
    }
    crate::services::opencode_store::session_changes(db, dir, since, own, subagent, version, limit)
        .unwrap_or_else(|| AgentChanges::unavailable("read_failed"))
}

/// Which transcript format a file is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Store {
    Claude,
    Codex,
    Copilot,
}

/// The changes in the transcript at `path`: its tail, the last `limit`
/// changes in it. `None` only when the file cannot be read.
pub fn read_changes(path: &Path, kind: Store, version: Option<&str>, limit: usize) -> Option<AgentChanges> {
    // The agent writes its transcript: never a link, a FIFO or another special
    // file (threat model gap 29).
    let mut file = crate::services::home_io::open_regular(path)?;
    let meta = file.metadata().ok()?;
    let current = agent_transcript::fingerprint(&meta);
    if version == Some(current.as_str()) {
        return Some(AgentChanges::unchanged(current));
    }
    let (text, cut) = crate::services::agent_session::read_conversation_tail(&mut file, meta.len(), TAIL_BYTES)?;
    let mut changes = Vec::new();
    for line in text.lines() {
        // Most records are no change: only parse the ones that may be.
        let candidate = match kind {
            Store::Claude => line.contains("\"toolUseResult\"") && line.contains("\"filePath\""),
            Store::Codex => line.contains("\"FileChange\""),
            Store::Copilot => line.contains("\"fileEdits\""),
        };
        if !candidate {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match kind {
            Store::Claude => changes.extend(claude_change(&value)),
            Store::Codex => codex_changes(&value, &mut changes),
            Store::Copilot => copilot_changes(&value, &mut changes),
        }
    }
    Some(AgentChanges::read(current, changes, cut, limit))
}

/// The change a Claude tool result records: an edit's applied hunks, or a
/// file written new.
fn claude_change(value: &Value) -> Option<FileChange> {
    let result = value.get("toolUseResult")?.as_object()?;
    let path = result.get("filePath")?.as_str()?;
    let at = value.get("timestamp").and_then(Value::as_str).map(str::to_string);
    if result.get("type").and_then(Value::as_str) == Some("create") {
        let content = result.get("content")?.as_str()?;
        return Some(whole_file(path, "add", content, at));
    }
    let hunks = result.get("structuredPatch")?.as_array()?;
    let mut diff = String::new();
    for hunk in hunks {
        let number = |key: &str| hunk.get(key).and_then(Value::as_u64).unwrap_or(0);
        let _ = writeln!(
            diff,
            "@@ -{},{} +{},{} @@",
            number("oldStart"),
            number("oldLines"),
            number("newStart"),
            number("newLines")
        );
        for line in hunk.get("lines").and_then(Value::as_array).into_iter().flatten() {
            if let Some(line) = line.as_str() {
                diff.push_str(line);
                diff.push('\n');
            }
        }
    }
    (!diff.is_empty()).then(|| change(path, "edit", diff, at))
}

/// The changes a Codex `FileChange` item records, one per path.
fn codex_changes(value: &Value, out: &mut Vec<FileChange>) {
    if value.get("type").and_then(Value::as_str) != Some("event_msg") {
        return;
    }
    let Some(payload) = value.get("payload") else {
        return;
    };
    if payload.get("type").and_then(Value::as_str) != Some("item_completed") {
        return;
    }
    let Some(item) = payload.get("item") else {
        return;
    };
    if item.get("type").and_then(Value::as_str) != Some("FileChange")
        || item.get("status").and_then(Value::as_str).is_some_and(|status| status != "completed")
    {
        return;
    }
    let at = value.get("timestamp").and_then(Value::as_str).map(str::to_string);
    let Some(changes) = item.get("changes").and_then(Value::as_object) else {
        return;
    };
    for (path, entry) in changes {
        let text = |key: &str| entry.get(key).and_then(Value::as_str);
        let made = match text("type") {
            Some("update") => text("unified_diff").map(|diff| {
                let mut made = change(path, "edit", hunks_only(diff).to_string(), at.clone());
                made.moved_to = text("move_path").map(str::to_string);
                made
            }),
            Some("add") => text("content").map(|content| whole_file(path, "add", content, at.clone())),
            Some("delete") => text("content").map(|content| whole_file(path, "delete", content, at.clone())),
            _ => None,
        };
        out.extend(made);
    }
}

fn copilot_is_remote(project_id: Option<&str>) -> bool {
    project_id.is_some_and(|id| crate::services::remote::remote_target_for(id).is_some())
}

/// The changes a Copilot `tool.execution_complete` records, one per entry of
/// its `fileEdits`. The diff of each is its section of `detailedContent`: the
/// one whose `diff --git` header names the file, else the one at the same
/// position. A section with no hunk (an empty file created) lists no diff.
fn copilot_changes(value: &Value, out: &mut Vec<FileChange>) {
    if value.get("type").and_then(Value::as_str) != Some("tool.execution_complete") {
        return;
    }
    let Some(data) = value.get("data") else {
        return;
    };
    if data.get("success").and_then(Value::as_bool) != Some(true) {
        return;
    }
    let Some(edits) = data.get("fileEdits").and_then(Value::as_array) else {
        return;
    };
    let detailed = data.pointer("/result/detailedContent").and_then(Value::as_str).unwrap_or_default();
    let sections = copilot_sections(detailed);
    let at = value.get("timestamp").and_then(Value::as_str).map(str::to_string);
    for (index, edit) in edits.iter().enumerate() {
        let Some(path) = edit.get("path").and_then(Value::as_str) else {
            continue;
        };
        let kind = match edit.get("kind").and_then(Value::as_str) {
            Some("create") => "add",
            Some("delete") => "delete",
            _ => "edit",
        };
        let named = format!("a/{}", path.trim_start_matches('/'));
        let section = sections
            .iter()
            .find(|section| section.lines().next().is_some_and(|header| header.contains(&named)))
            .or_else(|| sections.get(index));
        let diff = section.map(|section| hunks_only(section).trim_end_matches('\n')).filter(|diff| !diff.is_empty());
        if let Some(diff) = diff {
            out.push(change(path, kind, format!("{diff}\n"), at.clone()));
        }
    }
}

/// `detailed` split at its `diff --git` lines, each section from its header on.
fn copilot_sections(detailed: &str) -> Vec<&str> {
    let starts: Vec<usize> = detailed
        .match_indices("diff --git ")
        .map(|(at, _)| at)
        .filter(|&at| at == 0 || detailed.as_bytes()[at - 1] == b'\n')
        .collect();
    starts
        .iter()
        .enumerate()
        .map(|(n, &start)| &detailed[start..starts.get(n + 1).copied().unwrap_or(detailed.len())])
        .collect()
}

/// V2's public tool content carries FileDiff records directly. Reuse the
/// renderer's bounded diff format without reconstructing V1 tool envelopes.
/// A tool without them (OpenCode 2.1.3's `edit`, `write`, …) keeps V1's
/// `state` shape under its `name`, and is read as V1's are.
pub(crate) fn opencode_v2_tool_changes(created: i64, tool: &Value) -> Vec<FileChange> {
    if tool.pointer("/state/status").and_then(Value::as_str) != Some("completed") {
        return Vec::new();
    }
    let ended = tool.pointer("/time/completed").and_then(Value::as_i64).unwrap_or(created);
    let at = Some(crate::services::prompt_blame::epoch_ms_to_iso(ended));
    let changes: Vec<_> = tool.pointer("/state/metadata/files").and_then(Value::as_array)
        .into_iter().flatten().filter_map(|file| {
            let path = file["file"].as_str()?;
            let diff = hunks_only(file["patch"].as_str()?);
            if diff.is_empty() { return None; }
            let kind = match file["status"].as_str() {
                Some("added") => "add",
                Some("deleted") => "delete",
                _ => "edit",
            };
            Some(change(path, kind, diff.to_string(), at.clone()))
        }).collect();
    if !changes.is_empty() { return changes; }
    tool_state_changes(tool["name"].as_str(), &tool["state"], ended)
}

/// The changes one OpenCode tool part records, created at `created` (epoch
/// ms) unless the part says when it ended.
pub(crate) fn opencode_part_changes(created: i64, part: &Value) -> Vec<FileChange> {
    let Some(state) = part.get("state") else {
        return Vec::new();
    };
    let ended = state.pointer("/time/end").and_then(Value::as_i64).unwrap_or(created);
    tool_state_changes(part.get("tool").and_then(Value::as_str), state, ended)
}

/// The changes a completed `tool` call's `state` records, ended at `ended`.
fn tool_state_changes(tool: Option<&str>, state: &Value, ended: i64) -> Vec<FileChange> {
    if state.get("status").and_then(Value::as_str) != Some("completed") {
        return Vec::new();
    }
    let at = Some(crate::services::prompt_blame::epoch_ms_to_iso(ended));
    let input = |key: &str| state.pointer(&format!("/input/{key}")).and_then(Value::as_str);
    let meta = |key: &str| state.pointer(&format!("/metadata/{key}"));
    match tool {
        Some("edit") => {
            let (Some(path), Some(diff)) = (input("filePath"), meta("diff").and_then(Value::as_str).map(hunks_only)) else {
                return Vec::new();
            };
            if diff.is_empty() {
                return Vec::new();
            }
            vec![change(path, "edit", diff.to_string(), at)]
        }
        Some("multiedit") => {
            let Some(path) = input("filePath") else {
                return Vec::new();
            };
            meta("results")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(diff_of)
                .map(|diff| change(path, "edit", diff.to_string(), at.clone()))
                .collect()
        }
        Some("write") => {
            let (Some(path), Some(content)) = (input("filePath"), input("content")) else {
                return Vec::new();
            };
            let existed = meta("exists").and_then(Value::as_bool).unwrap_or(false);
            vec![whole_file(path, if existed { "write" } else { "add" }, content, at)]
        }
        Some("apply_patch") => meta("files")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|file| {
                let path = file.get("filePath").and_then(Value::as_str)?;
                let kind = file.get("type").and_then(Value::as_str).unwrap_or("update");
                let mut made = match (kind, diff_of(file)) {
                    ("delete", None) => whole_file(path, "delete", file.get("before")?.as_str()?, at.clone()),
                    ("add", None) => whole_file(path, "add", file.get("after")?.as_str()?, at.clone()),
                    (_, Some(diff)) => change(path, if kind == "add" || kind == "delete" { kind } else { "edit" }, diff.to_string(), at.clone()),
                    _ => return None,
                };
                made.moved_to = file.get("movePath").and_then(Value::as_str).map(str::to_string);
                Some(made)
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// The hunks of the `diff` a part's metadata carries, when it has any.
fn diff_of(value: &Value) -> Option<&str> {
    value.get("diff").and_then(Value::as_str).map(hunks_only).filter(|diff| !diff.is_empty())
}

/// A unified diff from its first hunk on: a file header (`---`/`+++`,
/// `Index:`, `diff --git`) is the panel's to draw.
pub(crate) fn hunks_only(diff: &str) -> &str {
    if diff.starts_with("@@") {
        return diff;
    }
    diff.find("\n@@").map(|at| &diff[at + 1..]).unwrap_or("")
}

/// A whole file as one hunk — every line added (`add`, `write`) or removed
/// (`delete`).
fn whole_file(path: &str, kind: &str, content: &str, at: Option<String>) -> FileChange {
    let lines: Vec<&str> = content.lines().collect();
    let count = lines.len();
    let (mark, header) = if kind == "delete" {
        ('-', format!("@@ -1,{count} +0,0 @@\n"))
    } else {
        ('+', format!("@@ -0,0 +1,{count} @@\n"))
    };
    let mut diff = header;
    for line in lines {
        diff.push(mark);
        diff.push_str(line);
        diff.push('\n');
    }
    if count == 0 {
        diff.clear();
    }
    change(path, kind, diff, at)
}

/// A change with its counts taken, its diff bounded.
fn change(path: &str, kind: &str, mut diff: String, at: Option<String>) -> FileChange {
    let (mut added, mut removed) = (0u32, 0u32);
    for line in diff.lines() {
        if line.starts_with('+') {
            added += 1;
        } else if line.starts_with('-') {
            removed += 1;
        }
    }
    let cut = diff.len() > MAX_DIFF_CHARS;
    if cut {
        let mut end = MAX_DIFF_CHARS;
        while !diff.is_char_boundary(end) {
            end -= 1;
        }
        let end = diff[..end].rfind('\n').map(|at| at + 1).unwrap_or(0);
        diff.truncate(end);
    }
    FileChange {
        path: path.to_string(),
        kind: kind.to_string(),
        diff,
        added,
        removed,
        at,
        cut,
        moved_to: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_lines(lines: &[String]) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        std::fs::write(&path, lines.join("\n") + "\n").unwrap();
        (dir, path)
    }

    #[test]
    fn claude_edits_and_new_files_are_listed_with_their_hunks_and_turned_down_ones_are_not() {
        let edit = serde_json::json!({
            "type": "user", "timestamp": "2026-10-02T10:00:00Z",
            "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "updated"}]},
            "toolUseResult": {"filePath": "/p/src/a.rs", "oldString": "x", "newString": "y",
                "structuredPatch": [{"oldStart": 9, "oldLines": 2, "newStart": 9, "newLines": 3,
                    "lines": [" keep", "-old", "+new", "+more"]}]}
        });
        let create = serde_json::json!({
            "type": "user", "timestamp": "2026-10-02T10:01:00Z",
            "toolUseResult": {"type": "create", "filePath": "/p/b.md", "content": "# B\n\ntext\n", "structuredPatch": []}
        });
        let rejected = serde_json::json!({"type": "user", "toolUseResult": "User rejected tool use"});
        let read_file = serde_json::json!({"type": "user", "toolUseResult": {"type": "text", "file": {"filePath": "/p/c.rs", "content": "x"}}});
        let unchanged_write = serde_json::json!({"type": "user", "toolUseResult": {"type": "update", "filePath": "/p/d.rs", "content": "x", "structuredPatch": []}});
        let (_dir, path) = write_lines(&[edit, create, rejected, read_file, unchanged_write].map(|v| v.to_string()));
        let read = read_changes(&path, Store::Claude, None, DEFAULT_LIMIT).unwrap();
        assert!(read.available);
        assert_eq!(read.changes.len(), 2);
        let edit = &read.changes[0];
        assert_eq!((edit.path.as_str(), edit.kind.as_str()), ("/p/src/a.rs", "edit"));
        assert_eq!(edit.diff, "@@ -9,2 +9,3 @@\n keep\n-old\n+new\n+more\n");
        assert_eq!((edit.added, edit.removed), (2, 1));
        assert_eq!(edit.at.as_deref(), Some("2026-10-02T10:00:00Z"));
        let created = &read.changes[1];
        assert_eq!(created.kind, "add");
        assert_eq!(created.diff, "@@ -0,0 +1,3 @@\n+# B\n+\n+text\n");
        assert_eq!((created.added, created.removed), (3, 0));
        // Asked again with its version: unchanged, nothing re-sent.
        let again = read_changes(&path, Store::Claude, read.version.as_deref(), DEFAULT_LIMIT).unwrap();
        assert!(again.unchanged && again.changes.is_empty());
    }

    #[test]
    fn the_whole_transcripts_paths_are_scanned_on_from_where_the_last_scan_stopped() {
        let edit = |path: &str| {
            serde_json::json!({"type": "user", "toolUseResult": {"filePath": path,
                "structuredPatch": [{"oldStart": 1, "oldLines": 1, "newStart": 1, "newLines": 1, "lines": ["-a", "+b"]}]}})
            .to_string()
        };
        let (_dir, path) = write_lines(&[edit("/p/a.rs"), edit("/p/b.rs")]);
        let first = scan_paths(&path, Store::Claude).unwrap();
        assert_eq!(first.iter().map(String::as_str).collect::<Vec<_>>(), ["/p/a.rs", "/p/b.rs"]);
        // Appended: a whole line and one still being written.
        let mut more = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        use std::io::Write as _;
        write!(more, "{}\n{}", edit("/p/c.rs"), &edit("/p/d.rs")[..20]).unwrap();
        let second = scan_paths(&path, Store::Claude).unwrap();
        assert_eq!(second.iter().map(String::as_str).collect::<Vec<_>>(), ["/p/a.rs", "/p/b.rs", "/p/c.rs"]);
        // The half line is read once it is whole.
        writeln!(more, "{}", &edit("/p/d.rs")[20..]).unwrap();
        let third = scan_paths(&path, Store::Claude).unwrap();
        assert!(third.contains("/p/d.rs"), "{third:?}");
        // A file replaced by a shorter one is read anew.
        std::fs::write(&path, edit("/p/z.rs") + "\n").unwrap();
        let fresh = scan_paths(&path, Store::Claude).unwrap();
        assert_eq!(fresh.iter().map(String::as_str).collect::<Vec<_>>(), ["/p/z.rs"]);
    }

    #[test]
    fn codex_file_changes_are_listed_per_path_and_unfinished_ones_are_not() {
        let item = |status: &str, changes: Value| {
            serde_json::json!({
                "timestamp": "2026-10-02T11:00:00Z", "type": "event_msg",
                "payload": {"type": "item_completed", "item": {"type": "FileChange", "id": "x", "status": status, "changes": changes}}
            })
            .to_string()
        };
        let lines = [
            item("completed", serde_json::json!({
                "/p/a.rs": {"type": "update", "unified_diff": "@@ -3,1 +3,2 @@\n ctx\n+added\n", "move_path": "/p/b.rs"},
                "/p/new.rs": {"type": "add", "content": "fn x() {}\n"},
                "/p/old.rs": {"type": "delete", "content": "one\ntwo\n"},
            })),
            item("failed", serde_json::json!({"/p/c.rs": {"type": "add", "content": "z"}})),
            // A command that merely names a FileChange is no change.
            serde_json::json!({"type": "response_item", "payload": {"type": "message", "content": "FileChange"}}).to_string(),
        ];
        let (_dir, path) = write_lines(&lines);
        let read = read_changes(&path, Store::Codex, None, DEFAULT_LIMIT).unwrap();
        let mut seen: Vec<_> = read.changes.iter().map(|c| (c.path.as_str(), c.kind.as_str(), c.added, c.removed)).collect();
        seen.sort();
        assert_eq!(seen, vec![("/p/a.rs", "edit", 1, 0), ("/p/new.rs", "add", 1, 0), ("/p/old.rs", "delete", 0, 2)]);
        let moved = read.changes.iter().find(|c| c.path == "/p/a.rs").unwrap();
        assert_eq!(moved.moved_to.as_deref(), Some("/p/b.rs"));
        assert_eq!(moved.diff, "@@ -3,1 +3,2 @@\n ctx\n+added\n");
        let deleted = read.changes.iter().find(|c| c.kind == "delete").unwrap();
        assert_eq!(deleted.diff, "@@ -1,2 +0,0 @@\n-one\n-two\n");
    }

    #[test]
    fn opencode_tool_parts_give_their_recorded_diffs() {
        let edit = serde_json::json!({
            "type": "tool", "tool": "edit",
            "state": {"status": "completed", "input": {"filePath": "/p/a.ts"},
                "metadata": {"diff": "Index: /p/a.ts\n===\n--- /p/a.ts\n+++ /p/a.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n"},
                "time": {"start": 1, "end": 1_790_000_000_000i64}}
        });
        let changes = opencode_part_changes(0, &edit);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].diff, "@@ -1,1 +1,1 @@\n-a\n+b\n");
        assert_eq!((changes[0].added, changes[0].removed), (1, 1));
        assert!(changes[0].at.is_some());

        let write = |exists: bool| serde_json::json!({
            "type": "tool", "tool": "write",
            "state": {"status": "completed", "input": {"filePath": "/p/w.ts", "content": "x\ny\n"}, "metadata": {"exists": exists}}
        });
        assert_eq!(opencode_part_changes(0, &write(false))[0].kind, "add");
        assert_eq!(opencode_part_changes(0, &write(true))[0].kind, "write");

        let patch = serde_json::json!({
            "type": "tool", "tool": "apply_patch",
            "state": {"status": "completed", "metadata": {"files": [
                {"filePath": "/p/u.ts", "type": "update", "diff": "--- a\n+++ b\n@@ -2,1 +2,1 @@\n-q\n+r\n"},
                {"filePath": "/p/gone.ts", "type": "delete", "before": "z\n"},
                {"filePath": "/p/m.ts", "type": "move", "diff": "@@ -1 +1 @@\n-s\n+t\n", "movePath": "/p/n.ts"},
            ]}}
        });
        let changes = opencode_part_changes(0, &patch);
        let kinds: Vec<_> = changes.iter().map(|c| (c.path.as_str(), c.kind.as_str())).collect();
        assert_eq!(kinds, vec![("/p/u.ts", "edit"), ("/p/gone.ts", "delete"), ("/p/m.ts", "edit")]);
        assert_eq!(changes[2].moved_to.as_deref(), Some("/p/n.ts"));

        let running = serde_json::json!({"type": "tool", "tool": "edit", "state": {"status": "running", "input": {"filePath": "/p/a.ts"}}});
        assert!(opencode_part_changes(0, &running).is_empty());
    }

    /// A Copilot 1.0.102/1.0.103 session as `events.jsonl` records it (a BYOK
    /// stub model driving `apply_patch`, `bash`, `task` and `edit`; paths shortened).
    fn copilot_log() -> Vec<String> {
        let at = |n: u32| format!("2026-10-24T06:37:25.{n:03}Z");
        let rec = |kind: &str, n: u32, data: serde_json::Value| serde_json::json!({ "type": kind, "data": data, "id": format!("e{n}"), "timestamp": at(n) }).to_string();
        let patch_one = "\ndiff --git a/work/a.txt b/work/a.txt\ncreate file mode 100644\nindex 0000000..0000000\n--- a/dev/null\n+++ b/work/a.txt\n@@ -1,0 +1,3 @@\n+alpha\n+beta\n+\n\n\n\ndiff --git a/work/b.txt b/work/b.txt\ncreate file mode 100644\nindex 0000000..0000000\n--- a/dev/null\n+++ b/work/b.txt\n@@ -1,0 +1,2 @@\n+bee\n+\n\n";
        let patch_two = "\ndiff --git a/work/a.txt b/work/a.txt\nindex 0000000..0000000 100644\n--- a/work/a.txt\n+++ b/work/a.txt\n@@ -1,3 +1,4 @@\n alpha\n-beta\n+gamma\n+delta\n \n\n\ndiff --git a/work/b.txt b/dev/null\nindex 0000000..0000000 100644\n--- a/work/b.txt\n+++ b/dev/null\n@@ -1,2 +0,0 @@\n-bee\n-\n\n";
        let edit = "\ndiff --git a/work/c.txt b/work/c.txt\nindex 0000000..0000000 100644\n--- a/work/c.txt\n+++ b/work/c.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+three\n \n\n";
        vec![
            rec("session.start", 1, serde_json::json!({ "sessionId": "c4196d1f-a396-42a7-8384-d0783bd09cc7", "copilotVersion": "1.0.103", "context": { "cwd": "/work" } })),
            rec("session.model_change", 2, serde_json::json!({ "newModel": "gpt-5.4", "reasoningEffort": "medium" })),
            rec("user.message", 3, serde_json::json!({ "content": "patch it", "interactionId": "i1", "turnId": "0" })),
            rec("assistant.message", 4, serde_json::json!({ "content": "", "model": "gpt-5.4", "toolRequests": [{ "toolCallId": "call_p1", "name": "apply_patch", "arguments": "*** Begin Patch\n*** End Patch\n", "type": "custom" }] })),
            rec("tool.execution_start", 5, serde_json::json!({ "toolCallId": "call_p1", "toolName": "apply_patch", "arguments": "*** Begin Patch\n*** End Patch\n" })),
            rec("tool.execution_complete", 6, serde_json::json!({ "toolCallId": "call_p1", "success": true, "fileEdits": [{ "path": "/work/a.txt", "kind": "create" }, { "path": "/work/b.txt", "kind": "create" }], "result": { "content": "Added 2 file(s)", "detailedContent": patch_one } })),
            rec("tool.execution_start", 7, serde_json::json!({ "toolCallId": "call_p2", "toolName": "apply_patch", "arguments": "" })),
            rec("tool.execution_complete", 8, serde_json::json!({ "toolCallId": "call_p2", "success": true, "fileEdits": [{ "path": "/work/a.txt", "kind": "edit" }, { "path": "/work/b.txt", "kind": "delete" }], "result": { "content": "Modified 1 file(s)", "detailedContent": patch_two } })),
            rec("tool.execution_complete", 9, serde_json::json!({ "toolCallId": "call_e1", "success": true, "fileEdits": [{ "path": "/work/c.txt", "kind": "edit" }], "result": { "content": "updated", "detailedContent": edit } })),
            rec("tool.execution_complete", 10, serde_json::json!({ "toolCallId": "call_e2", "success": false, "fileEdits": [{ "path": "/work/d.txt", "kind": "edit" }], "result": { "content": "no match" } })),
            rec("assistant.message", 11, serde_json::json!({ "content": "Done.", "model": "gpt-5.4", "toolRequests": [] })),
            rec("session.usage_info", 12, serde_json::json!({ "currentTokens": 18664, "tokenLimit": 272000 })),
        ]
    }

    #[test]
    fn copilot_patches_give_one_diff_per_file_and_a_failed_call_gives_none() {
        let (_dir, path) = write_lines(&copilot_log());
        let read = read_changes(&path, Store::Copilot, None, 50).unwrap();
        let listed: Vec<_> = read
            .changes
            .iter()
            .map(|c| (c.path.as_str(), c.kind.as_str(), c.added, c.removed))
            .collect();
        assert_eq!(
            listed,
            vec![
                ("/work/a.txt", "add", 3, 0),
                ("/work/b.txt", "add", 2, 0),
                ("/work/a.txt", "edit", 2, 1),
                ("/work/b.txt", "delete", 0, 2),
                ("/work/c.txt", "edit", 1, 1),
            ]
        );
        // Hunks only: the git header is the panel's to draw, and the diff ends at its last line.
        assert!(read.changes[0].diff.starts_with("@@ -1,0 +1,3 @@\n+alpha\n"));
        assert!(read.changes[2].diff.starts_with("@@ -1,3 +1,4 @@\n alpha\n-beta\n"));
        assert!(read.changes.iter().all(|c| !c.diff.contains("diff --git") && c.diff.ends_with('\n') && !c.diff.ends_with("\n\n")));
        assert_eq!(read.changes[4].at.as_deref(), Some("2026-10-24T06:37:25.009Z"));
        // Unchanged since the version the caller holds.
        let again = read_changes(&path, Store::Copilot, read.version.as_deref(), 50).unwrap();
        assert!(again.unchanged);
    }

    #[test]
    fn a_long_diff_is_cut_at_a_line_but_counted_whole() {
        let content: String = (0..40_000).map(|i| format!("line {i}\n")).collect();
        let made = whole_file("/p/big.txt", "add", &content, None);
        assert!(made.cut);
        assert!(made.diff.len() <= MAX_DIFF_CHARS);
        assert!(made.diff.ends_with('\n'));
        assert_eq!(made.added, 40_000);
    }

    #[test]
    fn only_the_newest_changes_up_to_the_limit_are_answered() {
        let lines: Vec<String> = (0..5)
            .map(|i| serde_json::json!({"type": "user", "toolUseResult": {"type": "create", "filePath": format!("/p/{i}"), "content": "x"}}).to_string())
            .collect();
        let (_dir, path) = write_lines(&lines);
        let read = read_changes(&path, Store::Claude, None, 2).unwrap();
        assert!(read.truncated);
        assert_eq!(read.changes.iter().map(|c| c.path.as_str()).collect::<Vec<_>>(), vec!["/p/3", "/p/4"]);
    }

    /// Gap 29: the transcript is agent-written; a planted FIFO or a link reads
    /// as nothing, without blocking.
    #[cfg(unix)]
    #[test]
    fn a_fifo_or_linked_transcript_reads_as_nothing_without_blocking() {
        use crate::services::home_io::{mkfifo, within_deadline};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        mkfifo(&path);
        let at = path.clone();
        assert!(within_deadline(move || read_changes(&at, Store::Claude, None, DEFAULT_LIMIT).is_none()));
        std::fs::remove_file(&path).unwrap();
        let outside = dir.path().join("outside.jsonl");
        std::fs::write(&outside, "").unwrap();
        std::os::unix::fs::symlink(&outside, &path).unwrap();
        assert!(read_changes(&path, Store::Claude, None, DEFAULT_LIMIT).is_none());
        assert!(read_changes(&outside, Store::Claude, None, DEFAULT_LIMIT).is_some());
    }
}
