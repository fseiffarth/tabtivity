//! A project folder renamed on this machine (`commands::projects::
//! rename_project_dir`): its agent conversations re-pointed **in place**, so
//! every CLI finds them from the new folder — the same re-pointing a bundle
//! import does on the way in ([`repoint_rel`] for the folder a CLI files a
//! project's sessions under, [`rewrite_file`] and [`rewrite_database`] for the
//! paths inside), done on the homes the conversations already sit in.
//!
//! What that carries, per CLI with a Resume menu:
//!
//! - **Claude**: `.claude/projects/<slug>/…` moves to the new folder's slug
//!   (`--resume <id>` looks only under the slug of the folder it runs in);
//!   the transcripts' `cwd` and paths follow.
//! - **Cursor**: `.cursor/chats/<md5 of the folder>/<chat>` moves to the new
//!   folder's hash (its `--continue` is dropped in a folder with no chat), and
//!   the chat's `meta.json` `cwd` follows.
//! - **Codex**: each rollout's `session_meta` / `turn_context` `cwd` (the
//!   Resume menu lists a folder's rollouts by it) and the thread store's
//!   `threads.cwd`. A rewritten rollout changes length, so its thread's rows in
//!   `thread_history_<n>.sqlite` — a projection of the rollout by byte offset —
//!   are dropped for Codex to project again ([`forget_codex_projection`]).
//! - **Copilot**: `workspace.yaml` `cwd`/`git_root`, `events.jsonl`, and
//!   `session-store.db` `sessions.cwd`.
//! - **OpenCode**: `session_v2.directory`, `project.worktree`,
//!   `project_directory`/`worktree` rows of `opencode.db`.
//! - **Antigravity**: `conversation_summaries.workspace_uris` (`file://` URIs).
//! - **Muse**: the `metadata` record's `workspace_root` in `session.jsonl`.
//!
//! A file whose content changed keeps its modification time: the Resume menu
//! orders chats by it. A move never replaces what is already at the new name
//! (that one is kept and the clash reported). Everything goes through
//! `home_io` handles and the untrusted-database connection; the project is
//! closed while this runs, so no CLI of the scope writes the home meanwhile.
//!
//! AppHandle-free.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};

use super::{
    for_each_root, harden, is_database, is_sidecar, leaf, looks_like_sqlite, needles, quote_ident, repoint_folder,
    rewrite_database, rewrite_file, Found, MAX_FILE,
};
use crate::services::home_io::{HomeDir, HomeFile};

/// Files one home's walk lists at most (a home with more is a hostile one).
const MAX_ENTRIES: usize = 200_000;
/// Folder levels walked below a root.
const MAX_DEPTH: usize = 12;

/// Codex's projection tables, keyed by thread (`thread_history_<n>.sqlite`).
const CODEX_PROJECTION_TABLES: &[&str] =
    &["thread_turns", "thread_items", "thread_realtime_items", "thread_history_projection_state"];

/// What re-pointing did to one or more homes.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Repointed {
    /// Files moved to the folder named after the new path.
    pub moved: usize,
    /// Files and databases whose paths were re-pointed.
    pub rewritten: usize,
    /// What could not be carried, with why.
    pub failed: Vec<String>,
}

impl Repointed {
    fn absorb(&mut self, other: Repointed) {
        self.moved += other.moved;
        self.rewritten += other.rewritten;
        self.failed.extend(other.failed);
    }
}

/// Re-point the conversations in project `project_id`'s agent homes (its own
/// and its local-model one) from the folder `old` to `new`, which the project
/// folder was just renamed to. The project's linked worktrees
/// (`<new>/.tabtivity/worktrees/<name>`) get their own pair: a CLI that hashes
/// its folder (Cursor) files a worktree's chats under that worktree's hash.
pub fn repoint_project(project_id: &str, old: &str, new: &str) -> Repointed {
    let state_dir = crate::storage::state_dir();
    let homes = [
        crate::services::agent_home::scope_home_in(&state_dir, project_id),
        crate::services::agent_home::local_model_home_in(&state_dir, project_id),
    ];
    let rewrites = folder_pairs(old, new);
    let mut out = Repointed::default();
    for home in homes.iter().filter(|home| home.is_dir()) {
        out.absorb(repoint_home(home, &rewrites));
        match crate::services::agent_home::repoint_folder_settings(home, &rewrites) {
            Ok(n) => out.rewritten += n,
            Err(e) => out.failed.push(format!("{}: folder settings: {e}", home.display())),
        }
    }
    out
}

