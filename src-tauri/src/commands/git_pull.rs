//! Fetch, the pull preview, the pull itself and the merge it can leave behind —
//! the Git panel's Pull flow.
//!
//! The flow is **fetch → look → apply**, never a blind `git pull`:
//!
//! * [`git_fetch`] updates the remote-tracking refs (and so every branch's
//!   ahead/behind count). It routes exactly like `git::git_push`.
//! * [`git_pull_preview`] reads what a pull would bring, from those refs alone —
//!   no network, so what the user reviews is exactly what gets applied.
//! * [`git_pull_apply`] then merges **the previewed tracking ref**, not whatever
//!   a second fetch would find: `merge --ff-only` by default, a real merge only
//!   when asked, and only on the checked-out branch. A branch that is not checked
//!   out can only fast-forward (`fetch . <upstream>:<branch>` — nothing to merge
//!   in without a working tree).
//! * A merge that stops on conflicts is left in git's own merge state; the
//!   `gitmerge` viewer resolves one file at a time ([`git_merge_sides`] feeds the
//!   shared three-way `CompareView`), then [`git_merge_commit`] or
//!   [`git_merge_abort`] ends it.
//!
//! Merging and committing run the repo's hooks, so they are gated like commit
//! and push (`require_hook_trust`) and are the only calls here that go through
//! `run_git_hooked`; everything else — the fetch, the branch fast-forward, the
//! merge-state probes, the abort — runs with hooks pinned off like every other
//! Tabtivity git call (#862: the conflicted-file probe rewrites the index and would
//! fire `post-index-change` on merely opening the Git panel).

use std::path::{Path, PathBuf};

use crate::commands::git::{
    selected_git_context, GitWorktreeSelection, check_rev, hardened_git_command_in, local_non_repo, require_hook_trust, run_git,
    run_git_hooked, run_off_thread, scoped_token_config,
};
use crate::services::remote::{remote_target_for_dir, RemoteTarget};

/// What pulling a branch would do, read from the remote-tracking refs.
#[derive(serde::Serialize)]
pub struct PullPreview {
    pub branch: String,
    /// Short upstream name for display (`origin/main`).
    pub upstream: String,
    pub is_current: bool,
    /// `<short> <subject>` of each commit the upstream has and the branch lacks.
    pub incoming: Vec<String>,
    /// …and the branch's own commits the upstream lacks. Non-empty = diverged:
    /// no fast-forward, only a merge.
    pub outgoing: Vec<String>,
    pub files: Vec<PullFile>,
}

/// One file the upstream changed since the merge base.
#[derive(serde::Serialize)]
pub struct PullFile {
    pub path: String,
    /// git's `--name-status` letter: `A`, `M`, `D`, `T`.
    pub status: String,
    /// The branch changed it too — where a merge can conflict.
    pub both: bool,
}

#[derive(serde::Serialize)]
pub struct PullOutcome {
    /// Files a merge stopped on; empty when it completed.
    pub conflicts: Vec<String>,
    /// git's own report.
    pub message: String,
}

#[derive(serde::Serialize)]
pub struct MergeState {
    pub merging: bool,
    pub conflicts: Vec<String>,
}

/// The two texts the `gitmerge` viewer compares for one file.
#[derive(serde::Serialize)]
pub struct MergeSides {
    /// `"conflict"`: ours vs theirs of an unresolved merge — Apply writes the
    /// result and stages it. `"incoming"`: HEAD vs its upstream — a preview only.
    pub mode: String,
    pub repo: String,
    pub rel: String,
    pub left: String,
    pub right: String,
    /// The refs the two sides come from (`HEAD`, `origin/main`, `MERGE_HEAD`).
    pub left_ref: String,
    pub right_ref: String,
}

fn stdout_of(out: &std::process::Output) -> String {
    String::from_utf8_lossy(&out.stdout).to_string()
}

fn err_of(out: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if stderr.is_empty() {
        stdout_of(out).trim().to_string()
    } else {
        stderr
    }
}

/// `git <args>`, failing with git's own words.
fn git_ok(target: Option<&RemoteTarget>, dir: &str, args: &[&str]) -> Result<String, String> {
    let out = run_git(target, dir, args)?;
    if !out.status.success() {
        return Err(err_of(&out));
    }
    Ok(stdout_of(&out))
}

