//! Change notifications for the transcripts a Reader shows.
//!
//! The desktop Reader (and its Changes panel) used to ask for its tab's
//! transcript every 2 s while shown — an IPC round trip, a `stat`, and with
//! background shells open a look at the process table, mostly to hear
//! "unchanged". Instead each read names a watch id; the command layer arms it
//! here on the files that read went by ([`Target`]s: the transcript itself, the
//! folder a `/clear` writes the next one into, Claude's subagents folder), and
//! a change calls the sink with the id. The window reads again on that, and
//! keeps a slow backstop timer for what no file event says (a background shell
//! dying with its CLI, a rollout started in another folder).
//!
//! Events are folded per id: the first one arms a [`SETTLE`] wait (a record is
//! often written in more than one `write`), and two notifications for one id
//! are at least [`MIN_GAP`] apart, so an agent streaming records costs one read
//! a second at most — never more than the old poll's two.
//!
//! `AppHandle`-free: the sink is a plain callback ([`install`]), which the
//! command layer points at its event emitter.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant};

use notify::event::{ModifyKind, RenameMode};
use notify::{EventKind, RecursiveMode, Watcher as _};

/// How long after a watched file's first change the notification waits for
/// the rest of the write.
pub const SETTLE: Duration = Duration::from_millis(250);
/// The least time between two notifications for one watch id.
pub const MIN_GAP: Duration = Duration::from_secs(1);

/// Which entries of a watched folder count as a change.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Rule {
    /// This one file.
    Exact(OsString),
    /// Any file whose name starts so (a database and its `-wal`) — except a
    /// SQLite `-shm` index: a reader's own open rewrites it when no other
    /// connection is open, so counting it made each read cause the next.
    /// Every committed write lands in the database or its `-wal`.
    Prefix(String),
    /// Any entry newly created (or renamed in): the next transcript a `/clear`
    /// starts, a subagent's folder.
    Created,
    /// Anything in the folder.
    Any,
}

/// A folder to watch (not recursively) and what in it counts.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Target {
    pub dir: PathBuf,
    pub rule: Rule,
}

impl Target {
    /// `file` itself.
    pub fn file(file: &Path) -> Option<Target> {
        Some(Target { dir: file.parent()?.to_path_buf(), rule: Rule::Exact(file.file_name()?.to_os_string()) })
    }

    fn matches(&self, path: &Path, created: bool) -> bool {
        if path.parent() != Some(self.dir.as_path()) {
            return false;
        }
        match &self.rule {
            Rule::Exact(name) => path.file_name() == Some(name.as_os_str()),
            Rule::Prefix(prefix) => path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with(prefix.as_str()) && !n.ends_with("-shm")),
            Rule::Created => created,
            Rule::Any => true,
        }
    }
}

/// The most watches kept at once. A window that reloads never disarms its
/// Readers' watches; past this the one read least recently goes — a shown
/// Reader reads at least every backstop period, a leaked watch never again.
const MAX_WATCHES: usize = 128;

/// Which ids watch what, and how many ids watch each folder.
#[derive(Debug, Default)]
struct Registry {
    subs: HashMap<String, Vec<Target>>,
    dirs: HashMap<PathBuf, usize>,
    /// When each id was last armed or kept by a read, in that order.
    armed_seq: HashMap<String, u64>,
    seq: u64,
}

