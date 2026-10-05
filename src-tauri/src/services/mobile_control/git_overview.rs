//! The phone's git overview of one project — `GET /api/v1/projects/{id}/git`:
//! which worktrees exist and which one is the project folder's, the branch it
//! has checked out, the local branches and the remote ones no local branch
//! already tracks. Read-only; the sidecar answers it itself, window open or
//! not, from the same hardened local git reads the desktop's Git panel makes.
//!
//! Nothing here names a path: a worktree crosses as its opaque id (the very
//! id the ＋ sheet's "Agents start in" row mints for it, so the two agree), its
//! leaf name and its branch. Lock and prune reasons and full shas stay home.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;

use super::discovery::key_id;
use crate::commands::git::{GitBranch, Worktree};

/// Worktree rows sent; the rest are counted in `worktrees_total`.
pub const MAX_WORKTREES: usize = 20;
/// Local and remote branch rows sent, each; the rest are counted.
pub const MAX_BRANCHES: usize = 60;
/// Worktrees whose changes are looked at per request, current one first.
pub const MAX_DIRTY_PROBES: usize = 8;
/// The time the per-worktree change probes may take together, checked before
/// each one: a monorepo's `git status` is slow, and the phone is waiting.
pub const PROBE_BUDGET: Duration = Duration::from_secs(3);
/// How long an overview stands: short, so ↻ after a checkout on the desk is
/// near-live, and long enough that a burst of opens costs one probe.
pub const TTL: Duration = Duration::from_secs(5);
/// Every string crosses capped at this many bytes.
const MAX_TEXT: usize = 200;
/// The longest path the desktop's `mobile_opaque_id` mints an id for; a longer
/// worktree crosses with no id rather than one that names nothing there.
const MAX_ID_INPUT: usize = 256;

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct GitOverview {
    pub repo: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head: Option<GitHead>,
    pub worktrees: Vec<WorktreeView>,
    pub worktrees_total: u32,
    pub branches: Vec<BranchView>,
    pub branches_total: u32,
    pub remote_branches: Vec<String>,
    pub remote_total: u32,
}

/// The project folder's checkout: its branch, or the short sha it is detached
/// at, and that branch's upstream as of the last fetch.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct GitHead {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub short: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct WorktreeView {
    /// The ＋ sheet's opaque id for this worktree; "" when none can be minted.
    pub id: String,
    /// The worktree folder's leaf name; "" for the current one, which the
    /// phone labels with the project's own name.
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// The 7-character sha a detached worktree is at.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub short: Option<String>,
    pub main: bool,
    pub current: bool,
    pub locked: bool,
    pub missing: bool,
    /// The phone's `GitDot` word; absent for a clean tree or one not checked.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git: Option<&'static str>,
    /// Whether its changes were looked at (`git` is then meaningful).
    pub checked: bool,
    /// This project's tabs running inside it.
    pub tabs: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct BranchView {
    pub name: String,
    pub current: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// The label of the other worktree that has it checked out.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
}

/// `text`, cut on a char boundary to at most [`MAX_TEXT`] bytes with `…`.
fn cap(text: &str) -> String {
    if text.len() <= MAX_TEXT {
        return text.to_string();
    }
    let mut end = MAX_TEXT - '…'.len_utf8();
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

/// The 7-character abbreviation of a full sha, or none for anything else.
fn short_sha(head: &str) -> Option<String> {
    (head.len() >= 7 && head.bytes().all(|b| b.is_ascii_hexdigit()) && head.bytes().any(|b| b != b'0'))
        .then(|| head[..7].to_string())
}

fn leaf(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.rsplit(['/', '\\']).find(|part| !part.is_empty()).unwrap_or("").to_string())
}

fn count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

/// A pseudo-row of `git branch` (`(HEAD detached at 1a2b3c4)`, `(no branch,
/// rebasing …)`): no legal refname contains whitespace.
fn real_branch(branch: &GitBranch) -> bool {
    !branch.name.is_empty() && !branch.name.chars().any(char::is_whitespace)
}

