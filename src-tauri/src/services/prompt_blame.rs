//! Prompt blame: what a project looked like when a prompt reached an agent,
//! and which files changed while the agent worked on it.
//!
//! `git blame` answers "which commit put this line here"; this answers "which
//! prompt did". A sent prompt records the commit HEAD pointed at when it was
//! delivered (and the branch, when there is one), and — once the agent has gone
//! idle again — the files that changed in between: what is dirty in the
//! working tree and was written after the delivery, plus what any commit made
//! since touched. The history row keeps both, so a file name typed into the
//! Sent prompts filter finds the prompts that touched it.
//!
//! Local projects only. A remote project's repo lives on the host and every
//! probe of it is an SSH round trip that must not run inside a send; a remote
//! send simply records no blame rather than a slow or freezing one.

use std::{
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use crate::services::remote::{project_directory, remote_target_for};

/// The upper bound on the files a single row records. A prompt that touched
/// more than this is a refactor whose file list nobody reads row by row; the
/// list is truncated after sorting so what is kept is deterministic.
pub const MAX_BLAME_FILES: usize = 200;
/// Where the repo stood when a prompt was delivered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoHead {
    /// The full HEAD hash.
    pub commit: String,
    /// The checked-out branch, or `None` on a detached HEAD.
    pub branch: Option<String>,
}

/// The directory of a LOCAL project's repository, or `None` for a remote
/// project, an unknown id, a box or root scope, or a folder without `.git`.
fn local_repo_dir(project_id: &str) -> Option<PathBuf> {
    if remote_target_for(project_id).is_some() {
        return None;
    }
    let dir = PathBuf::from(project_directory(project_id)?);
    dir.join(".git").exists().then_some(dir)
}

fn git_stdout(dir: &Path, args: &[&str]) -> Option<Vec<u8>> {
    let out = crate::services::git_bounded::output(crate::commands::git::hardened_git_command_in(dir, args)).ok()?;
    out.status.success().then_some(out.stdout)
}

fn git_line(dir: &Path, args: &[&str]) -> Option<String> {
    let text = String::from_utf8_lossy(&git_stdout(dir, args)?)
        .trim()
        .to_string();
    (!text.is_empty()).then_some(text)
}

/// HEAD of a local project's repo, or `None` when there is nothing to record
/// (remote project, no repo, unborn HEAD).
pub fn head(project_id: &str) -> Option<RepoHead> {
    let dir = local_repo_dir(project_id)?;
    // `--verify --quiet` prints nothing on an unborn HEAD instead of the
    // literal `HEAD` a bare `rev-parse HEAD` would.
    let commit = git_line(&dir, &["rev-parse", "--verify", "--quiet", "HEAD"])?;
    if !is_commit_hash(&commit) {
        return None;
    }
    let branch = git_line(&dir, &["symbolic-ref", "--short", "--quiet", "HEAD"]);
    Some(RepoHead { commit, branch })
}

/// A full or abbreviated hex object name. Stored hashes are our own, but they
/// still get handed to `git diff` as a positional argument, and a hex string
/// can never be parsed as an option.
pub fn is_commit_hash(value: &str) -> bool {
    (7..=64).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_hexdigit())
}

/// One entry of `git status --porcelain -z --untracked-files=all`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusEntry {
    pub path: String,
    /// Deleted in the index or the working tree — there is no file to stat, so
    /// there is no way to tell whether the deletion happened after the prompt.
    pub deleted: bool,
}

/// Parse `-z` porcelain output. Entries are `XY <path>\0`, and a rename or
/// copy is followed by a second NUL-terminated field holding the ORIGINAL
/// path, which is skipped: the file the prompt left behind is the new name.
pub fn parse_status_z(bytes: &[u8]) -> Vec<StatusEntry> {
    let mut entries = Vec::new();
    let mut fields = bytes.split(|b| *b == 0).peekable();
    while let Some(field) = fields.next() {
        if field.len() < 4 {
            continue;
        }
        let x = field[0];
        let y = field[1];
        let path = String::from_utf8_lossy(&field[3..]).into_owned();
        if x == b'R' || x == b'C' {
            fields.next();
        }
        entries.push(StatusEntry {
            path,
            deleted: x == b'D' || y == b'D',
        });
    }
    entries
}