/// The branch a pull is about: `branch`, or the checked-out one when `None`.
/// Returns `(name, is_current)`.
fn resolve_branch(
    target: Option<&RemoteTarget>,
    dir: &str,
    branch: Option<&str>,
) -> Result<(String, bool), String> {
    let current = run_git(target, dir, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .ok()
        .filter(|o| o.status.success())
        .map(|o| stdout_of(&o).trim().to_string())
        .filter(|s| !s.is_empty());
    match branch {
        Some(b) => {
            check_rev(b)?;
            Ok((b.to_string(), current.as_deref() == Some(b)))
        }
        None => current
            .map(|c| (c, true))
            .ok_or_else(|| "HEAD is detached — there is no branch to pull into".to_string()),
    }
}

/// `(full ref, short name)` of `branch`'s upstream.
fn upstream_of(target: Option<&RemoteTarget>, dir: &str, branch: &str) -> Result<(String, String), String> {
    // `for-each-ref`, not `rev-parse <ref>@{u}`: the latter rejects a full
    // `refs/heads/…` spelling, and a short one can be shadowed by a tag.
    let local = format!("refs/heads/{branch}");
    let listed = git_ok(target, dir, &["for-each-ref", "--format=%(refname)%1f%(upstream)", &local])?;
    let full = listed
        .lines()
        .filter_map(|l| l.split_once('\u{1f}'))
        .find(|(name, _)| *name == local)
        .map(|(_, up)| up.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("'{branch}' has no upstream branch to pull from"))?;
    check_rev(&full)?;
    let short = full
        .strip_prefix("refs/remotes/")
        .or_else(|| full.strip_prefix("refs/heads/"))
        .unwrap_or(&full)
        .to_string();
    Ok((full, short))
}

fn oneline(target: Option<&RemoteTarget>, dir: &str, range: &str) -> Result<Vec<String>, String> {
    Ok(git_ok(target, dir, &["log", "--format=%h %s", range, "--"])?
        .lines()
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect())
}

/// NUL-separated `--name-only -z` output → paths.
fn nul_paths(text: &str) -> Vec<String> {
    text.split('\0').filter(|p| !p.is_empty()).map(str::to_string).collect()
}

/// `--name-status -z` output → `(status letter, path)` pairs.
fn parse_name_status(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut it = text.split('\0').filter(|s| !s.is_empty());
    while let (Some(status), Some(path)) = (it.next(), it.next()) {
        out.push((status.chars().next().unwrap_or('M').to_string(), path.to_string()));
    }
    out
}

fn conflicted(target: Option<&RemoteTarget>, dir: &str) -> Vec<String> {
    run_git(target, dir, &["diff", "--name-only", "--diff-filter=U", "-z"])
        .ok()
        .filter(|o| o.status.success())
        .map(|o| nul_paths(&stdout_of(&o)))
        .unwrap_or_default()
}

fn is_merging(target: Option<&RemoteTarget>, dir: &str) -> bool {
    run_git(target, dir, &["rev-parse", "-q", "--verify", "MERGE_HEAD"])
        .map(|o| o.status.success())
        .unwrap_or(false)
}

// ── Fetch ────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn git_fetch(
    project_dir: String,
    project_id: Option<String>,
    worktree: Option<GitWorktreeSelection>,
) -> Result<String, String> {
    run_off_thread(move || {
        if worktree.is_none() {
            return git_fetch_blocking(project_dir, project_id);
        }
        let (dir, target) = selected_git_context(project_dir, worktree.as_ref())?;
        let out = if let Some(target) = target {
            run_git(Some(&target), &dir, &["fetch"])?
        } else {
            let token = project_id
                .as_deref()
                .and_then(|id| crate::commands::git_hosting::effective_git_creds(id).1);
            fetch_local(Path::new(&dir), token.as_deref(), project_id.as_deref())?
        };
        if !out.status.success() {
            return Err(err_of(&out));
        }
        Ok(err_of(&out))
    })
    .await
}

