//! The phone's Diffs view of one agent tab — `GET /api/v1/tabs/{id}/changes`:
//! the diffs its conversation (or one subagent's) recorded, as the desktop
//! Reader's Diffs tab reads them (`agent_changes`). The sidecar answers it
//! itself, window open or not, from the CLI's own transcript.
//!
//! A diff is file content, so it crosses only behind the desktop's "Project
//! files on the phone" switch, the one the phone's file library sits behind
//! (the route checks it). Nothing crosses as a host path: a file crosses
//! relative to its checkout, a linked worktree (or a box member's folder) as
//! its leaf name and branch, and a change to a file in no checkout of the
//! scope — the agent's own home, a scratch folder — is left out, only
//! counted (`outside`). A file the 📁 library would list also crosses as its
//! sealed row (`attach_files`), so the view can open it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::chat_uncommitted::{checkouts_of, relative_to};
use super::discovery::ResolvedTab;
use super::git_overview::{self, TabWorktree};
use super::protocol::MobileMarkupFile;
use crate::services::agent_changes::{self, AgentChanges};

/// Changes asked for when the phone names no `limit`, and at most.
pub const DEFAULT_LIMIT: usize = 60;
pub const MAX_LIMIT: usize = 200;
/// The diff text one answer carries at most, newest change first: a phone on
/// a mobile link is not sent the desktop's 200 changes of up to 200 KB each.
const MAX_DIFF_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct ChatChanges {
    pub available: bool,
    /// Why not: `agent_changes`' reasons, `no_session`, or `remote`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Passed back as `?version=`, answered `unchanged` while it stands.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub unchanged: bool,
    /// Oldest first, as the desktop's.
    pub changes: Vec<PhoneChange>,
    /// Earlier changes exist that this answer does not carry.
    pub truncated: bool,
    /// Changes left out because their file is in no checkout of the scope.
    #[serde(skip_serializing_if = "is_zero")]
    pub outside: u32,
}

fn is_zero(count: &u32) -> bool {
    *count == 0
}

impl ChatChanges {
    fn unavailable(reason: &str) -> Self {
        Self { available: false, reason: Some(reason.to_string()), ..Default::default() }
    }

    /// The changes without their diff text, for the Files list: it names the
    /// files and shows no diff, so a poll need not carry one.
    pub fn drop_diffs(&mut self) {
        for change in &mut self.changes {
            change.diff.clear();
        }
    }
}

/// One file one call changed: `agent_changes::FileChange` with its path made
/// checkout-relative.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PhoneChange {
    /// Relative to its checkout, `/`-separated.
    pub path: String,
    /// The linked worktree or box member's folder the file is in; absent for
    /// the project folder's own checkout.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<TabWorktree>,
    /// `edit`, `add`, `delete` or `write` (`agent_changes::FileChange::kind`).
    pub kind: String,
    /// Unified-diff hunks, each opened by its `@@` line; no file header.
    pub diff: String,
    pub added: u32,
    pub removed: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub cut: bool,
    /// Where a rename moved it, relative like `path`; absent when that is
    /// outside every checkout.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub moved_to: Option<String>,
    /// The file as the library rows it now, to open it by; absent for a file
    /// the library would not list (deleted since, in a worktree, a box's).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<MobileMarkupFile>,
    /// Where the file stands on this host, past a rename. Never crosses.
    #[serde(skip)]
    pub absolute: String,
}

/// The answer for `tab` of the scope `project_id`, whose folders are `roots`
/// (the project folder; a box's folder and its members'). Blocking.
pub fn for_tab(
    project_id: &str,
    roots: &[PathBuf],
    tab: &ResolvedTab,
    subagent: Option<&str>,
    version: Option<&str>,
    limit: Option<usize>,
) -> ChatChanges {
    // A host tab's conversation is on the host; nothing here reads it.
    if tab.place.on_host() {
        return ChatChanges::unavailable("unsupported");
    }
    if crate::services::remote::remote_target_for(project_id).is_some() {
        return ChatChanges::unavailable("remote");
    }
    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    // What the desktop's `agent_tab_changes` reads for the same tab.
    let read = if tab.local_model && tab.cmd == "opencode" {
        agent_changes::local_opencode_changes(Some(project_id), Some(&tab.cwd), tab.since, tab.session_id.as_deref(), subagent, version, limit)
    } else {
        let session = tab.session_id.as_deref().filter(|id| !id.is_empty());
        let Some(session) = session.or((tab.cmd == "opencode").then_some("")) else {
            let reason = if matches!(tab.cmd.as_str(), "claude" | "codex" | "copilot") { "no_session" } else { "unsupported" };
            return ChatChanges::unavailable(reason);
        };
        agent_changes::agent_session_changes(&tab.cmd, Some(project_id), Some(&tab.cwd), tab.since, session, subagent, version, limit)
    };
    for_phone(&checkouts_of(roots), read)
}