/// Pure core of [`files_touched`]: which working-tree entries count as changed
/// by a prompt delivered at `since` (Unix seconds), given each path's mtime.
/// A deletion is never attributed, and a file whose mtime cannot be read is
/// kept — a row missing a file it did change is the worse error.
pub fn select_touched(
    entries: &[StatusEntry],
    mtime: impl Fn(&str) -> Option<u64>,
    since: u64,
) -> Vec<String> {
    entries
        .iter()
        .filter(|entry| !entry.deleted)
        .filter(|entry| mtime(&entry.path).is_none_or(|at| at + 1 >= since))
        .map(|entry| entry.path.clone())
        .collect()
}

/// Merge the committed and working-tree lists into one bounded, sorted set.
pub fn merge_touched(mut files: Vec<String>) -> Vec<String> {
    files.retain(|path| !path.is_empty());
    files.sort();
    files.dedup();
    files.truncate(MAX_BLAME_FILES);
    files
}

/// The files a prompt delivered at `since` changed: committed ones (every
/// commit after `commit`, when the repo has moved on) and working-tree ones
/// written after the delivery. Empty when the project has no local repo.
pub fn files_touched(project_id: &str, commit: Option<&str>, since: &str) -> Vec<String> {
    let Some(dir) = local_repo_dir(project_id) else {
        return Vec::new();
    };
    let Some(since) = iso_to_epoch(since) else {
        return Vec::new();
    };
    let mut files = Vec::new();

    if let Some(commit) = commit.filter(|hash| is_commit_hash(hash)) {
        let moved = git_line(&dir, &["rev-parse", "--verify", "--quiet", "HEAD"])
            .is_some_and(|now| now != commit);
        if moved {
            if let Some(out) = git_stdout(&dir, &["diff", "--name-only", "-z", commit, "HEAD", "--"]) {
                files.extend(
                    out.split(|b| *b == 0)
                        .filter(|path| !path.is_empty())
                        .map(|path| String::from_utf8_lossy(path).into_owned()),
                );
            }
        }
    }

    if let Some(out) = git_stdout(&dir, &["status", "--porcelain", "-z", "--untracked-files=all"]) {
        let entries = parse_status_z(&out);
        let mtime = |path: &str| {
            std::fs::metadata(dir.join(path))
                .ok()?
                .modified()
                .ok()?
                .duration_since(UNIX_EPOCH)
                .ok()
                .map(|d| d.as_secs())
        };
        files.extend(select_touched(&entries, mtime, since));
    }

    merge_touched(files)
}

/// `YYYY-MM-DDTHH:MM:SS[.fff][Z|±HH:MM]` to Unix seconds. Both the service's
/// `iso_now` (`+00:00`) and a JavaScript `toISOString()` (`.000Z`) fit; a
/// value without an offset is read as UTC.
pub fn iso_to_epoch(value: &str) -> Option<u64> {
    let bytes = value.as_bytes();
    if bytes.len() < 19 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return None;
    }
    let num = |from: usize, to: usize| value.get(from..to)?.parse::<i64>().ok();
    let (year, month, day) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (hour, minute, second) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    let mut rest = &value[19..];
    if let Some(dot) = rest.strip_prefix('.') {
        let digits = dot.bytes().take_while(u8::is_ascii_digit).count();
        rest = &dot[digits..];
    }
    let offset = match rest {
        "" | "Z" => 0,
        sign if sign.len() == 6 && (sign.starts_with('+') || sign.starts_with('-')) => {
            let hours = sign[1..3].parse::<i64>().ok()?;
            let minutes = sign[4..6].parse::<i64>().ok()?;
            let total = hours * 3600 + minutes * 60;
            if sign.starts_with('-') { -total } else { total }
        }
        _ => return None,
    };
    // Howard Hinnant's days-from-civil.
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = days * 86_400 + hour * 3600 + minute * 60 + second - offset;
    u64::try_from(secs).ok()
}

