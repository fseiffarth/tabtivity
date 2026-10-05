//! Bounds on the state dir's **unbounded** files — the ones nothing else owns.
//!
//! Everything Tabtivity writes outside a project tree is owned by the subsystem
//! that writes it, and that subsystem prunes it: `sandbox::sweep_orphans` takes
//! its containers, `browser_engine::sweep_quarantine` takes abandoned downloads,
//! `ssh_exec::sweep_stale_control_sockets` takes its own sockets. What is left
//! over is the handful of files that are *appended to forever* by a writer with
//! no natural moment to trim them — a crash log written from a signal handler,
//! and a cache the engine fills on our behalf and never bounds.
//!
//! The measured shape (2026-09-01, one developer machine, ~7 weeks of use): a
//! 3.3 GB state dir of which 869 MB was a dev log, 961 MB a WebKit disk cache
//! and 2.4 MB a crash log, all three still growing. Nothing here is about
//! reclaiming disk for its own sake — it is about the fact that an unbounded
//! file *has no failure mode until it has a bad one*, and finding out which is
//! the user's problem rather than ours.
//!
//! Two rules hold for everything in this module. **A trim keeps the tail**, not
//! the head: the recent end is the one a crash report needs, and truncating to
//! zero throws away the entries written seconds before the trim. And **every
//! failure is silent and skipped** — this is startup housekeeping, and a state
//! dir that could not be tidied must never be a reason the app does not open.

use std::path::Path;

/// Keep a crash log this large. Comfortably more than a session's worth of
/// `=== STARTED … ===` lines plus a few panics with backtraces, and small
/// enough that the whole file is still openable in an editor when someone is
/// actually reading it after a crash.
const CRASH_LOG_CAP: u64 = 4 * 1024 * 1024;

/// The WebKitGTK disk cache Tabtivity is allowed to keep between sessions.
///
/// The engine bounds this itself in theory and did not in practice (961 MB in
/// `WebKitCache/Version 17/Blobs` after seven weeks, still growing daily), and
/// there is no size knob reachable from here: `WebKitWebsiteDataManager` is
/// created by wry before any of our code runs, and Tauri exposes neither the
/// manager nor a cache-model setting. So the cap is enforced the only way left
/// — by deleting the directory *before the engine opens it*.
const WEBVIEW_CACHE_CAP: u64 = 512 * 1024 * 1024;

/// Truncate `path` to its last `cap` bytes if it is larger, keeping the tail.
///
/// The rewrite is deliberately **in place** rather than a write-then-rename: the
/// crash logger and the panic hook hold this path open in append mode, and a
/// rename would leave every later line going to an unlinked inode — i.e. the
/// next panic would be logged nowhere at all. `O_APPEND` writers resume at the
/// new end of a shortened file, so truncating under them is safe; swapping the
/// file out from under them is not.
fn cap_file_to_tail(path: &Path, cap: u64) -> std::io::Result<bool> {
    use std::io::{Read, Seek, SeekFrom, Write};

    let len = match std::fs::metadata(path) {
        Ok(m) => m.len(),
        Err(_) => return Ok(false),
    };
    if len <= cap {
        return Ok(false);
    }
    let mut f = std::fs::OpenOptions::new().read(true).write(true).open(path)?;
    f.seek(SeekFrom::Start(len - cap))?;
    let mut tail = Vec::with_capacity(cap as usize);
    f.read_to_end(&mut tail)?;
    // The seek landed mid-line. Drop the partial first line so the file still
    // parses as whole entries — a half `=== PANIC` header reads as corruption.
    if let Some(nl) = tail.iter().position(|b| *b == b'\n') {
        tail.drain(..=nl);
    }
    f.seek(SeekFrom::Start(0))?;
    f.write_all(&tail)?;
    let kept = tail.len() as u64;
    f.set_len(kept)?;
    Ok(true)
}

/// Cap `crash.log` at startup, before the crash logger appends this run's
/// `=== STARTED … ===` line.
///
/// One shot rather than a check per write: `lib::append_to_log` is also reached
/// from a signal handler, where a `stat` and a rewrite are neither
/// async-signal-safe nor affordable, and the log only ever grows by kilobytes
/// within one session anyway.
pub fn cap_crash_log() {
    let path = crate::storage::state_dir().join("crash.log");
    let _ = cap_file_to_tail(&path, CRASH_LOG_CAP);
}

/// Delete the webview's on-disk HTTP cache when it has grown past
/// [`WEBVIEW_CACHE_CAP`].
///
/// **Must be called before the webview is created** — it removes a directory
/// WebKit would otherwise have open, and the whole reason this is a delete
/// rather than a trim is that only the engine knows which of its 38k cache
/// records are still referenced by its index. Dropping the lot is coherent
/// (the next fetch repopulates it); dropping a subset is not.
///
/// `data_root` comes from [`webview_data_root`] — the caller passes the
/// identifier from the Tauri config rather than this module hardcoding it, so a
/// bundle rename cannot leave the sweep pointed at a directory nothing writes to
/// any more — this app's identifier has been renamed once already, and the data
/// directory under the old one sat untouched for months.
pub fn trim_webview_cache(data_root: &Path) {
    let cache = data_root.join("WebKitCache");
    let Some(size) = dir_size(&cache) else {
        return;
    };
    if size <= WEBVIEW_CACHE_CAP {
        return;
    }
    if std::fs::remove_dir_all(&cache).is_ok() {
        crate::crash_log_append(&format!(
            "=== webview cache trimmed: {} MB removed from {} ===",
            size / (1024 * 1024),
            cache.display()
        ));
    }
}

