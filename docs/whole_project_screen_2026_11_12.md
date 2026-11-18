# Whole-project screen — 2026-11-12

Ten parallel read-only auditors, one per slice (agents; remote & sync; git/fs/
trust; phone API + PWA; server crates; MCP/mail/calendar; backend runtime;
frontend lib/stores; frontend components/CSS; tooling/CI/docs), run against
develop `214933ab5` **plus the uncommitted working tree** of that morning
(~146 paths from other sessions). Nothing was built, run or edited. The
coordinating session re-read the nine items marked ✔ below against the
source and they hold; the rest are the auditors' reading, unreproduced. Line
numbers are as of that tree; verify before fixing. Per-slice reports (ignored,
local only): `tmp/screen-2026-11-12/01…10-*.md`.

## Verdict

Critical: 0. High: 13. The hardening that exists is mostly sound — terminal
reaping, git hardening, the phone API's Origin checks (all 70 mutating
routes), gateway auth, generated command classes (785 rows, in step), sandboxed
mail/HTML iframes, print/markup/mail approval gates, release workflow pinning.
The problems sit at the **edges of those gates**: (a) two fence escapes through
spawn flags and scope-key collisions, (b) untrusted inputs (bundles, repo
config, box folders, `.ics`, server payloads) reaching host-side writes or
signatures without the guard their siblings use, (c) silent data loss in
editors and sync, and (d) CI/hooks that don't cover themselves.

## High — fix first

Fence / agent isolation
1. ✔ `src-tauri/src/services/sandbox.rs:704` + `agent/agent_fence.rs:222` + `launch_prep.rs:1288,1497` — a spawn with `sandbox:true, localOnly:true` and no project keeps the renderer's flags (`enforce_spawn_authority` returns early without a project), skips both docker and ssh wraps, `decide` answers `NotApplicable{"container"}`, and `_ => {}` lets the agent run **unfenced with the real `$HOME`**. Fix: force `sandbox=false` when there is no project; make any unhandled `NotApplicable` for a local agent an error.
2. ✔ `agent/agent_home.rs:64,95` — `scope_home_in(_, "host")` *is* `host_home_in(_)`; `storage::is_reserved_scope` (`storage.rs:685`) reserves only root/assistant, and bundle import keeps the bundle's id (`commands/project_transfer.rs:2671-2678`). A project id `host` shares the unfenced Host session's home → its fenced agent plants hooks the next Host session runs. The test at `agent_home.rs:788` compares against `host/x` and can't catch it. Also `box_x` vs `box:x` fold together. Fix: reserve `host` in `is_reserved_scope`; separate key namespaces.

Untrusted input → host
3. ✔ `commands/project_transfer.rs:2499-2508` — bundle extraction creates symlinks in archive order by path; an earlier link (`dir/a -> ~/.config/autostart`) lets a later link land outside the import folder → code at next login. Create links via no-follow dir handles (as `tree_copy`) or refuse a linked ancestor.
4. `commands/git_pull.rs:219-234` — `fetch_local` honours repo `core.sshCommand`, `credential.helper`, `uploadpack`, `insteadOf` with no `exec_trust` gate; Fetch on a downloaded/imported repo runs its program on the host.
5. `commands/boxes.rs:304-316` — box agent docs (`CLAUDE.md`/`AGENTS.md`/`GEMINI.md`) written with plain `fs::write` in a folder every member's fenced agent can write → a planted symlink makes Tabtivity append to `~/.gitconfig`, `~/.ssh/config`. Use `write_no_follow` + regular-file check.
6. ✔ `services/remote/ssh_common.rs:1818-1845` — `ssh_trust_host_key` (class `Core`) appends caller-supplied text to the user's real `~/.ssh/known_hosts`; nothing ties it to the scanned key. `@cert-authority *` / `* <key>` lines impersonate every host. Re-scan server-side and write only the key the user saw (and reconsider writing another app's config at all).
7. ✔ (mechanism) `mobile-web/src/auth.ts:45-52` — the PWA signs whatever `payload` the challenge returns. A compromised gateway can have it sign a secrets *enrol* / signed-*action* payload and enrol its own key (hosted mode). Build the login payload on the phone from nonce + expiry, as `secretsCore.actionPayload` does.
8. ✔ (missing gate; plugin load not tested live) `commands/python.rs:182-197,228` — interpreter discovery runs `poetry env info -p` on the host with the untrusted project as cwd, no `exec_trust`. Poetry 2 can load project-named plugins.
9. ✔ `services/tmux_local.rs:706,749` — `kill-session`/`rename-session -t <name>` without `=` exact-match: killing exited `train` kills live `train-2`. `local_tmux_kill` (Core) also skips the name check its siblings do, so a client can pass `*`/`$0`.

Data loss
10. ✔ `src/components/embed/draftSaver.ts:60-63` + `src/lib/remote/closeRemoteTab.ts:131-149` — closing a file tab with autosave off drops unsaved edits; `closeTabWithConfirm` confirms nothing.
11. `services/remote/worker_sync.rs:488-506` — a newer commit or forced "Sync code now" during a running sync to the same worker returns ok/skipped; the worker stays behind until the next commit.

