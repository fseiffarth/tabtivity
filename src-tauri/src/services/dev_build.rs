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
    crate::commands::apps::pid_alive(pid)
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

/// What this process runs as: (path, replaced). On Linux `current_exe` reads
/// `/proc/self/exe`, which keeps pointing at the inode this process runs and
/// is marked `(deleted)` once `install` has replaced the path. Elsewhere there
/// is no such mark, so a replaced binary is not detected (`false`).
fn own_exe() -> Option<(PathBuf, bool)> {
    let exe = std::env::current_exe().ok()?;
    #[cfg(target_os = "linux")]
    {
        let exe = exe.to_string_lossy();
        Some(match exe.strip_suffix(" (deleted)") {
            Some(path) => (PathBuf::from(path), true),
            None => (PathBuf::from(exe.as_ref()), false),
        })
    }
    #[cfg(not(target_os = "linux"))]
    {
        Some((exe, false))
    }
}

/// The list of builds `package-dev.sh` made on the host, one
/// `<sha256> <commit> <version> <built>` line each (`scripts/lib/dev-launcher.sh`).
/// The launcher adopts `target/release/<bin>` only when its hash is listed: the
/// tree is writable from every agent fence binding it, this folder from none
/// (threat recheck 2026-10-08, gap 20).
fn verified_list(app_dir: &Path) -> PathBuf {
    app_dir.join("dev-builds").join("verified")
}

/// Where the desktop entry's launcher lives once `package-dev.sh` has run on
/// the host: a copy of the checkout's, with every helper it sources, under
/// `<app_dir>/dev-launcher/`, so an uncommitted edit to the checkout's scripts
/// never runs unfenced on a relaunch. The checkout's own only while no copy
/// exists yet (a machine that has not frozen since this landed).
fn launcher_script(app_dir: &Path, root: &str) -> PathBuf {
    let copy = app_dir.join("dev-launcher").join(crate::brand::DEV_LAUNCHER_SCRIPT);
    if copy.is_file() {
        copy
    } else {
        Path::new(root).join(crate::brand::DEV_LAUNCHER_SCRIPT)
    }
}

