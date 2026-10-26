//! Where each agent CLI keeps its conversations inside an agent home, and how
//! to carry them to another machine — the knowledge behind the `agents/`
//! section of a project bundle (`commands::project_transfer`).
//!
//! **An allowlist.** Everything in a home that is not listed in [`ROOTS`] is
//! left behind: hooks, MCP servers, skills, settings and logins are what an
//! agent tab *runs* or signs in with, and a bundle is an untrusted file. A
//! conversation is data the user resumes on purpose. A root that does not
//! exist in a home (a CLI the project never ran, or a release that moved its
//! store) simply contributes nothing.
//!
//! **Databases** ([`DATABASES`], and any `*.db` / `*.sqlite` under a root) are
//! never copied byte for byte: a CLI writes them while an export runs, with
//! the newest pages still in a `-wal` beside the file. They are copied through
//! `home_io` handles into a private scratch dir, opened there (which folds the
//! WAL in), stripped to the tables listed as conversation, and written out with
//! `VACUUM INTO` — one consistent file, no sidecars, and no freed page still
//! holding a deleted row. The strip runs again on import: a crafted bundle must
//! not be able to plant, say, an OpenCode account row that signs the user's
//! agent into somebody else's account. Every connection to such a file runs
//! with triggers off, the defensive flag on and the schema untrusted.
//!
//! **Re-pointing.** The old machine's paths are written all over a
//! conversation: in its records, and in the name of the folder a CLI files a
//! project's sessions under — a slug of the path (Claude, CodeBuddy, Droid),
//! Pi's `--path--` form, or a hash of it (SHA-256: Gemini, Qwen; MD5: Cursor,
//! Kimi). [`repoint_rel`] renames such a folder when its name is exactly the
//! old path's encoding; [`rewrite_file`] and [`rewrite_database`] re-point the
//! paths inside. A file in any other format (Antigravity's protobufs) travels
//! as it is.
//!
//! Layouts verified against a live home on 2026-10-12: Claude, Codex,
//! Copilot, OpenCode, Antigravity. The others come from each CLI's
//! documentation and are tagged untested in the UI.
//!
//! AppHandle-free.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use rusqlite::config::DbConfig;
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;

use crate::services::home_io::{HomeDir, HomeFile};

/// One place a CLI keeps conversations: a home-relative folder or file. A `*`
/// in a segment matches any run of characters within that one name.
pub struct Root {
    pub path: &'static str,
    /// File names under the root that are configuration, not conversation,
    /// and stay behind.
    pub skip_suffixes: &'static [&'static str],
}

const fn root(path: &'static str) -> Root {
    Root { path, skip_suffixes: &[] }
}

pub const ROOTS: &[Root] = &[
    // Claude Code: one folder per cwd of JSONL transcripts. The folder's
    // `memory/` travels with it: instructions in the same trust class as the
    // project tree's own `CLAUDE.md`.
    root(".claude/projects"),
    // Codex: the rollouts, the thread index, and the thread store a resume
    // looks a thread up in (`services::codex_store`). Its
    // `thread_history_<n>.sqlite` is a projection of the rollouts by byte
    // offset, which re-pointing a rollout would invalidate; Codex rebuilds it.
    root(".codex/sessions"),
    root(".codex/archived_sessions"),
    root(".codex/session_index.jsonl"),
    root(".codex/state*.sqlite"),
    // GitHub Copilot CLI.
    root(".copilot/session-state"),
    root(".copilot/session-store.db"),
    root(".copilot/command-history-state.json"),
    // OpenCode (the database, and the JSON storage older releases kept).
    root(".local/share/opencode/opencode.db"),
    root(".local/share/opencode/storage"),
    root(".local/state/opencode/prompt-history.jsonl"),
    // Gemini CLI and Qwen Code: chats and logs only — `tmp/` also holds a
    // downloaded ripgrep binary.
    root(".gemini/projects.json"),
    root(".gemini/tmp/*/chats"),
    root(".gemini/tmp/*/logs.json"),
    root(".gemini/tmp/*/checkpoint-*.json"),
    root(".qwen/projects/*/chats"),
    root(".qwen/tmp/*/chats"),
    root(".qwen/tmp/*/logs.json"),
    root(".qwen/tmp/*/checkpoint-*.json"),
    // Antigravity.
    root(".gemini/antigravity-cli/conversations"),
    root(".gemini/antigravity-cli/brain"),
    root(".gemini/antigravity-cli/annotations"),
    root(".gemini/antigravity-cli/history.jsonl"),
    root(".gemini/antigravity-cli/conversation_summaries.db"),
    // Cursor Agent.
    root(".cursor/chats"),
    // Factory Droid; a session's `.settings.json` holds its autonomy level.
    Root {
        path: ".factory/sessions",
        skip_suffixes: &[".settings.json"],
    },
    // Pi, CodeBuddy, Kimi, Cline, Continue, Goose, Vibe, Auggie.
    root(".pi/agent/sessions"),
    root(".codebuddy/projects"),
    root(".kimi/sessions"),
    root(".cline/data/tasks"),
    root(".cline/data/state/taskHistory.json"),
    root(".continue/sessions"),
    root(".local/share/goose/sessions"),
    root(".vibe/logs/session"),
    root(".vibe/vibehistory"),
    root(".augment/sessions"),
];

