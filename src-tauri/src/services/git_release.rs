//! Release tags: tag a commit the remote already has and push exactly that
//! tag. Shared by the git bar's Release button (the user's click) and an
//! agent's `git_release` proposal on the `tabtivity-git` lane
//! (`services::git_push_mcp`), which the user approves on the same card as a
//! push. `docs/context/git_push_mcp.md`. AppHandle-free.
//!
//! Only a pushed commit is tagged — the checked-out branch's tip, equal to its
//! same-named upstream on the remote — so a tag can never publish commits the
//! branch push did not (the privacy scan runs on branch pushes, not tags). The
//! tag is annotated, never signed (a repo's `tag.gpgSign` + `gpg.program`
//! would run a program), and goes out through the hooks-off transport with the
//! one refspec `<tag object>:refs/tags/T` — the object checked to peel to the
//! tip, not the local tag by name: no `+`, no `--tags`, no delete, and an
//! existing remote tag is refused rather than moved.
//!
//! On GitHub the tip's CI must also have passed first (`git_ci::tip_ci`):
//! while the branch push's workflow runs are queued, running or red, a
//! release is refused (`ci_pending` / `ci_failed`), so a tag never names a
//! commit CI rejected. CI that cannot be read does not gate.
use std::path::Path;

use serde::Serialize;

use super::git_ci::{self, TipCi};
use super::git_push_mcp::{
    classify_remote_error, clean_output, git, join_streams, ls_remote_raw, repo_rewrites_urls, run_capped, validate_sha, Category,
    Failure, TRANSPORT_TIMEOUT,
};
use crate::commands::git::{hardened_git_command_in, push_transport_command};

/// What a release would do: tag `head` (the tip of `branch`, already on
/// `remote`) as `tag` and push it to `url`.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReleasePlan {
    pub tag: String,
    pub branch: String,
    pub remote: String,
    pub url: String,
    pub head: String,
    /// `<short sha> <subject>` of `head`.
    pub subject: String,
}

/// The Release dialog's opening state: the suggested tag and where it comes
/// from, and whether the tip is on the remote yet. `problem` is the refusal a
/// release would meet right now (push first, tag exists, …), if any.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub suggested: String,
    /// The file the version came from, or `None` when it was counted up from
    /// the latest tag.
    pub source: Option<String>,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub subject: Option<String>,
    pub url: Option<String>,
    pub problem: Option<String>,
    pub category: Option<Category>,
}

/// A plain tag name: letters, digits, `.`, `_`, `-`, `/`, starting with a
/// letter or digit, and nothing git's ref rules or a refspec would read
/// differently.
pub fn validate_tag(name: &str) -> Result<(), String> {
    let bad = name.is_empty() || name.len() > 100 || !name.starts_with(|c: char| c.is_ascii_alphanumeric())
        || name.ends_with('/') || name.ends_with('.') || name.ends_with(".lock") || name.contains("..") || name.contains("//")
        || name.contains("/.") || !name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/'));
    if bad { Err(format!("'{name}' is not a plain tag name (letters, digits, . _ - /)")) } else { Ok(()) }
}

/// Files a project's version is read from, in order, at the commit tagged.
const VERSION_FILES: &[&str] = &["package.json", "src-tauri/tauri.conf.json", "tauri.conf.json", "Cargo.toml", "pyproject.toml"];

/// The `version` a manifest declares: JSON's top-level `version`, or the
/// first `version = "…"` in a TOML `[package]` / `[project]` /
/// `[tool.poetry]` table. Only something that starts with a digit counts.
pub fn manifest_version(file: &str, text: &str) -> Option<String> {
    let version = if file.ends_with(".json") {
        serde_json::from_str::<serde_json::Value>(text).ok()?.get("version")?.as_str()?.trim().to_string()
    } else {
        let mut section = String::new();
        let mut found = None;
        for line in text.lines() {
            let line = line.trim();
            if line.starts_with('[') {
                section = line.trim_matches(|c| c == '[' || c == ']').trim().to_string();
                continue;
            }
            if !matches!(section.as_str(), "package" | "project" | "tool.poetry") { continue; }
            let Some((key, value)) = line.split_once('=') else { continue };
            if key.trim() != "version" { continue; }
            let value = value.trim();
            if let Some(inner) = value.strip_prefix('"').and_then(|v| v.split('"').next()) {
                found = Some(inner.trim().to_string());
                break;
            }
        }
        found?
    };
    (version.starts_with(|c: char| c.is_ascii_digit()) && validate_tag(&version).is_ok()).then_some(version)
}

