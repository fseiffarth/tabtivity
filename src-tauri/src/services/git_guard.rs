//! The files inside a repository that make git *run* something, and which a
//! sandbox must therefore keep its occupant from writing (#158).
//!
//! A fenced agent or a project container gets the project read-write, `.git`
//! included — it has to, to commit. But `.git/config` (`core.fsmonitor`,
//! `core.hooksPath`, `core.sshCommand`, filter drivers), `.git/hooks/*`, and
//! the `.git` entry itself (swap the directory for a `gitdir:` pointer file and
//! every one of those comes from wherever the pointer says) are instructions
//! the *next unsandboxed* git follows: Tabtivity's own calls, and the user's
//! terminal. That is the sandbox "trust handoff" escape (Pillar Security,
//! CSA, 2026) — the agent never leaves the box; the host runs what it wrote.
//!
//! [`guard_paths`] names what to re-mount over the read-write project:
//! `pinned` gets a read-write bind onto itself, which only makes it a mount
//! point (renaming or replacing a mount point fails `EBUSY`, verified under
//! bubblewrap); `read_only` gets a read-only bind. Git keeps working — commit,
//! branch, stash, gc and worktree add write objects, refs, the index and lock
//! files, none of them listed here. What an agent loses is `git config` on
//! the repo and installing hooks.
//!
//! **Residual, stated rather than hidden:** a read-only bind can only cover a
//! file that exists. Git creates lock files directly in the git dir, so the
//! dir itself stays writable, and an agent can still *create* a
//! `commondir` in a main `.git` (git then reads config and hooks from where it
//! points — verified: a plain `git add` runs the target's `post-index-change`),
//! or `git init` a repo where there was none. Tabtivity's own local git is not
//! steered by either (#862): every call pins `GIT_COMMON_DIR` to a main `.git`
//! (`commands::git::pin_common_dir`), so a planted `commondir` is ignored, and
//! runs with hooks off except the verbs `services::exec_trust` gates. A plain
//! `git` in the user's terminal still follows a planted `commondir`.

use std::path::{Path, PathBuf};

use crate::services::home_io::HomeFile;

/// Where Tabtivity puts agent worktrees inside a project (`commands::git`'s
/// `worktrees_root`). Each holds a `.git` pointer file the occupant could
/// otherwise rewrite.
const WORKTREES_DIR: [&str; 2] = [crate::brand::PROJECT_DIR, "worktrees"];

/// Files in a git dir that name programs git runs, or redirect where git reads
/// them from.
const CONTROL_FILES: [&str; 4] = ["config", "config.worktree", "hooks", "commondir"];

#[derive(Debug, Default, PartialEq, Eq)]
pub struct GuardPaths {
    /// Bind read-write onto itself: a mount point cannot be renamed away.
    pub pinned: Vec<PathBuf>,
    /// Bind read-only onto itself.
    pub read_only: Vec<PathBuf>,
}

