//! The launch steps around the state dir: retire the old phone host, move
//! the folder and leave a link at the old path, re-point the absolute paths
//! that named it, and copy the webview's data to the new identifier.

use std::fs;
use std::path::{Path, PathBuf};

use super::{Env, Halt, Outcome, StepResult, StepState};
use crate::brand::Name;

/// Step `mobile-host`: stop the phone host an older build installed and
/// remove its login start. The current host is installed and started by the
/// ordinary launch path afterwards (`start_host_on_launch` finds no copy
/// under the current name and installs one), so this only clears the way.
pub fn retire_mobile_host(env: &Env) -> StepResult {
    if env.pair.legacy(Name::MOBILE_HOST_UNIT).is_none()
        && env.pair.legacy(Name::MOBILE_HOST_LAUNCHD_LABEL).is_none()
        && env.pair.legacy(Name::MOBILE_HOST_RUN_VALUE).is_none()
        && env.pair.legacy(Name::MOBILE_HOST_BIN).is_none()
    {
        return Ok(Outcome::NothingToDo);
    }
    if !env.machine_wide {
        return Ok(Outcome::NothingToDo);
    }
    let runs_from = env.legacy_state_dir.clone().unwrap_or_else(|| env.state_dir.clone());
    let retired = env.world.retire_legacy_mobile_host(&env.pair, &runs_from);
    if retired.is_ok() {
        remove_legacy_host_binaries(env, &runs_from);
    }
    match retired {
        Ok(true) => Ok(Outcome::Done("the old phone host was stopped and its login start removed".into())),
        Ok(false) => Ok(Outcome::NothingToDo),
        Err(error) => Ok(Outcome::Pending(format!("the old phone host could not be retired: {error}"))),
    }
}

/// The old host's installed copies, `mobile-control/bin/<version>/<old
/// name>`. The install prunes other versions' folders but would leave an
/// old-named file beside the current one of the same version. Best effort: a
/// copy that will not delete (still running on Windows) is left.
fn remove_legacy_host_binaries(env: &Env, state_dir: &Path) {
    let names: Vec<String> = [Name::MOBILE_HOST_BIN, Name::MOBILE_HOST_EXE]
        .into_iter()
        .filter_map(|name| env.pair.legacy(name))
        .collect();
    let Ok(versions) = fs::read_dir(state_dir.join("mobile-control").join("bin")) else {
        return;
    };
    for version in versions.flatten() {
        for name in &names {
            let _ = fs::remove_file(version.path().join(name));
        }
    }
}

/// Step `state-dir`: `<data>/<old name>` → `<data>/<current name>`, with a
/// link left at the old path.
pub fn move_state_dir(env: &Env) -> StepResult {
    let Some(old) = env.legacy_state_dir.as_deref() else {
        return Ok(Outcome::NothingToDo);
    };
    move_dir(env, "state-dir", old, &env.state_dir, true)
}

/// Step `share-dir`: the same for `~/.local/share/<name>` where that is not
/// the state dir.
pub fn move_share_dir(env: &Env) -> StepResult {
    let Some((old, new)) = env.share_dir.as_ref() else {
        return Ok(Outcome::NothingToDo);
    };
    move_dir(env, "share-dir", old, new, false)
}

/// Whether `path` is itself a link (a symlink, or a junction on Windows),
/// whatever it points at.
fn is_link(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| {
        meta.file_type().is_symlink() || is_reparse_point(&meta)
    })
}

#[cfg(windows)]
fn is_reparse_point(meta: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_meta: &fs::Metadata) -> bool {
    false
}

/// Whether anything is at `path`, a dangling link included.
fn present(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

fn is_empty_dir(path: &Path) -> bool {
    !is_link(path) && fs::read_dir(path).is_ok_and(|mut entries| entries.next().is_none())
}

/// Leave a link at `at` that leads to `target`: a symlink on Unix, a
/// directory junction on Windows (a symlink there needs a privilege an
/// ordinary account does not hold).
#[cfg(unix)]
fn link_dir(target: &Path, at: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(target, at).map_err(|e| e.to_string())
}

#[cfg(windows)]
fn link_dir(target: &Path, at: &Path) -> Result<(), String> {
    if std::os::windows::fs::symlink_dir(target, at).is_ok() {
        return Ok(());
    }
    let (target, at) = (target.to_string_lossy(), at.to_string_lossy());
    if target.contains('"') || at.contains('"') {
        return Err("the path holds a quote".into());
    }
    use std::os::windows::process::CommandExt;
    let status = crate::paths::command_no_window("cmd")
        .raw_arg(format!("/C mklink /J \"{at}\" \"{target}\""))
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("mklink /J failed".into())
    }
}

