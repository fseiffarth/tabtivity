//! The checkpoint store of one folder: where it lives, its log, and the one
//! way git is run against it.
//!
//! ```text
//! <state_dir>/checkpoints/<key>/      key = first 16 hex of sha256(canonical folder)
//!   store.git/                        the git dir (objects, refs/ckpt/<id>)
//!   index                             GIT_INDEX_FILE: the stat cache that keeps re-snapshots fast
//!   ignore                            core.excludesFile, regenerated each snapshot
//!   meta.json                         { folder, projectId, created, gcPending }
//!   log.jsonl                         one row per checkpoint / restore
//!   store.lock                        advisory lock (this process's worker and any other process)
//!   blocked                           folders git must not enter (their `.gitignore` is a pipe), NUL-separated
//! ```
//!
//! Nothing here is under the folder's own `.git`, and the folder's repo config
//! is never read: [`Store::git`] builds every call through
//! `git_hardened::checkpoint_git_command`.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Output;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::services::git_bounded as bounded;
use crate::services::git_hardened::{checkpoint_git_command, CheckpointRepo};
use crate::storage::FileLock;

/// The store folder under the state dir.
pub const DIR: &str = "checkpoints";

/// The ref namespace a row keeps its commit alive under.
pub const REF_PREFIX: &str = "refs/ckpt/";

/// What a row records.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    /// Taken as a turn began.
    Pre,
    /// Taken as a turn ended.
    Post,
    /// The user's "Checkpoint now".
    Manual,
    /// Taken just before a restore: the Undo restore target.
    PreRestore,
    /// A restore (log only: no commit).
    Restore,
}

/// A file a snapshot left out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Skipped {
    pub path: String,
    pub bytes: u64,
    /// `size` (over the per-file cap), `budget` (the new-bytes budget ran out),
    /// `special` (a pipe, socket or device) or `unreadable`.
    pub reason: String,
}

/// One log line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    /// Opaque, time-ordered; also the ref's name under [`REF_PREFIX`].
    pub id: String,
    pub kind: Kind,
    /// The snapshot commit (empty on a restore row).
    #[serde(default)]
    pub commit: String,
    #[serde(default)]
    pub tree: String,
    #[serde(default)]
    pub tab_uid: String,
    #[serde(default)]
    pub tab_label: String,
    #[serde(default)]
    pub cli: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Milliseconds since the epoch.
    pub at: u64,
    /// When the turn's prompt landed (`pre` rows), milliseconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_at: Option<u64>,
    /// A file newer than the prompt was already in the snapshot: the agent may
    /// have started writing before it was taken.
    #[serde(default)]
    pub raced: bool,
    /// Some files were left out (budget, unreadable).
    #[serde(default)]
    pub partial: bool,
    #[serde(default)]
    pub skipped: Vec<Skipped>,
    /// Nested repositories, stored as gitlinks (their contents are not captured).
    #[serde(default)]
    pub nested: Vec<String>,
    /// A restore row: the checkpoint it restored to, and how many paths.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restored_to: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paths: Option<usize>,
}

impl Row {
    /// Whether the row names a commit a restore can go back to.
    pub fn has_snapshot(&self) -> bool {
        self.kind != Kind::Restore && !self.commit.is_empty()
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub folder: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default)]
    pub created: u64,
    /// Refs dropped since the last `git gc`.
    #[serde(default)]
    pub gc_pending: u32,
}

/// The most of a log file read: far over [`super::MAX_ROWS`] rows of any
/// size the snapshot writes.
const MAX_LOG_BYTES: u64 = 32 * 1024 * 1024;

/// A path as git lists it: `/`-separated bytes. A file name need not be UTF-8,
/// so it is kept as git wrote it until it is shown.
pub type GitPath = Vec<u8>;

/// `rel` (a [`GitPath`]) as a path to join onto the folder. On Windows git's
/// paths are UTF-8.
pub fn rel_path(rel: &[u8]) -> PathBuf {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        PathBuf::from(std::ffi::OsStr::from_bytes(rel))
    }
    #[cfg(not(unix))]
    {
        PathBuf::from(String::from_utf8_lossy(rel).into_owned())
    }
}

