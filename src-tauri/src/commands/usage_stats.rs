//! Commands behind the daily usage recap.
//!
//! Three surfaces:
//!
//! - [`usage_bump`] — the one write path the frontend uses. It is *batched*: the
//!   frontend accumulates counters in memory and flushes them on an interval, so
//!   a burst of keystrokes costs one whole-file rewrite per flush, not per event.
//! - [`usage_summary`] — read-only rollup, mirroring `commands::net_usage::get_net_usage`.
//! - [`usage_token_stats`] — agent tokens, **derived** from the CLIs' own
//!   transcripts by `services::token_stats`, never counted into the store.
//! - [`usage_git_stats`] — commits/lines, **derived on demand** from `git log`
//!   rather than counted into the store, so they can never drift or double-count.

use std::collections::HashMap;

use crate::schema::usage_stats::{self, Counters};
use crate::services::remote::remote_target_for_dir;

/// The rollup handed to the frontend: the same two bucket maps the store holds,
/// already folded to one project (or summed across all of them).
#[derive(Debug, Clone, serde::Serialize)]
pub struct UsageReport {
    /// hour ("YYYY-MM-DDTHH") → metric → count.
    pub hours: HashMap<String, Counters>,
    /// date ("YYYY-MM-DD") → metric → count.
    pub days: HashMap<String, Counters>,
}

/// Fold a batch of counters into `project_id`'s current UTC hour.
///
/// `project_id` is the scope the counters belong to — a project id, or the root
/// scope's pseudo-id. An empty batch or an empty id is a no-op that never touches
/// disk.
///
/// Offloaded to the blocking pool: it is a read-modify-write of a JSON file, and
/// a Tauri sync command would do that on the UI thread.
#[tauri::command]
pub async fn usage_bump(project_id: String, metrics: Counters) -> Result<(), String> {
    tokio::task::spawn_blocking(move || usage_stats::record(&project_id, &metrics))
        .await
        .map_err(|e| format!("usage_bump task failed: {e}"))?
}

/// Every recorded counter for `project_id`, or summed across all projects when it
/// is empty. Read-only — recording is internal to [`usage_bump`] and the watcher.
#[tauri::command]
pub async fn usage_summary(project_id: String) -> Result<UsageReport, String> {
    tokio::task::spawn_blocking(move || {
        let stats = usage_stats::load();
        UsageReport {
            hours: stats.hourly_for(&project_id),
            days: stats.daily_for(&project_id),
        }
    })
    .await
    .map_err(|e| format!("usage_summary task failed: {e}"))
}

/// Agent token counters, in the [`UsageReport`] shape plus what the frontend
/// needs to read them honestly.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenReport {
    /// hour ("YYYY-MM-DDTHH") → `tokens.<kind>.<cli>.<model>` → count.
    pub hours: HashMap<String, Counters>,
    /// date ("YYYY-MM-DD") → `tokens.<kind>.<cli>.<model>` → count.
    pub days: HashMap<String, Counters>,
    /// The scan stopped at its budget; the counts are short and the next call
    /// carries on.
    pub partial: bool,
    /// The CLIs whose records are read at all, so a CLI used in the period but
    /// missing here reads as "not reported", never as zero.
    pub sources: Vec<String>,
}

/// Token counts for `project_id` (a project, `box:<id>` or the root scope), or
/// summed across every scope when it is empty.
///
/// **Derived, not stored**: runs an incremental scan of the agent homes'
/// transcripts (`services::token_stats`) and folds the result like
/// [`usage_summary`]. On the blocking pool — the first scan reads every
/// transcript there is.
#[tauri::command]
pub async fn usage_token_stats(project_id: String) -> Result<TokenReport, String> {
    tokio::task::spawn_blocking(move || {
        let state_dir = crate::storage::state_dir();
        let scanned = crate::services::token_stats::scan(&state_dir, &known_scope_ids());
        TokenReport {
            hours: scanned.stats.hourly_for(&project_id),
            days: scanned.stats.daily_for(&project_id),
            partial: scanned.partial,
            sources: crate::services::token_stats::SOURCES
                .iter()
                .map(|s| s.to_string())
                .collect(),
        }
    })
    .await
    .map_err(|e| format!("usage_token_stats task failed: {e}"))
}

