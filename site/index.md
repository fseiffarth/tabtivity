---
layout: default
---

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-wordmark-white.svg">
    <img alt="Tabtivity logo" src="assets/logo-wordmark.svg" width="160">
  </picture>
</p>

Tabtivity is a project-centric desktop layer. Switch projects and your whole
working context swaps as one unit: windows, files, apps, Git state, layout,
and especially your AI agent terminals.

**[Download the latest release](https://github.com/fseiffarth/tabtivity/releases/latest)**
· [Source on GitHub](https://github.com/fseiffarth/tabtivity)
· Linux, Windows, macOS · **Alpha**

![The Tabtivity window: project bar, tiled agent terminals, and the side panel](assets/eldrun-current.png)

## Three pillars

**One project = one desktop.** Select a project and the desktop becomes that
project: its windows come forward, the previous project's windows park out of
the way, default apps re-route, and time tracking switches. Need two projects
at once? *Box* them into one shared desktop, file tree and set of agent tabs,
then unbox them afterwards, leaving both exactly as they were.

**One project = any machine.** Point a project at an SSH host and its agent
tabs, shells, Python runs and jobs execute *there*, while the file tree,
viewers and Git views keep working as they do locally. No sshfs or FUSE mount,
long runs survive an SSH drop or a closed laptop lid, and SLURM clusters are
driven from the same cockpit: submit, watch, cancel, and grab an interactive
compute node.

**Every agent = one phone.** The opt-in Tabtivity Mobile app reaches every agent
tab (Claude, Codex, Gemini, Qwen, Grok, Cursor, Copilot, OpenCode and the rest)
from your phone over your own private tailnet. It works whether or not the
vendor ships a phone app, and no vendor relay sits in between.

## Is Tabtivity for you?

| Try Tabtivity if you… | Look elsewhere if you… |
| --- | --- |
| work across several projects and want each one to bring back its own desktop, files, apps and agent sessions | need a platform that dispatches, supervises and recovers multi-day agent work without you |
| work on remote machines or an HPC cluster over SSH and want easy reconnection | want the tool to manage the agent workflow for you |
| want to monitor or answer your agents from your phone | |
| run many models in parallel and are tired of hunting for the right tab | |

Tabtivity is a project workspace and control cockpit, not an autonomous agent
scheduler. It complements task orchestrators: run one inside an Tabtivity
terminal while Tabtivity handles switching the desktop between projects.

## What's inside

![Tabtivity functionality map](assets/tabtivity-functionality.svg)

- **Agent terminals:** 27 built-in agent CLIs plus your own, with resume where
  the CLI supports it, each fenced into its own sandboxed home.
- **Tiling tab layout:** agent tabs, shells, file viewers and app tabs side by
  side. Any tab can pop out into its own window.
- **Files, Git and search:** a side panel with the file tree, Git views and
  search, plus built-in viewers for PDF, Markdown, images, tables and more.
- **Remote projects and HPC:** SSH hosts, GPU boxes and SLURM clusters from one
  place.
- **Containers and VMs:** run a project inside a Docker container or a QEMU VM.
- **Mail, calendar, to-do:** a mail client, a calendar with a to-do board, and
  a private daily recap of where your time went.
- **Workspace apps:** a reader-mode browser, a print manager, an Agent Skills
  library, TeX workspaces, and a slide presenter.

## Download

Grab a package from the
[latest release](https://github.com/fseiffarth/tabtivity/releases/latest).
Nothing else is required. Once Tabtivity is installed, **Settings → Updates** can
fetch newer builds for you.

| Platform | Package | Status |
| --- | --- | --- |
| Linux (X11) | `.AppImage` or `.deb` | Primary development target |
| Linux (KDE Wayland) | `.AppImage` or `.deb` | Supported, KDE 5 and 6 |
| Linux (other Wayland) | `.AppImage` or `.deb` | Partial: no workspace switching |
| Windows | `.exe` installer | Alpha, CI-verified |
| macOS | universal `.dmg`, unsigned | Builds in CI, not yet tried on real hardware |

The Linux packages need glibc 2.39 or newer (Ubuntu 24.04+, Debian 13+,
Fedora 40+). The macOS app is not notarized, so after dragging it into
Applications, run this once:

```sh
xattr -dr com.apple.quarantine /Applications/Tabtivity.app
```

Each of these optional tools unlocks one feature: OpenSSH (plus `tmux` on the
host) for remote projects, Docker for containers, QEMU for VMs, Tailscale for
Tabtivity Mobile, and Ollama for local-model features.

To build Tabtivity yourself, see
[Building from source](https://github.com/fseiffarth/tabtivity#building-from-source).

---

[Documentation](https://github.com/fseiffarth/tabtivity#readme) ·
[Status](https://github.com/fseiffarth/tabtivity/blob/main/STATUS.md) ·
[Roadmap](https://github.com/fseiffarth/tabtivity/blob/main/ROADMAP.md) ·
[Issues](https://github.com/fseiffarth/tabtivity/issues) ·
Dual-licensed MIT or Apache-2.0
