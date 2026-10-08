//! Filesystem watcher for the side-panel file tree.
//!
//! The tree renders one directory level at a time, so we watch exactly that
//! directory (non-recursively) and emit `fs-change` whenever it changes. The
//! frontend (`FileTree.tsx`) re-fetches the listing on that event, giving live
//! updates for files created/removed by terminals, agents, or other processes.
//!
//! The folder alone misses every git change that moves the tree's markers
//! without touching a listed file — `add`, `commit`, `push`, `reset` only write
//! `.git/` — so the same watcher also follows the repo's index, `HEAD` and refs
//! ([`git_watch_paths`]), filtered down to real state changes
//! ([`is_git_state_event`]) so git merely *reading* them can't re-trigger it.
//!
//! A single watcher is active at a time (one `FileTree` is mounted for the
//! active project); `watch_dir` replaces any previous watcher, which drops and
//! unwatches it.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::event::{AccessKind, AccessMode};
use notify::{recommended_watcher, EventKind, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, State};

/// How long to coalesce a burst of raw `notify` events into a single
/// `fs-change` emit. A single write (or a `git status` touching `.git/*` while
/// the repo root is watched) fires many raw events back-to-back; without this
/// the frontend would receive a storm of `fs-change` events.
const DEBOUNCE: Duration = Duration::from_millis(200);

/// Currently-watched canonical directory, the path as the frontend spelled it
/// (the `fs-change` payload), and the live watcher. `None` when nothing is
/// being watched (panel closed / unmounted).
pub type FsWatchState = Arc<Mutex<Option<(PathBuf, String, notify::RecommendedWatcher)>>>;

pub fn new_state() -> FsWatchState {
    Arc::new(Mutex::new(None))
}

/// A ref tree bigger than this is not watched recursively (the index/`HEAD`
/// watch still covers add/commit/checkout). The refs dir is a project-folder
/// path, i.e. attacker-shaped, and `watch_dir` runs on the main thread: a
/// crafted tree of thousands of dirs must not stall the window adding watches.
const MAX_REF_DIRS: usize = 256;

/// `(git_dir, common_dir)` of the repo containing `start`, found the way git
/// finds it: the nearest ancestor holding `.git`, as a directory or as a
/// `gitdir:` file (worktrees, submodules), whose `commondir` names the shared
/// refs. Read as plain files — no git process, so no repo config runs.
fn find_git_dirs(start: &Path) -> Option<(PathBuf, PathBuf)> {
    let dot_git = start.ancestors().map(|a| a.join(".git")).find(|p| p.exists())?;
    let git_dir = if dot_git.is_dir() {
        dot_git
    } else {
        let text = std::fs::read_to_string(&dot_git).ok()?;
        let target = text.lines().find_map(|l| l.strip_prefix("gitdir:"))?.trim();
        dot_git.parent()?.join(target)
    };
    let git_dir = std::fs::canonicalize(git_dir).ok()?;
    let common = match std::fs::read_to_string(git_dir.join("commondir")) {
        Ok(rel) => std::fs::canonicalize(git_dir.join(rel.trim())).ok()?,
        Err(_) => git_dir.clone(),
    };
    Some((git_dir, common))
}

/// Whether `dir` holds at most `limit` directories (itself included), without
/// following symlinks — the walk stops as soon as it knows the answer.
fn dir_count_within(dir: &Path, limit: usize) -> bool {
    let mut stack = vec![dir.to_path_buf()];
    let mut seen = 0;
    while let Some(d) = stack.pop() {
        seen += 1;
        if seen > limit {
            return false;
        }
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                stack.push(e.path());
            }
        }
    }
    true
}

/// The git metadata to watch alongside the listed folder: the per-worktree
/// git dir (its `index` and `HEAD`: add, commit, checkout, reset) and the
/// shared one (`packed-refs`) non-recursively, plus the shared `refs/` tree
/// recursively (a commit moves `refs/heads/…`, a push `refs/remotes/…`).
fn git_watch_paths(repo_dir: &Path) -> Vec<(PathBuf, RecursiveMode)> {
    let Some((git_dir, common)) = find_git_dirs(repo_dir) else {
        return Vec::new();
    };
    let mut paths = vec![(git_dir.clone(), RecursiveMode::NonRecursive)];
    if common != git_dir {
        paths.push((common.clone(), RecursiveMode::NonRecursive));
    }
    let refs = common.join("refs");
    if refs.is_dir() && dir_count_within(&refs, MAX_REF_DIRS) {
        paths.push((refs, RecursiveMode::Recursive));
    }
    paths
}

