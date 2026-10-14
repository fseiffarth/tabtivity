---
id: project-transfer
title: Move, export, archive and repair projects
keywords: [export, import, move, another computer, transfer, bundle, tabtivityproj, backup, archive, delete, restore, archived projects, close project, rename folder, repair scaffold, scaffold, remove git, migrate]
related: [projects, remote-projects, containers-boxes]
---

How to carry a project to another computer, put it away without losing it,
and repair what Tabtivity set up in it.

## Carry a project to another computer

1. On the project pill's menu, **Export project…** writes one file
   (`.tabtivityproj`) holding the project. Choose what goes in:
   - **Project files** (for a remote project: from one of its two copies;
     nothing on the host is changed),
   - **Git history** — leave it out if the other computer will clone from the
     remote instead,
   - **Skip rebuildable folders** — `node_modules`, `.venv`, `target` and build
     caches, which the other computer rebuilds,
   - **Open tabs**, re-pointed to the new folder on import.

   Always carried: name, description, categories, git and remote settings,
   container setup, interpreter and time history. **Never carried**: saved
   passwords and access tokens (they stay in this computer's keyring) and sync
   state tied to this machine.
2. Copy the file to the other computer.
3. There: `+` in the project bar → **Import Project File**, choose the file,
   then the name and the folder to import into. Optionally **Restore tabs**,
   **Restore time tracking** and **Join the same boxes**. A tab whose command
   the other Tabtivity does not know comes back as a plain shell.

A VM project cannot be exported (its files live on the VM's own disk); copy
them out into a plain project first.

## Import an existing folder instead

To register a folder that is already on this computer (keep it in place, copy
or move it), or clone from GitHub or GitLab, use `+` → **Import Project** or
**Import from GitHub/GitLab**. See `projects`.

## Close, archive or delete a project

- **Close project** (pill menu) takes its pill out of the project bar; its
  folder, tabs and settings stay, and it comes back from the project search.
- **Delete to archive** disconnects the project and moves it into Tabtivity's
  archive. On a remote project, the files on the host are not touched.
- **Settings → Workspace & apps → Archived Projects** lists archived projects:
  **Restore**, or **Delete permanently…** (type the name to confirm). **Clear
  archive…** deletes them all after you type "delete".

## Rename a project's folder

Renaming the folder from the pill menu closes the project for the rename
(running terminals and agents stop) and reopens it. Agent conversations
started in the old folder can't be resumed from the new one.

## Repair the scaffold

New projects get `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, a `.gitignore` and
`.claude/settings.json`. **Repair scaffold files** on the pill menu (or
**Settings → Workspace & apps → Repair Project Scaffold** for several
projects) fills in any that are missing. It never overwrites what is there.

## Remove git and history

**Remove git & history…** on the pill menu deletes the project's `.git` folder
and with it all version history. It cannot be undone.
