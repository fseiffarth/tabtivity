use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::services::remote::{remote_target_for_dir, RemoteTarget};
use crate::tauri_host::Ctx;

// The hardened git runner lives in `services::git_hardened` (S5); these names
// keep resolving here for every command-side caller.
pub use crate::services::git_hardened::git_available_blocking;
pub(crate) use crate::services::git_hardened::{
    check_rev, hardened_git_command_in, hooked_git_command_in, hookless_git_command_in,
    local_non_repo, pin_common_dir, run_git, run_git_hooked,
    git_clone_blocking, scoped_token_config, stdout, valid_positional_path, validate_clone_url,
};

// Off-thread note: why every git command runs its body through
// `app_core::rt::try_blocking`.
//
// Every git command here is genuinely blocking — `run_git` either spawns a local
// `git` subprocess (`.output()`) or runs `git` over SSH (`run_git_remote`, which
// can stall up to the SSH `ConnectTimeout`/`ServerAlive` window on an unreachable
// or unauthenticated host). Tauri runs a synchronous `#[command]` on the MAIN
// thread, so doing that work inline froze the whole window whenever a remote
// project's host was down (the remote-disconnect freeze). Each command is an
// `async` wrapper that offloads its sync body that way, so the
// blocking work runs on tokio's blocking pool and the UI thread stays free. The
// bodies live in sibling `*_blocking` fns (kept sync, so they remain directly
// unit-testable without a tokio runtime).

/// Whether the `git` binary is on `PATH`. The new/import-project dialog calls
/// this before offering a git-backed project, so a missing `git` surfaces as an
/// install prompt instead of `scaffold_project` silently no-oping `git init`
/// (see its `let _ =` discard) and registering a git-typed project with no repo.
///
/// The probe spawns a process, so the command runs it on a worker; a worker
/// that fails reads as "not available".
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn git_available() -> bool {
    app_core::rt::blocking("git", git_available_blocking).await.unwrap_or(false)
}

#[derive(serde::Serialize)]
pub struct GitStatus {
    pub staged: usize,
    pub unstaged: usize,
    pub untracked: usize,
    pub has_remote: bool,
    pub is_repo: bool,
    /// Commits the upstream has that the current branch lacks, as of the last
    /// fetch — the git bar's Pull button. `0` with no upstream.
    pub behind: usize,
    /// A tag already names `HEAD` — the git bar hides Release, whose only
    /// target is that commit. Probed only for a local repo with a remote (the
    /// sole case the button shows); `false` otherwise.
    pub head_tagged: bool,
    /// Commits ahead of a live upstream, from the same `## …` header as
    /// `behind`; `None` with no upstream (or a `[gone]` one), where the
    /// unpushed count needs [`unpushed_base`]'s namesake lookup instead.
    /// Internal: lets the dot probe skip two git spawns ([`unpushed_count`]).
    #[serde(skip)]
    pub upstream_ahead: Option<usize>,
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn git_status(
    project_dir: String,
    worktree: Option<GitWorktreeSelection>,
) -> Result<GitStatus, String> {
    app_core::rt::try_blocking("git", move || match worktree {
        None => git_status_blocking(project_dir),
        Some(selection) => git_status_blocking_selected(project_dir, Some(selection)),
    })
    .await
}

fn git_status_blocking(project_dir: String) -> Result<GitStatus, String> {
    git_status_blocking_selected(project_dir, None)
}

fn git_status_blocking_selected(
    project_dir: String,
    worktree: Option<GitWorktreeSelection>,
) -> Result<GitStatus, String> {
    git_status_probe_selected(project_dir, true, worktree)
}

/// `probe_remote: false` skips the `git remote` spawn and reports
/// `has_remote: false`. Only `git_dirty_probe` passes it: that path is the
/// switcher's 12 s per-project poll, and its sole consumer (`stores/gitDirty.ts`
/// → `gitDirtyState`) reads the counts and `is_repo`, never `has_remote` — so the
/// second process (an SSH round trip on a remote project) bought nothing. The
/// `git_status` command keeps the full answer for anything that does read it.
pub(crate) fn git_status_probe(project_dir: String, probe_remote: bool) -> Result<GitStatus, String> {
    git_status_probe_selected(project_dir, probe_remote, None)
}

fn git_status_probe_selected(
    project_dir: String,
    probe_remote: bool,
    worktree: Option<GitWorktreeSelection>,
) -> Result<GitStatus, String> {
    let (project_dir, target) = selected_git_context(project_dir, worktree.as_ref())?;
    if local_non_repo(target.as_ref(), &project_dir) {
        return Ok(GitStatus {
            staged: 0,
            unstaged: 0,
            untracked: 0,
            has_remote: false,
            is_repo: false,
            behind: 0,
            head_tagged: false,
            upstream_ahead: None,
        });
    }

    // `--branch` adds one `## main...origin/main [behind 2]` header — the
    // behind count for free, in the spawn this probe already pays for.
    let out = run_git(
        target.as_ref(),
        &project_dir,
        &["status", "--porcelain", "--branch"],
    )?;

    let text = String::from_utf8_lossy(&out.stdout);
    let mut staged = 0usize;
    let mut unstaged = 0usize;
    let mut untracked = 0usize;
    let mut behind = 0usize;
    let mut upstream_ahead = None;
    for line in text.lines() {
        if let Some(header) = line.strip_prefix("## ") {
            let (ahead, back) = header
                .rfind('[')
                .map(|at| parse_track(&header[at..]))
                .unwrap_or((0, 0));
            behind = back;
            upstream_ahead = header_has_live_upstream(header).then_some(ahead);
            continue;
        }
        if line.len() < 2 {
            continue;
        }
        let x = line.chars().next().unwrap_or(' ');
        let y = line.chars().nth(1).unwrap_or(' ');
        if x == '?' && y == '?' {
            untracked += 1;
        } else {
            if x != ' ' {
                staged += 1;
            }
            if y != ' ' {
                unstaged += 1;
            }
        }
    }

    let has_remote = probe_remote
        && run_git(target.as_ref(), &project_dir, &["remote"])
            .map(|o| !o.stdout.is_empty())
            .unwrap_or(false);
    let head_tagged = has_remote
        && target.is_none()
        && run_git(None, &project_dir, &["tag", "--points-at", "HEAD"])
            .map(|o| o.status.success() && !o.stdout.trim_ascii().is_empty())
            .unwrap_or(false);

    Ok(GitStatus {
        staged,
        unstaged,
        untracked,
        has_remote,
        is_repo: true,
        behind,
        head_tagged,
        upstream_ahead,
    })
}

/// Whether a `git status --branch` header names an upstream that still
/// exists: `main...origin/main [ahead 1]` does, `main` (none), `HEAD (no
/// branch)` and `main...origin/main [gone]` do not. A ref name cannot hold
/// `..`, so `...` is always the separator.
fn header_has_live_upstream(header: &str) -> bool {
    header.contains("...") && !header.contains("[gone]")
}

/// The dot's unpushed count for a status just read: the header's `ahead` when
/// the branch tracks a live upstream (no further spawn — `git log @{u}..`
/// counts the same commits), else [`git_unpushed_commits_blocking`]'s
/// namesake fallback. Best-effort: a failed read counts as zero.
pub(crate) fn unpushed_count(status: &GitStatus, project_dir: String) -> usize {
    match status.upstream_ahead {
        Some(ahead) => ahead,
        None => git_unpushed_commits_blocking(project_dir)
            .map(|v| v.len())
            .unwrap_or(0),
    }
}

/// `(ahead, behind)` out of git's tracking text — `[ahead 1, behind 2]`,
/// `ahead 1` (`%(upstream:track,nobracket)`), `[gone]` or empty. Anything it
/// does not recognise counts as zero: a stale reading never invents a pull.
pub(crate) fn parse_track(s: &str) -> (usize, usize) {
    let mut ahead = 0;
    let mut behind = 0;
    for part in s.trim_matches(|c| c == '[' || c == ']').split(',') {
        let mut words = part.split_whitespace();
        let (Some(word), Some(n)) = (words.next(), words.next()) else {
            continue;
        };
        let n = n.parse().unwrap_or(0);
        match word {
            "ahead" => ahead = n,
            "behind" => behind = n,
            _ => {}
        }
    }
    (ahead, behind)
}

/// One probe behind the project switcher's per-pill git dot.
#[derive(serde::Serialize)]
pub struct GitDirtyProbe {
    pub status: GitStatus,
    /// Commits ahead of the upstream — computed **only when the working tree is
    /// clean**, `0` otherwise (the dot never consults it while anything is
    /// dirty or staged, so probing it unconditionally paid a second git spawn
    /// per project per poll tick for an answer that was then discarded).
    pub unpushed: usize,
}

/// `git_status` + the unpushed-commit count as ONE command, for the switcher's
/// 12 s per-project dot poll and its `.git` watcher refresh: one git spawn and
/// one IPC round trip — a clean tree tracking an upstream reads its unpushed
/// count off the status header too ([`unpushed_count`]); only a clean branch
/// with no upstream pays the namesake lookup.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn git_dirty_probe(project_dir: String) -> Result<GitDirtyProbe, String> {
    app_core::rt::try_blocking("git", move || {
        // `has_remote` is not read by the dot (see `git_status_probe`); skip it.
        let status = git_status_probe(project_dir.clone(), false)?;
        let clean = status.is_repo
            && status.staged == 0
            && status.unstaged == 0
            && status.untracked == 0;
        let unpushed = if clean {
            // Best-effort, like the frontend's old `.catch(() => [])`: a failed
            // unpushed read must not blank a dot the status half already earned.
            unpushed_count(&status, project_dir)
        } else {
            0
        };
        Ok(GitDirtyProbe { status, unpushed })
    })
    .await
}

/// Resolve the git top-level enclosing `project_dir`/`rel_path` (the folder the
/// user is currently browsing in the file tree). Returns the absolute repo root
/// path, or `None` when the folder isn't inside any git repo. The side panel
/// uses this to detect a **nested** repo — a subfolder that is its own git repo
/// distinct from the project's repo — and re-root its git section at it.
///
/// Local only for now: a remote project's tree lives on the host, and a nested
/// host toplevel can't be reverse-mapped back to the project's `RemoteSpec` by
/// `remote_target_for_dir`, so remote projects short-circuit to `None` and keep
/// their existing project-scoped behavior.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn git_repo_root(
    project_dir: String,
    rel_path: String,
) -> Result<Option<String>, String> {
    app_core::rt::try_blocking("git", move || git_repo_root_blocking(project_dir, rel_path)).await
}

