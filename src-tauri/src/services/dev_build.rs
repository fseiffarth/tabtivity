//! What the background "Tabtivity (dev)" freeze is doing, read for the header's
//! dev-build chip (`header/DevBuildIndicator.tsx`).
//!
//! The build is `scripts/package-dev-auto.sh`'s, queued by the `post-commit`
//! hook (see `docs/context/dev_builds.md`). This module never starts one
//! itself; it asks the script to `--queue` a commit the hook could not queue
//! itself (`queue_if_behind`), to `--pause`/`--resume` when the user
//! clicks the chip's switch (`set_paused`), and to `--build-now` when they
//! click its "Build now" while paused (`build_now`). Otherwise it
//! reads the files that script already keeps for `--status`:
//! the lock directory and its pid, the pending marker, the installed-commit
//! stamp, the last failure, and the tail of the log, whose own lines say which
//! step a pass has reached.
//!
//! Only a binary built from a checkout knows where that checkout is:
//! `TABTIVITY_DEV_SOURCE_ROOT` is exported by `package-dev.sh` and the hot-reload
//! launcher and read at compile time, so a released Tabtivity (CI builds, the
//! AppImage) has no source root, reads nothing, and shows no chip.

use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

/// The checkout this binary was built from, or `None` for a release build.
pub const SOURCE_ROOT: Option<&str> = option_env!(crate::app_env!("DEV_SOURCE_ROOT"));

/// How much of the log's end is read. One pass writes ~25 KB (vite's asset
/// listing dominates), so this holds the running pass and the one before it,
/// whose duration is the estimate.
const LOG_TAIL_BYTES: u64 = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BuildState {
    /// No build process alive.
    Idle,
    /// The build process is alive but waiting for commits to settle
    /// (`TABTIVITY_DEV_BUILD_SETTLE`) before its next pass.
    Waiting,
    /// A pass is running.
    Building,
}

/// Which step of `package-dev.sh --head` the running pass has reached, from the
/// last marker line the log holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BuildPhase {
    /// Checking the commit out into the freeze tree.
    Prepare,
    /// `tsc && vite build`.
    Frontend,
    /// `npm run mobile:build`.
    Mobile,
    /// The release `cargo build`.
    Cargo,
    /// Checking and installing the finished binary.
    Install,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedBuild {
    pub commit: String,
    pub status: String,
    pub when: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevBuildStatus {
    pub state: BuildState,
    /// Set while `Building`.
    pub phase: Option<BuildPhase>,
    /// Short commit the running pass builds.
    pub commit: Option<String>,
    /// Epoch seconds the running pass started.
    pub started_at: Option<i64>,
    /// How long the last successful pass in the log took, in seconds — the
    /// chip's estimate. `None` when the log holds none.
    pub estimate_secs: Option<i64>,
    /// A commit landed that the running (or next) pass will build.
    pub queued: bool,
    /// The last pass that failed, until one succeeds.
    pub failed: Option<FailedBuild>,
    /// Short commit of the installed snapshot.
    pub installed: Option<String>,
    /// Commits on `HEAD` the installed snapshot does not have.
    pub behind: Option<u32>,
    /// This process is the frozen binary and a newer one has been installed
    /// over it since it started: a relaunch picks the new one up.
    pub relaunch: bool,
    /// Short commit of a finished snapshot in the tree that the launcher adopts
    /// on its next start (the install a fenced build could not do itself).
    pub adoptable: Option<String>,
    /// This process is the frozen binary and a relaunch would open something
    /// newer (`relaunch` or `adoptable`): the menu offers to do it.
    pub can_relaunch: bool,
    /// Auto-builds are paused (`package-dev-auto.sh --pause`): nothing queues
    /// until the user resumes.
    pub paused: bool,
    pub log_path: String,
}

/// What a log tail says about the passes in it. Pure; see [`parse_log`].
#[derive(Debug, Default, PartialEq)]
pub struct LogSummary {
    /// A pass that started and has not reported finishing: (start, commit, phase).
    pub open_pass: Option<(Option<i64>, String, BuildPhase)>,
    /// Duration of the last pass that finished with status 0.
    pub last_success_secs: Option<i64>,
}

/// Read the passes out of the tail of `package-dev-auto.log`.
///
/// The script's own lines (`<iso> building <root> @ <sha>`,
/// `<iso> pass N (<sha>) finished with status S`) bracket each pass; between
/// them, npm's and cargo's banners say which step is running.
pub fn parse_log(text: &str) -> LogSummary {
    let mut summary = LogSummary::default();
    let mut open: Option<(Option<i64>, String, BuildPhase)> = None;
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some((ts, rest)) = line.split_once(' ') {
            if let Some(commit) = rest.strip_prefix("building ").and_then(|r| r.rsplit_once(" @ ")) {
                open = Some((parse_iso8601(ts), commit.1.trim().to_string(), BuildPhase::Prepare));
                continue;
            }
            if rest.starts_with("pass ") && rest.contains(" finished with status ") {
                if let Some((start, _, phase)) = open.take() {
                    // Only a pass that got as far as installing is a build: one
                    // that found the tree unchanged takes no time and estimates
                    // nothing.
                    let ok = rest.trim_end().ends_with(" status 0") && phase == BuildPhase::Install;
                    if let (true, Some(start), Some(end)) = (ok, start, parse_iso8601(ts)) {
                        summary.last_success_secs = Some((end - start).max(0));
                    }
                }
                continue;
            }
        }
        let Some((_, _, phase)) = open.as_mut() else {
            continue;
        };
        // npm's banner, `> <package>@<version> <script>`; the line after it
        // (`> tsc && vite build && …`) is the script's body, not a banner.
        let script = trimmed
            .strip_prefix("> ")
            .and_then(|r| r.split_once(' '))
            .filter(|(package, _)| package.contains('@'))
            .map(|(_, script)| script.trim());
        if script == Some("build") {
            *phase = BuildPhase::Frontend;
        } else if script == Some("mobile:build") {
            *phase = BuildPhase::Mobile;
        } else if trimmed.starts_with("package-dev: published the phone bundle")
            || trimmed.starts_with("Compiling ")
        {
            *phase = BuildPhase::Cargo;
        } else if trimmed.starts_with("Finished `release`") {
            *phase = BuildPhase::Install;
        }
    }
    summary.open_pass = open;
    summary
}