Tooling / release
12. ✔ `.githooks/pre-push:156,309,330` — any `refs/heads/*` push is "bumpable", and the bump commits onto and re-pushes the *checked-out* `HEAD`: `git push origin feature` from `develop` bumps and pushes develop, then aborts the feature push.
13. `.github/workflows/release.yml` — waits only on `ci-cd.yml`; cargo-audit, cargo-deny, npm audit and CodeQL (`security.yml`) gate nothing, so a fresh advisory can be signed and shipped via the updater.

User decision (not a code fix): 19 published commits on public `main` (GitHub web-UI merges, 2026-06-24 → 09-29) carry a personal, non-noreply author email; `privacy-check.sh` only scans pushed ranges so never sees them. Accept and record in `docs/threat_model.md`, or rewrite `main` (breaks clones and tags).

## Medium — worth a batch each

Agents
- `commands/agents.rs:884,950` — scheduled warm-up runs agent CLIs unfenced with a caller-chosen prompt (≤200 chars); some CLIs auto-approve tools there. Contradicts "Host session is the only unfenced agent"; undocumented in agent_authority.
- `agent_shim.rs:52,74` + `agent_privacy.rs:876-885` — shell-tab shim passes the shell's env through; a `LOCAL_MODELS_ONLY` stamp exported in the shell lets a cloud CLI into a local-models-only project. Strip control vars in the shim.
- AI switch (`agent_fence`) and HPC dial gate (`services/hpc_mode.rs:92-125`) both **fail open** on unreadable `settings.json` with a cold cache.

Remote & sync (no `local_loss` record in any of these)
- `commands/sync.rs:1300-1311` — apply-delete on host side deletes a host file rewritten since the base.
- `services/remote/sync_auto.rs:739-770`, `remote_sync.rs:1050-1080` — auto-pull checks the mirror once before the SFTP read; a save during the pull is overwritten and the row turns green.
- Worker apply script runs unhardened `git` on the worker; fan-out runs inside the lockstep loop and blocks it for a whole upload.

Git / fs
- `project_transfer.rs:2747-2750` — remote-project import adopts every file in the bundle's `state/` (export allows only `project.json`): seeds `sync.json`, `git_peer.json`, `local_loss.json`.
- `commands/exec_trust.rs:8` — `exec_trust_approve` is sync and spawns git twice on the window thread (the source-scan test misses indirect spawns).
- Box CRUD (`delete_box`, `set_box_members`, …) read-modify-writes `boxes.json` outside the lock; `set_box_members` skips the reserved-scope filter.
- `set_project_git_disabled` deletes `.gitignore` together with `.git`.

Runtime
- `commands/apps.rs:768` — `run_script_detached` runs on the host even for container projects, and the child is untracked → outlives a clean quit.
- `commands/ollama.rs:2728` / `ollama_client.rs:803` — owned `ollama serve` recorded by bare pid; quit-time reap can kill a recycled pid's tree.
- `sandbox::up` holds the global container lock across an untimed `docker build` (can hang quit); VM teardown at quit is serial (~22 s each).
- Ollama/Vibe installers run headless (breaks "install = open a tab and run") and aren't stopped at quit.

Calendar / mail / MCP
- `calendar_recurrence.rs:387-389,264-269` — crafted `FREQ=YEARLY;INTERVAL=4294967295;…` wraps the year; phone month view (`headless.rs:182`) loops ~2e9 times. `ics.ts:246` caps nothing.
- `browser_engine::fetch_ics` (`:969`) ignores the 5 MiB truncation flag; `calendar_replace_events` then drops every event after the cut.
- `caldav.rs:599-603` buffers the whole body before the 32 MiB check at `:793`.
- `commands/calendar.rs:46-104` — `calendar_read_ics`/`calendar_write_ics` are Core with raw paths (extension check only, write follows symlinks); mail already moved to pick grants.
- Root MCP `repeat` bounds advertised, not enforced (truncated by cast).

Server / phone
- `src-gateway/src/server.rs:984-997` — unauthenticated `GET /content/<name>/…` wakes an idle account daemon (breaks "pair never starts an idle daemon"), no rate limit, account-existence oracle.
- Todo board lists every registered project to every phone (`MobileBridgeHost.tsx:1801-1810`, `headless.rs:134-156`, `headless_board.rs:103-105`), ignoring mobile opt-in and per-phone scope.

Frontend
- `editableFile.tsx:249-258` — autosave (400 ms) writes without an mtime check; the outside-change poll is 1.5 s, so an agent's write is silently replaced.
- `TerminalLimitHandoff.tsx:60-96` — "switch CLI?" marked handled when shown, vanishes after one tab switch.
- `src/web/WebShell.tsx:50-89` — one pending-dialog slot; a second request orphans the first promise.
- `stores/calendar/alarms.ts:204,225,251` — snooze/dismiss during the claim round trip is undone.
- `stores/settings.ts:679-701` — nested-map writers (`python_run_args`, `python_main_scripts`) drop concurrent entries; `stores/remote/sync.ts:503` refresh has no ordering guard.