/// Which of the worktree folders `paths` a tab's folder runs in, by index: the
/// one that is the longest whole-component ancestor of it — so a tab in
/// `<root>/.tabtivity/worktrees/a` is in `a`, not the main checkout, and `/p/a`
/// never claims `/p/ab`. Both sides are canonicalized first (a symlinked temp
/// dir, macOS's `/var`); when that matches nothing the raw spellings are
/// compared, for a folder that no longer resolves.
pub fn worktree_matcher<'a>(paths: impl IntoIterator<Item = &'a str>) -> impl Fn(&str) -> Option<usize> {
    fn canonical(path: &str) -> PathBuf {
        std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path))
    }
    fn best(roots: &[PathBuf], cwd: &Path) -> Option<usize> {
        roots
            .iter()
            .enumerate()
            .filter(|(_, root)| !root.as_os_str().is_empty() && cwd.starts_with(root))
            .max_by_key(|(_, root)| root.components().count())
            .map(|(at, _)| at)
    }
    let raw: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    let resolved: Vec<PathBuf> = raw.iter().map(|path| canonical(&path.to_string_lossy())).collect();
    move |cwd: &str| {
        if cwd.is_empty() {
            return None;
        }
        best(&resolved, &canonical(cwd)).or_else(|| best(&raw, Path::new(cwd)))
    }
}

/// How many of `tab_cwds` run in each worktree (`worktree_matcher`).
pub fn tab_counts(worktrees: &[Worktree], tab_cwds: &[String]) -> Vec<u32> {
    let of = worktree_matcher(worktrees.iter().map(|wt| wt.path.as_str()));
    let mut counts = vec![0u32; worktrees.len()];
    for cwd in tab_cwds {
        if let Some(at) = of(cwd) {
            counts[at] = counts[at].saturating_add(1);
        }
    }
    counts
}

/// The linked worktree an agent tab runs in, as its card on the phone names
/// it: the folder's leaf name (the Git sheet's label) and its branch. Never a
/// path. The project folder's own checkout has none — it is the default.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TabWorktree {
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}

/// One worktree of a project, kept between the project screen's polls: its
/// folder (host-side only) and what a tab in it wears — `None` for the
/// project folder's own checkout.
#[derive(Debug, Clone)]
pub struct WorktreeSpot {
    pub path: String,
    pub tab: Option<TabWorktree>,
}

/// The project's worktrees as tab spots: one hardened `git worktree list`,
/// blocking, so the host runs it off the async thread and caches it
/// ([`SpotCache`]).
pub fn worktree_spots(root: &Path) -> Vec<WorktreeSpot> {
    let dir = root.to_string_lossy().into_owned();
    crate::commands::git::git_worktree_list_blocking(dir, Some("mirror".into()), None)
        .unwrap_or_default()
        .into_iter()
        .filter(|wt| !wt.path.is_empty() && !wt.is_bare)
        .map(|wt| WorktreeSpot {
            tab: (!wt.is_current).then(|| TabWorktree {
                label: cap(&leaf(&wt.path)),
                branch: (!wt.branch.is_empty()).then(|| cap(&wt.branch)),
            }),
            path: wt.path,
        })
        .collect()
}

/// The worktree each of `cwds` runs in, as its card shows it; `None` for the
/// project folder's checkout or a folder in no worktree of the project.
pub fn tab_worktrees(spots: &[WorktreeSpot], cwds: &[&str]) -> Vec<Option<TabWorktree>> {
    let of = worktree_matcher(spots.iter().map(|spot| spot.path.as_str()));
    cwds.iter().map(|cwd| of(cwd).and_then(|at| spots[at].tab.clone())).collect()
}

/// How long a project's worktree list stands for the tab cards: the project
/// screen polls every 1.5 s, and a worktree is made or removed rarely.
pub const SPOT_TTL: Duration = Duration::from_secs(30);

/// The host's worktree spots, per raw project id, each standing for [`SPOT_TTL`].
#[derive(Debug, Default)]
pub struct SpotCache {
    entries: HashMap<String, (Instant, Vec<WorktreeSpot>)>,
}

impl SpotCache {
    pub fn get(&self, raw_id: &str, now: Instant) -> Option<Vec<WorktreeSpot>> {
        self.entries
            .get(raw_id)
            .filter(|(at, _)| now.duration_since(*at) < SPOT_TTL)
            .map(|(_, spots)| spots.clone())
    }

