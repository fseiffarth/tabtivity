//! Bounded local git runs (#2349, threat-model gap 15).
//!
//! git reads a handful of files with a plain blocking `open()` + `read()`:
//! `.gitignore` (every one in the tree), `.gitattributes`, the git dir's
//! `info/exclude` and `info/attributes`, `config`, `HEAD`, `index`,
//! `packed-refs`. A named pipe at any of them makes `git status` (and `diff`,
//! `ls-files --exclude-standard`, `check-ignore`, `log --numstat`, …) block
//! forever (verified, git 2.53). A fenced agent can plant one in the project it
//! works in, and Tabtivity's background git (file-tree status, the switcher's
//! dirty poll, the usage recap, the phone's git overview and file browser,
//! lockstep) would then hang one thread per call, and any window command
//! waiting on it with them.
//!
//! Two layers:
//! - [`hazard`]: a cheap `stat` of the fixed-name files (the top-level
//!   `.gitignore`/`.gitattributes`, the git dir's and common dir's
//!   `info/exclude`, `info/attributes`, `config`, `HEAD`, `index`,
//!   `packed-refs`, `commondir`). A FIFO, socket or device there refuses the
//!   call before git runs (logged once per file). Nested `.gitignore`s can't
//!   all be checked cheaply; the timeout covers them.
//! - [`run`]/[`output`]: spawn in its own process group, read both streams on
//!   threads, and stop at a deadline — the whole child subtree is killed and
//!   the child reaped — answering a clear error, never a fake empty output.
//!
//! Timeouts never cut legitimate work: [`READ_TIMEOUT`] (2 min) for reads and
//! quick ref/metadata verbs, [`WRITE_TIMEOUT`] (10 min) for verbs that touch
//! the index or history (`add`, `commit`, `rm`, `blame`, …) and any verb not
//! listed, [`LONG_TIMEOUT`] (1 h) for transport, maintenance, verbs that write
//! the work tree (`checkout`, `reset`, `merge`, `worktree`, …: a smudge filter
//! may download every LFS object) and calls with the repo's hooks live (a
//! pre-commit hook may run a test suite).

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// Reads and quick ref/metadata verbs.
pub(crate) const READ_TIMEOUT: Duration = Duration::from_secs(120);
/// Index/history verbs (`add`, `commit`, …) and anything unlisted.
pub(crate) const WRITE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Transport, maintenance, and any call with the repo's hooks live.
pub(crate) const LONG_TIMEOUT: Duration = Duration::from_secs(60 * 60);

/// Verbs bounded by [`READ_TIMEOUT`].
const READ_VERBS: &[&str] = &[
    "status", "diff", "show", "log", "ls-files", "ls-tree", "check-ignore", "check-attr", "rev-parse",
    "rev-list", "remote", "symbolic-ref", "for-each-ref", "show-ref", "cat-file", "merge-base", "describe",
    "name-rev", "config", "branch", "tag", "var", "version", "update-ref", "hash-object", "diff-tree",
    "diff-index", "diff-files", "count-objects", "check-ref-format", "grep",
];

/// Verbs bounded by [`LONG_TIMEOUT`]: transport and maintenance, and the verbs
/// that write files into the work tree — they run the user's global smudge
/// filter (`git lfs install`), which downloads every LFS object they check out,
/// and a mutating verb stopped half-way leaves a half-updated tree and its
/// `index.lock` behind.
const LONG_VERBS: &[&str] = &[
    "fetch", "pull", "push", "clone", "ls-remote", "submodule", "bundle", "gc", "repack", "fsck", "prune",
    "maintenance", "lfs", "checkout", "switch", "restore", "reset", "merge", "rebase", "cherry-pick", "revert",
    "stash", "worktree", "am", "read-tree", "checkout-index", "sparse-checkout",
];