/// The short commit of a finished snapshot in the tree that
/// `start-tabtivity-dev-build.sh` would adopt: `target/release/tabtivity` newer than
/// the installed binary, with the `.frozen` record `package-dev.sh` writes only
/// after a verified build, whose sha256 is also in the host's verified list
/// (`verified_list`). A binary newer than its record is one cargo is still
/// linking, or one that failed the check — not a snapshot. The binary itself
/// is not hashed on every poll: the launcher does that, and refuses a mismatch.
fn adoptable_snapshot(root: &str, installed: &Path, verified: &Path) -> Option<String> {
    let built = Path::new(root).join("target/release").join(crate::brand::BIN_NAME);
    let record = Path::new(root).join("target/release").join(crate::brand::FROZEN_RECORD_NAME);
    let mtime = |p: &Path| fs::metadata(p).and_then(|m| m.modified()).ok();
    let built_at = mtime(&built)?;
    if mtime(installed).is_some_and(|at| at >= built_at) || mtime(&record)? < built_at {
        return None;
    }
    let record = fs::read_to_string(&record).ok()?;
    let field = |key: &str| record.lines().find_map(|l| l.strip_prefix(key)).map(str::trim);
    let sha = field("sha256=").filter(|s| s.len() == 64)?;
    let listed = fs::read_to_string(verified)
        .ok()?
        .lines()
        .any(|line| line.split(' ').next() == Some(sha));
    if !listed {
        return None;
    }
    field("commit=").map(short)
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
    let adoptable = adoptable_snapshot(root, &binary, &verified_list(&dir));

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
    // The launcher and the wait below are POSIX sh, and the frozen dev build is
    // a Linux flow (`package-dev-auto.sh`): say so rather than fail on `sh`.
    if !cfg!(target_os = "linux") {
        return Err("dev relaunch is Linux-only".into());
    }
    let binary = app_dir().join(crate::brand::DEV_BIN_NAME);
    if !own_exe().is_some_and(|(exe, _)| exe == binary) {
        return Err(concat!("this window is not the frozen ", crate::app_name!(), " (dev) binary").into());
    }
    let launcher = launcher_script(&app_dir(), root);
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
        let app = tempfile::tempdir().unwrap();
        let verified = verified_list(app.path());
        let sha = "a".repeat(64);
        let recorded = format!("sha256={sha}\ncommit=30ed3471234\n");

        // Nothing built.
        assert_eq!(adoptable_snapshot(root, &installed, &verified), None);

        // Built after the install, record written after the build — but no
        // build on the host listed that hash (an agent's build, or a planted
        // file with a made-up record): not a snapshot the launcher adopts.
        touch(&installed, "old", 300);
        touch(&built, "new", 200);
        touch(&record, &recorded, 100);
        assert_eq!(adoptable_snapshot(root, &installed, &verified), None);
        fs::create_dir_all(verified.parent().unwrap()).unwrap();
        fs::write(&verified, format!("{} 1111111 0.1.0 x\n", "b".repeat(64))).unwrap();
        assert_eq!(adoptable_snapshot(root, &installed, &verified), None);

        // Listed: adoptable.
        fs::write(&verified, format!("{} 1111111 0.1.0 x\n{sha} 30ed347 0.1.1 y\n", "b".repeat(64))).unwrap();
        assert_eq!(adoptable_snapshot(root, &installed, &verified), Some("30ed347".into()));

        // A binary newer than its record is still being linked.
        touch(&built, "newer", 50);
        assert_eq!(adoptable_snapshot(root, &installed, &verified), None);

        // Already installed.
        touch(&record, &recorded, 40);
        touch(&installed, "new", 10);
        assert_eq!(adoptable_snapshot(root, &installed, &verified), None);
    }

    #[test]
    fn a_relaunch_runs_the_installed_launcher_copy_not_the_checkouts() {
        let app = tempfile::tempdir().unwrap();
        let root = "/checkout";
        // No copy yet (never frozen on the host since gap 20): the checkout's.
        assert_eq!(
            launcher_script(app.path(), root),
            Path::new(root).join(crate::brand::DEV_LAUNCHER_SCRIPT)
        );
        let copy = app.path().join("dev-launcher").join(crate::brand::DEV_LAUNCHER_SCRIPT);
        fs::create_dir_all(copy.parent().unwrap()).unwrap();
        fs::write(&copy, "#!/bin/sh\n").unwrap();
        assert_eq!(launcher_script(app.path(), root), copy);
    }
}

/// The dev launcher's trust rules (threat recheck 2026-10-08, gap 20), run as
/// shell against temp dirs, fake binaries and a stub `notify-send`: never the
/// real app, state dir or desktop entry. The launcher is a Linux-only flow.
#[cfg(all(test, target_os = "linux"))]
mod launcher_tests {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::time::{Duration, SystemTime};

    use crate::brand::{BIN_NAME, DEV_BIN_NAME, DEV_LAUNCHER_SCRIPT, ENV_PREFIX, LEGACY_ENV_PREFIX, STATE_DIR_NAME};