impl Registry {
    /// Point `id` at `targets`. Answers the folders that gained their first
    /// watcher and those that lost their last.
    fn arm(&mut self, id: &str, targets: Vec<Target>) -> (Vec<PathBuf>, Vec<PathBuf>) {
        let mut dropped = self.disarm(id);
        let mut added = Vec::new();
        if targets.is_empty() {
            return (added, dropped);
        }
        while self.subs.len() >= MAX_WATCHES {
            let Some(oldest) = self.armed_seq.iter().min_by_key(|(_, seq)| **seq).map(|(id, _)| id.clone()) else {
                break;
            };
            dropped.extend(self.disarm(&oldest));
        }
        self.seq += 1;
        self.armed_seq.insert(id.to_string(), self.seq);
        let mut dirs: Vec<PathBuf> = targets.iter().map(|t| t.dir.clone()).collect();
        dirs.sort();
        dirs.dedup();
        for dir in dirs {
            let count = self.dirs.entry(dir.clone()).or_insert(0);
            *count += 1;
            if *count == 1 {
                // A folder dropped and taken again in one re-arm stays watched.
                if let Some(at) = dropped.iter().position(|d| *d == dir) {
                    dropped.remove(at);
                } else {
                    added.push(dir);
                }
            }
        }
        self.subs.insert(id.to_string(), targets);
        (added, dropped)
    }

    /// A read kept `id` as it is: it is in use, so the last to be evicted.
    /// False when `id` is not armed.
    fn touch(&mut self, id: &str) -> bool {
        if !self.subs.contains_key(id) {
            return false;
        }
        self.seq += 1;
        self.armed_seq.insert(id.to_string(), self.seq);
        true
    }

    /// Forget `id`; answers the folders that lost their last watcher.
    fn disarm(&mut self, id: &str) -> Vec<PathBuf> {
        let mut dropped = Vec::new();
        self.armed_seq.remove(id);
        let Some(targets) = self.subs.remove(id) else {
            return dropped;
        };
        let mut dirs: Vec<PathBuf> = targets.into_iter().map(|t| t.dir).collect();
        dirs.sort();
        dirs.dedup();
        for dir in dirs {
            if let Some(count) = self.dirs.get_mut(&dir) {
                *count -= 1;
                if *count == 0 {
                    self.dirs.remove(&dir);
                    dropped.push(dir);
                }
            }
        }
        dropped
    }

    fn targets(&self, id: &str) -> Option<&Vec<Target>> {
        self.subs.get(id)
    }

    /// The ids one changed `path` concerns.
    fn matching(&self, path: &Path, created: bool) -> Vec<String> {
        self.subs
            .iter()
            .filter(|(_, targets)| targets.iter().any(|t| t.matches(path, created)))
            .map(|(id, _)| id.clone())
            .collect()
    }
}

/// Per id: when its pending notification is due, and when it last went out.
#[derive(Debug, Default)]
struct Debouncer {
    due: HashMap<String, Instant>,
    last: HashMap<String, Instant>,
}

impl Debouncer {
    /// A change for `id` at `now`. A notification already pending absorbs it.
    fn note(&mut self, id: &str, now: Instant) {
        if self.due.contains_key(id) {
            return;
        }
        let settle = now + SETTLE;
        let at = self.last.get(id).map_or(settle, |last| settle.max(*last + MIN_GAP));
        self.due.insert(id.to_string(), at);
    }

    fn next_due(&self) -> Option<Instant> {
        self.due.values().min().copied()
    }

    /// The ids due at `now`, marked sent.
    fn take_due(&mut self, now: Instant) -> Vec<String> {
        let ready: Vec<String> = self.due.iter().filter(|(_, at)| **at <= now).map(|(id, _)| id.clone()).collect();
        for id in &ready {
            self.due.remove(id);
            self.last.insert(id.clone(), now);
        }
        self.last.retain(|_, at| now.saturating_duration_since(*at) < MIN_GAP);
        ready
    }
}

type Sink = Arc<dyn Fn(&str) + Send + Sync>;

struct State {
    registry: Registry,
    fs: Option<notify::RecommendedWatcher>,
}

/// One watcher: a `notify` watch over the armed folders and a thread folding
/// its events into notifications. The thread ends when this is dropped.
pub struct TranscriptWatch {
    state: Arc<Mutex<State>>,
}

