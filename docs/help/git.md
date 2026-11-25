---
id: git
title: Git — commit, push, branches, worktrees and agent pushes
keywords: [git, commit, push, pull, fetch, merge, stage, branch, checkout, worktree, history, graph, amend, commit message, github, gitlab, publish, token, access token, git hosting, release, tag, ci, actions, code scanning, git_push, git_release, tabtivity-git, hooks, pre-push]
related: [sync, projects, remote-projects, agent-clis, server-sharing]
---

Every project with a git repository gets git tools in the file panel, and
local agent tabs can ask Tabtivity to push for them without ever seeing your
token.

## The file tree's git markers

Files in the **Files** view are coloured by their git state: modified,
untracked, staged, committed but not yet pushed, and ignored. Project pills
show a dot while a project has uncommitted work (not in Fast mode).

## Commit and push

At the top of the file panel's git bar:

- **Add (n)** stages every change (the count shows what is unstaged); **Show
  changed files** lists them, each with **Stage** / **Unstage** and a **Staged
  diff**, so one commit can hold just some of your edits.
- **Commit (n)** commits the staged files: type the message, then **Confirm
  commit**. The draft message belongs to its checkout (repository or
  worktree) and stays if the commit is refused.
- **Push (n)** pushes the commits not on the remote yet; the arrow beside it
  lists the files they touch. A new branch with no remote copy shows
  **Publish branch to …** instead (it sets up tracking), and a branch whose
  remote namesake exists shows **Track …**. A rejected push leaves your commit
  in place and offers **Fetch and review**.

Git runs with your own settings, but a repository's hooks run only once you
have allowed them for that project, and again after they change.

## History, branches and pull

The **Git** view of the file panel shows:

- The current branch and **Branches**: click a branch to check it out, or
  create a **new branch**.
- The commit list, as **≡ List** or **⌗ Graph**, with a search and **Load
  older commits**. Click a commit to open it: reword the latest one (**Save
  (amend)**), let an agent write the message (**Generate (agent)**), or
  **Checkout** that commit.
- **Fetch** updates how far each branch is behind its upstream. A branch that
  is behind shows a chip; click it to review the incoming commits and changed
  files (with diffs) before you **Fast-forward** or **Merge**. The review is
  pinned to the commits you looked at: if the remote moves meanwhile, you get
  a fresh review. A merge that conflicts stops, and you resolve the files one
  by one.

## Worktrees

**Worktrees** in the Git view lists the repository's worktrees. **+ Worktree**
adds one for a branch (an existing one, or a new branch from a start point);
select a worktree to see its branch and history. **Lock** keeps a worktree
safe from **Prune** and a plain remove; **Prune** drops the entries of
worktrees whose folder is gone. Removing a worktree deletes its folder — git
refuses when tracked changes are uncommitted, and asks before going ahead
anyway.

## Remote projects

On a remote (SSH) project the Git view also shows **⇄ Git sync**, which keeps
the local copy and the host on the same commit, with **Use local**, **Use
remote**, **Resolve in terminal** and **Backups** when they diverge. See
`sync`.

## Publish to GitHub or GitLab, and tokens

A project with no remote yet can be published from its pill menu: **Publish
to GitHub / GitLab**, public or private (see `projects`). It uses the `gh` or
`glab` CLI, signed in, or a token you saved under **Settings → Remote &
mobile → Git Hosting**.

Git Hosting lists your hosts — github.com, gitlab.com, your own GitLab or
GitHub Enterprise — each with its profile URL and one access token (**Add
host** for another). The first host is the default. Tabtivity hands each token
only to its own host when it pushes, fetches, clones, publishes or forks, so a
GitLab token never goes to GitHub. Tokens are kept in your system keyring, not
in a file; a token an older version saved in its settings file moves to the
keyring the next time Tabtivity starts.

A single project can use its own token instead: pill menu → **Git hosting…**.
While a project has one, it is used for that project and the host tokens are
not. A token limited to one repository (a GitHub fine-grained token, a GitLab
project access token) is the safest choice for a project where agents push:
their pushes can then reach only that repository.

## Letting agents push, tag releases and read CI

A local Claude, Codex or tool-capable Local Model tab in a git project gets
the `tabtivity-git` tools. A project folder that is not a git repository gets
none; once you make it one, tabs opened from then on get them. The agent asks; Tabtivity pushes with your stored token
outside the agent's sandbox, so the agent never sees it.

- **git_push** pushes the checked-out branch, fast-forward only, to its
  existing upstream. Never a force-push, a delete, a tag, a new remote branch,
  or a branch you listed as protected. A push to the remote's default branch
  (usually `main`) is allowed but always waits for your click, even at
  **Push immediately**. The repository's `pre-push` hook runs first inside the
  sandbox, without the token. On Windows, which has no sandbox, it runs only
  once you approved the repository's hooks: push once from the git bar,
  which asks, and agent pushes run the hook from then on until it changes.
- **git_release** proposes an annotated release tag on the branch's pushed
  tip. A release **always** waits for you to press **Release** on its card.
- **ci_runs**, **ci_run** and **ci_security_alerts** read the repository's
  GitHub Actions runs, failed-job logs and code-scanning alerts — read-only.
  The first read of a repository that is not the one confirmed for pushes
  shows a card: **Allow** only if it is this project's own repository.

Per project, on the project pill's menu (**Agent pushes**): **Off**,
**Propose for approval** (the default — every push is a card you click) or
**Push immediately**. The first push to a new URL always asks. Optionally list
**protected branches** an agent may never push (list `main` to keep agents
off it entirely). The cards show the agent's
note, the state (waiting for you, pushed, failed, dismissed, expired) and the
output. The whole feature can be switched off in **Settings → Agents → Manage
CLIs** (under Advanced): **Let project agents ask Tabtivity to push, tag
releases and read CI**.

Not available in remote, VM or container tabs. Limits: six push or release
requests per hour and two pending per tab; sixty CI reads per tab per hour.

## Sharing a project with others on a server

On a hosted Tabtivity server you can share a git project with other users of
that server. See `server-sharing`.
