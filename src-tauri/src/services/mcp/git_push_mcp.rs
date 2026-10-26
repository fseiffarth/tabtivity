//! Agent-requested pushes: the `/mcp/git` lane (`docs/context/git_push_mcp.md`,
//! plan in `docs/git_push_mcp_plan.md`). AppHandle-free.
//!
//! A fenced agent tab can commit but cannot push: the project's access token
//! lives in the keyring, and nothing readable from inside the fence may hold
//! it. So the agent *asks*, and Tabtivity pushes from outside the fence under
//! rules read from the trusted `projects.json` entry — never from anything in
//! the project folder. Two phases keep project code and the token apart:
//!
//! 1. **Preflight, fenced, no token.** The repo's `pre-push` hook runs inside
//!    the tab's own fence with git's normal arguments and stdin line, plus
//!    `TABTIVITY_PUSH_PREFLIGHT=1`. Its commits (a version bump) are picked up.
//! 2. **Transport, host, hooks off.** One explicit refspec to one pinned URL
//!    through `commands::git::push_transport`, the token offered only to the
//!    project's token origins. No repo hook runs while the token is in `env`.
//!
//! Every failure the agent can act on is a normal tool *result* with a fixed
//! `category`, a plain `message`, capped and redacted `output`, and the repo
//! `state`. Proposals live in memory beside the tokens that made them: neither
//! survives a restart.
use std::collections::HashMap;
use app_core::sync::LockExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::services::root_mcp::{Caller, Session};
use crate::services::git_hardened::{hardened_git_command_in, push_transport_command, resolve_pre_push_hook, scoped_token_config};

pub const SERVER_NAME: &str = crate::brand::MCP_GIT_SERVER;
/// Emitted whenever a proposal is created or changes state.
pub const CHANGED_EVENT: &str = "git-push-mcp-changed";
pub const CONTRACT: &str = concat!("Pushes the branch checked out in this tab's project, fast-forward only, to its existing upstream branch — never a tag, a force-push, a delete, a new remote branch or the remote's default branch. ", crate::app_name!(), " pushes from outside your sandbox with the user's stored token; you never see it. The repo's pre-push hook runs first, inside your sandbox and without any token (", crate::app_upper!(), "_PUSH_PREFLIGHT=1); other hooks do not run. Depending on the project's level the push is applied at once or staged for the user's approval — then poll git_push_status for the outcome. A repository made or swapped in after this tab started is never pushed (repo_changed: ask the user to restart the tab). Every refusal is a normal result with a fixed `category` and a `message` saying what to do next. Budget: six pushes per hour and two pending proposals per tab.");
/// What every CI tool's description says about which repo it reads (gap 19).
const CI_REPO_RULE: &str = "Only for the repository the user confirmed for this project's pushes or allowed on a card; any other answers ci_repo_unconfirmed and puts an \"Allow CI\" card in front of the user — ask again once they allowed it.";
/// The server's `instructions`: the push contract plus the release and CI
/// tools that share the lane.
pub const INSTRUCTIONS: &str = concat!("Pushes, release tags and CI for the project this tab works in, done by ", crate::app_name!(), " outside your sandbox with the user's stored token (you never see it). git_push pushes the checked-out branch fast-forward to its existing upstream (never a tag, force-push, delete, new remote branch or the remote's default branch); the repo's pre-push hook runs first inside your sandbox without a token. git_release proposes an annotated release tag on the checked-out branch's tip once that tip is on the remote; it always waits for the user to press Release on the card. Staged requests: poll git_push_status for the outcome. ci_runs, ci_run and ci_security_alerts read GitHub Actions runs, failed-job logs and annotations, and open code-scanning alerts of this repo — read-only, sixty reads per tab per hour, and only for the repo the user confirmed for pushes or allowed on a card (ci_repo_unconfirmed otherwise: a card is waiting, ask again once the user allowed it). A repository created or swapped after this tab started is never used (repo_changed: ask the user to restart the tab). Every refusal is a normal result with a fixed `category` and a `message` saying what to do next. Budget: six push or release requests per hour and two pending per tab.");

/// How long the whole request may block the tool call before it answers
/// `running` and lets the agent poll — inside the listener's 30 s socket life.
const INLINE_WAIT: Duration = Duration::from_secs(18);
const PREFLIGHT_TIMEOUT: Duration = Duration::from_secs(300);
pub(crate) const REMOTE_TIMEOUT: Duration = Duration::from_secs(120);
pub(crate) const TRANSPORT_TIMEOUT: Duration = Duration::from_secs(600);
/// stdout kept from a lane process (`ls-remote`, the pre-push hook, the push);
/// past it `ls-remote` and the push are stopped, the hook's is drained.
pub(crate) const LANE_OUTPUT_CAP: u64 = 4 * 1024 * 1024;
/// Unapproved proposals expire after a day; records are kept as long.
const RETENTION: Duration = Duration::from_secs(24 * 3600);
const OUTPUT_CAP: usize = 8 * 1024;
const NOTE_MAX: usize = 200;
const PENDING_LIMIT: usize = 2;

// ── Policy ──────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Level { Off, Propose, Apply }

/// The project's `git_push_mcp` block in `projects.json`. Absent means off;
/// an existing file without it round-trips unchanged.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ProjectPolicy {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level: Option<Level>,
    /// Branch names never pushed, beside the remote's default branch.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub protected: Vec<String>,
    /// The upstream URL the user confirmed. A different URL asks again.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirmed_url: Option<String>,
}
impl ProjectPolicy {
    /// Absent means Propose: every push or release waits for the user's click
    /// on the card, so the lane is useful without setup and never acts alone.
    pub fn level(&self) -> Level { self.level.unwrap_or(Level::Propose) }
}

/// The global switch (`Settings::git_push_mcp`, absent = on: a project's
/// default level only proposes). A missing settings file is a fresh install
/// and answers on; an unreadable one answers off, so spawn and request agree.
pub fn enabled() -> bool { enabled_in(&crate::storage::settings_path()) }
pub fn enabled_in(settings: &Path) -> bool {
    if !settings.exists() { return true; }
    crate::storage::read_json::<crate::schema::Settings>(settings).is_ok_and(|s| s.git_push_mcp != Some(false))
}

pub fn policy(project: &str) -> Result<ProjectPolicy, String> {
    policy_at(&crate::storage::projects_path(), project)
}
fn policy_at(projects: &Path, project: &str) -> Result<ProjectPolicy, String> {
    let list: crate::schema::projects::ProjectsList = crate::storage::read_json(projects).map_err(|_| "project policy unavailable")?;
    let entry = list.iter().find(|p| p.id == project).ok_or("project unavailable")?;
    match entry.extra.get("git_push_mcp") {
        None => Ok(ProjectPolicy::default()),
        Some(value) => serde_json::from_value(value.clone()).map_err(|_| "invalid push policy".into()),
    }
}

/// Patch the project's policy block in the trusted list (never the in-folder
/// `project.json`). `None` values leave a field as it is.
pub fn set_policy(project: &str, level: Option<Level>, protected: Option<Vec<String>>, confirmed_url: Option<String>) -> Result<ProjectPolicy, String> {
    if let Some(list) = &protected {
        for name in list { validate_branch(name)?; }
    }
    crate::services::project_registry::patch_project_entry(project, |entry| {
        let mut policy: ProjectPolicy = match entry.extra.get("git_push_mcp") {
            None => ProjectPolicy::default(),
            Some(value) => serde_json::from_value(value.clone()).map_err(|_| "invalid push policy")?,
        };
        if let Some(level) = level { policy.level = Some(level); }
        if let Some(protected) = protected { policy.protected = protected; }
        if let Some(url) = confirmed_url { policy.confirmed_url = Some(url); }
        entry.extra.insert("git_push_mcp".into(), serde_json::to_value(&policy).map_err(|e| e.to_string())?);
        Ok(policy)
    })
}

// ── Which repo CI may be read for (gap 19) ──────────────────────────────────

/// The `projects.json` entry key listing the repos the user allowed on an
/// "Allow CI" card: lowercase `owner/repo` strings. Kept beside the
/// `git_push_mcp` block, not in it: [`ProjectPolicy`] is `deny_unknown_fields`,
/// so an older build would read a new field there as an invalid policy and
/// lose the whole lane.
const CI_REPOS_KEY: &str = "git_ci_repos";

/// Lowercase `owner/repo` of a github.com URL: what CI confirmations compare.
pub(crate) fn ci_repo_key(url: &str) -> Option<String> {
    crate::services::git_ci::github_repo(url).map(|(owner, repo)| format!("{owner}/{repo}").to_ascii_lowercase())
}

/// The repos allowed on a card. Missing or malformed reads as none.
fn ci_repos_of(entry: &crate::schema::projects::ProjectEntry) -> Vec<String> {
    entry.extra.get(CI_REPOS_KEY).and_then(Value::as_array).into_iter().flatten()
        .filter_map(Value::as_str).filter(|r| ci_repo_key(&format!("https://github.com/{r}")).as_deref() == Some(*r))
        .map(str::to_string).collect()
}
pub fn ci_repos(project: &str) -> Vec<String> {
    let projects = crate::storage::state_dir().join("projects.json");
    crate::storage::read_json::<crate::schema::projects::ProjectsList>(&projects).ok()
        .and_then(|list| list.iter().find(|p| p.id == project).map(ci_repos_of)).unwrap_or_default()
}

/// Whether CI may be read for the repo `url` names: the repo of the push URL
/// the user confirmed, or one they allowed on a card. Compared as lowercase
/// `owner/repo` (GitHub's own names are case-insensitive).
pub(crate) fn ci_repo_allowed(policy: &ProjectPolicy, listed: &[String], url: &str) -> bool {
    let Some(key) = ci_repo_key(url) else { return false };
    policy.confirmed_url.as_deref().and_then(ci_repo_key).as_deref() == Some(key.as_str()) || listed.contains(&key)
}

/// Add `repo` (a [`ci_repo_key`]) to the entry's allowed list, once.
fn add_ci_repo(entry: &mut crate::schema::projects::ProjectEntry, repo: &str) -> Result<(), String> {
    if ci_repo_key(&format!("https://github.com/{repo}")).as_deref() != Some(repo) { return Err(format!("'{repo}' is not a GitHub owner/repo")); }
    let mut list = ci_repos_of(entry);
    if !list.iter().any(|r| r == repo) { list.push(repo.to_string()); }
    entry.extra.insert(CI_REPOS_KEY.into(), json!(list));
    Ok(())
}
fn allow_ci_repo(project: &str, repo: &str) -> Result<(), String> {
    crate::services::project_registry::patch_project_entry(project, |entry| add_ci_repo(entry, repo))
}

/// Strip what the user confirmed on this machine from a `projects.json`
/// entry's extras: the confirmed push URL and the repos allowed for CI. A
/// project bundle carries the entry and is untrusted input
/// (`commands::project_transfer`), so a bundle naming the user's private repo
/// must neither open its CI to the project's agents nor skip the first push's
/// URL check without a click here (gap 19). The level and the protected
/// branches travel.
pub(crate) fn drop_confirmations(extra: &mut HashMap<String, Value>) {
    extra.remove(CI_REPOS_KEY);
    if let Some(block) = extra.get_mut("git_push_mcp").and_then(Value::as_object_mut) {
        block.remove("confirmed_url");
    }
}

// ── Categories and results ──────────────────────────────────────────────────

/// The fixed enum the agent branches on. Also the only thing about a failure
/// the audit ring keeps.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Category {
    LevelOff, BranchProtected, NotCheckedOut, NoUpstream, RemoteBranchMissing, Diverged, NothingToPush,
    PreflightFailed, PreflightTimeout, UrlUnconfirmed, UrlRewritten, StaleApproval, Dismissed, Expired,
    RateLimited, PendingLimit, AuthFailed, Network, RemoteRejected, TransportFailed, FenceUnavailable,
    NotLocal, Busy, NotFound, InvalidArguments, NotPushed, TagExists, NotGithub, NotAvailable,
    /// A release whose commit's GitHub Actions runs are still going, or did
    /// not pass (`git_ci::tip_ci`): a tag goes out only after green CI.
    CiPending, CiFailed,
    /// The tab was started by the Mobile host with no window open, whose lane
    /// never reads the stored token (`docs/headless_mcp_plan.md`).
    WindowRequired,
    /// A CI read (or a release's CI gate) for a repo the user has neither
    /// confirmed for pushes nor allowed on a card (gap 19).
    CiRepoUnconfirmed,
    /// The git dir the tab would push or read CI from is not the one that
    /// was there when the tab started — or there was none (gap 19).
    RepoChanged,
}
impl Category {
    pub fn as_str(self) -> &'static str {
        match self {
            Category::LevelOff => "level_off", Category::BranchProtected => "branch_protected",
            Category::NotCheckedOut => "not_checked_out", Category::NoUpstream => "no_upstream",
            Category::RemoteBranchMissing => "remote_branch_missing", Category::Diverged => "diverged",
            Category::NothingToPush => "nothing_to_push", Category::PreflightFailed => "preflight_failed",
            Category::PreflightTimeout => "preflight_timeout", Category::UrlUnconfirmed => "url_unconfirmed",
            Category::UrlRewritten => "url_rewritten", Category::StaleApproval => "stale_approval",
            Category::Dismissed => "dismissed", Category::Expired => "expired", Category::RateLimited => "rate_limited",
            Category::PendingLimit => "pending_limit", Category::AuthFailed => "auth_failed", Category::Network => "network",
            Category::RemoteRejected => "remote_rejected", Category::TransportFailed => "transport_failed",
            Category::FenceUnavailable => "fence_unavailable", Category::NotLocal => "not_local", Category::Busy => "busy",
            Category::NotFound => "not_found", Category::InvalidArguments => "invalid_arguments",
            Category::NotPushed => "not_pushed", Category::TagExists => "tag_exists",
            Category::NotGithub => "not_github", Category::NotAvailable => "not_available",
            Category::CiPending => "ci_pending", Category::CiFailed => "ci_failed",
            Category::WindowRequired => "window_required",
            Category::CiRepoUnconfirmed => "ci_repo_unconfirmed", Category::RepoChanged => "repo_changed",
        }
    }
    fn from_str(s: &str) -> Option<Category> {
        serde_json::from_value(Value::String(s.into())).ok()
    }
}

/// A failed step: the category, one sentence, and what ran (already capped
/// and redacted by the time it is stored).
#[derive(Clone, Debug)]
pub struct Failure { pub category: Category, pub message: String, pub output: String }
impl Failure {
    pub(crate) fn new(category: Category, message: impl Into<String>) -> Self { Failure { category, message: message.into(), output: String::new() } }
    pub(crate) fn with_output(mut self, output: String) -> Self { self.output = output; self }
}

/// The repo as the agent last saw it: local and remote SHAs and the local
/// ahead/behind against the tracking ref, so no second call is needed.
#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
pub struct RepoState {
    pub branch: Option<String>,
    pub head: Option<String>,
    pub remote: Option<String>,
    pub upstream: Option<String>,
    pub url: Option<String>,
    pub remote_sha: Option<String>,
    pub ahead: usize,
    pub behind: usize,
}

// ── Output hygiene ──────────────────────────────────────────────────────────

/// The last 8 KB, invisible controls stripped, credentials replaced.
pub fn clean_output(raw: &str, secret: Option<&str>) -> String {
    let stripped = crate::services::root_mcp_mail::strip_invisible(raw);
    let redacted = redact(&stripped, secret);
    tail(&redacted, OUTPUT_CAP)
}

pub(crate) fn tail(s: &str, cap: usize) -> String {
    if s.len() <= cap { return s.to_string(); }
    format!("…{}", &s[s.ceil_char_boundary(s.len() - cap)..])
}

/// Replace anything that looks like a token: the effective secret itself,
/// GitHub and GitLab token shapes, and the userinfo of any URL.
pub fn redact(text: &str, secret: Option<&str>) -> String {
    let mut out = match secret.filter(|s| s.len() >= 8) {
        Some(secret) => text.replace(secret, "[redacted]"),
        None => text.to_string(),
    };
    const PREFIXES: &[&str] = &["github_pat_", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "glpat-"]; // privacy-check: ok — token prefixes the redactor looks for, no token
    let mut result = String::with_capacity(out.len());
    let chars: Vec<char> = out.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let word_char = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '-';
        if word_char(chars[i]) && (i == 0 || !word_char(chars[i - 1])) {
            let mut j = i;
            while j < chars.len() && word_char(chars[j]) { j += 1; }
            let word: String = chars[i..j].iter().collect();
            if PREFIXES.iter().any(|p| word.starts_with(p) && word.len() > p.len() + 4) {
                result.push_str("[redacted]");
            } else {
                result.push_str(&word);
            }
            i = j;
        } else {
            result.push(chars[i]);
            i += 1;
        }
    }
    out = result;
    // `scheme://user:secret@host` → `scheme://[redacted]@host`.
    let mut redacted = String::with_capacity(out.len());
    let mut rest = out.as_str();
    while let Some(at) = rest.find("://") {
        let (head, after) = rest.split_at(at + 3);
        redacted.push_str(head);
        let end = after.find(|c: char| c == '/' || c == '@' || c.is_whitespace()).unwrap_or(after.len());
        if after[..end].len() < after.len() && after[end..].starts_with('@') {
            redacted.push_str("[redacted]");
            rest = &after[end..];
        } else {
            rest = after;
        }
    }
    redacted.push_str(rest);
    redacted
}

// ── Branch names and refspecs ───────────────────────────────────────────────

/// A plain branch name: what `refs/heads/<name>` may carry, and nothing that
/// could read as a refspec operator, an option or a tag.
pub fn validate_branch(name: &str) -> Result<(), String> {
    let bad = name.is_empty() || name.len() > 200 || name.starts_with('-') || name.starts_with('/') || name.ends_with('/')
        || name.starts_with("refs/") || name.ends_with(".lock") || name.contains("..") || name.contains("@{")
        || name.chars().any(|c| c.is_whitespace() || c.is_control() || matches!(c, '~' | '^' | ':' | '?' | '*' | '[' | '\\' | '+'));
    if bad { Err(format!("'{name}' is not a plain branch name")) } else { Ok(()) }
}