#[cfg(not(any(unix, windows)))]
fn link_dir(_target: &Path, _at: &Path) -> Result<(), String> {
    Err("no directory links on this platform".into())
}

/// Whether the link at `at` leads to `target`.
fn links_to(at: &Path, target: &Path) -> bool {
    match (fs::canonicalize(at), fs::canonicalize(target)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// Move the folder `old` to `new` and leave a link at `old`.
///
/// A rename, not a copy: both names sit in the same parent, so it is atomic
/// and there is never a moment with two half-copies. When it fails (another
/// file system, a locked executable inside on Windows) nothing has changed,
/// the step stays pending, and the app keeps running from `old` — every
/// lookup of these folders tries the current name and then the old one.
///
/// The record is marked `started` inside `old` before the rename and travels
/// with the folder, so a crash between the rename and the link is told apart
/// from a fresh install (which must never get a link under the old name).
///
/// `host_runs_inside`: the phone host may run from inside `old` (the state
/// dir). See the stop before the rename.
fn move_dir(env: &Env, id: &'static str, old: &Path, new: &Path, host_runs_inside: bool) -> StepResult {
    if old == new {
        return Ok(Outcome::NothingToDo);
    }
    let began = matches!(
        env.record().state_of(id),
        Some(StepState::Started | StepState::Pending)
    );
    let old_is_link = is_link(old);
    if old_is_link && links_to(old, new) {
        return Ok(Outcome::Done("moved; the old path links here".into()));
    }
    if !present(old) {
        // Never there, or already moved by a run that stopped before the
        // link was made.
        if began && new.is_dir() {
            return link_old_path(env, new, old);
        }
        return Ok(Outcome::NothingToDo);
    }
    if present(new) {
        // Something already sits under the current name. An empty folder a
        // failed earlier launch created is cleared away; anything else is the
        // user's to sort out, and the current name wins until they do.
        if is_empty_dir(new) {
            fs::remove_dir(new).map_err(|e| format!("clear the empty {}: {e}", new.display()))?;
        } else {
            crate::brand::legacy_hit(id);
            return Ok(Outcome::Pending(format!(
                "both {} and {} exist; the second one is used, the first is left alone",
                old.display(),
                new.display()
            )));
        }
    }
    if host_runs_inside && began && old.join("mobile-control").is_dir() {
        // An earlier launch could not move the folder and ran from it, so the
        // ordinary launch path installed and started the *current* phone host
        // in there. `mobile-host` is done by now and only ever retired the
        // old-named one, so nothing else stops this one — and on Windows its
        // executable locks the folder, failing every later rename. Stop it;
        // the ordinary launch path starts it again from the moved folder.
        env.world.stop_host_in(old);
    }
    super::mark_started(env, id, "moving");
    env.checkpoint("dir:before-rename")?;
    let renamed = env
        .injected("dir:rename")
        .map_err(std::io::Error::other)
        .and_then(|()| fs::rename(old, new));
    if let Err(error) = renamed {
        crate::brand::legacy_hit(id);
        return Ok(Outcome::Pending(format!(
            "could not rename {} to {}: {error}",
            old.display(),
            new.display()
        )));
    }
    env.checkpoint("dir:after-rename")?;
    // `old` was the user's own link to another disk: it moved as a link, and
    // the folder behind it stayed where it is.
    link_old_path(env, new, old)
}

/// Leave the link at `old` after the move. Without it the step is not done:
/// the link is the net for every absolute path nothing rewrote (a VM
/// overlay's base image, a running tmux session's cwd), so a failed one stays
/// `pending`, is listed in Settings → About, and is tried again at the next
/// launch (the record moved with the folder, so `began` holds there).
///
/// A `pending` result is recorded without marking the install upgraded
/// (`run_startup` sets [`Record::upgraded`](super::Record::upgraded) only on
/// `done`). The steps after this one (`state-paths`, `persisted-names`) find
/// the old state in the moved folder on the same launch and set it.
fn link_old_path(env: &Env, new: &Path, old: &Path) -> StepResult {
    match env.injected("dir:link").and_then(|()| link_dir(new, old)) {
        Ok(()) => Ok(Outcome::Done("moved; the old path links here".into())),
        Err(error) => Ok(Outcome::Pending(format!("moved; the old path could not be linked: {error}"))),
    }
}

/// Step `state-paths`: re-point every stored absolute path that named the old
/// state dir at the current one. The link at the old path keeps a missed one
/// working; this is what lets a later release take the link away.
///
/// The holders are the app's own JSON state — the registry files in the state
/// dir, each project's saved session and sync state, and the archive's
/// restore manifests. A file is rewritten only when a path in it changed.
///
/// The state files go through their lock and move their counters, like the
/// name rewrite ([`super::persisted::rewrite_json_locked`]): a phone host the
/// previous launch started can be writing them now. The archive's manifests
/// have no other writer and sit in the user's own tree, so they are rewritten
/// plainly and get no lock file beside them.
pub fn rewrite_state_paths(env: &Env) -> StepResult {
    let Some(old) = env.legacy_state_dir.as_deref() else {
        return Ok(Outcome::NothingToDo);
    };
    let new = env.state_dir.as_path();
    if old == new {
        return Ok(Outcome::NothingToDo);
    }
    // Not moved yet: something still sits at the old path and the move has
    // not finished. Decided before looking at `new` — after a failed rename
    // the current name does not exist, and "nothing there" must not read as a
    // fresh install, or this step is marked done and never re-points the
    // paths once the move succeeds. Asked of the record rather than of the
    // old path's kind, so a user's own link there that has not moved yet
    // counts as not moved. (Moved and linked: `state-dir` is done. Moved but
    // the link failed: nothing is at the old path.)
    if present(old) && env.record().state_of("state-dir") != Some(StepState::Done) {
        return Ok(Outcome::Pending("the state dir has not moved yet".into()));
    }
    if !new.is_dir() {
        return Ok(Outcome::NothingToDo);
    }
    let (old, new) = (old.to_string_lossy().into_owned(), new.to_string_lossy().into_owned());
    let mut rewritten = 0usize;
    for file in state_json_files(&env.state_dir) {
        env.checkpoint("paths:before-file")?;
        let changed = super::persisted::rewrite_json_locked(&file, |value| {
            crate::storage::rewrite_path_prefix(value, &old, &new)
        })?;
        rewritten += usize::from(changed);
    }
    for file in archive_manifests(env) {
        env.checkpoint("paths:before-file")?;
        let Ok(mut value) = crate::storage::read_json::<serde_json::Value>(&file) else {
            continue;
        };
        if crate::storage::rewrite_path_prefix(&mut value, &old, &new) {
            crate::storage::write_json_atomic(&file, &value)
                .map_err(|e| format!("rewrite {}: {e}", file.display()))?;
            rewritten += 1;
        }
    }
    if rewritten == 0 {
        return Ok(Outcome::NothingToDo);
    }
    Ok(Outcome::Done(format!("{rewritten} file(s) re-pointed")))
}

/// `*.json` directly in `dir`.
fn json_files_in(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|ext| ext == "json") && entry.file_type().is_ok_and(|kind| kind.is_file()) {
            out.push(path);
        }
    }
}

