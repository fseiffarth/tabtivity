//! Read-only CI for the `tabtivity-git` lane (`services::git_push_mcp`): a
//! fenced agent reads why a GitHub Actions run — the build, the tests, the
//! security workflow — failed, and which code-scanning alerts are open,
//! without the token entering its sandbox. Tabtivity asks api.github.com from the
//! host and hands back capped, redacted text. `docs/context/git_push_mcp.md`.
//! AppHandle-free.
//!
//! GitHub only. The repository is the checked-out branch's upstream URL (else
//! `origin`) — never an argument, so an agent reads only the repo it is
//! working in. The stored token is offered to the API only when github.com is
//! one of the project's token origins; without one, a public repo still
//! answers its runs, and anything else says where to add a token. Nothing here
//! writes: no re-run, no cancel, no dispatch.
use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::git_push_mcp::{git, redact, tail, Category, Failure};

const API: &str = "https://api.github.com";
/// Reads per tab per rolling hour — well inside GitHub's own 5000/h.
const CI_RATE: usize = 60;
/// How much of a job log is downloaded at most (the tail is kept).
const LOG_DOWNLOAD_CAP: usize = 32 * 1024 * 1024;
/// What of it is kept in memory while reading: the last 4 MB.
const LOG_WINDOW: usize = 4 * 1024 * 1024;
/// The excerpt one failed job contributes to the answer.
const EXCERPT_CAP: usize = 12 * 1024;
/// Failed jobs whose logs are read per `ci_run`.
const LOG_JOBS: usize = 3;
const TEXT_CAP: usize = 600;

/// `owner/repo` of a github.com remote URL in any of git's spellings.
pub fn github_repo(url: &str) -> Option<(String, String)> {
    let url = url.trim();
    let lower = url.to_ascii_lowercase();
    let path = ["https://github.com/", "http://github.com/", "ssh://git@github.com/", "git@github.com:", "ssh://github.com/", "git://github.com/"]
        .iter()
        .find(|prefix| lower.starts_with(*prefix))
        .map(|prefix| &url[prefix.len()..])?;
    let path = path.trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let mut parts = path.split('/');
    let (owner, repo) = (parts.next()?, parts.next()?);
    let plain = |s: &str| !s.is_empty() && s.len() <= 100 && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')) && !s.starts_with('.');
    (parts.next().is_none() && plain(owner) && plain(repo)).then(|| (owner.to_string(), repo.to_string()))
}

/// The repository this checkout pushes to, and the checked-out branch.
fn repo_of(dir: &Path) -> Result<(String, String, Option<String>), Failure> {
    let branch = git(dir, &["symbolic-ref", "--short", "-q", "HEAD"]).ok().filter(|b| !b.is_empty());
    let remote = branch.as_deref()
        .and_then(|b| git(dir, &["config", "--get", &format!("branch.{b}.remote")]).ok())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "origin".into());
    let url = git(dir, &["config", "--get", &format!("remote.{remote}.url")]).ok().filter(|s| !s.is_empty())
        .ok_or_else(|| Failure::new(Category::NoUpstream, format!("remote '{remote}' has no URL, so there is no CI to read.")))?;
    let (owner, repo) = github_repo(&url)
        .ok_or_else(|| Failure::new(Category::NotGithub, "CI can be read for GitHub repositories only, and this remote is not on github.com."))?;
    Ok((owner, repo, branch))
}

/// The token for api.github.com: only when github.com is one of the
/// project's token origins (`git_hosting::token_origins`).
fn api_token(project: &str) -> Option<String> {
    let (token, origins) = super::git_push_mcp::creds(project);
    token.filter(|_| origins.iter().any(|o| o == "https://github.com"))
}

/// Per-tab budget, taken at admission.
pub fn admit_rate(tab: &str) -> bool {
    static CALLS: OnceLock<Mutex<HashMap<String, VecDeque<Instant>>>> = OnceLock::new();
    let mut map = CALLS.get_or_init(Default::default).lock().unwrap_or_else(|p| p.into_inner());
    let calls = map.entry(tab.to_string()).or_default();
    calls.retain(|at| at.elapsed() < Duration::from_secs(3600));
    if calls.len() >= CI_RATE { return false; }
    calls.push_back(Instant::now());
    true
}