/// A full object name as git prints it: 40 (SHA-1) or 64 (SHA-256) lowercase
/// hex digits. Nothing a refspec could read as a ref name or an operator.
pub(crate) fn validate_sha(sha: &str) -> Result<(), String> {
    let ok = matches!(sha.len(), 40 | 64) && sha.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    if ok { Ok(()) } else { Err(format!("'{sha}' is not a full commit id")) }
}

/// The one refspec shape this lane pushes: the approved commit itself onto
/// the branch — `<sha>:refs/heads/<branch>`, never the local branch by name,
/// which the fenced agent can move between the approval and the transport.
/// No `+`, no tags, no delete.
pub fn refspec(sha: &str, branch: &str) -> Result<String, String> {
    validate_sha(sha)?;
    validate_branch(branch)?;
    Ok(format!("{sha}:refs/heads/{branch}"))
}

/// Test seam: runs right before the transport starts, so a test can move
/// refs where the fenced agent could. A no-op outside tests.
pub(crate) fn before_transport() {
    #[cfg(test)]
    BEFORE_TRANSPORT.with(|slot| if let Some(f) = slot.borrow_mut().take() { f() });
}
#[cfg(test)]
thread_local! { pub(crate) static BEFORE_TRANSPORT: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) }; }

/// Whether `branch` may never be pushed: the remote's default branch (falling
/// back to `main`/`master` when the remote did not say) or a listed one.
pub fn is_protected(branch: &str, default_branch: Option<&str>, policy: &ProjectPolicy) -> bool {
    let default_hit = match default_branch {
        Some(default) => default == branch,
        None => matches!(branch, "main" | "master"),
    };
    default_hit || policy.protected.iter().any(|p| p == branch)
}

// ── Running processes with a cap ────────────────────────────────────────────

use crate::services::git_bounded::{BoundedOutput, RunError};

/// [`git_bounded::run`](crate::services::git_bounded::run) options for a lane
/// process: stdout capped at [`LANE_OUTPUT_CAP`], stopped at `timeout`.
pub(crate) fn lane_opts(stdin: Option<Vec<u8>>, timeout: Duration) -> crate::services::git_bounded::Opts {
    crate::services::git_bounded::Opts { stdin, stdout_cap: Some(LANE_OUTPUT_CAP), timeout: Some(timeout), ..Default::default() }
}

/// A lane process's streams as text.
pub(crate) fn lane_text(out: &std::process::Output) -> (String, String) {
    (String::from_utf8_lossy(&out.stdout).into_owned(), String::from_utf8_lossy(&out.stderr).into_owned())
}

/// The hardened git command for this lane, with replace refs ignored:
/// `refs/replace/*` is writable in the fence and changes what `log` and
/// `merge-base` see but not what `pack-objects` sends, so a graft could hide
/// a commit from the card or fake a fast-forward.
pub(crate) fn lane_git_command<S: AsRef<str>>(dir: &Path, args: &[S]) -> std::process::Command {
    let mut cmd = hardened_git_command_in(dir, args);
    cmd.env("GIT_NO_REPLACE_OBJECTS", "1");
    cmd
}

pub(crate) fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = crate::services::git_bounded::output(lane_git_command(dir, args))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

// ── Planning: what would be pushed, decided on the host ─────────────────────

#[derive(Clone, Debug)]
pub struct Plan {
    pub branch: String,
    pub remote: String,
    pub url: String,
    pub head: String,
    pub remote_sha: String,
    pub default_branch: Option<String>,
    pub commits: Vec<String>,
    pub diffstat: String,
    pub needs_url_confirm: bool,
}

/// What `git_push_status` reports: the checked-out branch, its upstream and
/// the local ahead/behind. Never contacts the remote.
pub fn local_state(dir: &Path) -> RepoState {
    let mut state = RepoState::default();
    let Ok(branch) = git(dir, &["symbolic-ref", "--short", "-q", "HEAD"]) else { return state };
    if branch.is_empty() { return state; }
    state.head = git(dir, &["rev-parse", "--verify", &format!("refs/heads/{branch}^{{commit}}")]).ok();
    state.remote = git(dir, &["config", "--get", &format!("branch.{branch}.remote")]).ok().filter(|s| !s.is_empty());
    if let Some(remote) = &state.remote {
        state.url = git(dir, &["config", "--get", &format!("remote.{remote}.url")]).ok().filter(|s| !s.is_empty());
        if let Ok(merge) = git(dir, &["config", "--get", &format!("branch.{branch}.merge")]) {
            if let Some(name) = merge.strip_prefix("refs/heads/") {
                let upstream = format!("{remote}/{name}");
                if let Ok(counts) = git(dir, &["rev-list", "--left-right", "--count", &format!("refs/heads/{branch}...refs/remotes/{upstream}")]) {
                    let mut parts = counts.split_whitespace().filter_map(|n| n.parse::<usize>().ok());
                    state.ahead = parts.next().unwrap_or(0);
                    state.behind = parts.next().unwrap_or(0);
                }
                state.upstream = Some(upstream);
            }
        }
    }
    state.branch = Some(branch);
    state
}

/// The default branch as the local clone knows it (`refs/remotes/<r>/HEAD`),
/// used where no `ls-remote` answer is at hand.
fn local_default_branch(dir: &Path, remote: &str) -> Option<String> {
    git(dir, &["symbolic-ref", "-q", &format!("refs/remotes/{remote}/HEAD")]).ok()
        .and_then(|full| full.strip_prefix(&format!("refs/remotes/{remote}/")).map(str::to_string))
}

/// Local branches the policy would let through, for `git_push_status`.
fn allowed_branches(dir: &Path, policy: &ProjectPolicy) -> Vec<String> {
    let remote = git(dir, &["symbolic-ref", "--short", "-q", "HEAD"]).ok()
        .and_then(|b| git(dir, &["config", "--get", &format!("branch.{b}.remote")]).ok())
        .filter(|s| !s.is_empty());
    let default = remote.as_deref().and_then(|r| local_default_branch(dir, r));
    git(dir, &["for-each-ref", "--format=%(refname:short)", "refs/heads/"]).map(|list| {
        list.lines().map(str::to_string).filter(|b| !is_protected(b, default.as_deref(), policy)).collect()
    }).unwrap_or_default()
}

/// A repo-scope `url.<base>.insteadOf` / `pushInsteadOf` would rewrite even
/// the URL passed on the command line, so the destination could not be pinned.
/// A query git refused or that timed out (#2349: a FIFO it reads) counts as a
/// rewrite: unknown fails closed.
pub(crate) fn repo_rewrites_urls(dir: &Path) -> bool {
    ["--local", "--worktree"].iter().any(|scope| {
        match crate::services::git_bounded::output(hardened_git_command_in(dir, &["config", scope, "--name-only", "--get-regexp", r"^url\..*\.(push)?insteadof$"])) {
            Ok(o) => o.status.success() && !o.stdout.is_empty(),
            Err(_) => true,
        }
    })
}

pub(crate) fn classify_remote_error(stderr: &str) -> Category {
    let s = stderr.to_ascii_lowercase();
    if s.contains("authentication failed") || s.contains("could not read username") || s.contains("could not read password")
        || s.contains("403") || s.contains("401") || s.contains("permission denied") || s.contains("invalid username or token")
        || s.contains("terminal prompts disabled") || s.contains("publickey") {
        Category::AuthFailed
    } else if s.contains("could not resolve host") || s.contains("unable to access") || s.contains("connection")
        || s.contains("network is unreachable") || s.contains("timed out") || s.contains("could not connect") || s.contains("operation timed out") {
        Category::Network
    } else if s.contains("non-fast-forward") || s.contains("fetch first") || s.contains("stale info") {
        Category::Diverged
    } else if s.contains("pre-receive hook declined") || s.contains("protected branch") || s.contains("remote rejected") || s.contains("gh006") {
        Category::RemoteRejected
    } else {
        Category::TransportFailed
    }
}

struct RemoteView { sha: Option<String>, default_branch: Option<String> }

/// One `ls-remote --symref` for the branch and the remote's `HEAD`, with the
/// scoped token. The remote's own answer beats any local guess.
fn ls_remote(dir: &Path, url: &str, branch: &str, token: Option<&str>, origins: &[String]) -> Result<RemoteView, Failure> {
    let stdout = ls_remote_raw(dir, url, &["HEAD".to_string(), format!("refs/heads/{branch}")], token, origins)?;
    let mut view = RemoteView { sha: None, default_branch: None };
    let want = format!("refs/heads/{branch}");
    for line in stdout.lines() {
        if let Some(rest) = line.strip_prefix("ref: ") {
            if let Some((target, name)) = rest.split_once('\t') {
                if name == "HEAD" { view.default_branch = target.strip_prefix("refs/heads/").map(str::to_string); }
            }
        } else if let Some((sha, name)) = line.split_once('\t') {
            if name == want && sha.len() == 40 { view.sha = Some(sha.to_string()); }
        }
    }
    Ok(view)
}

/// `git ls-remote --symref` for exactly `refs`, with the scoped token; its
/// stdout, or the classified failure. Shared with `services::git_release`.
pub(crate) fn ls_remote_raw(dir: &Path, url: &str, refs: &[String], token: Option<&str>, origins: &[String]) -> Result<String, Failure> {
    let mut args: Vec<String> = Vec::new();
    if token.is_some() { args.extend(scoped_token_config(origins, "x-access-token")); }
    args.extend(["ls-remote", "--symref", "--", url].map(str::to_string));
    args.extend(refs.iter().cloned());
    let mut cmd = hardened_git_command_in(dir, &args);
    if let Some(tok) = token { cmd.env(crate::app_env!("GIT_TOKEN"), tok); }
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    let ran = match crate::services::git_bounded::run(&mut cmd, lane_opts(None, REMOTE_TIMEOUT)) {
        Ok(ran) => ran,
        Err(RunError::TimedOut(_)) => return Err(Failure::new(Category::Network, "The remote did not answer within two minutes; try again later.")),
        Err(e) => return Err(Failure::new(Category::TransportFailed, format!("git could not be started: {e}"))),
    };
    let (stdout, stderr) = lane_text(&ran.output);
    // A cut listing is stopped mid-line: never parsed as the remote's answer.
    if ran.cut || !ran.output.status.success() {
        let category = classify_remote_error(&stderr);
        let message = match category {
            Category::AuthFailed => "The remote refused the stored credentials. Ask the user to check the token in Settings → Git Hosting.",
            Category::Network => "The remote could not be reached; try again later.",
            _ => "The remote could not be queried.",
        };
        return Err(Failure::new(category, message).with_output(clean_output(&format!("{stdout}{stderr}"), token)));
    }
    Ok(stdout)
}

fn commits_between(dir: &Path, base: &str, head: &str) -> (Vec<String>, String) {
    let commits = git(dir, &["log", "--format=%h %s", &format!("{base}..{head}"), "--"]).map(|s| s.lines().map(str::to_string).collect()).unwrap_or_default();
    let diffstat = git(dir, &["diff", "--shortstat", base, head, "--"]).unwrap_or_default().trim().to_string();
    (commits, diffstat)
}

/// Everything decided before any project code runs. `requested` is the
/// agent's `branch` argument, which must name the checked-out branch.
fn plan(dir: &Path, policy: &ProjectPolicy, requested: Option<&str>, token: Option<&str>, origins: &[String]) -> Result<Plan, Failure> {
    let branch = git(dir, &["symbolic-ref", "--short", "-q", "HEAD"]).ok().filter(|b| !b.is_empty())
        .ok_or_else(|| Failure::new(Category::NotCheckedOut, "HEAD is detached; check out the branch to push first."))?;
    if let Some(wanted) = requested {
        if wanted != branch {
            return Err(Failure::new(Category::NotCheckedOut, format!("Only the checked-out branch can be pushed, and that is '{branch}'; check out '{wanted}' first.")));
        }
    }
    validate_branch(&branch).map_err(|e| Failure::new(Category::NotCheckedOut, e))?;
    if policy.protected.iter().any(|p| p == &branch) {
        return Err(Failure::new(Category::BranchProtected, format!("'{branch}' is protected for this project; agent pushes never touch it.")));
    }
    let remote = git(dir, &["config", "--get", &format!("branch.{branch}.remote")]).ok().filter(|s| !s.is_empty())
        .ok_or_else(|| Failure::new(Category::NoUpstream, format!("'{branch}' has no upstream; the user can publish it once with the git bar, after which pushes to it can be requested.")))?;
    let merge = git(dir, &["config", "--get", &format!("branch.{branch}.merge")]).unwrap_or_default();
    if merge != format!("refs/heads/{branch}") {
        return Err(Failure::new(Category::NoUpstream, format!("'{branch}' tracks a differently named remote branch; only a same-named upstream can be pushed.")));
    }
    if repo_rewrites_urls(dir) {
        return Err(Failure::new(Category::UrlRewritten, "The repo's own git config rewrites URLs (url.*.insteadOf), so the destination cannot be pinned; ask the user to remove that setting from .git/config."));
    }
    let url = git(dir, &["config", "--get", &format!("remote.{remote}.url")]).ok().filter(|s| !s.is_empty())
        .ok_or_else(|| Failure::new(Category::NoUpstream, format!("remote '{remote}' has no URL.")))?;
    if url.starts_with("http") && token.is_none() {
        return Err(Failure::new(Category::AuthFailed, "No access token is stored for this project. Ask the user to add one in Settings → Git Hosting."));
    }
    let head = git(dir, &["rev-parse", "--verify", &format!("refs/heads/{branch}^{{commit}}")]).map_err(|e| Failure::new(Category::NotCheckedOut, e))?;
    let view = ls_remote(dir, &url, &branch, token, origins)?;
    if is_protected(&branch, view.default_branch.as_deref(), policy) {
        return Err(Failure::new(Category::BranchProtected, format!("'{branch}' is the remote's default branch; agent pushes never touch it. Work on another branch and open a pull request.")));
    }
    let remote_sha = view.sha.ok_or_else(|| Failure::new(Category::RemoteBranchMissing, format!("'{branch}' does not exist on the remote yet; the user can publish it once with the git bar.")))?;
    if remote_sha == head {
        return Err(Failure::new(Category::NothingToPush, format!("'{branch}' is already up to date with the remote.")));
    }
    let ff = lane_git_command(dir, &["merge-base", "--is-ancestor", &remote_sha, &head]).bounded_output().is_ok_and(|o| o.status.success());
    if !ff {
        return Err(Failure::new(Category::Diverged, format!("The remote '{branch}' has commits this branch does not have; pull or rebase first, then ask again.")));
    }
    let (commits, diffstat) = commits_between(dir, &remote_sha, &head);
    Ok(Plan {
        needs_url_confirm: policy.confirmed_url.as_deref() != Some(url.as_str()),
        default_branch: view.default_branch, branch, remote, url, head, remote_sha, commits, diffstat,
    })
}

// ── Preflight: the repo's pre-push hook, in the tab's fence, no token ────────

/// Where a preflight runs the hook (gap 18).
#[derive(Clone, Copy, Debug)]
enum HookBoundary<'a> {
    /// The fence scope recorded on the tab's Pusher binding at spawn
    /// ([`PushBinding::fence_scope`](crate::services::root_mcp::PushBinding)).
    Fence(&'a str),
    /// No scope was recorded: the hook is not run and the push is refused.
    /// The hook is agent-writable, so a missing record never means "run it
    /// on the host".
    Unrecorded,
    /// The host, for the hook tests only (Unix: they write a `#!/bin/sh` hook).
    #[cfg(all(test, unix))]
    Host,
}

impl<'a> HookBoundary<'a> {
    fn of(fence_scope: Option<&'a str>) -> Self {
        fence_scope.map_or(Self::Unrecorded, Self::Fence)
    }
}

/// The command that runs `hook` on the tab's behalf, inside the fence its
/// tab was spawned into. Never carries a token. A Pusher exists only for a
/// local project agent, which is always fenced on Linux and macOS, so an
/// unrecorded scope fails closed rather than falling back to the host; on
/// Windows (no fence) a repo with a `pre-push` hook is pushed from the git
/// bar.
fn preflight_command(boundary: HookBoundary<'_>, hook: &Path, dir: &Path, remote: &str, url: &str) -> Result<std::process::Command, Failure> {
    let args = vec![remote.to_string(), url.to_string()];
    let mut cmd = match boundary {
        HookBoundary::Fence(scope) => crate::services::agent_fence::one_shot_command(scope, &hook.to_string_lossy(), &args, dir)
            .map_err(|e| Failure::new(Category::FenceUnavailable, format!("The tab is fenced but the fence cannot run the pre-push hook: {e}")))?,
        HookBoundary::Unrecorded => {
            return Err(Failure::new(Category::FenceUnavailable, if cfg!(windows) {
                "pre-push hooks are not run for agent pushes on Windows; the user can push from the git bar."
            } else {
                "This tab has no recorded sandbox to run the repo's pre-push hook in, so nothing was pushed. Ask the user to restart the tab, or to push from the git bar."
            }));
        }
        #[cfg(all(test, unix))]
        HookBoundary::Host => {
            let mut cmd = crate::paths::command_no_window(hook);
            cmd.args(&args).current_dir(dir);
            cmd
        }
    };
    for var in [crate::app_env!("GIT_TOKEN"), crate::services::root_mcp::TOKEN_ENV, crate::services::root_mcp::SCHEDULE_TOKEN_ENV, crate::services::root_mcp::GIT_TOKEN_ENV, crate::services::root_mcp::HELP_TOKEN_ENV, crate::services::root_mcp::MARKUP_TOKEN_ENV, "GIT_CONFIG_PARAMETERS", "GIT_DIR", "GIT_WORK_TREE"] {
        cmd.env_remove(var);
    }
    cmd.env(crate::app_env!("PUSH_PREFLIGHT"), "1");
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    // The hook's scan sees the commits that are sent, not a graft over them.
    cmd.env("GIT_NO_REPLACE_OBJECTS", "1");
    Ok(cmd)
}

