//! Codex's own thread store: `~/.codex/state_<n>.sqlite`.
//!
//! Codex used to keep every conversation as a JSONL transcript under
//! `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl`, and Tabtivity
//! read the model tag beside an agent tab out of that file's tail. Codex
//! 0.153.4 could keep a thread in SQLite without writing its named rollout.
//! Codex 0.160.1 writes rollouts again, but the store remains needed when a
//! thread has no file and to check whether a retained rollout was archived.
//!
//! The row's own `model` column is the same fact by another route — the model
//! that thread is running — so that is what this module reads, as the fallback
//! for when there is no rollout to read.
//!
//! Everything here is read-only and best-effort. The schema is Codex's, not
//! ours, and it moves: a release that renames the file, the table or the column
//! yields `None` and a tab with no tag, never an error and never a guess.

use std::path::{Path, PathBuf};

use crate::services::agent_session::clean_model_name;

/// The store the scope's Codex is writing now (`<scope home>/.codex`), or
/// `None` when there is none to read. Codex bumps the file's suffix when it
/// breaks the schema (`state_5.sqlite` today), leaving the older ones in
/// place, so the highest number is the live one. A plain `state.sqlite`
/// counts as zero, below every numbered store.
pub fn state_db_for(scope_id: Option<&str>) -> Option<PathBuf> {
    state_db_in(&crate::services::agent_home::scope_home(scope_id).join(".codex"))
}

/// The stores that can own a scope's threads: its own agent home's. Kept as a
/// list so a caller reads them the way it did when a host store was a
/// fallback too.
pub fn state_dbs(scope_id: Option<&str>) -> Vec<PathBuf> {
    state_db_for(scope_id).into_iter().collect()
}

/// Testable core of [`state_db_for`] against an explicit `.codex` dir.
pub(crate) fn state_db_in(dir: &Path) -> Option<PathBuf> {
    newest_db_in(dir, "state")
}

/// The scope's goal store (`<scope home>/.codex/goals_<n>.sqlite`, Codex
/// 0.153+), numbered the way the thread store is.
pub fn goals_db_for(scope_id: Option<&str>) -> Option<PathBuf> {
    newest_db_in(&crate::services::agent_home::scope_home(scope_id).join(".codex"), "goals")
}

/// The highest-numbered `<stem>_<n>.sqlite` (a bare `<stem>.sqlite` is zero) in `dir`.
fn newest_db_in(dir: &Path, stem: &str) -> Option<PathBuf> {
    let mut best: Option<(u32, PathBuf)> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Some(rest) = name.strip_prefix(stem).and_then(|r| r.strip_suffix(".sqlite")) else {
            continue;
        };
        // "state.sqlite" → 0; "state_5.sqlite" → 5; anything else is not a store.
        let version = match rest.strip_prefix('_') {
            Some(digits) => match digits.parse::<u32>() {
                Ok(n) => n,
                Err(_) => continue,
            },
            None if rest.is_empty() => 0,
            None => continue,
        };
        if best.as_ref().is_none_or(|(seen, _)| version > *seen) {
            best = Some((version, path));
        }
    }
    best.map(|(_, path)| path)
}

/// Whether the store at `db` still holds the thread `thread_id`.
///
/// This is the successor to walking `~/.codex/sessions` for a
/// `rollout-*-<uuid>.jsonl`: 0.153.4 could record the thread here without a
/// rollout file, so the walk found nothing and a Codex tab fell
/// back to a fresh session on relaunch (see
/// [`crate::services::agent_session::codex_session_exists`]).
///
/// An **archived** thread does not count. Archiving is the user saying that
/// conversation is done; resuming it would be the one case where answering
/// "yes, it exists" is worse than starting fresh.
pub fn thread_exists(db: &Path, thread_id: &str) -> bool {
    thread_archived(db, thread_id) == Some(false)
}

/// The store's archive verdict for one thread. `None` means no row or an
/// unreadable store; a legacy rollout may still be the only record then.
pub(crate) fn thread_archived(db: &Path, thread_id: &str) -> Option<bool> {
    use rusqlite::{Connection, OpenFlags, OptionalExtension};

    let conn = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    let archived: Option<i64> = conn
        .query_row("SELECT archived FROM threads WHERE id = ?1", [thread_id], |row| row.get(0))
        .optional()
        .ok()?;
    archived.map(|value| value != 0)
}

