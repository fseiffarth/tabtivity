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
//!   call before git runs (logged once per file). The repo-local and
//!   common-dir config is listed too, and the files its `core.excludesFile`,
//!   `core.attributesFile`, `mailmap.file` and `blame.ignoreRevsFile` name get
//!   the same check (the user's global values are left alone). Nested
//!   `.gitignore`s can't all be checked cheaply; the timeout covers them.
//! - [`run`]/[`output`]: spawn in its own process group, read both streams on
//!   threads (each capped: [`DEFAULT_STDOUT_CAP`], [`STDERR_CAP`]), and stop
//!   at a deadline — the whole child subtree is killed and
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
use app_core::sync::LockExt;
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

/// Test bound for "answered instead of hanging": far under [`READ_TIMEOUT`],
/// so it still tells a refusal or a stop at the test's own ceiling apart from
/// git running to the production one, and far over what the setup spawns
/// (config sanitizing, the common-dir pin) take on a loaded CI runner — a 5 s
/// bound failed there at 7 s.
#[cfg(all(test, unix))]
pub(crate) const NOT_A_HANG: Duration = Duration::from_secs(60);
#[cfg(all(test, unix))]
const _: () = assert!(NOT_A_HANG.as_secs() * 2 <= READ_TIMEOUT.as_secs());

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
    timeout_for_args(&args)
}

/// [`timeout_for`] a git argument list as built (`hardened_git_args` & co.):
/// hooks count as live unless it carries the `core.hooksPath=` pin.
pub(crate) fn timeout_for_args<S: AsRef<std::ffi::OsStr>>(args: &[S]) -> Duration {
    let hooks_off = args.iter().any(|a| a.as_ref().to_str() == Some("core.hooksPath="));
    timeout_for(args, !hooks_off)
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
    if let Some(why) = files.iter().find_map(|f| special(f).map(|what| refusal(f, what))) {
        return Some(why);
    }
    // The path-valued keys a repo's own config can set. The config files
    // above are regular now, so listing them cannot block.
    for d in &dirs {
        for name in ["config", "config.worktree"] {
            for value in config_path_values(&d.join(name)) {
                let candidates = if value.is_absolute() { vec![value] } else { vec![top.join(&value), dir.join(&value)] };
                if let Some(why) = candidates.iter().find_map(|f| special(f).map(|what| refusal(f, what))) {
                    return Some(why);
                }
            }
        }
    }
    None
}

/// Keys git reads as a file with a blocking open on a repo's behalf (gap 61).
const PATH_KEYS: &[&str] = &["core.excludesfile", "core.attributesfile", "mailmap.file", "blame.ignorerevsfile"];

/// The values of [`PATH_KEYS`] set in one config file, listed the way the
/// sanitizer lists it (`config --file`, no includes — the sanitizer has
/// stripped those), `~` expanded as git does. Empty for a missing file or one
/// git cannot parse. Cached per file until its mtime or size changes: the
/// switcher polls every few seconds.
fn config_path_values(config: &Path) -> Vec<PathBuf> {
    type Cache = std::collections::HashMap<PathBuf, ((Option<std::time::SystemTime>, u64), Vec<PathBuf>)>;
    static CACHE: std::sync::Mutex<Option<Cache>> = std::sync::Mutex::new(None);
    let Ok(meta) = std::fs::metadata(config) else { return Vec::new() };
    if !meta.is_file() {
        return Vec::new();
    }
    let stamp = (meta.modified().ok(), meta.len());
    if let Some((seen, values)) = CACHE.lock_ok().get_or_insert_with(Default::default).get(config) {
        if *seen == stamp {
            return values.clone();
        }
    }
    let values = list_path_values(config);
    let mut cache = CACHE.lock_ok();
    let cache = cache.get_or_insert_with(Default::default);
    if cache.len() > 256 {
        cache.clear();
    }
    cache.insert(config.to_path_buf(), (stamp, values.clone()));
    values
}

