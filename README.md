<picture>
  <source media="(prefers-color-scheme: dark)" srcset="src/assets/logo-wordmark-white.svg">
  <img alt="Tabtivity logo" src="src/assets/logo-wordmark.svg">
</picture>

**Tabtivity** — *A tab for each project. A tab for everything in it.*
(Formerly Eldrun; an existing install is carried over on its first start.)

# You open projects not applications

[![CI](https://github.com/fseiffarth/tabtivity/actions/workflows/ci-cd.yml/badge.svg)](https://github.com/fseiffarth/tabtivity/actions/workflows/ci-cd.yml)
[![License: MIT OR Apache-2.0](https://img.shields.io/badge/License-MIT%20OR%20Apache--2.0-yellow.svg)](#license)
[![Release](https://img.shields.io/github/v/release/fseiffarth/tabtivity)](https://github.com/fseiffarth/tabtivity/releases)
![Status: Alpha](https://img.shields.io/badge/status-alpha-orange)
![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-blue)
![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri)

[![Tabtivity in 90 seconds: projects, any agent, local models, split tabs, Git, remote runs, PDF markup, the phone app, mail and calendar](screenshots/tabtivity-promo.gif)](screenshots/tabtivity-promo.mp4)

▶ **[Watch the 90-second promo with sound](screenshots/tabtivity-promo.mp4)**

## Introduction

Tabtivity is a project-centric desktop layer that swaps your entire working context — windows, files, apps, Git state, layout, and especially AI agent terminals — as a single unit when you switch projects.

| **Who should try Tabtivity** | **Who should look elsewhere** |
| --- | --- |
| You work across several projects and want each one to bring back its own desktop, files, apps, and agent sessions. | Your main need is an autonomous agent platform that dispatches, supervises, and recovers multi-day work without your involvement. |
| You work on multiple remote machines or an HPC cluster over SSH and want easy reconnection and simple distribution of tasks across machines. | You want Tabtivity to manage the agent workflow. Tabtivity is a project workspace and control cockpit, not an autonomous agent scheduler. |
| You want to monitor or answer your agents from your phone independently of developer apps. | |
| You need structure and control and are tired of switching between your agent tabs. You use many different models (claude, openai, meta, google, ...) in parallel. | |

## Get started

1. **Install.** Grab a package from the
   [latest release](https://github.com/fseiffarth/tabtivity/releases/latest)
   (see [Download](#download)) or [build from source](#building-from-source).
   Nothing else is required; [optional tools](#optional-tools) unlock single
   features.
2. **Add a project.** Click **+** in the project bar. **New project** creates
   `~/tabtivity/projects/<name>/` with Git and agent docs (`AGENTS.md`,
   `CLAUDE.md`, `GEMINI.md`) already in place; **Import project** registers an
   existing folder in place, or copies or moves it.
3. **Start working.** Opening a project gives you a tab running your default
   agent. Set that command in **Settings**; any new tab can pick another
   installed agent CLI or a plain shell.
4. **Switch projects.** Click another project pill: its windows, tabs, files,
   and layout come back, and the previous project's desktop is parked until you
   return.
5. **Go further when you need it.** Point a project at an
   [SSH host or HPC cluster](#remote-machines--hpc-clusters-the-second-differentiator),
   or opt a project into [Tabtivity Mobile](#every-agent-from-your-phone-the-third-differentiator)
   (**Settings**, needs Tailscale) to answer your agents from your phone.

## Three pillars

**One project = one desktop.** Tabtivity is a project-centric desktop layer, not
just an app that launches or embeds other apps: projects own their windows and
desktop context, and selecting a project swaps that whole context — windows,
files, apps, Git state, and layout — as a single unit. The AI agent terminals,
file viewers, and app launcher ride on top, living *inside* a project once its
desktop is restored.

**One project = any machine.** A project is not tied to the computer in front of
you. Point it at an SSH host — or extend an existing local project onto one — and
its agent tabs, shells, Python runs, and jobs execute *there*, while the file
tree, viewers, and Git views keep working exactly as they do locally. No sshfs or
FUSE mount is involved, a project can span several machines at once, long runs
survive an SSH drop or a laptop lid, and SLURM clusters are driven from the same
cockpit — submit, watch, cancel, and grab an interactive compute node without
memorizing the commands. The goal is that *running a project on a cluster costs
about as much ceremony as running it locally*. See
[Remote machines & HPC clusters](#remote-machines--hpc-clusters-the-second-differentiator).

**Every agent = one phone.** An opt-in companion PWA,
**[Tabtivity Mobile](#every-agent-from-your-phone-the-third-differentiator)**,
reaches the same agent and shell tabs from a phone over your own private
tailnet — read what an agent is doing and answer it from another room. That is
remote control for **every agent CLI Tabtivity runs** — Claude, Codex, Gemini,
Qwen, Grok, Cursor, Copilot, OpenCode and the rest — whether or not its vendor
ships a phone app for it, and without any vendor's relay in between. See
[Every agent from your phone](#every-agent-from-your-phone-the-third-differentiator).

Built with **Tauri 2 + React + TypeScript**. Linux (X11 / KDE Wayland),
Windows, and macOS have native workspace, app-launch, and default-app
integration. Linux X11 is the reference platform; KDE Wayland needs live QA,
and Windows/macOS are CI-built with real-hardware checks still pending
(see the platform table).

**Contents:**
[At a glance](#at-a-glance) ·
[Why Tabtivity](#why-tabtivity) ·
[Download](#download) ·
[Features](#features)
([project desktop](#project-desktop-the-first-differentiator) ·
[remote machines & HPC clusters](#remote-machines--hpc-clusters-the-second-differentiator) ·
[every agent from your phone](#every-agent-from-your-phone-the-third-differentiator) ·
[agents and terminals](#agents-and-terminals) ·
[projects and boxes](#projects-and-boxes) ·
[isolation tiers](#isolation-tiers-container-vm-and-the-trash-workspace) ·
[workspace apps](#workspace-apps) ·
[files, viewers, and editing](#files-viewers-and-editing) ·
[interface and learning](#interface-and-learning)) ·
[Building from source](#building-from-source) ·
[Project storage](#project-storage) ·
[Current limits](#current-limits) ·
[Vision](#vision) ·
[License](#license)

See [STATUS.md](STATUS.md) for what has been live-verified and
[ROADMAP.md](ROADMAP.md) for remaining work.

## At a glance

![Tabtivity functionality map](screenshots/tabtivity-functionality.svg)

**①** pick a project — or a box, or the disposable trash project — and the
desktop swaps to it. **②** inside, a tiling tab layout hosts agent terminals
(27 built-in CLIs plus your own, with resume support depending on the CLI),
shells, native file viewers, and the app tabs Tabtivity renders itself instead of
sending you to another window — every one of those agent tabs is also readable
and answerable from a phone through Tabtivity Mobile, whichever vendor it belongs
to. Alongside them sit the side panel (Files · Git
· Search · Apps · Agents) and the header, where mail, the calendar, the to-do board, the
machine hub, and the VPN live. **③** the
project-desktop layer — window parking, default-app mapping, time tracking and
its daily recap, external windows, pop-out tab windows — follows the active
project automatically. **④** and the project carries the machines it runs on:
its tabs, jobs, and files can live on an SSH host, a GPU box, an HPC cluster, a
container, or a VM without changing how any of the above works.

And here's how that looks in the running app:

![Current Tabtivity screen](screenshots/eldrun-current.png)

## Why Tabtivity

Are you also annoyed by switching between agent tabs or apps, keeping track of
which tab or agent works on which project? This is why Tabtivity exists. When you
juggle several projects at once, every project's windows — browsers, terminals,
file managers, docs, agent sessions — pile onto one desktop. Switching from
project A to project B means digging through dozens of windows for the handful
that belong where you're going, remembering which Claude or Codex tab was
started for which repo, and losing the rest in the noise.

Tabtivity flips the model. **Select a project, and the desktop becomes that
project:** its windows come forward, the previous project's windows park out of
the way, the default-app mappings re-route, and time tracking switches. One
project visible at a time, everything else cleanly out of sight. And if you
need to work on two projects at the same time, simply *box* them — the box
behaves like one project with a shared desktop, file tree, and agent tabs —
and unbox afterwards, leaving both projects exactly as they were.

### How Tabtivity compares

Agent orchestrators (Vibe Kanban, Conductor, Claude Squad, the Claude Code
desktop app) manage agent *processes inside a repo* — task delegation, git
worktrees, diff review, merge flow. They are excellent at parallelizing work
within one codebase, but they have no notion of your desktop: they won't move
your windows or switch default apps when you change focus.

Manual approaches cover only one slice each: KDE Activities and one virtual
desktop per project handle windows but have no project model and no restore;
tmux and scripts like `workon` restore terminal layouts but ignore everything
outside the terminal.

Nor do any of them cross machines. Remote development tooling (VS Code Remote,
JupyterHub, a hand-rolled `ssh` + `rsync` + tmux setup) attaches *one editor* to
*one host*; the cluster half — workspaces on the parallel filesystem, `sbatch`
and `squeue`, an `srun` shell on a compute node, keeping several machines in
step — stays a terminal exercise you repeat per project.

The vendor phone apps and remote-control features (Claude Code's remote
control, the Codex app, the Gemini app) each reach *their own* agent, and only
through *their own* relay. An agent from a vendor without one — or the one you
started in a plain terminal — cannot be reached at all. Tabtivity Mobile reaches
every agent tab in every project from the phone over your own tailnet, because
it attaches to the tab's session on your desktop rather than to a vendor
service: one phone app for all agents, independent of whether one exists for
that agent.

Tabtivity occupies the gap none of them fill: project ownership of *windows and
desktop context*, project ownership of *the machines the work runs on*, and one
phone-side remote for every agent, with
agent terminals built in throughout. It is complementary to the
task orchestrators rather than a replacement — you can run one inside a Tabtivity
project terminal for parallel task delegation while Tabtivity handles switching the
desktop between projects.

## Download

Prebuilt packages are published on the
[Releases page](https://github.com/fseiffarth/tabtivity/releases). From the
[latest release](https://github.com/fseiffarth/tabtivity/releases/latest),
grab the `.AppImage` (portable Linux) or `.deb` (Debian/Ubuntu), or the `.exe`
installer on Windows, or the unsigned universal Intel/Apple Silicon `.dmg`
on macOS. The CI release workflow publishes each platform whose packaging job
succeeds. To build from source instead, follow the requirements below.

The macOS `.dmg` is neither signed nor notarized, so Gatekeeper refuses to open
the app as downloaded ("damaged" or "cannot be opened"). After dragging Tabtivity
into Applications, clear the download quarantine once:

```sh
xattr -dr com.apple.quarantine /Applications/Tabtivity.app
```

The Linux packages are built on Ubuntu 24.04, so they need glibc 2.39 or newer
(Ubuntu 24.04+, Debian 13+, Fedora 40+). On an older distro the loader fails
with `GLIBC_2.39 not found` — build from source there instead.

Once it is installed, **Settings → Updates** checks the same releases page from
inside the app and can download and install a newer build for you. It only
looks when you open that screen — Tabtivity never checks in the background — and
restarting is always yours to do. A copy installed from the `.deb` (or by any
other package manager) downloads the new build but leaves installing it to you.

### Optional tools

A release build needs nothing beyond the OS. Each of these unlocks one
feature, and every one of them is optional:

- Remote/SSH and HPC projects: nothing to install locally beyond OpenSSH — no
  `sshfs`, no FUSE. On the host: `tmux` for persistent sessions, plus
  `openvpn` locally for VPN-gated hosts
- Containerized projects: Docker. VM projects: QEMU/KVM
- Print manager: CUPS on Linux/macOS — nothing to install on Windows
- Tabtivity Mobile: Tailscale on this machine and on the phone
- Local model features — Vibe tabs, autocomplete, the mail
  assistant, the root console's agent tools (all off by default): Ollama

### Platform support

| Platform                  | Status             | Notes                                                                                        |
| ------------------------- | ------------------ | -------------------------------------------------------------------------------------------- |
| **Linux — X11**           | Yes                | Two-desktop workspace parking model (EWMH/xcb). Primary development target.                  |
| **Linux — KDE Wayland**   | Yes                | Per-project virtual desktop model via KWin DBus scripting. KDE 5 and KDE 6 supported.        |
| **Linux — other Wayland** | Partial            | Null backend (no workspace switching, no sticky windows). Terminal and file management work. |
| **Windows**               | Yes (alpha)        | Win32 `SW_HIDE`/`SW_SHOW` parking model (+ best-effort virtual-desktop pinning). Start-Menu app launch with `.lnk`/icon resolution, shell file associations, external-window tracking, OpenVPN, SSH/SFTP remote projects, Claude/Codex agent resume, project containers via Docker Desktop, project VMs via QEMU + WHPX, Tabtivity Mobile (Run-key sidecar), in-app browser live pages (deny-all permission handler), DXGI GPU readouts, and a WebView2 renderer crash reporter. No agent fence (no unprivileged sandbox on Windows), no tmux session persistence, no ControlMaster link counters. CI-verified only. |
| **macOS**                 | Yes (unverified)   | App-granular window parking via `NSRunningApplication` hide/unhide (no public per-window API), `.app` scanner, LaunchServices file defaults, Keychain, `caffeinate` presenter inhibitor, `sandbox-exec` agent fence, project containers (Docker Desktop), project VMs via QEMU + HVF (arm64 guests on Apple silicon), Tabtivity Mobile (launchd agent), `nettop` SSH-link counters, IOKit GPU readouts. Compiles and tests on the CI macOS runner; not yet exercised on real hardware. |

## Features

Inside a project, Tabtivity is an operational cockpit — a root control terminal for
the workspace, agent terminals scoped to the project (Claude, Codex, Gemini, or
a local Ollama model), a tiling tab layout, a hover-revealed file panel with
built-in viewers, and cross-project app controls that follow you between
projects. Around that core it has grown the surfaces you'd otherwise leave the
window for: mail, a calendar with a to-do board, a reader-mode browser, a print
manager, an Agent Skills library, TeX workspaces, a slide presenter, and a
private daily recap — each of them a list and a handful of verbs Tabtivity can
render itself.

### Project desktop (the first differentiator)

- **Workspace management**: X11 two-desktop parking model, KDE Wayland
  per-project virtual desktop model, and a Windows `SW_HIDE`/`SW_SHOW` parking
  model (with best-effort virtual-desktop pinning). macOS parks applications
  through hide/unhide. Global app windows stay visible across project switches.
- **External window tracking**: file opens use `xdg-open` (Linux), the shell
  open verb (Windows), or LaunchServices (macOS). Launched apps are tracked and
  shown in the side panel; macOS tracking and parking operate per application.
- **Default app mapping**: file extensions use per-project overrides, global
  defaults, system MIME defaults, or a manual "Open With" picker.
- **Time tracking**: Tabtivity records active project sessions and shows today's
  elapsed time on project pills.

### Remote machines & HPC clusters (the second differentiator)

Tabtivity treats remote hosts as first-class: it **manages a fleet of machines** and
**runs your projects on them**, from a single SSH box to a full HPC cluster —
with the same file tree, viewers, Git panel, and agent tabs you use locally, and
without an sshfs/FUSE mount anywhere.

- **Machine hub**: register SSH hosts once (independent of any project) in the
  header's machines indicator — see a live CPU/GPU usage bar per machine,
  connect/disconnect, arm silent auto-connect on launch, and drag a machine onto
  a project to attach it as a compute host.
- **Point a project at a host**: enter an SSH address (`user@host[:port]`),
  connect, and browse the remote filesystem in-app to pick the project root —
  no mount involved: the file tree and file I/O go over SFTP, terminal and
  agent tabs run **on the remote host** over `ssh -tt` (multiplexed over a
  ControlMaster socket), and git runs on the host, with the agent CLI
  auto-detected/bootstrapped there and authenticated with the remote's own
  login. Auth uses your existing SSH setup (keys / agent / `~/.ssh/config`) or
  a password you can optionally save to the OS keychain.
- **Run on the remote host**: a project can point at a host — at creation, or by
  *extending* an existing local project onto one in place — and run its agent,
  shell, and Python tabs *on that host* over `ssh -tt`, with the file tree, Git,
  and in-app viewers all reading the remote tree over SFTP. Everything rides one
  pooled ControlMaster connection per machine, and VPN-gated hosts bring up an
  OpenVPN tunnel first.
- **A local copy that stays in step, on purpose**: the project keeps a local
  mirror kept current by two transports that split the tree by Git. **Git
  lockstep** moves *tracked* files semantically — commits and refs via
  `git bundle`, never `.git` bytes — while an opt-in, per-folder **byte-sync**
  moves everything else. So your editor, agents, and Git history see the project
  locally, while gigabytes of host-side experiment output stay on the host until
  you ask for them; a setup census offers to exclude the giant folders
  (`node_modules/`, `.venv/`, `data/`, `checkpoints/`) up front.
- **Many machines per project**: beyond the primary host, add extra *worker*
  machines — their code is kept in sync from the project (one-way, tracked files
  only) and their experiment outputs are pulled back on demand. A worker on a
  **shared filesystem** (e.g. an HPC compute node on a shared home) is used in
  place, with nothing copied and no Git run on it.
- **Persistent sessions**: a long run lives in a tmux session per shell tab, so
  a job survives an SSH drop, a laptop sleep, a VPN drop, or Tabtivity quitting, and
  the tab reattaches on relaunch. A **Sessions view** lists every running session
  across all connected machines, with per-row attach/rename/kill.
- **Remote system monitor**: a host's CPU, memory, and GPUs (AMD + NVIDIA,
  including per-process GPU memory) are sampled over the same SSH connection and
  shown alongside the local machine's.
- **HPC / SLURM** *(built, but untested pending real-cluster QA)*: submit a batch
  script with `sbatch`, watch its live log, list and cancel your queued jobs, and
  open an interactive compute-node shell via `srun` — without memorizing the
  commands. A guided **HPC pipeline wizard** walks a cluster newcomer through
  login → project → data upload → job → watch.
- **HPC workspaces** *(same QA caveat)*: on clusters that hand out scratch space
  on the parallel filesystem via `hpc-workspace`, Tabtivity allocates, lists,
  extends, and releases workspaces from the app, and can put the project's remote
  root *in* one — so the data lands off the quota'd `$HOME` before the first byte
  is uploaded. Nothing is site-specific: the host is asked which filesystems and
  limits it offers.

### Every agent from your phone (the third differentiator)

**Tabtivity Mobile** is an **opt-in** phone/tablet companion that reaches this
desktop's *agent and shell tabs* — read what an agent is doing and answer it
from another room. It is a compact terminal-control product, not a mobile copy
of the workspace, and it is the same product for every agent CLI: the vendor
does not have to ship a phone app for the agent you are running.

- **Every agent, whether or not its vendor has a phone app.** Any agent tab
  with a resumable session is reachable — Claude, Codex, Gemini, Qwen,
  OpenCode, Copilot, Cursor, Grok, Antigravity, Vibe, or a custom command with
  its own resume arguments — because the phone attaches to the tab's tmux
  session on your desktop rather than to a vendor API. Claude's own
  remote-control feature stays what it is (Claude-only, through Anthropic's
  relay) and is independent of this.
- An **Agents** mode lists every session that is working, waiting on a
  decision, or done, flat across all opted-in projects and waiting-first — the
  one question a phone is picked up to ask. Tapping a row lands in that
  session.
- A loopback-only sidecar on the desktop, published to your own **Tailscale
  tailnet** with `tailscale serve`; there is no public endpoint and no Tabtivity
  server in the middle. Devices are paired and authenticated explicitly, and the
  desktop mediates every tab creation.
- Raw project ids, paths, commands, and tmux targets never cross the browser
  API — the sidecar core (`services::mobile_control`) is `AppHandle`-free and
  path-free by construction.
- **Reader** presents a chat view of a session. For Claude and Codex it reads
  stored prompts and answers, with explicit truncation limits; when that record
  is unavailable it falls back to the terminal screen. Model selection,
  scheduled prompts, closing tabs, and the `tabtivity-send` file outbox are also
  available from the phone.
- **Files from the agent to the phone**: a picture the agent wants you to see —
  a screenshot it took, a plot it rendered — it runs `tabtivity-send <file>`, and
  the phone shows it. Local and container tabs can send any file up to 24 MiB:
  images open full screen, text opens a preview, PDFs open a browser tab, and
  other files download. Every tile offers Save and Delete, and the project
  screen reaches the whole gallery from its header as well as from the shelf
  under its tab cards. Share is available where the phone browser supports
  file sharing; stdin works with `command | tabtivity-send -n tests.log`.
- **Project files, read-only** (opt-in, off by default): a left→right swipe on
  the phone's project screen, or from the left third of a tab's Focus view,
  opens a drawer that walks the project's folders
  and opens files in the same viewer. Folders and files travel as sealed
  tokens, never paths; `.git`, `.tabtivity`, `.env…` and symlinks are left out,
  and nothing can be changed.
- The phone gets a touch terminal (readable-screen mode, touch scrolling, a
  composer, voice input), a to-do board, Alerts with Done actions, opt-in mail
  flag/reply actions, last-tab restore, an offline app shell, and a local lock.
  Project boxes are selectable scopes too. Access is granted **per project**;
  remote, VM and containerized projects are excluded.
- A desktop header control shows host status; Settings carries the opt-in, the
  security-health readout, and one-click terminal setup.

**Set it up.** Until Mobile is set up, clicking the Mobile indicator in the
header opens a guide with these steps. The full version, with troubleshooting,
is in [docs/help/mobile.md](docs/help/mobile.md).

1. Install Tailscale on this computer and sign in.
2. Install the Tailscale app on the phone and sign in to the same tailnet.
3. Publish Tabtivity privately with Tailscale Serve (8742 is the default port):
   `tailscale serve --bg http://127.0.0.1:8742`. The guide's **Set up in
   terminal** button runs it for you. Use Serve, never Funnel.
4. Open **Settings → Remote & mobile → Mobile**, press **Detect Tailscale Serve
   settings**, check what it fills in, then switch Mobile on.
5. Under **Project access**, switch on the projects and boxes the phone may
   reach. All start off.
6. Press **Show install QR** and scan the `https://…ts.net` address with the
   phone (Tailscale must be connected there).
7. Press **New pairing code** and type the code on the phone within five
   minutes. Never send it by chat, e-mail or screenshot.
8. Optional: add the page to the Home Screen (iPhone: Share → Add to Home
   Screen; Android: browser menu → Install app). On iPhone this is needed for
   notifications.

*Host setup is implemented for Linux (systemd user service), macOS (launchd),
and Windows (Run key). Cross-platform and full real-phone security/acceptance QA
remain; some Mobile UI has been live-tested.*

### Agents and terminals

- **Agent-terminal orchestration**: create Claude, Codex, Gemini, Muse Code,
  and the other built-in agent CLIs, or plain shell
  tabs from the tab bar; create local Ollama-backed Vibe tabs from installed
  models; rename, close, and reorder them by drag and drop. The `+` menu's
  Agents group is searchable, its quick picks are configurable, and you can
  register your own agent CLI through "＋ Add agent…". Tab layout is persisted
  per project. Settings shows installed CLI versions against the versions
  Tabtivity was checked with.
- **Agents view and prompt chart** *(implemented, live QA pending)*: inspect
  each tab's activity, latest prompt, and model from the side panel; open a
  project-scoped chart tab with a zoomable timeline of sent, queued, and
  scheduled prompts. Collect Markdown drafts on a strip or free-position board,
  tag/filter them, select several cards, and link related prompts or ordered
  follow-ups. Prompt history records the answering model when available.
- **Scheduled prompts and chains**: one-time, daily, or selected-weekday rules
  deliver to an idle agent while the desktop app is open. The chart allows one
  independent rule per tab; further prompts can follow through an **after**
  link. Follow-ups wait for the source turn to finish and then stay idle for
  five minutes. Claude/Codex hooks provide turn state when available; other
  agents use a best-effort output/idle fallback. Due schedules have a one-hour
  catch-up window and record missed deliveries. Delivery replaces any unsent
  terminal composer draft, including in a focused tab.
- **Tiling subwindows**: the center panel is a tiling layout — drag a tab onto
  another subwindow's left/right/top/bottom edge to split that direction into a
  new pane, or onto its center to move the tab in. Splits resize with draggable
  dividers, each subwindow keeps its own tab bar, and the whole tree is persisted
  per project. A subwindow's tab bar also offers a **pop-out** button that
  detaches that group into its own borderless OS window; the detached window is
  tracked as a project-owned window and parks/restores with its project on switch.
  Dock it back with the ⤓ button (re-docks into the main layout; session-only, so
  it re-docks on restart too). Closing the popped-out window instead closes its
  tabs for good — they are not docked back and do not restore on next launch.
- **Root control terminal**: opens in `~/tabtivity/root/` with workspace-level
  context files.
- **Project terminals**: each active project gets a PTY tab scoped to its
  directory, with best-effort project-local XDG sandbox paths.
- **Ollama model management**: the Settings Ollama panel shows installed
  models, running CPU/GPU state, parameter and quantization details, plus
  catalog install, update, unload, and delete controls.

#### Agent CLIs, resume, and tools

Tabtivity launches agents in xterm.js PTY tabs. The table below describes the
current integration state.

| Agent | Resume behavior | Live verification |
| --- | --- | --- |
| **Claude** (`claude`) | Per-tab conversation via session hooks; preserves the CLI-selected permission mode on resume. | Core tab use confirmed; newer resume/activity paths still have open checks. |
| **Codex** (`codex`) | Per-tab conversation via hooks or hook-free binding, including the SQLite session index. | Core tab use confirmed; newer binding/activity paths still have open checks. |
| **Gemini** (`gemini`) | Continues the latest conversation in the directory. | Core tab use confirmed; restore remains less precise than Claude/Codex. |
| **Vibe** (`vibe`) | Continues the latest saved session. | Pending. |
| **Ollama via Vibe** | Isolated per-model `VIBE_HOME`; continue-latest where a resumable tab is available. | Partial. |
| **Qwen, OpenCode, Copilot, Cursor, Grok, Antigravity, Droid** | CLI-specific continue-latest flags. | Pending. |
| **Kiro, Cline, Aider, OpenClaw, Goose, Pi, Plandex, SWE-agent, Mini SWE-agent, Crush, Amp, Kimi, Qoder, Muse Code, Auggie, Kilo Code, Continue.dev, Junie, CodeBuddy** | Launch support; no built-in tab restore path. | Pending. |
| **Custom agents** | Optional resume arguments supplied by the user. | Depends on the command. |
| **Shell** | Respawns an ordinary shell or reattaches its tmux session where configured. | Core tab use confirmed. |

The default agent command is set in Settings, and each new tab can select a
built-in or custom CLI. The agent fence and project runtime tier determine
filesystem access; project-local XDG paths alone are not an isolation boundary.

**Session resume.** Claude and Codex track each tab's own conversation across
restarts. Tabtivity installs session hooks keyed by `TABTIVITY_TAB_UID`, so a
`/clear` can update the recorded live session. Codex also has hook-free binding,
including its SQLite-backed session index; its hooks may need one-time `/hooks`
trust. Qwen, OpenCode, Copilot, Cursor, Grok, Gemini, Antigravity, and Vibe have
continue-latest restore paths. Those cannot distinguish several conversations
in the same directory as precisely as Claude/Codex. Custom agents can supply
resume arguments; agents without a supported resume path are not restored.

**Permission and activity.** Set permission mode inside the agent CLI. On Claude
resume, Tabtivity reapplies the mode its hook recorded to preserve that choice.
Claude/Codex turn hooks also drive working, decision-needed, and finished states;
agents without a hook verdict use terminal-output heuristics.

**Tabtivity's tools (MCP).** Agents opened in the root console are the one kind
that get Tabtivity's own tools: calendar, to-do board, project sweeps, and the
"open this overlay" verbs (see [Workspace apps](#workspace-apps)). Claude gets
an inline `--mcp-config`, Codex a `-c mcp_servers.tabtivity.*` override, and every
other CLI the `TABTIVITY_ROOT_MCP_URL`/`TABTIVITY_ROOT_MCP_TOKEN` environment — on
the command line, never in the CLI's own config files. Reads are annotated
read-only and writes destructive, so a CLI that asks before tools asks for the
right ones; approval itself stays the CLI's own. Settings has the single
switch, on by default.

**Custom agents.** Any other agent CLI can be registered from "＋ Add agent…" in
the tab menu and then appears in the Agents group like the built-ins.

Local Ollama models are available from the tab `+` menu when Ollama is
installed and reachable. Tabtivity can start the Ollama service, list installed
models, and create a `vibe` tab for a selected model. The per-model `VIBE_HOME`
config pins `active_model`, registers the Ollama provider, and disables Vibe
tool calls for local models so local tabs do not mutate global `~/.vibe`
configuration.
For tool-capable models, the local-agent picker also supports Claude Code,
Codex, OpenCode, Droid, and OpenClaw through the installed Ollama/CLI integration,
with availability and model capability checks.

### Projects and boxes

- **Project creation and import**: the `+` button creates a new git-backed
  project or imports an existing directory (keep in place, copy, or move).
- **Project switcher**: the header's scope picker selects projects, boxes, and
  Root. Project pills show activity and pending decisions; hover to inspect
  the path, Git state, today's active time, and live CPU%.
- **Project boxes (meta-project grouping)**: temporarily join two or more
  projects into a *box* — its own pill in the switcher — for side-by-side file
  work, cross-project copy-paste, PDF merges across members, and box-rooted
  agent tabs. Membership is non-exclusive (a project can sit in several boxes);
  member pills keep rendering individually with a small ▣ badge. Add via the
  pill menu's Boxes group, Ctrl-click multi-select → "Box these…", the box
  editor, or by dropping a pill on a box; a box only ever disappears through
  the editor's explicit, confirmed Dissolve. Opening a box lands in a per-box
  folder under `~/tabtivity/boxes/<name>/`, which carries managed
  `CLAUDE.md`/`GEMINI.md`/`AGENTS.md` link blocks plus one symlink per member
  (Unix), so agent CLIs can traverse into every member's tree; hover the pill
  to list members and click one to jump to it. Box membership lives in a
  sibling `boxes.json`, so `projects.json` is untouched. Box tab scopes
  persist and restore like a project's; box tabs run locally, with local agents
  covered by the agent fence and access derived from the box's member roots.
- **Publish to GitHub / GitLab**: a local (or SSH-remote) git project can be
  published to a new GitHub or GitLab repository from the project pill menu.
  Choose the provider and public/private; Tabtivity runs `gh repo create …
  --source=. --push` (GitHub) or `glab repo create … --remoteName origin`
  followed by `git push` (GitLab) via the system CLI (over `ssh` on the host
  where the bytes live for remote projects), then records the new push target
  (`git_type` becomes `remote-public`/`remote-private`) and provider. Requires
  the chosen provider's CLI — `gh` or `glab` — installed, with authentication
  from the CLI or a saved token under Settings → Git hosting.

### Isolation tiers: container and VM

A project's tabs run in one of four trust tiers, and the tier is a property of
the project rather than a different way of working.

- **Local** — shells and agents run on the host, in the project directory.
- **Containerized** *(local projects, Docker; Docker Desktop on Windows/macOS)*: flip the pill's "run this
  project in a container" toggle and every shell and agent tab `docker exec`s
  into **one** session-lived, capability-dropped container. The project folder
  stays on the host, bind-mounted at its *identical* absolute path — so the file
  tree, git, viewers, and agent session-resume keep reading host bytes, which is
  what makes it a toggle rather than a migration. Closing a tab reaps its
  in-container processes.
- **Remote SSH** — see
  [Remote machines & HPC clusters](#remote-machines--hpc-clusters-the-second-differentiator).
- **Virtual machine** *(chosen at project creation, not toggled later)*: the
  strongest tier. A QEMU/KVM guest boots, exposes SSH on a forwarded loopback
  port, and from there is an ordinary remote project — with **no shared
  filesystem**, an inverted sync posture, and an egress switch. *(Implemented;
  never live-booted.)*

Local agent tabs also have a default-on **agent fence**: bubblewrap on Linux
and `sandbox-exec` on macOS, with writable access limited to allowed project
roots and required agent state. An unavailable Linux fence blocks the launch;
Windows reports that no fence is available. Tabtivity controls the project's
container and the tab's location (local / primary host / worker). The agent's
permission mode is selected in its own CLI; Tabtivity has no Plan/Auto toggle.

### Workspace apps

Roles Tabtivity used to hand off to an external app now have in-app surfaces, on
the same reasoning each time: what sits behind the button is a list and a
handful of verbs, and Tabtivity can render a list. Where a link still needs an
app — a `mailto:` or `webcal:` from a terminal or the file tree — the router
opens the in-app surface when it is enabled and falls back to your configured
external app when it is not.

**Several of these are experimental and off by default** in a release build —
mail (`mail_client`), the browser (`web_browser`), the deck presenter
(`deck_presenter`), and Python run/debug (`python_run_debug`). Turn them on
under Settings → Experimental; an unset flag
follows debug mode, so they are all on in a development build.

- **Mail** *(IMAP/SMTP)*: a full client over the whole window — folders, message
  list, compose/reply, attachments (saved into the active project by opaque id,
  never by path), and keyword filter rules. Two independent
  encryption tracks: the **local store** is sealed value-by-value with
  XChaCha20-Poly1305, each ciphertext bound to its own row, so a backup or a
  cloud-synced copy carries no readable subject lines; and **OpenPGP**
  (Curve25519 only, by decision) handles what the sender did before the message
  left their machine. Message HTML is sanitized and rendered in a script-less
  sandboxed frame, always in the order *decrypt → parse → sanitize → render*.
  An opt-in **local-model** assistant (Ollama) can summarize or draft — on
  device, or not at all. PDF attachments preview inside the mail pane.
- **Calendar**: month, week/time-grid, and agenda views; drag to create; alarms
  and reminders; `.ics` import (with a review step) and export. **CalDAV
  accounts** sync against a real server — a sync merges by resource URL rather
  than replacing, so a local edit is never silently overwritten. Two-way push
  is opt-in per account, with a conflict dialog; mail and CalDAV accounts can
  also wait for a required VPN before connecting.
- **To-do board**: a Trello-style board of cards in columns, with steps, tags,
  and due dates. The cards *are* the calendar's tasks — one store, not a second
  one — flanked by an agenda rail and an urgent-mail rail.
- **Browser**: a reader-mode tab (text and images, **no scripts**) behind the
  same sanitizer and SSRF guards as mail, with a security chip, a start page,
  and downloads. Settings → Browser can opt into live pages, which open in a
  separate Tabtivity webview window with an ephemeral profile and no Tabtivity IPC
  privileges. Live pages run scripts; reader mode stays script-free. Opening
  the page in your external browser is also available.
- **Print manager**: every printer this machine knows, its queue, and the verbs
  — pause/resume a printer, cancel a stuck job, send a test page. CUPS on
  Linux/macOS, PowerShell on Windows; read-only by default, and a missing print
  system is reported as a state rather than an error. Native viewers have a
  print preview with copy count and document-specific settings; PDFs support
  `Ctrl+P`, and the preview follows its submitted job through the queue.
- **Agent Skills library**: browse `SKILL.md` catalogs from git sources and
  one-click install a skill into a project's `.claude/skills/` or into the
  machine's personal `~/.claude/skills/`, which every project here sees.
  Claude-only.
- **Deck presenter**: lay slides over a PDF or a LaTeX base, then present with
  speaker notes, a timer, and a second audience display or window.
- **Agent tools for the calendar and the board (MCP)**: an agent opened in the
  root console (`Ctrl+Shift+R`) — a cloud CLI, or a **local Ollama model**
  behind a tool-capable CLI — gets Tabtivity's own tools and can manage these
  surfaces for you: "add a calendar entry on Friday at 14:00, one hour",
  "move every event of that calendar into the other one", "put a card on the
  board for project X", "what did I finish this week?". The calendar tools list,
  add, edit, move, and delete events (a CalDAV-backed calendar pushes them as it
  would a dialog edit); the board tools add, edit, complete, reopen, move, and
  delete cards through the same gestures a drag uses; plus read-only sweeps —
  which projects have uncommitted work, what is out of sync with its host, last
  week's time and usage. **Mail tools are next**. The tools live on a loopback endpoint behind a per-run bearer token
  that is never written to disk, and **no project's agents ever get them**. One
  switch in Settings turns it all off without a restart: new root agents are
  handed nothing and the ones already running are refused.
- **Daily recap**: a private, local-only summary of your day — which agents and
  models you used, prompts asked, shell commands, file churn, commits, and time
  per project. It opens once on the first launch of each day. Nothing leaves the
  machine and nothing is uploaded anywhere.

### Files, viewers, and editing

Drag a file from the tree onto a subwindow's tab bar to open it in a tab; the
viewer is chosen by extension. In-progress types open in the external default
app until they land.

| Viewer | Extensions | Status | Notes |
| ------ | ---------- | ------ | ----- |
| **Text / code** | `.txt` `.py` `.ts`/`.tsx` `.cpp` `.rs` `.java` `.toml` + many more, plus extensionless files like `Dockerfile` | ✅ Shipping | Editable editor: line-number gutter, syntax highlighting with a spec per language (JS/TS + JSX, C/C++, Java, C#, Kotlin, Swift, Go, Rust, Python, Ruby, PHP, Lua, Perl, R, Haskell, Elixir, shell, SQL, …), Tab/Shift+Tab indent, undo/redo (`Ctrl+Z`/`Ctrl+Shift+Z`), find (`Ctrl+F`) and find-and-replace (`Ctrl+R`) with match nav + case toggle, save (`Ctrl+S`); unsaved lines marked; non-destructive auto-reload banner; opt-in local autocomplete and dictionary spell check. |
| **Markdown** | `.md` `.markdown` `.mdx` | ✅ Shipping | Rendered preview with an Edit/Preview toggle; links to local files are clickable. Fenced `mermaid` code blocks render as diagrams and `$…$`/`$$…$$` as math (KaTeX with `trust: false`, mermaid script-free). Remote images load only on request. |
| **YAML / JSON** | `.yaml` `.yml` `.json` | ✅ Shipping | Editable structure tree with a Tree/Source toggle: retype a value, rename a key, add a key or list item (with a type picker), reorder, delete. Both of YAML's syntaxes are first-class — block (`key:`) and flow (`{a: 1}`, which is exactly JSON, on one line or spread over many) — and each keeps the style it is written in. The tree edits the file's own text, so comments, quoting and layout survive an edit; it withholds the affordance rather than botch a construct it can't rewrite (anchors, merge keys). Source is the full code editor. |
| **BibTeX bibliography** | `.bib` `.bibtex` | ✅ Shipping (untested) | Card list with a Cards/Source toggle: one card per entry, its `field = {value}` pairs as editable rows. Retype a value, rename a field or the citation key, change the entry type, add or delete a field, delete an entry, add a new entry, copy a citation key. A filter box searches every key, type and field value (a real bibliography is thousands of records), and cards fold individually — both survive reopening the tab. Like the YAML tree it edits the file's own text, so field order, brace-protected `{DNA}` capitalization, `"…"` quoting, alignment and `%` comments survive an edit; a value it can't rewrite safely (a `@string` macro, a `#` concatenation) is shown read-only rather than mangled, and text outside every entry is reported rather than hidden. Duplicate citation keys are flagged. Source is the full code editor. |
| **LaTeX** | `.tex` | ✅ Shipping | Opens as a **single workspace tab per document**: a left sidebar of the main file's `\input` children and graphics switches the center in-tab, and the compiled PDF opens as its own tab tied to the source. Code editor + compile (when a TeX engine is on `PATH`, shell-escape stripped); `\ref`/`\cite` completion from `\label` keys and `.bib` entries; parsed compile errors jump to the line; bidirectional SyncTeX sync across tiled or detached panes. `Ctrl+Click` anywhere on an `\input{…}`-style command opens that file (no compile needed); elsewhere it jumps to that spot in the PDF, once one has been compiled. Compile always rebuilds (latexmk `-g`), even when latexmk sees nothing changed. Typeset fragment hover previews and Beamer overlay controls have project-wide toggles; build with `Ctrl+Shift+B`. |
| **PDF** | `.pdf` | ✅ Shipping | Rendered with a themed zoom toolbar. Blacking text out (untested) is a real redaction, not a black rectangle: drag over anything — or search and black out every hit in one click — and saving *rasterises* the pages you marked, so the covered text is gone from the file rather than hidden under a shape that any copy, extract or annotation delete would lift. Only marked pages are flattened; the rest keep their text. Marks are undoable, follow the page if you reorder it, and touch the file only when you confirm the save. |
| **Presentation deck** | `.eldeck.json` | ✅ Shipping (experimental, untested) | Native slide authoring over a PDF or LaTeX base: layered objects, build steps, speaker notes, and PDF export. Present in-tab or across two displays. Behind `deck_presenter`. |
| **Images** | `.png` `.jpg` `.bmp` `.webp` … | ✅ Shipping | Zoom-to-cursor / pan; draggable out as an OS drop source. An **Annotate** overlay adds freehand pen, rectangle, arrow, and text markup with colour/width controls, undo, and clear, then flattens it into a saved copy (`…-annotated.png`, or overwrite for a `.png`). |
| **Animated GIF** | `.gif` | ✅ Shipping | Frame-level transport on top of the image viewer's zoom/pan: play/pause, frame stepping, scrubber, playback speed, loop toggle, frame/delay readout. Decoded in-app (pure LZW decoder), so it works over SFTP too; a GIF the decoder can't handle degrades to the native animated `<img>`. |
| **Table / CSV** | `.csv` `.tsv` | ✅ Shipping | Editable cells and headers, row insertion/deletion, undo/redo, save/autosave, delimiter detection/override, filtering, sorting, and resizable columns. Edits preserve untouched source text, quoting, and line endings; only visible rows are rendered. |
| **Jupyter notebook** | `.ipynb` | ✅ Shipping | Read-only render of cells top-to-bottom — markdown cells, Python-highlighted code cells, and their classified outputs. |
| **Diff / patch** | `.diff` `.patch` | ✅ Shipping | Color-coded add/del rendering that reads in light and dark themes. |
| **OpenDocument Text** | `.odt` | ✅ Shipping | Read-only: unzips the archive and renders `content.xml` to a safe HTML subset (headings, lists, tables, images). |
| **Spreadsheet** | `.xlsx` `.xls` `.xlsm` | ✅ Shipping | Read-only backend reader (calamine) into the sortable/filterable table grid, with a sheet picker. |
| **SQLite** | `.db` `.sqlite` `.sqlite3` | ✅ Shipping | Read-only table browser: table list + paged row grid. |
| **HTML / SVG** | `.html` `.htm` `.svg` | ✅ Shipping | Editable source editor with a sandboxed (no-script) live preview, Preview ⇄ Source toggle. |
| **Audio / video** | `.mp3` `.mp4` `.webm` `.wav` … | ✅ Shipping | Native in-tab `<audio>`/`<video>` player. |

Other office formats (`.docx`, `.pptx`, `.ods`, …) open in their external
default app. Viewer behaviour is configured per file type under **Settings →
Native Viewers**: the per-type autocomplete and spell-check defaults (each tab
can override them from its header) plus a global autosave switch. The text/LaTeX/Markdown editors carry an `A−`/`A+` text-size control
(`Ctrl` +/−, `Ctrl`+0 to reset; scales the Markdown preview too), persisted
per file type. Every viewer remembers where you left off — editor/PDF scroll
position, PDF/image zoom, and image pan persist per tab, so reopening a file (or
restarting Tabtivity) restores your position instead of jumping to the top.

- **File side panel**: place it on either side; its closed edge rail opens
  Files, Git, Apps, or Agents on hover or click. Browse, open, create, rename,
  delete, copy/cut/paste, and reveal project files, with a breadcrumb trail and
  per-file git status
  markers (modified, untracked, staged, committed-but-unpushed, ignored). A
  **Git** view shows the current branch, clickable branch pills for checkout,
  and a commit list whose entries open an editable commit-message window (amend
  HEAD, agent-generated messages, or checkout). A **Search** view runs a
  project-wide literal content search and lists matching lines that jump straight
  into the in-app viewer. The panel can be pinned open instead of hover-revealed;
  additional views list tracked external windows.
- **Downloads and project captures**: browse configured download source folders
  in the file panel and move/copy files into a project. Screenshots and saved
  mail attachments use Tabtivity-prefixed, ignored project folders; Tabtivity does
  not rewrite another browser's preferences or download directory.
- **Local autocomplete (opt-in, private)**: in the editable text/LaTeX/markdown
  viewers, `Ctrl+Space` requests a single completion from a **local Ollama**
  model (`Tab` accepts, `Esc` dismisses). It is OFF by default; each editor tab
  has its own **Autocomplete** toggle + length-mode (Sentence/Block/Scope) in the
  header that overrides the per-type default, so you can enable it just for the
  tab you're in. Nothing is sent anywhere unless you enable it, and if Ollama
  isn't running it fails silently — no remote calls, ever.
- **Dictionary spell check**: a model-free Hunspell provider checks prose in
  the native editors, with downloadable language dictionaries and a personal
  dictionary; code, TeX commands, and other non-prose regions are skipped.
- **Python run and debug** *(experimental, off by default)*: run or debug a `.py`
  file straight from the viewer — breakpoints, `pdb`, and go-to-definition
  included. The tab opens against the
  interpreter the backend ranks highest (project venv, then the rest); the
  frontend does not second-guess that ranking.

### Interface and learning

- **Hover-revealed panels**: the file side panel appears on
  pointer hover and disappears when the pointer leaves, keeping the center
  terminal unobstructed; the side panel can also be pinned permanently open.
- **Appearance and responsiveness**: a Theme Customizer with saved presets,
  Tabtivity navigation and shortcut help, Fast mode, and Energy Saver. Hidden
  viewers suspend background work and hidden terminals buffer output until
  shown. Settings groups less frequently changed controls under Advanced
  options.
- **Network indicator**: probes connectivity and shows online/offline plus wired
  or wireless state.
- **Keyboard shortcuts**: `F11` toggles fullscreen; `F9` toggles panels while
  Tabtivity is focused. A bare `Super` also toggles panels where the desktop does
  not claim that key (GNOME, KDE, and Windows do).
- **Guided tour and lessons**: a first-run tour plus ~30 step-by-step lessons
  that anchor onto the real UI — adding a project, arranging tabs, the YAML and
  PDF viewers, TeX workspaces, the presenter, Python run/debug, the browser,
  printing, calendar, the to-do board, mail, the daily recap, installing an
  agent or a local model, the Skills library, project boxes, container and VM
  projects, SSH projects and OpenVPN, extending a local project onto a host,
  compute machines, persistent sessions, the HPC pipeline, and Mobile.
- **Five languages**: every user-facing string goes through one place
  (`src/lib/i18n.ts`) — English, German, Spanish, French, and Italian, with
  English as the source of truth and the fallback.

## Building from source

- Linux desktop (X11 or KDE Wayland), Windows 10/11, or macOS
- Rust toolchain (`rustup`) and a current Node.js LTS release (matching CI)

```bash
# Install Rust (all platforms): https://rustup.rs

# Linux: Tauri system dependencies (Debian / Ubuntu)
sudo apt install libwebkit2gtk-4.1-dev libssl-dev libgtk-3-dev \
    libayatana-appindicator3-dev librsvg2-dev

# Install JS deps
npm install
```

On Windows the Tauri webview uses the system WebView2 runtime (preinstalled on
Windows 11); no GTK/WebKit packages are needed.
On macOS, install the Xcode command-line tools; the webview uses WKWebView.

### Running a development build

A development build with hot-reload (all platforms):

```bash
npm run tauri:dev
```

Frontend edits hot-reload. This command disables Rust watching, so backend
changes take effect only when you deliberately restart the app. Run
`npm run backend:stale` to compare the running backend and embedded frontend/PWA
with the checkout. `npm run tauri:dev:watch` opts into automatic backend
rebuilds and window relaunches.

On Linux, `npm run package:dev` freezes the working tree for the **Tabtivity (dev)**
desktop entry. With this clone's hooks enabled, commits also queue a background
freeze of **the committed snapshot**; `scripts/package-dev-auto.sh --status`
reports the queue or last failure. A running window keeps its current binary
until you relaunch it. For a separate development state directory, launch
`./start-tabtivity-dev-sandbox.sh` yourself.

On Linux you can also use the convenience scripts in `docs/`:
`docs/start-tabtivity-tauri.sh` (packaged build) and
`docs/start-tabtivity-tauri-hotreload.sh` (hot reload). The desktop launchers
`docs/Tabtivity.desktop` and `docs/TabtivityHotReload.desktop` carry a
`/path/to/tabtivity/...` placeholder — point them at your checkout, then
install them:

```bash
cp docs/Tabtivity*.desktop ~/.local/share/applications/
update-desktop-database ~/.local/share/applications/
```

### Stack

- **Frontend:** React 18, TypeScript, Vite, Tailwind CSS, Zustand
- **Terminal UI:** xterm.js (`@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`)
- **Backend:** Rust, Tauri v2
- **PTY:** `portable-pty` crate
- **Companion PWA:** a separate Vite bundle under `mobile-web/`, served by a
  loopback sidecar (built by the same `npm run build`)
- **Workspace:** `zbus` (DBus) and `xcb` (X11) on Linux; the Win32 API
  (`windows` crate — `SW_HIDE`/`SW_SHOW`, `EnumWindows`, virtual-desktop manager,
  shell-link/icon resolution) on Windows

### Packaging and diagnostics

- **Packaging**: Linux `.deb` and AppImage, Windows NSIS `.exe`, and an unsigned
  universal macOS `.dmg`. CI builds packages on pushes and publishes successful
  platform artifacts on `v*` tags.
- **Crash logging**: Rust panic hook appends to `~/.local/share/tabtivity/crash.log`.

## Project Storage

Managed projects live under `~/tabtivity/projects/<sanitized-name>/`.
Imported projects can also be registered in place.

Global Tabtivity state lives in `~/.local/share/tabtivity/`:

- `projects.json`: lightweight index with project id, name, status, ordering,
  and path to each project's local metadata file.
- `settings.json`: default agent command, theme, workspace-management setting,
  global app registry, and other user preferences.
- `default_apps.json`: global file-extension to application command map.
- `boxes.json`: project-box definitions (id, name, ordered `member_ids`,
  resolved `folder`, relations); kept separate so `projects.json` stays
  byte-compatible.
- `time_log.json` and `time_summary.json`: session time tracking.
- `global_machines.json`: SSH machines registered independently of any project.
- `calendar.json`: events **and** to-do cards — the board and the calendar share
  one store.
- `usage_stats.json`: local-only rolling hour/day counters behind the daily
  recap. Deliberately separate from time, network bytes (`net_usage.json`), and
  git stats, each of which the recap reads at its own source so they cannot
  drift.
- `agent_prompts.json`: collected drafts, prompt history, tags, and links,
  keyed by project/box scope. `agent_tasks.json` holds per-tab schedules and
  delivery receipts; their target bindings are saved with the tab layout.
- `sessions/<project-id>/terminals.json`: **tab layout and open apps live here,
  outside the project tree**, keyed by project id. The copy inside a project
  folder is legacy/export-only and is adopted only on an explicit request — and
  the app list is never adopted, since a folder-supplied list of host commands
  to launch is exactly what moving it guarded against.
- Per-subsystem directories: `mail/` (sealed store), `browser/`, `vm/`,
  `remote-projects/`, `skills_cache/`, and
  `vibe_local/<model-alias>/config.toml` — isolated Vibe configuration for each
  local Ollama model tab.

Project-local state lives in each project's `project.json` (project identity,
remote specs, runtime/container settings, per-project viewer settings),
alongside scaffolded files (created when missing): `AGENTS.md`, `CLAUDE.md`,
`GEMINI.md`, `TODO.md`, `ROADMAP.md`, `STATUS.md`, `README.md`,
`DOCUMENTATION.md`, plus `.gitignore` and `.claude/settings.json`. **`AGENTS.md`
is the canonical one** — it carries the actual template, and `CLAUDE.md` /
`GEMINI.md` are pointers that import it, so guidance is written once instead of
drifting across three files. A scaffold repair upgrades an agent doc still
holding its untouched pre-`AGENTS.md` stub and never touches anything a human
or agent wrote.

See [DOCUMENTATION.md](DOCUMENTATION.md) for the detailed architecture, data
schemas, behavior notes, and known limitations.

## Current Limits

- Live window embedding (frameless reparenting of an external app into a tab) is
  not yet implemented; files render in built-in in-app viewers where available,
  otherwise open in the OS default app (`xdg-open` / shell open) and are tracked
  as external windows.
- KDE Wayland workspace management needs live-session QA.
- macOS parks at *application* granularity (hide/unhide the owning app): a
  single window of a multi-window app cannot be parked on its own, and a
  launched app cannot be placed on a chosen monitor (no public API for
  positioning another app's window).
- Terminal/tab layout is persisted per project and box; shell, file-viewer,
  and supported resumable agent tabs restore on relaunch. An ordinary PTY's
  processes and scrollback do not survive an app exit; tmux-backed sessions
  can survive and reattach. Continue-latest agent restores have the multi-tab
  limits described above.
- Detached subwindows re-dock on restart. Closing a detached window closes its
  tabs; it does not dock them back.
- Non-KDE Wayland compositors fall back to the null backend.
- Remaining office formats (`.docx`, `.pptx`, `.ods`, …) have no native viewer
  yet and open in the external default app.
- **Code-complete does not mean live-verified.** Mail and selected calendar,
  to-do, Mobile, import, and monitor controls have recorded live use. That does
  not validate every path in those subsystems: CalDAV server sync, mail crypto,
  the deck presenter, VM boots, SLURM/HPC, and the newest prompt-chart workflows
  still have open acceptance checks. Features awaiting verification carry an
  *untested* pill; it is removed per item after user confirmation.
- Tabtivity Mobile runs its host sidecar on all three desktops (systemd user
  unit, launchd agent, Windows Run key), requires Tailscale on both ends, and
  its real-phone security and acceptance QA is still open.
- Containerized projects are local-only and need Docker (Docker Desktop on
  Windows/macOS, where they have never been run); VM projects need QEMU with
  hardware acceleration (KVM, Hypervisor.framework, or the Windows Hypervisor
  Platform) and have never been booted on any host.
- Windows has no agent fence (there is no unprivileged filesystem sandbox to
  build one on), no tmux-backed local session persistence, and no SSH
  ControlMaster to read link traffic from; each is reported in the UI rather
  than silently skipped.
- The Agent Skills library is Claude-only, with no manifest, versioning, or
  cross-agent generalization — deliberately out of the MVP.

## Vision

Each platform parks windows in its own idiom today (desktops, `SW_HIDE`, app
hide/unhide), and the design is cross-platform by intent. The long-term shape
is a stable Tabtivity core behind pluggable compositor/window backends (X11,
KDE/KWin, Hyprland, GNOME Shell, i3, Sway, and other Wayland environments; the
Win32 backend on Windows; AppKit on macOS), and eventually a Tabtivity-native
compositor for full control of projects, windows, and layout.

See [VISION.md](docs/VISION.md) for the full strategy and platform rationale.

## License

Tabtivity is dual-licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE) or
  <http://www.apache.org/licenses/LICENSE-2.0>)
- MIT license ([LICENSE-MIT](LICENSE-MIT) or
  <http://opensource.org/licenses/MIT>)

at your option.

Unless you explicitly state otherwise, any contribution intentionally submitted
for inclusion in the work by you, as defined in the Apache-2.0 license, shall be
dual-licensed as above, without any additional terms or conditions.
