//! Fetch, the pull preview, the pull itself and the merge it can leave behind —
//! the Git panel's Pull flow.
//!
//! The flow is **fetch → look → apply**, never a blind `git pull`:
//!
//! * [`git_fetch`] updates the remote-tracking refs on the exchange checkout.
//! * [`git_pull_preview`] reads what a pull would bring, from those refs alone —
//!   without fetching, and pins the commits used for comparison.
//! * [`git_pull_apply`] checks that the preview is current, then merges the
//!   reviewed commit by object ID: `merge --ff-only` by default, a real merge only
//!   when asked, and only on the checked-out branch. A branch that is not checked
//!   out can only fast-forward (`fetch . <commit>:<branch>` — nothing to merge
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
//! fire `post-index-change` on merely opening the Git panel). The local fetch
//! still passes the same trust gate: it runs no hook, but it honours the repo's
//! program-naming config keys (see [`fetch_local`]).

use std::path::{Path, PathBuf};

use crate::commands::git::{
    check_rev, git_exchange_context, hardened_git_command_in, local_non_repo, require_hook_trust,
    run_git, run_git_hooked, selected_git_context, GitExchangeContext, GitWorktreeSelection,
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
    pub review: PullReview,
}

#[derive(Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PullCheckout {
    /// The resolved site and paths, compared again before applying a review.
    site: String,
    path: String,
    git_dir: String,
    host: Option<(String, String, Option<String>, u16)>,
}

#[derive(Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PullReview {
    checkout: PullCheckout,
    branch: String,
    checked_out: Option<String>,
    upstream_ref: String,
    remote: String,
    local_oid: String,
    incoming_oid: String,
}

#[derive(Debug, serde::Serialize)]
pub struct FetchReceipt {
    checkout: PullCheckout,
    upstream_ref: Option<String>,
    remote: Option<String>,
    fetched_at: u64,
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
    pub stale: bool,
}

#[derive(serde::Serialize)]
pub struct MergeState {
    pub merging: bool,
    pub conflicts: Vec<String>,
    pub mirror: bool,
    pub path: Option<String>,
}

#[derive(serde::Deserialize)]
pub struct PullFileTips {
    local_oid: String,
    incoming_oid: String,
}