// ── HTTP ────────────────────────────────────────────────────────────────────

fn client() -> Result<reqwest::Client, Failure> {
    // `reqwest` is built with `rustls-no-provider`; see `app_update::client`.
    crate::services::mail_engine::install_crypto_provider();
    reqwest::Client::builder()
        .user_agent(crate::brand::user_agent())
        .timeout(Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| Failure::new(Category::TransportFailed, e.to_string()))
}

/// Run `fut` to completion from the blocking worker the lane's handler runs
/// on (`spawn_blocking`), or on a private runtime where there is none.
fn block_on<F: std::future::Future>(fut: F) -> Result<F::Output, Failure> {
    match tokio::runtime::Handle::try_current() {
        Ok(handle) => Ok(handle.block_on(fut)),
        Err(_) => tokio::runtime::Builder::new_current_thread().enable_all().build()
            .map(|rt| rt.block_on(fut))
            .map_err(|e| Failure::new(Category::TransportFailed, e.to_string())),
    }
}

fn status_failure(status: reqwest::StatusCode, body: &str, have_token: bool) -> Failure {
    let lower = body.to_ascii_lowercase();
    match status.as_u16() {
        401 => Failure::new(Category::AuthFailed, "GitHub refused the stored token. Ask the user to check it in Settings → Git Hosting."),
        403 | 429 if lower.contains("rate limit") => Failure::new(Category::RateLimited, "GitHub's API rate limit is used up; try again later."),
        403 | 404 if !have_token && super::git_push_mcp::keyring_free() => Failure::new(Category::NotAvailable, concat!("GitHub did not show this without a token, and this tab was started by ", crate::app_name!(), " Mobile while no window was open, which reads CI without the stored token. Ask the user to restart this tab from the ", crate::app_name!(), " window to read it with the token.")),
        403 | 404 if !have_token => Failure::new(Category::NotAvailable, "GitHub did not show this without a token. Ask the user to add a GitHub token in Settings → Git Hosting."),
        403 => Failure::new(Category::NotAvailable, "GitHub refused this for the stored token (its scopes may not cover it)."),
        404 => Failure::new(Category::NotFound, "GitHub has no such run, job or feature for this repository."),
        _ => Failure::new(Category::TransportFailed, format!("GitHub answered {status}.")),
    }
}

async fn get_json(client: &reqwest::Client, path: &str, token: Option<&str>) -> Result<Value, Failure> {
    let mut request = client.get(format!("{API}{path}"))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28");
    if let Some(token) = token { request = request.bearer_auth(token); }
    let response = request.send().await.map_err(|_| Failure::new(Category::Network, "GitHub could not be reached; try again later."))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() { return Err(status_failure(status, &body, token.is_some())); }
    serde_json::from_str(&body).map_err(|_| Failure::new(Category::TransportFailed, "GitHub's answer was not JSON."))
}

/// A job's raw log: the API answers with a redirect to a short-lived storage
/// URL, fetched without the token. Only the last [`LOG_WINDOW`] bytes of at
/// most [`LOG_DOWNLOAD_CAP`] are kept.
async fn job_log(client: &reqwest::Client, owner: &str, repo: &str, job: u64, token: Option<&str>) -> Result<String, Failure> {
    let mut request = client.get(format!("{API}/repos/{owner}/{repo}/actions/jobs/{job}/logs"))
        .header("X-GitHub-Api-Version", "2022-11-28");
    if let Some(token) = token { request = request.bearer_auth(token); }
    let response = request.send().await.map_err(|_| Failure::new(Category::Network, "GitHub could not be reached; try again later."))?;
    let mut response = if response.status().is_redirection() {
        let location = response.headers().get(reqwest::header::LOCATION).and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
        if !location.starts_with("https://") {
            return Err(Failure::new(Category::TransportFailed, "GitHub pointed the log somewhere unexpected."));
        }
        client.get(location).send().await.map_err(|_| Failure::new(Category::Network, "The log could not be downloaded; try again later."))?
    } else {
        response
    };
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(status_failure(status, &body, token.is_some()));
    }
    let mut kept: Vec<u8> = Vec::new();
    let mut total = 0usize;
    while let Some(chunk) = response.chunk().await.map_err(|_| Failure::new(Category::Network, "The log download broke off."))? {
        total += chunk.len();
        kept.extend_from_slice(&chunk);
        if kept.len() > LOG_WINDOW { kept.drain(..kept.len() - LOG_WINDOW); }
        if total >= LOG_DOWNLOAD_CAP { break; }
    }
    Ok(String::from_utf8_lossy(&kept).into_owned())
}