    pub fn set(&mut self, raw_id: &str, spots: Vec<WorktreeSpot>, now: Instant) {
        self.entries.retain(|_, (at, _)| now.duration_since(*at) < SPOT_TTL);
        self.entries.insert(raw_id.to_string(), (now, spots));
    }
}

/// The overview out of what git listed: ordering, caps, labels, ids and tab
/// counts. `dots` holds each worktree whose changes were looked at, by its
/// porcelain path; one absent from it is sent `checked: false`.
pub fn assemble(
    worktrees: &[Worktree],
    branches: &[GitBranch],
    dots: &HashMap<String, Option<&'static str>>,
    tab_cwds: &[String],
    host_key: &[u8],
) -> GitOverview {
    if worktrees.is_empty() {
        return GitOverview::default();
    }
    let tabs = tab_counts(worktrees, tab_cwds);
    let local: Vec<&GitBranch> = branches.iter().filter(|b| !b.is_remote && real_branch(b)).collect();
    let current = worktrees.iter().find(|wt| wt.is_current);
    let label_of = |wt: &Worktree| if wt.is_current { String::new() } else { cap(&leaf(&wt.path)) };

    let head = match current {
        Some(wt) => {
            let row = local.iter().find(|b| !wt.branch.is_empty() && b.name == wt.branch);
            GitHead {
                branch: (!wt.branch.is_empty()).then(|| cap(&wt.branch)),
                short: if wt.branch.is_empty() { short_sha(&wt.head) } else { None },
                upstream: row.filter(|b| !b.upstream.is_empty()).map(|b| cap(&b.upstream)),
                ahead: row.map_or(0, |b| count(b.ahead)),
                behind: row.map_or(0, |b| count(b.behind)),
            }
        }
        None => match local.iter().find(|b| b.is_current) {
            Some(b) => GitHead {
                branch: Some(cap(&b.name)),
                short: None,
                upstream: (!b.upstream.is_empty()).then(|| cap(&b.upstream)),
                ahead: count(b.ahead),
                behind: count(b.behind),
            },
            None => GitHead::default(),
        },
    };

    // The current worktree first, then git's own order (the main one leads).
    let mut order: Vec<usize> = (0..worktrees.len()).collect();
    order.sort_by_key(|&at| !worktrees[at].is_current);
    let worktree_rows = order
        .iter()
        .take(MAX_WORKTREES)
        .map(|&at| {
            let wt = &worktrees[at];
            WorktreeView {
                id: if wt.path.is_empty() || wt.path.len() > MAX_ID_INPUT {
                    String::new()
                } else {
                    key_id(host_key, "worktree", &[&wt.path])
                },
                label: label_of(wt),
                branch: (!wt.branch.is_empty()).then(|| cap(&wt.branch)),
                short: if wt.branch.is_empty() && !wt.is_bare { short_sha(&wt.head) } else { None },
                main: wt.is_main,
                current: wt.is_current,
                locked: wt.is_locked,
                missing: wt.is_prunable,
                git: dots.get(&wt.path).copied().flatten(),
                checked: dots.contains_key(&wt.path),
                tabs: tabs[at],
            }
        })
        .collect();

    // Which other worktree holds a branch: `in <label>` on its row.
    let held_by = |name: &str| {
        worktrees
            .iter()
            .find(|wt| !wt.is_current && wt.branch == name)
            .map(label_of)
    };
    let mut local_order: Vec<(u8, &GitBranch)> = local
        .iter()
        .map(|b| {
            let rank = if b.is_current {
                0
            } else if worktrees.iter().any(|wt| wt.branch == b.name) {
                1
            } else {
                2
            };
            (rank, *b)
        })
        .collect();
    local_order.sort_by_key(|(rank, _)| *rank);
    let branch_rows = local_order
        .iter()
        .take(MAX_BRANCHES)
        .map(|(_, b)| BranchView {
            name: cap(&b.name),
            current: b.is_current,
            upstream: (!b.upstream.is_empty()).then(|| cap(&b.upstream)),
            ahead: count(b.ahead),
            behind: count(b.behind),
            worktree: if b.is_current { None } else { held_by(&b.name) },
        })
        .collect();

    // A remote branch a local one already stands for (same short name, or it
    // is that branch's upstream) is not listed again.
    let remote: Vec<&GitBranch> = branches
        .iter()
        .filter(|b| b.is_remote && real_branch(b))
        .filter(|r| {
            let short = r.name.split_once('/').map_or(r.name.as_str(), |(_, rest)| rest);
            !local.iter().any(|b| b.upstream == r.name || b.name == short)
        })
        .collect();

    GitOverview {
        repo: true,
        head: Some(head),
        worktrees: worktree_rows,
        worktrees_total: count(worktrees.len()),
        branches: branch_rows,
        branches_total: count(local.len()),
        remote_branches: remote.iter().take(MAX_BRANCHES).map(|b| cap(&b.name)).collect(),
        remote_total: count(remote.len()),
    }
}

