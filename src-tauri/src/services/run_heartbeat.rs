//! The desktop process's heartbeat: when a run died, when nothing else can say.
//!
//! Since 2026-11-05 the frozen dev build's main process has died with nothing
//! in `crash.log` — no panic, no fatal-signal entry, no core — while its
//! children ran on: a SIGKILL to it alone, or a library's `_exit` past every
//! hook. No handler in the process sees either. So every run keeps
//! `<state_dir>/run-heartbeats/<pid>.json` fresh (every [`INTERVAL`]), marks
//! it when the quit teardown starts and removes it when the teardown ends;
//! the next launch reports every file whose process is gone. That run ended
//! uncleanly within one interval after its last beat, and the beat carries
//! the machine's load and free memory and the process's RSS and threads at
//! that moment. The launcher's `=== EXITED` line, when it ran the window,
//! says how (`start-tabtivity-dev-build.sh`).
//!
//! Pure over the state dir and an injected liveness check; the thread and the
//! process-wide record are [`start`], [`quitting`] and [`clear`].

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// How often a running process rewrites its beat: the resolution of the
/// death time the next launch reports.
pub const INTERVAL: Duration = Duration::from_secs(30);

const DIR: &str = "run-heartbeats";

/// One run's last sign of life.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Beat {
    pub pid: u32,
    /// `sysstat::process_start` at launch: with the pid it names this one
    /// process across pid reuse. `0` when the platform could not tell.
    pub start: u64,
    pub commit: String,
    pub started: String,
    pub last: String,
    /// `running`, or `quitting` once `RunEvent::Exit` began its teardown.
    pub phase: String,
    /// Load, free memory, RSS and threads at `last`; empty where unreadable.
    #[serde(default)]
    pub sample: String,
}

fn dir(state_dir: &Path) -> PathBuf {
    state_dir.join(DIR)
}

fn file(state_dir: &Path, pid: u32) -> PathBuf {
    dir(state_dir).join(format!("{pid}.json"))
}

/// Whether the run a beat describes is still alive, per `start_now` (the
/// platform's start-time reader, or a test's).
fn still_running(beat: &Beat, start_now: impl Fn(u32) -> Option<u64>) -> bool {
    match start_now(beat.pid) {
        Some(now) => beat.start == 0 || now == beat.start,
        None => false,
    }
}

/// Remove and return the beats of runs that are gone, skipping `own_pid` and
/// every run still alive (another instance on the same state). A file that
/// does not parse is removed and skipped: it can name no run.
pub fn take_dead(state_dir: &Path, own_pid: u32, start_now: impl Fn(u32) -> Option<u64>) -> Vec<Beat> {
    let Ok(entries) = std::fs::read_dir(dir(state_dir)) else {
        return Vec::new();
    };
    let mut dead = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let beat = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice::<Beat>(&b).ok());
        match beat {
            Some(beat) if beat.pid == own_pid || still_running(&beat, &start_now) => {}
            Some(beat) => {
                let _ = std::fs::remove_file(&path);
                dead.push(beat);
            }
            None => {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
    dead.sort_by(|a, b| (&a.started, a.pid).cmp(&(&b.started, b.pid)));
    dead
}

/// The crash.log entry for a run that ended without a clean quit.
pub fn report(beat: &Beat) -> String {
    let during = if beat.phase == "quitting" { " during its quit teardown" } else { "" };
    let sample = if beat.sample.is_empty() { String::new() } else { format!("; then: {}", beat.sample) };
    format!(
        "=== PREVIOUS RUN DIED{during} pid={} commit={} started={}: last heartbeat {} (died within {} s after it){sample} ===",
        beat.pid,
        beat.commit,
        beat.started,
        beat.last,
        INTERVAL.as_secs(),
    )
}

fn write(state_dir: &Path, beat: &Beat) -> std::io::Result<()> {
    std::fs::create_dir_all(dir(state_dir))?;
    let path = file(state_dir, beat.pid);
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(beat).map_err(std::io::Error::other)?)?;
    std::fs::rename(&tmp, &path)
}

/// Load, free memory, and this process's RSS and threads, from `/proc`.
#[cfg(target_os = "linux")]
fn sample() -> String {
    let load = std::fs::read_to_string("/proc/loadavg")
        .ok()
        .map(|s| s.split_whitespace().take(3).collect::<Vec<_>>().join(" "));
    let field = |text: &str, key: &str| {
        text.lines()
            .find_map(|l| l.strip_prefix(key))
            .and_then(|v| v.split_whitespace().next())
            .and_then(|v| v.parse::<u64>().ok())
    };
    let meminfo = std::fs::read_to_string("/proc/meminfo").unwrap_or_default();
    let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    let mut parts = Vec::new();
    if let Some(load) = load {
        parts.push(format!("load {load}"));
    }
    if let Some(kb) = field(&meminfo, "MemAvailable:") {
        parts.push(format!("mem available {} MB", kb / 1024));
    }
    if let Some(kb) = field(&status, "VmRSS:") {
        parts.push(format!("rss {} MB", kb / 1024));
    }
    if let Some(n) = crate::sysstat::parse_threads(&status) {
        parts.push(format!("threads {n}"));
    }
    match super::fd_limit::usage() {
        Ok((open, limit)) => parts.push(format!("fds {open}/{limit}")),
        Err(e) if e.raw_os_error() == Some(libc::EMFILE) => parts.push("fds exhausted".into()),
        Err(_) => {}
    }
    parts.join(", ")
}