fn git_repo_root_blocking(project_dir: String, rel_path: String) -> Result<Option<String>, String> {
    // Remote projects keep project-scoped git (see doc comment).
    if remote_target_for_dir(&project_dir).is_some() {
        return Ok(None);
    }
    let dir: PathBuf = if rel_path.is_empty() {
        PathBuf::from(&project_dir)
    } else {
        Path::new(&project_dir).join(&rel_path)
    };
    // `--show-toplevel` prints the absolute root of the innermost repo enclosing
    // `dir`. Any failure (not a repo, missing dir) maps to `None`, not an error,
    // so the UI treats it as "no repo here" rather than flashing a banner.
    // Hardened like every local call: `dir` is inside the project, so its
    // repo's config is untrusted. The builder discovers the git dir from `dir`
    // (the innermost repo, the one `--show-toplevel` reports).
    let cmd = hardened_git_command_in(&dir, &["rev-parse", "--show-toplevel"]);
    let out = crate::services::git_bounded::output(cmd);
    match out {
        Ok(o) if o.status.success() => {
            let top = String::from_utf8_lossy(&o.stdout).trim().to_string();
            Ok(if top.is_empty() { None } else { Some(top) })
        }
        _ => Ok(None),
    }
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn git_add_all(
    project_dir: String,
    worktree: Option<GitWorktreeSelection>,
) -> Result<(), String> {
    app_core::rt::try_blocking("git", move || match worktree {
        None => git_add_all_blocking(project_dir),
        Some(selection) => git_add_all_blocking_selected(project_dir, Some(selection)),
    })
    .await
}

fn git_add_all_blocking(project_dir: String) -> Result<(), String> {
    git_add_all_blocking_selected(project_dir, None)
}

fn git_add_all_blocking_selected(
    project_dir: String,
    worktree: Option<GitWorktreeSelection>,
) -> Result<(), String> {
    let (project_dir, target) = selected_git_context(project_dir, worktree.as_ref())?;
    let out = run_git(target.as_ref(), &project_dir, &["add", "-A"])?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(())
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn git_generate_commit_message(
    project_dir: String,
    worktree: Option<GitWorktreeSelection>,
) -> Result<String, String> {
    app_core::rt::try_blocking("git", move || match worktree {
        None => git_generate_commit_message_blocking(project_dir),
        Some(selection) => {
            git_generate_commit_message_blocking_selected(project_dir, Some(selection))
        }
    })
    .await
}

fn git_generate_commit_message_blocking(project_dir: String) -> Result<String, String> {
    git_generate_commit_message_blocking_selected(project_dir, None)
}

fn git_generate_commit_message_blocking_selected(
    project_dir: String,
    worktree: Option<GitWorktreeSelection>,
) -> Result<String, String> {
    let (project_dir, target) = selected_git_context(project_dir, worktree.as_ref())?;
    let files_out = run_git(
        target.as_ref(),
        &project_dir,
        &["diff", "--staged", "--name-only"],
    )?;
    let staged_text = String::from_utf8_lossy(&files_out.stdout).to_string();
    let staged: Vec<&str> = staged_text.lines().collect();

    // Also check untracked / unstaged if nothing staged
    let files: Vec<String> = if staged.is_empty() {
        let all = run_git(target.as_ref(), &project_dir, &["diff", "--name-only"])
            .map(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        all
    } else {
        staged.iter().map(|s| s.to_string()).collect()
    };

    if files.is_empty() {
        return Ok("chore: update files".to_string());
    }

    let kind = infer_commit_type(&files);
    let msg = format_commit_message(kind, &files);
    Ok(msg)
}

fn infer_commit_type(files: &[String]) -> &'static str {
    let has = |pat: &str| files.iter().any(|f| f.contains(pat));
    if has(".github/") || has("ci-cd") || has("Dockerfile") {
        return "ci";
    }
    if files.iter().all(|f| f.ends_with(".md")) {
        return "docs";
    }
    if has("Cargo.toml") || has("package.json") || has("package-lock") {
        return "chore";
    }
    if has("test") || has("spec") || has("__tests__") {
        return "test";
    }
    if has("src/") || has("src-tauri/src/") {
        return "feat";
    }
    "chore"
}

fn format_commit_message(kind: &str, files: &[String]) -> String {
    let names: Vec<String> = files
        .iter()
        .map(|f| {
            std::path::Path::new(f)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(f.as_str())
                .to_string()
        })
        .collect();

    let mut seen = std::collections::HashSet::new();
    let unique: Vec<&String> = names.iter().filter(|n| seen.insert(n.as_str())).collect();

    let subject = match unique.len() {
        0 => "update files".to_string(),
        1 => format!("update {}", unique[0]),
        2 => format!("update {} and {}", unique[0], unique[1]),
        _ => format!(
            "update {}, {} and {} more",
            unique[0],
            unique[1],
            unique.len() - 2
        ),
    };
    format!("{kind}: {subject}")
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn git_commit(
    project_dir: String,
    message: String,
    worktree: Option<GitWorktreeSelection>,
) -> Result<(), String> {
    app_core::rt::try_blocking("git", move || match worktree {
        None => git_commit_blocking(project_dir, message),
        Some(selection) => git_commit_blocking_selected(project_dir, message, Some(selection)),
    })
    .await
}

fn git_commit_blocking(project_dir: String, message: String) -> Result<(), String> {
    git_commit_blocking_selected(project_dir, message, None)
}

fn git_commit_blocking_selected(
    project_dir: String,
    message: String,
    worktree: Option<GitWorktreeSelection>,
) -> Result<(), String> {
    let (project_dir, target) = selected_git_context(project_dir, worktree.as_ref())?;
    require_hook_trust(target.as_ref(), &project_dir)?;
    let out = run_git_hooked(target.as_ref(), &project_dir, &["commit", "-m", &message])?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(())
}

/// Returns a map of `relative_path → status` for all entries directly under `rel_path`.
/// Status values (highest priority first when bubbled up to a directory):
///   "modified"  – tracked file with unstaged working-tree changes (red bar)
///   "untracked" – new, not yet tracked (red bar)
///   "staged"    – staged, not yet committed (orange bar)
///   "unpushed"  – committed locally but not pushed to upstream (green ↑)
///   "ignored"   – ignored by git (gray ✕)
/// For directories the highest-priority child status bubbles up.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn git_file_statuses(
    project_dir: String,
    rel_path: String,
) -> Result<HashMap<String, String>, String> {
    app_core::rt::try_blocking("git", move || git_file_statuses_blocking(project_dir, rel_path)).await
}

fn git_file_statuses_blocking(
    project_dir: String,
    rel_path: String,
) -> Result<HashMap<String, String>, String> {
    let target = remote_target_for_dir(&project_dir);
    if local_non_repo(target.as_ref(), &project_dir) {
        return Ok(HashMap::new());
    }

    // A directory that is itself wholly ignored is collapsed by git into a
    // single `!! rel_path/` line at every ancestor listing under the default
    // `--untracked-files=normal` — so listing `rel_path` itself would come
    // back with zero lines under its prefix, and its children would silently
    // lose their "ignored" marker (rather than the folder just being empty of
    // git-reportable changes, which is the far more common reason this map
    // comes back empty). Detect that case up front via `check-ignore` and add
    // `--untracked-files=all`, which makes git recurse into an ignored
    // directory and report every file underneath individually instead of
    // collapsing it, scoped to `rel_path` so this stays cheap even inside a
    // huge folder like `node_modules`. Left off for the common case: it's a
    // more expensive walk, and combined with the anti-bubble rule below it
    // would actually stop a normal (non-wholly-ignored-ancestor) ignored
    // subfolder from being recognized, since a deep file line like
    // `sub/leaf.js` never equals its containing folder's own name.
    let wholly_ignored = !rel_path.is_empty()
        && run_git(
            target.as_ref(),
            &project_dir,
            &["check-ignore", "-q", "--", &rel_path],
        )
        .map(|out| out.status.success())
        .unwrap_or(false);

    // Scope the status to the browsed folder. Without a pathspec git walks the
    // WHOLE repo — and with `--ignored` that means stat-ing every ignored path in
    // it — only for `record` below to throw away every line outside `rel_path`
    // anyway. On a REMOTE project that walk runs on the host over SSH, on every
    // folder navigation and on every Local→Remote switch, which is what made
    // both feel like a hang on a repo carrying big gitignored trees (data,
    // checkpoints, venvs). The wholly-ignored branch already scoped itself for
    // exactly this reason; the common branch just never did. An empty
    // `rel_path` IS the repo root, so there is nothing to scope it to.
    let status_args: Vec<&str> = if wholly_ignored {
        vec![
            "status",
            "--porcelain",
            "--ignored",
            "--untracked-files=all",
            "--",
            &rel_path,
        ]
    } else if rel_path.is_empty() {
        vec![
            "status",
            "--porcelain",
            "--ignored",
            "--untracked-files=normal",
        ]
    } else {
        vec![
            "status",
            "--porcelain",
            "--ignored",
            "--untracked-files=normal",
            "--",
            &rel_path,
        ]
    };
    let out = run_git(target.as_ref(), &project_dir, &status_args)?;
    let porcelain = String::from_utf8_lossy(&out.stdout).into_owned();

    // prefix used to filter entries under rel_path
    let prefix = if rel_path.is_empty() {
        String::new()
    } else {
        format!("{rel_path}/")
    };

    fn priority(s: &str) -> u8 {
        match s {
            "modified" => 5,
            "untracked" => 4,
            "staged" => 3,
            "unpushed" => 2,
            "ignored" => 1,
            _ => 0,
        }
    }

    let mut map: HashMap<String, String> = HashMap::new();
    // Record `raw_path → status`, bubbling the highest-priority status up to the
    // top-level entry directly under `rel_path`.
    let mut record = |raw_path: &str, status: &str| {
        let file_path = if raw_path.contains(" -> ") {
            raw_path
                .split(" -> ")
                .last()
                .unwrap_or(raw_path)
                .trim_matches('"')
        } else {
            raw_path.trim_matches('"')
        };

        let rel = if prefix.is_empty() {
            file_path
        } else if let Some(stripped) = file_path.strip_prefix(&prefix) {
            stripped
        } else {
            return;
        };

        let top = rel.split('/').next().unwrap_or(rel);
        if top.is_empty() {
            return;
        }

        // "ignored" must not bubble up from a descendant: git reports a wholly
        // ignored path as `foo` (file) or `foo/` (whole dir), but an ignored
        // file inside an otherwise-tracked dir as `foo/bar`. Only mark the
        // top-level entry ignored when the ignored path IS that entry — else a
        // single ignored child would drag the whole folder into the gitignored
        // section. Other statuses still bubble up so a dir reflects its changes.
        // Skipped when `rel_path` itself is already known to be wholly
        // ignored: every line here is one of its descendants, so there is no
        // "is this ONE child ignored or is the whole folder" ambiguity to
        // guard against, and a deep file's top-level parent must still be
        // marked ignored even though the two paths never match exactly.
        if status == "ignored" && !wholly_ignored && rel.trim_end_matches('/') != top {
            return;
        }

        let cur = map.get(top).map(|s| priority(s.as_str())).unwrap_or(0);
        if priority(status) > cur {
            map.insert(top.to_string(), status.to_string());
        }
    };

    for line in porcelain.lines() {
        if line.len() < 4 {
            continue;
        }
        let bytes = line.as_bytes();
        let (x, y) = (bytes[0], bytes[1]);
        let raw_path = &line[3..];

        let status = if x == b'!' && y == b'!' {
            "ignored"
        } else if x == b'?' && y == b'?' {
            "untracked"
        } else if y != b' ' {
            // Unstaged working-tree change (also covers partly-staged like "MM").
            "modified"
        } else if x != b' ' {
            "staged"
        } else {
            continue;
        };
        record(raw_path, status);
    }

    // Files in commits that exist locally but are not on the upstream branch.
    let unpushed = unpushed_base(target.as_ref(), &project_dir).and_then(|base| {
        run_git(
            target.as_ref(),
            &project_dir,
            &["log", &format!("{base}.."), "--name-only", "--pretty=format:"],
        )
        .ok()
    });
    if let Some(out) = unpushed {
        if out.status.success() {
            let committed = String::from_utf8_lossy(&out.stdout).into_owned();
            for line in committed.lines() {
                let p = line.trim();
                if !p.is_empty() {
                    record(p, "unpushed");
                }
            }
        }
    }

    // git's porcelain only lists files, so an ignored folder that holds no file
    // at all (an empty `emails/` waiting for its first attachment) gets no line
    // and would sit in the regular section. Ask `check-ignore` about exactly
    // those children — one call, no walk. Local only: a remote tree would need
    // a second SSH round trip per listing.
    if target.is_none() && !wholly_ignored {
        let here = Path::new(&project_dir).join(&rel_path);
        let empty_dirs: Vec<(bool, String)> = std::fs::read_dir(&here)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|name| name != ".git" && !map.contains_key(name))
            .filter(|name| holds_no_file(&here.join(name), &mut 256))
            .map(|name| (true, name))
            .collect();
        let rel = rel_path.trim_matches('/');
        for name in crate::services::mobile_control::files::ignored_names(Path::new(&project_dir), rel, &empty_dirs) {
            map.insert(name, "ignored".to_string());
        }
    }

    // When `rel_path` is itself wholly ignored, EVERY entry under it is ignored —
    // but git's porcelain only ever emits *file* lines, so a child that is an
    // empty directory (or a tree of only empty directories, e.g. freshly scaffolded
    // experiment-output folders) produces no line at all and would silently drop
    // its "ignored" marker, landing in the regular section. git also can't be
    // coaxed into listing such dirs: it collapses a wholly-ignored subtree to its
    // topmost ignored ancestor and never enumerates empty descendants. Emit a
    // sentinel under the reserved key "." (never a real listing entry) so the
    // frontend can default every child of this directory to ignored, letting any
    // explicit per-child status above (a force-added tracked file) still win.
    if wholly_ignored {
        map.insert(".".to_string(), "ignored".to_string());
    }

    Ok(map)
}

/// Whether `dir` holds nothing but (possibly nested) empty folders — the shape
/// git status can't report. Links and other non-folders count as files, so the
/// walk never leaves the tree; it gives up (answers "holds a file") once
/// `budget` names are read.
fn holds_no_file(dir: &Path, budget: &mut usize) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else { return false };
    for entry in entries {
        if *budget == 0 {
            return false;
        }
        *budget -= 1;
        let Ok(entry) = entry else { return false };
        if !entry.file_type().is_ok_and(|t| t.is_dir()) || !holds_no_file(&entry.path(), budget) {
            return false;
        }
    }
    true
}

