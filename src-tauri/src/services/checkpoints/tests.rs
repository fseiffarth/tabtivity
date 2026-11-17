use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use super::restore::{plain_path, restore, since};
use super::snapshot::{snapshot, stage_with, Limits, Who};
use super::store::{Kind, Row, Store};
use super::worker::{Job, Queues, Runner};
use super::*;
use crate::services::agent_turn::TurnState;
#[cfg(unix)]
use crate::test_util::git;
use crate::test_util::init_repo;

struct Fixture {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    folder: PathBuf,
}

fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("checkpoints");
    let folder = tmp.path().join("proj");
    std::fs::create_dir_all(&folder).unwrap();
    let folder = folder.canonicalize().unwrap();
    Fixture { root, folder, _tmp: tmp }
}

fn who(uid: &str) -> Who {
    Who { tab_uid: uid.into(), cli: "claude".into(), project_id: Some("p1".into()), ..Who::default() }
}

fn put(folder: &Path, rel: &str, text: &str) {
    let path = folder.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn read(folder: &Path, rel: &str) -> Option<String> {
    std::fs::read_to_string(folder.join(rel)).ok()
}

fn snap(fx: &Fixture, kind: Kind, uid: &str) -> Row {
    // Ids and ordering are by the millisecond.
    std::thread::sleep(Duration::from_millis(3));
    snapshot(&fx.root, &fx.folder, kind, &who(uid), None).unwrap()
}

fn store(fx: &Fixture) -> Store {
    Store::for_folder(&fx.root, &fx.folder).unwrap()
}

/// The paths of a snapshot's tree.
fn tree_paths(store: &Store, row: &Row) -> Vec<String> {
    let out = store.run_ok(&["ls-tree", "-r", "--name-only", "-z", &row.tree], None, 1 << 20).unwrap();
    String::from_utf8_lossy(&out).split('\0').filter(|s| !s.is_empty()).map(str::to_string).collect()
}

fn blob(store: &Store, row: &Row, rel: &str) -> Vec<u8> {
    store.run_ok(&["cat-file", "blob", &format!("{}:{rel}", row.commit)], None, 1 << 24).unwrap()
}

// ── Snapshot ─────────────────────────────────────────────────────────────

#[test]
fn a_snapshot_captures_new_modified_and_deleted_files_in_a_folder_that_is_not_a_repo() {
    let fx = fixture();
    put(&fx.folder, "a.txt", "one");
    put(&fx.folder, "b.txt", "two");
    put(&fx.folder, "sub/c.txt", "three");
    let first = snap(&fx, Kind::Pre, "t1");
    let st = store(&fx);
    assert_eq!(tree_paths(&st, &first), ["a.txt", "b.txt", "sub/c.txt"]);
    assert_eq!(blob(&st, &first, "a.txt"), b"one");

    put(&fx.folder, "a.txt", "one, edited");
    std::fs::remove_file(fx.folder.join("b.txt")).unwrap();
    put(&fx.folder, "d.txt", "four");
    let second = snap(&fx, Kind::Post, "t1");
    assert_ne!(first.tree, second.tree);
    assert_eq!(tree_paths(&st, &second), ["a.txt", "d.txt", "sub/c.txt"]);
    assert_eq!(blob(&st, &second, "a.txt"), b"one, edited");
    // The first one still holds the old bytes.
    assert_eq!(blob(&st, &first, "b.txt"), b"two");
    assert_eq!(st.rows().len(), 2);
}

#[test]
fn a_snapshot_with_nothing_new_reuses_the_commit_and_still_logs_a_row() {
    let fx = fixture();
    put(&fx.folder, "a.txt", "one");
    let first = snap(&fx, Kind::Pre, "t1");
    let second = snap(&fx, Kind::Post, "t1");
    assert_eq!(first.commit, second.commit);
    assert_eq!(first.tree, second.tree);
    assert_ne!(first.id, second.id);
    let st = store(&fx);
    // Each row keeps the (shared) commit alive under its own ref.
    let refs = st.text(&["for-each-ref", "--format=%(refname)", "refs/ckpt/"]).unwrap();
    assert_eq!(refs.lines().count(), 2, "{refs}");
}

#[test]
fn ignored_files_are_neither_captured_nor_the_repos_own_git_dir() {
    let fx = fixture();
    init_repo(&fx.folder);
    put(&fx.folder, ".gitignore", "build/\n*.log\n");
    put(&fx.folder, ".git/info/exclude", "secret.txt\n");
    put(&fx.folder, "src/main.rs", "fn main() {}");
    put(&fx.folder, "build/out.bin", "x");
    put(&fx.folder, "debug.log", "x");
    put(&fx.folder, "secret.txt", "x");
    put(&fx.folder, "kept.txt", "x");
    let row = snap(&fx, Kind::Manual, "t1");
    let paths = tree_paths(&store(&fx), &row);
    assert_eq!(paths, [".gitignore", "kept.txt", "src/main.rs"], "{paths:?}");
}

#[test]
fn linked_worktrees_nested_in_the_root_are_their_own_folders() {
    let fx = fixture();
    put(&fx.folder, "a.txt", "one");
    let worktrees = crate::brand::WORKTREES_DIR.split('/').fold(fx.folder.clone(), |p, seg| p.join(seg));
    std::fs::create_dir_all(worktrees.join("feat")).unwrap();
    put(&worktrees, "feat/inner.txt", "x");
    let row = snap(&fx, Kind::Manual, "t1");
    assert_eq!(tree_paths(&store(&fx), &row), ["a.txt"]);
}

#[test]
fn a_file_over_the_cap_is_left_out_and_named() {
    let fx = fixture();
    put(&fx.folder, "small.txt", "x");
    put(&fx.folder, "big.bin", &"y".repeat(5000));
    let st = store(&fx);
    std::fs::create_dir_all(&st.dir).unwrap();
    let _lock = st.lock().unwrap();
    st.ensure(None).unwrap();
    let staged = stage_with(&st, None, Limits { max_file: 1000, budget: u64::MAX }).unwrap();
    assert_eq!(staged.skipped.len(), 1);
    assert_eq!((staged.skipped[0].path.as_str(), staged.skipped[0].reason.as_str(), staged.skipped[0].bytes), ("big.bin", "size", 5000));
    let listed = st.text(&["ls-tree", "-r", "--name-only", &staged.tree]).unwrap();
    assert_eq!(listed, "small.txt");
    assert!(!staged.partial);
}

#[test]
fn a_file_that_grows_past_the_cap_drops_out_of_the_next_snapshot() {
    let fx = fixture();
    put(&fx.folder, "log.txt", "short");
    let first = snap(&fx, Kind::Manual, "t1");
    assert_eq!(tree_paths(&store(&fx), &first), ["log.txt"]);
    put(&fx.folder, "log.txt", &"z".repeat(3000));
    let st = store(&fx);
    let _lock = st.lock().unwrap();
    let staged = stage_with(&st, None, Limits { max_file: 1000, budget: u64::MAX }).unwrap();
    assert!(staged.skipped.iter().any(|s| s.path == "log.txt" && s.reason == "size"));
    assert_eq!(st.text(&["ls-tree", "-r", "--name-only", &staged.tree]).unwrap(), "");
}

#[test]
fn new_bytes_past_the_budget_leave_out_the_largest_and_mark_the_snapshot_partial() {
    let fx = fixture();
    put(&fx.folder, "tiny.txt", &"a".repeat(10));
    put(&fx.folder, "mid.txt", &"b".repeat(100));
    put(&fx.folder, "huge.txt", &"c".repeat(900));
    let st = store(&fx);
    let _lock = st.lock().unwrap();
    st.ensure(None).unwrap();
    let staged = stage_with(&st, None, Limits { max_file: 10_000, budget: 500 }).unwrap();
    assert!(staged.partial);
    assert_eq!(staged.skipped.iter().map(|s| (s.path.as_str(), s.reason.as_str())).collect::<Vec<_>>(), [("huge.txt", "budget")]);
    let listed = st.text(&["ls-tree", "-r", "--name-only", &staged.tree]).unwrap();
    assert_eq!(listed.lines().collect::<Vec<_>>(), ["mid.txt", "tiny.txt"]);
}

#[test]
fn the_byte_exact_file_is_stored_whatever_the_attributes_say() {
    let fx = fixture();
    put(&fx.folder, ".gitattributes", "* text eol=lf\n*.dat -text ident\n");
    put(&fx.folder, "crlf.txt", "a\r\nb\r\n");
    put(&fx.folder, "id.dat", "$Id$\n");
    let row = snap(&fx, Kind::Manual, "t1");
    let st = store(&fx);
    assert_eq!(blob(&st, &row, "crlf.txt"), b"a\r\nb\r\n");
    assert_eq!(blob(&st, &row, "id.dat"), b"$Id$\n");
}

/// A script that records it ran, as a filter, hook or fsmonitor program.
#[cfg(unix)]
fn marker_script(dir: &Path, name: &str, marker: &Path) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let script = dir.join(name);
    std::fs::write(&script, format!("#!/bin/sh\ntouch '{}'\ncat\n", marker.display())).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    script
}

