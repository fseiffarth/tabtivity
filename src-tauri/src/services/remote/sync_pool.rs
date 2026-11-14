//! Bounded, ordered concurrency for byte-sync (`docs/remote_sync_guide.md`):
//! the per-file runner that manual pushes and pulls and the background pass
//! move files through ([`run_ordered`]), and the host walk's concurrent
//! directory listing ([`walk_listed`]).
//!
//! A file's transfer costs several SFTP round trips, so a folder of a few
//! hundred small files moved one after another took minutes on an ordinary
//! link. Both helpers overlap only the remote work: results come back in input
//! order, so what a caller records, reports and counts is what its old
//! one-at-a-time loop produced.

use std::collections::{HashMap, VecDeque};
use std::future::Future;

use futures_util::stream::{self, FuturesUnordered, StreamExt};
use tokio::sync::{mpsc, Semaphore};

use crate::services::remote_sync::{join_rel, HostFile, MAX_SYNC_FILE_BYTES};
use crate::services::sftp::{RawEntry, SyncKind};

/// Files one transfer moves at once. Small files are latency-bound (open,
/// write, rename, re-stat: each a round trip on the one pooled channel), so a
/// few in flight hide most of it; a large file is bandwidth-bound and gains
/// nothing from company. Four keeps the pooled session, which every other
/// sync command and lockstep share, from being flooded.
pub const TRANSFER_CONCURRENCY: usize = 4;

/// Bytes the files in flight may hold in memory together, judged by their
/// listed sizes: a pull reads a file within [`MAX_SYNC_FILE_BYTES`] whole and a
/// push reads the mirror copy whole, so four files at the cap would hold
/// 256 MiB. Two files of the cap keeps the peak where the old sequential loop
/// could already reach with one, while small files still run four wide. A file
/// over the budget (a manual pull streams one past the cap) takes all of it and
/// runs alone.
pub const TRANSFER_BYTE_BUDGET: u64 = 2 * MAX_SYNC_FILE_BYTES;

/// Directory listings the host walk keeps in flight. A listing is one round
/// trip per batch of names, so a deep tree of small folders is latency-bound
/// the same way small files are.
pub const LIST_CONCURRENCY: usize = 8;

const _: () = assert!(TRANSFER_BYTE_BUDGET <= u32::MAX as u64, "the budget is counted in semaphore permits");

/// How wide a [`run_ordered`] runs: at most `width` files at once, and at most
/// `budget` bytes of their weights.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub width: usize,
    pub budget: u64,
}

impl Limits {
    /// The byte-sync transfers' bounds.
    pub const TRANSFERS: Limits = Limits { width: TRANSFER_CONCURRENCY, budget: TRANSFER_BYTE_BUDGET };
}

/// Run `work(i)` for every `i` in `0..count`, at most `limits.width` at once and
/// at most `limits.budget` of their `weight(i)` at once (a weight over the
/// budget takes all of it, so that item runs alone; the queue is first come,
/// first served, so a heavy item is never starved by light ones behind it).
///
/// Returns the driver and the receiver of `(i, output)`, **in input order**.
/// The caller polls both together (`tokio::join!`) and does its recording in
/// the receiving half, which therefore stays sequential: the driver is polled
/// while the receiver awaits a lock or a save, so neither the transfers in
/// flight nor their timeouts are held up by it.
///
/// `halt` is asked before each item starts (once it has its share of the
/// budget): once it answers true no further item starts, and items never
/// started send nothing. Items already started always run to their end and
/// are sent — a transfer is never cut off mid-file by this runner.
pub fn run_ordered<R, W, H, F, Fut>(
    count: usize,
    limits: Limits,
    weight: W,
    halt: H,
    work: F,
) -> (impl Future<Output = ()>, mpsc::UnboundedReceiver<(usize, R)>)
where
    W: Fn(usize) -> u64,
    H: Fn() -> bool,
    F: Fn(usize) -> Fut,
    Fut: Future<Output = R>,
{
    let (tx, rx) = mpsc::unbounded_channel();
    let budget = u32::try_from(limits.budget.max(1)).unwrap_or(u32::MAX);
    let width = limits.width.max(1);
    let drive = async move {
        let held = Semaphore::new(budget as usize);
        let (held, weight, halt, work, tx) = (&held, &weight, &halt, &work, &tx);
        stream::iter(0..count)
            .take_while(|_| std::future::ready(!halt()))
            .map(|i| async move {
                let share = u32::try_from(weight(i).clamp(1, u64::from(budget))).unwrap_or(budget);
                // The semaphore is never closed, so the acquire cannot fail.
                let _share = held.acquire_many(share).await.ok()?;
                if halt() {
                    return None;
                }
                Some((i, work(i).await))
            })
            .buffered(width)
            .for_each(|finished| {
                if let Some(finished) = finished {
                    // A receiver dropped early only loses the report, never a transfer.
                    let _ = tx.send(finished);
                }
                std::future::ready(())
            })
            .await;
    };
    (drive, rx)
}