/// Stages a specific path (file or directory) via `git add`.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn git_add_path(project_dir: String, rel_path: String) -> Result<(), String> {
    app_core::rt::try_blocking("git", move || git_add_path_blocking(project_dir, rel_path)).await
}

fn git_add_path_blocking(project_dir: String, rel_path: String) -> Result<(), String> {
    let target = remote_target_for_dir(&project_dir);
    let out = run_git(target.as_ref(), &project_dir, &["add", "--", &rel_path])?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(())
}

/// A single changed file with its line delta, used by the action-button change
/// tree (Add/Commit/Push). `binary` files report 0/0 — git emits "-" for them.
#[derive(serde::Serialize)]
pub struct FileChange {
    pub path: String,
    pub added: i64,
    pub deleted: i64,
    pub binary: bool,
}

/// Per-file line stats (`git diff --numstat`) for one of three scopes:
///   "unstaged" – working-tree changes + untracked files (the Add list)
///   "staged"   – index vs HEAD (the Commit list)
///   "unpushed" – local commits ahead of upstream (the Push list)
/// The frontend folds these flat paths into a navigable folder tree.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn git_change_stats(
    ctx: Ctx,
    project_dir: String,
    scope: String,
    worktree: Option<GitWorktreeSelection>,
) -> Result<Vec<FileChange>, String> {
    let pool = ctx.get::<crate::services::remote::RemotePoolState>();
    let (project_dir, target) = selected_git_context(project_dir, worktree.as_ref())?;
    let dir = Path::new(&project_dir);
    if local_non_repo(target.as_ref(), &project_dir) {
        return Ok(vec![]);
    }

    let numstat_args: Option<Vec<String>> = match scope.as_str() {
        "staged" => Some(vec![
            "diff".into(),
            "--cached".into(),
            "--numstat".into(),
            "--".into(),
        ]),
        "unpushed" => unpushed_base(target.as_ref(), &project_dir).map(|base| {
            vec![
                "diff".into(),
                format!("{base}.."),
                "--numstat".into(),
                "--".into(),
            ]
        }),
        _ => Some(vec!["diff".into(), "--numstat".into(), "--".into()]),
    };

    let mut changes: Vec<FileChange> = Vec::new();
    let numstat = numstat_args.and_then(|args| {
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        run_git(target.as_ref(), &project_dir, &args).ok()
    });
    if let Some(out) = numstat {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines() {
                let mut parts = line.splitn(3, '\t');
                let a = parts.next().unwrap_or("");
                let d = parts.next().unwrap_or("");
                let p = parts.next().unwrap_or("");
                if p.is_empty() {
                    continue;
                }
                changes.push(FileChange {
                    path: normalize_numstat_path(p),
                    added: a.parse().unwrap_or(0),
                    deleted: d.parse().unwrap_or(0),
                    binary: a == "-" || d == "-",
                });
            }
        }
    }

    // Untracked files never appear in `git diff`; list them separately and count
    // their lines as additions (the Add list shows them alongside modified files).
    if scope == "unstaged" {
        if let Ok(out) = run_git(
            target.as_ref(),
            &project_dir,
            &["ls-files", "--others", "--exclude-standard", "-z"],
        ) {
            if out.status.success() {
                for chunk in out.stdout.split(|&b| b == 0) {
                    if chunk.is_empty() {
                        continue;
                    }
                    let rel = String::from_utf8_lossy(chunk).into_owned();
                    // Untracked line counts read the file's bytes and apply the
                    // same NUL/newline logic for both project kinds:
                    //   * local  → `std::fs::read` under the project directory;
                    //   * remote → the bytes over the pooled SFTP session, with
                    //     the rel path confined under `spec.remote_path` (a path
                    //     that escapes the root is treated as unreadable).
                    // Any read/confinement error degrades to (0, false) rather
                    // than failing the whole listing.
                    let (added, binary) = match &target {
                        None => count_added_lines(&dir.join(&rel)),
                        Some(t) => count_added_lines_remote(pool, t, &rel).await,
                    };
                    changes.push(FileChange {
                        path: rel,
                        added,
                        deleted: 0,
                        binary,
                    });
                }
            }
        }
    }

    Ok(changes)
}

/// `git --numstat` renders renames as `old => new`, optionally with a braced
/// common segment (`src/{a => b}/f.rs`). Reduce either form to the new path.
fn normalize_numstat_path(p: &str) -> String {
    let Some(arrow) = p.find(" => ") else {
        return p.to_string();
    };
    if let (Some(lb), Some(rb)) = (p.find('{'), p.find('}')) {
        if lb < arrow && arrow < rb {
            return format!("{}{}{}", &p[..lb], &p[arrow + 4..rb], &p[rb + 1..]);
        }
    }
    p[arrow + 4..].to_string()
}

/// Classify an untracked file's bytes into `(added_lines, binary)`, treating
/// NUL-containing files as binary (0 lines). A final line without a trailing
/// newline still counts. Shared by the local and remote readers below.
fn count_lines_in_bytes(bytes: &[u8]) -> (i64, bool) {
    if bytes.contains(&0) {
        return (0, true);
    }
    let newlines = bytes.iter().filter(|&&b| b == b'\n').count() as i64;
    let trailing = matches!(bytes.last(), Some(&b) if b != b'\n') as i64;
    (newlines + trailing, false)
}

/// Line count of an untracked **local** file. An unreadable path degrades to
/// `(0, false)` rather than failing the listing.
fn count_added_lines(path: &Path) -> (i64, bool) {
    match std::fs::read(path) {
        Ok(bytes) => count_lines_in_bytes(&bytes),
        Err(_) => (0, false),
    }
}

/// Line count of an untracked **remote** file, read over the project's pooled
/// SFTP session (mount-free remote). `rel` is the project-relative path from
/// `git ls-files --others`; it is confined under `spec.remote_path` so a hostile
/// path cannot escape the root. A confinement or read error degrades to
/// `(0, false)`, mirroring the local reader.
async fn count_added_lines_remote(
    pool: &crate::services::remote::RemotePoolState,
    target: &RemoteTarget,
    rel: &str,
) -> (i64, bool) {
    let Ok(path) = crate::commands::fs::remote_join_confined(&target.spec.remote_path, rel) else {
        return (0, false);
    };
    match crate::commands::fs::remote_read(pool, target, &path).await {
        Ok(bytes) => count_lines_in_bytes(&bytes),
        Err(_) => (0, false),
    }
}

/// The ref every "unpushed" view (tree markers, Push list, pill dot) measures
/// against: the configured upstream, else the current branch's namesake on a
/// remote (`origin` first). A branch pushed with an explicit refspec — or by a
/// tool that never set tracking — has no `@{u}` yet plainly has a pushed copy,
/// and measuring only `@{u}` left every one of its local commits unmarked.
/// `None` for a detached HEAD or a branch no remote has.
fn unpushed_base(target: Option<&RemoteTarget>, project_dir: &str) -> Option<String> {
    let ok = |args: &[&str]| {
        run_git(target, project_dir, args)
            .ok()
            .filter(|out| out.status.success())
            .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
    };
    if ok(&["rev-parse", "--verify", "-q", "@{u}"]).is_some() {
        return Some("@{u}".to_string());
    }
    let branch = ok(&["symbolic-ref", "-q", "--short", "HEAD"]).filter(|b| !b.is_empty())?;
    let refs = ok(&["for-each-ref", "--format=%(refname)", "refs/remotes/"])?;
    pick_remote_namesake(&refs, &branch)
}

/// From `for-each-ref refs/remotes/` output, the ref that is `branch` on some
/// remote — `origin`'s when several remotes carry it.
fn pick_remote_namesake(refs: &str, branch: &str) -> Option<String> {
    let suffix = format!("/{branch}");
    let mut found: Option<&str> = None;
    for r in refs.lines().map(str::trim) {
        let Some(rest) = r.strip_prefix("refs/remotes/") else {
            continue;
        };
        if !rest.ends_with(&suffix) || rest.len() == suffix.len() {
            continue;
        }
        if rest == format!("origin{suffix}") {
            return Some(r.to_string());
        }
        found.get_or_insert(r);
    }
    found.map(str::to_string)
}

/// Returns one-line summaries of commits ahead of the upstream (not yet pushed),
/// measured against [`unpushed_base`]. Empty when there is none or no repo.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn git_unpushed_commits(
    project_dir: String,
    worktree: Option<GitWorktreeSelection>,
) -> Result<Vec<String>, String> {
    app_core::rt::try_blocking("git", move || match worktree {
        None => git_unpushed_commits_blocking(project_dir),
        Some(selection) => git_unpushed_commits_blocking_selected(project_dir, Some(selection)),
    })
    .await
}

pub(crate) fn git_unpushed_commits_blocking(project_dir: String) -> Result<Vec<String>, String> {
    git_unpushed_commits_blocking_selected(project_dir, None)
}

fn git_unpushed_commits_blocking_selected(
    project_dir: String,
    worktree: Option<GitWorktreeSelection>,
) -> Result<Vec<String>, String> {
    let (project_dir, target) = selected_git_context(project_dir, worktree.as_ref())?;
    if local_non_repo(target.as_ref(), &project_dir) {
        return Ok(vec![]);
    }
    let Some(base) = unpushed_base(target.as_ref(), &project_dir) else {
        return Ok(vec![]);
    };
    let out = run_git(
        target.as_ref(),
        &project_dir,
        &["log", &format!("{base}.."), "--oneline"],
    )?;
    if !out.status.success() {
        return Ok(vec![]);
    }
    let text = String::from_utf8_lossy(&out.stdout);
    Ok(text
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect())
}

/// The ask-once gate (`services::exec_trust`) for git verbs that run the repo's
/// hooks on this machine. A remote project's git runs on its host — that host's
/// hooks are its own business — so only local repos are gated.
pub(crate) fn require_hook_trust(target: Option<&RemoteTarget>, project_dir: &str) -> Result<(), String> {
    if target.is_some() {
        return Ok(());
    }
    // A shared project's clone runs no hook at all (plan §6.5): nothing to
    // approve, and no approval could make one run.
    if crate::services::server::share::is_shared_dir(Path::new(project_dir)) {
        return Ok(());
    }
    crate::services::exec_trust::require(
        crate::services::exec_trust::TrustKind::GitHooks,
        Path::new(project_dir),
    )
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn git_push(
    project_dir: String,
    project_id: Option<String>,
    worktree: Option<GitWorktreeSelection>,
) -> Result<String, String> {
    app_core::rt::try_blocking("git", move || {
        if worktree.is_none() {
            return git_push_blocking(project_dir, project_id);
        }
        let (dir, target) = selected_git_context(project_dir, worktree.as_ref())?;
        if let Some(target) = target {
            let out = run_git_hooked(Some(&target), &dir, &PUSH_ARGS)?;
            push_outcome(&out, None, None)
        } else {
            git_push_blocking(dir, project_id)
        }
    })
    .await
}

/// The git bar's Release dialog: the suggested tag for the checked-out
/// branch's tip and whether a release could go out now
/// (`services::git_release`). Local projects only; asks the remote.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn git_release_preview(
    project_dir: String,
    project_id: Option<String>,
    worktree: Option<GitWorktreeSelection>,
) -> Result<crate::services::git_release::Preview, String> {
    app_core::rt::try_blocking("git", move || {
        let (project_dir, target) = selected_git_context(project_dir, worktree.as_ref())?;
        if target.is_some() {
            return Err("Releases are tagged from local projects only.".to_string());
        }
        require_hook_trust(None, &project_dir)?;
        let (token, origins) = release_creds(project_id.as_deref());
        Ok(crate::services::git_release::preview(
            Path::new(&project_dir),
            token.as_deref(),
            &origins,
        ))
    })
    .await
}