fn list_path_values(config: &Path) -> Vec<PathBuf> {
    let Some(path) = config.to_str() else { return Vec::new() };
    // Bare on purpose: `config --file` reads one file as plain config, no repo.
    let mut list = crate::paths::command_no_window("git");
    list.args(["config", "--file", path, "--list", "--no-includes", "-z"]);
    let Ok(out) = output_within(list, READ_TIMEOUT) else { return Vec::new() };
    if !out.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&out.stdout)
        .split('\0')
        .filter_map(|entry| entry.split_once('\n'))
        .filter(|(key, value)| PATH_KEYS.contains(&key.to_ascii_lowercase().as_str()) && !value.is_empty())
        .take(64)
        .map(|(_, value)| match value.strip_prefix("~/") {
            Some(rest) => crate::paths::home_dir().join(rest),
            None if value == "~" => crate::paths::home_dir(),
            None => PathBuf::from(value),
        })
        .collect()
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
    let mut seen = SEEN.lock_ok();
    if seen.get_or_insert_with(Default::default).insert(why.to_string()) {
        eprintln!("[git] {why}");
    }
}

// ── Bounded run ─────────────────────────────────────────────────────────────

/// stdout kept when [`Opts::stdout_cap`] is `None`: far over any listing,
/// diff or blob Tabtivity shows, and a bound on a child that writes forever.
pub(crate) const DEFAULT_STDOUT_CAP: u64 = 256 * 1024 * 1024;

/// stderr kept: its first and last halves. The rest is read and dropped, so
/// a chatty command is never stopped for it.
pub(crate) const STDERR_CAP: u64 = 4 * 1024 * 1024;

/// What [`run`] may add to a plain `output()`.
#[derive(Default)]
pub(crate) struct Opts {
    /// Bytes fed to stdin (from a thread); `None` = stdin is null.
    pub stdin: Option<Vec<u8>>,
    /// Stop reading stdout after this many bytes and stop git ([`Ran::cut`]);
    /// `None` = [`DEFAULT_STDOUT_CAP`].
    pub stdout_cap: Option<u64>,
    /// The ceiling; `None` = [`timeout_for`] the command's own arguments.
    pub timeout: Option<Duration>,
    /// Skip [`hazard`] (`init`, `clone`: no repo of their own yet).
    pub no_precheck: bool,
    /// Past [`Opts::stdout_cap`], keep stdout's first and last halves and
    /// drain the rest, as stderr always is, instead of stopping the child:
    /// for output only shown (a hook's log), never parsed. Never [`Ran::cut`].
    pub keep_stdout_ends: bool,
    /// At the deadline, answer what was captured so far ([`Ran::timed_out`])
    /// instead of [`RunError::TimedOut`]: for a log shown to the user (a stuck
    /// TeX build's output says where it stuck).
    pub keep_on_timeout: bool,
}

pub(crate) struct Ran {
    pub output: Output,
    /// stdout reached [`Opts::stdout_cap`] and git was stopped there.
    pub cut: bool,
    /// Stopped at its ceiling ([`Opts::keep_on_timeout`] only); `output`
    /// holds what it wrote until then.
    pub timed_out: bool,
}

/// Why [`run`] has no output to give.
#[derive(Debug)]
pub(crate) enum RunError {
    /// [`hazard`] found a blocking file; nothing ran.
    Refused(String),
    /// The program could not be started or waited on.
    Io(std::io::Error),
    /// Stopped at its ceiling.
    TimedOut(String),
}

impl std::fmt::Display for RunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Refused(why) | Self::TimedOut(why) => f.write_str(why),
            Self::Io(e) => write!(f, "{e}"),
        }
    }
}

impl From<RunError> for String {
    fn from(e: RunError) -> String {
        e.to_string()
    }
}

/// `cmd.output()`, bounded: refused when [`hazard`] finds a blocking file,
/// and stopped (subtree killed, child reaped) at [`timeout_for`] its verb.
pub(crate) fn output(mut cmd: Command) -> Result<Output, String> {
    whole(run(&mut cmd, Opts::default())?)
}

/// [`output`] with an explicit ceiling.
pub(crate) fn output_within(mut cmd: Command, timeout: Duration) -> Result<Output, String> {
    whole(run(&mut cmd, Opts { timeout: Some(timeout), ..Opts::default() })?)
}

