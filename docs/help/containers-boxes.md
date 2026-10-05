---
id: containers-boxes
title: Containers, VMs and project boxes
keywords: [container, docker, sandbox, vm, virtual machine, isolation, trust tier, box, group, meta-project]
---

## Where a project runs (trust tiers)

| Tier | Tabs run | Files | Chosen |
|---|---|---|---|
| This machine | on the host | on the host | default for new projects |
| Docker container | in one closed container per project | stay on the host, mounted at the same path | at creation, or later from the pill |
| Virtual machine | in a QEMU guest over SSH | only inside the guest | at creation only |
| Remote SSH | on another machine | on that machine | see `remote-projects` |

## Run a project in a Docker container

Needs Docker (Docker Desktop on Windows and macOS). Local projects only.

1. New/Import dialog → **Where this project runs** → **In a Docker
   container**, or later right-click the pill and turn on **Run this project
   in a container**.
2. Every shell and agent tab of the project then runs inside one
   capability-dropped container that can reach this project folder and
   nothing else. Local Model tabs stay on the host.
3. **Container settings…** on the pill holds the image and "What runs in the
   container": everything (default), or agent tabs only — which leaves shells
   and Run/Debug on the host so a `.venv`, conda or pyenv keeps working.
4. A `Dockerfile` or devcontainer in the repo is adopted on first enable; a
   missing image becomes a one-click build tab.

Turning the container on or off respawns the project's tabs; the pill warns
when a conversation that cannot resume would be lost.

## Run a project inside a VM

The strongest isolation: a real virtual machine with no shared filesystem.
Choose **Inside a virtual machine (strongest isolation)** in the New dialog (or
when cloning a repository). It cannot be switched on later. The dialog offers
the missing prerequisites and the base image download (Ubuntu cloud image,
about 600 MB) as one-click terminal tabs. The pill's VM menu boots and shuts
down the guest and sets resources and network access. The VM tier is new and
less tested than the others.

## The Linux agent sandbox

Separate from containers: on Linux every local agent tab runs inside a
bubblewrap sandbox by default, with the project writable and your home folder
hidden. See `agent-clis`.

## Project boxes

A box temporarily groups related projects, for side-by-side work across them.
A project can be in several boxes; deleting a box never deletes its projects.

1. Click `+` beside the pills → **New Box**. The ▣ chip beside the ✦ root
   button lists boxes.
2. Add projects: drag a pill onto a box pill (or onto a row of the ▣ list),
   Alt-drag one pill onto another to box the two, or Ctrl-click several pills
   → **Box these…**.
3. Click a box pill to open the **box scope**: its own tabs, a file view with
   every member, and a box folder under `~/tabtivity/boxes/<name>/` whose
   `AGENTS.md`/`CLAUDE.md`/`GEMINI.md` link each member (Tabtivity edits only the
   marked block in them). The `+` menu offers per-member Files, Shell and
   Claude rows.
4. Right-click a box pill for Open, Rename, Edit box, Members or Delete.
   Ctrl+Shift+PageDown/PageUp cycles boxes.

Box tabs run locally and uncontained, even when a member uses a container or
VM; the box editor warns about that.