/// The user's Release click: tag the checked-out branch's tip as `tag`
/// (annotated, unsigned) and push that one tag, hooks off. Refused unless the
/// tip is exactly what the remote branch holds and the tag is new there. Gated
/// like Push: with no stored token the user's own credential helpers answer,
/// and those are part of the approved hook fingerprint.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn git_release_tag(
    project_dir: String,
    project_id: Option<String>,
    tag: String,
    worktree: Option<GitWorktreeSelection>,
) -> Result<String, String> {
    app_core::rt::try_blocking("git", move || {
        let (project_dir, target) = selected_git_context(project_dir, worktree.as_ref())?;
        if target.is_some() {
            return Err("Releases are tagged from local projects only.".to_string());
        }
        require_hook_trust(None, &project_dir)?;
        let dir = Path::new(&project_dir);
        let (token, origins) = release_creds(project_id.as_deref());
        let plan =
            crate::services::git_release::plan(dir, tag.trim(), false, token.as_deref(), &origins, &|_| true)
                .map_err(|f| f.message)?;
        crate::services::git_release::release(dir, &plan, &plan.tag, token.as_deref(), &origins)
            .map(|_| {
                format!(
                    "Tagged {} at {} and pushed it to {}.",
                    plan.tag,
                    &plan.head[..7.min(plan.head.len())],
                    plan.remote
                )
            })
            .map_err(|f| {
                if f.output.is_empty() {
                    f.message
                } else {
                    format!("{}\n{}", f.message, f.output)
                }
            })
    })
    .await
}

/// The project's effective token and the origins it may go to; no project
/// (a nested repo) means no token, so the user's own helpers answer.
fn release_creds(project_id: Option<&str>) -> (Option<String>, Vec<String>) {
    match project_id {
        Some(id) => crate::services::git_push_mcp::creds(id),
        None => (None, Vec::new()),
    }
}

/// The push button's `git push`. A branch with no upstream (created locally,
/// or pushed once with an explicit refspec) would fail with "has no upstream
/// branch"; `push.autoSetupRemote` pushes it to the same-named branch on the
/// push remote and records that as its upstream, like `push -u`. A git older
/// than 2.37 ignores the key and fails as before.
const PUSH_ARGS: [&str; 3] = ["-c", "push.autoSetupRemote=true", "push"];

/// `git push` in a local directory, authenticating an https remote with `token`
/// when one is set — scoped to `project_id`'s token origins (see
/// [`scoped_token_config`]). Hardened like every local git call, and gated on
/// the repo's hooks (`pre-push`) being approved. Shared by the local-project push
/// and the mirror-side push below, so both sides get identical auth.
fn push_local(
    dir: &std::path::Path,
    token: Option<&str>,
    project_id: Option<&str>,
) -> Result<std::process::Output, String> {
    crate::services::exec_trust::require(crate::services::exec_trust::TrustKind::GitHooks, dir)?;
    let mut args: Vec<String> = Vec::new();
    if token.is_some() {
        let origins = crate::commands::git_hosting::token_origins(project_id, None);
        args.extend(scoped_token_config(&origins, "x-access-token"));
    }
    args.extend(PUSH_ARGS.map(str::to_string));
    let mut cmd = hooked_git_command_in(dir, &args);
    if let Some(tok) = token {
        cmd.env(crate::app_env!("GIT_TOKEN"), tok);
        cmd.env("GIT_TERMINAL_PROMPT", "0");
    }
    cmd.output().map_err(|e| e.to_string())
}

fn git_push_blocking(project_dir: String, project_id: Option<String>) -> Result<String, String> {
    // The local repo whose remote-tracking ref this push moves — the mirror
    // for a mirror-published remote project, none for a push run on the host.
    let mut local_repo: Option<std::path::PathBuf> = None;
    let (out, before) = if let Some(target) = remote_target_for_dir(&project_dir) {
        // A remote project published from THIS machine has its `origin` on the
        // lockstep mirror, not on the host (see `commands::git_publish`) — so the
        // push has to run there, where the remote exists and the effective token
        // is the right machine's secret.
        match crate::commands::git_publish::mirror_origin_repo(&target.project_id) {
            Some(mirror) => {
                let token = crate::commands::git_hosting::effective_git_creds(&target.project_id).1;
                let before = pushed_tip(&mirror);
                local_repo = Some(mirror.clone());
                let out = push_local(&mirror, token.as_deref(), Some(&target.project_id))?;
                (out, before)
            }
            // No mirror-side origin: the repo was published (or wired by hand) on
            // the host, so the push runs there and authenticates with the host's
            // own git credentials/SSH keys. The local effective token does not
            // apply (it would be the wrong machine's secret) and is not forwarded.
            None => (crate::services::ssh_exec::run_git_remote(&target.spec, &PUSH_ARGS.map(str::to_string))?, None),
        }
    } else {
        // Local project: effective per-project → global token (if any).
        let token = project_id
            .as_deref()
            .and_then(|id| crate::commands::git_hosting::effective_git_creds(id).1);
        let dir = std::path::PathBuf::from(&project_dir);
        let before = pushed_tip(&dir);
        local_repo = Some(dir.clone());
        (push_local(&dir, token.as_deref(), project_id.as_deref())?, before)
    };
    push_outcome(&out, local_repo.as_deref(), before)
}

/// The push's result for the git bar. `repo` is the local repo whose
/// remote-tracking ref the push moves and `before` that ref's commit ahead of
/// the push (see [`pushed_tip`]).
fn push_outcome(out: &std::process::Output, repo: Option<&std::path::Path>, before: Option<String>) -> Result<String, String> {
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    if !out.status.success() {
        // A pre-push hook that amends the push (this repo's version bump)
        // re-pushes HEAD itself and then aborts the original, so git reports
        // failure for a push that landed — with everything the bump commit's
        // own hooks printed (the phone-staleness advisory) as the "error".
        // The remote-tracking ref says what actually happened.
        let landed = repo.is_some_and(|dir| {
            let after = pushed_tip(dir);
            after.is_some() && after != before && after == head_sha(dir)
        });
        if !landed {
            return Err(if stderr.is_empty() { stdout } else { stderr });
        }
        if let Some(dir) = repo {
            adopt_pushed_upstream(dir);
        }
        return Ok("Pushed — the repository's pre-push hook re-pushed it itself.".to_string());
    }
    Ok(if stdout.is_empty() { stderr } else { stdout })
}

/// The commit the current branch's pushed copy points at, per the local
/// remote-tracking ref ([`unpushed_base`]); `None` when there is none.
fn pushed_tip(dir: &std::path::Path) -> Option<String> {
    let d = dir.to_string_lossy();
    let base = unpushed_base(None, &d)?;
    rev_parse(dir, &base)
}

/// Record the upstream `push.autoSetupRemote` would have: a push the hook
/// re-pushed "failed", so git never set one, and a branch without one can't
/// be released or pushed by an agent (`services::git_release`). Only when
/// the branch has none; the same-named remote-tracking ref the push moved.
fn adopt_pushed_upstream(dir: &std::path::Path) {
    let d = dir.to_string_lossy();
    if rev_parse(dir, "@{u}").is_some() {
        return;
    }
    let Some(tracking) = unpushed_base(None, &d) else { return };
    let _ = run_git(None, &d, &["branch", &format!("--set-upstream-to={tracking}")]);
}

fn head_sha(dir: &std::path::Path) -> Option<String> {
    rev_parse(dir, "HEAD")
}

fn rev_parse(dir: &std::path::Path, rev: &str) -> Option<String> {
    stdout(None, dir, &["rev-parse", "--verify", "-q", rev])
}

// ── Clone (import from GitHub/GitLab) ───────────────────────────────────────

/// Clone `url` into `dest` and return `dest`. Used by the import dialog's
/// "Clone from GitHub/GitLab" source: the clone lands first, then the regular
/// `import_project` registers the resulting directory in place ("keep" mode).
///
/// Auth: an https URL rides the global access token from Settings → Git Hosting
/// (via the same inline credential helper as `git_push`) when one is stored; an
/// SSH URL uses the user's own keys. Every interactive prompt git could raise is
/// disabled (`GIT_TERMINAL_PROMPT=0`, ssh `BatchMode=yes`) — Tabtivity has no console
/// attached, so a prompt would be an invisible hang rather than a question.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn git_clone(url: String, dest: String) -> Result<String, String> {
    app_core::rt::try_blocking("git", move || git_clone_blocking(url, dest)).await
}

/// The https form of a clone URL, for an *anonymous* readability probe. An
/// `ssh://`/scp-style URL says nothing about visibility on its own (a key opens
/// public and private repos alike), so it is rewritten to the same repo's https
/// address; `http(s)` URLs are returned as-is minus any userinfo, which would
/// otherwise make the probe authenticated. Pure.
pub(crate) fn https_probe_url(raw: &str) -> Option<String> {
    let url = raw.trim();
    if url.is_empty() {
        return None;
    }
    let (authority, path) = match url.to_ascii_lowercase().find("://") {
        Some(i) => {
            let rest = &url[i + 3..];
            let slash = rest.find('/')?;
            (&rest[..slash], &rest[slash + 1..])
        }
        None => {
            // scp-like `[user@]host:path`.
            let colon = url.find(':')?;
            (&url[..colon], &url[colon + 1..])
        }
    };
    // Drop userinfo and any port: a probe must be anonymous, and the https
    // service does not live on the ssh port.
    let host = authority.rsplit('@').next().unwrap_or("");
    let host = host.split(':').next().unwrap_or("");
    let path = path.trim_start_matches('/');
    if host.is_empty() || path.is_empty() {
        return None;
    }
    Some(format!("https://{host}/{path}"))
}

/// Whether `url`'s repository can be read **without credentials** — the one
/// honest signal for "is this repo public or private" that costs a single
/// `ls-remote` and no provider login.
///
/// Returns `"public"`, `"private"`, or `"unknown"` (offline, an unreachable or
/// non-provider host, anything that is not an auth refusal). Used by the import
/// dialog to fill the Git hosting field from the repository being cloned rather
/// than assuming private. Deliberately anonymous: the stored access token is
/// *not* offered, since a token turns a private repo into a readable one and the
/// probe would then answer "public" for every repo the user can see.
///
/// A host that hides private repos behind a 404 (GitHub does) is indistinguishable
/// from a mistyped URL — both read as `"private"`, which is also the safe default
/// for the field this fills, and the clone itself is the thing that reports a bad
/// URL.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn git_remote_visibility(url: String) -> Result<String, String> {
    app_core::rt::try_blocking("git", move || git_remote_visibility_blocking(url)).await
}

fn git_remote_visibility_blocking(url: String) -> Result<String, String> {
    validate_clone_url(&url)?;
    let Some(probe) = https_probe_url(&url) else {
        return Ok("unknown".to_string());
    };
    // Bare on purpose: an anonymous `ls-remote` against a URL, no local repo.
    let mut cmd = crate::paths::command_no_window("git");
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    // No credential helper, no stored token: the whole point is what an
    // anonymous reader sees. `lowSpeed*` bounds a stalled connection so the
    // dialog's probe cannot hang around forever.
    cmd.args([
        "-c",
        "credential.helper=",
        "-c",
        "http.lowSpeedLimit=1000",
        "-c",
        "http.lowSpeedTime=8",
        "ls-remote",
        "--heads",
        "--",
        &probe,
    ]);
    let out = match cmd.output() {
        Ok(out) => out,
        Err(_) => return Ok("unknown".to_string()),
    };
    if out.status.success() {
        return Ok("public".to_string());
    }
    let stderr = String::from_utf8_lossy(&out.stderr).to_ascii_lowercase();
    let refused = stderr.contains("could not read username")
        || stderr.contains("authentication failed")
        || stderr.contains("terminal prompts disabled")
        || stderr.contains("repository not found")
        || stderr.contains("access denied")
        || stderr.contains("403")
        || stderr.contains("404");
    Ok(if refused { "private" } else { "unknown" }.to_string())
}

/// The `origin` URL of a folder about to be imported, or `None` when the folder
/// is not itself a repository or has no `origin`. Lets the import dialog fill
/// its Git hosting field from a repository that is already hosted, the way a
/// clone import fills it from the URL being cloned.
///
/// Only the folder's own `.git` counts: without that check `git` would walk up
/// and answer with an enclosing repository's `origin`. Read-only and offline
/// (`remote get-url` reads config, contacts nothing), hookless and bounded,
/// since the folder is not trusted yet.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn git_folder_origin(source_dir: String) -> Result<Option<String>, String> {
    app_core::rt::try_blocking("git", move || Ok(git_folder_origin_blocking(Path::new(&source_dir)))).await
}