/// Every scope id an agent home can belong to: the root console, each
/// registered project, each box (`box:<id>`). An unreadable registry only
/// means its homes are filed under the root until the next read succeeds —
/// the scan re-files them then.
fn known_scope_ids() -> Vec<String> {
    let mut ids = vec![crate::storage::ROOT_SCOPE.to_string()];
    if let Ok(projects) = crate::commands::projects::read_projects_list() {
        ids.extend(projects.into_iter().map(|p| p.id));
    }
    let boxes_path = crate::storage::state_dir().join("boxes.json");
    if let Ok(boxes) = crate::storage::read_json::<crate::schema::boxes::BoxesList>(&boxes_path) {
        let prefix = crate::commands::boxes::BOX_SCOPE_PREFIX;
        ids.extend(boxes.into_iter().map(|b| format!("{prefix}{}", b.id)));
    }
    ids
}

/// Point the file-churn watcher at a project's tree, replacing any previous
/// watch. Called by the frontend when the active project changes; an empty
/// `project_id` (no project active) just stops watching.
///
/// Which directory that actually is — the project's own, or a remote project's
/// local mirror — is resolved backend-side (`services::usage_stats::watch_root_for`).
/// Watching is best-effort: a project with nothing watchable simply records no
/// file stats.
#[tauri::command]
pub fn usage_watch_project(
    state: tauri::State<'_, crate::services::usage_stats::UsageWatchState>,
    project_id: String,
) -> Result<(), String> {
    crate::services::usage_stats::watch_project(&state, &project_id)
}

/// Commits and line churn attributable to *you*, in a time window.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStats {
    pub commits: u64,
    pub files_changed: u64,
    pub lines_added: u64,
    pub lines_removed: u64,
}

/// Commits/lines for `project_dir` since `since` (any string git's `--since`
/// accepts — the recap passes an ISO date).
///
/// **Derived, not stored.** Re-reading the log is idempotent, so a recap that is
/// opened twice cannot double-count, and the week/month windows come free by
/// moving `since`.
///
/// Scoped to commits authored by the repo's configured `user.email`, so a `git
/// pull` that lands fifty of a colleague's commits does not read as fifty of
/// yours. With no `user.email` configured we fall back to counting every commit
/// (better than reporting zero).
///
/// **Local repos only.** A remote project's git lives on the host and would run
/// over SSH, which can stall for the whole `ConnectTimeout` when the host is
/// down — and this command runs while the recap is opening. A remote project
/// reports no git stats rather than hanging the dialog; its local mirror, being
/// an ordinary local path, works normally.
#[tauri::command]
pub async fn usage_git_stats(project_dir: String, since: String) -> Result<GitStats, String> {
    tokio::task::spawn_blocking(move || git_stats_blocking(&project_dir, &since))
        .await
        .map_err(|e| format!("usage_git_stats task failed: {e}"))?
}

fn git_stats_blocking(project_dir: &str, since: &str) -> Result<GitStats, String> {
    // Remote (see the doc comment) and non-repos short-circuit to zero.
    if remote_target_for_dir(project_dir).is_some() {
        return Ok(GitStats::default());
    }
    if !std::path::Path::new(project_dir).join(".git").exists() {
        return Ok(GitStats::default());
    }

    let author = git_user_email(project_dir);
    let mut args: Vec<String> = vec![
        "log".into(),
        format!("--since={since}"),
        "--numstat".into(),
        "--pretty=format:%H".into(),
        // A merge shows no numstat by default; excluding merges also keeps the
        // commit count to work you actually authored.
        "--no-merges".into(),
    ];
    if let Some(email) = &author {
        args.push(format!("--author={email}"));
    }

    // The recap runs this unattended, in a directory a project container mounts
    // writable — so the repo's own config is untrusted (`commands::git`,
    // Group O #151); `hardened_git_command_in` sanitizes it first.
    let out = crate::services::git_bounded::output(crate::commands::git::hardened_git_command_in(
        project_dir,
        &args,
    ))?;

    // A repo with no commits yet exits non-zero; that is "nothing today", not an
    // error worth failing the whole recap over.
    if !out.status.success() {
        return Ok(GitStats::default());
    }
    Ok(parse_numstat_log(&String::from_utf8_lossy(&out.stdout)))
}

