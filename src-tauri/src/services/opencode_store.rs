//! OpenCode's own session store: `~/.local/share/opencode/opencode.db`, read
//! for the phone's Focus view.
//!
//! OpenCode keeps no transcript file. Every session, message and message part
//! is a row in one SQLite database (`session`, `message`, `part`, each row's
//! body a JSON `data` column), shared by every OpenCode on the machine —
//! fenced and containerized tabs included, which mount the same directory.
//!
//! Which session is a tab's own is recorded by Tabtivity's OpenCode plugin
//! (`services::opencode_session`): the session its OpenCode last took a
//! prompt in, read first while the store still has it as a top-level,
//! unarchived session. A tab with no such record reads the newest top-level
//! session of its folder — what a tab from before the plugin was restored
//! into with `--continue` — and a tab opened fresh only the sessions created
//! since its launch: before its first prompt it has none, and the folder's
//! older conversation is somebody else's.
//!
//! A subagent OpenCode spawns (its `task` tool) runs as a child session —
//! `parent_id` naming the session that spawned it — and is one `agent` entry
//! in its parent's conversation, placed when it was created; its own
//! conversation is read by the handle on that entry, looked up only among the
//! tab's session's descendants.
//!
//! What is read is the conversation only: the user's typed text parts (not
//! the `synthetic` ones OpenCode writes for itself, such as a file's content
//! or its auto-continue nudge) and the assistant's text parts, each finished
//! part one bubble. Reasoning, tool calls, patches and compaction summaries
//! are stepped over — save the completed edit tool parts, which
//! [`session_changes`] reads for the desktop Reader's Changes panel. A part still streaming is left out until it is finished,
//! so a bubble never changes once shown.
//!
//! The Reader's Resume menu lists a folder's top-level sessions by their first
//! prompt ([`folder_chats`]); a picked one is read as the `own` session is.
//!
//! The database also holds OpenCode's account tokens. Only the `session`,
//! `message` and `part` tables are ever queried, and the file is opened
//! strictly read-only: OpenCode is writing it while it is read. A missing
//! file or a schema that moved answers `None` — no session — never an error.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;

use crate::services::agent_chats::FolderChat;
use crate::services::agent_changes::{opencode_part_changes, opencode_v2_tool_changes, AgentChanges};
use crate::services::agent_transcript::{
    agent_entry, agents_unlisted, insert_by_time, running_agents, subagent_token, transcript_entry, AgentTranscript, TranscriptEntry, MAX_SUBAGENT_DEPTH,
};
use crate::services::prompt_blame::epoch_ms_to_iso;

/// The most messages of one session read per answer: the newest ones. What
/// fell before them is announced as `truncated`.
const MESSAGE_TAIL: i64 = 2000;
/// The most edit tool parts of one session read for its changes.
const CHANGE_TAIL: i64 = 2000;

/// Components of the store below its home (`.local/share/opencode/opencode.db`).
const DB_DEPTH: usize = 4;
/// The names read from the store; each must be a table, never a view.
const STORE_TABLES: &[&str] = &["session", "session_v2", "session_message", "message", "part"];

fn table_exists(conn: &Connection, table: &str) -> bool {
    conn.query_row("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1", [table], |_| Ok(()))
        .is_ok()
}

/// V2 keeps sessions in `session_v2` and complete messages in
/// `session_message`. A connection-local view lets the session ownership and
/// subagent queries serve both formats without changing the vendor database.
fn open_store(db: &Path) -> Option<Connection> {
    let conn = crate::services::agent_sqlite::open_below(db, DB_DEPTH, STORE_TABLES)?;
    if table_exists(&conn, "session_v2") {
        let mut sql = String::from(
            "CREATE TEMP VIEW session AS SELECT id, parent_id, directory, time_created,
             time_updated, time_archived, title, agent FROM main.session_v2",
        );
        if table_exists(&conn, "session") {
            // Earlier V1 schemas have neither title nor agent. Those are
            // optional Reader labels; keep their conversations readable too.
            let has = |name: &str| conn.prepare("SELECT name FROM pragma_table_info('session')")
                .ok().and_then(|mut stmt| stmt.query_map([], |r| r.get::<_, String>(0)).ok()
                    .map(|rows| rows.filter_map(Result::ok).any(|column| column == name))).unwrap_or(false);
            let title = if has("title") { "title" } else { "NULL" };
            let agent = if has("agent") { "agent" } else { "NULL" };
            sql.push_str(&format!(
                " UNION ALL SELECT id, parent_id, directory, time_created, time_updated,
                 time_archived, {title}, {agent} FROM main.session
                 WHERE id NOT IN (SELECT id FROM main.session_v2)"
            ));
        }
        conn.execute_batch(&sql).ok()?;
    }
    Some(conn)
}

fn v2_session(conn: &Connection, session: &str) -> bool {
    table_exists(conn, "session_v2") && conn.query_row(
        "SELECT 1 FROM session_v2 WHERE id = ?1", [session], |_| Ok(()),
    ).is_ok()
}

/// The scope's OpenCode database: `.local/share/opencode/opencode.db` of its
/// Tabtivity-owned agent home — where OpenCode's `xdg-basedir` puts it under the
/// `$HOME` the tab runs with.
pub fn db_path_for(scope_id: Option<&str>) -> PathBuf {
    db_in_home(&crate::services::agent_home::scope_home(scope_id))
}

/// The OpenCode database of the scope's local-model tabs (`ollama launch
/// opencode`), in the scope's local-model home.
pub fn local_model_db_path_for(scope_id: Option<&str>) -> PathBuf {
    db_in_home(&crate::services::agent_home::local_model_home(scope_id))
}

fn db_in_home(home: &Path) -> PathBuf {
    home.join(".local").join("share").join("opencode").join("opencode.db")
}

/// The `wellknown` sources `home`'s OpenCode 2 database holds: the origins
/// whose remote configuration (MCP servers, plugins, permissions) OpenCode
/// fetches and loads at every start. They are one JSON array of strings under
/// the `wellknown:sources` key of the `kv` table, put there by the legacy
/// `auth.json` import or by `integration.wellknown.add`. `None` when there is
/// no database, none can be read, or no source is recorded; at most a few
/// origins, each cut short, for display. Read-only through `agent_sqlite`.
pub fn wellknown_sources_in(home: &Path) -> Option<Vec<String>> {
    let conn = crate::services::agent_sqlite::open_below(&db_in_home(home), DB_DEPTH, &["kv"])?;
    let value: String = conn
        .query_row("SELECT value FROM kv WHERE key = 'wellknown:sources'", [], |row| row.get(0))
        .optional()
        .ok()??;
    let Value::Array(sources) = serde_json::from_str(&value).ok()? else { return None };
    let origins: Vec<String> = sources
        .iter()
        .filter_map(|s| s.as_str())
        .filter(|s| !s.is_empty())
        .take(8)
        .map(|s| s.chars().take(200).collect())
        .collect();
    (!origins.is_empty()).then_some(origins)
}