/// Whether a linked worktree's changes may be looked at. Its path comes from
/// `.git/worktrees/*/gitdir` — project-folder content, so attacker-controlled
/// — and may name a remote project's registered directory, which would turn a
/// status read into an SSH spawn; that, a vanished checkout and a bare entry
/// are skipped.
fn probeable(wt: &Worktree) -> bool {
    !wt.is_prunable
        && !wt.is_bare
        && Path::new(&wt.path).is_dir()
        && crate::services::remote::remote_target_for_dir(&wt.path).is_none()
}

/// A linked worktree's dot: one hardened `git status` for untracked, unstaged
/// and staged changes, then its branch's own `ahead` for unpushed — not the
/// project dot's full ladder, which costs more spawns per row. `None` when
/// git could not answer.
fn linked_dot(wt: &Worktree, branches: &[GitBranch]) -> Option<Option<&'static str>> {
    let out = crate::services::git_bounded::output(crate::commands::git::hardened_git_command_in(
        &wt.path,
        &["status", "--porcelain"],
    ))
    .ok()?;
    if !out.status.success() {
        return None;
    }
    let (mut changed, mut staged) = (false, false);
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let bytes = line.as_bytes();
        if bytes.len() < 2 {
            continue;
        }
        if bytes[0] == b'?' || bytes[1] != b' ' {
            changed = true;
        }
        if bytes[0] != b' ' && bytes[0] != b'?' {
            staged = true;
        }
    }
    if changed {
        return Some(Some("dirty"));
    }
    if staged {
        return Some(Some("staged"));
    }
    let ahead = !wt.branch.is_empty()
        && branches.iter().any(|b| !b.is_remote && b.name == wt.branch && b.ahead > 0);
    Some(ahead.then_some("unpushed"))
}

/// The overview of the project at `root`. Blocking — a worktree list, a branch
/// list and up to [`MAX_DIRTY_PROBES`] change probes within [`PROBE_BUDGET`],
/// every spawn hardened (hooks off, optional locks off, repo config
/// sanitized) — so the host runs it off the async thread and caches it.
pub fn probe(root: &Path, host_key: &[u8], tab_cwds: &[String]) -> GitOverview {
    let dir = root.to_string_lossy().into_owned();
    // `mirror`, as the desktop bridge lists them: a local project ignores the
    // side, and it can never pick an SSH host.
    let worktrees = crate::commands::git::git_worktree_list_blocking(dir.clone(), Some("mirror".into()), None)
        .unwrap_or_default();
    if worktrees.is_empty() {
        return GitOverview::default();
    }
    let branches = crate::commands::git::git_branches_blocking(dir).unwrap_or_default();
    let tabs = tab_counts(&worktrees, tab_cwds);
    let mut order: Vec<usize> = (0..worktrees.len()).collect();
    order.sort_by_key(|&at| (!worktrees[at].is_current, std::cmp::Reverse(tabs[at])));
    let started = Instant::now();
    let mut dots = HashMap::new();
    for at in order {
        if dots.len() >= MAX_DIRTY_PROBES || started.elapsed() >= PROBE_BUDGET {
            break;
        }
        let wt = &worktrees[at];
        if wt.is_current {
            // The project's own dot, the same ladder as Home's.
            dots.insert(wt.path.clone(), super::headless::git_dot_for(root));
        } else if probeable(wt) {
            if let Some(dot) = linked_dot(wt, &branches) {
                dots.insert(wt.path.clone(), dot);
            }
        }
    }
    assemble(&worktrees, &branches, &dots, tab_cwds, host_key)
}