#[cfg(unix)]
#[test]
fn nothing_the_folders_own_repo_names_runs_during_a_snapshot() {
    let fx = fixture();
    init_repo(&fx.folder);
    let scripts = fx.folder.parent().unwrap().join("scripts");
    std::fs::create_dir_all(&scripts).unwrap();
    let marker = scripts.join("ran");
    let filter = marker_script(&scripts, "filter.sh", &marker);
    git(&fx.folder, &["config", "filter.evil.clean", &filter.display().to_string()]);
    git(&fx.folder, &["config", "filter.evil.smudge", &filter.display().to_string()]);
    git(&fx.folder, &["config", "core.fsmonitor", &filter.display().to_string()]);
    git(&fx.folder, &["config", "core.hooksPath", &scripts.display().to_string()]);
    git(&fx.folder, &["config", "diff.evil.textconv", &filter.display().to_string()]);
    marker_script(&fx.folder.join(".git/hooks"), "post-index-change", &marker);
    marker_script(&scripts, "post-index-change", &marker);
    put(&fx.folder, ".gitattributes", "* filter=evil diff=evil\n");
    put(&fx.folder, "a.txt", "payload");

    // The control: git as the folder's config reads it does run them.
    let control = crate::test_util::git_output(&fx.folder, &["add", "-A"]);
    assert!(control.status.success());
    assert!(marker.exists(), "the control shows the filter would run");
    std::fs::remove_file(&marker).unwrap();

    let first = snap(&fx, Kind::Pre, "t1");
    put(&fx.folder, "a.txt", "payload, edited");
    let second = snap(&fx, Kind::Post, "t1");
    assert!(!marker.exists(), "the folder's filter, fsmonitor or hook ran");
    let st = store(&fx);
    assert_eq!(blob(&st, &first, "a.txt"), b"payload");
    assert_eq!(blob(&st, &second, "a.txt"), b"payload, edited");
    // And the diff path.
    let _ = since(&st, &first, &who("t1"), None).unwrap();
    assert!(!marker.exists());
}

/// A global config naming a filter (Git LFS's shape) is not read by a
/// checkpoint call: with `HOME` pointed at one, the builder's pin wins.
#[cfg(unix)]
#[test]
fn the_users_global_config_is_not_read() {
    let fx = fixture();
    let home = fx.folder.parent().unwrap().join("home");
    std::fs::create_dir_all(&home).unwrap();
    let marker = home.join("ran");
    let filter = marker_script(&home, "filter.sh", &marker);
    let config = format!(
        "[filter \"evil\"]\n\tclean = {0}\n\tsmudge = {0}\n[core]\n\tfsmonitor = {0}\n",
        filter.display()
    );
    std::fs::write(home.join(".gitconfig"), &config).unwrap();
    put(&fx.folder, ".gitattributes", "* filter=evil\n");
    put(&fx.folder, "a.txt", "payload");

    let st = store(&fx);
    std::fs::create_dir_all(&st.dir).unwrap();
    let _lock = st.lock().unwrap();
    st.ensure(None).unwrap();

    // Control: plain git with the same HOME does run the filter.
    let control = fx.folder.parent().unwrap().join("control");
    std::fs::create_dir_all(&control).unwrap();
    init_repo(&control);
    put(&control, ".gitattributes", "* filter=evil\n");
    put(&control, "a.txt", "payload");
    let ran = crate::paths::command_no_window("git")
        .args(["add", "-A"])
        .current_dir(&control)
        .env("HOME", &home)
        .env("XDG_CONFIG_HOME", &home)
        .env_remove("GIT_CONFIG_GLOBAL")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(ran.status.success(), "{}", String::from_utf8_lossy(&ran.stderr));
    assert!(marker.exists(), "the control shows the global filter would run");
    std::fs::remove_file(&marker).unwrap();

    let mut add = st.git(&["add", "-A"]);
    add.env("HOME", &home).env("XDG_CONFIG_HOME", &home);
    let out = add.output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert!(!marker.exists(), "the global config's filter ran");

    // The environment the builder pins.
    let cmd = st.git(&["status"]);
    let envs: std::collections::HashMap<_, _> = cmd
        .get_envs()
        .filter_map(|(k, v)| Some((k.to_string_lossy().into_owned(), v?.to_string_lossy().into_owned())))
        .collect();
    assert_eq!(envs.get("GIT_CONFIG_NOSYSTEM").map(String::as_str), Some("1"));
    assert_eq!(envs.get("GIT_CONFIG_GLOBAL").map(String::as_str), Some(crate::services::git_hardened::NULL_DEVICE));
    assert_eq!(envs.get("GIT_DIR").map(String::as_str), Some(crate::paths::display_path(&st.git_dir()).as_str()));
    assert!(cmd.get_args().any(|a| a == "core.fsmonitor=false"));
    assert!(cmd.get_args().any(|a| a == "core.hooksPath="));
}

#[test]
fn the_null_device_is_the_platforms_own() {
    assert_eq!(crate::services::git_hardened::NULL_DEVICE, if cfg!(windows) { "NUL" } else { "/dev/null" });
}

#[cfg(unix)]
#[test]
fn a_symlink_is_stored_as_a_link_and_never_followed() {
    let fx = fixture();
    let outside = fx.folder.parent().unwrap().join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("secret.txt"), "do not copy").unwrap();
    std::os::unix::fs::symlink(&outside, fx.folder.join("out")).unwrap();
    std::os::unix::fs::symlink("a.txt", fx.folder.join("rel")).unwrap();
    put(&fx.folder, "a.txt", "one");
    let row = snap(&fx, Kind::Manual, "t1");
    let st = store(&fx);
    assert_eq!(tree_paths(&st, &row), ["a.txt", "out", "rel"]);
    assert_eq!(blob(&st, &row, "out"), outside.display().to_string().as_bytes());
    let modes = st.text(&["ls-tree", &row.tree]).unwrap();
    assert_eq!(modes.matches("120000").count(), 2, "{modes}");
}

#[cfg(unix)]
#[test]
fn a_named_pipe_in_the_folder_is_never_read_and_does_not_stop_the_snapshot() {
    let fx = fixture();
    put(&fx.folder, "a.txt", "one");
    assert!(std::process::Command::new("mkfifo").arg(fx.folder.join("pipe")).status().unwrap().success());
    let st = store(&fx);
    std::fs::create_dir_all(&st.dir).unwrap();
    let _lock = st.lock().unwrap();
    st.ensure(None).unwrap();
    let staged = stage_with(&st, None, Limits::default()).unwrap();
    // git itself passes over a pipe when it walks the folder; it is never read.
    assert!(staged.skipped.is_empty(), "{:?}", staged.skipped);
    assert_eq!(st.text(&["ls-tree", "-r", "--name-only", &staged.tree]).unwrap(), "a.txt");
}

