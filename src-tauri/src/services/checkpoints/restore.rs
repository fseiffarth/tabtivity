//! What changed in a folder since a checkpoint, and putting files back.
//!
//! The store's index is first brought up to the folder (`snapshot::stage`,
//! the same excludes and budget a snapshot has), so "since" is one tree
//! compared with one index: `diff-index --cached`. A restore takes a
//! `pre-restore` snapshot first (the **Undo restore** target), then for the
//! paths the diff reports:
//!
//! - modified / deleted / type-changed since: `git checkout <commit> --
//!   :(literal)<path>…`, in chunks;
//! - added since: removed.
//!
//! The renderer's path strings are only ever *filters* on the paths git
//! reported, never handed to git or the file system as they came. Before
//! anything is written, every path is checked ([`plain_path`]): no `..`, no
//! `.git`, no leading folder that is a link (a folder swapped for a link in
//! the meantime is refused, never written through). git's own checkout
//! refuses a leading link too; this is the second check, and the one that
//! also covers the removals. A swap between the check and the write remains a
//! race with another process in the same folder (the restore refuses while
//! this tab's agent works, and the dialog warns about other tabs').

use std::collections::HashSet;
use std::path::Path;

use serde::Serialize;

use super::snapshot::{snapshot_locked, special, stage, Who, MAX_FILE_BYTES};
use super::store::{new_id, rel_path, shown, spec_arg, GitPath, Kind, Row, Store};

/// The most stdout read of a listing.
const LIST_CAP: u64 = 256 * 1024 * 1024;
/// Per-file diff text kept, in bytes.
pub const FILE_DIFF_BYTES: u64 = 256 * 1024;
/// The diffs of the first this-many files come with the list; the rest on request.
pub const EAGER_DIFFS: usize = 200;
/// ...and at most this much diff text in all.
pub const EAGER_DIFF_BYTES: usize = 3 * 1024 * 1024;
/// Argument bytes per `checkout` chunk (Windows allows 32 KiB a command line).
const CHUNK_BYTES: usize = 12 * 1024;
/// Other tabs' (pre, post) turns looked at for "changed by another tab".
const OTHER_TURNS: usize = 60;

/// One changed file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub path: String,
    /// `A` added since, `D` deleted since, `M` modified, `T` type changed.
    pub status: char,
    pub added: Option<u32>,
    pub removed: Option<u32>,
    pub binary: bool,
    /// The unified diff, checkpoint → now (absent past [`EAGER_DIFFS`] until asked for).
    pub diff: Option<String>,
    /// The diff was cut at [`FILE_DIFF_BYTES`].
    pub cut: bool,
}

/// The files that differ now from checkpoint `row`.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Since {
    pub files: Vec<Change>,
    /// Files another tab's turn changed in between (for the dialog's flag).
    pub others: Vec<String>,
    /// Files left out of the folder's current state (size, budget, special).
    pub left_out: usize,
    /// Nested repositories in the folder (not captured).
    pub nested: Vec<String>,
}

/// What a restore did.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Restored {
    pub restored: usize,
    pub removed: usize,
    pub failed: Vec<Failure>,
    /// The `pre-restore` checkpoint: restore to it to undo this one.
    pub undo_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Failure {
    pub path: String,
    pub error: String,
}

/// Whether a restore leaves `path` alone: on disk it is now a file over the
/// snapshot cap or not an ordinary file, or it lies in a folder whose
/// `.gitignore` blocks git. Such a file is dropped from the store's index, so
/// git reports the checkpoint's copy as "deleted since", but the `pre-restore`
/// snapshot did not capture it either: writing the old version over it could
/// not be undone. (The dialog counts these as left out.)
fn left_alone(folder: &Path, path: &[u8]) -> bool {
    let mut dir = folder.to_path_buf();
    let parts: Vec<&[u8]> = path.split(|b| *b == b'/').collect();
    for part in &parts[..parts.len().saturating_sub(1)] {
        dir.push(rel_path(part));
        if special(&dir.join(".gitignore")).is_some() {
            return true;
        }
    }
    match std::fs::symlink_metadata(folder.join(rel_path(path))) {
        Ok(meta) => {
            let kind = meta.file_type();
            if kind.is_file() {
                meta.len() > MAX_FILE_BYTES
            } else {
                !(kind.is_dir() || kind.is_symlink())
            }
        }
        Err(_) => false,
    }
}

