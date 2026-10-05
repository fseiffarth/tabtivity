//! The **Undo** behind a PDF markup round that applied the marks directly
//! (`docs/pdf_markup_direct_apply_plan.md` §2.2).
//!
//! A Submit in `apply` mode first takes a snapshot of the project's git work
//! tree ([`begin`]); once the agent's turn has finished the round is settled
//! ([`settle`]: a second snapshot), and **Undo** ([`undo`]) writes every file
//! *inside the project folder* that differs between the two back as the
//! first snapshot holds it — refusing, and changing nothing, when one of them
//! is not exactly as the round left it (edited, removed or back again since).
//!
//! **Only the project's files.** The project folder may be a subfolder of a
//! larger repo. The snapshots still cover the whole work tree, so that the
//! files changed elsewhere in it during the round (a sibling project, the
//! repo's top) can be *named*: preview and undo list them as `outside`
//! (top-relative, bounded) and the undo leaves them as they are. What the
//! user or another tab changed inside the project between Submit and settle
//! is still put back with the round's own edits — a snapshot cannot tell
//! them apart (the preview names every file first).
//!
//! Both snapshots are ordinary git trees, written into the round's own object
//! store under the state dir, never into the project:
//! `<state_dir>/markup-rounds/<id>/` holds `round.json`, `objects/` (the
//! `GIT_OBJECT_DIRECTORY`), `index` (the `GIT_INDEX_FILE`) and an empty
//! `attributes`. Nothing under the repo's `.git` is written — not even an
//! object's mtime: git *freshens* an object it finds already stored instead
//! of writing it, so the calls that write objects (`add`, `write-tree`) never
//! see the repo's object dir; only the reading calls (`diff-tree`,
//! `cat-file`) get it, as a read-only `GIT_ALTERNATE_OBJECT_DIRECTORIES`. A
//! `git gc` there cannot prune a live snapshot.
//!
//! **Bytes, not git's idea of them.** The snapshot calls run with the work
//! tree's attributes switched off (`GIT_ATTR_SOURCE` = the empty tree,
//! `GIT_ATTR_NOSYSTEM`, a round-local `core.attributesFile`) and
//! `core.autocrlf=false`, so no end-of-line conversion, `ident` or filter
//! (Git LFS…) touches what is snapshotted (git 2.40 or later); the undo reads
//! blobs raw (`cat-file --batch`) and compares and writes plain bytes itself —
//! not `git apply`, which would convert again (and crashes under
//! `GIT_ATTR_SOURCE` in git 2.53). A repo whose `info/attributes` names a
//! conversion — which the switch cannot reach — gets no undo (`Filtered`).
//! Two ways to start:
//!
//! - **seeded** (whenever the repo has an index) — that index is copied in,
//!   so its stat cache spares re-reading unchanged files, and every tracked
//!   file is hashed as it is *without writing* (`hash-object --no-filters`);
//!   only a file whose bytes are not the blob the index names (a local edit,
//!   or a conversion on the way in: `core.autocrlf`, an `eol`/`ident`/filter
//!   attribute) is added again, raw. So only those and the untracked files
//!   are copied into the round ([`MAX_COPIED_FILES`], [`MAX_COPIED_BYTES`]);
//!   the unchanged blobs stay the repo's (`write-tree --missing-ok`), read
//!   through the alternate. The hashing pass is bounded too
//!   ([`MAX_HASHED_FILES`], [`MAX_HASHED_BYTES`]).
//! - **fresh** — no index (a repo with nothing added yet), or seeding failed:
//!   an empty index, every non-ignored file and every tracked one (ignored or
//!   not) hashed as it is, the whole tree bounded ([`MAX_TREE_FILES`],
//!   [`MAX_TREE_BYTES`]) since it is all copied in.
//!
//! A git-ignored PDF (the usual built PDF) is in neither tree: its bytes
//! before the round are kept as `before.pdf` and put back only when the PDF
//! has not changed since the round settled. Submodules are never touched.
//!
//! **Writes.** An undo first checks every changed file, then *stages* every
//! write — a temporary beside its file — before it changes anything, so a
//! failure up to there leaves the work tree as it was. Every write, rename
//! and removal goes through folders opened one plain name at a time from the
//! work tree's top (`openat(O_NOFOLLOW)` on Unix, [`Folder`]): a folder swapped
//! for a link after the check (another tab's agent is still running in this
//! project) is refused, never followed, so nothing is ever written outside
//! the work tree. The project folder must lie inside the work tree git names
//! (a planted `core.worktree` cannot point the round elsewhere).
//!
//! Every git call goes through `commands::git::hardened_git_command_in` (hooks
//! off, repo config sanitized, common dir pinned — none of which touches the
//! object, index or attribute variables set here), plus
//! `core.splitIndex=false` (a split index writes its shared half into the
//! repo's git dir), `core.untrackedCache=false`, `gc.auto=0`,
//! `GIT_NO_LAZY_FETCH` (a partial clone must not fetch), and each call is
//! killed after [`GIT_TIMEOUT`] — or sooner, once the operation it serves has
//! spent its [`OPERATION_BUDGET`] (a Submit waits for its snapshot). Nothing
//! here runs project code.
//!
//! AppHandle-free: the phone route (`mobile_control::host`) and the desktop
//! commands (`commands::pdf_markup`) pass the state dir and the round's
//! owner, which every call after [`begin`] checks.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// The rounds' folder under the state dir.
pub const ROUNDS_DIR: &str = "markup-rounds";
/// How long one git call may take before it is killed and the round has no
/// undo (or the call fails).
pub const GIT_TIMEOUT: Duration = Duration::from_secs(20);
/// What one begin, settle, preview or undo may spend on git altogether.
pub const OPERATION_BUDGET: Duration = Duration::from_secs(30);
/// What a seeded snapshot copies into the round: untracked files and tracked
/// ones whose bytes are not the index's blob. A data folder that is not
/// git-ignored must not be copied into the state dir every round.
pub const MAX_COPIED_FILES: usize = 5_000;
pub const MAX_COPIED_BYTES: u64 = 64 * 1024 * 1024;
/// What a seeded snapshot hashes (read, not stored): every tracked file.
pub const MAX_HASHED_FILES: usize = 50_000;
pub const MAX_HASHED_BYTES: u64 = 512 * 1024 * 1024;
/// A fresh snapshot copies the whole tree in.
pub const MAX_TREE_FILES: usize = 20_000;
pub const MAX_TREE_BYTES: u64 = 128 * 1024 * 1024;
/// The largest PDF whose bytes a round keeps as `before.pdf`.
pub const MAX_PDF_BYTES: usize = 64 * 1024 * 1024;
/// The most changed files a preview or an undo names; the rest are counted.
pub const MAX_LISTED: usize = 50;
/// The most an undo reads of the changed files' blobs, before and after.
const MAX_UNDO_BYTES: usize = 512 * 1024 * 1024;
/// Rounds older than this, and all but the newest [`KEEP_ROUNDS`], are pruned
/// whenever a round begins.
const KEEP_FOR: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const KEEP_ROUNDS: usize = 30;
/// The largest `info/attributes` read for a conversion; a larger one counts
/// as naming one.
const MAX_ATTRIBUTE_BYTES: u64 = 1024 * 1024;
/// The first git with `GIT_ATTR_SOURCE`.
const MIN_GIT: (u32, u32) = (2, 40);
/// The empty tree, as `GIT_ATTR_SOURCE`: no in-tree attributes.
const EMPTY_TREE_SHA1: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const EMPTY_TREE_SHA256: &str = "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321";

/// `-c` pairs on every call, before the subcommand (`hardened_git_command_in`
/// passes leading `-c` pairs through and adds its own pins in front).
const ROUND_CONFIG: &[&str] = &[
    "-c",
    "core.splitIndex=false",
    "-c",
    "core.untrackedCache=false",
    "-c",
    "gc.auto=0",
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.safecrlf=false",
];

/// Variables a caller's environment (a git hook running the app's tests, a
/// shell with `GIT_DIR` exported) could carry into a call and point it at
/// another repo, index or attribute source.
const FOREIGN_GIT_ENV: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_ATTR_SOURCE",
    "GIT_NAMESPACE",
    "GIT_PREFIX",
    "GIT_LITERAL_PATHSPECS",
    "GIT_GLOB_PATHSPECS",
    "GIT_NOGLOB_PATHSPECS",
    "GIT_ICASE_PATHSPECS",
];

/// Round operations in this process, one at a time — a settle and an undo of
/// the same round must not interleave. A round is only ever touched by the
/// process that began it (the phone's sidecar or the window).
static LOCK: Mutex<()> = Mutex::new(());

thread_local! {
    /// When the operation running on this thread must be done with git
    /// ([`Budget`]); `None` outside one.
    static DEADLINE: std::cell::Cell<Option<Instant>> = const { std::cell::Cell::new(None) };
}

/// One operation's [`OPERATION_BUDGET`], from now until dropped: every git
/// call it makes is killed at the budget's end at the latest.
struct Budget;

impl Budget {
    fn start() -> Self {
        DEADLINE.with(|deadline| deadline.set(Some(Instant::now() + OPERATION_BUDGET)));
        Budget
    }
}

impl Drop for Budget {
    fn drop(&mut self) {
        DEADLINE.with(|deadline| deadline.set(None));
    }
}

/// When a git call started now must end: [`GIT_TIMEOUT`] from now, or the
/// running operation's end when sooner.
fn call_deadline() -> Instant {
    let own = Instant::now() + GIT_TIMEOUT;
    DEADLINE.with(std::cell::Cell::get).map_or(own, |end| end.min(own))
}

/// Whose round it is: every call after [`begin`] must name the same owner.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Owner {
    /// A phone Submit: the public tab id and the tab's raw project id.
    Phone { tab: String, project: String },
    /// A desktop viewer Submit: the project id.
    Desktop { project: String },
}

/// Why a Submit asked for `apply` but runs as `list`: no snapshot, no undo.
/// `code()` is the wire's `noUndo`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoUndo {
    /// No `git` binary, or one older than 2.40.
    NoGit,
    /// The project folder is not inside a git work tree.
    NotGit,
    /// Too many (or too large) files to copy into the snapshot.
    TooBig,
    /// The repo's `info/attributes` names a conversion (a filter, `text`,
    /// `eol`…) the snapshot cannot switch off.
    Filtered,
    /// git failed or timed out.
    Failed,
    /// A remote project (decided by the caller): its work tree is not here.
    Remote,
    /// The marked file is a picture, not a PDF (decided by the caller).
    NotPdf,
}

impl NoUndo {
    pub fn code(self) -> &'static str {
        match self {
            NoUndo::NoGit => "no_git",
            NoUndo::NotGit => "not_git",
            NoUndo::TooBig => "too_big",
            NoUndo::Filtered => "filtered",
            NoUndo::Failed => "git_failed",
            NoUndo::Remote => "remote",
            NoUndo::NotPdf => "not_pdf",
        }
    }
}

/// Why a settle, preview or undo was refused. `code()` is the wire's error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RoundError {
    /// Not a round id, or not this owner's round.
    NotFound,
    /// Pruned, undone already, or it lost its undo at settle (too big).
    Gone,
    /// The round has not settled yet (no after-snapshot to undo).
    NotReady,
    /// A file the round changed has changed again since: nothing was changed.
    /// Project-relative names (at most [`MAX_LISTED`]), and how many more.
    Conflict { files: Vec<String>, more: usize },
    /// git failed or timed out.
    Failed,
}

impl RoundError {
    pub fn code(&self) -> &'static str {
        match self {
            RoundError::NotFound => "round_not_found",
            RoundError::Gone => "undo_gone",
            RoundError::NotReady => "undo_not_ready",
            RoundError::Conflict { .. } => "undo_conflict",
            RoundError::Failed => "undo_failed",
        }
    }
}

/// One file a round changed, named relative to the project folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Changed {
    pub path: String,
    /// `added`, `modified`, `deleted` (by the round) or `changed` (its type).
    pub change: &'static str,
}

/// What happens (preview) or happened (undo) to a PDF the tree does not hold.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PdfFate {
    /// Back as it was before the round.
    Restored,
    /// Changed since the round settled: left as it is.
    Kept,
    /// Nothing to put back (no copy kept, unchanged, or the tree holds it).
    None,
}

/// A round's changes: what an undo would put back, or did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Changes {
    /// The project folder's changed files — the only ones an undo touches.
    pub files: Vec<Changed>,
    /// The project's changed files not named: past [`MAX_LISTED`], or named
    /// so they could speak in a chat note.
    pub more: usize,
    /// Files changed in the same work tree but outside the project folder,
    /// named relative to the work tree's top (at most [`MAX_LISTED`]): an
    /// undo leaves them as they are — and a file the round moved *into* the
    /// project from outside it (its only copy now), named the same way. Not
    /// sent when empty; never sent to a phone ([`Changes::outside_counted`]).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub outside: Vec<String>,
    /// The ones outside not named (past the cap, or unspeakable names).
    #[serde(rename = "outsideMore")]
    pub outside_more: usize,
    pub pdf: PdfFate,
}