/// Unix milliseconds as `YYYY-MM-DDTHH:MM:SS.fffZ` — a JavaScript
/// `toISOString()`, the inverse of [`iso_to_epoch`] to the millisecond.
pub fn epoch_ms_to_iso(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let (days, rest) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Howard Hinnant's civil-from-days.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn epoch_ms_formats_as_to_iso_string_and_round_trips() {
        assert_eq!(epoch_ms_to_iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(epoch_ms_to_iso(1_788_350_400_250), "2026-09-02T12:00:00.250Z");
        assert_eq!(epoch_ms_to_iso(951_782_400_000), "2000-02-29T00:00:00.000Z");
        let ms = 1_789_737_331_233;
        assert_eq!(iso_to_epoch(&epoch_ms_to_iso(ms)), Some((ms / 1000) as u64));
    }

    #[test]
    fn iso_parsing_matches_both_writers() {
        assert_eq!(iso_to_epoch("1970-01-01T00:00:00+00:00"), Some(0));
        assert_eq!(iso_to_epoch("2026-09-02T12:00:00+00:00"), Some(1_788_350_400));
        assert_eq!(iso_to_epoch("2026-09-02T12:00:00.250Z"), Some(1_788_350_400));
        assert_eq!(iso_to_epoch("2026-09-02T14:00:00+02:00"), Some(1_788_350_400));
        assert_eq!(iso_to_epoch("2026-09-02T12:00:00"), Some(1_788_350_400));
        assert_eq!(iso_to_epoch("2026-09-02"), None);
        assert_eq!(iso_to_epoch("2026-13-02T12:00:00Z"), None);
        assert_eq!(iso_to_epoch("2026-09-02T12:00:00 UTC"), None);
    }

    #[test]
    fn status_z_skips_rename_sources_and_marks_deletions() {
        let raw = b" M src/a.rs\0R  src/new.rs\0src/old.rs\0?? notes.md\0 D gone.txt\0";
        let entries = parse_status_z(raw);
        assert_eq!(
            entries,
            vec![
                StatusEntry { path: "src/a.rs".into(), deleted: false },
                StatusEntry { path: "src/new.rs".into(), deleted: false },
                StatusEntry { path: "notes.md".into(), deleted: false },
                StatusEntry { path: "gone.txt".into(), deleted: true },
            ]
        );
    }

    #[test]
    fn touched_files_are_the_ones_written_after_the_prompt() {
        let entries = parse_status_z(b" M before.rs\0 M after.rs\0?? unknown.rs\0 D gone.rs\0");
        let mtime = |path: &str| match path {
            "before.rs" => Some(90),
            "after.rs" => Some(120),
            _ => None,
        };
        let touched = select_touched(&entries, mtime, 100);
        // Written after: kept. Unreadable mtime: kept. Deleted: never blamed.
        assert_eq!(touched, vec!["after.rs".to_string(), "unknown.rs".to_string()]);
        // One second of slack covers a filesystem that rounds mtimes down.
        assert_eq!(select_touched(&entries, |_| Some(99), 100), vec!["before.rs", "after.rs", "unknown.rs"]);
    }

    #[test]
    fn merge_sorts_dedupes_and_caps() {
        let files = (0..MAX_BLAME_FILES + 5)
            .map(|i| format!("f{i:04}"))
            .chain(["f0001".to_string(), String::new()])
            .collect();
        let merged = merge_touched(files);
        assert_eq!(merged.len(), MAX_BLAME_FILES);
        assert_eq!(merged[0], "f0000");
        assert_eq!(merged.iter().filter(|f| *f == "f0001").count(), 1);
    }

    #[test]
    fn commit_hashes_are_hex_and_bounded() {
        assert!(is_commit_hash("d5d74e2"));
        assert!(is_commit_hash(&"a".repeat(40)));
        assert!(!is_commit_hash("HEAD"));
        assert!(!is_commit_hash("--output=x"));
        assert!(!is_commit_hash("abc"));
    }
}
