//! The phone's "not committed yet" count for one agent tab —
//! `GET /api/v1/tabs/{id}/uncommitted`: the files the tab's conversation
//! changed (`agent_changes::changed_paths`) that `git status` still lists as
//! changed. The sidecar answers it itself, window open or not, from the CLI's
//! own transcript and one hardened `git status` per checkout touched, limited
//! to those files.
//!
//! A floor, not the tree's changes: an edit the agent made through a shell
//! command is in no record read here, and a file another session also changed
//! still counts as this chat's. Nothing crosses as a host path: a file crosses
//! relative to its checkout, a linked worktree as its leaf name and branch.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use app_core::sync::LockExt;
use serde::Serialize;

use super::discovery::ResolvedTab;
use super::git_overview::{self, TabWorktree};

/// File rows sent; the rest are counted in `total`.
pub const MAX_FILES: usize = 100;
/// Files asked about per checkout; a conversation that changed more is asked
/// about its first ones (by path).
const MAX_PATHSPECS: usize = 500;
/// Checkouts asked per request.
const MAX_CHECKOUTS: usize = 8;
/// The time the status reads may take together, checked before each one.
const PROBE_BUDGET: Duration = Duration::from_secs(3);
/// How long an answer stands: the chat screen asks on every turn and on its
/// own clock, and more than one phone may be looking.
pub const TTL: Duration = Duration::from_secs(4);

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct ChatUncommitted {
    pub available: bool,
    /// Why not: `unsupported` (a CLI whose edits are not read), `remote`,
    /// `git_failed`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
    /// Sorted by worktree, then path; at most [`MAX_FILES`].
    pub files: Vec<UncommittedFile>,
    pub total: u32,
}