/// The git control paths to protect for a sandbox whose writable roots are
/// `roots` and which starts in `cwd` (`None` for a container, which has no
/// single start dir). Only paths that exist and lie inside a writable root are
/// named — everything else is already read-only to the occupant, and a mount
/// over a missing path would create it on the host.
pub fn guard_paths(roots: &[PathBuf], cwd: Option<&Path>) -> GuardPaths {
    let roots: Vec<PathBuf> = roots
        .iter()
        .map(|r| r.canonicalize().unwrap_or_else(|_| r.clone()))
        .collect();
    let inside = |p: &Path| roots.iter().any(|r| p.starts_with(r));
    let mut starts: Vec<PathBuf> = roots.clone();
    if let Some(cwd) = cwd {
        // The nearest `.git` above the start dir is the one git discovers.
        let cwd = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
        if let Some(dir) = cwd.ancestors().filter(|d| inside(d)).find(|d| d.join(".git").exists()) {
            starts.push(dir.to_path_buf());
        }
    }
    // A project not opened since a rename still keeps its worktrees in the
    // app's folder under the old name; they are guarded the same.
    let legacy_dir = crate::brand::PAIR.legacy(crate::brand::Name::PROJECT_DIR);
    for root in &roots {
        for app_dir in std::iter::once(WORKTREES_DIR[0]).chain(legacy_dir.as_deref()) {
            if let Ok(entries) = std::fs::read_dir(root.join(app_dir).join(WORKTREES_DIR[1])) {
                starts.extend(entries.flatten().map(|e| e.path()));
            }
        }
    }

    let mut out = GuardPaths::default();
    let mut git_dirs: Vec<PathBuf> = Vec::new();
    for dir in starts {
        let dot_git = dir.join(".git");
        let Ok(meta) = std::fs::symlink_metadata(&dot_git) else { continue };
        if meta.is_dir() {
            git_dirs.push(dot_git);
        } else if meta.is_file() {
            // A pointer: pin it by binding it read-only, then guard its target.
            out.read_only.push(dot_git.clone());
            if let Some(target) = pointer_target(&dot_git) {
                git_dirs.push(target);
            }
        }
    }
    // A linked worktree's git dir shares its common dir's config and hooks.
    for dir in git_dirs.clone() {
        // Agent-writable (gap 29): a FIFO here must not hang a spawn.
        if let Some(text) = crate::services::home_io::read_record(&dir.join("commondir")) {
            let common = text.trim();
            if !common.is_empty() {
                git_dirs.push(dir.join(common));
            }
        }
    }
    for dir in git_dirs {
        let Ok(dir) = dir.canonicalize() else { continue };
        if !inside(&dir) {
            continue;
        }
        // Only a `.git` dir is pinned: a worktree's git dir lives inside the
        // main one, which pinning already holds in place.
        if dir.file_name().is_some_and(|n| n == ".git") {
            out.pinned.push(dir.clone());
        }
        out.read_only
            .extend(CONTROL_FILES.iter().map(|f| dir.join(f)).filter(|p| p.exists()));
    }
    dedupe(&mut out.pinned);
    dedupe(&mut out.read_only);
    out
}

/// The git dir a `.git` pointer file names (`gitdir: <path>`, relative to the
/// pointer's folder).
fn pointer_target(dot_git: &Path) -> Option<PathBuf> {
    let text = crate::services::home_io::read_record(dot_git)?;
    let target = text.lines().find_map(|l| l.strip_prefix("gitdir:"))?.trim();
    if target.is_empty() {
        return None;
    }
    Some(dot_git.parent()?.join(target)) // an absolute target replaces the base
}

fn dedupe(paths: &mut Vec<PathBuf>) {
    let mut seen = std::collections::HashSet::new();
    paths.retain(|p| seen.insert(p.clone()));
}

// ---------------------------------------------------------------------------
// `info/` — not guarded, so read and written by handle (#2347)
// ---------------------------------------------------------------------------
//
// `<git dir>/info/` stays writable to the occupant: `git sparse-checkout`
// writes `info/sparse-checkout` (it fails outright on a read-only `info/`),
// and every repack — `git gc`, the auto-gc after a commit — rewrites
// `info/refs` and prints an error when it can't (both verified, git 2.53).
// So a fenced agent can swap `info` or `info/exclude` for a link (into
// `~/.profile`, say), or plant a FIFO there. Tabtivity's own unfenced reads
// and writes of those files therefore go through `services::home_io`
// handles: `info` opened with `O_DIRECTORY | O_NOFOLLOW` relative to the git
// dir, the file opened `O_NOFOLLOW | O_NONBLOCK` and checked regular on the
// opened inode, a write landing as an exclusive temporary in the held `info`
// folder renamed over the name. A link or anything but a folder/regular file
// is refused, never followed or replaced. Windows (no fence) keeps the
// path-based `symlink_metadata` checks behind the same API.

