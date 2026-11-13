//! One snapshot of a folder into its checkpoint store.
//!
//! 1. The store's ignore file is regenerated: the folder's own git ignore
//!    rules (the repo's `info/exclude`, read through `git_guard`, never raw)
//!    plus the linked worktrees nested in the root (they are folders of their
//!    own). The folder's `.gitignore` files apply as git applies them.
//! 2. The folder is listed (`ls-files`, tracked-by-the-store and not) and each
//!    entry is `lstat`ed: a file over [`MAX_FILE_BYTES`], a pipe, socket or
//!    device is left out and named; when the files new to the store pass
//!    [`NEW_BYTES_BUDGET`] the largest are left out until they fit (`partial`).
//!    Left-out paths go into the ignore file, so `git add -A` never reads them.
//! 3. `git add -A` updates the store's index, `git write-tree` names the tree.
//! 4. A tree equal to the newest row's reuses its commit; otherwise a
//!    parentless commit (a parent chain would keep every pruned snapshot
//!    alive) is written and `refs/ckpt/<id>` keeps it.
//!
//! The caller holds the store's lock. Every git call is bounded and runs with
//! none of the folder's, the user's or the system's config
//! (`git_hardened::checkpoint_git_command`).

use std::path::Path;

use super::store::{new_id, Kind, Row, Skipped, Store, REF_PREFIX};

/// A file over this is not captured.
pub const MAX_FILE_BYTES: u64 = 25 * 1024 * 1024;
/// The bytes of files new to the store one snapshot takes in.
pub const NEW_BYTES_BUDGET: u64 = 256 * 1024 * 1024;
/// Left-out files named on a row.
const MAX_SKIPPED_LISTED: usize = 100;
/// The longest file listing read.
const LIST_CAP: u64 = 512 * 1024 * 1024;
/// A file listing's exit code, text and all, is small.
const SMALL: u64 = 1 << 20;

/// The size limits of one snapshot.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub max_file: u64,
    pub budget: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self { max_file: MAX_FILE_BYTES, budget: NEW_BYTES_BUDGET }
    }
}

/// Who a snapshot is for.
#[derive(Debug, Clone, Default)]
pub struct Who {
    pub tab_uid: String,
    pub tab_label: String,
    pub cli: String,
    pub session_id: Option<String>,
    pub project_id: Option<String>,
}

/// The store's index brought up to the folder.
#[derive(Debug, Default)]
pub struct Staged {
    pub tree: String,
    pub skipped: Vec<Skipped>,
    pub partial: bool,
    pub nested: Vec<String>,
    pub raced: bool,
}

/// One snapshot of `folder` for `who`: the row it logged.
pub fn snapshot(root: &Path, folder: &Path, kind: Kind, who: &Who, prompt_at: Option<u64>) -> Result<Row, String> {
    let store = Store::for_folder(root, folder)?;
    let _lock = store.lock()?;
    store.ensure(who.project_id.as_deref())?;
    snapshot_locked(&store, kind, who, prompt_at)
}

/// [`snapshot`] with the store already locked and ensured (a restore takes its
/// `pre-restore` snapshot inside its own lock).
pub fn snapshot_locked(store: &Store, kind: Kind, who: &Who, prompt_at: Option<u64>) -> Result<Row, String> {
    let staged = stage(store, if kind == Kind::Pre { prompt_at } else { None })?;
    let at = crate::clock::now_ms();
    let id = new_id(at);
    let reuse = store.rows().into_iter().rev().find(Row::has_snapshot).filter(|prev| prev.tree == staged.tree);
    let commit = match reuse {
        Some(prev) => prev.commit,
        None => {
            let message = format!("checkpoint {}", serde_json::to_string(&kind).unwrap_or_default().trim_matches('"'));
            store.text(&["commit-tree", &staged.tree, "-m", &message])?
        }
    };
    store.run_ok(&["update-ref", &format!("{REF_PREFIX}{id}"), &commit], None, SMALL)?;
    let mut skipped = staged.skipped;
    skipped.truncate(MAX_SKIPPED_LISTED);
    let row = Row {
        id,
        kind,
        commit,
        tree: staged.tree,
        tab_uid: who.tab_uid.clone(),
        tab_label: who.tab_label.clone(),
        cli: who.cli.clone(),
        session_id: who.session_id.clone(),
        at,
        prompt_at,
        raced: staged.raced,
        partial: staged.partial,
        skipped,
        nested: staged.nested,
        restored_to: None,
        paths: None,
    };
    store.append(&row)?;
    Ok(row)
}

