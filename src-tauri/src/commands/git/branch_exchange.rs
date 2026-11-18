//! Calculate and apply the Git bar's single-branch exchange actions.
use super::{
    exchange_local, failure_message, git_exchange_context, require_hook_trust, run_git,
    run_git_hooked, GitExchangeContext, GitStatus, GitWorktreeSelection,
};
use std::{path::Path, process::Output};

#[derive(Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionKind {
    Publish,
    Track,
    Push,
}

#[derive(serde::Serialize)]
pub struct Destination {
    pub remote: String,
    pub branch: String,
    pub action: ActionKind,
    pub ahead: usize,
    pub behind: usize,
    pub tracking: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum BranchExchange {
    Detached,
    Unborn {
        branch: String,
    },
    NoRemote {
        branch: String,
    },
    Branch {
        branch: String,
        head: String,
        checkout: String,
        upstream: Option<String>,
        ahead: Option<usize>,
        behind: Option<usize>,
        destinations: Vec<Destination>,
    },
    Error {
        error: String,
    },
}

#[derive(serde::Deserialize)]
pub struct BranchAction {
    kind: ActionKind,
    branch: String,
    head: String,
    checkout: String,
    remote: String,
    remote_branch: String,
    #[serde(default)]
    check_remote: bool,
}

fn git(ctx: &GitExchangeContext, args: &[&str]) -> Result<Output, String> {
    run_git(ctx.target.as_ref(), &ctx.dir, args)
}

fn output(result: Output) -> Result<String, String> {
    if !result.status.success() {
        return Err(failure_message(&result));
    }
    Ok(String::from_utf8_lossy(&result.stdout)
        .trim_end_matches(['\r', '\n'])
        .to_string())
}

fn config(ctx: &GitExchangeContext, key: &str) -> Result<Option<String>, String> {
    let result = git(ctx, &["config", "--get", key])?;
    if result.status.code() == Some(1) && result.stderr.is_empty() {
        return Ok(None);
    }
    output(result).map(Some)
}

fn counts(ctx: &GitExchangeContext, reference: &str, head: &str) -> Result<(usize, usize), String> {
    let range = format!("{reference}...{head}");
    let read = output(git(
        ctx,
        &["rev-list", "--left-right", "--count", &range, "--"],
    )?)?;
    let parse = || {
        let (behind, ahead) = read.split_once('\t')?;
        Some((ahead.parse::<usize>().ok()?, behind.parse::<usize>().ok()?))
    };
    parse().ok_or_else(|| "Git did not return branch comparison counts.".into())
}

pub(super) fn checkout_label(ctx: &GitExchangeContext) -> String {
    let Some(target) = &ctx.target else {
        return ctx.dir.clone();
    };
    let spec = &target.spec;
    let user = spec
        .user
        .as_deref()
        .filter(|user| !user.is_empty())
        .map_or_else(String::new, |user| format!("{user}@"));
    let port = spec
        .port
        .filter(|port| *port != 22)
        .map_or_else(String::new, |port| format!(":{port}"));
    format!("{user}{}{port}:{}", spec.host, spec.remote_path)
}

#[derive(serde::Deserialize)]
pub struct BranchComparison {
    checkout: String,
    head: String,
    tracking: String,
}

pub(super) fn resolve_comparison(
    project_dir: String,
    worktree: Option<&GitWorktreeSelection>,
    comparison: BranchComparison,
) -> Result<Vec<super::FileChange>, String> {
    let ctx = git_exchange_context(project_dir, worktree)?;
    if checkout_label(&ctx) != comparison.checkout {
        return Err("The comparison checkout changed. Refresh the Git view and try again.".into());
    }
    if !matches!(comparison.head.len(), 40 | 64)
        || !comparison.head.bytes().all(|b| b.is_ascii_hexdigit())
        || !comparison.tracking.starts_with("refs/")
    {
        return Err("Invalid branch comparison.".into());
    }
    output(git(&ctx, &["check-ref-format", &comparison.tracking])?)?;
    let range = format!("{}..{}", comparison.tracking, comparison.head);
    super::change_list_with_range(&ctx.dir, ctx.target.as_ref(), "unpushed", Some(range))
}

fn tracks<'a>(pattern: &str, reference: &'a str) -> Option<&'a str> {
    if let Some((prefix, suffix)) = pattern.split_once('*') {
        return reference.strip_prefix(prefix)?.strip_suffix(suffix);
    }
    (pattern == reference).then_some("")
}

