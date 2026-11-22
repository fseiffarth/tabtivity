# Tabtivity Code Review

A three-reviewer review of the Tabtivity codebase (Tauri 2 + React 18 + TypeScript,
Rust backend). The review was conducted by three specialists working in
parallel — **Security**, **Efficiency/Performance**, and **Structure &
Features** — followed by a cross-cutting discussion to reconcile findings that
span more than one lens.

- **Reviewed:** `develop` branch, `src-tauri/src/**` and `src/**`
- **Method:** direct source reading (not inference); findings cite `file:line`.
- **Headline:** the codebase is architecturally sound and well-tested
  (59 frontend test files, 6 Rust integration suites, all automated tests
  passing), but **no feature has been live-QA'd**, and a small number of
  hotspots — chiefly `commands/projects.rs` and broad Zustand subscriptions —
  recur across all three lenses.

---

## Cross-Cutting Discussion

The three reviews independently converged on the same structural pressure
points. These are the highest-leverage items because fixing them improves
security, performance, **and** maintainability at once.

### 1. `commands/projects.rs` is the center of gravity for all three concerns

- **Structure** flagged it as a 1,395-line god module with 29 Tauri commands,
  ~15 of which are file-I/O operations that belong in a dedicated
  `commands/fs.rs`.
- **Security** flagged that the unconfined file commands living in this file —
  `read_file_text` (`:451`), `write_file_text` (`:475`), `read_file_bytes`
  (`:496`), `file_mtime` (`:519`) — bypass the project confinement that the rest
  of the file API enforces, allowing arbitrary local file read/overwrite.
- **Efficiency** flagged that `get_time_today` (`:844`) and `list_dir`'s
  per-file `mime_guess` (`:208`) in this same file are O(n) hot paths.

**Converged recommendation:** extracting the file-I/O commands into
`commands/fs.rs` is not just cosmetic — it creates the natural seam at which to
(a) add the missing path-confinement / write-root restriction (security), and
(b) revisit the per-call deserialization and MIME computation (efficiency).
One refactor, three wins. Carry the inline `#[cfg(test)]` block with it.

### 2. CSP-disabled + unconfined commands form a single exploit chain

Security's two top findings are multiplicative, not additive:
`tauri.conf.json:27` sets `csp: null`, and the IPC surface exposes arbitrary
file read/write (#1 above) plus arbitrary process spawn (`apps.rs`
`run_script_detached`/`launch_app`). The renderers escape correctly *today*, but
CSP is the backstop: any future markdown/highlight escaping regression becomes
full local file + command compromise with no second line of defense. **Re-enable
a strict CSP and constrain the file commands together** — neither alone closes
the chain.

### 3. Broad Zustand subscriptions are both a perf cost and a coupling smell

- **Efficiency** found `TabBar`, `CenterPanel`, and `ProjectSwitcher` subscribe
  to whole store slices (`s.layout`, `s.tabs`, `s.tabsByScope`), causing
  cross-group and cross-scope re-renders, plus per-render `Map`/`flatMap`
  rebuilds.
- **Structure** independently found that `stores/projects.ts` reaches directly
  into `useTabsStore.getState()` inside `setActive`, tightly coupling the two
  largest stores.

These are the same underlying issue viewed from two angles: **subscription
granularity is too coarse**. Introducing per-group / per-scope selectors (e.g. a
`useGroup(groupId)` selector) fixes the re-render storms *and* gives the stores a
cleaner, event-mediated boundary. `stores/drag/drag.ts` is the model to copy — both
reviewers praised it as the example of correctly isolated subscriptions.

### 4. Append-only JSON state files are repeatedly read-modify-rewritten

`time_log.json` is fully deserialized and rewritten on every
`flush_project_secs` (every switch + every 60s tick) and fully re-read on every
`get_time_today` (every pill hover). This is a structural data-model choice
(`schema/time_log.rs` models an unbounded `Vec`) with a performance consequence
that grows with installation age. A rolling daily-summary file resolves both.

---

## Security

Scope: backend command handlers, sshfs/SSH/OpenVPN, the SessionStart hook
injection, PTY handling, Tauri capability/CSP config, frontend markdown/syntax
rendering.

### Strengths

- **Argv-based subprocess invocation throughout.** `ssh.rs`, `ssh_mount.rs`,
  `openvpn.rs`, `tex.rs`, `apps.rs`, `ollama.rs` never build a shell string from
  user input — no `sh -c` with interpolated data. Classic shell-metacharacter
  injection is not possible in the command path.