/// The model the thread `thread_id` is running, per the store at `db`.
///
/// Opened strictly read-only: Codex is writing this database while we read it,
/// and the one thing that must never happen is Tabtivity touching another
/// application's state. A locked, missing, or differently-shaped store is not
/// an error here — it is simply no tag.
pub fn thread_model(db: &Path, thread_id: &str) -> Option<String> {
    use rusqlite::{Connection, OpenFlags};

    let conn = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    let model: Option<String> = conn
        .query_row("SELECT model FROM threads WHERE id = ?1", [thread_id], |row| {
            row.get(0)
        })
        .ok()?;
    clean_model_name(&model?)
}

/// Whether the thread `thread_id` is pursuing a `/goal`, per the goal store at
/// `db`: its row says `active` — not paused, blocked, out of budget or
/// complete. A thread with no row has no goal. `None` when the store cannot
/// be read or has another shape.
pub fn thread_goal_active(db: &Path, thread_id: &str) -> Option<bool> {
    use rusqlite::{Connection, OpenFlags, OptionalExtension};

    let conn = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    let status: Option<String> = conn
        .query_row("SELECT status FROM thread_goals WHERE thread_id = ?1", [thread_id], |row| row.get(0))
        .optional()
        .ok()?;
    Some(status.as_deref() == Some("active"))
}

/// A thread another thread spawned: one of Codex's subagents.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnedThread {
    pub id: String,
    /// What it was sent to do: its first message, else its title.
    pub task: String,
    /// The role it was spawned as, and the name Codex gave it.
    pub role: Option<String>,
    pub nickname: Option<String>,
    /// When it was created, epoch ms.
    pub created_ms: Option<i64>,
    /// The rollout its row names — a path the caller checks before reading.
    pub rollout_path: Option<String>,
}

/// The most spawned threads read for one parent, or one tree.
const MAX_SPAWNED: i64 = 500;

/// The threads `parent` spawned, oldest first, per the store at `db`: its
/// `thread_spawn_edges`, each joined to its `threads` row. A store without
/// the table (a release before subagents) has none.
pub fn spawned_threads(db: &Path, parent: &str) -> Vec<SpawnedThread> {
    query_spawned(
        db,
        "SELECT t.id, t.first_user_message, t.title, t.agent_role, t.agent_nickname,
                t.created_at_ms, t.created_at, t.rollout_path
           FROM thread_spawn_edges e JOIN threads t ON t.id = e.child_thread_id
          WHERE e.parent_thread_id = ?1
          ORDER BY coalesce(t.created_at_ms, t.created_at * 1000), t.id LIMIT ?2",
        rusqlite::params![parent, MAX_SPAWNED],
    )
}

/// Every thread under `root` — the threads it spawned, theirs, and so on to
/// `depth` levels — per the store at `db`.
pub fn descendant_threads(db: &Path, root: &str, depth: usize) -> Vec<SpawnedThread> {
    query_spawned(
        db,
        "WITH RECURSIVE tree(id, depth) AS (
             SELECT child_thread_id, 1 FROM thread_spawn_edges WHERE parent_thread_id = ?1
             UNION
             SELECT e.child_thread_id, tree.depth + 1
               FROM thread_spawn_edges e JOIN tree ON e.parent_thread_id = tree.id
              WHERE tree.depth < ?2)
         SELECT t.id, t.first_user_message, t.title, t.agent_role, t.agent_nickname,
                t.created_at_ms, t.created_at, t.rollout_path
           FROM tree JOIN threads t ON t.id = tree.id LIMIT ?3",
        rusqlite::params![root, depth as i64, MAX_SPAWNED],
    )
}

