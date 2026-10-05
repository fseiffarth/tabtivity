# Tabtivity — Feature Checklist

A manual-QA matrix for the current **Tauri 2 + React + TypeScript** Tabtivity
(the former Python/GTK `app/` implementation and its `plan_*.md` / `tests/`
files are gone — ignore any older snapshot that references them).

Ground truth for this list: `docs/REVIEW.md` (the three-reviewer code review)
and `TODO.md`. Per that review, **all automated tests pass but no feature has
been live-QA'd** — filling in this matrix is the single biggest gap between
"code-complete" and "shippable."

Use the columns during manual QA:

- **Done** — works end to end.
- **Partial** — some part works; scope incomplete or unverified.
- **Issue** — a bug, crash, missing behavior, or UX problem was found.

Do not launch a second Tabtivity instance from an agent terminal while checking
these items (it can corrupt workspace state). Check in the already-running
instance, or after the user restarts Tabtivity. Frontend (`src/`) edits hot-reload;
only `src-tauri/` changes need a rebuild/restart.

## Implemented (code-complete, automated tests passing)

| Feature | Done | Partial | Issue | Notes |
|---------|:----:|:-------:|:-----:|-------|
| Root control terminal + per-project PTY terminals | | | | xterm.js + PTY |
| Project switcher: search, DnD reorder, CRUD | | | | `ProjectSwitcher`/`ProjectSearch`/`ProjectDialog` |
| Project boxes (meta-grouping) | | | | #13/#41 ph.1–2; phases 3–4 deferred |
| File-tree overlay with git status markers | | | | `RightPanel`/`FileTree` |
| Git history / commit / push | | | | `commands/git.rs` |
| GitHub publishing | | | | `commands/github.rs` |
| Per-project time tracking + activity calendar | | | | `ActivityCalendar` |
| Per-project CPU display | | | | `header/AppResourceDisplay` |
| App launching + external window tracking | | | | `commands/apps.rs` |
| Global app bar | | | | `GlobalAppBar` |
| Default apps per project / file type | | | | `commands/default_apps.rs` |
| Per-project download routing | | | | `commands/downloads.rs` |
| In-app viewers: PDF, image, markdown, code | | | | `FileViewerPane` + `lib/viewers/*` |
| In-app TeX viewer with bidirectional SyncTeX | | | | `commands/tex.rs`, `stores/viewers/pdfSync` |
| LaTeX `\ref`/`\cite` completion (labels + .bib) | | | | `lib/viewers/tex/tex`, `TexComplete.test` |
| In-editor find / find-and-replace | | | | `Ctrl+F`/`Ctrl+R`; `EditorSearch.test` |
| Viewer reader-position persistence (scroll/zoom/pan) | | | | `ViewerState`; `ViewerStatePersist.test` |
| Tiling subwindows (split/group tree, DnD) | | | | `CenterPanel`/`Subwindow`/`TabBar` |
| Subwindow detach to standalone OS window | | | | #42; `DetachedApp` |
| Agent session resume — Claude | | | | #39a–c; `--session-id` |
| Agent session resume — Codex | | | | #39a–c; needs one-time `/hooks` trust |
| SSH remote projects (sshfs mount, remote PTY) | | | | #28/#28b |
| OpenVPN tunnels for VPN-gated hosts | | | | `VpnPasswordPrompt`, `services/openvpn.rs` |
| README default tab; tab inline rename + scope bind | | | | |
| Keyboard shortcuts (rebindable) | | | | `lib/shortcuts/shortcuts.ts`, #62 |
| Autosave / font-size / per-type viewer prefs | | | | |
| Viewer link routing | | | | `stores/linkRouting` |
| WebKitGTK crash reporter | | | | `crashReporter.ts`, `commands/crash.rs` |
| Ollama local model management + autocomplete | | | | `commands/ollama.rs` |
| Filesystem watch | | | | `commands/fs_watch.rs` |
| X11 workspace switching | | | | `platform/x11.rs` |
| Windows workspace backend (SW_HIDE parking) | | | | `platform/windows.rs` |
| macOS workspace backend (app-granular hide/unhide) | | | | `platform/macos.rs` |
| Windows/macOS parity: presenter inhibitor, spell dirs, popout ids, renderer memory, crash reporters, network tables, GPU readouts, box junctions, file defaults, macOS fence, containers on Windows, VMs on macOS/Windows, Mobile on Windows | | | | 2026-09-03 sweep; all **untested** on hardware |

## In-progress / partial

| Feature | Done | Partial | Issue | Notes |
|---------|:----:|:-------:|:-----:|-------|
| SSH hardening (#28c) | | | | two **Critical**: remote cmd injection in `ssh_list_dir`/`ssh_default_dir`; remote `--resume` ordering bug |
| Agent resume generalization (#39d) | ✅ | | | Claude/Codex resume-by-id; Gemini (`--resume latest`) + Mistral/vibe (`--continue`) via continue-last |
| KDE Wayland backend (#18) | | | | show/hide are explicit no-ops (KWin scripting pending) |
| Boxes phases 3–4 (#41) | | | | merged file tree + relation graph deferred |
| Git worktrees (#23) | ✅ | | | list/add/remove/lock/prune, host-or-mirror side, worktrees confined to `<root>/.tabtivity/worktrees/`; `docs/worktree_improvement_plan.md` phases 0–2. **Untested.** Worktree-aware tab groups + worktree-as-project (phases 3–4) deferred |

## Open / not started

| Feature | Notes |
|---------|-------|
| X11 switching stability | #15–17 |
| Full session restore on startup | #24 — `schema/active_session.rs` exists but unwired |
| Docker projects | #38 — one session container per project; see `docs/context/docker_containers.md` |
| Cross-platform Windows/macOS QA | #30/#31 |
| Backend runtime hardening (PTY resurrection, transcript storage) | #32 |
| URI-scheme routing + in-app mail/browser | #33/#61/#65 (gated on CSP restore, Security #1/#2) |
| Per-project security model | #58–60 |
| Right-panel polish | #63–64 |

## Security / hardening backlog (from REVIEW.md)

| Item | Notes |
|------|-------|
| Re-enable a strict CSP (`tauri.conf.json`) | Security #2 |
| Constrain unconfined file commands | Security #1 — now extractable via `commands/fs.rs` |
| Validate Ollama model string into TOML | Security #6 |
| `safe_stem` ASCII-slice panic risk | Security #4 |