- **Leading-dash / control-char rejection.** `services/ssh_mount.rs:24`
  `validate_arg` rejects values starting with `-` (blocking
  `-oProxyCommand=…`-style option injection) and any control chars, applied
  consistently with good test coverage.
- **TeX shell-escape defense-in-depth.** `tex.rs:173-186` filters user flags
  mentioning `shell-escape`/`write18`, never enables it, and warns if a system
  config did.
- **Credentials handled carefully.** SSH password goes via the `SSHPASS` env var
  (not argv, so invisible to `ps`); VPN password is written to a `0600` askpass
  file deleted after connect. Frontend never persists either.
- **Path confinement in the project file API** (`enforce_confinement` on
  `list_dir`/`rename_path`/`delete_*`/`create_*`/`write_project_file`); symlinks
  not followed during tree scans; depth-capped.
- **XSS-safe renderers.** `markdown.ts` / `highlight.ts` HTML-escape raw source
  first, emit only fixed tags/classes, allowlist href schemes (`SAFE_HREF`), add
  `rel="noopener noreferrer"`. The `dangerouslySetInnerHTML` sinks in
  `FileViewerPane.tsx` are fed only from these. Regression test confirms
  `<script>` renders as text.
- **SessionStart hook is well-guarded.** No-ops unless `TABTIVITY_TAB_UID` matches
  `[a-zA-Z0-9-]` (`agent_session.rs:100`); `read_live_session_in` rejects
  non-uuid keys; Claude `settings.json` merge is idempotent and preserves
  unrelated keys.

### Findings

| # | Severity | Finding | Location |
|---|----------|---------|----------|
| 1 | **Medium** | Unconfined arbitrary-path file read/write/mtime commands | `commands/projects.rs:451,475,496,519,418` |
| 2 | **Medium** | Content-Security-Policy disabled (`csp: null`) | `tauri.conf.json:27-28` |
| 3 | Low/Info | SessionStart hook silently injected into global agent configs | `services/agent_session.rs:61-208` |
| 4 | Low | `safe_stem` length-slice relies on an ASCII invariant (panic risk) | `services/openvpn.rs:127-139` |
| 5 | Low (by design) | `run_script_detached`/`launch_app`/`open_file` run arbitrary executables | `commands/apps.rs:312,124,237` |
| 6 | Low | Ollama model string interpolated into TOML without validation | `commands/ollama.rs:558-643` |

