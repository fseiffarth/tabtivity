//! OpenCode's own session store: `~/.local/share/opencode/opencode.db`, read
//! for the phone's Focus view.
//!
//! OpenCode keeps no transcript file. Every session, message and message part
//! is a row in one SQLite database (`session`, `message`, `part`, each row's
//! body a JSON `data` column), shared by every OpenCode on the machine —
//! fenced and containerized tabs included, which mount the same directory.
//!
//! OpenCode has no session hook, so a tab cannot be told which session is its
//! own. What it launches into is the one this reads: an OpenCode tab is
//! restored with `--continue`, "the most recent session of this directory",
//! so the newest top-level session in the tab's folder *is* the tab's
//! conversation — with the same caveat the restore has: two OpenCode tabs in
//! one folder read the same (newest) session. A tab opened fresh (no
//! `--continue`) starts a new session, so only sessions created since its
//! launch are its own: before its first prompt it has none, and the folder's
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
//! The database also holds OpenCode's account tokens. Only the `session`,
//! `message` and `part` tables are ever queried, and the file is opened
//! strictly read-only: OpenCode is writing it while it is read. A missing
//! file or a schema that moved answers `None` — no session — never an error.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::Value;

use crate::services::agent_changes::{opencode_part_changes, AgentChanges};
use crate::services::agent_transcript::{
    agent_entry, agents_unlisted, insert_by_time, running_agents, subagent_token, transcript_entry, AgentTranscript, TranscriptEntry, MAX_SUBAGENT_DEPTH,
};
use crate::services::prompt_blame::epoch_ms_to_iso;

/// The most messages of one session read per answer: the newest ones. What
/// fell before them is announced as `truncated`.
const MESSAGE_TAIL: i64 = 2000;
/// The most edit tool parts of one session read for its changes.
const CHANGE_TAIL: i64 = 2000;

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

