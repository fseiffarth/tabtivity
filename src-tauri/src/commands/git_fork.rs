//! Forking a hosted repository into the user's own account, then cloning the
//! fork — the import dialog's "Fork a GitHub/GitLab repository" source.
//!
//! This is deliberately *not* a clone with a different name. A clone of someone
//! else's repository has an `origin` nobody can push to; a fork gives the user a
//! repository of their own to push to, with the original kept as `upstream` so
//! the history can still be followed (and a pull request opened). So the flow is
//! three steps, in this order:
//!
//!   1. **fork** — `gh api -X POST repos/<owner>/<repo>/forks` / `glab api -X
//!      POST projects/<path>/fork`. The provider CLIs are used the way
//!      `git_publish` uses them (same `Provider`, same token env, same "the CLI
//!      owns the auth" bargain) — but through their raw `api` subcommand rather
//!      than `repo fork`, because the response JSON *names the fork*: neither
//!      CLI's `repo fork --clone` can be pointed at a destination directory, and
//!      guessing the fork's URL from the user's login is wrong the moment a fork
//!      lands in a different namespace or under a different name.
//!   2. **clone** — the fork's URL through `git::git_clone_blocking`, so a fork
//!      import inherits the ordinary clone's URL whitelist, token credential
//!      helper, prompt-disabling and partial-directory cleanup unchanged.
//!   3. **upstream** — `git remote add upstream <original url>`, best-effort:
//!      the tree is already on disk by then, and failing the whole import over a
//!      second remote would leave a cloned directory with no project behind it.
//!
//! Forking is asynchronous on both services (GitHub answers 202 before the fork
//! exists; GitLab reports an `import_status`), which is why the clone is retried
//! on the "no such repository yet" class of failure instead of once.

use std::time::Duration;

use serde_json::Value;

use crate::commands::git::validate_clone_url;
use crate::commands::git_publish::Provider;

/// How many times the clone of a freshly created fork is attempted, and how long
/// to wait between attempts. A fork is created asynchronously, so the first
/// clone can legitimately hit a repository that does not exist yet; only that
/// class of failure is retried (an auth failure fails on the first attempt).
const CLONE_ATTEMPTS: usize = 5;
const CLONE_RETRY_DELAY: Duration = Duration::from_secs(3);

/// A hosted repository, as read out of a clone/browser URL.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct RepoRef {
    /// Host only — no userinfo, no port.
    pub host: String,
    /// Namespace + repository, `.git` stripped: `owner/repo`, or a nested
    /// GitLab group path like `group/sub/repo`.
    pub path: String,
    /// The URL asked for SSH transport (`git@host:…`, `ssh://…`), so the fork is
    /// cloned over SSH too rather than silently switching the user to https.
    pub ssh: bool,
}

impl RepoRef {
    /// The repository's own name (last path segment).
    fn name(&self) -> &str {
        self.path.rsplit('/').next().unwrap_or(&self.path)
    }
}

/// Read `host` + `owner/repo` out of any clone URL form we accept. The URL has
/// already passed `validate_clone_url`; this only has to understand it.
pub(crate) fn parse_repo_url(raw: &str) -> Result<RepoRef, String> {
    let url = raw.trim();
    let reject = || format!("Could not read an owner/repository out of '{url}'");

    let (authority, path, ssh) = if let Some(scheme_end) = url.find("://") {
        let scheme = url[..scheme_end].to_ascii_lowercase();
        let rest = &url[scheme_end + 3..];
        let slash = rest.find('/').ok_or_else(reject)?;
        (
            &rest[..slash],
            &rest[slash + 1..],
            scheme == "ssh" || scheme == "git",
        )
    } else {
        // scp-like `[user@]host:path`.
        let colon = url.find(':').ok_or_else(reject)?;
        (&url[..colon], &url[colon + 1..], true)
    };

    // Strip userinfo and port off the authority; strip a leading slash, a
    // trailing slash and a trailing `.git` off the path.
    let host = authority.rsplit('@').next().unwrap_or(authority);
    let host = host.split(':').next().unwrap_or(host).to_ascii_lowercase();
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);

    if host.is_empty() || path.is_empty() || !path.contains('/') {
        return Err(reject());
    }
    Ok(RepoRef {
        host,
        path: path.to_string(),
        ssh,
    })
}

/// Which provider a host is, when the hostname says so. A self-hosted instance
/// usually doesn't, which is why the dialog also offers an explicit choice.
pub(crate) fn provider_from_host(host: &str) -> Option<Provider> {
    let host = host.to_ascii_lowercase();
    if host == "github.com" || host.contains("github") {
        Some(Provider::GitHub)
    } else if host == "gitlab.com" || host.contains("gitlab") {
        Some(Provider::GitLab)
    } else {
        None
    }
}