fn git_folder_origin_blocking(dir: &Path) -> Option<String> {
    if !dir.join(".git").exists() {
        return None;
    }
    let cmd = hookless_git_command_in(dir, &["remote", "get-url", "origin"]);
    let output = crate::services::git_bounded::output_within(cmd, std::time::Duration::from_secs(15)).ok()?;
    if !output.status.success() {
        return None;
    }
    let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!url.is_empty()).then_some(url)
}

// ── Git history & branches ──────────────────────────────────────────────────

#[derive(Clone, serde::Serialize)]
pub struct GitCommit {
    pub hash: String,
    pub short: String,
    pub subject: String,
    pub author: String,
    pub date: String,
    pub refs: String,
    pub is_head: bool,
    /// Full hashes of this commit's parents (2+ for merge commits), oldest-first
    /// as reported by git. Empty for the root commit.
    pub parents: Vec<String>,
}

fn git_head_hash(target: Option<&RemoteTarget>, project_dir: &str) -> Option<String> {
    run_git(target, project_dir, &["rev-parse", "HEAD"])
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

/// Returns commits as one-line summaries, newest first: `limit` of them (default
/// 100) starting `skip` commits back from HEAD, so the panel can page a long
/// history in instead of stopping at the first page. Returns an empty vec for a
/// non-git directory, a repo with no commits yet, or a `skip` past the root.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn git_log(
    project_dir: String,
    limit: Option<u32>,
    skip: Option<u32>,
    worktree: Option<GitWorktreeSelection>,
) -> Result<Vec<GitCommit>, String> {
    app_core::rt::try_blocking("git", move || match worktree {
        None => git_log_blocking(project_dir, limit, skip),
        Some(selection) => git_log_blocking_selected(project_dir, limit, skip, Some(selection)),
    })
    .await
}

fn git_log_blocking(
    project_dir: String,
    limit: Option<u32>,
    skip: Option<u32>,
) -> Result<Vec<GitCommit>, String> {
    git_log_blocking_selected(project_dir, limit, skip, None)
}

fn git_log_blocking_selected(
    project_dir: String,
    limit: Option<u32>,
    skip: Option<u32>,
    worktree: Option<GitWorktreeSelection>,
) -> Result<Vec<GitCommit>, String> {
    let (project_dir, target) = selected_git_context(project_dir, worktree.as_ref())?;
    if local_non_repo(target.as_ref(), &project_dir) {
        return Ok(vec![]);
    }
    let max = limit.unwrap_or(100);
    let max_count = format!("--max-count={max}");
    let skipped = format!("--skip={}", skip.unwrap_or(0));
    let out = run_git(
        target.as_ref(),
        &project_dir,
        &["log", &max_count, &skipped, GIT_LOG_FMT],
    )?;
    if !out.status.success() {
        // Empty repository (no commits) — not an error for our purposes.
        return Ok(vec![]);
    }
    let head = git_head_hash(target.as_ref(), &project_dir);
    Ok(parse_git_log(
        &String::from_utf8_lossy(&out.stdout),
        head.as_deref(),
    ))
}

/// How far back a history search reads. Bounded so a huge repo cannot turn one
/// keystroke into an unbounded `git log`; the panel says when a search hit it.
const GIT_LOG_SEARCH_SCAN: u32 = 20_000;

/// Search the history (newest first) for commits whose hash, subject, author or
/// ref names contain `query` (case-insensitive). Reads `GIT_LOG_SEARCH_SCAN`
/// commits at most and returns up to `limit` matches.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn git_log_search(
    project_dir: String,
    query: String,
    limit: Option<u32>,
    worktree: Option<GitWorktreeSelection>,
) -> Result<Vec<GitCommit>, String> {
    app_core::rt::try_blocking("git", move || match worktree {
        None => git_log_search_blocking(project_dir, query, limit),
        Some(selection) => {
            git_log_search_blocking_selected(project_dir, query, limit, Some(selection))
        }
    })
    .await
}

fn git_log_search_blocking(
    project_dir: String,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<GitCommit>, String> {
    git_log_search_blocking_selected(project_dir, query, limit, None)
}

fn git_log_search_blocking_selected(
    project_dir: String,
    query: String,
    limit: Option<u32>,
    worktree: Option<GitWorktreeSelection>,
) -> Result<Vec<GitCommit>, String> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(vec![]);
    }
    let (project_dir, target) = selected_git_context(project_dir, worktree.as_ref())?;
    if local_non_repo(target.as_ref(), &project_dir) {
        return Ok(vec![]);
    }
    let max_count = format!("--max-count={GIT_LOG_SEARCH_SCAN}");
    let out = run_git(
        target.as_ref(),
        &project_dir,
        &["log", &max_count, GIT_LOG_FMT],
    )?;
    if !out.status.success() {
        return Ok(vec![]);
    }
    let head = git_head_hash(target.as_ref(), &project_dir);
    let all = parse_git_log(&String::from_utf8_lossy(&out.stdout), head.as_deref());
    Ok(filter_commits(all, &needle, limit.unwrap_or(200) as usize))
}

/// Keep the commits matching the lower-cased `needle`, at most `limit`.
fn filter_commits(commits: Vec<GitCommit>, needle: &str, limit: usize) -> Vec<GitCommit> {
    commits
        .into_iter()
        .filter(|c| {
            c.hash.starts_with(needle)
                || c.subject.to_lowercase().contains(needle)
                || c.author.to_lowercase().contains(needle)
                || c.refs.to_lowercase().contains(needle)
        })
        .take(limit)
        .collect()
}

/// The `--pretty` format shared by `git_log` and `git_file_log`: fields separated
/// by US (0x1f) so subjects can contain anything but a newline.
const GIT_LOG_FMT: &str = "--pretty=format:%H\u{1f}%h\u{1f}%s\u{1f}%an\u{1f}%ar\u{1f}%D\u{1f}%P";

/// Parse `git log` output emitted with `GIT_LOG_FMT` into `GitCommit`s. `head` is
/// the current HEAD sha (used only to flag `is_head`).
fn parse_git_log(text: &str, head: Option<&str>) -> Vec<GitCommit> {
    let mut commits = Vec::new();
    for line in text.lines() {
        let parts: Vec<&str> = line.split('\u{1f}').collect();
        if parts.len() < 7 {
            continue;
        }
        let hash = parts[0].to_string();
        let is_head = head == Some(hash.as_str());
        let parents = parts[6].split_whitespace().map(|p| p.to_string()).collect();
        commits.push(GitCommit {
            hash,
            short: parts[1].to_string(),
            subject: parts[2].to_string(),
            author: parts[3].to_string(),
            date: parts[4].to_string(),
            refs: parts[5].to_string(),
            is_head,
            parents,
        });
    }
    commits
}

/// The commit history for a single file (`git log --follow -- <rel_path>`), most
/// recent first. `--follow` keeps history across renames. Returns an empty vec for
/// a non-git dir, an untracked path, or a repo with no commits. Local and remote
/// (SSH) projects both work via the shared `run_git` dispatch.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn git_file_log(
    project_dir: String,
    rel_path: String,
    limit: Option<u32>,
) -> Result<Vec<GitCommit>, String> {
    app_core::rt::try_blocking("git", move || git_file_log_blocking(project_dir, rel_path, limit)).await
}

fn git_file_log_blocking(
    project_dir: String,
    rel_path: String,
    limit: Option<u32>,
) -> Result<Vec<GitCommit>, String> {
    let target = remote_target_for_dir(&project_dir);
    if local_non_repo(target.as_ref(), &project_dir) {
        return Ok(vec![]);
    }
    let max = limit.unwrap_or(100);
    let max_count = format!("--max-count={max}");
    let out = run_git(
        target.as_ref(),
        &project_dir,
        &["log", &max_count, "--follow", GIT_LOG_FMT, "--", &rel_path],
    )?;
    if !out.status.success() {
        // Untracked path or empty repo — not an error for our purposes.
        return Ok(vec![]);
    }
    let head = git_head_hash(target.as_ref(), &project_dir);
    Ok(parse_git_log(
        &String::from_utf8_lossy(&out.stdout),
        head.as_deref(),
    ))
}

/// Returns a file's contents at a specific revision (`git show <rev>:<rel_path>`).
/// Used by the in-app compare/merge view for the "old version" pane. Errors (bad
/// rev, path absent at that rev) surface as `Err(stderr)`. Local and remote (SSH)
/// projects both work via the shared `run_git` dispatch.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn git_file_at_rev(
    project_dir: String,
    rel_path: String,
    rev: String,
) -> Result<String, String> {
    app_core::rt::try_blocking("git", move || git_file_at_rev_blocking(project_dir, rel_path, rev)).await
}

fn git_file_at_rev_blocking(
    project_dir: String,
    rel_path: String,
    rev: String,
) -> Result<String, String> {
    let target = remote_target_for_dir(&project_dir);
    if local_non_repo(target.as_ref(), &project_dir) {
        return Ok(String::new());
    }
    // `git show <rev>:<path>` is one combined argument, so it can take no `--`
    // separator — the rev is validated instead (see `valid_rev`).
    check_rev(&rev)?;
    // `git show <rev>:<path>` wants a repo-relative, forward-slash path.
    let spec = format!("{rev}:{}", rel_path.replace('\\', "/"));
    let out = run_git(target.as_ref(), &project_dir, &["show", &spec])?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

#[derive(serde::Serialize)]
pub struct GitBranch {
    pub name: String,
    pub is_current: bool,
    pub is_remote: bool,
    /// The configured upstream (`origin/main`), "" for none / a remote branch.
    pub upstream: String,
    /// Against that upstream, as of the last fetch.
    pub ahead: usize,
    pub behind: usize,
}

/// Lists local and remote-tracking branches.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn git_branches(
    project_dir: String,
    worktree: Option<GitWorktreeSelection>,
) -> Result<Vec<GitBranch>, String> {
    app_core::rt::try_blocking("git", move || match worktree {
        None => git_branches_blocking(project_dir),
        Some(selection) => git_branches_blocking_selected(project_dir, Some(selection)),
    })
    .await
}

pub(crate) fn git_branches_blocking(project_dir: String) -> Result<Vec<GitBranch>, String> {
    git_branches_blocking_selected(project_dir, None)
}

fn git_branches_blocking_selected(
    project_dir: String,
    worktree: Option<GitWorktreeSelection>,
) -> Result<Vec<GitBranch>, String> {
    let (project_dir, target) = selected_git_context(project_dir, worktree.as_ref())?;
    if local_non_repo(target.as_ref(), &project_dir) {
        return Ok(vec![]);
    }
    let fmt = "--format=%(if)%(HEAD)%(then)*%(else) %(end)\u{1f}%(refname:short)\u{1f}%(refname)\u{1f}%(upstream:short)\u{1f}%(upstream:track,nobracket)";
    let out = run_git(target.as_ref(), &project_dir, &["branch", "-a", fmt])?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut branches = Vec::new();
    for line in text.lines() {
        let parts: Vec<&str> = line.split('\u{1f}').collect();
        if parts.len() < 3 {
            continue;
        }
        let name = parts[1].to_string();
        // Skip the symbolic remote HEAD pointer (e.g. "origin/HEAD").
        if name.ends_with("/HEAD") {
            continue;
        }
        let upstream = parts.get(3).copied().unwrap_or("").to_string();
        let (ahead, behind) = parse_track(parts.get(4).copied().unwrap_or(""));
        branches.push(GitBranch {
            is_current: parts[0] == "*",
            is_remote: parts[2].starts_with("refs/remotes/"),
            name,
            upstream,
            ahead,
            behind,
        });
    }
    Ok(branches)
}

/// Checks out a branch name or commit hash. Surfaces git's stderr on failure
/// (e.g. when the working tree has conflicting uncommitted changes).
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn git_checkout(
    project_dir: String,
    target: String,
    worktree: Option<GitWorktreeSelection>,
) -> Result<String, String> {
    app_core::rt::try_blocking("git", move || match worktree {
        None => git_checkout_blocking(project_dir, target),
        Some(selection) => git_checkout_blocking_selected(project_dir, target, Some(selection)),
    })
    .await
}

fn git_checkout_blocking(project_dir: String, target: String) -> Result<String, String> {
    git_checkout_blocking_selected(project_dir, target, None)
}

