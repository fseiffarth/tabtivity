//! SQLite database browser backend (Dev C).
//!
//! Read-only inspection of a `.db`/`.sqlite`/`.sqlite3` file: list its user
//! tables and page through a single table's rows. Opens the database in
//! read-only mode (never mutates the file) and bounds every result so a huge
//! table can't exhaust memory. All values are stringified for transport to the
//! webview table grid.
//!
//! The file is attacker-controlled, and so is the SQL its views run: a
//! recursive view never ends, a computed column can ask for a gigabyte. Every
//! connection therefore runs under [`guard`]: a deadline enforced by a progress
//! handler, `SQLITE_LIMIT_LENGTH` and friends, `trusted_schema=OFF` and
//! `query_only`. The path is confined to the viewer's project roots first.

use std::path::Path;
use std::time::{Duration, Instant};

use rusqlite::limits::Limit;
use rusqlite::types::ValueRef;
use rusqlite::{Connection, ErrorCode, OpenFlags};
use serde::Serialize;

/// One page of rows from a table, plus its column names.
#[derive(Debug, Clone, Serialize)]
pub struct SqlitePage {
    pub columns: Vec<String>,
    /// Each row is a vector of stringified cell values, column-aligned.
    pub rows: Vec<Vec<String>>,
    /// Total row count of the table (so the UI can show "showing N of M").
    pub total: i64,
}

/// A query ran past [`DEADLINE`] and was interrupted.
pub const ERR_TIMEOUT: &str = "viewer-limit:sqlite-timeout";
/// A value or the page passed the size limits.
pub const ERR_TOO_LARGE: &str = "viewer-limit:sqlite-too-large";

/// Wall time one command's statements may run, together.
const DEADLINE: Duration = Duration::from_secs(5);
/// VM steps between deadline checks.
const PROGRESS_OPS: i32 = 1000;
/// Largest string or blob SQLite will build or read.
const MAX_LENGTH: i32 = 16 * 1024 * 1024;
/// Longest SQL statement. The schema's own `CREATE` statements are parsed under
/// it when the file opens, and one over it makes the *whole* database
/// unreadable ("malformed database schema"), so it is no tighter than
/// [`MAX_LENGTH`], which already bounds the `sql` text a schema row can hold.
const MAX_SQL_LENGTH: i32 = MAX_LENGTH;
/// Deepest expression tree: SQLite's own default (`SQLITE_MAX_EXPR_DEPTH`),
/// set explicitly. Like [`MAX_SQL_LENGTH`] it applies to the schema parse, and
/// an ordinary view with a long `a OR b OR …` chain nests one level per term,
/// so a tighter value refused whole databases.
const MAX_EXPR_DEPTH: i32 = 1000;
/// Rows one page may ask for.
const MAX_PAGE_ROWS: u32 = 1000;
/// One cell's text, in bytes, as sent to the grid.
const MAX_CELL_BYTES: usize = 4 * 1024;
/// All cell text of one page, in bytes.
const MAX_PAGE_BYTES: usize = 32 * 1024 * 1024;

/// The query that enumerates the user tables/views we're willing to expose.
/// Reused by `sqlite_tables` and by `sqlite_page` to validate the table name.
const LIST_TABLES_SQL: &str = "SELECT name FROM sqlite_master \
     WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name";

/// Open the database file strictly read-only — never create or modify it —
/// under [`guard`] with `budget`.
fn open_readonly(path: &str, budget: Duration) -> Result<Connection, String> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(sql_err)?;
    guard(&conn, budget)?;
    Ok(conn)
}

/// Bound everything `conn` runs from now on: statements stop once `budget` has
/// passed (the schema parse, `COUNT(*)` on a view and the page alike), values
/// past [`MAX_LENGTH`] are an error, and the file's schema may call only
/// innocuous functions.
fn guard(conn: &Connection, budget: Duration) -> Result<(), String> {
    let deadline = Instant::now() + budget;
    conn.progress_handler(PROGRESS_OPS, Some(move || Instant::now() >= deadline))
        .map_err(sql_err)?;
    for (limit, value) in [
        (Limit::SQLITE_LIMIT_LENGTH, MAX_LENGTH),
        (Limit::SQLITE_LIMIT_SQL_LENGTH, MAX_SQL_LENGTH),
        (Limit::SQLITE_LIMIT_EXPR_DEPTH, MAX_EXPR_DEPTH),
    ] {
        conn.set_limit(limit, value).map_err(sql_err)?;
    }
    conn.pragma_update(None, "trusted_schema", false)
        .map_err(sql_err)?;
    conn.pragma_update(None, "query_only", true).map_err(sql_err)?;
    Ok(())
}