/// Epoch seconds of `date -Is` output (`2026-09-18T15:26:39+02:00`), or `None`.
pub fn parse_iso8601(s: &str) -> Option<i64> {
    let s = s.trim();
    let (date, time) = s.split_once('T')?;
    let mut d = date.splitn(3, '-').map(|p| p.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    if !(1..=12).contains(&m) || !(1..=31).contains(&day) {
        return None;
    }
    let (clock, offset) = if let Some(clock) = time.strip_suffix('Z') {
        (clock, 0)
    } else {
        let at = time.rfind(['+', '-'])?;
        let (clock, off) = time.split_at(at);
        let sign = if off.starts_with('-') { -1 } else { 1 };
        let (oh, om) = off[1..].split_once(':').unwrap_or((&off[1..], "0"));
        (clock, sign * (oh.parse::<i64>().ok()? * 3600 + om.parse::<i64>().ok()? * 60))
    };
    let mut c = clock.splitn(3, ':').map(|p| p.parse::<i64>().ok());
    let (h, mi, sec) = (c.next()??, c.next()??, c.next()??);
    let days = crate::schema::calendar::days_from_civil(y as i32, m as u32, day as u32);
    Some(days * 86_400 + h * 3600 + mi * 60 + sec - offset)
}

/// Where the script keeps its files: fixed per user, like the binary it
/// installs, never the (sandboxable) state dir.
fn app_dir() -> PathBuf {
    crate::storage::home_share_dir()
}

fn read_trimmed(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

fn read_log_tail(path: &Path) -> String {
    let Ok(mut file) = fs::File::open(path) else {
        return String::new();
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let from = len.saturating_sub(LOG_TAIL_BYTES);
    if file.seek(SeekFrom::Start(from)).is_err() {
        return String::new();
    }
    let mut bytes = Vec::new();
    if file.read_to_end(&mut bytes).is_err() {
        return String::new();
    }
    let text = String::from_utf8_lossy(&bytes).into_owned();
    // A cut mid-line is not a line.
    match (from > 0, text.find('\n')) {
        (true, Some(at)) => text[at + 1..].to_string(),
        _ => text,
    }
}

/// Whether the build process holding the lock is alive. A lock left by a
/// crashed build (no such pid) is not a build.
fn lock_holder_alive(lock_dir: &Path) -> bool {
    let Some(pid) = read_trimmed(&lock_dir.join("pid")).and_then(|p| p.parse::<u32>().ok()) else {
        return false;
    };
    Path::new(&format!("/proc/{pid}")).exists()
}

fn commits_behind(root: &str, installed: &str) -> Option<u32> {
    let out = crate::paths::command_no_window("git")
        .args(["-C", root, "rev-list", "--count", &format!("{installed}..HEAD")])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

/// What this process runs as, from `/proc/self/exe`: (path, replaced). Linux
/// keeps the link pointing at the inode this process runs, and marks it
/// `(deleted)` once `install` has replaced the path.
fn own_exe() -> Option<(PathBuf, bool)> {
    let exe = fs::read_link("/proc/self/exe").ok()?;
    let exe = exe.to_string_lossy();
    Some(match exe.strip_suffix(" (deleted)") {
        Some(path) => (PathBuf::from(path), true),
        None => (PathBuf::from(exe.as_ref()), false),
    })
}

/// The short commit of a finished snapshot in the tree that
/// `start-tabtivity-dev-build.sh` would adopt: `target/release/tabtivity` newer than
/// the installed binary, with the `.frozen` record `package-dev.sh` writes only
/// after a verified build. A binary newer than its record is one cargo is still
/// linking, or one that failed the check — not a snapshot.
fn adoptable_snapshot(root: &str, installed: &Path) -> Option<String> {
    let built = Path::new(root).join("target/release").join(crate::brand::BIN_NAME);
    let record = Path::new(root).join("target/release").join(crate::brand::FROZEN_RECORD_NAME);
    let mtime = |p: &Path| fs::metadata(p).and_then(|m| m.modified()).ok();
    let built_at = mtime(&built)?;
    if mtime(installed).is_some_and(|at| at >= built_at) || mtime(&record)? < built_at {
        return None;
    }
    fs::read_to_string(&record)
        .ok()?
        .lines()
        .find_map(|l| l.strip_prefix("commit="))
        .map(|c| short(c.trim()))
}

fn short(sha: &str) -> String {
    sha.chars().take(7).collect()
}

/// The chip's reading, or `None` when this binary was not built from a checkout.
pub fn status() -> Option<DevBuildStatus> {
    let root = SOURCE_ROOT?;
    let dir = app_dir();
    let log_path = dir.join("package-dev-auto.log");
    let alive = lock_holder_alive(&dir.join("package-dev-auto.lock"));
    let summary = if alive {
        parse_log(&read_log_tail(&log_path))
    } else {
        LogSummary::default()
    };

    let (state, phase, commit, started_at) = match (alive, summary.open_pass) {
        (false, _) => (BuildState::Idle, None, None, None),
        (true, None) => (BuildState::Waiting, None, None, None),
        (true, Some((start, commit, phase))) => {
            (BuildState::Building, Some(phase), Some(commit), start)
        }
    };

    let failed = read_trimmed(&dir.join("package-dev-auto.failed")).map(|line| {
        let mut parts = line.splitn(3, ' ');
        FailedBuild {
            commit: parts.next().unwrap_or_default().to_string(),
            status: parts.next().unwrap_or_default().to_string(),
            when: parts.next().unwrap_or_default().to_string(),
        }
    });
    let stamp = read_trimmed(&dir.join("package-dev-auto.stamp"));
    let behind = stamp.as_deref().and_then(|sha| commits_behind(root, sha));
    let binary = dir.join(crate::brand::DEV_BIN_NAME);
    let (frozen, replaced) = match own_exe() {
        Some((exe, replaced)) if exe == binary => (true, replaced),
        _ => (false, false),
    };
    let adoptable = adoptable_snapshot(root, &binary);

    Some(DevBuildStatus {
        state,
        phase,
        commit,
        started_at,
        estimate_secs: summary.last_success_secs,
        queued: dir.join("package-dev-auto.pending").exists(),
        failed,
        installed: stamp.as_deref().map(short),
        behind,
        relaunch: replaced,
        can_relaunch: frozen && (replaced || adoptable.is_some()),
        adoptable,
        paused: dir.join(PAUSED_FILE).exists(),
        log_path: log_path.to_string_lossy().into_owned(),
    })
}

/// The script's pause mark (`package-dev-auto.sh --pause`).
const PAUSED_FILE: &str = "package-dev-auto.paused";

/// The HEAD this process last asked the script to freeze, so a HEAD the script
/// declined (`tabtivity.autoDevBuild false`) or already failed is asked for once,
/// not on every poll.
static LAST_QUEUED: Mutex<Option<String>> = Mutex::new(None);

/// Whether `head` still needs a freeze that nobody has queued: not the
/// installed snapshot, no build alive or pending to pick it up, not the commit
/// whose build just failed (`failed` is the script's short sha), and not
/// already asked for by this process.
pub fn needs_queue(
    head: &str,
    stamp: Option<&str>,
    failed: Option<&str>,
    busy: bool,
    last_queued: Option<&str>,
) -> bool {
    !busy
        && stamp != Some(head)
        && !failed.is_some_and(|f| !f.is_empty() && head.starts_with(f))
        && last_queued != Some(head)
}

/// Queue a freeze of HEAD when the `post-commit` hook could not. A commit made
/// in an agent tab runs the hook inside the agent fence, whose `$HOME` is the
/// agent's own: the script declines there (`TABTIVITY_AGENT_FENCE`), since what it
/// would lock, stamp and install is a throwaway copy and the real snapshot
/// never moved (2026-09-25: 27 commits behind). This process runs on the host,
/// so it asks instead, from the chip's poll. `SOURCE_ROOT` is this binary's
/// own checkout, fixed at compile time — never a project path — and the
/// script's own off switches still apply.
pub fn queue_if_behind() {
    let Some(root) = SOURCE_ROOT else { return };
    let Some(head) = head_sha(root) else { return };
    let dir = app_dir();
    // Checked before the memo below: a HEAD skipped while paused must still be
    // askable after a resume.
    if dir.join(PAUSED_FILE).exists() {
        return;
    }
    let stamp = read_trimmed(&dir.join("package-dev-auto.stamp"));
    let failed = read_trimmed(&dir.join("package-dev-auto.failed"))
        .and_then(|line| line.split(' ').next().map(str::to_string));
    let busy = lock_holder_alive(&dir.join("package-dev-auto.lock"))
        || dir.join("package-dev-auto.pending").exists();
    let mut last = LAST_QUEUED.lock().unwrap_or_else(|e| e.into_inner());
    if !needs_queue(&head, stamp.as_deref(), failed.as_deref(), busy, last.as_deref()) {
        return;
    }
    *last = Some(head);
    let script = Path::new(root).join("scripts/package-dev-auto.sh");
    if !script.is_file() {
        return;
    }
    // `--queue` detaches the build itself and returns at once.
    let _ = crate::paths::command_no_window(&script)
        .arg("--queue")
        .current_dir(root)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

/// Pause or resume auto-builds, from the chip's switch. Pausing also cancels a
/// running compile (the script's own loop sees the mark), since the point is
/// to hand the machine back; resuming queues HEAD if the snapshot is behind.
/// User-clicked only.
pub fn set_paused(paused: bool) -> Result<(), String> {
    run_script(if paused { "--pause" } else { "--resume" })?;
    if !paused {
        // The script queued what the pause skipped; forget any HEAD this
        // process asked for meanwhile so a later poll may ask again.
        *LAST_QUEUED.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
    Ok(())
}

/// Build HEAD once while auto-builds stay paused, from the chip's "Build now".
/// The script does nothing when the installed snapshot already is HEAD, and
/// detaches the build otherwise. User-clicked only.
pub fn build_now() -> Result<(), String> {
    run_script("--build-now")
}

/// Run `package-dev-auto.sh <arg>` in this binary's checkout and wait for it;
/// its stderr is the error.
fn run_script(arg: &str) -> Result<(), String> {
    let root = SOURCE_ROOT.ok_or("not a dev build")?;
    let script = Path::new(root).join("scripts/package-dev-auto.sh");
    if !script.is_file() {
        return Err(format!("{} is missing", script.display()));
    }
    let out = crate::paths::command_no_window(&script)
        .arg(arg)
        .current_dir(root)
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("{}: {e}", script.display()))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("{} exited with {}: {}", script.display(), out.status, err.trim()));
    }
    Ok(())
}

fn head_sha(root: &str) -> Option<String> {
    let out = crate::paths::command_no_window("git")
        .args(["-C", root, "rev-parse", "HEAD"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let sha = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!sha.is_empty()).then_some(sha)
}

/// Start the "Tabtivity (dev)" launcher once this process has exited, detached so
/// the quit's teardown does not take it along. The caller then closes the main
/// window, which runs the ordinary quit (layout flush, tmux reap,
/// `RunEvent::Exit`); the launcher refuses while this binary still runs, hence
/// the wait. A quit that never comes (cancelled, hung) lets the helper give up
/// after two minutes rather than open a second window some hours later.
pub fn spawn_relauncher() -> Result<(), String> {
    let root = SOURCE_ROOT.ok_or("not a dev build")?;
    let binary = app_dir().join(crate::brand::DEV_BIN_NAME);
    if !own_exe().is_some_and(|(exe, _)| exe == binary) {
        return Err(concat!("this window is not the frozen ", crate::app_name!(), " (dev) binary").into());
    }
    let launcher = Path::new(root).join(crate::brand::DEV_LAUNCHER_SCRIPT);
    if !launcher.is_file() {
        return Err(format!("{} is missing", launcher.display()));
    }
    let mut cmd = crate::paths::command_no_window("sh");
    cmd.args([
        "-c",
        r#"i=0; while kill -0 "$1" 2>/dev/null; do i=$((i+1)); [ "$i" -gt 600 ] && exit 0; sleep 0.2; done; exec "$2""#,
        concat!(crate::app_slug!(), "-relaunch"),
        &std::process::id().to_string(),
    ])
    .arg(&launcher)
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    // Not waited on: it outlives this process by design, and init reaps it.
    cmd.spawn().map(drop).map_err(|e| format!("could not start the relauncher: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queues_only_an_unclaimed_head() {
        let h = "c031c7ef4818714450a5d0d4fa7f088575d43ce5";
        assert!(needs_queue(h, Some("5bcd0392"), None, false, None));
        assert!(needs_queue(h, None, Some("5bcd039"), false, None));
        // Frozen already, a build alive or pending, failed at this very commit,
        // or asked for once: leave it.
        assert!(!needs_queue(h, Some(h), None, false, None));
        assert!(!needs_queue(h, Some("5bcd0392"), None, true, None));
        assert!(!needs_queue(h, Some("5bcd0392"), Some("c031c7ef"), false, None));
        assert!(!needs_queue(h, Some("5bcd0392"), None, false, Some(h)));
        // A malformed failure record blocks nothing.
        assert!(needs_queue(h, Some("5bcd0392"), Some(""), false, None));
    }

    #[test]
    fn iso8601_honours_the_offset() {
        assert_eq!(parse_iso8601("1970-01-01T00:00:00+00:00"), Some(0));
        assert_eq!(parse_iso8601("1970-01-01T02:00:00+02:00"), Some(0));
        assert_eq!(parse_iso8601("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso8601("1969-12-31T19:00:00-05:00"), Some(0));
        assert_eq!(parse_iso8601("2026-09-18T15:26:39+02:00"), Some(1_789_737_999));
        assert_eq!(parse_iso8601("garbage"), None);
        assert_eq!(parse_iso8601("2026-13-01T00:00:00Z"), None);
    }

    const PASS_OK: &str = concat!("\
=== PACKAGE:DEV (auto) 2026-09-18T14:40:00+02:00 ===
2026-09-18T14:40:30+02:00 building /r @ 47b2af1

> ", crate::app_slug!(), "@0.1.72 build
> tsc && vite build && npm run mobile:build
✓ built in 16.37s
> ", crate::app_slug!(), "@0.1.72 mobile:build
package-dev: published the phone bundle (47b2af1) to /r/target/mobile-pwa
   Compiling ", crate::app_slug!(), " v0.1.72 (/r/target/freeze-tree/src-tauri)
    Finished `release` profile [optimized] target(s) in 2m 14s
Installed frozen binary: /h/", crate::app_slug!(), "-dev (0.1.72 @ 47b2af1, from head)
2026-09-18T14:48:19+02:00 pass 1 (47b2af1) finished with status 0
");

    #[test]
    fn a_finished_pass_is_the_estimate_and_nothing_is_open() {
        let s = parse_log(PASS_OK);
        assert_eq!(s.open_pass, None);
        assert_eq!(s.last_success_secs, Some(7 * 60 + 49));
    }

    #[test]
    fn the_running_pass_reports_its_latest_step() {
        let mut log = PASS_OK.to_string();
        log.push_str("2026-09-18T15:26:39+02:00 building /r @ 30ed347\n");
        let s = parse_log(&log);
        assert_eq!(
            s.open_pass,
            Some((parse_iso8601("2026-09-18T15:26:39+02:00"), "30ed347".into(), BuildPhase::Prepare))
        );
        let step = |extra: &str| parse_log(&format!("{log}{extra}")).open_pass.map(|p| p.2);
        assert_eq!(
            step(concat!("> ", crate::app_slug!(), "@0.1.73 build\n> tsc && vite build && npm run mobile:build\n")),
            Some(BuildPhase::Frontend)
        );
        assert_eq!(step(concat!("> ", crate::app_slug!(), "@0.1.73 mobile:build\n")), Some(BuildPhase::Mobile));
        assert_eq!(
            step("package-dev: published the phone bundle (30ed347) to /x\n"),
            Some(BuildPhase::Cargo)
        );
        assert_eq!(
            step("    Finished `release` profile [optimized] target(s) in 7m 01s\n"),
            Some(BuildPhase::Install)
        );
        // The earlier pass still supplies the estimate.
        assert_eq!(parse_log(&log).last_success_secs, Some(469));
    }

    #[test]
    fn a_failed_pass_is_no_estimate() {
        let log = "\
2026-09-18T10:00:00+02:00 building /r @ aaa
2026-09-18T10:01:00+02:00 pass 1 (aaa) finished with status 1
";
        let s = parse_log(log);
        assert_eq!(s.open_pass, None);
        assert_eq!(s.last_success_secs, None);
    }

    #[test]
    fn an_unchanged_tree_is_no_estimate() {
        let log = "\
2026-09-18T10:00:00+02:00 building /r @ aaa
2026-09-18T10:00:00+02:00 tree unchanged since the installed snapshot (aaa) — nothing to build
2026-09-18T10:00:01+02:00 pass 1 (aaa) finished with status 0
";
        assert_eq!(parse_log(log).last_success_secs, None);
    }

    #[test]
    fn a_snapshot_is_adoptable_only_when_newer_and_recorded() {
        use std::time::{Duration, SystemTime};
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let release = dir.path().join("target/release");
        fs::create_dir_all(&release).unwrap();
        let installed = dir.path().join(crate::brand::DEV_BIN_NAME);
        let touch = |path: &Path, body: &str, age_secs: u64| {
            fs::write(path, body).unwrap();
            let file = fs::OpenOptions::new().write(true).open(path).unwrap();
            file.set_modified(SystemTime::now() - Duration::from_secs(age_secs)).unwrap();
        };
        let built = release.join(crate::app_slug!());
        let record = release.join(concat!(crate::app_slug!(), ".frozen"));

        // Nothing built.
        assert_eq!(adoptable_snapshot(root, &installed), None);

        // Built after the install, record written after the build.
        touch(&installed, "old", 300);
        touch(&built, "new", 200);
        touch(&record, "sha256=x\ncommit=30ed3471234\n", 100);
        assert_eq!(adoptable_snapshot(root, &installed), Some("30ed347".into()));

        // A binary newer than its record is still being linked.
        touch(&built, "newer", 50);
        assert_eq!(adoptable_snapshot(root, &installed), None);

        // Already installed.
        touch(&record, "commit=30ed347\n", 40);
        touch(&installed, "new", 10);
        assert_eq!(adoptable_snapshot(root, &installed), None);
    }
}
