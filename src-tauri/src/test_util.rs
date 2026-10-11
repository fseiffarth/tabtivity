//! Helpers for unit tests that must hold where CI runs them, not only on the
//! developer's Linux box: on a loaded runner (a stopwatch bound or a fixed
//! sleep there is a coin toss) and on macOS, whose temp dir is reached through
//! a symlink (`/var` → `/private/var`), so a path the OS reports back (a
//! watcher event, `/proc/<pid>/fd`, `canonicalize`, a process's cwd) is not
//! the path the test was given.

use std::path::PathBuf;
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

mod tests {
    use super::*;

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
    fn the_symlinked_tempdir_reaches_a_real_dir() {
        let (_dir, link) = tempdir_via_symlink();
        std::fs::write(link.join("f"), "x").unwrap();
        let real = std::fs::canonicalize(&link).unwrap();
        assert_eq!(std::fs::read_to_string(real.join("f")).unwrap(), "x");
        #[cfg(unix)]
        assert_ne!(real, link, "reached through a link");
    }
}
