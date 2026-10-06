//! The default branch name for repositories **Tabtivity creates**, and the one
//! place that policy is written down.
//!
//! Git's own built-in default is still `master`, and it only changes when a
//! user has set `init.defaultBranch` — most have not. So every repo Tabtivity
//! created (project scaffold, scaffold repair, re-enabling git, the host repo a
//! remote import seeds) started on `master`, and publishing pushes `HEAD`:
//! `gh`/`glab` take the first branch they receive as the new repository's
//! default, so the hosted repo came out with `master` as its default branch —
//! against both providers' own default and everything else the project pushes
//! to.
//!
//! Two halves, because a fix to only the first would leave every project
//! created before it publishing `master` forever:
//!
//! - [`init_repo`] / [`INIT_SHELL`] create new repos on [`DEFAULT_BRANCH`].
//! - [`ensure_default_branch`] renames a *still-unpublished* `master` to `main`
//!   just before the publish that would otherwise fix the wrong name on the
//!   hosting side.
//!
//! Both are deliberately conservative: they touch a repo only while it has no
//! `main` of its own and its `master` has no upstream, so a repository that
//! genuinely uses `master` (a clone, a repo already pushed somewhere) is left
//! exactly as the user has it. Renaming is a ref move, never a history rewrite.
//!
//! The rename is also **local-project only**. A work-remote project's bytes
//! exist twice — the lockstep mirror and the host tree — and lockstep moves
//! branches by name: renaming one side's `master` would show up on the other as
//! a new branch beside the old one, which is a worse problem than a default
//! branch called `master`. Such a project publishes whatever branch it is on.
//!
//! `-b` on `git init` is 2.28+, so the shell forms fall back to a plain init
//! plus `symbolic-ref` — an unborn HEAD is just a file pointing at a branch
//! that does not exist yet, so pointing it elsewhere costs nothing.

use std::path::Path;
use std::process::Command;

/// The branch new Tabtivity repositories start on.
pub const DEFAULT_BRANCH: &str = "main";

/// `git init` for a remote shell: prefers `-b`, falls back for git < 2.28.
/// Used by the host-side init a remote import runs over ssh.
pub const INIT_SHELL: &str =
    "git init -b main >/dev/null 2>&1 || { git init && git symbolic-ref HEAD refs/heads/main; }";

fn git(dir: &Path) -> Command {
    let mut cmd = crate::paths::command_no_window("git");
    cmd.current_dir(dir);
    cmd
}