impl TranscriptWatch {
    pub fn start(sink: impl Fn(&str) + Send + Sync + 'static) -> Self {
        let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
        let fs = notify::recommended_watcher(move |res| {
            let _ = tx.send(res);
        })
        .map_err(|e| eprintln!("transcript_watch: no watcher: {e}"))
        .ok();
        let state = Arc::new(Mutex::new(State { registry: Registry::default(), fs }));
        let weak = Arc::downgrade(&state);
        let sink: Sink = Arc::new(sink);
        let spawned = std::thread::Builder::new()
            .name("transcript-watch".into())
            .spawn(move || run(rx, weak, sink));
        if let Err(e) = spawned {
            eprintln!("transcript_watch: not started: {e}");
        }
        TranscriptWatch { state }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Point watch `id` at `targets`, replacing what it watched. True when it
    /// now watches something: every target's folder is watched. False (and
    /// nothing armed) when there is nothing to watch or a folder cannot be —
    /// the caller then keeps reading on its own clock.
    pub fn arm(&self, id: &str, targets: Vec<Target>) -> bool {
        let mut seen = std::collections::HashSet::new();
        let mut targets = targets;
        targets.retain(|t| seen.insert(t.clone()));
        let mut state = self.lock();
        if state.registry.targets(id) == Some(&targets) {
            return state.registry.touch(id);
        }
        let (added, dropped) = state.registry.arm(id, targets.clone());
        let State { registry, fs } = &mut *state;
        let Some(fs) = fs.as_mut() else {
            registry.disarm(id);
            return false;
        };
        for dir in &dropped {
            let _ = fs.unwatch(dir);
        }
        let mut failed = false;
        for dir in &added {
            if fs.watch(dir, RecursiveMode::NonRecursive).is_err() {
                failed = true;
            }
        }
        if failed || targets.is_empty() {
            for dir in &registry.disarm(id) {
                let _ = fs.unwatch(dir);
            }
            return false;
        }
        true
    }

    /// Stop watch `id`.
    pub fn disarm(&self, id: &str) {
        let mut state = self.lock();
        let State { registry, fs } = &mut *state;
        let dropped = registry.disarm(id);
        if let Some(fs) = fs.as_mut() {
            for dir in &dropped {
                let _ = fs.unwatch(dir);
            }
        }
    }

    /// Whether watch `id` is armed.
    pub fn armed(&self, id: &str) -> bool {
        self.lock().registry.targets(id).is_some()
    }

    /// A read went by the same files as the one that armed `id`: keep it as
    /// it is, marked in use. False when it is not armed (never, or evicted).
    pub fn keep(&self, id: &str) -> bool {
        self.lock().registry.touch(id)
    }
}

/// Whether an event kind is a change worth a read, and whether it brought a
/// new entry. Reads and closes are not changes.
fn classify(kind: &EventKind) -> Option<bool> {
    match kind {
        EventKind::Access(_) => None,
        EventKind::Create(_) => Some(true),
        EventKind::Modify(ModifyKind::Name(RenameMode::To | RenameMode::Both | RenameMode::Any)) => Some(true),
        _ => Some(false),
    }
}

fn run(rx: mpsc::Receiver<notify::Result<notify::Event>>, state: Weak<Mutex<State>>, sink: Sink) {
    let mut debounce = Debouncer::default();
    loop {
        let wait = debounce
            .next_due()
            .map_or(Duration::from_secs(3600), |at| at.saturating_duration_since(Instant::now()));
        match rx.recv_timeout(wait) {
            Ok(Ok(event)) => {
                if let Some(created) = classify(&event.kind) {
                    let Some(state) = state.upgrade() else { return };
                    let state = state.lock().unwrap_or_else(|p| p.into_inner());
                    let now = Instant::now();
                    for path in &event.paths {
                        for id in state.registry.matching(path, created) {
                            debounce.note(&id, now);
                        }
                    }
                }
            }
            Ok(Err(_)) | Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
        let due = debounce.take_due(Instant::now());
        if due.is_empty() {
            continue;
        }
        let Some(state) = state.upgrade() else { return };
        let armed: Vec<String> = {
            let state = state.lock().unwrap_or_else(|p| p.into_inner());
            due.into_iter().filter(|id| state.registry.targets(id).is_some()).collect()
        };
        for id in armed {
            sink(&id);
        }
    }
}

static GLOBAL: OnceLock<TranscriptWatch> = OnceLock::new();

/// Start the process-wide watcher with its sink. Later calls are ignored.
pub fn install(sink: impl Fn(&str) + Send + Sync + 'static) {
    let _ = GLOBAL.set(TranscriptWatch::start(sink));
}

/// [`TranscriptWatch::arm`] on the process-wide watcher; false before
/// [`install`].
pub fn arm(id: &str, targets: Vec<Target>) -> bool {
    GLOBAL.get().is_some_and(|w| w.arm(id, targets))
}

pub fn disarm(id: &str) {
    if let Some(w) = GLOBAL.get() {
        w.disarm(id);
    }
}

/// [`TranscriptWatch::keep`] on the process-wide watcher.
pub fn keep(id: &str) -> bool {
    GLOBAL.get().is_some_and(|w| w.keep(id))
}

/// A watch id as the window mints it: short, plain. Anything else is refused
/// before it reaches the registry.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(dir: &str, rule: Rule) -> Target {
        Target { dir: PathBuf::from(dir), rule }
    }