**#1 — Unconfined file commands (Medium).** Unlike the rest of the file API,
these take an absolute path with no project confinement. Any code reaching the
IPC bridge (an XSS, a malicious file-link, a compromised renderer dependency) can
read/overwrite any user-accessible file (`~/.ssh/id_rsa`, `~/.aws/credentials`).
`write_file_text` can overwrite any existing regular file. *Recommendation:*
restrict writes to known roots (project dirs, `~/tabtivity`, mounts dir) or require
the path to have been surfaced by a prior `list_dir`; at minimum refuse secret
dotfiles outside project roots; and re-enable CSP (#2).

**#2 — CSP disabled (Medium).** With `csp: null` Tauri injects no CSP, so the
webview rendering untrusted file content has unmitigated access to the powerful
IPC surface. *Recommendation:* set an explicit restrictive policy, e.g.
`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; connect-src 'self' ipc: http://ipc.localhost`.

**#3 — Global hook injection (Low/Info).** Tabtivity writes a SessionStart hook into
`~/.claude/settings.json` and `~/.codex/config.toml` on every startup, so every
Claude/Codex session anywhere runs Tabtivity's script. The script is benign and
no-ops without `TABTIVITY_TAB_UID`; this is a transparency/trust concern, not
escalation. *Recommendation:* document it prominently; ensure `hooks/` dir +
script have restrictive perms so another local user can't pre-create/replace it.

**#4–#6** as tabled above — minor; #4 and #6 are unvalidated-input-into-string
patterns (slice on `chars()` not bytes; reject TOML-significant chars in model
names), #5 is intended behavior whose blast radius is governed by #2.

**Verified non-issues:** mountpoints derive from server-generated UUIDs (not
traversal-controlled); `ssh_list_dir` passes path after `--`; Ollama HTTP is
`127.0.0.1`-only. Note: the custom `uuid_v4()` (`projects.rs:1089`) is
time-based, **not** cryptographically random — fine for local ids, never to be
used as an unguessable secret.

**Top priority:** re-enable a strict CSP (#2) and constrain the unconfined file
commands (#1) — together they are the most realistic path from content-injection
to local compromise.

---

## Efficiency & Performance

### Strengths

- **Drag store isolation** (`stores/drag/drag.ts`): per-frame pointermove updates a
  separate store with coarse primitive selectors, so the tab tree doesn't
  re-render during drags. The reference example for the whole frontend.
- **Pane persistence across scope switches** (`CenterPanel`): all panes stay
  mounted, hidden via `display:none`, so PTY streams survive project switches.
- **`setGroupRects` equality guard** (`CenterPanel.tsx:234-248`): field-by-field
  comparison before `setState`.
- **project-runtime switch off the UI thread** (`services/project_runtime.rs`):
  worker thread + event emit, so `setActive` doesn't block on file I/O.
- **Activity store outside React** (`lastOutputByPty`): the 60+ msg/s PTY stream
  never triggers React renders directly.

### Findings

| # | Impact | Finding | Location |
|---|--------|---------|----------|
| 1 | **High** | `JSON.stringify` diff of full file listing on every fs-change tick | `files/FileTree.tsx:292-300` |
| 2 | **High** | `get_time_today` deserializes the entire growing time log per call | `commands/projects.rs:844-858` |
| 3 | High | `TabBar` subscribes to whole `layout`+`tabs`; re-renders on any tab change anywhere | `tabs/TabBar.tsx:72-74` |
| 4 | Medium | `TabBar` rebuilds a `Map` of all tabs every render (no `useMemo`) | `tabs/TabBar.tsx:113` |
| 5 | High (deep trees) | `writeScope` runs 4–5 separate tree walks per mutation | `stores/tabs.ts:552-601` |
| 6 | High (if polled) | `sysstat::descendant_pids` walks all of `/proc` per CPU sample | `sysstat.rs:30-70` |
| 7 | High | `CenterPanel` subscribes to `tabsByScope` (all scopes); rebuilds maps inline | `CenterPanel.tsx:87,94,462-471` |
| 8 | Medium | `embed_capability` checks fire sequentially per extension | `files/FileTree.tsx:178-201` |
| 9 | Medium | `refreshGit` fires 3 git subprocesses as separate chains (no `Promise.all`/debounce) | `layout/RightPanel.tsx:157-167` |
| 10 | Low–Med | `TerminalView` builds `new TextEncoder()` + `Array.from` per keystroke | `terminal/TerminalView.tsx:197-198,242` |
| 11 | Low–Med | `ProjectSwitcher` memo chain re-runs on unrelated `projects` changes | `ProjectSwitcher.tsx:234-268` |
| 12 | Medium | `flush_project_secs` rewrites entire `time_log.json` per flush | `services/project_runtime.rs:306-321` |
| 13 | Low | `setActive` walks the layout tree multiple times | `stores/projects.ts:152-181` |
| 14 | Low | `DragGhost` subscribes to whole `drag` object (per-frame re-render) | `CenterPanel.tsx:635-644` |
| 15 | Low | `list_dir` computes MIME for every file even when unused | `commands/projects.rs:208-212` |

**Quick wins (easy + meaningful):** #1 (structural compare instead of double
`JSON.stringify`), #4 (`useMemo` the tab map), #8 (`Promise.all` the embed
checks), #9 (`Promise.all` + debounce git), #10 (hoist the encoder, pass
`Uint8Array` directly), #14 (fine-grained `DragGhost` selectors).

**Larger structural fixes:** #2/#12 (rolling daily time-summary file), #3/#7
(per-group/per-scope selectors), #5 (single-pass collapse+prune), #6 (cache
descendant pid set, invalidate on PTY spawn/death).

**Suggested measurements before optimizing:** `FileTree.refresh()` stringify cost
under active agent writing; `get_time_today` after months of use;
`descendant_pids` with ~300 `/proc` entries; `CenterPanel` render count per
pointermove via the React Profiler; `writeScope` traversal count per keystroke.

---

## Structure

The Tauri 2 / React 18 split is well respected: Rust in `src-tauri/src/`,
TypeScript in `src/`, bridged cleanly via `invoke` + `emit`/`listen`. No Rust
logic leaks into the frontend and no frontend logic is duplicated on the backend.

**Backend layering** (commands → services → platform) holds well. `services/`
functions don't take `AppHandle`, so they stay unit-testable.
`platform::WorkspaceBackend` (trait + `detect_backend()` factory) is a clean
strategy pattern. **Frontend** is organized into `components/` (8 subdirs, ~45
files), 13 Zustand stores, `hooks/`, `lib/`, `types/`, with 59 Vitest suites.