/// Where the webview keeps its per-app data, for `identifier`.
///
/// **Linux only, deliberately.** This exists to find one directory —
/// `WebKitCache` — and only WebKitGTK writes one: WebView2 and WKWebView bound
/// their own caches and keep them under their own layouts, so there is nothing
/// on the other two platforms for the caller to trim and guessing at their paths
/// would be inventing a cleanup target rather than fixing a measured one.
///
/// The layout is wry's: `$XDG_DATA_HOME/<identifier>`, falling back to
/// `~/.local/share` per the XDG base-directory spec — the same resolution
/// `storage::state_dir` does for Tabtivity's own state, minus the Tabtivity-specific
/// override (this directory belongs to the engine, and pointing a dev sandbox's
/// `TABTIVITY_STATE_DIR` at it would be pointing it at the wrong thing).
#[cfg(target_os = "linux")]
pub fn webview_data_root(identifier: &str) -> Option<std::path::PathBuf> {
    let base = match std::env::var("XDG_DATA_HOME") {
        Ok(dir) if !dir.is_empty() => std::path::PathBuf::from(dir),
        _ => crate::paths::home_dir().join(".local").join("share"),
    };
    Some(base.join(identifier))
}

#[cfg(not(target_os = "linux"))]
pub fn webview_data_root(_identifier: &str) -> Option<std::path::PathBuf> {
    None
}

/// Total size of the files under `dir`, or `None` if it does not exist.
///
/// Iterative rather than recursive: this walks a cache directory whose shape is
/// the engine's, not ours, and a deep tree must not be able to overflow the
/// stack during startup. Symlinks are counted but never followed — a link into
/// a huge tree elsewhere must not make the cache *look* over cap, and following
/// one would be the more interesting bug.
fn dir_size(dir: &Path) -> Option<u64> {
    let mut stack = vec![std::fs::read_dir(dir).ok()?];
    let mut total = 0u64;
    while let Some(rd) = stack.pop() {
        for entry in rd.flatten() {
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                if let Ok(rd) = std::fs::read_dir(entry.path()) {
                    stack.push(rd);
                }
            } else if let Ok(meta) = entry.metadata() {
                total = total.saturating_add(meta.len());
            }
        }
    }
    Some(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_under_the_cap_is_left_alone() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("crash.log");
        std::fs::write(&path, b"one\ntwo\n").expect("write");
        assert!(!cap_file_to_tail(&path, 1024).expect("cap"));
        assert_eq!(std::fs::read(&path).expect("read"), b"one\ntwo\n");
    }

    #[test]
    fn a_trim_keeps_the_tail_and_drops_the_partial_line() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("crash.log");
        // 10 lines of 10 bytes each.
        let body: String = (0..10).map(|i| format!("line-{i}xxx\n")).collect();
        std::fs::write(&path, &body).expect("write");
        assert!(cap_file_to_tail(&path, 35).expect("cap"));
        let kept = std::fs::read_to_string(&path).expect("read");
        // The 35-byte window starts mid-`line-6`, so that partial line goes and
        // the file begins at a whole entry.
        assert_eq!(kept, "line-7xxx\nline-8xxx\nline-9xxx\n");
    }

    #[test]
    fn an_appender_open_across_the_trim_keeps_writing_to_the_same_file() {
        use std::io::Write;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("crash.log");
        let body: String = (0..10).map(|i| format!("line-{i}xxx\n")).collect();
        std::fs::write(&path, &body).expect("write");
        // The crash logger's handle, opened before the trim and used after it.
        let mut appender = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("open");
        assert!(cap_file_to_tail(&path, 35).expect("cap"));
        appender.write_all(b"after\n").expect("append");
        let kept = std::fs::read_to_string(&path).expect("read");
        assert!(
            kept.ends_with("line-9xxx\nafter\n"),
            "post-trim append must land at the new end: {kept:?}"
        );
    }

    #[test]
    fn dir_size_sums_a_nested_tree_and_reports_a_missing_one() {
        let dir = tempfile::tempdir().expect("tempdir");
        let nested = dir.path().join("a").join("b");
        std::fs::create_dir_all(&nested).expect("mkdir");
        std::fs::write(dir.path().join("one"), b"1234").expect("write");
        std::fs::write(nested.join("two"), b"12345678").expect("write");
        assert_eq!(dir_size(dir.path()), Some(12));
        assert_eq!(dir_size(&dir.path().join("nope")), None);
    }

    #[test]
    fn a_cache_under_the_cap_survives() {
        let dir = tempfile::tempdir().expect("tempdir");
        let cache = dir.path().join("WebKitCache");
        std::fs::create_dir_all(&cache).expect("mkdir");
        std::fs::write(cache.join("record"), b"small").expect("write");
        trim_webview_cache(dir.path());
        assert!(cache.exists(), "a cache under the cap must not be deleted");
    }

    #[test]
    fn a_missing_cache_is_not_an_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        trim_webview_cache(dir.path());
        assert!(!dir.path().join("WebKitCache").exists());
    }
}