Docs / CI
- Two file-map rows point at missing files: `docs/filemap_frontend.md:536` (`brand.rs` lives in `src-core/src/`), `docs/filemap_backend.md:345` (`screenshot.rs`, deleted in `4e80dec7d`). The other ~1,350 paths resolve.
- `scripts/test_gate_job.py`, `test_fresh_vm.py` run nowhere; `scripts/lib/changed.sh:46` treats `scripts/`, `.github/`, `.githooks/` edits as cheap; no shellcheck/actionlint over ~45 scripts. `privacy-check.sh:463` excludes itself.
- The uncommitted AGENTS.md edit names `scripts/gates-job.sh`, which is untracked: land them together.

## Low — see per-slice files

AGENTS.md invariant breaks: `read_json(..).unwrap_or_default()` + write in `local_loss.rs:107`, `calendar_alarms.rs:126-158` and the worker record; missing readings as 0 in `remote_usage.rs:376` (`[N/A]` GPU) and `SystemMonitorPane.tsx:346` (**open since 10-15**); hardcoded English in `DetachedCenterPanel.tsx:1707-1708`, `TexView.tsx:1130`, the Mermaid error, `web_client.rs` login pages (one interpolates `{error}` unescaped); `Typewriter.tsx:42-54` animates under `[data-software-paint]`; `list_local_drivers` has no `MODEL_ARG` row; `global_inbox_open` sync + `opener::open`. Others: `percent_decode` panics on `%` + non-ASCII (`web_client.rs:1474`, one of three diverging copies); daemon trusts its own uid when `GATEWAY_UID` is unset; `env::remove_var` inside the tokio runtime (`host.rs:8926`); gateway `flock` on async workers; sign-in callback relays to any loopback port ≥1024 (`sign_in.rs:43-89`); `slurm_submit` passes `-`-leading names as options; `VIBE_HOME` from env picks the rw mount; multi-pane tmux reported ended after one pane; macOS fence skips the shared-project review gate; zip extraction without size/entry budget (**open since 10-15**); `extract_archive` TOCTOU; print claim releasable by another window; `voiceProbe.tsx` dev page shipped; Upload-here has no total quota; listener leaks in `pdfSync.ts:216-245`, `pdfDrag.ts`; `listenSyncProgress` caches a rejection; `useVoiceNav.ts:194` leaks a quiet-wait; unpinned `curl | sh` in `server-vm.sh:160` and the sandbox Dockerfile (**open since 10-15**); Windows/macOS clippy `continue-on-error`; stale comments (`root_mcp.rs:23-26` says agents run unfenced).

## Systemic patterns

1. **Fail-open defaults when settings can't be read** — AI switch, HPC dial gate. Every gate reading `settings.json` should pick its safe side on error and be tested for it.
2. **Sibling guard not applied** — `write_no_follow` (boxes), pick grants (calendar vs mail), `=` prefix (tmux kill/rename vs capture), `exec_trust` (fetch, poetry vs hooked verbs), `is_reserved_scope` (`host`, `set_box_members`). When a guard is added, `rg` its siblings.
3. **Untrusted archives** — bundle links, `state/` adoption, zip budgets, extract TOCTOU: import needs one hardened extractor.
4. **Check-then-act without recheck** — auto-pull, apply-delete, autosave, worker fan-out, alarms, box CRUD: compare-and-swap or recheck before the write.
5. **Spawns outside the quit teardown** — detached scripts, installers, bare-pid ollama.
6. **Tests for the tooling itself** — hooks, gate scripts, release ordering run untested; the pre-push bug would ship silently.

## Not covered (union)

`agent_transcript`, `agent_turn`, opencode/codex stores, `agent_api_keys`, `agent_auth` keeper internals; most of `ssh_exec`/`sftp`/`openvpn`, `connect` pairing, `local_lane` server/relay; most of `git_peer.rs`, `git_ci.rs`, `git_release.rs`, `private_file.rs`; phone `discovery`, `scheduler`, `push`, `markup*`, most of `headless.rs`, `pty_bridge.rs`, `uploads.rs`, most PWA screens; vault rotation, broker, keeper/units; `mail_pgp`/`mail_crypt` in depth, IMAP/SMTP, `mail_store`, CalDAV XML, `cockpit_mcp`, `git_push_mcp`, `pdf_markup.rs`; window/popout/platform, most of voice, `dev_build`, `brand_migration`; `tabs.ts`, `activity.ts`, `detached.ts`, `mail.ts`, `useSteering.ts`; `TerminalView`, `TerminalReaderView`, `MobileBridgeHost`, `TabBar`, `ProjectFilesView` line by line, calendar/todo/server/printing components; `ci-local.sh`, `fresh-vm.sh`, `server-isolation-test.sh`, GitHub-side settings, a full email/hostname sweep. Overlap with `docs/threat_recheck_2026_11_12_plan.md`: none (that is a plan without findings).