### Issues

1. **`commands/projects.rs` is a god module** (1,395 lines, 29 commands). Extract
   the ~15 file-I/O commands into `commands/fs.rs` (matches existing
   `commands/fs_watch.rs` naming and the `// File tree` registration grouping in
   `lib.rs`); carry their 300-line inline test block along. → see Cross-Cutting #1.
2. **CLAUDE.md file map is badly out of date** — lists 15 frontend / 8 backend
   files; reality is ~45 frontend component files and 51 backend source files.
   Unlisted-but-important: `components/header/*` (6 files), `DetachedApp.tsx`,
   `GlobalAppMenu.tsx`, `BoxPill.tsx`, 9 of 13 stores (`detached`, `drag`,
   `boxes`, `activity`, `linkRouting`, `pdfSync`, …), `crashReporter.ts`,
   `lib/shortcuts/shortcuts.ts`; backend `commands/{boxes,crash,debug,downloads,github,
   openvpn,subwindow}.rs`, `services/{agent_session,openvpn,remote_agents,
   restore_service,ssh_exec}.rs`. Real onboarding friction.
3. **`stores/projects.ts` couples switching to tab/timer/VPN state** via direct
   `useTabsStore.getState()` calls inside `setActive`. Works (snapshot, not
   subscription, so no render loop) but fragile to store init ordering. Prefer an
   event/signal or a single `useProjectSwitch` hook. → see Cross-Cutting #3.