#[cfg(test)]
thread_local! {
    /// Test seam: caps every timeout on this thread.
    pub(crate) static TEST_TIMEOUT: std::cell::Cell<Option<Duration>> = const { std::cell::Cell::new(None) };
    /// Test seam: the pid of this thread's last spawned child.
    pub(crate) static LAST_PID: std::cell::Cell<Option<u32>> = const { std::cell::Cell::new(None) };
}

/// The subcommand in a git argument list: the first argument that is neither a
/// top-level option nor the value of one (`-c k=v`, `-C dir`, …).
pub(crate) fn verb<S: AsRef<std::ffi::OsStr>>(args: &[S]) -> Option<String> {
    let mut it = args.iter().map(|a| a.as_ref().to_string_lossy());
    while let Some(arg) = it.next() {
        match arg.as_ref() {
            "-c" | "-C" | "--git-dir" | "--work-tree" | "--namespace" | "--config-env" | "--super-prefix"
            | "--attr-source" => {
                it.next();
            }
            a if a.starts_with('-') => {}
            a => return Some(a.to_string()),
        }
    }
    None
}

/// The ceiling for `git <args>`. `hooks_live` lifts a work-tree verb to
/// [`LONG_TIMEOUT`] (a pre-commit hook may run a test suite); a read stays a
/// read.
pub(crate) fn timeout_for<S: AsRef<std::ffi::OsStr>>(args: &[S], hooks_live: bool) -> Duration {
    match verb(args).as_deref() {
        Some(v) if READ_VERBS.contains(&v) => READ_TIMEOUT,
        Some(v) if LONG_VERBS.contains(&v) => LONG_TIMEOUT,
        _ if hooks_live => LONG_TIMEOUT,
        _ => WRITE_TIMEOUT,
    }
}

/// [`timeout_for`] read off a built command: hooks count as live unless it
/// carries the hardened `core.hooksPath=` pin.
fn timeout_of(cmd: &Command) -> Duration {
    let args: Vec<&std::ffi::OsStr> = cmd.get_args().collect();
    let hooks_off = args.iter().any(|a| a.to_str() == Some("core.hooksPath="));
    timeout_for(&args, !hooks_off)
}

fn capped(timeout: Duration) -> Duration {
    #[cfg(test)]
    if let Some(cap) = TEST_TIMEOUT.with(|t| t.get()) {
        return timeout.min(cap);
    }
    timeout
}

// ── Pre-check ───────────────────────────────────────────────────────────────

/// Read a small control file (`.git` pointer, `commondir`) only if it is a
/// regular file: opened non-blocking, checked on the opened inode, at most
/// 64 KiB. `None` for a FIFO, device, folder, missing or unreadable file —
/// a plain `read_to_string` would block on a FIFO before git even ran.
pub(crate) fn read_small_regular(path: &Path) -> Option<String> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = options.open(path).ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut text = String::new();
    file.take(64 * 1024).read_to_string(&mut text).ok()?;
    Some(text)
}

/// Whether `path` (followed, as git follows it) is something git would block
/// or stall reading: a FIFO, socket or device. A link to `/dev/null` is fine.
#[cfg(unix)]
fn special(path: &Path) -> Option<&'static str> {
    use std::os::unix::fs::FileTypeExt;
    let kind = std::fs::metadata(path).ok()?.file_type();
    let what = if kind.is_fifo() {
        "a named pipe"
    } else if kind.is_socket() {
        "a socket"
    } else if kind.is_block_device() || kind.is_char_device() {
        "a device"
    } else {
        return None;
    };
    if std::fs::canonicalize(path).is_ok_and(|p| p == Path::new("/dev/null")) {
        return None;
    }
    Some(what)
}

#[cfg(not(unix))]
fn special(_path: &Path) -> Option<&'static str> {
    None
}

