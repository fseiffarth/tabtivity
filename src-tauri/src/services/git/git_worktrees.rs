//! `git worktree list --porcelain`, parsed: the [`Worktree`] rows the Git
//! panel, the lockstep peer and an agent tab's worktree move read. Moved down
//! from `commands::git` (S5), which keeps the worktree commands and
//! re-exports these names.

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
