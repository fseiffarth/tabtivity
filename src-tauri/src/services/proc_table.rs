//! One shared reading of the process table.
//!
//! Several background loops each used to walk all of `/proc` on their own
//! timer: the agent turn relay's tool-shell scan (`agent_turn`, every 2 s while
//! an agent tab is unsettled), the fence marker (`agent_fence`, 15 s), the UI
//! priority rescan (`ui_priority`, 15 s), the Reader's background-shell check
//! (`agent_transcript`) and the CPU readouts' descendant trees (`sysstat`).
//! Each walk is a `read_dir("/proc")` plus a `stat` read per process — the same
//! answer read again and again, sometimes within the same second.
//!
//! [`snapshot`] answers them all from one walk: pid → (ppid, `comm`, start
//! time), taken at most once per [`MAX_AGE`] for callers that tolerate that,
//! and shared as an `Arc`. A caller that must see the table as it is right now
//! (the PTY layer reaping a subtree) asks [`snapshot_within`] with a zero age —
//! its walk then becomes everyone else's reading too.
//!
//! What a process carries beyond its `stat` line is read lazily and only for the
//! processes a caller asks about: [`tab_uid`] reads `/proc/<pid>/environ` once
//! per process lifetime (keyed by pid, start time and `comm`, so a reused pid or
//! an `exec` reads again) and remembers the answer until the process leaves the
//! table.
//!
//! `AppHandle`-free. Linux reads `/proc`; elsewhere the table is
//! `sysstat::parent_map`'s pid → ppid with empty names, which is all the
//! non-Linux callers (descendant trees) ask of it.

use std::collections::{HashMap, HashSet, VecDeque};
use app_core::sync::LockExt;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// How old a shared snapshot may be for the periodic readers. Every caller
/// polls at 2 s or slower, so a one-second-old table answers each of them as
/// well as a fresh walk would, and bursts (hook records arriving several a
/// second, two Readers polling together) share one walk.
pub const MAX_AGE: Duration = Duration::from_secs(1);

/// One process as its `stat` line describes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Proc {
    pub pid: u32,
    pub ppid: u32,
    /// The kernel's `comm` (at most 15 bytes); empty where the platform does
    /// not report it.
    pub comm: String,
    /// Start time since boot in clock ticks (`stat` field 22): with the pid,
    /// it names one process across pid reuse. Zero where unknown.
    pub start: u64,
}

/// The process table at one moment.
#[derive(Debug)]
pub struct Snapshot {
    taken_at: Instant,
    procs: HashMap<u32, Proc>,
    children: OnceLock<HashMap<u32, Vec<u32>>>,
}

impl Snapshot {
    pub fn new(procs: impl IntoIterator<Item = Proc>, taken_at: Instant) -> Self {
        Snapshot {
            taken_at,
            procs: procs.into_iter().map(|p| (p.pid, p)).collect(),
            children: OnceLock::new(),
        }
    }

    /// How long ago the walk behind this snapshot ran.
    pub fn age(&self) -> Duration {
        self.taken_at.elapsed()
    }

    pub fn get(&self, pid: u32) -> Option<&Proc> {
        self.procs.get(&pid)
    }

    pub fn procs(&self) -> impl Iterator<Item = &Proc> {
        self.procs.values()
    }

    pub fn len(&self) -> usize {
        self.procs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.procs.is_empty()
    }

    /// pid → ppid for every process in the snapshot.
    pub fn parent_map(&self) -> HashMap<u32, u32> {
        self.procs.values().map(|p| (p.pid, p.ppid)).collect()
    }

    /// ppid → its children, built once per snapshot.
    pub fn children(&self) -> &HashMap<u32, Vec<u32>> {
        self.children.get_or_init(|| {
            let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
            for p in self.procs.values() {
                children.entry(p.ppid).or_default().push(p.pid);
            }
            children
        })
    }