/// An interrupted statement reads as [`ERR_TIMEOUT`], an oversized value as
/// [`ERR_TOO_LARGE`]; anything else keeps SQLite's own message.
fn sql_err(e: rusqlite::Error) -> String {
    match e.sqlite_error_code() {
        Some(ErrorCode::OperationInterrupted) => ERR_TIMEOUT.to_string(),
        Some(ErrorCode::TooBig) => ERR_TOO_LARGE.to_string(),
        _ => e.to_string(),
    }
}

/// Run `LIST_TABLES_SQL` against an open connection, returning the names.
fn list_tables(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn.prepare(LIST_TABLES_SQL).map_err(sql_err)?;
    let names = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(sql_err)?
        .collect::<Result<Vec<String>, _>>()
        .map_err(sql_err)?;
    Ok(names)
}

/// Quote an identifier for safe interpolation: wrap in double quotes and double
/// any embedded double quote. Only ever applied to a name already validated
/// against the allow-list, but quoting defensively keeps the SQL well-formed.
fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Stringify one cell value for transport to the webview grid. Text is cut to
/// [`MAX_CELL_BYTES`] (on a character boundary, marked with `…`).
fn stringify(value: ValueRef<'_>) -> String {
    match value {
        ValueRef::Null => String::new(),
        ValueRef::Integer(i) => i.to_string(),
        ValueRef::Real(f) => f.to_string(),
        ValueRef::Text(bytes) => {
            if bytes.len() <= MAX_CELL_BYTES {
                String::from_utf8_lossy(bytes).into_owned()
            } else {
                let mut text = String::from_utf8_lossy(&bytes[..MAX_CELL_BYTES]).into_owned();
                // A character split by the cut decodes as U+FFFD; drop it.
                if text.ends_with('\u{FFFD}') {
                    text.pop();
                }
                text.push('…');
                text
            }
        }
        ValueRef::Blob(bytes) => format!("<blob {} bytes>", bytes.len()),
    }
}

/// Offload a blocking SQLite read to a worker thread. An arbitrary dropped
/// `.db` — possibly on a network mount — is opened and queried synchronously,
/// which run inline on the main thread is the freeze class `commands::git`'s
/// `run_off_thread` doc describes. The sync bodies stay directly unit-testable.
async fn run_off_thread<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("sqlite task failed: {e}"))?
}

/// The path must sit in the viewer's project roots, as for every `fs.rs`
/// reader.
fn confine(path: &str, project_id: Option<&str>) -> Result<(), String> {
    crate::commands::fs::confine_project_path(Path::new(path), project_id)
}

/// List the user tables (and views) in a SQLite database file, sorted by name.
#[tauri::command]
pub async fn sqlite_tables(path: String, project_id: Option<String>) -> Result<Vec<String>, String> {
    run_off_thread(move || {
        confine(&path, project_id.as_deref())?;
        sqlite_tables_blocking(path)
    })
    .await
}

pub fn sqlite_tables_blocking(path: String) -> Result<Vec<String>, String> {
    let conn = open_readonly(&path, DEADLINE)?;
    list_tables(&conn)
}

/// Read up to `limit` rows (at most [`MAX_PAGE_ROWS`]) from `table`, starting
/// at `offset`.
#[tauri::command]
pub async fn sqlite_page(
    path: String,
    table: String,
    limit: u32,
    offset: u32,
    project_id: Option<String>,
) -> Result<SqlitePage, String> {
    run_off_thread(move || {
        confine(&path, project_id.as_deref())?;
        sqlite_page_blocking(path, table, limit, offset)
    })
    .await
}

pub fn sqlite_page_blocking(
    path: String,
    table: String,
    limit: u32,
    offset: u32,
) -> Result<SqlitePage, String> {
    sqlite_page_within(&path, &table, limit, offset, DEADLINE)
}