impl Changes {
    /// The phone's view: the names outside the project folder only counted.
    /// A phone may be scoped to this one project, and those names can be a
    /// sibling project's.
    pub fn outside_counted(mut self) -> Self {
        self.outside_more += self.outside.len();
        self.outside.clear();
        self
    }
}

/// `round.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Record {
    v: u32,
    owner: Owner,
    /// The project folder.
    root: PathBuf,
    /// The work tree's top, where every call runs.
    toplevel: PathBuf,
    /// `root` relative to `toplevel`, `/`-separated with a trailing `/`, or
    /// empty.
    prefix: String,
    /// The repo's own object dir, the reading calls' alternate — set for a
    /// seeded snapshot, whose unchanged blobs stay there.
    objects: Option<PathBuf>,
    /// The empty tree of the repo's hash, as `GIT_ATTR_SOURCE`.
    empty_tree: String,
    tree_before: String,
    tree_after: Option<String>,
    /// The marked PDF, relative to `root`, when `before.pdf` was kept.
    pdf: Option<String>,
    pdf_before_sha256: Option<String>,
    /// The PDF's digest when the round last settled; `None` = absent then.
    pdf_after_sha256: Option<String>,
    /// Seconds since the epoch.
    created: u64,
    undone: bool,
    /// Lost its undo at settle (the round grew past the bounds).
    lost: bool,
}

/// Whether `id` has the shape [`begin`] mints: 32 lowercase hex digits.
pub fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn rounds_dir(state_dir: &Path) -> PathBuf {
    state_dir.join(ROUNDS_DIR)
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn new_id() -> Option<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).ok()?;
    Some(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// The digest of the regular file at `path`, never through a symlink;
/// `None` when it is absent, a link or unreadable.
fn file_digest(path: &Path) -> Option<String> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let mut file = std::fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).ok()?;
    Some(format!("{:x}", hasher.finalize()))
}

/// A git call's failure.
#[derive(Debug, PartialEq, Eq)]
enum RunError {
    /// No `git` to spawn.
    Missing,
    /// Killed after [`GIT_TIMEOUT`], or its output passed the limit.
    Timeout,
    Io,
}

/// The ordinary output limit: name lists, tree ids.
const LIST_LIMIT: usize = 64 * 1024 * 1024;

/// Runs `cmd` with `stdin` fed in, its output read whole (at most `limit`
/// bytes of stdout), killed at [`call_deadline`].
fn run(mut cmd: Command, stdin: Option<Vec<u8>>, limit: usize) -> Result<Output, RunError> {
    let deadline = call_deadline();
    cmd.stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { RunError::Missing } else { RunError::Io })?;
    let writer = match (stdin, child.stdin.take()) {
        (Some(bytes), Some(mut pipe)) => Some(std::thread::spawn(move || {
            let _ = pipe.write_all(&bytes);
        })),
        _ => None,
    };
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(RunError::Io);
    };
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.take(limit as u64 + 1).read_to_end(&mut buf);
        buf
    });
    let errors = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr.take(64 * 1024).read_to_end(&mut buf);
        buf
    });
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                // The whole subtree, so no descendant keeps the pipes the
                // readers below are joined on (#2349).
                crate::terminal::reap_child_subtree(child.id(), crate::terminal::ReapMode::Immediate);
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let stdout = reader.join().unwrap_or_default();
    let stderr = errors.join().unwrap_or_default();
    if let Some(writer) = writer {
        let _ = writer.join();
    }
    match status {
        Some(status) if stdout.len() <= limit => Ok(Output { status, stdout, stderr }),
        _ => Err(RunError::Timeout),
    }
}

/// A hardened git command in `dir` that reads the repo as the user's own git
/// would (its config unpinned), the caller's own git variables dropped.
fn repo_git(dir: &Path, args: &[&str]) -> Command {
    let mut cmd = crate::commands::git::hardened_git_command_in(dir, args);
    for name in FOREIGN_GIT_ENV {
        cmd.env_remove(name);
    }
    cmd.env("GIT_NO_LAZY_FETCH", "1");
    cmd
}

/// `repo_git` with the round's pins ([`ROUND_CONFIG`]).
fn git_in(dir: &Path, args: &[&str]) -> Command {
    let mut all: Vec<&str> = ROUND_CONFIG.to_vec();
    all.extend_from_slice(args);
    repo_git(dir, &all)
}

/// The output of a successful call.
fn output_of(cmd: Command, limit: usize) -> Result<Vec<u8>, RunError> {
    let out = run(cmd, None, limit)?;
    if !out.status.success() {
        return Err(RunError::Io);
    }
    Ok(out.stdout)
}

/// A path as git reads it from the environment (no Windows `\\?\`).
fn env_path(path: &Path) -> String {
    crate::commands::fs::display_path(path)
}

/// `GIT_ALTERNATE_OBJECT_DIRECTORIES` holding one directory: quoted (git's
/// C-style quoting) when it holds the list separator or starts with a quote.
fn alternates_value(path: &Path) -> String {
    let text = env_path(path);
    let separator = if cfg!(windows) { ';' } else { ':' };
    if !text.contains(separator) && !text.starts_with('"') {
        return text;
    }
    let mut quoted = String::from("\"");
    for c in text.chars() {
        if c == '"' || c == '\\' {
            quoted.push('\\');
        }
        quoted.push(c);
    }
    quoted.push('"');
    quoted
}

/// NUL-separated output as strings (lossy), the empty tail dropped.
fn split_z(bytes: &[u8]) -> Vec<String> {
    bytes
        .split(|b| *b == 0)
        .filter(|part| !part.is_empty())
        .map(|part| String::from_utf8_lossy(part).into_owned())
        .collect()
}

/// Whether an attributes file's text sets an attribute that changes bytes
/// between the work tree and git: `text`, `eol`, `crlf`, `ident`, `filter`,
/// `working-tree-encoding` (`-text`, `!eol` and the like unset them — fine).
fn names_conversion(text: &str) -> bool {
    text.lines().any(|line| {
        let line = line.trim_start();
        if line.starts_with('#') {
            return false;
        }
        line.split_whitespace().skip(1).any(|attr| {
            let name = attr.split('=').next().unwrap_or(attr);
            matches!(name, "text" | "eol" | "crlf" | "ident" | "filter" | "working-tree-encoding")
        })
    })
}

/// Whether the git dir's `info/attributes` names a conversion; a file too
/// large to read counts as one, and so does one that cannot be vetted — a
/// linked `info` or `attributes` (git follows it), a FIFO, a folder. Opened
/// by handle, never through a link and never blocking (#2347: `info/` is
/// writable inside the fence).
fn info_attributes_name_conversion(common_dir: &Path) -> bool {
    use std::io::Read;
    let file = match crate::services::git_guard::open_info_file(common_dir, "attributes") {
        Ok(Some(file)) => file,
        Ok(None) => return false,
        Err(_) => return true,
    };
    let mut bytes = Vec::new();
    match file.take(MAX_ATTRIBUTE_BYTES + 1).read_to_end(&mut bytes) {
        Ok(_) if bytes.len() as u64 > MAX_ATTRIBUTE_BYTES => true,
        Ok(_) => names_conversion(&String::from_utf8_lossy(&bytes)),
        Err(_) => true,
    }
}

/// Where the project folder's repo is.
struct Located {
    toplevel: PathBuf,
    prefix: String,
    git_dir: PathBuf,
    common_dir: PathBuf,
    empty_tree: &'static str,
}

/// `git version` → whether it is at least [`MIN_GIT`].
fn new_enough(version: &str) -> bool {
    let numbers: Vec<u32> = version
        .split_whitespace()
        .nth(2)
        .unwrap_or_default()
        .split('.')
        .take(2)
        .map(|part| part.parse().unwrap_or(0))
        .collect();
    match numbers[..] {
        [major, minor] => (major, minor) >= MIN_GIT,
        _ => false,
    }
}

fn locate(root: &Path) -> Result<Located, NoUndo> {
    let version = run(git_in(root, &["version"]), None, 1024).map_err(|error| match error {
        RunError::Missing => NoUndo::NoGit,
        _ => NoUndo::Failed,
    })?;
    if !version.status.success() || !new_enough(&String::from_utf8_lossy(&version.stdout)) {
        return Err(NoUndo::NoGit);
    }
    let args = ["rev-parse", "--show-toplevel", "--show-prefix", "--git-dir", "--git-common-dir", "--show-object-format"];
    let out = run(git_in(root, &args), None, 64 * 1024).map_err(|_| NoUndo::Failed)?;
    if !out.status.success() {
        return Err(NoUndo::NotGit);
    }
    let text = String::from_utf8(out.stdout).map_err(|_| NoUndo::Failed)?;
    // A work tree at its top prints an empty prefix line, which `lines` keeps.
    let lines: Vec<&str> = text.lines().collect();
    let [toplevel, prefix, git_dir, common_dir, format] = lines[..] else {
        return Err(NoUndo::NotGit);
    };
    if toplevel.is_empty() {
        return Err(NoUndo::NotGit);
    }
    // The repo's config is the project's (attacker-controlled): a planted
    // `core.worktree` names a work tree elsewhere — `~/.ssh`, say — and an
    // undo writes into the work tree. The project folder must be inside it.
    let (Ok(top_real), Ok(root_real)) = (Path::new(toplevel).canonicalize(), root.canonicalize()) else {
        return Err(NoUndo::NotGit);
    };
    if !root_real.starts_with(&top_real) {
        return Err(NoUndo::NotGit);
    }
    let absolute = |p: &str| {
        let path = PathBuf::from(p);
        if path.is_absolute() { path } else { root.join(path) }
    };
    let empty_tree = match format {
        "sha1" => EMPTY_TREE_SHA1,
        "sha256" => EMPTY_TREE_SHA256,
        _ => return Err(NoUndo::Failed),
    };
    Ok(Located {
        toplevel: PathBuf::from(toplevel),
        prefix: prefix.to_string(),
        git_dir: absolute(git_dir),
        common_dir: absolute(common_dir),
        empty_tree,
    })
}

/// A round's git setting: the work tree's top, the round's own objects, index
/// and attributes file, no attributes from the tree.
struct Snapshot<'a> {
    toplevel: &'a Path,
    dir: &'a Path,
    empty_tree: &'a str,
    /// The repo's objects, for the reading calls of a seeded snapshot.
    objects: Option<&'a Path>,
}