    /// Every pid that is one of `roots` or descends from one, deduplicated.
    /// A root is always in the answer, listed or not — `sysstat`'s rule, which
    /// its callers (CPU sums, subtree reaping) rely on.
    pub fn descendants(&self, roots: &[u32]) -> Vec<u32> {
        let children = self.children();
        let mut seen: HashSet<u32> = HashSet::new();
        let mut queue: VecDeque<u32> = VecDeque::new();
        for &root in roots {
            if seen.insert(root) {
                queue.push_back(root);
            }
        }
        while let Some(pid) = queue.pop_front() {
            if let Some(kids) = children.get(&pid) {
                for &kid in kids {
                    if seen.insert(kid) {
                        queue.push_back(kid);
                    }
                }
            }
        }
        seen.into_iter().collect()
    }
}

/// A cache of one [`Snapshot`], refreshed on demand. One instance serves the
/// whole process ([`snapshot`]); tests build their own with a fake reader.
pub struct Table {
    current: Mutex<Option<Arc<Snapshot>>>,
    /// Held across a walk, so callers that miss together walk once: the
    /// second re-checks under it and takes the first one's reading.
    walk: Mutex<()>,
}

impl Table {
    pub const fn new() -> Self {
        Table { current: Mutex::new(None), walk: Mutex::new(()) }
    }

    fn fresh(&self, max_age: Duration) -> Option<Arc<Snapshot>> {
        let current = self.current.lock_ok();
        current.as_ref().filter(|snap| snap.age() < max_age).cloned()
    }

    /// The cached snapshot if it is younger than `max_age`, else a new walk
    /// through `read` — which then replaces the cache for every caller.
    pub fn get(&self, max_age: Duration, read: impl FnOnce() -> Vec<Proc>) -> Arc<Snapshot> {
        if let Some(snap) = self.fresh(max_age) {
            return snap;
        }
        let _walking = self.walk.lock_ok();
        if let Some(snap) = self.fresh(max_age) {
            return snap;
        }
        let snap = Arc::new(Snapshot::new(read(), Instant::now()));
        *self.current.lock_ok() = Some(snap.clone());
        snap
    }
}

impl Default for Table {
    fn default() -> Self {
        Self::new()
    }
}

static TABLE: Table = Table::new();

/// The shared process table, at most [`MAX_AGE`] old.
pub fn snapshot() -> Arc<Snapshot> {
    snapshot_within(MAX_AGE)
}

/// The shared process table, at most `max_age` old; `Duration::ZERO` always
/// walks (and shares that walk).
pub fn snapshot_within(max_age: Duration) -> Arc<Snapshot> {
    TABLE.get(max_age, || {
        let procs = read_table();
        prune_lazy(&procs);
        procs
    })
}

/// Parse one `/proc/<pid>/stat` line. `comm` may hold spaces and parentheses,
/// so the fields are read after the last `)`.
pub fn parse_stat(pid: u32, stat: &str) -> Option<Proc> {
    let open = stat.find('(')?;
    let close = stat.rfind(')')?;
    let comm = stat.get(open + 1..close)?.to_string();
    let fields: Vec<&str> = stat.get(close + 1..)?.split_whitespace().collect();
    // After `)`: [0] = state (field 3), [1] = ppid (field 4), [19] = starttime (field 22).
    let ppid = fields.get(1)?.parse().ok()?;
    let start = fields.get(19).and_then(|s| s.parse().ok()).unwrap_or(0);
    Some(Proc { pid, ppid, comm, start })
}

#[cfg(target_os = "linux")]
fn read_table() -> Vec<Proc> {
    let Ok(dir) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    dir.flatten()
        .filter_map(|entry| {
            let pid: u32 = entry.file_name().to_str()?.parse().ok()?;
            let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
            parse_stat(pid, &stat)
        })
        .collect()
}

#[cfg(not(target_os = "linux"))]
fn read_table() -> Vec<Proc> {
    crate::sysstat::parent_map()
        .into_iter()
        .map(|(pid, ppid)| Proc { pid, ppid, comm: String::new(), start: 0 })
        .collect()
}

/// Whether `proc` still runs as the snapshot saw it — same pid, same start.
/// For a caller about to act on a snapshot up to [`MAX_AGE`] old.
#[cfg(target_os = "linux")]
pub fn alive(proc_: &Proc) -> bool {
    std::fs::read_to_string(format!("/proc/{}/stat", proc_.pid))
        .ok()
        .and_then(|stat| parse_stat(proc_.pid, &stat))
        .is_some_and(|now| now.start == proc_.start)
}