fn query_spawned(db: &Path, sql: &str, params: impl rusqlite::Params) -> Vec<SpawnedThread> {
    use rusqlite::{Connection, OpenFlags};

    let Ok(conn) = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return Vec::new();
    };
    let Ok(mut stmt) = conn.prepare(sql) else {
        return Vec::new();
    };
    let text = |value: Option<String>| value.filter(|v| !v.trim().is_empty());
    stmt.query_map(params, |row| {
        let first: Option<String> = row.get(1)?;
        let title: Option<String> = row.get(2)?;
        let created_ms: Option<i64> = row.get(5)?;
        let created_s: Option<i64> = row.get(6)?;
        Ok(SpawnedThread {
            id: row.get(0)?,
            task: text(first).or(text(title)).unwrap_or_default(),
            role: text(row.get(3)?),
            nickname: text(row.get(4)?),
            created_ms: created_ms.or(created_s.map(|s| s * 1000)),
            rollout_path: text(row.get(7)?),
        })
    })
    .map(|rows| rows.filter_map(Result::ok).collect())
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_tmp(prefix: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("{prefix}-{}-{n}", std::process::id()));
        // Pids are reused: a store left by an earlier run must not survive into
        // this one, or the `CREATE TABLE`s below fail on the second run.
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Write a store shaped like Codex's, holding `rows` of (id, model).
    fn store_with(path: &Path, rows: &[(&str, Option<&str>)]) {
        let live: Vec<(&str, Option<&str>, bool)> =
            rows.iter().map(|(id, model)| (*id, *model, false)).collect();
        store_with_archived(path, &live);
    }

    /// As [`store_with`], with each row's `archived` flag spelled out.
    fn store_with_archived(path: &Path, rows: &[(&str, Option<&str>, bool)]) {
        let conn = rusqlite::Connection::open(path).unwrap();
        conn.execute(
            "CREATE TABLE threads (id TEXT PRIMARY KEY, model TEXT, archived INTEGER NOT NULL DEFAULT 0)",
            [],
        )
        .unwrap();
        for (id, model, archived) in rows {
            conn.execute(
                "INSERT INTO threads (id, model, archived) VALUES (?1, ?2, ?3)",
                (id, model, i64::from(*archived)),
            )
            .unwrap();
        }
    }

    #[test]
    fn picks_the_highest_numbered_store() {
        let dir = unique_tmp(concat!(crate::app_slug!(), "-codex-store"));
        for name in ["state.sqlite", "state_2.sqlite", "state_10.sqlite", "logs_9.sqlite"] {
            std::fs::write(dir.join(name), b"").unwrap();
        }
        // 10 > 2 numerically; sorted as text "state_10" would lose to "state_2".
        assert_eq!(state_db_in(&dir), Some(dir.join("state_10.sqlite")));
    }

    #[test]
    fn a_thread_pursues_its_goal_only_while_the_row_says_active() {
        let dir = unique_tmp(concat!(crate::app_slug!(), "-codex-goals"));
        std::fs::write(dir.join("goals_1.sqlite"), b"").unwrap();
        let db = newest_db_in(&dir, "goals").unwrap();
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute("CREATE TABLE thread_goals (thread_id TEXT PRIMARY KEY, objective TEXT, status TEXT)", []).unwrap();
        conn.execute("INSERT INTO thread_goals VALUES ('run', 'x', 'active'), ('stuck', 'y', 'blocked')", []).unwrap();
        assert_eq!(thread_goal_active(&db, "run"), Some(true));
        assert_eq!(thread_goal_active(&db, "stuck"), Some(false));
        assert_eq!(thread_goal_active(&db, "none"), Some(false));
        // Another shape of store is no answer, not "no goal".
        assert_eq!(thread_goal_active(&dir.join("state_1.sqlite"), "run"), None);
    }

    #[test]
    fn unnumbered_store_is_the_oldest_not_the_newest() {
        let dir = unique_tmp(concat!(crate::app_slug!(), "-codex-store"));
        std::fs::write(dir.join("state.sqlite"), b"").unwrap();
        assert_eq!(state_db_in(&dir), Some(dir.join("state.sqlite")));
        std::fs::write(dir.join("state_1.sqlite"), b"").unwrap();
        assert_eq!(state_db_in(&dir), Some(dir.join("state_1.sqlite")));
    }

    #[test]
    fn no_codex_dir_is_no_store() {
        let dir = unique_tmp(concat!(crate::app_slug!(), "-codex-store"));
        assert_eq!(state_db_in(&dir.join("nope")), None);
    }

    #[test]
    fn reads_a_threads_model() {
        let dir = unique_tmp(concat!(crate::app_slug!(), "-codex-store"));
        let db = dir.join("state_5.sqlite");
        store_with(
            &db,
            &[
                ("01a07c18-3a25-7fa1-9ac4-74fa84d4e12a", Some("gpt-5-codex")),
                ("01a07b6f-8952-7280-8848-c2c7501b3329", None),
                ("01a07b65-415e-7423-a42f-5e229ed5ffac", Some("  not a model  ")),
            ],
        );
        assert_eq!(
            thread_model(&db, "01a07c18-3a25-7fa1-9ac4-74fa84d4e12a").as_deref(),
            Some("gpt-5-codex")
        );
        // A thread with no model yet, a name that is not one, and a thread the
        // store has never heard of: no tag, three times over.
        assert_eq!(thread_model(&db, "01a07b6f-8952-7280-8848-c2c7501b3329"), None);
        assert_eq!(thread_model(&db, "01a07b65-415e-7423-a42f-5e229ed5ffac"), None);
        assert_eq!(thread_model(&db, "no-such-thread"), None);
    }

    #[test]
    fn a_live_thread_exists_an_archived_or_unknown_one_does_not() {
        let dir = unique_tmp(concat!(crate::app_slug!(), "-codex-store"));
        let db = dir.join("state_5.sqlite");
        store_with_archived(
            &db,
            &[
                ("01a07c18-3a25-7fa1-9ac4-74fa84d4e12a", Some("gpt-5-codex"), false),
                // No model recorded yet still counts: the tab has a thread to resume.
                ("01a07b6f-8952-7280-8848-c2c7501b3329", None, false),
                ("01a07b65-415e-7423-a42f-5e229ed5ffac", Some("gpt-5-codex"), true),
            ],
        );
        assert!(thread_exists(&db, "01a07c18-3a25-7fa1-9ac4-74fa84d4e12a"));
        assert!(thread_exists(&db, "01a07b6f-8952-7280-8848-c2c7501b3329"));
        assert!(!thread_exists(&db, "01a07b65-415e-7423-a42f-5e229ed5ffac"));
        assert!(!thread_exists(&db, "no-such-thread"));
    }

    #[test]
    fn a_store_we_cannot_read_holds_no_thread() {
        let dir = unique_tmp(concat!(crate::app_slug!(), "-codex-store"));
        let junk = dir.join("state_6.sqlite");
        std::fs::write(&junk, b"not a database").unwrap();
        assert!(!thread_exists(&junk, "01a07c18-3a25-7fa1-9ac4-74fa84d4e12a"));
        assert!(!thread_exists(&dir.join("nope.sqlite"), "01a07c18-3a25-7fa1-9ac4-74fa84d4e12a"));
        // A store whose schema moved out from under us: no thread, no panic.
        let other = dir.join("state_7.sqlite");
        rusqlite::Connection::open(&other)
            .unwrap()
            .execute("CREATE TABLE logs (id TEXT)", [])
            .unwrap();
        assert!(!thread_exists(&other, "01a07c18-3a25-7fa1-9ac4-74fa84d4e12a"));
    }

    #[test]
    fn a_store_without_the_schema_we_know_is_no_tag() {
        let dir = unique_tmp(concat!(crate::app_slug!(), "-codex-store"));
        let db = dir.join("state_5.sqlite");
        rusqlite::Connection::open(&db)
            .unwrap()
            .execute("CREATE TABLE logs (id TEXT)", [])
            .unwrap();
        assert_eq!(thread_model(&db, "01a07c18-3a25-7fa1-9ac4-74fa84d4e12a"), None);
        // Not a database at all.
        let junk = dir.join("state_6.sqlite");
        std::fs::write(&junk, b"not a database").unwrap();
        assert_eq!(thread_model(&junk, "01a07c18-3a25-7fa1-9ac4-74fa84d4e12a"), None);
    }
}