/// The host's overviews, per raw project id, each standing for [`TTL`].
#[derive(Debug, Default)]
pub struct Cache {
    entries: HashMap<String, (Instant, GitOverview)>,
}

impl Cache {
    pub fn get(&self, raw_id: &str, now: Instant) -> Option<GitOverview> {
        self.entries
            .get(raw_id)
            .filter(|(at, _)| now.duration_since(*at) < TTL)
            .map(|(_, overview)| overview.clone())
    }

    pub fn set(&mut self, raw_id: &str, overview: GitOverview, now: Instant) {
        self.entries.retain(|_, (at, _)| now.duration_since(*at) < TTL);
        self.entries.insert(raw_id.to_string(), (now, overview));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: [u8; 32] = [7; 32];

    fn wt(path: &str, branch: &str, head: &str) -> Worktree {
        Worktree {
            path: path.into(),
            branch: branch.into(),
            head: head.into(),
            is_main: false,
            is_locked: false,
            lock_reason: String::new(),
            is_prunable: false,
            prunable_reason: String::new(),
            is_bare: false,
            is_current: false,
        }
    }

    fn branch(name: &str, current: bool, upstream: &str, ahead: usize, behind: usize) -> GitBranch {
        GitBranch {
            name: name.into(),
            is_current: current,
            is_remote: false,
            upstream: upstream.into(),
            ahead,
            behind,
        }
    }

    fn remote(name: &str) -> GitBranch {
        GitBranch { is_remote: true, ..branch(name, false, "", 0, 0) }
    }

    const SHA: &str = "1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0d";

    #[test]
    fn the_current_worktree_and_branch_lead_and_names_map_to_labels() {
        let root = "/work/proj";
        let linked = format!("/work/proj/{}/feature", crate::brand::WORKTREES_DIR);
        let mut main = wt(root, "main", SHA);
        main.is_main = true;
        let mut current = wt(&linked, "feat", SHA);
        current.is_current = true;
        let mut gone = wt("/elsewhere/gone", "", SHA);
        gone.is_prunable = true;
        gone.lock_reason = "on /secret/drive".into();
        let branches = vec![
            branch("alpha", false, "", 0, 0),
            branch("feat", true, "origin/feat", 2, 1),
            branch("main", false, "origin/main", 0, 3),
            branch("(HEAD detached at 1a2b3c4)", false, "", 0, 0),
            remote("origin/feat"),
            remote("origin/main"),
            remote("origin/other"),
        ];
        let overview = assemble(&[main, current, gone], &branches, &HashMap::new(), &[], &KEY);
        assert!(overview.repo);
        let head = overview.head.clone().expect("head");
        assert_eq!(head.branch.as_deref(), Some("feat"));
        assert_eq!(head.upstream.as_deref(), Some("origin/feat"));
        assert_eq!((head.ahead, head.behind), (2, 1));
        assert_eq!(head.short, None);

        let labels: Vec<&str> = overview.worktrees.iter().map(|w| w.label.as_str()).collect();
        assert_eq!(labels, ["", "proj", "gone"], "current first, it alone unlabelled");
        assert!(overview.worktrees[0].current && overview.worktrees[1].main);
        assert!(overview.worktrees[2].missing && !overview.worktrees[2].checked);
        assert_eq!(overview.worktrees[2].short.as_deref(), Some("1a2b3c4"), "detached → short sha");
        assert_eq!(overview.worktrees[2].branch, None);

        let names: Vec<&str> = overview.branches.iter().map(|b| b.name.as_str()).collect();
        assert_eq!(names, ["feat", "main", "alpha"], "current, in a worktree, then git's order");
        assert_eq!(overview.branches_total, 3, "the detached pseudo-row is dropped");
        assert_eq!(overview.branches[1].worktree.as_deref(), Some("proj"));
        assert_eq!(overview.branches[0].worktree, None);
        assert_eq!(overview.remote_branches, ["origin/other"]);
        assert_eq!(overview.remote_total, 1);
    }

    #[test]
    fn a_detached_project_folder_reads_as_its_short_sha() {
        let mut current = wt("/p", "", SHA);
        current.is_current = true;
        current.is_main = true;
        let overview = assemble(&[current], &[branch("main", false, "", 0, 0)], &HashMap::new(), &[], &KEY);
        let head = overview.head.expect("head");
        assert_eq!(head.branch, None);
        assert_eq!(head.short.as_deref(), Some("1a2b3c4"));
        assert_eq!(overview.branches[0].name, "main");
    }

    #[test]
    fn caps_keep_totals_and_long_text_is_cut_on_a_char_boundary() {
        let mut current = wt("/p", "main", SHA);
        current.is_current = true;
        let mut worktrees = vec![current];
        worktrees.extend((0..30).map(|i| wt(&format!("/w/{i}"), &format!("b{i}"), SHA)));
        let mut branches: Vec<GitBranch> = (0..90).map(|i| branch(&format!("b{i:03}"), false, "", 0, 0)).collect();
        branches.extend((0..70).map(|i| remote(&format!("origin/r{i}"))));
        let overview = assemble(&worktrees, &branches, &HashMap::new(), &[], &KEY);
        assert_eq!((overview.worktrees.len(), overview.worktrees_total), (MAX_WORKTREES, 31));
        assert_eq!((overview.branches.len(), overview.branches_total), (MAX_BRANCHES, 90));
        assert_eq!((overview.remote_branches.len(), overview.remote_total), (MAX_BRANCHES, 70));

        let long = "é".repeat(150); // 300 bytes, two per char
        let cut = cap(&long);
        assert!(cut.len() <= MAX_TEXT && cut.ends_with('…'), "{}", cut.len());
        assert_eq!(cap("short"), "short");
    }

    #[test]
    fn a_tab_counts_for_the_deepest_worktree_by_whole_components() {
        let root = "/work/proj";
        let linked = format!("{root}/{}/a", crate::brand::WORKTREES_DIR);
        let mut main = wt(root, "main", SHA);
        main.is_current = true;
        let worktrees = [main, wt(&linked, "a", SHA), wt("/work/pro", "x", SHA)];
        let cwds = vec![
            format!("{linked}/src"),
            linked.clone(),
            format!("{root}/docs"),
            "/work/projector".to_string(),
            "/elsewhere".to_string(),
            String::new(),
        ];
        assert_eq!(tab_counts(&worktrees, &cwds), [1, 2, 0]);
    }

    #[test]
    fn a_tab_card_names_its_linked_worktree_and_never_the_project_folder() {
        let root = "/work/proj";
        let linked = format!("{root}/{}/fix-login", crate::brand::WORKTREES_DIR);
        let spot = |path: &str, tab: Option<TabWorktree>| WorktreeSpot { path: path.into(), tab };
        let fix = TabWorktree { label: "fix-login".into(), branch: Some("fix/login".into()) };
        let spots = [spot(root, None), spot(&linked, Some(fix.clone())), spot("/work/detached", Some(TabWorktree { label: "detached".into(), branch: None }))];
        let inside = format!("{linked}/src");
        let cwds = [inside.as_str(), root, "/work/proj/docs", "/elsewhere", ""];
        assert_eq!(tab_worktrees(&spots, &cwds), [Some(fix), None, None, None, None]);
    }

    #[test]
    fn ids_match_the_desktops_and_nothing_crosses_as_a_path() {
        let state = tempfile::tempdir().expect("state dir");
        std::fs::create_dir_all(state.path().join("mobile-control")).expect("control dir");
        std::fs::write(state.path().join("mobile-control/host.key"), KEY).expect("host key");
        let root = "/home/someone/secret-root";
        let linked = format!("{root}/{}/topic", crate::brand::WORKTREES_DIR);
        let mut main = wt(root, "main", SHA);
        main.is_current = true;
        main.is_main = true;
        let mut locked = wt(&linked, "topic", SHA);
        locked.is_locked = true;
        locked.lock_reason = format!("kept at {root}");
        let long = format!("/{}", "x".repeat(MAX_ID_INPUT + 1));
        let overview = assemble(
            &[main, locked, wt(&long, "", SHA)],
            &[branch("main", true, "", 0, 0)],
            &HashMap::new(),
            &[format!("{root}/sub")],
            &KEY,
        );
        let desktop = crate::services::mobile_control::discovery::opaque_control_id(state.path(), "worktree", &linked)
            .expect("desktop id");
        assert_eq!(overview.worktrees[1].id, desktop, "the ＋ sheet names this worktree the same");
        assert!(overview.worktrees[1].locked);
        assert_eq!(overview.worktrees[2].id, "", "too long for the desktop's id");
        let body = serde_json::to_string(&overview).expect("json");
        assert!(!body.contains(root) && !body.contains("secret-root") && !body.contains(SHA), "{body}");
    }

    #[test]
    fn the_cache_answers_inside_its_ttl_only() {
        let mut cache = Cache::default();
        let now = Instant::now();
        let overview = GitOverview { repo: true, ..GitOverview::default() };
        cache.set("p1", overview.clone(), now);
        assert_eq!(cache.get("p1", now + Duration::from_secs(1)), Some(overview));
        assert_eq!(cache.get("p1", now + TTL), None);
        assert_eq!(cache.get("p2", now), None);
    }

    fn git(dir: &Path, args: &[&str]) {
        let out = crate::paths::command_no_window("git")
            .args(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main"])
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git runs");
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    #[test]
    fn probe_reads_worktrees_branches_and_one_dirty_row() {
        if !crate::commands::git::git_available() {
            return;
        }
        let tmp = tempfile::tempdir().expect("tmp");
        // Through a symlink, as macOS's `/var` → `/private/var` would be.
        let real = tmp.path().join("real");
        std::fs::create_dir_all(&real).expect("real dir");
        let link = tmp.path().join("link");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real, &link).expect("symlink");
        #[cfg(not(unix))]
        let link = real.clone();
        let root = real.join("proj");
        std::fs::create_dir_all(&root).expect("root");
        git(&root, &["init", "-q"]);
        // As the desktop keeps its own folder (worktrees included) out of git.
        std::fs::write(root.join(".git/info/exclude"), crate::brand::PROJECT_DIR_EXCLUDE_RULE).expect("exclude");
        std::fs::write(root.join("a.txt"), "a").expect("file");
        git(&root, &["add", "a.txt"]);
        git(&root, &["commit", "-q", "-m", "one"]);
        git(&root, &["branch", "side"]);
        let worktrees = root.join(crate::brand::WORKTREES_DIR);
        std::fs::create_dir_all(&worktrees).expect("worktrees dir");
        let topic = worktrees.join("topic");
        let loose = worktrees.join("loose");
        git(&root, &["worktree", "add", "-q", "-b", "topic", &topic.to_string_lossy()]);
        git(&root, &["worktree", "add", "-q", "--detach", &loose.to_string_lossy()]);
        std::fs::write(topic.join("new.txt"), "dirty").expect("dirty file");

        let via_link = link.join("proj").join(crate::brand::WORKTREES_DIR).join("topic").join("deep");
        std::fs::create_dir_all(&via_link).expect("tab dir");
        let cwds = vec![via_link.to_string_lossy().into_owned()];
        let overview = probe(&root, &KEY, &cwds);

        assert!(overview.repo);
        assert_eq!(overview.head.as_ref().and_then(|h| h.branch.as_deref()), Some("main"));
        assert_eq!(overview.worktrees.len(), 3);
        assert!(overview.worktrees[0].current && overview.worktrees[0].checked);
        let row = |label: &str| overview.worktrees.iter().find(|w| w.label == label).expect(label);
        assert_eq!(row("topic").git, Some("dirty"));
        assert!(row("topic").checked);
        assert_eq!(row("topic").tabs, 1, "the symlinked tab cwd counts here");
        assert_eq!(row("loose").git, None);
        assert!(row("loose").short.is_some() && row("loose").branch.is_none());
        assert_eq!(overview.worktrees[0].git, None, "the project folder is clean");
        let names: Vec<&str> = overview.branches.iter().map(|b| b.name.as_str()).collect();
        assert_eq!(names, ["main", "topic", "side"]);
        assert_eq!(overview.branches[1].worktree.as_deref(), Some("topic"));

        let plain = tmp.path().join("plain");
        std::fs::create_dir_all(&plain).expect("plain dir");
        assert_eq!(probe(&plain, &KEY, &[]), GitOverview::default());
    }
}
