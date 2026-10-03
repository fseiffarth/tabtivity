//! SQLite database browser backend (Dev C).
//!
//! Read-only inspection of a `.db`/`.sqlite`/`.sqlite3` file: list its user
//! tables and page through a single table's rows. Opens the database in
//! read-only mode (never mutates the file) and bounds every result so a huge
//! table can't exhaust memory. All values are stringified for transport to the
//! webview table grid.

use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};
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

/// The query that enumerates the user tables/views we're willing to expose.
/// Reused by `sqlite_tables` and by `sqlite_page` to validate the table name.
const LIST_TABLES_SQL: &str = "SELECT name FROM sqlite_master \
     WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name";

/// Open the database file strictly read-only — never create or modify it.
fn open_readonly(path: &str) -> Result<Connection, String> {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| e.to_string())
}

/// Run `LIST_TABLES_SQL` against an open connection, returning the names.
fn list_tables(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn.prepare(LIST_TABLES_SQL).map_err(|e| e.to_string())?;
    let names = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<String>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(names)
}

/// Quote an identifier for safe interpolation: wrap in double quotes and double
/// any embedded double quote. Only ever applied to a name already validated
/// against the allow-list, but quoting defensively keeps the SQL well-formed.
fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Stringify one cell value for transport to the webview grid.
fn stringify(value: ValueRef<'_>) -> String {
    match value {
        ValueRef::Null => String::new(),
        ValueRef::Integer(i) => i.to_string(),
        ValueRef::Real(f) => f.to_string(),
        ValueRef::Text(bytes) => String::from_utf8_lossy(bytes).into_owned(),
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

/// List the user tables (and views) in a SQLite database file, sorted by name.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn sqlite_tables(path: String) -> Result<Vec<String>, String> {
    run_off_thread(move || sqlite_tables_blocking(path)).await
}

pub fn sqlite_tables_blocking(path: String) -> Result<Vec<String>, String> {
    let conn = open_readonly(&path)?;
    list_tables(&conn)
}

/// Read up to `limit` rows from `table`, starting at `offset`.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn sqlite_page(
    path: String,
    table: String,
    limit: u32,
    offset: u32,
) -> Result<SqlitePage, String> {
    run_off_thread(move || sqlite_page_blocking(path, table, limit, offset)).await
}

pub fn sqlite_page_blocking(
    path: String,
    table: String,
    limit: u32,
    offset: u32,
) -> Result<SqlitePage, String> {
    let conn = open_readonly(&path)?;

    // SECURITY: a table identifier cannot be a bound parameter, so validate it
    // against the allow-list of real tables/views before interpolating. This
    // blocks SQL injection through the `table` argument.
    let allowed = list_tables(&conn)?;
    if !allowed.iter().any(|t| t == &table) {
        return Err(format!("unknown table: {table}"));
    }
    let quoted = quote_ident(&table);

    // Total row count of the table (drives the UI's "rows X–Y of N").
    let total: i64 = conn
        .query_row(&format!("SELECT COUNT(*) FROM {quoted}"), [], |row| {
            row.get(0)
        })
        .map_err(|e| e.to_string())?;

    let sql = format!("SELECT * FROM {quoted} LIMIT ?1 OFFSET ?2");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    // Column names must be cloned before stepping (they borrow the statement).
    let columns: Vec<String> = stmt.column_names().iter().map(|c| c.to_string()).collect();
    let col_count = columns.len();

    let mut query_rows = stmt
        .query(rusqlite::params![limit, offset])
        .map_err(|e| e.to_string())?;
    let mut rows: Vec<Vec<String>> = Vec::new();
    while let Some(row) = query_rows.next().map_err(|e| e.to_string())? {
        let mut cells = Vec::with_capacity(col_count);
        for i in 0..col_count {
            let value = row.get_ref(i).map_err(|e| e.to_string())?;
            cells.push(stringify(value));
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
}