fn git_checkout_blocking_selected(
    project_dir: String,
    target: String,
    worktree: Option<GitWorktreeSelection>,
) -> Result<String, String> {
    // `target` originates from `git_branches` output, i.e. from repo content — a
    // refname beginning with `-` would be parsed by git as an option.
    check_rev(&target)?;
    let (project_dir, rt) = selected_git_context(project_dir, worktree.as_ref())?;
    // A checkout fires `post-checkout`, and for a container-toggled project
    // `.git/hooks` is the container's writable mount — so a contained agent
    // writing one would get host execution from a click in Tabtivity's Git panel.
    // `run_git` pins hooks off (see `hardened_git_args`); checkout stays there.
    let out = run_git(rt.as_ref(), &project_dir, &["checkout", &target])?;
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    if !out.status.success() {
        return Err(if stderr.is_empty() { stdout } else { stderr });
    }
    Ok(if stdout.is_empty() { stderr } else { stdout })
}

/// Returns the full commit message (subject + body) for a single commit.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn git_commit_message(
    project_dir: String,
    hash: String,
    worktree: Option<GitWorktreeSelection>,
) -> Result<String, String> {
    app_core::rt::try_blocking("git", move || match worktree {
        None => git_commit_message_blocking(project_dir, hash),
        Some(selection) => git_commit_message_blocking_selected(project_dir, hash, Some(selection)),
    })
    .await
}

fn git_commit_message_blocking(project_dir: String, hash: String) -> Result<String, String> {
    git_commit_message_blocking_selected(project_dir, hash, None)
}

fn git_commit_message_blocking_selected(
    project_dir: String,
    hash: String,
    worktree: Option<GitWorktreeSelection>,
) -> Result<String, String> {
    check_rev(&hash)?;
    let (project_dir, target) = selected_git_context(project_dir, worktree.as_ref())?;
    let out = run_git(
        target.as_ref(),
        &project_dir,
        &["log", "-1", "--pretty=format:%B", &hash],
    )?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Rewords the most recent commit (HEAD) via `git commit --amend`. Only valid
/// for the latest commit; rewording older commits would require a rebase.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn git_reword_head(
    project_dir: String,
    message: String,
    worktree: Option<GitWorktreeSelection>,
) -> Result<(), String> {
    app_core::rt::try_blocking("git", move || match worktree {
        None => git_reword_head_blocking(project_dir, message),
        Some(selection) => git_reword_head_blocking_selected(project_dir, message, Some(selection)),
    })
    .await
}

fn git_reword_head_blocking(project_dir: String, message: String) -> Result<(), String> {
    git_reword_head_blocking_selected(project_dir, message, None)
}

fn git_reword_head_blocking_selected(
    project_dir: String,
    message: String,
    worktree: Option<GitWorktreeSelection>,
) -> Result<(), String> {
    if message.trim().is_empty() {
        return Err("Commit message cannot be empty".to_string());
    }
    let (project_dir, target) = selected_git_context(project_dir, worktree.as_ref())?;
    require_hook_trust(target.as_ref(), &project_dir)?;
    let out = run_git_hooked(
        target.as_ref(),
        &project_dir,
        &["commit", "--amend", "-m", &message],
    )?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(())
}

/// Returns the unified diff for a single file relative to `project_dir`.
///
/// Runs `git diff -- <rel_path>` (working-tree changes against the index/HEAD).
/// When that yields no output — typically because the file is untracked, so it
/// has no tracked diff — it falls back to `git diff --no-index -- /dev/null
/// <rel_path>`, which renders the whole file as added. `--no-index` exits
/// non-zero whenever there are differences, so for the fallback we treat any
/// non-empty stdout as success regardless of exit status.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn git_diff_file(project_dir: String, rel_path: String) -> Result<String, String> {
    app_core::rt::try_blocking("git", move || git_diff_file_blocking(project_dir, rel_path)).await
}

fn git_diff_file_blocking(project_dir: String, rel_path: String) -> Result<String, String> {
    let target = remote_target_for_dir(&project_dir);
    let out = run_git(target.as_ref(), &project_dir, &["diff", "--", &rel_path])?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    if !stdout.is_empty() {
        return Ok(stdout);
    }

    // Tracked diff is empty. A tracked file is simply unchanged; an untracked
    // one shows whole, as added. `--no-index` exits non-zero when differences
    // exist, which is the normal case here, so treat any non-empty stdout as
    // success.
    let tracked = run_git(target.as_ref(), &project_dir, &["ls-files", "--", &rel_path])?;
    if tracked.status.success() && !tracked.stdout.is_empty() {
        return Ok(stdout);
    }
    let fallback = run_git(
        target.as_ref(),
        &project_dir,
        &["diff", "--no-index", "--", "/dev/null", &rel_path],
    )?;
    let fb_stdout = String::from_utf8_lossy(&fallback.stdout).to_string();
    if !fb_stdout.is_empty() {
        return Ok(fb_stdout);
    }
    if !fallback.status.success() {
        return Err(String::from_utf8_lossy(&fallback.stderr).to_string());
    }
    // No tracked changes and the fallback produced nothing — return empty diff.
    Ok(stdout)
}

// ── Git blame ────────────────────────────────────────────────────────────────

/// One source line's blame attribution. Mirrored field-for-field by the
/// frontend `BlameLine` interface (snake_case, no serde renames).
#[derive(serde::Serialize)]
pub struct GitBlameLine {
    /// 1-based final line number in the current file.
    pub line_no: u32,
    /// Full commit sha. All-zeros ⇒ the line is uncommitted (working tree).
    pub hash: String,
    /// First 8 chars of `hash`.
    pub short: String,
    pub author: String,
    /// Author time as unix epoch seconds; the frontend renders the relative date.
    pub author_time: i64,
    /// Commit subject (first line of the message).
    pub summary: String,
}

#[derive(Clone, Default)]
struct BlameMeta {
    author: String,
    author_time: i64,
    summary: String,
}

/// Parses `git blame --porcelain` output into one `GitBlameLine` per source
/// line. In porcelain form each line begins with a header
/// `<40-hex-sha> <orig-lineno> <final-lineno>[ <group-size>]`, followed — only
/// the **first** time a given commit appears — by its metadata (`author`,
/// `author-time`, `summary`, …), and always ends with a `\t`-prefixed content
/// line. Later lines of an already-seen commit carry only the header + content,
/// so commit metadata is cached by sha and reused.
fn parse_blame_porcelain(text: &str) -> Vec<GitBlameLine> {
    let mut cache: HashMap<String, BlameMeta> = HashMap::new();
    let mut lines: Vec<GitBlameLine> = Vec::new();

    let mut cur_hash: Option<String> = None;
    let mut cur_line_no: u32 = 0;
    let mut building = BlameMeta::default();

    let is_header = |l: &str| -> Option<(String, u32)> {
        let mut it = l.split(' ');
        let sha = it.next()?;
        if sha.len() != 40 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        let _orig = it.next()?; // original line number (unused)
        let final_no: u32 = it.next()?.parse().ok()?;
        Some((sha.to_string(), final_no))
    };

    for line in text.lines() {
        if let Some((sha, final_no)) = is_header(line) {
            // Start a new line record; seed metadata from cache if this commit
            // was already described earlier in the stream.
            building = cache.get(&sha).cloned().unwrap_or_default();
            cur_hash = Some(sha);
            cur_line_no = final_no;
        } else if let Some(rest) = line.strip_prefix("author-time ") {
            building.author_time = rest.trim().parse().unwrap_or(0);
        } else if let Some(rest) = line.strip_prefix("author ") {
            building.author = rest.to_string();
        } else if let Some(rest) = line.strip_prefix("summary ") {
            building.summary = rest.to_string();
        } else if line.starts_with('\t') {
            // Content line — finalizes the current record.
            if let Some(hash) = cur_hash.take() {
                cache
                    .entry(hash.clone())
                    .or_insert_with(|| building.clone());
                let short = hash.chars().take(8).collect();
                lines.push(GitBlameLine {
                    line_no: cur_line_no,
                    short,
                    author: building.author.clone(),
                    author_time: building.author_time,
                    summary: building.summary.clone(),
                    hash,
                });
            }
        }
    }

    lines
}

/// Per-line git blame for a file, ordered by line number. Returns an empty vec
/// for a non-git dir or a path with no blame (e.g. never committed and no
/// working-tree content). Local and remote (SSH) projects both work via the
/// shared `run_git` dispatch.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn git_blame(project_dir: String, rel_path: String) -> Result<Vec<GitBlameLine>, String> {
    app_core::rt::try_blocking("git", move || git_blame_blocking(project_dir, rel_path)).await
}

fn git_blame_blocking(project_dir: String, rel_path: String) -> Result<Vec<GitBlameLine>, String> {
    let target = remote_target_for_dir(&project_dir);
    if local_non_repo(target.as_ref(), &project_dir) {
        return Ok(vec![]);
    }
    // `--porcelain` emits commit metadata once per commit; `-w` ignores
    // whitespace-only changes so reformatting doesn't reassign blame.
    let out = run_git(
        target.as_ref(),
        &project_dir,
        &["blame", "--porcelain", "-w", "--", &rel_path],
    )?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        // An unmodified/untracked-but-blamable file blames fine; genuinely
        // un-blamable paths (never committed, no HEAD) just yield nothing.
        if stderr.is_empty() {
            return Ok(vec![]);
        }
        return Err(stderr);
    }
    Ok(parse_blame_porcelain(&String::from_utf8_lossy(&out.stdout)))
}

// ── Git worktrees (#23) ──────────────────────────────────────────────────────
//
// Three things about this surface are not obvious from the git verbs it wraps.
//
// **Where the operation runs is not where the bytes the user picked live** (I2).
// For a remote project `project_dir` is the *local mirror*, so resolving
// remoteness from it alone made every path the user typed into a local file
// tree get created on the login node — a mirror of the mirror's path inside the
// cluster `$HOME`, with nothing erroring. `WorktreeSite` makes that choice
// explicit, following `git_publish::PublishSite`, which solved the same problem.
//
// **A worktree has exactly one legitimate home** (I3). `git worktree add <path>`
// creates *and populates* `<path>`, so an unconstrained path argument is a
// "write repo-controlled content to any writable absolute path" primitive —
// including a path Tabtivity would later read back as executable intent (Group O
// #151). Every worktree therefore lands under `<root>/.tabtivity/worktrees/`, which
// is also the answer to two other findings at once: `.tabtivity` is already a walk
// boundary for both byte-sync walkers (so a worktree is never mirrored as a
// second full copy of the tree), and it sits inside the project directory the
// container bind-mounts at its identical absolute path (so the linked `.git`
// file's `gitdir:` pointer resolves inside the container instead of dangling).
// A single enumerable root per project is also what the deferred PTY-cwd
// confinement (#149) was waiting on.
//
// **`worktree add` checks out, and a checkout runs hooks** (I4). `.git/hooks`
// sits in a container-toggled project's writable rw mount, so a contained agent
// writing `.git/hooks/post-checkout` would get *host* execution the moment the
// user clicked Add. `run_git` pins `NO_HOOKS_CONFIG` on every verb that is not
// hook-trust gated (#862), the worktree verbs included (verified: `-c
// core.hooksPath=` does suppress the hook).

#[derive(serde::Serialize)]
pub struct Worktree {
    pub path: String,
    /// Short branch name, or "" when detached/bare.
    pub branch: String,
    /// Full HEAD sha, or "" for a bare worktree.
    pub head: String,
    pub is_main: bool,
    pub is_locked: bool,
    /// git's own words for *why* it is locked ("on a removable drive"), or "".
    /// Shown rather than discarded: the reason is the whole content of a lock.
    pub lock_reason: String,
    /// The administrative entry survives but the checkout is gone (deleted
    /// out-of-band). Discarding this was why a dead worktree listed as healthy.
    pub is_prunable: bool,
    pub prunable_reason: String,
    pub is_bare: bool,
    /// This worktree **is** the directory the command ran in. git does not
    /// protect the current worktree — `remove --force` on the tree you are
    /// standing in exits 0 and deletes it (verified) — so the refusal is ours
    /// (D4). `is_main` answers a different question and cannot stand in for it.
    pub is_current: bool,
}