/// A CLI database whose tables are known: only `keep` survive a transfer,
/// and each `(table, column)` in `blank` is set to NULL.
pub struct Database {
    pub path: &'static str,
    pub keep: &'static [&'static str],
    pub blank: &'static [(&'static str, &'static str)],
}

pub const DATABASES: &[Database] = &[
    Database {
        path: ".codex/state*.sqlite",
        // Left behind: remote-control enrollments (an account and a relay),
        // config imports, idempotency keys.
        keep: &[
            "_sqlx_migrations",
            "threads",
            "thread_dynamic_tools",
            "thread_spawn_edges",
            "thread_sections",
            "thread_attachments",
            "projects",
            "project_roots",
            "backfill_state",
            "rollout_migration_state",
            "rollout_migration_skipped_rollouts",
        ],
        blank: &[],
    },
    Database {
        path: ".copilot/session-store.db",
        // Left behind: skill proposals and injected context items.
        keep: &[
            "schema_version",
            "sessions",
            "turns",
            "checkpoints",
            "session_files",
            "session_refs",
            "forge_trajectory_events",
            "assistant_usage_events",
            "search_index",
        ],
        blank: &[],
    },
    Database {
        path: ".local/share/opencode/opencode.db",
        // Left behind: accounts, their tokens and credentials, share
        // secrets, and the permissions the user granted.
        keep: &[
            "migration",
            "data_migration",
            "project",
            "project_directory",
            "workspace",
            "session",
            "session_v2",
            "message",
            "part",
            "session_context_epoch",
            "session_input",
            "session_message",
            "instruction_blob",
            "instruction_entry",
            "instruction_state",
            "todo",
            "event",
            "event_sequence",
        ],
        blank: &[("session", "permission"), ("session_v2", "permission")],
    },
    Database {
        path: ".gemini/antigravity-cli/conversation_summaries.db",
        keep: &["conversation_summaries"],
        blank: &[],
    },
];

/// The largest conversation file restored, and the largest database
/// snapshotted: each is held whole (in memory, or as a scratch copy).
pub const MAX_FILE: u64 = 1 << 30;

/// SQLite's sidecar files: folded into a snapshot, never carried.
const SIDECARS: &[&str] = &["-wal", "-shm", "-journal"];

/// `*` matches any run of characters (no `/`).
fn glob(pattern: &str, name: &str) -> bool {
    match pattern.split_once('*') {
        None => pattern == name,
        Some((head, tail)) => {
            let Some(rest) = name.strip_prefix(head) else {
                return false;
            };
            (0..=rest.len())
                .filter(|i| rest.is_char_boundary(*i))
                .any(|i| glob(tail, &rest[i..]))
        }
    }
}

/// `rel` is `pattern` or lies under it.
fn under(pattern: &str, rel: &str) -> bool {
    let pat: Vec<&str> = pattern.split('/').collect();
    let segs: Vec<&str> = rel.split('/').collect();
    segs.len() >= pat.len() && pat.iter().zip(&segs).all(|(p, s)| glob(p, s))
}

fn leaf(rel: &str) -> &str {
    rel.rsplit('/').next().unwrap_or(rel)
}

/// A SQLite sidecar (`-wal`, `-shm`, `-journal`).
pub fn is_sidecar(rel: &str) -> bool {
    SIDECARS.iter().any(|s| leaf(rel).ends_with(s))
}

/// Whether the home-relative file `rel` is conversation that may travel: under
/// one of [`ROOTS`], not a sidecar, not one of its root's configuration
/// files. Checked on export and again on import, where `rel` comes from an
/// untrusted bundle.
pub fn allowed(rel: &str) -> bool {
    if rel.split('/').any(|s| s.is_empty() || s == "." || s == "..") || is_sidecar(rel) {
        return false;
    }
    ROOTS.iter().any(|root| {
        under(root.path, rel) && !root.skip_suffixes.iter().any(|s| leaf(rel).ends_with(s))
    })
}

/// Whether `rel` is carried as a database: a known one, or any `*.db` /
/// `*.sqlite` / `*.sqlite3` under a root (Cursor's chat stores, Goose's).
pub fn is_database(rel: &str) -> bool {
    known_database(rel).is_some()
        || [".db", ".sqlite", ".sqlite3"]
            .iter()
            .any(|ext| leaf(rel).ends_with(ext))
}

fn known_database(rel: &str) -> Option<&'static Database> {
    let segs = rel.split('/').count();
    DATABASES
        .iter()
        .find(|db| db.path.split('/').count() == segs && under(db.path, rel))
}

// ── Walking a home ──────────────────────────────────────────────────────────

/// What a root (or a `*` in one) resolved to in a home.
pub enum Found {
    Dir(HomeDir),
    File(HomeFile),
    /// A link, FIFO or socket where a root names something: never followed.
    Link,
    Special,
}