impl ChatUncommitted {
    fn unavailable(reason: &'static str) -> Self {
        Self { available: false, reason: Some(reason), ..Default::default() }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct UncommittedFile {
    /// Relative to its checkout, `/`-separated.
    pub path: String,
    /// `modified`, `added` (new, staged or not) or `deleted`.
    pub status: &'static str,
    /// The linked worktree (or a box member's folder) the file is in; absent
    /// for the project folder's own checkout.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<TabWorktree>,
}

/// The answer for `tab` of the scope `project_id`, whose folders are `roots`
/// (the project folder; a box's folder and its members'). Blocking.
pub fn for_tab(project_id: &str, roots: &[PathBuf], tab: &ResolvedTab) -> ChatUncommitted {
    if crate::services::remote::remote_target_for(project_id).is_some() {
        return ChatUncommitted::unavailable("remote");
    }
    let session = tab.session_id.as_deref().filter(|id| !id.is_empty());
    let Some(changed) = crate::services::agent_changes::changed_paths(
        &tab.cmd,
        Some(project_id),
        Some(&tab.cwd),
        tab.since,
        session,
        tab.local_model,
    ) else {
        return ChatUncommitted::unavailable("unsupported");
    };
    probe(roots, &changed)
}

/// Which of `changed` (absolute paths) `git status` lists as changed, in the
/// checkouts of `roots`' repositories. Blocking.
pub fn probe(roots: &[PathBuf], changed: &[String]) -> ChatUncommitted {
    if changed.is_empty() {
        return ChatUncommitted { available: true, ..Default::default() };
    }
    let checkouts = checkouts_of(roots);
    let of = git_overview::worktree_matcher(checkouts.iter().map(|(path, _)| path.as_str()));
    let mut asked: BTreeMap<usize, Vec<String>> = BTreeMap::new();
    for path in changed {
        let Some(at) = of(path) else {
            continue;
        };
        if let Some(relative) = relative_to(Path::new(&checkouts[at].0), Path::new(path)) {
            asked.entry(at).or_default().push(relative);
        }
    }
    let started = Instant::now();
    let mut files = Vec::new();
    let mut failed = false;
    for (at, mut paths) in asked.into_iter().take(MAX_CHECKOUTS) {
        if started.elapsed() > PROBE_BUDGET {
            failed = true;
            break;
        }
        paths.sort();
        paths.dedup();
        paths.truncate(MAX_PATHSPECS);
        let (checkout, worktree) = &checkouts[at];
        match status_of(Path::new(checkout), &paths) {
            Some(listed) => files.extend(listed.into_iter().map(|(path, status)| UncommittedFile {
                path,
                status,
                worktree: worktree.clone(),
            })),
            None => failed = true,
        }
    }
    if failed && files.is_empty() {
        return ChatUncommitted::unavailable("git_failed");
    }
    files.sort_by(|a, b| {
        let label = |file: &UncommittedFile| file.worktree.as_ref().map(|wt| wt.label.clone());
        (label(a), &a.path).cmp(&(label(b), &b.path))
    });
    let total = u32::try_from(files.len()).unwrap_or(u32::MAX);
    files.truncate(MAX_FILES);
    ChatUncommitted { available: true, reason: None, files, total }
}

/// Every checkout of `roots`' repositories — each root's worktree list —
/// with what a file in it wears: a linked worktree its own name, a box
/// member's folder (any root after the first) its leaf name, the first
/// root's own checkout nothing. A remote or vanished root is skipped.
pub(super) fn checkouts_of(roots: &[PathBuf]) -> Vec<(String, Option<TabWorktree>)> {
    let mut checkouts: Vec<(String, Option<TabWorktree>)> = Vec::new();
    for (index, root) in roots.iter().enumerate() {
        if !root.is_dir() || crate::services::remote::remote_target_for_dir(&root.to_string_lossy()).is_some() {
            continue;
        }
        for spot in git_overview::worktree_spots(root) {
            if checkouts.iter().any(|(path, _)| *path == spot.path) {
                continue;
            }
            let worktree = spot.tab.or_else(|| {
                (index > 0).then(|| TabWorktree {
                    label: root.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default(),
                    branch: None,
                })
            });
            checkouts.push((spot.path, worktree));
        }
    }
    checkouts
}

/// `path` relative to `checkout`, `/`-separated — both canonicalized first
/// (a symlinked folder, macOS's `/var`), a deleted file through its deepest
/// existing ancestor, and compared as spelled when that does not place it.
/// `None` outside it.
pub(super) fn relative_to(checkout: &Path, path: &Path) -> Option<String> {
    fn resolved(path: &Path) -> PathBuf {
        crate::paths::canonical_or_new(path).unwrap_or_else(|_| path.to_path_buf())
    }
    let relative = resolved(path)
        .strip_prefix(resolved(checkout))
        .map(Path::to_path_buf)
        .or_else(|_| path.strip_prefix(checkout).map(Path::to_path_buf))
        .ok()?;
    let parts: Vec<String> = relative
        .components()
        .map(|part| match part {
            std::path::Component::Normal(name) => Some(name.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Option<_>>()?;
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// What `git status` lists among `paths` (relative to `checkout`): each path
/// with its kind of change. One hardened spawn, the paths as literal
/// pathspecs, untracked files listed one by one, renames as a delete and an
/// add. `None` when git could not answer.
fn status_of(checkout: &Path, paths: &[String]) -> Option<Vec<(String, &'static str)>> {
    let mut args: Vec<String> = ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--"]
        .into_iter()
        .map(str::to_string)
        .collect();
    args.extend(paths.iter().map(|path| format!(":(literal){path}")));
    let out = crate::services::git_bounded::output(crate::commands::git::hardened_git_command_in(checkout, &args)).ok()?;
    if !out.status.success() {
        return None;
    }
    Some(parse_status(&out.stdout))
}

/// `git status --porcelain=v1 -z --no-renames` output as (path, kind) rows.
fn parse_status(stdout: &[u8]) -> Vec<(String, &'static str)> {
    let mut rows: HashMap<String, &'static str> = HashMap::new();
    for entry in stdout.split(|&b| b == 0) {
        if entry.len() < 4 || entry[2] != b' ' {
            continue;
        }
        let (x, y) = (entry[0], entry[1]);
        let status = match (x, y) {
            (b'!', _) => continue,
            (b'?', _) | (b'A', _) => "added",
            (b'D', _) | (_, b'D') => "deleted",
            _ => "modified",
        };
        rows.insert(String::from_utf8_lossy(&entry[3..]).into_owned(), status);
    }
    let mut rows: Vec<(String, &'static str)> = rows.into_iter().collect();
    rows.sort();
    rows
}

/// Each tab's last answer, for [`TTL`].
static ANSWERS: std::sync::LazyLock<std::sync::Mutex<HashMap<String, (Instant, ChatUncommitted)>>> =
    std::sync::LazyLock::new(Default::default);

/// The answer for `key` (a tab's id) still standing at `now`.
pub fn cached(key: &str, now: Instant) -> Option<ChatUncommitted> {
    ANSWERS
        .lock_ok()
        .get(key)
        .filter(|(at, _)| now.duration_since(*at) < TTL)
        .map(|(_, answer)| answer.clone())
}

pub fn remember(key: &str, answer: ChatUncommitted, now: Instant) {
    let mut answers = ANSWERS.lock_ok();
    answers.retain(|_, (at, _)| now.duration_since(*at) < TTL);
    answers.insert(key.to_string(), (now, answer));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::git;

    #[test]
    fn status_rows_name_the_kind_of_change_and_skip_ignored_files() {
        let out = b" M src/a.ts\0?? new file.txt\0D  gone.rs\0 D lost.rs\0A  staged.rs\0MM both.rs\0!! ignored.log\0";
        assert_eq!(
            parse_status(out),
            vec![
                ("both.rs".to_string(), "modified"),
                ("gone.rs".to_string(), "deleted"),
                ("lost.rs".to_string(), "deleted"),
                ("new file.txt".to_string(), "added"),
                ("src/a.ts".to_string(), "modified"),
                ("staged.rs".to_string(), "added"),
            ]
        );
        assert!(parse_status(b"").is_empty());
    }

    #[test]
    fn relative_paths_are_slash_separated_and_never_leave_the_checkout() {
        let tmp = tempfile::tempdir().expect("tmp");
        let checkout = tmp.path().join("proj");
        std::fs::create_dir_all(checkout.join("src")).expect("dirs");
        std::fs::write(checkout.join("src").join("a.ts"), "a").expect("file");
        assert_eq!(relative_to(&checkout, &checkout.join("src").join("a.ts")).as_deref(), Some("src/a.ts"));
        // A deleted file is placed through its parent, or a deleted folder's.
        assert_eq!(relative_to(&checkout, &checkout.join("src").join("gone.ts")).as_deref(), Some("src/gone.ts"));
        assert_eq!(
            relative_to(&checkout, &checkout.join("gone").join("deep.ts")).as_deref(),
            Some("gone/deep.ts")
        );
        assert_eq!(relative_to(&checkout, &tmp.path().join("elsewhere.ts")), None);
        assert_eq!(relative_to(&checkout, &checkout), None);
    }

    #[test]
    fn only_the_chats_files_still_changed_are_counted_per_checkout() {
        if !crate::commands::git::git_available_blocking() {
            return;
        }
        // Reached through a symlink, as macOS's temp dir is: git reports the
        // checkouts by their real path, a deleted file has none of its own.
        let (_tmp, base) = crate::test_util::tempdir_via_symlink();
        let root = base.join("proj");
        std::fs::create_dir_all(&root).expect("root");
        git(&root, &["init", "-q"]);
        // As the desktop keeps its own folder (worktrees included) out of git.
        std::fs::write(root.join(".git").join("info").join("exclude"), crate::brand::PROJECT_DIR_EXCLUDE_RULE).expect("exclude");
        for name in ["a.txt", "b.txt", "c.txt", "d.txt"] {
            std::fs::write(root.join(name), "one").expect("file");
        }
        std::fs::write(root.join(".gitignore"), "*.log\n").expect("ignore");
        git(&root, &["add", "."]);
        git(&root, &["commit", "-q", "-m", "one"]);
        let topic = root.join(crate::brand::WORKTREES_DIR).join("topic");
        std::fs::create_dir_all(topic.parent().expect("parent")).expect("worktrees dir");
        git(&root, &["worktree", "add", "-q", "-b", "topic", &topic.to_string_lossy()]);

        // The chat edited a.txt (still dirty), b.txt (committed since),
        // created new.txt, deleted d.txt, wrote an ignored log, and edited a
        // file in the worktree. Another session's c.txt is not the chat's.
        std::fs::write(root.join("a.txt"), "two").expect("edit");
        std::fs::write(root.join("c.txt"), "two").expect("other session");
        std::fs::write(root.join("new.txt"), "new").expect("new");
        std::fs::remove_file(root.join("d.txt")).expect("delete");
        std::fs::write(root.join("run.log"), "log").expect("log");
        std::fs::write(topic.join("b.txt"), "topic").expect("worktree edit");
        let changed: Vec<String> = [
            root.join("a.txt"),
            root.join("b.txt"),
            root.join("new.txt"),
            root.join("d.txt"),
            root.join("run.log"),
            topic.join("b.txt"),
            base.join("outside.txt"),
        ]
        .iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect();

        let answer = probe(std::slice::from_ref(&root), &changed);
        assert!(answer.available);
        let rows: Vec<(&str, &str, Option<&str>)> = answer
            .files
            .iter()
            .map(|file| (file.path.as_str(), file.status, file.worktree.as_ref().map(|wt| wt.label.as_str())))
            .collect();
        assert_eq!(
            rows,
            vec![
                ("a.txt", "modified", None),
                ("d.txt", "deleted", None),
                ("new.txt", "added", None),
                ("b.txt", "modified", Some("topic")),
            ]
        );
        assert_eq!(answer.total, 4);

        git(&root, &["commit", "-q", "-am", "two"]);
        let after = probe(std::slice::from_ref(&root), &changed);
        let rows: Vec<&str> = after.files.iter().map(|file| file.path.as_str()).collect();
        assert_eq!(rows, ["new.txt", "b.txt"], "committed files drop out");

        assert_eq!(probe(std::slice::from_ref(&root), &[]), ChatUncommitted { available: true, ..Default::default() });
    }
}