/// The next tag after `latest` (`v1.2.9` → `v1.2.10`): its last run of
/// digits counted up. `None` when it has none.
pub fn next_after(latest: &str) -> Option<String> {
    let end = latest.rfind(|c: char| c.is_ascii_digit())? + 1;
    let start = latest[..end].rfind(|c: char| !c.is_ascii_digit()).map(|i| i + 1).unwrap_or(0);
    let n: u64 = latest[start..end].parse().ok()?;
    Some(format!("{}{}{}", &latest[..start], n + 1, &latest[end..]))
}

fn local_tag_commit(dir: &Path, tag: &str) -> Option<String> {
    git(dir, &["rev-parse", "-q", "--verify", &format!("refs/tags/{tag}^{{commit}}")]).ok().filter(|s| !s.is_empty())
}

/// The tag a release of `head` would most likely want: `v<version>` from the
/// first manifest that has one — unless that tag already names another
/// commit, which means the version was not bumped — else the latest `v*` tag
/// counted up, else `v0.1.0`.
pub fn suggest_tag(dir: &Path, head: &str) -> (String, Option<String>) {
    for file in VERSION_FILES {
        let Ok(text) = git(dir, &["show", &format!("{head}:{file}")]) else { continue };
        let Some(version) = manifest_version(file, &text) else { continue };
        let tag = format!("v{version}");
        if local_tag_commit(dir, &tag).is_none_or(|at| at == head) {
            return (tag, Some((*file).to_string()));
        }
        break;
    }
    let latest = git(dir, &["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", head]).ok().filter(|s| !s.is_empty());
    (latest.as_deref().and_then(next_after).unwrap_or_else(|| "v0.1.0".into()), None)
}

/// The checked-out branch, its same-named upstream and URL, and its tip —
/// everything a release is decided on, read locally.
fn local_target(dir: &Path, need_token: bool, token: Option<&str>) -> Result<(String, String, String, String, String), Failure> {
    let branch = git(dir, &["symbolic-ref", "--short", "-q", "HEAD"]).ok().filter(|b| !b.is_empty())
        .ok_or_else(|| Failure::new(Category::NotCheckedOut, "HEAD is detached; check out the branch to release from first."))?;
    let remote = git(dir, &["config", "--get", &format!("branch.{branch}.remote")]).ok().filter(|s| !s.is_empty())
        .ok_or_else(|| Failure::new(Category::NoUpstream, format!("'{branch}' has no upstream; push it once first.")))?;
    let merge = git(dir, &["config", "--get", &format!("branch.{branch}.merge")]).unwrap_or_default();
    if merge != format!("refs/heads/{branch}") {
        return Err(Failure::new(Category::NoUpstream, format!("'{branch}' tracks a differently named remote branch; release from a branch with a same-named upstream.")));
    }
    if repo_rewrites_urls(dir) {
        return Err(Failure::new(Category::UrlRewritten, "The repo's own git config rewrites URLs (url.*.insteadOf), so the destination cannot be pinned; remove that setting from .git/config."));
    }
    let url = git(dir, &["config", "--get", &format!("remote.{remote}.url")]).ok().filter(|s| !s.is_empty())
        .ok_or_else(|| Failure::new(Category::NoUpstream, format!("remote '{remote}' has no URL.")))?;
    if need_token && url.starts_with("http") && token.is_none() {
        return Err(Failure::new(Category::AuthFailed, "No access token is stored for this project. Ask the user to add one in Settings → Git Hosting."));
    }
    let head = git(dir, &["rev-parse", "--verify", &format!("refs/heads/{branch}^{{commit}}")]).map_err(|e| Failure::new(Category::NotCheckedOut, e))?;
    let subject = git(dir, &["log", "-1", "--format=%h %s", &head, "--"]).unwrap_or_default();
    Ok((branch, remote, url, head, subject))
}