/// `git diff-index --cached --name-status` of `row`'s tree against the
/// (already staged) index, without what [`left_alone`] names.
fn name_status(store: &Store, tree: &str) -> Result<Vec<(char, GitPath)>, String> {
    let out = store.run_ok(
        &["diff-index", "--cached", "--name-status", "-z", "-r", "--no-renames", "--ignore-submodules=all", tree],
        None,
        LIST_CAP,
    )?;
    let mut parts = out.split(|b| *b == 0).filter(|s| !s.is_empty());
    let mut changes = Vec::new();
    while let (Some(status), Some(path)) = (parts.next(), parts.next()) {
        let status = status.first().copied().map(char::from).unwrap_or('M');
        if !matches!(status, 'A' | 'D' | 'M' | 'T') {
            continue;
        }
        if left_alone(&store.folder, path) {
            continue;
        }
        changes.push((status, path.to_vec()));
    }
    Ok(changes)
}

/// A path with its line counts, `None` for a binary file.
type Counted = (GitPath, Option<(u32, u32)>);

fn numstat(store: &Store, tree: &str) -> Result<Vec<Counted>, String> {
    let out = store.run_ok(
        &["diff-index", "--cached", "--numstat", "-z", "-r", "--no-renames", "--ignore-submodules=all", tree],
        None,
        LIST_CAP,
    )?;
    Ok(out
        .split(|b| *b == 0)
        .filter(|s| !s.is_empty())
        .filter_map(|record| {
            let mut fields = record.splitn(3, |b| *b == b'\t');
            let (added, removed, path) = (fields.next()?, fields.next()?, fields.next()?);
            let number = |field: &[u8]| std::str::from_utf8(field).ok()?.parse::<u32>().ok();
            let counts = number(added).zip(number(removed));
            Some((path.to_vec(), counts))
        })
        .collect())
}