/// Run the resolved `pre-push` (if any) and pick up what it committed. The
/// returned plan has the post-preflight SHA, commit list and diffstat.
///
/// The hook's stdin line names the SHA the transport will push. When the
/// hook adds commits (a version bump), the branch's new tip is not what that
/// line named, so the hook runs once more on the new tip: whatever it checks
/// (a privacy scan) then covers every commit that leaves, including any that
/// landed on the branch while it ran. A hook that still adds commits on that
/// second run is refused rather than run again.
fn preflight(dir: &Path, boundary: HookBoundary<'_>, mut plan: Plan) -> Result<(Plan, String), Failure> {
    let Some(hook) = resolve_pre_push_hook(dir) else { return Ok((plan, String::new())) };
    let mut outputs: Vec<String> = Vec::new();
    for round in 0..2 {
        let mut cmd = preflight_command(boundary, &hook, dir, &plan.remote, &plan.url)?;
        let line = format!("refs/heads/{b} {h} refs/heads/{b} {r}\n", b = plan.branch, h = plan.head, r = plan.remote_sha);
        // Drained, not stopped, past the cap: a hook's log is only shown (its
        // tail), so a chatty but passing hook (a test run) never blocks the push.
        let opts = crate::services::git_bounded::Opts { keep_stdout_ends: true, ..lane_opts(Some(line.into_bytes()), PREFLIGHT_TIMEOUT) };
        let ran = match crate::services::git_bounded::run(&mut cmd, opts) {
            Ok(ran) => ran,
            Err(RunError::TimedOut(_)) => return Err(Failure::new(Category::PreflightTimeout, "The pre-push hook did not finish within five minutes and was stopped; nothing was pushed.")),
            Err(e) => return Err(Failure::new(Category::PreflightFailed, format!("The pre-push hook could not be started: {e}"))),
        };
        let (stdout, stderr) = lane_text(&ran.output);
        outputs.push(join_streams(&stdout, &stderr));
        let output = clean_output(&outputs.join("\n"), None);
        if !ran.output.status.success() {
            return Err(Failure::new(Category::PreflightFailed, format!("The pre-push hook exited with status {}; nothing was pushed. Fix what its output reports and ask again.", ran.output.status.code().map(|c| c.to_string()).unwrap_or_else(|| "signal".into()))).with_output(output));
        }
        // The hook may have committed (a version bump): re-resolve and re-check.
        let head = git(dir, &["rev-parse", "--verify", &format!("refs/heads/{}^{{commit}}", plan.branch)]).map_err(|e| Failure::new(Category::NotCheckedOut, e))?;
        if head == plan.head {
            return Ok((plan, output));
        }
        if round == 1 {
            return Err(Failure::new(Category::PreflightFailed, "The pre-push hook added commits again when run on its own commits; nothing was pushed.").with_output(output));
        }
        let ff = lane_git_command(dir, &["merge-base", "--is-ancestor", &plan.head, &head]).bounded_output().is_ok_and(|o| o.status.success());
        if !ff {
            return Err(Failure::new(Category::PreflightFailed, "The pre-push hook rewrote the branch instead of adding to it; nothing was pushed.").with_output(output));
        }
        plan.head = head;
        let (commits, diffstat) = commits_between(dir, &plan.remote_sha, &plan.head);
        plan.commits = commits;
        plan.diffstat = diffstat;
    }
    unreachable!("the second round always returns")
}

pub(crate) fn join_streams(stdout: &str, stderr: &str) -> String {
    match (stdout.trim().is_empty(), stderr.trim().is_empty()) {
        (true, _) => stderr.to_string(),
        (_, true) => stdout.to_string(),
        _ => format!("{stdout}\n{stderr}"),
    }
}

// ── Transport ───────────────────────────────────────────────────────────────

fn transport(dir: &Path, plan: &Plan, token: Option<&str>, origins: &[String]) -> Result<String, Failure> {
    // The plan's SHA, not the branch name: what was validated (Apply) or
    // shown on the approved card (Propose) is what leaves, wherever the
    // branch points by now.
    let refspec = refspec(&plan.head, &plan.branch).map_err(|e| Failure::new(Category::NotCheckedOut, e))?;
    let mut cmd = push_transport_command(dir, &plan.url, &refspec, token, origins);
    before_transport();
    let ran = match crate::services::git_bounded::run(&mut cmd, lane_opts(None, TRANSPORT_TIMEOUT)) {
        Ok(ran) => ran,
        Err(RunError::TimedOut(_)) => return Err(Failure::new(Category::Network, "The push did not finish within ten minutes and was stopped.")),
        Err(e) => return Err(Failure::new(Category::TransportFailed, format!("git could not be started: {e}"))),
    };
    let (stdout, stderr) = lane_text(&ran.output);
    let output = clean_output(&join_streams(&stdout, &stderr), token);
    if ran.output.status.success() {
        return Ok(output);
    }
    let category = classify_remote_error(&format!("{stdout}\n{stderr}"));
    let message = match category {
        Category::AuthFailed => "The remote refused the stored credentials. Ask the user to check the token in Settings → Git Hosting.",
        Category::Network => "The remote could not be reached; try again later.",
        Category::Diverged => "The remote moved in the meantime; pull or rebase first, then ask again.",
        Category::RemoteRejected => "The remote rejected the push (a server-side hook or branch protection); read its output.",
        _ => "git push failed; read its output.",
    };
    Err(Failure::new(category, message).with_output(output))
}

// ── Proposals ───────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status { Running, Pending, Pushed, Failed, Dismissed, Expired,
    /// A [`Kind::CiRepo`] card the user allowed.
    Allowed }

/// What a proposal asks for: a branch push, a release tag on a pushed tip
/// (`services::git_release`), or leave to read CI for a repo (gap 19).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind { Push, Release,
    /// "Allow CI for <owner/repo>": staged by a CI read of an unconfirmed
    /// repo, never counted against the push budget or the pending limit.
    CiRepo }

/// One agent request, from admission to its terminal state. The card and
/// `git_push_status` both read this; the audit ring only ever sees the
/// category and SHAs.
#[derive(Clone, Debug, Serialize)]
pub struct Proposal {
    pub id: String,
    pub session: String,
    pub tab: String,
    pub project: String,
    #[serde(skip)]
    dir: PathBuf,
    /// The fence scope the requesting tab was spawned into, copied from its
    /// Pusher binding; where the preflight runs the hook.
    #[serde(skip)]
    fence_scope: Option<String>,
    pub kind: Kind,
    /// The release tag (`Kind::Release` only).
    pub tag: Option<String>,
    /// The lowercase `owner/repo` a [`Kind::CiRepo`] card allows.
    pub repo: Option<String>,
    pub branch: Option<String>,
    pub remote: Option<String>,
    pub url: Option<String>,
    /// The post-preflight SHA approval binds.
    pub head: Option<String>,
    pub remote_sha: Option<String>,
    pub commits: Vec<String>,
    pub diffstat: String,
    pub note: String,
    pub needs_url_confirm: bool,
    pub created_at: String,
    #[serde(skip)]
    created: Instant,
    pub status: Status,
    pub category: Option<Category>,
    pub message: String,
    pub output: String,
    pub state: RepoState,
    /// What the hook printed on a successful preflight.
    pub preflight_output: String,
    /// The user closed the finished card; `git_push_status` still reports it.
    pub cleared: bool,
}

fn proposals() -> &'static Mutex<Vec<Proposal>> {
    static STORE: OnceLock<Mutex<Vec<Proposal>>> = OnceLock::new();
    STORE.get_or_init(Default::default)
}
fn project_locks() -> &'static Mutex<HashMap<String, Arc<Mutex<()>>>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(Default::default)
}
fn project_lock(project: &str) -> Arc<Mutex<()>> {
    project_locks().lock_ok().entry(project.to_string()).or_default().clone()
}
/// Set once by the command layer; called after any state change from a
/// worker thread, so the window learns of it without an `AppHandle` here.
static CHANGE_HOOK: OnceLock<Box<dyn Fn() + Send + Sync>> = OnceLock::new();
pub fn set_change_hook(hook: Box<dyn Fn() + Send + Sync>) { let _ = CHANGE_HOOK.set(hook); }
fn changed() { if let Some(hook) = CHANGE_HOOK.get() { hook(); } }

/// Expire day-old pending proposals, drop day-old records and everything
/// bound to a session that no longer holds a token.
fn prune(list: &mut Vec<Proposal>) -> bool {
    let mut changed = false;
    for p in list.iter_mut() {
        if p.status == Status::Pending && p.created.elapsed() >= RETENTION {
            p.status = Status::Expired;
            p.category = Some(Category::Expired);
            p.message = "The proposal expired unapproved after 24 hours.".into();
            changed = true;
        }
    }
    let before = list.len();
    list.retain(|p| p.status == Status::Running || (p.created.elapsed() < RETENTION && (crate::services::root_mcp::session_alive(&p.session) || cfg!(test) && p.session.starts_with("test-"))));
    changed | (list.len() != before)
}

fn proposal_id(prefix: &str) -> String {
    format!("{prefix}-{}", crate::services::root_mcp::mint_token().map(|t| t[..16].to_string()).unwrap_or_else(|| format!("{}", chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default())))
}

fn new_proposal(session: &Session, project: &str, dir: &Path, note: String) -> Proposal {
    Proposal {
        id: proposal_id("push"),
        session: session.id.clone(), tab: session.identity.tab.clone(), project: project.to_string(), dir: dir.to_path_buf(),
        fence_scope: session.identity.push.as_ref().and_then(|b| b.fence_scope.clone()),
        kind: Kind::Push, tag: None, repo: None, branch: None, remote: None, url: None, head: None, remote_sha: None, commits: Vec::new(), diffstat: String::new(), note,
        needs_url_confirm: false, created_at: chrono::Local::now().to_rfc3339(), created: Instant::now(), status: Status::Running,
        category: None, message: String::new(), output: String::new(), state: RepoState::default(), preflight_output: String::new(),
        cleared: false,
    }
}

fn update(id: &str, f: impl FnOnce(&mut Proposal)) -> Option<Proposal> {
    let mut list = proposals().lock_ok();
    let p = list.iter_mut().find(|p| p.id == id)?;
    f(p);
    Some(p.clone())
}
/// A proposal just staged supersedes the same tab's older still-pending
/// ones of its kind: their card describes a branch tip the newer one has
/// replaced, so they are dismissed without the user pressing anything. The
/// agent polling `git_push_status` sees the dismissal and why.
fn supersede_older(id: &str) {
    let mut list = proposals().lock_ok();
    let Some((tab, kind)) = list.iter().find(|p| p.id == id).map(|p| (p.tab.clone(), p.kind)) else { return };
    for p in list.iter_mut().filter(|p| p.id != id && p.tab == tab && p.kind == kind && p.status == Status::Pending) {
        p.status = Status::Dismissed;
        p.category = Some(Category::Dismissed);
        p.message = "Superseded by a newer request of this tab.".into();
    }
}
fn get(id: &str) -> Option<Proposal> {
    proposals().lock_ok().iter().find(|p| p.id == id).cloned()
}
fn fail(id: &str, failure: Failure) -> Option<Proposal> {
    let out = update(id, |p| {
        p.status = Status::Failed;
        p.category = Some(failure.category);
        p.message = failure.message.clone();
        p.output = failure.output.clone();
        p.state = local_state(&p.dir);
    });
    changed();
    out
}
fn apply_plan(p: &mut Proposal, plan: &Plan) {
    p.branch = Some(plan.branch.clone());
    p.remote = Some(plan.remote.clone());
    p.url = Some(plan.url.clone());
    p.head = Some(plan.head.clone());
    p.remote_sha = Some(plan.remote_sha.clone());
    p.commits = plan.commits.clone();
    p.diffstat = plan.diffstat.clone();
    p.needs_url_confirm = plan.needs_url_confirm;
    p.state = local_state(&p.dir);
    p.state.remote_sha = Some(plan.remote_sha.clone());
}

/// Stage the "Allow CI for <repo>" card for `base`'s session and project, or
/// find the one already waiting for that repo (one per project and repo).
/// Outside the push budget and the pending limit, so a CI card never blocks
/// a push. Returns the card's id.
fn stage_ci_card(base: &Proposal, url: &str, repo: &str) -> String {
    let mut list = proposals().lock().unwrap_or_else(|p| p.into_inner());
    prune(&mut list);
    if let Some(waiting) = list.iter().find(|p| p.kind == Kind::CiRepo && p.status == Status::Pending && p.project == base.project && p.repo.as_deref() == Some(repo)) {
        return waiting.id.clone();
    }
    let mut card = base.clone();
    card.id = proposal_id("ci");
    card.kind = Kind::CiRepo;
    card.tag = None;
    card.repo = Some(repo.to_string());
    card.url = Some(url.to_string());
    (card.branch, card.remote, card.head, card.remote_sha) = (None, None, None, None);
    (card.commits, card.diffstat, card.note, card.output, card.preflight_output) = (Vec::new(), String::new(), String::new(), String::new(), String::new());
    card.needs_url_confirm = false;
    card.created_at = chrono::Local::now().to_rfc3339();
    card.created = Instant::now();
    card.status = Status::Pending;
    card.category = None;
    card.message = format!("Waiting for the user to allow CI reads for {repo}.");
    card.state = RepoState::default();
    card.cleared = false;
    let id = card.id.clone();
    list.push(card);
    drop(list);
    changed();
    id
}

/// What a CI read of an unconfirmed repo answers.
fn ci_unconfirmed(card: Option<&str>, repo: &str) -> Value {
    let message = match card {
        Some(_) => format!("CI for {repo} is not read without the user's leave: it is neither the repository confirmed for this project's pushes nor one the user allowed. A card \"Allow CI for {repo}\" is waiting in the git bar; ask the user to allow it, then call this again."),
        None => format!(concat!("CI for {repo} is not read without the user's leave, and this tab was started by ", crate::app_name!(), " Mobile while no window was open, where no card can be shown. Ask the user to restart this tab from the ", crate::app_name!(), " window and ask again; the window then shows an \"Allow CI\" card."), repo = repo),
    };
    let mut value = json!({"status":"refused","category":Category::CiRepoUnconfirmed,"message":message,"output":"","state":Value::Null});
    if let Some(id) = card { value["requestId"] = json!(id); }
    value
}

/// The repo a CI read goes to — only once it is confirmed (gap 19). An
/// unconfirmed one stages the card and answers `ci_repo_unconfirmed`;
/// `no_upstream` / `not_github` come first. `Err` is the tool result.
fn ci_target(session: &Session, project: &str, dir: &Path, policy: &ProjectPolicy, listed: &[String]) -> Result<crate::services::git_ci::CiRepo, Value> {
    let target = crate::services::git_ci::resolve(dir).map_err(|f| ci_result(Err(f)))?;
    if ci_repo_allowed(policy, listed, &target.url) { return Ok(target); }
    let repo = ci_repo_key(&target.url).unwrap_or_default();
    if keyring_free() { return Err(ci_unconfirmed(None, &repo)); }
    let id = stage_ci_card(&new_proposal(session, project, dir, String::new()), &target.url, &repo);
    Err(ci_unconfirmed(Some(&id), &repo))
}

/// The confirmed-repo check of a release's CI gate, read now.
fn release_ci_gate(project: &str) -> impl Fn(&str) -> bool {
    let (policy, listed) = (policy(project).unwrap_or_default(), ci_repos(project));
    move |url: &str| ci_repo_allowed(&policy, &listed, url)
}

/// A release refused for an unconfirmed CI repo stages the card too.
fn release_failure(p: &Proposal, failure: Failure) -> Failure {
    if failure.category != Category::CiRepoUnconfirmed { return failure; }
    let Ok(target) = crate::services::git_ci::resolve(&p.dir) else { return failure };
    let url = target.url;
    let Some(repo) = ci_repo_key(&url) else { return failure };
    let card = (!keyring_free()).then(|| stage_ci_card(p, &url, &repo));
    let message = ci_unconfirmed(card.as_deref(), &repo)["message"].as_str().unwrap_or_default().to_string();
    Failure::new(Category::CiRepoUnconfirmed, format!("A release checks the tip's CI first. {message}"))
}

/// The proposals of one project (the card) or of one tab (`git_push_status`).
pub fn proposals_for(project: Option<&str>, tab: Option<&str>) -> Vec<Proposal> {
    let mut list = proposals().lock_ok();
    prune(&mut list);
    list.iter().filter(|p| project.is_none_or(|id| p.project == id) && tab.is_none_or(|t| p.tab == t)).cloned().collect()
}
/// Drop every proposal of a revoked session. Whether anything went.
pub fn remove_for_session(session: &str) -> bool {
    let mut list = proposals().lock_ok();
    let before = list.len();
    list.retain(|p| p.session != session || p.status == Status::Running);
    list.len() != before
}

/// Set once by the Mobile host before its listener starts: this process
/// serves the lane for the tabs it spawned with no window open and never
/// reads the user's git token from the OS keychain (`docs/headless_mcp_plan.md`).
/// The host faces the phone, and on Linux a locked Secret Service collection
/// would turn a read into an unlock prompt or a parked D-Bus call. Pushes and
/// releases then answer [`Category::WindowRequired`]; CI reads go without a
/// token.
static KEYRING_FREE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
pub fn serve_without_keyring() { KEYRING_FREE.store(true, std::sync::atomic::Ordering::Release); }
pub(crate) fn keyring_free() -> bool {
    KEYRING_FREE.load(std::sync::atomic::Ordering::Acquire) || KEYRING_FREE_HERE.with(std::cell::Cell::get)
}
// The switch for one test thread only: the process-wide one would reach every
// other test of the lane running beside it.
thread_local! { static KEYRING_FREE_HERE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }
#[cfg(test)]
pub(crate) fn serve_without_keyring_on_this_thread(on: bool) { KEYRING_FREE_HERE.with(|c| c.set(on)); }