/// Percent-encode a GitLab project path for use as the `:id` path segment
/// (`group/sub/repo` → `group%2Fsub%2Frepo`). Only the separator needs encoding;
/// everything else a GitLab path may contain (`a-z0-9_.-`) is already safe.
fn encode_project_id(path: &str) -> String {
    path.replace('/', "%2F")
}

/// Whether the provider's CLI (`gh` / `glab`) is on `PATH`. The import dialog
/// asks before offering the fork source, so a missing CLI surfaces as an install
/// prompt rather than as a failed fork after the user filled the form in. Also
/// used by the publish flow (`commands::git_publish`) for the same reason —
/// publishing to a fresh GitHub/GitLab repo shells out to this same CLI.
/// The probe spawns a process, so it runs on a worker, never the window's thread.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn provider_cli_available(provider: String) -> Result<bool, String> {
    let provider = Provider::parse(&provider)?;
    app_core::rt::blocking("git", move || {
        crate::paths::command_no_window(provider.cli())
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    })
    .await
}

/// What a completed fork import reports back: where the tree landed, and the
/// fork it was cloned from (so the caller can name it).
#[derive(serde::Serialize)]
pub struct ForkResult {
    /// The directory the fork was cloned into (= `dest`).
    pub dir: String,
    /// The fork's full path on the host, e.g. `me/repo`.
    pub fork: String,
    /// The URL the fork was cloned from.
    pub url: String,
}

/// Fork `url` into the user's own account, clone the fork into `dest`, and wire
/// the original repository as the `upstream` remote.
///
/// `provider` is "github"/"gitlab", or empty to infer it from the URL's host
/// (which only works for a host that names itself — a self-hosted instance must
/// be told). Auth is the provider CLI's own (`gh auth login` / `glab auth
/// login`), with the global access token from Settings → Git Hosting passed
/// through its env var when one is stored.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn git_fork_clone(
    url: String,
    dest: String,
    provider: Option<String>,
) -> Result<ForkResult, String> {
    app_core::rt::try_blocking("git", move || fork_clone_blocking(url, dest, provider)).await
}

fn fork_clone_blocking(
    url: String,
    dest: String,
    provider: Option<String>,
) -> Result<ForkResult, String> {
    let url = url.trim().to_string();
    validate_clone_url(&url)?;
    let repo = parse_repo_url(&url)?;

    let requested = provider.unwrap_or_default();
    let provider = if requested.trim().is_empty() {
        provider_from_host(&repo.host).ok_or_else(|| {
            format!(
                "Could not tell whether '{}' is GitHub or GitLab — choose the host type.",
                repo.host
            )
        })?
    } else {
        Provider::parse(&requested)?
    };

    let fork = create_fork(provider, &repo)?;

    // Prefer the transport the user asked for: an ssh URL in, an ssh URL out.
    let clone_url = if repo.ssh && !fork.ssh_url.is_empty() {
        fork.ssh_url.clone()
    } else if !fork.http_url.is_empty() {
        fork.http_url.clone()
    } else {
        fork.ssh_url.clone()
    };
    if clone_url.is_empty() {
        return Err(format!(
            "{} created the fork but reported no clone URL for it",
            provider.cli()
        ));
    }

    clone_with_retry(&clone_url, &dest)?;

    // Best-effort: the tree is on disk already, so a missing `upstream` is worth
    // less than the import it would otherwise abort.
    let _ = crate::services::git_bounded::BoundedOutput::bounded_output(
        &mut crate::commands::git::hardened_git_command_in(&dest, &["remote", "add", "upstream", &url]),
    );

    Ok(ForkResult {
        dir: dest,
        fork: fork.full_path,
        url: clone_url,
    })
}

/// The fork, as the provider reported it.
struct Fork {
    full_path: String,
    http_url: String,
    ssh_url: String,
}

fn create_fork(provider: Provider, repo: &RepoRef) -> Result<Fork, String> {
    match provider {
        Provider::GitHub => {
            // GitHub answers an already-existing fork with the existing one, so
            // there is no conflict case to handle here.
            let json = provider_api(
                provider,
                repo,
                &["-X", "POST", &format!("repos/{}/forks", repo.path)],
            )?;
            Ok(github_fork(&json))
        }
        Provider::GitLab => {
            let id = encode_project_id(&repo.path);
            match provider_api(
                provider,
                repo,
                &["-X", "POST", &format!("projects/{id}/fork")],
            ) {
                Ok(json) => Ok(gitlab_fork(&json)),
                // GitLab refuses a second fork into the same namespace ("has
                // already been taken"). That is the *success* state for an
                // import — the user's fork exists — so look it up instead of
                // reporting a name clash they cannot act on.
                Err(e) if is_already_forked(&e) => existing_gitlab_fork(repo).map_err(|_| e),
                Err(e) => Err(e),
            }
        }
    }
}

