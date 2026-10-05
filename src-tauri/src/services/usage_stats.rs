//! File-churn watcher behind the daily recap's "created / modified / deleted".
//!
//! A recursive `notify` watcher on the active project's root. It is deliberately
//! separate from `commands::fs_watch`, which watches exactly one directory
//! non-recursively and exists to refresh the file tree — it would see nothing of
//! what an agent does three directories down.
//!
//! Three things make the raw event stream usable as a statistic:
//!
//! 1. **Ignore rules** ([`is_ignored`]) — `.git`, `node_modules`, `target`, build
//!    output and editor scratch files. Without them a single `cargo build` would
//!    report tens of thousands of "modified files".
//! 2. **A per-path cooldown** ([`Debouncer`]) — one editor save fires a burst of
//!    raw events; a new file fires Create *and* Modify. The cooldown collapses
//!    each burst to the one event that characterises it.
//! 3. **Batched flushes** — counters accumulate in memory and reach disk every
//!    [`FLUSH_INTERVAL_SECS`], so a `git checkout` costs one file rewrite.
//!
//! **Local filesystems only.** inotify cannot see an SFTP tree, so a remote
//! project records file stats only through its local mirror (an ordinary local
//! path, watched normally). A remote project with no mirror reports nothing —
//! which the recap states, rather than showing a misleading zero.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{recommended_watcher, EventKind, RecursiveMode, Watcher};

use crate::schema::usage_stats::{metric, Counters};
use crate::storage::ROOT_SCOPE;

/// How long after counting an event for a path we ignore further events for it.
///
/// Long enough to swallow the burst from one save (and the Modify that trails a
/// Create), short enough that genuinely repeated edits — an agent rewriting the
/// same file through a task — still register separately.
const COOLDOWN: Duration = Duration::from_millis(1500);

/// How often the in-memory counters are folded into `usage_stats.json`.
const FLUSH_INTERVAL_SECS: u64 = 30;

/// Directory names whose entire subtree is ignored. These churn constantly under
/// builds and dependency installs, and none of it is work the user did.
const IGNORED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".venv",
    "venv",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    ".cargo",
    ".gradle",
    ".idea",
    "vendor",
];

/// Suffixes of editor scratch/lock files — churn that represents no real edit.
const IGNORED_SUFFIXES: &[&str] = &[".swp", ".swx", ".tmp", ".lock", "~"];

/// Whether a single directory NAME names an ignored subtree.
///
/// Exact matching against [`IGNORED_DIRS`] is not enough for virtualenvs, which
/// are named by their owner rather than by convention: `venv` and `.venv` are in
/// the list, but a second environment beside them is routinely `venv-rocm`,
/// `venv313`, `.venv-cuda`… Those are thousands of directories each, and missing
/// one does not merely cost watch churn — every write inside it is counted as
/// work the user did, so the recap's file-churn figure reports a `pip install`
/// as a day's editing. Hence the venv rule is a *shape* (a `venv`/`.venv` stem,
/// or a `-venv`/`_venv` suffix), not a fixed list.
pub fn is_ignored_dir_name(name: &str) -> bool {
    if IGNORED_DIRS.contains(&name) {
        return true;
    }
    let stem = name.strip_prefix('.').unwrap_or(name);
    stem.starts_with("venv") || name.ends_with("-venv") || name.ends_with("_venv")
}

/// Whether a path should never contribute to file-churn counts.
///
/// Pure, so every rule below is unit-tested without touching a filesystem.
pub fn is_ignored(path: &Path) -> bool {
    for component in path.components() {
        let Some(name) = component.as_os_str().to_str() else {
            continue;
        };
        if is_ignored_dir_name(name) {
            return true;
        }
    }
    let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    if IGNORED_SUFFIXES.iter().any(|s| file_name.ends_with(s)) {
        return true;
    }
    // Emacs lock files (`.#foo`) and vim's atomic-write probe file (`4913`).
    file_name.starts_with(".#") || file_name == "4913"
}