/// The repo's configured author email, or `None` when unset.
fn git_user_email(project_dir: &str) -> Option<String> {
    let mut cmd = crate::paths::command_no_window("git");
    cmd.args(["config", "user.email"]).current_dir(project_dir);
    let out = crate::services::git_bounded::output(cmd).ok()?;
    if !out.status.success() {
        return None;
    }
    let email = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!email.is_empty()).then_some(email)
}

/// Parse `git log --numstat --pretty=format:%H` output.
///
/// The shape is a commit hash on its own line, then one `added\tremoved\tpath`
/// line per file, then a blank line. A binary file reports `-` for both counts —
/// it changed, so it counts as a file, but contributes no lines.
///
/// Pure, so the parsing is unit-tested without a repo.
fn parse_numstat_log(stdout: &str) -> GitStats {
    let mut stats = GitStats::default();
    for line in stdout.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            continue;
        }
        match line.split('\t').collect::<Vec<_>>()[..] {
            [added, removed, _path] => {
                stats.files_changed += 1;
                // "-" means binary: a real change, but no line counts.
                stats.lines_added += added.parse::<u64>().unwrap_or(0);
                stats.lines_removed += removed.parse::<u64>().unwrap_or(0);
            }
            // Anything else on its own line is the `%H` commit hash.
            _ => stats.commits += 1,
        }
    }
    stats
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_single_commit_with_two_files() {
        let out = "abc123\n\
                   3\t1\tsrc/lib.rs\n\
                   10\t0\tREADME.md\n";
        let stats = parse_numstat_log(out);
        assert_eq!(
            stats,
            GitStats {
                commits: 1,
                files_changed: 2,
                lines_added: 13,
                lines_removed: 1,
            }
        );
    }

    #[test]
    fn parses_several_commits_separated_by_blank_lines() {
        let out = "aaa\n\
                   1\t1\ta.rs\n\
                   \n\
                   bbb\n\
                   2\t3\tb.rs\n";
        let stats = parse_numstat_log(out);
        assert_eq!(stats.commits, 2);
        assert_eq!(stats.files_changed, 2);
        assert_eq!(stats.lines_added, 3);
        assert_eq!(stats.lines_removed, 4);
    }

    #[test]
    fn binary_files_count_as_changed_but_add_no_lines() {
        // git reports "-\t-\tpath" for a binary blob.
        let out = "abc\n-\t-\tlogo.png\n";
        let stats = parse_numstat_log(out);
        assert_eq!(stats.commits, 1);
        assert_eq!(stats.files_changed, 1);
        assert_eq!(stats.lines_added, 0);
        assert_eq!(stats.lines_removed, 0);
    }

    #[test]
    fn a_commit_touching_nothing_still_counts_as_a_commit() {
        let stats = parse_numstat_log("abc123\n");
        assert_eq!(stats.commits, 1);
        assert_eq!(stats.files_changed, 0);
    }

    #[test]
    fn empty_log_is_all_zeroes() {
        assert_eq!(parse_numstat_log(""), GitStats::default());
        assert_eq!(parse_numstat_log("\n\n"), GitStats::default());
    }

    #[test]
    fn paths_containing_spaces_are_not_split() {
        // numstat is TAB-separated precisely so paths may contain spaces; a
        // whitespace split here would misread the path as extra columns.
        let out = "abc\n5\t2\tsrc/my folder/a file.rs\n";
        let stats = parse_numstat_log(out);
        assert_eq!(stats.files_changed, 1);
        assert_eq!(stats.lines_added, 5);
        assert_eq!(stats.lines_removed, 2);
    }
}