#[cfg(unix)]
#[test]
fn a_nested_repo_is_a_gitlink_and_nothing_it_names_runs() {
    let fx = fixture();
    put(&fx.folder, "a.txt", "one");
    let inner = fx.folder.join("inner");
    std::fs::create_dir_all(&inner).unwrap();
    init_repo(&inner);
    put(&inner, "f.txt", "inner file");
    git(&inner, &["add", "-A"]);
    git(&inner, &["commit", "-q", "-m", "c"]);
    let marker = fx.folder.parent().unwrap().join("ran");
    let hook = marker_script(fx.folder.parent().unwrap(), "fsmon.sh", &marker);
    git(&inner, &["config", "core.fsmonitor", &hook.display().to_string()]);
    git(&inner, &["config", "filter.evil.clean", &hook.display().to_string()]);

    let row = snap(&fx, Kind::Manual, "t1");
    let st = store(&fx);
    assert_eq!(tree_paths(&st, &row), ["a.txt", "inner"]);
    assert!(st.text(&["ls-tree", &row.tree, "inner"]).unwrap().starts_with("160000"));
    assert_eq!(row.nested, ["inner"]);
    // Later snapshots still say so (the gitlink is tracked by then).
    assert_eq!(snap(&fx, Kind::Post, "t1").nested, ["inner"]);
    assert!(!marker.exists());
}

#[test]
fn a_pre_snapshot_is_raced_when_a_file_is_newer_than_the_prompt() {
    let fx = fixture();
    put(&fx.folder, "a.txt", "one");
    let now = crate::clock::now_ms();
    let far_future = snapshot(&fx.root, &fx.folder, Kind::Pre, &who("t1"), Some(now + 3_600_000)).unwrap();
    assert!(!far_future.raced);
    let long_ago = snapshot(&fx.root, &fx.folder, Kind::Pre, &who("t1"), Some(now - 3_600_000)).unwrap();
    assert!(long_ago.raced);
    // Only a pre-snapshot is compared.
    let post = snapshot(&fx.root, &fx.folder, Kind::Post, &who("t1"), Some(now - 3_600_000)).unwrap();
    assert!(!post.raced);
}

// ── Restore ──────────────────────────────────────────────────────────────

#[test]
fn restore_puts_back_modified_and_deleted_files_and_removes_added_ones() {
    let fx = fixture();
    put(&fx.folder, "a.txt", "one");
    put(&fx.folder, "b.txt", "two");
    put(&fx.folder, "sub/c.txt", "three");
    let ckpt = snap(&fx, Kind::Pre, "t1");

    put(&fx.folder, "a.txt", "one, edited");
    std::fs::remove_file(fx.folder.join("b.txt")).unwrap();
    put(&fx.folder, "new.txt", "new");
    put(&fx.folder, "sub/new2.txt", "new2");

    let st = store(&fx);
    let diff = since(&st, &ckpt, &who("t1"), None).unwrap();
    let mut seen: Vec<_> = diff.files.iter().map(|f| (f.path.as_str(), f.status)).collect();
    seen.sort();
    assert_eq!(seen, [("a.txt", 'M'), ("b.txt", 'D'), ("new.txt", 'A'), ("sub/new2.txt", 'A')]);
    let a = diff.files.iter().find(|f| f.path == "a.txt").unwrap();
    assert!(a.diff.as_deref().is_some_and(|d| d.contains("-one") && d.contains("+one, edited")));
    assert_eq!((a.added, a.removed), (Some(1), Some(1)));

    let done = restore(&st, &ckpt, &who("t1"), None).unwrap();
    assert_eq!((done.restored, done.removed), (2, 2), "{:?}", done.failed);
    assert!(done.failed.is_empty());
    assert_eq!(read(&fx.folder, "a.txt").as_deref(), Some("one"));
    assert_eq!(read(&fx.folder, "b.txt").as_deref(), Some("two"));
    assert_eq!(read(&fx.folder, "new.txt"), None);
    assert_eq!(read(&fx.folder, "sub/new2.txt"), None);
    assert_eq!(read(&fx.folder, "sub/c.txt").as_deref(), Some("three"));
    // Nothing differs any more.
    assert!(since(&st, &ckpt, &who("t1"), None).unwrap().files.is_empty());
}

#[test]
fn undo_restore_round_trips() {
    let fx = fixture();
    put(&fx.folder, "a.txt", "one");
    put(&fx.folder, "b.txt", "two");
    let ckpt = snap(&fx, Kind::Pre, "t1");
    put(&fx.folder, "a.txt", "edited");
    std::fs::remove_file(fx.folder.join("b.txt")).unwrap();
    put(&fx.folder, "c.txt", "created");

    let st = store(&fx);
    let done = restore(&st, &ckpt, &who("t1"), None).unwrap();
    assert_eq!(read(&fx.folder, "a.txt").as_deref(), Some("one"));
    let undo = st.row(&done.undo_id).unwrap();
    assert_eq!(undo.kind, Kind::PreRestore);

    let back = restore(&st, &undo, &who("t1"), None).unwrap();
    assert!(back.failed.is_empty(), "{:?}", back.failed);
    assert_eq!(read(&fx.folder, "a.txt").as_deref(), Some("edited"));
    assert_eq!(read(&fx.folder, "b.txt"), None);
    assert_eq!(read(&fx.folder, "c.txt").as_deref(), Some("created"));
    // Both restores are in the log, each with its own way back.
    let restores = st.rows().into_iter().filter(|r| r.kind == Kind::Restore).count();
    assert_eq!(restores, 2);
}

#[test]
fn a_restore_of_chosen_paths_leaves_the_rest_alone() {
    let fx = fixture();
    put(&fx.folder, "a.txt", "one");
    put(&fx.folder, "b.txt", "two");
    let ckpt = snap(&fx, Kind::Pre, "t1");
    put(&fx.folder, "a.txt", "edited a");
    put(&fx.folder, "b.txt", "edited b");
    put(&fx.folder, "c.txt", "created");
    let st = store(&fx);
    let done = restore(&st, &ckpt, &who("t1"), Some(&["a.txt".to_string(), "not-reported.txt".to_string()])).unwrap();
    assert_eq!((done.restored, done.removed), (1, 0));
    assert_eq!(read(&fx.folder, "a.txt").as_deref(), Some("one"));
    assert_eq!(read(&fx.folder, "b.txt").as_deref(), Some("edited b"));
    assert_eq!(read(&fx.folder, "c.txt").as_deref(), Some("created"));
}

#[test]
fn paths_are_literal_pathspecs() {
    let fx = fixture();
    put(&fx.folder, "a[1].txt", "bracket");
    put(&fx.folder, "a1.txt", "plain");
    let ckpt = snap(&fx, Kind::Pre, "t1");
    put(&fx.folder, "a[1].txt", "bracket, edited");
    put(&fx.folder, "a1.txt", "plain, edited");
    let st = store(&fx);
    let done = restore(&st, &ckpt, &who("t1"), Some(&["a[1].txt".to_string()])).unwrap();
    assert_eq!(done.restored, 1);
    assert_eq!(read(&fx.folder, "a[1].txt").as_deref(), Some("bracket"));
    assert_eq!(read(&fx.folder, "a1.txt").as_deref(), Some("plain, edited"));
}

#[cfg(unix)]
#[test]
fn a_leading_folder_that_became_a_link_is_never_written_through() {
    let fx = fixture();
    put(&fx.folder, "dir/f.txt", "inside");
    put(&fx.folder, "keep.txt", "keep");
    let ckpt = snap(&fx, Kind::Pre, "t1");
    // The agent swaps the folder for a link to somewhere else.
    let outside = fx.folder.parent().unwrap().join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::remove_dir_all(fx.folder.join("dir")).unwrap();
    std::os::unix::fs::symlink(&outside, fx.folder.join("dir")).unwrap();
    put(&fx.folder, "keep.txt", "changed");

    let st = store(&fx);
    let done = restore(&st, &ckpt, &who("t1"), None).unwrap();
    assert!(
        done.failed.iter().any(|f| f.path == "dir/f.txt" && f.error.contains("link")),
        "{:?}",
        done.failed
    );
    assert!(!outside.join("f.txt").exists(), "written through the link");
    assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
    assert_eq!(read(&fx.folder, "keep.txt").as_deref(), Some("keep"));
}