/// `(old, new)` for the project folder, then for each of its linked worktrees
/// (listed under the new folder, where they now are).
fn folder_pairs(old: &str, new: &str) -> Vec<(String, String)> {
    let (old, new) = (trimmed(old), trimmed(new));
    let mut pairs = vec![(old.to_string(), new.to_string())];
    if old.contains('\\') {
        // A Windows path as a `file://` URI spells it with `/` (Antigravity's
        // `workspace_uris`).
        pairs.push((old.replace('\\', "/"), new.replace('\\', "/")));
    }
    let worktrees = |root: &str| crate::brand::WORKTREES_DIR.split('/').fold(PathBuf::from(root), |path, seg| path.join(seg));
    if let Ok(entries) = std::fs::read_dir(worktrees(new)) {
        let mut names: Vec<String> = entries
            .flatten()
            .filter(|entry| entry.file_type().is_ok_and(|t| t.is_dir()))
            .filter_map(|entry| entry.file_name().into_string().ok())
            .collect();
        names.sort();
        for name in names.into_iter().take(256) {
            pairs.push((
                worktrees(old).join(&name).to_string_lossy().into_owned(),
                worktrees(new).join(&name).to_string_lossy().into_owned(),
            ));
        }
    }
    pairs
}

fn trimmed(dir: &str) -> &str {
    let t = dir.trim_end_matches(['/', '\\']);
    if t.is_empty() { dir } else { t }
}

/// Re-point the conversations in one home. Idempotent: a second pass finds
/// nothing under the old names.
pub fn repoint_home(home: &Path, rewrites: &[(String, String)]) -> Repointed {
    let mut out = Repointed::default();
    let rewrites: Vec<(String, String)> =
        rewrites.iter().filter(|(old, new)| !old.is_empty() && old != new).cloned().collect();
    if rewrites.is_empty() {
        return out;
    }
    // SQLite's NOFOLLOW refuses a link anywhere in the path, the home's own
    // prefix included (a symlinked temp dir): resolved once, by name — the
    // home sits under the state dir, which no agent writes.
    #[cfg(unix)]
    let Ok(home) = std::fs::canonicalize(home) else { return out };
    #[cfg(not(unix))]
    let home = home.to_path_buf();

    // 1. Moves: everything under a folder named after an old path.
    let mut emptied: Vec<String> = Vec::new();
    for rel in list_files(&home, &mut out) {
        let target = repoint_rel_in_place(&rel, &rewrites);
        if target == rel {
            continue;
        }
        match move_file(&home, &rel, &target) {
            Ok(()) => {
                out.moved += 1;
                emptied.extend(moved_out_dirs(&rel, &rewrites));
            }
            Err(e) => out.failed.push(format!("{rel}: {e}")),
        }
    }
    remove_emptied(&home, emptied);

    // 2. The paths inside, where the files now are.
    let mut threads: Vec<String> = Vec::new();
    for rel in list_files(&home, &mut out).into_iter().filter(|rel| !is_sidecar(rel)) {
        let result = if is_database(&rel) {
            rewrite_database_at(&home, &rel, &rewrites)
        } else if [".jsonl", ".json", ".yaml", ".yml"].iter().any(|ext| leaf(&rel).ends_with(ext)) {
            rewrite_file_at(&home, &rel, &rewrites)
        } else {
            Ok(false)
        };
        match result {
            Ok(true) => {
                out.rewritten += 1;
                threads.extend(codex_thread_of(&rel));
            }
            Ok(false) => {}
            Err(e) => out.failed.push(format!("{rel}: {e}")),
        }
    }
    if !threads.is_empty() {
        forget_codex_projection(&home, &threads, &mut out);
    }
    out
}

/// Every regular file under the conversation roots of `home` (sidecars
/// included: a database moves with its `-wal`), home-relative. Links and
/// special files are never listed.
fn list_files(home: &Path, out: &mut Repointed) -> Vec<String> {
    let mut files = Vec::new();
    let walked = for_each_root(home, &mut |rel, found| {
        match found {
            Found::File(_) => files.push(rel.to_string()),
            Found::Dir(dir) => walk(&dir, rel, 0, &mut files),
            Found::Link | Found::Special => {}
        }
        Ok(())
    });
    if let Err(e) = walked {
        out.failed.push(format!("{}: {e}", home.display()));
    }
    files
}