/// `rel` as the window shows it (a name that is not UTF-8 is shown lossily;
/// it is never looked up by that text).
pub fn shown(rel: &[u8]) -> String {
    String::from_utf8_lossy(rel).into_owned()
}

/// A pathspec argument `<magic><rel>` (`:(literal)`, `:(exclude,literal)`),
/// the bytes kept as they are.
pub fn spec_arg(magic: &str, rel: &[u8]) -> OsString {
    let mut bytes = magic.as_bytes().to_vec();
    bytes.extend_from_slice(rel);
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStringExt;
        OsString::from_vec(bytes)
    }
    #[cfg(not(unix))]
    {
        OsString::from(String::from_utf8_lossy(&bytes).into_owned())
    }
}

/// A store being removed is first renamed to `<root>/<TRASH_PREFIX><key>-<id>`.
pub const TRASH_PREFIX: &str = ".removing-";

/// The checkpoints folder under `state_dir`.
pub fn root_in(state_dir: &Path) -> PathBuf {
    state_dir.join(DIR)
}

/// `folder`'s store key: the first 16 hex digits of the digest of its
/// canonical path.
pub fn key_of(folder: &Path) -> String {
    let text = crate::paths::display_path(folder);
    crate::digest::sha256_hex(text.as_bytes())[..16].to_string()
}

