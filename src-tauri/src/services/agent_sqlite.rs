//! The one opener for a SQLite store an agent wrote in its own home
//! (OpenCode's `opencode.db`, Codex's `state_<n>.sqlite`, Antigravity's
//! conversation databases). The file is attacker-controlled: it is reached by
//! a `HomeDir` walk (no link at any component), must be a regular file on a
//! non-blocking handle (a planted FIFO would park the reader inside SQLite's
//! `open()`), is opened `NOFOLLOW` and read-only, and the connection gets the
//! guards a hostile schema needs: untrusted schema, defensive mode, a length
//! limit, a progress deadline, and refusal of a view standing in for a table
//! the caller reads. AppHandle-free and unit-testable.

use std::path::Path;
use std::time::{Duration, Instant};

use rusqlite::{config::DbConfig, limits::Limit, Connection, OpenFlags};

use crate::services::home_io::HomeFile;

/// What one connection may spend: queries past `deadline` from the open are
/// interrupted, one value past `max_len` bytes is refused.
#[derive(Clone, Copy)]
pub struct Limits {
    pub deadline: Duration,
    pub max_len: i32,
    pub busy: Duration,
}

impl Limits {
    /// A conversation store's reads: a handful of indexed queries.
    pub const STORE: Limits = Limits {
        deadline: Duration::from_secs(5),
        max_len: 64 * 1024 * 1024,
        busy: Duration::from_secs(1),
    };
}

/// Open `file` read-only. `tables` are the names the caller will query: any
/// of them present as something other than a table (a view is a stored query
/// that runs without a deadline of its own) refuses the store.
pub fn open_read(file: &HomeFile, limits: Limits, tables: &[&str]) -> Option<Connection> {
    file.open_read()?;
    let conn = Connection::open_with_flags(file.path(), OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW).ok()?;
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_TRUSTED_SCHEMA, false).ok()?;
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true).ok()?;
    conn.set_limit(Limit::SQLITE_LIMIT_LENGTH, limits.max_len).ok()?;
    conn.busy_timeout(limits.busy).ok()?;
    let deadline = Instant::now() + limits.deadline;
    conn.progress_handler(1000, Some(move || Instant::now() >= deadline)).ok()?;
    only_tables(&conn, tables).then_some(conn)
}

/// [`open_read`] for a store at `db`, `depth` components below the home it is
/// in (`.codex/state_5.sqlite` is 2). The home is resolved once by name
/// (SQLite's `NOFOLLOW` refuses a link anywhere in the path, a symlinked temp
/// dir included); everything below it is walked by handle.
pub fn open_below(db: &Path, depth: usize, tables: &[&str]) -> Option<Connection> {
    open_read(&HomeFile::open_below(db, depth)?, Limits::STORE, tables)
}

fn only_tables(conn: &Connection, tables: &[&str]) -> bool {
    let Ok(mut stmt) = conn.prepare("SELECT type FROM sqlite_master WHERE name = ?1 AND type != 'index'") else {
        return false;
    };
    tables.iter().all(|name| {
        stmt.query_map([name], |row| row.get::<_, String>(0))
            .map(|rows| rows.filter_map(Result::ok).all(|kind| kind == "table"))
            .unwrap_or(false)
    })
}

/// Run `work` on its own thread and wait at most `wait`: `None` when it did
/// not finish (the thread is left to end on its own). A spawn-time store
/// check that times out counts as no session, never a parked worker.
pub fn bounded<T: Send + 'static>(wait: Duration, work: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .name("agent-store-check".into())
        .spawn(move || {
            let _ = tx.send(work());
        })
        .ok()?;
    rx.recv_timeout(wait).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("{}-agent-sqlite-{tag}-{}", crate::app_slug!(), std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn store(path: &Path, sql: &str) {
        Connection::open(path).unwrap().execute_batch(sql).unwrap();
    }

    #[test]
    fn a_plain_store_opens_and_reads() {
        let home = dir("plain");
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        let db = home.join(".codex").join("state_1.sqlite");
        store(&db, "CREATE TABLE threads (id TEXT); INSERT INTO threads VALUES ('a');");
        let conn = open_below(&db, 2, &["threads"]).unwrap();
        assert_eq!(conn.query_row("SELECT count(*) FROM threads", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        assert!(conn.execute_batch("CREATE TABLE x (y)").is_err(), "read-only");
        assert!(open_below(&home.join(".codex").join("absent.sqlite"), 2, &["threads"]).is_none());
    }

    #[test]
    fn a_view_in_place_of_a_table_is_refused() {
        let home = dir("view");
        let db = home.join("state.sqlite");
        store(&db, "CREATE VIEW threads AS WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT i AS id FROM n;");
        assert!(open_below(&db, 1, &["threads"]).is_none());
        assert!(open_below(&db, 1, &["other"]).is_some(), "only the names the caller reads are held to tables");
    }

    #[test]
    fn a_runaway_query_is_interrupted() {
        let home = dir("deadline");
        let db = home.join("state.sqlite");
        store(&db, "CREATE TABLE threads (id TEXT);");
        let limits = Limits { deadline: Duration::from_millis(50), ..Limits::STORE };
        let conn = open_read(&HomeFile::open_existing(&home, "state.sqlite").unwrap(), limits, &["threads"]).unwrap();
        let started = Instant::now();
        let ran = conn.query_row("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT count(*) FROM n", [], |r| r.get::<_, i64>(0));
        assert!(ran.is_err());
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[cfg(unix)]
    #[test]
    fn a_fifo_is_refused_without_blocking() {
        let home = dir("fifo");
        let db = home.join("state.sqlite");
        let c = std::ffi::CString::new(db.to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        assert!(open_below(&db, 1, &["threads"]).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn a_link_at_the_file_or_a_folder_is_refused() {
        let home = dir("link");
        let real = home.join("real.sqlite");
        store(&real, "CREATE TABLE threads (id TEXT);");
        std::os::unix::fs::symlink(&real, home.join("state.sqlite")).unwrap();
        assert!(open_below(&home.join("state.sqlite"), 1, &["threads"]).is_none());

        let other = dir("link-target");
        store(&other.join("state.sqlite"), "CREATE TABLE threads (id TEXT);");
        std::os::unix::fs::symlink(&other, home.join(".codex")).unwrap();
        assert!(open_below(&home.join(".codex").join("state.sqlite"), 2, &["threads"]).is_none());
    }

    #[test]
    fn a_timeout_reads_as_nothing() {
        let slow = bounded(Duration::from_millis(20), || std::thread::sleep(Duration::from_millis(300)));
        assert!(slow.is_none());
        assert_eq!(bounded(Duration::from_secs(5), || 7), Some(7));
    }
}
