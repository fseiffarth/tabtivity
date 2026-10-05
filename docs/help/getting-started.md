---
id: getting-started
title: Getting started with Tabtivity
keywords: [start, first run, welcome, intro, overview, setup, onboarding, tour, lessons]
---

Tabtivity keeps AI-assisted development in one window: projects in the header,
terminals and AI agent tabs in the middle, a file panel at the edge. This page
is the shortest path from a fresh install to a working agent tab.

## The window at a glance

- **Header** — the ✦ root button, one pill per open project, the `+` for new
  projects, and indicators (mail, calendar, to-do board, VPN, machines, the
  Models & agents button, CPU/RAM/GPU).
- **Center** — the active project's tabs: agents, shells, file viewers. Drag a
  tab onto a pane edge to split the view.
- **File panel** — push the cursor to the right edge to reveal the project's
  file tree; click the pin to dock it.
- **Root console** (Ctrl+Shift+R) — a terminal that belongs to no project, in
  Tabtivity's root folder (`~/tabtivity/root`). It floats over whatever is open.

## First steps

1. **Create or import a project.** Click `+` beside the project pills and pick
   New Project (a fresh folder with a git repo) or Import Project (register a
   folder you already have). See the `projects` topic.
2. **Install an agent CLI.** Open Settings → Agents → Manage CLIs and click
   Install for Claude, Codex, Gemini or another agent. The install runs in a
   visible terminal tab. See `agent-clis`.
3. **Open an agent tab.** Click `+` on the project's tab bar and pick the agent
   under "Agents & CLIs". The first start asks you to sign in inside the tab.
4. **Optional: add a local model.** Install Ollama and pull a small model to
   run on your own machine. See `local-models`.
5. **Find your files.** Reveal the file panel at the right edge; double-click
   a file to open it in Tabtivity's built-in viewer.

## Learning more inside Tabtivity

- **How to start** — the first-run introduction; reopen it from the Settings
  menu (gear) or Settings → General → Hints & onboarding.
- **Take a tour / Advanced tour** — guided highlights of the window; the
  advanced tour covers remote hosts, VPN, containers, VMs and the phone.
- **Lessons** — narrated step-by-step walkthroughs, one per task (add a
  project, add a tab, install an agent, pull a local model, SSH projects, …).
- **Feature Guide** — Settings → General → Feature Guide lists what each part
  of Tabtivity does.
- **F1** — the keyboard shortcut cheat sheet.
- **Ask Tabtivity** — agent tabs can query this help corpus through the
  `tabtivity-help` tools. See `ask-tabtivity`.

## Platforms

Linux (X11 and KDE Wayland) is the primary platform. Other Wayland desktops
work with reduced window management. Windows builds are alpha: no agent
agent sandbox and no tmux session persistence. macOS builds compile and pass
tests in CI but are not yet exercised on real hardware.