/// Whether `id` has the shape [`new_id`] mints. The id is a ref name and a
/// path component of nothing else: anything else is never used.
pub fn valid_id(id: &str) -> bool {
    id.len() == 20 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// A fresh id: the time in milliseconds (so ids sort by age) and 32 random bits.
pub fn new_id(at_ms: u64) -> String {
    let mut bytes = [0u8; 4];
    let _ = getrandom::fill(&mut bytes);
    format!("{:012x}{}", at_ms & 0xffff_ffff_ffff, crate::digest::hex(&bytes))
}

/// The store of one folder.
#[derive(Debug, Clone)]
pub struct Store {
    pub dir: PathBuf,
    /// The canonical folder (the work tree).
    pub folder: PathBuf,
}

impl Store {
    /// The store for `folder` under `root` (the checkpoints folder). The
    /// folder must exist; it is canonicalized, so two spellings share a store.
    pub fn for_folder(root: &Path, folder: &Path) -> Result<Self, String> {
        let folder = folder.canonicalize().map_err(|e| format!("{}: {e}", folder.display()))?;
        if !folder.is_dir() {
            return Err(format!("{} is not a folder", folder.display()));
        }
        Ok(Self { dir: root.join(key_of(&folder)), folder })
    }

    /// [`Self::for_folder`] for the folder a tab was bound to, which is already
    /// canonical: refused when it now resolves somewhere else. A linked
    /// worktree's folder lies inside the project, where an agent can swap it
    /// for a link, and the host's snapshot would then read whatever the link
    /// names (into a store of its own) and a restore could write there.
    pub fn for_bound(root: &Path, folder: &Path) -> Result<Self, String> {
        let store = Self::for_folder(root, folder)?;
        if store.folder != folder {
            return Err(format!("{} now resolves to {}: not checkpointed", folder.display(), store.folder.display()));
        }
        Ok(store)
    }

    /// An existing store folder `dir` (its meta names the folder).
    pub fn at(dir: PathBuf) -> Option<Self> {
        let meta: Meta = crate::storage::read_json(&dir.join("meta.json")).ok()?;
        Some(Self { dir, folder: PathBuf::from(meta.folder) })
    }

    pub fn key(&self) -> String {
        self.dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
    }

    pub fn git_dir(&self) -> PathBuf {
        self.dir.join("store.git")
    }

    pub fn index(&self) -> PathBuf {
        self.dir.join("index")
    }

    /// The ignore file the store's git reads (`core.excludesFile`).
    pub fn ignore_file(&self) -> PathBuf {
        self.dir.join("ignore")
    }

    fn meta_path(&self) -> PathBuf {
        self.dir.join("meta.json")
    }

    fn log_path(&self) -> PathBuf {
        self.dir.join("log.jsonl")
    }

    fn blocked_path(&self) -> PathBuf {
        self.dir.join("blocked")
    }

    /// The folders a snapshot found git cannot enter, remembered so the next
    /// one keeps out of them without waiting for git first.
    pub fn blocked(&self) -> Vec<GitPath> {
        // The store is under the state dir, out of every fence's reach.
        let Ok(bytes) = std::fs::read(self.blocked_path()) else { return Vec::new() };
        bytes.split(|b| *b == 0).filter(|s| !s.is_empty()).map(<[u8]>::to_vec).collect()
    }

    /// Replace [`Self::blocked`]. The caller holds [`Self::lock`].
    pub fn set_blocked(&self, dirs: &[GitPath]) -> Result<(), String> {
        if dirs.is_empty() {
            return match std::fs::remove_file(self.blocked_path()) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("checkpoint store: {e}")),
                _ => Ok(()),
            };
        }
        let mut bytes = Vec::new();
        for dir in dirs {
            bytes.extend_from_slice(dir);
            bytes.push(0);
        }
        crate::storage::write_private_atomic(&self.blocked_path(), &bytes)
    }

    /// The store's lock, held for the length of a snapshot, restore or prune:
    /// serial across this process's worker and any other Tabtivity process
    /// working on the same folder.
    pub fn lock(&self) -> Result<FileLock, String> {
        std::fs::create_dir_all(&self.dir).map_err(|e| format!("{}: {e}", self.dir.display()))?;
        FileLock::exclusive(&self.dir.join("store")).map_err(|e| format!("checkpoint store lock: {e}"))
    }

    /// A git command against this store ([`checkpoint_git_command`]).
    pub fn git(&self, args: &[&str]) -> std::process::Command {
        let (git_dir, index, exclude) = (self.git_dir(), self.index(), self.ignore_file());
        let repo = CheckpointRepo { git_dir: &git_dir, work_tree: &self.folder, index: &index, exclude: &exclude };
        checkpoint_git_command(&repo, args)
    }

    /// [`Self::git`] with another work tree and index: a restore's private
    /// staging folder under the store, never the folder.
    pub fn git_in(&self, work_tree: &Path, index: &Path, args: &[&str]) -> std::process::Command {
        let (git_dir, exclude) = (self.git_dir(), self.ignore_file());
        let repo = CheckpointRepo { git_dir: &git_dir, work_tree, index, exclude: &exclude };
        checkpoint_git_command(&repo, args)
    }

    /// Run a command built by [`Self::git`], bounded (`timeout`: `None` = its
    /// verb's own ceiling): its output, and whether stdout was stopped at `cap`
    /// bytes (git was stopped there too). The folder's own repo is not
    /// prechecked: the store's git reads none of its files, and a pipe an
    /// agent plants there must not switch the checkpoints off. The one
    /// work-tree file that can block it, a `.gitignore`, is the snapshot's to
    /// check.
    pub(crate) fn exec(
        &self,
        mut cmd: std::process::Command,
        stdin: Option<Vec<u8>>,
        cap: u64,
        timeout: Option<Duration>,
    ) -> Result<(Output, bool), bounded::RunError> {
        let opts = bounded::Opts { stdin, stdout_cap: Some(cap), timeout, no_precheck: true, ..Default::default() };
        let ran = bounded::run(&mut cmd, opts)?;
        Ok((ran.output, ran.cut))
    }

    /// Run `git <args>` against the store, bounded: its output, and whether
    /// stdout was stopped at `cap` bytes (git was stopped there too).
    pub fn run_capped(&self, args: &[&str], stdin: Option<Vec<u8>>, cap: u64) -> Result<(Output, bool), String> {
        self.exec(self.git(args), stdin, cap, None).map_err(String::from)
    }

    /// [`Self::run_capped`] where a longer stdout is an error, never a short
    /// answer that reads as git's whole one.
    pub fn run(&self, args: &[&str], stdin: Option<Vec<u8>>, cap: u64) -> Result<Output, String> {
        let (output, cut) = self.run_capped(args, stdin, cap)?;
        if cut {
            return Err(format!("git {} wrote more than {} bytes", args.first().copied().unwrap_or(""), cap));
        }
        Ok(output)
    }

    /// [`Self::run`] that must succeed: stdout, or git's own message.
    pub fn run_ok(&self, args: &[&str], stdin: Option<Vec<u8>>, cap: u64) -> Result<Vec<u8>, String> {
        let out = self.run(args, stdin, cap)?;
        if out.status.success() {
            return Ok(out.stdout);
        }
        let err = String::from_utf8_lossy(&out.stderr);
        let err = err.trim();
        Err(format!("git {}: {}", args.first().copied().unwrap_or(""), if err.is_empty() { "failed" } else { err }))
    }

    /// [`Self::run_ok`] as trimmed text.
    pub fn text(&self, args: &[&str]) -> Result<String, String> {
        self.run_ok(args, None, 1 << 20).map(|b| String::from_utf8_lossy(&b).trim().to_string())
    }

    /// Create the store if it does not exist yet, and (re)write `meta.json`
    /// when new. The caller holds [`Self::lock`].
    pub fn ensure(&self, project_id: Option<&str>) -> Result<(), String> {
        let git_dir = self.git_dir();
        if !git_dir.join("HEAD").is_file() {
            std::fs::create_dir_all(&git_dir).map_err(|e| format!("{}: {e}", git_dir.display()))?;
            // No template: no sample hooks, no `info/` of the system's.
            self.run_ok(&["init", "-q", "--template="], None, 1 << 16)?;
            for (key, value) in [
                ("core.bare", "false"),
                ("core.logAllRefUpdates", "false"),
                ("core.symlinks", "true"),
                ("gc.auto", "0"),
            ] {
                self.run_ok(&["config", key, value], None, 1 << 16)?;
            }
            // A work tree named by the environment is never stored: it is
            // handed in again on every call.
            let _ = self.run(&["config", "--unset", "core.worktree"], None, 1 << 16);
        }
        if !self.meta_path().is_file() {
            let meta = Meta {
                folder: crate::paths::display_path(&self.folder),
                project_id: project_id.map(str::to_string),
                created: crate::clock::now_secs(),
                gc_pending: 0,
            };
            crate::storage::write_private_atomic(&self.meta_path(), &serde_json::to_vec(&meta).map_err(|e| e.to_string())?)?;
        }
        Ok(())
    }

    pub fn meta(&self) -> Option<Meta> {
        crate::storage::read_json(&self.meta_path()).ok()
    }

    /// Change the meta under the store lock the caller holds.
    pub fn update_meta(&self, edit: impl FnOnce(&mut Meta)) -> Result<(), String> {
        let mut meta = self.meta().ok_or("the checkpoint store has no meta")?;
        edit(&mut meta);
        crate::storage::write_private_atomic(&self.meta_path(), &serde_json::to_vec(&meta).map_err(|e| e.to_string())?)
    }

    /// Every row of the log, oldest first. A line that does not parse is
    /// skipped (a torn append); a log over [`MAX_LOG_BYTES`] reads as its
    /// last part.
    pub fn rows(&self) -> Vec<Row> {
        use std::io::{Read, Seek, SeekFrom};
        let Ok(mut file) = std::fs::File::open(self.log_path()) else { return Vec::new() };
        let Ok(len) = file.metadata().map(|m| m.len()) else { return Vec::new() };
        let mut bytes = Vec::new();
        if len > MAX_LOG_BYTES {
            let _ = file.seek(SeekFrom::Start(len - MAX_LOG_BYTES));
        }
        if file.take(MAX_LOG_BYTES).read_to_end(&mut bytes).is_err() {
            return Vec::new();
        }
        String::from_utf8_lossy(&bytes)
            .lines()
            .filter_map(|line| serde_json::from_str::<Row>(line.trim()).ok())
            .collect()
    }

    /// Append one row. The caller holds [`Self::lock`].
    pub fn append(&self, row: &Row) -> Result<(), String> {
        use std::io::Write;
        let mut line = serde_json::to_string(row).map_err(|e| e.to_string())?;
        line.push('\n');
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.log_path())
            .map_err(|e| format!("checkpoint log: {e}"))?;
        file.write_all(line.as_bytes()).map_err(|e| format!("checkpoint log: {e}"))
    }

    /// Replace the log with `rows`. The caller holds [`Self::lock`].
    pub fn write_rows(&self, rows: &[Row]) -> Result<(), String> {
        let mut text = String::new();
        for row in rows {
            text.push_str(&serde_json::to_string(row).map_err(|e| e.to_string())?);
            text.push('\n');
        }
        crate::storage::write_private_atomic(&self.log_path(), text.as_bytes())
    }

    /// The row `id`, if the log has it.
    pub fn row(&self, id: &str) -> Option<Row> {
        if !valid_id(id) {
            return None;
        }
        self.rows().into_iter().rev().find(|r| r.id == id)
    }

    /// The bytes the store takes on disk (a bounded walk; links are not followed).
    pub fn size(&self) -> u64 {
        dir_bytes(&self.dir, 0)
    }
}