/// [`output`] for git wrapped in another program — `ssh … 'cd … && git …'`
/// (`ssh_exec::run_git_remote`): the ceiling and the timeout's wording come
/// from `git_args`, the git argument list before it was wrapped, because
/// [`verb`] can't find the subcommand inside the wrapper's argv. No
/// [`hazard`] check: the repo is on the other end.
pub(crate) fn wrapped_output<S: AsRef<std::ffi::OsStr>>(mut cmd: Command, git_args: &[S]) -> Result<Output, String> {
    let timeout = timeout_for_args(git_args);
    match run(&mut cmd, Opts { timeout: Some(timeout), no_precheck: true, ..Opts::default() }) {
        Err(RunError::TimedOut(_)) => Err(format!(
            "git {} timed out after {} s and was stopped. The connection to the host may be stalled.",
            verb(git_args).unwrap_or_default(),
            capped(timeout).as_secs()
        )),
        ran => whole(ran?),
    }
}

/// [`output`] as a method, for a builder chain:
/// `hardened_git_command_in(dir, &args).bounded_output()`.
pub(crate) trait BoundedOutput {
    fn bounded_output(&mut self) -> Result<Output, String>;
}

impl BoundedOutput for Command {
    fn bounded_output(&mut self) -> Result<Output, String> {
        whole(run(self, Opts::default())?)
    }
}

/// A run at the default cap: a cut stdout is an error, never a short output
/// that reads as git's whole answer.
fn whole(ran: Ran) -> Result<Output, String> {
    if ran.cut {
        return Err(format!(
            "git wrote more than {} MiB and was stopped.",
            DEFAULT_STDOUT_CAP / (1024 * 1024)
        ));
    }
    Ok(ran.output)
}

/// The stdout bytes [`run`] keeps: [`Opts::stdout_cap`], else [`DEFAULT_STDOUT_CAP`].
fn stdout_cap(cap: Option<u64>) -> u64 {
    cap.unwrap_or(DEFAULT_STDOUT_CAP)
}

/// Read `s` to its end, keeping the first and last `cap / 2` bytes and a
/// marker for what was dropped between them.
fn read_head_and_tail(mut s: impl Read, cap: u64) -> Vec<u8> {
    let half = (cap / 2) as usize;
    let mut head = Vec::new();
    let mut tail = Vec::new();
    let mut dropped: u64 = 0;
    let mut chunk = [0u8; 8192];
    loop {
        let n = match s.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        let mut bytes = &chunk[..n];
        if head.len() < half {
            let take = bytes.len().min(half - head.len());
            head.extend_from_slice(&bytes[..take]);
            bytes = &bytes[take..];
        }
        tail.extend_from_slice(bytes);
        if tail.len() > 2 * half {
            let excess = tail.len() - half;
            dropped += excess as u64;
            tail.drain(..excess);
        }
    }
    if tail.len() > half {
        let excess = tail.len() - half;
        dropped += excess as u64;
        tail.drain(..excess);
    }
    if dropped > 0 {
        head.extend_from_slice(format!("\n[… {dropped} bytes cut …]\n").as_bytes());
    }
    head.extend_from_slice(&tail);
    head
}