/// The two texts the `gitmerge` viewer compares for one file.
#[derive(serde::Serialize)]
pub struct MergeSides {
    /// `"conflict"`: ours vs theirs of an unresolved merge — Apply writes the
    /// result and stages it. `"incoming"`: a read-only commit comparison.
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
/// Returns the branch and the worktree’s checked-out branch.
fn resolve_branch(
    target: Option<&RemoteTarget>,
    dir: &str,
    branch: Option<&str>,
) -> Result<(String, Option<String>), String> {
    let out = run_git(target, dir, &["symbolic-ref", "--quiet", "HEAD"])?;
    let current = if out.status.success() {
        Some(stdout_of(&out).trim().strip_prefix("refs/heads/")
            .ok_or("HEAD does not point to a local branch")?
            .to_string())
    } else if out.status.code() == Some(1) {
        None
    } else {
        return Err(err_of(&out));
    };
    match branch {
        Some(b) => {
            check_rev(b)?;
            Ok((b.to_string(), current))
        }
        None => current
            .map(|c| (c.clone(), Some(c)))
            .ok_or_else(|| "HEAD is detached — there is no branch to pull into".to_string()),
    }
}

struct Upstream {
    full: String,
    short: String,
    remote: String,
}

fn upstream_of(target: Option<&RemoteTarget>, dir: &str, branch: &str) -> Result<Upstream, String> {
    // `for-each-ref`, not `rev-parse <ref>@{u}`: the latter rejects a full
    // `refs/heads/…` spelling, and a short one can be shadowed by a tag.
    let local = format!("refs/heads/{branch}");
    let listed = git_ok(target, dir, &[
        "for-each-ref", "--format=%(refname)%1f%(upstream)%1f%(upstream:remotename)", &local,
    ])?;
    let (full, remote) = listed
        .lines()
        .filter_map(|line| {
            let (name, tracking) = line.split_once('\u{1f}')?;
            if name == local {
                tracking.split_once('\u{1f}')
            } else {
                None
            }
        })
        .find(|(up, remote)| !up.is_empty() && !remote.is_empty())
        .ok_or_else(|| format!("'{branch}' has no upstream branch to pull from"))?;
    check_rev(full)?;
    check_rev(remote)?;
    let short = full
        .strip_prefix("refs/remotes/")
        .or_else(|| full.strip_prefix("refs/heads/"))
        .unwrap_or(full)
        .to_string();
    Ok(Upstream { full: full.into(), short, remote: remote.into() })
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

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn git_fetch(
    project_dir: String,
    project_id: Option<String>,
    worktree: Option<GitWorktreeSelection>,
    branch: Option<String>,
) -> Result<FetchReceipt, String> {
    app_core::rt::try_blocking("git", move || {
        git_fetch_blocking(project_dir, project_id, worktree.as_ref(), branch.as_deref())
    })
    .await
}

fn pull_checkout(ctx: &GitExchangeContext) -> Result<PullCheckout, String> {
    let t = ctx.target.as_ref();
    let git_dir = git_ok(t, &ctx.dir, &["rev-parse", "--absolute-git-dir"])?;
    let site = if t.is_some() {
        "host"
    } else if ctx.mirror_project_id.is_some() {
        "mirror"
    } else {
        "local"
    };
    Ok(PullCheckout {
        site: site.into(),
        path: t.map_or_else(|| ctx.dir.clone(), |target| target.spec.remote_path.clone()),
        git_dir: git_dir.trim_end_matches(['\r', '\n']).into(),
        host: t.map(|target| {
            let spec = &target.spec;
            (target.project_id.clone(), spec.host.clone(), spec.user.clone(), spec.port.unwrap_or(22))
        }),
    })
}

fn git_fetch_blocking(
    project_dir: String,
    project_id: Option<String>,
    worktree: Option<&GitWorktreeSelection>,
    branch: Option<&str>,
) -> Result<FetchReceipt, String> {
    let ctx = git_exchange_context(project_dir, worktree)?;
    let checkout = pull_checkout(&ctx)?;
    let t = ctx.target.as_ref();
    // A branch chip fetches its upstream remote, even if the current branch
    // tracks a different remote. The toolbar can still fetch on an unborn,
    // detached or untracked checkout using Git's default remote.
    let upstream = if let Some(branch) = branch {
        check_rev(branch)?;
        Some(upstream_of(t, &ctx.dir, branch)?)
    } else {
        resolve_branch(t, &ctx.dir, None)
            .and_then(|(branch, _)| upstream_of(t, &ctx.dir, &branch))
            .ok()
    };

    let mut args = vec!["fetch"];
    if let Some(up) = &upstream {
        args.extend(["--", up.remote.as_str()]);
    }
    let out = if let Some(target) = t {
        run_git(Some(target), &ctx.dir, &args)?
    } else {
        let auth = ctx.mirror_project_id.as_ref().or(project_id.as_ref())
            .map(|id| crate::commands::git_hosting::project_auth(id))
            .unwrap_or_default();
        fetch_local(Path::new(&ctx.dir), &auth, &args)?
    };
    if !out.status.success() {
        return Err(err_of(&out));
    }
    Ok(FetchReceipt {
        checkout,
        upstream_ref: upstream.as_ref().map(|up| up.full.clone()),
        remote: upstream.map(|up| up.remote),
        fetched_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default().as_secs(),
    })
}

/// `git fetch` in a local directory with push's scoped token auth.
///
/// Gated like push (`exec_trust`, `GitHooks`): fetch runs no hook, but it
/// honours the repo's program-naming keys (`core.sshCommand`,
/// `credential.helper`, `remote.*.uploadpack`, `url.*.insteadOf`), which a
/// downloaded or imported repo can carry — and the gate's fingerprint covers
/// exactly those.
fn fetch_local(
    dir: &Path,
    auth: &crate::services::git_hosting::GitAuth,
    fetch_args: &[&str],
) -> Result<std::process::Output, String> {
    crate::services::exec_trust::require(crate::services::exec_trust::TrustKind::GitHooks, dir)?;
    let mut args = auth.git_args("x-access-token");
    args.extend(fetch_args.iter().map(|arg| arg.to_string()));
    let mut cmd = hardened_git_command_in(dir, &args);
    if !auth.is_empty() {
        auth.apply_env(&mut cmd);
        cmd.env("GIT_TERMINAL_PROMPT", "0");
    }
    // Bounded (#2349), like `git::push_local`.
    crate::services::git_bounded::output(cmd)
}

// ── Preview ──────────────────────────────────────────────────────────────────

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn git_pull_preview(
    project_dir: String,
    branch: Option<String>,
    worktree: Option<GitWorktreeSelection>,
) -> Result<PullPreview, String> {
    app_core::rt::try_blocking("git", move || {
        git_pull_preview_blocking(project_dir, branch.as_deref(), worktree.as_ref())
    })
    .await
}

fn reviewed_refs(
    ctx: &GitExchangeContext,
    branch: Option<&str>,
) -> Result<(String, String, PullReview), String> {
    let t = ctx.target.as_ref();
    let checkout = pull_checkout(ctx)?;
    let (branch, checked_out) = resolve_branch(t, &ctx.dir, branch)?;
    let up = upstream_of(t, &ctx.dir, &branch)?;
    let local_ref = format!("refs/heads/{branch}");
    let commit_oid = |reference: &str| {
        let reference = format!("{reference}^{{commit}}");
        git_ok(t, &ctx.dir, &["rev-parse", "--verify", "--end-of-options", &reference])
            .map(|oid| oid.trim().to_string())
    };
    let local_oid = commit_oid(&local_ref)?;
    let incoming_oid = commit_oid(&up.full)?;
    let review = PullReview {
        checkout,
        branch: branch.clone(),
        checked_out,
        upstream_ref: up.full,
        remote: up.remote,
        local_oid,
        incoming_oid,
    };
    Ok((branch, up.short, review))
}

fn git_pull_preview_blocking(
    project_dir: String,
    branch: Option<&str>,
    worktree: Option<&GitWorktreeSelection>,
) -> Result<PullPreview, String> {
    let ctx = git_exchange_context(project_dir, worktree)?;
    let t = ctx.target.as_ref();
    let project_dir = &ctx.dir;
    let (branch, upstream, review) = reviewed_refs(&ctx, branch)?;
    let is_current = review.checked_out.as_deref() == Some(branch.as_str());
    let local = &review.local_oid;
    let up = &review.incoming_oid;
    let incoming = oneline(t, project_dir, &format!("{local}..{up}"))?;
    let outgoing = oneline(t, project_dir, &format!("{up}..{local}"))?;
    // Three dots: each side's changes since the merge base, so `files` is what
    // the upstream did and `mine` what the branch did.
    let theirs = git_ok(
        t,
        project_dir,
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
            project_dir,
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
        review,
    })
}

// ── Apply ────────────────────────────────────────────────────────────────────

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn git_pull_apply(
    project_dir: String,
    branch: String,
    merge: bool,
    worktree: Option<GitWorktreeSelection>,
    review: PullReview,
) -> Result<PullOutcome, String> {
    app_core::rt::try_blocking("git", move || {
        git_pull_apply_blocking(project_dir, &branch, merge, worktree.as_ref(), &review)
    })
    .await
}

fn git_pull_apply_blocking(
    project_dir: String,
    branch: &str,
    merge: bool,
    worktree: Option<&GitWorktreeSelection>,
    review: &PullReview,
) -> Result<PullOutcome, String> {
    let stale = || Ok(PullOutcome { conflicts: vec![], message: String::new(), stale: true });
    let Ok(ctx) = git_exchange_context(project_dir, worktree) else { return stale() };
    let t = ctx.target.as_ref();
    let project_dir = &ctx.dir;
    if review.checked_out.as_deref() == Some(branch) {
        require_hook_trust(t, project_dir)?;
    }
    let Ok((branch, _, actual)) = reviewed_refs(&ctx, Some(branch)) else { return stale() };
    if &actual != review {
        return stale();
    }
    let is_current = review.checked_out.as_deref() == Some(branch.as_str());
    let incoming = &actual.incoming_oid;

    if !is_current {
        if merge {
            return Err(format!(
                "'{branch}' is not checked out — only a fast-forward can update it; check it out to merge"
            ));
        }
        // A fetch from this very repo: refuses anything but a fast-forward, and
        // refuses a branch checked out in another worktree.
        let refspec = format!("{incoming}:refs/heads/{branch}");
        let message = git_ok(t, project_dir, &["fetch", ".", &refspec])?;
        return Ok(PullOutcome {
            conflicts: vec![],
            message,
            stale: false,
        });
    }

    let mode = if merge { "--no-edit" } else { "--ff-only" };
    let out = run_git_hooked(t, project_dir, &["merge", mode, incoming])?;
    if out.status.success() {
        return Ok(PullOutcome {
            conflicts: vec![],
            message: stdout_of(&out),
            stale: false,
        });
    }
    // A merge that stopped on conflicts is not an error: it is the next step.
    if merge && is_merging(t, project_dir) {
        let conflicts = conflicted(t, project_dir);
        if !conflicts.is_empty() {
            return Ok(PullOutcome {
                conflicts,
                message: stdout_of(&out),
                stale: false,
            });
        }
    }
    Err(err_of(&out))
}

// ── The merge it can leave ───────────────────────────────────────────────────

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn git_merge_state(
    project_dir: String,
    worktree: Option<GitWorktreeSelection>,
) -> Result<MergeState, String> {
    app_core::rt::try_blocking("git", move || {
        let (dir, target) = selected_git_context(project_dir, worktree.as_ref())?;
        let t = target.as_ref();
        if !local_non_repo(t, &dir) && is_merging(t, &dir) {
            return Ok(MergeState {
                merging: true,
                conflicts: conflicted(t, &dir),
                mirror: worktree.as_ref().is_some_and(|selection| selection.site == "mirror"),
                path: t.is_none().then_some(dir),
            });
        }
        // A default pull can merge in the mirror even though this history view
        // displays the host. Keep its stopped merge visible after a panel reload.
        if let Some(host) = t.filter(|_| worktree.is_none()) {
            if let Some(mirror) = crate::commands::git_publish::mirror_origin_repo(&host.project_id) {
                let path = mirror.to_string_lossy().into_owned();
                if is_merging(None, &path) {
                    return Ok(MergeState {
                        merging: true,
                        conflicts: conflicted(None, &path),
                        mirror: true,
                        path: Some(path),
                    });
                }
            }
        }
        Ok(MergeState { merging: false, conflicts: vec![], mirror: false, path: None })
    })
    .await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn git_merge_abort(
    project_dir: String,
    worktree: Option<GitWorktreeSelection>,
) -> Result<(), String> {
    app_core::rt::try_blocking("git", move || {
        let (project_dir, target) = selected_git_context(project_dir, worktree.as_ref())?;
        git_ok(target.as_ref(), &project_dir, &["merge", "--abort"]).map(|_| ())
    })
    .await
}

/// Conclude the merge with git's prepared message. Refuses while a file is
/// still unmerged, which git itself would too — but with a clearer sentence.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn git_merge_commit(
    project_dir: String,
    worktree: Option<GitWorktreeSelection>,
) -> Result<(), String> {
    app_core::rt::try_blocking("git", move || match worktree {
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
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn git_merge_sides(path: String, tips: Option<PullFileTips>) -> Result<MergeSides, String> {
    app_core::rt::try_blocking("git", move || git_merge_sides_blocking(path, tips.as_ref())).await
}

fn git_merge_sides_blocking(path: String, tips: Option<&PullFileTips>) -> Result<MergeSides, String> {
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

    if let Some(tips) = tips {
        for oid in [&tips.local_oid, &tips.incoming_oid] {
            if !matches!(oid.len(), 40 | 64) || !oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err("Invalid reviewed commit ID".into());
            }
            // A removed object must report an error, while a file that did
            // not exist in an available commit still reads as empty.
            git_ok(None, &repo_s, &["cat-file", "-e", &format!("{oid}^{{commit}}")])?;
        }
        return Ok(MergeSides {
            mode: "incoming".into(),
            left: show(format!("{}:{rel}", tips.local_oid)),
            right: show(format!("{}:{rel}", tips.incoming_oid)),
            left_ref: tips.local_oid[..12].into(),
            right_ref: tips.incoming_oid[..12].into(),
            repo: repo_s,
            rel,
        });
    }

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
    let up = upstream_of(None, &repo_s, &branch)?;
    Ok(MergeSides {
        mode: "incoming".into(),
        left: show(format!("HEAD:{rel}")),
        right: show(format!("{}:{rel}", up.full)),
        left_ref: "HEAD".into(),
        right_ref: up.short,
        repo: repo_s,
        rel,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::git;
    use std::fs;

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
        if !crate::commands::git::git_available_blocking() {
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

    /// A repo whose own config names a program fetch would run (here the
    /// remote's `uploadpack`) is refused until approved — the program never
    /// runs. A plain clone fetches without asking.
    #[cfg(unix)]
    #[test]
    fn fetch_is_gated_on_the_repos_program_keys() {
        use std::os::unix::fs::PermissionsExt;
        let Some((tmp, _up, clone)) = behind_pair() else { return };
        let dir = clone.to_string_lossy().to_string();
        assert!(git_fetch_blocking(dir.clone(), None, None, None).is_ok());

        let marker = tmp.path().join("ran");
        let script = tmp.path().join("pack.sh");
        fs::write(&script, format!("#!/bin/sh\ntouch '{}'\nexec git-upload-pack \"$@\"\n", marker.display()))
            .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        git(&clone, &["config", "remote.origin.uploadpack", &script.to_string_lossy()]);

        let err = git_fetch_blocking(dir, None, None, None).unwrap_err();
        assert!(err.starts_with(crate::services::exec_trust::TRUST_REQUIRED_PREFIX), "{err}");
        assert!(!marker.exists(), "the repo's program must not run unapproved");
    }

    #[test]
    fn preview_then_fast_forward() {
        let Some((_tmp, _up, clone)) = behind_pair() else { return };
        let dir = clone.to_string_lossy().to_string();
        let p = git_pull_preview_blocking(dir.clone(), None, None).unwrap();
        assert!(p.is_current);
        assert_eq!(p.upstream, "origin/main");
        assert_eq!(p.incoming.len(), 1);
        assert!(p.outgoing.is_empty());
        assert_eq!(p.files.len(), 1);
        assert_eq!(p.files[0].path, "a.txt");
        assert!(!p.files[0].both);

        let s = git_merge_sides_blocking(clone.join("a.txt").to_string_lossy().to_string(), None).unwrap();
        assert_eq!(s.mode, "incoming");
        assert_eq!(s.rel, "a.txt");
        assert!(s.right.contains("TWO") && !s.left.contains("TWO"));

        let o = git_pull_apply_blocking(dir, &p.branch, false, None, &p.review).unwrap();
        assert!(!o.stale);
        assert!(o.conflicts.is_empty());
        assert!(fs::read_to_string(clone.join("a.txt")).unwrap().contains("TWO"));
    }

    #[test]
    fn apply_requires_a_new_review_after_either_tip_moves() {
        let Some((_tmp, upstream, clone)) = behind_pair() else { return };
        let dir = clone.to_string_lossy().into_owned();
        let first = git_pull_preview_blocking(dir.clone(), None, None).unwrap();

        commit(&upstream, "new.txt", "unreviewed");
        git(&clone, &["fetch", "-q"]);
        let tips = PullFileTips {
            local_oid: first.review.local_oid.clone(),
            incoming_oid: first.review.incoming_oid.clone(),
        };
        let compared = git_merge_sides_blocking(clone.join("new.txt").to_string_lossy().into_owned(), Some(&tips)).unwrap();
        assert!(compared.right.is_empty());
        let stale = git_pull_apply_blocking(dir.clone(), &first.branch, false, None, &first.review).unwrap();
        assert!(stale.stale);
        assert_eq!(git(&clone, &["rev-parse", "HEAD"]).trim(), first.review.local_oid);
        assert!(!clone.join("new.txt").exists());

        let second = git_pull_preview_blocking(dir.clone(), None, None).unwrap();
        commit(&clone, "ours.txt", "new local commit");
        let stale = git_pull_apply_blocking(dir.clone(), &second.branch, true, None, &second.review).unwrap();
        assert!(stale.stale);
        assert!(!is_merging(None, &dir));
        assert!(!clone.join("new.txt").exists());
    }

    #[test]
    fn fetch_preview_and_apply_use_the_selected_checkout_and_upstream() {
        let Some((tmp, upstream, clone)) = behind_pair() else { return };
        let worktree = tmp.path().join("worktree");
        git(&clone, &["worktree", "add", "-q", "-b", "linked", &worktree.to_string_lossy()]);
        git(&clone, &["remote", "add", "second", &upstream.to_string_lossy()]);
        git(&worktree, &["config", "branch.linked.remote", "second"]);
        git(&worktree, &["config", "branch.linked.merge", "refs/heads/main"]);
        git(&clone, &["switch", "-q", "-c", "other"]);

        let dir = clone.to_string_lossy().into_owned();
        let selection = GitWorktreeSelection { path: worktree.to_string_lossy().into_owned(), site: "host".into() };
        let receipt = git_fetch_blocking(dir.clone(), None, Some(&selection), Some("linked")).unwrap();
        let preview = git_pull_preview_blocking(dir.clone(), None, Some(&selection)).unwrap();
        assert_eq!(receipt.checkout, preview.review.checkout);
        assert_eq!(receipt.upstream_ref.as_deref(), Some(preview.review.upstream_ref.as_str()));
        assert_eq!(receipt.remote.as_deref(), Some("second"));
        assert_eq!(preview.upstream, "second/main");
        assert_eq!(preview.incoming.len(), 1);

        let stale = git_pull_apply_blocking(dir.clone(), &preview.branch, false, None, &preview.review).unwrap();
        assert!(stale.stale);
        let result = git_pull_apply_blocking(dir, &preview.branch, false, Some(&selection), &preview.review).unwrap();
        assert!(!result.stale);
        assert_ne!(git(&worktree, &["rev-parse", "HEAD"]), git(&clone, &["rev-parse", "HEAD"]));
        assert!(fs::read_to_string(worktree.join("a.txt")).unwrap().contains("TWO"));
    }

    #[test]
    fn diverged_branch_refuses_ff_and_merges_into_conflict() {
        let Some((_tmp, _up, clone)) = behind_pair() else { return };
        commit(&clone, "a.txt", "one\nzwei\nthree\n");
        let dir = clone.to_string_lossy().to_string();
        let p = git_pull_preview_blocking(dir.clone(), None, None).unwrap();
        assert_eq!(p.outgoing.len(), 1);
        assert!(p.files[0].both);

        assert!(git_pull_apply_blocking(dir.clone(), &p.branch, false, None, &p.review).is_err());
        let o = git_pull_apply_blocking(dir.clone(), &p.branch, true, None, &p.review).unwrap();
        assert!(!o.stale);
        assert_eq!(o.conflicts, vec!["a.txt".to_string()]);

        let s = git_merge_sides_blocking(clone.join("a.txt").to_string_lossy().to_string(), None).unwrap();
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
        let p = git_pull_preview_blocking(dir.clone(), Some("main"), None).unwrap();
        assert!(!p.is_current);
        assert_eq!(p.incoming.len(), 1);
        assert!(git_pull_apply_blocking(dir.clone(), &p.branch, true, None, &p.review).is_err());
        assert!(!git_pull_apply_blocking(dir, &p.branch, false, None, &p.review).unwrap().stale);
        assert_eq!(
            git(&clone, &["rev-parse", "main"]),
            git(&clone, &["rev-parse", "origin/main"])
        );
    }
}
