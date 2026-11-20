//! Helpers for unit tests that must hold where CI runs them, not only on the
//! developer's Linux box: on a loaded runner (a stopwatch bound or a fixed
//! sleep there is a coin toss) and on macOS, whose temp dir is reached through
//! a symlink (`/var` → `/private/var`), so a path the OS reports back (a
//! watcher event, `/proc/<pid>/fd`, `canonicalize`, a process's cwd) is not
//! the path the test was given.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// How long a test waits for something that should happen soon. Generous on
/// purpose: it only bounds a failing run — a passing one returns as soon as
/// the condition holds.
pub(crate) const PATIENCE: Duration = Duration::from_secs(30);

/// Poll `cond` until it holds or `within` has passed; whether it held. Use
/// it instead of sleeping "long enough" and then asserting once.
pub(crate) fn wait_until(within: Duration, mut cond: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + within;
    let mut nap = Duration::from_millis(5);
    loop {
        if cond() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(nap);
        nap = (nap * 2).min(Duration::from_millis(100));
    }
}

/// A test that needs an external tool skips on a box without it, but fails
/// where the tool is promised: the Linux CI job sets `CI_REQUIRE_TOOLS` to a
/// comma list of tool keys (`tex,tmux,isoinfo,python3`), and a skip of a
/// listed key panics instead. Call it at the point of the would-be `return`,
/// then return: `test_util::skip_or_fail("tmux", "no tmux"); return;`.
pub(crate) fn skip_or_fail(tool: &str, why: &str) {
    if tool_required(std::env::var("CI_REQUIRE_TOOLS").ok().as_deref(), tool) {
        panic!("CI_REQUIRE_TOOLS names {tool}, so this test may not skip: {why}");
    }
    eprintln!("{why}: skipped");
}

fn tool_required(list: Option<&str>, tool: &str) -> bool {
    list.is_some_and(|list| list.split(',').any(|key| key.trim() == tool))
}

/// A fresh temp dir and a path to it through a symlink, as macOS's temp dir
/// always is: hand the test the link and see the code cope with the real path
/// coming back. Where symlinks cannot be made (Windows without the
/// privilege), the "link" is the real dir.
pub(crate) fn tempdir_via_symlink() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("tempdir");
    let real = dir.path().join("real");
    std::fs::create_dir(&real).expect("real dir");
    let link = dir.path().join("link");
    #[cfg(unix)]
    let linked = std::os::unix::fs::symlink(&real, &link).is_ok();
    #[cfg(windows)]
    let linked = std::os::windows::fs::symlink_dir(&real, &link).is_ok();
    (dir, if linked { link } else { real })
}

/// `git <args>` in `dir`, as a fixture runs it: the caller's own `GIT_*`
/// variables dropped (a git hook running the suite, a shell with `GIT_DIR`
/// exported), the user's global and system config unread, an identity and
/// `main` as the first branch pinned, signing and hooks off. The output
/// whatever the exit status; panics only when git cannot run.
pub(crate) fn git_output(dir: &Path, args: &[&str]) -> std::process::Output {
    let mut cmd = crate::paths::command_no_window("git");
    for name in crate::services::markup_rounds::FOREIGN_GIT_ENV {
        cmd.env_remove(name);
    }
    let null = if cfg!(windows) { "NUL" } else { "/dev/null" };
    cmd.args([
        "-c", "user.name=t",
        "-c", "user.email=t@example.invalid",
        "-c", "init.defaultBranch=main",
        "-c", "commit.gpgsign=false",
        "-c", "core.hooksPath=",
    ])
    .args(args)
    .current_dir(dir)
    .env("GIT_CONFIG_NOSYSTEM", "1")
    .env("GIT_CONFIG_GLOBAL", null)
    .output()
    .expect("git runs")
}

/// [`git_output`], which must succeed: the trimmed stdout. The one copy of
/// what every git fixture in the unit tests needs.
pub(crate) fn git(dir: &Path, args: &[&str]) -> String {
    let out = git_output(dir, args);
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// A repository in `dir` with an identity of its own in its config, for the
/// code under test that commits with the repo's config rather than `-c`.
pub(crate) fn init_repo(dir: &Path) {
    git(dir, &["init", "-q"]);
    git(dir, &["config", "user.email", "test@example.com"]);
    git(dir, &["config", "user.name", "Test User"]);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_pins_the_identity_and_first_branch_whatever_the_global_config_says() {
        let tmp = tempfile::tempdir().unwrap();
        git(tmp.path(), &["init", "-q"]);
        assert!(tmp.path().join(".git").is_dir());
        git(tmp.path(), &["commit", "-q", "--allow-empty", "-m", "one"]);
        assert_eq!(git(tmp.path(), &["log", "-1", "--format=%an <%ae>"]), "t <t@example.invalid>");
        assert_eq!(git(tmp.path(), &["symbolic-ref", "--short", "HEAD"]), "main");
    }

    #[test]
    fn wait_until_returns_once_the_condition_holds_or_gives_up() {
        let mut calls = 0;
        assert!(wait_until(PATIENCE, || {
            calls += 1;
            calls == 3
        }));
        assert_eq!(calls, 3);
        assert!(!wait_until(Duration::from_millis(20), || false));
    }

    #[test]
    fn only_a_listed_tool_may_not_skip() {
        assert!(tool_required(Some("tex, tmux"), "tmux"));
        assert!(tool_required(Some("tex,tmux"), "tex"));
        assert!(!tool_required(Some("tex,tmux"), "isoinfo"));
        assert!(!tool_required(Some(""), "tex"));
        assert!(!tool_required(None, "tex"));
    }

    #[test]
    fn the_symlinked_tempdir_reaches_a_real_dir() {
        let (_dir, link) = tempdir_via_symlink();
        std::fs::write(link.join("f"), "x").unwrap();
        let real = std::fs::canonicalize(&link).unwrap();
        assert_eq!(std::fs::read_to_string(real.join("f")).unwrap(), "x");
        #[cfg(unix)]
        assert_ne!(real, link, "reached through a link");
    }
}