/// `read` as the phone may see it: paths placed in `checkouts`
/// (`checkouts_of`), the rest dropped and counted, the diff text bounded.
pub fn for_phone(checkouts: &[(String, Option<TabWorktree>)], read: AgentChanges) -> ChatChanges {
    if !read.available {
        return ChatChanges::unavailable(read.reason.as_deref().unwrap_or("read_failed"));
    }
    if read.unchanged {
        return ChatChanges { available: true, version: read.version, unchanged: true, ..Default::default() };
    }
    let of = git_overview::worktree_matcher(checkouts.iter().map(|(path, _)| path.as_str()));
    let place = |path: &str| -> Option<(String, Option<TabWorktree>)> {
        let (checkout, worktree) = &checkouts[of(path)?];
        Some((relative_to(Path::new(checkout), Path::new(path))?, worktree.clone()))
    };
    let mut changes = Vec::new();
    let mut outside = 0u32;
    let mut truncated = read.truncated;
    let mut bytes = 0usize;
    // Newest first, so the bound drops the oldest.
    for change in read.changes.into_iter().rev() {
        let Some((path, worktree)) = place(&change.path) else {
            outside = outside.saturating_add(1);
            continue;
        };
        bytes += change.diff.len();
        if bytes > MAX_DIFF_BYTES && !changes.is_empty() {
            truncated = true;
            break;
        }
        let moved_to = change.moved_to.as_deref().and_then(place).map(|(path, _)| path);
        let absolute = change.moved_to.unwrap_or(change.path);
        changes.push(PhoneChange {
            path,
            worktree,
            kind: change.kind,
            diff: agent_changes::hunks_only(&change.diff).to_string(),
            added: change.added,
            removed: change.removed,
            at: change.at,
            cut: change.cut,
            moved_to,
            file: None,
            absolute,
        });
    }
    changes.reverse();
    ChatChanges { available: true, reason: None, version: read.version, unchanged: false, changes, truncated, outside }
}