// A file that outgrew the cap drops out of the store's index, so it reads as
// "deleted since"; the `pre-restore` snapshot does not hold it either, so a
// restore must leave it as it is.
#[test]
fn a_file_that_outgrew_the_cap_is_left_alone_by_a_restore() {
    let fx = fixture();
    put(&fx.folder, "big.bin", "small");
    put(&fx.folder, "keep.txt", "keep");
    let ckpt = snap(&fx, Kind::Pre, "t1");
    let big = std::fs::OpenOptions::new().write(true).open(fx.folder.join("big.bin")).unwrap();
    big.set_len(super::snapshot::MAX_FILE_BYTES + 1).unwrap();
    drop(big);
    put(&fx.folder, "keep.txt", "changed");

    let st = store(&fx);
    let listed = since(&st, &ckpt, &who("t1"), None).unwrap();
    assert_eq!(listed.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["keep.txt"]);
    assert_eq!(listed.left_out, 1);
    let done = restore(&st, &ckpt, &who("t1"), None).unwrap();
    assert!(done.failed.is_empty(), "{:?}", done.failed);
    assert_eq!(std::fs::metadata(fx.folder.join("big.bin")).unwrap().len(), super::snapshot::MAX_FILE_BYTES + 1);
    assert_eq!(read(&fx.folder, "keep.txt").as_deref(), Some("keep"));
}

// A linked worktree's folder lies inside the project, where the fenced agent
// can replace it with a link: the host must not then snapshot (or restore
// into) whatever the link names.
#[cfg(unix)]
#[test]
fn a_bound_folder_swapped_for_a_link_is_not_snapshotted_as_the_place_it_points_to() {
    let fx = fixture();
    let bound = fx.folder.join("wt");
    put(&bound, "a.txt", "mine");
    let bound = bound.canonicalize().unwrap();
    snapshot(&fx.root, &bound, Kind::Pre, &who("t1"), None).unwrap();

    let elsewhere = fx.folder.parent().unwrap().join("elsewhere");
    put(&elsewhere, "secret.txt", "not the project's");
    let elsewhere = elsewhere.canonicalize().unwrap();
    std::fs::remove_dir_all(&bound).unwrap();
    std::os::unix::fs::symlink(&elsewhere, &bound).unwrap();

    let err = snapshot(&fx.root, &bound, Kind::Post, &who("t1"), None).unwrap_err();
    assert!(err.contains("now resolves"), "{err}");
    assert!(!fx.root.join(store::key_of(&elsewhere)).exists(), "a store was made for the link's target");
    assert!(Store::for_bound(&fx.root, &elsewhere).is_ok(), "a folder that is itself canonical is fine");
}

#[test]
fn plain_path_refuses_what_is_not_a_path_inside_the_folder() {
    let fx = fixture();
    put(&fx.folder, "file.txt", "x");
    for bad in ["", "..", "../x", "a/../x", "/abs", "a//b", "./a", ".git/config", "a/.GIT/x", "file.txt/under"] {
        assert!(plain_path(&fx.folder, bad).is_err(), "{bad:?}");
    }
    for good in ["a.txt", "sub/deeper/x.txt", "not/yet/there.txt", ".github/workflows/ci.yml", "file.txt"] {
        assert!(plain_path(&fx.folder, good).is_ok(), "{good:?}");
    }
}

#[test]
fn the_files_another_tabs_turn_changed_are_flagged() {
    let fx = fixture();
    put(&fx.folder, "mine.txt", "m");
    put(&fx.folder, "theirs.txt", "t");
    let mine = snap(&fx, Kind::Manual, "me");
    let pre = snap(&fx, Kind::Pre, "other");
    put(&fx.folder, "theirs.txt", "t, edited by the other tab");
    let _post = snap(&fx, Kind::Post, "other");
    put(&fx.folder, "mine.txt", "m, edited by me");
    let st = store(&fx);
    assert_ne!(pre.tree, _post.tree);
    let diff = since(&st, &mine, &who("me"), None).unwrap();
    assert_eq!(diff.others, ["theirs.txt"]);
    let mut changed: Vec<_> = diff.files.iter().map(|f| f.path.as_str()).collect();
    changed.sort();
    assert_eq!(changed, ["mine.txt", "theirs.txt"]);
    // Seen from the other tab, its own turn is not "someone else's".
    let theirs = since(&st, &mine, &who("other"), None).unwrap();
    assert!(theirs.others.is_empty());
}

#[test]
fn a_restore_row_names_what_it_restored_to() {
    let fx = fixture();
    put(&fx.folder, "a.txt", "one");
    let ckpt = snap(&fx, Kind::Pre, "t1");
    put(&fx.folder, "a.txt", "two");
    let st = store(&fx);
    restore(&st, &ckpt, &who("t1"), None).unwrap();
    let row = st.rows().into_iter().rev().find(|r| r.kind == Kind::Restore).unwrap();
    assert_eq!(row.restored_to.as_deref(), Some(ckpt.id.as_str()));
    assert_eq!(row.paths, Some(1));
    assert!(!row.has_snapshot());
}

// ── Triggers, bindings ───────────────────────────────────────────────────

#[test]
fn transitions_map_to_checkpoint_kinds() {
    use TurnState::*;
    let table = [
        (None, Working, Some(Kind::Pre)),
        (Some(Done), Working, Some(Kind::Pre)),
        (Some(Idle), Working, Some(Kind::Pre)),
        (Some(Working), Working, None),
        (Some(Decision), Working, None),
        (Some(Working), Done, Some(Kind::Post)),
        (Some(Decision), Done, Some(Kind::Post)),
        (Some(Done), Done, None),
        (None, Done, None),
        (Some(Working), Decision, None),
        (Some(Done), Decision, None),
        (Some(Working), Idle, None),
        (Some(Done), Idle, None),
        (None, Idle, None),
    ];
    for (prev, state, want) in table {
        assert_eq!(kind_for(prev, state), want, "{prev:?} -> {state:?}");
    }
}

#[test]
fn a_tabs_folder_is_found_among_its_projects_roots_and_nowhere_else() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let (root, other, member) = (base.join("proj"), base.join("other"), base.join("box").join("member"));
    for dir in [&root, &other, &member, &root.join("src/deep")] {
        std::fs::create_dir_all(dir).unwrap();
    }
    let worktrees = crate::brand::WORKTREES_DIR.split('/').fold(root.clone(), |p, seg| p.join(seg));
    std::fs::create_dir_all(worktrees.join("feat").join("src")).unwrap();
    let roots = vec![root.clone(), member.clone()];

    assert_eq!(resolve_folder(&roots, &root), Some(root.clone()));
    assert_eq!(resolve_folder(&roots, &root.join("src/deep")), Some(root.clone()));
    assert_eq!(resolve_folder(&roots, &member), Some(member.clone()));
    assert_eq!(resolve_folder(&roots, &worktrees.join("feat")), Some(worktrees.join("feat")));
    assert_eq!(resolve_folder(&roots, &worktrees.join("feat/src")), Some(worktrees.join("feat")));
    assert_eq!(resolve_folder(&roots, &other), None);
    assert_eq!(resolve_folder(&[], &root), None);
    assert_eq!(resolve_folder(&roots, &base.join("missing")), None);
}

#[test]
fn some_folders_never_get_a_store() {
    let tmp = tempfile::tempdir().unwrap();
    let state = tmp.path().join("state");
    std::fs::create_dir_all(&state).unwrap();
    let state = state.canonicalize().unwrap();
    // The folder that holds the state dir would snapshot its own store.
    assert!(unsuitable(tmp.path().canonicalize().unwrap().as_path(), &state));
    assert!(unsuitable(&state, &state));
    assert!(unsuitable(Path::new(if cfg!(windows) { "C:\\" } else { "/" }), &state));
    let project = tmp.path().canonicalize().unwrap().join("proj");
    std::fs::create_dir_all(&project).unwrap();
    assert!(!unsuitable(&project, &state));
}

