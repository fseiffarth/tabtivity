# ProjectEldrun — Documentation

Tabtivity is a Tauri 2 + React + TypeScript desktop workspace for AI-assisted
development. It keeps a root control terminal, per-project terminal and agent
tabs in a tiling layout, a project switcher in the top header, a file panel with
native viewers, global app launching, time tracking, local Ollama model
management, and best-effort X11/KDE workspace integration in one fullscreen
window.

Around that core it has grown surfaces that used to be someone else's
application: an embedded mail client, a calendar with CalDAV and a to-do board,
a reader-mode browser, a print manager, an Agent Skills library, TeX workspaces,
a slide presenter, and a private daily recap. A project can also run somewhere
else entirely — in a container, on an SSH host or HPC cluster, or in a VM — and
an opt-in companion PWA reaches its agent tabs from a phone.

This document reflects the code in `src/` and `src-tauri/src/` as of
2026-08-26.

## Document Boundaries

- `DOCUMENTATION.md` describes how Tabtivity works now: architecture, behavior,
  persistence, and operational notes.
- `STATUS.md` is the short current-state snapshot: readiness, validation, and
  known rough edges.
- `ROADMAP.md` captures product direction and sequencing.
- `TODO.md` tracks concrete implementation tasks with grouped IDs.

## Tabtivity's Model

Tabtivity treats development work as a set of active projects, each with its own
directory, metadata, terminal tabs, file context, and optional workspace-level
desktop state.

- The root terminal is for orchestration: managing Tabtivity itself and the broader
  workspace under `~/tabtivity/root/`.
- Project terminals are for implementation work inside a specific project
  directory. They launch with a best-effort project sandbox that keeps XDG
  config/cache/data/state and temp writes under `<project>/.tabtivity/sandbox/`.
  The root terminal keeps the normal workspace environment.
- Agent tabs run `claude`, `codex`, `gemini`, or `vibe`; plain shell tabs run
  the user's shell. Other agents can be used in a plain shell tab.
- Local Ollama models appear as Local Agent tab choices when the Ollama server
  exposes installed models. They run through `vibe` with an isolated per-model
  `VIBE_HOME` under `~/.local/share/tabtivity/vibe_local/`.
- The file panel, default app mappings, tracked external windows, and time
  tracking follow the active project.
- Global app shortcuts are intentionally cross-project. They launch or raise
  tools such as a browser, password manager, notes app, or screenshot tool and
  keep those windows visible across project switches. They are not owned by a
  single project. Roles Tabtivity has since grown its own surface for — mail,
  calendar, file manager, system monitor, print manager — were **retired** from
  that bar (`RETIRED_GLOBAL_APP_ROLES` in `GlobalAppBar.tsx`) rather than deleted
  from settings, so a configured command survives if a role ever returns.
- A project's tabs run in one of four **trust tiers** — local, containerized,
  remote SSH, or VM — and the tier is a property of the project rather than a
  different way of working. See *Trust Tiers* under Project Lifecycle.

## Stack

| Concern | Technology |
|---------|-----------|
| Window shell | Tauri v2 (`tauri-plugin-dialog`) |
| Frontend framework | React 18, TypeScript, Vite |
| Styling | Tailwind CSS + CSS variables (5 themes, `src/types/index.ts::THEMES`) |
| Global state | Zustand |
| Terminal UI | xterm.js (`@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`) |
| PTY management | `portable-pty` Rust crate |
| JSON persistence | `serde` + `serde_json` |
| MIME detection | `mime_guess` (extension) + `infer` (magic bytes) |
| File/URL opening | `xdg-open` / `opener` crate |
| Network monitoring | `network-interface` crate + TCP probe |
| Local model integration | Ollama REST API over localhost TCP + Vibe config files |
| Drag-to-reorder | hand-rolled pointer events (HTML5 DnD breaks on WebKitGTK; no DnD library) |
| X11 workspace | `xcb` crate (Linux only) |
| KDE DBus | `zbus` crate (Linux only) |
| Companion PWA | separate Vite bundle under `mobile-web/`, built by `npm run build` |
| Mail | IMAP/SMTP engine + `ammonia` sanitizer; `pgp` (Curve25519 only) for OpenPGP |
| Mail at-rest encryption | XChaCha20-Poly1305 per value, SQLite index (`services/mail_crypt.rs`) |
| CalDAV | hand-rolled `PROPFIND`/`REPORT` bodies on `reqwest` + `roxmltree` |
| Spreadsheets | `calamine` (`.xlsx`/`.xls`/`.xlsm`) |
| PDF | in-app render + redaction rasterisation; SyncTeX for TeX round-trips |
| Remote transport | pooled OpenSSH ControlMaster + SFTP (no sshfs/FUSE) |
| Containers / VMs | Docker (`services/sandbox.rs`), QEMU/KVM (`services/vm.rs`) |

## Installation

### Runtime Dependencies

```bash
# Tauri system dependencies (Debian / Ubuntu)
sudo apt install libwebkit2gtk-4.1-dev libssl-dev libgtk-3-dev \
    libayatana-appindicator3-dev librsvg2-dev

# Install JS dependencies
npm install
```

### Launching

```bash
docs/start-tabtivity-tauri.sh
```

Or for a development build:

```bash
npm run tauri:dev
```

`tauri:dev` runs `tauri dev --no-watch` deliberately. Tauri's Rust watcher
rebuilds *and relaunches the window* on any backend write, taking the user's
open tabs and live terminals with it; `src/` changes hot-reload into a running
window either way, while `src-tauri/` changes accumulate until a deliberate
restart. `npm run tauri:dev:watch` is the opt-in escape hatch, and
`npm run backend:stale` reports whether the running window is behind the backend
sources. `scripts/guard-single-instance.sh` (wired into both `pretauri:dev`
hooks) refuses a second session, including one that would silently attach to an
orphaned vite on port 1420 and render its stale module graph.

The desktop launchers are `docs/Tabtivity.desktop` for the packaged app,
`docs/TabtivityHotReload.desktop` for the hot-reload dev server, and
`docs/TabtivityDev.desktop` for a frozen release build of the working tree
(`npm run package:dev` builds and installs it — real state, no hot reload;
it and the hot-reload window run one at a time, each launcher refusing while
the other is up); all carry a
`/path/to/tabtivity/...` placeholder to point at your checkout.

### Staying Current

**Settings → Updates** compares the running version against the project's
GitHub `/releases/latest`, and — for a release that published an artifact for
your platform — downloads it and hands it to that platform's own installer.

It is deliberately not the Tauri updater plugin, which expects a signed
`latest.json` and a CI signing key that this project does not have; it reads
the same public releases page a user would open by hand. Three properties are
worth knowing:

- **It only looks when you ask.** The check runs when that screen is opened and
  at no other time — there is no background poll and no check at launch.
- **The renderer names nothing.** No command takes a URL or a path: the
  download re-checks which asset belongs to this platform, and the install acts
  on what that download staged. Every asset URL is validated against this
  repository's release-download prefix before it is fetched and again before
  anything is installed.
- **Restarting is yours.** On Linux the running `.AppImage` is swapped in place
  (the previous build is kept beside it as `.old`) and the new one takes effect
  at your next launch; on Windows the NSIS installer runs and offers to close
  Tabtivity first; on macOS the `.dmg` opens. A copy installed by a package
  manager — the `.deb`, or a plain `cargo build` binary — is downloaded and
  then left alone, since installing it is not Tabtivity's to do.

## User Interface

The active layout is a single fullscreen orchestration surface:

```text
+------------------------------------------------------------------+
| clock | project switcher + pills | tab bar | indicators | controls |
+------------------------------------------------------------------+
| global cross-project app toolbar (hover-revealed from left edge)  |
+------------------------------------------------------------------+
|                                                                  |
| tiling subwindow layout: xterm.js PTY tabs, file viewers,        | file panel
| and full-surface tabs (mail, calendar, board, browser, print,    | (hover-revealed,
| skills, monitor)                                                 |  pinnable, and
|                                                                  |  movable to
+------------------------------------------------------------------+  either edge)
```

The file panel appears on pointer hover and
auto-closes after the pointer leaves; it can also be pinned open,
resized, and moved to the left edge. The project switcher lives in the top
header bar. `Super` hides the panels simultaneously; `F11` toggles fullscreen.

Some surfaces are **overlays over the whole window** rather than tabs — mail
(`MailOverlay`), the calendar (`CalendarOverlay`), the to-do board
(`TodoOverlay`), models & agents with the machine-level Skills library
(`ModelsOverlay`), and the presenter
(`PresentationOverlay`) — opened from their header indicator or the `+` menu.
Mail is the settled example: it was built as a tab *and* an overlay, and the tab
was retired (`RETIRED_TAB_CMDS`) because the mail store is global, so a
project-scoped tab could only ever show the same mailbox.

### Header Bar

`HeaderBar.tsx` spans the full window width and acts as the drag handle. It
contains:

- Clock, and a connection icon (`ConnTypeIcon`) that shows LAN vs WiFi and
  slashes itself when offline.
- The project switcher and its pills (`ProjectSwitcher.tsx`, rendered in
  `header-center`).
- Tab bar (from `TabBar.tsx`).
- Indicators, each owning its own surface and lifecycle: `MailIndicator` (✉),
  `CalendarIndicator`, `TodoIndicator`, `MachinesIndicator` (the fleet, with a
  live CPU/GPU bar per machine), `VpnIndicator` (machine-wide OpenVPN — project
  UI must not imply the tunnel is project-scoped), `MobileIndicator`,
  `BatteryIndicator`, `AppResourceDisplay`, and `AppTimerDisplay`.
- Custom minimize, maximize/restore, and close buttons.

**Online state** comes from the webview's own `navigator.onLine` plus the
`online`/`offline` events — there is no backend reachability probe. Separately,
`network_conn_type` is polled (10 s, stretched under the power saver) for the
LAN/WiFi distinction.

### Global Apps

The header's ▦ launcher is gone. **Settings → Global apps** still records one
command per role (`settings.json["global_apps"]`, listed by `GLOBAL_APP_ROLES`
in `SettingsSubPanels.tsx`); the `browser` entry is what PDF links open in
(`lib/linkTarget.ts`). Entries for roles no longer listed stay in settings
untouched.

Toolbar behavior:

- Role entries come from `settings.json["global_apps"]`.
- Buttons are hidden when `visible: false`; clicking exposes an inline edit
  popover to change the command.