/// `<git_dir>/info/<name>`, held by handle. `Ok(None)` when it (or `info`)
/// is missing; `Err` names why it is refused.
fn info_file(git_dir: &Path, name: &str, create_info: bool) -> Result<Option<HomeFile>, String> {
    let info = git_dir.join("info");
    match std::fs::symlink_metadata(&info) {
        Ok(meta) if meta.file_type().is_symlink() => return Err(format!("{} is a link", info.display())),
        Ok(meta) if !meta.is_dir() => return Err(format!("{} is not a folder", info.display())),
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && !create_info => return Ok(None),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("{}: {e}", info.display())),
    }
    // Never make the git dir itself: it came from git, so a missing one is a
    // race or a mistake, not something to create.
    if !git_dir.is_dir() {
        return Ok(None);
    }
    // A missing `info` is made the way git makes it (`0777` less the umask,
    // not `HomeDir`'s private `0700`); `mkdir` never follows a link at the
    // name, and the handle open below re-checks whatever is there.
    if create_info {
        if let Err(e) = std::fs::create_dir(&info) {
            if e.kind() != std::io::ErrorKind::AlreadyExists {
                return Err(format!("{}: {e}", info.display()));
            }
        }
    }
    let file = HomeFile::open_existing(git_dir, &format!("info/{name}"));
    // The `lstat` above only words the refusal; the handle open is what
    // refuses a link that appeared since.
    let Some(file) = file else {
        return Err(format!("{} could not be opened as a plain folder", info.display()));
    };
    match file.metadata() {
        // Missing: the handle is still good for creating it.
        None => Ok(Some(file)),
        Some(meta) if meta.is_symlink => Err(format!("{} is a link", file.path().display())),
        Some(meta) if !meta.is_file => Err(format!("{} is not a regular file", file.path().display())),
        Some(_) => Ok(Some(file)),
    }
}

/// The most of an `info/` file Tabtivity reads: a fenced agent can make it
/// as large (or as sparse) as it likes.
const MAX_INFO_BYTES: u64 = 4 << 20;

/// Read a held regular file as UTF-8, with its permission bits (`None` where
/// the platform has none). `Err` when it changed into something else since
/// it was checked, is larger than [`MAX_INFO_BYTES`], or is not text.
fn read_text(file: &HomeFile) -> Result<(String, Option<u32>), String> {
    use std::io::Read;
    let unreadable = || format!("{} is not a readable regular file", file.path().display());
    let opened = file.open_read().ok_or_else(unreadable)?;
    #[cfg(unix)]
    let mode = {
        use std::os::unix::fs::PermissionsExt;
        Some(opened.metadata().map_err(|_| unreadable())?.permissions().mode() & 0o7777)
    };
    #[cfg(not(unix))]
    let mode = None;
    let mut bytes = Vec::new();
    opened
        .take(MAX_INFO_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| unreadable())?;
    if bytes.len() as u64 > MAX_INFO_BYTES {
        return Err(format!("{} is larger than {MAX_INFO_BYTES} bytes", file.path().display()));
    }
    let text = String::from_utf8(bytes).map_err(|_| format!("{} is not UTF-8 text", file.path().display()))?;
    Ok((text, mode))
}

/// Open `<git_dir>/info/<name>` for reading without following a link or
/// blocking on a FIFO: `Ok(None)` when missing, `Err(why)` when `info` or the
/// file is a link or not a folder / regular file.
pub fn open_info_file(git_dir: &Path, name: &str) -> Result<Option<std::fs::File>, String> {
    match info_file(git_dir, name, false)? {
        Some(file) if file.exists() => file
            .open_read()
            .map(Some)
            .ok_or_else(|| format!("{} is not a readable regular file", file.path().display())),
        _ => Ok(None),
    }
}

/// The git dir's `info/exclude` as text: `Ok(None)` when missing,
/// `Err(why)` when refused (see [`open_info_file`]).
pub fn read_info_exclude(git_dir: &Path) -> Result<Option<String>, String> {
    match info_file(git_dir, "exclude", false)? {
        Some(file) if file.exists() => read_text(&file).map(|(text, _)| Some(text)),
        _ => Ok(None),
    }
}