#[test]
fn a_launch_without_roots_or_a_project_is_unbound() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().canonicalize().unwrap().join("p");
    std::fs::create_dir_all(&dir).unwrap();
    let roots = vec![dir.clone()];
    let cwd = dir.display().to_string();
    assert!(bind("uid-bind-1", &cwd, Some("proj-1"), "/usr/bin/claude", Some(&roots), false).is_some());
    assert_eq!(bound("uid-bind-1").unwrap().folder, dir);
    assert_eq!(bound("uid-bind-1").unwrap().cli, "claude");
    // The root console (no project), a remote or Host launch (no roots): none,
    // and no key.
    assert!(bind("uid-bind-1", &cwd, None, "claude", Some(&roots), false).is_none());
    assert!(bound("uid-bind-1").is_err());
    bind("uid-bind-1", &cwd, Some("proj-1"), "claude", Some(&roots), false);
    assert!(bind("uid-bind-1", &cwd, Some("proj-1"), "claude", None, false).is_none());
    assert!(bound("uid-bind-1").is_err());
    // A reserved scope is no project.
    bind("uid-bind-1", &cwd, Some("root"), "claude", Some(&roots), false);
    assert!(bound("uid-bind-1").is_err());
    bind("uid-bind-2", &cwd, Some("proj-1"), "claude", Some(&roots), false);
    unbind("uid-bind-2");
    assert!(bound("uid-bind-2").is_err());
}

#[test]
fn the_window_names_a_tab_by_its_launch_key_never_by_the_uid_its_agent_holds() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().canonicalize().unwrap().join("p");
    std::fs::create_dir_all(&dir).unwrap();
    let (roots, cwd) = (vec![dir.clone()], dir.display().to_string());
    let key = bind("uid-key-1", &cwd, Some("proj-1"), "claude", Some(&roots), false).unwrap();
    assert_eq!(key.len(), 32);
    assert!(key.bytes().all(|b| b.is_ascii_hexdigit()));
    assert_eq!(by_key(&key).unwrap().0, "uid-key-1");
    // The uid (in the agent's environment as TAB_UID) is no key.
    assert!(by_key("uid-key-1").is_err());
    assert!(!list("uid-key-1").bound);
    assert!(by_key("").is_err());
    // A relaunch mints a new key; the old one names nothing any more.
    let again = bind("uid-key-1", &cwd, Some("proj-1"), "claude", Some(&roots), false).unwrap();
    assert_ne!(again, key);
    assert!(by_key(&key).is_err());
    assert!(by_key(&again).is_ok());
    unbind("uid-key-1");
    assert!(by_key(&again).is_err());
}

#[test]
fn a_tab_whose_hooks_never_spoke_cannot_be_told_working_or_not() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().canonicalize().unwrap().join("p");
    std::fs::create_dir_all(&dir).unwrap();
    let (roots, cwd) = (vec![dir.clone()], dir.display().to_string());
    // Codex with untrusted hooks: no record from a previous run, no turn yet.
    bind("uid-unknown-1", &cwd, Some("proj-1"), "codex", Some(&roots), false);
    assert!(turn_unknown("uid-unknown-1"));
    // Its hooks speak (any transition, a session end too): known from now on.
    on_turn("uid-unknown-1", None, TurnState::Idle, None);
    assert!(!turn_unknown("uid-unknown-1"));
    // The previous run's record showed working hooks.
    bind("uid-unknown-2", &cwd, Some("proj-1"), "claude", Some(&roots), true);
    assert!(!turn_unknown("uid-unknown-2"));
    let others = other_tabs("uid-unknown-2", &dir);
    assert!(!others.unknown && !others.working, "the only other tab has spoken");
    // Another tab of the folder that can't be told counts as "others".
    bind("uid-unknown-3", &cwd, Some("proj-1"), "codex", Some(&roots), false);
    let others = other_tabs("uid-unknown-2", &dir);
    assert!(others.unknown && !others.working);
    for uid in ["uid-unknown-1", "uid-unknown-2", "uid-unknown-3"] {
        unbind(uid);
    }
}

#[test]
fn a_restore_waits_for_a_working_agent_and_asks_when_it_cannot_tell() {
    use TurnState::*;
    // (own state, own unknown, others working, others unknown, confirm others, confirm unknown) → allowed
    let cases = [
        (Some(Done), false, false, false, false, false, true),
        (None, false, false, false, false, false, true),
        (Some(Working), false, false, false, true, true, false),
        (Some(Decision), false, false, false, true, true, false),
        (None, true, false, false, false, false, false),
        (None, true, false, false, false, true, true),
        (Some(Done), false, true, false, false, false, false),
        (Some(Done), false, true, false, true, false, true),
        (Some(Done), false, false, true, false, false, false),
        (Some(Done), false, false, true, true, false, true),
        (None, true, true, true, true, false, false),
        (None, true, true, true, true, true, true),
    ];
    for (own, own_unknown, working, unknown, c_others, c_unknown, allowed) in cases {
        let refusal = restore_refusal(own, own_unknown, working, unknown, c_others, c_unknown);
        assert_eq!(refusal.is_none(), allowed, "{own:?} {own_unknown} {working} {unknown} {c_others} {c_unknown}: {refusal:?}");
    }
}

// ── Worker ───────────────────────────────────────────────────────────────

fn job(folder: &Path, kind: Kind, uid: &str) -> Job {
    Job { folder: folder.to_path_buf(), kind, who: who(uid), prompt_at: None, reply: None }
}

#[test]
fn a_folders_jobs_run_one_at_a_time_and_duplicates_are_coalesced() {
    let queues = Queues::new();
    let running = Arc::new(AtomicUsize::new(0));
    let widest = Arc::new(AtomicUsize::new(0));
    let ran = Arc::new(AtomicUsize::new(0));
    let idle = Arc::new(AtomicUsize::new(0));
    let runner = Arc::new(Runner {
        run: {
            let (running, widest, ran) = (running.clone(), widest.clone(), ran.clone());
            Box::new(move |_job| {
                let now = running.fetch_add(1, Ordering::SeqCst) + 1;
                widest.fetch_max(now, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(150));
                ran.fetch_add(1, Ordering::SeqCst);
                running.fetch_sub(1, Ordering::SeqCst);
            })
        },
        idle: {
            let idle = idle.clone();
            Box::new(move |_| {
                idle.fetch_add(1, Ordering::SeqCst);
            })
        },
    });
    let folder = PathBuf::from("/work/one");
    // The first starts the worker; the rest queue behind it. Three pre jobs of
    // one tab are one; a post of the same tab and a pre of another stay.
    queues.submit(job(&folder, Kind::Pre, "a"), runner.clone());
    for _ in 0..3 {
        queues.submit(job(&folder, Kind::Pre, "a"), runner.clone());
    }
    queues.submit(job(&folder, Kind::Post, "a"), runner.clone());
    queues.submit(job(&folder, Kind::Pre, "b"), runner.clone());
    // Another folder runs on its own worker, beside the first.
    queues.submit(job(Path::new("/work/two"), Kind::Pre, "c"), runner.clone());
    assert!(crate::test_util::wait_until(crate::test_util::PATIENCE, || queues.is_idle()));
    assert_eq!(widest.load(Ordering::SeqCst), 2, "one per folder, two folders");
    assert_eq!(idle.load(Ordering::SeqCst), 2, "each folder's worker reports idle once");
    // a:pre, (a:pre coalesced into the queued one), a:post, b:pre, c:pre.
    let n = ran.load(Ordering::SeqCst);
    assert!((4..=5).contains(&n), "ran {n}");
}