#[cfg(not(target_os = "linux"))]
pub fn alive(_proc: &Proc) -> bool {
    true
}

/// What a liveness probe of one pid found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PidState {
    /// The probe succeeded: the process exists (a zombie still counts) and, on
    /// Windows, has not exited.
    Alive,
    /// Positively no such process (`ESRCH`; on Windows no process under that
    /// pid, or one that has exited). The only state that licenses deleting
    /// something on the pid's behalf.
    Gone,
    /// Cannot tell: a process that exists but may not be probed (`EPERM`: the
    /// root-run OpenVPN daemon for an unprivileged probe; Windows access
    /// denied), a pid the platform cannot signal (out of `pid_t` range), or a
    /// probe that failed. Each caller maps it to the side it can afford.
    Unknown,
}

/// Probe `pid` without delivering anything (`kill(pid, 0)`; Windows: open the
/// process and read its exit code). Pid 0 is [`PidState::Gone`] (`kill(0, 0)`
/// would answer for the caller's whole process group); a pid beyond `pid_t`
/// is [`PidState::Unknown`] (a cast would turn it into a negative group id).
pub fn pid_state(pid: u32) -> PidState {
    if pid == 0 {
        return PidState::Gone;
    }
    #[cfg(unix)]
    {
        let Ok(raw) = libc::pid_t::try_from(pid) else {
            return PidState::Unknown;
        };
        // SAFETY: `kill` takes no pointers; signal 0 only probes for
        // existence and permission.
        if unsafe { libc::kill(raw, 0) } == 0 {
            return PidState::Alive;
        }
        match std::io::Error::last_os_error().raw_os_error() {
            Some(libc::ESRCH) => PidState::Gone,
            _ => PidState::Unknown,
        }
    }
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        const STILL_ACTIVE: u32 = 259;
        // HRESULT_FROM_WIN32(ERROR_ACCESS_DENIED): an elevated or protected
        // process exists but refuses the query.
        const ACCESS_DENIED: i32 = 0x8007_0005_u32 as i32;
        // A handle to an already-exited process still opens, so the exit code
        // decides, not the open.
        unsafe {
            match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                Ok(handle) => {
                    let mut code: u32 = 0;
                    let state = if GetExitCodeProcess(handle, &mut code).is_err() {
                        PidState::Unknown
                    } else if code == STILL_ACTIVE {
                        PidState::Alive
                    } else {
                        PidState::Gone
                    };
                    let _ = CloseHandle(handle);
                    state
                }
                Err(e) if e.code().0 == ACCESS_DENIED => PidState::Unknown,
                Err(_) => PidState::Gone,
            }
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        PidState::Unknown
    }
}

/// pid, start time, `comm`: one process image. An `exec` changes the `comm`
/// (and may change the environment), so it is read again.
type ProcKey = (u32, u64, String);

fn key_of(proc_: &Proc) -> ProcKey {
    (proc_.pid, proc_.start, proc_.comm.clone())
}

/// What was read about each process image, until it leaves the table.
struct UidCache(Mutex<HashMap<ProcKey, Option<String>>>);

impl UidCache {
    fn new() -> Self {
        UidCache(Mutex::new(HashMap::new()))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<ProcKey, Option<String>>> {
        self.0.lock_ok()
    }

    /// Forget processes no longer in the table.
    fn prune(&self, procs: &[Proc]) {
        let live: HashSet<(u32, u64)> = procs.iter().map(|p| (p.pid, p.start)).collect();
        self.lock().retain(|(pid, start, _), _| live.contains(&(*pid, *start)));
    }

    fn tab_uid(&self, proc_: &Proc, read: impl FnOnce(u32) -> Option<Vec<u8>>) -> Option<String> {
        let key = key_of(proc_);
        if let Some(known) = self.lock().get(&key) {
            return known.clone();
        }
        let environ = read(proc_.pid);
        let uid = environ.as_deref().and_then(environ_tab_uid);
        // An empty block is a process caught inside `exec`: the kernel names
        // the new image before it sets up its environment. Read it again.
        if environ.as_ref().is_some_and(Vec::is_empty) {
            return uid;
        }
        self.lock().insert(key, uid.clone());
        uid
    }
}

fn tab_uids() -> &'static UidCache {
    static UIDS: OnceLock<UidCache> = OnceLock::new();
    UIDS.get_or_init(UidCache::new)
}