fn sqlite_page_within(
    path: &str,
    table: &str,
    limit: u32,
    offset: u32,
    budget: Duration,
) -> Result<SqlitePage, String> {
    let conn = open_readonly(path, budget)?;
    let limit = limit.min(MAX_PAGE_ROWS);

    // SECURITY: a table identifier cannot be a bound parameter, so validate it
    // against the allow-list of real tables/views before interpolating. This
    // blocks SQL injection through the `table` argument.
    let allowed = list_tables(&conn)?;
    if !allowed.iter().any(|t| t == table) {
        return Err(format!("unknown table: {table}"));
    }
    let quoted = quote_ident(table);

    // Total row count of the table (drives the UI's "rows X–Y of N"). On a
    // view this runs the view's SQL, under the same deadline as the page.
    let total: i64 = conn
        .query_row(&format!("SELECT COUNT(*) FROM {quoted}"), [], |row| {
            row.get(0)
        })
        .map_err(sql_err)?;

    let sql = format!("SELECT * FROM {quoted} LIMIT ?1 OFFSET ?2");
    let mut stmt = conn.prepare(&sql).map_err(sql_err)?;
    // Column names must be cloned before stepping (they borrow the statement).
    let columns: Vec<String> = stmt.column_names().iter().map(|c| c.to_string()).collect();
    let col_count = columns.len();

    let mut query_rows = stmt
        .query(rusqlite::params![limit, offset])
        .map_err(sql_err)?;
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut page_bytes = 0usize;
    while let Some(row) = query_rows.next().map_err(sql_err)? {
        let mut cells = Vec::with_capacity(col_count);
        for i in 0..col_count {
            let value = row.get_ref(i).map_err(sql_err)?;
            let cell = stringify(value);
            page_bytes += cell.len();
            if page_bytes > MAX_PAGE_BYTES {
                return Err(ERR_TOO_LARGE.to_string());
            }
            cells.push(cell);
        }
        rows.push(cells);
    }

    Ok(SqlitePage {
        columns,
        rows,
        total,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    /// Build a small on-disk SQLite fixture and return its path (kept alive by
    /// the returned `TempDir`).
    fn fixture() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.db");
        let path_str = path.to_string_lossy().into_owned();
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT, score REAL);
             INSERT INTO people (id, name, score) VALUES (1, 'Ada', 9.5);
             INSERT INTO people (id, name, score) VALUES (2, 'Linus', NULL);
             CREATE VIEW high AS SELECT * FROM people WHERE score >= 9.0;",
        )
        .unwrap();
        drop(conn);
        (dir, path_str)
    }

    #[test]
    fn lists_tables_and_views() {
        let (_dir, path) = fixture();
        let tables = sqlite_tables_blocking(path).unwrap();
        // Sorted by name; view + table, no sqlite_* internals.
        assert_eq!(tables, vec!["high".to_string(), "people".to_string()]);
    }

    #[test]
    fn pages_rows_with_columns_and_total() {
        let (_dir, path) = fixture();
        let page = sqlite_page_blocking(path, "people".to_string(), 100, 0).unwrap();
        assert_eq!(page.columns, vec!["id", "name", "score"]);
        assert_eq!(page.total, 2);
        assert_eq!(page.rows.len(), 2);
        assert_eq!(page.rows[0], vec!["1", "Ada", "9.5"]);
        // NULL stringifies to empty; integer/real to their decimal forms.
        assert_eq!(page.rows[1], vec!["2", "Linus", ""]);
    }

    #[test]
    fn paginates_with_limit_and_offset() {
        let (_dir, path) = fixture();
        let page = sqlite_page_blocking(path, "people".to_string(), 1, 1).unwrap();
        assert_eq!(page.total, 2);
        assert_eq!(page.rows.len(), 1);
        assert_eq!(page.rows[0][0], "2");
    }

    #[test]
    fn rejects_unknown_table() {
        let (_dir, path) = fixture();
        let err = sqlite_page_blocking(path, "people; DROP TABLE people".to_string(), 10, 0).unwrap_err();
        assert!(err.contains("unknown table"), "got: {err}");
    }

    #[test]
    fn a_recursive_view_is_interrupted_at_the_deadline() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("loop.db");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE t (x INTEGER);
             CREATE VIEW forever AS
               WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n)
               SELECT i FROM n;",
        )
        .unwrap();
        drop(conn);
        let path = path.to_string_lossy().into_owned();
        let started = Instant::now();
        let err = sqlite_page_within(&path, "forever", 10, 0, Duration::from_millis(300))
            .unwrap_err();
        assert_eq!(err, ERR_TIMEOUT);
        assert!(started.elapsed() < Duration::from_secs(10), "took {:?}", started.elapsed());
    }

    #[test]
    fn a_value_past_the_length_limit_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.db");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(&format!(
            "CREATE VIEW huge AS SELECT zeroblob({}) AS b, randomblob({}) AS r;",
            MAX_LENGTH as i64 + 1,
            MAX_LENGTH as i64 + 1
        ))
        .unwrap();
        drop(conn);
        let err = sqlite_page_blocking(path.to_string_lossy().into_owned(), "huge".into(), 10, 0)
            .unwrap_err();
        assert_eq!(err, ERR_TOO_LARGE);
    }

    #[test]
    fn long_text_is_cut_and_the_page_size_is_clamped() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("text.db");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE t (s TEXT);
             WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1500)
             INSERT INTO t SELECT 'é' || printf('%.10000c', 'x') FROM n;",
        )
        .unwrap();
        drop(conn);
        let page = sqlite_page_blocking(path.to_string_lossy().into_owned(), "t".into(), u32::MAX, 0)
            .unwrap();
        assert_eq!(page.total, 1500);
        assert_eq!(page.rows.len(), MAX_PAGE_ROWS as usize);
        let cell = &page.rows[0][0];
        assert!(cell.starts_with('é') && cell.ends_with('…'), "{}", &cell[..8]);
        assert!(cell.len() <= MAX_CELL_BYTES + '…'.len_utf8());
    }

    #[test]
    fn a_split_character_at_the_cut_is_dropped_not_garbled() {
        let mut text = "x".repeat(MAX_CELL_BYTES - 1);
        text.push('é'); // straddles the cut
        let cell = stringify(ValueRef::Text(text.as_bytes()));
        assert_eq!(cell, format!("{}…", "x".repeat(MAX_CELL_BYTES - 1)));
    }

    /// The limits apply to the schema parse at open: a view an ordinary
    /// database may well hold (a 150-term `OR` chain, a statement over 1 MiB)
    /// must not make its plain tables unreadable.
    #[test]
    fn an_ordinary_deep_or_long_view_keeps_the_database_readable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("views.db");
        let conn = Connection::open(&path).unwrap();
        let ors: Vec<String> = (0..150).map(|i| format!("x = {i}")).collect();
        let list: Vec<String> = (0..250_000).map(|i| i.to_string()).collect();
        conn.execute_batch(&format!(
            "CREATE TABLE t (x INTEGER);
             INSERT INTO t VALUES (3);
             CREATE VIEW deep AS SELECT x FROM t WHERE {};
             CREATE VIEW long AS SELECT x FROM t WHERE x IN ({});",
            ors.join(" OR "),
            list.join(",")
        ))
        .unwrap();
        drop(conn);
        let path = path.to_string_lossy().into_owned();
        assert_eq!(
            sqlite_tables_blocking(path.clone()).unwrap(),
            vec!["deep".to_string(), "long".to_string(), "t".to_string()]
        );
        for table in ["t", "deep", "long"] {
            let page = sqlite_page_blocking(path.clone(), table.into(), 10, 0).unwrap();
            assert_eq!(page.rows, vec![vec!["3".to_string()]], "{table}");
        }
    }

    #[tokio::test]
    async fn a_path_outside_the_scope_is_refused() {
        let (_dir, path) = fixture();
        // No project has this id, so its scope has no roots: fail closed.
        let scope = Some("no-such-project-0c1d".to_string());
        let err = sqlite_tables(path.clone(), scope.clone()).await.unwrap_err();
        assert!(err.contains("not in the current project"), "got: {err}");
        let err = sqlite_page(path, "people".into(), 10, 0, scope).await.unwrap_err();
        assert!(err.contains("not in the current project"), "got: {err}");
    }
}