/// What a push or release from a tab of the keyring-free process answers.
fn window_required(dir: &Path) -> Value {
    json!({"status":"refused","category":Category::WindowRequired,"message":concat!("This tab was started by ", crate::app_name!(), " Mobile while no window was open, and that background service never uses the stored git token, so it cannot push or tag from here. Ask the user to restart this tab from the ", crate::app_name!(), " window (its pushes then go through the window's approval card), or to push from the git bar."),"output":"","state":local_state(dir)})
}

pub(crate) fn creds(project: &str) -> (Option<String>, Vec<String>) {
    if keyring_free() {
        return (None, crate::services::git_hosting::token_origins(Some(project), None));
    }
    let token = crate::services::git_hosting::effective_git_creds(project).1;
    let origins = crate::services::git_hosting::token_origins(Some(project), None);
    (token, origins)
}

/// The worker behind `git_push`: plan, preflight, then stage or push. Runs
/// under the project's lock so two tabs cannot push the same repo at once.
fn run_request(id: String, level: Level, requested: Option<String>) {
    let Some(p) = get(&id) else { return };
    let lock = project_lock(&p.project);
    let _guard = lock.lock_ok();
    let policy = match policy(&p.project) { Ok(policy) => policy, Err(e) => { fail(&id, Failure::new(Category::LevelOff, e)); return; } };
    let (token, origins) = creds(&p.project);
    let plan = match plan(&p.dir, &policy, requested.as_deref(), token.as_deref(), &origins) {
        Ok(plan) => plan,
        Err(failure) => { fail(&id, failure); return; }
    };
    update(&id, |p| apply_plan(p, &plan));
    let (plan, preflight_output) = match preflight(&p.dir, HookBoundary::of(p.fence_scope.as_deref()), plan) {
        Ok(done) => done,
        Err(failure) => { fail(&id, failure); return; }
    };
    let staged = level != Level::Apply || plan.needs_url_confirm;
    update(&id, |p| {
        apply_plan(p, &plan);
        p.preflight_output = preflight_output;
        if staged {
            p.status = Status::Pending;
            p.message = if plan.needs_url_confirm && level == Level::Apply {
                "The first push to this URL needs the user's confirmation; a card is waiting for them.".into()
            } else {
                "Staged for the user's approval; poll git_push_status for the outcome.".into()
            };
        }
    });
    if staged { supersede_older(&id); }
    changed();
    if staged { return; }
    push_now(&id, &plan, token.as_deref(), &origins);
}

fn push_now(id: &str, plan: &Plan, token: Option<&str>, origins: &[String]) {
    let Some(p) = get(id) else { return };
    match transport(&p.dir, plan, token, origins) {
        Ok(output) => {
            update(id, |p| {
                p.status = Status::Pushed;
                p.output = output;
                p.message = format!("Pushed {} to {} ({} → {}).", plan.branch, plan.remote, &plan.remote_sha[..7.min(plan.remote_sha.len())], &plan.head[..7.min(plan.head.len())]);
                p.state = local_state(&p.dir);
                p.state.remote_sha = Some(plan.head.clone());
            });
            changed();
        }
        Err(failure) => { fail(id, failure); }
    }
}

/// The user pressed Push (or Dismiss) on the card. Approval binds the
/// post-preflight SHA: a branch that moved since is a stale approval (the
/// card no longer describes the branch, so the user decides again), and
/// the transport pushes that SHA itself, so a move after this check — while
/// the remote is queried — changes nothing that leaves. The first push to a
/// URL records it as confirmed.
pub fn decide(id: &str, approve: bool) -> Result<Proposal, String> {
    let p = get(id).ok_or("proposal not found")?;
    if p.status != Status::Pending { return Err("this proposal is no longer pending".into()); }
    if p.kind == Kind::CiRepo { return decide_ci_repo(&p, approve, allow_ci_repo); }
    if !approve {
        let out = update(id, |p| { p.status = Status::Dismissed; p.category = Some(Category::Dismissed); p.message = "The user dismissed the push.".into(); });
        changed();
        return out.ok_or("proposal not found".into());
    }
    let lock = project_lock(&p.project);
    let _guard = lock.lock_ok();
    if p.kind == Kind::Release { return decide_release(p); }
    let (Some(branch), Some(head), Some(remote), Some(url), Some(remote_sha)) = (p.branch.clone(), p.head.clone(), p.remote.clone(), p.url.clone(), p.remote_sha.clone()) else {
        return Err("incomplete proposal".into());
    };
    if p.needs_url_confirm {
        set_policy(&p.project, None, None, Some(url.clone()))?;
    }
    let current = git(&p.dir, &["rev-parse", "--verify", &format!("refs/heads/{branch}^{{commit}}")]).unwrap_or_default();
    if current != head {
        return fail(id, Failure::new(Category::StaleApproval, "The branch moved after the proposal was made; ask the agent to request the push again.")).ok_or("proposal not found".into());
    }
    let (token, origins) = creds(&p.project);
    // The remote may have moved too: still fine while the approved SHA
    // fast-forwards it, otherwise the same answer the agent gets.
    let view = match ls_remote(&p.dir, &url, &branch, token.as_deref(), &origins) {
        Ok(view) => view,
        Err(failure) => return fail(id, failure).ok_or("proposal not found".into()),
    };
    let Some(live_remote) = view.sha else {
        return fail(id, Failure::new(Category::RemoteBranchMissing, "The remote branch disappeared in the meantime.")).ok_or("proposal not found".into());
    };
    if live_remote != remote_sha && !lane_git_command(&p.dir, &["merge-base", "--is-ancestor", &live_remote, &head]).bounded_output().is_ok_and(|o| o.status.success()) {
        return fail(id, Failure::new(Category::Diverged, "The remote moved in the meantime; pull or rebase first, then ask again.")).ok_or("proposal not found".into());
    }
    update(id, |p| { p.status = Status::Running; p.needs_url_confirm = false; });
    let plan = Plan { branch, remote, url, head, remote_sha: live_remote, default_branch: view.default_branch, commits: p.commits.clone(), diffstat: p.diffstat.clone(), needs_url_confirm: false };
    push_now(id, &plan, token.as_deref(), &origins);
    get(id).ok_or("proposal not found".into())
}

/// The user pressed Allow (or Dismiss) on an "Allow CI" card: Allow records
/// the repo in the project's `git_ci_repos`, so the agent's next read goes.
/// `allow` is the `projects.json` write (a test seam).
fn decide_ci_repo(p: &Proposal, approve: bool, allow: impl FnOnce(&str, &str) -> Result<(), String>) -> Result<Proposal, String> {
    let repo = p.repo.clone().ok_or("incomplete proposal")?;
    if approve { allow(&p.project, &repo)?; }
    let out = update(&p.id, |p| if approve {
        p.status = Status::Allowed;
        p.category = None;
        p.message = format!("The user allowed CI reads for {repo}; ask again.");
    } else {
        p.status = Status::Dismissed;
        p.category = Some(Category::Dismissed);
        p.message = format!("The user did not allow CI reads for {repo}.");
    });
    changed();
    out.ok_or("proposal not found".into())
}

/// Close a finished card. The record stays, so the agent polling
/// `git_push_status` still learns the outcome; only the card hides it.
pub fn clear(id: &str) -> Result<Proposal, String> {
    let out = update(id, |p| if !matches!(p.status, Status::Running | Status::Pending) { p.cleared = true; })
        .ok_or("proposal not found")?;
    if !out.cleared { return Err("this proposal is not finished yet".into()); }
    changed();
    Ok(out)
}

/// The worker behind `git_release`: decide the tag on the host and stage it.
/// A release is never applied without the user's click, whatever the level.
fn run_release(id: String, requested: Option<String>) {
    let Some(p) = get(&id) else { return };
    let lock = project_lock(&p.project);
    let _guard = lock.lock_ok();
    let (token, origins) = creds(&p.project);
    let tag = match requested {
        Some(tag) => tag,
        None => match git(&p.dir, &["rev-parse", "--verify", "HEAD^{commit}"]) {
            Ok(head) => crate::services::git_release::suggest_tag(&p.dir, &head).0,
            Err(e) => { fail(&id, Failure::new(Category::NotCheckedOut, e)); return; }
        },
    };
    let plan = match crate::services::git_release::plan(&p.dir, &tag, true, token.as_deref(), &origins, &release_ci_gate(&p.project)) {
        Ok(plan) => plan,
        Err(failure) => { update(&id, |p| p.tag = Some(tag.clone())); fail(&id, release_failure(&p, failure)); return; }
    };
    update(&id, |p| {
        p.tag = Some(plan.tag.clone());
        p.branch = Some(plan.branch.clone());
        p.remote = Some(plan.remote.clone());
        p.url = Some(plan.url.clone());
        p.head = Some(plan.head.clone());
        p.remote_sha = Some(plan.head.clone());
        p.commits = vec![plan.subject.clone()];
        p.state = local_state(&p.dir);
        p.status = Status::Pending;
        p.message = "Staged for the user's approval; poll git_push_status for the outcome.".into();
    });
    supersede_older(&id);
    changed();
}

/// The user pressed Release: re-decide against the live remote, bind to the
/// proposed tip, then tag and push the one tag (`git_release::release` pins
/// the tag object it verified, so a local tag moved meanwhile is not sent).
fn decide_release(p: Proposal) -> Result<Proposal, String> {
    let (Some(tag), Some(head)) = (p.tag.clone(), p.head.clone()) else { return Err("incomplete proposal".into()) };
    let (token, origins) = creds(&p.project);
    let plan = match crate::services::git_release::plan(&p.dir, &tag, true, token.as_deref(), &origins, &release_ci_gate(&p.project)) {
        Ok(plan) => plan,
        Err(failure) => return fail(&p.id, release_failure(&p, failure)).ok_or("proposal not found".into()),
    };
    if plan.head != head {
        return fail(&p.id, Failure::new(Category::StaleApproval, "The branch moved after the release was proposed; ask the agent to request it again.")).ok_or("proposal not found".into());
    }
    update(&p.id, |p| p.status = Status::Running);
    changed();
    match crate::services::git_release::release(&p.dir, &plan, &plan.tag, token.as_deref(), &origins) {
        Ok(output) => {
            update(&p.id, |p| {
                p.status = Status::Pushed;
                p.output = output;
                p.message = format!("Tagged {} at {} and pushed it to {}.", plan.tag, &plan.head[..7.min(plan.head.len())], plan.remote);
                p.state = local_state(&p.dir);
            });
            changed();
        }
        Err(failure) => { fail(&p.id, failure); }
    }
    get(&p.id).ok_or("proposal not found".into())
}

// ── The RPC ─────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PushArgs { branch: Option<String>, note: Option<String> }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReleaseArgs { tag: Option<String>, note: Option<String> }
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CiRunsArgs { #[serde(rename = "ref")] reference: Option<String>, limit: Option<u64>, failed_only: Option<bool> }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CiRunArgs { id: u64 }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CiAlertsArgs { #[serde(rename = "ref")] reference: Option<String>, limit: Option<u64> }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Cancel { id: String }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}

pub fn tool_names() -> &'static [&'static str] { &["git_push_status", "git_push", "git_push_cancel", "git_release", "ci_runs", "ci_run", "ci_security_alerts"] }

pub fn tools() -> Value {
    let object = |properties: Value, required: Value| json!({"type":"object","properties":properties,"required":required,"additionalProperties":false});
    json!([
        {"name":"git_push_status","description":"This project's push state: the checked-out branch, its upstream, ahead/behind, the project's agent-push level, which local branches the policy allows, and this tab's push requests with their outcome (pending, running, pushed, failed, dismissed, expired). Read-only.",
         "inputSchema":object(json!({}),json!([])),"annotations":{"readOnlyHint":true}},
        {"name":"git_push","description":format!("Ask {app} to push this tab's checked-out branch. {CONTRACT}", app = crate::brand::DISPLAY),
         "inputSchema":object(json!({
            "branch":{"type":"string","maxLength":200,"description":"The branch to push. Optional; defaults to the checked-out branch, and must be the checked-out branch."},
            "note":{"type":"string","maxLength":NOTE_MAX,"description":"One line for the user's approval card saying why this push is wanted. Optional; at most 200 characters."}
         }),json!([]))},
        {"name":"git_push_cancel","description":"Withdraw one of this tab's own pending push or release requests. A request already running or decided cannot be withdrawn.",
         "inputSchema":object(json!({"id":{"type":"string","maxLength":64,"description":"The request id git_push, git_release or git_push_status returned."}}),json!(["id"]))},
        {"name":"git_release","description":concat!("Ask ", crate::app_name!(), " to tag a release: an annotated tag on the checked-out branch's tip, pushed as that one tag. The tip must already be on the remote (git_push first, and wait until git_push_status says pushed), and on GitHub its CI must have passed (ci_pending / ci_failed otherwise; ci_runs shows it). The tag must be new on the remote. Always staged: the user presses Release on the card; poll git_push_status for the outcome. Counts against the push budget."),
         "inputSchema":object(json!({
            "tag":{"type":"string","maxLength":100,"description":"The tag, e.g. v1.2.3. Optional; defaults to v<version> from package.json / tauri.conf.json / Cargo.toml / pyproject.toml at the tip, else the latest v* tag counted up."},
            "note":{"type":"string","maxLength":NOTE_MAX,"description":"One line for the user's approval card. Optional."}
         }),json!([]))},
        {"name":"ci_runs","description":format!("Recent GitHub Actions runs of this repository (CI, security scans, releases), newest first: workflow, title, event, status, conclusion, commit, run id and link. Read-only. {CI_REPO_RULE}"),
         "inputSchema":object(json!({
            "ref":{"type":"string","maxLength":200,"description":"Branch or tag whose runs to list. Optional; defaults to the checked-out branch."},
            "limit":{"type":"integer","minimum":1,"maximum":30,"description":"How many runs (default 10)."},
            "failedOnly":{"type":"boolean","description":"Only runs that failed or timed out."}
         }),json!([])),"annotations":{"readOnlyHint":true}},
        {"name":"ci_run","description":format!("One GitHub Actions run: its jobs and steps with their conclusions and, for up to three failed jobs, the check annotations and the log around the first error (timestamps and colours stripped, capped, credentials redacted). Read-only. {CI_REPO_RULE}"),
         "inputSchema":object(json!({"id":{"type":"integer","minimum":1,"description":"The run id from ci_runs."}}),json!(["id"])),"annotations":{"readOnlyHint":true}},
        {"name":"ci_security_alerts","description":format!("Open code-scanning alerts of this repository (CodeQL and other SARIF uploads): rule, severity, file and line, message and link. Read-only; needs code scanning set up and a token that may read it. {CI_REPO_RULE}"),
         "inputSchema":object(json!({
            "ref":{"type":"string","maxLength":200,"description":"Only alerts on this branch (or refs/… ref). Optional."},
            "limit":{"type":"integer","minimum":1,"maximum":100,"description":"How many alerts (default 30)."}
         }),json!([])),"annotations":{"readOnlyHint":true}}
    ])
}

/// The fixed category of a refused or failed call, for the audit ring.
pub fn refusal_reason(reply: &Value) -> Option<&'static str> {
    if reply.get("error").is_some() { return Some("invalid_or_unavailable"); }
    let result = &reply["result"];
    if result["isError"] == true { return Some("invalid_or_unavailable"); }
    let structured = &result["structuredContent"];
    match structured["status"].as_str() {
        Some("refused") | Some("failed") => Some(structured["category"].as_str().and_then(Category::from_str).map(Category::as_str).unwrap_or("invalid_or_unavailable")),
        _ => None,
    }
}

fn sanitize_note(note: Option<String>) -> Result<String, String> {
    let Some(note) = note else { return Ok(String::new()) };
    let clean: String = crate::services::root_mcp_mail::strip_invisible(&note).split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.chars().count() > NOTE_MAX { return Err(format!("invalid_arguments: the note is longer than {NOTE_MAX} characters")); }
    Ok(clean)
}

