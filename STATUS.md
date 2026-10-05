# Tabtivity — Status

Current implementation snapshot, reviewed **2026-09-15** against **v0.1.68**
(`c5c0e2d`). Product overview: [README.md](README.md). Remaining direction:
[ROADMAP.md](ROADMAP.md). Item-level implementation and verification tracking:
[TODO.md](TODO.md) and [`todo/`](todo/).

## Current State

- **Desktop workspace:** Tauri 2 + React 18 + TypeScript. The Python/GTK migration
  is complete. Projects and non-exclusive project boxes own terminal layouts,
  files, apps, time tracking, and best-effort desktop context. The header scope
  picker includes projects, boxes, Root, and Trash; the movable side panel has
  Files, Git, Apps, and Agents views.
- **Agents:** 27 built-in CLI entries, including Muse Code, plus custom commands
  and local Ollama-backed tabs. Claude/Codex preserve per-tab conversations;
  several other CLIs, including Gemini and Vibe, restore through continue-latest
  arguments. Claude/Codex hooks report turn activity, with output heuristics as
  the fallback. Permission modes belong to the agent CLI; the Tabtivity Plan/Auto
  toggle has been removed.
- **Prompt workflows:** a per-scope chart tab combines a zoomable timeline,
  Markdown drafts, a free-position draft board, tags, filters, multi-selection,
  prompt/model history, scheduled delivery, and related/after links. After-links
  wait for completion plus five idle minutes. One-time, daily, and weekday
  schedules run while desktop Tabtivity is open, with a one-hour catch-up window.
  The chart permits one independent schedule rule per tab; chains add follow-ups.
- **Remote and runtime support:** mount-free SSH/SFTP projects, Git lockstep for
  tracked commits, opt-in byte-sync for other files, multi-host workers, tmux
  sessions, system/GPU monitoring, OpenVPN, and HPC/SLURM tools. Local projects
  can use Docker session containers or QEMU VMs. The local-agent fence uses
  bubblewrap on Linux and Seatbelt on macOS; Windows reports no agent fence.
- **Tabtivity Mobile:** opt-in PWA and loopback sidecar over a private Tailscale
  tailnet. Agent/session lists, touch terminal, chat-style Focus, model selection,
  schedules, tab closing, project boxes, to-do/Alerts actions, gated mail writes,
  and the file outbox are implemented. Focus reads stored Claude/Codex prompts
  and answers when available, falling back to the terminal. `tabtivity-send`
  supports local/container file transfers up to 24 MiB. Mobile project access
  excludes remote, VM, and ordinary container projects; Trash is the exception.
- **Workspace apps and viewers:** embedded mail, calendar/CalDAV, to-do board,
  reader browser with opt-in separate live-page windows, print manager, Claude
  Skills library, daily recap, and Deck presenter. Native viewers cover
  text/code, Markdown, YAML/JSON, BibTeX,
  LaTeX/PDF, images/annotation, tables/spreadsheets, notebooks, diffs, SQLite,
  HTML/SVG, ODT, and media. Recent additions include mail PDF previews,
  dictionary spell check, TeX/Beamer editor improvements, and print previews
  with copies and job-queue tracking. CalDAV push is opt-in with conflict review;
  mail and CalDAV accounts can require a VPN. CSV/TSV cells and rows are editable
  with text-preserving saves; spreadsheet workbooks remain read-only.
- **Interface:** five languages with English fallback, Theme Customizer and
  presets, keyboard steering, shortcut help, Fast mode, Energy Saver, and
  Advanced options in Settings. Hidden viewers suspend background work and
  hidden terminals buffer output. `F11` toggles fullscreen; `F9` toggles panels;
  bare `Super` also works where the desktop does not reserve it.

## Platforms and Packaging