#[test]
fn a_stopped_queue_takes_no_more_work_and_answers_a_waiting_caller() {
    let queues = Queues::new();
    queues.stop(Duration::from_millis(1));
    let (tx, rx) = std::sync::mpsc::channel();
    let runner = Arc::new(Runner { run: Box::new(|_| panic!("ran")), idle: Box::new(|_| {}) });
    let mut j = job(Path::new("/work/x"), Kind::Manual, "a");
    j.reply = Some(tx);
    queues.submit(j, runner);
    assert!(rx.recv_timeout(Duration::from_secs(5)).unwrap().is_err());
}

// ── Retention, settings, cleanup ─────────────────────────────────────────

fn row_at(kind: Kind, at: u64) -> Row {
    Row {
        id: store::new_id(at),
        kind,
        commit: "c".into(),
        tree: "t".into(),
        tab_uid: String::new(),
        tab_label: String::new(),
        cli: String::new(),
        session_id: None,
        at,
        prompt_at: None,
        raced: false,
        partial: false,
        skipped: vec![],
        nested: vec![],
        restored_to: None,
        paths: None,
    }
}

#[test]
fn retention_keeps_the_young_the_newest_and_recent_undos() {
    let now = 100 * 24 * 60 * 60 * 1000;
    let day = 24 * 60 * 60 * 1000;
    let rows = vec![
        row_at(Kind::Pre, now - 30 * day),
        row_at(Kind::PreRestore, now - 20 * day),
        row_at(Kind::PreRestore, now - 5 * day),
        row_at(Kind::Post, now - 13 * day),
        row_at(Kind::Post, now - 1000),
    ];
    assert_eq!(retained(&rows, now), [false, false, true, true, true]);

    // The count cap drops the oldest of the young; a recent undo outlives it.
    let mut many: Vec<Row> = (0..MAX_ROWS + 20).map(|i| row_at(Kind::Post, now - 10 * day + i as u64)).collect();
    many.insert(0, row_at(Kind::PreRestore, now - 6 * day));
    let keep = retained(&many, now);
    assert!(keep[0], "a recent pre-restore is not pruned early");
    assert_eq!(keep.iter().filter(|k| **k).count(), MAX_ROWS + 1);
    assert!(!keep[1] && keep[keep.len() - 1]);
}

#[test]
fn pruning_drops_the_refs_and_the_log_rows_and_gc_waits_for_enough_of_them() {
    let fx = fixture();
    put(&fx.folder, "a.txt", "one");
    let old = snap(&fx, Kind::Pre, "t1");
    put(&fx.folder, "a.txt", "two");
    let young = snap(&fx, Kind::Post, "t1");
    let st = store(&fx);
    let _lock = st.lock().unwrap();
    // Age the first one.
    let mut rows = st.rows();
    rows[0].at = rows[0].at.saturating_sub(KEEP_MS + 1000);
    st.write_rows(&rows).unwrap();

    assert_eq!(prune_locked(&st, crate::clock::now_ms()).unwrap(), 1);
    let left = st.rows();
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].id, young.id);
    let refs = st.text(&["for-each-ref", "--format=%(refname)", "refs/ckpt/"]).unwrap();
    assert_eq!(refs, format!("refs/ckpt/{}", young.id));
    assert_eq!(st.meta().unwrap().gc_pending, 1);
    // Too few dropped for a repack.
    assert!(!gc_locked(&st).unwrap());
    st.update_meta(|m| m.gc_pending = 60).unwrap();
    assert!(gc_locked(&st).unwrap());
    assert_eq!(st.meta().unwrap().gc_pending, 0);
    // The kept snapshot survived the repack; the dropped one's unique blob did not.
    assert_eq!(blob(&st, &young, "a.txt"), b"two");
    assert!(st.run(&["cat-file", "-e", &old.commit], None, 1 << 16).unwrap().status.code() != Some(0));
}

#[test]
fn the_switch_is_off_until_turned_on_and_a_broken_file_reads_as_off() {
    let tmp = tempfile::tempdir().unwrap();
    assert!(!enabled_in(tmp.path()));
    set_enabled_in(tmp.path(), true).unwrap();
    assert!(enabled_in(tmp.path()));
    set_enabled_in(tmp.path(), false).unwrap();
    assert!(!enabled_in(tmp.path()));
    std::fs::write(tmp.path().join("checkpoints.json"), "{ not json").unwrap();
    assert!(!enabled_in(tmp.path()));
}

#[test]
fn checkpoints_need_git_2_40() {
    assert!(git_supported_by(Some((2, 40))));
    assert!(git_supported_by(Some((2, 53))));
    assert!(git_supported_by(Some((3, 0))));
    assert!(!git_supported_by(Some((2, 39))));
    assert!(!git_supported_by(Some((1, 99))));
    assert!(!git_supported_by(None));
    assert!(git_refusal(Some((2, 40))).is_none());
    assert!(git_refusal(Some((2, 39))).unwrap().contains("2.39"));
    assert!(git_refusal(None).unwrap().contains("no git"));
}

#[test]
fn turning_checkpoints_on_is_refused_over_an_old_git_and_off_always_works() {
    let tmp = tempfile::tempdir().unwrap();
    let err = set_enabled_checked_in(tmp.path(), true, Some((2, 39))).unwrap_err();
    assert!(err.contains("2.40"), "{err}");
    assert!(!enabled_in(tmp.path()));
    assert!(set_enabled_checked_in(tmp.path(), true, None).is_err());
    assert!(!enabled_in(tmp.path()));

    set_enabled_checked_in(tmp.path(), true, Some((2, 40))).unwrap();
    assert!(enabled_in(tmp.path()));
    // A git that went old (or away) never traps the switch on.
    set_enabled_checked_in(tmp.path(), false, Some((2, 30))).unwrap();
    assert!(!enabled_in(tmp.path()));
}

#[test]
fn settings_list_each_store_and_clear_and_purge_remove_them() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let state = base.join("state");
    let root = store::root_in(&state);
    let mut folders = Vec::new();
    for (name, project) in [("one", "p1"), ("two", "p2")] {
        let folder = base.join(name);
        std::fs::create_dir_all(&folder).unwrap();
        put(&folder, "a.txt", name);
        let who = Who { project_id: Some(project.into()), ..who("t") };
        snapshot(&root, &folder, Kind::Manual, &who, None).unwrap();
        folders.push(folder);
    }
    let view = settings_view_in(&state);
    assert_eq!(view.stores.len(), 2);
    assert!(view.stores.iter().all(|s| s.count == 1 && s.bytes > 0));
    assert!(!view.enabled);

    purge_project_in(&root, "p1");
    let left = settings_view_in(&state).stores;
    assert_eq!(left.len(), 1);
    // Shown as the UI spells it: no `\\?\` prefix from `canonicalize` on Windows.
    assert_eq!(left[0].folder, crate::paths::display_path(&folders[1]));

    clear_in(&root, Some("nonexistent-key")).unwrap();
    assert_eq!(settings_view_in(&state).stores.len(), 1);
    clear_in(&root, None).unwrap();
    assert!(settings_view_in(&state).stores.is_empty());
}

#[test]
fn a_store_whose_folder_is_gone_is_swept_only_once_it_is_old() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let root = base.join("checkpoints");
    let folder = base.join("proj");
    std::fs::create_dir_all(&folder).unwrap();
    put(&folder, "a.txt", "x");
    snapshot(&root, &folder, Kind::Manual, &who("t"), None).unwrap();
    // Folder present: kept however old.
    assert_eq!(sweep_orphans_in(&root, crate::clock::now_ms() + 2 * KEEP_MS), 0);
    std::fs::remove_dir_all(&folder).unwrap();
    // Gone but recent: kept (it may be on an unmounted drive).
    assert_eq!(sweep_orphans_in(&root, crate::clock::now_ms()), 0);
    assert_eq!(sweep_orphans_in(&root, crate::clock::now_ms() + 2 * KEEP_MS), 1);
    assert!(store::all_in(&root).is_empty());
}

