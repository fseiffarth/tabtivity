# Git workflow for projects in Tabtivity

> **Status (screened against code 2026-11-22):** PARTIAL, mostly built on 2026-11-18 (`50e609274`, `a0dcc3867`, `38d3305ff`). §1: "Publish branch to {destination}" (`projectFilesView.publishBranchTo`) and track/publish backend. §2: `commands/git_pull.rs` `reviewed_refs` pins fetch/preview/apply to the reviewed commit IDs; `GitPullPanel` reuses the fetch receipt. §3: per-file stage/unstage in `GitChangeTree.tsx` (`git_add_path` `unstage`), per-checkout drafts. §4: push-rejection recovery landed; the per-step commit/peer/hosting completion display and the "Delivery" performance measurements were not individually verified. Not live-tested.


A project owner should be able to open a repository, choose what goes into a commit, and get that commit onto the intended branch using the project’s Git view. The first change to ship is first-push support for a new branch. The next is making the repository used for a network operation consistent from preview through execution.

## Current workflow

| Project stage | What Tabtivity does today |
| --- | --- |
| Set up | New Project can initialize Git. Import registers a folder. Clone brings down an existing repository, and Fork and Clone uses the fork as origin and attempts to retain the original as upstream. Publishing a local repository asks for the provider and visibility. |
| Review and commit | The project file view detects nested repositories. The Git view supports a selected worktree. Add stages all changes in that checkout. The file tree also offers per-path staging. Commit generates an editable message from staged names and commits the index. |
| Exchange commits | Fetch refreshes tracking refs. Pull fetches, previews incoming commits and files, then offers a fast-forward or an explicit merge when branches diverge. Push uses the repository’s Git configuration and applicable credentials. |
| Work on a remote machine | A remote-only project runs Git on its host. A mirrored project can publish from the host or mirror. When Git lockstep is enabled, commits transfer tracked files between the two checkouts. Publishing sends commits to a hosting remote. Those transfers can complete at different times. |

Existing entry points are [project setup](../src/components/projects/ProjectDialog.tsx), [fork and clone](../src-tauri/src/commands/git_fork.rs), [publishing](../src-tauri/src/commands/git_publish.rs), [the project Git view](../src/components/files/ProjectFilesView.tsx), and [remote synchronization](remote_sync_guide.md).

## 1. Make the first push discoverable

A user clones a repository, creates a branch in a worktree, and commits. The bar shows Push only when the list of commits ahead of a comparison ref is nonempty. For a new branch with neither an upstream nor a same-named remote branch, there is no comparison ref. The list is empty even though the backend can establish tracking on a first push. A fresh branch can therefore lose its next action precisely when the user needs it.

| Observed state | Next action in the Git view |
| --- | --- |
| Repository has commits and no hosting remote | Offer the existing Publish flow where supported. Show the provider, visibility and source checkout before publication. |
| Branch has commits and a remote, but no tracking branch or remote namesake | Offer **Publish branch**. Show the destination remote and branch. Ask the user to select a destination if it is ambiguous. Set tracking on successful push. |
| Branch has a remote namesake and no configured upstream | Compare with the existing ref. Offer to track that branch. Check for remote changes before updating it. |
| Branch tracks an upstream | Show incoming and outgoing counts from the last successful comparison. Offer Push when ahead and the existing pull preview when behind or diverged. |
| Detached HEAD, unborn branch, or comparison failure | Identify the observed condition. Offer branch creation, a first commit, or retry respectively. |

Use one backend result to distinguish these states. Include the branch and effective destination. A remote called `upstream` in a fork can refer to the original project, while the branch’s configured upstream can point at the fork. Use the configured push destination and show its name. Preserve existing trust and credential handling for the operation.

**Acceptance.** Clone, create a new branch, commit, and publish it from the Git view. Verify the intended remote ref and the local tracking configuration. Repeat with multiple remotes, a fork, a remote namesake with different history, and a rejected push. A rejection must leave the local commit available and report the reason. [Push visibility](../src/components/files/ProjectFilesView.tsx) · [Comparison and push implementation](../src-tauri/src/commands/git.rs)

## 2. Keep fetch, preview, and apply on the intended checkout