/// Decide a release of the checked-out branch's tip as `tag`: the tip must be
/// exactly what the remote branch holds, its GitHub CI (if any) must have
/// passed, and `tag` must be new on the remote (and locally, unless it
/// already names the tip). `need_token` refuses an
/// https remote without a stored token (the agent lane, which never falls back
/// to the user's own credential helpers).
pub fn plan(dir: &Path, tag: &str, need_token: bool, token: Option<&str>, origins: &[String]) -> Result<ReleasePlan, Failure> {
    validate_tag(tag).map_err(|e| Failure::new(Category::InvalidArguments, e))?;
    let (branch, remote, url, head, subject) = local_target(dir, need_token, token)?;
    if let Some(at) = local_tag_commit(dir, tag) {
        if at != head {
            return Err(Failure::new(Category::TagExists, format!("The tag '{tag}' already exists locally at {}; pick another name.", &at[..7.min(at.len())])));
        }
    }
    let want_branch = format!("refs/heads/{branch}");
    let want_tag = format!("refs/tags/{tag}");
    let stdout = ls_remote_raw(dir, &url, &[want_branch.clone(), want_tag.clone()], token, origins)?;
    let mut remote_sha = None;
    let mut tag_on_remote = false;
    for line in stdout.lines() {
        let Some((sha, name)) = line.split_once('\t') else { continue };
        if name == want_branch && sha.len() == 40 { remote_sha = Some(sha.to_string()); }
        if name == want_tag || name == format!("{want_tag}^{{}}") { tag_on_remote = true; }
    }
    if tag_on_remote {
        return Err(Failure::new(Category::TagExists, format!("The tag '{tag}' already exists on the remote; pick another name.")));
    }
    let Some(remote_sha) = remote_sha else {
        return Err(Failure::new(Category::RemoteBranchMissing, format!("'{branch}' does not exist on the remote yet; push it first.")));
    };
    if remote_sha != head {
        return Err(Failure::new(Category::NotPushed, format!("'{branch}' is not in sync with the remote ({} here, {} there); push or pull first, then release.", &head[..7.min(head.len())], &remote_sha[..7.min(remote_sha.len())])));
    }
    let api_token = token.filter(|_| origins.iter().any(|o| o == "https://github.com"));
    match git_ci::tip_ci(&url, &branch, &head, api_token) {
        TipCi::Pending(names) => return Err(Failure::new(Category::CiPending, format!("CI is still running on {} ({}); release once it has passed.", &head[..7.min(head.len())], names.join(", ")))),
        TipCi::Failed(names) => return Err(Failure::new(Category::CiFailed, format!("CI did not pass on {} ({}); fix it and push, then release.", &head[..7.min(head.len())], names.join(", ")))),
        TipCi::Green | TipCi::Unknown => {}
    }
    Ok(ReleasePlan { tag: tag.to_string(), branch, remote, url, head, subject })
}

/// The dialog's opening state. Never fails outright: a refusal becomes
/// `problem`, so the dialog can say what to do.
pub fn preview(dir: &Path, token: Option<&str>, origins: &[String]) -> Preview {
    let mut out = Preview { suggested: String::new(), source: None, branch: None, head: None, subject: None, url: None, problem: None, category: None };
    match local_target(dir, false, token) {
        Ok((branch, _, url, head, subject)) => {
            let (suggested, source) = suggest_tag(dir, &head);
            out.suggested = suggested;
            out.source = source;
            out.branch = Some(branch);
            out.head = Some(head);
            out.subject = Some(subject);
            out.url = Some(url);
        }
        Err(failure) => {
            out.problem = Some(failure.message);
            out.category = Some(failure.category);
            return out;
        }
    }
    if let Err(failure) = plan(dir, &out.suggested, false, token, origins) {
        out.problem = Some(failure.message);
        out.category = Some(failure.category);
    }
    out
}