- Clicking a visible role invokes `launch_or_raise_global_app` on the backend.
- The backend scans for an existing window matching the role, raises it, marks
  it sticky (X11), or launches a new instance.
- Desktop icons are resolved via `resolve_app_icon` and cached as data URLs.

### Center Panel and Tabs

`CenterPanel.tsx` owns the terminal/file-browser stack and drives tab scoping.

- When a project is activated, `CenterPanel` sets the tab scope to that
  project's ID and restores its saved layout from
  `<state_dir>/sessions/<project id>/terminals.json`, or opens a default agent
  tab on an explicit switch.
- When the root is active, the scope is `"root"` and the root terminal opens in
  `~/tabtivity/root/`.
- `TabBar.tsx` renders tabs with close, rename (double-click), drag-to-reorder,
  and a `+` menu for adding agent, shell, and files tabs plus locally installed
  Ollama models, the workspace-app tabs (browser, print manager, monitor, skills,
  calendar, board), and any custom agent registered from "＋ Add agent…". The
  Agents group is searchable, and `compact_tab_agents` decides which built-ins
  appear before you search. Tab drag is **pointer-based**, not HTML5 DnD, which
  breaks on WebKitGTK; the engine also skips a terminal `pointerup` for listeners
  added mid-gesture, so the commit fires from a handler `TabBar` binds at
  `pointerdown`.
- The center panel is a tiling layout: dragging a tab onto another subwindow's
  left/right/top/bottom edge splits that direction into a new pane (center drops
  move the tab in), splits resize with draggable dividers, and the whole tree is
  saved alongside the tabs in `terminals.json` (`tab_layout` / `tab_groups`).
- **Detaching subwindows.** A subwindow tab bar exposes a pop-out button
  (`detachGroup`) that calls `detach_subwindow` (`commands/subwindow.rs`). The
  backend opens a borderless Tauri `WebviewWindow` rendering the same bundle under
  `?detached=<scope>:<group>` (`DetachedApp.tsx` → `DetachedCenterPanel.tsx`),
  registers it as a project-owned `TrackedWindow` (origin `detached_subwindow`),
  and opts its X11 id into the workspace backend's parkable override so the normal
  `project_runtime::switch` hide/show path parks and restores it with its project.
  The ⤓ dock button (and the cross-window drag-to-dock) re-docks the group via
  `attach_subwindow`, which closes the window. **Closing** the popped-out window
  (WM/title-bar close) instead emits `detached-close`: the main window kills its
  tabs' PTYs, drops their payloads, and persists, so those tabs do NOT dock back
  and do NOT restore on next launch. Dock-back is session-only — a re-docked group
  restores as docked on restart; only the main window is the persistence owner.
  `attachOnly` never spawns a PTY, so the main window keeps owning the process.
- Each tab with kind `"agent"` or `"shell"` renders a `TerminalView` backed by
  a PTY. Tabs with kind `"local_agent"` also render a PTY, using `vibe` with a
  per-model local Ollama configuration. Tabs with kind `"files"` render a
  `FileBrowser`. Viewer tabs (`kind: "files"` with a `viewer`) render the native
  viewer for their file type; full-surface tabs render a workspace app.
- Tab layout is auto-saved to the session file whenever tabs change.
- If no tabs exist for the active scope, the stack shows an empty Subwindow with
  a `+`.
- A project-switch toast notification appears briefly after switching projects.
- An offline banner appears over the center when the webview reports offline.

`TerminalView.tsx`:
- Creates an xterm.js `Terminal` instance with the fit, web-links, and
  canvas/webgl addons (WebGL behind `terminal_webgl`). An open-watchdog guards
  the case where xterm never `open()`s — on Windows, WebView2 can drop the
  ResizeObserver callback, which showed up as a black, dead agent tab.
- On mount, invokes `spawn_pty` on the backend; backend emits
  `pty-output-<key>` events which the frontend writes to the terminal.
- Resize events call `resize_pty`; keyboard input calls `write_pty`.
- On unmount, invokes `kill_pty`.

### Right File Panel

`RightPanel.tsx` is a hover-revealed overlay on either vertical edge — it can be
pinned open, resized by dragging, and moved to the left edge. It and the Files
(Project) tab share one component, `ProjectFilesView.tsx`, so viewer features
cannot drift between the two surfaces: `ProjectFilesPane` owns tree/sort/source
mechanics, and hosts own only identity, active state, browsed folder, and chrome
slots.

Views, switched from the header toolbar:

1. **Files** — a recursive project file tree. Hidden-file section, double-click
   expand/collapse, per-file git status markers (modified, untracked, staged,
   committed-but-unpushed, ignored), drag a file onto a subwindow's tab bar to
   open it in a viewer, and a context menu (open, open with, new file, new
   folder, copy path, reveal, rename, delete, properties). File opens resolve
   per-project defaults → global defaults → system MIME → `xdg-open`, tracked via
   `open_file`.
2. **Git** — current branch, clickable branch pills for checkout, and a commit
   list whose entries open an editable commit-message window (amend HEAD,
   agent-generated messages, or checkout).
3. **Search** — project-wide file-name and literal content search; a hit jumps
   straight into the in-app viewer.
4. **Apps** — tracked external windows from the `windows.ts` store, each with
   un-tracking.
5. **± (sync)** — for remote projects, the pending-change view with direction,
   per-path upload/download offers, and never-synced (`localnew`) files.
6. **Sessions / jobs / import** — tmux sessions across connected machines, SLURM
   jobs, and import actions, shown when the project has them.

Work in a hidden pane is gated through `PaneVisibleContext` and caught up on
show. Mtime polls, animation loops, and terminal streaming all cost real time
while invisible, and on a remote project each poll is an SFTP round trip.
Remote/SFTP/git probes are additionally gated on the SSH session being
connected: a synchronous Tauri command against a dead session freezes the
window.

The panel is only rendered when a project is active and panels are not hidden.

### Project Switcher

`ProjectSwitcher.tsx` is the project-switcher strip in the top header bar
(rendered inside `header-center` by `HeaderBar.tsx`).

Contents:

- **Root button** — switches to the root terminal.
- **Search bar** — filters registered projects by name or path; `Enter`
  activates a unique match, `Escape` clears the search.
- **Project pills** — one per active/current project, drag-to-reorder with
  pointer events (`stores/drag/pillDrag.ts`, `PILL_DRAG_TYPE`); HTML5 drag-and-drop is
  not used anywhere in Tabtivity because it breaks on WebKitGTK. Hovering a pill
  shows the project path, status, today's active time (`get_time_today`), and
  live CPU%; a running-task indicator spins on pills with live terminal output,
  including backgrounded projects. Clicking switches to the project; the × button
  closes it. The pill's menu exposes the container toggle, remote actions, and
  **Publish to GitHub / GitLab** (see below).
- **The scope chip and the box pill** — `BoxScopeChip.tsx` is the row's fixed
  leading segment: one control standing for every scope that is not a project
  pill. Its dropdown is the only list of boxes (with Root and "All projects"
  above them); picking a box **slices** the strip to that
  box's members. The selected box then stands beside the chip as a pill of its
  own (`.box-scope-pill`) with a member-count badge: click it to enter the box
  scope, drop a project pill on it (same pointer drag as pill reorder) to add a
  member, right-click for Open / Rename / Edit box / Delete. Both wear the pill
  row's working/waiting/finished bars — the pill for its own box, the chip for
  every scope the pill is not reporting. See **Project Boxes** under Project
  Lifecycle.
- **Settings gear** — opens the settings dialog.
- **+ button** — opens an add-project menu: "New project", "Import project",
  and the remote/VM variants.

**Publish to GitHub / GitLab.** `publishProject` (`stores/projects.ts`) invokes
`publish_project` (`commands/git_publish.rs`) with a `provider` (`github` /
`gitlab`) and `visibility`. For GitHub it runs `gh repo create <name>
--<visibility> --source=. --remote=origin --push`; for GitLab it runs `glab repo
create <name> --<visibility> --remoteName origin` followed by an explicit `git
push -u origin HEAD` (since `glab` has no `--source/--push`), authenticating the
push with the effective token via an ephemeral inline git credential helper. For a
work-remote (SSH) project the CLI call runs over `ssh` on the host where the repo
lives (`BatchMode`, validated argv, single-quoted remote path), relying on that
host's own `gh`/`glab` auth. On success it records the new push target —
`git_type` becomes `remote-public` or `remote-private`, and `git_provider` the
chosen provider, in both `projects.json` and the project's `project.json` — and
returns the CLI's stdout (the repo URL). Requires the chosen provider's CLI (`gh`
or `glab`) installed and authenticated, or a token under Settings → Git hosting
(locally, or on the remote host for remote projects).

Settings dialog (`SettingsPanel.tsx` + `SettingsSubPanels.tsx`) covers the main
page — default agent command, theme, workspace management, experimental flags,
the daily-recap toggle, and the Tabtivity Mobile opt-in (`MobileSettings`) — plus
these sub-panels: **Global apps** (per-role commands, e.g. the browser for PDF links), **File types**
(per-type viewer behaviour, autocomplete and spelling defaults, autosave),
**Ollama** (model management, when the binary is installed), **Agents**,
**Shortcuts**, **Git hosting** (provider tokens), **VPN auto-connect**, **Remote
hosts**, **Archived projects**, **Scaffold repair**, and **Help**.

Themes are `THEMES` in `src/types/index.ts` — Fancy Dark, Plain Dark (the
default), Plain Light, Fancy Light, and Light Lavender.

**Experimental flags** (`src/lib/experimental.ts`) gate surfaces that are not
finished: `mail_client`, `web_browser`, `deck_presenter`, `python_run_debug`,
and `terminal_webgl`. An unset flag falls back to
`settings.debug`, so everything is on in a development build and off in a
release one — except `terminal_webgl`, which stays opt-in because WebGL can fall
back to software rendering while DMABUF is disabled, making a visible terminal
slower rather than faster. `EXPERIMENTAL_TAB_KINDS` marks the flags that own a
tab end to end and whose "off" closes something already open; the live sweep and
the restore filter both do nothing until settings have actually loaded, because
unknown must not read as off.

### Tabtivity Mobile