/// The conversation of the tab's `own` session (its plugin's record) while
/// the store has it, else of the newest top-level, unarchived session
/// OpenCode ran in `directory` — created at or after `since` (epoch ms) when
/// given: the last `limit` turns, or `unchanged` when `version` still names it as it is.
/// A folder with no such session yet is an available, empty transcript — a
/// tab before its first prompt. `subagent` reads, instead, the descendant of
/// that session whose handle it is. `None` when the store cannot be read at
/// all.
#[allow(clippy::too_many_arguments)]
pub fn session_transcript(
    db: &Path,
    directory: &str,
    since: Option<i64>,
    own: Option<&str>,
    subagent: Option<&str>,
    version: Option<&str>,
    limit: usize,
) -> Option<AgentTranscript> {
    let conn = open_store(db)?;
    let session = match tab_session(&conn, directory, since, own, subagent)? {
        TabSession::Id(id) => id,
        TabSession::NoSubagent => return Some(AgentTranscript::unavailable("no_subagent")),
        TabSession::None => {
            return Some(AgentTranscript {
                available: true,
                version: Some(format!("new:{directory}")),
                ..Default::default()
            })
        }
    };
    let current = fingerprint(&conn, &session)?;
    if version == Some(current.as_str()) {
        return Some(AgentTranscript {
            available: true,
            version: Some(current),
            unchanged: true,
            ..Default::default()
        });
    }
    let (mut entries, mut truncated) = read_entries(&conn, &session)?;
    let children = children(&conn, &session);
    let spawned: Vec<String> = children.iter().filter_map(|entry| entry.subagent.clone()).collect();
    insert_by_time(&mut entries, children, truncated);
    let running_agents = running_agents(&entries);
    if entries.len() > limit {
        entries.drain(..entries.len() - limit);
        truncated = true;
    }
    let agents_earlier = if truncated { agents_unlisted(&entries, &spawned) } else { 0 };
    Some(AgentTranscript {
        available: true,
        reason: None,
        version: Some(current),
        unchanged: false,
        entries,
        truncated,
        agents_earlier,
        running_agents,
        usage: None,
        model: None,
        effort: None,
        tokens: None,
        shells: Vec::new(),
        context_card: None,
        cwd: None,
        running_cwds: Vec::new(),
        watched: false,
    })
}

/// Which session a tab in `directory` reads: see [`session_transcript`].
enum TabSession {
    /// The folder has no session of the tab's yet.
    None,
    /// `subagent` names none of that session's descendants.
    NoSubagent,
    Id(String),
}

/// The tab's session — or, with `subagent`, its descendant of that handle.
/// `None` when the store cannot be queried.
fn tab_session(conn: &Connection, directory: &str, since: Option<i64>, own: Option<&str>, subagent: Option<&str>) -> Option<TabSession> {
    let session = match own.and_then(|id| top_level(conn, id)) {
        Some(id) => Some(id),
        None => newest_in(conn, directory, since)?,
    };
    let Some(session) = session else {
        return Some(if subagent.is_some() { TabSession::NoSubagent } else { TabSession::None });
    };
    Some(match subagent {
        None => TabSession::Id(session),
        Some(token) => match descendants(conn, &session).into_iter().find(|id| subagent_token(id) == token) {
            Some(child) => TabSession::Id(child),
            None => TabSession::NoSubagent,
        },
    })
}

/// Whether the store holds `id` as a top-level, unarchived session: one a
/// tab can be restored into (`--session`) and read as its own. False when the
/// store cannot be read.
pub fn resumable_session(db: &Path, id: &str) -> bool {
    open_store(db)
        .and_then(|conn| top_level(&conn, id))
        .is_some()
}

fn top_level(conn: &Connection, id: &str) -> Option<String> {
    conn.query_row(
        "SELECT id FROM session WHERE id = ?1 AND parent_id IS NULL AND time_archived IS NULL",
        [id],
        |row| row.get(0),
    )
    .optional()
    .ok()?
}

/// The newest top-level, unarchived session of `directory` created at or
/// after `since`; `None` when the store cannot be queried.
fn newest_in(conn: &Connection, directory: &str, since: Option<i64>) -> Option<Option<String>> {
    let [given, real] = folder_dirs(directory);
    conn.query_row(
        "SELECT id FROM session
          WHERE directory IN (?1, ?2) AND parent_id IS NULL AND time_archived IS NULL
            AND time_created >= ?3
          ORDER BY time_updated DESC LIMIT 1",
        rusqlite::params![given, real, since.unwrap_or(i64::MIN)],
        |row| row.get(0),
    )
    .optional()
    .ok()
}

/// The two ways a session's `directory` may name the folder: as given, and
/// resolved (the same twice when they agree).
fn folder_dirs(directory: &str) -> [String; 2] {
    let real = std::fs::canonicalize(directory)
        .map(|real| real.to_string_lossy().into_owned())
        .unwrap_or_else(|_| directory.to_string());
    [directory.to_string(), real]
}

/// Whether `id` is a top-level, unarchived session OpenCode ran in
/// `directory`: one of the folder's chats the Resume menu lists
/// (`services::agent_chats`). False when the store cannot be read.
pub fn folder_session(db: &Path, directory: &str, id: &str) -> bool {
    let Some(conn) = open_store(db) else {
        return false;
    };
    let [given, real] = folder_dirs(directory);
    conn.query_row(
        "SELECT 1 FROM session
          WHERE id = ?1 AND directory IN (?2, ?3) AND parent_id IS NULL AND time_archived IS NULL",
        rusqlite::params![id, given, real],
        |_| Ok(()),
    )
    .is_ok()
}