/// Every root present in `home`, as `(home-relative path, what is there)`.
/// Folders under a root are the caller's to walk. Everything is opened
/// through `home_io` handles: an agent may swap a folder for a link to the
/// user's real home while this runs.
pub fn for_each_root(
    home: &Path,
    visit: &mut dyn FnMut(&str, Found) -> Result<(), String>,
) -> Result<(), String> {
    let Some(top) = HomeDir::open_existing(home, "") else {
        return Ok(());
    };
    for root in ROOTS {
        let segs: Vec<&str> = root.path.split('/').collect();
        expand(&top, "", &segs, visit)?;
    }
    Ok(())
}

fn expand(
    dir: &HomeDir,
    rel: &str,
    segs: &[&str],
    visit: &mut dyn FnMut(&str, Found) -> Result<(), String>,
) -> Result<(), String> {
    let Some((seg, rest)) = segs.split_first() else {
        return Ok(());
    };
    let names: Vec<String> = if seg.contains('*') {
        let mut names: Vec<String> = dir.names().into_iter().filter(|n| glob(seg, n)).collect();
        names.sort();
        names
    } else {
        vec![seg.to_string()]
    };
    for name in names {
        let child = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        if !rest.is_empty() {
            if let Some(sub) = dir.open_subdir(&name) {
                expand(&sub, &child, rest, visit)?;
            }
            continue;
        }
        let Some(file) = dir.file(&name) else { continue };
        let Some(meta) = file.metadata() else { continue };
        if meta.is_symlink {
            visit(&child, Found::Link)?;
        } else if meta.is_dir {
            if let Some(sub) = dir.open_subdir(&name) {
                visit(&child, Found::Dir(sub))?;
            }
        } else if meta.is_file {
            if !is_sidecar(&child) {
                visit(&child, Found::File(file))?;
            }
        } else {
            visit(&child, Found::Special)?;
        }
    }
    Ok(())
}

// ── Databases ───────────────────────────────────────────────────────────────

/// A database written out for a bundle (export) or for a home (import):
/// one file in a private scratch dir, deleted with this value.
pub struct Snapshot {
    _dir: tempfile::TempDir,
    pub path: PathBuf,
}

impl Snapshot {
    pub fn open(&self) -> Result<std::fs::File, String> {
        std::fs::File::open(&self.path).map_err(|e| e.to_string())
    }
}

/// A scratch dir private to the user, under the state dir rather than a
/// shared `/tmp`: what lands in it is the user's conversation.
fn scratch_dir(parent: &Path) -> Result<tempfile::TempDir, String> {
    crate::services::agent_home::create_private_dir(parent).map_err(|e| e.to_string())?;
    tempfile::Builder::new()
        .prefix(".agent-history-")
        .tempdir_in(parent)
        .map_err(|e| e.to_string())
}

/// Copy `from` into `to`, at most [`MAX_FILE`] bytes. `false` when larger.
fn copy_capped(mut from: impl Read, to: &Path) -> Result<bool, String> {
    let mut out = std::fs::File::create(to).map_err(|e| e.to_string())?;
    let copied = std::io::copy(&mut (&mut from).take(MAX_FILE + 1), &mut out)
        .map_err(|e| e.to_string())?;
    out.flush().map_err(|e| e.to_string())?;
    Ok(copied <= MAX_FILE)
}

/// A connection to a database Tabtivity did not write, made safe to change:
/// its triggers do not fire (an UPDATE here must not run the file's own SQL),
/// its schema's functions are not trusted, and its shadow tables are
/// read-only.
fn open_untrusted(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| e.to_string())?;
    for (config, on) in [
        (DbConfig::SQLITE_DBCONFIG_ENABLE_TRIGGER, false),
        (DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true),
        (DbConfig::SQLITE_DBCONFIG_TRUSTED_SCHEMA, false),
    ] {
        conn.set_db_config(config, on).map_err(|e| e.to_string())?;
    }
    conn.execute_batch("PRAGMA cell_size_check = ON;")
        .map_err(|e| e.to_string())?;
    let check: String = conn
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if check != "ok" {
        return Err(format!("damaged database ({check})"));
    }
    Ok(conn)
}

fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// The tables of a database a transfer touches: `(name, virtual)`. SQLite's
/// own tables and a virtual table's shadow tables (`<vtab>_…`, written only
/// through the virtual table) are left out.
fn tables(conn: &Connection) -> Result<Vec<(String, bool)>, String> {
    let mut stmt = conn
        .prepare("SELECT name, COALESCE(sql, '') FROM sqlite_schema WHERE type = 'table'")
        .map_err(|e| e.to_string())?;
    let rows: Vec<(String, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    let virtuals: Vec<String> = rows
        .iter()
        .filter(|(_, sql)| sql.trim_start().to_ascii_uppercase().starts_with("CREATE VIRTUAL"))
        .map(|(name, _)| name.clone())
        .collect();
    Ok(rows
        .into_iter()
        .filter(|(name, _)| !name.starts_with("sqlite_"))
        .filter(|(name, _)| !virtuals.iter().any(|v| name.starts_with(&format!("{v}_"))))
        .map(|(name, _)| {
            let virt = virtuals.contains(&name);
            (name, virt)
        })
        .collect())
}

/// Empty every table `db` does not list, and blank its listed columns.
fn strip(conn: &Connection, db: &Database) -> Result<(), String> {
    for (name, _) in tables(conn)? {
        if !db.keep.contains(&name.as_str()) {
            conn.execute(&format!("DELETE FROM {}", quote_ident(&name)), [])
                .map_err(|e| format!("{name}: {e}"))?;
        }
    }
    for (table, column) in db.blank {
        let present: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name = ?2",
                [table, column],
                |row| row.get::<_, i64>(0),
            )
            .map(|n| n > 0)
            .map_err(|e| e.to_string())?;
        if present {
            conn.execute(
                &format!("UPDATE {} SET {} = NULL", quote_ident(table), quote_ident(column)),
                [],
            )
            .map_err(|e| format!("{table}.{column}: {e}"))?;
        }
    }
    Ok(())
}