/// The work-tree top and git dir for `dir`, found the way git's discovery
/// does (nearest `.git` walking up, one `gitdir:` hop), without running git.
fn locate(dir: &Path) -> Option<(PathBuf, PathBuf)> {
    for top in dir.ancestors() {
        let dot_git = top.join(".git");
        let Ok(meta) = std::fs::metadata(&dot_git) else { continue };
        if meta.is_dir() {
            return Some((top.to_path_buf(), dot_git));
        }
        if meta.is_file() {
            let text = read_small_regular(&dot_git)?;
            let target = text.lines().find_map(|l| l.strip_prefix("gitdir:"))?.trim().to_string();
            return (!target.is_empty()).then(|| (top.to_path_buf(), top.join(target)));
        }
        return None;
    }
    None
}

/// Why git must not be run in `dir`: a fixed-name file it reads with a
/// blocking open is a FIFO, socket or device. `None` when nothing is wrong
/// (or there is no repo to check).
pub(crate) fn hazard(dir: &Path) -> Option<String> {
    let (top, git_dir) = locate(dir)?;
    let mut files = vec![top.join(".gitignore"), top.join(".gitattributes")];
    let mut dirs = vec![git_dir.clone()];
    let commondir = git_dir.join("commondir");
    if let Some(what) = special(&commondir) {
        return Some(refusal(&commondir, what));
    }
    if let Some(common) = read_small_regular(&commondir) {
        let common = common.trim();
        if !common.is_empty() {
            dirs.push(git_dir.join(common));
        }
    }
    for d in &dirs {
        for name in ["HEAD", "index", "config", "config.worktree", "packed-refs", "info/exclude", "info/attributes"]
        {
            files.push(d.join(name));
        }
    }
    files.iter().find_map(|f| special(f).map(|what| refusal(f, what)))
}

fn refusal(path: &Path, what: &str) -> String {
    format!(
        "git was not run: {} is {what}, and git would block reading it. Replace it with a regular file.",
        path.display()
    )
}

/// Log a refusal once per file, so a 12 s poll does not repeat it forever.
fn warn_once(why: &str) {
    static SEEN: std::sync::Mutex<Option<std::collections::HashSet<String>>> = std::sync::Mutex::new(None);
    let mut seen = SEEN.lock().unwrap_or_else(|e| e.into_inner());
    if seen.get_or_insert_with(Default::default).insert(why.to_string()) {
        eprintln!("[git] {why}");
    }
}

// ── Bounded run ─────────────────────────────────────────────────────────────

/// What [`run`] may add to a plain `output()`.
#[derive(Default)]
pub(crate) struct Opts {
    /// Bytes fed to stdin (from a thread); `None` = stdin is null.
    pub stdin: Option<Vec<u8>>,
    /// Stop reading stdout after this many bytes and stop git ([`Ran::cut`]).
    pub stdout_cap: Option<u64>,
    /// The ceiling; `None` = [`timeout_for`] the command's own arguments.
    pub timeout: Option<Duration>,
    /// Skip [`hazard`] (`init`, `clone`: no repo of their own yet).
    pub no_precheck: bool,
}

pub(crate) struct Ran {
    pub output: Output,
    /// stdout reached [`Opts::stdout_cap`] and git was stopped there.
    pub cut: bool,
}

/// `cmd.output()`, bounded: refused when [`hazard`] finds a blocking file,
/// and stopped (subtree killed, child reaped) at [`timeout_for`] its verb.
pub(crate) fn output(mut cmd: Command) -> Result<Output, String> {
    run(&mut cmd, Opts::default()).map(|r| r.output)
}

/// [`output`] with an explicit ceiling.
pub(crate) fn output_within(mut cmd: Command, timeout: Duration) -> Result<Output, String> {
    run(&mut cmd, Opts { timeout: Some(timeout), ..Opts::default() }).map(|r| r.output)
}

/// [`output`] as a method, for a builder chain:
/// `hardened_git_command_in(dir, &args).bounded_output()`.
pub(crate) trait BoundedOutput {
    fn bounded_output(&mut self) -> Result<Output, String>;
}