Tabtivity Mobile provides tailnet-only access to explicitly opted-in local project
sessions. The independently installed sidecar — a copy of the Tabtivity binary
running `--mobile-host` — binds to loopback;
an existing, non-Funnel Tailscale Serve HTTPS root handler must be verified as
an exact proxy to that port before Tabtivity saves or starts it. Each browser pairs
with a short-lived code and a device-held P-256 key and can be revoked
individually. The header's phone menu lists every paired device — a green
lamp for one signed in now, otherwise when it last connected — with
**Disconnect** (click again to confirm): the device is unpaired, signed out
within seconds, and needs a new pairing code to come back.

A project's or box's Mobile access reaches **all phones** (phones paired later
included) or **only these phones**, a checklist of the paired devices chosen
from the side panel's phone button or the **All phones ▾** button beside its
switch in Mobile settings (`tabtivity_mobile_devices`, beside
`tabtivity_mobile_access`). The sidecar filters every phone request through
it: a phone off the list neither lists nor opens the scope (it answers as an
unknown id), an open terminal of it detaches within seconds of a narrowing,
and its agent pushes go only to the listed phones. A re-paired phone is a new
device and is on no old list; after Lock down a limited scope reaches no phone
until re-picked ("No phones"). Design: `docs/context/mobile_access.md`.

