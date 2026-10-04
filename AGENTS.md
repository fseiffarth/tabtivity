# Tabtivity — Agents

Canonical instructions for every AI coding agent here; `CLAUDE.md` and
`GEMINI.md` `@import` this file. Write guidance **here**. Keep it to rules an
agent would otherwise get wrong — no overviews, no history (that goes in
`docs/context/`). Tabtivity is a Tauri 2 + React/TS desktop workspace (`src/`
frontend, `src-tauri/` Rust backend, `mobile-web/` phone PWA).

## Running

- **Never start or stop Tabtivity** — no launcher script, `tauri:dev`, or
  `package:dev` launch, not even "to check one thing"; a running window holds
  the user's live tabs. To verify live, give the user exact steps to click
  through; otherwise report the gates and say plainly it was not run live.
- `src/` hot-reloads into the running window. `src-tauri/` does not, by design
  (`--no-watch`): after backend edits run **`npm run backend:stale`** and
  report its result. Never restart the app to apply them.
- The phone PWA is baked into the binary; `npm run mobile:bundle` rebuilds it.
  A mobile feature whose backend half isn't in the running window will render
  and then fail — `backend:stale` says so.
- Each commit queues a background frozen dev build (`post-commit` hook); leave
  it alone. `scripts/package-dev-auto.sh --status` reports it. Mechanics:
  `docs/context/dev_builds.md`.

## Gates

Run before calling work done; all are CI gates and all sit at zero warnings:

```
npm run build        # the ONLY type-check (tsc + both bundles); vitest/eslint don't type-check
npm test
cargo test --manifest-path src-tauri/Cargo.toml
npm run lint
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
scripts/brand-check.sh   # the app's name is spelled only in the brand modules
```

CI clippy is latest stable; a stale local toolchain can pass what CI fails.
`cargo fmt` is not enforced. Without the RTK hook, keep output short:
`cargo test -q`, `npm test -- --reporter=dot`, `npm run build 2>&1 | tail -40`. `git diff --check` for whitespace. If a gate's
tool is unavailable, say so — never skip silently.

## Git & privacy (public repo)

- Work on `develop`; `main` is reached by PR.
- Before any push: `scripts/privacy-check.sh` must pass (the pre-commit and
  pre-push hooks and CI run it; hooks need `git config core.hooksPath
  .githooks` once per clone). A plumbing commit (private index + `update-ref`)
  skips pre-commit: run `GIT_INDEX_FILE=<yours> git hook run pre-commit` first.
  Never hardcode institution/lab hostnames. Author email must be the GitHub
  `noreply` one. New/changed binaries need their blob id in
  `scripts/privacy-reviewed-binaries.txt`. Private literals that must never
  ship go in the untracked `.git/info/privacy-denylist`.
- Pushes auto-bump the patch version; don't bump by hand.
- Don't rewrite unrelated docs, generated state, `dist/`, `target/`, or backups.

## Where to look

- File maps: `docs/filemap_frontend.md`, `docs/filemap_backend.md` — **grep
  them for the file you're touching; never read them whole.** Adding or
  reshaping a load-bearing file? Update its row, one line. Never add a nested
  `CLAUDE.md`/`AGENTS.md`: agents auto-load those. Why a file is the way it
  is: grep `docs/filemap_rationale/` (frozen, verify against code).
- Design rationale, one file per subsystem in `docs/context/` — open only the
  one you're touching: agent_authority, agent_schedule_mcp, agent_sessions,
  brand_migration, caldav, dev_builds, docker_containers, git_push_mcp, git_sync, help_mcp, hpc_careful_mode, mail_encryption,
  markup_mcp, mobile_access, multi_host_remote, openvpn, project_boxes, project_transfer,
  release_signing, remote_autoconnect, remote_credentials, remote_projects, root_console,
  tmux_sessions, usage_stats, vm_projects.
- Before touching byte-sync or git lockstep: `docs/remote_sync_guide.md`.
- Updating a wrapped third-party tool: `docs/third_party_update_checklist.md`.
- New TODOs go in the matching `todo/<group>.md`. A 🖐️ manual box gets a
  `✅ Works on <P>` / `❌ Doesn't work on <P>` child pair for each platform P —
  `Linux (X11)`, `Linux (Wayland)`, `Windows`, `macOS`; tick only where checked.
- `todo/*.md`, `DOCUMENTATION.md` and `README.md` run 50–160 KB each: find the
  spot with `rg -n`, then read or edit only that range. Never read one whole.

## Conventions

- Match surrounding style; small focused changes; `rg` for search.
- Never spell the app's name in code. Rust: `crate::brand` constants and
  `app_name!`/`app_slug!` macros; TS (desktop and phone): `src/lib/brand.ts`
  (`BRAND`, `NAMES`, `storageKey`, …); dictionaries: `{app}`/`{slug}`; shell:
  source `scripts/lib/brand.sh`. Comments and docs may name it — the current
  name only; the old one (Eldrun) belongs to history prose and `LEGACY_*`.
  Something an older build may have written under the old name is looked up
  through `brand::PAIR.legacy(Name::…)` and counted with `brand::legacy_hit`;
  nothing is ever *written* under it.