impl BoundedOutput for Command {
    fn bounded_output(&mut self) -> Result<Output, String> {
        run(self, Opts::default()).map(|r| r.output)
    }
}

/// Spawn `cmd`, feed and read it, and stop it at its deadline.
pub(crate) fn run(cmd: &mut Command, opts: Opts) -> Result<Ran, String> {
    let initializing = matches!(verb(&cmd.get_args().collect::<Vec<_>>()).as_deref(), Some("init" | "clone"));
    if !opts.no_precheck && !initializing {
        if let Some(why) = cmd.get_current_dir().and_then(hazard) {
            warn_once(&why);
            return Err(why);
        }
    }
    let timeout = capped(opts.timeout.unwrap_or_else(|| timeout_of(cmd)));
    let deadline = Instant::now() + timeout;
    cmd.stdin(if opts.stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    #[cfg(test)]
    LAST_PID.with(|p| p.set(Some(child.id())));
    let feeder = match (opts.stdin, child.stdin.take()) {
        (Some(bytes), Some(mut pipe)) => Some(std::thread::spawn(move || {
            let _ = pipe.write_all(&bytes);
        })),
        _ => None,
    };
    let (done_tx, done_rx) = mpsc::channel::<bool>();
    let stdout = child.stdout.take().map(|s| {
        let tx = done_tx.clone();
        let cap = opts.stdout_cap;
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let cut = match cap {
                Some(cap) => {
                    let _ = s.take(cap).read_to_end(&mut buf);
                    buf.len() as u64 >= cap
                }
                None => {
                    let mut s = s;
                    let _ = s.read_to_end(&mut buf);
                    false
                }
            };
            let _ = tx.send(cut);
            buf
        })
    });
    let stderr = child.stderr.take().map(|mut s| {
        let tx = done_tx.clone();
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = s.read_to_end(&mut buf);
            let _ = tx.send(false);
            buf
        })
    });
    drop(done_tx);

    // Both streams closing is (nearly always) git exiting; then the exit
    // itself, bounded too. A cut stdout stops git at once.
    let streams = usize::from(stdout.is_some()) + usize::from(stderr.is_some());
    let mut closed = 0;
    let mut cut = false;
    let mut timed_out = false;
    while closed < streams && !cut {
        match done_rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(was_cut) => {
                closed += 1;
                cut = was_cut;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                timed_out = true;
                break;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    let mut status = None;
    if !timed_out && !cut {
        let mut nap = Duration::from_millis(1);
        loop {
            match child.try_wait() {
                Ok(Some(s)) => {
                    status = Some(s);
                    break;
                }
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(nap);
                    nap = (nap * 2).min(Duration::from_millis(20));
                }
                Ok(None) => {
                    timed_out = true;
                    break;
                }
                Err(e) => {
                    stop(&mut child);
                    return Err(e.to_string());
                }
            }
        }
    }
    let status = match status {
        Some(s) => s,
        None => stop(&mut child),
    };
    if let Some(feeder) = feeder {
        let _ = feeder.join();
    }
    // Every process that held the pipes is dead now, unless one left the group
    // and the tree; give the readers a moment, never wait on them unbounded.
    let collect = |h: Option<std::thread::JoinHandle<Vec<u8>>>| -> Vec<u8> {
        let Some(h) = h else { return Vec::new() };
        let until = Instant::now() + Duration::from_secs(2);
        while !h.is_finished() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(5));
        }
        if h.is_finished() {
            h.join().unwrap_or_default()
        } else {
            Vec::new()
        }
    };
    let (stdout, stderr) = (collect(stdout), collect(stderr));
    if timed_out {
        let what = verb(&cmd.get_args().collect::<Vec<_>>()).unwrap_or_default();
        return Err(format!(
            "git {what} timed out after {} s and was stopped. A file it reads (an ignore or attributes \
             file, the index, a ref) may be a named pipe or device.",
            timeout.as_secs()
        ));
    }
    Ok(Ran { output: Output { status, stdout, stderr }, cut })
}