/// Forget what was read about processes no longer in the table.
fn prune_lazy(procs: &[Proc]) {
    tab_uids().prune(procs);
}

/// The tab uid (`TABTIVITY_TAB_UID`) a NUL-separated environment block sets.
pub fn environ_tab_uid(environ: &[u8]) -> Option<String> {
    environ
        .split(|b| *b == 0)
        .find_map(|kv| kv.strip_prefix(concat!(crate::app_env!("TAB_UID"), "=").as_bytes()))
        .and_then(|v| std::str::from_utf8(v).ok())
        .map(str::to_string)
}

/// The tab uid `proc_` inherited, read from its environment once per process
/// image and remembered while it stays in the table. `None` for a process
/// that sets none or whose environment cannot be read (another user's).
pub fn tab_uid(proc_: &Proc) -> Option<String> {
    tab_uids().tab_uid(proc_, |pid| std::fs::read(format!("/proc/{pid}/environ")).ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn proc_(pid: u32, ppid: u32, comm: &str) -> Proc {
        Proc { pid, ppid, comm: comm.to_string(), start: u64::from(pid) * 10 }
    }

    #[test]
    fn pid_state_tells_alive_gone_and_unprobeable_apart() {
        assert_eq!(pid_state(std::process::id()), PidState::Alive);
        assert_eq!(pid_state(0), PidState::Gone);
        let mut child = std::process::Command::new(if cfg!(windows) { "cmd" } else { "true" })
            .args(if cfg!(windows) { vec!["/C", "exit"] } else { vec![] })
            .spawn()
            .expect("spawn");
        let pid = child.id();
        child.wait().expect("reap");
        // Reaped, so the number is free again (a reuse in this instant would
        // only turn it Alive; `Unknown` never happens for a free number).
        assert_ne!(pid_state(pid), PidState::Unknown);
        #[cfg(unix)]
        {
            // Out of `pid_t` range: never cast into a negative group id.
            assert_eq!(pid_state(u32::MAX), PidState::Unknown);
            // Pid 1 exists; an unprivileged probe is Alive or EPERM-Unknown, never Gone.
            assert_ne!(pid_state(1), PidState::Gone);
        }
    }

    #[test]
    fn a_fresh_snapshot_is_reused_and_a_stale_one_is_read_again() {
        let table = Table::new();
        let reads = Cell::new(0);
        let read = || {
            reads.set(reads.get() + 1);
            vec![proc_(1, 0, "init"), proc_(2, 1, "bash")]
        };
        let first = table.get(Duration::from_secs(60), read);
        let second = table.get(Duration::from_secs(60), read);
        assert_eq!(reads.get(), 1, "a fresh snapshot is shared");
        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(second.len(), 2);

        // A caller that needs the table as it is now always walks — and its
        // walk is the one the next tolerant caller gets.
        let strict = table.get(Duration::ZERO, read);
        assert_eq!(reads.get(), 2);
        let after = table.get(Duration::from_secs(60), read);
        assert_eq!(reads.get(), 2);
        assert!(Arc::ptr_eq(&strict, &after));

        std::thread::sleep(Duration::from_millis(15));
        table.get(Duration::from_millis(10), read);
        assert_eq!(reads.get(), 3, "older than the caller's bound: walked again");
    }

    #[test]
    fn concurrent_misses_walk_once() {
        let table = Arc::new(Table::new());
        let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let table = table.clone();
                let reads = reads.clone();
                std::thread::spawn(move || {
                    table.get(Duration::from_secs(60), || {
                        reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        std::thread::sleep(Duration::from_millis(20));
                        vec![proc_(1, 0, "init")]
                    })
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        assert_eq!(reads.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn descendants_include_the_roots_and_their_whole_subtree() {
        let snap = Snapshot::new(
            vec![proc_(1, 0, "init"), proc_(10, 1, "bash"), proc_(11, 10, "node"), proc_(12, 11, "sh"), proc_(20, 1, "other")],
            Instant::now(),
        );
        let mut tree = snap.descendants(&[10]);
        tree.sort_unstable();
        assert_eq!(tree, vec![10, 11, 12]);
        // An unlisted root is still answered (it may have died since the walk).
        assert_eq!(snap.descendants(&[999]), vec![999]);
        assert!(snap.descendants(&[]).is_empty());
        assert_eq!(snap.children().get(&1).map(Vec::len), Some(2));
        assert_eq!(snap.parent_map().get(&12), Some(&11));
    }

    #[test]
    fn stat_lines_parse_past_a_comm_with_spaces_and_parens() {
        let stat = "4242 (Web (Kit) Proc) S 4000 4242 4242 0 -1 4194560 1 0 0 0 10 5 0 0 20 0 37 0 987654 0 0";
        let p = parse_stat(4242, stat).unwrap();
        assert_eq!(p.comm, "Web (Kit) Proc");
        assert_eq!(p.ppid, 4000);
        assert_eq!(p.start, 987654);
        assert!(parse_stat(1, "garbage").is_none());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_live_table_holds_this_process_under_its_parent() {
        let snap = snapshot_within(Duration::ZERO);
        let me = std::process::id();
        let own = snap.get(me).expect("own pid in the table");
        assert!(own.start > 0);
        assert!(alive(own));
        assert!(!alive(&Proc { start: own.start + 1, ..own.clone() }));
        assert!(snap.descendants(&[own.ppid]).contains(&me));
    }

    #[test]
    fn a_tab_uid_is_read_once_per_process_image() {
        let p = Proc { pid: 4_000_001, ppid: 1, comm: "bash".into(), start: 77 };
        let reads = Cell::new(0);
        let env = concat!("HOME=/h\0", crate::app_env!("TAB_UID"), "=aaaa-1\0").as_bytes().to_vec();
        let read = |_| {
            reads.set(reads.get() + 1);
            Some(env.clone())
        };
        let cache = UidCache::new();
        assert_eq!(cache.tab_uid(&p, read).as_deref(), Some("aaaa-1"));
        assert_eq!(cache.tab_uid(&p, read).as_deref(), Some("aaaa-1"));
        assert_eq!(reads.get(), 1);
        // An exec (new comm) or a reused pid (new start) reads again.
        let execd = Proc { comm: "node".into(), ..p.clone() };
        assert_eq!(cache.tab_uid(&execd, |_| Some(b"HOME=/h\0".to_vec())), None);
        let reused = Proc { start: 78, ..p.clone() };
        cache.tab_uid(&reused, read);
        assert_eq!(reads.get(), 2);
        // A process gone from the table is forgotten.
        cache.prune(&[Proc { pid: 1, ppid: 0, comm: "init".into(), start: 1 }]);
        cache.tab_uid(&p, read);
        assert_eq!(reads.get(), 3);
    }

    /// `exec` names the new image (`comm`) before it sets up its environment:
    /// a read in between gets an empty block. Remembering that as "no tab uid"
    /// lost the shell for its whole life — never a job, however long it ran.
    #[test]
    fn an_empty_environment_read_mid_exec_is_read_again() {
        let p = Proc { pid: 4_000_002, ppid: 1, comm: "bash".into(), start: 91 };
        let cache = UidCache::new();
        assert_eq!(cache.tab_uid(&p, |_| Some(Vec::new())), None);
        let env = concat!(crate::app_env!("TAB_UID"), "=bbbb-2\0").as_bytes().to_vec();
        assert_eq!(cache.tab_uid(&p, |_| Some(env.clone())).as_deref(), Some("bbbb-2"));
        // Unreadable (another user's) stays known: not read again.
        let q = Proc { pid: 4_000_003, ..p.clone() };
        assert_eq!(cache.tab_uid(&q, |_| None), None);
        assert_eq!(cache.tab_uid(&q, |_| Some(env.clone())), None);
    }

    #[test]
    fn environ_tab_uid_matches_the_exact_variable() {
        let env = concat!("HOME=/h\0", crate::app_env!("TAB_UID"), "=aaaa-1\0PATH=/bin\0");
        assert_eq!(environ_tab_uid(env.as_bytes()).as_deref(), Some("aaaa-1"));
        assert_eq!(environ_tab_uid(concat!("X_", crate::app_env!("TAB_UID"), "=aaaa-1\0").as_bytes()), None);
        assert_eq!(environ_tab_uid(b"HOME=/h\0"), None);
    }
}