| Platform | Implemented support | Verification limits |
| --- | --- | --- |
| Linux X11 | EWMH window parking; reference desktop platform | Individual newer features still need live QA. |
| KDE Wayland | KWin scripting, KDE 5/6 per-project desktops | Live-session QA and tracked-window fallback checks remain. |
| Other Wayland | Terminal/file workspace with null window backend | No compositor-specific workspace switching or sticky windows. |
| Windows | Win32 window parking, native app/file integration, Docker Desktop, QEMU/WHPX, Mobile Run-key host | CI builds/tests; real-hardware QA pending. No agent fence, local tmux persistence, or ControlMaster link counters. |
| macOS | App-level window parking, LaunchServices, Keychain, Seatbelt fence, Docker Desktop, QEMU/HVF, Mobile launchd host | CI builds/tests; real-hardware QA pending. Parking is per application, not per window. |

CI builds Linux AppImage/`.deb`, Windows NSIS `.exe`, and unsigned universal
Intel/Apple Silicon macOS `.dmg` packages. Tags publish the platforms whose
package jobs succeed. `main` is the stable branch; ongoing work lands on
`develop` and reaches `main` by PR.

`npm run tauri:dev` hot-reloads the frontend but disables Rust watching. Backend
changes and embedded PWA changes require a deliberate rebuild/relaunch to reach
the window. `npm run backend:stale` reports those seams. On Linux,
`npm run package:dev` freezes the working tree; the enabled post-commit hook
queues a coalesced background freeze of the commit. Failed passes are recorded,
newly queued commits still get a pass, and the launcher reports a stale snapshot.
Neither a build nor a commit restarts a running window.

## Persistence and Restore

- Session layouts and open-app records live outside project trees at
  `<state_dir>/sessions/<scope-id>/terminals.json`, including box scopes.
  Project-local session files are legacy/export-only; adoption requires an
  explicit request and never imports their open-app commands.
- `project.json` keeps identity, remote/runtime configuration, and viewer
  preferences. Global state normally lives in `~/.local/share/tabtivity/`.
  Prompt drafts/history/links use `agent_prompts.json`; per-tab schedules and
  delivery receipts use `agent_tasks.json` with bindings in the tab layout.
- Shell, file, and supported resumable agent tabs restore. Ordinary PTYs do not
  survive app exit; tmux-backed sessions can reattach. Closing a project leaves
  remote tmux work running. Detached windows re-dock on restart; closing a
  detached window closes its tabs.
- Download source folders are browsed in the file panel. Screenshots and saved
  mail attachments use ignored Tabtivity-prefixed folders. Tabtivity does not edit
  another browser's preferences or redirect its download directory.

## Quality and Verification

The configured gates are:

- `npm run build` — TypeScript checks plus both desktop and Mobile bundles.
- `npm test` and `cargo test --manifest-path src-tauri/Cargo.toml` — frontend and
  backend suites. CI runs builds and both suites on Linux, Windows, and macOS.
- `npm run lint` and
  `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
  — the Linux CI lint job. CI uses stable Rust; an older local clippy can miss
  newer lints. `cargo fmt` is not an enforced gate.
- `scripts/privacy-check.sh` — pre-push and CI privacy scan; all package jobs
  depend on it.

This documentation review inspected source, history, and CI configuration; it
is not a fresh application build/test result or a live run. Historical test
counts have been removed because they do not establish the current verdict.
Agents must never launch Tabtivity or stop the user's instance for verification.

**Implemented, automated, and live-tested are separate states.** Mail and
selected calendar, to-do, Mobile, import, file-tree, and monitor controls have
recorded live use; this does not close every manual check in those subsystems.
Remaining high-value acceptance work includes:

- Real Windows/macOS hardware and KDE Wayland workspace behavior.
- CalDAV against a real server, mail crypto, and Mobile security/reconnect cases.
- Deck presentation on a second display, VM boot/lifecycle, and real HPC/SLURM.
- Prompt-chart drag/link/schedule flows, completion gating, and multi-tab resume.

`UntestedTag` stays on individual features until the user confirms them.
Continue-latest agent restores can mix up tabs sharing a directory; external-app
relaunch and geometry restore remain best-effort. Further detail belongs in the
matching [TODO group](TODO.md), not generated runtime logs in this file.