On the default path for a mirrored project, fetch can run in the mirror that owns the hosting remote. Pull preview and apply independently resolve the project directory, which can select the host. A second issue applies to local projects too. Apply receives the branch name and merge choice, then resolves the upstream ref again. A fetch while the preview is open can move that ref beyond the commits the user reviewed.

- Resolve the source checkout and destination once for each network operation. Carry the site, validated worktree, and branch through fetch, preview, and apply. When a mirror owns the hosting remote, identify the mirror in the preview and show subsequent lockstep progress separately.
- Include the reviewed local and incoming commit IDs in a pull preview. Revalidate the checkout and branch before applying, use the reviewed incoming commit, and request a fresh preview if either tip moved. Retain fast-forward by default, explicit merge for divergence, conflict resolution, and merge abort.
- After a successful fetch, allow the pull panel to reuse that result for the same checkout and upstream. Show when the last fetch succeeded and expose retry after an offline or authentication error.

**Acceptance.** Give host and mirror distinguishable branch tips and verify that fetch, preview, and apply use the indicated checkout. Repeat on a local project, a remote-only project, and a selected linked worktree. Advance the upstream after opening a preview. The new commits should require a fresh review. [Fetch and apply](../src-tauri/src/commands/git_pull.rs) · [Pull panel](../src/components/files/GitPullPanel.tsx) · [Worktree resolution](../src-tauri/src/commands/git.rs)

## 3. Make a selective commit possible from one view

The Git bar has an Add All action and a read-only change list. Staging an individual file requires switching to the file tree. Bring stage and unstage actions beside each file in the Git view, retaining Add All for users who want the entire checkout.

- Route each action through the selected repository, site, and worktree. Unstaging must preserve working-tree edits. Show the staged diff so the user can see which version of a partially staged file the next commit will record.
- Keep the draft commit message bound to its checkout. If the user switches repository or worktree while composing, restore the draft only in its original context. On a refused commit, keep the draft and show the Git diagnostic.
- Populate untracked filenames first. Load optional line counts for visible rows with bounded reads so a large file or slow SFTP connection does not hold up staging.

**Acceptance.** Modify two files, stage one, inspect it, and commit. Verify the commit contains only the chosen change and the second edit remains on disk. Repeat with a partially staged file, an initial commit, and a linked worktree. [Git action bar](../src/components/files/ProjectFilesView.tsx) · [Change list](../src/components/files/GitChangeTree.tsx) · [Existing per-path action](../src/components/files/FileTree.tsx)

## 4. Make completion and recovery clear

After commit, show the branch and short commit ID. After push, show the destination and result. For a mirrored project, distinguish a commit recorded on the working checkout, its arrival on the peer, and its publication to the hosting remote. Only mark each step complete when its own backend reports success. Existing agent push proposals should continue to use their per-project approval policy.

Use the operation result to offer the next available action. A non-fast-forward rejection leads to fetch and review. A merge conflict leads back to resolution or abort. A failed host connection leaves the last successful reading identifiable and offers retry after reconnection. Check the remote tip before retrying a push whose outcome is uncertain.

**Acceptance.** Interrupt a transfer, reconnect, and verify the displayed checkout, peer, and hosting states against their actual refs. After a rejected push, the user should be able to fetch, inspect incoming changes, resolve divergence, and retry from the project. [Remote sync states](remote_sync_guide.md) · [Git history and merge controls](../src/components/files/GitHistory.tsx) · [Agent push proposals](../src/components/agents/GitPushMcp.tsx)

## Delivery and verification

Ship each phase separately. Start with a temporary local checkout and a bare remote to cover first push, divergence, and retry without a provider account. Extend the same scenarios to forks and a host/mirror pair. Check final refs, index contents, and working-tree files alongside what the UI reports.

Measure supporting performance changes within those workflows. Reuse the ahead count from status for tracked branches, coalesce post-action and watcher refreshes, and verify that paging history does not rerun an unchanged search. Record Git subprocesses per refresh and time to first change-list row locally and over SSH.

This plan is based on source review. For implementation, run the affected gates and report backend staleness after Rust changes. Record live project and remote verification separately.