/// `git fetch` in a local directory with push's scoped token auth.
fn fetch_local(dir: &Path, token: Option<&str>, project_id: Option<&str>) -> Result<std::process::Output, String> {
    let mut args: Vec<String> = Vec::new();
    if token.is_some() {
        let origins = crate::commands::git_hosting::token_origins(project_id, None);
        args.extend(scoped_token_config(&origins, "x-access-token"));
    }
    args.push("fetch".to_string());
    let mut cmd = hardened_git_command_in(dir, &args);
    if let Some(tok) = token {
        cmd.env(crate::app_env!("GIT_TOKEN"), tok);
        cmd.env("GIT_TERMINAL_PROMPT", "0");
    }
    cmd.output().map_err(|e| e.to_string())
}

/// Routed like `git::git_push_blocking`: a remote project whose `origin` lives on
/// the lockstep mirror fetches there, any other remote project on its host with
/// the host's own credentials, a local project here with its effective token.
fn git_fetch_blocking(project_dir: String, project_id: Option<String>) -> Result<String, String> {
    let out = if let Some(target) = remote_target_for_dir(&project_dir) {
        match crate::commands::git_publish::mirror_origin_repo(&target.project_id) {
            Some(mirror) => {
                let token = crate::commands::git_hosting::effective_git_creds(&target.project_id).1;
                fetch_local(&mirror, token.as_deref(), Some(&target.project_id))?
            }
            None => run_git(Some(&target), &project_dir, &["fetch"])?,
        }
    } else {
        let token = project_id
            .as_deref()
            .and_then(|id| crate::commands::git_hosting::effective_git_creds(id).1);
        fetch_local(Path::new(&project_dir), token.as_deref(), project_id.as_deref())?
    };
    if !out.status.success() {
        return Err(err_of(&out));
    }
    Ok(err_of(&out))
}

// ── Preview ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn git_pull_preview(
    project_dir: String,
    branch: Option<String>,
    worktree: Option<GitWorktreeSelection>,
) -> Result<PullPreview, String> {
    run_off_thread(move || match worktree {
        None => git_pull_preview_blocking(project_dir, branch),
        Some(selection) => git_pull_preview_blocking_selected(project_dir, branch, Some(selection)),
    })
    .await
}

fn git_pull_preview_blocking(
    project_dir: String,
    branch: Option<String>,
) -> Result<PullPreview, String> {
    git_pull_preview_blocking_selected(project_dir, branch, None)
}

fn git_pull_preview_blocking_selected(
    project_dir: String,
    branch: Option<String>,
    worktree: Option<GitWorktreeSelection>,
) -> Result<PullPreview, String> {
    let (project_dir, target) = selected_git_context(project_dir, worktree.as_ref())?;
    let t = target.as_ref();
    if local_non_repo(t, &project_dir) {
        return Err("not a git repository".to_string());
    }
    let (branch, is_current) = resolve_branch(t, &project_dir, branch.as_deref())?;
    let (up, upstream) = upstream_of(t, &project_dir, &branch)?;
    let local = format!("refs/heads/{branch}");
    let incoming = oneline(t, &project_dir, &format!("{local}..{up}"))?;
    let outgoing = oneline(t, &project_dir, &format!("{up}..{local}"))?;
    // Three dots: each side's changes since the merge base, so `files` is what
    // the upstream did and `mine` what the branch did.
    let theirs = git_ok(
        t,
        &project_dir,
        &[
            "diff",
            "--no-renames",
            "--name-status",
            "-z",
            &format!("{local}...{up}"),
            "--",
        ],
    )?;
    let mine: std::collections::HashSet<String> = if outgoing.is_empty() {
        Default::default()
    } else {
        nul_paths(&git_ok(
            t,
            &project_dir,
            &[
                "diff",
                "--no-renames",
                "--name-only",
                "-z",
                &format!("{up}...{local}"),
                "--",
            ],
        )?)
        .into_iter()
        .collect()
    };
    let files = parse_name_status(&theirs)
        .into_iter()
        .map(|(status, path)| PullFile {
            both: mine.contains(&path),
            status,
            path,
        })
        .collect();
    Ok(PullPreview {
        branch,
        upstream,
        is_current,
        incoming,
        outgoing,
        files,
    })
}