**Per-phone sections and projects.** In **Settings → Mobile → Paired
devices**, each phone has **To-do / Calendar / Mail** buttons and its own list
of the projects and boxes that reach it. A section pressed off is gone from
that phone's tab bar and refused by the sidecar for that device (`403
section_hidden`); its alert rows are dropped, and without Calendar the phone
gets no reminder push. The choice lives on the device record in
`mobile-control/devices.json`, so revoking or re-pairing starts fresh.
**Disconnect** takes the phone off a project or box (one open to every phone
becomes the other paired phones; the last phone turns access off); **Add
project ▾** opens one for it (an off project opens for that phone alone).

Only persistent local shells and resumable configured agents are discoverable.
The sidecar derives opaque browser ids from trusted Tabtivity state and revalidates
the project, tab, tmux session, device session, and canonical project directory
throughout an attachment. Mobile creation goes through the running desktop and
accepts only a typed shell or cataloged resumable-agent request; it does not
accept paths, commands, argv, or tmux names. The protocol lives in
`src-tauri/src/services/mobile_control/`.

**Git on the phone.** A project's name menu on the phone has **⎇ Git**, a
read-only sheet the sidecar answers itself, window open or not
(`GET /api/v1/projects/{id}/git`, `mobile_control/git_overview.rs`): the project
folder's branch or detached sha with upstream and ahead/behind, the repo's
worktrees (only when a linked one exists; project folder first, each with its
change dot and how many of the project's tabs run in it), local branches and the
remote ones no local branch tracks — capped, with `+N more`. Worktrees cross as
the same opaque ids the ＋ sheet's "Agents start in" row uses; no path, lock
reason or full sha is sent. Boxes and the root console have no Git entry.

**Mark up a PDF or picture for the agent.** In an agent tab's viewer (the
files drawer, the 🖼 gallery or a picture/PDF bubble in the chat) a PDF or a
picture carries **Mark up**: write on the pages with a pen (an Apple Pencil
always draws, fingers scroll and pinch; a phone without a pen gets a ✋ / ✎
switch), drag highlighter boxes, tap to type notes, erase whole strokes, undo.
The marks live only on the phone (its own storage) until **Submit**: each
marked page's layer goes into the project's `.tabtivity/inbox/`, the desktop bakes
the marks into a copy, `<name>-marked.pdf`, as real PDF annotations (a picture
comes back drawn on, `<name>-marked.png`), and a prompt naming the file, the
copy, the layers and the typed notes goes into the chat — held like a typed
message while the agent works. The original file is never changed; the agent
is asked to apply the marks to the sources and send the rebuilt file back with
`tabtivity-send`. PDF pages are drawn on the phone by pdf.js inside a sealed
frame with no access to the session or the network. Project files need
**Settings → Mobile → Project files on the phone**; files the agent sent work
without it.

Marking up is a loop, not one shot (`docs/pdf_markup_rounds_plan.md`):
**Submit keeps the view open.** The round's marks stay on show, dimmed, and are
never sent again; marking goes on while the agent works, and the next Submit
carries only the new marks (into the agent's queue if it is busy). A pill
follows the agent since the last Submit — sent, queued, working, asking,
finished (with whether the PDF changed) — off the live screen. **Reload PDF**
redraws the file as it is now, or the newer copy the agent sent, under the same
layer: unsent marks stay, and the sent ones stay too, dimmed, so each change can
be checked and its mark then erased by hand (the eraser and Clear page reach
shown sent marks; ⋯ **Show sent marks** hides them). Nothing removes a mark
automatically.

**Apply marks directly, with an Undo** (`docs/pdf_markup_direct_apply_plan.md`;
on by default — the phone's switch in Home → This phone → **Mark up prompt**,
the desktop's in Settings → Agents → PDF markup). A Submit asks for an `apply`
round: the desktop first takes a snapshot of the project's git work tree in its
own state folder (never in the project or its `.git`), and the default prompt
has the agent make the changes, rebuild and (phone) send the PDF back in one
turn. Each time the round finishes the snapshot is settled; the pill then
offers **Undo**, which lists the files the round changed and whether the PDF
goes back, and on **Undo** puts them back as they were before the round —
refusing, with nothing changed, when one of them was edited since ("Can't undo
— `a.tex` changed since") — reloads the PDF under the marks and puts a short
note into the agent's chat, without starting a new round. (A phone view of a
copy the agent sent goes back to the copy the marks were drawn on, and Reload
then passes over the copies the agent sent before the undo.) Where no snapshot can
be taken — not a git repository, git missing or older than 2.40, too many
changed or untracked files, a remote project, a picture — the pill says why in
one line and the round runs list-first: the default prompt has the agent only
list the changes, and the pill offers **Make these changes**, which sends the
go-ahead (edit the sources, rebuild, send the PDF back) — its wording is the
second field of Home → This phone → **Mark up prompt**. With the switch off
every round is list-first. A custom Mark up prompt is sent as written in either
mode; the field starts from the default of the current mode.

How often the agent stops to ask about a mark is a five-stop slider beside the
prompt — **Ask always**, **Ask often**, **Ask when unsure** (default: only
unreadable marks and real choices), **Ask rarely**, **Never ask** — the
phone's in Home → This phone → **Mark up prompt**, the desktop's in Settings →
PDF markup. When a mark leaves the agent a choice it may ask about, a local
Claude, Codex or MCP-enabled Vibe tab can ask with its `markup_ask` tool (`docs/context/markup_mcp.md`;
on by default, Manage CLIs → Advanced). The questions show as a card in that
tab's markup view, phone and desktop alike, each with a `?n` pin at the words
it quotes. Several questions show one at a time, paged with ‹ ›. A tap only
picks (or **Other…** takes typed words); **Send answers** sends them into the
tab as the next prompt and closes the card everywhere, and **Answer in chat
instead** closes it unanswered. The phone's chat shows a one-line banner while
a question is open; on the desktop, with marking off, the **Mark up** button is
underlined and opens on the asking tab.

**Local models from the phone** (`docs/mobile_local_model_control_plan.md`).
Home → **Local models** lists the Ollama models installed on the desktop —
size, parameters and quantization, idle / loading / loaded / last load failed,
where a loaded one sits (GPU, N % on the GPU, CPU) and whether it stays loaded
or unloads in N minutes — with **Load** (Ollama picks the device, kept loaded)
and **Unload** (no confirmation), and **Start Ollama** when the desktop can
start it without a password (`systemctl --no-ask-password`, else an owned
`ollama serve` that quitting stops). The sheet polls every 2.5 s while
something loads or starts and every 10 s otherwise. Every request goes
`GET`/`POST /api/v1/local-models` → sidecar (`mobile_control/local_models.rs`)
→ desktop bridge (`src/lib/mobileLocalModels.ts`) → the window's Ollama
commands, so the desktop's 🧠 menu shows a load the phone started; with no
window open the routes answer 503 `desktop_unavailable` and the phone says to
open the app (there is no headless fallback). Load and Start answer at once and
the work runs on the desktop; a write whose answer misses the deadline is read
again rather than shown as failed. Downloading, updating and deleting stay
desktop-only: the sidecar refuses any other action with 400
`unsupported_action` before the desktop is asked, and the load command loads
only a name `/api/tags` lists. **Settings → Mobile → Local models from the
phone** (under Project access; unset = on) switches it off — both routes then
answer 403 `local_models_disabled` and the Home row disappears. A desktop build
older than the feature cannot parse the request and drops the connection, which
the sidecar cannot tell from no window: 503 `desktop_unavailable`, "open the
app". Only a window whose backend knows the request but whose page does not
answers `unknown_request`; the phone then says to update the desktop app.

### Workspace Apps

Each of these replaced a global-app role, on the same reasoning: what sits
behind the button is a list and a handful of verbs, and Tabtivity can render a
list. Where a link still needs an app, `src/lib/linkTarget.ts::routeUri` decides
— it opens the in-app surface when its flag is on and falls back to
`launch_app` for the configured external app when it is not.

| Surface | Frontend | Backend | Notes |
|---------|----------|---------|-------|
| Mail | `components/mail/`, `stores/mail.ts` | `commands/mail.rs`, `services/mail_{engine,store,crypt,crypto,pgp,sanitize,filters,authres,ai}.rs` | IMAP/SMTP. Behind `mail_client`. |
| Calendar | `components/calendar/`, `stores/calendar/calendar.ts` | `commands/calendar.rs`, `commands/caldav.rs`, `services/caldav.rs` | Month / time-grid / agenda, alarms, `.ics` import+export, CalDAV accounts. |
| To-do board | `components/todo/`, `stores/todo.ts` | shares `calendar.json` | Cards **are** calendar tasks — one store, not a second one. |
| Browser | `components/browser/`, `stores/browser.ts` | `commands/browser.rs`, `services/browser_engine.rs`, `services/web_safety.rs` | Reader mode, no scripts. Behind `web_browser`. |
| Print manager | `components/printing/PrintManagerPane.tsx` | `commands/printing.rs` | CUPS on Linux/macOS, PowerShell on Windows. |
| Skills library | `components/skills/` (+ the `ModelsOverlay` Skills tab) | `commands/skills.rs`, `services/skills.rs` | Claude-only; no manifest or versioning by design. |
| Deck presenter | `components/embed/deck/`, `lib/viewers/deck/` | `commands/presenter.rs` | Behind `deck_presenter`. |
| Daily recap | `components/stats/` | `commands/usage_stats.rs`, `services/usage_stats.rs` | Local-only counters. |
| System monitor | `components/monitoring/` | `commands/monitor.rs`, `gpustat.rs`, `sysstat.rs` | Local and remote hosts through the same parsers. |

**Mail encryption is two independent tracks that share a prefix.**
`services/mail_crypt.rs` seals the **local store**; `services/mail_crypto.rs` +
`mail_pgp.rs` handle what the **sender** did before the message left their
machine. They are sequenced, not merely ordered — the end-to-end track holds
private keys and caches nothing, so putting either into a plaintext store would
make the store key cryptographically equivalent to the mail key. `PgpKeyring::open`
takes `MailKeys` and there is no constructor that does not: the coupling is
enforced by the type.

- **At rest.** Every *value* is an envelope before SQLite sees it, so the WAL and
  the freelist can only ever hold ciphertext. XChaCha20-Poly1305 with a random
  192-bit nonce (AES-GCM's 96-bit nonce would need a counter that must survive a
  crash *and* a restore-from-backup — that is how reuse happens in the field),
  and every ciphertext is bound to its row by AAD, so an attacker with disk write
  access cannot relocate message A's sealed body onto message B's row. A sealed
  column cannot carry a `UNIQUE`, so schema v2 moves that constraint onto a keyed
  digest sitting in cleartext beside the sealed value. Search cannot use `LIKE`;
  it is a bounded decrypt-on-scan that reports how far it got, because a
  truncated answer that looks complete is the one thing a search must never
  produce. An unreachable key **degrades** to an ephemeral in-memory store rather
  than locking the mailbox — a locked Secret Service collection reads identically
  to "nothing saved" and can block forever.
- **End to end.** The ordering `decrypt → parse → sanitize → render` is
  non-negotiable: decryption confers no trust, and a decrypted body may have been
  encrypted *to* the victim by the attacker. Decrypted plaintext is never written
  to disk. Curve25519 only, deliberately — `pgp`'s unconditional `rsa` dependency
  carries an unpatched timing oracle (RUSTSEC-2023-0071).

**CalDAV** is hand-rolled on `reqwest` + `roxmltree` rather than a crate (the
Rust landscape is unmaintained or WebDAV-generic, and a `PROPFIND` body is a
five-line template). A sync **merges by resource URL** instead of replacing, so a
local edit is never silently dropped; an HTML login page fails loudly rather than
importing zero events.

### Native Viewers

Dragging a file from the tree onto a subwindow's tab bar opens it in a tab; the
viewer is chosen by extension (`lib/viewers/`, `components/embed/`). Text, YAML/
JSON, BibTeX, and HTML/SVG viewers are **text-preserving views** — they edit the
file's own bytes, so comments, delimiters, quoting, and line endings survive, and
they withhold the affordance rather than mangle a construct they cannot rewrite
safely. The full list, with per-viewer behaviour, is in `README.md`.

Four that carry design decisions worth recording here:

- **TeX** opens as a *single workspace tab per document* (deduped on
  `resolve_tex_root`): a left sidebar of the main file's `\input` children and
  graphics switches the center in-tab, and the compiled PDF is its **own** tab
  tied to the source path, popout-aware through `FileDropContext.openTab`.
  SyncTeX drives both directions across tiled or detached panes.
- **PDF redaction** rasterises the pages you marked on save, so covered text is
  gone from the file rather than hidden under a shape that any copy, extract, or
  annotation-delete would lift. Only marked pages are flattened.
- **PDF markup** (✎ **Mark up** in the PDF toolbar, the TeX workspace's PDF
  too) is the phone's markup on the desktop: pen, highlighter, typed notes and
  eraser over the pages, kept in this window's own storage — never in the
  project or the session — until **Submit** bakes `<name>-marked.pdf` into
  `.tabtivity/inbox/` (`pdf_markup_submit`, `commands/pdf_markup.rs`) and queues the
  prompt for an agent tab of the same project, straight into its queue if it
  works. The strip stays open with the same rounds and pill as the phone; a
  recompile while marks are on the pages waits for **Reload PDF** rather than
  sliding new pages under them. Local projects in the main window only, on the
  PDF as saved (no page edits pending), one pane per file. **Apply marks
  directly** (`pdf_markup_direct`, on unset) works as on the phone: an `apply`
  round backed by an undo snapshot, settled as it finishes
  (`pdf_markup_undo_settle`), and the strip's **Undo** → a confirm dialog with
  the files (`pdf_markup_undo_preview`) → `pdf_markup_undo`, a reload under the
  marks and a note queued into the agent tab; without a snapshot the round is
  list-first and **Make these changes** appears once the agent has listed them.
  Both prompts — the one a Submit ends with and that go-ahead — are the
  desktop's own, in Settings → Agents → **PDF markup** (`pdf_markup_instruction`,
  `pdf_markup_apply`).
  Its **Hand each Submit to a new subagent** switch (`pdf_markup_subagents`,
  off; the phone's ⋯ **Each Submit to a new subagent**) starts every Submit's
  prompt with `MARKUP_SUBAGENT_LINE` (`mobile-web/src/markupInstruction.ts`):
  the tab's agent hands the round to a new background subagent and ends its
  turn, so the next round goes in at once and rounds run side by side; answers
  to that round's questions and **Make these changes** are passed on to it.
- **Markdown** renders fenced `mermaid` code blocks and `$…$`/`$$…$$` math; KaTeX runs
  with `trust: false` and mermaid script-free.

Viewer state — editor/PDF scroll position, PDF/image zoom, image pan — persists
per tab. Editable text/LaTeX/Markdown viewers carry opt-in, entirely local Ollama
**autocomplete** (`Ctrl+Space`) and a dictionary **spell check**, both off by
default with a per-tab header toggle; if Ollama is not running autocomplete fails
silently, and nothing is ever sent off the machine. While spelling is on, the header shows
the dictionary language beside the toggle and a **＋ Language** menu that
downloads another Hunspell dictionary (wooorm/dictionaries) and switches to it —
the same download as Project Settings › Native viewers.

### Lessons, Tour, and i18n

`src/lib/tour.ts` drives a first-run tour and `src/lib/lessons.ts` holds ~30
step-by-step lessons that anchor onto real UI elements (`data-hint-anchor`),
hosted by `TourHost.tsx` / `HintHost.tsx` and listed in `LessonsMenu.tsx`.

Every user-facing string goes through `src/lib/i18n.ts` (`useT()`) — the one
place every language lives. English is the source of truth and holds every key;
`de`, `es`, `fr`, and `it` fall back to it. Display text is never hardcoded.

New or not-yet-live-verified features carry an `UntestedTag` pill in the UI,
removed per item only once the user says that item is tested.

### Fast Mode

**Settings → Fast mode** (default off) withdraws the display aids whose cost is
a directory walk, a standing poll, or a read of every file in view. What it
turns off:

- **Folder sizes in the file tree**, and the group totals summed from them —
  one recursive walk per visible folder, which on a remote project is a `du`
  over SSH.
- **The git-dirty dots on the project pills** — a `git status` per local
  project every 12 seconds, including projects you are not in.
- **The hover cards** on a project pill and on a tab; both fall back to a plain
  tooltip.
- **The CPU/RAM/GPU readout** in the header.
- **The Python ▶ button's check** for a `__main__` guard, which means reading
  every `.py` in view — a round trip per file on a remote listing. Files already
  answered keep their ▶: it stops the scanning, not the answers.
- **The file tree's periodic remote re-stat**, the 15-second refresh behind the
  sync markers. They still catch up when the window regains focus and on every
  explicit re-list.
- **Animations and transitions** throughout the interface.

Three properties hold for everything on that list, and are the rule for
anything added to it: it costs work nobody asked for, its absence is *legible*
(the number is simply not there — no spinner and no `…` that never resolves),
and nothing is lost but the aid. No file goes unlisted, no edit unsaved, no
lamp wrong. Fast mode may make Tabtivity say less; it never makes it say something
untrue.

It is a separate switch from **Energy Saver**, and the two compose. Energy saver
widens background timers and pauses idle animation off a live battery reading;
fast mode removes features off a standing preference — "plugged in, still want
it lean" is the case one merged control could not express. Everything is
reactive: turning fast mode off brings every surface back in place, with no
restart.

The withdrawals are all in the interface. The backend loops that keep two trees
in step — byte-sync, git lockstep, the usage watcher — are untouched, since
skipping those would not be withdrawing an aid but declining to do the work.

### Ollama Model Management

The Settings dialog shows an `Ollama...` panel when `ollama_is_installed`
returns true. The panel uses backend commands from `commands/ollama.rs`:

| Command | Behavior |
|---------|----------|
| `ollama_is_installed` | Checks whether the `ollama` binary exists in `$PATH`. |
| `ensure_ollama_running` | Starts the system `ollama` service when possible, otherwise falls back to `ollama serve`. |
| `ensure_ollama_running_unattended` | `ensure_ollama_running` for the phone: `systemctl --no-ask-password start ollama` (fails instead of a polkit dialog), then the owned `ollama serve` fallback that quit stops. Runs off the async runtime. |
| `ollama_server_kind` | Whether the configured Ollama server is on this machine (`"local"`) or another (`"remote"`); a bad `ollama_host` is an error. |
| `list_ollama_models` | Lists installed model names for the Local Agents tab menu. |
| `list_ollama_models_detailed` | Returns installed model names, disk sizes, family, parameter size, quantization, running state, and VRAM use. |
| `list_installable_models` | Returns Tabtivity's built-in catalog of common model families and tags. |
| `pull_ollama_model` | Pulls or updates a model through `/api/pull`. |
| `load_ollama_model` | Loads a model into memory (`device`: `gpu` / `cpu`, default auto) with `keep_alive = -1` and waits; emits `ollama-load-progress` (`loading` → `success`/`error`). |
| `load_installed_ollama_model` | The phone's load: only a name `/api/tags` lists (exact or `:latest`, never a prefix or a cloud model), Ollama picks the device, answers at once with the listed name and loads on a detached thread with the same events; refusals are bare codes (`ollama_not_running`, `model_not_installed`, `model_not_local`). |
| `stop_ollama_model` | Unloads a model from memory with `keep_alive = 0`. |
| `delete_ollama_model` | Deletes a local model through `/api/delete`. |
| `prepare_local_agent` | Writes an isolated per-model Vibe config and returns `VIBE_HOME` plus alias. |

`ensure_ollama_running` prefers `systemctl start ollama` so models owned by the
system Ollama service remain visible. If the service path is unavailable, it
spawns `ollama serve`; when system model directories are detected, it sets
`OLLAMA_MODELS` so the fallback process can see those models.

Local model tabs use `prepare_local_agent(model)`. The backend writes:

```text
~/.local/share/tabtivity/vibe_local/<alias>/config.toml
```

The generated Vibe config pins `active_model = "<alias>"`, disables tools with
`enabled_tools = ["__no_tools__"]`, registers the local Ollama provider, and
adds one model block for the selected model. `TabBar.tsx` then opens `vibe`
with both `VIBE_HOME=<path>` and `VIBE_ACTIVE_MODEL=<alias>`. Keeping one
directory per alias prevents one local model tab from shadowing another and
keeps global `~/.vibe/config.toml` untouched.

### Keyboard Shortcuts

| Key | Behavior |
|-----|----------|
| `F11` | Toggle fullscreen for the focused window (main or popout); also the fullscreen button in the window controls. |
| `Super` | Toggle all panels (file panel, switcher). Only while Tabtivity is focused. |
| `Escape` | Close dialogs. |
| `Enter` | Confirm create/import dialogs; activate a unique search result. |

Beyond these, a **rebindable** set lives in `src/lib/shortcuts/shortcuts.ts` and is edited
in Settings → Shortcuts, persisted as `settings.keyboard_shortcuts` overrides:
toggle subwindow fullscreen, cycle to the next project, previous/next tab in a
subwindow, cycle the focused subwindow up/down, cycle tabs, hide the focused
subwindow, toggle its file viewer, close the focused subwindow, close the active
tab, and close all tabs in a project. On macOS the Meta key is reserved for Cmd
shortcuts, so the chord labels differ there.

## Project Lifecycle

### Creating a Project

Click `+` → "New project".

Name sanitization:

- Trim and lowercase.
- Characters outside `a-z`, `0-9`, `_`, `-` become `-`.
- Repeated hyphens collapse; leading/trailing hyphens strip.

Example: `My New Project!` → `my-new-project`.

On confirmation the backend:

1. Creates `~/tabtivity/projects/<sanitized-name>/`.
2. Runs `git init --initial-branch=main`, falling back to plain `git init`.
3. Writes scaffold files.
4. Commits them as `Initial project scaffold` with author `Tabtivity <tabtivity@local>`.
5. Creates project-local `project.json`.
6. Adds a lightweight global index entry to `~/.local/share/tabtivity/projects.json`.

### Importing a Project

Click `+` → "Import project".

Import modes:

| Mode | Behavior |
|------|----------|
| Keep location | Registers the selected directory in place. |
| Copy | Copies the source into `~/tabtivity/projects/<sanitized-name>/`, excluding `.git/`. |
| Move | Moves the source into `~/tabtivity/projects/<sanitized-name>/`. |

Missing scaffold files are created without overwriting existing ones. If the
target has no `.git/`, Tabtivity initializes git and commits the registration.

### Scaffold Files

New and imported projects receive these files when missing:

| File | Purpose |
|------|---------|
| `AGENTS.md` | Canonical agent instructions — the single source of truth; links every sibling agent doc. |
| `CLAUDE.md` | Claude Code pointer: `@AGENTS.md` import plus Claude-specific overrides. |
| `GEMINI.md` | Gemini CLI pointer: `@AGENTS.md` import plus Gemini-specific overrides. |
| `.claude/settings.json` | Claude permission allow/deny rules scoped to the project. |
| `.gitignore` | Common ignores for Python, Node, macOS, logs, and build output. |
| `TODO.md` | Concrete task backlog with grouped IDs. |
| `ROADMAP.md` | High-level project direction and sequencing. |
| `STATUS.md` | Current-state and validation snapshot. |
| `README.md` | Project overview. |
| `DOCUMENTATION.md` | Architecture, behavior, and persistence notes. |

`AGENTS.md` carries the actual template; `CLAUDE.md` and `GEMINI.md` are
pointers that `@AGENTS.md`-import it (real import syntax in both CLIs, so the
text is loaded rather than merely referenced) and link the sibling agent files.
Writing guidance in one file is the point — three interchangeable stubs meant it
got written three times, or into whichever file that day's agent happened to
read.

A **scaffold repair** (Settings → Scaffold repair) additionally upgrades an agent
doc still byte-identical to its old pre-`AGENTS.md` stub, or empty — provably
untouched text — and reports it as `updated_files`. Anything a user or agent
wrote is left alone, and `project_scaffold_missing` counts a legacy stub as
missing so the pill's tag agrees with what a repair would actually do.

The root terminal also gets context files in `~/tabtivity/root/`:
`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`.

### Project Boxes (meta-project grouping)

A *box* temporarily joins two or more projects for side-by-side work — the box
folder plus every member root in one file view, cross-project copy-paste, PDF
merges across members, and box-rooted agent tabs (`BoxScopeChip.tsx`,
`BoxEditorDialog.tsx`, `stores/boxes.ts`, `commands/boxes.rs`;
`docs/context/project_boxes.md` holds the design rationale). Backend commands:
`get_boxes`, `save_boxes`, `create_box`, `rename_box`, `delete_box`,
`set_box_members`, `ensure_box_folder`, `refresh_box_agent_docs`,
`set_box_relations`.

- **Data model (N:M).** Boxes live in their own `~/.local/share/tabtivity/boxes.json`
  (`Vec<ProjectBox>` = `{id, name, member_ids, position, folder?, relations}`)
  so `projects.json` stays byte-compatible. The box's ordered `member_ids` is
  the ONLY membership record, and membership is non-exclusive — a project may
  sit in several boxes at once. The old per-project `box_id` back-reference is
  retired; a stale persisted key is stripped in-memory on load and dropped from
  disk by the next ordinary `save_projects`. `get_boxes` reconciles away member
  ids that no longer reference a known project.
- **Switcher (overlay model).** Member pills always render individually, with
  one colour swatch per box they are in (`lib/theme/boxColor`, a stable hue per
  box id); no box takes width in the scrolling strip. Every box stands as a
  small pill of its own in the fixed leading segment beside the scope chip —
  its mark in the box's colour, one click into the box, a standing drop
  target, right-click for rename / a Members checklist / edit / delete — up to
  `MAX_BOX_PILLS`; the rest stay in the chip's dropdown (which always lists
  every box) and the chip shows "+N". `Ctrl+Shift+PageDown/PageUp` cycle the
  boxes. Empty and one-member boxes survive and are still listed — the ONLY way
  a box disappears is an explicit, confirmed **Dissolve** / **Delete box** (the
  folder and agent docs stay on disk).
- **Box/unbox gestures.** Five ways in/out: the pill context menu's *Boxes*
  group (checkbox row per box, additive toggle), the box pill's context menu's
  *Members* checklist (toggles on the spot, stays open), Ctrl/Cmd-click
  multi-select → "Box these (N)…", the box editor dialog (rename, full member
  list, dissolve; opened from the box pill's menu, the pill menu, multi-select,
  or the switcher "+"), and drag-and-drop (plain or Alt drop on any box pill —
  or, when boxes overflow the row, on a row of the chip's list, which springs
  open under a drag — = additive add; Alt-drop one pill on another = new box of
  the two). While a box slice is selected the switcher's "+" lists non-members
  to add, and each member pill's ✕ removes only that membership.
- **Box folder, agent docs + member symlinks.** Opening a box (`openBox` →
  `ensure_box_folder`) lazily creates a folder under `~/tabtivity/boxes/<name>/`
  (unique name resolved against other boxes and existing dirs) and
  writes/refreshes managed `CLAUDE.md`/`GEMINI.md`/`AGENTS.md` link blocks
  pointing at each member's root and same-named agent doc; only the text
  between the `<!-- tabtivity:box-links:start -->` / `…:end -->` markers is
  regenerated, so user edits outside the block survive. Beside the docs, one
  **symlink per member** (Unix; skipped on Windows) makes each member root
  reachable as `./<member>/`, so agent CLIs launched in the box folder can
  traverse into every member. Ownership is recorded in
  `.tabtivity-box-links.json`: regeneration only ever removes links Tabtivity itself
  created, never a user file shadowing a member's name (the member re-links
  under a `-1` suffix instead). Tabtivity's own file confinement deliberately does
  NOT follow the links — the multi-root Files view is Tabtivity's file surface.
  `refresh_box_agent_docs` re-runs both after membership changes.
- **Box scope (persisted).** Opening a box activates a `box:<id>` tab scope
  (disjoint from project ids and `"root"`). The scope is first-class now: its
  tabs persist under `<state_dir>/sessions/box_<id>/terminals.json` and restore
  lazily on the next open (nothing restorable seeds one shell at the box
  folder). New tabs default to the box folder; the box "+" menu also offers
  per-member rows ("Files — ⟨m⟩" / "Shell — ⟨m⟩" / "Claude — ⟨m⟩") whose tabs
  land at the member root — resume-safe, since Claude keys history by cwd. The
  spawn gate (`pty_spawn`) and file confinement (`compute_allowed_roots`)
  accept the box folder ∪ member roots ∪ remote members' mirrors, and fail
  closed on an unknown box. Local shells in a box scope get tmux persistence
  like root/project shells. **Trust (v1):** box tabs run local + uncontained —
  a member's container/VM boundary does not extend to the shared scope; the box
  editor shows a notice when a member is containerized/VM.

### Trust Tiers

A project's shells and agents run in one of four tiers. The tier is a property of
the project; nothing else about working in it changes.

| Tier | Where tabs run | Files | Chosen |
|------|----------------|-------|--------|
| Local | host, in the project dir | host | default |
| Containerized | one session-lived `tabtivity-<id>` Docker container | host (bind-mounted at the *identical* absolute path) | pill toggle |
| Remote SSH | the host, over `ssh -tt` on a pooled ControlMaster | the host, over SFTP | at creation, or by *extending* a local project |
| VM | a QEMU/KVM guest, over SSH on a forwarded loopback port | guest only — **no shared filesystem** | at creation only |

- **Containers** (`services/sandbox.rs`). Every shell/agent tab `docker exec`s
  into ONE capability-dropped container; `local_agent` tabs stay on the host. The
  identical-path bind mount is what makes it a *toggle*: the file tree, git,
  viewers, and the usage watcher keep reading host bytes, and agent resume keeps
  working from the `cwd` recorded inside a transcript. Local-only, hidden or
  refused on unsupported platforms; closing a tab reaps in-container processes
  through the wrapper/pidfile mechanism.
- **VM projects** (`services/vm.rs`, `vm_proxy.rs`). A VM project *is* a remote
  project: the guest boots, exposes SSH on a forwarded loopback port, and is from
  then on an ordinary `RemoteSpec { host: "127.0.0.1", port, vm: true }`.
  Mirrorless, locality pinned, with a CONNECT-proxy egress switch. Implemented;
  never live-booted.

**Agent authority** has three axes that compose: the project container sandbox
(OS containment), the tab's `location` (local / primary host / `host:<id>`
worker), and the default-on local-agent filesystem fence. All three are
properties of the *process* — where it runs and what it can reach.

An agent's **permission mode** is deliberately not among them. Claude's
plan/accept-edits, Codex's sandbox and approval policy, Gemini's approval mode:
each is set inside that agent's own CLI, and Tabtivity launches the plain command
with no mode flag. A per-tab Plan/Auto toggle existed and was removed — a mode
is a *launch* flag, so every flip respawned the PTY (losing the scrollback and
any turn in flight), and a persisted per-tab mode became a second authority
record that could override, on restart, whatever the user had set in-session.
What survives a relaunch is the agent's own answer: the backend re-applies the
mode Claude's Stop hook recorded onto the `--resume` line. Args are never
persisted as the source of truth — they are rebuilt from layout state.

### Remote, Sync, and Multi-Host

Remote projects are **mount-free**: no sshfs, no FUSE. Tabs run on the host over
`ssh -tt`, files go over SFTP, git runs on the host, all through pooled
ControlMaster/SFTP sessions in `services::remote` — the source of truth for
host-aware resolution. Remoteness is **explicit**: use `remote_target_for{,_dir}`
and the host-aware variants, never inferred from path conventions.

- **Workers.** A project's `remote` is the primary host; extra `compute_hosts`
  are workers, each with its own pool entry, lamp, and tab locality (`host:<id>`).
  `services::worker_sync` is push-only, tracked-files-only code fan-out via git
  bundle/reset — never `git clean`, never the bidirectional divergence path.
  Shared-filesystem workers (the default in the add-machine UI) see the primary
  folder at their own `remote_path`: no git init/reset/fan-out, tabs just `cd`.
- **Two transports, split by git.** `services::git_peer` owns **lockstep**, which
  moves git-tracked commits and refs semantically via bundles over SFTP — never
  `.git` bytes. **Byte-sync** owns everything else and moves raw bytes. The
  `drop_tracked` split is what keeps the two from racing for one file. With
  lockstep on, a saved edit to a tracked file reaches the peer only after it is
  committed; that is the design, not a bug to fix back into continuous mirroring.
  Byte-sync is opt-in per path from an explicit manifest and does **not** read
  `.gitignore`, so a pull is previewed and confirmed before it drags a big host
  tree down.
- **Losses survive a relaunch.** Local-loss warnings are file-backed, not events:
  destructive background git or sync moves record through `services::local_loss`.
- **Credentials.** Passwords are never persisted by default; the opt-in save
  keys them by host/config target, not project id, so a blank password can mean
  "use the saved credential". Unix password auth runs through an OpenSSH
  `SSH_ASKPASS` shim rather than `sshpass` (Windows still uses `sshpass`).
- **Silence is a precondition.** Remote and VPN auto-connect must never prompt —
  the silent-connect predicates are checked first. Never elevate for a connect
  that cannot succeed silently: `pkexec` prompts *before* OpenVPN validates its
  config or credentials.
- **HPC.** `hpc_hosts` is user-set and gates *background behaviour* (scans, sync
  and lockstep loops, auto-connect, login-node runs); `careful_hosts` gates how
  much is read. The tag outranks careful mode. SLURM (`commands/slurm.rs`) and
  `hpc-workspace` allocation (`commands/hpc_ws.rs`) are driven from the app;
  nothing is site-specific — the host is asked what it offers.

## Architecture

The tree below lists only load-bearing entries; the directory listing is the
source of truth. `docs/filemap_frontend.md` and `docs/filemap_backend.md` are the maintained
file maps.

```text
Tauri v2 Application
+-- Rust backend (src-tauri/src/)
|   +-- commands/         Tauri command handlers (~55 modules)
|   |   +-- terminal.rs   PTY lifecycle, spawn/resize/kill/write
|   |   +-- projects.rs   Project CRUD, scaffold + repair, file tree
|   |   +-- fs.rs         Host-aware file read/write (local + SFTP paths)
|   |   +-- git.rs / git_peer.rs / git_publish.rs / git_fork.rs
|   |   +-- ssh.rs / remote.rs / sync.rs / vm.rs   Remote tiers and transports
|   |   +-- slurm.rs / hpc_ws.rs                   Cluster jobs and workspaces
|   |   +-- mail.rs / calendar.rs / caldav.rs / browser.rs / printing.rs
|   |   +-- tex.rs / synctex.rs / presenter.rs / sqlite.rs / sheets.rs
|   |   +-- skills.rs / agents.rs / ollama.rs / monitor.rs / usage_stats.rs
|   |   +-- mobile_control.rs  Tabtivity Mobile sidecar commands
|   |   +-- apps.rs / default_apps.rs / workspace.rs / subwindow.rs
|   +-- services/         Reusable runtime logic, AppHandle-free where that
|   |                     is the established boundary (~45 modules)
|   |   +-- remote.rs     ControlMaster/SFTP pool — host-aware resolution
|   |   +-- git_peer.rs   Git lockstep (bundles, never .git bytes)
|   |   +-- worker_sync.rs  Push-only, tracked-files-only worker fan-out
|   |   +-- sandbox.rs    Docker project containers
|   |   +-- vm.rs / vm_proxy.rs   QEMU/KVM guests and egress proxy
|   |   +-- mail_*.rs     Engine, store, at-rest crypt, OpenPGP, sanitizer, AI
|   |   +-- caldav.rs / openvpn.rs / skills.rs / usage_stats.rs
|   |   +-- agent_session.rs  Claude/Codex session hooks for resumable tabs
|   |   +-- mobile_control/   Path-free Mobile sidecar core
|   |   +-- local_loss.rs File-backed loss warnings that survive a relaunch
|   +-- platform/         Workspace backends
|   |   +-- x11.rs        EWMH/xcb — two-desktop parking (also Cinnamon/Muffin)
|   |   +-- wayland_kde.rs  KWin DBus — per-project virtual desktop
|   |   +-- windows.rs / macos.rs / null.rs
|   +-- terminal/mod.rs   PTY registry the frontend reconnects to by id
|   +-- schema/           Serde structs mirroring persisted JSON
|   +-- paths.rs / storage.rs   Path helpers (~/.local/share/tabtivity/)
|   +-- lib.rs            Command registration and app setup
|   +-- main.rs           Tauri entry point
+-- React/TypeScript frontend (src/)
|   +-- components/layout/    AppShell, HeaderBar, CenterPanel, GlobalAppBar,
|   |                         RightPanel, ProjectSwitcher, SettingsPanel,
|   |                         TourHost, DetachedApp/DetachedCenterPanel
|   +-- components/header/    Clock, ConnTypeIcon, and the indicators
|   |                         (Mail, Calendar, Todo, Machines, Vpn, Mobile,
|   |                         Battery, WindowControls)
|   +-- components/terminal/  TerminalView — xterm.js PTY wrapper
|   +-- components/files/     ProjectFilesView (shared by panel and Files tab)
|   +-- components/embed/     Native viewers, incl. deck/, pdf/, tex/
|   +-- components/{mail,calendar,todo,browser,printing,skills,monitoring,
|   |                stats,mobile,projects,tabs}/
|   +-- lib/                  i18n.ts, viewers/, tour.ts, lessons.ts,
|   |                         shortcuts.ts, experimental.ts, linkTarget.ts
|   +-- stores/               ~55 Zustand stores (projects, tabs, settings,
|   |                         mail, calendar, todo, sync, remote*, tour, …)
|   +-- hooks/                useKeyboard, useClampToViewport, useWindowFocused
|   +-- types/index.ts        Shared TypeScript types
+-- mobile-web/               The companion PWA — its own Vite bundle
```

**IPC pattern:** Rust ↔ React via Tauri `invoke` for request/response and Tauri
events (`emit_to` / `listen`) for push notifications (PTY output, time ticks,
workspace updates, sync and remote status). Terminal output is batched before
crossing IPC, and **only visible** PTYs stream: a hidden tab emits nothing over
IPC, feeding a terminal-activity digest for its pill instead, and replays on
show. Keep Tauri command payload names compatible with the frontend's camelCase
keys.

## Persistence Model

Tabtivity splits global index data from project-local metadata.

### Global Directory

All global data is under `~/.local/share/tabtivity/`.

| File | Purpose |
|------|---------|
| `projects.json` | Lightweight index of known projects. The retired built-in Trash workspace's `tabtivity-trash` entry is dropped on every read/write. |
| `boxes.json` | Project-box definitions (id, name, ordered `member_ids`, `folder?`, relations). |
| `settings.json` | User settings: agent command, theme, workspace management, global apps, experimental flags, shortcut overrides, window state. |
| `default_apps.json` | Global file-extension → app command map. |
| `global_machines.json` | SSH machines registered independently of any project. |
| `calendar.json` | Calendar events **and** to-do cards — one store for both. |
| `time_log.json`, `time_summary.json` | Session time records and their rollup. |
| `usage_stats.json` | Local-only rolling hour/day counters behind the daily recap. |
| `net_usage.json` | Network byte counters (separate source from usage stats). |
| `crash.log` | Appended on Rust panics. |
| `sessions/<project id>/terminals.json` | **Tab layout and `open_apps`**, keyed by project id — outside the project tree. |
| `mail/` | Sealed mail store: SQLite index, blobs, `accounts.json.enc`, `filters.json.enc`. |
| `browser/`, `vm/`, `remote-projects/`, `skills_cache/` | Per-subsystem state. Box *folders* live under `~/tabtivity/boxes/<name>/` (outside the state dir); a box scope's tab layout persists under `sessions/box_<id>/`. |
| `vibe_local/` | Per-model Vibe homes for local Ollama agent tabs. |

`active_session.json` no longer exists; orphan-session recovery is handled
inside the time-tracking service.

**Session state lives outside the project tree.** Tab layout and `open_apps` are
stored per project id under `sessions/`. The copy inside a project folder
(`<project>/.tabtivity/sessions/terminals.json`) is legacy/export-only and is
adopted only on an explicit request (`commands::projects::adopt_folder_tab_layout`)
— and `open_apps` is **never** adopted, since a folder-supplied list of host
commands to launch is exactly what the move guarded against. Treat any in-project
control file as attacker-controlled: Tabtivity's control files live in a
container's rw mount, and the host reads them as executable intent.

Usage stats are deliberately **not** mixed with time (`time_summary.json`),
network bytes (`net_usage.json`), or git statistics (re-derived from `git log` on
demand) — the recap reads each at its own source so they cannot drift. Tab opens
are counted in the frontend's `addTab`, not at `pty_spawn`, because the backend
spawn fires again for every resumable agent tab respawned on relaunch. File churn
comes from a `notify` watcher on the **active** project, which cannot see an SFTP
tree, so a remote project is counted only via its local mirror.

### `projects.json`

Each entry:

```json
{
  "id": "<uuid4>",
  "name": "My Project",
  "status": "current",
  "position": 10,
  "local_file": "/home/user/tabtivity/projects/my-project/project.json"
}
```

| Field | Meaning |
|-------|---------|
| `id` | Stable UUID. |
| `name` | Display name. |
| `status` | `current`, `active`, or `inactive`. At most one `current`. |
| `position` | Project-switcher ordering weight; lower appears earlier. |
| `local_file` | Path to the project-local metadata file. |

### Project-Local `project.json`

```json
{
  "id": "<uuid4>",
  "name": "My Project",
  "directory": "/home/user/tabtivity/projects/my-project",
  "git_type": "remote-private",
  "created_at": "2026-06-01T10:00:00+00:00",
  "status": "current",
  "position": 10,
  "local_file": "/home/user/tabtivity/projects/my-project/project.json",
  "default_apps": {
    ".md": "gnome-text-editor"
  },
  "file_type_stats": {
    ".ts": { "count": 20, "bytes": 48200 }
  },
  "time_today_s": 1800.0,
  "time_total_s": 3600.0,
  "time": {
    "total_s": 3600.0,
    "recent_sessions": [
      { "date": "2026-06-01", "start": "2026-06-01 10:00", "duration_s": 3600.0 }
    ]
  },
  "remote": null,
  "compute_hosts": [],
  "sandbox": { "enabled": false },
  "vm": null
}
```

- `project.json` holds project **identity**: name, directory, git/push axis,
  remote specs and `compute_hosts`, runtime/container and VM settings, per-project
  file-viewer settings, per-project `default_apps` overrides, and time rollups.
- `tab_layout` and `open_apps` are **no longer read from here.** The `tab_layout`
  field still exists in the schema for the legacy/export copy, but live session
  state is `<state_dir>/sessions/<project id>/terminals.json` (see above).
- Unknown fields are preserved on read/write (serde `deny_unknown_fields` is
  not used) to allow rollback to earlier versions. Python-era JSON shapes are
  preserved wherever the Rust schema already supports them — existing user state
  must round-trip cleanly.

The persisted tab entry itself is unchanged in shape: `{key, label, cmd, cwd,
kind, env?}`, where local Ollama tabs carry `kind: "local_agent"` plus the
`VIBE_HOME` / `VIBE_ACTIVE_MODEL` values needed to relaunch the same model, and
resumable Claude/Codex tabs carry a `sessionId`. Plan/Auto is persisted as a
launch *flag* per tab and re-applied when args are rebuilt — raw args are never
the source of truth.

The `git_type` field models the **push** axis (`local` / `remote-private` /
`remote-public`) and is independent of whether the project's *work* is remote;
a project can be local work with a GitHub push target, or SSH work with no
remote git at all.

### `settings.json`

```json
{
  "default_agent_cmd": "claude",
  "workspace_management": false,
  "color_scheme": "dark",
  "global_apps": {
    "browser": { "exec": "/usr/bin/firefox", "visible": true }
  }
}
```

- `default_agent_cmd` drives the default tab type and project terminal respawn.
  UI choices are `claude`, `codex`, `gemini`, `vibe`, plus any custom agent
  registered from "＋ Add agent…".
- `color_scheme` supports `fancy_dark`, `dark` (default), `light`,
  `fancy_light`, `light_lavender`.
- `global_apps` stores one entry per role with `exec` and `visible`; retired
  roles keep their entries but are filtered out of the bar.
- `compact_tab_agents` lists the built-in agent ids shown before a search in the
  `+` menu's compact Agents group. Unset means the familiar Claude/Codex/Gemini
  quick picks; an **empty list** is a deliberate choice to show agents only after
  searching, and is not the same as unset.
- `mobile_indicator` controls the Mobile host-status control in the header;
  unset means visible whenever the Mobile host is enabled.
- `keyboard_shortcuts` holds per-action chord overrides (Settings → Shortcuts).
- `fast_mode` is the Fast Mode switch (see above). **Unset and `false` both
  mean off** — the mode is never inferred; only an explicit `true` engages it.
  Read entirely on the frontend (`src/lib/agents/fastMode.ts`), which also holds the
  list of what it withdraws; the backend only round-trips the value.
- `window_state` holds monitor, position, size, and maximized for startup
  restore; experimental flags are stored as plain booleans keyed by flag name.
- Custom agents round-trip through the settings `extra` catch-all — no Rust
  field needed.

### `default_apps.json`

```json
{ ".py": "code", ".md": "gnome-text-editor", ".pdf": "evince" }
```

Lookup order for file opens:

1. Project-local `project.json["default_apps"]`.
2. Global `default_apps.json`.
3. System MIME default (`xdg-mime query default …`).
4. `xdg-open` fallback.

### `time_log.json`

```json
[
  {
    "project_id": "<uuid4>",
    "date": "2026-06-01",
    "start_iso": "2026-06-01T10:00:00+00:00",
    "duration_s": 3600.0
  }
]
```

A session left open by a crash is closed as an orphaned session on the next
startup. (The former `active_session.json` sentinel file is gone.)

## Runtime Behavior

### Startup

1. The main window is created hidden (`"visible": false` in `tauri.conf.json`).
   The backend's `restore_main_window` (`lib.rs`) reapplies the geometry saved in
   `settings.window_state` — monitor, position, size, maximized — then shows it,
   so the window never visibly jumps between monitors. If nothing is saved, or the
   saved rect no longer fits any connected monitor (an unplugged external display),
   it falls back to opening maximized wherever the WM puts it. Which rect is
   placeable is decided by `services::window_state::resolve_startup_geometry`.
2. `AppShell` mounts; loads settings and projects from the backend. On macOS only,
   `getCurrentWindow().setFullscreen(true)` is called after the window is ready
   (Linux must never enter fullscreen: a `_NET_WM_STATE_FULLSCREEN` window is
   unmovable under KWin). It then listens for window moves/resizes and writes the
   geometry back to `settings.window_state` on a 300 ms debounce, plus once more on
   close.
3. Projects marked `current` or `active` appear as project-switcher pills.
4. The project marked `current` is the initial active scope; if none, root.
5. Workspace management (if enabled) allocates desktops for visible projects.
6. The daily recap opens on the first launch of each day (`daily_stats_recap`,
   default on).
7. If Tabtivity Mobile is enabled, the loopback sidecar starts; the header's
   `MobileIndicator` reports its status.
8. Connection lamps fill in. Keychain reads are **bounded**
   (`remote_credentials::read_timed`, 4 s): a locked Secret Service collection
   reads identically to "nothing saved" and can otherwise block forever, which is
   what once left every lamp permanently amber.

### Project Activation

Switching to a project pill:

- Sets the active scope in the projects store.
- `CenterPanel` reacts to the `activeId` change: loads the saved layout from
  `<state_dir>/sessions/<project id>/terminals.json` and restores or spawns tabs.
- Updates the file panel to the new project directory.
- Starts a time-tracking session via `start_session`.
- The workspace backend moves windows between desktops (if enabled), including
  any detached popout windows, which are registered as project-owned tracked
  windows and park/restore with their project.

Switching away closes the active time session via `end_session`.

### Terminal Lifecycle

- `TerminalView` mounts → invokes `spawn_pty(key, cmd, args, cwd, env)`.
- Backend creates a PTY, spawns the child process, and begins streaming
  `pty-output-<key>` events.
- Project tabs get project-local XDG sandbox paths; local Ollama tabs also pass
  the prepared `VIBE_HOME` and `VIBE_ACTIVE_MODEL` values.
- xterm.js renders output; user input invokes `write_pty(key, data)`.
- Window resize invokes `resize_pty(key, cols, rows)`.
- Unmount invokes `kill_pty(key)`.
- The backend has a crash-loop guard: if a process exits within 1 s, respawn is
  delayed.

Tab layout is auto-saved to `<state_dir>/sessions/<project id>/terminals.json`
with a 500 ms debounce after any tab change.

`kill` and `kill_all` must reap the child process **subtree**, not just the shell
leader — and for a containerized project, the in-container processes through the
wrapper/pidfile mechanism.

**Restore.** Shell and files tabs always restore. Claude and Codex agent tabs
that carry a `sessionId` are resumable and restored with `--resume`; Gemini and
Vibe tabs are dropped. Tabtivity installs `SessionStart` hooks (a POSIX script on
Linux, a PowerShell `.ps1` on Windows) that record each tab's live session id
keyed by a `TABTIVITY_TAB_UID` env var, so resume follows the live session even
across a `/clear`. Codex additionally has hook-free binding, and Codex user hooks
may need a one-time `/hooks` trust.

**Performance.** The PTY batcher parks when idle and quiesces on window blur.
Hidden tabs do not stream (see the IPC note under Architecture); a heavy local
job should go in `batch.slice` or `SCHED_IDLE` (`chrt -i 0`), since a batch load
at nice 0 was measured starving the renderer by 57% versus 12% under
`SCHED_IDLE`.

### File Opening and External Window Tracking

When a file is opened:

1. Backend resolves the app command (per-project → global → MIME → `xdg-open`).
2. Backend launches the process via `xdg-open` or the resolved command.
3. The opened window is tracked by PID in `project.json["open_apps"]` and shown
   in the side panel's Windows view.

There is no X11 window embedding in the Tauri WebView. All file-opened apps run
as external processes tracked by PID.

### Global App Launching

1. Backend looks up the role entry in `settings.json["global_apps"]`.
2. Scans open windows for a match (by process name, WM_CLASS, or window title).
3. If found, raises the window (and marks it sticky on X11).
4. If not found, launches the configured command.
5. Global app windows are not moved during project switches.

### Network Monitoring

Two unrelated things, often confused:

- **Online / offline** is read from the webview's own `navigator.onLine` and its
  `online`/`offline` events in `HeaderBar.tsx`. Tabtivity runs **no** reachability
  probe of its own and contacts no third-party host to decide this.
- **Adapter type** (`lan` / `wlan`) comes from the `network_conn_type` command,
  polled every 10 s and stretched under the power saver.

Separately, `commands/network.rs` is a read-only **traffic monitor** for project
tabs: a local project observes the local host, and a remote project observes its
SSH host by riding the already-authenticated ControlMaster — it never opens a
connection of its own. The SSH-link snapshot is collected locally from the
ControlMaster's TCP socket, so it covers every multiplexed channel (terminal,
SFTP, sync, git).

### Workspace Management

Backend auto-detection:

| Backend | Detected when |
|---------|--------------|
| KDE Wayland | `WAYLAND_DISPLAY` is set and `XDG_CURRENT_DESKTOP` contains `kde`/`plasma` |
| X11 | X11 display is available and KDE Wayland conditions are not met |
| Null | All else |

**X11 two-desktop model:**

- Workspace 0 (`Tabtivity`): the visible workspace for the current project.
- Workspace 1 (`Tabtivity-Hidden`): parking workspace for inactive project windows.
- On project switch, non-sticky windows from workspace 0 are moved to workspace
  1 (or vice versa).
- Global app windows are excluded from parking.

**KDE Wayland per-project model:**

- Each project gets a dedicated KDE virtual desktop.
- Switching projects switches `VirtualDesktopManager.current` via KWin DBus.
- Tabtivity is made sticky at startup via `_NET_WM_STATE_STICKY` or KWin scripting.
- KDE 5 and KDE 6 use different DBus paths (`/KWin` vs `/VirtualDesktopManager`).
- Window enumeration uses KWin JS scripting via `org.kde.kwin.Scripting`.

### Downloads (removed)

Tabtivity used to maintain a `~/tabtivity/downloads` symlink and rewrite Firefox and
Chromium preference files on project switch. **Both were removed on 2026-06-30**,
along with `commands/downloads.rs`, under the rule that Tabtivity must never
manipulate another application's paths or config. `tests/no_foreign_config_writes.rs`
is a regression guard that fails the build if such a write reappears in the source
tree; the agent-session hooks (`services/agent_session.rs`) are the one deliberate
exception to that rule.

What remains is Tabtivity's own: the in-app browser writes into its own downloads
directory — never the active project — and `commands/fs.rs::list_recent_downloads`
is an unconfined lister sharing its shape with the project-confined one.

### Crash Logging

`std::panic::set_hook` in the Rust backend appends stack traces to
`~/.local/share/tabtivity/crash.log` on panics.

## Tests and Quality Checks

Five gates, all of them enforced in CI:

```bash
npm run build                                   # tsc + both bundles
npm test                                        # vitest
cargo test --manifest-path src-tauri/Cargo.toml
npm run lint                                    # eslint
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