/// Spawn `cmd`, feed and read it, and stop it at its deadline.
pub(crate) fn run(cmd: &mut Command, opts: Opts) -> Result<Ran, RunError> {
    let initializing = matches!(verb(&cmd.get_args().collect::<Vec<_>>()).as_deref(), Some("init" | "clone"));
    if !opts.no_precheck && !initializing {
        if let Some(why) = cmd.get_current_dir().and_then(hazard) {
            warn_once(&why);
            return Err(RunError::Refused(why));
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
    let mut child = cmd.spawn().map_err(RunError::Io)?;
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
        let cap = stdout_cap(opts.stdout_cap);
        let keep_ends = opts.keep_stdout_ends;
        std::thread::spawn(move || {
            if keep_ends {
                let buf = read_head_and_tail(s, cap);
                let _ = tx.send(false);
                return buf;
            }
            let mut buf = Vec::new();
            let _ = s.take(cap).read_to_end(&mut buf);
            let _ = tx.send(buf.len() as u64 >= cap);
            buf
        })
    });
    let stderr = child.stderr.take().map(|s| {
        let tx = done_tx.clone();
        std::thread::spawn(move || {
            let buf = read_head_and_tail(s, STDERR_CAP);
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
                    return Err(RunError::Io(e));
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
    if timed_out && opts.keep_on_timeout {
        return Ok(Ran { output: Output { status, stdout, stderr }, cut, timed_out });
    }
    if timed_out {
        let what = verb(&cmd.get_args().collect::<Vec<_>>()).unwrap_or_default();
        return Err(RunError::TimedOut(format!(
            "git {what} timed out after {} s and was stopped. A file it reads (an ignore or attributes \
             file, the index, a ref) may be a named pipe or device.",
            timeout.as_secs()
        )));
    }
    Ok(Ran { output: Output { status, stdout, stderr }, cut, timed_out: false })
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
    use crate::test_util::git;

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

    /// A git call wrapped in ssh is stopped at its git verb's ceiling and
    /// says which git verb it was — not the wrapper's first argument.
    #[cfg(unix)]
    #[test]
    fn a_wrapped_git_call_is_stopped_and_named_by_its_git_verb() {
        TEST_TIMEOUT.with(|t| t.set(Some(Duration::from_millis(300))));
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "sleep 30"]);
        let started = Instant::now();
        let err = wrapped_output(cmd, &["-c", "core.hooksPath=", "status"]).expect_err("times out");
        TEST_TIMEOUT.with(|t| t.set(None));
        assert!(err.starts_with("git status timed out"), "{err}");
        assert!(started.elapsed() < NOT_A_HANG, "took {:?}", started.elapsed());

        let mut ok = Command::new("sh");
        ok.args(["-c", "printf done"]);
        assert_eq!(wrapped_output(ok, &["status"]).expect("ran").stdout, b"done");
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
        assert_eq!(timeout_for_args(&["-c", "core.hooksPath=", "commit"]), WRITE_TIMEOUT);
        assert_eq!(timeout_for_args(&["commit"]), LONG_TIMEOUT, "no pin: hooks live");
        let hardened = crate::services::git_hardened::hardened_git_command_in(std::env::temp_dir(), &["status"]);
        assert_eq!(timeout_of(&hardened), READ_TIMEOUT);
        let hooked = crate::services::git_hardened::hooked_git_command_in(std::env::temp_dir(), &["commit"]);
        assert_eq!(timeout_of(&hooked), LONG_TIMEOUT);
    }

    #[test]
    fn a_normal_repo_runs_as_before() {
        let tmp = repo();
        std::fs::write(tmp.path().join("new.txt"), "n").unwrap();
        assert_eq!(hazard(tmp.path()), None);
        let out = output(crate::services::git_hardened::hardened_git_command_in(tmp.path(), &["status", "--porcelain"]))
            .expect("status");
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout), "?? new.txt\n");
        // stdin and a stdout cap.
        let ran = run(
            &mut crate::services::git_hardened::hardened_git_command_in(tmp.path(), &["check-ignore", "-z", "--stdin"]),
            Opts { stdin: Some(b"./a.txt\0".to_vec()), ..Opts::default() },
        )
        .expect("check-ignore");
        assert_eq!(ran.output.status.code(), Some(1), "nothing ignored");
        let ran = run(
            &mut crate::services::git_hardened::hardened_git_command_in(tmp.path(), &["ls-files", "-z"]),
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
            let err = output(crate::services::git_hardened::hardened_git_command_in(tmp.path(), &["status"]))
                .expect_err(name);
            assert!(err.contains("named pipe"), "{name}: {err}");
            assert!(started.elapsed() < NOT_A_HANG, "{name}: took {:?}", started.elapsed());
            // Also from a subfolder, and through a link to the pipe.
            assert!(hazard(&tmp.path().join("sub")).is_some(), "{name} from sub");
        }
        let tmp = repo();
        std::os::unix::fs::symlink("/dev/null", tmp.path().join(".gitattributes")).unwrap();
        assert_eq!(hazard(tmp.path()), None, "a link to /dev/null is harmless");
    }

    #[cfg(unix)]
    #[test]
    fn a_fifo_named_by_a_path_valued_config_key_is_refused() {
        let cases = [
            ("core.excludesFile", "pipe"),
            ("core.attributesFile", "pipe"),
            ("mailmap.file", "pipe"),
            ("blame.ignoreRevsFile", "pipe"),
            ("core.excludesFile", "sub/../pipe"),
        ];
        for (key, value) in cases {
            let tmp = repo();
            mkfifo(&tmp.path().join("pipe"));
            assert_eq!(hazard(tmp.path()), None, "an unnamed pipe is harmless");
            git(tmp.path(), &["config", "--local", key, value]);
            let started = Instant::now();
            let err = output(crate::services::git_hardened::hardened_git_command_in(tmp.path(), &["status"]))
                .expect_err(key);
            assert!(err.contains("named pipe"), "{key}: {err}");
            assert!(started.elapsed() < NOT_A_HANG, "{key}: took {:?}", started.elapsed());
            assert!(hazard(&tmp.path().join("sub")).is_some(), "{key} from sub");
            // Absolute, too; and once the value is changed the cache lets go.
            let abs = tmp.path().join("pipe");
            git(tmp.path(), &["config", "--local", key, abs.to_str().unwrap()]);
            assert!(hazard(tmp.path()).is_some(), "{key} absolute");
            git(tmp.path(), &["config", "--local", key, "regular-file"]);
            assert_eq!(hazard(tmp.path()), None, "{key} repointed");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_fifo_named_by_the_common_dir_config_or_a_worktree_config_is_refused() {
        let tmp = repo();
        let wt = tempfile::tempdir().unwrap();
        let wt_path = wt.path().join("wt");
        git(tmp.path(), &["worktree", "add", "-q", "-b", "other", wt_path.to_str().unwrap()]);
        let fifo = tmp.path().join("pipe");
        mkfifo(&fifo);
        assert_eq!(hazard(&wt_path), None);
        git(tmp.path(), &["config", "--local", "core.excludesFile", fifo.to_str().unwrap()]);
        assert!(hazard(&wt_path).is_some_and(|w| w.contains("named pipe")), "common-dir config, from a linked worktree");
        git(tmp.path(), &["config", "--local", "--unset", "core.excludesFile"]);
        assert_eq!(hazard(&wt_path), None);
        git(tmp.path(), &["config", "--local", "extensions.worktreeConfig", "true"]);
        git(&wt_path, &["config", "--worktree", "mailmap.file", fifo.to_str().unwrap()]);
        assert!(hazard(&wt_path).is_some_and(|w| w.contains("named pipe")), "config.worktree");
    }

    #[cfg(unix)]
    #[test]
    fn a_global_path_valued_key_is_left_alone() {
        let tmp = repo();
        let home = tempfile::tempdir().unwrap();
        mkfifo(&home.path().join("pipe"));
        let global = home.path().join("gitconfig");
        std::fs::write(&global, format!("[core]\n\texcludesFile = {}\n", home.path().join("pipe").display())).unwrap();
        assert_eq!(hazard(tmp.path()), None);
        // Nothing but the repo's own files are listed.
        assert_eq!(config_path_values(&global).len(), 1, "the parse itself sees it");
        assert_eq!(hazard(tmp.path()), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_fifo_nested_ignore_times_out_and_the_child_is_reaped() {
        let tmp = repo();
        mkfifo(&tmp.path().join("sub/.gitignore"));
        assert_eq!(hazard(tmp.path()), None, "nested files are not pre-checked");
        TEST_TIMEOUT.with(|t| t.set(Some(Duration::from_millis(700))));
        let started = Instant::now();
        let err = output(crate::services::git_hardened::hardened_git_command_in(tmp.path(), &["status", "--porcelain"]))
            .expect_err("a FIFO .gitignore must not hang");
        TEST_TIMEOUT.with(|t| t.set(None));
        assert!(err.contains("timed out"), "{err}");
        assert!(started.elapsed() < NOT_A_HANG, "took {:?}", started.elapsed());
        let pid = LAST_PID.with(|p| p.get()).expect("spawned");
        assert!(gone(pid), "git {pid} left behind (zombie or running)");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_grandchild_holding_the_pipes_is_killed_with_the_tree() {
        let marker = tempfile::tempdir().unwrap();
        let pidfile = marker.path().join("pid");
        // The shell must have started the sleeper and written its pid before
        // the ceiling stops it; a loaded runner may not get that far within a
        // short one, so the ceiling grows until it did.
        let mut sleeper = None;
        for ceiling in [500, 2_000, 8_000] {
            let mut cmd = Command::new("sh");
            cmd.args(["-c", &format!("sleep 30 & echo $! > {}.new && mv {0}.new {0}; wait", pidfile.display())]);
            let started = Instant::now();
            let err = output_within(cmd, Duration::from_millis(ceiling)).expect_err("times out");
            assert!(err.contains("timed out"), "{err}");
            assert!(started.elapsed() < NOT_A_HANG, "took {:?}", started.elapsed());
            sleeper = std::fs::read_to_string(&pidfile).ok().and_then(|pid| pid.trim().parse::<u32>().ok());
            if sleeper.is_some() {
                break;
            }
        }
        let sleeper = sleeper.expect("the shell never started its sleeper");
        // The sleeper is reparented and reaped by init; give it a moment.
        assert!(crate::test_util::wait_until(crate::test_util::PATIENCE, || gone(sleeper)), "the grandchild survived");
    }

    /// A child writing without end (an agent-writable hook running `yes`)
    /// is stopped at its stdout cap instead of filling memory, and no cap set
    /// means [`DEFAULT_STDOUT_CAP`], never unbounded. (A 1 MiB cap here: the
    /// default's 256 MiB would be read twice per test run for the same check.)
    #[cfg(unix)]
    #[test]
    fn unbounded_stdout_is_cut_at_the_default_cap() {
        let cap = 1024 * 1024;
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "exec yes"]);
        let ran = run(&mut cmd, Opts { stdout_cap: Some(cap), timeout: Some(NOT_A_HANG), ..Opts::default() }).expect("ran");
        assert!(ran.cut, "not cut at the cap");
        assert_eq!(ran.output.stdout.len() as u64, cap);
        assert!(!ran.output.status.success(), "a cut child is stopped");
        assert_eq!(stdout_cap(Opts::default().stdout_cap), DEFAULT_STDOUT_CAP);
        // The plain wrappers answer an error, not the cut output.
        assert!(whole(ran).unwrap_err().contains("MiB"));
    }

    /// `keep_stdout_ends` drains stdout past its cap, keeping both ends, so a
    /// chatty child runs to its own exit instead of being stopped.
    #[cfg(unix)]
    #[test]
    fn keep_stdout_ends_drains_instead_of_stopping() {
        let cap = 64 * 1024;
        let mut cmd = Command::new("sh");
        cmd.args(["-c", &format!("printf first; head -c {} /dev/zero; printf last", cap * 8)]);
        let opts = Opts { stdout_cap: Some(cap), keep_stdout_ends: true, timeout: Some(NOT_A_HANG), ..Opts::default() };
        let ran = run(&mut cmd, opts).expect("ran");
        assert!(!ran.cut && ran.output.status.success(), "stopped instead of drained");
        assert!(ran.output.stdout.len() as u64 <= cap + 64, "kept {} bytes", ran.output.stdout.len());
        assert!(ran.output.stdout.starts_with(b"first") && ran.output.stdout.ends_with(b"last"));
    }

    /// stderr keeps its head and tail within [`STDERR_CAP`]; the child is
    /// drained, not stopped, so a chatty but working command still succeeds.
    #[cfg(unix)]
    #[test]
    fn a_flood_on_stderr_is_capped_and_drained() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", &format!("printf first >&2; head -c {} /dev/zero >&2; printf last >&2", STDERR_CAP * 4)]);
        let out = output_within(cmd, NOT_A_HANG).expect("ran");
        assert!(out.status.success());
        assert!(out.stderr.len() as u64 <= STDERR_CAP + 64, "kept {} bytes", out.stderr.len());
        assert!(out.stderr.starts_with(b"first"));
        assert!(out.stderr.ends_with(b"last"));
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