/// `*.json` in each direct subfolder of `dir`.
fn json_files_one_level_down(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            json_files_in(&entry.path(), out);
        }
    }
}

/// The app's own JSON state under `state`: the registry files directly in
/// it, each project's saved session, and each remote project's sync state.
/// Not the migrator's own two files.
pub(super) fn state_json_files(state: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    json_files_in(state, &mut files);
    json_files_one_level_down(&state.join("sessions"), &mut files);
    json_files_one_level_down(&state.join("remote-projects"), &mut files);
    files.retain(|file| {
        let name = file.file_name().and_then(|name| name.to_str());
        name != Some(super::RECORD_FILE) && name != Some(super::hits::FILE)
    });
    files.sort();
    files
}

/// The archive's restore manifests in the home tree(s), which may hold an
/// absolute path into the state dir (the state files are the other holders).
fn archive_manifests(env: &Env) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for tree in &env.home_trees {
        json_files_one_level_down(&tree.join("archive"), &mut files);
    }
    files.sort();
    files
}

/// Step `webview-data`: the webview keeps localStorage and IndexedDB in a
/// folder named after the app's identifier. Copy the old folder to the
/// current identifier before the webview first opens it; the old one stays
/// (an older build can still run from it) until a later release deletes it.
///
/// The copy lands under a temporary name and is renamed into place only once
/// it is complete and its size matches, so a crash mid-copy leaves nothing
/// under the current identifier and the step starts over.
pub fn copy_webview_data(env: &Env) -> StepResult {
    let Some((old, new)) = env.webview_data.as_ref() else {
        return Ok(Outcome::NothingToDo);
    };
    if old == new || !old.is_dir() {
        return Ok(Outcome::NothingToDo);
    }
    if present(new) {
        return Ok(Outcome::Done("the current identifier already has its data".into()));
    }
    let staging = sibling(new, ".migrating");
    if present(&staging) {
        fs::remove_dir_all(&staging).map_err(|e| format!("clear {}: {e}", staging.display()))?;
    }
    super::mark_started(env, "webview-data", "copying");
    let copied = copy_tree(env, old, &staging)?;
    env.checkpoint("webview:after-copy")?;
    let source = tree_size(old);
    if copied != source {
        let _ = fs::remove_dir_all(&staging);
        return Ok(Outcome::Pending(format!(
            "the copy does not match ({} of {} bytes); the old webview data changed while it was read",
            copied.bytes, source.bytes
        )));
    }
    fs::rename(&staging, new).map_err(|e| format!("rename {}: {e}", staging.display()))?;
    Ok(Outcome::Done(format!("{} file(s), {} bytes copied", copied.files, copied.bytes)))
}

fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(suffix);
    path.with_file_name(name)
}

/// What a tree holds, for comparing a copy with its source.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct TreeSize {
    pub files: u64,
    pub bytes: u64,
}

/// Files and their total size under `dir`. Links are counted, never followed.
pub(crate) fn tree_size(dir: &Path) -> TreeSize {
    let mut size = TreeSize::default();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                stack.push(entry.path());
            } else if kind.is_file() {
                size.files += 1;
                size.bytes += entry.metadata().map(|meta| meta.len()).unwrap_or(0);
            } else if kind.is_symlink() {
                size.files += 1;
            }
        }
    }
    size
}

/// Copy the tree `from` to `to` (which must not exist). Regular files and
/// folders are copied, symlinks are re-created as links, anything else
/// (sockets, fifos) is skipped. Returns what was written.
pub(crate) fn copy_tree(env: &Env, from: &Path, to: &Path) -> Result<TreeSize, Halt> {
    let mut size = TreeSize::default();
    let mut stack = vec![(from.to_path_buf(), to.to_path_buf())];
    while let Some((from, to)) = stack.pop() {
        fs::create_dir_all(&to).map_err(|e| format!("create {}: {e}", to.display()))?;
        let entries = fs::read_dir(&from).map_err(|e| format!("read {}: {e}", from.display()))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("read {}: {e}", from.display()))?;
            let kind = entry.file_type().map_err(|e| format!("stat {}: {e}", entry.path().display()))?;
            let target = to.join(entry.file_name());
            if kind.is_dir() {
                stack.push((entry.path(), target));
            } else if kind.is_file() {
                env.checkpoint("copy:before-file")?;
                size.bytes += fs::copy(entry.path(), &target)
                    .map_err(|e| format!("copy {}: {e}", entry.path().display()))?;
                size.files += 1;
            } else if kind.is_symlink() {
                copy_link(&entry.path(), &target)?;
                size.files += 1;
            }
        }
    }
    Ok(size)
}

#[cfg(unix)]
fn copy_link(from: &Path, to: &Path) -> Result<(), String> {
    let target = fs::read_link(from).map_err(|e| format!("read link {}: {e}", from.display()))?;
    std::os::unix::fs::symlink(target, to).map_err(|e| format!("link {}: {e}", to.display()))
}

#[cfg(not(unix))]
fn copy_link(from: &Path, _to: &Path) -> Result<(), String> {
    Err(format!("{} is a link; it is not copied on this platform", from.display()))
}