/// Map a raw `notify` event to the metric it should count, or `None` when it is
/// not a change worth counting (access, metadata-only, ignored path, …).
///
/// Pure — the watcher's whole classification is testable without a watcher.
pub fn classify_fs_event(kind: &EventKind, path: &Path) -> Option<&'static str> {
    if is_ignored(path) {
        return None;
    }
    match kind {
        EventKind::Create(_) => Some(metric::FILE_CREATED),
        EventKind::Remove(_) => Some(metric::FILE_DELETED),
        // A rename shows up as Modify(Name); count it as a modification rather
        // than inventing a create+delete pair for what the user sees as one act.
        EventKind::Modify(_) => Some(metric::FILE_MODIFIED),
        // Access / Any / Other: opening or stat-ing a file is not churn.
        _ => None,
    }
}

/// Per-path cooldown collapsing a burst of raw events into one counted event.
///
/// A save fires several Modify events; a new file fires Create then Modify. After
/// counting anything for a path we ignore that path for [`COOLDOWN`] — with one
/// exception: a **delete always counts** and clears the cooldown, so a file
/// created and immediately removed reports both, and a delete right after an edit
/// is never swallowed.
#[derive(Default)]
pub struct Debouncer {
    last: HashMap<PathBuf, Instant>,
    /// When [`Debouncer::prune`] last actually swept. `Option` because `Instant`
    /// has no `Default` and this struct derives it (built via `default()` in the
    /// watcher and every test); `None` means "never swept", so the first call runs.
    last_prune: Option<Instant>,
}

impl Debouncer {
    /// Whether this (path, metric) should be counted now. Takes `now` explicitly
    /// so the cooldown is testable without sleeping.
    pub fn should_count(&mut self, path: &Path, key: &str, now: Instant) -> bool {
        if key == metric::FILE_DELETED {
            // The file is gone: no further events can arrive for it, and any
            // cooldown left over from its creation/edits must not hide its death.
            self.last.remove(path);
            return true;
        }
        if let Some(&seen) = self.last.get(path) {
            if now.duration_since(seen) < COOLDOWN {
                return false;
            }
        }
        self.last.insert(path.to_path_buf(), now);
        true
    }

    /// Drop cooldown entries older than the window, so the map cannot grow without
    /// bound over a long session (a `git checkout` can touch thousands of distinct
    /// paths).
    ///
    /// Called after **every filesystem event** by the watcher callback, which owns
    /// this debouncer outright — not from the 30 s flush loop, which cannot reach
    /// it without a lock on the per-event path. A full `retain` per event made a
    /// burst quadratic (N events each walking a map of up to N paths), so the sweep
    /// runs at most once per [`COOLDOWN`]. That is inert for correctness —
    /// `should_count` compares timestamps itself and never trusts an entry's mere
    /// presence — and still bounds the map to roughly two windows of distinct paths.
    pub fn prune(&mut self, now: Instant) {
        if let Some(last) = self.last_prune {
            if now.duration_since(last) < COOLDOWN {
                return;
            }
        }
        self.last_prune = Some(now);
        self.last
            .retain(|_, seen| now.duration_since(*seen) < COOLDOWN);
    }
}

/// Counters observed since the last flush, keyed by project id.
type Pending = Arc<Mutex<HashMap<String, Counters>>>;

/// The live watcher (dropping it unwatches) plus what it is watching. `None` when
/// no local project is active.
struct Active {
    project_id: String,
    root: PathBuf,
    _watcher: notify::RecommendedWatcher,
}

/// Managed state: the pending counters and the single active watcher.
#[derive(Clone)]
pub struct UsageWatchState {
    pending: Pending,
    active: Arc<Mutex<Option<Active>>>,
}

pub fn new_state() -> UsageWatchState {
    UsageWatchState {
        pending: Arc::new(Mutex::new(HashMap::new())),
        active: Arc::new(Mutex::new(None)),
    }
}

impl UsageWatchState {
    /// Fold one counted event into the pending batch.
    fn bump(&self, project_id: &str, key: &str) {
        let mut pending = self.pending.lock().unwrap();
        let counters = pending.entry(project_id.to_string()).or_default();
        let slot = counters.entry(key.to_string()).or_insert(0);
        *slot = slot.saturating_add(1);
    }