/// The checks before any work: the arguments must parse, and a `git_push`
/// must be inside the hourly budget and the pending limit. A refused call
/// costs nothing. `Ok` for every other message.
pub fn admit(session: &Session, message: &Value) -> Result<(), String> {
    if message["method"] != "tools/call" { return Ok(()); }
    let name = message["params"]["name"].as_str().unwrap_or_default();
    let args = message["params"].get("arguments").cloned().unwrap_or(json!({}));
    match name {
        "git_push" => {
            let args: PushArgs = serde_json::from_value(args).map_err(|e| format!("invalid_arguments: {e}"))?;
            if let Some(branch) = &args.branch { validate_branch(branch).map_err(|e| format!("invalid_arguments: {e}"))?; }
            sanitize_note(args.note)?;
            // Refused as `window_required` below; a refusal costs nothing.
            if keyring_free() { return Ok(()); }
            let pending = proposals_for(None, Some(&session.identity.tab)).iter().filter(|p| p.kind != Kind::CiRepo && !(p.kind == Kind::Push && p.status == Status::Pending) && matches!(p.status, Status::Pending | Status::Running)).count();
            if pending >= PENDING_LIMIT { return Err(format!("pending_limit: at most {PENDING_LIMIT} pending push requests per tab; cancel one or wait for the user")); }
            if !session.admit_push_rate() { return Err("rate_limited: six push requests per tab per hour".into()); }
            Ok(())
        }
        "git_release" => {
            let args: ReleaseArgs = serde_json::from_value(args).map_err(|e| format!("invalid_arguments: {e}"))?;
            if let Some(tag) = &args.tag { crate::services::git_release::validate_tag(tag).map_err(|e| format!("invalid_arguments: {e}"))?; }
            sanitize_note(args.note)?;
            if keyring_free() { return Ok(()); }
            let pending = proposals_for(None, Some(&session.identity.tab)).iter().filter(|p| p.kind != Kind::CiRepo && !(p.kind == Kind::Release && p.status == Status::Pending) && matches!(p.status, Status::Pending | Status::Running)).count();
            if pending >= PENDING_LIMIT { return Err(format!("pending_limit: at most {PENDING_LIMIT} pending requests per tab; cancel one or wait for the user")); }
            if !session.admit_push_rate() { return Err("rate_limited: six push or release requests per tab per hour".into()); }
            Ok(())
        }
        "ci_runs" | "ci_run" | "ci_security_alerts" => {
            let parsed = match name {
                "ci_runs" => serde_json::from_value::<CiRunsArgs>(args).map(|_| ()),
                "ci_run" => serde_json::from_value::<CiRunArgs>(args).map(|_| ()),
                _ => serde_json::from_value::<CiAlertsArgs>(args).map(|_| ()),
            };
            parsed.map_err(|e| format!("invalid_arguments: {e}"))?;
            if !crate::services::git_ci::admit_rate(&session.identity.tab) { return Err("rate_limited: sixty CI reads per tab per hour".into()); }
            Ok(())
        }
        "git_push_cancel" => serde_json::from_value::<Cancel>(args).map(|_| ()).map_err(|e| format!("invalid_arguments: {e}")),
        "git_push_status" => serde_json::from_value::<Empty>(args).map(|_| ()).map_err(|e| format!("invalid_arguments: {e}")),
        _ => Ok(()),
    }
}

fn admission_result(reason: &str) -> Value {
    let (category, message) = match reason.split_once(": ") {
        Some(("rate_limited", msg)) => (Category::RateLimited, msg.to_string()),
        Some(("pending_limit", msg)) => (Category::PendingLimit, msg.to_string()),
        Some((_, msg)) => (Category::InvalidArguments, msg.to_string()),
        None => (Category::InvalidArguments, reason.to_string()),
    };
    let mut value = json!({"status":"refused","category":category,"message":message,"output":"","state":Value::Null});
    if category == Category::RateLimited { value["retryAfterSecs"] = json!(3600); }
    value
}

fn proposal_view(p: &Proposal) -> Value {
    json!({
        "id": p.id, "kind": p.kind, "tag": p.tag, "repo": p.repo, "status": p.status, "category": p.category, "message": p.message, "output": p.output, "state": p.state,
        "branch": p.branch, "remote": p.remote, "url": p.url, "head": p.head, "remoteSha": p.remote_sha,
        "commits": p.commits, "diffstat": p.diffstat, "note": p.note, "needsUrlConfirm": p.needs_url_confirm,
        "createdAt": p.created_at, "preflightOutput": p.preflight_output,
    })
}

fn tool_result(p: &Proposal) -> Value {
    let mut value = proposal_view(p);
    if p.status == Status::Running {
        value["message"] = json!("Still working (preflight or push); poll git_push_status with this id.");
    }
    value
}

fn call_push(session: &Session, project: &str, dir: &Path, level: Level, args: PushArgs) -> Result<Value, String> {
    let note = sanitize_note(args.note)?;
    if keyring_free() { return Ok(window_required(dir)); }
    if level == Level::Off {
        return Ok(json!({"status":"refused","category":Category::LevelOff,"message":"Agent pushes are off for this project. Ask the user to set the project's agent push level (project pill menu, or Settings → Manage CLIs → Agent pushes) to Propose or Apply.","output":"","state":local_state(dir)}));
    }
    let proposal = new_proposal(session, project, dir, note);
    let id = proposal.id.clone();
    {
        let mut list = proposals().lock_ok();
        prune(&mut list);
        list.push(proposal);
    }
    changed();
    let worker_id = id.clone();
    let requested = args.branch.clone();
    let done = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
    let signal = done.clone();
    std::thread::Builder::new().name("git-push-mcp".into()).spawn(move || {
        run_request(worker_id, level, requested);
        let (flag, cv) = &*signal;
        *flag.lock_ok() = true;
        cv.notify_all();
    }).map_err(|e| e.to_string())?;
    let (flag, cv) = &*done;
    let guard = flag.lock_ok();
    let _ = cv.wait_timeout_while(guard, INLINE_WAIT, |finished| !*finished);
    Ok(get(&id).map(|p| tool_result(&p)).unwrap_or_else(|| json!({"status":"failed","category":Category::NotFound,"message":"The request vanished.","output":"","state":Value::Null})))
}

fn call_release(session: &Session, project: &str, dir: &Path, level: Level, args: ReleaseArgs) -> Result<Value, String> {
    let note = sanitize_note(args.note)?;
    if keyring_free() { return Ok(window_required(dir)); }
    if level == Level::Off {
        return Ok(json!({"status":"refused","category":Category::LevelOff,"message":"Agent pushes and releases are off for this project. Ask the user to set the project's agent push level (project pill menu, or Settings → Manage CLIs → Agent pushes) to Propose or Apply.","output":"","state":local_state(dir)}));
    }
    let mut proposal = new_proposal(session, project, dir, note);
    proposal.kind = Kind::Release;
    proposal.tag = args.tag.clone();
    let id = proposal.id.clone();
    {
        let mut list = proposals().lock_ok();
        prune(&mut list);
        list.push(proposal);
    }
    changed();
    let worker_id = id.clone();
    let done = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
    let signal = done.clone();
    std::thread::Builder::new().name("git-release-mcp".into()).spawn(move || {
        run_release(worker_id, args.tag);
        let (flag, cv) = &*signal;
        *flag.lock_ok() = true;
        cv.notify_all();
    }).map_err(|e| e.to_string())?;
    let (flag, cv) = &*done;
    let guard = flag.lock_ok();
    let _ = cv.wait_timeout_while(guard, INLINE_WAIT, |finished| !*finished);
    Ok(get(&id).map(|p| tool_result(&p)).unwrap_or_else(|| json!({"status":"failed","category":Category::NotFound,"message":"The request vanished.","output":"","state":Value::Null})))
}

/// A CI read's answer: the data, or the failure as a normal result.
fn ci_result(result: Result<Value, Failure>) -> Value {
    match result {
        Ok(mut value) => { value["status"] = json!("ok"); value }
        Err(f) => json!({"status":"failed","category":f.category,"message":f.message,"output":f.output}),
    }
}

fn call_cancel(session: &Session, id: &str) -> Result<Value, String> {
    let Some(p) = get(id).filter(|p| p.tab == session.identity.tab) else {
        return Ok(json!({"status":"refused","category":Category::NotFound,"message":"No such request of this tab.","output":"","state":Value::Null}));
    };
    match p.status {
        Status::Pending => {
            let out = update(id, |p| { p.status = Status::Dismissed; p.category = Some(Category::Dismissed); p.message = "Withdrawn by the agent.".into(); });
            changed();
            Ok(out.map(|p| proposal_view(&p)).unwrap_or(Value::Null))
        }
        Status::Running => Ok(json!({"status":"refused","category":Category::Busy,"message":"The request is running and cannot be withdrawn now.","output":"","state":p.state})),
        _ => Ok(json!({"status":"refused","category":Category::NotFound,"message":"The request is already decided.","output":"","state":p.state})),
    }
}

fn call_status(session: &Session, dir: &Path, policy: &ProjectPolicy) -> Value {
    let rows: Vec<Value> = proposals_for(None, Some(&session.identity.tab)).iter().map(proposal_view).collect();
    json!({"state":local_state(dir),"level":policy.level(),"protected":policy.protected,"allowedBranches":allowed_branches(dir, policy),"urlConfirmed":policy.confirmed_url,"proposals":rows})
}

/// One CI read against a repo [`ci_target`] let through.
fn call_ci(name: &str, target: &crate::services::git_ci::CiRepo, project: &str, args: Value) -> Result<Value, String> {
    match name {
        "ci_runs" => serde_json::from_value::<CiRunsArgs>(args).map_err(|e| e.to_string())
            .map(|a| ci_result(crate::services::git_ci::runs(target, project, a.reference.as_deref(), a.limit, a.failed_only.unwrap_or(false)))),
        "ci_run" => serde_json::from_value::<CiRunArgs>(args).map_err(|e| e.to_string())
            .map(|a| ci_result(crate::services::git_ci::run(target, project, a.id))),
        _ => serde_json::from_value::<CiAlertsArgs>(args).map_err(|e| e.to_string())
            .map(|a| ci_result(crate::services::git_ci::security_alerts(target, project, a.reference.as_deref(), a.limit))),
    }
}