#[cfg(not(target_os = "linux"))]
fn sample() -> String {
    String::new()
}

struct Live {
    state_dir: PathBuf,
    beat: Beat,
}

fn live() -> &'static Mutex<Option<Live>> {
    static LIVE: OnceLock<Mutex<Option<Live>>> = OnceLock::new();
    LIVE.get_or_init(|| Mutex::new(None))
}

/// Report the runs that died since, then keep this run's beat fresh on a
/// detached thread. Once per process, at launch; `log` appends to crash.log.
pub fn start(state_dir: PathBuf, commit: &str, log: fn(&str)) {
    let pid = std::process::id();
    for beat in take_dead(&state_dir, pid, crate::sysstat::process_start) {
        log(&report(&beat));
    }
    let now = crate::storage::iso_now();
    let beat = Beat {
        pid,
        start: crate::sysstat::process_start(pid).unwrap_or(0),
        commit: commit.to_string(),
        started: now.clone(),
        last: now,
        phase: "running".into(),
        sample: sample(),
    };
    let _ = write(&state_dir, &beat);
    *live().lock().unwrap_or_else(|p| p.into_inner()) = Some(Live { state_dir, beat });
    let _ = std::thread::Builder::new().name("run-heartbeat".into()).spawn(|| loop {
        std::thread::sleep(INTERVAL);
        let mut guard = live().lock().unwrap_or_else(|p| p.into_inner());
        let Some(live) = guard.as_mut() else { return };
        live.beat.last = crate::storage::iso_now();
        live.beat.sample = sample();
        let _ = write(&live.state_dir, &live.beat);
    });
}

/// The quit teardown has begun: a death from here on is reported as one
/// during the teardown.
pub fn quitting() {
    let mut guard = live().lock().unwrap_or_else(|p| p.into_inner());
    if let Some(live) = guard.as_mut() {
        live.beat.phase = "quitting".into();
        live.beat.last = crate::storage::iso_now();
        let _ = write(&live.state_dir, &live.beat);
    }
}

/// The run ended cleanly: its beat goes, and the thread stops beating.
pub fn clear() {
    if let Some(live) = live().lock().unwrap_or_else(|p| p.into_inner()).take() {
        let _ = std::fs::remove_file(file(&live.state_dir, live.beat.pid));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn beat(pid: u32, start: u64, phase: &str) -> Beat {
        Beat {
            pid,
            start,
            commit: "abc1234".into(),
            started: "2026-11-06T08:49:30+00:00".into(),
            last: "2026-11-06T10:01:00+00:00".into(),
            phase: phase.into(),
            sample: "load 70.1 80.2 71.0, mem available 22000 MB, rss 1800 MB, threads 140".into(),
        }
    }

    #[test]
    fn a_dead_run_is_reported_once_and_live_ones_are_kept() {
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path();
        write(state, &beat(10, 111, "running")).unwrap(); // gone
        write(state, &beat(20, 222, "running")).unwrap(); // pid reused by another process
        write(state, &beat(30, 333, "running")).unwrap(); // still alive
        write(state, &beat(40, 444, "running")).unwrap(); // ourselves
        let start_now = |pid: u32| match pid {
            20 => Some(999),
            30 => Some(333),
            40 => Some(444),
            _ => None,
        };
        let dead: Vec<u32> = take_dead(state, 40, start_now).iter().map(|b| b.pid).collect();
        assert_eq!(dead, vec![10, 20]);
        assert!(take_dead(state, 40, start_now).is_empty(), "reported once");
        assert!(file(state, 30).exists() && file(state, 40).exists());
    }

    #[test]
    fn an_unreadable_beat_is_dropped_silently() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(super::dir(dir.path())).unwrap();
        std::fs::write(file(dir.path(), 7), b"{not json").unwrap();
        assert!(take_dead(dir.path(), 1, |_| None).is_empty());
        assert!(!file(dir.path(), 7).exists());
    }

    #[test]
    fn the_report_names_the_time_window_and_the_teardown() {
        let running = report(&beat(10, 1, "running"));
        assert!(running.starts_with("=== PREVIOUS RUN DIED pid=10 commit=abc1234"), "{running}");
        assert!(running.contains("last heartbeat 2026-11-06T10:01:00+00:00 (died within 30 s after it)"));
        assert!(running.contains("load 70.1"));
        assert!(report(&beat(10, 1, "quitting")).starts_with("=== PREVIOUS RUN DIED during its quit teardown"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_sample_reads_proc() {
        let s = sample();
        assert!(s.contains("load ") && s.contains("rss ") && s.contains("threads "), "{s}");
    }
}