/// The folder's chats for the Resume menu: from the `offset`-th of its
/// top-level, unarchived sessions on, newest first, at most `limit` that a
/// prompt went into, of at most `scanned` sessions read; and where the next
/// page starts while older sessions are left. `None` when the store cannot
/// be read.
pub fn folder_chats(
    db: &Path,
    directory: &str,
    offset: usize,
    limit: usize,
    scanned: usize,
) -> Option<(Vec<FolderChat>, Option<usize>)> {
    let conn = open_store(db)?;
    let [given, real] = folder_dirs(directory);
    let mut stmt = conn
        .prepare(
            "SELECT id, time_updated FROM session
              WHERE directory IN (?1, ?2) AND parent_id IS NULL AND time_archived IS NULL
              ORDER BY time_updated DESC, id DESC LIMIT ?3 OFFSET ?4",
        )
        .ok()?;
    let rows: Vec<(String, i64)> = stmt
        .query_map(rusqlite::params![given, real, scanned as i64 + 1, offset as i64], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .ok()?
        .filter_map(Result::ok)
        .collect();
    let mut chats = Vec::new();
    let mut read = 0;
    for (id, updated) in rows.iter().take(scanned) {
        if chats.len() >= limit {
            break;
        }
        read += 1;
        let (first, last) = session_prompts(&conn, id);
        let Some((title, at)) = first else { continue };
        chats.push(FolderChat {
            id: id.clone(),
            title,
            last,
            started: Some(epoch_ms_to_iso(at)),
            updated: u64::try_from(*updated).unwrap_or(0),
        });
    }
    Some((chats, (read < rows.len()).then_some(offset + read)))
}

/// The session's first prompt with its moment (epoch ms), and its last one
/// when that is another message.
fn session_prompts(conn: &Connection, session: &str) -> (Option<(String, i64)>, Option<String>) {
    let prompt = |newest: bool| -> Option<(String, i64)> {
        let order = if newest { "DESC" } else { "ASC" };
        let (text, at) = if v2_session(conn, session) {
            // 2.1.3 keeps the kind in the row's `type` column, earlier V2 in `data`.
            let kind = if has_column(conn, "session_message", "type") {
                "coalesce(type, json_extract(data, '$.type'))"
            } else {
                "json_extract(data, '$.type')"
            };
            let (at, data): (i64, String) = conn
                .query_row(
                    &format!(
                        "SELECT time_created, data FROM session_message
                          WHERE session_id = ?1 AND {kind} = 'user' ORDER BY seq {order} LIMIT 1"
                    ),
                    [session],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .ok()?;
            let message: Value = serde_json::from_str(&data).ok()?;
            (message.get("text").and_then(Value::as_str)?.to_string(), at)
        } else {
            let (id, at): (String, i64) = conn
                .query_row(
                    &format!(
                        "SELECT id, time_created FROM message
                          WHERE session_id = ?1 AND json_extract(data, '$.role') = 'user'
                          ORDER BY time_created {order}, id {order} LIMIT 1"
                    ),
                    [session],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .ok()?;
            let mut stmt = conn
                .prepare(
                    "SELECT data FROM part
                      WHERE message_id = ?1 AND json_extract(data, '$.type') = 'text'
                      ORDER BY time_created, id",
                )
                .ok()?;
            let text = stmt
                .query_map([&id], |row| row.get::<_, String>(0))
                .ok()?
                .filter_map(Result::ok)
                .filter_map(|data| serde_json::from_str::<Value>(&data).ok())
                .filter(is_written)
                .filter_map(|part| part_text(&part).map(str::to_string))
                .collect::<Vec<_>>()
                .join("\n");
            (text, at)
        };
        (!text.trim().is_empty()).then_some((text, at))
    };
    let first = prompt(false);
    let last = first.as_ref().and_then(|_| prompt(true)).filter(|last| Some(last) != first.as_ref());
    (first, last.map(|(text, _)| text))
}

fn has_column(conn: &Connection, table: &str, column: &str) -> bool {
    conn.prepare(&format!("SELECT name FROM pragma_table_info('{table}')"))
        .ok()
        .and_then(|mut stmt| {
            stmt.query_map([], |row| row.get::<_, String>(0))
                .ok()
                .map(|mut rows| rows.any(|name| name.is_ok_and(|name| name == column)))
        })
        .unwrap_or(false)
}

/// The files the tab's session — or `subagent`'s — changed, from its
/// completed edit tool parts (`services::agent_changes`): the newest
/// [`CHANGE_TAIL`] such parts, the last `limit` changes of those.
#[allow(clippy::too_many_arguments)]
pub fn session_changes(
    db: &Path,
    directory: &str,
    since: Option<i64>,
    own: Option<&str>,
    subagent: Option<&str>,
    version: Option<&str>,
    limit: usize,
) -> Option<AgentChanges> {
    let conn = open_store(db)?;
    let session = match tab_session(&conn, directory, since, own, subagent)? {
        TabSession::Id(id) => id,
        TabSession::NoSubagent => return Some(AgentChanges::unavailable("no_subagent")),
        TabSession::None => return Some(AgentChanges::read(format!("new:{directory}"), Vec::new(), false, limit)),
    };
    let current = fingerprint(&conn, &session)?;
    if version == Some(current.as_str()) {
        return Some(AgentChanges {
            available: true,
            version: Some(current),
            unchanged: true,
            ..Default::default()
        });
    }
    // Edit tool parts only, filtered in SQL: the others carry whole file
    // reads and command outputs.
    if v2_session(&conn, &session) {
        let (messages, truncated) = v2_messages(&conn, &session, CHANGE_TAIL)?;
        let changes = messages.iter().flat_map(|(at, message)| {
            message.get("content").and_then(Value::as_array).into_iter().flatten()
                .filter(|part| part["type"] == "tool")
                .flat_map(move |part| opencode_v2_tool_changes(*at, part))
        }).collect();
        return Some(AgentChanges::read(current, changes, truncated, limit));
    }
    let mut stmt = conn
        .prepare(
            "SELECT time_created, data FROM part
              WHERE session_id = ?1 AND json_extract(data, '$.type') = 'tool'
                AND json_extract(data, '$.tool') IN ('edit', 'multiedit', 'write', 'apply_patch')
              ORDER BY time_created DESC, id DESC LIMIT ?2",
        )
        .ok()?;
    let mut rows: Vec<(i64, String)> = stmt
        .query_map(rusqlite::params![session, CHANGE_TAIL + 1], |row| Ok((row.get(0)?, row.get(1)?)))
        .ok()?
        .filter_map(Result::ok)
        .collect();
    let truncated = rows.len() as i64 > CHANGE_TAIL;
    rows.truncate(CHANGE_TAIL as usize);
    rows.reverse();
    let changes = rows
        .iter()
        .filter_map(|(created, data)| Some((*created, serde_json::from_str::<Value>(data).ok()?)))
        .flat_map(|(created, part)| opencode_part_changes(created, &part))
        .collect();
    Some(AgentChanges::read(current, changes, truncated, limit))
}

/// The sessions `session` spawned, as its `agent` entries: the task its title
/// names (without the ` (@explore subagent)` OpenCode appends), the agent it
/// ran as. A store whose `session` table lacks those columns has none.
fn children(conn: &Connection, session: &str) -> Vec<TranscriptEntry> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT id, title, agent, time_created FROM session WHERE parent_id = ?1
          ORDER BY time_created, id LIMIT 500",
    ) else {
        return Vec::new();
    };
    stmt.query_map([session], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, i64>(3)?,
        ))
    })
    .map(|rows| {
        rows.filter_map(Result::ok)
            .filter_map(|(id, title, agent, created)| {
                let title = title.unwrap_or_default();
                let mut entry = agent_entry(task_of(&title), agent.as_deref(), Some(epoch_ms_to_iso(created)))?;
                entry.subagent = Some(subagent_token(&id));
                Some(entry)
            })
            .collect()
    })
    .unwrap_or_default()
}