#[cfg(unix)]
#[test]
fn a_tracked_file_that_became_a_pipe_is_dropped_and_named() {
    let fx = fixture();
    put(&fx.folder, "a.txt", "one");
    put(&fx.folder, "swap", "was a file");
    snap(&fx, Kind::Manual, "t1");
    std::fs::remove_file(fx.folder.join("swap")).unwrap();
    assert!(std::process::Command::new("mkfifo").arg(fx.folder.join("swap")).status().unwrap().success());
    let st = store(&fx);
    let _lock = st.lock().unwrap();
    let staged = stage_with(&st, None, Limits::default()).unwrap();
    assert!(staged.skipped.iter().any(|s| s.path == "swap" && s.reason == "special"), "{:?}", staged.skipped);
    assert_eq!(st.text(&["ls-tree", "-r", "--name-only", &staged.tree]).unwrap(), "a.txt");
}

// ── Flagged in review: blocking `.gitignore`, byte names, panics, byte cap,
// the two switches ───────────────────────────────────────────────────────

#[cfg(unix)]
fn mkfifo(path: &Path) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    assert!(std::process::Command::new("mkfifo").arg(path).status().unwrap().success());
}

/// Run `body` with every git call of this thread stopped after `secs`.
#[cfg(unix)]
fn with_git_timeout<T>(secs: u64, body: impl FnOnce() -> T) -> T {
    use crate::services::git_bounded::TEST_TIMEOUT;
    TEST_TIMEOUT.with(|t| t.set(Some(Duration::from_secs(secs))));
    let out = body();
    TEST_TIMEOUT.with(|t| t.set(None));
    out
}

#[cfg(unix)]
#[test]
fn a_pipe_gitignore_in_a_stored_folder_keeps_that_folder_out_without_a_stall() {
    let fx = fixture();
    put(&fx.folder, "a.txt", "one");
    put(&fx.folder, "d/b.txt", "two");
    put(&fx.folder, "d/e/c.txt", "three");
    snap(&fx, Kind::Manual, "t1");
    mkfifo(&fx.folder.join("d/.gitignore"));
    // Found by a stat of the folders the store holds files in: git never
    // waits, so the ceiling is never reached.
    let started = std::time::Instant::now();
    let row = with_git_timeout(30, || snap(&fx, Kind::Manual, "t1"));
    assert!(started.elapsed() < Duration::from_secs(20), "{:?}", started.elapsed());
    assert_eq!(tree_paths(&store(&fx), &row), ["a.txt"]);
    assert!(row.partial);
    assert!(row.skipped.iter().any(|s| s.path == "d/" && s.reason == "blocked"), "{:?}", row.skipped);
    assert_eq!(store(&fx).blocked(), [b"d".to_vec()]);
    // The files in the blocked folder are left alone by "since" and a restore.
    let st = store(&fx);
    let first = st.rows()[0].clone();
    let seen = since(&st, &first, &who("t1"), None).unwrap();
    assert!(seen.files.is_empty(), "{:?}", seen.files);
    // Once the pipe is gone, the folder is back.
    std::fs::remove_file(fx.folder.join("d/.gitignore")).unwrap();
    let row = snap(&fx, Kind::Manual, "t1");
    assert_eq!(tree_paths(&store(&fx), &row), ["a.txt", "d/b.txt", "d/e/c.txt"]);
    assert!(store(&fx).blocked().is_empty());
}

#[cfg(unix)]
#[test]
fn a_pipe_gitignore_in_a_new_folder_is_found_once_the_listing_stalls_and_remembered() {
    let fx = fixture();
    put(&fx.folder, "a.txt", "one");
    put(&fx.folder, "new/deep/x.txt", "x");
    mkfifo(&fx.folder.join("new/deep/.gitignore"));
    // The first walk stalls at the test's ceiling; the search finds the pipe.
    let row = with_git_timeout(3, || snap(&fx, Kind::Manual, "t1"));
    assert_eq!(tree_paths(&store(&fx), &row), ["a.txt"]);
    assert!(row.skipped.iter().any(|s| s.path == "new/deep/" && s.reason == "blocked"), "{:?}", row.skipped);
    // Remembered: the next snapshot does not wait for git at all.
    let started = std::time::Instant::now();
    let row = with_git_timeout(30, || snap(&fx, Kind::Manual, "t1"));
    assert!(started.elapsed() < Duration::from_secs(20), "{:?}", started.elapsed());
    assert_eq!(tree_paths(&store(&fx), &row), ["a.txt"]);
}

#[cfg(unix)]
#[test]
fn a_gitignore_negation_cannot_draw_git_into_a_blocked_folder() {
    let fx = fixture();
    put(&fx.folder, "a.txt", "one");
    put(&fx.folder, "d/b.txt", "two");
    snap(&fx, Kind::Manual, "t1");
    put(&fx.folder, ".gitignore", "!/d/\n!d/**\n");
    mkfifo(&fx.folder.join("d/.gitignore"));
    let row = with_git_timeout(20, || snap(&fx, Kind::Manual, "t1"));
    assert_eq!(tree_paths(&store(&fx), &row), [".gitignore", "a.txt"]);
}

#[cfg(unix)]
#[test]
fn a_pipe_as_the_top_gitignore_fails_at_once_and_says_why() {
    let fx = fixture();
    put(&fx.folder, "a.txt", "one");
    mkfifo(&fx.folder.join(".gitignore"));
    let started = std::time::Instant::now();
    let err = snapshot(&fx.root, &fx.folder, Kind::Manual, &who("t1"), None).unwrap_err();
    assert!(started.elapsed() < Duration::from_secs(20));
    assert!(err.contains(".gitignore") && err.contains("named pipe"), "{err}");
}

#[cfg(unix)]
#[test]
fn a_pipe_in_the_folders_own_git_dir_does_not_stop_its_checkpoints() {
    let fx = fixture();
    init_repo(&fx.folder);
    put(&fx.folder, "a.txt", "one");
    let packed = fx.folder.join(".git").join("packed-refs");
    let _ = std::fs::remove_file(&packed);
    mkfifo(&packed);
    let row = with_git_timeout(20, || snap(&fx, Kind::Manual, "t1"));
    assert_eq!(tree_paths(&store(&fx), &row), ["a.txt"]);
}

#[test]
fn a_gitignore_negation_cannot_take_back_a_left_out_file_or_the_worktrees() {
    let fx = fixture();
    let worktrees = crate::brand::WORKTREES_DIR;
    put(&fx.folder, ".gitignore", &format!("!/big.bin\n!/{worktrees}/\n"));
    put(&fx.folder, "big.bin", &"x".repeat(4096));
    put(&fx.folder, &format!("{worktrees}/feat/inner.txt"), "x");
    let st = store(&fx);
    std::fs::create_dir_all(&st.dir).unwrap();
    let _lock = st.lock().unwrap();
    st.ensure(None).unwrap();
    let staged = stage_with(&st, None, Limits { max_file: 1024, budget: 1 << 20 }).unwrap();
    assert_eq!(st.text(&["ls-tree", "-r", "--name-only", &staged.tree]).unwrap(), ".gitignore");
    assert!(staged.skipped.iter().any(|s| s.path == "big.bin" && s.reason == "size"), "{:?}", staged.skipped);
}

#[test]
fn only_the_folders_own_repo_or_its_worktree_roots_ignore_file_applies() {
    let tmp = tempfile::tempdir().unwrap();
    let outer = tmp.path().canonicalize().unwrap().join("outer");
    std::fs::create_dir_all(&outer).unwrap();
    init_repo(&outer);
    put(&outer, ".git/info/exclude", "secret.txt\n");
    // A plain folder inside someone else's repo: that repo's rules are not its own.
    let folder = outer.join("proj");
    put(&folder, "secret.txt", "x");
    assert_eq!(snapshot::repo_git_dir(&folder), None);
    let root = tmp.path().join("checkpoints");
    let row = snapshot(&root, &folder, Kind::Manual, &who("t1"), None).unwrap();
    let st = Store::for_folder(&root, &folder).unwrap();
    assert_eq!(tree_paths(&st, &row), ["secret.txt"]);
    // A linked worktree of the root reads the root's.
    let wt = crate::brand::WORKTREES_DIR.split('/').fold(outer.clone(), |p, seg| p.join(seg)).join("feat");
    std::fs::create_dir_all(&wt).unwrap();
    put(&wt, ".git", "gitdir: ../../.git/worktrees/feat\n");
    assert_eq!(snapshot::repo_git_dir(&wt), Some(outer.join(".git")));
    assert_eq!(snapshot::repo_git_dir(&outer), Some(outer.join(".git")));
}