    #[test]
    fn a_first_change_settles_and_later_ones_keep_a_gap() {
        let mut d = Debouncer::default();
        let t0 = Instant::now();
        d.note("a", t0);
        // Absorbed into the pending one.
        d.note("a", t0 + Duration::from_millis(100));
        assert_eq!(d.next_due(), Some(t0 + SETTLE));
        assert!(d.take_due(t0 + Duration::from_millis(200)).is_empty());
        let sent_at = t0 + SETTLE;
        assert_eq!(d.take_due(sent_at), vec!["a".to_string()]);
        assert_eq!(d.next_due(), None);
        // A change right after a notification waits out the gap.
        d.note("a", sent_at + Duration::from_millis(50));
        assert_eq!(d.next_due(), Some(sent_at + MIN_GAP));
        assert_eq!(d.take_due(sent_at + MIN_GAP), vec!["a".to_string()]);
        // After a quiet spell the settle alone applies again.
        let later = sent_at + MIN_GAP + Duration::from_secs(5);
        d.take_due(later);
        d.note("a", later);
        assert_eq!(d.next_due(), Some(later + SETTLE));
        // Ids are independent.
        d.note("b", later);
        assert_eq!(d.take_due(later + SETTLE).len(), 2);
    }

    #[test]
    fn events_match_by_folder_and_rule() {
        let file = target("/t/proj", Rule::Exact("s.jsonl".into()));
        assert!(file.matches(Path::new("/t/proj/s.jsonl"), false));
        assert!(!file.matches(Path::new("/t/proj/other.jsonl"), false));
        assert!(!file.matches(Path::new("/t/proj/sub/s.jsonl"), false));
        let created = target("/t/proj", Rule::Created);
        assert!(created.matches(Path::new("/t/proj/new.jsonl"), true));
        assert!(!created.matches(Path::new("/t/proj/new.jsonl"), false));
        let db = target("/t/oc", Rule::Prefix("opencode.db".into()));
        assert!(db.matches(Path::new("/t/oc/opencode.db-wal"), false));
        assert!(!db.matches(Path::new("/t/oc/opencode.db-shm"), false));
        assert!(!db.matches(Path::new("/t/oc/other.db"), false));
        assert!(target("/t/sub", Rule::Any).matches(Path::new("/t/sub/x.meta.json"), false));
    }