/// One entry of a listed directory, in listing order, waiting its turn.
enum Item {
    File(HostFile),
    Dir(String),
    /// A link, a special file or a folder `skip_dir` names: contributes no file,
    /// but still counts as "more to walk" for the cap.
    Inert,
}

/// A listed directory's entries not yet walked, and the subdirectories among
/// them whose listing has not been started (always a suffix of its folders in
/// order: listings start in walk order).
struct Level {
    items: VecDeque<Item>,
    unstarted: VecDeque<String>,
}

/// The host walk's traversal over a lister: `list(rel)` lists project-relative
/// directory `rel` (lstat-typed entries, `sftp::list_dir_raw_on`). Collects the
/// regular files under `rel`, at most `cap` of them, with `true` when the cap
/// cut the walk short.
///
/// The output — files, order and the `truncated` flag — is exactly what the old
/// recursive one-listing-at-a-time walk gave: depth-first, each directory's
/// entries in listing order. Only the listings overlap: up to `width` of the
/// next directories in walk order are listed ahead while the walk consumes the
/// earlier ones. A listing error fails the walk only when the walk reaches that
/// directory (as before); one listed ahead past the cap is dropped unread.
///
/// The rules: Tabtivity's runtime dir and `.git` entries are never walked; a
/// subdirectory (or a non-root `rel`) holding a `.git` entry of either kind is
/// somebody else's repo and yields nothing (#23 D2); a folder `skip_dir` names
/// is not entered; links and special files are never followed (G3).
pub async fn walk_listed<L, Fut>(
    list: L,
    rel: &str,
    skip_dir: &(dyn Fn(&str) -> bool + Sync),
    cap: usize,
    width: usize,
) -> Result<(Vec<HostFile>, bool), String>
where
    L: Fn(String) -> Fut,
    Fut: Future<Output = Result<Vec<RawEntry>, String>>,
{
    let width = width.max(1);
    let start = |dir: String| {
        let listing = list(dir.clone());
        async move { (dir, listing.await) }
    };
    let mut in_flight = FuturesUnordered::new();
    let mut listed: HashMap<String, Result<Vec<RawEntry>, String>> = HashMap::new();
    let mut levels: Vec<Level> = Vec::new();
    let mut out = Vec::new();
    // The directory to expand next, and whether its listing is already running.
    let mut expand: Option<(String, bool)> = Some((rel.to_string(), false));
    loop {
        if let Some((dir, started)) = expand.take() {
            if !started {
                in_flight.push(start(dir.clone()));
            }
            // List ahead: the first unstarted folders in walk order, nearest first.
            'ahead: for level in levels.iter_mut().rev() {
                while in_flight.len() < width {
                    let Some(next) = level.unstarted.pop_front() else { continue 'ahead };
                    in_flight.push(start(next));
                }
                break;
            }
            let entries = loop {
                if let Some(entries) = listed.remove(&dir) {
                    break entries;
                }
                match in_flight.next().await {
                    Some((done, entries)) => {
                        listed.insert(done, entries);
                    }
                    None => return Err(format!("the listing of '{dir}' was lost")),
                }
            }?;
            // #23 D2: a directory holding a `.git` entry of EITHER kind is somebody
            // else's repo — a nested clone, or a linked worktree, whose `.git` is a
            // *file*. Skipping the entry named `.git` (below) covers the file but
            // not the checkout around it, so a worktree inside the project used to
            // be walked and mirrored as a second full copy of the source tree. The
            // project root itself of course has one, so this is a check on *sub*
            // directories only.
            if dir.is_empty() || !entries.iter().any(|e| e.name == ".git") {
                levels.push(level_of(&dir, entries, skip_dir));
            }
        }
        let Some(level) = levels.last_mut() else { break };
        let Some(item) = level.items.pop_front() else {
            levels.pop();
            continue;
        };
        if out.len() >= cap {
            return Ok((out, true));
        }
        match item {
            Item::File(file) => out.push(file),
            Item::Dir(dir) => {
                // Started already unless it is the next unstarted folder here.
                let started = level.unstarted.front() != Some(&dir);
                if !started {
                    level.unstarted.pop_front();
                }
                expand = Some((dir, started));
            }
            Item::Inert => {}
        }
    }
    Ok((out, false))
}

