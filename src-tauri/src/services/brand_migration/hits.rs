//! The fallback log, `<state>/legacy-hits.json`: how often a lookup found
//! something only under its old name, `{id: {count, first, last}}`.
//!
//! It answers one question — "may the old-name lookups be deleted yet?". When
//! the file has stayed empty on every machine for a while, they may.
//!
//! Hits are counted in memory and written at most once per [`FLUSH_EVERY`] per
//! process (and at once for an id seen for the first time), because some dual
//! reads sit on a poll: tmux discovery matches session names every few
//! seconds, and a state write per match would be the larger cost.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// File name under the state dir.
pub const FILE: &str = "legacy-hits.json";

/// How long counts may sit in memory before they are written.
const FLUSH_EVERY: Duration = Duration::from_secs(30);

/// One lookup's tally.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hit {
    pub count: u64,
    /// When it was first seen (ISO-8601 UTC).
    pub first: String,
    /// When it was last seen.
    pub last: String,
}

/// The whole log, by lookup id.
pub type Hits = BTreeMap<String, Hit>;

/// `<state>/legacy-hits.json`.
pub fn path_in(state_dir: &Path) -> PathBuf {
    state_dir.join(FILE)
}

/// The log as written; empty when there is none or it cannot be read.
pub fn read(path: &Path) -> Hits {
    crate::storage::read_json(path).unwrap_or_default()
}

#[derive(Default)]
struct Inner {
    /// Counts not written yet, with the first and last time seen.
    unwritten: BTreeMap<String, Hit>,
    /// Ids already written by this process.
    written: BTreeSet<String>,
    last_flush: Option<Instant>,
}

/// Counts hits in memory and writes them through to the log.
#[derive(Default)]
pub struct Buffer {
    inner: Mutex<Inner>,
}

impl Buffer {
    pub const fn new() -> Self {
        Self { inner: Mutex::new(Inner { unwritten: BTreeMap::new(), written: BTreeSet::new(), last_flush: None }) }
    }

    /// Count one hit of `id` at `now` in memory. Returns whether a write is
    /// due: the id is new to this process, or the last write is old enough.
    pub fn count(&self, id: &str, now: &str) -> bool {
        let mut inner = self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let hit = inner.unwritten.entry(id.to_string()).or_insert_with(|| Hit {
            count: 0,
            first: now.to_string(),
            last: now.to_string(),
        });
        hit.count += 1;
        hit.last = now.to_string();
        !inner.written.contains(id) || inner.last_flush.is_none_or(|at| at.elapsed() >= FLUSH_EVERY)
    }

    /// Count one hit and write when it is due.
    pub fn note(&self, path: &Path, id: &str, now: &str) {
        if self.count(id, now) {
            let _ = self.flush(path);
        }
    }

    /// Write every count still in memory. A log that exists but cannot be
    /// parsed is left alone and the counts stay in memory.
    pub fn flush(&self, path: &Path) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if inner.unwritten.is_empty() {
            return Ok(());
        }
        let unwritten = inner.unwritten.clone();
        crate::storage::patch_json(path, Hits::new(), |hits: &mut Hits| {
            for (id, add) in &unwritten {
                let hit = hits.entry(id.clone()).or_insert_with(|| Hit {
                    count: 0,
                    first: add.first.clone(),
                    last: add.last.clone(),
                });
                hit.count += add.count;
                hit.last = add.last.clone();
            }
            Ok(())
        })?;
        inner.written.extend(unwritten.into_keys());
        inner.unwritten.clear();
        inner.last_flush = Some(Instant::now());
        Ok(())
    }
}

#[cfg(not(test))]
static GLOBAL: Buffer = Buffer::new();

/// Count one hit in the running app's log. Does nothing while the brand is
/// unchanged: no lookup can hit under an old name then, and the log must not
/// appear on disk before there is a rename to observe.
#[cfg(not(test))]
pub fn record(id: &str) {
    if !crate::brand::PAIR.renamed() {
        return;
    }
    let due = GLOBAL.count(id, &crate::storage::iso_now());
    // Finding the state dir is itself a dual read and may count a hit: that
    // inner call only counts, and this one writes for both.
    if due && !WRITING.with(|writing| writing.replace(true)) {
        let _ = GLOBAL.flush(&path_in(&crate::storage::state_dir()));
        WRITING.with(|writing| writing.set(false));
    }
}

