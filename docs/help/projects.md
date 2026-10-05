---
id: projects
title: Projects
keywords: [project, create, new, import, folder, clone, github, gitlab, fork, scaffold, pill, workspace, publish]
---

A project is a folder Tabtivity manages as one workspace: its own pill in the
header, its own tabs and layout, its own file tree and git view. Switching
pills swaps all of that at once.

## Create a new project

1. Click the `+` just right of the last project pill in the header.
2. Pick **New Project**.
3. Enter a name (the only required field). It becomes the folder name,
   lowercased with spaces turned into hyphens.
4. Optional: a description, and **Git hosting** — no git, a local repo only,
   or push to GitHub/GitLab as private or public.
5. Optional: **Where this project runs** — on this machine (default), inside a
   Docker container, or inside a virtual machine. See `containers-boxes`.
6. Click **Create**. Tabtivity creates `~/tabtivity/projects/<name>/` (the Location
   picker changes it), writes starter files, initializes git and makes a
   first commit. Tick "Skip scaffolding" to start empty.

Starter files include `AGENTS.md` (the canonical agent instructions),
`CLAUDE.md` and `GEMINI.md` (pointers that import `AGENTS.md`), a `.gitignore`,
`README.md`, `TODO.md` and a few status documents. Existing files are never
overwritten.

## Import an existing folder or repository

1. Click `+` → **Import Project** (or **Import from GitHub/GitLab**).
2. **Import from**: a folder on this machine, a repository to clone, or a
   repository to fork into your account and then clone. Forking uses the
   provider's CLI (`gh` or `glab`) and its login.
3. For a folder, **Import mode**: keep it where it is, or copy/move it into
   Tabtivity's projects folder. Tabtivity does not modify the folder's contents; it
   only adds missing starter files.
4. Check **Where this project runs**. For imported code Tabtivity recommends the
   strictest tier this machine supports — a virtual machine for a cloned
   repository when the VM prerequisites are present, otherwise a Docker
   container when Docker is available, otherwise this machine — so build
   scripts and agent instructions you have not read yet stay contained. You
   can pick another tier.
5. Confirm. The project's pill appears in the header.

Private repositories clone with the access token from Settings → Remote &
mobile → Git Hosting, or with your SSH keys when you use a `git@…` URL.

## Remote and HPC projects

Tick **Remote (SSH) project** at the top of the New or Import dialog to keep
the project on another machine. **HPC pipeline…** in the same `+` menu is a
guided SLURM wizard. See `remote-projects`.

## Working with pills

- Click a pill to switch to that project; drag pills to reorder them.
- Hover a pill for its path, status and today's active time.
- Right-click a pill for project actions: container settings, remote
  machines, **Extend to remote…**, **Publish to GitHub / GitLab…**, **Export
  project…** and more.
- The × on a pill closes the project (it stays registered). The search box
  finds projects that are not open.
- Drop one pill on another (Alt-drag) to group them into a box. See
  `containers-boxes`.

## What is saved per project

- **In the project folder**: `project.json` (name, tasks, file-hiding rules)
  and the starter files. Everything inside a project folder is treated as
  untrusted: tab state and apps are never read from it.
- **In Tabtivity's state directory**: the project index (`projects.json`) and the
  tab layout (`sessions/<id>/terminals.json`).
- **Tabs after a restart**: shell and file tabs come back. Agent tabs come back
  when their CLI can resume (see `agent-clis`).

## Publish to GitHub or GitLab later

1. Right-click the pill → **Publish to GitHub / GitLab…**.
2. Choose the provider and public or private.
3. Tabtivity runs `gh` or `glab` to create the repository and push. The chosen
   CLI must be installed and signed in, or a token must be saved under
   Settings → Git Hosting.

## Tasks

Right-click an agent tab to set, complete or clear its task. Tasks are stored
in the project's `project.json` and can seed a new agent's prompt.
