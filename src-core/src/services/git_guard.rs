//! The files inside a repository that make git *run* something, and which a
//! sandbox must therefore keep its occupant from writing (#158).
//!
//! A fenced agent or a project container gets the project read-write, `.git`
//! included — it has to, to commit. But `.git/config` (`core.fsmonitor`,
//! `core.hooksPath`, `core.sshCommand`, filter drivers), `.git/hooks/*`, and
//! the `.git` entry itself (swap the directory for a `gitdir:` pointer file and
//! every one of those comes from wherever the pointer says) are instructions
//! the *next unsandboxed* git follows: Tabtivity's own calls, and the user's
//! terminal. That is the sandbox "trust handoff" escape (Pillar Security,
//! CSA, 2026) — the agent never leaves the box; the host runs what it wrote.
//!
//! [`guard_paths`] names what to re-mount over the read-write project:
//! `pinned` gets a read-write bind onto itself, which only makes it a mount
//! point (renaming or replacing a mount point fails `EBUSY`, verified under
//! bubblewrap); `read_only` gets a read-only bind. Git keeps working — commit,
//! branch, stash, gc and worktree add write objects, refs, the index and lock
//! files, none of them listed here. What an agent loses is `git config` on
//! the repo and installing hooks.
//!
//! **Residual, stated rather than hidden:** a read-only bind can only cover a
//! file that exists. Git creates lock files directly in the git dir, so the
//! dir itself stays writable, and an agent can still *create* a
//! `commondir` in a main `.git` (git then reads config and hooks from where it
//! points — verified: a plain `git add` runs the target's `post-index-change`),
//! or `git init` a repo where there was none. Tabtivity's own local git is not
//! steered by either (#862): every call pins `GIT_COMMON_DIR` to a main `.git`
//! (`commands::git::pin_common_dir`), so a planted `commondir` is ignored, and
//! runs with hooks off except the verbs `services::exec_trust` gates. A plain
//! `git` in the user's terminal still follows a planted `commondir`.

use std::path::{Path, PathBuf};

/// Where Tabtivity puts agent worktrees inside a project (`commands::git`'s
/// `worktrees_root`). Each holds a `.git` pointer file the occupant could
/// otherwise rewrite.
const WORKTREES_DIR: [&str; 2] = [crate::brand::PROJECT_DIR, "worktrees"];

/// Files in a git dir that name programs git runs, or redirect where git reads
/// them from.
const CONTROL_FILES: [&str; 4] = ["config", "config.worktree", "hooks", "commondir"];

#[derive(Debug, Default, PartialEq, Eq)]
pub struct GuardPaths {
    /// Bind read-write onto itself: a mount point cannot be renamed away.
    pub pinned: Vec<PathBuf>,
    /// Bind read-only onto itself.
    pub read_only: Vec<PathBuf>,
}

/// The git control paths to protect for a sandbox whose writable roots are
/// `roots` and which starts in `cwd` (`None` for a container, which has no
/// single start dir). Only paths that exist and lie inside a writable root are
/// named — everything else is already read-only to the occupant, and a mount
/// over a missing path would create it on the host.
pub fn guard_paths(roots: &[PathBuf], cwd: Option<&Path>) -> GuardPaths {
    let roots: Vec<PathBuf> = roots
        .iter()
        .map(|r| r.canonicalize().unwrap_or_else(|_| r.clone()))
        .collect();
    let inside = |p: &Path| roots.iter().any(|r| p.starts_with(r));
    let mut starts: Vec<PathBuf> = roots.clone();
    if let Some(cwd) = cwd {
        // The nearest `.git` above the start dir is the one git discovers.
        let cwd = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
        if let Some(dir) = cwd.ancestors().filter(|d| inside(d)).find(|d| d.join(".git").exists()) {
            starts.push(dir.to_path_buf());
        }
    }
    // A project not opened since a rename still keeps its worktrees in the
    // app's folder under the old name; they are guarded the same.
    let legacy_dir = crate::brand::PAIR.legacy(crate::brand::Name::PROJECT_DIR);
    for root in &roots {
        for app_dir in std::iter::once(WORKTREES_DIR[0]).chain(legacy_dir.as_deref()) {
            if let Ok(entries) = std::fs::read_dir(root.join(app_dir).join(WORKTREES_DIR[1])) {
                starts.extend(entries.flatten().map(|e| e.path()));
            }
        }
    }

    let mut out = GuardPaths::default();
    let mut git_dirs: Vec<PathBuf> = Vec::new();
    for dir in starts {
        let dot_git = dir.join(".git");
        let Ok(meta) = std::fs::symlink_metadata(&dot_git) else { continue };
        if meta.is_dir() {
            git_dirs.push(dot_git);
        } else if meta.is_file() {
            // A pointer: pin it by binding it read-only, then guard its target.
            out.read_only.push(dot_git.clone());
            if let Some(target) = pointer_target(&dot_git) {
                git_dirs.push(target);
            }
        }
    }
    // A linked worktree's git dir shares its common dir's config and hooks.
    for dir in git_dirs.clone() {
        if let Ok(text) = std::fs::read_to_string(dir.join("commondir")) {
            let common = text.trim();
            if !common.is_empty() {
                git_dirs.push(dir.join(common));
            }
        }
    }
    for dir in git_dirs {
        let Ok(dir) = dir.canonicalize() else { continue };
        if !inside(&dir) {
            continue;
        }
        // Only a `.git` dir is pinned: a worktree's git dir lives inside the
        // main one, which pinning already holds in place.
        if dir.file_name().is_some_and(|n| n == ".git") {
            out.pinned.push(dir.clone());
        }
        out.read_only
            .extend(CONTROL_FILES.iter().map(|f| dir.join(f)).filter(|p| p.exists()));
    }
    dedupe(&mut out.pinned);
    dedupe(&mut out.read_only);
    out
}