/// Run `git` in `dir` and report only whether it succeeded. Bounded
/// (`services::git_bounded`, #2349): Publish runs these on an existing repo,
/// whose `HEAD` or `config` may be a FIFO git would block on.
fn ok(dir: &Path, args: &[&str]) -> bool {
    use crate::services::git_bounded::BoundedOutput;
    git(dir)
        .args(args)
        .bounded_output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Trimmed stdout of a `git` command, or `None` when it failed.
fn out(dir: &Path, args: &[&str]) -> Option<String> {
    use crate::services::git_bounded::BoundedOutput;
    let o = git(dir).args(args).bounded_output().ok()?;
    if !o.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
}

/// `git init` in `dir` on [`DEFAULT_BRANCH`]. Returns the raw error text on
/// failure so callers can keep their existing (mostly best-effort) handling.
///
/// The `-c init.defaultBranch` covers git 2.28+; the `symbolic-ref` afterwards
/// covers older git *and* is a no-op when the first worked. Only ever touches
/// an unborn HEAD — an existing repo (this is called guarded by "no `.git`
/// yet", but a race or a nested repo could still land here) keeps its branch.
pub fn init_repo(dir: &Path) -> Result<(), String> {
    let init = git(dir)
        .args([
            "-c",
            &format!("init.defaultBranch={DEFAULT_BRANCH}"),
            "init",
        ])
        .output()
        .map_err(|e| format!("failed to run git init: {e}"))?;
    if !init.status.success() {
        return Err(String::from_utf8_lossy(&init.stderr).trim().to_string());
    }
    // Unborn HEAD only: `rev-parse HEAD` fails exactly while no commit exists.
    if !ok(dir, &["rev-parse", "--verify", "-q", "HEAD"]) {
        let _ = ok(
            dir,
            &[
                "symbolic-ref",
                "HEAD",
                &format!("refs/heads/{DEFAULT_BRANCH}"),
            ],
        );
    }
    Ok(())
}

/// Move a repo that is still sitting on `master` onto `main`, so the publish
/// that follows names the hosted default branch the way the rest of the project
/// does. Returns `true` when the branch was actually moved.
///
/// Declines — leaving the repo untouched — unless *all* of:
/// - HEAD is on `master` (a detached HEAD or any other branch is not ours),
/// - there is no `main` already (never merge two branches' names), and
/// - `master` has no upstream (it is published somewhere; renaming would
///   desync the user's own remote rather than fix a fresh one).
pub fn ensure_default_branch(dir: &Path) -> bool {
    if out(dir, &["symbolic-ref", "--quiet", "--short", "HEAD"]).as_deref() != Some("master") {
        return false;
    }
    if ok(dir, &["show-ref", "--verify", "--quiet", "refs/heads/main"]) {
        return false;
    }
    if ok(dir, &["rev-parse", "--verify", "-q", "master@{upstream}"]) {
        return false;
    }
    if ok(
        dir,
        &["show-ref", "--verify", "--quiet", "refs/heads/master"],
    ) {
        // Has commits: a real branch rename, which carries config and reflog.
        ok(dir, &["branch", "-m", "master", DEFAULT_BRANCH])
    } else {
        // Unborn: nothing to rename, just re-point HEAD.
        ok(
            dir,
            &[
                "symbolic-ref",
                "HEAD",
                &format!("refs/heads/{DEFAULT_BRANCH}"),
            ],
        )
    }
}

#[cfg(test)]
mod tests {
    use crate::brand::SLUG;
    use super::*;

    fn git_available() -> bool {
        crate::paths::command_no_window("git")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    fn head(dir: &Path) -> String {
        out(dir, &["symbolic-ref", "--quiet", "--short", "HEAD"]).unwrap_or_default()
    }

    fn commit(dir: &Path) {
        std::fs::write(dir.join("f.txt"), b"x").unwrap();
        assert!(ok(dir, &["add", "-A"]));
        assert!(ok(
            dir,
            &[
                "-c",
                "user.email=t@example.com",
                "-c",
                "user.name=T",
                "commit",
                "-m",
                "c",
            ]
        ));
    }

    /// A temp dir that cleans up after itself; no dev-dependency for one test.
    fn tmp(tag: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("{SLUG}-git-init-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_new_repo_starts_on_main() {
        if !git_available() {
            eprintln!("git not on PATH — skipping a_new_repo_starts_on_main");
            return;
        }
        let dir = tmp("new");
        init_repo(&dir).expect("init");
        assert_eq!(head(&dir), "main");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unpublished_master_is_renamed_before_publishing() {
        if !git_available() {
            eprintln!("git not on PATH — skipping an_unpublished_master_is_renamed…");
            return;
        }
        let dir = tmp("rename");
        assert!(ok(&dir, &["-c", "init.defaultBranch=master", "init"]));
        commit(&dir);
        assert_eq!(head(&dir), "master");
        assert!(ensure_default_branch(&dir));
        assert_eq!(head(&dir), "main");
        // The commit came along — a rename, not a fresh branch.
        assert!(ok(&dir, &["rev-parse", "--verify", "-q", "HEAD"]));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_repo_that_already_has_main_is_left_alone() {
        if !git_available() {
            eprintln!("git not on PATH — skipping a_repo_that_already_has_main…");
            return;
        }
        let dir = tmp("both");
        assert!(ok(&dir, &["-c", "init.defaultBranch=master", "init"]));
        commit(&dir);
        assert!(ok(&dir, &["branch", "main"]));
        assert!(!ensure_default_branch(&dir));
        assert_eq!(head(&dir), "master");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_branch_that_is_not_master_is_never_touched() {
        if !git_available() {
            eprintln!("git not on PATH — skipping a_branch_that_is_not_master…");
            return;
        }
        let dir = tmp("other");
        init_repo(&dir).expect("init");
        commit(&dir);
        assert!(ok(&dir, &["checkout", "-q", "-b", "develop"]));
        assert!(!ensure_default_branch(&dir));
        assert_eq!(head(&dir), "develop");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