#[cfg(not(test))]
thread_local! {
    static WRITING: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Write what is still in memory; called when the app exits.
#[cfg(not(test))]
pub fn flush() {
    if crate::brand::PAIR.renamed() {
        let _ = GLOBAL.flush(&path_in(&crate::storage::state_dir()));
    }
}

/// Route `brand::legacy_hit` here. Called first thing by every entry point
/// of the binary; a second call changes nothing.
pub fn install() {
    crate::brand::set_legacy_hit_sink(record);
}

/// Under test nothing is written to the state dir: hits land in a list of the
/// calling thread, which [`taken`] hands to the test.
#[cfg(test)]
pub fn record(id: &str) {
    TEST_HITS.with(|hits| hits.borrow_mut().push(id.to_string()));
}

#[cfg(test)]
pub fn flush() {}

#[cfg(test)]
thread_local! {
    static TEST_HITS: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// The hits this test thread recorded since the last call, in order.
#[cfg(test)]
pub fn taken() -> Vec<String> {
    install();
    TEST_HITS.with(|hits| std::mem::take(&mut *hits.borrow_mut()))
}

/// [`taken`] without the hits of finding the machine's own folders. Code under
/// test that asks for the real state dir or home tree counts one on a
/// developer's machine that still has them under the old name, and none on a
/// clean one — a test of something else must not depend on which it runs on.
#[cfg(test)]
pub fn taken_here() -> Vec<String> {
    const AMBIENT: [&str; 3] = ["state-dir", "share-dir", "home-tree"];
    taken().into_iter().filter(|id| !AMBIENT.contains(&id.as_str())).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_first_hit_is_written_at_once_with_its_times() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = path_in(dir.path());
        let buffer = Buffer::new();
        buffer.note(&path, "state-dir", "2026-10-01T10:00:00+00:00");
        let hits = read(&path);
        assert_eq!(
            hits.get("state-dir"),
            Some(&Hit {
                count: 1,
                first: "2026-10-01T10:00:00+00:00".into(),
                last: "2026-10-01T10:00:00+00:00".into(),
            })
        );
    }

    #[test]
    fn repeated_hits_wait_in_memory_and_a_flush_adds_them_up() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = path_in(dir.path());
        let buffer = Buffer::new();
        buffer.note(&path, "tmux-prefix", "t1");
        buffer.note(&path, "tmux-prefix", "t2");
        buffer.note(&path, "tmux-prefix", "t3");
        // The first was written; the next two are within the flush interval.
        assert_eq!(read(&path)["tmux-prefix"].count, 1);
        buffer.flush(&path).expect("flush");
        let hit = &read(&path)["tmux-prefix"];
        assert_eq!((hit.count, hit.first.as_str(), hit.last.as_str()), (3, "t1", "t3"));
        // Nothing left: a second flush changes nothing.
        buffer.flush(&path).expect("flush");
        assert_eq!(read(&path)["tmux-prefix"].count, 3);
    }

    #[test]
    fn a_second_process_adds_to_what_the_first_wrote() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = path_in(dir.path());
        Buffer::new().note(&path, "env:TAB_UID", "t1");
        Buffer::new().note(&path, "env:TAB_UID", "t9");
        Buffer::new().note(&path, "keyring-remote", "t9");
        let hits = read(&path);
        assert_eq!(hits["env:TAB_UID"], Hit { count: 2, first: "t1".into(), last: "t9".into() });
        assert_eq!(hits["keyring-remote"].count, 1);
    }

    #[test]
    fn an_unreadable_log_is_left_alone() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = path_in(dir.path());
        std::fs::write(&path, "not json").expect("write");
        let buffer = Buffer::new();
        buffer.note(&path, "state-dir", "t1");
        assert_eq!(std::fs::read_to_string(&path).expect("read"), "not json");
        assert!(read(&path).is_empty());
    }

    #[test]
    fn the_test_sink_collects_per_thread() {
        let _ = taken();
        record("a");
        record("b");
        assert_eq!(taken(), ["a", "b"]);
        assert!(taken().is_empty());
    }
}