4. **`schema/active_session.rs` is defined but never written or read** (TODO
   Group F #24). Add a `// TODO #24: not yet wired up` doc comment so the schema
   reads honestly.
5. **`terminal/mod.rs` is a 737-line flat singleton** mixing PTY lifecycle with
   agent-session resolution (`resolve_claude_session`/`resolve_codex_session`),
   while `agent_session.rs` (the hook installer) lives in `services/`. Move the
   resolvers into `services/agent_session.rs` to consolidate session logic.
6. **`lib.rs` registers all 60+ commands in one `generate_handler!` block.** Keep
   the comment groupings strictly aligned with actual command modules (today the
   `// File tree` group points at `projects.rs`, not a `file_tree.rs`).
7. **`docs/Features.md` describes the deleted Python app** (`app/*.py`,
   `tests/`, `plan_*.md`). Update or delete.
8. **Spawn-path asymmetry:** ssh goes `commands/ssh.rs → services/ssh_mount.rs`,
   but terminal goes `commands/terminal.rs → terminal/mod.rs` directly, bypassing
   the `services/` layer (a `services/terminal_service.rs` exists only for
   save/restore). Minor inconsistency.
9. **Test layout:** Rust tests split between inline `#[cfg(test)]` blocks and
   `src-tauri/tests/` (6 files); the inline block in `projects.rs` adds to its
   bulk (resolved naturally by issue #1). Frontend tests are well organized and
   extensive (~11,000 lines). The one gap: **0 manual-QA items checked.**
10. **`ProjectSwitcher.tsx` is 2,209 lines** — the largest frontend
    single-responsibility violation. It bundles the add/import dialog (with SSH +
    OpenVPN + Docker sub-flows), the global settings panel, project search, and
    the pill bar. Extract `ProjectDialog.tsx`, `SettingsPanel.tsx`, and
    optionally `ProjectSearch.tsx` — each lands under ~600 lines and becomes
    independently testable.
11. **`components/files/` mixes components with pure logic** (`fileUtils.ts`,
    `markdown.ts`, `highlight.ts`, `tex.ts`). Project convention is `src/lib/`
    for pure logic — move them to `src/lib/` (or `src/lib/viewers/`).

---

## Features & Roadmap

Tabtivity tracks features on three axes: **written**, **automated test passing
(🤖)**, **live QA done (🖐️)**. Per TODO.md's self-assessment, **all automated
tests pass but no feature has been live-QA'd** — the dominant gap between
"code-complete" and "shipped."

### Implemented (code-complete, automated tests passing)

Root + per-project PTY terminals; project switcher (search, DnD reorder, CRUD);
file-tree overlay with git status markers, git history/commit/push, GitHub
publishing; per-project time tracking + activity calendar; per-project CPU
display; X11 workspace switching; KDE Wayland backend (**stub** — show/hide are
no-ops) and Windows backend (**stub**); app launching + external window tracking;
global app bar; default apps per project/type; per-project download routing;
in-app viewers (PDF, image, markdown, code via highlight.js, TeX with bidirectional
SyncTeX); tiling subwindows (split/group tree, DnD split/reorder); subwindow
detach to standalone OS window (#42); **agent session resume for Claude + Codex**
(#39a–c); **SSH remote projects** (#28/#28b: sshfs mount, remote PTY via `ssh -tt`,
ControlMaster, remote agent bootstrap, OpenVPN tunnels); **project boxes**
meta-grouping (#13/#41 ph.1–2); README default tab; tab inline rename + scope
binding; keyboard shortcuts; autosave/font-size/per-type viewer prefs; viewer
link routing; WebKitGTK crash reporter; Ollama local model management + local
autocomplete; filesystem watch.

### In-progress / partially implemented

- **SSH hardening (#28c)** — several open items, two **Critical**:
  (a) remote command injection in `ssh_list_dir`/`ssh_default_dir` (remote dir
  names with `;`/`$()` not individually quoted); (b) remote agent resume ordering
  bug — `wrap_pty_options` rewrites cmd to `ssh` *before* `resolve_agent_session`
  runs, so `--resume` is never injected for remote tabs. Plus High items: TOCTOU
  in `mount()`, raw env-key interpolation in `remote_command`, non-centralized
  VPN-gated activation, password-auth half-state (`BatchMode=yes` vs `sshpass`),
  no connection-loss/stale-handle recovery.
- **Agent resume generalization (#39d):** Gemini (`--session-file` path
  identified, not implemented) and Vibe (no launch-id control) still dropped.
- **Boxes phase 3–4 (#41):** multi-root merged file tree + agent-hint relation
  graph deferred.
- **KDE Wayland (#18):** show/hide are explicit no-ops pending KWin scripting.
- **Git worktrees (#23):** phases 0–2 of `docs/worktree_improvement_plan.md`
  shipped (blocking defects, the data-loss set, locality + containment); the
  product rungs — worktree-aware tab groups, worktree-as-project,
  agent-per-branch — are phases 3–4 and deferred. Untested in the running app.

### Open / not started

X11 switching stability (#15–17); **full session restore on
startup (#24)** — `active_session.rs` exists but is unwired; **Docker projects
(#38)** — full plan in `docs/docker_projects_plan.md`, no runtime yet;
cross-platform Windows/macOS QA (#30/#31); backend runtime hardening (#32, PTY
resurrection / transcript storage); URI-scheme routing + in-app mail/browser
(#33/#61/#65); per-project security model (#58–60); right-panel polish (#63–64).

**Note for #65 / in-app browser:** an in-app browser materially widens the
attack surface and interacts directly with Security #1/#2 — it should not ship
until CSP is restored and the file-command surface is constrained.

---

## Converged Priority List

Ordered by leverage (impact × number of lenses improved):

1. **Re-enable a strict CSP** (`tauri.conf.json`) **and constrain the unconfined
   file commands** (`projects.rs`). *Security #1+#2 — the one real exploit
   chain.*
2. **Fix the SSH-hardening Criticals (#28c):** remote command injection in
   `ssh_list_dir`/`ssh_default_dir`, and the remote agent-resume ordering bug.
   *Already tracked; both Critical.*
3. **Extract `commands/fs.rs` from `projects.rs`.** *Structure #1 — the seam that
   enables Security #1 and Efficiency #2/#15 fixes.*
4. **Adopt fine-grained store selectors** (`useGroup`, per-scope, `shallow`) for
   `TabBar`/`CenterPanel`/`DragGhost`/`ProjectSwitcher`. *Efficiency #3/#4/#7/#14
   + Structure #3 coupling.*
5. **Move time tracking to a rolling daily-summary file.** *Efficiency #2/#12.*
6. **Quick frontend wins:** structural compare in `FileTree.refresh` (#1),
   `Promise.all` embed checks (#8) and git refresh (#9), hoist `TextEncoder`
   /pass `Uint8Array` (#10).
7. **Cache `descendant_pids`, invalidate on PTY spawn/death.** *Efficiency #6.*
8. **Refactor `ProjectSwitcher.tsx`** into dialog/settings/search components.
   *Structure #10.*
9. **Documentation hygiene:** update CLAUDE.md's file map (#2); update/delete
   `docs/Features.md` (#7); annotate the unwired `active_session.rs` (#4).
10. **Run live QA.** No feature has been manually verified; this is the single
    biggest gap between the current state and a shippable build.