/// The git dir a `.git` pointer file names (`gitdir: <path>`, relative to the
/// pointer's folder).
fn pointer_target(dot_git: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(dot_git).ok()?;
    let target = text.lines().find_map(|l| l.strip_prefix("gitdir:"))?.trim();
    if target.is_empty() {
        return None;
    }
    Some(dot_git.parent()?.join(target)) // an absolute target replaces the base
}

fn dedupe(paths: &mut Vec<PathBuf>) {
    let mut seen = std::collections::HashSet::new();
    paths.retain(|p| seen.insert(p.clone()));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn git(dir: &Path, args: &[&str]) {
        let ok = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        assert!(ok, "git {args:?} failed in {}", dir.display());
    }

    fn repo() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap().join("proj");
        fs::create_dir_all(&root).unwrap();
        git(&root, &["init", "-q"]);
        git(
            &root,
            &["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "i"],
        );
        (tmp, root)
    }

    #[test]
    fn a_plain_repo_pins_dot_git_and_guards_config_and_hooks() {
        let (_tmp, root) = repo();
        let g = guard_paths(std::slice::from_ref(&root), Some(&root.join("sub")));
        assert_eq!(g.pinned, vec![root.join(".git")]);
        assert!(g.read_only.contains(&root.join(".git").join("config")));
        assert!(g.read_only.contains(&root.join(".git").join("hooks")));
        // Absent files are never named: a mount would create them on the host.
        assert!(!g.read_only.contains(&root.join(".git").join("config.worktree")));
        assert!(!g.read_only.contains(&root.join(".git").join("commondir")));
    }

    #[test]
    fn an_app_worktree_guards_its_pointer_and_its_git_dir() {
        let (_tmp, root) = repo();
        let wt = root.join(WORKTREES_DIR[0]).join(WORKTREES_DIR[1]).join("feat");
        // Relative: git can't parse the `\\?\` verbatim root Windows canonicalizes to.
        let rel = format!("{}/{}/feat", WORKTREES_DIR[0], WORKTREES_DIR[1]);
        git(&root, &["worktree", "add", "-q", &rel, "-b", "feat"]);
        let g = guard_paths(std::slice::from_ref(&root), None);
        assert!(g.read_only.contains(&wt.join(".git")), "pointer file");
        let wt_git = root.join(".git").join("worktrees").join("feat");
        assert!(g.read_only.contains(&wt_git.join("commondir")), "{g:?}");
        assert!(g.read_only.contains(&root.join(".git").join("config")));
        assert_eq!(g.pinned, vec![root.join(".git")]);
    }

    #[test]
    fn a_hostile_pointer_is_pinned_and_its_target_guarded() {
        let (_tmp, root) = repo();
        fs::rename(root.join(".git"), root.join(".notgit")).unwrap();
        fs::write(root.join(".git"), "gitdir: .notgit\n").unwrap();
        let g = guard_paths(std::slice::from_ref(&root), Some(&root));
        assert!(g.read_only.contains(&root.join(".git")));
        assert!(g.read_only.contains(&root.join(".notgit").join("config")));
        assert!(g.read_only.contains(&root.join(".notgit").join("hooks")));
    }

    #[test]
    fn a_git_dir_outside_the_writable_roots_is_left_alone() {
        let (tmp, root) = repo();
        let project = root.join("sub");
        fs::create_dir_all(&project).unwrap();
        // The repo root is above the only writable root: already read-only.
        let g = guard_paths(std::slice::from_ref(&project), Some(&project));
        assert_eq!(g, GuardPaths::default());
        drop(tmp);
    }

    #[test]
    fn no_repo_names_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        assert_eq!(guard_paths(std::slice::from_ref(&root), Some(&root)), GuardPaths::default());
    }
}