    #[test]
    fn folders_are_refcounted_across_ids_and_re_arms() {
        let mut r = Registry::default();
        let (added, dropped) = r.arm("a", vec![target("/t/p", Rule::Exact("1.jsonl".into())), target("/t/p", Rule::Created)]);
        assert_eq!((added, dropped), (vec![PathBuf::from("/t/p")], vec![]));
        let (added, _) = r.arm("b", vec![target("/t/p", Rule::Exact("2.jsonl".into()))]);
        assert!(added.is_empty(), "already watched for a");
        assert_eq!(r.matching(Path::new("/t/p/2.jsonl"), false), vec!["b".to_string()]);
        let mut both = r.matching(Path::new("/t/p/3.jsonl"), true);
        both.sort();
        assert_eq!(both, vec!["a".to_string()], "only a watches for new files");
        // Re-arming a onto the same folder neither drops nor re-adds it.
        let (added, dropped) = r.arm("a", vec![target("/t/p", Rule::Exact("9.jsonl".into()))]);
        assert!(added.is_empty() && dropped.is_empty());
        // Rotation into another folder.
        let (added, dropped) = r.arm("b", vec![target("/t/q", Rule::Exact("2.jsonl".into()))]);
        assert_eq!((added, dropped), (vec![PathBuf::from("/t/q")], vec![]));
        assert_eq!(r.disarm("a"), vec![PathBuf::from("/t/p")]);
        assert!(r.matching(Path::new("/t/p/9.jsonl"), false).is_empty());
    }

    #[test]
    fn past_the_cap_the_oldest_watch_goes() {
        let mut r = Registry::default();
        for n in 0..MAX_WATCHES {
            r.arm(&format!("w{n}"), vec![target(&format!("/t/{n}"), Rule::Any)]);
        }
        // Re-arming the first makes it the newest.
        r.arm("w0", vec![target("/t/0", Rule::Any)]);
        let (added, dropped) = r.arm("new", vec![target("/t/new", Rule::Any)]);
        assert_eq!(added, vec![PathBuf::from("/t/new")]);
        assert_eq!(dropped, vec![PathBuf::from("/t/1")]);
        assert!(r.targets("w1").is_none());
        assert!(r.targets("w0").is_some());
        assert_eq!(r.subs.len(), MAX_WATCHES);
    }

    /// The cap evicts the watch read least recently. A shown Reader's watch is
    /// armed once and then kept by every read (`keep`, or a re-arm onto the
    /// same files) — while a window reload leaves newer, never-read leaks. By
    /// arm time alone the live Reader went first and fell back to the 15 s
    /// backstop.
    #[test]
    fn a_watch_still_read_is_not_the_one_the_cap_evicts() {
        let dir = tempfile::tempdir().unwrap();
        let watch = TranscriptWatch::start(|_| {});
        let file = |n: usize| Target::file(&dir.path().join(format!("{n}.jsonl"))).unwrap();
        for n in 0..MAX_WATCHES {
            assert!(watch.arm(&format!("w{n}"), vec![file(n)]));
        }
        // w0 is read again over the same files; w1 is kept by an unchanged read.
        assert!(watch.arm("w0", vec![file(0)]));
        assert!(watch.keep("w1"));
        assert!(!watch.keep("never"), "keeping an unarmed id arms nothing");
        assert!(watch.arm("new", vec![file(999)]));
        assert!(watch.armed("w0") && watch.armed("w1") && watch.armed("new"));
        assert!(!watch.armed("w2"), "the least recently read went");
    }

    #[test]
    fn ids_are_plain() {
        assert!(valid_id("rw-1a2b-3"));
        assert!(!valid_id(""));
        assert!(!valid_id("../x"));
        assert!(!valid_id(&"a".repeat(65)));
    }