/// An open or a read-only close — inotify (`notify` ≥ 7) reports both, and
/// neither changes anything on disk.
fn is_read_only_access(kind: &EventKind) -> bool {
    matches!(kind, EventKind::Access(a) if *a != AccessKind::Close(AccessMode::Write))
}

/// Whether a (non-read) event under a watched git dir is a state change the
/// markers follow. Lock files come and go on every write attempt (and on an
/// optional-lock refresh that ends up writing nothing); the write that matters
/// lands as a rename onto the real name, reported on its own.
fn is_git_state_event(path: &Path, git_roots: &[PathBuf]) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    if name.ends_with(".lock") {
        return false;
    }
    // Directly in a git dir only these three are state; the rest (FETCH_HEAD,
    // COMMIT_EDITMSG, logs, objects, gc droppings) either follows one of them
    // or moves nothing the tree shows. Anything deeper is under `refs/`.
    match path.parent() {
        Some(parent) if git_roots.iter().any(|r| r == parent) => {
            matches!(name, "index" | "HEAD" | "packed-refs")
        }
        _ => true,
    }
}

#[tauri::command]
pub fn watch_dir(
    app: AppHandle,
    state: State<'_, FsWatchState>,
    path: String,
    repo_dir: Option<String>,
) -> Result<(), String> {
    // Mount-free remote (Phase 2): inotify cannot see a remote (SFTP) tree, and a
    // remote project's watched dir is its non-fs mountpoint root. No-op so the
    // remote file tree just relies on manual refresh; the frontend already skips
    // watching for remote projects, this is belt-and-suspenders.
    if crate::services::remote::remote_target_for_dir(&path).is_some() {
        return Ok(());
    }
    let canonical = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;

    let mut guard = state.lock().unwrap();
    if let Some((current, spelled, _)) = guard.as_ref() {
        if *current == canonical && *spelled == path {
            return Ok(()); // already watching this directory
        }
    }

    // The payload is the path exactly as the frontend asked for it, not the
    // canonical one: a tree compares it with its own folder to ignore events
    // meant for another tree (the slot is shared by every window), and only
    // the backend can canonicalize (perf plan §3.4).
    let emit_path = path.clone();
    // Trailing-edge debounce: each raw event bumps a shared generation, and ONE
    // long-lived thread waits out `DEBOUNCE` and emits only if no newer event
    // arrived meanwhile. A burst of raw events thus collapses into a single
    // `fs-change`.
    //
    // The generation counter used to be paired with a `std::thread::spawn` *per
    // raw event*. That is fine at a handful of events and pathological at a burst:
    // an unpacking install or a recursive size walk in the watched directory turns
    // into thousands of thread spawns a second, each one only to sleep 200ms and
    // find itself outdated. One parked thread does the same job at a fixed cost.
    let generation = Arc::new(AtomicU64::new(0));
    let (tx, rx) = std::sync::mpsc::channel::<u64>();
    {
        let generation = Arc::clone(&generation);
        std::thread::spawn(move || {
            // Ends when the watcher (and with it the sender) is dropped.
            while let Ok(mut seen) = rx.recv() {
                // Greedily drain the queue to the newest generation before (and
                // after) each sleep. The previous shape slept once PER QUEUED
                // MESSAGE (recv → sleep → generation check), i.e. drained a burst
                // at 5 events/second — 600 raw events from an archive extraction
                // or a `git checkout` meant ~2 minutes with no emit, presenting
                // as "the file tree stopped updating". Draining first costs one
                // sleep per burst instead of one per event.
                loop {
                    while let Ok(newer) = rx.try_recv() {
                        seen = newer;
                    }
                    std::thread::sleep(DEBOUNCE);
                    // Only the last event of a burst still matches; anything newer
                    // means the burst is still going — drain and wait again.
                    if generation.load(Ordering::SeqCst) == seen {
                        let _ = app.emit("fs-change", &emit_path);
                        break;
                    }
                }
            }
        });
    }
    // Git state lives in the repo containing the project, not necessarily in
    // one containing the listed subfolder (a nested repo shows up in the tree
    // but is not what its markers come from).
    let git_paths = git_watch_paths(Path::new(repo_dir.as_deref().unwrap_or(&path)));
    let git_roots: Vec<PathBuf> = git_paths
        .iter()
        .filter(|(_, mode)| *mode == RecursiveMode::NonRecursive)
        .map(|(p, _)| p.clone())
        .collect();
    let listed = canonical.clone();
    let mut watcher = recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else {
            return;
        };
        // Opens and read-closes change nothing, and listing the folder (or
        // `git status` reading the index) is itself one: counting them let a
        // re-list re-trigger itself. Past that, anything in the listed folder
        // counts; under the git dirs only a state change does.
        if is_read_only_access(&event.kind) {
            return;
        }
        let relevant = event.paths.iter().any(|p| {
            p.parent() == Some(listed.as_path())
                || p == &listed
                || !git_roots.is_empty() && is_git_state_event(p, &git_roots)
        });
        if !relevant {
            return;
        }
        let my_gen = generation.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = tx.send(my_gen);
    })
    .map_err(|e| e.to_string())?;

    watcher
        .watch(&canonical, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;
    // Best-effort: a git dir that can't be watched only costs the live markers.
    for (p, mode) in &git_paths {
        let _ = watcher.watch(p, *mode);
    }

    // Replacing the stored watcher drops the previous one, unwatching it.
    *guard = Some((canonical, path, watcher));
    Ok(())
}