/// Parses `git worktree list --porcelain` output. Records are blank-line
/// separated; each starts with `worktree <abs-path>` followed by optional
/// attribute lines (`HEAD <sha>`, `branch refs/heads/<name>`, `bare`,
/// `detached`, `locked [<reason>]`, `prunable [<reason>]`). git always lists
/// the main worktree first, so the first record is flagged `is_main`.
pub(crate) fn parse_worktree_porcelain(text: &str) -> Vec<Worktree> {
    let mut out: Vec<Worktree> = Vec::new();
    let mut cur: Option<Worktree> = None;
    let mut first = true;

    fn flush(cur: &mut Option<Worktree>, out: &mut Vec<Worktree>) {
        if let Some(wt) = cur.take() {
            if !wt.path.is_empty() {
                out.push(wt);
            }
        }
    }

    for line in text.lines() {
        if line.is_empty() {
            flush(&mut cur, &mut out);
            continue;
        }
        if let Some(path) = line.strip_prefix("worktree ") {
            // Starting a new record; close any in progress.
            flush(&mut cur, &mut out);
            cur = Some(Worktree {
                path: path.to_string(),
                branch: String::new(),
                head: String::new(),
                is_main: first,
                is_locked: false,
                lock_reason: String::new(),
                is_prunable: false,
                prunable_reason: String::new(),
                is_bare: false,
                is_current: false,
            });
            first = false;
        } else if let Some(wt) = cur.as_mut() {
            if let Some(sha) = line.strip_prefix("HEAD ") {
                wt.head = sha.to_string();
            } else if let Some(refname) = line.strip_prefix("branch ") {
                wt.branch = refname
                    .strip_prefix("refs/heads/")
                    .unwrap_or(refname)
                    .to_string();
            } else if line == "bare" {
                wt.is_bare = true;
            } else if line == "detached" {
                // branch stays empty
            } else if line == "locked" || line.starts_with("locked ") {
                wt.is_locked = true;
                wt.lock_reason = line["locked".len()..].trim().to_string();
            } else if line == "prunable" || line.starts_with("prunable ") {
                wt.is_prunable = true;
                wt.prunable_reason = line["prunable".len()..].trim().to_string();
            }
            // ignore unknown lines
        }
    }
    flush(&mut cur, &mut out);
    out
}

/// Which side of a project a worktree command operates on.
///
/// The distinction only bites for a **remote** project, whose `project_dir` is
/// the local mirror while its repo of record is on the host. `git_publish`'s
/// `PublishSite` is the precedent: where the bytes are is not where the
/// operation runs.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum WorktreeSite {
    /// The remote host's tree (a remote project's default — the Git panel
    /// reflects the host, and `git_checkout` already initiates from there).
    Host,
    /// The local working copy: a local project's directory, or a remote
    /// project's lockstep mirror.
    Local,
}

impl WorktreeSite {
    fn parse(s: Option<&str>) -> Self {
        match s {
            Some("mirror") | Some("local") => WorktreeSite::Local,
            _ => WorktreeSite::Host,
        }
    }
}

/// Frontend capability check: older running binaries ignore unknown command
/// arguments, so selection must stay disabled until this API is available.
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn git_worktree_selection_supported() -> bool {
    true
}

/// Explicit panel selection, always anchored to the registered project's repository.
#[derive(Clone, serde::Deserialize)]
pub struct GitWorktreeSelection {
    pub path: String,
    pub site: String,
}

/// Resolve the side first, then accept only a live checkout returned by that
/// repository's own worktree list. A host path never becomes a local invocation.
pub(crate) fn selected_git_context(
    project_dir: String,
    selection: Option<&GitWorktreeSelection>,
) -> Result<(String, Option<RemoteTarget>), String> {
    let Some(selection) = selection else {
        let target = remote_target_for_dir(&project_dir);
        return Ok((project_dir, target));
    };
    if selection.site != "host" && selection.site != "mirror" {
        return Err("Unknown worktree side".into());
    }
    let mut ctx = worktree_ctx(&project_dir, Some(&selection.site), None);
    if !selection.path.is_empty() {
        let out = run_worktree_git(&ctx, &["worktree", "list", "--porcelain"])?;
        if !out.status.success() {
            return Err(git_err(&out));
        }
        let list = parse_worktree_porcelain(&String::from_utf8_lossy(&out.stdout));
        let wt = list
            .iter()
            .find(|wt| same_dir(&ctx, &wt.path, &selection.path))
            .ok_or_else(|| {
                "The selected worktree no longer belongs to this repository".to_string()
            })?;
        if wt.is_prunable || wt.is_bare {
            return Err("The selected worktree is not a live checkout".into());
        }
        ctx.cwd = wt.path.clone();
        if let Some(target) = ctx.target.as_mut() {
            target.spec.remote_path = wt.path.clone();
        }
    }
    Ok((ctx.cwd, ctx.target))
}

/// Everything a worktree command needs once the site question is settled.
pub(crate) struct WorktreeCtx {
    /// `Some` → git runs over SSH on that host (and `remote_git_command` cds
    /// into `spec.remote_path`); `None` → git runs locally in `cwd`.
    target: Option<RemoteTarget>,
    /// The directory git runs in for a local invocation.
    cwd: String,
    /// The repo root on the side git actually runs — the containment anchor.
    /// Equal to `cwd` locally and to `spec.remote_path` on a host.
    root: String,
    /// The root's path separator: a host is always POSIX, whatever this machine is.
    posix: bool,
}

impl WorktreeCtx {
    /// The one sanctioned home for this side's worktrees (I3).
    fn worktrees_root(&self) -> String {
        self.join(&self.root, crate::brand::WORKTREES_DIR)
    }

    fn sep(&self) -> char {
        if self.posix || cfg!(not(windows)) {
            '/'
        } else {
            '\\'
        }
    }

    fn join(&self, base: &str, rel: &str) -> String {
        let base = base.trim_end_matches(['/', '\\']);
        let sep = self.sep();
        let rel = if sep == '/' {
            rel.replace('\\', "/")
        } else {
            rel.replace('/', "\\")
        };
        format!("{base}{sep}{rel}")
    }
}

/// Resolve `(project_dir, site, host_id)` into the side a worktree command runs on.
///
/// `host_id` mirrors `commands::slurm`: absent (or `"primary"`) means the
/// project's own host; anything else names one of its compute hosts.
pub(crate) fn worktree_ctx(
    project_dir: &str,
    site: Option<&str>,
    host_id: Option<&str>,
) -> WorktreeCtx {
    let primary = remote_target_for_dir(project_dir);
    let Some(primary) = primary else {
        // A local project has one side; `site` is meaningless and ignored.
        return WorktreeCtx {
            target: None,
            cwd: project_dir.to_string(),
            root: project_dir.to_string(),
            posix: false,
        };
    };
    if WorktreeSite::parse(site) == WorktreeSite::Local {
        // The remote project's local mirror — a real local git repo, and the
        // only repo whose worktrees could never be managed at all before.
        let mirror = crate::services::remote_sync::mirror_dir(&primary.project_id)
            .to_string_lossy()
            .to_string();
        return WorktreeCtx {
            target: None,
            cwd: mirror.clone(),
            root: mirror,
            posix: false,
        };
    }
    let target = match host_id {
        Some(h) if h != crate::services::remote::PRIMARY_HOST => {
            crate::services::remote::remote_target_for_host(&primary.project_id, h)
                .unwrap_or(primary)
        }
        _ => primary,
    };
    let root = target.spec.remote_path.clone();
    WorktreeCtx {
        target: Some(target),
        cwd: project_dir.to_string(),
        root,
        posix: true,
    }
}

/// Split a path into its components for both separators, so a lexical
/// containment check cannot be defeated by the other machine's slash.
fn path_components(s: &str) -> Vec<&str> {
    s.split(['/', '\\']).filter(|c| !c.is_empty()).collect()
}

fn is_absolute_on(s: &str, posix: bool) -> bool {
    if posix {
        s.starts_with('/')
    } else {
        s.starts_with('/')
            || s.starts_with('\\')
            || s.as_bytes()
                .get(1)
                .is_some_and(|&b| b == b':' && s.len() > 2)
    }
}

/// Resolve the user's worktree input to an absolute path **inside the sanctioned
/// worktrees root**, or refuse with the reason (I3).
///
/// Accepts a bare name (`feature-x`, the normal case — resolved inside the root)
/// or an absolute path already under the root (what the resolved-path preview in
/// the UI shows, so a paste of it round-trips). Everything else is refused
/// naming the root, because with exactly one legal location there is nothing
/// else a path could mean. `..` is rejected outright rather than normalized: a
/// path that has to be walked back into bounds is not one anybody typed on
/// purpose.
pub(crate) fn resolve_worktree_path(ctx: &WorktreeCtx, input: &str) -> Result<String, String> {
    let input = input.trim();
    if input.is_empty() {
        return Err("Worktree path cannot be empty".to_string());
    }
    if input.chars().any(|c| c.is_control()) {
        return Err("Worktree path contains control characters".to_string());
    }
    // `git worktree add` has no `--` boundary, so a positional that looks like an
    // option is refused rather than shielded.
    if !valid_positional_path(input) {
        return Err(format!("'{input}' is not a valid worktree path"));
    }
    let root = ctx.worktrees_root();
    let comps = path_components(input);
    if comps.iter().any(|c| *c == ".." || *c == ".") {
        return Err(format!(
            "A worktree path may not contain '.' or '..' — it must sit directly under {root}"
        ));
    }
    let abs = if is_absolute_on(input, ctx.posix) {
        input.to_string()
    } else {
        ctx.join(&root, input)
    };
    // Lexical containment, component-wise so `<root>-evil` cannot pass a prefix test.
    let root_comps = path_components(&root);
    let abs_comps = path_components(&abs);
    let contained = abs_comps.len() > root_comps.len()
        && abs_comps[..root_comps.len()] == root_comps[..]
        && is_absolute_on(&abs, ctx.posix);
    if !contained {
        return Err(format!(
            "Worktrees live under {root}. '{input}' is outside it."
        ));
    }
    Ok(abs)
}

/// Whether two paths on `ctx`'s side name the same directory. Canonicalized
/// locally (so a symlink or a `//` cannot smuggle a second name past the
/// current-worktree refusal); lexical for a host, where there is nothing to
/// canonicalize against without another round trip.
fn same_dir(ctx: &WorktreeCtx, a: &str, b: &str) -> bool {
    if ctx.target.is_none() {
        if let (Ok(a), Ok(b)) = (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
            return a == b;
        }
    }
    path_components(a) == path_components(b)
}

/// Run a worktree verb on `ctx`'s side, with hooks pinned off (I4) — as
/// `run_git` pins them for every verb it runs.
fn run_worktree_git(ctx: &WorktreeCtx, args: &[&str]) -> Result<std::process::Output, String> {
    run_git(ctx.target.as_ref(), &ctx.cwd, args)
}

fn git_err(out: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    if stderr.trim().is_empty() {
        stdout
    } else {
        stderr
    }
}

/// Lists worktrees attached to the repository on the chosen side.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn git_worktree_list(
    project_dir: String,
    site: Option<String>,
    host_id: Option<String>,
) -> Result<Vec<Worktree>, String> {
    app_core::rt::try_blocking("git", move || git_worktree_list_blocking(project_dir, site, host_id)).await
}

pub(crate) fn git_worktree_list_blocking(
    project_dir: String,
    site: Option<String>,
    host_id: Option<String>,
) -> Result<Vec<Worktree>, String> {
    let ctx = worktree_ctx(&project_dir, site.as_deref(), host_id.as_deref());
    // `.git` exists as a DIRECTORY for a main repo and as a FILE in a linked
    // worktree, so this guard tests existence, never `is_dir` (I6).
    if local_non_repo(ctx.target.as_ref(), &ctx.cwd) {
        return Ok(vec![]);
    }
    let out = run_worktree_git(&ctx, &["worktree", "list", "--porcelain"])?;
    if !out.status.success() {
        // Lenient, like git_log (e.g. empty repo).
        return Ok(vec![]);
    }
    let mut list = parse_worktree_porcelain(&String::from_utf8_lossy(&out.stdout));
    for wt in list.iter_mut() {
        wt.is_current = same_dir(&ctx, &wt.path, &ctx.root);
    }
    Ok(list)
}

/// Adds a worktree. When `new_branch` is true, `branch` is *created* at
/// `start_point` (default `HEAD`); otherwise the existing `branch` is checked
/// out there.
///
/// `path` is resolved into the project's sanctioned worktrees root — see
/// [`resolve_worktree_path`]; a bare name is the normal input.
#[cfg_attr(feature = "desktop", tauri::command)]
#[allow(clippy::too_many_arguments)]
pub async fn git_worktree_add(
    project_dir: String,
    path: String,
    branch: String,
    new_branch: bool,
    start_point: Option<String>,
    site: Option<String>,
    host_id: Option<String>,
) -> Result<String, String> {
    app_core::rt::try_blocking("git", move || {
        git_worktree_add_blocking(
            project_dir,
            path,
            branch,
            new_branch,
            start_point,
            site,
            host_id,
        )
    })
    .await
}