impl Snapshot<'_> {
    /// A call that may write objects: never sees the repo's object dir, so it
    /// writes every object into the round's (and freshens none of the repo's).
    fn writing(&self, args: &[&str]) -> Command {
        let attributes = format!("core.attributesFile={}", env_path(&self.dir.join("attributes")));
        let mut all = vec!["-c", attributes.as_str()];
        all.extend_from_slice(args);
        let mut cmd = git_in(self.toplevel, &all);
        cmd.env("GIT_OBJECT_DIRECTORY", env_path(&self.dir.join("objects")))
            .env("GIT_INDEX_FILE", env_path(&self.dir.join("index")))
            .env("GIT_ATTR_SOURCE", self.empty_tree)
            .env("GIT_ATTR_NOSYSTEM", "1");
        cmd
    }

    /// A call that only reads objects: the repo's are its alternate.
    fn reading(&self, args: &[&str]) -> Command {
        let mut cmd = self.writing(args);
        if let Some(objects) = self.objects {
            cmd.env("GIT_ALTERNATE_OBJECT_DIRECTORIES", alternates_value(objects));
        }
        cmd
    }

    /// Whether the files `names` stay within `max_files` / `max_bytes`.
    fn within(&self, names: &HashSet<String>, max_files: usize, max_bytes: u64) -> Result<(), NoUndo> {
        if names.len() > max_files {
            return Err(NoUndo::TooBig);
        }
        let mut total = 0u64;
        for name in names {
            total += std::fs::symlink_metadata(self.toplevel.join(name)).map(|m| m.len()).unwrap_or(0);
            if total > max_bytes {
                return Err(NoUndo::TooBig);
            }
        }
        Ok(())
    }

    /// The untracked files `add -A` would copy into the round (relative to
    /// the round's index).
    fn untracked(&self) -> Result<HashSet<String>, NoUndo> {
        let listed = output_of(self.writing(&["ls-files", "-z", "--others", "--exclude-standard"]), LIST_LIMIT)
            .map_err(|_| NoUndo::Failed)?;
        Ok(split_z(&listed).into_iter().collect())
    }

    /// The untracked files within the copy bounds?
    fn bounded(&self) -> Result<(), NoUndo> {
        self.within(&self.untracked()?, MAX_COPIED_FILES, MAX_COPIED_BYTES)
    }

    /// `add --force` of exactly `names` (literal, NUL-separated from a file in
    /// the round's folder): ignored ones too.
    fn add_listed(&self, names: &[String]) -> Result<(), NoUndo> {
        if names.is_empty() {
            return Ok(());
        }
        let list = self.dir.join("listed");
        let mut bytes = Vec::new();
        for name in names {
            bytes.extend_from_slice(name.as_bytes());
            bytes.push(0);
        }
        std::fs::write(&list, bytes).map_err(|_| NoUndo::Failed)?;
        let from = format!("--pathspec-from-file={}", env_path(&list));
        let mut add = self.writing(&["add", "--force", from.as_str(), "--pathspec-file-nul"]);
        add.env("GIT_LITERAL_PATHSPECS", "1");
        let added = output_of(add, LIST_LIMIT);
        let _ = std::fs::remove_file(&list);
        added.map(|_| ()).map_err(|_| NoUndo::Failed)
    }

    /// The seeded start, over the repo's index copied into the round's: every
    /// tracked file there is hashed raw without writing (`hash-object
    /// --no-filters`), and each whose bytes are not the blob the index names
    /// — edited, or converted on the way in by `core.autocrlf` or an
    /// attribute when the repo's git added it — is taken out of the round's
    /// index and added again as it is (a stat-clean entry is never re-read by
    /// `add`). Then `add -A` for the rest. Only those files and the untracked
    /// ones are copied into the round. `Failed` (a name git cannot take on a
    /// line, a non-UTF-8 name, a git error) lets the caller start fresh.
    fn seeded(&self) -> Result<String, NoUndo> {
        let listed = output_of(self.writing(&["ls-files", "-s", "-z"]), LIST_LIMIT).map_err(|_| NoUndo::Failed)?;
        let mut hashed: Vec<(String, String)> = Vec::new();
        let mut redo: Vec<String> = Vec::new();
        let mut bytes = 0u64;
        let mut plain_folders: HashMap<String, bool> = HashMap::new();
        let mut folders_ok = |path: &str| {
            let folder = path.rsplit_once('/').map(|(folder, _)| folder).unwrap_or_default();
            *plain_folders.entry(folder.to_string()).or_insert_with(|| folders_plain(self.toplevel, path))
        };
        for line in listed.split(|b| *b == 0).filter(|part| !part.is_empty()) {
            let line = std::str::from_utf8(line).map_err(|_| NoUndo::Failed)?;
            // `<mode> <oid> <stage>\t<path>`
            let Some((head, path)) = line.split_once('\t') else { return Err(NoUndo::Failed) };
            let parts: Vec<&str> = head.split(' ').collect();
            let [mode, oid, stage] = parts[..] else { return Err(NoUndo::Failed) };
            // Links, submodules and conflicted entries hold no file bytes to
            // convert; a file that is gone, became a folder or a link, or sits
            // beyond a link is `add -A`'s to see (its stat no longer matches).
            if stage != "0" || !matches!(mode, "100644" | "100755") || !folders_ok(path) {
                continue;
            }
            let Ok(meta) = std::fs::symlink_metadata(self.toplevel.join(path)) else { continue };
            if !meta.is_file() {
                continue;
            }
            bytes += meta.len();
            // `--stdin-paths` reads lines, unquotes a leading `"` and drops a
            // trailing CR: such a name is simply copied again.
            if path.contains(['\n', '\r']) || path.starts_with('"') {
                redo.push(path.to_string());
            } else {
                hashed.push((path.to_string(), oid.to_string()));
            }
        }
        if hashed.len() + redo.len() > MAX_HASHED_FILES || bytes > MAX_HASHED_BYTES {
            return Err(NoUndo::TooBig);
        }
        if !hashed.is_empty() {
            let input: Vec<u8> = hashed.iter().flat_map(|(path, _)| path.bytes().chain(std::iter::once(b'\n'))).collect();
            // No `-w`: nothing is written, the round's objects included.
            let out = run(self.writing(&["hash-object", "--no-filters", "--stdin-paths"]), Some(input), LIST_LIMIT)
                .map_err(|error| if error == RunError::Missing { NoUndo::NoGit } else { NoUndo::Failed })?;
            if !out.status.success() {
                return Err(NoUndo::Failed);
            }
            let text = String::from_utf8(out.stdout).map_err(|_| NoUndo::Failed)?;
            let now: Vec<&str> = text.lines().collect();
            if now.len() != hashed.len() {
                return Err(NoUndo::Failed);
            }
            redo.extend(hashed.into_iter().zip(now).filter(|((_, oid), now)| oid != now).map(|((path, _), _)| path));
        }
        let mut copied = self.untracked()?;
        copied.extend(redo.iter().cloned());
        self.within(&copied, MAX_COPIED_FILES, MAX_COPIED_BYTES)?;
        if !redo.is_empty() {
            let mut names = Vec::new();
            for name in &redo {
                names.extend_from_slice(name.as_bytes());
                names.push(0);
            }
            let out = run(self.writing(&["update-index", "-z", "--force-remove", "--stdin"]), Some(names), 1024)
                .map_err(|_| NoUndo::Failed)?;
            if !out.status.success() {
                return Err(NoUndo::Failed);
            }
            self.add_listed(&redo)?;
        }
        self.write_tree()
    }

    /// `add -A` + `write-tree` into the round: the work tree as a tree id.
    /// `--missing-ok`: a seeded index names blobs the repo holds, which the
    /// writing call does not see.
    fn write_tree(&self) -> Result<String, NoUndo> {
        output_of(self.writing(&["add", "-A"]), LIST_LIMIT).map_err(|_| NoUndo::Failed)?;
        let out = output_of(self.writing(&["write-tree", "--missing-ok"]), 1024).map_err(|_| NoUndo::Failed)?;
        let tree = String::from_utf8_lossy(&out).trim().to_string();
        let hex = tree.bytes().all(|b| b.is_ascii_hexdigit());
        if !(hex && (tree.len() == 40 || tree.len() == 64)) {
            return Err(NoUndo::Failed);
        }
        Ok(tree)
    }

    /// The fresh start: every tracked file that is there (by the repo's own
    /// index, read only — ignored ones too, as `git add` once forced them)
    /// and every non-ignored one, bounded as a whole, hashed as it is.
    fn fresh(&self) -> Result<String, NoUndo> {
        let tracked = output_of(repo_git(self.toplevel, &["ls-files", "-z", "--cached"]), LIST_LIMIT)
            .map_err(|_| NoUndo::Failed)?;
        let tracked: Vec<String> = split_z(&tracked)
            .into_iter()
            .filter(|name| std::fs::symlink_metadata(self.toplevel.join(name)).is_ok())
            .collect();
        let others = output_of(self.writing(&["ls-files", "-z", "--others", "--exclude-standard"]), LIST_LIMIT)
            .map_err(|_| NoUndo::Failed)?;
        let mut all: HashSet<String> = split_z(&others).into_iter().collect();
        all.extend(tracked.iter().cloned());
        self.within(&all, MAX_TREE_FILES, MAX_TREE_BYTES)?;
        self.add_listed(&tracked)?;
        self.write_tree()
    }

    /// The round's changes, from `diff-tree`'s raw lines.
    fn entries(&self, before: &str, after: &str) -> Result<Vec<Entry>, RoundError> {
        let out = output_of(self.reading(&["diff-tree", "-r", "-z", "--no-renames", before, after]), LIST_LIMIT)
            .map_err(|_| RoundError::Failed)?;
        let fields = split_z(&out);
        let mut entries = Vec::new();
        for pair in fields.chunks(2) {
            let [head, path] = pair else { return Err(RoundError::Failed) };
            // `:<mode> <mode> <oid> <oid> <status>`
            let parts: Vec<&str> = head.trim_start_matches(':').split(' ').collect();
            let [mode_before, mode_after, before, after, status] = parts[..] else {
                return Err(RoundError::Failed);
            };
            let mode = |text: &str| u32::from_str_radix(text, 8).map_err(|_| RoundError::Failed);
            entries.push(Entry {
                mode_before: mode(mode_before)?,
                mode_after: mode(mode_after)?,
                before: before.to_string(),
                after: after.to_string(),
                status: status.chars().next().unwrap_or('M'),
                path: path.clone(),
            });
        }
        Ok(entries)
    }

    /// The blobs `oids` hold, raw (no filter, no conversion), by one
    /// `cat-file --batch`; at most [`MAX_UNDO_BYTES`] together.
    fn blobs(&self, oids: &HashSet<&str>) -> Result<HashMap<String, Vec<u8>>, RoundError> {
        let mut found = HashMap::new();
        if oids.is_empty() {
            return Ok(found);
        }
        let input: String = oids.iter().map(|oid| format!("{oid}\n")).collect();
        let out = run(self.reading(&["cat-file", "--batch"]), Some(input.into_bytes()), MAX_UNDO_BYTES)
            .map_err(|_| RoundError::Failed)?;
        if !out.status.success() {
            return Err(RoundError::Failed);
        }
        let mut rest = &out.stdout[..];
        while !rest.is_empty() {
            let line_end = rest.iter().position(|b| *b == b'\n').ok_or(RoundError::Failed)?;
            let header = String::from_utf8_lossy(&rest[..line_end]).into_owned();
            rest = &rest[line_end + 1..];
            let parts: Vec<&str> = header.split(' ').collect();
            let [oid, "blob", size] = parts[..] else { return Err(RoundError::Failed) };
            let size: usize = size.parse().map_err(|_| RoundError::Failed)?;
            if rest.len() < size + 1 {
                return Err(RoundError::Failed);
            }
            found.insert(oid.to_string(), rest[..size].to_vec());
            rest = &rest[size + 1..];
        }
        Ok(found)
    }
}

/// One file a round changed: its mode and blob before and after (mode 0 =
/// absent), as `diff-tree` gives them, the path relative to the work tree's top.
struct Entry {
    mode_before: u32,
    mode_after: u32,
    before: String,
    after: String,
    status: char,
    path: String,
}

const MODE_LINK: u32 = 0o120000;
const MODE_GITLINK: u32 = 0o160000;
const MODE_EXEC: u32 = 0o100755;

/// What is at a changed path now.
#[derive(Debug, PartialEq, Eq)]
enum Here {
    Absent,
    File(Vec<u8>),
    Link(Vec<u8>),
    /// A directory, something unreadable, or a path through a symlink or a
    /// file — nothing an undo may touch.
    Other,
}

/// `rel` under `top` by plain names only, or `None`.
fn plain(top: &Path, rel: &str) -> Option<PathBuf> {
    let path = Path::new(rel);
    path.components().all(|c| matches!(c, std::path::Component::Normal(_))).then(|| top.join(path))
}

/// Whether every folder between `top` and `rel`'s leaf is a real directory
/// (or absent) — never a symlink, never a file.
fn folders_plain(top: &Path, rel: &str) -> bool {
    let mut at = top.to_path_buf();
    let names: Vec<&str> = rel.split('/').collect();
    for name in &names[..names.len().saturating_sub(1)] {
        at.push(name);
        match std::fs::symlink_metadata(&at) {
            Ok(meta) if meta.is_dir() => {}
            Ok(_) => return false,
            Err(_) => return true,
        }
    }
    true
}

#[cfg(unix)]
fn link_bytes(target: &Path) -> Vec<u8> {
    use std::os::unix::ffi::OsStrExt;
    target.as_os_str().as_bytes().to_vec()
}

#[cfg(not(unix))]
fn link_bytes(target: &Path) -> Vec<u8> {
    target.to_string_lossy().replace('\\', "/").into_bytes()
}

fn here(top: &Path, rel: &str) -> Here {
    let Some(path) = plain(top, rel) else { return Here::Other };
    if !folders_plain(top, rel) {
        return Here::Other;
    }
    match std::fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Here::Absent,
        Err(_) => Here::Other,
        Ok(meta) if meta.file_type().is_symlink() => {
            std::fs::read_link(&path).map(|target| Here::Link(link_bytes(&target))).unwrap_or(Here::Other)
        }
        Ok(meta) if meta.is_file() => std::fs::read(&path).map(Here::File).unwrap_or(Here::Other),
        Ok(_) => Here::Other,
    }
}

/// Whether what is at `entry`'s path now is what the round left there.
fn as_left(top: &Path, entry: &Entry, blobs: &HashMap<String, Vec<u8>>) -> bool {
    if entry.mode_before == MODE_GITLINK || entry.mode_after == MODE_GITLINK {
        // Submodules are never touched.
        return true;
    }
    let now = here(top, &entry.path);
    if entry.mode_after == 0 {
        return now == Here::Absent;
    }
    let Some(blob) = blobs.get(&entry.after) else { return false };
    match now {
        Here::Link(bytes) if entry.mode_after == MODE_LINK => bytes == *blob,
        Here::File(bytes) if entry.mode_after != MODE_LINK => bytes == *blob,
        // Windows checks a symlink out as a file holding its target.
        Here::File(bytes) if cfg!(not(unix)) => bytes == *blob,
        _ => false,
    }
}

/// What stands at a name in a [`Folder`], never following a link.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Absent,
    /// A regular file, with its permission bits.
    File(u32),
    /// A link, a folder, anything else — or unreadable.
    Other,
}

/// The permissions a staged file gets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Perms {
    /// These bits (`0o777`).
    Exact(u32),
    /// A new file's (the process umask's), plus exec bits where it is
    /// readable when `exec`.
    New { exec: bool },
}

