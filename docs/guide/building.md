# Building, development and storage

Moved out of the [README](../../README.md).

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

## Running a development build

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

## Stack

- **Frontend:** React 18, TypeScript, Vite, Tailwind CSS, Zustand
- **Terminal UI:** xterm.js (`@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`)
- **Backend:** Rust, Tauri v2
- **PTY:** `portable-pty` crate
- **Companion PWA:** a separate Vite bundle under `mobile-web/`, served by a
  loopback sidecar (built by the same `npm run build`)
- **Workspace:** `zbus` (DBus) and `xcb` (X11) on Linux; the Win32 API
  (`windows` crate — `SW_HIDE`/`SW_SHOW`, `EnumWindows`, virtual-desktop manager,
  shell-link/icon resolution) on Windows

## Packaging and diagnostics

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

See [DOCUMENTATION.md](../../DOCUMENTATION.md) for the detailed architecture, data
schemas, behavior notes, and known limitations.
