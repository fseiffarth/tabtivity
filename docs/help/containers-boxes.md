---
id: containers-boxes
title: Containers, VMs and project boxes
keywords: [container, docker, sandbox, vm, virtual machine, isolation, trust tier, box, group, meta-project]
related: [projects, remote-projects, agent-clis, server]
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

A box groups related projects for work across them. A project can be in
several boxes, and a box never takes a project away: dissolving one only ends
the grouping. Each box has a colour, and every surface that names the box wears
it.

**Make one.** Click `+` beside the pills → **New Box**, or the dashed **+ Box**
pill that stands beside the ✦ root button until you have a box, or press
Ctrl+K → **New box…**. Type a name (it is pre-filled "Box 1", and must be
non-empty and not used by another box) and press Enter: the box exists and you
are already inside it.

**Fill it.** Drag a project pill onto a box pill (or onto its row in the ▣
list), Alt-drag one pill onto another to box the two, or Ctrl-click several
pills → **Box these…**. The box pill's menu → **Members** and a project pill's
menu → **Boxes** are the same checklist: it stays open while you tick, lists
closed projects too (marked "closed"), scrolls, and gains a filter field past
eight rows. Inside a box, a member pill's menu has a row that removes it, named
after the project and the box.

**Enter and leave.** Click a box pill to enter it: the strip narrows to the
box's projects and takes the box's colour, and the selected pill shows a ✕.
The ✕, **All projects** in the ▣ list, and the first row of the header search
all leave again, back to the project you were on. In the list a ✓ marks the
box you are in and bold marks the box the strip shows. On a narrow window the
pills fold into **▣▾ +N**, which opens the same list. Ctrl+Shift+PageDown/PageUp
walk home → each box → back to the project you came from. Clicking a coloured
swatch on a project's pill opens that box.

**Inside a box.**
- Tabs run in the box's own scope: a box folder under
  `~/tabtivity/boxes/<name>/` whose `AGENTS.md`/`CLAUDE.md`/`GEMINI.md` link
  each member (Tabtivity edits only the marked block in them).
- A tab opened in a member wears a small dot in that project's colour after its
  label (a square for the whole box). Hover it for the member.
- A plain `+` (and Ctrl+Shift+N, Ctrl+Shift+M, Ctrl+1-9) starts a tab in the
  active tab's project, and the menu header says which. Hover **Agents**,
  **Shell** or **Files** for **Start in…** to choose another project or the
  whole box.
- The side panel is an accordion: one section per project, one open at a time.
  Each header shows the project's colour dot, a dot when its git state needs
  attention, and its agent count. Which sections you fold is remembered per box.
- The box pill's status bars count the agents of the box and of its member
  projects.

**Find and manage.** Focusing the header search lists your boxes (and, inside a
box, **All projects** first); typing a member's name finds its box too.
Ctrl+K has a **Boxes** group, **New box…**, **Show all projects** (inside a
box) and **Add (current project) to (box)**. Right-click a box pill for Open, Rename,
**Edit box…** (the box sheet: name, colour, folder, phone access, and
**Dissolve box…**), Members or **Dissolve box…**. A popout window that shows a
box carries its name and colour in the title bar. With four or more projects
and no box, a hint points at the **+ Box** pill; the lesson "Group projects
into a box" (Help → Lessons) walks through all of this.

Box tabs run locally and uncontained, even when a member uses a container or
VM; the box sheet warns about that.