/// The bytes of the regular files below `dir`, to a depth that covers a git
/// object store.
fn dir_bytes(dir: &Path, depth: usize) -> u64 {
    if depth > 6 {
        return 0;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    entries
        .flatten()
        .map(|entry| match entry.file_type() {
            Ok(t) if t.is_dir() => dir_bytes(&entry.path(), depth + 1),
            Ok(t) if t.is_file() => entry.metadata().map(|m| m.len()).unwrap_or(0),
            _ => 0,
        })
        .sum()
}

/// Every store folder under `root`, as stores that carry a readable meta. A
/// dot-named folder is a store on its way out ([`TRASH_PREFIX`]).
pub fn all_in(root: &Path) -> Vec<Store> {
    let Ok(entries) = std::fs::read_dir(root) else { return Vec::new() };
    entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .filter_map(|e| Store::at(e.path()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_time_ordered_and_only_their_own_shape_is_valid() {
        let a = new_id(1_700_000_000_000);
        let b = new_id(1_700_000_000_001);
        assert!(valid_id(&a) && valid_id(&b) && a < b, "{a} {b}");
        for bad in ["", "..", "../../x", "ABCDEF0123456789ABCD", "0123456789abcdef012", "0123456789abcdef01234", "refs/ckpt/x"] {
            assert!(!valid_id(bad), "{bad}");
        }
    }

    #[test]
    fn a_folder_has_one_key_and_two_folders_do_not_share_one() {
        let a = key_of(Path::new("/work/a"));
        assert_eq!(a.len(), 16);
        assert_eq!(a, key_of(Path::new("/work/a")));
        assert_ne!(a, key_of(Path::new("/work/b")));
    }

    #[test]
    fn rows_round_trip_and_a_torn_line_is_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        let folder = tmp.path().join("proj");
        std::fs::create_dir_all(&folder).unwrap();
        let store = Store::for_folder(&tmp.path().join("cp"), &folder).unwrap();
        std::fs::create_dir_all(&store.dir).unwrap();
        let row = Row {
            id: new_id(1),
            kind: Kind::Pre,
            commit: "c".into(),
            tree: "t".into(),
            tab_uid: "u".into(),
            tab_label: String::new(),
            cli: "claude".into(),
            session_id: Some("s".into()),
            at: 5,
            prompt_at: Some(4),
            raced: true,
            partial: false,
            skipped: vec![Skipped { path: "big".into(), bytes: 9, reason: "size".into() }],
            nested: vec![],
            restored_to: None,
            paths: None,
        };
        store.append(&row).unwrap();
        {
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new().append(true).open(store.log_path()).unwrap();
            f.write_all(b"{\"id\": \"torn\n").unwrap();
        }
        store.append(&Row { id: new_id(2), ..row.clone() }).unwrap();
        let rows = store.rows();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0], row);
        assert!(store.row(&row.id).is_some());
        assert!(store.row("../../etc").is_none());
    }
}
