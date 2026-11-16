//! One snapshot of a folder into its checkpoint store.
//!
//! 1. The store's ignore file is regenerated: the folder's own git ignore
//!    rules (the repo's `info/exclude`, read through `git_guard`, never raw)
//!    plus the linked worktrees nested in the root (they are folders of their
//!    own). The folder's `.gitignore` files apply as git applies them.
//! 2. Folders git would wait on forever (their `.gitignore` is a named pipe:
//!    git opens it with a plain blocking `open`) are kept out: the ones a
//!    stored file sits in and the ones found before are checked with a
//!    `stat`; a new one makes the first walk stall, and is then looked for
//!    ([`LIST_TIMEOUT`], [`FIND_ENTRIES`]). Their files leave the index (an
//!    indexed file draws git into its folder) and every walk carries an
//!    exclude pathspec for them. The row names them (`blocked`).
//! 3. The folder is listed (`ls-files`, tracked-by-the-store and not) and each
//!    entry is `lstat`ed: a file over [`MAX_FILE_BYTES`], a pipe, socket or
//!    device is left out and named; when the files new to the store pass
//!    [`NEW_BYTES_BUDGET`] the largest are left out until they fit (`partial`).
//! 4. `git add -A` with an exclude pathspec for every left-out path updates the
//!    store's index (a pathspec, not an ignore line: a `.gitignore` negation
//!    outranks `core.excludesFile` and would let the folder take them back),
//!    and `git write-tree` names the tree.
//! 5. A tree equal to the newest row's reuses its commit; otherwise a
//!    parentless commit (a parent chain would keep every pruned snapshot
//!    alive) is written and `refs/ckpt/<id>` keeps it.
//!
//! Paths stay bytes ([`GitPath`]) until they are shown: a file name need not
//! be UTF-8, and a lossy copy would name a file that does not exist.
//!
//! The caller holds the store's lock. Every git call is bounded and runs with
//! none of the folder's, the user's or the system's config
//! (`git_hardened::checkpoint_git_command`).

use std::collections::BTreeSet;
use std::path::Path;
use std::time::Duration;