// ── Apply ────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn git_pull_apply(
    project_dir: String,
    branch: Option<String>,
    merge: bool,
    worktree: Option<GitWorktreeSelection>,
) -> Result<PullOutcome, String> {
    run_off_thread(move || match worktree {
        None => git_pull_apply_blocking(project_dir, branch, merge),
        Some(selection) => {
            git_pull_apply_blocking_selected(project_dir, branch, merge, Some(selection))
        }
    })
    .await
}

fn git_pull_apply_blocking(
    project_dir: String,
    branch: Option<String>,
    merge: bool,
) -> Result<PullOutcome, String> {
    git_pull_apply_blocking_selected(project_dir, branch, merge, None)
}

fn git_pull_apply_blocking_selected(
    project_dir: String,
    branch: Option<String>,
    merge: bool,
    worktree: Option<GitWorktreeSelection>,
) -> Result<PullOutcome, String> {
    let (project_dir, target) = selected_git_context(project_dir, worktree.as_ref())?;
    let t = target.as_ref();
    let (branch, is_current) = resolve_branch(t, &project_dir, branch.as_deref())?;
    let (up, _) = upstream_of(t, &project_dir, &branch)?;

    if !is_current {
        if merge {
            return Err(format!(
                "'{branch}' is not checked out — only a fast-forward can update it; check it out to merge"
            ));
        }
        // A fetch from this very repo: refuses anything but a fast-forward, and
        // refuses a branch checked out in another worktree.
        let refspec = format!("{up}:refs/heads/{branch}");
        let message = git_ok(t, &project_dir, &["fetch", ".", &refspec])?;
        return Ok(PullOutcome {
            conflicts: vec![],
            message,
        });
    }

    require_hook_trust(t, &project_dir)?;
    let args: Vec<&str> = if merge {
        vec!["merge", "--no-edit", &up]
    } else {
        vec!["merge", "--ff-only", &up]
    };
    let out = run_git_hooked(t, &project_dir, &args)?;
    if out.status.success() {
        return Ok(PullOutcome {
            conflicts: vec![],
            message: stdout_of(&out),
        });
    }
    // A merge that stopped on conflicts is not an error: it is the next step.
    if merge && is_merging(t, &project_dir) {
        let conflicts = conflicted(t, &project_dir);
        if !conflicts.is_empty() {
            return Ok(PullOutcome {
                conflicts,
                message: stdout_of(&out),
            });
        }
    }
    Err(err_of(&out))
}

// ── The merge it can leave ───────────────────────────────────────────────────

#[tauri::command]
pub async fn git_merge_state(
    project_dir: String,
    worktree: Option<GitWorktreeSelection>,
) -> Result<MergeState, String> {
    run_off_thread(move || {
        let (project_dir, target) = selected_git_context(project_dir, worktree.as_ref())?;
        let t = target.as_ref();
        if local_non_repo(t, &project_dir) || !is_merging(t, &project_dir) {
            return Ok(MergeState {
                merging: false,
                conflicts: vec![],
            });
        }
        Ok(MergeState {
            merging: true,
            conflicts: conflicted(t, &project_dir),
        })
    })
    .await
}

#[tauri::command]
pub async fn git_merge_abort(
    project_dir: String,
    worktree: Option<GitWorktreeSelection>,
) -> Result<(), String> {
    run_off_thread(move || {
        let (project_dir, target) = selected_git_context(project_dir, worktree.as_ref())?;
        git_ok(target.as_ref(), &project_dir, &["merge", "--abort"]).map(|_| ())
    })
    .await
}

/// Conclude the merge with git's prepared message. Refuses while a file is
/// still unmerged, which git itself would too — but with a clearer sentence.
#[tauri::command]
pub async fn git_merge_commit(
    project_dir: String,
    worktree: Option<GitWorktreeSelection>,
) -> Result<(), String> {
    run_off_thread(move || match worktree {
        None => git_merge_commit_blocking(project_dir),
        Some(selection) => git_merge_commit_blocking_selected(project_dir, Some(selection)),
    })
    .await
}

fn git_merge_commit_blocking(project_dir: String) -> Result<(), String> {
    git_merge_commit_blocking_selected(project_dir, None)
}