// ── Text hygiene ────────────────────────────────────────────────────────────

/// A log line without its runner timestamp and ANSI colour codes.
fn plain_line(line: &str) -> String {
    let line = match line.split_once(' ') {
        Some((stamp, rest)) if stamp.len() >= 20 && stamp.ends_with('Z') && stamp.as_bytes()[4] == b'-' && stamp.contains('T') => rest,
        _ => line,
    };
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                while let Some(&n) = chars.peek() {
                    chars.next();
                    if n.is_ascii_alphabetic() { break; }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// The part of a job log that explains the failure: from 120 lines before the
/// first `##[error]` through 20 after the last one, or the last 150 lines
/// when the log marks no error. Capped from the front, redacted.
pub fn log_excerpt(raw: &str, token: Option<&str>) -> String {
    let lines: Vec<String> = raw.lines().map(plain_line).collect();
    let errors: Vec<usize> = lines.iter().enumerate().filter(|(_, l)| l.contains("##[error]")).map(|(i, _)| i).collect();
    let (start, end) = match (errors.first(), errors.last()) {
        (Some(&first), Some(&last)) => (first.saturating_sub(120), (last + 21).min(lines.len())),
        _ => (lines.len().saturating_sub(150), lines.len()),
    };
    let text = lines[start..end].join("\n");
    tail(&redact(&super::root_mcp_mail::strip_invisible(&text), token), EXCERPT_CAP)
}

/// Short, single-line, redacted text from GitHub (titles, messages).
fn short(value: &Value, token: Option<&str>) -> Value {
    match value.as_str() {
        Some(s) => {
            let clean: String = super::root_mcp_mail::strip_invisible(s).split_whitespace().collect::<Vec<_>>().join(" ");
            let clean = redact(&clean, token);
            Value::String(if clean.chars().count() > TEXT_CAP { format!("{}…", clean.chars().take(TEXT_CAP).collect::<String>()) } else { clean })
        }
        None => Value::Null,
    }
}

fn run_row(run: &Value, token: Option<&str>) -> Value {
    json!({
        "id": run["id"], "workflow": short(&run["name"], token), "title": short(&run["display_title"], token),
        "event": run["event"], "status": run["status"], "conclusion": run["conclusion"],
        "ref": short(&run["head_branch"], token), "sha": run["head_sha"], "runNumber": run["run_number"],
        "attempt": run["run_attempt"], "createdAt": run["created_at"], "url": run["html_url"],
    })
}

fn failed(conclusion: &Value) -> bool {
    matches!(conclusion.as_str(), Some("failure" | "timed_out" | "startup_failure" | "action_required"))
}

// ── The three reads ─────────────────────────────────────────────────────────

/// A plain ref name for the `branch` filter (a branch or a tag).
fn validate_ref(name: &str) -> Result<(), Failure> {
    let ok = !name.is_empty() && name.len() <= 200 && !name.starts_with('-')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/'));
    if ok { Ok(()) } else { Err(Failure::new(Category::InvalidArguments, format!("'{name}' is not a plain branch or tag name"))) }
}

/// Recent workflow runs of a ref (default: the checked-out branch), newest
/// first; `failed_only` keeps the red ones.
pub fn runs(dir: &Path, project: &str, reference: Option<&str>, limit: Option<u64>, failed_only: bool) -> Result<Value, Failure> {
    let (owner, repo, branch) = repo_of(dir)?;
    let reference = reference.map(str::to_string).or(branch);
    if let Some(r) = &reference { validate_ref(r)?; }
    let limit = limit.unwrap_or(10).clamp(1, 30);
    let token = api_token(project);
    let mut path = format!("/repos/{owner}/{repo}/actions/runs?per_page={}", if failed_only { 30 } else { limit });
    if let Some(r) = &reference { path.push_str(&format!("&branch={r}")); }
    let body = block_on(async { get_json(&client()?, &path, token.as_deref()).await })??;
    let rows: Vec<Value> = body["workflow_runs"].as_array().into_iter().flatten()
        .filter(|run| !failed_only || failed(&run["conclusion"]))
        .take(limit as usize)
        .map(|run| run_row(run, token.as_deref()))
        .collect();
    Ok(json!({"repository": format!("{owner}/{repo}"), "ref": reference, "runs": rows}))
}

/// One run: its jobs and steps, and for up to three failed jobs their
/// annotations and the log excerpt around the error.
pub fn run(dir: &Path, project: &str, id: u64) -> Result<Value, Failure> {
    let (owner, repo, _) = repo_of(dir)?;
    let token = api_token(project);
    let tok = token.as_deref();
    block_on(async {
        let client = client()?;
        let run = get_json(&client, &format!("/repos/{owner}/{repo}/actions/runs/{id}"), tok).await?;
        let jobs = get_json(&client, &format!("/repos/{owner}/{repo}/actions/runs/{id}/jobs?per_page=100&filter=latest"), tok).await?;
        let mut rows = Vec::new();
        let mut logs_read = 0;
        for job in jobs["jobs"].as_array().into_iter().flatten() {
            let steps: Vec<Value> = job["steps"].as_array().into_iter().flatten()
                .map(|s| json!({"name": short(&s["name"], tok), "status": s["status"], "conclusion": s["conclusion"]}))
                .collect();
            let mut row = json!({"id": job["id"], "name": short(&job["name"], tok), "status": job["status"], "conclusion": job["conclusion"], "url": job["html_url"], "steps": steps});
            if failed(&job["conclusion"]) && logs_read < LOG_JOBS {
                if let Some(job_id) = job["id"].as_u64() {
                    logs_read += 1;
                    row["annotations"] = match get_json(&client, &format!("/repos/{owner}/{repo}/check-runs/{job_id}/annotations?per_page=50"), tok).await {
                        Ok(list) => Value::Array(list.as_array().into_iter().flatten().map(|a| json!({
                            "level": a["annotation_level"], "path": short(&a["path"], tok), "line": a["start_line"],
                            "title": short(&a["title"], tok), "message": short(&a["message"], tok),
                        })).collect()),
                        Err(f) => json!({"unavailable": f.message}),
                    };
                    row["log"] = match job_log(&client, &owner, &repo, job_id, tok).await {
                        Ok(raw) => Value::String(log_excerpt(&raw, tok)),
                        Err(f) => json!({"unavailable": f.message}),
                    };
                }
            }
            rows.push(row);
        }
        Ok::<Value, Failure>(json!({"repository": format!("{owner}/{repo}"), "run": run_row(&run, tok), "jobs": rows}))
    })?
}

/// Open code-scanning alerts (CodeQL and other SARIF uploads), optionally for
/// one ref, most severe first as GitHub sorts them.
pub fn security_alerts(dir: &Path, project: &str, reference: Option<&str>, limit: Option<u64>) -> Result<Value, Failure> {
    let (owner, repo, _) = repo_of(dir)?;
    if let Some(r) = reference { validate_ref(r)?; }
    let limit = limit.unwrap_or(30).clamp(1, 100);
    let token = api_token(project);
    let tok = token.as_deref();
    let mut path = format!("/repos/{owner}/{repo}/code-scanning/alerts?state=open&per_page={limit}");
    if let Some(r) = reference {
        let full = if r.starts_with("refs/") { r.to_string() } else { format!("refs/heads/{r}") };
        path.push_str(&format!("&ref={full}"));
    }
    let body = block_on(async { get_json(&client()?, &path, tok).await })?.map_err(|f| match f.category {
        Category::NotFound => Failure::new(Category::NotAvailable, "Code scanning is not set up for this repository, or has no analysis yet."),
        _ => f,
    })?;
    let rows: Vec<Value> = body.as_array().into_iter().flatten().map(|a| {
        let at = &a["most_recent_instance"];
        json!({
            "number": a["number"], "rule": short(&a["rule"]["id"], tok), "severity": a["rule"]["security_severity_level"].as_str().or(a["rule"]["severity"].as_str()),
            "description": short(&a["rule"]["description"], tok), "tool": short(&a["tool"]["name"], tok),
            "path": short(&at["location"]["path"], tok), "line": at["location"]["start_line"],
            "message": short(&at["message"]["text"], tok), "ref": short(&at["ref"], tok), "url": a["html_url"],
        })
    }).collect();
    Ok(json!({"repository": format!("{owner}/{repo}"), "alerts": rows}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_urls_in_every_spelling() {
        let want = Some(("octo-org".to_string(), "some-repo".to_string()));
        for url in ["https://github.com/octo-org/some-repo", "https://github.com/octo-org/some-repo.git", "git@github.com:octo-org/some-repo.git",
                    "ssh://git@github.com/octo-org/some-repo.git", "https://GitHub.com/octo-org/some-repo/"] {
            assert_eq!(github_repo(url), want, "{url}");
        }
        for url in ["https://gitlab.com/o/r", "https://github.com.evil.example/o/r", "https://github.com/o", "https://github.com/o/r/extra",
                    "file:///tmp/r", "https://github.com/../r", "https://github.com/o/r?x=1"] {
            assert_eq!(github_repo(url), None, "{url}");
        }
        assert_eq!(github_repo(&format!("https://{}@github.com/o/r", "someone")), None, "userinfo is refused");
    }

    #[test]
    fn excerpt_keeps_the_error_neighbourhood_without_noise() {
        let mut log = String::new();
        for i in 0..400 { log.push_str(&format!("2026-09-25T10:00:00.1234567Z line {i}\n")); }
        log.push_str("2026-09-25T10:00:01.0000000Z \u{1b}[31merror[E0308]\u{1b}[0m: mismatched types\n");
        log.push_str("2026-09-25T10:00:01.0000000Z ##[error]Process completed with exit code 101.\n");
        for i in 0..100 { log.push_str(&format!("2026-09-25T10:00:02.0000000Z post {i}\n")); }
        let excerpt = log_excerpt(&log, None);
        assert!(excerpt.contains("error[E0308]: mismatched types"), "ANSI stripped");
        assert!(excerpt.contains("##[error]Process completed"));
        assert!(!excerpt.contains("2026-09-25T"), "timestamps stripped");
        assert!(excerpt.contains("line 399") && !excerpt.contains("line 200\n"), "120 lines of lead-in only");
        assert!(excerpt.contains("post 19") && !excerpt.contains("post 20"), "20 lines after");

        let quiet: String = (0..500).map(|i| format!("x {i}\n")).collect();
        let excerpt = log_excerpt(&quiet, None);
        assert!(excerpt.starts_with("x 350") && excerpt.ends_with("x 499"));
        let fake = format!("gh{}_{}", "p", "abcdefghijklmnop1234");
        assert_eq!(log_excerpt(&format!("token {fake} used"), None), "token [redacted] used");
    }

    #[test]
    fn short_text_is_one_capped_redacted_line() {
        let long = "a ".repeat(TEXT_CAP);
        assert!(short(&json!(long), None).as_str().unwrap().ends_with('…'));
        let fake = format!("gh{}_{}", "p", "abcdefghijklmnop1234");
        assert_eq!(short(&json!(format!("fix\n\tthe{} thing  {fake}", '\u{200b}')), None), json!("fix the thing [redacted]"));
        assert_eq!(short(&Value::Null, None), Value::Null);
    }

    #[test]
    fn refs_are_plain() {
        assert!(validate_ref("develop").is_ok() && validate_ref("v0.1.86").is_ok() && validate_ref("feature/x").is_ok());
        for bad in ["", "-x", "a&b=c", "a b", "a?b", "a#b"] { assert!(validate_ref(bad).is_err(), "{bad}"); }
    }

    #[test]
    fn budget_is_per_tab() {
        for _ in 0..CI_RATE { assert!(admit_rate("test-ci-tab")); }
        assert!(!admit_rate("test-ci-tab"));
        assert!(admit_rate("test-ci-other"));
    }
}