use super::store::{new_id, rel_path, shown, spec_arg, GitPath, Kind, Row, Skipped, Store, REF_PREFIX};
use crate::services::git_bounded::RunError;

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
/// The first walk of the folder (`ls-files --others`) gets this long before a
/// blocking `.gitignore` is looked for: far over a big project's listing, far
/// under git's own two minutes.
const LIST_TIMEOUT: Duration = Duration::from_secs(45);
/// Entries the search for a blocking `.gitignore` looks at before it gives up.
const FIND_ENTRIES: usize = 200_000;
/// Folders kept out at most (each is an argument of every walk).
const MAX_BLOCKED: usize = 64;
/// The exclude pathspec magic: literal, and absolute (no ignore rule outranks it).
const EXCLUDE: &str = ":(exclude,literal)";

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
    let store = Store::for_bound(root, folder)?;
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
    let top = store.folder.join(".gitignore");
    if let Some(what) = special(&top) {
        return Err(format!(
            "{} is {what}: git would wait on it forever, so no checkpoint is taken until it is a regular file again",
            top.display()
        ));
    }
    write_ignore(store, &ignore_text(&store.folder))?;

    let tracked = split_z(&store.run_ok(&["ls-files", "-z", "--cached"], None, LIST_CAP)?);
    let mut blocked = blocked_among(store, &tracked);
    let mut tracked = drop_under(store, tracked, &blocked)?;
    let mut searched = false;
    let untracked = loop {
        match list_others(store, &blocked) {
            Ok(list) => break list,
            Err(RunError::TimedOut(why)) if !searched => {
                searched = true;
                let found = find_blocked(&store.folder, &blocked);
                if found.is_empty() {
                    return Err(format!("{why} No `.gitignore` that is a pipe was found in the first {FIND_ENTRIES} entries."));
                }
                tracked = drop_under(store, tracked, &found)?;
                blocked.extend(found);
            }
            Err(e) => return Err(e.to_string()),
        }
    };
    if blocked.len() > MAX_BLOCKED {
        return Err(format!("more than {MAX_BLOCKED} folders have a .gitignore that is a pipe"));
    }
    if blocked != store.blocked() {
        store.set_blocked(&blocked)?;
    }

    let mut staged = Staged::default();
    for dir in &blocked {
        staged.skipped.push(Skipped { path: format!("{}/", shown(dir)), bytes: 0, reason: "blocked".into() });
        staged.partial = true;
    }
    let mut leave_out: Vec<GitPath> = Vec::new();
    let mut drop_from_index: Vec<GitPath> = Vec::new();
    let mut new_files: Vec<(GitPath, u64)> = Vec::new();
    let mut newest_ms: u64 = 0;

    for path in &tracked {
        match look(&store.folder, path) {
            Look::File { bytes, modified } => {
                newest_ms = newest_ms.max(modified);
                if bytes > limits.max_file {
                    staged.skipped.push(Skipped { path: shown(path), bytes, reason: "size".into() });
                    drop_from_index.push(path.clone());
                    leave_out.push(path.clone());
                }
            }
            Look::Special => {
                staged.skipped.push(Skipped { path: shown(path), bytes: 0, reason: "special".into() });
                drop_from_index.push(path.clone());
                leave_out.push(path.clone());
            }
            Look::Link { modified } => newest_ms = newest_ms.max(modified),
            // A folder the store tracks is a nested repository's gitlink.
            Look::Folder => staged.nested.push(shown(path)),
            Look::Gone => {}
        }
    }
    for path in &untracked {
        if let Some(repo) = path.strip_suffix(b"/") {
            staged.nested.push(shown(repo));
            continue;
        }
        match look(&store.folder, path) {
            Look::File { bytes, modified } => {
                newest_ms = newest_ms.max(modified);
                if bytes > limits.max_file {
                    staged.skipped.push(Skipped { path: shown(path), bytes, reason: "size".into() });
                    leave_out.push(path.clone());
                } else {
                    new_files.push((path.clone(), bytes));
                }
            }
            Look::Special => {
                staged.skipped.push(Skipped { path: shown(path), bytes: 0, reason: "special".into() });
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
            staged.skipped.push(Skipped { path: shown(path), bytes: *bytes, reason: "budget".into() });
            leave_out.push(path.clone());
        }
        staged.partial = true;
    }
    staged.raced = raced_since.is_some_and(|since| newest_ms > since);

    if !drop_from_index.is_empty() {
        force_remove(store, &drop_from_index)?;
    }

    let mut specs = b".\0".to_vec();
    for out in excluded(&blocked).iter().chain(&leave_out) {
        specs.extend_from_slice(EXCLUDE.as_bytes());
        specs.extend_from_slice(out);
        specs.push(0);
    }
    let added = store.run(&["add", "-A", "--ignore-errors", "--pathspec-from-file=-", "--pathspec-file-nul"], Some(specs), SMALL)?;
    if !added.status.success() {
        let err = String::from_utf8_lossy(&added.stderr).into_owned();
        let failed = err.lines().any(|l| l.starts_with("fatal:") || l.starts_with("error:"));
        if !failed && err.contains("are ignored by one of your .gitignore files") {
            // An exclude pathspec naming a path that is ignored anyway is
            // reported as "ignored" (exit 1); everything else was added.
        } else if err.contains("unable to index") || err.contains("could not be added") || err.contains("does not have a commit") {
            // `--ignore-errors` still exits non-zero for a file it could not
            // read (permissions, a nested repository with no commit): the
            // rest was added.
            staged.partial = true;
        } else {
            return Err(format!("git add: {}", err.trim()));
        }
    }
    staged.tree = store.text(&["write-tree"])?;
    Ok(staged)
}