fn git_merge_commit_blocking_selected(
    project_dir: String,
    worktree: Option<GitWorktreeSelection>,
) -> Result<(), String> {
    let (project_dir, target) = selected_git_context(project_dir, worktree.as_ref())?;
    let t = target.as_ref();
    let left = conflicted(t, &project_dir);
    if !left.is_empty() {
        return Err(format!(
            "{} file(s) still have conflicts: {}",
            left.len(),
            left.join(", ")
        ));
    }
    require_hook_trust(t, &project_dir)?;
    let out = run_git_hooked(t, &project_dir, &["commit", "--no-edit"])?;
    if !out.status.success() {
        return Err(err_of(&out));
    }
    Ok(())
}

/// Both sides of one file for the `gitmerge` viewer, keyed by the file's
/// absolute path so a restored tab needs nothing else. Local repos only: the
/// resolved text is written to this machine's working tree.
#[tauri::command]
pub async fn git_merge_sides(path: String) -> Result<MergeSides, String> {
    run_off_thread(move || git_merge_sides_blocking(path)).await
}

fn git_merge_sides_blocking(path: String) -> Result<MergeSides, String> {
    let abs = PathBuf::from(&path);
    if remote_target_for_dir(&path).is_some() {
        return Err("merging in the viewer is local-only — resolve a remote project's merge in its terminal".into());
    }
    let parent = abs.parent().ok_or("no parent directory")?;
    // The file may not exist on this side yet (added upstream), so resolve the
    // repo from the nearest existing ancestor.
    let mut probe = parent.to_path_buf();
    while !probe.is_dir() {
        probe = probe.parent().ok_or("no existing parent directory")?.to_path_buf();
    }
    let top = crate::services::git_bounded::output(hardened_git_command_in(&probe, &["rev-parse", "--show-toplevel"]))?;
    if !top.status.success() {
        return Err(err_of(&top));
    }
    let repo = PathBuf::from(stdout_of(&top).trim());
    let canon_repo = repo.canonicalize().unwrap_or_else(|_| repo.clone());
    let canon_probe = probe.canonicalize().unwrap_or_else(|_| probe.clone());
    let tail = abs.strip_prefix(&probe).map_err(|_| "path outside its repo")?;
    let rel_dir = canon_probe.strip_prefix(&canon_repo).map_err(|_| "path outside its repo")?;
    let rel = rel_dir.join(tail).to_string_lossy().replace('\\', "/");
    let repo_s = repo.to_string_lossy().to_string();

    // A side that does not have the file (added/deleted on one side) is "".
    let show = |spec: String| -> String {
        run_git(None, &repo_s, &["show", &spec])
            .ok()
            .filter(|o| o.status.success())
            .map(|o| stdout_of(&o))
            .unwrap_or_default()
    };

    if is_merging(None, &repo_s) && conflicted(None, &repo_s).contains(&rel) {
        return Ok(MergeSides {
            mode: "conflict".into(),
            left: show(format!(":2:{rel}")),
            right: show(format!(":3:{rel}")),
            left_ref: "HEAD".into(),
            right_ref: "MERGE_HEAD".into(),
            repo: repo_s,
            rel,
        });
    }
    let (branch, _) = resolve_branch(None, &repo_s, None)?;
    let (up, short) = upstream_of(None, &repo_s, &branch)?;
    Ok(MergeSides {
        mode: "incoming".into(),
        left: show(format!("HEAD:{rel}")),
        right: show(format!("{up}:{rel}")),
        left_ref: "HEAD".into(),
        right_ref: short,
        repo: repo_s,
        rel,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = crate::paths::command_no_window("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git runs");
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).to_string()
    }

    fn init(dir: &Path) {
        git(dir, &["init", "-q", "-b", "main"]);
        git(dir, &["config", "user.email", "test@example.com"]);
        git(dir, &["config", "user.name", "Test User"]);
    }

    fn commit(dir: &Path, file: &str, body: &str) {
        fs::write(dir.join(file), body).unwrap();
        git(dir, &["add", "--", file]);
        git(dir, &["commit", "-q", "-m", &format!("edit {file}")]);
    }

    /// An upstream repo and a clone of it, the clone one commit behind.
    fn behind_pair() -> Option<(tempfile::TempDir, PathBuf, PathBuf)> {
        if !crate::commands::git::git_available() {
            return None;
        }
        let tmp = tempfile::tempdir().unwrap();
        let up = tmp.path().join("up");
        fs::create_dir(&up).unwrap();
        init(&up);
        commit(&up, "a.txt", "one\ntwo\nthree\n");
        git(tmp.path(), &["clone", "-q", "up", "clone"]);
        let clone = tmp.path().join("clone");
        git(&clone, &["config", "user.email", "test@example.com"]);
        git(&clone, &["config", "user.name", "Test User"]);
        commit(&up, "a.txt", "one\nTWO\nthree\n");
        git(&clone, &["fetch", "-q"]);
        Some((tmp, up, clone))
    }

    #[test]
    fn track_text_parses_every_form() {
        use crate::commands::git::parse_track;
        assert_eq!(parse_track("[ahead 1, behind 2]"), (1, 2));
        assert_eq!(parse_track("behind 3"), (0, 3));
        assert_eq!(parse_track("[gone]"), (0, 0));
        assert_eq!(parse_track(""), (0, 0));
    }

    #[test]
    fn preview_then_fast_forward() {
        let Some((_tmp, _up, clone)) = behind_pair() else { return };
        let dir = clone.to_string_lossy().to_string();
        let p = git_pull_preview_blocking(dir.clone(), None).unwrap();
        assert!(p.is_current);
        assert_eq!(p.upstream, "origin/main");
        assert_eq!(p.incoming.len(), 1);
        assert!(p.outgoing.is_empty());
        assert_eq!(p.files.len(), 1);
        assert_eq!(p.files[0].path, "a.txt");
        assert!(!p.files[0].both);

        let s = git_merge_sides_blocking(clone.join("a.txt").to_string_lossy().to_string()).unwrap();
        assert_eq!(s.mode, "incoming");
        assert_eq!(s.rel, "a.txt");
        assert!(s.right.contains("TWO") && !s.left.contains("TWO"));

        let o = git_pull_apply_blocking(dir, None, false).unwrap();
        assert!(o.conflicts.is_empty());
        assert!(fs::read_to_string(clone.join("a.txt")).unwrap().contains("TWO"));
    }

    #[test]
    fn diverged_branch_refuses_ff_and_merges_into_conflict() {
        let Some((_tmp, _up, clone)) = behind_pair() else { return };
        commit(&clone, "a.txt", "one\nzwei\nthree\n");
        let dir = clone.to_string_lossy().to_string();
        let p = git_pull_preview_blocking(dir.clone(), None).unwrap();
        assert_eq!(p.outgoing.len(), 1);
        assert!(p.files[0].both);

        assert!(git_pull_apply_blocking(dir.clone(), None, false).is_err());
        let o = git_pull_apply_blocking(dir.clone(), None, true).unwrap();
        assert_eq!(o.conflicts, vec!["a.txt".to_string()]);

        let s = git_merge_sides_blocking(clone.join("a.txt").to_string_lossy().to_string()).unwrap();
        assert_eq!(s.mode, "conflict");
        assert!(s.left.contains("zwei") && s.right.contains("TWO"));

        fs::write(clone.join("a.txt"), "one\nzwei TWO\nthree\n").unwrap();
        git(&clone, &["add", "--", "a.txt"]);
        git_merge_commit_blocking(dir.clone()).unwrap();
        assert!(!is_merging(None, &dir));
    }

    #[test]
    fn a_branch_not_checked_out_fast_forwards_in_place() {
        let Some((_tmp, _up, clone)) = behind_pair() else { return };
        git(&clone, &["switch", "-q", "-c", "side"]);
        let dir = clone.to_string_lossy().to_string();
        let p = git_pull_preview_blocking(dir.clone(), Some("main".into())).unwrap();
        assert!(!p.is_current);
        assert_eq!(p.incoming.len(), 1);
        assert!(git_pull_apply_blocking(dir.clone(), Some("main".into()), true).is_err());
        git_pull_apply_blocking(dir, Some("main".into()), false).unwrap();
        assert_eq!(
            git(&clone, &["rev-parse", "main"]),
            git(&clone, &["rev-parse", "origin/main"])
        );
    }
}