/// A folder of the work tree, held open: on Unix a descriptor reached from
/// the top one plain name at a time by `openat(O_DIRECTORY | O_NOFOLLOW)`,
/// and every write, rename and removal relative to it — a folder swapped for
/// a link after the conflict check is refused, never followed, so an undo
/// never writes outside the work tree (the same shape as
/// `services::home_io`). Elsewhere the same API over checked paths.
struct Folder {
    #[cfg(unix)]
    fd: std::os::fd::OwnedFd,
    #[cfg(not(unix))]
    path: PathBuf,
}

#[cfg(unix)]
fn c_name(name: &std::ffi::OsStr) -> Option<std::ffi::CString> {
    use std::os::unix::ffi::OsStrExt;
    std::ffi::CString::new(name.as_bytes()).ok()
}

/// A fresh name for a temporary beside a file being put back.
fn temp_name() -> Option<std::ffi::OsString> {
    Some(format!(".{}-undo-{}.tmp", crate::brand::SLUG, &new_id()?[..16]).into())
}

#[cfg(unix)]
impl Folder {
    /// The work tree's (or the project folder's) top, opened by name: its
    /// own path is the user's.
    fn top(path: &Path) -> Option<Self> {
        use std::os::fd::FromRawFd;
        let c = c_name(path.as_os_str())?;
        // SAFETY: a NUL-terminated path.
        let fd = unsafe { libc::open(c.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) };
        // SAFETY: `fd` was just opened and nothing else owns it.
        (fd >= 0).then(|| Folder { fd: unsafe { std::os::fd::OwnedFd::from_raw_fd(fd) } })
    }

    /// The folder `name` in this one, never through a link; made (as `mkdir`
    /// would, under the umask) when missing and `create`.
    fn child(&self, name: &str, create: bool) -> Option<Self> {
        use std::os::fd::{AsRawFd, FromRawFd};
        let c = c_name(name.as_ref())?;
        let open = || {
            let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
            // SAFETY: a live directory descriptor and a NUL-terminated name.
            unsafe { libc::openat(self.fd.as_raw_fd(), c.as_ptr(), flags) }
        };
        let mut fd = open();
        if fd < 0 && create && std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound {
            // SAFETY: as above.
            if unsafe { libc::mkdirat(self.fd.as_raw_fd(), c.as_ptr(), 0o777) } == 0 {
                fd = open();
            }
        }
        // SAFETY: `fd` was just opened and nothing else owns it.
        (fd >= 0).then(|| Folder { fd: unsafe { std::os::fd::OwnedFd::from_raw_fd(fd) } })
    }

    fn kind(&self, name: &str) -> Kind {
        use std::os::fd::AsRawFd;
        let Some(c) = c_name(name.as_ref()) else { return Kind::Other };
        let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
        // SAFETY: a live directory descriptor, a NUL-terminated name, room for the answer.
        let found = unsafe { libc::fstatat(self.fd.as_raw_fd(), c.as_ptr(), stat.as_mut_ptr(), libc::AT_SYMLINK_NOFOLLOW) };
        if found != 0 {
            return if std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound { Kind::Absent } else { Kind::Other };
        }
        // SAFETY: `fstatat` succeeded and filled it.
        let stat = unsafe { stat.assume_init() };
        // `mode_t` is `u32` here but `u16` on macOS.
        #[allow(clippy::unnecessary_cast)]
        let mode = (stat.st_mode & 0o777) as u32;
        if stat.st_mode & libc::S_IFMT == libc::S_IFREG {
            Kind::File(mode)
        } else {
            Kind::Other
        }
    }

    /// A temporary in this folder holding `bytes` with `perms`: its name.
    fn stage_file(&self, bytes: &[u8], perms: Perms) -> Option<std::ffi::OsString> {
        use std::os::fd::{AsRawFd, FromRawFd};
        use std::os::unix::fs::PermissionsExt;
        let temp = temp_name()?;
        let c = c_name(&temp)?;
        let flags = libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        let mode: libc::c_uint = 0o666;
        // SAFETY: a live directory descriptor and a NUL-terminated name.
        let fd = unsafe { libc::openat(self.fd.as_raw_fd(), c.as_ptr(), flags, mode) };
        if fd < 0 {
            return None;
        }
        // SAFETY: `fd` was just opened and nothing else owns it.
        let mut file = unsafe { std::fs::File::from_raw_fd(fd) };
        let mode = match perms {
            Perms::Exact(mode) => Some(mode),
            Perms::New { exec: true } => file.metadata().ok().map(|meta| {
                let mode = meta.permissions().mode() & 0o777;
                mode | ((mode & 0o444) >> 2)
            }),
            Perms::New { exec: false } => None,
        };
        let written = file.write_all(bytes).is_ok()
            && mode.is_none_or(|mode| file.set_permissions(std::fs::Permissions::from_mode(mode)).is_ok());
        drop(file);
        if !written {
            self.remove(&temp, false);
            return None;
        }
        Some(temp)
    }

    /// A temporary symlink in this folder pointing at `target`: its name.
    fn stage_link(&self, target: &[u8]) -> Option<std::ffi::OsString> {
        use std::os::fd::AsRawFd;
        use std::os::unix::ffi::OsStrExt;
        let temp = temp_name()?;
        let (c, to) = (c_name(&temp)?, c_name(std::ffi::OsStr::from_bytes(target))?);
        // SAFETY: NUL-terminated strings and a live directory descriptor.
        (unsafe { libc::symlinkat(to.as_ptr(), self.fd.as_raw_fd(), c.as_ptr()) } == 0).then_some(temp)
    }

    /// Renames `from` over `to`, both in this folder (a link at `to` is
    /// replaced, not followed).
    fn rename(&self, from: &std::ffi::OsStr, to: &str) -> bool {
        use std::os::fd::AsRawFd;
        let (Some(from), Some(to)) = (c_name(from), c_name(to.as_ref())) else { return false };
        // SAFETY: NUL-terminated names and a live directory descriptor.
        unsafe { libc::renameat(self.fd.as_raw_fd(), from.as_ptr(), self.fd.as_raw_fd(), to.as_ptr()) == 0 }
    }

    /// Removes the name (a file or a link itself), or the empty folder.
    fn remove(&self, name: &std::ffi::OsStr, folder: bool) -> bool {
        use std::os::fd::AsRawFd;
        let Some(c) = c_name(name) else { return false };
        let flags = if folder { libc::AT_REMOVEDIR } else { 0 };
        // SAFETY: a NUL-terminated name and a live directory descriptor.
        unsafe { libc::unlinkat(self.fd.as_raw_fd(), c.as_ptr(), flags) == 0 }
    }
}

#[cfg(not(unix))]
impl Folder {
    fn top(path: &Path) -> Option<Self> {
        std::fs::metadata(path).ok()?.is_dir().then(|| Folder { path: path.to_path_buf() })
    }

    fn child(&self, name: &str, create: bool) -> Option<Self> {
        let path = self.path.join(name);
        match std::fs::symlink_metadata(&path) {
            Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => Some(Folder { path }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && create => {
                std::fs::create_dir(&path).ok().map(|()| Folder { path })
            }
            _ => None,
        }
    }

    fn kind(&self, name: &str) -> Kind {
        match std::fs::symlink_metadata(self.path.join(name)) {
            Ok(meta) if meta.is_file() => Kind::File(0o666),
            Ok(_) => Kind::Other,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Kind::Absent,
            Err(_) => Kind::Other,
        }
    }

    fn stage_file(&self, bytes: &[u8], _perms: Perms) -> Option<std::ffi::OsString> {
        let temp = temp_name()?;
        let path = self.path.join(&temp);
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&path).ok()?;
        let written = file.write_all(bytes).is_ok();
        drop(file);
        if !written {
            let _ = std::fs::remove_file(&path);
            return None;
        }
        Some(temp)
    }

    /// Windows checks a symlink out as a file holding its target.
    fn stage_link(&self, target: &[u8]) -> Option<std::ffi::OsString> {
        self.stage_file(target, Perms::New { exec: false })
    }

    fn rename(&self, from: &std::ffi::OsStr, to: &str) -> bool {
        std::fs::rename(self.path.join(from), self.path.join(to)).is_ok()
    }

    fn remove(&self, name: &std::ffi::OsStr, folder: bool) -> bool {
        let path = self.path.join(name);
        if folder { std::fs::remove_dir(path).is_ok() } else { std::fs::remove_file(path).is_ok() }
    }
}

/// The folders from `top` down to `rel`'s parent, each opened from the one
/// before ([`Folder`]), and `rel`'s leaf. `None` when a name is not plain, or
/// a folder on the way is a link, not a folder, or — unless `create` —
/// missing.
fn walk(top: &Path, rel: &str, create: bool) -> Option<(Vec<Folder>, String)> {
    let names: Vec<&str> = rel.split('/').collect();
    let odd = |name: &&str| name.is_empty() || *name == "." || *name == ".." || (cfg!(windows) && name.contains(['\\', ':']));
    if names.iter().any(odd) {
        return None;
    }
    let (leaf, folders) = names.split_last()?;
    let mut chain = vec![Folder::top(top)?];
    for name in folders {
        let next = chain.last()?.child(name, create)?;
        chain.push(next);
    }
    Some((chain, (*leaf).to_string()))
}

/// Stages `entry`'s bytes before the round beside `leaf` in `folder`: a link
/// as a link; a file with the permissions the file there has now, its exec
/// bit as before the round when the round changed that one.
fn stage(folder: &Folder, leaf: &str, entry: &Entry, blob: &[u8]) -> Option<std::ffi::OsString> {
    if entry.mode_before == MODE_LINK {
        return folder.stage_link(blob);
    }
    let exec = entry.mode_before == MODE_EXEC;
    let perms = match folder.kind(leaf) {
        Kind::File(mode) if entry.mode_after == entry.mode_before => Perms::Exact(mode),
        Kind::File(mode) if exec => Perms::Exact(mode | ((mode & 0o444) >> 2)),
        Kind::File(mode) => Perms::Exact(mode & !0o111),
        _ => Perms::New { exec },
    };
    folder.stage_file(blob, perms)
}

/// One write the undo has staged: the temporary `temp` beside `rel` under
/// `top`.
struct Staged {
    top: PathBuf,
    rel: String,
    temp: std::ffi::OsString,
}

impl Staged {
    /// Renames the temporary over its file, its folder reached again from
    /// the top the same way (a folder swapped since: refused).
    fn commit(&self) -> bool {
        walk(&self.top, &self.rel, false)
            .is_some_and(|(chain, leaf)| chain.last().is_some_and(|folder| folder.rename(&self.temp, &leaf)))
    }

    fn discard(&self) {
        if let Some(folder) = walk(&self.top, &self.rel, false).and_then(|(mut chain, _)| chain.pop()) {
            folder.remove(&self.temp, false);
        }
    }
}

/// Removes what the round added at `rel`, and the folders above it that this
/// leaves empty, up to `top` — never the first `keep` folders below it (the
/// project folder and those above it).
fn remove_added(top: &Path, rel: &str, keep: usize) -> bool {
    let Some((chain, leaf)) = walk(top, rel, false) else { return false };
    if !chain.last().is_some_and(|folder| folder.remove(leaf.as_ref(), false)) {
        return false;
    }
    let names: Vec<&str> = rel.split('/').collect();
    for depth in (keep + 1..chain.len()).rev() {
        if !chain[depth - 1].remove(names[depth - 1].as_ref(), true) {
            break;
        }
    }
    true
}

/// The marked PDF as the Submit read it: its path relative to the project
/// folder and its bytes.
pub struct PdfBefore<'a> {
    pub rel: &'a str,
    pub bytes: &'a [u8],
}