/// Gives the changes of the project folder's own checkout the rows `row`
/// answers for a path relative to `root`, which may lie below the checkout (a
/// project in a repo's subfolder). A worktree's or a box member's file has
/// none: the library lists only the project folder. Asked once per path, since
/// a chat edits the same few files many times; an `unchanged` answer holds no
/// changes, so a poll that finds nothing new asks nothing.
pub fn attach_files(answer: &mut ChatChanges, root: &Path, mut row: impl FnMut(&str) -> Option<MobileMarkupFile>) {
    let mut rows: HashMap<String, Option<MobileMarkupFile>> = HashMap::new();
    for change in answer.changes.iter_mut().filter(|change| change.worktree.is_none()) {
        let Some(relative) = relative_to(root, Path::new(&change.absolute)) else { continue };
        change.file = rows.entry(relative).or_insert_with_key(|relative| row(relative)).clone();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::agent_changes::FileChange;

    fn row(name: &str) -> MobileMarkupFile {
        MobileMarkupFile {
            token: format!("sealed-{name}"),
            name: name.to_string(),
            kind: "text/plain".into(),
            size: 1,
            modified: 1,
            folder: None,
            place: String::new(),
        }
    }

    #[test]
    fn a_change_is_rowed_once_per_path_past_its_rename_and_never_in_a_worktree() {
        let tmp = tempfile::tempdir().expect("tmp");
        let root = tmp.path().join("proj");
        let topic = root.join(crate::brand::WORKTREES_DIR).join("topic");
        std::fs::create_dir_all(root.join("src")).expect("src");
        std::fs::create_dir_all(&topic).expect("topic");
        let checkouts = vec![
            (root.to_string_lossy().into_owned(), None),
            (topic.to_string_lossy().into_owned(), Some(TabWorktree { label: "topic".into(), branch: None })),
        ];
        let mut renamed = change(&root.join("src").join("old.rs"), "@@ -1 +1 @@\n-a\n+b\n");
        renamed.moved_to = Some(root.join("src").join("new.rs").to_string_lossy().into_owned());
        let mut answer = for_phone(
            &checkouts,
            read(vec![
                change(&root.join("a.md"), "@@ -1 +1 @@\n-a\n+b\n"),
                change(&root.join("a.md"), "@@ -1 +1 @@\n-b\n+c\n"),
                renamed,
                change(&root.join("gone.md"), "@@ -1 +1 @@\n-a\n+b\n"),
                change(&topic.join("b.md"), "@@ -1 +1 @@\n-x\n+y\n"),
            ]),
        );
        let mut asked = Vec::new();
        attach_files(&mut answer, &root, |relative| {
            asked.push(relative.to_string());
            (relative != "gone.md").then(|| row(relative))
        });
        assert_eq!(asked, ["a.md", "src/new.rs", "gone.md"], "each path once, no worktree's");
        let tokens: Vec<Option<&str>> = answer.changes.iter().map(|c| c.file.as_ref().map(|file| file.token.as_str())).collect();
        assert_eq!(
            tokens,
            vec![Some("sealed-a.md"), Some("sealed-a.md"), Some("sealed-src/new.rs"), None, None]
        );
        let text = serde_json::to_string(&answer).expect("json");
        assert!(!text.contains(&*tmp.path().to_string_lossy()), "no host path crosses: {text}");
    }

    #[test]
    fn a_project_in_a_subfolder_of_its_repo_rows_paths_from_its_own_folder() {
        let tmp = tempfile::tempdir().expect("tmp");
        let repo = tmp.path().join("repo");
        let project = repo.join("paper");
        std::fs::create_dir_all(&project).expect("project");
        let checkouts = vec![(repo.to_string_lossy().into_owned(), None)];
        let mut answer = for_phone(
            &checkouts,
            read(vec![
                change(&project.join("main.tex"), "@@ -1 +1 @@\n-a\n+b\n"),
                change(&repo.join("elsewhere.md"), "@@ -1 +1 @@\n-a\n+b\n"),
            ]),
        );
        assert_eq!(answer.changes[0].path, "paper/main.tex", "the diff still reads from the checkout");
        let mut asked = Vec::new();
        attach_files(&mut answer, &project, |relative| {
            asked.push(relative.to_string());
            Some(row(relative))
        });
        assert_eq!(asked, ["main.tex"], "a file above the project folder is none of the library's");
        assert!(answer.changes[1].file.is_none());
    }

    fn change(path: &Path, diff: &str) -> FileChange {
        FileChange {
            path: path.to_string_lossy().into_owned(),
            kind: "edit".into(),
            diff: diff.into(),
            added: 1,
            removed: 1,
            ..Default::default()
        }
    }

    fn read(changes: Vec<FileChange>) -> AgentChanges {
        AgentChanges { available: true, version: Some("v1".into()), changes, ..Default::default() }
    }

    #[test]
    fn paths_cross_checkout_relative_and_files_elsewhere_stay_home() {
        let tmp = tempfile::tempdir().expect("tmp");
        let root = tmp.path().join("proj");
        let topic = root.join(crate::brand::WORKTREES_DIR).join("topic");
        std::fs::create_dir_all(root.join("src")).expect("src");
        std::fs::create_dir_all(&topic).expect("topic");
        let checkouts = vec![
            (root.to_string_lossy().into_owned(), None),
            (topic.to_string_lossy().into_owned(), Some(TabWorktree { label: "topic".into(), branch: Some("topic".into()) })),
        ];
        let mut renamed = change(&root.join("src").join("old.rs"), "@@ -1 +1 @@\n-a\n+b\n");
        renamed.moved_to = Some(root.join("src").join("new.rs").to_string_lossy().into_owned());
        let answer = for_phone(
            &checkouts,
            read(vec![
                renamed,
                // A file header before the hunks is the panel's, never a path that crosses.
                change(&topic.join("b.md"), "--- a/b.md\n+++ b/b.md\n@@ -1 +1 @@\n-x\n+y\n"),
                change(&tmp.path().join("home").join("memory.md"), "@@ -1 +1 @@\n-secret\n+secret2\n"),
            ]),
        );
        assert!(answer.available);
        assert_eq!(answer.outside, 1);
        let rows: Vec<(&str, Option<&str>, Option<&str>, &str)> = answer
            .changes
            .iter()
            .map(|c| (c.path.as_str(), c.worktree.as_ref().map(|wt| wt.label.as_str()), c.moved_to.as_deref(), c.diff.as_str()))
            .collect();
        assert_eq!(
            rows,
            vec![
                ("src/old.rs", None, Some("src/new.rs"), "@@ -1 +1 @@\n-a\n+b\n"),
                ("b.md", Some("topic"), None, "@@ -1 +1 @@\n-x\n+y\n"),
            ]
        );
        let text = serde_json::to_string(&answer).expect("json");
        assert!(!text.contains(&*tmp.path().to_string_lossy()), "no host path crosses: {text}");
        assert!(!text.contains("secret"), "{text}");
    }

    #[test]
    fn the_newest_changes_are_kept_when_the_diff_text_runs_over_its_bound() {
        let tmp = tempfile::tempdir().expect("tmp");
        let root = tmp.path().join("proj");
        std::fs::create_dir_all(&root).expect("root");
        let checkouts = vec![(root.to_string_lossy().into_owned(), None)];
        let big = format!("@@ -1 +1 @@\n+{}\n", "x".repeat(MAX_DIFF_BYTES / 2 - 100));
        let changes = (0..4).map(|n| change(&root.join(format!("f{n}.txt")), &big)).collect();
        let answer = for_phone(&checkouts, read(changes));
        assert!(answer.truncated);
        let paths: Vec<&str> = answer.changes.iter().map(|c| c.path.as_str()).collect();
        assert_eq!(paths, ["f2.txt", "f3.txt"], "oldest first, the newest kept");
    }

    #[test]
    fn an_unchanged_or_unavailable_read_passes_through() {
        let unchanged = AgentChanges { available: true, unchanged: true, version: Some("v2".into()), ..Default::default() };
        let answer = for_phone(&[], unchanged);
        assert!(answer.available && answer.unchanged);
        assert_eq!(answer.version.as_deref(), Some("v2"));
        let answer = for_phone(&[], AgentChanges::unavailable("no_subagent"));
        assert!(!answer.available);
        assert_eq!(answer.reason.as_deref(), Some("no_subagent"));
    }
}