    /// Take everything accumulated so far, leaving the batch empty.
    fn drain(&self) -> HashMap<String, Counters> {
        std::mem::take(&mut *self.pending.lock().unwrap())
    }
}

/// The directory whose churn should be attributed to `project_id`, or `None`
/// when there is nothing watchable.
///
/// A **remote** project's tree lives on the host and inotify cannot see it, so
/// what gets watched is its **local mirror** — an ordinary local directory — and
/// a remote project with no mirror yet is simply not watched. A **local**
/// project is watched at its own directory.
///
/// Resolved here rather than passed in by the frontend: which directory actually
/// holds a project's files is a backend fact (the mirror path is derived, not
/// stored on the project), and the frontend has no business knowing it.
///
/// The **root scope** resolves the same way, to `~/tabtivity/root`. It is not in
/// `projects.json` — it has no entry to look up and never will — so the id is
/// matched literally, exactly as `storage::project_key` and the tab-session
/// files already treat it. Without this the one scope whose whole purpose is
/// holding files that have not found a project yet was the one scope whose file
/// churn was never counted.
pub fn watch_root_for(project_id: &str) -> Option<PathBuf> {
    if project_id == ROOT_SCOPE {
        let dir = crate::storage::root_work_dir();
        return dir.is_dir().then_some(dir);
    }
    if crate::services::remote::remote_target_for(project_id).is_some() {
        let mirror = crate::services::remote_sync::mirror_dir(project_id);
        return mirror.is_dir().then_some(mirror);
    }
    let dir = crate::services::remote::project_directory(project_id)?;
    let path = PathBuf::from(dir);
    path.is_dir().then_some(path)
}

/// Attach the watch to `root`'s tree, descending it ourselves so that an ignored
/// subtree is never watched in the first place.
///
/// `RecursiveMode::Recursive` on the root would be one line, and was — but it asks
/// the kernel for one inotify watch per directory *including* the ones
/// [`is_ignored`] exists to throw away. On a real project that is not a rounding
/// error: a tree with two virtualenvs measured 8017 watches, of which ~85% were
/// venv internals whose every event was queued, delivered, woken a thread for, and
/// then discarded. Pruning here makes the kernel stop reporting what we were only
/// going to drop.
///
/// The trade-off is deliberate: a directory created *after* this pass is not
/// watched (its own creation is still seen, since its parent is). Re-watching
/// happens on the next project switch, and the payload is a usage counter — a
/// newly-created folder's churn going uncounted until then is worth the ~98%
/// reduction in watch load.
/// `excluded` additionally drops the subtrees the user excluded by hand (the file
/// tree's "Exclude from scans"), so one list governs every scan rather than the
/// size walk and the churn watcher each having their own notion of "skip this".
fn watch_pruned(
    watcher: &mut notify::RecommendedWatcher,
    root: &Path,
    excluded: &std::collections::HashSet<String>,
) {
    // (dir, project-relative path) — the rel is what the exclusion list speaks.
    let mut stack = vec![(root.to_path_buf(), String::new())];
    while let Some((dir, rel)) = stack.pop() {
        // NonRecursive: every directory gets its own watch, so files anywhere in
        // the surviving tree are still reported — only the ignored subtrees are
        // absent, which a recursive watch could not express.
        if watcher.watch(&dir, RecursiveMode::NonRecursive).is_err() {
            continue; // vanished mid-walk, or the watch limit is exhausted
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            // Never follow a symlink: a link pointing up the tree would loop, and
            // one pointing out of the project would watch someone else's files.
            if !entry.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if is_ignored_dir_name(name) {
                continue;
            }
            let child_rel = if rel.is_empty() {
                name.to_string()
            } else {
                format!("{rel}/{name}")
            };
            if excluded.contains(&child_rel) {
                continue;
            }
            stack.push((entry.path(), child_rel));
        }
    }
}