fn walk(dir: &HomeDir, rel: &str, depth: usize, files: &mut Vec<String>) {
    if depth > MAX_DEPTH {
        return;
    }
    let mut names = dir.names();
    names.sort();
    for name in names {
        if files.len() >= MAX_ENTRIES {
            return;
        }
        let child = format!("{rel}/{name}");
        let Some(meta) = dir.file(&name).and_then(|file| file.metadata()) else { continue };
        if meta.is_symlink {
            continue;
        }
        if meta.is_dir {
            if let Some(sub) = dir.open_subdir(&name) {
                walk(&sub, &child, depth + 1, files);
            }
        } else if meta.is_file {
            files.push(child);
        }
    }
}

/// [`repoint_rel`](super::repoint_rel) for a home being re-pointed where it
/// is: a folder already named after a new path stays. When the new name
/// extends the old one (`/x/p` → `/x/p-2`), the new folder's slug also reads
/// as a subfolder of the old (`-x-p` + `-2`); it is the new one's, or the
/// result of an earlier pass, never moved again.
fn repoint_rel_in_place(rel: &str, rewrites: &[(String, String)]) -> String {
    let segs: Vec<&str> = rel.split('/').collect();
    let last = segs.len().saturating_sub(1);
    segs.iter()
        .enumerate()
        .map(|(i, seg)| {
            let renamed = (i < last && !already_new(seg, rewrites)).then(|| repoint_folder(seg, rewrites)).flatten();
            renamed.unwrap_or_else(|| seg.to_string())
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// Whether the folder `name` is already filed under one of the new paths.
fn already_new(name: &str, rewrites: &[(String, String)]) -> bool {
    rewrites.iter().any(|(_, new)| repoint_folder(name, &[(new.clone(), new.clone())]).is_some())
}

/// Move the file at `rel` to `target` (same file name, other folders), never
/// replacing what is there.
fn move_file(home: &Path, rel: &str, target: &str) -> Result<(), String> {
    let source = HomeFile::open_existing(home, rel).filter(HomeFile::is_file).ok_or("gone or not a plain file")?;
    let (parent, name) = target.rsplit_once('/').ok_or("no folder")?;
    if name != leaf(rel) {
        return Err("the file name changed".into());
    }
    let dir = HomeDir::open(home, parent).ok_or_else(|| format!("{parent} is not a plain folder"))?;
    source.move_into(&dir).map_err(|e| match e.kind() {
        std::io::ErrorKind::AlreadyExists => format!("kept: {target} already exists"),
        _ => e.to_string(),
    })
}

/// The folders a move from `rel` may have left empty, deepest first: every
/// ancestor whose own name was re-pointed, and the folders below it.
fn moved_out_dirs(rel: &str, rewrites: &[(String, String)]) -> Vec<String> {
    let segs: Vec<&str> = rel.split('/').collect();
    let Some(first) = (0..segs.len().saturating_sub(1))
        .find(|&i| !already_new(segs[i], rewrites) && repoint_folder(segs[i], rewrites).is_some())
    else {
        return Vec::new();
    };
    (first + 1..segs.len()).rev().map(|end| segs[..end].join("/")).collect()
}

/// Remove the folders the moves emptied. Only an empty folder goes; anything
/// left in one (a clash kept, a link) keeps it.
fn remove_emptied(home: &Path, mut dirs: Vec<String>) {
    dirs.sort_by(|a, b| b.matches('/').count().cmp(&a.matches('/').count()).then_with(|| a.cmp(b)));
    dirs.dedup();
    for rel in dirs {
        let Some((parent, name)) = rel.rsplit_once('/') else { continue };
        let Some(dir) = HomeDir::open_existing(home, parent) else { continue };
        if dir.open_subdir(name).is_some_and(|sub| sub.names().is_empty()) {
            let _ = std::fs::remove_dir(dir.path().join(name));
        }
    }
}

/// A conversation file's paths re-pointed, its modification time kept.
fn rewrite_file_at(home: &Path, rel: &str, rewrites: &[(String, String)]) -> Result<bool, String> {
    let Some(file) = HomeFile::open_existing(home, rel).filter(HomeFile::is_file) else { return Ok(false) };
    let bytes = file.read_capped(MAX_FILE).ok_or("unreadable or over the size cap")?;
    if !mentions(&bytes, rewrites) {
        return Ok(false);
    }
    let rewritten = rewrite_file(rel, bytes.clone(), rewrites);
    if rewritten == bytes {
        return Ok(false);
    }
    let modified = file.open_read().and_then(|f| f.metadata().ok()).and_then(|m| m.modified().ok());
    file.write(&rewritten).map_err(|e| e.to_string())?;
    if let Some(at) = modified {
        // Best effort: the content is already re-pointed.
        let _ = file.set_modified(at);
    }
    Ok(true)
}

/// Whether `bytes` holds one of the old paths, as text or inside a JSON string.
fn mentions(bytes: &[u8], rewrites: &[(String, String)]) -> bool {
    needles(rewrites)
        .iter()
        .any(|needle| !needle.is_empty() && bytes.windows(needle.len()).any(|w| w == needle.as_bytes()))
}

/// A database's paths re-pointed in place, in one transaction.
fn rewrite_database_at(home: &Path, rel: &str, rewrites: &[(String, String)]) -> Result<bool, String> {
    let Some(file) = HomeFile::open_existing(home, rel).filter(HomeFile::is_file) else { return Ok(false) };
    if file.metadata().is_some_and(|m| m.len > MAX_FILE) {
        return Err("over the size cap".into());
    }
    if !looks_like_sqlite(&file) {
        return Ok(false);
    }
    let conn = open_in_home(&file)?;
    conn.execute_batch("BEGIN IMMEDIATE").map_err(|e| e.to_string())?;
    let before = conn.total_changes();
    if let Err(e) = rewrite_database(&conn, rewrites) {
        let _ = conn.execute_batch("ROLLBACK");
        return Err(e);
    }
    let changed = conn.total_changes() > before;
    conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
    Ok(changed)
}

/// A database in the home opened to change it: reached by the handle walk,
/// opened `NOFOLLOW`, with the untrusted-database guards ([`harden`]).
fn open_in_home(file: &HomeFile) -> Result<Connection, String> {
    file.open_read().ok_or("not a plain file")?;
    let conn = Connection::open_with_flags(
        file.path(),
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(|e| e.to_string())?;
    conn.busy_timeout(std::time::Duration::from_secs(2)).map_err(|e| e.to_string())?;
    harden(conn)
}

/// The thread id of a Codex rollout (`.codex/sessions/<y>/<m>/<d>/rollout-<stamp>-<id>.jsonl`).
fn codex_thread_of(rel: &str) -> Option<String> {
    if !(rel.starts_with(".codex/sessions/") || rel.starts_with(".codex/archived_sessions/")) {
        return None;
    }
    let stem = leaf(rel).strip_prefix("rollout-")?.strip_suffix(".jsonl")?;
    let id = stem.get(stem.len().checked_sub(36)?..)?;
    crate::services::agent_session::is_uuid_shaped(id).then(|| id.to_string())
}

/// Drop the rewritten threads' rows from Codex's `thread_history_<n>.sqlite`:
/// they point into the rollout by byte offset, which the rewrite moved. Codex
/// projects a thread with no rows from its rollout again.
fn forget_codex_projection(home: &Path, threads: &[String], out: &mut Repointed) {
    let Some(codex) = HomeDir::open_existing(home, ".codex") else { return };
    for name in codex.names() {
        if !(name.starts_with("thread_history") && name.ends_with(".sqlite")) {
            continue;
        }
        let rel = format!(".codex/{name}");
        let Some(file) = HomeFile::open_existing(home, &rel).filter(HomeFile::is_file) else { continue };
        let result = open_in_home(&file).and_then(|conn| {
            conn.execute_batch("BEGIN IMMEDIATE").map_err(|e| e.to_string())?;
            for table in CODEX_PROJECTION_TABLES {
                let is_table = conn
                    .query_row("SELECT type FROM sqlite_master WHERE name = ?1", [table], |row| row.get::<_, String>(0))
                    .is_ok_and(|kind| kind == "table");
                if !is_table {
                    continue;
                }
                let sql = format!("DELETE FROM {} WHERE thread_id = ?1", quote_ident(table));
                for thread in threads {
                    conn.execute(&sql, [thread]).map_err(|e| e.to_string())?;
                }
            }
            conn.execute_batch("COMMIT").map_err(|e| e.to_string())
        });
        if let Err(e) = result {
            out.failed.push(format!("{rel}: {e}"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::agent_history::{claude_folder_name, md5_hex};

    const ID: &str = "11111111-2222-3333-4444-555555555555";

    fn abs(parts: &[&str]) -> String {
        let base = if cfg!(windows) { PathBuf::from(r"C:\") } else { PathBuf::from("/") };
        parts.iter().fold(base, |path, part| path.join(part)).to_string_lossy().into_owned()
    }

    fn json_str(path: &str) -> String {
        serde_json::to_string(path).unwrap()
    }

    fn write(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    fn mtime(path: &Path) -> std::time::SystemTime {
        std::fs::metadata(path).unwrap().modified().unwrap()
    }

    fn age(path: &Path) {
        let then = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        std::fs::File::options().write(true).open(path).unwrap().set_modified(then).unwrap();
    }

    #[test]
    fn claude_sessions_move_to_the_new_slug_with_their_paths_and_times() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let (old, new) = (abs(&["home", "me", "trips"]), abs(&["home", "me", "trips-refunds"]));
        let projects = home.join(".claude").join("projects");
        let src = projects.join(claude_folder_name(&old));
        let session = src.join(format!("{ID}.jsonl"));
        write(&session, &format!("{{\"cwd\":{}}}\n{{\"x\":1}}\n", json_str(&old)));
        write(&src.join(ID).join("subagents").join("a.jsonl"), "{}\n");
        let sub = projects.join(format!("{}-src", claude_folder_name(&old)));
        write(&sub.join(format!("{ID}.jsonl")), "{}\n");
        let other = projects.join(claude_folder_name(&abs(&["home", "me", "elsewhere"])));
        write(&other.join("o.jsonl"), "{}\n");
        age(&session);
        let before = mtime(&session);

        let done = repoint_home(home, &[(old.clone(), new.clone())]);
        assert!(done.failed.is_empty(), "{:?}", done.failed);

        let dst = projects.join(claude_folder_name(&new));
        let moved = dst.join(format!("{ID}.jsonl"));
        let text = std::fs::read_to_string(&moved).unwrap();
        assert!(text.contains(&json_str(&new)) && !text.contains(&json_str(&old)), "{text}");
        assert_eq!(mtime(&moved), before, "the Resume menu's order keeps");
        assert!(dst.join(ID).join("subagents").join("a.jsonl").is_file());
        assert!(projects.join(format!("{}-src", claude_folder_name(&new))).join(format!("{ID}.jsonl")).is_file());
        assert!(!src.exists() && !sub.exists(), "the emptied folders go");
        assert!(other.join("o.jsonl").is_file());

        // A second pass finds nothing left under the old names — and leaves
        // the new folder (whose slug extends the old one) where it is.
        let again = repoint_home(home, &[(old, new)]);
        assert_eq!((again.moved, again.rewritten), (0, 0), "{:?}", again.failed);
        assert!(moved.is_file());
    }

    #[test]
    fn a_clash_is_kept_and_reported() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let (old, new) = (abs(&["p"]), abs(&["q"]));
        let projects = home.join(".claude").join("projects");
        write(&projects.join(claude_folder_name(&old)).join("s.jsonl"), "old\n");
        write(&projects.join(claude_folder_name(&new)).join("s.jsonl"), "new\n");
        let done = repoint_home(home, &[(old.clone(), new.clone())]);
        assert_eq!(done.failed.len(), 1, "{:?}", done.failed);
        assert_eq!(std::fs::read_to_string(projects.join(claude_folder_name(&new)).join("s.jsonl")).unwrap(), "new\n");
        assert!(projects.join(claude_folder_name(&old)).join("s.jsonl").is_file());
    }

    #[test]
    fn cursor_chats_move_to_the_new_hash_and_name_the_new_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let (old, new) = (abs(&["w", "a"]), abs(&["w", "b"]));
        let chat = home.join(".cursor").join("chats").join(md5_hex(&old)).join(ID);
        write(&chat.join("meta.json"), &format!("{{\"cwd\":{},\"hasConversation\":true}}", json_str(&old)));
        write(&chat.join("store.db-wal"), "");
        let done = repoint_home(home, &[(old, new.clone())]);
        assert!(done.failed.is_empty(), "{:?}", done.failed);
        let moved = home.join(".cursor").join("chats").join(md5_hex(&new)).join(ID);
        let meta: serde_json::Value = serde_json::from_slice(&std::fs::read(moved.join("meta.json")).unwrap()).unwrap();
        assert_eq!(meta["cwd"], new.as_str());
        assert!(moved.join("store.db-wal").is_file(), "sidecars move with the chat");
    }

    #[test]
    fn a_worktree_gets_its_own_pair_for_hashed_folders() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("new");
        let wt = crate::brand::WORKTREES_DIR.split('/').fold(root.clone(), |p, s| p.join(s)).join("feat");
        std::fs::create_dir_all(&wt).unwrap();
        let old = tmp.path().join("old");
        let pairs = folder_pairs(&old.to_string_lossy(), &format!("{}{}", root.to_string_lossy(), std::path::MAIN_SEPARATOR));
        assert_eq!(pairs[0], (old.to_string_lossy().into_owned(), root.to_string_lossy().into_owned()));
        let old_wt = crate::brand::WORKTREES_DIR.split('/').fold(old.clone(), |p, s| p.join(s)).join("feat");
        let wt_pair = (old_wt.to_string_lossy().into_owned(), wt.to_string_lossy().into_owned());
        assert!(pairs.contains(&wt_pair), "{pairs:?}");
    }

    #[test]
    fn codex_rollouts_copilot_and_muse_records_are_re_pointed_where_they_are() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let (old, new) = (abs(&["src", "trips"]), abs(&["src", "refunds"]));
        let rollout = home
            .join(".codex")
            .join("sessions")
            .join("2026")
            .join("11")
            .join("26")
            .join(format!("rollout-2026-11-26T10-00-00-{ID}.jsonl"));
        write(
            &rollout,
            &format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{ID}\",\"cwd\":{}}}}}\n{{\"type\":\"response_item\",\"payload\":{{\"text\":\"no path\"}}}}\n",
                json_str(&old)
            ),
        );
        age(&rollout);
        let before = mtime(&rollout);
        let history = home.join(".codex").join("thread_history_1.sqlite");
        {
            let conn = Connection::open(&history).unwrap();
            conn.execute_batch(&format!(
                "CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT);
                 CREATE TABLE thread_history_projection_state (thread_id TEXT PRIMARY KEY, next_rollout_byte_offset INTEGER);
                 INSERT INTO thread_turns VALUES ('{ID}', 't'), ('other', 't');
                 INSERT INTO thread_history_projection_state VALUES ('{ID}', 99), ('other', 5);"
            ))
            .unwrap();
        }
        let workspace = home.join(".copilot").join("session-state").join(ID).join("workspace.yaml");
        write(&workspace, &format!("id: {ID}\ncwd: {old}\ngit_root: {old}\nbranch: main\n"));
        let muse = home.join(".local").join("share").join("muse").join("sessions").join("2026").join("11").join("26").join(ID).join("session.jsonl");
        write(&muse, &format!("{{\"payload\":{{\"kind\":\"metadata\",\"record\":{{\"workspace_root\":{}}}}}}}\n", json_str(&old)));

        let done = repoint_home(home, &[(old.clone(), new.clone())]);
        assert!(done.failed.is_empty(), "{:?}", done.failed);

        let first: serde_json::Value =
            serde_json::from_str(std::fs::read_to_string(&rollout).unwrap().lines().next().unwrap()).unwrap();
        assert_eq!(first["payload"]["cwd"], new.as_str());
        assert!(std::fs::read_to_string(&rollout).unwrap().contains("{\"type\":\"response_item\",\"payload\":{\"text\":\"no path\"}}"), "untouched lines stay byte for byte");
        assert_eq!(mtime(&rollout), before);
        let conn = Connection::open(&history).unwrap();
        let left = |table: &str| -> Vec<String> {
            let mut stmt = conn.prepare(&format!("SELECT thread_id FROM {table} ORDER BY thread_id")).unwrap();
            stmt.query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect()
        };
        assert_eq!(left("thread_turns"), ["other"], "the rewritten thread is projected again");
        assert_eq!(left("thread_history_projection_state"), ["other"]);

        let yaml = std::fs::read_to_string(&workspace).unwrap();
        assert!(yaml.contains(&format!("cwd: {new}\n")) && yaml.contains(&format!("git_root: {new}\n")), "{yaml}");
        let record: serde_json::Value = serde_json::from_str(std::fs::read_to_string(&muse).unwrap().trim()).unwrap();
        assert_eq!(record["payload"]["record"]["workspace_root"], new.as_str());
    }

    #[test]
    fn opencode_and_antigravity_stores_are_re_pointed_in_place() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let (old, new) = (abs(&["src", "trips"]), abs(&["src", "refunds"]));
        let oc = home.join(".local").join("share").join("opencode").join("opencode.db");
        std::fs::create_dir_all(oc.parent().unwrap()).unwrap();
        {
            let conn = Connection::open(&oc).unwrap();
            conn.execute_batch(
                "CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT NOT NULL);
                 CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL);",
            )
            .unwrap();
            conn.execute("INSERT INTO session_v2 VALUES ('a', ?1), ('b', ?2), ('c', ?3)", [
                old.clone(),
                Path::new(&old).join("sub").to_string_lossy().into_owned(),
                format!("{old}-other"),
            ])
            .unwrap();
            conn.execute("INSERT INTO project VALUES ('p', ?1)", [old.clone()]).unwrap();
        }
        let agy = home.join(".gemini").join("antigravity-cli").join("conversation_summaries.db");
        std::fs::create_dir_all(agy.parent().unwrap()).unwrap();
        let old_uri = url::Url::from_file_path(&old).unwrap().to_string();
        {
            let conn = Connection::open(&agy).unwrap();
            conn.execute_batch("CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, workspace_uris TEXT NOT NULL);").unwrap();
            conn.execute("INSERT INTO conversation_summaries VALUES ('c', ?1)", [serde_json::json!([old_uri]).to_string()]).unwrap();
        }

        // The pairs `repoint_project` passes: on Windows they carry the
        // `/`-spelled path a `file:///C:/…` URI holds.
        let done = repoint_home(home, &folder_pairs(&old, &new));
        assert!(done.failed.is_empty(), "{:?}", done.failed);
        assert_eq!(done.rewritten, 2);

        let conn = Connection::open(&oc).unwrap();
        let dir = |id: &str| conn.query_row("SELECT directory FROM session_v2 WHERE id = ?1", [id], |r| r.get::<_, String>(0)).unwrap();
        assert_eq!(dir("a"), new);
        assert_eq!(dir("b"), Path::new(&new).join("sub").to_string_lossy());
        assert_eq!(dir("c"), format!("{old}-other"), "a sibling folder is not this one");
        assert_eq!(conn.query_row("SELECT worktree FROM project", [], |r| r.get::<_, String>(0)).unwrap(), new);
        let conn = Connection::open(&agy).unwrap();
        let uris: String = conn.query_row("SELECT workspace_uris FROM conversation_summaries", [], |r| r.get(0)).unwrap();
        let uris: Vec<String> = serde_json::from_str(&uris).unwrap();
        assert_eq!(url::Url::parse(&uris[0]).unwrap().to_file_path().unwrap(), PathBuf::from(&new));
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_session_folder_is_neither_followed_nor_moved_into() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let elsewhere = tmp.path().join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        let (old, new) = ("/p".to_string(), "/q".to_string());
        let projects = home.join(".claude").join("projects");
        write(&projects.join(claude_folder_name(&old)).join("s.jsonl"), "{\"cwd\":\"/p\"}\n");
        std::os::unix::fs::symlink(&elsewhere, projects.join(claude_folder_name(&new))).unwrap();
        let outside = tmp.path().join("outside.jsonl");
        write(&outside, "{\"cwd\":\"/p\"}\n");
        std::os::unix::fs::symlink(&outside, projects.join(claude_folder_name(&old)).join("l.jsonl")).unwrap();

        let done = repoint_home(&home, &[(old, new)]);
        assert!(!done.failed.is_empty());
        assert!(std::fs::read_dir(&elsewhere).unwrap().next().is_none());
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "{\"cwd\":\"/p\"}\n");
    }
}