/// A child session's title without the ` (@<agent> subagent)` OpenCode ends
/// it with.
fn task_of(title: &str) -> &str {
    let title = title.trim_end();
    title
        .strip_suffix(" subagent)")
        .and_then(|rest| rest.rfind(" (@").map(|at| rest[..at].trim_end()))
        .unwrap_or(title)
}

/// Every session under `session`: its children, theirs, and so on.
fn descendants(conn: &Connection, session: &str) -> Vec<String> {
    let Ok(mut stmt) = conn.prepare(
        "WITH RECURSIVE tree(id, depth) AS (
             SELECT id, 1 FROM session WHERE parent_id = ?1
             UNION
             SELECT s.id, tree.depth + 1 FROM session s JOIN tree ON s.parent_id = tree.id
              WHERE tree.depth < ?2)
         SELECT id FROM tree LIMIT 500",
    ) else {
        return Vec::new();
    };
    stmt.query_map(rusqlite::params![session, MAX_SUBAGENT_DEPTH as i64], |row| row.get::<_, String>(0))
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
}

/// Moves whenever the session gains a message or a part, or a part is updated
/// (a streaming answer, a finished one) — two indexed aggregates, no bodies.
fn fingerprint(conn: &Connection, session: &str) -> Option<String> {
    if v2_session(conn, session) {
        let (count, updated): (i64, Option<i64>) = conn.query_row(
            "SELECT count(*), max(time_updated) FROM session_message WHERE session_id = ?1",
            [session], |row| Ok((row.get(0)?, row.get(1)?)),
        ).ok()?;
        return Some(format!("oc2:{session}:{count}:{}", updated.unwrap_or(0)));
    }
    let (messages, message_at): (i64, Option<i64>) = conn
        .query_row(
            "SELECT count(*), max(time_updated) FROM message WHERE session_id = ?1",
            [session],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok()?;
    let (parts, part_at): (i64, Option<i64>) = conn
        .query_row(
            "SELECT count(*), max(time_updated) FROM part WHERE session_id = ?1",
            [session],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok()?;
    Some(format!(
        "oc:{session}:{messages}:{}:{parts}:{}",
        message_at.unwrap_or(0),
        part_at.unwrap_or(0)
    ))
}

/// The session's newest [`MESSAGE_TAIL`] messages as turns, oldest first, and
/// whether older messages exist beyond them.
fn read_entries(conn: &Connection, session: &str) -> Option<(Vec<TranscriptEntry>, bool)> {
    if v2_session(conn, session) {
        let (messages, truncated) = v2_messages(conn, session, MESSAGE_TAIL)?;
        let entries = messages.iter().flat_map(|(created, message)| v2_message_entries(message, *created)).collect();
        return Some((entries, truncated));
    }
    let mut stmt = conn
        .prepare(
            "SELECT id, time_created, data FROM message WHERE session_id = ?1
              ORDER BY time_created DESC, id DESC LIMIT ?2",
        )
        .ok()?;
    let mut messages: Vec<(String, i64, String)> = stmt
        .query_map(rusqlite::params![session, MESSAGE_TAIL + 1], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .ok()?
        .filter_map(Result::ok)
        .collect();
    let truncated = messages.len() as i64 > MESSAGE_TAIL;
    messages.truncate(MESSAGE_TAIL as usize);
    messages.reverse();
    let Some(oldest) = messages.first().map(|(_, at, _)| *at) else {
        return Some((Vec::new(), truncated));
    };
    // Text parts only, filtered in SQL: a session's tool parts carry whole
    // file reads and command outputs this never shows.
    let mut stmt = conn
        .prepare(
            "SELECT message_id, time_created, data FROM part
              WHERE session_id = ?1 AND time_created >= ?2
                AND json_extract(data, '$.type') = 'text'
              ORDER BY time_created, id",
        )
        .ok()?;
    let mut parts: std::collections::HashMap<String, Vec<(i64, Value)>> = Default::default();
    for row in stmt
        .query_map(rusqlite::params![session, oldest], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?))
        })
        .ok()?
        .filter_map(Result::ok)
    {
        if let Ok(data) = serde_json::from_str::<Value>(&row.2) {
            parts.entry(row.0).or_default().push((row.1, data));
        }
    }
    let mut entries = Vec::new();
    for (id, created, data) in &messages {
        let Ok(message) = serde_json::from_str::<Value>(data) else {
            continue;
        };
        entries.extend(message_entries(&message, *created, parts.get(id).map(Vec::as_slice).unwrap_or(&[])));
    }
    Some((entries, truncated))
}

/// Public V2 message shapes: user text is direct, assistant content is typed.
/// Synthetic/system/compaction records never become user turns. Query by seq
/// (the durable admission order), not IDs that can precede queued prompts.
/// The kind is the row's `type` column — `data` holds no `type` of its own
/// (OpenCode 2.1.3) — put back into the message as `type`.
fn v2_messages(conn: &Connection, session: &str, tail: i64) -> Option<(Vec<(i64, Value)>, bool)> {
    let mut stmt = conn.prepare(
        "SELECT time_created, type, data FROM session_message WHERE session_id = ?1
         ORDER BY seq DESC LIMIT ?2",
    ).ok()?;
    let mut rows: Vec<(i64, Option<String>, String)> = stmt.query_map(rusqlite::params![session, tail + 1], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
    }).ok()?.filter_map(Result::ok).collect();
    let truncated = rows.len() as i64 > tail;
    rows.truncate(tail as usize);
    rows.reverse();
    let messages = rows.into_iter().filter_map(|(at, kind, data)| {
        let mut message: Value = serde_json::from_str(&data).ok()?;
        if let (Some(kind), Some(fields)) = (kind, message.as_object_mut()) {
            fields.entry("type").or_insert(Value::String(kind));
        }
        Some((at, message))
    }).collect();
    Some((messages, truncated))
}