/// Kill the child's whole subtree and its process group, then reap it.
fn stop(child: &mut std::process::Child) -> std::process::ExitStatus {
    // Walk the tree before the leader dies (its children reparent then).
    crate::terminal::reap_child_subtree(child.id(), crate::terminal::ReapMode::Immediate);
    #[cfg(unix)]
    // SAFETY: no pointers; the group is the child's own (`process_group(0)`),
    // and a gone group returns ESRCH.
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.kill();
    match child.wait() {
        Ok(status) => status,
        // Already reaped elsewhere: report a failure status.
        Err(_) => failed_status(),
    }
}

#[cfg(unix)]
fn failed_status() -> std::process::ExitStatus {
    use std::os::unix::process::ExitStatusExt;
    std::process::ExitStatus::from_raw(1 << 8)
}

#[cfg(windows)]
fn failed_status() -> std::process::ExitStatus {
    use std::os::windows::process::ExitStatusExt;
    std::process::ExitStatus::from_raw(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git").args(args).current_dir(dir).output().expect("git");
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    fn repo() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        git(d, &["init", "-q"]);
        std::fs::write(d.join("a.txt"), "a\n").unwrap();
        std::fs::create_dir(d.join("sub")).unwrap();
        std::fs::write(d.join("sub/b.txt"), "b\n").unwrap();
        git(d, &["add", "."]);
        git(d, &["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "i"]);
        tmp
    }

    #[cfg(unix)]
    fn mkfifo(path: &Path) {
        let c = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
        // SAFETY: a valid NUL-terminated path.
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o644) }, 0, "mkfifo {}", path.display());
    }

    #[cfg(target_os = "linux")]
    fn gone(pid: u32) -> bool {
        !Path::new(&format!("/proc/{pid}")).exists()
    }

    #[test]
    fn verbs_and_ceilings() {
        assert_eq!(verb(&["-c", "core.hooksPath=", "-C", "x", "status"]).as_deref(), Some("status"));
        assert_eq!(verb(&["--no-pager", "log"]).as_deref(), Some("log"));
        assert_eq!(verb::<&str>(&[]), None);
        assert_eq!(timeout_for(&["status"], false), READ_TIMEOUT);
        assert_eq!(timeout_for(&["add", "-A"], false), WRITE_TIMEOUT);
        assert_eq!(timeout_for(&["checkout", "x"], false), LONG_TIMEOUT, "smudge filters (LFS) download");
        assert_eq!(timeout_for(&["worktree", "add", "p"], false), LONG_TIMEOUT);
        assert_eq!(timeout_for(&["frobnicate"], false), WRITE_TIMEOUT);
        assert_eq!(timeout_for(&["fetch"], false), LONG_TIMEOUT);
        assert_eq!(timeout_for(&["status"], true), READ_TIMEOUT);
        assert_eq!(timeout_for(&["commit"], true), LONG_TIMEOUT);
        let hardened = crate::commands::git::hardened_git_command_in(std::env::temp_dir(), &["status"]);
        assert_eq!(timeout_of(&hardened), READ_TIMEOUT);
        let hooked = crate::commands::git::hooked_git_command_in(std::env::temp_dir(), &["commit"]);
        assert_eq!(timeout_of(&hooked), LONG_TIMEOUT);
    }

    #[test]
    fn a_normal_repo_runs_as_before() {
        let tmp = repo();
        std::fs::write(tmp.path().join("new.txt"), "n").unwrap();
        assert_eq!(hazard(tmp.path()), None);
        let out = output(crate::commands::git::hardened_git_command_in(tmp.path(), &["status", "--porcelain"]))
            .expect("status");
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout), "?? new.txt\n");
        // stdin and a stdout cap.
        let ran = run(
            &mut crate::commands::git::hardened_git_command_in(tmp.path(), &["check-ignore", "-z", "--stdin"]),
            Opts { stdin: Some(b"./a.txt\0".to_vec()), ..Opts::default() },
        )
        .expect("check-ignore");
        assert_eq!(ran.output.status.code(), Some(1), "nothing ignored");
        let ran = run(
            &mut crate::commands::git::hardened_git_command_in(tmp.path(), &["ls-files", "-z"]),
            Opts { stdout_cap: Some(4), ..Opts::default() },
        )
        .expect("ls-files");
        assert!(ran.cut);
        assert_eq!(ran.output.stdout, b"a.tx");
    }

    #[cfg(unix)]
    #[test]
    fn a_fifo_exclude_or_top_level_ignore_is_refused_before_git_runs() {
        for name in [".git/info/exclude", ".gitignore", ".gitattributes", ".git/info/attributes"] {
            let tmp = repo();
            let path = tmp.path().join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            let _ = std::fs::remove_file(&path);
            mkfifo(&path);
            let started = Instant::now();
            let err = output(crate::commands::git::hardened_git_command_in(tmp.path(), &["status"]))
                .expect_err(name);
            assert!(err.contains("named pipe"), "{name}: {err}");
            assert!(started.elapsed() < Duration::from_secs(5), "{name}: took {:?}", started.elapsed());
            // Also from a subfolder, and through a link to the pipe.
            assert!(hazard(&tmp.path().join("sub")).is_some(), "{name} from sub");
        }
        let tmp = repo();
        std::os::unix::fs::symlink("/dev/null", tmp.path().join(".gitattributes")).unwrap();
        assert_eq!(hazard(tmp.path()), None, "a link to /dev/null is harmless");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_fifo_nested_ignore_times_out_and_the_child_is_reaped() {
        let tmp = repo();
        mkfifo(&tmp.path().join("sub/.gitignore"));
        assert_eq!(hazard(tmp.path()), None, "nested files are not pre-checked");
        TEST_TIMEOUT.with(|t| t.set(Some(Duration::from_millis(700))));
        let started = Instant::now();
        let err = output(crate::commands::git::hardened_git_command_in(tmp.path(), &["status", "--porcelain"]))
            .expect_err("a FIFO .gitignore must not hang");
        TEST_TIMEOUT.with(|t| t.set(None));
        assert!(err.contains("timed out"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(5), "took {:?}", started.elapsed());
        let pid = LAST_PID.with(|p| p.get()).expect("spawned");
        assert!(gone(pid), "git {pid} left behind (zombie or running)");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_grandchild_holding_the_pipes_is_killed_with_the_tree() {
        let marker = tempfile::tempdir().unwrap();
        let pidfile = marker.path().join("pid");
        let mut cmd = Command::new("sh");
        cmd.args(["-c", &format!("sleep 30 & echo $! > {}; wait", pidfile.display())]);
        let started = Instant::now();
        let err = output_within(cmd, Duration::from_millis(500)).expect_err("times out");
        assert!(err.contains("timed out"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(5));
        let sleeper: u32 = std::fs::read_to_string(&pidfile).unwrap().trim().parse().unwrap();
        let until = Instant::now() + Duration::from_secs(2);
        // The sleeper is reparented and reaped by init; give it a moment.
        while !gone(sleeper) && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(gone(sleeper), "the grandchild survived");
    }

    #[cfg(unix)]
    #[test]
    fn a_fifo_pointer_or_commondir_never_blocks_the_rust_side() {
        let tmp = tempfile::tempdir().unwrap();
        mkfifo(&tmp.path().join(".git"));
        // A FIFO `.git` is neither a folder nor a file: no repo, no read.
        assert_eq!(hazard(tmp.path()), None);
        let fifo = tmp.path().join("commondir");
        mkfifo(&fifo);
        assert_eq!(read_small_regular(&fifo), None);
    }
}