/// Bring the store's index to the folder's current state and name the tree.
/// `raced_since`: a file modified after this many milliseconds since the epoch
/// marks the result `raced`.
pub fn stage(store: &Store, raced_since: Option<u64>) -> Result<Staged, String> {
    stage_with(store, raced_since, Limits::default())
}

/// [`stage`] under other size limits (the tests'; production keeps the constants).
pub fn stage_with(store: &Store, raced_since: Option<u64>, limits: Limits) -> Result<Staged, String> {
    let base = ignore_text(&store.folder);
    write_ignore(store, &base)?;

    let tracked = split_z(&store.run_ok(&["ls-files", "-z", "--cached"], None, LIST_CAP)?);
    let untracked = split_z(&store.run_ok(&["ls-files", "-z", "--others", "--exclude-standard"], None, LIST_CAP)?);

    let mut staged = Staged::default();
    let mut leave_out: Vec<String> = Vec::new();
    let mut drop_from_index: Vec<String> = Vec::new();
    let mut new_files: Vec<(String, u64)> = Vec::new();
    let mut newest_ms: u64 = 0;

    for path in &tracked {
        match look(&store.folder, path) {
            Look::File { bytes, modified } => {
                newest_ms = newest_ms.max(modified);
                if bytes > limits.max_file {
                    staged.skipped.push(Skipped { path: path.clone(), bytes, reason: "size".into() });
                    drop_from_index.push(path.clone());
                    leave_out.push(path.clone());
                }
            }
            Look::Special => {
                staged.skipped.push(Skipped { path: path.clone(), bytes: 0, reason: "special".into() });
                drop_from_index.push(path.clone());
                leave_out.push(path.clone());
            }
            Look::Link { modified } => newest_ms = newest_ms.max(modified),
            // A folder the store tracks is a nested repository's gitlink.
            Look::Folder => staged.nested.push(path.clone()),
            Look::Gone => {}
        }
    }
    for path in &untracked {
        if let Some(repo) = path.strip_suffix('/') {
            staged.nested.push(repo.to_string());
            continue;
        }
        match look(&store.folder, path) {
            Look::File { bytes, modified } => {
                newest_ms = newest_ms.max(modified);
                if bytes > limits.max_file {
                    staged.skipped.push(Skipped { path: path.clone(), bytes, reason: "size".into() });
                    leave_out.push(path.clone());
                } else {
                    new_files.push((path.clone(), bytes));
                }
            }
            Look::Special => {
                staged.skipped.push(Skipped { path: path.clone(), bytes: 0, reason: "special".into() });
                leave_out.push(path.clone());
            }
            Look::Link { modified } => newest_ms = newest_ms.max(modified),
            Look::Folder | Look::Gone => {}
        }
    }

    // The new bytes one snapshot takes in: the largest wait for a later one
    // (the files that did fit are in the index by then).
    let total: u64 = new_files.iter().map(|(_, b)| b).sum();
    if total > limits.budget {
        new_files.sort_by_key(|(_, bytes)| std::cmp::Reverse(*bytes));
        let mut left = total;
        for (path, bytes) in &new_files {
            if left <= limits.budget {
                break;
            }
            left -= bytes;
            staged.skipped.push(Skipped { path: path.clone(), bytes: *bytes, reason: "budget".into() });
            leave_out.push(path.clone());
        }
        staged.partial = true;
    }
    staged.raced = raced_since.is_some_and(|since| newest_ms > since);

    if !leave_out.is_empty() {
        let mut text = base;
        for path in &leave_out {
            text.push_str(&ignore_pattern(path));
            text.push('\n');
        }
        write_ignore(store, &text)?;
    }
    if !drop_from_index.is_empty() {
        let mut stdin = Vec::new();
        for path in &drop_from_index {
            stdin.extend_from_slice(path.as_bytes());
            stdin.push(0);
        }
        store.run_ok(&["update-index", "--force-remove", "-z", "--stdin"], Some(stdin), SMALL)?;
    }

    let added = store.run(&["add", "-A", "--ignore-errors"], None, SMALL)?;
    if !added.status.success() {
        // `--ignore-errors` still exits non-zero for a file it could not read
        // (permissions, a nested repository with no commit): the rest was added.
        let err = String::from_utf8_lossy(&added.stderr).into_owned();
        if !(err.contains("unable to index") || err.contains("could not be added") || err.contains("does not have a commit")) {
            return Err(format!("git add: {}", err.trim()));
        }
        staged.partial = true;
    }
    staged.tree = store.text(&["write-tree"])?;
    Ok(staged)
}