fn github_fork(json: &Value) -> Fork {
    Fork {
        full_path: string_field(json, "full_name"),
        http_url: string_field(json, "clone_url"),
        ssh_url: string_field(json, "ssh_url"),
    }
}

fn gitlab_fork(json: &Value) -> Fork {
    Fork {
        full_path: string_field(json, "path_with_namespace"),
        http_url: string_field(json, "http_url_to_repo"),
        ssh_url: string_field(json, "ssh_url_to_repo"),
    }
}

/// GitLab's "you already forked this" refusal, in the wordings it comes in.
fn is_already_forked(err: &str) -> bool {
    let lower = err.to_ascii_lowercase();
    lower.contains("already been taken")
        || lower.contains("already exists")
        || lower.contains("name has already")
}

/// Resolve the fork the user already has: their own namespace + the repository's
/// name, which is where `POST /fork` would have put it.
fn existing_gitlab_fork(repo: &RepoRef) -> Result<Fork, String> {
    let user = provider_api(Provider::GitLab, repo, &["user"])?;
    let login = string_field(&user, "username");
    if login.is_empty() {
        return Err("glab did not report the logged-in user".to_string());
    }
    let id = encode_project_id(&format!("{login}/{}", repo.name()));
    let json = provider_api(Provider::GitLab, repo, &[&format!("projects/{id}")])?;
    Ok(gitlab_fork(&json))
}

/// Run the provider CLI's `api` subcommand and parse its JSON response.
///
/// The CLI authenticates itself; the stored global token is passed through its
/// env var (never argv) when set, and a non-default host is pointed at through
/// the CLI's own host env var so a self-hosted instance works.
fn provider_api(provider: Provider, repo: &RepoRef, args: &[&str]) -> Result<Value, String> {
    let mut cmd = crate::paths::command_no_window(provider.cli());
    cmd.arg("api").args(args);
    if let Some(tok) = crate::commands::git_hosting::global_git_token() {
        cmd.env(provider.token_env(), tok);
    }
    if !provider.is_default_host(&repo.host) {
        cmd.env(provider.host_env(), &repo.host);
    }

    let out = cmd
        .output()
        .map_err(|e| format!("failed to run {}: {e}", provider.cli()))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let raw = if stderr.is_empty() { stdout } else { stderr };
        return Err(api_error(provider, &raw));
    }
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    serde_json::from_str(&stdout)
        .map_err(|e| format!("could not read {}'s response: {e}", provider.cli()))
}

/// Turn the CLI's own failure into the sentence that says what to do about it.
/// "not logged in" is by far the most common one, and the CLI's own wording for
/// it doesn't mention the fork the user was trying to make.
fn api_error(provider: Provider, raw: &str) -> String {
    let lower = raw.to_ascii_lowercase();
    let cli = provider.cli();
    if lower.contains("not logged") || lower.contains("authentication") || lower.contains("401") {
        return format!(
            "{}\n\nForking uses the {cli} CLI's own login — run `{cli} auth login` (or store an access token in Settings → Git Hosting).",
            raw.trim()
        );
    }
    if lower.contains("404") || lower.contains("not found") {
        return format!(
            "{}\n\nThe repository was not found — check the URL, and that your {cli} login can see it if it is private.",
            raw.trim()
        );
    }
    raw.trim().to_string()
}

/// Clone the fork, retrying only the "it isn't there yet" failure: a fork is
/// created asynchronously, so the repository can legitimately 404 for a few
/// seconds after the API call returned. Any other failure (auth, disk) is final
/// on the first attempt — retrying it would only make the dialog hang.
fn clone_with_retry(clone_url: &str, dest: &str) -> Result<(), String> {
    let mut last = String::new();
    for attempt in 0..CLONE_ATTEMPTS {
        match crate::commands::git::git_clone_blocking(clone_url.to_string(), dest.to_string()) {
            Ok(_) => return Ok(()),
            Err(e) => {
                if !fork_not_ready(&e) {
                    return Err(e);
                }
                last = e;
                if attempt + 1 < CLONE_ATTEMPTS {
                    std::thread::sleep(CLONE_RETRY_DELAY);
                }
            }
        }
    }
    Err(format!(
        "{last}\n\nThe fork was created but is not clonable yet — try importing it again in a moment."
    ))
}