/// The walkable entries of directory `dir`, in listing order.
fn level_of(dir: &str, entries: Vec<RawEntry>, skip_dir: &(dyn Fn(&str) -> bool + Sync)) -> Level {
    let mut level = Level { items: VecDeque::with_capacity(entries.len()), unstarted: VecDeque::new() };
    for entry in entries {
        // Skip Tabtivity's internal runtime dir, mirroring the local/remote listers.
        // `.git` is likewise never byte-mirrored: git state is kept in step
        // *semantically* by `services::git_peer` (lockstep), so copying its bytes
        // would fight that layer and risk corrupting a repo mid-write.
        if crate::brand::is_project_dir(&entry.name) || entry.name == ".git" {
            continue;
        }
        let child = join_rel(dir, &entry.name);
        let item = match entry.kind {
            SyncKind::Dir if !skip_dir(&child) => {
                level.unstarted.push_back(child.clone());
                Item::Dir(child)
            }
            SyncKind::File => Item::File(HostFile {
                rel: child,
                size: entry.size,
                mtime: entry.modified_secs,
                mode: entry.mode,
            }),
            // G3: symlinks and special files are never mirrored.
            SyncKind::Dir | SyncKind::Symlink | SyncKind::Other => Item::Inert,
        };
        level.items.push_back(item);
    }
    level
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    /// Tracks how many items run at once, and their weights.
    #[derive(Default)]
    struct Gauge {
        now: AtomicUsize,
        peak: AtomicUsize,
        bytes: AtomicU64,
        peak_bytes: AtomicU64,
        started: Mutex<Vec<usize>>,
    }

    impl Gauge {
        fn enter(&self, i: usize, bytes: u64) {
            let now = self.now.fetch_add(1, Ordering::SeqCst) + 1;
            self.peak.fetch_max(now, Ordering::SeqCst);
            let held = self.bytes.fetch_add(bytes, Ordering::SeqCst) + bytes;
            self.peak_bytes.fetch_max(held, Ordering::SeqCst);
            self.started.lock().unwrap().push(i);
        }
        fn leave(&self, bytes: u64) {
            self.now.fetch_sub(1, Ordering::SeqCst);
            self.bytes.fetch_sub(bytes, Ordering::SeqCst);
        }
    }

    /// Run `durations.len()` items whose item `i` takes `durations[i]` ms and
    /// weighs `weights[i]`, collecting what the receiver sees.
    async fn run(
        limits: Limits,
        durations: &[u64],
        weights: &[u64],
        gauge: &Gauge,
        halt: &AtomicBool,
        halt_after: Option<usize>,
    ) -> Vec<(usize, usize)> {
        let (drive, mut rx) = run_ordered(
            durations.len(),
            limits,
            |i| weights[i],
            || halt.load(Ordering::SeqCst),
            |i| async move {
                gauge.enter(i, weights[i]);
                tokio::time::sleep(Duration::from_millis(durations[i])).await;
                gauge.leave(weights[i]);
                if halt_after == Some(i) {
                    halt.store(true, Ordering::SeqCst);
                }
                i * 10
            },
        );
        let collect = async {
            let mut seen = Vec::new();
            while let Some(done) = rx.recv().await {
                seen.push(done);
            }
            seen
        };
        tokio::join!(drive, collect).1
    }

    /// Later items finishing first still come back in input order, and the
    /// width bounds how many run at once.
    #[tokio::test(start_paused = true)]
    async fn results_come_back_in_input_order_within_the_width() {
        let gauge = Gauge::default();
        let durations = [50, 10, 40, 5, 30, 1, 20, 2, 9, 3];
        let limits = Limits { width: 3, budget: 1000 };
        let seen = run(limits, &durations, &[1; 10], &gauge, &AtomicBool::new(false), None).await;
        let expected: Vec<(usize, usize)> = (0..10).map(|i| (i, i * 10)).collect();
        assert_eq!(seen, expected);
        assert_eq!(gauge.peak.load(Ordering::SeqCst), 3, "ran exactly as wide as allowed");
    }

    /// The overlap is real: ten 100 ms items four wide take three rounds, not ten.
    #[tokio::test(start_paused = true)]
    async fn items_overlap() {
        let gauge = Gauge::default();
        let began = tokio::time::Instant::now();
        let seen = run(Limits::TRANSFERS, &[100; 10], &[1; 10], &gauge, &AtomicBool::new(false), None).await;
        assert_eq!(seen.len(), 10);
        assert_eq!(began.elapsed(), Duration::from_millis(300));
        assert_eq!(gauge.peak.load(Ordering::SeqCst), TRANSFER_CONCURRENCY);
    }

    /// The byte budget holds while small items still run wide, and an item over
    /// the whole budget runs — alone.
    #[tokio::test(start_paused = true)]
    async fn the_byte_budget_holds_and_an_oversized_item_runs_alone() {
        let gauge = Gauge::default();
        let limits = Limits { width: 4, budget: 100 };
        //              small ×4 run wide, then 60+60 cannot share, then 500 alone, then small
        let weights = [10, 10, 10, 10, 60, 60, 500, 10, 10];
        let durations = [10; 9];
        let seen = run(limits, &durations, &weights, &gauge, &AtomicBool::new(false), None).await;
        assert_eq!(seen.iter().map(|(i, _)| *i).collect::<Vec<_>>(), (0..9).collect::<Vec<_>>());
        assert_eq!(gauge.peak.load(Ordering::SeqCst), 4, "small files still run four wide");
        // Every moment's held bytes stay within the budget, except the one item
        // larger than the budget, which must have been alone.
        let peak = gauge.peak_bytes.load(Ordering::SeqCst);
        assert_eq!(peak, 500, "the oversized item ran");
        let gauge = Gauge::default();
        let seen = run(limits, &durations, &[10, 10, 10, 10, 60, 60, 50, 10, 10], &gauge, &AtomicBool::new(false), None).await;
        assert_eq!(seen.len(), 9);
        assert!(gauge.peak_bytes.load(Ordering::SeqCst) <= 100, "{}", gauge.peak_bytes.load(Ordering::SeqCst));
    }

    /// An item larger than the budget never shares it.
    #[tokio::test(start_paused = true)]
    async fn an_oversized_item_runs_with_nothing_beside_it() {
        let limits = Limits { width: 4, budget: 100 };
        let beside = Arc::new(AtomicUsize::new(0));
        let running = Arc::new(AtomicUsize::new(0));
        let weights = [5u64, 5, 1000, 5, 5];
        let (drive, mut rx) = run_ordered(
            weights.len(),
            limits,
            |i| weights[i],
            || false,
            |i| {
                let (beside, running) = (beside.clone(), running.clone());
                async move {
                    let now = running.fetch_add(1, Ordering::SeqCst) + 1;
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    if weights[i] > limits.budget {
                        beside.store(now, Ordering::SeqCst);
                    }
                    running.fetch_sub(1, Ordering::SeqCst);
                }
            },
        );
        let collect = async { while rx.recv().await.is_some() {} };
        tokio::join!(drive, collect);
        assert_eq!(beside.load(Ordering::SeqCst), 1, "the oversized item ran alone");
    }

    /// Once the halt flag is up no new item starts; the ones in flight finish
    /// and are reported, and the never-started ones report nothing.
    #[tokio::test(start_paused = true)]
    async fn after_a_halt_no_item_starts_and_the_ones_in_flight_finish() {
        let gauge = Gauge::default();
        let halt = AtomicBool::new(false);
        // Item 1 "stalls" (finishes at 50 ms and raises the flag); 0, 2 and 3
        // started beside it and run longer; 4.. never start.
        let durations = [80, 50, 90, 70, 10, 10, 10, 10];
        let limits = Limits { width: 4, budget: 1000 };
        let seen = run(limits, &durations, &[1; 8], &gauge, &halt, Some(1)).await;
        assert_eq!(seen.iter().map(|(i, _)| *i).collect::<Vec<_>>(), vec![0, 1, 2, 3]);
        let mut started = gauge.started.lock().unwrap().clone();
        started.sort_unstable();
        assert_eq!(started, vec![0, 1, 2, 3], "nothing started after the halt");
        assert_eq!(gauge.now.load(Ordering::SeqCst), 0, "everything in flight finished");
    }

    /// An item queued for the budget when the flag goes up does not start.
    #[tokio::test(start_paused = true)]
    async fn an_item_waiting_for_the_budget_does_not_start_after_a_halt() {
        let gauge = Gauge::default();
        let halt = AtomicBool::new(false);
        let limits = Limits { width: 4, budget: 100 };
        // 0 holds the whole budget; 1 waits for it; 0 raises the flag as it ends.
        let seen = run(limits, &[20, 10, 10], &[100, 100, 1], &gauge, &halt, Some(0)).await;
        assert_eq!(seen, vec![(0, 0)]);
        assert_eq!(*gauge.started.lock().unwrap(), vec![0]);
    }

    /// The receiving half may wait on a lock the items take too (the manifest's,
    /// for a base snapshot and for a record): the driver keeps being polled while
    /// it waits, so an item queued on that lock ahead of it gets it and lets go.
    /// Had the receiver awaited outside the stream, it would wait forever behind
    /// an item nobody polls.
    #[tokio::test(start_paused = true)]
    async fn the_receiver_may_wait_on_a_lock_the_items_take() {
        let lock = tokio::sync::Mutex::new(0usize);
        let outside = lock.lock().await; // held by some other command for a moment
        let lock = &lock;
        let (drive, mut rx) = run_ordered(
            6,
            Limits { width: 3, budget: 100 },
            |_| 1,
            || false,
            |i| async move {
                if i > 0 {
                    *lock.lock().await += 1;
                }
                tokio::time::sleep(Duration::from_millis(1)).await;
                i
            },
        );
        let release = async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            drop(outside);
        };
        let collect = async {
            let mut seen = Vec::new();
            while let Some((i, _)) = rx.recv().await {
                *lock.lock().await += 1;
                seen.push(i);
            }
            seen
        };
        let all = async { tokio::join!(drive, release, collect).2 };
        let seen = tokio::time::timeout(Duration::from_secs(600), all).await.expect("no deadlock");
        assert_eq!(seen, (0..6).collect::<Vec<_>>());
        assert_eq!(*lock.lock().await, 11);
    }

    // ── The host walk ──────────────────────────────────────────────────────

    fn file(name: &str, size: u64) -> RawEntry {
        RawEntry { name: name.into(), kind: SyncKind::File, size, modified_secs: Some(size), mode: Some(0o644) }
    }
    fn dir(name: &str) -> RawEntry {
        RawEntry { name: name.into(), kind: SyncKind::Dir, size: 0, modified_secs: None, mode: None }
    }
    fn kind(name: &str, kind: SyncKind) -> RawEntry {
        RawEntry { name: name.into(), kind, size: 0, modified_secs: None, mode: None }
    }

    /// A host tree with links, a nested repo, a worktree, the runtime dir, an
    /// excluded folder and listing orders that are not sorted.
    fn tree() -> HashMap<String, Vec<RawEntry>> {
        let runtime = crate::brand::PROJECT_DIR;
        let mut t = HashMap::new();
        t.insert(String::new(), vec![
            file("z.txt", 1),
            dir("src"),
            kind(".git", SyncKind::Dir),
            kind(runtime, SyncKind::Dir),
            dir("data"),
            kind("link", SyncKind::Symlink),
            dir("nested"),
            dir("wt"),
            file("a.txt", 2),
            dir("empty"),
            kind("fifo", SyncKind::Other),
            dir("deep"),
        ]);
        t.insert("src".into(), vec![file("m.rs", 3), dir("sub"), file("b.rs", 4)]);
        t.insert("src/sub".into(), vec![file("x.rs", 5), file("y.rs", 6)]);
        t.insert("data".into(), vec![file("huge.bin", 7)]);
        t.insert("nested".into(), vec![dir(".git"), file("inner.txt", 8)]);
        t.insert("wt".into(), vec![file(".git", 9), file("dup.rs", 10)]);
        t.insert("empty".into(), vec![]);
        t.insert("deep".into(), vec![dir("d1"), file("after.txt", 11)]);
        t.insert("deep/d1".into(), vec![dir("d2"), file("d1.txt", 12)]);
        t.insert("deep/d1/d2".into(), vec![file("d2.txt", 13)]);
        t
    }

    /// The walk as it was before listings overlapped: recursive, one listing at a
    /// time. The reference the concurrent walk must equal exactly.
    fn reference(
        t: &HashMap<String, Vec<RawEntry>>,
        rel: &str,
        skip_dir: &dyn Fn(&str) -> bool,
        cap: usize,
        out: &mut Vec<HostFile>,
    ) -> Result<bool, String> {
        let entries = t.get(rel).cloned().ok_or_else(|| format!("no such dir '{rel}'"))?;
        if !rel.is_empty() && entries.iter().any(|e| e.name == ".git") {
            return Ok(false);
        }
        for entry in entries {
            if crate::brand::is_project_dir(&entry.name) || entry.name == ".git" {
                continue;
            }
            if out.len() >= cap {
                return Ok(true);
            }
            let child = join_rel(rel, &entry.name);
            match entry.kind {
                SyncKind::Dir => {
                    if !skip_dir(&child) && reference(t, &child, skip_dir, cap, out)? {
                        return Ok(true);
                    }
                }
                SyncKind::File => out.push(HostFile {
                    rel: child,
                    size: entry.size,
                    mtime: entry.modified_secs,
                    mode: entry.mode,
                }),
                SyncKind::Symlink | SyncKind::Other => {}
            }
        }
        Ok(false)
    }

    /// A lister over `t` that takes `delay(rel)` to answer and counts how many
    /// listings run at once.
    async fn walk_fake(
        t: &HashMap<String, Vec<RawEntry>>,
        rel: &str,
        skip_dir: &(dyn Fn(&str) -> bool + Sync),
        cap: usize,
        width: usize,
        gauge: &Gauge,
    ) -> Result<(Vec<HostFile>, bool), String> {
        let list = |dir: String| async move {
            gauge.enter(0, 0);
            // Deeper folders answer faster, so listings finish out of order.
            let depth = dir.matches('/').count() as u64;
            tokio::time::sleep(Duration::from_millis(40 - 10 * depth.min(3) + dir.len() as u64 % 7)).await;
            gauge.leave(0);
            t.get(&dir).cloned().ok_or_else(|| format!("no such dir '{dir}'"))
        };
        walk_listed(list, rel, skip_dir, cap, width).await
    }

    /// Every cap, every width, with and without a skipped folder, from the root
    /// and from a subfolder: the concurrent walk gives exactly the old walk's
    /// files, order and truncation flag.
    #[tokio::test(start_paused = true)]
    async fn the_concurrent_walk_equals_the_sequential_walk() {
        let t = tree();
        let skips: [&(dyn Fn(&str) -> bool + Sync); 2] = [&|_| false, &|rel| rel == "data"];
        for skip in skips {
            for rel in ["", "src", "deep"] {
                for cap in [0, 1, 2, 3, 5, 7, 9, 11, usize::MAX] {
                    let mut want = Vec::new();
                    let truncated = reference(&t, rel, skip, cap, &mut want).unwrap();
                    for width in [1, 2, 3, LIST_CONCURRENCY] {
                        let gauge = Gauge::default();
                        let got = walk_fake(&t, rel, skip, cap, width, &gauge).await.unwrap();
                        assert_eq!(got, (want.clone(), truncated), "rel {rel:?} cap {cap} width {width}");
                        assert!(got.0.len() <= cap);
                        assert!(gauge.peak.load(Ordering::SeqCst) <= width, "listings stay within the width");
                    }
                }
            }
        }
        // The rules themselves, spelled out once.
        let gauge = Gauge::default();
        let (files, truncated) = walk_fake(&t, "", &|rel| rel == "data", usize::MAX, 8, &gauge).await.unwrap();
        let names: Vec<&str> = files.iter().map(|f| f.rel.as_str()).collect();
        assert_eq!(
            names,
            ["z.txt", "src/m.rs", "src/sub/x.rs", "src/sub/y.rs", "src/b.rs", "a.txt", "deep/d1/d2/d2.txt", "deep/d1/d1.txt", "deep/after.txt"]
        );
        assert!(!truncated);
        assert!(gauge.peak.load(Ordering::SeqCst) > 1, "listings overlapped");
    }

    /// A non-root walk of a nested repo yields nothing, and the root of the
    /// project is walked although it holds `.git`.
    #[tokio::test(start_paused = true)]
    async fn a_walk_of_a_nested_repo_yields_nothing() {
        let t = tree();
        let gauge = Gauge::default();
        assert_eq!(walk_fake(&t, "nested", &|_| false, usize::MAX, 8, &gauge).await.unwrap(), (vec![], false));
        assert_eq!(walk_fake(&t, "wt", &|_| false, usize::MAX, 8, &gauge).await.unwrap(), (vec![], false));
    }

    /// A listing error fails the walk when the walk reaches that folder, and
    /// not when the folder was only listed ahead past the cap.
    #[tokio::test(start_paused = true)]
    async fn a_listing_error_fails_the_walk_only_where_the_walk_reaches() {
        let gauge = Gauge::default();
        let mut t = tree();
        t.remove("deep/d1/d2"); // listing it now errors
        let err = walk_fake(&t, "", &|_| false, usize::MAX, 8, &gauge).await.unwrap_err();
        assert!(err.contains("deep/d1/d2"), "{err}");
        // Cut short before `deep`: `deep` is listed ahead (a sibling of `src`), but
        // its error is never read, exactly as the old walk never listed it.
        let mut t = tree();
        t.remove("deep");
        let mut want = Vec::new();
        assert!(reference(&tree(), "", &|_| false, 6, &mut want).unwrap());
        let listed = Mutex::new(Vec::new());
        let list = |dir: String| {
            listed.lock().unwrap().push(dir.clone());
            let entries = t.get(&dir).cloned().ok_or_else(|| format!("no such dir '{dir}'"));
            async move {
                tokio::time::sleep(Duration::from_millis(10)).await;
                entries
            }
        };
        let got = walk_listed(list, "", &|_| false, 6, 8).await.unwrap();
        assert_eq!(got, (want, true));
        assert!(listed.lock().unwrap().iter().any(|d| d == "deep"), "the failing folder was listed ahead");
        // The root's own listing error is the walk's.
        let none: HashMap<String, Vec<RawEntry>> = HashMap::new();
        assert!(walk_fake(&none, "", &|_| false, usize::MAX, 8, &gauge).await.is_err());
    }
}