fn git_worktree_add_blocking(
    project_dir: String,
    path: String,
    branch: String,
    new_branch: bool,
    start_point: Option<String>,
    site: Option<String>,
    host_id: Option<String>,
) -> Result<String, String> {
    if branch.trim().is_empty() {
        return Err("Branch cannot be empty".to_string());
    }
    // Neither positional can be shielded with `--` (`git worktree add`'s synopsis
    // has no pathspec boundary), so both are validated instead.
    check_rev(&branch)?;
    let start = start_point.unwrap_or_default();
    let start = start.trim();
    if !start.is_empty() {
        check_rev(start)?;
    }
    if !new_branch && !start.is_empty() {
        return Err("A start point only applies when creating a new branch".to_string());
    }
    let ctx = worktree_ctx(&project_dir, site.as_deref(), host_id.as_deref());
    let abs = resolve_worktree_path(&ctx, &path)?;

    // The worktrees root lives inside the project tree so a container mount and
    // both byte-sync walkers already cover it — but an *imported* repo has no
    // `.tabtivity/` ignore rule, and `git add -A` then records the new checkout as a
    // bogus gitlink (mode 160000, verified). Repo-local `info/exclude` fixes that
    // without touching a tracked file. Best-effort: a failure here costs a noisy
    // `git status`, never the worktree.
    exclude_app_dir(&ctx);

    let mut args: Vec<&str> = vec!["worktree", "add"];
    if new_branch {
        args.push("-b");
        args.push(&branch);
        args.push(&abs);
        if !start.is_empty() {
            args.push(start);
        }
    } else {
        args.push(&abs);
        args.push(&branch);
    }
    let out = run_worktree_git(&ctx, &args)?;
    if !out.status.success() {
        return Err(git_err(&out));
    }
    Ok(abs)
}

/// Add `.tabtivity/` to the repo's own `info/exclude` if it is not already ignored.
/// Untracked and repo-local, so it changes nothing the user has committed.
fn exclude_app_dir(ctx: &WorktreeCtx) {
    const RULE: &str = crate::brand::PROJECT_DIR_EXCLUDE_RULE;
    match ctx.target.as_ref() {
        None => {
            let Ok(out) = run_git(None, &ctx.cwd, &["rev-parse", "--git-common-dir"]) else {
                return;
            };
            if !out.status.success() {
                return;
            }
            let git_dir = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if git_dir.is_empty() {
                return;
            }
            let git_dir = Path::new(&git_dir);
            let git_dir = if git_dir.is_absolute() {
                git_dir.to_path_buf()
            } else {
                Path::new(&ctx.cwd).join(git_dir)
            };
            // `info/` is writable inside the fence, so `info` or `exclude` may be
            // a planted link or FIFO: refused, never followed (#2347).
            let added = crate::services::git_guard::edit_info_exclude(&git_dir, |existing| {
                if existing.lines().any(|l| l.trim() == RULE) {
                    return None;
                }
                let mut next = existing.to_string();
                if !next.is_empty() && !next.ends_with('\n') {
                    next.push('\n');
                }
                next.push_str(RULE);
                next.push('\n');
                Some(next)
            });
            if let Err(why) = added {
                eprintln!("git worktree: {RULE} not added to info/exclude: {why}");
            }
        }
        Some(t) => {
            let _ = crate::services::ssh_exec::run_remote_script(&t.spec, &remote_exclude_script());
        }
    }
}

/// [`exclude_app_dir`]'s remote half, as one shell round trip. Nothing is
/// interpolated: `run_remote_script` supplies the `cd <remote_path> &&`
/// itself, already shell-quoted. A linked `info` or `exclude`, or one that is
/// not a folder / regular file, is left alone rather than appended through
/// (#2347).
fn remote_exclude_script() -> String {
    const RULE: &str = crate::brand::PROJECT_DIR_EXCLUDE_RULE;
    format!(
        "d=$(git rev-parse --git-common-dir 2>/dev/null) && \
         [ ! -L \"$d/info\" ] && mkdir -p \"$d/info\" && \
         [ -d \"$d/info\" ] && [ ! -L \"$d/info\" ] && \
         [ ! -L \"$d/info/exclude\" ] && \
         {{ [ ! -e \"$d/info/exclude\" ] || [ -f \"$d/info/exclude\" ]; }} && \
         {{ grep -qxF '{RULE}' \"$d/info/exclude\" 2>/dev/null || \
           printf '{RULE}\\n' >> \"$d/info/exclude\"; }}"
    )
}

/// Removes the worktree at `path`.
///
/// `force` is a **count**, not a flag: `1` removes a dirty worktree, and `2`
/// (`remove -f -f`) is the only thing that removes a *locked* one — git says so
/// itself and exits 128 for a single `--force` (verified). Passing a bool here
/// is what made a locked worktree permanently unremovable from Tabtivity (B4).
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn git_worktree_remove(
    project_dir: String,
    path: String,
    force: u8,
    site: Option<String>,
    host_id: Option<String>,
) -> Result<(), String> {
    app_core::rt::try_blocking("git", move || git_worktree_remove_blocking(project_dir, path, force, site, host_id))
        .await
}

fn git_worktree_remove_blocking(
    project_dir: String,
    path: String,
    force: u8,
    site: Option<String>,
    host_id: Option<String>,
) -> Result<(), String> {
    if !valid_positional_path(&path) {
        return Err(format!("'{path}' is not a valid worktree path"));
    }
    let ctx = worktree_ctx(&project_dir, site.as_deref(), host_id.as_deref());
    // D4: git happily deletes the tree you are standing in. Every open terminal
    // tab, the file watcher and the container bind mount are rooted there.
    if same_dir(&ctx, &path, &ctx.root) {
        return Err(
            concat!("That is this project's own checkout — removing it would delete the tree ", crate::app_name!(), " is \
             working in. Switch to another worktree first.")
                .to_string(),
        );
    }
    // Deliberately NOT containment-checked: git refuses a path it never
    // registered, so the delete side is already bounded — and a worktree created
    // before the sanctioned root existed (or from a terminal) must stay removable.
    let mut args: Vec<&str> = vec!["worktree", "remove"];
    args.extend(std::iter::repeat_n("--force", force.min(2) as usize));
    args.push(&path);
    let out = run_worktree_git(&ctx, &args)?;
    if !out.status.success() {
        return Err(git_err(&out));
    }
    Ok(())
}

/// Locks a worktree so neither `prune` nor a plain `remove` can drop it —
/// `reason` is git's own free text, shown back in the list.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn git_worktree_lock(
    project_dir: String,
    path: String,
    reason: Option<String>,
    site: Option<String>,
    host_id: Option<String>,
) -> Result<(), String> {
    app_core::rt::try_blocking("git", move || {
        let ctx = worktree_ctx(&project_dir, site.as_deref(), host_id.as_deref());
        if !valid_positional_path(&path) {
            return Err(format!("'{path}' is not a valid worktree path"));
        }
        let reason = reason.unwrap_or_default();
        let reason = reason.trim();
        let mut args: Vec<&str> = vec!["worktree", "lock"];
        if !reason.is_empty() {
            if reason.chars().any(|c| c.is_control()) {
                return Err("A lock reason cannot contain control characters".to_string());
            }
            args.push("--reason");
            args.push(reason);
        }
        args.push(&path);
        let out = run_worktree_git(&ctx, &args)?;
        if !out.status.success() {
            return Err(git_err(&out));
        }
        Ok(())
    })
    .await
}

/// Unlocks a worktree. Without this, and without `remove -f -f`, a locked
/// worktree could only be freed from a terminal — for a feature whose point is
/// not needing one (B4).
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn git_worktree_unlock(
    project_dir: String,
    path: String,
    site: Option<String>,
    host_id: Option<String>,
) -> Result<(), String> {
    app_core::rt::try_blocking("git", move || {
        let ctx = worktree_ctx(&project_dir, site.as_deref(), host_id.as_deref());
        if !valid_positional_path(&path) {
            return Err(format!("'{path}' is not a valid worktree path"));
        }
        let out = run_worktree_git(&ctx, &["worktree", "unlock", &path])?;
        if !out.status.success() {
            return Err(git_err(&out));
        }
        Ok(())
    })
    .await
}

/// Prunes administrative entries for worktrees whose directories were removed
/// out-of-band (`git worktree prune`).
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn git_worktree_prune(
    project_dir: String,
    site: Option<String>,
    host_id: Option<String>,
) -> Result<(), String> {
    app_core::rt::try_blocking("git", move || {
        let ctx = worktree_ctx(&project_dir, site.as_deref(), host_id.as_deref());
        let out = run_worktree_git(&ctx, &["worktree", "prune"])?;
        if !out.status.success() {
            return Err(git_err(&out));
        }
        Ok(())
    })
    .await
}

/// Map an `origin` remote URL to a hosting provider by its **host only**.
/// Handles both SSH (`git@github.com:owner/repo.git`) and HTTPS
/// (`https://github.com/owner/repo.git`) forms. Read-only string work — no
/// network. Returns `None` for unrecognized/self-hosted vanity hosts so we
/// never render a wrong badge.
fn provider_from_origin_url(url: &str) -> Option<&'static str> {
    let lower = url.to_ascii_lowercase();
    if lower.contains("gitlab") {
        Some("gitlab")
    } else if lower.contains("github") {
        Some("github")
    } else {
        None
    }
}

/// A recognized `origin` for a local project: the hosting provider plus the raw
/// remote URL, so the frontend can both badge the provider and display the git
/// address in the project hover.
#[derive(serde::Serialize)]
pub struct DetectedOrigin {
    pub provider: String,
    pub url: String,
}

/// Sniff the `origin` host for each **local** git project and map it to a
/// hosting provider (`"github"`/`"gitlab"`) plus its raw URL. Read-only: runs
/// `git remote get-url origin`, makes no network calls and writes nothing.
/// Returns `{ project_id -> { provider, url } }` only for projects whose origin
/// resolves to a recognized provider. Published (`remote-*`) local projects are
/// included too, so their git address shows in the hover even though their badge
/// already rides on `git_type`. Used to decorate pill/side-panel hovers for
/// repos pushed to a host — including ones published outside Tabtivity's own
/// Publish flow (the sole writer of the `remote-*` `git_type`).
///
/// Offloaded via `app_core::rt::try_blocking`: the body forks one `git remote get-url`
/// per local project, and as a sync command that whole loop ran on the main
/// thread, stalling the window for N process spawns on every call.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn detect_git_providers() -> Result<HashMap<String, DetectedOrigin>, String> {
    app_core::rt::try_blocking("git", detect_git_providers_blocking).await
}

fn detect_git_providers_blocking() -> Result<HashMap<String, DetectedOrigin>, String> {
    use serde_json::Value;

    let list = crate::services::remote::projects()?;

    let mut out = HashMap::new();
    for entry in list.iter() {
        // Local projects only: a remote project's `origin` lives on the host,
        // and sniffing it would be a network call.
        if entry.extra.contains_key("remote") {
            continue;
        }
        // Skip repo-less projects; `local` and `remote-*` are both eligible.
        if let Some(Value::String(gt)) = entry.extra.get("git_type") {
            if gt == "none" {
                continue;
            }
        }
        // The project's working directory. Legacy entries (created before
        // `directory` was persisted — e.g. the self-hosting checkout's own
        // entry) omit the key; `directory()` falls back to `local_file`'s
        // folder, so they still get sniffed/badged.
        let Some(dir) = entry.directory() else { continue };
        if !Path::new(dir).join(".git").exists() {
            continue;
        }
        // Bounded (#2349), in the folder rather than `-C` so the FIFO pre-check
        // sees it: one hung `config` read must not hold the whole sweep.
        // Hookless: a background sweep over every project's repo.
        let cmd = hookless_git_command_in(dir, &["remote", "get-url", "origin"]);
        let output = crate::services::git_bounded::output_within(cmd, std::time::Duration::from_secs(15));
        let Ok(output) = output else { continue };
        if !output.status.success() {
            continue;
        }
        let url = String::from_utf8_lossy(&output.stdout);
        let url = url.trim();
        if let Some(provider) = provider_from_origin_url(url) {
            out.insert(
                entry.id.clone(),
                DetectedOrigin {
                    provider: provider.to_string(),
                    url: url.to_string(),
                },
            );
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests;