/// What every walk keeps out of besides the left-out files: the blocked
/// folders and the linked worktrees folder (in the ignore file too, but a
/// `.gitignore` negation outranks that).
fn excluded(blocked: &[GitPath]) -> Vec<GitPath> {
    let mut out = blocked.to_vec();
    out.push(crate::brand::WORKTREES_DIR.as_bytes().to_vec());
    out
}

/// The untracked, not ignored files (`ls-files --others`), outside `blocked`.
/// Stopped at [`LIST_TIMEOUT`].
fn list_others(store: &Store, blocked: &[GitPath]) -> Result<Vec<GitPath>, RunError> {
    let mut cmd = store.git(&["ls-files", "-z", "--others", "--exclude-standard", "--", "."]);
    cmd.args(excluded(blocked).iter().map(|dir| spec_arg(EXCLUDE, dir)));
    let (out, cut) = store.exec(cmd, None, LIST_CAP, Some(LIST_TIMEOUT))?;
    if cut {
        return Err(RunError::Refused(format!("git ls-files wrote more than {LIST_CAP} bytes")));
    }
    if !out.status.success() {
        return Err(RunError::Refused(format!("git ls-files: {}", String::from_utf8_lossy(&out.stderr).trim())));
    }
    Ok(split_z(&out.stdout))
}

fn force_remove(store: &Store, paths: &[GitPath]) -> Result<(), String> {
    let mut stdin = Vec::new();
    for path in paths {
        stdin.extend_from_slice(path);
        stdin.push(0);
    }
    store.run_ok(&["update-index", "--force-remove", "-z", "--stdin"], Some(stdin), SMALL).map(|_| ())
}

/// Whether `path` lies in folder `dir`.
pub fn under(path: &[u8], dir: &[u8]) -> bool {
    path.len() > dir.len() && path.starts_with(dir) && path[dir.len()] == b'/'
}

/// `tracked` without the files in `blocked`, which leave the store's index.
fn drop_under(store: &Store, tracked: Vec<GitPath>, blocked: &[GitPath]) -> Result<Vec<GitPath>, String> {
    if blocked.is_empty() {
        return Ok(tracked);
    }
    let (gone, kept): (Vec<GitPath>, Vec<GitPath>) =
        tracked.into_iter().partition(|path| blocked.iter().any(|dir| under(path, dir)));
    if !gone.is_empty() {
        force_remove(store, &gone)?;
    }
    Ok(kept)
}

/// Whether git would wait forever reading folder `dir`'s `.gitignore`: `dir`
/// is a real folder (git never walks into a link) holding one that is a pipe,
/// socket or device.
fn blocks(folder: &Path, dir: &[u8]) -> bool {
    let dir = folder.join(rel_path(dir));
    std::fs::symlink_metadata(&dir).is_ok_and(|m| m.is_dir()) && special(&dir.join(".gitignore")).is_some()
}

/// The folders that block git among those the store holds a file in and those
/// found before: a `stat` each.
fn blocked_among(store: &Store, tracked: &[GitPath]) -> Vec<GitPath> {
    let remembered = store.blocked();
    let mut dirs: BTreeSet<&[u8]> = remembered.iter().map(Vec::as_slice).collect();
    for path in tracked {
        for (i, b) in path.iter().enumerate() {
            if *b == b'/' {
                dirs.insert(&path[..i]);
            }
        }
    }
    dirs.into_iter().filter(|dir| blocks(&store.folder, dir)).map(<[u8]>::to_vec).collect()
}