/// The `.git` entry git discovery finds from `dir` — the nearest
/// `<ancestor>/.git` git would stop at — as `(dev, ino)`. Read at spawn into
/// [`PushBinding::git_at_spawn`](crate::services::root_mcp::PushBinding) and again
/// before every push, release and CI read (gap 19): `git_guard` pins only a
/// `.git` that exists at spawn, so an agent can `git init` a repo where there
/// was none, or nearer than the one there was. Bare-repo discovery needs no
/// check: the lane's git runs with `safe.bareRepository=explicit`. Windows
/// has no fence and no stable inode in std, so there it records presence
/// only.
pub(crate) fn git_entry_identity(dir: &Path) -> Option<(u64, u128)> {
    let (dot_git, meta) = dir.ancestors().find_map(|d| {
        let dot_git = d.join(".git");
        git_entry_at(&dot_git).map(|meta| (dot_git, meta))
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let _ = dot_git;
        Some((meta.dev(), u128::from(meta.ino())))
    }
    // Volume and file id: every repo used to read as the same `(0, 0)` here,
    // so a repo made after spawn passed (ci-cd #389). Unreadable: none, refused.
    #[cfg(windows)]
    {
        let _ = meta;
        crate::services::mobile_control::files::file_identity(&dot_git).ok()
    }
}

/// `dot_git` as git discovery counts it. A pointer file always stops git
/// (an invalid one is an error, not a walk upwards). A folder stops it only
/// once it holds `HEAD`, `objects` and `refs`: an empty or half-made `.git`
/// is passed over, as git passes it over, so a `git init` that fills one in
/// after spawn reads as a new repo instead of the same inode. A link counts
/// as what it points at, and its identity is the target's, so re-pointing the
/// link or swapping its target reads as another repo too.
fn git_entry_at(dot_git: &Path) -> Option<std::fs::Metadata> {
    let entry = std::fs::symlink_metadata(dot_git).ok()?;
    let meta = if entry.file_type().is_symlink() { std::fs::metadata(dot_git).ok()? } else { entry };
    if meta.is_dir() && !["HEAD", "objects", "refs"].iter().all(|name| dot_git.join(name).exists()) { return None; }
    Some(meta)
}

/// The `repo_changed` refusal when the tab's git dir is not the one it
/// started with, or it started with none.
fn repo_changed(binding: &crate::services::root_mcp::PushBinding) -> Option<Value> {
    let message = match (binding.git_at_spawn, git_entry_identity(&binding.dir)) {
        (Some(at_spawn), Some(now)) if at_spawn == now => return None,
        (None, _) => "This tab started in a folder with no git repository, and a repository made since is never pushed or read CI for. Ask the user to restart this tab.",
        _ => "The git repository in this folder is not the one this tab started with, so it is not pushed or read CI for. Ask the user to restart this tab.",
    };
    Some(json!({"status":"refused","category":Category::RepoChanged,"message":message,"output":"","state":Value::Null}))
}

/// Returns an RPC reply and whether the proposal views must refresh.
pub fn handle_message(session: &Session, message: &Value) -> (Option<Value>, bool) {
    let admission = admit(session, message);
    handle_admitted(session, message, admission)
}

pub fn handle_admitted(session: &Session, message: &Value, admission: Result<(), String>) -> (Option<Value>, bool) {
    let error = |id: Value, code, text: &str| Some(json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":text}}));
    if message["jsonrpc"] != "2.0" || !message["method"].is_string()
        || message.get("id").is_some_and(|id| !id.is_string() && !id.is_i64() && !id.is_u64())
        || message.get("params").is_some_and(|p| !p.is_object()) {
        return (error(Value::Null, -32600, "invalid request"), false);
    }
    let Some(id) = message.get("id").cloned() else { return (None, false) };
    let ok = |value: Value| Some(json!({"jsonrpc":"2.0","id":id,"result":value}));
    if session.identity.caller != Caller::Pusher || session.check().is_err() { return (error(id, -32000, "access refused"), false); }
    let Some(project) = session.identity.project.as_deref() else { return (error(id, -32000, "missing project"), false) };
    let Some(binding) = session.identity.push.as_ref() else { return (error(id, -32000, "missing project directory"), false) };
    if crate::services::remote::remote_target_for(project).is_some() {
        return (ok(json!({"content":[{"type":"text","text":"not_local"}],"structuredContent":{"status":"refused","category":Category::NotLocal,"message":"Only local projects can be pushed through this lane.","output":"","state":Value::Null},"isError":false})), false);
    }
    match message["method"].as_str().unwrap_or_default() {
        "initialize" => (ok(json!({"protocolVersion":"2025-03-26","capabilities":{"tools":{}},"serverInfo":{"name":SERVER_NAME,"version":env!("CARGO_PKG_VERSION")},"instructions":INSTRUCTIONS})), false),
        "ping" => (ok(json!({})), false),
        "tools/list" => (ok(json!({"tools":tools()})), false),
        "tools/call" => {
            let name = message["params"]["name"].as_str().unwrap_or_default();
            // The keyring-free process (the Mobile host) refuses pushes and
            // releases whatever the project's policy says; arguments first.
            if keyring_free() && admission.is_ok() && matches!(name, "git_push" | "git_release") {
                let value = window_required(&binding.dir);
                return (ok(json!({"content":[{"type":"text","text":value.to_string()}],"structuredContent":value,"isError":false})), false);
            }
            // Gap 19: only the git dir that was there at spawn is pushed or
            // read CI for — never one an agent made or swapped in since.
            if admission.is_ok() && matches!(name, "git_push" | "git_release" | "ci_runs" | "ci_run" | "ci_security_alerts") {
                if let Some(value) = repo_changed(binding) {
                    return (ok(json!({"content":[{"type":"text","text":value.to_string()}],"structuredContent":value,"isError":false})), false);
                }
            }
            let policy = match policy(project) { Ok(p) => p, Err(e) => return (error(id, -32000, &e), false) };
            let args = message["params"].get("arguments").cloned().unwrap_or(json!({}));
            let result: Result<Value, String> = match admission {
                Err(reason) => Ok(admission_result(&reason)),
                Ok(()) => match name {
                    "git_push" => serde_json::from_value(args).map_err(|e| e.to_string()).and_then(|args| call_push(session, project, &binding.dir, policy.level(), args)),
                    "git_release" => serde_json::from_value(args).map_err(|e| e.to_string()).and_then(|args| call_release(session, project, &binding.dir, policy.level(), args)),
                    "ci_runs" | "ci_run" | "ci_security_alerts" => match ci_target(session, project, &binding.dir, &policy, &ci_repos(project)) {
                        Err(refusal) => Ok(refusal),
                        Ok(target) => call_ci(name, &target, project, args),
                    },
                    "git_push_cancel" => serde_json::from_value::<Cancel>(args).map_err(|e| e.to_string()).and_then(|args| call_cancel(session, &args.id)),
                    "git_push_status" => serde_json::from_value::<Empty>(args).map_err(|e| e.to_string()).map(|_| call_status(session, &binding.dir, &policy)),
                    _ => Err("unknown tool".into()),
                },
            };
            let changed = result.as_ref().is_ok_and(|v| matches!(name, "git_push" | "git_release" | "git_push_cancel") || v["category"] == "ci_repo_unconfirmed");
            let value = match result {
                Ok(value) => json!({"content":[{"type":"text","text":value.to_string()}],"structuredContent":value,"isError":false}),
                Err(e) => json!({"content":[{"type":"text","text":e}],"isError":true}),
            };
            (ok(value), changed)
        }
        _ => (error(id, -32601, "method not found"), false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::root_mcp::PushBinding;
    use std::process::Command;

    fn have_git() -> bool { Command::new("git").arg("--version").output().is_ok_and(|o| o.status.success()) }
    fn sh(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git").args(args).current_dir(dir)
            .env("GIT_CONFIG_GLOBAL", "/dev/null").env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_AUTHOR_NAME", "t").env("GIT_AUTHOR_EMAIL", "t@example.invalid").env("GIT_COMMITTER_NAME", "t").env("GIT_COMMITTER_EMAIL", "t@example.invalid")
            .output().expect("git");
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }
    /// A bare "remote", a clone with `origin` and one commit pushed, both
    /// with an author identity in the local config (the hardened command
    /// ignores the ambient one). Returns (root, remote, clone).
    fn pair() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let remote = root.path().join("remote.git");
        let work = root.path().join("work");
        sh(root.path(), &["init", "-q", "--bare", "-b", "main", remote.to_str().unwrap()]);
        sh(root.path(), &["init", "-q", "-b", "main", work.to_str().unwrap()]);
        sh(&work, &["config", "user.name", "t"]);
        sh(&work, &["config", "user.email", "t@example.invalid"]);
        std::fs::write(work.join("a.txt"), "a\n").unwrap();
        sh(&work, &["add", "a.txt"]);
        sh(&work, &["commit", "-q", "-m", "one"]);
        sh(&work, &["remote", "add", "origin", &format!("file://{}", remote.display())]);
        sh(&work, &["push", "-q", "-u", "origin", "main"]);
        sh(&work, &["checkout", "-q", "-b", "develop"]);
        sh(&work, &["push", "-q", "-u", "origin", "develop"]);
        sh(&work, &["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
        (root, remote, work)
    }
    fn commit(work: &Path, name: &str) -> String {
        std::fs::write(work.join(name), format!("{name}\n")).unwrap();
        sh(work, &["add", name]);
        sh(work, &["commit", "-q", "-m", name]);
        sh(work, &["rev-parse", "HEAD"])
    }
    fn session(tab: &str, dir: &Path) -> Session {
        let (_, mut s) = crate::services::root_mcp::test_session_for_tab(Caller::Pusher, tab, Path::new("/nonexistent"));
        s.identity.project = Some("p".into());
        s.identity.push = Some(crate::services::root_mcp::PushBinding { dir: dir.to_path_buf(), fence_scope: None, git_at_spawn: git_entry_identity(dir) });
        s
    }
    fn test_proposal(session: &Session, dir: &Path) -> String {
        let mut p = new_proposal(session, "p", dir, String::new());
        p.session = format!("test-{}", p.session);
        let id = p.id.clone();
        proposals().lock().unwrap().push(p);
        id
    }
    fn set_pending(id: &str, plan: &Plan) {
        update(id, |p| { apply_plan(p, plan); p.status = Status::Pending; });
    }
    fn propose_policy() -> ProjectPolicy { ProjectPolicy { level: Some(Level::Propose), protected: vec![], confirmed_url: None } }

    #[test]
    fn refspec_is_the_approved_sha_onto_one_branch_fast_forward_only() {
        let sha = "0123456789abcdef0123456789abcdef01234567";
        assert_eq!(refspec(sha, "develop").unwrap(), format!("{sha}:refs/heads/develop"));
        assert_eq!(refspec(sha, "feature/x").unwrap(), format!("{sha}:refs/heads/feature/x"));
        let sha256 = "a".repeat(64);
        assert_eq!(refspec(&sha256, "develop").unwrap(), format!("{sha256}:refs/heads/develop"));
        for bad in ["", "+develop", "develop:main", "refs/tags/v1", "v1..v2", "-f", "a b", "a~1", "x.lock", "a@{1}", "*"] {
            assert!(refspec(sha, bad).is_err(), "{bad:?}");
        }
        // Never a name, a short id, an operator or anything but full hex.
        for bad in ["", "develop", "refs/heads/develop", "HEAD", "0123456", &format!("+{}", &sha[1..]), &sha.to_uppercase(), &format!("{sha}0"), &format!("{}:", &sha[..39]), &format!("{}~", &sha[..39])] {
            assert!(refspec(bad, "develop").is_err(), "{bad:?}");
        }
        let spec = refspec(sha, "develop").unwrap();
        assert!(!spec.starts_with('+') && !spec.contains("tags") && !spec.starts_with(':') && !spec.starts_with("refs/"));
    }

    #[test]
    fn protected_branches_are_the_default_and_the_listed_ones() {
        let mut policy = ProjectPolicy::default();
        assert!(is_protected("main", Some("main"), &policy));
        assert!(!is_protected("develop", Some("main"), &policy));
        assert!(is_protected("trunk", Some("trunk"), &policy));
        assert!(!is_protected("main", Some("trunk"), &policy), "the remote's own answer wins");
        assert!(is_protected("main", None, &policy) && is_protected("master", None, &policy), "fallback without a remote answer");
        policy.protected = vec!["release".into()];
        assert!(is_protected("release", Some("main"), &policy));
    }

    #[test]
    fn transport_argv_is_hookless_scoped_and_explicit() {
        let dir = tempfile::tempdir().unwrap();
        let spec = refspec("0123456789abcdef0123456789abcdef01234567", "develop").unwrap();
        let cmd = push_transport_command(dir.path(), "https://github.com/o/r.git", &spec, Some("zzsecretzz"), &["https://github.com".into()]);
        let args: Vec<String> = cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        let joined = args.join(" ");
        assert!(args.windows(2).any(|w| w == ["-c", "core.hooksPath="]), "{joined}");
        assert!(args.contains(&"--no-verify".to_string()));
        assert!(args.windows(2).any(|w| w == ["-c", "credential.helper="]));
        assert_eq!(args.iter().filter(|a| a.starts_with("credential.") && a.contains(".helper=!")).count(), 1);
        assert!(args.iter().any(|a| a.starts_with("credential.https://github.com.helper=!")));
        let push = args.iter().position(|a| a == "push").unwrap();
        assert_eq!(&args[push..], &["push", "--no-verify", "--porcelain", "--", "https://github.com/o/r.git", spec.as_str()]);
        assert!(!joined.contains("zzsecretzz"), "the token is never in argv");
        let env: Vec<(String, Option<String>)> = cmd.get_envs().map(|(k, v)| (k.to_string_lossy().into_owned(), v.map(|v| v.to_string_lossy().into_owned()))).collect();
        assert!(env.contains(&(crate::app_env!("GIT_TOKEN").into(), Some("zzsecretzz".into()))));
        assert!(env.contains(&("GIT_TERMINAL_PROMPT".into(), Some("0".into()))));
        assert!(args.iter().all(|a| !a.starts_with('+') && !a.contains("--tags") && !a.contains("--force")));
    }

    #[test]
    fn output_is_capped_stripped_and_redacted() {
        let long = "x".repeat(OUTPUT_CAP + 100);
        let capped = clean_output(&long, None);
        assert!(capped.starts_with('…') && capped.chars().count() == OUTPUT_CAP + 1);
        assert_eq!(redact("token ghp_abcdefghijklmnop123 and github_pat_11AAAA_bbbb end", None), "token [redacted] and [redacted] end"); // privacy-check: ok — fake test token
        assert_eq!(redact("glpat-xxxxxxxxxxxxxxxxxxxx\n", None), "[redacted]\n"); // privacy-check: ok — fake test token
        assert_eq!(redact("remote: https://x-access-token:ghp_secretsecret@github.com/o/r.git", None), "remote: https://[redacted]@github.com/o/r.git"); // privacy-check: ok — fake test token
        assert_eq!(redact("https://github.com/o/r.git ok", None), "https://github.com/o/r.git ok");
        assert_eq!(redact("the effective one is s3cr3tvalue here", Some("s3cr3tvalue")), "the effective one is [redacted] here");
        assert_eq!(clean_output("a\u{200b}b\x1b[31mc", None), "ab[31mc");
    }

    #[test]
    fn policy_block_is_optional_and_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let projects = dir.path().join("projects.json");
        let raw = r#"[{"id":"p","name":"P","status":"active","position":0,"local_file":"/x/project.json","directory":"/x"}]"#;
        std::fs::write(&projects, raw).unwrap();
        let policy = policy_at(&projects, "p").unwrap();
        assert_eq!(policy, ProjectPolicy::default());
        assert_eq!(policy.level(), Level::Propose, "absent means propose: every agent push waits for a click");
        assert!(policy_at(&projects, "other").is_err());
        let list: crate::schema::projects::ProjectsList = serde_json::from_str(raw).unwrap();
        assert_eq!(serde_json::to_string(&list).unwrap(), raw, "an entry without the block is written back unchanged");
        let block = json!({"level":"propose","protected":["release"],"confirmed_url":"https://github.com/o/r.git"});
        let parsed: ProjectPolicy = serde_json::from_value(block.clone()).unwrap();
        assert_eq!(serde_json::to_value(&parsed).unwrap(), block);
        assert!(serde_json::from_value::<ProjectPolicy>(json!({"level":"propose","remote":"evil"})).is_err(), "no scope selectors sneak in");
        let settings = dir.path().join("settings.json");
        assert!(enabled_in(&settings), "a fresh install has the lane on");
        std::fs::write(&settings, "{}").unwrap();
        assert!(enabled_in(&settings), "absent means on");
        std::fs::write(&settings, r#"{"git_push_mcp":false}"#).unwrap();
        assert!(!enabled_in(&settings));
        std::fs::write(&settings, r#"{"git_push_mcp":true}"#).unwrap();
        assert!(enabled_in(&settings));
        std::fs::write(&settings, "not json").unwrap();
        assert!(!enabled_in(&settings), "unreadable settings answer off");
    }

    #[test]
    fn admission_validates_before_it_spends_budget() {
        let dir = tempfile::tempdir().unwrap();
        let s = session("tab:admit", dir.path());
        let call = |args: Value| json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"git_push","arguments":args}});
        for _ in 0..50 {
            assert!(admit(&s, &call(json!({"branch":"+develop"}))).unwrap_err().starts_with("invalid_arguments"));
            assert!(admit(&s, &call(json!({"remote":"other"}))).unwrap_err().starts_with("invalid_arguments"));
            assert!(admit(&s, &call(json!({"force":true}))).is_err());
            assert!(admit(&s, &call(json!({"note":"n".repeat(201)}))).is_err());
        }
        for _ in 0..6 { assert!(admit(&s, &call(json!({}))).is_ok()); }
        assert!(admit(&s, &call(json!({"note":"one more"}))).unwrap_err().starts_with("rate_limited"));
        assert!(admit(&s, &json!({"jsonrpc":"2.0","id":1,"method":"tools/list"})).is_ok());
        assert!(admit(&s, &json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"git_push_cancel","arguments":{"id":"a","tab":"x"}}})).is_err());
        assert_eq!(admission_result("rate_limited: six push requests per tab per hour")["retryAfterSecs"], 3600);
    }

    /// The Mobile host's lane (`docs/headless_mcp_plan.md`) never reads the
    /// keychain: a push or release answers `window_required` — after argument
    /// checks, before any git, proposal or budget — and nothing is staged.
    #[test]
    fn without_the_keyring_pushes_and_releases_answer_window_required_for_free() {
        let dir = tempfile::tempdir().unwrap();
        let s = session("tab:keyring-free", dir.path());
        let call = |name: &str, args: Value| json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":name,"arguments":args}});
        serve_without_keyring_on_this_thread(true);
        for _ in 0..10 {
            assert!(admit(&s, &call("git_push", json!({}))).is_ok());
            assert!(admit(&s, &call("git_release", json!({}))).is_ok());
        }
        assert!(admit(&s, &call("git_push", json!({"branch":"+develop"}))).unwrap_err().starts_with("invalid_arguments"));
        for level in [Level::Propose, Level::Apply] {
            let push = call_push(&s, "p", dir.path(), level, PushArgs { branch: None, note: Some("ship it".into()) }).unwrap();
            assert_eq!((push["status"].as_str(), push["category"].as_str()), (Some("refused"), Some("window_required")), "{push}");
            assert!(push["message"].as_str().is_some_and(|m| m.contains("restart this tab")), "{push}");
            let release = call_release(&s, "p", dir.path(), level, ReleaseArgs { tag: None, note: None }).unwrap();
            assert_eq!(release["category"], "window_required");
        }
        // Through the RPC as the listener calls it: a normal tool result whose
        // category the audit ring records, nothing marked changed.
        for name in ["git_push", "git_release"] {
            let (reply, changed) = handle_message(&s, &call(name, json!({"note":"ship it"})));
            let reply = reply.expect("a reply");
            assert!(!changed);
            assert_eq!(reply["result"]["isError"], false, "{reply}");
            assert_eq!(reply["result"]["structuredContent"]["category"], "window_required", "{reply}");
            assert_eq!(refusal_reason(&reply), Some("window_required"));
        }
        assert!(proposals_for(None, Some("tab:keyring-free")).is_empty(), "nothing was staged");
        assert_eq!(Category::from_str("window_required"), Some(Category::WindowRequired));
        serve_without_keyring_on_this_thread(false);
        for _ in 0..6 { assert!(admit(&s, &call("git_push", json!({}))).is_ok(), "the refusals cost no budget"); }
    }

    #[test]
    fn a_newly_staged_request_dismisses_the_tabs_older_pending_ones_of_its_kind() {
        let dir = tempfile::tempdir().unwrap();
        let s = session("tab:supersede", dir.path());
        let other = session("tab:supersede-other", dir.path());
        let (old, release, theirs, new) = (test_proposal(&s, dir.path()), test_proposal(&s, dir.path()), test_proposal(&other, dir.path()), test_proposal(&s, dir.path()));
        for id in [&old, &release, &theirs, &new] { update(id, |p| p.status = Status::Pending); }
        update(&release, |p| p.kind = Kind::Release);
        supersede_older(&new);
        let status = |id: &str| get(id).unwrap().status;
        assert_eq!(status(&old), Status::Dismissed);
        assert_eq!(get(&old).unwrap().category, Some(Category::Dismissed));
        assert_eq!((status(&release), status(&theirs), status(&new)), (Status::Pending, Status::Pending, Status::Pending));
        // A pending push never blocks the next push: it is about to be replaced.
        let call = json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"git_push","arguments":{}}});
        let again = test_proposal(&s, dir.path());
        update(&again, |p| p.status = Status::Pending);
        assert!(admit(&s, &call).is_ok());
        proposals().lock().unwrap().retain(|p| !p.tab.starts_with("tab:supersede"));
    }

    #[test]
    fn pending_limit_and_cancel_ownership() {
        let dir = tempfile::tempdir().unwrap();
        let s = session("tab:pending", dir.path());
        let other = session("tab:other", dir.path());
        let a = test_proposal(&s, dir.path());
        let b = test_proposal(&s, dir.path());
        update(&a, |p| { p.kind = Kind::Release; p.status = Status::Pending; });
        update(&b, |p| p.status = Status::Running);
        let call = json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"git_push","arguments":{}}});
        assert!(admit(&s, &call).unwrap_err().starts_with("pending_limit"));
        // Another tab cannot withdraw them, the owner can — once.
        assert_eq!(call_cancel(&other, &a).unwrap()["category"], "not_found");
        assert_eq!(call_cancel(&s, &a).unwrap()["status"], "dismissed");
        assert_eq!(call_cancel(&s, &a).unwrap()["category"], "not_found");
        assert_eq!(call_cancel(&s, &b).unwrap()["category"], "busy");
        assert!(admit(&s, &call).is_ok(), "one pending slot is free again");
        proposals().lock().unwrap().retain(|p| p.tab != "tab:pending");
    }

    #[test]
    fn expiry_and_dead_sessions_are_pruned() {
        let dir = tempfile::tempdir().unwrap();
        let s = session("tab:expiry", dir.path());
        let id = test_proposal(&s, dir.path());
        update(&id, |p| { p.status = Status::Pending; p.created = Instant::now() - RETENTION; });
        let mut list = proposals().lock().unwrap();
        prune(&mut list);
        assert!(list.iter().all(|p| p.id != id), "a day-old proposal is gone");
        drop(list);
        let fresh = test_proposal(&s, dir.path());
        update(&fresh, |p| { p.status = Status::Pending; p.session = "gone".into(); });
        let mut list = proposals().lock().unwrap();
        prune(&mut list);
        assert!(list.iter().all(|p| p.id != fresh), "a proposal of a session without a token is gone");
    }

    #[test]
    fn revoked_and_wrong_class_sessions_are_refused_and_root_registry_never_serves_pusher() {
        let dir = tempfile::tempdir().unwrap();
        let call = json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"git_push_status","arguments":{}}});
        let refused = |s: &Session| {
            let (reply, changed) = handle_message(s, &call);
            assert!(!changed);
            assert_eq!(reply.unwrap()["error"]["message"], "access refused");
        };
        let s = session("tab:revoked", dir.path());
        crate::services::root_mcp::revoke_session(&s.id).unwrap();
        refused(&s);
        let s = session("tab:closed", dir.path());
        assert!(crate::services::root_mcp::revoke_tab(&s.identity.tab));
        refused(&s);
        let (_, root) = crate::services::root_mcp::test_session(Caller::Agent);
        refused(&root);
        let (_, scheduler) = crate::services::root_mcp::test_session(Caller::Scheduler);
        refused(&scheduler);
        for name in crate::services::root_mcp::tool_names() {
            assert!(!crate::services::root_mcp_security::tool(name).unwrap().serves(Caller::Pusher), "{name}");
        }
        for name in tool_names() { assert!(crate::services::root_mcp_security::tool(name).is_none()); }
    }

    #[test]
    fn planning_refuses_what_the_policy_forbids_and_reads_the_remote() {
        if !have_git() { eprintln!("git not on PATH — skipping"); return; }
        let (_root, _remote, work) = pair();
        let policy = propose_policy();
        // Up to date.
        assert_eq!(plan(&work, &policy, None, None, &[]).unwrap_err().category, Category::NothingToPush);
        let head = commit(&work, "b.txt");
        // Another branch than the checked-out one.
        assert_eq!(plan(&work, &policy, Some("main"), None, &[]).unwrap_err().category, Category::NotCheckedOut);
        let p = plan(&work, &policy, Some("develop"), None, &[]).unwrap();
        assert_eq!((p.branch.as_str(), p.head.as_str(), p.commits.len()), ("develop", head.as_str(), 1));
        assert!(p.needs_url_confirm);
        assert_eq!(p.default_branch.as_deref(), Some("main"));
        // The remote's default branch is never pushed.
        sh(&work, &["checkout", "-q", "main"]);
        commit(&work, "c.txt");
        assert_eq!(plan(&work, &policy, None, None, &[]).unwrap_err().category, Category::BranchProtected);
        sh(&work, &["checkout", "-q", "develop"]);
        // A listed branch neither.
        let listed = ProjectPolicy { protected: vec!["develop".into()], ..propose_policy() };
        assert_eq!(plan(&work, &listed, None, None, &[]).unwrap_err().category, Category::BranchProtected);
        // No upstream, missing remote branch.
        sh(&work, &["checkout", "-q", "-b", "topic"]);
        assert_eq!(plan(&work, &policy, None, None, &[]).unwrap_err().category, Category::NoUpstream);
        sh(&work, &["config", "branch.topic.remote", "origin"]);
        sh(&work, &["config", "branch.topic.merge", "refs/heads/topic"]);
        assert_eq!(plan(&work, &policy, None, None, &[]).unwrap_err().category, Category::RemoteBranchMissing);
        sh(&work, &["checkout", "-q", "develop"]);
        // A repo-scope insteadOf cannot pin the destination.
        sh(&work, &["config", "url.https://evil.invalid/.insteadOf", "file://"]);
        assert_eq!(plan(&work, &policy, None, None, &[]).unwrap_err().category, Category::UrlRewritten);
        sh(&work, &["config", "--unset", "url.https://evil.invalid/.insteadOf"]);
        // #2349: a config read git refuses (a FIFO it would block on) is not
        // "no rewrite" — unknown fails closed.
        #[cfg(unix)]
        {
            let fifo = work.join(".git/info/exclude");
            let _ = std::fs::remove_file(&fifo);
            let c = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
            // SAFETY: a valid NUL-terminated path.
            assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o644) }, 0);
            assert!(repo_rewrites_urls(&work));
            std::fs::remove_file(&fifo).unwrap();
            assert!(!repo_rewrites_urls(&work));
        }
        // The remote moved: diverged.
        let other = _root.path().join("other");
        sh(_root.path(), &["clone", "-q", "-b", "develop", &format!("file://{}", _remote.display()), other.to_str().unwrap()]);
        sh(&other, &["config", "user.name", "t"]); sh(&other, &["config", "user.email", "t@example.invalid"]);
        commit(&other, "d.txt");
        sh(&other, &["push", "-q", "origin", "develop"]);
        assert_eq!(plan(&work, &policy, None, None, &[]).unwrap_err().category, Category::Diverged);
        // Detached.
        sh(&work, &["checkout", "-q", "--detach"]);
        assert_eq!(plan(&work, &policy, None, None, &[]).unwrap_err().category, Category::NotCheckedOut);
    }

    #[test]
    fn transport_ignores_pushurl_and_lands_on_the_explicit_url() {
        if !have_git() { eprintln!("git not on PATH — skipping"); return; }
        let (_root, remote, work) = pair();
        let head = commit(&work, "b.txt");
        sh(&work, &["config", "remote.origin.pushurl", "file:///nonexistent/elsewhere.git"]);
        let policy = ProjectPolicy { confirmed_url: Some(format!("file://{}", remote.display())), ..propose_policy() };
        let p = plan(&work, &policy, None, None, &[]).unwrap();
        assert!(!p.needs_url_confirm);
        let output = transport(&work, &p, None, &[]).unwrap();
        assert!(output.contains("refs/heads/develop"), "{output}");
        assert_eq!(sh(&work, &["-C", remote.to_str().unwrap(), "rev-parse", "refs/heads/develop"]), head);
        // Now the remote is ahead of the branch: fast-forward only, no retry.
        sh(&work, &["reset", "-q", "--hard", "HEAD~1"]);
        commit(&work, "e.txt");
        assert_eq!(plan(&work, &policy, None, None, &[]).unwrap_err().category, Category::Diverged);
    }

    #[cfg(unix)]
    #[test]
    fn preflight_gets_gits_arguments_no_token_and_its_commits_are_carried() {
        if !have_git() { eprintln!("git not on PATH — skipping"); return; }
        use std::os::unix::fs::PermissionsExt;
        let (_root, remote, work) = pair();
        commit(&work, "b.txt");
        let hooks = work.join(".githooks");
        std::fs::create_dir_all(&hooks).unwrap();
        let hook = hooks.join("pre-push");
        // Bumps once, like this repo's hook: a second run on its own commit
        // adds nothing. Every run appends what it saw.
        std::fs::write(&hook, concat!("#!/bin/sh\nset -e\nread line\nprintf '%s\\n' \"$1 $2\" \"$line\" \"pf=${", crate::app_upper!(), "_PUSH_PREFLIGHT:-unset}\" \"tok=${", crate::app_upper!(), "_GIT_TOKEN:-unset}\" >> \"$(git rev-parse --git-dir)/seen.txt\"\nif [ ! -e bump.txt ] || [ -n \"${HOOK_ALWAYS:-}\" ]; then date +%s%N >> bump.txt; git add bump.txt; git -c user.name=h -c user.email=h@example.invalid commit -q -m bump; fi\necho 'hook says hi'\nexit ${HOOK_EXIT:-0}\n")).unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        sh(&work, &["config", "core.hooksPath", ".githooks"]);
        assert_eq!(resolve_pre_push_hook(&work).unwrap(), hook);
        let policy = ProjectPolicy { confirmed_url: Some(format!("file://{}", remote.display())), ..propose_policy() };
        let before = plan(&work, &policy, None, None, &[]).unwrap();
        std::env::set_var(crate::app_env!("GIT_TOKEN"), "leak-me-not");
        let (after, output) = preflight(&work, HookBoundary::Host, before.clone()).unwrap();
        std::env::remove_var(crate::app_env!("GIT_TOKEN"));
        assert!(output.contains("hook says hi"), "{output}");
        let seen_file = work.join(".git").join("seen.txt");
        let seen = std::fs::read_to_string(&seen_file).unwrap();
        assert!(seen.contains(&format!("origin file://{}", remote.display())), "{seen}");
        assert!(seen.contains(&format!("refs/heads/develop {} refs/heads/develop {}", before.head, before.remote_sha)), "{seen}");
        assert!(seen.contains("pf=1") && seen.contains("tok=unset") && !seen.contains("tok=leak"), "{seen}");
        assert_ne!(after.head, before.head, "the hook's commit is the new head");
        assert_eq!(after.commits.len(), 2);
        assert_eq!(after.head, sh(&work, &["rev-parse", "HEAD"]));
        // The hook ran again on its own commit: its last stdin line names
        // the SHA the transport pushes.
        let lines: Vec<&str> = seen.lines().filter(|l| l.starts_with("refs/heads/")).collect();
        assert_eq!(lines, [format!("refs/heads/develop {} refs/heads/develop {}", before.head, before.remote_sha), format!("refs/heads/develop {} refs/heads/develop {}", after.head, before.remote_sha)], "{seen}");
        assert_eq!(output.matches("hook says hi").count(), 2, "{output}");
        // A hook that adds a commit on every run is refused, not chased.
        std::fs::remove_file(&seen_file).unwrap();
        std::env::set_var("HOOK_ALWAYS", "1");
        let failure = preflight(&work, HookBoundary::Host, plan(&work, &policy, None, None, &[]).unwrap()).unwrap_err();
        std::env::remove_var("HOOK_ALWAYS");
        assert_eq!(failure.category, Category::PreflightFailed);
        assert!(failure.message.contains("again"), "{}", failure.message);
        assert_eq!(std::fs::read_to_string(&seen_file).unwrap().lines().filter(|l| l.starts_with("refs/heads/")).count(), 2, "run twice, never a third time");
        // Exit 1 refuses with the output.
        std::env::set_var("HOOK_EXIT", "1");
        let failure = preflight(&work, HookBoundary::Host, plan(&work, &policy, None, None, &[]).unwrap()).unwrap_err();
        std::env::remove_var("HOOK_EXIT");
        assert_eq!(failure.category, Category::PreflightFailed);
        assert!(failure.output.contains("hook says hi"));
    }

    /// The hook is agent-writable: one that floods stdout is never read whole
    /// into the main process, only its ends are kept; and a chatty hook that
    /// passes still lets the push go on (its tail is what the card shows).
    #[cfg(unix)]
    #[test]
    fn a_preflight_hook_flooding_stdout_is_kept_to_its_ends() {
        if !have_git() { eprintln!("git not on PATH — skipping"); return; }
        use std::os::unix::fs::PermissionsExt;
        let (_root, remote, work) = pair();
        commit(&work, "b.txt");
        let hooks = work.join(".githooks");
        std::fs::create_dir_all(&hooks).unwrap();
        let hook = hooks.join("pre-push");
        std::fs::write(&hook, format!("#!/bin/sh\nhead -c {} /dev/zero | tr '\\0' x\necho hook-passed\n", LANE_OUTPUT_CAP * 4)).unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        sh(&work, &["config", "core.hooksPath", ".githooks"]);
        let policy = ProjectPolicy { confirmed_url: Some(format!("file://{}", remote.display())), ..propose_policy() };
        let before = plan(&work, &policy, None, None, &[]).unwrap();
        let (_, output) = preflight(&work, HookBoundary::Host, before).map_err(|f| f.message).expect("a passing hook lets the push go on");
        assert!(output.trim_end().ends_with("hook-passed"), "{}", tail(&output, 200));
        assert!(output.len() <= OUTPUT_CAP + 8, "kept {} bytes", output.len());
        // The ends, not the whole: what the lane reads is bounded.
        let mut cmd = std::process::Command::new(&hook);
        let opts = crate::services::git_bounded::Opts { keep_stdout_ends: true, ..lane_opts(None, Duration::from_secs(60)) };
        let ran = crate::services::git_bounded::run(&mut cmd, opts).expect("ran");
        assert!(ran.output.status.success() && !ran.cut);
        assert!(ran.output.stdout.len() as u64 <= LANE_OUTPUT_CAP + 64, "kept {} bytes", ran.output.stdout.len());
    }

    /// Gap 18: the hook is agent-writable, so a Pusher whose binding holds no
    /// fence scope is refused and the hook never runs on the host; a recorded
    /// scope is where the preflight goes, and a fence that cannot run there
    /// refuses too.
    #[cfg(unix)]
    #[test]
    fn a_pusher_with_no_recorded_fence_scope_is_refused_and_its_hook_never_runs() {
        if !have_git() { eprintln!("git not on PATH — skipping"); return; }
        use std::os::unix::fs::PermissionsExt;
        let (_root, remote, work) = pair();
        commit(&work, "b.txt");
        let hooks = work.join(".githooks");
        std::fs::create_dir_all(&hooks).unwrap();
        let hook = hooks.join("pre-push");
        let marker = work.join(".git").join("hook-ran");
        std::fs::write(&hook, format!("#!/bin/sh\ntouch '{}'\n", marker.display())).unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        sh(&work, &["config", "core.hooksPath", ".githooks"]);
        let policy = ProjectPolicy { confirmed_url: Some(format!("file://{}", remote.display())), ..propose_policy() };
        let s = session("tab:unrecorded", &work);
        let id = test_proposal(&s, &work);
        let p = get(&id).unwrap();
        assert_eq!(p.fence_scope, None);
        let failure = preflight(&work, HookBoundary::of(p.fence_scope.as_deref()), plan(&work, &policy, None, None, &[]).unwrap()).unwrap_err();
        assert_eq!(failure.category, Category::FenceUnavailable, "{}", failure.message);
        assert!(!marker.exists(), "the hook ran with no fence scope recorded");
        // A scope the fence cannot build (an unknown one, or no fence on this
        // platform) refuses as well, never falling back to the host.
        let failure = preflight(&work, HookBoundary::Fence("gp-no-such-scope"), plan(&work, &policy, None, None, &[]).unwrap()).unwrap_err();
        assert_eq!(failure.category, Category::FenceUnavailable, "{}", failure.message);
        assert!(!marker.exists());
        proposals().lock().unwrap().retain(|p| p.id != id);
    }

    #[test]
    fn the_proposal_carries_the_fence_scope_its_binding_recorded() {
        let dir = Path::new("/nonexistent/gp-scope");
        let mut s = session("tab:recorded", dir);
        s.identity.push = Some(crate::services::root_mcp::PushBinding { dir: dir.to_path_buf(), fence_scope: Some("p".into()), git_at_spawn: git_entry_identity(dir) });
        let p = new_proposal(&s, "p", dir, String::new());
        assert_eq!(p.fence_scope.as_deref(), Some("p"));
        assert!(matches!(HookBoundary::of(p.fence_scope.as_deref()), HookBoundary::Fence("p")));
        assert!(matches!(HookBoundary::of(None), HookBoundary::Unrecorded));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_fenced_preflight_cannot_write_outside_the_project() {
        if !have_git() { eprintln!("git not on PATH — skipping"); return; }
        if !crate::services::agent_fence::bwrap_available() { eprintln!("bubblewrap unavailable — skipping the fenced preflight test"); return; }
        let home = crate::paths::home_dir();
        let marker = home.join(format!(concat!(".", crate::app_slug!(), "-preflight-marker-{}"), std::process::id()));
        let _ = std::fs::remove_file(&marker);
        let hook = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(hook.path(), format!("#!/bin/sh\ntouch {} 2>/dev/null; echo done\n", marker.display())).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(hook.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        // The scope is the root work dir: a known scope without a project entry.
        let root = crate::storage::root_work_dir();
        let _ = std::fs::create_dir_all(&root);
        let mut cmd = match crate::services::agent_fence::one_shot_command("root", &hook.path().to_string_lossy(), &[], &root) {
            Ok(cmd) => cmd,
            Err(e) => { eprintln!("fence refused ({e}) — skipping"); return; }
        };
        let ran = crate::services::git_bounded::run(&mut cmd, lane_opts(None, Duration::from_secs(30))).expect("bwrap ran");
        assert!(!marker.exists(), "the fenced hook wrote into $HOME: {}", lane_text(&ran.output).1);
        let _ = std::fs::remove_file(&marker);
    }

    #[test]
    fn approval_is_stale_once_the_branch_moves_and_the_first_url_is_confirmed_on_push() {
        if !have_git() { eprintln!("git not on PATH — skipping"); return; }
        let (_root, remote, work) = pair();
        let head = commit(&work, "b.txt");
        let s = session("tab:approve", &work);
        let id = test_proposal(&s, &work);
        let plan = Plan { branch: "develop".into(), remote: "origin".into(), url: format!("file://{}", remote.display()), head: head.clone(),
            remote_sha: sh(&work, &["rev-parse", "origin/develop"]), default_branch: Some("main".into()), commits: vec!["b".into()], diffstat: String::new(), needs_url_confirm: false };
        set_pending(&id, &plan);
        commit(&work, "moved.txt");
        let decided = decide(&id, true).unwrap();
        assert_eq!((decided.status, decided.category), (Status::Failed, Some(Category::StaleApproval)));
        assert_ne!(sh(&work, &["-C", remote.to_str().unwrap(), "rev-parse", "refs/heads/develop"]), head, "nothing was pushed");
        assert!(decide(&id, true).is_err(), "a decided proposal stays decided");
        // Dismiss.
        let id = test_proposal(&s, &work);
        set_pending(&id, &plan);
        assert_eq!(decide(&id, false).unwrap().status, Status::Dismissed);
        // A finished card closes; the record stays for `git_push_status`.
        assert!(clear(&id).unwrap().cleared);
        assert!(proposals_for(None, Some("tab:approve")).iter().any(|p| p.id == id && p.cleared));
        // Approve for real, with the branch where the approval left it.
        let head = sh(&work, &["rev-parse", "HEAD"]);
        let id = test_proposal(&s, &work);
        set_pending(&id, &Plan { head: head.clone(), ..plan.clone() });
        let pushed = decide(&id, true).unwrap();
        assert_eq!((pushed.status, pushed.category), (Status::Pushed, None), "{}", pushed.message);
        assert_eq!(sh(&work, &["-C", remote.to_str().unwrap(), "rev-parse", "refs/heads/develop"]), head);
        assert!(pushed.state.remote_sha.as_deref() == Some(head.as_str()));
    }

    #[test]
    fn a_branch_moved_after_approval_never_sends_the_new_commit() {
        if !have_git() { eprintln!("git not on PATH — skipping"); return; }
        let (_root, remote, work) = pair();
        let approved = commit(&work, "b.txt");
        let remote_sha = sh(&work, &["rev-parse", "origin/develop"]);
        let s = session("tab:moved", &work);
        let id = test_proposal(&s, &work);
        let plan = Plan { branch: "develop".into(), remote: "origin".into(), url: format!("file://{}", remote.display()), head: approved.clone(),
            remote_sha: remote_sha.clone(), default_branch: Some("main".into()), commits: vec!["b".into()], diffstat: String::new(), needs_url_confirm: false };
        set_pending(&id, &plan);
        // The approval check passes; the agent then fast-forwards the branch
        // while the remote is queried, right before the transport.
        let w = work.clone();
        let unseen = Arc::new(Mutex::new(String::new()));
        let slot = unseen.clone();
        BEFORE_TRANSPORT.with(|b| *b.borrow_mut() = Some(Box::new(move || { *slot.lock().unwrap() = commit(&w, "unseen.txt"); })));
        let pushed = decide(&id, true).unwrap();
        let unseen = unseen.lock().unwrap().clone();
        assert_eq!(unseen.len(), 40, "the branch really moved");
        assert_eq!(sh(&work, &["rev-parse", "refs/heads/develop"]), unseen);
        assert_eq!((pushed.status, pushed.category), (Status::Pushed, None), "{}", pushed.message);
        assert_eq!(sh(&work, &["-C", remote.to_str().unwrap(), "rev-parse", "refs/heads/develop"]), approved, "the card's SHA landed");
        let has = |sha: &str| Command::new("git").args(["cat-file", "-e", sha]).current_dir(&remote).output().unwrap().status.success();
        assert!(!has(&unseen), "the commit the card did not list never reached the remote");

        // Apply (no card): the transport sends the SHA its plan validated,
        // not wherever the branch points by then.
        let validated = commit(&work, "c.txt");
        let policy = ProjectPolicy { confirmed_url: Some(format!("file://{}", remote.display())), ..propose_policy() };
        let p = super::plan(&work, &policy, None, None, &[]).unwrap();
        assert_eq!(p.head, validated);
        let later = commit(&work, "later.txt");
        transport(&work, &p, None, &[]).unwrap();
        assert_eq!(sh(&work, &["-C", remote.to_str().unwrap(), "rev-parse", "refs/heads/develop"]), validated);
        assert!(!has(&later));
    }

    #[test]
    fn a_replace_graft_neither_hides_a_commit_nor_fakes_a_fast_forward() {
        if !have_git() { eprintln!("git not on PATH — skipping"); return; }
        let (_root, remote, work) = pair();
        let base = sh(&work, &["rev-parse", "origin/develop"]);
        commit(&work, "hidden.txt");
        let tip = commit(&work, "tip.txt");
        // `refs/replace` is writable in the fence; plain git now skips the
        // hidden commit, while pack-objects would still send it.
        sh(&work, &["replace", "--graft", &tip, &base]);
        assert_eq!(sh(&work, &["log", "--format=%H", &format!("{base}..{tip}")]), tip);
        let p = super::plan(&work, &propose_policy(), None, None, &[]).unwrap();
        assert_eq!(p.commits.len(), 2, "the card lists the hidden commit: {:?}", p.commits);
        assert!(p.commits.iter().any(|c| c.ends_with("hidden.txt")), "{:?}", p.commits);
        sh(&work, &["replace", "-d", &tip]);

        // A graft making a diverged tip look like a fast-forward of the remote.
        sh(&work, &["reset", "-q", "--hard", &base]);
        let theirs = commit(&work, "theirs.txt");
        sh(&work, &["push", "-q", "origin", "develop"]);
        sh(&work, &["reset", "-q", "--hard", &base]);
        let ours = commit(&work, "ours.txt");
        sh(&work, &["replace", "--graft", &ours, &theirs]);
        assert_eq!(super::plan(&work, &propose_policy(), None, None, &[]).unwrap_err().category, Category::Diverged);
        let forced = Plan { branch: "develop".into(), remote: "origin".into(), url: format!("file://{}", remote.display()), head: ours,
            remote_sha: theirs.clone(), default_branch: Some("main".into()), commits: vec![], diffstat: String::new(), needs_url_confirm: false };
        assert!(transport(&work, &forced, None, &[]).is_err(), "the transport refuses the non-fast-forward too");
        assert_eq!(sh(&work, &["-C", remote.to_str().unwrap(), "rev-parse", "refs/heads/develop"]), theirs);
    }

    #[test]
    fn the_rpc_answers_level_off_and_lists_status() {
        if !have_git() { eprintln!("git not on PATH — skipping"); return; }
        let (_root, _remote, work) = pair();
        let s = session("tab:rpc", &work);
        let state = local_state(&work);
        assert_eq!(state.branch.as_deref(), Some("develop"));
        assert_eq!(state.upstream.as_deref(), Some("origin/develop"));
        assert_eq!((state.ahead, state.behind), (0, 0));
        commit(&work, "b.txt");
        assert_eq!(local_state(&work).ahead, 1);
        let off = call_push(&s, "p", &work, Level::Off, PushArgs { branch: None, note: None }).unwrap();
        assert_eq!(off["category"], "level_off");
        assert!(off["message"].as_str().unwrap().contains("Manage CLIs"));
        let status = call_status(&s, &work, &propose_policy());
        assert_eq!(status["level"], "propose");
        assert_eq!(status["allowedBranches"], json!(["develop"]), "main is the default branch");
        assert_eq!(status["state"]["ahead"], 1);
        let reply = handle_message(&s, &json!({"jsonrpc":"2.0","id":7,"method":"tools/list"})).0.unwrap();
        let names: Vec<&str> = reply["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, tool_names());
        for tool in reply["result"]["tools"].as_array().unwrap() {
            for (_, prop) in tool["inputSchema"]["properties"].as_object().unwrap() { assert!(prop["description"].is_string()); }
            assert_eq!(tool["inputSchema"]["additionalProperties"], false);
        }
        let refused = json!({"jsonrpc":"2.0","id":1,"result":{"isError":false,"structuredContent":{"status":"refused","category":"branch_protected"}}});
        assert_eq!(refusal_reason(&refused), Some("branch_protected"));
        assert_eq!(refusal_reason(&json!({"jsonrpc":"2.0","id":1,"result":{"isError":false,"structuredContent":{"status":"pushed"}}})), None);
    }

    fn ci_cards(project: &str) -> Vec<Proposal> {
        proposals_for(Some(project), None).into_iter().filter(|p| p.kind == Kind::CiRepo).collect()
    }

    /// Gap 19 (decision A2): CI is read only for the repo of the confirmed
    /// push URL or one the user allowed on a card; anything else stages one
    /// card per project and repo, outside the push budget, and is refused.
    #[test]
    fn ci_reads_go_only_to_a_confirmed_repo_and_stage_one_card() {
        if !have_git() { eprintln!("git not on PATH — skipping"); return; }
        let (_root, _remote, work) = pair();
        sh(&work, &["remote", "set-url", "origin", "https://github.com/Octo-Org/Some-Repo.git"]);
        let project = "p-ci-gate";
        let s = session("tab:ci-gate", &work);
        let other = session("tab:ci-gate-2", &work);
        for s in [&s, &other] { proposals().lock().unwrap().retain(|p| p.tab != s.identity.tab); }
        // The confirmed push URL's repo passes, compared in lowercase and
        // across git's spellings.
        let confirmed = ProjectPolicy { confirmed_url: Some("git@github.com:octo-org/some-repo".into()), ..propose_policy() };
        let target = ci_target(&s, project, &work, &confirmed, &[]).unwrap();
        assert_eq!((target.owner.as_str(), target.repo.as_str(), target.branch.as_deref()), ("Octo-Org", "Some-Repo", Some("develop")));
        assert!(ci_cards(project).is_empty(), "nothing staged for a confirmed repo");
        // Neither confirmed nor listed: refused, one card.
        let refused = ci_target(&s, project, &work, &propose_policy(), &[]).unwrap_err();
        assert_eq!((refused["status"].as_str(), refused["category"].as_str()), (Some("refused"), Some("ci_repo_unconfirmed")), "{refused}");
        assert!(refused["message"].as_str().unwrap().contains("Allow CI for octo-org/some-repo"), "{refused}");
        let card = refused["requestId"].as_str().unwrap().to_string();
        let cards = ci_cards(project);
        assert_eq!(cards.len(), 1);
        assert_eq!((cards[0].status, cards[0].repo.as_deref(), cards[0].url.as_deref(), cards[0].branch.as_deref()),
            (Status::Pending, Some("octo-org/some-repo"), Some("https://github.com/Octo-Org/Some-Repo.git"), None));
        // Asked again, from this tab or another of the project: the same card.
        assert_eq!(ci_target(&s, project, &work, &propose_policy(), &[]).unwrap_err()["requestId"], card.as_str());
        assert_eq!(ci_target(&other, project, &work, &propose_policy(), &[]).unwrap_err()["requestId"], card.as_str());
        assert_eq!(ci_cards(project).len(), 1, "deduped per project and repo");
        // A confirmed push URL of another repo does not cover this one.
        let elsewhere = ProjectPolicy { confirmed_url: Some("https://github.com/octo-org/other".into()), ..propose_policy() };
        assert!(ci_target(&s, project, &work, &elsewhere, &[]).is_err());
        // A second repo gets its own card; neither counts toward the pending
        // limit of pushes.
        sh(&work, &["remote", "set-url", "origin", "https://github.com/octo-org/second"]);
        let second = ci_target(&s, project, &work, &propose_policy(), &[]).unwrap_err()["requestId"].as_str().unwrap().to_string();
        assert_ne!(second, card);
        for c in ci_cards(project) { update(&c.id, |p| p.session = format!("test-{}", p.session)); }
        let push = json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"git_push","arguments":{}}});
        assert!(admit(&s, &push).is_ok(), "CI cards never fill the pending slots");
        // Dismiss works as for pushes; Allow records the repo and the read goes.
        assert_eq!(decide(&second, false).unwrap().status, Status::Dismissed);
        let mut written = Vec::new();
        let allowed = decide_ci_repo(&get(&card).unwrap(), true, |project, repo| { written.push((project.to_string(), repo.to_string())); Ok(()) }).unwrap();
        assert_eq!((allowed.status, allowed.category), (Status::Allowed, None));
        assert_eq!(written, vec![(project.to_string(), "octo-org/some-repo".to_string())]);
        assert!(decide(&card, true).is_err(), "a decided card stays decided");
        sh(&work, &["remote", "set-url", "origin", "https://github.com/OCTO-ORG/some-repo"]);
        assert!(ci_target(&s, project, &work, &propose_policy(), &["octo-org/some-repo".into()]).is_ok());
        let staged = ci_cards(project).len();
        // Not GitHub: `not_github` as before, no card.
        sh(&work, &["remote", "set-url", "origin", "https://gitlab.com/o/r.git"]);
        let not_github = ci_target(&s, project, &work, &propose_policy(), &[]).unwrap_err();
        assert_eq!(not_github["category"], "not_github", "{not_github}");
        // The Mobile host cannot show a card: refused, nothing staged.
        sh(&work, &["remote", "set-url", "origin", "https://github.com/o/third"]);
        serve_without_keyring_on_this_thread(true);
        let headless = ci_target(&s, project, &work, &propose_policy(), &[]).unwrap_err();
        serve_without_keyring_on_this_thread(false);
        assert_eq!(headless["category"], "ci_repo_unconfirmed");
        assert!(headless.get("requestId").is_none() && headless["message"].as_str().unwrap().contains("restart this tab"), "{headless}");
        assert_eq!(ci_cards(project).len(), staged, "nothing staged without a window");
        assert_eq!(Category::from_str("ci_repo_unconfirmed"), Some(Category::CiRepoUnconfirmed));
        assert_eq!(Category::from_str("repo_changed"), Some(Category::RepoChanged));
        proposals().lock().unwrap().retain(|p| p.project != project);
    }

    /// A release whose CI gate meets an unconfirmed repo stages the same card.
    #[test]
    fn a_release_refused_for_an_unconfirmed_ci_repo_stages_the_card() {
        if !have_git() { eprintln!("git not on PATH — skipping"); return; }
        let (_root, _remote, work) = pair();
        sh(&work, &["remote", "set-url", "origin", "https://github.com/o/released"]);
        let s = session("tab:ci-release", &work);
        let mut base = new_proposal(&s, "p-ci-release", &work, String::new());
        base.session = format!("test-{}", base.session);
        let failure = release_failure(&base, Failure::new(Category::CiRepoUnconfirmed, "x"));
        assert_eq!(failure.category, Category::CiRepoUnconfirmed);
        assert!(failure.message.contains("Allow CI for o/released"), "{}", failure.message);
        assert_eq!(ci_cards("p-ci-release").len(), 1);
        let other = release_failure(&base, Failure::new(Category::NotPushed, "y"));
        assert_eq!((other.category, other.message.as_str()), (Category::NotPushed, "y"), "other refusals pass through");
        proposals().lock().unwrap().retain(|p| p.project != "p-ci-release");
    }

    /// The confirmed-repo list sits beside the policy block, never in it: an
    /// entry without it round-trips unchanged and an old build's strict
    /// policy parse never sees it.
    #[test]
    fn the_ci_repo_list_is_optional_lowercase_and_outside_the_policy_block() {
        let raw = r#"[{"id":"p","name":"P","status":"active","position":0,"local_file":"/x/project.json","git_push_mcp":{"level":"apply"},"directory":"/x"}]"#;
        let mut list: crate::schema::projects::ProjectsList = serde_json::from_str(raw).unwrap();
        assert!(ci_repos_of(&list[0]).is_empty());
        assert_eq!(serde_json::to_value(&list).unwrap(), serde_json::from_str::<Value>(raw).unwrap(), "an entry without the list is written back unchanged");
        add_ci_repo(&mut list[0], "octo-org/some-repo").unwrap();
        add_ci_repo(&mut list[0], "octo-org/some-repo").unwrap();
        assert_eq!(list[0].extra["git_ci_repos"], json!(["octo-org/some-repo"]), "listed once");
        for bad in ["Octo-Org/Some-Repo", "o", "o/r/x", "../r", ""] { assert!(add_ci_repo(&mut list[0], bad).is_err(), "{bad}"); }
        let policy: ProjectPolicy = serde_json::from_value(list[0].extra["git_push_mcp"].clone()).unwrap();
        assert_eq!(policy.level, Some(Level::Apply), "the policy block is untouched and still parses strictly");
        list[0].extra.insert("git_ci_repos".into(), json!(["ok/one", 7, "Upper/Case", "a/b/c"]));
        assert_eq!(ci_repos_of(&list[0]), vec!["ok/one".to_string()], "malformed rows are ignored");
        list[0].extra.insert("git_ci_repos".into(), json!("nonsense"));
        assert!(ci_repos_of(&list[0]).is_empty());
        let none = ProjectPolicy::default();
        assert!(ci_repo_allowed(&none, &["octo-org/some-repo".into()], "ssh://git@github.com/Octo-Org/Some-Repo.git"));
        assert!(!ci_repo_allowed(&none, &[], "https://github.com/octo-org/some-repo"));
        assert!(!ci_repo_allowed(&none, &["octo-org/some-repo".into()], "https://github.com.evil.example/octo-org/some-repo"));
        let confirmed = ProjectPolicy { confirmed_url: Some("https://github.com/Octo-Org/Some-Repo.git".into()), ..ProjectPolicy::default() };
        assert!(ci_repo_allowed(&confirmed, &[], "git@github.com:octo-org/some-repo"));
        assert!(!ci_repo_allowed(&confirmed, &[], "git@github.com:octo-org/some-repo-2"));
    }

    /// Gap 19 defence in depth: a git dir made (or a nearer one planted)
    /// after the tab started is refused as `repo_changed` before any push,
    /// release or CI read; the one there at spawn passes.
    #[test]
    fn a_repo_made_after_spawn_is_refused_for_push_release_and_ci() {
        if !have_git() { eprintln!("git not on PATH — skipping"); return; }
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let s = session("tab:repo-changed", &project);
        let binding = s.identity.push.clone().unwrap();
        sh(&project, &["init", "-q", "-b", "main"]);
        sh(&project, &["remote", "add", "origin", "https://github.com/someone/private"]);
        assert_ne!(binding.git_at_spawn, git_entry_identity(&project), "the new .git is another entry");
        let call = |name: &str, args: Value| json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":name,"arguments":args}});
        for (name, args) in [("git_push", json!({})), ("git_release", json!({})), ("ci_runs", json!({})), ("ci_run", json!({"id":1})), ("ci_security_alerts", json!({}))] {
            let (reply, changed) = handle_message(&s, &call(name, args));
            let reply = reply.unwrap();
            assert!(!changed);
            assert_eq!(reply["result"]["structuredContent"]["category"], "repo_changed", "{name}: {reply}");
            assert!(reply["result"]["structuredContent"]["message"].as_str().unwrap().contains("restart this tab"));
            assert_eq!(refusal_reason(&reply), Some("repo_changed"));
        }
        assert!(proposals_for(None, Some("tab:repo-changed")).is_empty(), "nothing staged");
        // A tab started with that repo: it passes, until a nearer one appears.
        let started = session("tab:repo-same", &project);
        assert!(repo_changed(started.identity.push.as_ref().unwrap()).is_none());
        let sub = project.join("sub");
        std::fs::create_dir(&sub).unwrap();
        let in_sub = session("tab:repo-sub", &sub);
        let sub_binding = in_sub.identity.push.clone().unwrap();
        assert_eq!(sub_binding.git_at_spawn, git_entry_identity(&project), "discovery walks up");
        assert!(repo_changed(&sub_binding).is_none());
        sh(&sub, &["init", "-q"]);
        assert_eq!(repo_changed(&sub_binding).unwrap()["category"], "repo_changed", "a nearer .git planted after spawn");
        // No git dir at spawn and none now: still refused.
        let bare = PushBinding { dir: root.path().join("none"), fence_scope: None, git_at_spawn: None };
        assert_eq!(repo_changed(&bare).unwrap()["category"], "repo_changed");
    }

    /// Reviewer, gap 19: an empty `.git` folder at spawn is not a repo to git,
    /// and `git init` fills it in place (same inode). Discovery passes over it
    /// at spawn, so the repo made in it afterwards is refused. A `.git` link
    /// counts as its target: swapping what it names is another repo.
    #[test]
    fn a_git_init_into_an_empty_dot_git_after_spawn_is_refused() {
        if !have_git() { eprintln!("git not on PATH — skipping"); return; }
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        std::fs::create_dir_all(project.join(".git")).unwrap();
        let s = session("tab:empty-dot-git", &project);
        let binding = s.identity.push.clone().unwrap();
        assert_eq!(binding.git_at_spawn, git_entry_identity(root.path()), "an empty .git is passed over, as git does");
        sh(&project, &["init", "-q", "-b", "main"]);
        assert!(git_entry_identity(&project).is_some());
        assert_eq!(repo_changed(&binding).unwrap()["category"], "repo_changed", "the repo filled into the empty .git is new");
        let started = session("tab:filled-dot-git", &project);
        assert!(repo_changed(started.identity.push.as_ref().unwrap()).is_none(), "a tab started with it keeps it");

        #[cfg(unix)]
        {
            let linked = root.path().join("linked");
            std::fs::create_dir(&linked).unwrap();
            let (one, two) = (root.path().join("one"), root.path().join("two"));
            for target in [&one, &two] {
                std::fs::create_dir(target).unwrap();
                sh(target, &["init", "-q", "-b", "main"]);
            }
            std::os::unix::fs::symlink(one.join(".git"), linked.join(".git")).unwrap();
            let s = session("tab:linked-dot-git", &linked);
            let binding = s.identity.push.clone().unwrap();
            assert_eq!(binding.git_at_spawn, git_entry_identity(&one), "a link counts as its target");
            assert!(repo_changed(&binding).is_none());
            // The link stays; the folder it names is swapped for another repo.
            std::fs::rename(one.join(".git"), one.join(".git-old")).unwrap();
            std::fs::rename(two.join(".git"), one.join(".git")).unwrap();
            assert_eq!(repo_changed(&binding).unwrap()["category"], "repo_changed", "a swapped link target is another repo");
        }
    }
}