fn remote_tracking_ref(
    ctx: &GitExchangeContext,
    remote: &str,
    branch: &str,
) -> Result<Option<String>, String> {
    let key = format!("remote.{remote}.fetch");
    let result = git(ctx, &["config", "--get-all", &key])?;
    if result.status.code() == Some(1) && result.stderr.is_empty() {
        return Ok(None);
    }
    let specs = output(result)?;
    let reference = format!("refs/heads/{branch}");
    if specs
        .lines()
        .filter_map(|spec| spec.strip_prefix('^'))
        .any(|pattern| tracks(pattern, &reference).is_some())
    {
        return Ok(None);
    }
    Ok(specs
        .lines()
        .filter_map(|spec| spec.trim_start_matches('+').split_once(':'))
        .find_map(|(source, destination)| {
            let matching = tracks(source, &reference)?;
            (!destination.is_empty()).then(|| destination.replacen('*', matching, 1))
        }))
}

pub(super) fn read_exchange(
    project_dir: String,
    worktree: Option<&GitWorktreeSelection>,
    status: &GitStatus,
) -> BranchExchange {
    let result = git_exchange_context(project_dir, worktree).and_then(|ctx| {
        read(
            &ctx,
            (worktree.is_some() || ctx.mirror_project_id.is_none()).then_some(status),
        )
    });
    result.unwrap_or_else(|error| BranchExchange::Error { error })
}

fn read(ctx: &GitExchangeContext, status: Option<&GitStatus>) -> Result<BranchExchange, String> {
    let branch_ref = if let Some(header) = status.and_then(|s| s.branch_header.as_deref()) {
        if header == "HEAD (no branch)" {
            return Ok(BranchExchange::Detached);
        }
        if let Some(branch) = header
            .strip_prefix("No commits yet on ")
            .or_else(|| header.strip_prefix("Initial commit on "))
        {
            return Ok(BranchExchange::Unborn {
                branch: branch.to_string(),
            });
        }
        format!(
            "refs/heads/{}",
            header
                .split_once("...")
                .map_or(header, |(branch, _)| branch)
        )
    } else {
        let symref = git(ctx, &["symbolic-ref", "--quiet", "HEAD"])?;
        if symref.status.code() == Some(1) && symref.stderr.is_empty() {
            return Ok(BranchExchange::Detached);
        }
        output(symref)?
    };
    let branch = branch_ref
        .strip_prefix("refs/heads/")
        .ok_or_else(|| "HEAD does not identify a local branch.".to_string())?
        .to_string();
    let row = output(git(ctx, &[
        "for-each-ref",
        "--format=%(refname)%09%(objectname)%09%(upstream)%09%(upstream:remotename)%09%(upstream:remoteref)%09%(push:remotename)%09%(push:remoteref)%09%(push)%09%(upstream:track)",
        &branch_ref,
    ])?)?;
    let Some(row) = row
        .lines()
        .find(|row| row.split('\t').next() == Some(branch_ref.as_str()))
    else {
        return Ok(BranchExchange::Unborn { branch });
    };
    let columns: Vec<_> = row.split('\t').collect();
    let [_, head, upstream_ref, upstream_remote, upstream_branch, push_remote, push_ref, push_tracking, track] =
        columns.as_slice()
    else {
        return Err("Git did not return the branch's tracking configuration.".into());
    };
    let remote_list;
    let remotes: Vec<_> = if status.is_some()
        && !push_remote.is_empty()
        && *push_remote != "."
        && push_remote == upstream_remote
        && !upstream_ref.is_empty()
        && *track != "[gone]"
    {
        // Git already resolved the configured push remote to the live upstream.
        vec![*push_remote]
    } else {
        remote_list = output(git(ctx, &["remote"])?)?;
        remote_list.lines().collect()
    };
    if remotes.is_empty() {
        return Ok(BranchExchange::NoRemote { branch });
    }
    let upstream = (!upstream_ref.is_empty()).then(|| {
        upstream_ref
            .strip_prefix("refs/remotes/")
            .unwrap_or(upstream_ref)
            .to_string()
    });
    let upstream_counts = if upstream.is_some() && *track != "[gone]" {
        Some(
            match status.and_then(|s| s.upstream_ahead.map(|ahead| (ahead, s.behind))) {
                Some(counts) => counts,
                None => counts(ctx, upstream_ref, head)?,
            },
        )
    } else {
        None
    };
    let preferred = if push_remote.is_empty() {
        // Ref-filter normally supplies an explicit override or the tracking
        // remote. A branch with neither lets the user choose among remotes.
        config(ctx, &format!("branch.{branch}.pushRemote"))?.or(config(ctx, "remote.pushDefault")?)
    } else {
        Some(push_remote.to_string())
    };
    let candidates = match preferred {
        Some(ref remote) if remotes.contains(&remote.as_str()) => vec![remote.as_str()],
        Some(remote) if remote != "." => {
            return Err(format!(
                "The configured push remote {remote} is unavailable."
            ))
        }
        _ => remotes,
    };
    let mut destinations = Vec::with_capacity(candidates.len());
    for remote in candidates {
        let conventional_prefix = format!("refs/remotes/{remote}/");
        let remote_branch = if remote == *push_remote {
            push_ref
                .strip_prefix("refs/heads/")
                .or_else(|| push_tracking.strip_prefix(&conventional_prefix))
                .or_else(|| {
                    if remote == *upstream_remote {
                        upstream_branch.strip_prefix("refs/heads/")
                    } else {
                        None
                    }
                })
                .unwrap_or(&branch)
        } else {
            &branch
        };
        let same_upstream = remote == *upstream_remote
            && upstream_branch.strip_prefix("refs/heads/") == Some(remote_branch);
        let tracking = if same_upstream {
            Some(upstream_ref.to_string())
        } else if remote == *push_remote && !push_tracking.is_empty() {
            Some(push_tracking.to_string())
        } else {
            remote_tracking_ref(ctx, remote, remote_branch)?
        };
        let compared = if same_upstream {
            upstream_counts
        } else if let Some(reference) = tracking.as_deref() {
            let exists = git(ctx, &["show-ref", "--verify", "--quiet", reference])?;
            match exists.status.code() {
                Some(0) => Some(counts(ctx, reference, head)?),
                Some(1) if exists.stderr.is_empty() => None,
                _ => return Err(failure_message(&exists)),
            }
        } else {
            None
        };
        let action = match compared {
            None => ActionKind::Publish,
            Some(_) if upstream.is_none() => ActionKind::Track,
            Some(_) => ActionKind::Push,
        };
        destinations.push(Destination {
            remote: remote.to_string(),
            branch: remote_branch.to_string(),
            action,
            ahead: compared.map_or(0, |(ahead, _)| ahead),
            behind: compared.map_or(0, |(_, behind)| behind),
            tracking,
        });
    }

    Ok(BranchExchange::Branch {
        branch,
        head: head.to_string(),
        checkout: checkout_label(ctx),
        upstream,
        ahead: upstream_counts.map(|(ahead, _)| ahead),
        behind: upstream_counts.map(|(_, behind)| behind),
        destinations,
    })
}