/// The user's own scan-exclusion list for `project_id` — `scan_excluded_paths` on
/// the trusted `projects.json` entry, the same list the file tree writes and the
/// size walk reads (`commands::fs::excluded_rel_set`). Never the in-folder
/// `project.json` copy, which anything working in the tree can rewrite.
fn user_excluded_dirs(project_id: &str) -> std::collections::HashSet<String> {
    let list_path = crate::storage::state_dir().join("projects.json");
    let Ok(list) = crate::storage::read_json::<crate::schema::projects::ProjectsList>(&list_path)
    else {
        return Default::default();
    };
    let list: Vec<String> = list
        .iter()
        .find(|e| e.id == project_id)
        .and_then(|e| e.extra.get("scan_excluded_paths"))
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    crate::commands::fs::excluded_rel_set(&list)
}

/// Watch `project_id`'s tree (recursively), replacing any previous watch. An
/// empty id — or a project with nothing watchable — just stops watching.
///
/// One watcher at a time: the recap counts what you are working on, and watching
/// every project a user has ever opened would mean an inotify tree per project.
pub fn watch_project(state: &UsageWatchState, project_id: &str) -> Result<(), String> {
    let mut guard = state.active.lock().unwrap();

    let Some(root) = (!project_id.is_empty())
        .then(|| watch_root_for(project_id))
        .flatten()
    else {
        *guard = None; // dropping the watcher unwatches
        return Ok(());
    };

    let canonical = std::fs::canonicalize(&root).map_err(|e| e.to_string())?;
    if let Some(active) = guard.as_ref() {
        if active.root == canonical && active.project_id == project_id {
            return Ok(()); // already watching exactly this
        }
    }

    let owner = project_id.to_string();
    let state_for_cb = state.clone();
    let mut debouncer = Debouncer::default();

    let mut watcher = recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        let now = Instant::now();
        for path in &event.paths {
            let Some(key) = classify_fs_event(&event.kind, path) else {
                continue;
            };
            if debouncer.should_count(path, key, now) {
                state_for_cb.bump(&owner, key);
            }
        }
        debouncer.prune(now);
    })
    .map_err(|e| e.to_string())?;

    watch_pruned(&mut watcher, &canonical, &user_excluded_dirs(project_id));

    // Replacing the stored watcher drops the previous one, unwatching it.
    *guard = Some(Active {
        project_id: project_id.to_string(),
        root: canonical,
        _watcher: watcher,
    });
    Ok(())
}