/// What an entry of the listing is on disk.
enum Look {
    File { bytes: u64, modified: u64 },
    Link { modified: u64 },
    Folder,
    Special,
    Gone,
}

fn look(folder: &Path, path: &str) -> Look {
    if path.split('/').any(|c| c == ".." || c.is_empty()) {
        return Look::Gone;
    }
    let Ok(meta) = std::fs::symlink_metadata(folder.join(path)) else { return Look::Gone };
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64);
    let kind = meta.file_type();
    if kind.is_symlink() {
        Look::Link { modified }
    } else if kind.is_dir() {
        Look::Folder
    } else if kind.is_file() {
        Look::File { bytes: meta.len(), modified }
    } else {
        Look::Special
    }
}

fn split_z(bytes: &[u8]) -> Vec<String> {
    bytes
        .split(|b| *b == 0)
        .filter(|s| !s.is_empty())
        .map(|s| String::from_utf8_lossy(s).into_owned())
        .collect()
}

fn write_ignore(store: &Store, text: &str) -> Result<(), String> {
    crate::storage::write_private_atomic(&store.ignore_file(), text.as_bytes())
}

/// The ignore rules a snapshot starts from: the folder's repo-level ones
/// (read through the guarded helper) and the linked worktrees folder.
fn ignore_text(folder: &Path) -> String {
    let mut text = repo_ignore(folder).unwrap_or_default();
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(&format!("/{}/\n", crate::brand::WORKTREES_DIR));
    text
}

/// The repo-level ignore file of the repository `folder` sits in (the folder's
/// own git dir, or the root's for a linked worktree below it): at most four
/// levels up, a plain `.git` folder only. A link, a FIFO or an oversize file
/// there reads as nothing.
fn repo_ignore(folder: &Path) -> Option<String> {
    let git_dir = folder
        .ancestors()
        .take(4)
        .map(|dir| dir.join(".git"))
        .find(|git| std::fs::symlink_metadata(git).is_ok_and(|m| m.is_dir()))?;
    match crate::services::git_guard::read_info_exclude(&git_dir) {
        Ok(text) => text,
        Err(why) => {
            eprintln!("checkpoints: the repo's ignore file is not read: {why}");
            None
        }
    }
}

/// `path` as an anchored, literal line of an ignore file. A newline cannot be
/// written into one: it matches any single character instead (over-matching a
/// path no one names that way).
pub fn ignore_pattern(path: &str) -> String {
    let mut out = String::with_capacity(path.len() + 2);
    out.push('/');
    for c in path.chars() {
        match c {
            '\\' | '*' | '?' | '[' | ']' => {
                out.push('\\');
                out.push(c);
            }
            '\n' | '\r' => out.push('?'),
            c => out.push(c),
        }
    }
    // Trailing spaces are dropped by git unless escaped.
    let trimmed = out.trim_end_matches(' ').len();
    let spaces = out.len() - trimmed;
    out.truncate(trimmed);
    for _ in 0..spaces {
        out.push_str("\\ ");
    }
    out
}