/// A walk of the folder for folders that block git, after a listing stalled:
/// links are not followed, and `.git`, nested repositories, the linked
/// worktrees folder and the folders in `known` are not entered. Gives up after
/// [`FIND_ENTRIES`] entries.
fn find_blocked(folder: &Path, known: &[GitPath]) -> Vec<GitPath> {
    let worktrees = crate::brand::WORKTREES_DIR.as_bytes();
    let mut found = Vec::new();
    let mut seen = 0usize;
    let mut stack: Vec<GitPath> = vec![Vec::new()];
    while let Some(rel) = stack.pop() {
        let dir = if rel.is_empty() { folder.to_path_buf() } else { folder.join(rel_path(&rel)) };
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            seen += 1;
            if seen > FIND_ENTRIES {
                return found;
            }
            let Ok(kind) = entry.file_type() else { continue };
            if !kind.is_dir() {
                continue;
            }
            let name = name_bytes(&entry.file_name());
            if name == b".git" {
                continue;
            }
            let mut child = rel.clone();
            if !child.is_empty() {
                child.push(b'/');
            }
            child.extend_from_slice(&name);
            if child == worktrees || known.contains(&child) || entry.path().join(".git").symlink_metadata().is_ok() {
                continue;
            }
            if special(&entry.path().join(".gitignore")).is_some() {
                found.push(child);
            } else {
                stack.push(child);
            }
        }
    }
    found
}

/// A file name as git spells it.
fn name_bytes(name: &std::ffi::OsStr) -> Vec<u8> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        name.as_bytes().to_vec()
    }
    #[cfg(not(unix))]
    {
        name.to_string_lossy().into_owned().into_bytes()
    }
}

/// What `path` is when git would block opening it, not following a link
/// (git opens an in-tree `.gitignore` without following one): a named pipe,
/// socket or device.
pub fn special(path: &Path) -> Option<&'static str> {
    let kind = std::fs::symlink_metadata(path).ok()?.file_type();
    if kind.is_file() || kind.is_dir() || kind.is_symlink() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileTypeExt;
        if kind.is_fifo() {
            return Some("a named pipe");
        }
        if kind.is_socket() {
            return Some("a socket");
        }
        Some("a device")
    }
    #[cfg(not(unix))]
    Some("not a regular file")
}

/// What an entry of the listing is on disk.
enum Look {
    File { bytes: u64, modified: u64 },
    Link { modified: u64 },
    Folder,
    Special,
    Gone,
}

fn look(folder: &Path, path: &[u8]) -> Look {
    if path.split(|b| *b == b'/').any(|c| c == b".." || c.is_empty()) {
        return Look::Gone;
    }
    let Ok(meta) = std::fs::symlink_metadata(folder.join(rel_path(path))) else { return Look::Gone };
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

/// A `-z` listing's paths, as bytes.
pub fn split_z(bytes: &[u8]) -> Vec<GitPath> {
    bytes.split(|b| *b == 0).filter(|s| !s.is_empty()).map(<[u8]>::to_vec).collect()
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

/// The git dir whose `info/exclude` applies to `folder`: its own `.git`
/// folder, or for a linked worktree of a project
/// (`<root>/<worktrees dir>/<name>`, whose `.git` is a pointer file) the
/// root's. A repo further up (a dotfiles repo around the project) is not
/// the folder's and is never read.
pub fn repo_git_dir(folder: &Path) -> Option<std::path::PathBuf> {
    let is_dir = |p: &Path| std::fs::symlink_metadata(p).is_ok_and(|m| m.is_dir());
    let own = folder.join(".git");
    if is_dir(&own) {
        return Some(own);
    }
    let parent = folder.parent()?;
    let depth = crate::brand::WORKTREES_DIR.split('/').count();
    let root = parent.ancestors().nth(depth)?;
    let worktrees = crate::brand::WORKTREES_DIR.split('/').fold(root.to_path_buf(), |path, seg| path.join(seg));
    let git = root.join(".git");
    (worktrees == parent && is_dir(&git)).then_some(git)
}

/// The repo-level ignore file of [`repo_git_dir`]. A link, a FIFO or an
/// oversize file there reads as nothing.
fn repo_ignore(folder: &Path) -> Option<String> {
    let git_dir = repo_git_dir(folder)?;
    match crate::services::git_guard::read_info_exclude(&git_dir) {
        Ok(text) => text,
        Err(why) => {
            eprintln!("checkpoints: the repo's ignore file is not read: {why}");
            None
        }
    }
}