/// Edit the git dir's `info/exclude` in place: `edit` gets its text (empty
/// when missing) and returns the new text, or `None` to leave it. `Ok(true)`
/// when it was written, keeping the file's permission bits. A missing `info`
/// is created; a linked or non-folder `info`, or an `exclude` that is a link
/// or not a regular UTF-8 file (or larger than [`MAX_INFO_BYTES`]), is
/// refused (`Err(why)`) and left exactly as it is. The write replaces the
/// name inside the held `info` folder, so a link swapped in meanwhile is
/// replaced, never written through.
pub fn edit_info_exclude(git_dir: &Path, edit: impl FnOnce(&str) -> Option<String>) -> Result<bool, String> {
    let Some(file) = info_file(git_dir, "exclude", true)? else {
        return Err(format!("{} is not a git folder", git_dir.display()));
    };
    let (text, mode) = if file.exists() { read_text(&file)? } else { (String::new(), None) };
    let Some(next) = edit(&text) else { return Ok(false) };
    if next == text {
        return Ok(false);
    }
    // A rewrite keeps the file's permission bits; a new one gets git's usual
    // `0644` less the umask.
    file.write_keeping_mode(next.as_bytes(), mode)
        .map(|()| true)
        .map_err(|e| format!("{}: {e}", file.path().display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn git(dir: &Path, args: &[&str]) {
        let ok = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        assert!(ok, "git {args:?} failed in {}", dir.display());
    }

    fn repo() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap().join("proj");
        fs::create_dir_all(&root).unwrap();
        git(&root, &["init", "-q"]);
        git(
            &root,
            &["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "i"],
        );
        (tmp, root)
    }

    #[test]
    fn a_plain_repo_pins_dot_git_and_guards_config_and_hooks() {
        let (_tmp, root) = repo();
        let g = guard_paths(std::slice::from_ref(&root), Some(&root.join("sub")));
        assert_eq!(g.pinned, vec![root.join(".git")]);
        assert!(g.read_only.contains(&root.join(".git").join("config")));
        assert!(g.read_only.contains(&root.join(".git").join("hooks")));
        // Absent files are never named: a mount would create them on the host.
        assert!(!g.read_only.contains(&root.join(".git").join("config.worktree")));
        assert!(!g.read_only.contains(&root.join(".git").join("commondir")));
    }

    #[test]
    fn an_app_worktree_guards_its_pointer_and_its_git_dir() {
        let (_tmp, root) = repo();
        let wt = root.join(WORKTREES_DIR[0]).join(WORKTREES_DIR[1]).join("feat");
        // Relative: git can't parse the `\\?\` verbatim root Windows canonicalizes to.
        let rel = format!("{}/{}/feat", WORKTREES_DIR[0], WORKTREES_DIR[1]);
        git(&root, &["worktree", "add", "-q", &rel, "-b", "feat"]);
        let g = guard_paths(std::slice::from_ref(&root), None);
        assert!(g.read_only.contains(&wt.join(".git")), "pointer file");
        let wt_git = root.join(".git").join("worktrees").join("feat");
        assert!(g.read_only.contains(&wt_git.join("commondir")), "{g:?}");
        assert!(g.read_only.contains(&root.join(".git").join("config")));
        assert_eq!(g.pinned, vec![root.join(".git")]);
    }

    #[test]
    fn a_hostile_pointer_is_pinned_and_its_target_guarded() {
        let (_tmp, root) = repo();
        fs::rename(root.join(".git"), root.join(".notgit")).unwrap();
        fs::write(root.join(".git"), "gitdir: .notgit\n").unwrap();
        let g = guard_paths(std::slice::from_ref(&root), Some(&root));
        assert!(g.read_only.contains(&root.join(".git")));
        assert!(g.read_only.contains(&root.join(".notgit").join("config")));
        assert!(g.read_only.contains(&root.join(".notgit").join("hooks")));
    }

    /// Gap 29: `commondir` and the `.git` pointer are agent-writable and read
    /// at every fenced spawn and push preflight. A FIFO there must not hang
    /// either; a link or an oversized pointer names nothing.
    #[cfg(unix)]
    #[test]
    fn a_fifo_linked_or_huge_commondir_or_pointer_is_not_read() {
        use crate::services::home_io::{mkfifo, within_deadline, RECORD_CAP};
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap().join("proj");
        fs::create_dir_all(root.join(".git/hooks")).unwrap();
        fs::write(root.join(".git/config"), "").unwrap();
        mkfifo(&root.join(".git/commondir"));
        let at = root.clone();
        let g = within_deadline(move || guard_paths(std::slice::from_ref(&at), Some(&at)));
        assert_eq!(g.pinned, vec![root.join(".git")]);
        assert!(g.read_only.contains(&root.join(".git/config")));

        let pointer = tmp.path().join("pointer");
        mkfifo(&pointer);
        let at = pointer.clone();
        assert_eq!(within_deadline(move || pointer_target(&at)), None);
        fs::remove_file(&pointer).unwrap();
        let elsewhere = tmp.path().join("elsewhere");
        fs::write(&elsewhere, "gitdir: /x\n").unwrap();
        std::os::unix::fs::symlink(&elsewhere, &pointer).unwrap();
        assert_eq!(pointer_target(&pointer), None);
        fs::remove_file(&pointer).unwrap();
        let mut huge = b"gitdir: /x\n".to_vec();
        huge.resize(RECORD_CAP as usize + 1, b'\n');
        fs::write(&pointer, &huge).unwrap();
        assert_eq!(pointer_target(&pointer), None);
        fs::write(&pointer, "gitdir: /x\n").unwrap();
        assert_eq!(pointer_target(&pointer), Some(PathBuf::from("/x")));
    }

    #[test]
    fn a_git_dir_outside_the_writable_roots_is_left_alone() {
        let (tmp, root) = repo();
        let project = root.join("sub");
        fs::create_dir_all(&project).unwrap();
        // The repo root is above the only writable root: already read-only.
        let g = guard_paths(std::slice::from_ref(&project), Some(&project));
        assert_eq!(g, GuardPaths::default());
        drop(tmp);
    }

    fn append_rule(text: &str) -> Option<String> {
        let rule = crate::brand::PROJECT_DIR_EXCLUDE_RULE;
        if text.lines().any(|l| l == rule) {
            return None;
        }
        Some(format!("{text}{rule}\n"))
    }

    #[test]
    fn a_plain_exclude_is_appended_once_and_a_missing_info_is_made() {
        let (_tmp, root) = repo();
        let git_dir = root.join(".git");
        let exclude = git_dir.join("info").join("exclude");
        fs::write(&exclude, "*.log\n").unwrap();
        assert_eq!(edit_info_exclude(&git_dir, append_rule), Ok(true));
        assert_eq!(edit_info_exclude(&git_dir, append_rule), Ok(false));
        let want = format!("*.log\n{}\n", crate::brand::PROJECT_DIR_EXCLUDE_RULE);
        assert_eq!(fs::read_to_string(&exclude).unwrap(), want);
        assert_eq!(read_info_exclude(&git_dir), Ok(Some(want)));

        fs::remove_dir_all(git_dir.join("info")).unwrap();
        assert_eq!(read_info_exclude(&git_dir), Ok(None));
        assert!(open_info_file(&git_dir, "attributes").unwrap().is_none());
        assert_eq!(edit_info_exclude(&git_dir, append_rule), Ok(true));
        assert_eq!(fs::read_to_string(&exclude).unwrap(), format!("{}\n", crate::brand::PROJECT_DIR_EXCLUDE_RULE));
    }

    /// #2347: a fenced agent can replace `info/exclude` or `info/` with a
    /// link; neither is followed, and the target stays exactly as it was.
    #[cfg(unix)]
    #[test]
    fn a_linked_exclude_or_info_is_refused_and_its_target_untouched() {
        let (tmp, root) = repo();
        let git_dir = root.join(".git");
        let victim = tmp.path().join("profile");
        fs::write(&victim, "export PATH\n").unwrap();
        fs::remove_file(git_dir.join("info").join("exclude")).unwrap();
        std::os::unix::fs::symlink(&victim, git_dir.join("info").join("exclude")).unwrap();
        assert!(read_info_exclude(&git_dir).is_err());
        assert!(edit_info_exclude(&git_dir, append_rule).is_err());
        assert!(open_info_file(&git_dir, "exclude").is_err());
        assert_eq!(fs::read_to_string(&victim).unwrap(), "export PATH\n");
        assert!(fs::symlink_metadata(git_dir.join("info").join("exclude")).unwrap().file_type().is_symlink());

        let elsewhere = tmp.path().join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        fs::write(elsewhere.join("exclude"), "mine\n").unwrap();
        fs::remove_dir_all(git_dir.join("info")).unwrap();
        std::os::unix::fs::symlink(&elsewhere, git_dir.join("info")).unwrap();
        assert!(read_info_exclude(&git_dir).is_err());
        assert!(edit_info_exclude(&git_dir, append_rule).is_err());
        assert!(open_info_file(&git_dir, "attributes").is_err());
        assert_eq!(fs::read_to_string(elsewhere.join("exclude")).unwrap(), "mine\n");
        assert_eq!(fs::read_dir(&elsewhere).unwrap().count(), 1, "no temporary left behind");
    }

    /// A FIFO or a folder at the name is refused without blocking.
    #[cfg(unix)]
    #[test]
    fn a_fifo_or_folder_exclude_is_refused_without_blocking() {
        let (_tmp, root) = repo();
        let git_dir = root.join(".git");
        let exclude = git_dir.join("info").join("exclude");
        fs::remove_file(&exclude).unwrap();
        let c = std::ffi::CString::new(exclude.to_string_lossy().into_owned()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        assert!(read_info_exclude(&git_dir).is_err());
        assert!(edit_info_exclude(&git_dir, append_rule).is_err());
        fs::remove_file(&exclude).unwrap();
        fs::create_dir(&exclude).unwrap();
        assert!(edit_info_exclude(&git_dir, append_rule).is_err());
        assert!(exclude.is_dir() && fs::read_dir(&exclude).unwrap().count() == 0);
    }

    /// A rewrite keeps the file's own permission bits; a new `exclude` and a
    /// new `info` get git's usual modes less the umask, not `0600`/`0700`.
    #[cfg(unix)]
    #[test]
    fn a_rewritten_exclude_keeps_its_mode_and_a_new_one_gets_gits() {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o7777;
        let (tmp, root) = repo();
        let git_dir = root.join(".git");
        let exclude = git_dir.join("info").join("exclude");
        for kept in [0o640, 0o444, 0o664] {
            fs::write(&exclude, "*.log\n").unwrap();
            fs::set_permissions(&exclude, fs::Permissions::from_mode(kept)).unwrap();
            assert_eq!(edit_info_exclude(&git_dir, append_rule), Ok(true));
            assert_eq!(mode(&exclude), kept);
            fs::set_permissions(&exclude, fs::Permissions::from_mode(0o644)).unwrap();
            fs::remove_file(&exclude).unwrap();
        }
        // What the umask leaves of `0666` / `0777`, measured without
        // touching the process umask.
        let probe_file = tmp.path().join("probe");
        fs::write(&probe_file, "").unwrap();
        let probe_dir = tmp.path().join("probe-dir");
        fs::create_dir(&probe_dir).unwrap();
        fs::remove_dir_all(git_dir.join("info")).unwrap();
        assert_eq!(edit_info_exclude(&git_dir, append_rule), Ok(true));
        assert_eq!(mode(&exclude), 0o644 & mode(&probe_file));
        assert_eq!(mode(&git_dir.join("info")), mode(&probe_dir));
    }

    /// An `exclude` past the read cap (a sparse file costs the agent nothing)
    /// is refused, not read whole, and left as it is.
    #[cfg(unix)]
    #[test]
    fn an_oversized_exclude_is_refused_unread() {
        let (_tmp, root) = repo();
        let git_dir = root.join(".git");
        let exclude = git_dir.join("info").join("exclude");
        fs::File::create(&exclude).unwrap().set_len(MAX_INFO_BYTES + 1).unwrap();
        assert!(read_info_exclude(&git_dir).is_err());
        assert!(edit_info_exclude(&git_dir, append_rule).is_err());
        assert_eq!(fs::metadata(&exclude).unwrap().len(), MAX_INFO_BYTES + 1);
    }

    #[test]
    fn no_repo_names_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        assert_eq!(guard_paths(std::slice::from_ref(&root), Some(&root)), GuardPaths::default());
    }
}