fn v2_message_entries(message: &Value, created: i64) -> Vec<TranscriptEntry> {
    match message["type"].as_str() {
        Some("user") => transcript_entry("prompt", message["text"].as_str().unwrap_or_default(), Some(epoch_ms_to_iso(created)))
            .into_iter().collect(),
        Some("assistant") if message.pointer("/time/completed").is_some_and(|t| !t.is_null()) => {
            let mut entries: Vec<_> = message["content"].as_array().into_iter().flatten()
                .filter(|part| part["type"] == "text")
                .filter_map(|part| transcript_entry("answer", part["text"].as_str()?, Some(epoch_ms_to_iso(created))))
                .collect();
            // V2 errors use a tagged public schema instead of V1's envelope.
            if let Some(text) = message.pointer("/error/message").and_then(Value::as_str) {
                entries.extend(transcript_entry("answer", text, Some(epoch_ms_to_iso(created))));
            }
            entries
        }
        _ => Vec::new(),
    }
}

/// A part the user or the model actually wrote — not one OpenCode generated
/// (`synthetic`) or set aside (`ignored`).
fn is_written(part: &Value) -> bool {
    let flagged = |key: &str| part.get(key).and_then(Value::as_bool) == Some(true);
    !flagged("synthetic") && !flagged("ignored")
}

fn part_text(part: &Value) -> Option<&str> {
    part.get("text").and_then(Value::as_str)
}

/// The turns one message contributes: a user message is one prompt (its text
/// parts joined); an assistant message is one answer per finished text part.
/// A compaction summary is OpenCode's note to itself, not an answer.
fn message_entries(message: &Value, created: i64, parts: &[(i64, Value)]) -> Vec<TranscriptEntry> {
    match message.get("role").and_then(Value::as_str) {
        Some("user") => {
            let text = parts
                .iter()
                .map(|(_, part)| part)
                .filter(|part| is_written(part))
                .filter_map(part_text)
                .collect::<Vec<_>>()
                .join("\n");
            transcript_entry("prompt", &text, Some(epoch_ms_to_iso(created)))
                .into_iter()
                .collect()
        }
        Some("assistant") => {
            if message.get("summary").and_then(Value::as_bool) == Some(true) {
                return Vec::new();
            }
            let completed = message.pointer("/time/completed").is_some_and(|t| !t.is_null());
            let failure = message_error(message).and_then(|text| {
                let at = message.pointer("/time/completed").and_then(Value::as_i64).unwrap_or(created);
                transcript_entry("answer", &text, Some(epoch_ms_to_iso(at)))
            });
            parts
                .iter()
                .filter(|(_, part)| is_written(part))
                .filter(|(_, part)| completed || part.pointer("/time/end").is_some_and(|t| !t.is_null()))
                .filter_map(|(part_created, part)| {
                    let at = part
                        .pointer("/time/start")
                        .and_then(Value::as_i64)
                        .unwrap_or(*part_created);
                    transcript_entry("answer", part_text(part)?, Some(epoch_ms_to_iso(at)))
                })
                .chain(failure)
                .collect()
        }
        _ => Vec::new(),
    }
}