pub(super) fn create_branch(
    project_dir: String,
    worktree: Option<&GitWorktreeSelection>,
    branch: &str,
) -> Result<String, String> {
    let (dir, target) = super::selected_git_context(project_dir, worktree)?;
    if branch.is_empty() || branch.starts_with('-') {
        return Err("Enter a valid branch name.".into());
    }
    output(run_git(
        target.as_ref(),
        &dir,
        &["check-ref-format", &format!("refs/heads/{branch}")],
    )?)?;
    output(run_git(target.as_ref(), &dir, &["checkout", "-b", branch])?)
}

pub(super) fn apply(
    project_dir: String,
    project_id: Option<String>,
    worktree: Option<&GitWorktreeSelection>,
    action: BranchAction,
) -> Result<String, String> {
    let ctx = git_exchange_context(project_dir, worktree)?;
    let id = ctx.mirror_project_id.as_deref().or(project_id.as_deref());
    let auth = id
        .map(crate::commands::git_hosting::project_auth)
        .unwrap_or_default();
    require_hook_trust(ctx.target.as_ref(), &ctx.dir)?;
    let BranchExchange::Branch {
        branch,
        head,
        checkout,
        destinations,
        upstream,
        ..
    } = read(&ctx, None)?
    else {
        return Err("The checkout changed. Refresh the Git view and try again.".into());
    };
    let destination = destinations.iter().find(|dest| {
        dest.remote == action.remote
            && dest.branch == action.remote_branch
            && (action.check_remote || dest.action == action.kind)
    });
    let Some(destination) = destination
        .filter(|_| branch == action.branch && head == action.head && checkout == action.checkout)
    else {
        return Err(
            "The branch or its destination changed. Refresh the Git view and try again.".into(),
        );
    };
    let transport = |args: &[&str]| {
        if args.first() == Some(&"fetch") && ctx.target.is_some() {
            git(&ctx, args)
        } else if ctx.target.is_some() {
            run_git_hooked(ctx.target.as_ref(), &ctx.dir, args)
        } else {
            exchange_local(Path::new(&ctx.dir), &auth, args)
        }
    };
    if action.check_remote {
        return output(transport(&[
            "fetch",
            "--no-prune",
            "--no-tags",
            "--",
            &action.remote,
        ])?);
    }
    let Some(tracking) = destination.tracking.as_deref() else {
        return Err(format!(
            "The remote {} has no fetch mapping for {}.",
            action.remote, action.remote_branch
        ));
    };
    let source = format!("refs/heads/{branch}");
    let destination = format!("refs/heads/{}", action.remote_branch);
    if action.kind == ActionKind::Track {
        output(transport(&[
            "fetch",
            "--no-tags",
            "--",
            &action.remote,
            &destination,
        ])?)?;
        return output(git(
            &ctx,
            &[
                "branch",
                &format!("--set-upstream-to={tracking}"),
                "--",
                &branch,
            ],
        )?);
    }
    let before = super::stdout(
        ctx.target.as_ref(),
        &ctx.dir,
        &["rev-parse", "--verify", "-q", tracking],
    );
    let spec = format!("{source}:{destination}");
    let lease = format!("--force-with-lease={destination}:");
    let mut args = vec!["push", "--no-follow-tags"];
    if action.kind == ActionKind::Publish {
        args.push(&lease);
        if upstream.is_none() {
            args.push("--set-upstream");
        }
    }
    args.extend(["--", &action.remote, &spec]);
    let result = transport(&args)?;
    if !result.status.success() && ctx.target.is_none() {
        // The repo's hook can push an amended HEAD and end the original push.
        let after = super::rev_parse(Path::new(&ctx.dir), tracking);
        if after.is_some()
            && after != before
            && after == super::rev_parse(Path::new(&ctx.dir), &source)
        {
            if action.kind == ActionKind::Publish && upstream.is_none() {
                output(git(
                    &ctx,
                    &[
                        "branch",
                        &format!("--set-upstream-to={tracking}"),
                        "--",
                        &branch,
                    ],
                )?)?;
            }
            return Ok("The repository's pre-push hook pushed the branch.".into());
        }
    }
    super::push_outcome(&result, None, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::{git as fixture_git, init_repo};

    fn observed(root: &str, worktree: Option<&GitWorktreeSelection>, remote: &str) -> BranchAction {
        let ctx = git_exchange_context(root.into(), worktree).unwrap();
        let BranchExchange::Branch {
            branch,
            head,
            checkout,
            destinations,
            ..
        } = read(&ctx, None).unwrap()
        else {
            panic!("expected a branch checkout with destinations");
        };
        let destination = destinations
            .into_iter()
            .find(|dest| dest.remote == remote)
            .unwrap();
        BranchAction {
            kind: destination.action,
            branch,
            head,
            checkout,
            remote: destination.remote,
            remote_branch: destination.branch,
            check_remote: false,
        }
    }

    #[test]
    fn publishes_the_selected_worktree_branch_to_the_chosen_remote() {
        if !super::super::git_available_blocking() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        let worktree = tmp.path().join("linked");
        let fork = tmp.path().join("fork.git");
        let original = tmp.path().join("original.git");
        std::fs::create_dir(&repo).unwrap();
        std::fs::create_dir(&fork).unwrap();
        std::fs::create_dir(&original).unwrap();
        init_repo(&repo);
        fixture_git(&repo, &["commit", "--allow-empty", "-m", "initial"]);
        fixture_git(&fork, &["init", "--bare"]);
        fixture_git(&original, &["init", "--bare"]);
        fixture_git(&repo, &["remote", "add", "origin", fork.to_str().unwrap()]);
        fixture_git(
            &repo,
            &["remote", "add", "upstream", original.to_str().unwrap()],
        );
        fixture_git(
            &repo,
            &[
                "worktree",
                "add",
                "-b",
                "feature/one",
                worktree.to_str().unwrap(),
            ],
        );
        let root = repo.to_str().unwrap();
        let selected = GitWorktreeSelection {
            path: worktree.to_str().unwrap().into(),
            site: "host".into(),
        };
        fixture_git(&worktree, &["commit", "--allow-empty", "-m", "feature"]);
        let action = observed(root, Some(&selected), "origin");
        assert!(matches!(action.kind, ActionKind::Publish));
        let head = action.head.clone();
        apply(root.into(), None, Some(&selected), action).unwrap();
        assert_eq!(
            fixture_git(&fork, &["rev-parse", "refs/heads/feature/one"]),
            head
        );
        assert_eq!(
            fixture_git(&worktree, &["rev-parse", "--symbolic-full-name", "@{u}"]),
            "refs/remotes/origin/feature/one"
        );
        assert_eq!(fixture_git(&repo, &["branch", "--show-current"]), "main");
        assert!(fixture_git(&original, &["for-each-ref"]).is_empty());
        assert!(matches!(
            observed(root, Some(&selected), "origin").kind,
            ActionKind::Push
        ));
    }

    #[test]
    fn refuses_a_branch_created_after_review_then_tracks_its_divergent_tip() {
        if !super::super::git_available_blocking() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        let peer = tmp.path().join("peer");
        let bare = tmp.path().join("remote.git");
        for dir in [&repo, &peer, &bare] {
            std::fs::create_dir(dir).unwrap();
        }
        init_repo(&repo);
        init_repo(&peer);
        fixture_git(&bare, &["init", "--bare"]);
        let remote = bare.to_str().unwrap();
        fixture_git(&repo, &["remote", "add", "fork", remote]);
        fixture_git(
            &repo,
            &[
                "config",
                "remote.fork.fetch",
                "+refs/heads/*:refs/custom/fork/*",
            ],
        );
        fixture_git(&peer, &["remote", "add", "fork", remote]);
        fixture_git(&repo, &["commit", "--allow-empty", "-m", "local"]);
        fixture_git(&peer, &["commit", "--allow-empty", "-m", "independent"]);
        let root = repo.to_str().unwrap();
        let action = observed(root, None, "fork");
        assert!(matches!(action.kind, ActionKind::Publish));
        let local = action.head.clone();
        fixture_git(&peer, &["push", "fork", "refs/heads/main"]);
        let peer_head = fixture_git(&peer, &["rev-parse", "HEAD"]);
        let error = apply(root.into(), None, None, action).unwrap_err();
        assert!(error.contains("stale info"), "{error}");
        assert_eq!(fixture_git(&repo, &["rev-parse", "HEAD"]), local);
        assert_eq!(
            fixture_git(&bare, &["rev-parse", "refs/heads/main"]),
            peer_head
        );
        assert_eq!(
            fixture_git(
                &repo,
                &["for-each-ref", "--format=%(upstream)", "refs/heads/main"]
            ),
            ""
        );

        fixture_git(&repo, &["fetch", "fork"]);
        let action = observed(root, None, "fork");
        assert!(matches!(action.kind, ActionKind::Track));
        apply(root.into(), None, None, action).unwrap();
        let ctx = git_exchange_context(root.into(), None).unwrap();
        let BranchExchange::Branch { ahead, behind, .. } = read(&ctx, None).unwrap() else {
            panic!("expected tracked branch");
        };
        assert_eq!((ahead, behind), (Some(1), Some(1)));
        assert_eq!(
            fixture_git(&repo, &["rev-parse", "--symbolic-full-name", "@{u}"]),
            "refs/custom/fork/main"
        );
        assert_eq!(
            fixture_git(&bare, &["rev-parse", "refs/heads/main"]),
            peer_head
        );
    }

    #[test]
    fn branch_push_remote_overrides_the_comparison_upstream() {
        if !super::super::git_available_blocking() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();
        init_repo(repo);
        fixture_git(repo, &["commit", "--allow-empty", "-m", "local"]);
        fixture_git(
            repo,
            &["remote", "add", "origin", "https://example.com/fork.git"],
        );
        fixture_git(
            repo,
            &[
                "remote",
                "add",
                "upstream",
                "https://example.com/original.git",
            ],
        );
        fixture_git(repo, &["update-ref", "refs/remotes/upstream/main", "HEAD"]);
        fixture_git(repo, &["branch", "--set-upstream-to=upstream/main"]);
        fixture_git(repo, &["config", "branch.main.pushRemote", "origin"]);
        fixture_git(
            repo,
            &[
                "config",
                "remote.origin.push",
                "refs/heads/main:refs/heads/staging",
            ],
        );
        let action = observed(repo.to_str().unwrap(), None, "origin");
        assert!(matches!(action.kind, ActionKind::Publish));
        assert_eq!(action.remote_branch, "staging");
    }
}