/// The conversation of the newest top-level, unarchived session OpenCode ran
/// in `directory` — created at or after `since` (epoch ms) when given: the
/// last `limit` turns, or `unchanged` when `version` still names it as it is.
/// A folder with no such session yet is an available, empty transcript — a
/// tab before its first prompt. `subagent` reads, instead, the descendant of
/// that session whose handle it is. `None` when the store cannot be read at
/// all.
pub fn session_transcript(
    db: &Path,
    directory: &str,
    since: Option<i64>,
    subagent: Option<&str>,
    version: Option<&str>,
    limit: usize,
) -> Option<AgentTranscript> {
    let conn = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    let session = match tab_session(&conn, directory, since, subagent)? {
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
    let agents_earlier = truncated && agents_unlisted(&entries, &spawned);
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
        tokens: None,
        shells: Vec::new(),
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
fn tab_session(conn: &Connection, directory: &str, since: Option<i64>, subagent: Option<&str>) -> Option<TabSession> {
    let mut dirs = vec![directory.to_string()];
    if let Ok(real) = std::fs::canonicalize(directory) {
        let real = real.to_string_lossy().into_owned();
        if real != directory {
            dirs.push(real);
        }
    }
    let session: Option<String> = conn
        .query_row(
            "SELECT id FROM session
              WHERE directory IN (?1, ?2) AND parent_id IS NULL AND time_archived IS NULL
                AND time_created >= ?3
              ORDER BY time_updated DESC LIMIT 1",
            rusqlite::params![&dirs[0], dirs.last().unwrap_or(&dirs[0]), since.unwrap_or(i64::MIN)],
            |row| row.get(0),
        )
        .optional()
        .ok()?;
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

/// The files the tab's session — or `subagent`'s — changed, from its
/// completed edit tool parts (`services::agent_changes`): the newest
/// [`CHANGE_TAIL`] such parts, the last `limit` changes of those.
pub fn session_changes(
    db: &Path,
    directory: &str,
    since: Option<i64>,
    subagent: Option<&str>,
    version: Option<&str>,
    limit: usize,
) -> Option<AgentChanges> {
    let conn = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    let session = match tab_session(&conn, directory, since, subagent)? {
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
                .collect()
        }
        _ => Vec::new(),
    }
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

        let t = session_transcript(&db, dir, None, None, None, 120).unwrap();
        assert!(t.available);
        assert_eq!(kinds(&t), vec![("prompt", "fix the tests"), ("answer", "Let me look."), ("answer", "Fixed.")]);
        assert_eq!(t.entries[0].at.as_deref(), Some("1970-01-01T00:00:01.000Z"));
        assert_eq!(t.entries[2].at.as_deref(), Some("1970-01-01T00:00:03.000Z"));
        assert!(!t.truncated);
    }

    #[test]
    fn a_streaming_answer_waits_until_its_part_is_finished() {
        let (db, conn) = store();
        session(&conn, "s", None, "/p", 1, None);
        message(&conn, "m1", "s", 1_000, serde_json::json!({"role": "assistant", "time": {"created": 1_000}}));
        part(&conn, "p1", "m1", "s", 1_001, serde_json::json!({"type": "text", "text": "Done part.", "time": {"start": 1_001, "end": 1_050}}));
        part(&conn, "p2", "m1", "s", 1_100, serde_json::json!({"type": "text", "text": "Still wri", "time": {"start": 1_100}}));
        let t = session_transcript(&db, "/p", None, None, None, 120).unwrap();
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
        let t = session_transcript(&db, "/p", None, None, None, 120).unwrap();
        assert!(t.available);
        assert!(t.entries.is_empty());
    }

    #[test]
    fn a_folder_with_no_session_is_a_fresh_empty_chat_and_a_missing_store_is_none() {
        let (db, _conn) = store();
        let t = session_transcript(&db, "/nothing/here", None, None, None, 120).unwrap();
        assert!(t.available && t.entries.is_empty());
        assert!(session_transcript(&db.with_file_name("absent.db"), "/p", None, None, None, 120).is_none());
    }

    #[test]
    fn a_fresh_tab_reads_only_sessions_created_since_its_launch() {
        let (db, conn) = store();
        session(&conn, "ses_before", None, "/p", 100, None);
        message(&conn, "m0", "ses_before", 100, serde_json::json!({"role": "user"}));
        part(&conn, "p0", "m0", "ses_before", 100, serde_json::json!({"type": "text", "text": "yesterday's chat"}));
        let fresh = session_transcript(&db, "/p", Some(500), None, None, 120).unwrap();
        assert!(fresh.available && fresh.entries.is_empty());
        session(&conn, "ses_mine", None, "/p", 600, None);
        message(&conn, "m1", "ses_mine", 600, serde_json::json!({"role": "user"}));
        part(&conn, "p1", "m1", "ses_mine", 600, serde_json::json!({"type": "text", "text": "new question"}));
        let mine = session_transcript(&db, "/p", Some(500), None, fresh.version.as_deref(), 120).unwrap();
        assert_eq!(kinds(&mine), vec![("prompt", "new question")]);
    }

    #[test]
    fn an_unchanged_session_answers_unchanged_and_a_new_part_moves_the_version() {
        let (db, conn) = store();
        session(&conn, "s", None, "/p", 1, None);
        message(&conn, "m1", "s", 1_000, serde_json::json!({"role": "user"}));
        part(&conn, "p1", "m1", "s", 1_000, serde_json::json!({"type": "text", "text": "hi"}));
        let first = session_transcript(&db, "/p", None, None, None, 120).unwrap();
        let again = session_transcript(&db, "/p", None, None, first.version.as_deref(), 120).unwrap();
        assert!(again.unchanged && again.entries.is_empty());
        part(&conn, "p2", "m1", "s", 1_500, serde_json::json!({"type": "text", "text": "more"}));
        let moved = session_transcript(&db, "/p", None, None, first.version.as_deref(), 120).unwrap();
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
        let t = session_transcript(&db, "/p", None, None, None, 2).unwrap();
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

        let t = session_transcript(&db, "/p", None, None, None, 120).unwrap();
        assert_eq!(kinds(&t), vec![("prompt", "map it"), ("agent", "Explore the repo"), ("answer", "Mapped.")]);
        assert_eq!(t.entries[1].role.as_deref(), Some("explore"));
        let token = t.entries[1].subagent.clone().expect("handle");

        let sub = session_transcript(&db, "/p", None, Some(&token), None, 120).unwrap();
        assert_eq!(kinds(&sub), vec![("prompt", "look at src"), ("answer", "src holds the app.")]);
        // Deeper descendants read too; another folder's are not this tab's.
        assert!(session_transcript(&db, "/p", None, Some(&subagent_token("grandkid")), None, 120).unwrap().available);
        let foreign = session_transcript(&db, "/p", None, Some(&subagent_token("strangers-kid")), None, 120).unwrap();
        assert_eq!(foreign.reason.as_deref(), Some("no_subagent"));
    }

    #[test]
    fn a_child_title_loses_the_suffix_opencode_appends() {
        assert_eq!(task_of("Explore codebase structure (@explore subagent)"), "Explore codebase structure");
        assert_eq!(task_of("Plain title"), "Plain title");
        assert_eq!(task_of("(@x subagent)"), "(@x subagent)");
    }
}