/// Start the periodic flush of watched churn into `usage_stats.json`. One
/// detached task for the life of the process.
pub fn start(state: UsageWatchState) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(FLUSH_INTERVAL_SECS)).await;
            let batch = state.drain();
            if batch.is_empty() {
                continue;
            }
            // The store is a read-modify-write of a JSON file: keep it off the
            // async runtime's worker.
            let _ = tokio::task::spawn_blocking(move || {
                for (project_id, counters) in batch {
                    if let Err(error) = crate::schema::usage_stats::record(&project_id, &counters) {
                        eprintln!("usage_stats: record watcher counters: {error}");
                    }
                }
            })
            .await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, DataChange, ModifyKind, RemoveKind};

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    // ── watch_root_for ─────────────────────────────────────────────────────

    /// The root scope is watched at `~/tabtivity/root`, like a local project is
    /// watched at its own directory. It is in no project list, so it can only
    /// be matched literally — before the lookup, which would answer `None` and
    /// leave the one scope built for files-without-a-project uncounted.
    ///
    /// Asserts WHICH path is named, never `Some`/`None`: whether that directory
    /// exists is a property of the machine running the test, and the `is_dir`
    /// guard is the same one both project branches apply.
    #[test]
    fn the_root_scope_is_watched_at_the_root_work_dir() {
        match watch_root_for(ROOT_SCOPE) {
            Some(dir) => assert_eq!(dir, crate::storage::root_work_dir()),
            None => assert!(
                !crate::storage::root_work_dir().is_dir(),
                "root work dir exists but was not offered for watching"
            ),
        }
    }

    // ── is_ignored ─────────────────────────────────────────────────────────

    #[test]
    fn ordinary_source_files_are_not_ignored() {
        assert!(!is_ignored(&p("/home/me/proj/src/lib.rs")));
        assert!(!is_ignored(&p("/home/me/proj/README.md")));
        // A dotted directory that is NOT in the list must still count — .github
        // workflows are real work.
        assert!(!is_ignored(&p("/home/me/proj/.github/workflows/ci.yml")));
    }

    #[test]
    fn build_and_vcs_subtrees_are_ignored() {
        // Without these one `cargo build` would report tens of thousands of
        // "modified files" and swamp every real edit.
        assert!(is_ignored(&p("/home/me/proj/.git/index")));
        assert!(is_ignored(&p("/home/me/proj/target/debug/build/x.o")));
        assert!(is_ignored(&p("/home/me/proj/node_modules/react/index.js")));
        assert!(is_ignored(&p("/home/me/proj/dist/bundle.js")));
        assert!(is_ignored(&p("/home/me/proj/__pycache__/mod.pyc")));
    }

    #[test]
    fn ignored_dir_matches_at_any_depth() {
        assert!(is_ignored(&p("/a/b/c/node_modules/d/e/f.js")));
        assert!(is_ignored(&p("/a/node_modules/b/node_modules/c.js")));
    }

    #[test]
    fn virtualenvs_are_ignored_by_shape_not_by_exact_name() {
        // A venv is named by its owner, so an exact-name list only ever catches the
        // first one. A measured project carried `venv` AND `venv-rocm` side by side:
        // the second slipped through, and every `pip install` inside it was counted
        // as the user's own file churn.
        assert!(is_ignored(&p("/home/me/proj/venv/lib/python3.12/site.py")));
        assert!(is_ignored(&p(
            "/home/me/proj/venv-rocm/lib/python3.12/site.py"
        )));
        assert!(is_ignored(&p("/home/me/proj/.venv-cuda/bin/python")));
        assert!(is_ignored(&p("/home/me/proj/venv313/bin/python")));
        assert!(is_ignored(&p("/home/me/proj/project_venv/bin/python")));
        assert!(is_ignored(&p("/home/me/proj/api-venv/bin/python")));
        // …but the shape must not swallow ordinary source directories that merely
        // start with the same letters.
        assert!(!is_ignored(&p("/home/me/proj/vendored_ui/main.ts")));
        assert!(!is_ignored(&p("/home/me/proj/environments/prod.yaml")));
        assert!(!is_ignored(&p("/home/me/proj/ven/notes.md")));
    }

    #[test]
    fn a_file_merely_named_like_an_ignored_dir_is_not_ignored() {
        // "target" as a *file* is source, not a build directory.
        assert!(!is_ignored(&p("/home/me/proj/src/target.rs")));
        assert!(!is_ignored(&p("/home/me/proj/build.rs")));
    }

    #[test]
    fn editor_scratch_files_are_ignored() {
        assert!(is_ignored(&p("/proj/.lib.rs.swp")));
        assert!(is_ignored(&p("/proj/lib.rs~")));
        assert!(is_ignored(&p("/proj/.#lib.rs")));
        assert!(is_ignored(&p("/proj/4913"))); // vim's atomic-write probe
        assert!(is_ignored(&p("/proj/Cargo.lock")));
    }

    // ── classify_fs_event ──────────────────────────────────────────────────

    #[test]
    fn create_modify_remove_map_to_their_metrics() {
        let path = p("/proj/src/lib.rs");
        assert_eq!(
            classify_fs_event(&EventKind::Create(CreateKind::File), &path),
            Some(metric::FILE_CREATED)
        );
        assert_eq!(
            classify_fs_event(
                &EventKind::Modify(ModifyKind::Data(DataChange::Content)),
                &path
            ),
            Some(metric::FILE_MODIFIED)
        );
        assert_eq!(
            classify_fs_event(&EventKind::Remove(RemoveKind::File), &path),
            Some(metric::FILE_DELETED)
        );
    }

    #[test]
    fn access_events_are_not_churn() {
        // Reading a file is not work done to it — an agent grepping the tree must
        // not read as thousands of modifications.
        let path = p("/proj/src/lib.rs");
        assert_eq!(
            classify_fs_event(&EventKind::Access(notify::event::AccessKind::Read), &path),
            None
        );
    }

    #[test]
    fn events_on_ignored_paths_classify_to_nothing() {
        assert_eq!(
            classify_fs_event(
                &EventKind::Modify(ModifyKind::Data(DataChange::Content)),
                &p("/proj/target/debug/x.o")
            ),
            None
        );
    }

    // ── Debouncer ──────────────────────────────────────────────────────────

    #[test]
    fn a_burst_of_modifies_on_one_path_counts_once() {
        let mut d = Debouncer::default();
        let path = p("/proj/a.rs");
        let t0 = Instant::now();
        assert!(d.should_count(&path, metric::FILE_MODIFIED, t0));
        // One editor save fires several raw Modify events back to back.
        assert!(!d.should_count(&path, metric::FILE_MODIFIED, t0 + Duration::from_millis(5)));
        assert!(!d.should_count(
            &path,
            metric::FILE_MODIFIED,
            t0 + Duration::from_millis(300)
        ));
    }

    #[test]
    fn a_new_file_counts_as_created_not_created_plus_modified() {
        let mut d = Debouncer::default();
        let path = p("/proj/new.rs");
        let t0 = Instant::now();
        assert!(d.should_count(&path, metric::FILE_CREATED, t0));
        // Create is immediately followed by the Modify that writes the content.
        assert!(!d.should_count(&path, metric::FILE_MODIFIED, t0 + Duration::from_millis(10)));
    }

    #[test]
    fn edits_further_apart_than_the_cooldown_count_separately() {
        let mut d = Debouncer::default();
        let path = p("/proj/a.rs");
        let t0 = Instant::now();
        assert!(d.should_count(&path, metric::FILE_MODIFIED, t0));
        assert!(d.should_count(&path, metric::FILE_MODIFIED, t0 + COOLDOWN));
    }

    #[test]
    fn a_delete_always_counts_even_inside_the_cooldown() {
        // Otherwise a file edited and then removed would report only the edit.
        let mut d = Debouncer::default();
        let path = p("/proj/a.rs");
        let t0 = Instant::now();
        assert!(d.should_count(&path, metric::FILE_MODIFIED, t0));
        assert!(d.should_count(&path, metric::FILE_DELETED, t0 + Duration::from_millis(10)));
    }

    #[test]
    fn a_delete_clears_the_cooldown_so_a_recreate_counts() {
        let mut d = Debouncer::default();
        let path = p("/proj/a.rs");
        let t0 = Instant::now();
        assert!(d.should_count(&path, metric::FILE_CREATED, t0));
        assert!(d.should_count(&path, metric::FILE_DELETED, t0 + Duration::from_millis(10)));
        assert!(d.should_count(&path, metric::FILE_CREATED, t0 + Duration::from_millis(20)));
    }

    #[test]
    fn distinct_paths_do_not_share_a_cooldown() {
        let mut d = Debouncer::default();
        let t0 = Instant::now();
        assert!(d.should_count(&p("/proj/a.rs"), metric::FILE_MODIFIED, t0));
        assert!(d.should_count(&p("/proj/b.rs"), metric::FILE_MODIFIED, t0));
    }

    #[test]
    fn prune_drops_expired_entries_so_the_map_stays_bounded() {
        let mut d = Debouncer::default();
        let t0 = Instant::now();
        for i in 0..100 {
            d.should_count(&p(&format!("/proj/f{i}.rs")), metric::FILE_MODIFIED, t0);
        }
        assert_eq!(d.last.len(), 100);
        d.prune(t0 + COOLDOWN);
        assert!(d.last.is_empty(), "expired cooldowns must not accumulate");
    }

    // ── pending accumulator ────────────────────────────────────────────────

    #[test]
    fn bump_accumulates_and_drain_empties() {
        let state = new_state();
        state.bump("p1", metric::FILE_MODIFIED);
        state.bump("p1", metric::FILE_MODIFIED);
        state.bump("p1", metric::FILE_CREATED);
        state.bump("p2", metric::FILE_DELETED);

        let batch = state.drain();
        assert_eq!(batch["p1"][metric::FILE_MODIFIED], 2);
        assert_eq!(batch["p1"][metric::FILE_CREATED], 1);
        assert_eq!(batch["p2"][metric::FILE_DELETED], 1);

        // A drained batch must not be re-counted on the next flush.
        assert!(state.drain().is_empty());
    }
}