/// Write `conn`'s database to a fresh `out` — no WAL, no free pages.
fn vacuum_into(conn: &Connection, out: &Path) -> Result<(), String> {
    conn.execute("VACUUM INTO ?1", [out.to_string_lossy().as_ref()])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// A consistent, stripped copy of the database `file` (home-relative `rel`)
/// for a bundle. Its `-wal` comes along through the same directory handle so
/// the newest pages are in; a file that changed while it was copied is copied
/// again, and one that will not hold still is an error (the caller reports it
/// as skipped).
pub fn snapshot_for_export(file: &HomeFile, rel: &str) -> Result<Snapshot, String> {
    snapshot_for_export_in(&crate::storage::state_dir(), file, rel)
}

fn snapshot_for_export_in(scratch: &Path, file: &HomeFile, rel: &str) -> Result<Snapshot, String> {
    let dir = scratch_dir(scratch)?;
    let copy = dir.path().join("db");
    let wal_name = format!("{}-wal", leaf(rel));
    let mut settled = false;
    for _ in 0..3 {
        let main = file.open_read().ok_or("unreadable")?;
        let before = stamp(&main);
        if !copy_capped(main, &copy)? {
            return Err("over the size cap".to_string());
        }
        let _ = std::fs::remove_file(dir.path().join("db-wal"));
        if let Some(wal) = file.dir().file(&wal_name).and_then(|w| w.open_read()) {
            if !copy_capped(wal, &dir.path().join("db-wal"))? {
                return Err("over the size cap".to_string());
            }
        }
        let after = file.open_read().map(|f| stamp(&f));
        if after == Some(before) {
            settled = true;
            break;
        }
    }
    if !settled {
        return Err("kept changing while it was copied".to_string());
    }
    let conn = open_untrusted(&copy)?;
    if let Some(db) = known_database(rel) {
        strip(&conn, db)?;
    }
    let out = dir.path().join("out");
    vacuum_into(&conn, &out)?;
    Ok(Snapshot { _dir: dir, path: out })
}

/// Whether the file starts with SQLite's header.
pub fn looks_like_sqlite(file: &HomeFile) -> bool {
    let mut magic = [0u8; 16];
    file.open_read()
        .is_some_and(|mut f| f.read_exact(&mut magic).is_ok() && &magic == b"SQLite format 3\0")
}

fn stamp(file: &std::fs::File) -> Option<(u64, std::time::SystemTime)> {
    let meta = file.metadata().ok()?;
    Some((meta.len(), meta.modified().ok()?))
}

/// A bundle's database `entry` (home-relative `rel`) made ready for a home:
/// stripped again, every path re-pointed, written out fresh. `Ok(None)` when
/// the entry is not a SQLite database at all (it is then restored as a plain
/// file) or is over the size cap.
pub fn prepare_for_import(
    entry: impl Read,
    rel: &str,
    rewrites: &[(String, String)],
) -> Result<Option<Snapshot>, String> {
    prepare_for_import_in(&crate::storage::state_dir(), entry, rel, rewrites)
}

fn prepare_for_import_in(
    scratch: &Path,
    entry: impl Read,
    rel: &str,
    rewrites: &[(String, String)],
) -> Result<Option<Snapshot>, String> {
    let dir = scratch_dir(scratch)?;
    let copy = dir.path().join("db");
    if !copy_capped(entry, &copy)? {
        return Ok(None);
    }
    let mut magic = [0u8; 16];
    let is_sqlite = std::fs::File::open(&copy)
        .and_then(|mut f| f.read_exact(&mut magic))
        .is_ok()
        && &magic == b"SQLite format 3\0";
    if !is_sqlite {
        return Ok(None);
    }
    let conn = open_untrusted(&copy)?;
    if let Some(db) = known_database(rel) {
        strip(&conn, db)?;
    }
    rewrite_database(&conn, rewrites)?;
    let out = dir.path().join("out");
    vacuum_into(&conn, &out)?;
    Ok(Some(Snapshot { _dir: dir, path: out }))
}

/// Re-point every path in every text cell of the database's ordinary tables.
/// A table without a rowid, or one that refuses the update, is left as it is.
pub fn rewrite_database(conn: &Connection, rewrites: &[(String, String)]) -> Result<(), String> {
    let needles = needles(rewrites);
    if needles.is_empty() {
        return Ok(());
    }
    for (table, virt) in tables(conn)? {
        if virt {
            continue;
        }
        let columns: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT name FROM pragma_table_info(?1)")
                .map_err(|e| e.to_string())?;
            let names = stmt
                .query_map([&table], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            names
        };
        for column in columns {
            let (t, c) = (quote_ident(&table), quote_ident(&column));
            let filter = needles
                .iter()
                .enumerate()
                .map(|(i, _)| format!("instr({c}, ?{}) > 0", i + 1))
                .collect::<Vec<_>>()
                .join(" OR ");
            let sql = format!("SELECT rowid, {c} FROM {t} WHERE typeof({c}) = 'text' AND ({filter})");
            let Ok(mut stmt) = conn.prepare(&sql) else {
                continue; // WITHOUT ROWID
            };
            let rows: Vec<(i64, String)> = match stmt
                .query_map(rusqlite::params_from_iter(needles.iter()), |row| {
                    Ok((row.get(0)?, row.get(1)?))
                }) {
                Ok(rows) => rows.filter_map(Result::ok).collect(),
                Err(_) => continue,
            };
            for (rowid, value) in rows {
                if let Some(new) = rewrite_value(&value, rewrites) {
                    let _ = conn.execute(
                        &format!("UPDATE {t} SET {c} = ?1 WHERE rowid = ?2"),
                        rusqlite::params![new, rowid],
                    );
                }
            }
        }
    }
    Ok(())
}

// ── Re-pointing ─────────────────────────────────────────────────────────────

/// The old prefixes as they appear in plain text and inside a JSON string
/// (where a Windows path's backslashes are escaped).
fn needles(rewrites: &[(String, String)]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (old, _) in rewrites {
        if old.is_empty() {
            continue;
        }
        let escaped = serde_json::to_string(old).unwrap_or_default();
        for n in [old.clone(), escaped.trim_matches('"').to_string()] {
            if !out.contains(&n) {
                out.push(n);
            }
        }
    }
    out
}

/// The folder name Claude files a cwd's transcripts under: every character
/// that is not an ASCII letter or digit becomes `-`.
pub fn claude_folder_name(path: &str) -> String {
    path.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// `name` — a slug folder (Claude, CodeBuddy, Droid, Qwen's `projects/`) —
/// re-pointed from `old` to `new` when it is the folder of `old` or of a path
/// under it. Matched loosely, since an older Claude turned only separators
/// and dots into `-`: a `-` in the name stands for any character of `old`
/// that is not a letter or digit.
pub fn repoint_claude_folder(name: &str, old: &str, new: &str) -> Option<String> {
    let mut rest = name.chars();
    for o in old.chars() {
        let n = rest.next()?;
        if n != o && !(n == '-' && !o.is_ascii_alphanumeric()) {
            return None;
        }
    }
    let tail: String = rest.collect();
    (tail.is_empty() || tail.starts_with('-'))
        .then(|| format!("{}{tail}", claude_folder_name(new)))
}

/// Pi's session folder for a cwd: `--home-me-proj--`.
fn pi_folder_name(path: &str) -> String {
    let body: String = path
        .trim_start_matches(['/', '\\'])
        .chars()
        .map(|c| if matches!(c, '/' | '\\' | ':') { '-' } else { c })
        .collect();
    format!("--{body}--")
}

pub(crate) fn sha256_hex(text: &str) -> String {
    crate::digest::sha256_hex(text.as_bytes())
}

pub(crate) fn md5_hex(text: &str) -> String {
    use md5::Digest;
    crate::digest::hex(&md5::Md5::digest(text.as_bytes()))
}

/// One folder name re-pointed, when it is an encoding of an old path.
fn repoint_folder(name: &str, rewrites: &[(String, String)]) -> Option<String> {
    rewrites.iter().find_map(|(old, new)| {
        if name == sha256_hex(old) {
            Some(sha256_hex(new))
        } else if name == md5_hex(old) {
            Some(md5_hex(new))
        } else if name == pi_folder_name(old) {
            Some(pi_folder_name(new))
        } else {
            repoint_claude_folder(name, old, new)
        }
    })
}

/// `rel` with each folder that names an old path renamed for the new one.
/// The file name itself is kept.
pub fn repoint_rel(rel: &str, rewrites: &[(String, String)]) -> String {
    let segs: Vec<&str> = rel.split('/').collect();
    let last = segs.len().saturating_sub(1);
    segs.iter()
        .enumerate()
        .map(|(i, seg)| match (i < last).then(|| repoint_folder(seg, rewrites)).flatten() {
            Some(new) => new,
            None => seg.to_string(),
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// `value` with `old` re-pointed at `new` wherever `old` stands as a whole
/// path (or a `file://` URI's path): not inside a longer name, and followed by
/// a separator or the end of the path.
fn rewrite_text(value: &str, old: &str, new: &str) -> Option<String> {
    if old.is_empty() || !value.contains(old) {
        return None;
    }
    let before_ok = |head: &str| {
        head.is_empty()
            || head.ends_with("file://")
            || head
                .chars()
                .last()
                .is_some_and(|c| c.is_whitespace() || "\"'=:([{,<>`".contains(c))
    };
    let after_ok = |tail: &str| {
        tail.chars()
            .next()
            .is_none_or(|c| c.is_whitespace() || "/\\\"'`,;)]}>?#".contains(c))
    };
    let mut out = String::with_capacity(value.len());
    let mut changed = false;
    let mut rest = value;
    while let Some(at) = rest.find(old) {
        let (head, tail) = (&rest[..at], &rest[at + old.len()..]);
        let whole_head = &value[..value.len() - rest.len() + at];
        out.push_str(head);
        if before_ok(whole_head) && after_ok(tail) {
            out.push_str(new);
            changed = true;
        } else {
            out.push_str(old);
        }
        rest = tail;
    }
    out.push_str(rest);
    changed.then_some(out)
}

/// Every string in a JSON value — object keys too (Gemini's `projects.json`
/// maps paths to folders) — re-pointed. `true` when anything changed.
fn rewrite_json(value: &mut Value, rewrites: &[(String, String)]) -> bool {
    let fix = |s: &str| {
        rewrites.iter().fold(None::<String>, |acc, (old, new)| {
            let current = acc.as_deref().unwrap_or(s);
            rewrite_text(current, old, new).or(acc)
        })
    };
    match value {
        Value::String(s) => match fix(s) {
            Some(new) => {
                *s = new;
                true
            }
            None => false,
        },
        Value::Array(items) => items
            .iter_mut()
            .fold(false, |changed, item| rewrite_json(item, rewrites) | changed),
        Value::Object(map) => {
            let mut changed = false;
            let entries = std::mem::take(map);
            for (key, mut item) in entries {
                changed |= rewrite_json(&mut item, rewrites);
                let key = match fix(&key) {
                    Some(new) => {
                        changed = true;
                        new
                    }
                    None => key,
                };
                map.insert(key, item);
            }
            changed
        }
        _ => false,
    }
}

/// One text cell re-pointed: as JSON when it is JSON, else as text.
fn rewrite_value(value: &str, rewrites: &[(String, String)]) -> Option<String> {
    let trimmed = value.trim_start();
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        if let Ok(mut json) = serde_json::from_str::<Value>(value) {
            return rewrite_json(&mut json, rewrites)
                .then(|| serde_json::to_string(&json).ok())
                .flatten();
        }
    }
    rewrites.iter().fold(None::<String>, |acc, (old, new)| {
        let current = acc.as_deref().unwrap_or(value);
        rewrite_text(current, old, new).or(acc)
    })
}

/// Re-point every path in a JSON-lines transcript. A line that names none of
/// the old prefixes — or is not JSON — is kept byte for byte; only a line that
/// changed is re-serialized.
pub fn rewrite_jsonl(bytes: &[u8], rewrites: &[(String, String)]) -> Vec<u8> {
    let needles = needles(rewrites);
    let mut out = Vec::with_capacity(bytes.len());
    for line in bytes.split_inclusive(|b| *b == b'\n') {
        let (body, newline) = match line.strip_suffix(b"\n") {
            Some(body) => (body, &b"\n"[..]),
            None => (line, &b""[..]),
        };
        let mentions = std::str::from_utf8(body)
            .is_ok_and(|text| needles.iter().any(|n| text.contains(n.as_str())));
        let rewritten = mentions
            .then(|| serde_json::from_slice::<Value>(body).ok())
            .flatten()
            .and_then(|mut value| {
                rewrite_json(&mut value, rewrites)
                    .then(|| serde_json::to_vec(&value).ok())
                    .flatten()
            });
        out.extend_from_slice(rewritten.as_deref().unwrap_or(body));
        out.extend_from_slice(newline);
    }
    out
}

/// A conversation file's content re-pointed by its kind: JSON lines line by
/// line, a JSON document whole, YAML as text. Anything else — and anything
/// that does not parse — is returned untouched.
pub fn rewrite_file(rel: &str, bytes: Vec<u8>, rewrites: &[(String, String)]) -> Vec<u8> {
    if rewrites.is_empty() {
        return bytes;
    }
    let name = leaf(rel);
    if name.ends_with(".jsonl") {
        return rewrite_jsonl(&bytes, rewrites);
    }
    if name.ends_with(".json") {
        let Ok(mut value) = serde_json::from_slice::<Value>(&bytes) else {
            return bytes;
        };
        if !rewrite_json(&mut value, rewrites) {
            return bytes;
        }
        let pretty = bytes.windows(2).any(|w| w == b"\n ");
        let out = if pretty {
            serde_json::to_vec_pretty(&value)
        } else {
            serde_json::to_vec(&value)
        };
        return out.unwrap_or(bytes);
    }
    if name.ends_with(".yaml") || name.ends_with(".yml") {
        let Ok(text) = std::str::from_utf8(&bytes) else {
            return bytes;
        };
        return match rewrites.iter().fold(None::<String>, |acc, (old, new)| {
            let current = acc.as_deref().unwrap_or(text);
            rewrite_text(current, old, new).or(acc)
        }) {
            Some(new) => new.into_bytes(),
            None => bytes,
        };
    }
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairs(old: &str, new: &str) -> Vec<(String, String)> {
        vec![(old.to_string(), new.to_string())]
    }

    #[test]
    fn only_conversation_paths_are_allowed() {
        for ok in [
            ".claude/projects/-home-a-p/s.jsonl",
            ".codex/sessions/2026/10/12/rollout-x.jsonl",
            ".codex/state_5.sqlite",
            ".codex/state.sqlite",
            ".gemini/tmp/abc/chats/session-1.json",
            ".gemini/tmp/abc/logs.json",
            ".local/share/opencode/opencode.db",
            ".factory/sessions/-home-a-p/s.jsonl",
        ] {
            assert!(allowed(ok), "{ok}");
        }
        for no in [
            ".claude/settings.json",
            ".claude/.credentials.json",
            ".codex/auth.json",
            ".codex/config.toml",
            ".codex/state_5.sqlite-wal",
            ".codex/logs_2.sqlite",
            ".gemini/tmp/bin/rg",
            ".gemini/oauth_creds.json",
            ".local/share/opencode/auth.json",
            ".factory/sessions/-home-a-p/s.settings.json",
            ".claude/projects/../settings.json",
            ".claude/projects//x",
        ] {
            assert!(!allowed(no), "{no}");
        }
    }

    #[test]
    fn databases_are_known_by_path_or_extension() {
        assert!(known_database(".codex/state_5.sqlite").is_some());
        assert!(known_database(".codex/sessions/state_5.sqlite").is_none());
        assert!(is_database(".cursor/chats/abc/def/store.db"));
        assert!(!is_database(".claude/projects/x/s.jsonl"));
    }

    #[test]
    fn a_folder_named_after_the_old_path_is_renamed_for_the_new_one() {
        let r = pairs("/home/a/proj", "/srv/b/proj");
        assert_eq!(
            repoint_rel(".claude/projects/-home-a-proj-src/s.jsonl", &r),
            ".claude/projects/-srv-b-proj-src/s.jsonl"
        );
        let gemini = format!(".gemini/tmp/{}/chats/c.json", sha256_hex("/home/a/proj"));
        assert_eq!(
            repoint_rel(&gemini, &r),
            format!(".gemini/tmp/{}/chats/c.json", sha256_hex("/srv/b/proj"))
        );
        let cursor = format!(".cursor/chats/{}/x/store.db", md5_hex("/home/a/proj"));
        assert_eq!(
            repoint_rel(&cursor, &r),
            format!(".cursor/chats/{}/x/store.db", md5_hex("/srv/b/proj"))
        );
        assert_eq!(
            repoint_rel(".pi/agent/sessions/--home-a-proj--/s.jsonl", &r),
            ".pi/agent/sessions/--srv-b-proj--/s.jsonl"
        );
        // A file whose name happens to match is a file, not a folder.
        assert_eq!(repoint_rel(".claude/projects/-home-a-proj", &r), ".claude/projects/-home-a-proj");
        // A sibling whose name merely starts the same is not the project's.
        assert_eq!(
            repoint_rel(".claude/projects/-home-a-project/s.jsonl", &r),
            ".claude/projects/-home-a-project/s.jsonl"
        );
    }

    #[test]
    fn a_claude_folder_follows_the_project_to_its_new_path() {
        assert_eq!(claude_folder_name("/home/a/my_proj.v2"), "-home-a-my-proj-v2");
        assert_eq!(
            repoint_claude_folder("-home-a-proj", "/home/a/proj", "/srv/b/proj").as_deref(),
            Some("-srv-b-proj")
        );
        // An older Claude kept the underscore; matched all the same.
        assert_eq!(
            repoint_claude_folder("-home-a-my_proj", "/home/a/my_proj", "/x/y").as_deref(),
            Some("-x-y")
        );
        assert_eq!(repoint_claude_folder("-tmp", "/home/a/proj", "/x"), None);
    }

    #[test]
    fn a_path_is_rewritten_only_where_it_stands_whole() {
        let r = pairs("/home/a/proj", "/srv/b/proj");
        let fix = |s: &str| rewrite_value(s, &r);
        assert_eq!(fix("/home/a/proj").as_deref(), Some("/srv/b/proj"));
        assert_eq!(fix("cwd: /home/a/proj/src").as_deref(), Some("cwd: /srv/b/proj/src"));
        assert_eq!(fix("file:///home/a/proj").as_deref(), Some("file:///srv/b/proj"));
        assert_eq!(fix("/home/a/project"), None);
        assert_eq!(fix("/x/home/a/proj"), None);
        // JSON: values and keys alike.
        let json = fix(r#"{"/home/a/proj":{"cwd":"/home/a/proj/x"}}"#).unwrap();
        let v: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["/srv/b/proj"]["cwd"], "/srv/b/proj/x");
    }

    #[test]
    fn a_transcript_is_repointed_line_by_line_and_otherwise_kept_byte_for_byte() {
        let r = pairs("/home/a/proj", "/srv/b/proj");
        let input = b"{\"z\":1,\"cwd\":\"/home/a/proj/src\"}\n{ \"untouched\" : \"/elsewhere\" }\nnot json /home/a/proj\n{\"cwd\":\"/home/a/project\"}";
        let out = String::from_utf8(rewrite_jsonl(input, &r)).unwrap();
        let lines: Vec<&str> = out.split('\n').collect();
        assert_eq!(lines.len(), 4);
        let first: Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(first["cwd"], "/srv/b/proj/src");
        assert_eq!(first["z"], 1);
        assert_eq!(lines[1], "{ \"untouched\" : \"/elsewhere\" }");
        assert_eq!(lines[2], "not json /home/a/proj");
        assert_eq!(lines[3], "{\"cwd\":\"/home/a/project\"}", "a sibling path is not re-pointed");
        let yaml = rewrite_file("s/workspace.yaml", b"cwd: /home/a/proj\nid: 1\n".to_vec(), &r);
        assert_eq!(yaml, b"cwd: /srv/b/proj\nid: 1\n");
    }

    fn make_db(path: &Path) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, permission TEXT, data TEXT);
             CREATE TABLE account (id TEXT, access_token TEXT);
             CREATE TABLE credential (id TEXT, value TEXT);
             CREATE TABLE session_v2 (id TEXT, permission TEXT);
             CREATE TABLE session_message (id TEXT, session_id TEXT, data TEXT);
             CREATE TABLE migration (id TEXT);
             CREATE TRIGGER t AFTER UPDATE ON session BEGIN INSERT INTO account VALUES ('x', 'planted'); END;
             INSERT INTO session VALUES ('s1', '/home/a/proj', '{\"allow\":\"*\"}', '{\"cwd\":\"/home/a/proj/src\"}');
             INSERT INTO account VALUES ('a1', 'secret-token');
             INSERT INTO credential VALUES ('c1', 'secret-v2-token');
             INSERT INTO session_v2 VALUES ('ses_v2', '{\"allow\":\"*\"}');
             INSERT INTO session_message VALUES ('msg_v2', 'ses_v2', '{\"type\":\"user\",\"text\":\"hello\"}');
             INSERT INTO migration VALUES ('m1');",
        )
        .unwrap();
        // Left open: the rows sit in the WAL, not yet in the main file.
        std::mem::forget(conn);
    }

    #[test]
    fn a_database_snapshot_keeps_conversation_and_drops_secrets() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let dir = home.join(".local").join("share").join("opencode");
        std::fs::create_dir_all(&dir).unwrap();
        make_db(&dir.join("opencode.db"));
        assert!(dir.join("opencode.db-wal").is_file());
        let rel = ".local/share/opencode/opencode.db";
        let file = HomeFile::open_existing(home, rel).unwrap();
        let snap = snapshot_for_export_in(tmp.path(), &file, rel).unwrap();
        let conn = Connection::open(&snap.path).unwrap();
        let sessions: i64 = conn.query_row("SELECT COUNT(*) FROM session", [], |r| r.get(0)).unwrap();
        assert_eq!(sessions, 1, "rows still in the WAL are in the snapshot");
        let accounts: i64 = conn.query_row("SELECT COUNT(*) FROM account", [], |r| r.get(0)).unwrap();
        assert_eq!(accounts, 0);
        let credentials: i64 = conn.query_row("SELECT COUNT(*) FROM credential", [], |r| r.get(0)).unwrap();
        assert_eq!(credentials, 0);
        let permission: Option<String> = conn.query_row("SELECT permission FROM session_v2", [], |r| r.get(0)).unwrap();
        assert_eq!(permission, None);
        let messages: i64 = conn.query_row("SELECT COUNT(*) FROM session_message", [], |r| r.get(0)).unwrap();
        assert_eq!(messages, 1);
        let perm: Option<String> = conn.query_row("SELECT permission FROM session", [], |r| r.get(0)).unwrap();
        assert_eq!(perm, None);
        drop(conn);
        let bytes = std::fs::read(&snap.path).unwrap();
        assert!(!bytes.windows(12).any(|w| w == b"secret-token"), "no freed page keeps the token");
        assert!(!bytes.windows(15).any(|w| w == b"secret-v2-token"), "no freed page keeps a V2 credential");

        // Import: re-pointed, stripped again, and the file's trigger never fires.
        let r = pairs("/home/a/proj", "/srv/b/proj");
        let entry = std::fs::File::open(&snap.path).unwrap();
        let ready = prepare_for_import_in(tmp.path(), entry, rel, &r).unwrap().unwrap();
        let conn = Connection::open(&ready.path).unwrap();
        let (directory, data): (String, String) = conn
            .query_row("SELECT directory, data FROM session", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(directory, "/srv/b/proj");
        assert!(data.contains("/srv/b/proj/src"));
        let accounts: i64 = conn.query_row("SELECT COUNT(*) FROM account", [], |r| r.get(0)).unwrap();
        assert_eq!(accounts, 0, "the planted trigger did not run");
    }

    #[test]
    fn a_file_that_is_not_sqlite_is_restored_as_a_file() {
        let tmp = tempfile::tempdir().unwrap();
        let out = prepare_for_import_in(tmp.path(), &b"not a database"[..], ".cursor/chats/a/b/store.db", &[])
            .unwrap();
        assert!(out.is_none());
    }
}