/// The unified diff of one path, checkpoint → now, and whether it was cut.
fn file_diff(store: &Store, tree: &str, path: &[u8]) -> Result<(String, bool), String> {
    let mut cmd = store.git(&["diff-index", "-p", "--cached", "--no-renames", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "-U3", tree, "--"]);
    cmd.arg(spec_arg(":(literal)", path));
    let (out, cut) = store.exec(cmd, None, FILE_DIFF_BYTES, None).map_err(String::from)?;
    if !out.status.success() && !cut {
        return Err(format!("git diff-index: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok((String::from_utf8_lossy(&out.stdout).into_owned(), cut))
}

/// What differs between checkpoint `row` and the folder now. `paths`: only
/// these files' diffs are read (the rest of the answer is the same list
/// without diff text); `None` reads the first [`EAGER_DIFFS`].
pub fn since(store: &Store, row: &Row, who: &Who, paths: Option<&[String]>) -> Result<Since, String> {
    let _lock = store.lock()?;
    // Read again under the lock: a prune may have dropped it meanwhile.
    let row = &current(store, row)?;
    store.ensure(who.project_id.as_deref())?;
    let staged = stage(store, None)?;
    since_locked(store, row, who, paths, &staged)
}

/// `row` as the log has it now (the caller holds the lock).
fn current(store: &Store, row: &Row) -> Result<Row, String> {
    store.row(&row.id).filter(Row::has_snapshot).ok_or_else(|| "that checkpoint is gone".to_string())
}

fn since_locked(store: &Store, row: &Row, who: &Who, paths: Option<&[String]>, staged: &super::snapshot::Staged) -> Result<Since, String> {
    if !row.has_snapshot() {
        return Err("that checkpoint has no snapshot".into());
    }
    let status = name_status(store, &row.tree)?;
    let counts: std::collections::HashMap<GitPath, Option<(u32, u32)>> = numstat(store, &row.tree)?.into_iter().collect();
    let wanted: Option<HashSet<&str>> = paths.map(|p| p.iter().map(String::as_str).collect());
    let mut files = Vec::with_capacity(status.len());
    let mut spent = 0usize;
    for (i, (code, raw)) in status.into_iter().enumerate() {
        let path = shown(&raw);
        let (added, removed, binary) = match counts.get(&raw) {
            Some(Some((a, r))) => (Some(*a), Some(*r), false),
            Some(None) => (None, None, true),
            None => (None, None, false),
        };
        let wants_diff = match &wanted {
            Some(set) => set.contains(path.as_str()),
            None => i < EAGER_DIFFS && spent < EAGER_DIFF_BYTES,
        };
        let (diff, cut) = if wants_diff && !binary { file_diff(store, &row.tree, &raw).map(|(d, c)| (Some(d), c))? } else { (None, false) };
        spent += diff.as_ref().map_or(0, String::len);
        files.push(Change { path, status: code, added, removed, binary, diff, cut });
    }
    Ok(Since {
        files,
        others: others_changed(store, row, &who.tab_uid),
        left_out: staged.skipped.len(),
        nested: staged.nested.clone(),
    })
}

/// The files another tab's turns changed since `row`: for each `post` row of
/// another tab after it, the files between that tab's `pre` and `post`.
fn others_changed(store: &Store, row: &Row, my_uid: &str) -> Vec<String> {
    let rows = store.rows();
    let mut seen: HashSet<String> = HashSet::new();
    let mut turns = 0;
    for post in rows.iter().rev().filter(|r| r.kind == Kind::Post && r.at > row.at && r.tab_uid != my_uid) {
        let Some(pre) = rows.iter().rev().find(|r| r.kind == Kind::Pre && r.tab_uid == post.tab_uid && r.at <= post.at) else {
            continue;
        };
        if pre.tree == post.tree || pre.tree.is_empty() || post.tree.is_empty() {
            continue;
        }
        turns += 1;
        if turns > OTHER_TURNS {
            break;
        }
        let args = ["diff-tree", "-r", "--name-only", "-z", "--no-renames", "--ignore-submodules=all", &pre.tree, &post.tree];
        if let Ok(out) = store.run_ok(&args, None, LIST_CAP) {
            seen.extend(out.split(|b| *b == 0).filter(|s| !s.is_empty()).map(|s| String::from_utf8_lossy(s).into_owned()));
        }
    }
    let mut out: Vec<String> = seen.into_iter().collect();
    out.sort();
    out
}

/// Whether `rel` (a git path, `/`-separated) is safe to write or remove under
/// `folder`: relative, no `.`/`..`/empty/`.git` component, and no leading
/// component that is a link or not a folder. A leading component that does
/// not exist yet is fine (git creates it).
pub fn plain_path(folder: &Path, rel: impl AsRef<[u8]>) -> Result<(), String> {
    let rel = rel.as_ref();
    let parts: Vec<&[u8]> = rel.split(|b| *b == b'/').collect();
    if rel.is_empty() || parts.iter().any(|c| c.is_empty() || *c == b"." || *c == b".." || c.eq_ignore_ascii_case(b".git")) {
        return Err("not a path inside the folder".into());
    }
    if cfg!(windows) && parts.iter().any(|c| c.iter().any(|b| matches!(b, b'\\' | b':'))) {
        return Err("not a path inside the folder".into());
    }
    let mut at = folder.to_path_buf();
    for part in &parts[..parts.len() - 1] {
        at.push(rel_path(part));
        match std::fs::symlink_metadata(&at) {
            Ok(meta) if meta.file_type().is_symlink() => return Err(format!("{} is a link", shown(part))),
            Ok(meta) if !meta.is_dir() => return Err(format!("{} is not a folder", shown(part))),
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}

/// Put the files back that differ from checkpoint `row`. `paths`: only these
/// (`None` = every differing file). The caller has checked the agent is idle.
pub fn restore(store: &Store, row: &Row, who: &Who, paths: Option<&[String]>) -> Result<Restored, String> {
    if !row.has_snapshot() {
        return Err("that checkpoint has no snapshot".into());
    }
    let _lock = store.lock()?;
    let row = &current(store, row)?;
    store.ensure(who.project_id.as_deref())?;
    // The way back first: this stages the folder too, so the diff below is
    // against exactly what the undo would restore.
    let undo = snapshot_locked(store, Kind::PreRestore, who, None)?;
    let status = name_status(store, &row.tree)?;
    let wanted: Option<HashSet<&str>> = paths.map(|p| p.iter().map(String::as_str).collect());
    let mut result = Restored { undo_id: undo.id.clone(), ..Restored::default() };

    let mut remove = Vec::new();
    let mut checkout = Vec::new();
    for (code, path) in status {
        if wanted.as_ref().is_some_and(|set| !set.contains(shown(&path).as_str())) {
            continue;
        }
        if let Err(error) = plain_path(&store.folder, &path) {
            result.failed.push(Failure { path: shown(&path), error });
            continue;
        }
        if code == 'A' {
            remove.push(path);
        } else {
            checkout.push(path);
        }
    }

    for raw in remove {
        let target = store.folder.join(rel_path(&raw));
        let path = shown(&raw);
        match std::fs::symlink_metadata(&target) {
            Ok(meta) if meta.is_dir() => result.failed.push(Failure { path, error: "is now a folder".into() }),
            Ok(_) => match std::fs::remove_file(&target) {
                Ok(()) => result.removed += 1,
                Err(e) => result.failed.push(Failure { path, error: e.to_string() }),
            },
            // Gone already: nothing to take away.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => result.removed += 1,
            Err(e) => result.failed.push(Failure { path, error: e.to_string() }),
        }
    }

    // A file the checkpoint had where a folder is now: the folder's added
    // files were just removed, so an empty one can go.
    for path in &checkout {
        let target = store.folder.join(rel_path(path));
        if std::fs::symlink_metadata(&target).is_ok_and(|m| m.is_dir()) {
            let _ = std::fs::remove_dir(&target);
        }
    }

    let mut chunk: Vec<GitPath> = Vec::new();
    let mut bytes = 0;
    let mut batches: Vec<Vec<GitPath>> = Vec::new();
    for path in checkout {
        let len = ":(literal)".len() + path.len();
        if bytes + len > CHUNK_BYTES && !chunk.is_empty() {
            batches.push(std::mem::take(&mut chunk));
            bytes = 0;
        }
        bytes += len + 1;
        chunk.push(path);
    }
    if !chunk.is_empty() {
        batches.push(chunk);
    }
    for batch in batches {
        let mut cmd = store.git(&["checkout", &row.commit, "--"]);
        cmd.args(batch.iter().map(|path| spec_arg(":(literal)", path)));
        let error = match store.exec(cmd, None, 1 << 20, None) {
            Ok((out, _)) if out.status.success() => {
                result.restored += batch.len();
                continue;
            }
            Ok((out, _)) => String::from_utf8_lossy(&out.stderr).trim().to_string(),
            Err(error) => error.to_string(),
        };
        result.failed.extend(batch.iter().map(|path| Failure { path: shown(path), error: error.clone() }));
    }

    let at = crate::clock::now_ms();
    store.append(&Row {
        id: new_id(at),
        kind: Kind::Restore,
        commit: String::new(),
        tree: String::new(),
        tab_uid: who.tab_uid.clone(),
        tab_label: who.tab_label.clone(),
        cli: who.cli.clone(),
        session_id: who.session_id.clone(),
        at,
        prompt_at: None,
        raced: false,
        partial: false,
        skipped: Vec::new(),
        nested: Vec::new(),
        restored_to: Some(row.id.clone()),
        paths: Some(result.restored + result.removed),
    })?;
    Ok(result)
}