    fn repo() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
    }

    fn fence_vars() -> [String; 2] {
        [format!("{ENV_PREFIX}AGENT_FENCE"), format!("{LEGACY_ENV_PREFIX}AGENT_FENCE")]
    }

    /// `bash -c script` with the repo's brand.sh and dev-launcher.sh sourced,
    /// `$HOME` set to `home`, the fence variables removed and the stubs first
    /// on PATH. Returns (success, stdout + stderr).
    fn lib(home: &Path, script: &str, extra_env: &[(&str, &str)]) -> (bool, String) {
        let prelude = r#"set -eu
. "$REPO/scripts/lib/brand.sh"
. "$REPO/scripts/lib/dev-launcher.sh"
"#;
        let mut cmd = Command::new("bash");
        cmd.args(["-c", &format!("{prelude}{script}")])
            .env("REPO", repo())
            .env("HOME", home)
            .env("PATH", format!("{}:{}", home.join("stub-bin").display(), std::env::var("PATH").unwrap_or_default()));
        for var in fence_vars() {
            cmd.env_remove(var);
        }
        for (key, value) in extra_env {
            cmd.env(key, value);
        }
        let out = cmd.output().expect("bash runs");
        (
            out.status.success(),
            format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)),
        )
    }

    fn write_exec(path: &Path, body: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn age(path: &Path, secs: u64) {
        let file = fs::OpenOptions::new().write(true).open(path).unwrap();
        file.set_modified(SystemTime::now() - Duration::from_secs(secs)).unwrap();
    }

    fn sha256(path: &Path) -> String {
        let out = Command::new("sha256sum").arg(path).output().unwrap();
        String::from_utf8_lossy(&out.stdout).split(' ').next().unwrap().to_string()
    }

    struct Fixture {
        _dir: tempfile::TempDir,
        home: PathBuf,
        share: PathBuf,
        checkout: PathBuf,
        built: PathBuf,
        installed: PathBuf,
    }

    /// A home with an installed (old) dev binary, a checkout whose
    /// target/release holds a newer one, a checkout full of planted launcher
    /// scripts that would leave `$HOME/pwned`, and the launcher copy
    /// installed from this repo by `dev_launcher_install`.
    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let share = home.join(".local/share").join(STATE_DIR_NAME);
        let checkout = dir.path().join("checkout");
        let built = checkout.join("target/release").join(BIN_NAME);
        let installed = share.join(DEV_BIN_NAME);
        write_exec(&home.join("stub-bin/notify-send"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >>\"$HOME/notes\"\n");
        write_exec(&installed, "#!/bin/sh\necho old >\"$HOME/ran\"\n");
        write_exec(&built, "#!/bin/sh\necho new >\"$HOME/ran\"\n");
        age(&installed, 300);
        age(&built, 100);
        let planted = "#!/bin/sh\ntouch \"$HOME/pwned\"\nreturn 0 2>/dev/null || exit 0\n";
        for file in [
            DEV_LAUNCHER_SCRIPT.to_string(),
            "scripts/lib/brand.sh".into(),
            "scripts/lib/dev-launcher.sh".into(),
            "scripts/retain-dev-build.sh".into(),
        ] {
            write_exec(&checkout.join(file), planted);
        }
        let (ok, out) = lib(
            &home,
            r#"dev_launcher_install "$REPO" "$(dev_launcher_dir "$APP_SHARE_DIR")" "$CHECKOUT""#,
            &[("CHECKOUT", checkout.to_str().unwrap())],
        );
        assert!(ok, "install failed: {out}");
        Fixture { _dir: dir, home, share, checkout, built, installed }
    }

    impl Fixture {
        fn launch(&self) -> (bool, String) {
            let launcher = self.share.join("dev-launcher").join(DEV_LAUNCHER_SCRIPT);
            let mut cmd = Command::new(&launcher);
            cmd.env("HOME", &self.home).env(
                "PATH",
                format!("{}:{}", self.home.join("stub-bin").display(), std::env::var("PATH").unwrap_or_default()),
            );
            for var in fence_vars() {
                cmd.env_remove(var);
            }
            let out = cmd.output().expect("launcher runs");
            let log = fs::read_to_string(self.share.join(format!("{DEV_BIN_NAME}.log"))).unwrap_or_default();
            (out.status.success(), log)
        }

        fn ran(&self) -> String {
            fs::read_to_string(self.home.join("ran")).unwrap_or_default().trim().to_string()
        }

        fn notes(&self) -> String {
            fs::read_to_string(self.home.join("notes")).unwrap_or_default()
        }

        fn record(&self, sha: &str) {
            let (ok, out) = lib(
                &self.home,
                r#"dev_verified_add "$(dev_verified_list "$APP_SHARE_DIR")" "$SHA" 30ed347 0.1.99 2026-10-13T10:00:00+02:00"#,
                &[("SHA", sha)],
            );
            assert!(ok, "{out}");
        }
    }

    #[test]
    fn the_copy_holds_every_file_the_launcher_reads_and_names_the_checkout() {
        let f = fixture();
        let copy = f.share.join("dev-launcher");
        for file in [
            DEV_LAUNCHER_SCRIPT,
            "scripts/lib/brand.sh",
            "scripts/lib/dev-launcher.sh",
            "scripts/retain-dev-build.sh",
            "src-core/src/brand.rs",
            "src-tauri/Cargo.toml",
        ] {
            assert_eq!(fs::read(copy.join(file)).unwrap(), fs::read(repo().join(file)).unwrap(), "{file}");
            let mode = fs::metadata(copy.join(file)).unwrap().permissions().mode();
            assert_eq!(mode & 0o022, 0, "{file} is group/other-writable");
        }
        assert_eq!(fs::read_to_string(copy.join("source-root")).unwrap().trim(), f.checkout.to_str().unwrap());
        // The launcher's own source names no helper outside the copy.
        let launcher = fs::read_to_string(repo().join(DEV_LAUNCHER_SCRIPT)).unwrap();
        assert!(!launcher.contains("$ROOT/scripts"), "the launcher reaches into the checkout's scripts");
    }

    #[test]
    fn an_unlisted_build_in_the_tree_is_not_adopted_and_nothing_from_the_checkout_runs() {
        let f = fixture();
        // A record beside the binary claiming it is verified changes nothing.
        fs::write(
            f.built.with_file_name(crate::brand::FROZEN_RECORD_NAME),
            format!("sha256={}\ncommit=30ed347\nversion=0.1.99\n", sha256(&f.built)),
        )
        .unwrap();
        let (ok, log) = f.launch();
        assert!(ok, "{log}");
        assert_eq!(f.ran(), "old", "{log}");
        assert!(log.contains("not adopting it"), "{log}");
        assert!(f.notes().contains("no build outside an agent fence made it"), "{}", f.notes());
        assert!(fs::read_to_string(&f.installed).unwrap().contains("old"));
        assert!(!f.home.join("pwned").exists(), "a checkout script ran");
        let leftovers: Vec<_> = fs::read_dir(&f.share)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".adopt."))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn a_listed_build_is_adopted_with_the_lists_label() {
        let f = fixture();
        f.record(&sha256(&f.built));
        // A hostile record beside it is ignored: the label comes from the list.
        fs::write(
            f.built.with_file_name(crate::brand::FROZEN_RECORD_NAME),
            "commit=x|;e touch /nonexistent\nversion=--evil\n",
        )
        .unwrap();
        let desktop = f.home.join(".local/share/applications").join(format!("{}Dev.desktop", crate::brand::DISPLAY));
        fs::create_dir_all(desktop.parent().unwrap()).unwrap();
        fs::write(&desktop, "[Desktop Entry]\nComment=old\nExec=/x\n").unwrap();
        let (ok, log) = f.launch();
        assert!(ok, "{log}");
        assert_eq!(f.ran(), "new", "{log}");
        assert_eq!(fs::read(&f.installed).unwrap(), fs::read(&f.built).unwrap());
        let frozen = fs::read_to_string(f.installed.with_file_name(format!("{DEV_BIN_NAME}.frozen"))).unwrap();
        assert!(frozen.contains("commit=30ed347\n") && frozen.contains("version=0.1.99\n"), "{frozen}");
        assert!(fs::read_to_string(&desktop).unwrap().contains("Comment=Frozen build 0.1.99 @ 30ed347"));
        assert!(f.share.join("dev-builds").join(format!("{}-30ed347", crate::brand::SLUG)).is_file());
        assert!(!f.home.join("pwned").exists(), "a checkout script ran");
    }

    #[test]
    fn a_binary_swapped_after_listing_is_refused() {
        let f = fixture();
        f.record(&sha256(&f.built));
        write_exec(&f.built, "#!/bin/sh\necho planted >\"$HOME/ran\"\n");
        let (ok, log) = f.launch();
        assert!(ok, "{log}");
        assert_eq!(f.ran(), "old", "{log}");
    }

    #[test]
    fn the_list_is_trusted_only_when_private_and_sanitises_its_fields() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let list = home.join("verified");
        let sha = "c".repeat(64);
        let env = [("LIST", list.to_str().unwrap()), ("SHA", sha.as_str())];
        let (ok, out) = lib(home, r#"dev_verified_add "$LIST" "$SHA" 'ab1;rm -rf /|x' '0.1 $(id)' 'now`x`'; dev_verified_lookup "$LIST" "$SHA""#, &env);
        assert!(ok, "{out}");
        assert_eq!(out.trim(), "ab1rm-rfx 0.1id nowx");
        assert_eq!(fs::metadata(&list).unwrap().permissions().mode() & 0o077, 0);

        // Not a sha256: nothing recorded, nothing found.
        assert!(!lib(home, r#"dev_verified_add "$LIST" nope a b c"#, &env).0);
        assert!(!lib(home, r#"dev_verified_lookup "$LIST" "$(printf 'd%.0s' $(seq 64))""#, &env).0);

        // Group- or other-writable, or a link: not trusted.
        fs::set_permissions(&list, fs::Permissions::from_mode(0o620)).unwrap();
        assert!(!lib(home, r#"dev_verified_lookup "$LIST" "$SHA""#, &env).0);
        fs::set_permissions(&list, fs::Permissions::from_mode(0o602)).unwrap();
        assert!(!lib(home, r#"dev_verified_lookup "$LIST" "$SHA""#, &env).0);
        fs::set_permissions(&list, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(lib(home, r#"dev_verified_lookup "$LIST" "$SHA""#, &env).0);
        let link = home.join("link");
        std::os::unix::fs::symlink(&list, &link).unwrap();
        assert!(!lib(home, r#"dev_verified_lookup "$LINK" "$SHA""#, &[("LINK", link.to_str().unwrap()), ("SHA", sha.as_str())]).0);

        // The newest DEV_VERIFIED_KEEP are kept; re-recording moves a hash last.
        let (ok, out) = lib(
            home,
            r#"for i in $(seq 1 25); do dev_verified_add "$LIST" "$(printf '%064x' "$i")" "c$i" v t; done
dev_verified_add "$LIST" "$(printf '%064x' 10)" again v t
wc -l <"$LIST"; tail -n 1 "$LIST" | cut -d' ' -f2
dev_verified_lookup "$LIST" "$(printf '%064x' 5)" || echo gone"#,
            &env,
        );
        assert!(ok, "{out}");
        assert_eq!(out.split_whitespace().collect::<Vec<_>>(), ["20", "again", "gone"]);
    }

    #[test]
    fn only_a_host_session_writes_what_the_launcher_trusts() {
        let dir = repo();
        let dir = dir.to_str().unwrap();
        let home = tempfile::tempdir().unwrap();
        let script = r#"dev_on_host "$DIR" && echo host || echo fenced"#;
        let [current, legacy] = fence_vars();
        let fenced = lib(home.path(), script, &[("DIR", dir), (current.as_str(), "1")]).1;
        assert_eq!(fenced.trim(), "fenced");
        let fenced = lib(home.path(), script, &[("DIR", dir), (legacy.as_str(), "1")]).1;
        assert_eq!(fenced.trim(), "fenced");
        // package-dev.sh records and installs only under that check.
        let package_dev = fs::read_to_string(repo().join("scripts/package-dev.sh")).unwrap();
        let guard = package_dev.find("if dev_on_host \"$APP_DIR\"; then").expect("guarded");
        let add = package_dev.find("dev_verified_add").unwrap();
        let install = package_dev.find("dev_launcher_install").unwrap();
        assert!(guard < add && guard < install);
        assert!(package_dev.contains("Exec=$LAUNCHER") && package_dev.contains("LAUNCHER=\"$LAUNCHER_DIR/"));
    }

    #[test]
    fn the_desktop_entry_is_pointed_at_the_copy() {
        let dir = tempfile::tempdir().unwrap();
        let entry = dir.path().join("e.desktop");
        fs::write(&entry, "[Desktop Entry]\nName=x\nExec=/checkout/start.sh\nIcon=y\n").unwrap();
        let (ok, out) = lib(
            dir.path(),
            r#"dev_desktop_exec "$ENTRY" '/h/a b/dev-launcher/start.sh'; dev_desktop_exec "$ENTRY.missing" /x"#,
            &[("ENTRY", entry.to_str().unwrap())],
        );
        assert!(ok, "{out}");
        assert_eq!(
            fs::read_to_string(&entry).unwrap(),
            "[Desktop Entry]\nName=x\nExec=/h/a b/dev-launcher/start.sh\nIcon=y\n"
        );
        assert!(!dir.path().join("e.desktop.missing").exists());
    }
}