#[cfg(target_os = "linux")]
#[test]
fn file_names_that_are_not_utf8_are_capped_restored_and_removed_by_their_own_bytes() {
    use std::os::unix::ffi::OsStrExt;
    let fx = fixture();
    let name = |bytes: &[u8]| fx.folder.join(std::ffi::OsStr::from_bytes(bytes));
    put(&fx.folder, "a.txt", "one");
    std::fs::write(name(b"kept\xff.txt"), "before").unwrap();
    let st = store(&fx);
    std::fs::create_dir_all(&st.dir).unwrap();
    {
        let _lock = st.lock().unwrap();
        st.ensure(None).unwrap();
        // Over the cap: left out, though `lstat` of a lossy name would miss it.
        std::fs::write(name(b"big\xfe.bin"), "x".repeat(4096)).unwrap();
        let staged = stage_with(&st, None, Limits { max_file: 1024, budget: 1 << 20 }).unwrap();
        assert!(staged.skipped.iter().any(|s| s.reason == "size" && s.path.starts_with("big")), "{:?}", staged.skipped);
        let listed = st.run_ok(&["ls-files", "-z"], None, 1 << 20).unwrap();
        assert!(!listed.windows(4).any(|w| w == b"big\xfe"), "{listed:?}");
        std::fs::remove_file(name(b"big\xfe.bin")).unwrap();
    }
    let ckpt = snap(&fx, Kind::Pre, "t1");
    std::fs::write(name(b"kept\xff.txt"), "after").unwrap();
    std::fs::write(name(b"added\xfd.txt"), "new").unwrap();
    let seen = since(&st, &ckpt, &who("t1"), None).unwrap();
    assert_eq!(seen.files.len(), 2, "{:?}", seen.files);
    assert!(seen.files.iter().all(|f| f.diff.is_some()), "{:?}", seen.files);
    let done = restore(&st, &ckpt, &who("t1"), None).unwrap();
    assert!(done.failed.is_empty(), "{:?}", done.failed);
    assert_eq!((done.restored, done.removed), (1, 1));
    assert_eq!(std::fs::read(name(b"kept\xff.txt")).unwrap(), b"before");
    assert!(std::fs::symlink_metadata(name(b"added\xfd.txt")).is_err(), "the added file is really gone");
}

#[test]
fn a_job_that_panics_does_not_strand_its_folders_queue() {
    let queues = Queues::new();
    let ran = Arc::new(AtomicUsize::new(0));
    let idle = Arc::new(AtomicUsize::new(0));
    let runner = Arc::new(Runner {
        run: {
            let ran = ran.clone();
            Box::new(move |job: Job| {
                if job.kind == Kind::Pre {
                    panic!("a snapshot panicked");
                }
                ran.fetch_add(1, Ordering::SeqCst);
            })
        },
        idle: {
            let idle = idle.clone();
            Box::new(move |_| {
                idle.fetch_add(1, Ordering::SeqCst);
            })
        },
    });
    let folder = PathBuf::from("/work/panics");
    let (tx, rx) = std::sync::mpsc::channel();
    let mut first = job(&folder, Kind::Pre, "a");
    first.reply = Some(tx);
    queues.submit(first, runner.clone());
    queues.submit(job(&folder, Kind::Post, "a"), runner.clone());
    // The waiting caller hears (its sender went with the job) instead of hanging.
    assert!(rx.recv_timeout(Duration::from_secs(10)).is_err());
    assert!(crate::test_util::wait_until(crate::test_util::PATIENCE, || queues.is_idle()));
    assert_eq!(ran.load(Ordering::SeqCst), 1, "the job after the panic ran");
    assert_eq!(idle.load(Ordering::SeqCst), 1);
    // The folder takes work again.
    queues.submit(job(&folder, Kind::Post, "b"), runner.clone());
    assert!(crate::test_util::wait_until(crate::test_util::PATIENCE, || ran.load(Ordering::SeqCst) == 2 && queues.is_idle()));
}

#[test]
fn over_the_byte_cap_the_oldest_quarter_goes_but_never_the_newest_or_a_recent_undo() {
    let now = 100 * KEEP_MS;
    let mut rows: Vec<Row> = (0..9).map(|i| row_at(Kind::Post, now - 1000 + i)).collect();
    rows[1] = row_at(Kind::PreRestore, now - 999);
    rows.push(row_at(Kind::Restore, now));
    let keep = trimmed(&rows, now);
    // Droppable: rows 0, 2..=7 (7 of them; row 8 is the newest snapshot, row 1
    // a recent undo, row 9 holds none): the oldest two go.
    assert_eq!(keep, [false, true, false, true, true, true, true, true, true, true]);
    // Nothing droppable: nothing goes.
    assert_eq!(trimmed(&rows[8..9], now), [true]);
}

#[test]
fn a_store_over_its_byte_cap_drops_a_step_then_waits_for_the_repack() {
    let fx = fixture();
    for i in 0..5 {
        put(&fx.folder, "a.txt", &format!("version {i}"));
        snap(&fx, Kind::Post, "t1");
    }
    let st = store(&fx);
    let _lock = st.lock().unwrap();
    let now = crate::clock::now_ms();
    // Under the cap: nothing.
    assert_eq!(cap_locked(&st, now, u64::MAX).unwrap(), 0);
    // Over: a quarter of the four droppable ones, and a repack is due.
    assert_eq!(cap_locked(&st, now, 1).unwrap(), 1);
    assert_eq!(st.rows().len(), 4);
    assert!(st.meta().unwrap().gc_pending >= 50);
    // Still over, but the repack hasn't run: no second step yet.
    assert_eq!(cap_locked(&st, now, 1).unwrap(), 0);
    assert!(gc_locked(&st).unwrap());
    assert_eq!(cap_locked(&st, now, 1).unwrap(), 1);
    assert_eq!(st.rows().len(), 3);
}

#[test]
fn capture_needs_the_backend_switch_and_the_windows_flag() {
    let tmp = tempfile::tempdir().unwrap();
    let settings = tmp.path().join("settings.json");
    set_enabled_in(tmp.path(), true).unwrap();
    assert!(!capturing_in(tmp.path()), "no settings: the flag is off");
    std::fs::write(&settings, r#"{"experimental_explicit":true,"turn_checkpoints":true}"#).unwrap();
    assert!(capturing_in(tmp.path()));
    std::fs::write(&settings, r#"{"experimental_explicit":true,"turn_checkpoints":false}"#).unwrap();
    assert!(!capturing_in(tmp.path()), "the flag went off elsewhere: nothing is taken");
    std::fs::write(&settings, r#"{"experimental_explicit":true,"turn_checkpoints":true}"#).unwrap();
    set_enabled_in(tmp.path(), false).unwrap();
    assert!(!capturing_in(tmp.path()), "the backend switch off: nothing is taken");
}

#[test]
fn a_store_renamed_aside_is_not_listed_and_is_swept() {
    let fx = fixture();
    put(&fx.folder, "a.txt", "one");
    snap(&fx, Kind::Manual, "t1");
    let trash = fx.root.join(format!("{}abc", store::TRASH_PREFIX));
    std::fs::create_dir_all(&trash).unwrap();
    std::fs::write(trash.join("meta.json"), r#"{"folder":"/gone"}"#).unwrap();
    assert_eq!(store::all_in(&fx.root).len(), 1);
    assert_eq!(sweep_orphans_in(&fx.root, crate::clock::now_ms()), 1);
    assert!(!trash.exists());
    clear_in(&fx.root, None).unwrap();
    assert!(store::all_in(&fx.root).is_empty());
    assert_eq!(std::fs::read_dir(&fx.root).unwrap().count(), 0, "nothing left behind");
}