#[tauri::command]
pub fn unwatch_dir(state: State<'_, FsWatchState>) -> Result<(), String> {
    *state.lock().unwrap() = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, ModifyKind};

    #[test]
    fn only_state_changes_under_the_git_dir_count() {
        let git = PathBuf::from("/r/.git");
        let roots = vec![git.clone()];
        assert!(is_git_state_event(&git.join("index"), &roots));
        assert!(is_git_state_event(&git.join("HEAD"), &roots));
        assert!(is_git_state_event(&git.join("packed-refs"), &roots));
        assert!(is_git_state_event(&git.join("refs/remotes/origin/develop"), &roots));
        assert!(!is_git_state_event(&git.join("index.lock"), &roots));
        assert!(!is_git_state_event(&git.join("refs/heads/main.lock"), &roots));
        assert!(!is_git_state_event(&git.join("FETCH_HEAD"), &roots));
        assert!(!is_git_state_event(&git.join("COMMIT_EDITMSG"), &roots));
    }

    #[test]
    fn opens_and_read_closes_are_not_changes() {
        assert!(is_read_only_access(&EventKind::Access(AccessKind::Open(
            notify::event::AccessMode::Any
        ))));
        assert!(is_read_only_access(&EventKind::Access(AccessKind::Close(AccessMode::Read))));
        assert!(!is_read_only_access(&EventKind::Access(AccessKind::Close(AccessMode::Write))));
        assert!(!is_read_only_access(&EventKind::Create(CreateKind::File)));
        assert!(!is_read_only_access(&EventKind::Modify(ModifyKind::Any)));
    }

    #[test]
    fn git_dirs_resolve_through_a_worktree_gitdir_file() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let main = tmp.path().join("main/.git");
        let wt_git = main.join("worktrees/wt");
        std::fs::create_dir_all(main.join("refs/heads")).unwrap();
        std::fs::create_dir_all(&wt_git).unwrap();
        std::fs::write(wt_git.join("commondir"), "../..\n").unwrap();
        let wt = tmp.path().join("wt");
        std::fs::create_dir_all(wt.join("sub")).unwrap();
        std::fs::write(wt.join(".git"), format!("gitdir: {}\n", wt_git.display())).unwrap();

        let (git_dir, common) = find_git_dirs(&wt.join("sub")).expect("git dirs");
        assert_eq!(git_dir, std::fs::canonicalize(&wt_git).unwrap());
        assert_eq!(common, std::fs::canonicalize(&main).unwrap());
        let paths = git_watch_paths(&wt);
        assert_eq!(paths.len(), 3);
        assert_eq!(paths[2], (std::fs::canonicalize(&main).unwrap().join("refs"), RecursiveMode::Recursive));
    }

    #[test]
    fn a_huge_ref_tree_is_not_walked_past_the_cap() {
        let tmp = tempfile::tempdir().expect("tempdir");
        for i in 0..5 {
            std::fs::create_dir_all(tmp.path().join(format!("d{i}"))).unwrap();
        }
        assert!(dir_count_within(tmp.path(), 6));
        assert!(!dir_count_within(tmp.path(), 5));
    }
}
