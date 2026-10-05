---
id: sync
title: Syncing remote projects (Git sync and file sync)
keywords: [sync, Git sync, file sync, lockstep, byte-sync, mirror, remote, git, commit, conflict, orange, diverged, push, pull, auto-sync, exclude]
---

A remote project has two working trees: the **mirror** on this machine and the
**host** folder on the remote machine. Two engines keep them in step, and they
split the files by git.

## The two engines

| | Git sync | File sync |
|---|---|---|
| Owns | git-tracked files | everything else (untracked, gitignored) |
| Moves | commits and branches | raw file bytes |
| Scope | the whole repo, once enabled | only paths you mark |
| Reads `.gitignore` | yes | no |
| Conflicts | fast-forward only; a divergence is reported, never auto-resolved | a file changed on both sides is skipped and shown orange |

Both run only while the project is connected. Hosts tagged HPC get no
background sync; manual actions still work.

## The rule to remember

With Git sync on (the default for a new git-backed remote project), **a saved
edit to a tracked file reaches the other side only after you commit it.**
File sync will not carry tracked files. This is by design.

## Git sync

(Earlier versions called this *lockstep*.)

- Toggle it with **⇄ Git sync** in the file panel's Git view.
- On first pass it pairs the two sides: the side with commits becomes the
  authority. If the empty side already holds differing files, pairing stops
  and names them; **Overwrite** is the explicit consent.
- Branch checkouts replay on the other side.
- When both sides committed (**Diverged**): choose **Use local**, **Use
  remote**, or **Resolve in terminal** (the other side's tip is at
  `refs/tabtivity/peer/<branch>`, so `git merge` or a rebase works). Overwritten
  tips are backed up under `refs/tabtivity/backup/…` and can be restored from
  **Backups**.

## File sync

(Earlier versions called this *byte-sync*.)

Right-click a file or folder in the remote tree:

- **Sync to local** / **Push to host** — transfer now.
- **Auto-sync this file/folder** — keep it in step in the background.
- **Exclude from sync** — skip it everywhere, including "Sync all".
- **Stop syncing** — forget the path; local bytes stay.

The view header has **Auto-sync all** and **Large folders…** (a census that
lets you exclude big trees). Auto-syncing a folder that would pull more than
200 files or 100 MB asks first. Every manual transfer shows a confirmation with
direction, file count, size and which files would be overwritten.

## Colours in the file tree

- **green** — in step.
- **amber / orange** — one or both sides changed. Orange files appear in the
  **± diverged** list: open the merge viewer, or take the host's or keep the
  local version.
- **⬆ new local** — exists only in the mirror and was never synced; an upload
  offer.

## Common situations

| You see | Do |
|---|---|
| A saved edit is not on the host | commit it (the file is tracked) |
| A host output folder appeared locally | **Exclude from sync** on it |
| Orange row, both sides changed | merge viewer, or take one side |
| Orange row for a file you deleted | apply the delete, or restore it |
| Git sync red: *Diverged* | Use local / Use remote / resolve in terminal |
| Git sync red: *Out of step* | pick a branch in the Git view |
| "Files changed on your local copy" dialog | a sync step removed or overwrote mirror files; read the entry — git-side losses name the restore command |

## Workers

Extra compute machines with a synced copy receive the mirror's current commit,
one way, tracked files only; their untracked outputs survive. **Pull
outputs…** is the only way back. Shared-folder workers need no sync. See
`remote-projects`.