    /// Wait (bounded) for the sink to have seen `id` `n` times.
    fn seen(log: &Mutex<Vec<String>>, id: &str, n: usize) -> bool {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if log.lock().unwrap().iter().filter(|s| *s == id).count() >= n {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    /// OpenCode's store is read through SQLite: a read-only connection that
    /// finds no other one open (OpenCode not running) rewrites the store's
    /// `-shm` index on open. Counting that as a change made every read cause
    /// the next — a read a second for as long as the Reader showed.
    #[test]
    fn reading_the_opencode_store_is_not_a_change_but_a_write_is() {
        use rusqlite::{Connection, OpenFlags};
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("opencode.db");
        {
            let c = Connection::open(&db).unwrap();
            c.pragma_update(None, "journal_mode", "wal").unwrap();
            c.execute("CREATE TABLE m(x)", []).unwrap();
        }
        let read = || {
            let c = Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
            c.query_row("SELECT count(*) FROM m", [], |r| r.get::<_, i64>(0)).unwrap();
        };
        // The first read creates the `-wal` and `-shm` beside the store (a
        // new entry is a change); read once before arming.
        read();
        let log = Arc::new(Mutex::new(Vec::new()));
        let sink_log = log.clone();
        let watch = TranscriptWatch::start(move |id| sink_log.lock().unwrap().push(id.to_string()));
        assert!(watch.arm("oc", vec![Target { dir: dir.path().to_path_buf(), rule: Rule::Prefix("opencode.db".into()) }]));
        for _ in 0..3 {
            read();
        }
        std::thread::sleep(SETTLE + Duration::from_millis(400));
        assert!(log.lock().unwrap().is_empty(), "a read of the store is no change: {:?}", log.lock().unwrap());
        // A write is.
        Connection::open(&db).unwrap().execute("INSERT INTO m VALUES (1)", []).unwrap();
        assert!(seen(&log, "oc", 1), "a write notified");
    }

    #[test]
    fn appends_and_a_new_transcript_notify_and_a_missing_one_does_not_arm() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("s.jsonl");
        std::fs::write(&file, "{}\n").unwrap();
        let log = Arc::new(Mutex::new(Vec::new()));
        let sink_log = log.clone();
        let watch = TranscriptWatch::start(move |id| sink_log.lock().unwrap().push(id.to_string()));

        // Nothing to watch: not armed, the caller polls.
        assert!(!watch.arm("none", vec![]));
        assert!(!watch.arm("gone", vec![Target::file(&dir.path().join("missing").join("x.jsonl")).unwrap()]));
        assert!(!watch.armed("gone"));

        let targets = vec![Target::file(&file).unwrap(), Target { dir: dir.path().to_path_buf(), rule: Rule::Created }];
        assert!(watch.arm("r1", targets.clone()));
        assert!(watch.arm("r1", targets), "the same targets again: still armed");

        // An append: one notification for the burst.
        let mut f = std::fs::OpenOptions::new().append(true).open(&file).unwrap();
        writeln!(f, "{{\"a\":1}}").unwrap();
        writeln!(f, "{{\"a\":2}}").unwrap();
        drop(f);
        assert!(seen(&log, "r1", 1), "an append notified");
        std::thread::sleep(SETTLE + Duration::from_millis(100));
        assert_eq!(log.lock().unwrap().len(), 1, "one notification per burst");

        // A sibling's transcript changing is not this one's.
        let sibling = dir.path().join("t.jsonl");
        std::fs::write(&sibling, "").unwrap(); // created: the rotation rule fires
        assert!(seen(&log, "r1", 2), "a new transcript beside it notified");
        std::thread::sleep(MIN_GAP + SETTLE);
        let before = log.lock().unwrap().len();
        std::fs::write(&sibling, "{}\n").unwrap();
        std::thread::sleep(MIN_GAP + SETTLE + Duration::from_millis(300));
        assert_eq!(log.lock().unwrap().len(), before, "a sibling's write is not a change here");

        // Disarmed: silent.
        watch.disarm("r1");
        assert!(!watch.armed("r1"));
        std::fs::write(&file, "{}\n{}\n").unwrap();
        std::thread::sleep(MIN_GAP + SETTLE + Duration::from_millis(300));
        assert_eq!(log.lock().unwrap().len(), before);
    }
}