/// Snapshots the work tree before an `apply` round: the round's id, or why
/// there is no undo (the round then runs as `list`). `pdf`: a project-file PDF
/// source, kept as `before.pdf` when at most [`MAX_PDF_BYTES`].
pub fn begin(state_dir: &Path, root: &Path, owner: Owner, pdf: Option<PdfBefore>) -> Result<String, NoUndo> {
    let _guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let _budget = Budget::start();
    let located = locate(root)?;
    // `info/attributes` outranks every switch the snapshot sets.
    if info_attributes_name_conversion(&located.common_dir) {
        return Err(NoUndo::Filtered);
    }
    let id = new_id().ok_or(NoUndo::Failed)?;
    let dir = rounds_dir(state_dir).join(&id);
    let made = std::fs::create_dir_all(dir.join("objects").join("info"))
        .and_then(|_| std::fs::create_dir_all(dir.join("objects").join("pack")))
        .and_then(|_| std::fs::write(dir.join("attributes"), b""));
    if made.is_err() {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(NoUndo::Failed);
    }
    let repo_objects = located.common_dir.join("objects");
    let taken = (|| {
        let fresh = Snapshot { toplevel: &located.toplevel, dir: &dir, empty_tree: located.empty_tree, objects: None };
        if std::fs::copy(located.git_dir.join("index"), dir.join("index")).is_ok() {
            let seeded = Snapshot { objects: Some(&repo_objects), ..fresh };
            match seeded.seeded() {
                Ok(tree) => return Ok((tree, Some(repo_objects.clone()))),
                // A name `hash-object` cannot take on a line, or a copied
                // split index whose shared half git looks for elsewhere:
                // start fresh.
                Err(NoUndo::Failed) => {
                    let _ = std::fs::remove_file(dir.join("index"));
                }
                Err(other) => return Err(other),
            }
        }
        fresh.fresh().map(|tree| (tree, None))
    })();
    let (tree_before, objects) = match taken {
        Ok(taken) => taken,
        Err(reason) => {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(reason);
        }
    };
    let kept = pdf.filter(|pdf| pdf.bytes.len() <= MAX_PDF_BYTES).and_then(|pdf| {
        std::fs::write(dir.join("before.pdf"), pdf.bytes).ok().map(|_| (pdf.rel.to_string(), sha256_hex(pdf.bytes)))
    });
    let record = Record {
        v: 1,
        owner,
        root: root.to_path_buf(),
        toplevel: located.toplevel,
        prefix: located.prefix,
        objects,
        empty_tree: located.empty_tree.to_string(),
        tree_before,
        tree_after: None,
        pdf: kept.as_ref().map(|(rel, _)| rel.clone()),
        pdf_before_sha256: kept.map(|(_, digest)| digest),
        pdf_after_sha256: None,
        created: now_secs(),
        undone: false,
        lost: false,
    };
    if save(&dir, &record).is_err() {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(NoUndo::Failed);
    }
    prune(state_dir, &id);
    Ok(id)
}

fn save(dir: &Path, record: &Record) -> std::io::Result<()> {
    let text = serde_json::to_vec_pretty(record).map_err(std::io::Error::other)?;
    let temp = dir.join("round.json.tmp");
    std::fs::write(&temp, text)?;
    std::fs::rename(&temp, dir.join("round.json"))
}

/// The round `id` of `owner`, with its folder.
fn load(state_dir: &Path, id: &str, owner: &Owner) -> Result<(PathBuf, Record), RoundError> {
    if !valid_id(id) {
        return Err(RoundError::NotFound);
    }
    let dir = rounds_dir(state_dir).join(id);
    let Ok(bytes) = std::fs::read(dir.join("round.json")) else {
        return Err(RoundError::Gone);
    };
    let record: Record = serde_json::from_slice(&bytes).map_err(|_| RoundError::Gone)?;
    if &record.owner != owner {
        return Err(RoundError::NotFound);
    }
    if record.undone || record.lost {
        return Err(RoundError::Gone);
    }
    Ok((dir, record))
}

fn snapshot_of<'a>(dir: &'a Path, record: &'a Record) -> Snapshot<'a> {
    Snapshot { toplevel: &record.toplevel, dir, empty_tree: &record.empty_tree, objects: record.objects.as_deref() }
}

fn settle_record(dir: &Path, record: &mut Record) -> Result<(), RoundError> {
    let snapshot = snapshot_of(dir, record);
    match snapshot.bounded() {
        Err(NoUndo::TooBig) => {
            record.lost = true;
            let _ = save(dir, record);
            return Err(RoundError::Gone);
        }
        Err(_) => return Err(RoundError::Failed),
        Ok(()) => {}
    }
    let tree = snapshot.write_tree().map_err(|_| RoundError::Failed)?;
    record.tree_after = Some(tree);
    record.pdf_after_sha256 = record.pdf.as_deref().and_then(|rel| file_digest(&record.root.join(rel)));
    save(dir, record).map_err(|_| RoundError::Failed)
}

/// The after-snapshot, taken each time the round's turn finishes (the last
/// one wins). A round grown past the bounds loses its undo (`Gone`).
pub fn settle(state_dir: &Path, id: &str, owner: &Owner) -> Result<(), RoundError> {
    let _guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let _budget = Budget::start();
    let (dir, mut record) = load(state_dir, id, owner)?;
    settle_record(&dir, &mut record)
}

/// Whether a name may be shown and put into a chat note.
fn speakable(name: &str) -> bool {
    !name.is_empty() && !name.chars().any(|c| c.is_control() || c == '`')
}

/// Whether a changed path (relative to the work tree's top) lies inside the
/// project folder, whose `prefix` is empty (the top) or ends in `/`.
fn in_project(prefix: &str, path: &str) -> bool {
    path.starts_with(prefix)
}

/// Files the round added inside the project folder with the very bytes of a
/// file it removed outside it — a move in. An undo leaves them: it never puts
/// the outside one back, so removing this one would lose the only copy.
fn moved_in<'a>(prefix: &str, entries: &'a [Entry]) -> HashSet<&'a str> {
    let gone_outside: HashSet<&str> = entries
        .iter()
        .filter(|e| !in_project(prefix, &e.path) && e.mode_after == 0 && e.mode_before != MODE_GITLINK)
        .map(|e| e.before.as_str())
        .collect();
    entries
        .iter()
        .filter(|e| in_project(prefix, &e.path) && e.mode_before == 0 && e.mode_after != MODE_GITLINK)
        .filter(|e| gone_outside.contains(e.after.as_str()))
        .map(|e| e.path.as_str())
        .collect()
}

/// `entries` as the lists the phone and the viewer show: the project's files
/// (project-relative), and the names outside the project folder
/// (top-relative) that an undo leaves alone.
fn listed(prefix: &str, entries: &[Entry], pdf: PdfFate) -> Changes {
    let mut files = Vec::new();
    let mut more = 0usize;
    let mut outside = Vec::new();
    let mut outside_more = 0usize;
    let kept = moved_in(prefix, entries);
    for entry in entries {
        let rel = entry.path.strip_prefix(prefix).filter(|_| !kept.contains(entry.path.as_str()));
        let Some(rel) = rel else {
            if outside.len() < MAX_LISTED && speakable(&entry.path) {
                outside.push(entry.path.clone());
            } else {
                outside_more += 1;
            }
            continue;
        };
        match Some(rel).filter(|rel| speakable(rel)) {
            Some(rel) if files.len() < MAX_LISTED => files.push(Changed {
                path: rel.to_string(),
                change: match entry.status {
                    'A' => "added",
                    'D' => "deleted",
                    'M' => "modified",
                    _ => "changed",
                },
            }),
            _ => more += 1,
        }
    }
    Changes { files, more, outside, outside_more, pdf }
}

/// Project-relative names of conflicting files, at most [`MAX_LISTED`], and
/// how many more.
fn conflict_names(prefix: &str, paths: &[&str]) -> (Vec<String>, usize) {
    let named: Vec<String> = paths
        .iter()
        .filter_map(|path| path.strip_prefix(prefix).filter(|rel| speakable(rel)).map(str::to_string))
        .take(MAX_LISTED)
        .collect();
    let more = paths.len() - named.len();
    (named, more)
}

/// What becomes of the kept PDF: put back only when the tree does not hold
/// it, it differs from before, and it has not changed since the round settled.
fn pdf_fate(dir: &Path, record: &Record, entries: &[Entry]) -> PdfFate {
    let (Some(rel), Some(before)) = (record.pdf.as_deref(), record.pdf_before_sha256.as_deref()) else {
        return PdfFate::None;
    };
    if !dir.join("before.pdf").is_file() {
        return PdfFate::None;
    }
    let in_tree = format!("{}{rel}", record.prefix);
    if entries.iter().any(|entry| entry.path == in_tree) {
        return PdfFate::None;
    }
    let path = record.root.join(rel);
    // A link or a folder at its name now: never written over.
    if std::fs::symlink_metadata(&path).is_ok_and(|meta| !meta.is_file()) {
        return PdfFate::Kept;
    }
    let now = file_digest(&path);
    if now.as_deref() == Some(before) {
        return PdfFate::None;
    }
    if now != record.pdf_after_sha256 {
        return PdfFate::Kept;
    }
    PdfFate::Restored
}

/// Stages `before.pdf` beside the PDF for the undo to put in place: its
/// folder reached from the project folder by plain names ([`walk`]), never
/// over a link or a folder. `None` when it cannot be.
fn stage_pdf(dir: &Path, record: &Record) -> Option<Staged> {
    let rel = record.pdf.as_deref()?;
    let bytes = std::fs::read(dir.join("before.pdf")).ok()?;
    let (chain, leaf) = walk(&record.root, rel, false)?;
    let folder = chain.last()?;
    let perms = match folder.kind(&leaf) {
        Kind::File(mode) => Perms::Exact(mode),
        Kind::Absent => Perms::New { exec: false },
        Kind::Other => return None,
    };
    let temp = folder.stage_file(&bytes, perms)?;
    Some(Staged { top: record.root.clone(), rel: rel.to_string(), temp })
}

/// What an undo would put back. Settles first when the round has not (an
/// `unconfirmed` round).
pub fn preview(state_dir: &Path, id: &str, owner: &Owner) -> Result<Changes, RoundError> {
    let _guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let _budget = Budget::start();
    let (dir, mut record) = load(state_dir, id, owner)?;
    if record.tree_after.is_none() {
        settle_record(&dir, &mut record)?;
    }
    let after = record.tree_after.clone().ok_or(RoundError::Failed)?;
    let entries = snapshot_of(&dir, &record).entries(&record.tree_before, &after)?;
    Ok(listed(&record.prefix, &entries, pdf_fate(&dir, &record, &entries)))
}

/// Puts every file the round changed **inside the project folder** back as
/// it was before it, byte for byte, and the kept PDF when it has not changed
/// since. Files changed elsewhere in the same work tree (a sibling project,
/// the repo's top) are left as they are and named in the answer's `outside`,
/// and so is a file the round moved into the project from there
/// ([`moved_in`]). All or nothing: when a project file is not as the round left it — edited,
/// removed or back again since, or reached through a symlink — `Conflict`,
/// and nothing is touched. Every write is staged before the first change (a
/// staging failure is `Failed` with nothing changed), and all of them go
/// through folders reached without following a link ([`walk`]). Submodules
/// are never touched.
pub fn undo(state_dir: &Path, id: &str, owner: &Owner) -> Result<Changes, RoundError> {
    let _guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let _budget = Budget::start();
    let (dir, mut record) = load(state_dir, id, owner)?;
    let after = record.tree_after.clone().ok_or(RoundError::NotReady)?;
    let snapshot = snapshot_of(&dir, &record);
    let entries = snapshot.entries(&record.tree_before, &after)?;
    let fate = pdf_fate(&dir, &record, &entries);
    let kept = moved_in(&record.prefix, &entries);
    let touched: Vec<&Entry> = entries
        .iter()
        .filter(|e| in_project(&record.prefix, &e.path) && !kept.contains(e.path.as_str()))
        .filter(|e| e.mode_before != MODE_GITLINK && e.mode_after != MODE_GITLINK)
        .collect();
    // The project folder and the folders above it stay, however empty.
    let keep_depth = record.prefix.matches('/').count();
    let mut oids: HashSet<&str> = HashSet::new();
    for entry in &touched {
        if entry.mode_before != 0 {
            oids.insert(&entry.before);
        }
        if entry.mode_after != 0 {
            oids.insert(&entry.after);
        }
    }
    let blobs = snapshot.blobs(&oids)?;
    let top = &record.toplevel;
    let conflicting: Vec<&str> =
        touched.iter().filter(|entry| !as_left(top, entry, &blobs)).map(|entry| entry.path.as_str()).collect();
    if !conflicting.is_empty() {
        let (files, more) = conflict_names(&record.prefix, &conflicting);
        return Err(RoundError::Conflict { files, more });
    }
    // Every write is staged first — a temporary beside its file, in a folder
    // that is already there — so a failure up to here changes nothing. A file
    // whose folder the round removed waits for the second pass below.
    let mut staged: Vec<Staged> = Vec::new();
    let mut later: Vec<&Entry> = Vec::new();
    let mut ready = true;
    for entry in touched.iter().filter(|entry| entry.mode_before != 0) {
        let Some(blob) = blobs.get(&entry.before) else {
            ready = false;
            break;
        };
        let Some((chain, leaf)) = walk(top, &entry.path, false) else {
            later.push(entry);
            continue;
        };
        match chain.last().and_then(|folder| stage(folder, &leaf, entry, blob)) {
            Some(temp) => staged.push(Staged { top: top.clone(), rel: entry.path.clone(), temp }),
            None => {
                ready = false;
                break;
            }
        }
    }
    if !ready {
        staged.iter().for_each(Staged::discard);
        return Err(RoundError::Failed);
    }
    let pdf_staged = if fate == PdfFate::Restored { stage_pdf(&dir, &record) } else { None };
    // Then what the round added goes (it may stand where a folder comes
    // back), the files whose folders it removed are written (the folders
    // made again), and the staged ones are put in place.
    let mut whole = true;
    for entry in touched.iter().filter(|entry| entry.mode_before == 0) {
        whole &= remove_added(top, &entry.path, keep_depth);
    }
    for entry in later {
        let written = blobs.get(&entry.before).is_some_and(|blob| {
            walk(top, &entry.path, true).is_some_and(|(chain, leaf)| {
                chain.last().and_then(|folder| stage(folder, &leaf, entry, blob)).is_some_and(|temp| {
                    let staged = Staged { top: top.clone(), rel: entry.path.clone(), temp };
                    staged.commit() || {
                        staged.discard();
                        false
                    }
                })
            })
        });
        whole &= written;
    }
    for staged in &staged {
        if !staged.commit() {
            staged.discard();
            whole = false;
        }
    }
    let pdf = match (fate, pdf_staged) {
        (PdfFate::Restored, Some(staged)) if staged.commit() => PdfFate::Restored,
        (PdfFate::Restored, staged) => {
            staged.iter().for_each(Staged::discard);
            PdfFate::Kept
        }
        (other, _) => other,
    };
    if !whole {
        // Rare past staging (a rename refused): some files are back. The
        // round stays, but a second undo meets those as conflicts.
        return Err(RoundError::Failed);
    }
    record.undone = true;
    let _ = save(&dir, &record);
    Ok(listed(&record.prefix, &entries, pdf))
}