- All user-facing strings via `src/lib/i18n.ts` (`useT()`); English holds
  every key. Never hardcode display text.
- Tag new, not-live-verified features with the `UntestedTag` pill, and give it
  a row in the register (`src/lib/untested.ts`) — pills carry its id, menu-entry
  data carries it as `untested: "<id>"`. Clear one only when the user says that
  item is tested: `npm run untested -- tested <id-or-prefix>` stamps the row and
  the pills stop rendering; `-- sweep` later deletes the markup. `-- list` shows
  what is still tagged and where.
- Prefer local state and existing Zustand stores over new global state.
- Tauri command payloads use the frontend's camelCase keys.
- Keep `services/` modules `AppHandle`-free and unit-testable.
- Persisted JSON must round-trip existing user state (Python-era shapes too).
- Install flows are one-click open-a-tab-and-run, never copy-it-yourself.
- Box agent docs: edit only outside the
  `<!-- tabtivity:box-links:start/end -->` generated blocks.
- Tabtivity never edits another app's paths or config. (The agent-session hooks
  go into Tabtivity's own agent homes, so they are no longer an exception.)

## Invariants

Security / data loss:
- Anything inside a project folder is attacker-controlled. Session state
  (tabs, `open_apps`) lives in `<state_dir>/sessions/<id>/`; `open_apps` is
  never adopted from a project folder.
- Passwords are never persisted by default (opt-in → OS keychain, keyed by
  host/config target, not project id).
- Remote/VPN auto-connect must never prompt; never `pkexec` a connect that
  can't succeed silently.
- Destructive background git/sync moves record through `services::local_loss`.
- Local git verbs that can run repo-configured programs (status, diff, add,
  commit, checkout, merge, push, …) never run bare: use
  `commands::git::hardened_git_command_in` (the `hookless_` variant for
  background work). Project code Tabtivity runs on the
  host (git hooks, `latexmkrc`, a project's prettier) is gated by
  `services::exec_trust`; what runs or where comes from `projects.json`, never
  the in-folder `project.json`.
- `services::agent_fence` fails closed: missing/unusable bubblewrap never
  falls back to launching unfenced. The fence is the only mode (no per-project
  or global "off"); the one unfenced local agent is the root console's explicit
  Host session (`PtyOptions.host_session`, its own `agent-homes/host`). A CLI
  typed into a shell tab runs through the `agent_bin` shim, fenced.
- Agents live only in Tabtivity: every local agent tab's `$HOME` is its scope's
  `<state_dir>/agent-homes/<key>` (`services::agent_home`), never the user's.
  Logins are shared per CLI through `services::agent_auth` (credential files
  only, copied into every home and kept in step); config, skills, hooks and MCP entries
  are per scope. What the user wants everywhere lives in the Tabtivity-wide layer
  `<state_dir>/agent-global` (`services::agent_global`), copied/merged into
  each home at every spawn and never mounted into a fence — no agent may be
  able to write it. Tabtivity registers its session hooks in those homes, not in
  the user's own CLI config.
- `services::mobile_control`: raw project ids, paths, commands, tmux targets
  never cross the browser API.
- Terminal `kill`/`kill_all` reap the whole child subtree.

Remote & sync:
- Remoteness is explicit (`remote_target_for{,_dir}` and host-aware variants);
  never infer it from paths. `services::remote` is the source of truth.
- `worker_sync` is push-only, tracked files only — never `git clean`.
- Lockstep (`git_peer`) owns tracked files, byte-sync owns the rest; keep the
  `drop_tracked` split. A tracked edit reaches the peer only once committed —
  don't "fix" that into continuous mirroring.
- Byte-sync is opt-in per path and ignores `.gitignore`; preview before
  pulling big trees.
- OpenVPN is machine-wide; `VpnIndicator` owns it — no project-scoped UI.
- Containers: one session container per local project, project mounted at the
  same absolute path; `services::sandbox` owns lifecycle.
- `hpc_hosts` gates background behaviour and outranks `careful_hosts`.

Agents:
- An agent's permission mode is its own CLI's. Tabtivity injects no mode flag and
  has no mode toggle; `agent_session` only re-applies the mode Claude's hook
  recorded on `--resume`. Don't grow that into a mode Tabtivity chooses. (The
  Manage CLIs Codex auto-review switch only edits the user's own Codex config
  in the Tabtivity-wide layer; it is off unless the user turns it on.)

Frontend:
- Gate remote/SFTP/git probes on connected — a sync command against a dead
  session can freeze the window.
- Gate work in hidden panes (`PaneVisibleContext`) and catch up on show.
- Never animate a blurred `box-shadow` (WebKitGTK software path); use a static
  shadow pseudo-element and animate opacity.
- Viewer features go in the shared `ProjectFilesView`, not one host.
- YAML/table viewers edit surgically: comments, quoting, line endings survive.
- Never render a missing sensor reading as zero; omit it.
- Python interpreter precedence comes from the backend; don't re-rank.
- Experimental features use `useExperimental`.
- Menus/dialogs use the one shared scheme; portaled dialogs set an explicit
  `color` (`body` has none → black text).
- To show the user a file on their phone: `tabtivity-send <file>`.
