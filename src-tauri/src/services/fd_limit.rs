//! This process's open-file budget: raised at launch, and checked before a
//! renderer is asked for.
//!
//! 2026-11-09: the desktop process died after two days with many agent tabs open.
//! It ran at the session's default soft limit of 1024 open files (the hard limit
//! was 524288). After a renderer-crash reload it was out of descriptors (`Too
//! many open files` from agent_auth/agent_global). The next crash's reload asked
//! WebKit for a new web process. `g_subprocess_launcher_spawnv` failed on the
//! descriptors and GLib's own assertion (`gsubprocess.c:421 success == (pid !=
//! 0)`) aborted the whole app. So:
//!
//! - [`raise_soft_limit`] lifts the soft limit to the hard one at launch, as
//!   node, Go and most browsers do for themselves. Children inherit it. A
//!   `select()`-based program breaks only once it holds over 1024 descriptors
//!   itself, and the agent CLIs already raise their own limit.
//! - [`spawn_headroom`] says whether enough descriptors are free to start a web
//!   process. Every Linux renderer reload (the crash hook, the memory
//!   watchdog's restart) asks it first. Without headroom the window keeps its dead page
//!   instead of taking every tab down with it.
//!
//! Unix only for the raise; the headroom count reads `/proc/self/fd` and so
//! answers only on Linux (elsewhere it always allows).

/// The highest soft limit asked for. Linux caps it at `fs.nr_open` anyway (1 Mi
/// by default); macOS refuses anything above `OPEN_MAX` with `EINVAL`, even
/// under an unlimited hard limit.
#[cfg(target_os = "macos")]
const SOFT_CAP: u64 = 10_240;
#[cfg(not(target_os = "macos"))]
const SOFT_CAP: u64 = 1 << 20;

/// Descriptors that must stay free for a web process to be started: its IPC
/// socket pair, the spawn's pipes, shared-memory handles for the first frames,
/// plus room for everything else running meanwhile.
pub const MIN_SPARE: u64 = 128;

/// The soft limit to set, or `None` when the current one already suffices.
pub fn target_soft(soft: u64, hard: u64) -> Option<u64> {
    let want = hard.min(SOFT_CAP);
    (want > soft).then_some(want)
}

/// Raise this process's open-file soft limit toward its hard limit. Returns
/// `(old, new)` when it changed. Best effort: a refusal leaves the limit
/// as it was.
#[cfg(unix)]
pub fn raise_soft_limit() -> Option<(u64, u64)> {
    let mut lim = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
    // SAFETY: plain syscalls on a stack struct this function owns.
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim) } != 0 {
        return None;
    }
    let (soft, hard) = (lim.rlim_cur, lim.rlim_max);
    let new = target_soft(soft, hard)?;
    lim.rlim_cur = new;
    // SAFETY: as above.
    if unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &lim) } != 0 {
        return None;
    }
    Some((soft, new))
}

#[cfg(not(unix))]
pub fn raise_soft_limit() -> Option<(u64, u64)> {
    None
}

/// Whether `open` of `limit` descriptors leaves [`MIN_SPARE`] free.
pub fn headroom_ok(open: u64, limit: u64) -> bool {
    limit.saturating_sub(open) >= MIN_SPARE
}

/// Descriptors open in this process and its soft limit, from `/proc`. `Err`
/// with the reason when the directory cannot even be opened. That is itself
/// the answer when the reason is `EMFILE`.
#[cfg(target_os = "linux")]
pub fn usage() -> std::io::Result<(u64, u64)> {
    let mut lim = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
    // SAFETY: plain syscall on a stack struct this function owns.
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    // The listing's own directory handle is one of the entries; not counted.
    let open = std::fs::read_dir("/proc/self/fd")?.count().saturating_sub(1) as u64;
    Ok((open, lim.rlim_cur))
}

/// `Ok` when a web process can be started; `Err` with a crash.log-ready reason
/// when the descriptors are (nearly) gone. Unreadable counts other than
/// `EMFILE`/`ENFILE` allow: the guard only refuses on evidence.
#[cfg(target_os = "linux")]
pub fn spawn_headroom() -> Result<(), String> {
    match usage() {
        Ok((open, limit)) if headroom_ok(open, limit) => Ok(()),
        Ok((open, limit)) => Err(format!("{open} of {limit} file descriptors open")),
        Err(e) if matches!(e.raw_os_error(), Some(libc::EMFILE | libc::ENFILE)) => {
            Err(format!("no file descriptor left ({e})"))
        }
        Err(_) => Ok(()),
    }
}

#[cfg(not(target_os = "linux"))]
pub fn spawn_headroom() -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_soft_limit_rises_to_the_hard_one() {
        assert_eq!(target_soft(1024, 524_288), Some(524_288.min(SOFT_CAP)));
    }

    #[test]
    fn a_limit_already_at_the_hard_one_is_left() {
        assert_eq!(target_soft(524_288, 524_288), None);
        assert_eq!(target_soft(4096, 1024), None);
    }

    #[test]
    fn an_unlimited_hard_limit_is_capped() {
        assert_eq!(target_soft(256, u64::MAX), Some(SOFT_CAP));
    }

    #[test]
    fn headroom_needs_min_spare_free() {
        assert!(headroom_ok(100, 1024));
        assert!(headroom_ok(1024 - MIN_SPARE, 1024));
        assert!(!headroom_ok(1024 - MIN_SPARE + 1, 1024));
        assert!(!headroom_ok(1024, 1024));
        assert!(!headroom_ok(2000, 1024));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn this_test_process_has_headroom() {
        let (open, limit) = usage().expect("/proc/self/fd");
        assert!(open > 0 && open < limit, "{open} of {limit}");
        assert!(spawn_headroom().is_ok());
    }
}