/// Why OpenCode ended an assistant message early (`error.data.message`: a
/// provider's usage limit, a rejected key, …), shown as the last answer of
/// that turn. A turn the user stopped (`MessageAbortedError`) is not one.
fn message_error(message: &Value) -> Option<String> {
    let error = message.get("error").filter(|e| e.is_object())?;
    if error.get("name").and_then(Value::as_str) == Some("MessageAbortedError") {
        return None;
    }
    let text = error.pointer("/data/message")?.as_str()?.trim();
    (!text.is_empty()).then(|| text.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_tmp(prefix: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("{prefix}-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A store with OpenCode's own table shapes (the columns this reads, plus
    /// the account table whose presence is why only three tables are read).
    fn store() -> (PathBuf, Connection) {
        let dir = unique_tmp(concat!(crate::app_slug!(), "-opencode-store"));
        let db = dir.join("opencode.db");
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE account (id TEXT PRIMARY KEY, access_token TEXT NOT NULL);
             INSERT INTO account VALUES ('a', 'secret-token');
             CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT NOT NULL,
               time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER);
             CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
               time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
             CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
               time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);",
        )
        .unwrap();
        (db, conn)
    }

    fn session(conn: &Connection, id: &str, parent: Option<&str>, dir: &str, updated: i64, archived: Option<i64>) {
        conn.execute(
            "INSERT INTO session VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
            rusqlite::params![id, parent, dir, updated, archived],
        )
        .unwrap();
    }

    fn message(conn: &Connection, id: &str, session: &str, at: i64, data: Value) {
        conn.execute(
            "INSERT INTO message VALUES (?1, ?2, ?3, ?3, ?4)",
            rusqlite::params![id, session, at, data.to_string()],
        )
        .unwrap();
    }

    fn part(conn: &Connection, id: &str, message: &str, session: &str, at: i64, data: Value) {
        conn.execute(
            "INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
            rusqlite::params![id, message, session, at, data.to_string()],
        )
        .unwrap();
    }

    fn kinds(t: &AgentTranscript) -> Vec<(&str, &str)> {
        t.entries.iter().map(|e| (e.kind.as_str(), e.text.as_str())).collect()
    }

    #[test]
    fn v2_structured_messages_are_read_in_admission_order_beside_legacy_sessions() {
        use serde_json::json;
        let (db, conn) = store();
        session(&conn, "ses_legacy", None, "legacy", 10, None);
        message(&conn, "msg_old", "ses_legacy", 10, json!({"role":"user"}));
        part(&conn, "prt_old", "msg_old", "ses_legacy", 10, json!({"type":"text","text":"old question"}));
        conn.execute_batch(
            "CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT,
               time_created INTEGER, time_updated INTEGER, time_archived INTEGER, title TEXT, agent TEXT);
             CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
               time_created INTEGER, time_updated INTEGER, data TEXT);
             INSERT INTO session_v2 VALUES ('ses_v2', NULL, 'v2', 20, 30, NULL, 'Test', 'build');
             INSERT INTO session_v2 VALUES ('ses_child', 'ses_v2', 'v2', 21, 30, NULL, 'Explore', 'explore');",
        ).unwrap();
        // The kind is the row's `type` column; OpenCode 2.1.3 keeps none in `data`.
        for (seq, at, kind, data) in [
            (1, 30, "user", json!({"text":"question"})),
            (2, 20, "assistant", json!({"content":[{"type":"reasoning","text":"hidden"},{"type":"text","text":"answer"}],"time":{"completed":40}})),
            (3, 40, "synthetic", json!({"text":"hidden context"})),
            (4, 50, "assistant", json!({"content":[{"type":"text","text":"still streaming"}],"time":{}})),
            (5, 60, "assistant", json!({"content":[{"type":"tool","name":"edit","time":{"completed":61},"state":{"status":"completed","metadata":{"files":[{"file":"file.rs","patch":"@@ -1 +1 @@\n-old\n+new","status":"modified"}]}}}],"time":{"completed":62}})),
            (6, 70, "assistant", json!({"content":[
                {"type":"tool","name":"edit","time":{"completed":71},"state":{"status":"completed","input":{"filePath":"lib.rs","oldString":"a","newString":"b"},"metadata":{"diff":"Index: lib.rs\n--- lib.rs\n+++ lib.rs\n@@ -1 +1 @@\n-a\n+b\n"}}},
                {"type":"tool","name":"write","time":{"completed":72},"state":{"status":"completed","input":{"filePath":"new.rs","content":"fn x() {}\n"},"metadata":{"exists":false}}},
            ],"time":{"completed":73}})),
            (7, 80, "idle", json!({"outcome":"succeeded"})),
        ] {
            conn.execute("INSERT INTO session_message VALUES (?1, 'ses_v2', ?2, ?3, ?4, ?4, ?5)",
                rusqlite::params![format!("msg_{seq}"), kind, seq, at, data.to_string()]).unwrap();
        }
        assert!(resumable_session(&db, "ses_v2"));
        assert!(!resumable_session(&db, "ses_child"));
        let transcript = session_transcript(&db, "v2", None, Some("ses_v2"), None, None, 100).unwrap();
        let turns: Vec<_> = kinds(&transcript).into_iter().filter(|(kind, _)| *kind != "agent").collect();
        assert_eq!(turns, [("prompt", "question"), ("answer", "answer")]);
        assert!(transcript.entries.iter().any(|e| e.kind == "agent" && e.subagent.is_some()));
        assert!(session_transcript(&db, "v2", None, Some("ses_v2"), None, transcript.version.as_deref(), 100).unwrap().unchanged);
        let changes = session_changes(&db, "v2", None, Some("ses_v2"), None, None, 100).unwrap();
        let mut changed: Vec<_> = changes.changes.iter().map(|c| (c.path.as_str(), c.kind.as_str())).collect();
        changed.sort();
        assert_eq!(changed, [("file.rs", "edit"), ("lib.rs", "edit"), ("new.rs", "add")]);
        let legacy = session_transcript(&db, "legacy", None, Some("ses_legacy"), None, None, 100).unwrap();
        assert_eq!(kinds(&legacy), [("prompt", "old question")]);
        // Opening the read-only adapter creates no persistent views or tables.
        let views: i64 = conn.query_row("SELECT count(*) FROM sqlite_master WHERE type = 'view'", [], |r| r.get(0)).unwrap();
        assert_eq!(views, 0);
    }

    #[test]
    fn reads_the_newest_top_level_session_of_the_folder_as_prompts_and_answers() {
        let (db, conn) = store();
        let dir = "/work/project";
        session(&conn, "ses_old", None, dir, 100, None);
        session(&conn, "ses_new", None, dir, 300, None);
        session(&conn, "ses_child", Some("ses_new"), dir, 900, None);
        session(&conn, "ses_archived", None, dir, 800, Some(801));
        session(&conn, "ses_elsewhere", None, "/work/other", 950, None);
        message(&conn, "m0", "ses_old", 10, serde_json::json!({"role": "user", "time": {"created": 10}}));
        part(&conn, "p0", "m0", "ses_old", 10, serde_json::json!({"type": "text", "text": "old prompt"}));

        message(&conn, "m1", "ses_new", 1_000, serde_json::json!({"role": "user", "time": {"created": 1_000}}));
        part(&conn, "p1", "m1", "ses_new", 1_000, serde_json::json!({"type": "text", "text": "fix the tests"}));
        part(&conn, "p2", "m1", "ses_new", 1_001, serde_json::json!({"type": "text", "text": "file body", "synthetic": true}));
        message(&conn, "m2", "ses_new", 2_000, serde_json::json!({"role": "assistant", "time": {"created": 2_000, "completed": 5_000}}));
        part(&conn, "p3", "m2", "ses_new", 2_001, serde_json::json!({"type": "step-start"}));
        part(&conn, "p4", "m2", "ses_new", 2_002, serde_json::json!({"type": "reasoning", "text": "thinking"}));
        part(&conn, "p5", "m2", "ses_new", 2_003, serde_json::json!({"type": "text", "text": "Let me look.", "time": {"start": 2_003, "end": 2_100}}));
        part(&conn, "p6", "m2", "ses_new", 2_200, serde_json::json!({"type": "tool", "state": {"output": "huge"}}));
        part(&conn, "p7", "m2", "ses_new", 3_000, serde_json::json!({"type": "text", "text": "Fixed.", "time": {"start": 3_000, "end": 3_100}}));

        let t = session_transcript(&db, dir, None, None, None, None, 120).unwrap();
        assert!(t.available);
        assert_eq!(kinds(&t), vec![("prompt", "fix the tests"), ("answer", "Let me look."), ("answer", "Fixed.")]);
        assert_eq!(t.entries[0].at.as_deref(), Some("1970-01-01T00:00:01.000Z"));
        assert_eq!(t.entries[2].at.as_deref(), Some("1970-01-01T00:00:03.000Z"));
        assert!(!t.truncated);
    }

    #[test]
    fn a_message_ended_by_an_error_shows_it_after_its_text_unless_the_user_stopped_it() {
        let (db, conn) = store();
        session(&conn, "s", None, "/p", 1, None);
        message(&conn, "m1", "s", 1_000, serde_json::json!({"role": "user"}));
        part(&conn, "p1", "m1", "s", 1_000, serde_json::json!({"type": "text", "text": "go"}));
        message(&conn, "m2", "s", 2_000, serde_json::json!({"role": "assistant", "time": {"created": 2_000, "completed": 2_500},
            "error": {"name": "APIError", "data": {"message": "Usage limit reached. Try again at 3:20 PM.", "statusCode": 429}}}));
        message(&conn, "m3", "s", 3_000, serde_json::json!({"role": "assistant", "time": {"created": 3_000, "completed": 3_100},
            "error": {"name": "MessageAbortedError", "data": {"message": "The operation was aborted."}}}));
        let t = session_transcript(&db, "/p", None, None, None, None, 120).unwrap();
        assert_eq!(kinds(&t), vec![("prompt", "go"), ("answer", "Usage limit reached. Try again at 3:20 PM.")]);
    }

    #[test]
    fn a_streaming_answer_waits_until_its_part_is_finished() {
        let (db, conn) = store();
        session(&conn, "s", None, "/p", 1, None);
        message(&conn, "m1", "s", 1_000, serde_json::json!({"role": "assistant", "time": {"created": 1_000}}));
        part(&conn, "p1", "m1", "s", 1_001, serde_json::json!({"type": "text", "text": "Done part.", "time": {"start": 1_001, "end": 1_050}}));
        part(&conn, "p2", "m1", "s", 1_100, serde_json::json!({"type": "text", "text": "Still wri", "time": {"start": 1_100}}));
        let t = session_transcript(&db, "/p", None, None, None, None, 120).unwrap();
        assert_eq!(kinds(&t), vec![("answer", "Done part.")]);
    }

    #[test]
    fn compaction_summaries_and_empty_messages_are_not_turns() {
        let (db, conn) = store();
        session(&conn, "s", None, "/p", 1, None);
        message(&conn, "m1", "s", 1_000, serde_json::json!({"role": "user"}));
        part(&conn, "p1", "m1", "s", 1_000, serde_json::json!({"type": "compaction"}));
        message(&conn, "m2", "s", 2_000, serde_json::json!({"role": "assistant", "summary": true, "time": {"completed": 3}}));
        part(&conn, "p2", "m2", "s", 2_001, serde_json::json!({"type": "text", "text": "Summary of everything", "time": {"start": 1, "end": 2}}));
        let t = session_transcript(&db, "/p", None, None, None, None, 120).unwrap();
        assert!(t.available);
        assert!(t.entries.is_empty());
    }

    #[test]
    fn a_folder_with_no_session_is_a_fresh_empty_chat_and_a_missing_store_is_none() {
        let (db, _conn) = store();
        let t = session_transcript(&db, "/nothing/here", None, None, None, None, 120).unwrap();
        assert!(t.available && t.entries.is_empty());
        assert!(session_transcript(&db.with_file_name("absent.db"), "/p", None, None, None, None, 120).is_none());
    }

    #[test]
    fn a_fresh_tab_reads_only_sessions_created_since_its_launch() {
        let (db, conn) = store();
        session(&conn, "ses_before", None, "/p", 100, None);
        message(&conn, "m0", "ses_before", 100, serde_json::json!({"role": "user"}));
        part(&conn, "p0", "m0", "ses_before", 100, serde_json::json!({"type": "text", "text": "yesterday's chat"}));
        let fresh = session_transcript(&db, "/p", Some(500), None, None, None, 120).unwrap();
        assert!(fresh.available && fresh.entries.is_empty());
        session(&conn, "ses_mine", None, "/p", 600, None);
        message(&conn, "m1", "ses_mine", 600, serde_json::json!({"role": "user"}));
        part(&conn, "p1", "m1", "ses_mine", 600, serde_json::json!({"type": "text", "text": "new question"}));
        let mine = session_transcript(&db, "/p", Some(500), None, None, fresh.version.as_deref(), 120).unwrap();
        assert_eq!(kinds(&mine), vec![("prompt", "new question")]);
    }

    #[test]
    fn a_tab_reads_its_recorded_session_not_its_siblings_newer_one() {
        let (db, conn) = store();
        session(&conn, "ses_mine", None, "/p", 100, None);
        session(&conn, "ses_sibling", None, "/p", 900, None);
        session(&conn, "ses_kid", Some("ses_mine"), "/p", 950, None);
        session(&conn, "ses_shelved", None, "/p", 50, Some(60));
        for (m, s, text) in [("m1", "ses_mine", "my prompt"), ("m2", "ses_sibling", "their prompt")] {
            message(&conn, m, s, 100, serde_json::json!({"role": "user"}));
            part(&conn, &format!("{m}p"), m, s, 100, serde_json::json!({"type": "text", "text": text}));
        }
        let mine = session_transcript(&db, "/p", None, Some("ses_mine"), None, None, 120).unwrap();
        assert_eq!(kinds(&mine), vec![("prompt", "my prompt")]);
        // A record naming a child, an archived or a vanished session falls
        // back to the folder's newest.
        for stale in ["ses_kid", "ses_shelved", "ses_gone"] {
            let t = session_transcript(&db, "/p", None, Some(stale), None, None, 120).unwrap();
            assert_eq!(kinds(&t), vec![("prompt", "their prompt")], "{stale}");
        }
        assert!(resumable_session(&db, "ses_mine"));
        assert!(!resumable_session(&db, "ses_kid") && !resumable_session(&db, "ses_shelved") && !resumable_session(&db, "ses_gone"));
        assert!(!resumable_session(&db.with_file_name("absent.db"), "ses_mine"));
    }

    #[test]
    fn an_unchanged_session_answers_unchanged_and_a_new_part_moves_the_version() {
        let (db, conn) = store();
        session(&conn, "s", None, "/p", 1, None);
        message(&conn, "m1", "s", 1_000, serde_json::json!({"role": "user"}));
        part(&conn, "p1", "m1", "s", 1_000, serde_json::json!({"type": "text", "text": "hi"}));
        let first = session_transcript(&db, "/p", None, None, None, None, 120).unwrap();
        let again = session_transcript(&db, "/p", None, None, None, first.version.as_deref(), 120).unwrap();
        assert!(again.unchanged && again.entries.is_empty());
        part(&conn, "p2", "m1", "s", 1_500, serde_json::json!({"type": "text", "text": "more"}));
        let moved = session_transcript(&db, "/p", None, None, None, first.version.as_deref(), 120).unwrap();
        assert!(!moved.unchanged);
        assert_eq!(kinds(&moved), vec![("prompt", "hi\nmore")]);
    }

    #[test]
    fn the_limit_keeps_the_newest_turns_and_says_so() {
        let (db, conn) = store();
        session(&conn, "s", None, "/p", 1, None);
        for i in 0..5i64 {
            let (m, p) = (format!("m{i}"), format!("p{i}"));
            message(&conn, &m, "s", 1_000 * (i + 1), serde_json::json!({"role": "user"}));
            part(&conn, &p, &m, "s", 1_000 * (i + 1), serde_json::json!({"type": "text", "text": format!("prompt {i}")}));
        }
        let t = session_transcript(&db, "/p", None, None, None, None, 2).unwrap();
        assert_eq!(kinds(&t), vec![("prompt", "prompt 3"), ("prompt", "prompt 4")]);
        assert!(t.truncated);
    }

    #[test]
    fn a_task_subagent_is_an_entry_and_its_session_reads_by_handle() {
        let (db, conn) = store();
        session(&conn, "root", None, "/p", 100, None);
        session(&conn, "kid", Some("root"), "/p", 150, None);
        session(&conn, "grandkid", Some("kid"), "/p", 170, None);
        session(&conn, "other", None, "/q", 90, None);
        session(&conn, "strangers-kid", Some("other"), "/q", 95, None);
        conn.execute_batch("ALTER TABLE session ADD COLUMN title TEXT; ALTER TABLE session ADD COLUMN agent TEXT;").unwrap();
        conn.execute("UPDATE session SET title = 'Explore the repo (@explore subagent)', agent = 'explore' WHERE id = 'kid'", []).unwrap();
        message(&conn, "m1", "root", 110, serde_json::json!({"role": "user"}));
        part(&conn, "p1", "m1", "root", 110, serde_json::json!({"type": "text", "text": "map it"}));
        message(&conn, "m2", "root", 200, serde_json::json!({"role": "assistant", "time": {"completed": 210}}));
        part(&conn, "p2", "m2", "root", 200, serde_json::json!({"type": "text", "text": "Mapped.", "time": {"start": 200, "end": 210}}));
        message(&conn, "k1", "kid", 151, serde_json::json!({"role": "user"}));
        part(&conn, "kp1", "k1", "kid", 151, serde_json::json!({"type": "text", "text": "look at src"}));
        message(&conn, "k2", "kid", 160, serde_json::json!({"role": "assistant", "time": {"completed": 165}}));
        part(&conn, "kp2", "k2", "kid", 160, serde_json::json!({"type": "text", "text": "src holds the app.", "time": {"start": 160, "end": 165}}));

        let t = session_transcript(&db, "/p", None, None, None, None, 120).unwrap();
        assert_eq!(kinds(&t), vec![("prompt", "map it"), ("agent", "Explore the repo"), ("answer", "Mapped.")]);
        assert_eq!(t.entries[1].role.as_deref(), Some("explore"));
        let token = t.entries[1].subagent.clone().expect("handle");

        let sub = session_transcript(&db, "/p", None, None, Some(&token), None, 120).unwrap();
        assert_eq!(kinds(&sub), vec![("prompt", "look at src"), ("answer", "src holds the app.")]);
        // Deeper descendants read too; another folder's are not this tab's.
        assert!(session_transcript(&db, "/p", None, None, Some(&subagent_token("grandkid")), None, 120).unwrap().available);
        let foreign = session_transcript(&db, "/p", None, None, Some(&subagent_token("strangers-kid")), None, 120).unwrap();
        assert_eq!(foreign.reason.as_deref(), Some("no_subagent"));
    }

    #[test]
    fn a_child_title_loses_the_suffix_opencode_appends() {
        assert_eq!(task_of("Explore codebase structure (@explore subagent)"), "Explore codebase structure");
        assert_eq!(task_of("Plain title"), "Plain title");
        assert_eq!(task_of("(@x subagent)"), "(@x subagent)");
    }

    #[test]
    fn a_folders_prompted_top_level_sessions_are_its_chats_newest_first() {
        use serde_json::json;
        let (db, conn) = store();
        session(&conn, "ses_old", None, "dir", 10, None);
        message(&conn, "msg_a", "ses_old", 10, json!({"role":"user"}));
        part(&conn, "prt_a", "msg_a", "ses_old", 10, json!({"type":"text","text":"first ask"}));
        part(&conn, "prt_s", "msg_a", "ses_old", 10, json!({"type":"text","text":"file body","synthetic":true}));
        message(&conn, "msg_b", "ses_old", 11, json!({"role":"assistant"}));
        message(&conn, "msg_c", "ses_old", 12, json!({"role":"user"}));
        part(&conn, "prt_c", "msg_c", "ses_old", 12, json!({"type":"text","text":"then this"}));
        session(&conn, "ses_new", None, "dir", 20, None);
        message(&conn, "msg_d", "ses_new", 20, json!({"role":"user"}));
        part(&conn, "prt_d", "msg_d", "ses_new", 20, json!({"type":"text","text":"only ask"}));
        session(&conn, "ses_empty", None, "dir", 30, None);
        session(&conn, "ses_child", Some("ses_new"), "dir", 40, None);
        session(&conn, "ses_gone", None, "dir", 50, Some(50));
        session(&conn, "ses_else", None, "other", 60, None);
        let (chats, next) = folder_chats(&db, "dir", 0, 10, 10).unwrap();
        let rows: Vec<_> = chats.iter().map(|c| (c.id.as_str(), c.title.as_str(), c.last.as_deref())).collect();
        assert_eq!(rows, [("ses_new", "only ask", None), ("ses_old", "first ask", Some("then this"))]);
        assert_eq!(next, None);
        assert_eq!(chats[1].updated, 10);
        // A page ends at its limit and says where the next begins.
        let (page, next) = folder_chats(&db, "dir", 0, 1, 10).unwrap();
        assert_eq!(page.len(), 1);
        let (rest, _) = folder_chats(&db, "dir", next.unwrap(), 1, 10).unwrap();
        assert_eq!(rest[0].id, "ses_old");
        assert!(folder_session(&db, "dir", "ses_empty"));
        for id in ["ses_child", "ses_gone", "ses_else", "ses_missing"] {
            assert!(!folder_session(&db, "dir", id), "{id}");
        }
    }

    #[test]
    fn a_v2_sessions_prompts_are_read_from_the_type_column_or_its_data() {
        use serde_json::json;
        let (db, conn) = store();
        conn.execute_batch(
            "CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT,
               time_created INTEGER, time_updated INTEGER, time_archived INTEGER, title TEXT, agent TEXT);
             CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
               time_created INTEGER, time_updated INTEGER, data TEXT);
             INSERT INTO session_v2 VALUES ('ses_v2', NULL, 'dir', 20, 30, NULL, 'Test', 'build');",
        ).unwrap();
        for (seq, kind, data) in [
            (1, Some("user"), json!({"text":"question"})),
            (2, Some("assistant"), json!({"content":[]})),
            (3, None, json!({"type":"user","text":"follow-up"})),
        ] {
            conn.execute("INSERT INTO session_message VALUES (?1, 'ses_v2', ?2, ?3, ?3, ?3, ?4)",
                rusqlite::params![format!("msg_{seq}"), kind, seq, data.to_string()]).unwrap();
        }
        let (chats, _) = folder_chats(&db, "dir", 0, 10, 10).unwrap();
        assert_eq!(chats.len(), 1);
        assert_eq!((chats[0].title.as_str(), chats[0].last.as_deref()), ("question", Some("follow-up")));
        assert_eq!(chats[0].updated, 30);
    }
}