/// Whether a clone failure reads as "the fork has not materialized yet".
fn fork_not_ready(err: &str) -> bool {
    let lower = err.to_ascii_lowercase();
    lower.contains("repository not found")
        || lower.contains("not found")
        || lower.contains("does not appear to be a git repository")
        || lower.contains("could not read from remote repository")
}

fn string_field(json: &Value, key: &str) -> String {
    json.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_https_urls() {
        let r = parse_repo_url("https://github.com/owner/repo.git").unwrap();
        assert_eq!(r.host, "github.com");
        assert_eq!(r.path, "owner/repo");
        assert!(!r.ssh);
        assert_eq!(r.name(), "repo");
    }

    #[test]
    fn parses_browser_url_with_trailing_slash_and_nested_groups() {
        let r = parse_repo_url("https://gitlab.com/group/sub/repo/").unwrap();
        assert_eq!(r.host, "gitlab.com");
        assert_eq!(r.path, "group/sub/repo");
        assert_eq!(r.name(), "repo");
    }

    #[test]
    fn parses_scp_like_and_ssh_urls_as_ssh() {
        let scp = parse_repo_url("git@github.com:owner/repo.git").unwrap();
        assert_eq!(scp.host, "github.com");
        assert_eq!(scp.path, "owner/repo");
        assert!(scp.ssh);

        let ssh = parse_repo_url("ssh://git@gitlab.example.org:2222/owner/repo.git").unwrap();
        assert_eq!(ssh.host, "gitlab.example.org");
        assert_eq!(ssh.path, "owner/repo");
        assert!(ssh.ssh);
    }

    #[test]
    fn rejects_urls_with_no_owner() {
        // A fork needs a namespace + repository; a bare repo path is not one.
        assert!(parse_repo_url("https://github.com/repo.git").is_err());
        assert!(parse_repo_url("git@host:repo.git").is_err());
    }

    #[test]
    fn detects_provider_from_host_only_when_it_says_so() {
        assert!(matches!(
            provider_from_host("github.com"),
            Some(Provider::GitHub)
        ));
        assert!(matches!(
            provider_from_host("gitlab.example.org"),
            Some(Provider::GitLab)
        ));
        // A self-hosted instance that doesn't name itself must be told.
        assert!(provider_from_host("git.internal").is_none());
    }

    #[test]
    fn encodes_nested_gitlab_paths() {
        assert_eq!(encode_project_id("group/sub/repo"), "group%2Fsub%2Frepo");
        assert_eq!(encode_project_id("owner/repo"), "owner%2Frepo");
    }

    #[test]
    fn reads_provider_fork_payloads() {
        let gh = serde_json::json!({
            "full_name": "me/repo",
            "clone_url": "https://github.com/me/repo.git",
            "ssh_url": "git@github.com:me/repo.git",
        });
        let f = github_fork(&gh);
        assert_eq!(f.full_path, "me/repo");
        assert_eq!(f.http_url, "https://github.com/me/repo.git");
        assert_eq!(f.ssh_url, "git@github.com:me/repo.git");

        let gl = serde_json::json!({
            "path_with_namespace": "me/repo",
            "http_url_to_repo": "https://gitlab.com/me/repo.git",
            "ssh_url_to_repo": "git@gitlab.com:me/repo.git",
        });
        let f = gitlab_fork(&gl);
        assert_eq!(f.full_path, "me/repo");
        assert_eq!(f.http_url, "https://gitlab.com/me/repo.git");
    }

    #[test]
    fn already_forked_is_recognized_not_reported() {
        assert!(is_already_forked("Path has already been taken"));
        assert!(is_already_forked("name has already been taken"));
        assert!(!is_already_forked("404 Project Not Found"));
    }

    #[test]
    fn only_the_not_yet_there_clone_failure_is_retried() {
        assert!(fork_not_ready("remote: Repository not found."));
        assert!(fork_not_ready(
            "fatal: 'x' does not appear to be a git repository"
        ));
        // An auth failure must fail on the first attempt, not after 5 waits.
        assert!(!fork_not_ready(
            "fatal: Authentication failed for 'https://…'"
        ));
        assert!(!fork_not_ready(
            "Destination '/tmp/x' already exists and is not empty"
        ));
    }

    #[test]
    fn api_error_names_the_cli_login() {
        let msg = api_error(Provider::GitHub, "gh: not logged into any GitHub hosts");
        assert!(msg.contains("gh auth login"));
        let msg = api_error(Provider::GitLab, "404 Project Not Found");
        assert!(msg.contains("not found"));
        // An unrecognized failure is passed through as-is.
        assert_eq!(api_error(Provider::GitHub, "disk full"), "disk full");
    }
}