/// Drops rounds older than [`KEEP_FOR`] and all but the newest
/// [`KEEP_ROUNDS`] — never `keep`, the round just begun.
fn prune(state_dir: &Path, keep: &str) {
    let Ok(entries) = std::fs::read_dir(rounds_dir(state_dir)) else { return };
    let now = now_secs();
    let mut rounds: Vec<(u64, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !valid_id(&name) || name == keep {
            continue;
        }
        let created = std::fs::read(entry.path().join("round.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .and_then(|value| value.get("created").and_then(serde_json::Value::as_u64))
            .or_else(|| {
                entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
            })
            .unwrap_or(0);
        if now.saturating_sub(created) > KEEP_FOR.as_secs() {
            let _ = std::fs::remove_dir_all(entry.path());
        } else {
            rounds.push((created, entry.path()));
        }
    }
    rounds.sort_by_key(|round| std::cmp::Reverse(round.0));
    for (_, path) in rounds.into_iter().skip(KEEP_ROUNDS - 1) {
        let _ = std::fs::remove_dir_all(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn git(dir: &Path, args: &[&str]) -> String {
        let mut cmd = Command::new("git");
        for name in FOREIGN_GIT_ENV {
            cmd.env_remove(name);
        }
        let out = cmd
            .args(["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main"])
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    const MAIN: &str = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n";

    /// A repo with `main.tex`, `refs.bib`, `logo.bin` committed and `*.pdf`
    /// ignored; the project folder is the repo's top. `core.autocrlf` is set
    /// in the repo so the machine's global config cannot change what the
    /// repo's own index holds (`input`: LF blobs for CRLF files).
    fn repo_with(autocrlf: &str) -> (tempfile::TempDir, PathBuf, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().canonicalize().unwrap();
        let root = base.join("proj");
        let state = base.join("state");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&state).unwrap();
        git(&root, &["init", "-q"]);
        git(&root, &["config", "core.autocrlf", autocrlf]);
        fs::write(root.join("main.tex"), MAIN).unwrap();
        fs::write(root.join("refs.bib"), "@book{a}\n").unwrap();
        fs::write(root.join("logo.bin"), [0u8, 1, 2, 255, 0, 7]).unwrap();
        fs::write(root.join(".gitignore"), "*.pdf\n").unwrap();
        git(&root, &["add", "-A"]);
        git(&root, &["commit", "-q", "-m", "init"]);
        (tmp, root, state)
    }

    fn repo() -> (tempfile::TempDir, PathBuf, PathBuf) {
        repo_with("false")
    }

    fn phone() -> Owner {
        Owner::Phone { tab: "t1".into(), project: "p1".into() }
    }

    fn record(state: &Path, id: &str) -> Record {
        serde_json::from_slice(&fs::read(state.join(ROUNDS_DIR).join(id).join("round.json")).unwrap()).unwrap()
    }

    /// Every file under `.git` with its length and mtime.
    fn git_dir_state(root: &Path) -> Vec<(PathBuf, u64, SystemTime)> {
        fn walk(dir: &Path, out: &mut Vec<(PathBuf, u64, SystemTime)>) {
            for entry in fs::read_dir(dir).unwrap().flatten() {
                let meta = entry.metadata().unwrap();
                if meta.is_dir() {
                    walk(&entry.path(), out);
                }
                out.push((entry.path(), meta.len(), meta.modified().unwrap()));
            }
        }
        let mut out = Vec::new();
        walk(&root.join(".git"), &mut out);
        out.sort();
        out
    }

    /// The agent's turn of the round-trip tests: a tracked edit, a new file,
    /// a deletion and a binary edit.
    fn agent_turn(root: &Path) {
        fs::write(root.join("main.tex"), MAIN.replace("two", "TWO")).unwrap();
        fs::write(root.join("new.tex"), "fresh\n").unwrap();
        fs::remove_file(root.join("refs.bib")).unwrap();
        fs::write(root.join("logo.bin"), [9u8, 9, 0, 0, 1]).unwrap();
    }

    fn assert_back(root: &Path) {
        assert_eq!(fs::read_to_string(root.join("main.tex")).unwrap(), MAIN);
        assert!(!root.join("new.tex").exists());
        assert_eq!(fs::read_to_string(root.join("refs.bib")).unwrap(), "@book{a}\n");
        assert_eq!(fs::read(root.join("logo.bin")).unwrap(), vec![0u8, 1, 2, 255, 0, 7]);
    }

    #[test]
    fn a_round_trip_puts_tracked_new_deleted_and_binary_files_back() {
        for autocrlf in ["false", "input"] {
            let (_tmp, root, state) = repo_with(autocrlf);
            let id = begin(&state, &root, phone(), None).unwrap();
            assert!(valid_id(&id));
            assert!(record(&state, &id).objects.is_some(), "seeded from the index, whatever converts");
            agent_turn(&root);
            settle(&state, &id, &phone()).unwrap();
            let preview = preview(&state, &id, &phone()).unwrap();
            let mut named: Vec<(String, &str)> = preview.files.iter().map(|c| (c.path.clone(), c.change)).collect();
            named.sort();
            assert_eq!(
                named,
                vec![
                    ("logo.bin".into(), "modified"),
                    ("main.tex".into(), "modified"),
                    ("new.tex".into(), "added"),
                    ("refs.bib".into(), "deleted"),
                ],
                "{autocrlf}"
            );
            assert_eq!((preview.more, preview.pdf), (0, PdfFate::None));
            let done = undo(&state, &id, &phone()).unwrap();
            assert_eq!(done.files.len(), 4);
            assert_back(&root);
            // Undone once: gone.
            assert_eq!(undo(&state, &id, &phone()), Err(RoundError::Gone));
            assert_eq!(preview_err(&state, &id), RoundError::Gone);
        }
    }

    fn preview_err(state: &Path, id: &str) -> RoundError {
        preview(state, id, &phone()).unwrap_err()
    }

    #[test]
    fn crlf_lines_and_filtered_files_come_back_byte_for_byte() {
        let (_tmp, root, state) = repo_with("input");
        fs::write(root.join(".gitattributes"), "* text=auto\n*.psd filter=lfs diff=lfs merge=lfs -text\n").unwrap();
        fs::write(root.join("win.tex"), "a\r\nb\r\n").unwrap();
        fs::write(root.join("art.psd"), "raw bytes, no pointer\r\n").unwrap();
        git(&root, &["add", "-A"]);
        git(&root, &["commit", "-q", "-m", "crlf"]);
        let id = begin(&state, &root, phone(), None).unwrap();
        assert!(record(&state, &id).objects.is_some(), "a converting repo is seeded too");
        fs::write(root.join("win.tex"), "a\r\nB\r\n").unwrap();
        fs::write(root.join("art.psd"), "changed\n").unwrap();
        settle(&state, &id, &phone()).unwrap();
        undo(&state, &id, &phone()).unwrap();
        assert_eq!(fs::read(root.join("win.tex")).unwrap(), b"a\r\nb\r\n");
        assert_eq!(fs::read(root.join("art.psd")).unwrap(), b"raw bytes, no pointer\r\n");
    }

    /// The objects stored in the round's own object dir.
    fn round_objects(state: &Path, id: &str) -> usize {
        let objects = state.join(ROUNDS_DIR).join(id).join("objects");
        fs::read_dir(&objects)
            .unwrap()
            .flatten()
            .filter(|dir| dir.file_name().len() == 2)
            .map(|dir| fs::read_dir(dir.path()).unwrap().count())
            .sum()
    }

    /// The index can hold blobs that are not the work tree's bytes even when
    /// nothing converts *now*: added under `core.autocrlf=input`, the setting
    /// gone since. The snapshot hashes the bytes, so the undo still puts the
    /// CRLF file back as it was — and copies only that file into the round,
    /// not the forty unchanged ones.
    #[test]
    fn a_seeded_snapshot_holds_the_bytes_and_copies_only_what_differs() {
        let (_tmp, root, state) = repo_with("input");
        for n in 0..40 {
            fs::write(root.join(format!("ch{n}.tex")), format!("chapter {n}\n")).unwrap();
        }
        fs::write(root.join("win.tex"), "a\r\nb\r\n").unwrap();
        git(&root, &["add", "-A"]);
        git(&root, &["commit", "-q", "-m", "chapters"]);
        git(&root, &["config", "core.autocrlf", "false"]);
        let id = begin(&state, &root, phone(), None).unwrap();
        assert!(record(&state, &id).objects.is_some());
        // win.tex's raw blob and the trees — nothing of the unchanged files.
        let stored = round_objects(&state, &id);
        assert!(stored <= 2, "{stored} objects copied in");
        fs::write(root.join("win.tex"), "a\r\nB\r\n").unwrap();
        fs::write(root.join("ch3.tex"), "chapter three\n").unwrap();
        settle(&state, &id, &phone()).unwrap();
        let preview = preview(&state, &id, &phone()).unwrap();
        assert_eq!(preview.files.len(), 2, "{preview:?}");
        undo(&state, &id, &phone()).unwrap();
        assert_eq!(fs::read(root.join("win.tex")).unwrap(), b"a\r\nb\r\n");
        assert_eq!(fs::read_to_string(root.join("ch3.tex")).unwrap(), "chapter 3\n");
    }

    /// A project's `.git` pointer file naming a git dir whose config names a
    /// work tree elsewhere — another of the user's repos — must not point the
    /// snapshot, and so the undo's writes, there (the common dir is pinned
    /// only for a main `.git`, not for a pointer).
    #[test]
    fn a_planted_core_worktree_has_no_undo() {
        let (tmp, elsewhere, state) = repo();
        let base = tmp.path().canonicalize().unwrap();
        let root = base.join("planted");
        let git_dir = base.join("planted.git");
        git(&base, &["init", "-q", "--separate-git-dir", git_dir.to_str().unwrap(), "planted"]);
        git(&base, &["--git-dir", git_dir.to_str().unwrap(), "config", "core.worktree", elsewhere.to_str().unwrap()]);
        assert_eq!(begin(&state, &root, phone(), None), Err(NoUndo::NotGit));
        assert!(fs::read_dir(state.join(ROUNDS_DIR)).map(|d| d.count()).unwrap_or(0) == 0);
    }

    #[cfg(unix)]
    #[test]
    fn a_files_permissions_survive_the_undo() {
        use std::os::unix::fs::PermissionsExt;
        let (_tmp, root, state) = repo();
        fs::set_permissions(root.join("refs.bib"), fs::Permissions::from_mode(0o600)).unwrap();
        let id = begin(&state, &root, phone(), None).unwrap();
        fs::write(root.join("refs.bib"), "@book{b}\n").unwrap();
        fs::remove_file(root.join("main.tex")).unwrap();
        settle(&state, &id, &phone()).unwrap();
        undo(&state, &id, &phone()).unwrap();
        assert_eq!(fs::read_to_string(root.join("refs.bib")).unwrap(), "@book{a}\n");
        assert_eq!(fs::metadata(root.join("refs.bib")).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(fs::read_to_string(root.join("main.tex")).unwrap(), MAIN, "a deleted file comes back");
    }

    /// A write that cannot be staged (its folder read-only here) refuses the
    /// whole undo before anything is changed; once it can, the undo runs.
    #[cfg(unix)]
    #[test]
    fn a_write_that_cannot_be_staged_changes_nothing() {
        use std::os::unix::fs::PermissionsExt;
        // SAFETY: a plain query.
        if unsafe { libc::geteuid() } == 0 {
            return; // root writes into a read-only folder anyway
        }
        let (_tmp, root, state) = repo();
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("sub/x.tex"), "x\n").unwrap();
        git(&root, &["add", "-A"]);
        git(&root, &["commit", "-q", "-m", "sub"]);
        let id = begin(&state, &root, phone(), None).unwrap();
        fs::write(root.join("main.tex"), "edited\n").unwrap();
        fs::write(root.join("new.tex"), "added\n").unwrap();
        fs::write(root.join("sub/x.tex"), "y\n").unwrap();
        settle(&state, &id, &phone()).unwrap();
        fs::set_permissions(root.join("sub"), fs::Permissions::from_mode(0o555)).unwrap();
        let refused = undo(&state, &id, &phone());
        fs::set_permissions(root.join("sub"), fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(refused, Err(RoundError::Failed));
        assert_eq!(fs::read_to_string(root.join("main.tex")).unwrap(), "edited\n", "nothing changed");
        assert!(root.join("new.tex").exists(), "nothing removed");
        let left: Vec<String> = fs::read_dir(&root).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert!(!left.iter().any(|name| name.ends_with(".tmp")), "no temporary left: {left:?}");
        undo(&state, &id, &phone()).unwrap();
        assert_eq!(fs::read_to_string(root.join("main.tex")).unwrap(), MAIN);
        assert_eq!(fs::read_to_string(root.join("sub/x.tex")).unwrap(), "x\n");
        assert!(!root.join("new.tex").exists());
    }

    /// A staged write whose folder is swapped for a link before it is put in
    /// place is refused there — the link is never followed.
    #[cfg(unix)]
    #[test]
    fn a_folder_swapped_for_a_link_after_staging_is_never_written_through() {
        let tmp = tempfile::tempdir().unwrap();
        let top = tmp.path().canonicalize().unwrap().join("top");
        let elsewhere = tmp.path().canonicalize().unwrap().join("elsewhere");
        fs::create_dir_all(top.join("sub")).unwrap();
        fs::create_dir_all(&elsewhere).unwrap();
        let (chain, leaf) = walk(&top, "sub/x.tex", false).unwrap();
        let temp = chain.last().unwrap().stage_file(b"before", Perms::New { exec: false }).unwrap();
        let staged = Staged { top: top.clone(), rel: "sub/x.tex".into(), temp: temp.clone() };
        drop(chain);
        fs::rename(top.join("sub"), tmp.path().join("moved")).unwrap();
        std::os::unix::fs::symlink(&elsewhere, top.join("sub")).unwrap();
        fs::write(elsewhere.join(&temp), b"planted").unwrap();
        assert!(!staged.commit(), "the link at `sub` is refused");
        assert!(!elsewhere.join(&leaf).exists());
        assert!(walk(&top, "sub/x.tex", true).is_none(), "nor made through");
        assert!(walk(&top, "../x", false).is_none() && walk(&top, "a//b", false).is_none());
    }

    /// One slow git call cannot hold a Submit past the operation's budget.
    #[cfg(unix)]
    #[test]
    fn a_call_past_the_operations_deadline_is_killed() {
        let _budget = Budget::start();
        DEADLINE.with(|deadline| deadline.set(Some(Instant::now() + Duration::from_millis(200))));
        let started = Instant::now();
        let mut slow = Command::new("sleep");
        slow.arg("5");
        assert_eq!(run(slow, None, 1024).map(|_| ()), Err(RunError::Timeout));
        assert!(started.elapsed() < Duration::from_secs(3));
        drop(_budget);
        assert!(DEADLINE.with(std::cell::Cell::get).is_none(), "cleared with the budget");
    }

    #[test]
    fn a_force_added_ignored_file_is_in_the_snapshot() {
        for autocrlf in ["false", "input"] {
            let (_tmp, root, state) = repo_with(autocrlf);
            fs::write(root.join("figure.pdf"), b"%PDF figure").unwrap();
            git(&root, &["add", "--force", "figure.pdf"]);
            git(&root, &["commit", "-q", "-m", "figure"]);
            let id = begin(&state, &root, phone(), None).unwrap();
            fs::write(root.join("figure.pdf"), b"%PDF redrawn").unwrap();
            settle(&state, &id, &phone()).unwrap();
            let done = undo(&state, &id, &phone()).unwrap();
            assert_eq!(done.files, vec![Changed { path: "figure.pdf".into(), change: "modified" }], "{autocrlf}");
            assert_eq!(fs::read(root.join("figure.pdf")).unwrap(), b"%PDF figure");
        }
    }

    #[test]
    fn an_edit_to_another_file_after_the_round_survives_the_undo() {
        let (_tmp, root, state) = repo();
        let id = begin(&state, &root, phone(), None).unwrap();
        fs::write(root.join("main.tex"), MAIN.replace("two", "TWO")).unwrap();
        settle(&state, &id, &phone()).unwrap();
        // The user, later, in another file — and one new file of their own.
        fs::write(root.join("refs.bib"), "@book{a}\n@book{b}\n").unwrap();
        fs::write(root.join("mine.txt"), "keep me\n").unwrap();
        let done = undo(&state, &id, &phone()).unwrap();
        assert_eq!(done.files, vec![Changed { path: "main.tex".into(), change: "modified" }]);
        assert_eq!(fs::read_to_string(root.join("main.tex")).unwrap(), MAIN);
        assert_eq!(fs::read_to_string(root.join("refs.bib")).unwrap(), "@book{a}\n@book{b}\n");
        assert_eq!(fs::read_to_string(root.join("mine.txt")).unwrap(), "keep me\n");
    }

    #[test]
    fn an_edit_to_the_same_file_since_is_a_conflict_and_changes_nothing() {
        let (_tmp, root, state) = repo();
        let id = begin(&state, &root, phone(), None).unwrap();
        fs::write(root.join("main.tex"), MAIN.replace("two", "TWO")).unwrap();
        fs::write(root.join("new.tex"), "fresh\n").unwrap();
        settle(&state, &id, &phone()).unwrap();
        let edited = MAIN.replace("two", "Two, by hand");
        fs::write(root.join("main.tex"), &edited).unwrap();
        assert_eq!(undo(&state, &id, &phone()), Err(RoundError::Conflict { files: vec!["main.tex".into()], more: 0 }));
        assert_eq!(fs::read_to_string(root.join("main.tex")).unwrap(), edited);
        assert_eq!(fs::read_to_string(root.join("new.tex")).unwrap(), "fresh\n", "all or nothing");
        // A file the round deleted, back again, is a conflict too.
        fs::write(root.join("main.tex"), MAIN.replace("two", "TWO")).unwrap();
        let id2 = begin(&state, &root, phone(), None).unwrap();
        fs::remove_file(root.join("refs.bib")).unwrap();
        settle(&state, &id2, &phone()).unwrap();
        fs::write(root.join("refs.bib"), "mine now\n").unwrap();
        assert_eq!(undo(&state, &id2, &phone()), Err(RoundError::Conflict { files: vec!["refs.bib".into()], more: 0 }));
        // Still undoable once the file is put back as the round left it.
        assert!(undo(&state, &id, &phone()).is_ok());
        assert!(!root.join("new.tex").exists());
    }

    #[test]
    fn an_ignored_pdf_comes_back_only_when_unchanged_since_settle() {
        let (_tmp, root, state) = repo();
        fs::write(root.join("main.pdf"), b"%PDF before").unwrap();
        let pdf = || Some(PdfBefore { rel: "main.pdf", bytes: b"%PDF before" });
        let id = begin(&state, &root, phone(), pdf()).unwrap();
        fs::write(root.join("main.tex"), "rebuilt\n").unwrap();
        fs::write(root.join("main.pdf"), b"%PDF after").unwrap();
        settle(&state, &id, &phone()).unwrap();
        assert_eq!(preview(&state, &id, &phone()).unwrap().pdf, PdfFate::Restored);
        assert_eq!(undo(&state, &id, &phone()).unwrap().pdf, PdfFate::Restored);
        assert_eq!(fs::read(root.join("main.pdf")).unwrap(), b"%PDF before");

        // Rebuilt again after the round settled: kept.
        let id = begin(&state, &root, phone(), pdf()).unwrap();
        fs::write(root.join("main.tex"), "rebuilt twice\n").unwrap();
        fs::write(root.join("main.pdf"), b"%PDF after").unwrap();
        settle(&state, &id, &phone()).unwrap();
        fs::write(root.join("main.pdf"), b"%PDF later").unwrap();
        assert_eq!(preview(&state, &id, &phone()).unwrap().pdf, PdfFate::Kept);
        let done = undo(&state, &id, &phone()).unwrap();
        assert_eq!(done.pdf, PdfFate::Kept);
        assert_eq!(fs::read(root.join("main.pdf")).unwrap(), b"%PDF later");
        assert_eq!(fs::read_to_string(root.join("main.tex")).unwrap(), MAIN, "the source still goes back");

        // Not rebuilt at all: nothing to put back.
        fs::write(root.join("main.pdf"), b"%PDF before").unwrap();
        let id = begin(&state, &root, phone(), pdf()).unwrap();
        settle(&state, &id, &phone()).unwrap();
        assert_eq!(preview(&state, &id, &phone()).unwrap().pdf, PdfFate::None);
    }

    #[cfg(unix)]
    #[test]
    fn a_pdf_turned_symlink_is_never_written_through() {
        let (tmp, root, state) = repo();
        fs::write(root.join("main.pdf"), b"%PDF before").unwrap();
        let id = begin(&state, &root, phone(), Some(PdfBefore { rel: "main.pdf", bytes: b"%PDF before" })).unwrap();
        let elsewhere = tmp.path().join("victim");
        fs::write(&elsewhere, b"%PDF after").unwrap();
        fs::remove_file(root.join("main.pdf")).unwrap();
        std::os::unix::fs::symlink(&elsewhere, root.join("main.pdf")).unwrap();
        settle(&state, &id, &phone()).unwrap();
        let _ = undo(&state, &id, &phone()).unwrap();
        assert_eq!(fs::read(&elsewhere).unwrap(), b"%PDF after");
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_come_back_as_links_and_are_never_followed() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let (tmp, root, state) = repo();
        symlink("main.tex", root.join("link")).unwrap();
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("sub/x.tex"), "x\n").unwrap();
        fs::write(root.join("run.sh"), "#!/bin/sh\n").unwrap();
        fs::set_permissions(root.join("run.sh"), fs::Permissions::from_mode(0o755)).unwrap();
        git(&root, &["add", "-A"]);
        git(&root, &["commit", "-q", "-m", "links"]);
        let id = begin(&state, &root, phone(), None).unwrap();
        fs::remove_file(root.join("link")).unwrap();
        symlink("refs.bib", root.join("link")).unwrap();
        fs::write(root.join("sub/x.tex"), "y\n").unwrap();
        fs::write(root.join("run.sh"), "#!/bin/sh\necho\n").unwrap();
        settle(&state, &id, &phone()).unwrap();
        // The folder turned into a link to elsewhere since: a conflict.
        let elsewhere = tmp.path().join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        fs::write(elsewhere.join("x.tex"), "y\n").unwrap();
        fs::rename(root.join("sub"), tmp.path().join("sub-moved")).unwrap();
        symlink(&elsewhere, root.join("sub")).unwrap();
        assert_eq!(undo(&state, &id, &phone()), Err(RoundError::Conflict { files: vec!["sub/x.tex".into()], more: 0 }));
        assert_eq!(fs::read_to_string(elsewhere.join("x.tex")).unwrap(), "y\n");
        fs::remove_file(root.join("sub")).unwrap();
        fs::rename(tmp.path().join("sub-moved"), root.join("sub")).unwrap();
        undo(&state, &id, &phone()).unwrap();
        assert_eq!(fs::read_link(root.join("link")).unwrap(), Path::new("main.tex"));
        assert_eq!(fs::read_to_string(root.join("sub/x.tex")).unwrap(), "x\n");
        assert_eq!(fs::read_to_string(root.join("run.sh")).unwrap(), "#!/bin/sh\n");
        assert_eq!(fs::metadata(root.join("run.sh")).unwrap().permissions().mode() & 0o111, 0o111, "the exec bit stays");
    }

    #[test]
    fn not_a_repo_and_too_big_have_no_undo() {
        let tmp = tempfile::tempdir().unwrap();
        let plain = tmp.path().join("plain");
        fs::create_dir_all(&plain).unwrap();
        // A temp dir inside no repo.
        assert_eq!(begin(&tmp.path().join("state"), &plain, phone(), None), Err(NoUndo::NotGit));

        let (_tmp, root, state) = repo();
        fs::create_dir_all(root.join("data")).unwrap();
        for n in 0..=MAX_COPIED_FILES {
            fs::write(root.join("data").join(format!("{n}.csv")), "x").unwrap();
        }
        assert_eq!(begin(&state, &root, phone(), None), Err(NoUndo::TooBig));
        fs::remove_dir_all(root.join("data")).unwrap();
        let big = vec![0u8; (MAX_COPIED_BYTES + 1) as usize];
        fs::write(root.join("big.dat"), &big).unwrap();
        assert_eq!(begin(&state, &root, phone(), None), Err(NoUndo::TooBig));
        assert!(fs::read_dir(state.join(ROUNDS_DIR)).map(|d| d.count()).unwrap_or(0) == 0, "a refused round leaves nothing");
    }

    #[test]
    fn a_round_grown_too_big_by_settle_loses_its_undo() {
        let (_tmp, root, state) = repo();
        let id = begin(&state, &root, phone(), None).unwrap();
        fs::create_dir_all(root.join("out")).unwrap();
        for n in 0..=MAX_COPIED_FILES {
            fs::write(root.join("out").join(format!("{n}.log")), "x").unwrap();
        }
        assert_eq!(settle(&state, &id, &phone()), Err(RoundError::Gone));
        assert_eq!(undo(&state, &id, &phone()), Err(RoundError::Gone));
    }

    #[test]
    fn info_attributes_naming_a_conversion_have_no_undo() {
        let (_tmp, root, state) = repo();
        fs::create_dir_all(root.join(".git/info")).unwrap();
        fs::write(root.join(".git/info/attributes"), "# filter=x is a comment\n*.psd filter=lfs\n").unwrap();
        assert_eq!(begin(&state, &root, phone(), None), Err(NoUndo::Filtered));
        fs::write(root.join(".git/info/attributes"), "*.tex diff=tex\n*.bin -text\n").unwrap();
        assert!(begin(&state, &root, phone(), None).is_ok());
        // A link or FIFO there cannot be vetted (git follows the link): no
        // undo, and the FIFO never blocks the read (#2347).
        #[cfg(unix)]
        {
            let attributes = root.join(".git/info/attributes");
            fs::remove_file(&attributes).unwrap();
            let plain = root.join("plain-attributes");
            fs::write(&plain, "*.tex diff=tex\n").unwrap();
            std::os::unix::fs::symlink(&plain, &attributes).unwrap();
            assert_eq!(begin(&state, &root, phone(), None), Err(NoUndo::Filtered));
            fs::remove_file(&attributes).unwrap();
            let c = std::ffi::CString::new(attributes.to_string_lossy().into_owned()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
            assert_eq!(begin(&state, &root, phone(), None), Err(NoUndo::Filtered));
        }
    }

    #[test]
    fn conversions_are_read_off_attribute_lines() {
        assert!(names_conversion("* text=auto\n"));
        assert!(names_conversion("*.sh eol=lf\n"));
        assert!(names_conversion("*.c ident\n"));
        assert!(names_conversion("*.bin filter=lfs -text\n"));
        // A macro is caught where it is defined: its line names the attribute.
        assert!(names_conversion("[attr]paper text eol=crlf\n*.tex paper\n"));
        assert!(!names_conversion("*.bin -text binary\n# * text\n*.tex diff=tex\n"));
        assert!(!names_conversion("*.pdf !eol\n"));
    }

    #[test]
    fn nothing_is_written_under_the_repos_git_dir() {
        for autocrlf in ["false", "input"] {
            let (_tmp, root, state) = repo_with(autocrlf);
            // A stale stat cache, as a real index often has: rehashed, and
            // its blob already stored in the repo — never freshened.
            std::thread::sleep(Duration::from_millis(20));
            fs::write(root.join("refs.bib"), "@book{a}\n").unwrap();
            let before = git_dir_state(&root);
            let id = begin(&state, &root, phone(), None).unwrap();
            fs::write(root.join("main.tex"), "changed\n").unwrap();
            fs::write(root.join("added.tex"), "new\n").unwrap();
            settle(&state, &id, &phone()).unwrap();
            preview(&state, &id, &phone()).unwrap();
            undo(&state, &id, &phone()).unwrap();
            assert_eq!(git_dir_state(&root), before, "{autocrlf}");
            let objects = state.join(ROUNDS_DIR).join(&id).join("objects");
            assert!(objects.read_dir().unwrap().count() > 2, "the snapshot's objects are the round's");
        }
    }

    /// A repo whose top holds `main.tex` (from [`repo`]), a sibling folder
    /// `other/` and the project folder `paper/`, all committed.
    fn repo_with_paper() -> (tempfile::TempDir, PathBuf, PathBuf, PathBuf) {
        let (tmp, top, state) = repo();
        let root = top.join("paper");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(top.join("other")).unwrap();
        fs::write(root.join("draft.tex"), "a\n").unwrap();
        fs::write(top.join("other").join("notes.tex"), "notes\n").unwrap();
        git(&top, &["add", "-A"]);
        git(&top, &["commit", "-q", "-m", "paper"]);
        (tmp, top, root, state)
    }

    #[test]
    fn a_project_below_the_repo_top_undoes_only_its_own_files_and_names_the_rest() {
        let (_tmp, top, root, state) = repo_with_paper();
        let owner = Owner::Desktop { project: "p".into() };
        let id = begin(&state, &root, owner.clone(), None).unwrap();
        // The round: inside the project an edit and a file in a new folder;
        // outside it an edit at the top, an edit and a new file in a sibling.
        fs::write(root.join("draft.tex"), "b\n").unwrap();
        fs::create_dir_all(root.join("fig")).unwrap();
        fs::write(root.join("fig").join("new.tex"), "n\n").unwrap();
        fs::write(top.join("main.tex"), "outside\n").unwrap();
        fs::write(top.join("other").join("notes.tex"), "sibling edit\n").unwrap();
        fs::write(top.join("other").join("added.tex"), "sibling new\n").unwrap();
        settle(&state, &id, &owner).unwrap();
        let outside: Vec<String> = vec!["main.tex".into(), "other/added.tex".into(), "other/notes.tex".into()];
        let preview = preview(&state, &id, &owner).unwrap();
        assert_eq!(
            preview.files,
            vec![
                Changed { path: "draft.tex".into(), change: "modified" },
                Changed { path: "fig/new.tex".into(), change: "added" },
            ]
        );
        assert_eq!((preview.more, &preview.outside, preview.outside_more), (0, &outside, 0));
        // Changed again outside since the settle: not the undo's business.
        fs::write(top.join("other").join("notes.tex"), "sibling edit, twice\n").unwrap();
        let done = undo(&state, &id, &owner).unwrap();
        assert_eq!((done.files.len(), &done.outside, done.outside_more), (2, &outside, 0));
        assert_eq!(fs::read_to_string(root.join("draft.tex")).unwrap(), "a\n");
        assert!(!root.join("fig").exists(), "the folder the round added goes with its file");
        assert_eq!(fs::read_to_string(top.join("main.tex")).unwrap(), "outside\n");
        assert_eq!(fs::read_to_string(top.join("other").join("notes.tex")).unwrap(), "sibling edit, twice\n");
        assert_eq!(fs::read_to_string(top.join("other").join("added.tex")).unwrap(), "sibling new\n");
        // The wire's names.
        let wire = serde_json::to_value(&done).unwrap();
        assert_eq!(wire["outside"], serde_json::json!(outside));
        assert_eq!(wire["outsideMore"], serde_json::json!(0));
    }

    #[test]
    fn a_change_outside_the_project_neither_conflicts_nor_is_listed_past_the_cap() {
        let (_tmp, top, root, state) = repo_with_paper();
        let owner = Owner::Desktop { project: "p".into() };
        let id = begin(&state, &root, owner.clone(), None).unwrap();
        fs::write(root.join("draft.tex"), "b\n").unwrap();
        for n in 0..MAX_LISTED + 5 {
            fs::write(top.join("other").join(format!("n{n:03}.tex")), "x\n").unwrap();
        }
        fs::write(top.join("other").join("bad`name.tex"), "x\n").unwrap();
        settle(&state, &id, &owner).unwrap();
        // Removed since the settle — would be a conflict inside the project.
        fs::remove_file(top.join("other").join("n000.tex")).unwrap();
        let done = undo(&state, &id, &owner).unwrap();
        assert_eq!(done.files, vec![Changed { path: "draft.tex".into(), change: "modified" }]);
        assert_eq!((done.outside.len(), done.outside_more), (MAX_LISTED, 6), "past the cap, and the unspeakable name");
        assert!(done.outside.iter().all(|name| name.starts_with("other/n")));
        assert_eq!(fs::read_to_string(root.join("draft.tex")).unwrap(), "a\n");
        assert!(top.join("other").join("n001.tex").exists());
    }

    #[test]
    fn an_empty_project_folder_stays_after_its_only_file_is_undone() {
        let (_tmp, top, state) = repo();
        let root = top.join("empty");
        fs::create_dir_all(&root).unwrap();
        let owner = Owner::Desktop { project: "p".into() };
        let id = begin(&state, &root, owner.clone(), None).unwrap();
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("sub").join("a.tex"), "a\n").unwrap();
        settle(&state, &id, &owner).unwrap();
        let done = undo(&state, &id, &owner).unwrap();
        assert_eq!(done.files, vec![Changed { path: "sub/a.tex".into(), change: "added" }]);
        assert!(!root.join("sub").exists());
        assert!(root.is_dir(), "the project folder itself is never removed");
    }

    #[test]
    fn a_file_moved_into_the_project_stays_and_its_names_reach_no_phone() {
        let (_tmp, top, root, state) = repo_with_paper();
        let owner = Owner::Desktop { project: "p".into() };
        let id = begin(&state, &root, owner.clone(), None).unwrap();
        // Moved in from the sibling (its only copy now), and one moved out.
        fs::rename(top.join("other").join("notes.tex"), root.join("notes.tex")).unwrap();
        fs::rename(root.join("draft.tex"), top.join("other").join("draft.tex")).unwrap();
        settle(&state, &id, &owner).unwrap();
        let done = undo(&state, &id, &owner).unwrap();
        assert_eq!(done.files, vec![Changed { path: "draft.tex".into(), change: "deleted" }]);
        assert_eq!(done.outside, vec!["other/draft.tex", "other/notes.tex", "paper/notes.tex"]);
        assert_eq!(fs::read_to_string(root.join("notes.tex")).unwrap(), "notes\n", "never the last copy removed");
        assert_eq!(fs::read_to_string(root.join("draft.tex")).unwrap(), "a\n");
        assert!(!top.join("other").join("notes.tex").exists(), "nothing written outside");
        assert!(top.join("other").join("draft.tex").exists());
        // The phone gets the count only.
        let phone = serde_json::to_value(done.outside_counted()).unwrap();
        assert!(phone.get("outside").is_none(), "no names outside the project to a phone: {phone}");
        assert_eq!(phone["outsideMore"], serde_json::json!(3));
        assert!(!phone.to_string().contains("other/"));
    }

    #[test]
    fn another_owner_or_a_bad_id_is_not_found() {
        let (_tmp, root, state) = repo();
        let id = begin(&state, &root, phone(), None).unwrap();
        let other_tab = Owner::Phone { tab: "t2".into(), project: "p1".into() };
        let desktop = Owner::Desktop { project: "p1".into() };
        for owner in [&other_tab, &desktop] {
            assert_eq!(settle(&state, &id, owner), Err(RoundError::NotFound));
            assert_eq!(preview(&state, &id, owner), Err(RoundError::NotFound));
            assert_eq!(undo(&state, &id, owner), Err(RoundError::NotFound));
        }
        for bad in ["../x", "ABCDEF0123456789ABCDEF0123456789", "", "0"] {
            assert_eq!(settle(&state, bad, &phone()), Err(RoundError::NotFound), "{bad}");
        }
        assert_eq!(undo(&state, &"0".repeat(32), &phone()), Err(RoundError::Gone), "pruned or never there");
        assert_eq!(undo(&state, &id, &phone()), Err(RoundError::NotReady), "not settled yet");
    }

    #[test]
    fn prune_keeps_the_newest_and_drops_the_old() {
        let (_tmp, root, state) = repo();
        let mut ids = Vec::new();
        for _ in 0..KEEP_ROUNDS + 3 {
            ids.push(begin(&state, &root, phone(), None).unwrap());
        }
        let left: Vec<String> = fs::read_dir(state.join(ROUNDS_DIR))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(left.len(), KEEP_ROUNDS);
        assert!(left.contains(ids.last().unwrap()));
        // An old one goes whatever the count.
        let old = state.join(ROUNDS_DIR).join(&ids[ids.len() - 2]);
        let mut record: serde_json::Value = serde_json::from_slice(&fs::read(old.join("round.json")).unwrap()).unwrap();
        record["created"] = serde_json::json!(now_secs() - KEEP_FOR.as_secs() - 10);
        fs::write(old.join("round.json"), serde_json::to_vec(&record).unwrap()).unwrap();
        begin(&state, &root, phone(), None).unwrap();
        assert!(!old.exists());
    }

    #[test]
    fn versions_and_alternates_parse() {
        assert!(new_enough("git version 2.53.0"));
        assert!(new_enough("git version 2.40.1.windows.1"));
        assert!(new_enough("git version 3.0.0"));
        assert!(!new_enough("git version 2.39.3 (Apple Git-145)"));
        assert!(!new_enough("nonsense"));
        assert_eq!(alternates_value(Path::new("/home/u/p/.git/objects")), "/home/u/p/.git/objects");
        if cfg!(unix) {
            assert_eq!(alternates_value(Path::new("/a:b/\"q\"/o")), "\"/a:b/\\\"q\\\"/o\"");
        }
    }
}