/// `<tag object>:refs/tags/T`: the local tag's object as read now, checked
/// to peel to the plan's tip. Pushing that object (not the name) means a tag
/// re-pointed after this read cannot be what leaves.
fn pinned_tag_refspec(dir: &Path, plan: &ReleasePlan) -> Result<String, Failure> {
    let object = git(dir, &["rev-parse", "-q", "--verify", &format!("refs/tags/{}", plan.tag)]).ok().filter(|o| validate_sha(o).is_ok())
        .ok_or_else(|| Failure::new(Category::TransportFailed, "The tag vanished before it could be pushed; nothing was pushed."))?;
    let peeled = git(dir, &["rev-parse", "-q", "--verify", &format!("{object}^{{commit}}")]).unwrap_or_default();
    if peeled != plan.head {
        return Err(Failure::new(Category::StaleApproval, format!("The local tag '{}' no longer points at {}; nothing was pushed.", plan.tag, &plan.head[..7.min(plan.head.len())])));
    }
    Ok(format!("{object}:refs/tags/{}", plan.tag))
}

/// Create the annotated tag (unless it already names the tip) and push it.
/// A tag this call created is removed again when the push fails, so a retry
/// starts clean. Returns the push's cleaned output.
pub fn release(dir: &Path, plan: &ReleasePlan, message: &str, token: Option<&str>, origins: &[String]) -> Result<String, Failure> {
    validate_tag(&plan.tag).map_err(|e| Failure::new(Category::InvalidArguments, e))?;
    let created = local_tag_commit(dir, &plan.tag).is_none();
    if created {
        let message = if message.trim().is_empty() { plan.tag.as_str() } else { message };
        let out = crate::services::git_bounded::output(hardened_git_command_in(dir, &["-c", "tag.gpgSign=false", "-c", "tag.forceSignAnnotated=false", "tag", "-a", &plan.tag, "-m", message, &plan.head]))
            .map_err(|e| Failure::new(Category::TransportFailed, e))?;
        if !out.status.success() {
            return Err(Failure::new(Category::TransportFailed, "git could not create the tag; read its output.")
                .with_output(clean_output(&String::from_utf8_lossy(&out.stderr), None)));
        }
    }
    // Push the tag object read and checked here, never `refs/tags/T` by name:
    // the fenced agent can write `.git` refs and re-point the local tag at an
    // unpushed commit between this check and the transport.
    let result = pinned_tag_refspec(dir, plan).and_then(|refspec| {
        let cmd = push_transport_command(dir, &plan.url, &refspec, token, origins);
        super::git_push_mcp::before_transport();
        match run_capped(cmd, None, TRANSPORT_TIMEOUT) {
            Err(None) => Err(Failure::new(Category::Network, "The push did not finish within ten minutes and was stopped.")),
            Err(Some(e)) => Err(Failure::new(Category::TransportFailed, format!("git could not be started: {e}"))),
            Ok(ran) => {
                let output = clean_output(&join_streams(&ran.stdout, &ran.stderr), token);
                if ran.success {
                    Ok(output)
                } else {
                    let category = classify_remote_error(&format!("{}\n{}", ran.stdout, ran.stderr));
                    let message = match category {
                        Category::AuthFailed => "The remote refused the credentials; check the token in Settings → Git Hosting.",
                        Category::Network => "The remote could not be reached; try again later.",
                        Category::RemoteRejected => "The remote rejected the tag (a server-side rule); read its output.",
                        _ => "Pushing the tag failed; read its output.",
                    };
                    Err(Failure::new(category, message).with_output(output))
                }
            }
        }
    });
    if result.is_err() && created {
        let _ = crate::services::git_bounded::output(hardened_git_command_in(dir, &["tag", "-d", &plan.tag]));
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;

    fn sh(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git").args(args).current_dir(dir)
            .env("GIT_CONFIG_GLOBAL", "/dev/null").env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_AUTHOR_NAME", "t").env("GIT_AUTHOR_EMAIL", "t@example.invalid").env("GIT_COMMITTER_NAME", "t").env("GIT_COMMITTER_EMAIL", "t@example.invalid")
            .output().expect("git");
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }
    /// A bare remote and a clone on `develop` with a pushed `package.json`.
    fn pair(version: &str) -> (tempfile::TempDir, PathBuf, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let remote = root.path().join("remote.git");
        let work = root.path().join("work");
        sh(root.path(), &["init", "-q", "--bare", "-b", "main", remote.to_str().unwrap()]);
        sh(root.path(), &["init", "-q", "-b", "develop", work.to_str().unwrap()]);
        sh(&work, &["config", "user.name", "t"]);
        sh(&work, &["config", "user.email", "t@example.invalid"]);
        std::fs::write(work.join("package.json"), format!("{{\"name\":\"x\",\"version\":\"{version}\"}}\n")).unwrap();
        sh(&work, &["add", "package.json"]);
        sh(&work, &["commit", "-q", "-m", "one"]);
        sh(&work, &["remote", "add", "origin", &format!("file://{}", remote.display())]);
        sh(&work, &["push", "-q", "-u", "origin", "develop"]);
        (root, remote, work)
    }

    #[test]
    fn tag_names_are_plain() {
        for ok in ["v0.1.86", "1.0", "release/2026-09", "v1.0.0-rc.1", "v1_2"] {
            assert!(validate_tag(ok).is_ok(), "{ok}");
        }
        for bad in ["", "-v1", "+v1", "v1:main", "refs/tags/x/..", "v1..2", "v1.lock", "v1/", "v1.", "a b", "v1^", "v1~1", "v@{1}", ".v1", "/v1", "v1//2", "a/.b", "ü1"] {
            assert!(validate_tag(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn versions_come_from_the_manifests() {
        assert_eq!(manifest_version("package.json", r#"{"version":"0.1.86"}"#).as_deref(), Some("0.1.86"));
        assert_eq!(manifest_version("package.json", r#"{"name":"x"}"#), None);
        assert_eq!(manifest_version("package.json", r#"{"version":"workspace"}"#), None);
        let cargo = "[workspace]\nversion = \"9.9.9\"\n\n[package]\nname = \"x\"\nversion = \"1.2.3\"\n\n[dependencies]\nversion = \"0\"\n";
        assert_eq!(manifest_version("Cargo.toml", cargo).as_deref(), Some("1.2.3"));
        assert_eq!(manifest_version("pyproject.toml", "[project]\nversion = \"2.0.0\" # comment\n").as_deref(), Some("2.0.0"));
        assert_eq!(manifest_version("Cargo.toml", "[package]\nversion.workspace = true\n"), None);
    }

    #[test]
    fn next_tag_counts_up_the_last_number() {
        assert_eq!(next_after("v0.1.9").as_deref(), Some("v0.1.10"));
        assert_eq!(next_after("v2").as_deref(), Some("v3"));
        assert_eq!(next_after("v1.0.0-rc.1").as_deref(), Some("v1.0.0-rc.2"));
        assert_eq!(next_after("vX"), None);
    }

    #[test]
    fn suggests_the_manifest_version_unless_it_is_already_tagged_elsewhere() {
        let (_root, _remote, work) = pair("0.1.86");
        let head = sh(&work, &["rev-parse", "HEAD"]);
        assert_eq!(suggest_tag(&work, &head), ("v0.1.86".to_string(), Some("package.json".to_string())));
        sh(&work, &["tag", "-a", "v0.1.86", "-m", "v0.1.86"]);
        std::fs::write(work.join("b.txt"), "b\n").unwrap();
        sh(&work, &["add", "b.txt"]);
        sh(&work, &["commit", "-q", "-m", "two, version not bumped"]);
        let head = sh(&work, &["rev-parse", "HEAD"]);
        assert_eq!(suggest_tag(&work, &head), ("v0.1.87".to_string(), None), "an unbumped version counts up from the latest tag");
    }

    #[test]
    fn releases_only_a_pushed_tip_and_never_moves_a_remote_tag() {
        let (_root, remote, work) = pair("0.1.86");
        let head = sh(&work, &["rev-parse", "HEAD"]);
        let plan = plan(&work, "v0.1.86", false, None, &[]).unwrap();
        assert_eq!((plan.branch.as_str(), plan.head.as_str()), ("develop", head.as_str()));
        release(&work, &plan, "", None, &[]).unwrap();
        assert_eq!(sh(&remote, &["rev-parse", "refs/tags/v0.1.86^{commit}"]), head);
        assert_eq!(sh(&remote, &["cat-file", "-t", "refs/tags/v0.1.86"]), "tag", "annotated");
        assert_eq!(super::plan(&work, "v0.1.86", false, None, &[]).unwrap_err().category, Category::TagExists);

        std::fs::write(work.join("c.txt"), "c\n").unwrap();
        sh(&work, &["add", "c.txt"]);
        sh(&work, &["commit", "-q", "-m", "unpushed"]);
        assert_eq!(super::plan(&work, "v0.1.87", false, None, &[]).unwrap_err().category, Category::NotPushed);
        let preview = preview(&work, None, &[]);
        assert_eq!(preview.category, Some(Category::NotPushed));
        assert!(super::plan(&work, "+v1", false, None, &[]).is_err());
    }

    #[test]
    fn a_tag_re_pointed_before_the_transport_is_not_what_leaves() {
        let (_root, remote, work) = pair("0.1.86");
        let head = sh(&work, &["rev-parse", "HEAD"]);
        std::fs::write(work.join("c.txt"), "c\n").unwrap();
        sh(&work, &["add", "c.txt"]);
        sh(&work, &["commit", "-q", "-m", "unpushed"]);
        let unpushed = sh(&work, &["rev-parse", "HEAD"]);
        sh(&work, &["reset", "-q", "--hard", &head]);
        let plan = plan(&work, "v0.1.86", false, None, &[]).unwrap();
        // The agent re-points the local tag at an unpushed commit after the
        // tag was created and checked, right before the transport.
        let w = work.clone();
        let other = unpushed.clone();
        super::super::git_push_mcp::BEFORE_TRANSPORT.with(|slot| *slot.borrow_mut() = Some(Box::new(move || {
            sh(&w, &["tag", "-f", "-a", "v0.1.86", "-m", "moved", &other]);
        })));
        release(&work, &plan, "", None, &[]).unwrap();
        assert_eq!(sh(&remote, &["rev-parse", "refs/tags/v0.1.86^{commit}"]), head, "the checked tag object left");
        let missing = Command::new("git").args(["cat-file", "-e", &unpushed]).current_dir(&remote).output().unwrap();
        assert!(!missing.status.success(), "the unpushed commit never reached the remote");
        // A local tag already re-pointed when Release runs is refused.
        sh(&work, &["tag", "-f", "-a", "v0.1.87", "-m", "x", &unpushed]);
        let stale = ReleasePlan { tag: "v0.1.87".into(), ..plan.clone() };
        assert_eq!(release(&work, &stale, "", None, &[]).unwrap_err().category, Category::StaleApproval);
        assert!(sh(&remote, &["tag", "-l", "v0.1.87"]).is_empty());
        assert_eq!(pinned_tag_refspec(&work, &plan).unwrap_err().category, Category::StaleApproval, "the moved v0.1.86");
        sh(&work, &["tag", "-f", "-a", "v0.1.86", "-m", "back", &head]);
        let pinned = pinned_tag_refspec(&work, &plan).unwrap();
        let object = sh(&work, &["rev-parse", "refs/tags/v0.1.86"]);
        assert_eq!(pinned, format!("{object}:refs/tags/v0.1.86"), "the object, not the name");
    }

    #[test]
    fn agent_lane_needs_a_token_for_https() {
        let (_root, _remote, work) = pair("1.0.0");
        sh(&work, &["remote", "set-url", "origin", "https://github.com/o/r.git"]);
        assert_eq!(plan(&work, "v1.0.0", true, None, &[]).unwrap_err().category, Category::AuthFailed);
    }
}