`npm run build`, `npm test`, and `cargo test` run on all three platforms in CI.
**Only `npm run build` type-checks** — `npm test` and ESLint do not — so a type
error in `src/` *or* `mobile-web/` surfaces there and nowhere else. Lint and
clippy are both at zero; keep them there. `cargo fmt` is deliberately not
enforced.

A green *local* clippy is not a green *CI* clippy: CI lints with today's stable
while yours is whenever it was last `rustup update`d, and each release adds
lints. Either update, or lint against CI's version with `cargo +<ver> clippy …`.

**Before every push** — this repository is public — the privacy/secret scan must
pass:

```bash
git add -A && scripts/privacy-check.sh          # or: scripts/privacy-check.sh <base> <head>
```

`.githooks/pre-commit` (and `pre-merge-commit`) runs it over what each commit
records, so a leak never enters history; `.githooks/pre-push` runs it over the
outgoing commits — the authoritative gate, since rebases, cherry-picks,
plumbing commits and `--no-verify` skip pre-commit — and a `privacy` CI job
repeats it. With [gitleaks](https://github.com/gitleaks/gitleaks) on `PATH`
both hooks also run it (it knows far more token formats; CI runs it over the
whole history either way, but only after the push is public). Enable the hooks
once per clone with `git config core.hooksPath .githooks`; that arms the
privacy scans and the automatic patch-version bump. Never hardcode institution or lab hostnames, and
commits must use the GitHub `noreply` author email.

Notable suites beyond schema round-trips: hostile-input fixtures for mail
(`tests/mail_hostile_message.rs`, `mail_hostile_crypto.rs`), capability-scope and
file-ops guards, the project-tree intent tripwire, the foreign-config regression
guard, and Ollama config regressions (per-model Vibe homes, active-model
ordering, alias sanitization, no-tools config, idempotent generation). The live
Ollama integration test skips itself when no local server or model is available.

`main` is the stable default branch; ongoing work lands on `develop` and reaches
`main` by PR.

## Known Limitations

- X11 window embedding is not implemented; all file-opened apps run externally.
- KDE Wayland workspace management needs live-session QA (functional but
  untested end-to-end).
- Non-KDE Wayland compositors use the null backend (no workspace switching, no
  sticky windows).
- PTYs do not survive an app restart; tabs respawn their processes on next
  activation. Shell and files tabs restore, and Claude/Codex tabs with a
  `sessionId` resume their conversation, but live scrollback is not restored and
  Gemini/Vibe agent tabs are dropped. On a *remote* project, a tmux session per
  shell tab does survive an SSH drop, a laptop sleep, or Tabtivity quitting.
- Detached (popped-out) subwindows are session-only: they re-dock into the main
  layout on restart rather than respawning as separate OS windows.
- Project-box scopes are session-only: a box's tabs are dropped on project switch
  / restart. Renaming a box does not move its already-created folder.
- `publish_project` requires the chosen provider's CLI — `gh` (GitHub) or `glab`
  (GitLab) — installed and authenticated (on the remote host for work-remote
  projects); it does not manage provider auth itself beyond an optional token.
- Ollama model installation and update depend on network access to the Ollama
  registry and may take minutes for large models.
- `ensure_ollama_running` can start a system service only when the current user
  has permission to do so; otherwise it falls back to a user `ollama serve`
  process.
- Open-app restore uses a best-effort relaunch model; the geometry and focus
  order of *externally launched app* windows are not restored. (Tabtivity's own main
  window does restore its monitor, position, size, and maximized state — see
  Startup below.)
- Online/offline reflects what the webview reports (`navigator.onLine`), which
  can read as online on a captive-portal network.
- **Much of the newer surface is code-complete but not live-verified.** Mail is
  in daily use; the deck presenter, the to-do board, and VM projects have never
  been run live (no VM has been booted), CalDAV has never been pointed at a real
  server, and SLURM/HPC awaits real-cluster QA. Such items carry an `UntestedTag`
  pill in the UI.
- Tabtivity Mobile hosts on all three OSes — systemd user service on Linux,
  launchd LaunchAgent on macOS, Run-key autostart plus a named-pipe control
  plane on Windows, where terminal attach still requires tmux so only the
  desktop-mediated surfaces (mail, calendar, to-dos, pairing) work. Tailscale
  is required on both ends; the macOS/Windows host paths and the real-phone
  security and acceptance QA are unverified.
- Containerized projects are local-only and hidden or refused where Docker is
  unavailable; VM projects need QEMU/KVM.
- The Agent Skills library is Claude-only, with no manifest, versioning, or
  cross-agent generalization — deliberately outside the MVP.
- Mail search is a bounded decrypt-on-scan (50 000 rows) because the store is
  sealed; it reports where it stopped rather than implying a complete answer.
  What stays readable on disk by design: message counts, folder structure,
  arrival dates, sizes, and flags — plus folder ids, which are unkeyed
  `sha256(path)[..8]`, so a wordlist recovers which folders exist.
- Blurred box-shadows must never be animated: WebKitGTK renders them in software
  with DMABUF off. DMABUF stays disabled — a 2026-08-05 re-test on WebKitGTK
  2.52.3 was faster but produced flicker, missing PDF images, and a renderer
  crash.
- A native scrollbar's shape is unreachable from CSS on WebKitGTK, so Tabtivity
  hides the engine's bar and draws its own (`lib/theme/customScrollbar.ts`).

## Practical Development Notes

- Edit frontend under `src/`; backend under `src-tauri/src/`. Run all five gates
  above before handing off changes.
- **Agents must never start Tabtivity**, and must never stop an instance they did
  not start — a running window holds the user's open tabs and live terminals.
  The app's lifecycle belongs to the user. To verify something live, ask them to
  launch it or use a window they already have open; otherwise report the
  automated gates only and say plainly that the change was not run live.
- `src/` changes hot-reload into a running window — do not ask for a restart.
  `src-tauri/` changes do not, because `tauri dev` runs `--no-watch`; backend
  edits accumulate harmlessly until the user restarts deliberately. Run
  `npm run backend:stale` after backend edits and report the result. The cost of
  this trade is a backend fix that compiles and is silently not in the window.
- All user-facing strings go through `src/lib/i18n.ts` (`useT()`); English holds
  every key and the other four languages fall back to it. Never hardcode display
  text.
- Prefer local component state and existing Zustand stores over new global state.
- Keep service modules `AppHandle`-free and unit-testable where that is the
  established boundary.
- Keep Tauri command payload names in camelCase to match frontend `invoke` calls.
- Global/runtime data lives under `~/.local/share/tabtivity/`; do not store it in
  tracked markdown files. Unknown JSON fields are preserved on read/write to
  allow rollback to earlier versions, and existing user state must round-trip
  cleanly.
- Menus and dialogs share one canonical scheme (accent header + divider,
  `--text-primary`, `--bg-panel` chrome). Portaled dialogs must set an explicit
  color — `body` has none, so they inherit black.
- Add a TODO to the matching group file in `todo/`; create a group only if none
  fits. Avoid unrelated rewrites in docs, generated state, built assets, project
  metadata, `dist/`, `target/`, and backup files.
