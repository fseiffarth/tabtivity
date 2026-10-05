## Group F — Session Restore
*Files: `services/project_runtime.rs`, `terminal_service.rs`, `src/stores/tabs.ts`, `CenterPanel.tsx`.*

24. **Restore/resume agent sessions.** Terminal/tab layout persistence already
    exists (`.tabtivity/sessions/terminals.json`), but app-startup restore via
    `active_session.json` is **unused**. Wire up restoring the full prior session
    (active project, tabs, windows) on launch. Feasibility note: resuming the
    actual *agent* process state depends on the agent CLI's own resume support;
    realistic scope is restoring tabs + relaunching the agent, not live state.
    Agent-resume approach (migrated from TODO `ISSUE-RESUME`): when restoring a
    tab, detect that tab's most recent agent session ID from the agent's own
    session directory — Claude Code `~/.claude/projects/<encoded>/`, Codex
    `~/.codex/sessions/`, Gemini `~/.gemini/history/`, Vibe
    `$VIBE_HOME/logs/session/` — and pass `--resume <id>` when respawning. A
    prior attempt was removed 2026-06-07 because detection was unreliable and
    **each tab must track its own distinct session ID** (not the project-global
    latest) to work with multi-agent setups.
    - ✅ **That blocker is gone.** #39 solved per-tab session tracking
      (`services/agent_session.rs:39,292,503`, `services/codex_bind.rs`), so
      "solve per-tab session tracking before relying on `--resume`" no longer
      applies — this item is unblocked and ready to build.
    - **Residual scope is now narrow:** only `active_session.json` startup
      restore (active project + windows). The never-wired
      `schema/active_session.rs` stub was deleted (codebase review §10.2,
      2026-08-28) — recover it from git history, or redefine the schema, when
      this lands.

39. **Per-tab agent session restore — stepwise.** Concrete, incremental path to
    #24's hard part (per-tab session tracking), built one step at a time so each
    step is verifiable on its own.
    - [x] **39a — Surface a tab's launch session id (Claude).** ✅ Done. Tabtivity
      mints a UUID and launches Claude with `claude --session-id <uuid>`, stored
      on `TabEntry.sessionId` and shown on tab hover. This **launch id** is
      deterministic, stable, and unique per tab. *Files: `stores/tabs.ts`
      (`sessionId`), `components/tabs/TabBar.tsx`.* Pure frontend — no rebuild.
      **Known limitation (drove the design):** the id does **not** follow a
      `/clear` (which rolls Claude onto a new session id). A first attempt
      resolved the "live" id from the newest `<uuid>.jsonl` in
      `~/.claude/projects/<encoded-cwd>/`, but that was **removed** — all Claude
      sessions in a project (other tabs, *and the dev agent running in the same
      cwd*) share one folder, so "newest file" cross-contaminates: two tabs
      showed the same id and it drifted as any session wrote. Following `/clear`
      reliably needs per-process attribution, not directory guessing → 39c.
      - *Test (e.g.):* open two Claude tabs in one project → each hover shows a
        distinct, stable UUID that never changes while the tab is open.
      - [ ] 🤖 Automated test — none yet (trivial frontend tooltip; covered by
        manual)
      - [ ] 🖐️ Manual test
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
    - [x] **39b — Persist agent tabs with their session id.** ✅ Done.
      Resumable agent tabs (Claude with a `sessionId`) are now persisted in
      `tab_layout` (carrying `sessionId`) and restored on relaunch; other agent
      tabs are still dropped. *Files: `schema/project.rs` (`TabEntry.session_id`),
      `stores/tabs.ts` (`isRestorableTab`/`saveLayout`/`loadFromLayout`),
      `stores/projects.ts`, `components/layout/CenterPanel.tsx`.*
    - [x] **39c — Track the live session id across `/clear`, then resume.** ✅
      Done for Claude. The original hard part — following the *live* session id
      after `/clear` (Claude rolls onto a fresh id with no recorded back-link to
      the launch id) — is solved with a global Claude **`SessionStart` hook**
      (fires on startup/resume/clear/compact) that records the live `session_id`
      keyed by `$TABTIVITY_TAB_UID`. Tabtivity sets `TABTIVITY_TAB_UID` to the tab's
      stable launch id on spawn, then at (re)spawn resolves the hook-recorded
      live id and emits `claude --resume <live-id>` (falling back to the launch
      id, and downgrading to `--session-id` when no log exists yet). The hook is
      installed once into `~/.claude/settings.json` and no-ops for any Claude not
      launched by Tabtivity. *Files: `services/agent_session.rs` (hook install +
      live-id store), `terminal/mod.rs` (`resolve_claude_session`), `lib.rs`
      (install at startup). Hook script: `~/.local/share/tabtivity/hooks/`; live ids:
      `~/.local/share/tabtivity/live_sessions/`.*
      - [ ] 🖐️ **39c-relaunch — A Claude that relaunched itself before its first
        prompt keeps its tab.** Open a new Claude tab, accept the "flicker-free
        rendering" upsell (or run `/tui fullscreen`) before sending anything, then
        prompt: the phone's Reader shows the conversation, the tab's working /
        done marks light, and after a Tabtivity restart the tab resumes that
        conversation. (Claude 2.1.282 comes back under a fresh session id; the
        hook now follows it while the launch id has no transcript — 2026-09-25.)
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
    - [x] **39d — Generalize to other agents.** Codex, Gemini and Mistral/vibe done.
      - [x] **Codex.** ✅ Done. Codex mints its own session id (no launch-time
        `--session-id`), but it has a Claude-style `SessionStart` hook and resumes
        by uuid (`codex resume <id>`). Tabtivity sets `TABTIVITY_TAB_UID` (a per-tab key)
        on the Codex tab, installs a `SessionStart` hook into `~/.codex/config.toml`
        (TOML text-append, idempotent) that records the live session id under that
        key, then at spawn resolves it and launches `codex resume <live-id>` when a
        rollout log exists (else fresh). Covers `/clear` (Codex `source` includes
        `clear`). *Files: `services/agent_session.rs` (`register_codex_hook`,
        `resolve_codex_session`/`codex_session_exists`), `stores/tabs.ts`
        (`RESUMABLE_AGENTS.codex`), `components/tabs/TabBar.tsx`.*
        ⚠️ **The trust gate bit us:** user-level Codex hooks need a one-time
        approval (`/hooks` in Codex), and an unapproved hook *silently* never
        runs — so in practice this never fired at all (Codex recorded our hook
        with `enabled = false`, and 0 of 89 `live_sessions/` records were Codex's)
        and every Codex tab restored blank.
      - [x] **Codex, hook-free fallback.** ✅ Done. Resume no longer depends on
        the hook: `services/codex_bind.rs` follows Codex's own rollout logs
        (`~/.codex/sessions/**/rollout-*.jsonl`, whose `session_meta` header
        carries `session_id` + `cwd`), attributes a new rollout to the tab that
        spawned in that cwd, and writes it to the same `live_sessions/<uid>` file
        the hook would have — so the resolve path is unchanged. The hook stays
        installed as the *precise* path (it disambiguates two Codex tabs in one
        cwd, and rebinds on `/clear` instantly); `codex_hook_state` detects the
        trust gate and the UI offers a one-click "open Codex on `/hooks`" fix
        (`lib/agents/codexHooks.ts`, `lib/shortcuts/hints.ts`, `SettingsSubPanels.tsx`).
        Remaining: **remote (ssh) Codex tabs are out of scope** — their rollouts
        live on the far host, so the binder skips them; making them work means
        running the rollout scan over `ssh_exec`.
      - [x] **Gemini.** ✅ Done via **continue-last**. `--session-id <uuid>` sets
        the launch id (already passed), but `--resume` takes an index/`latest`,
        not a uuid — so precise resume-by-uuid isn't available. Instead Tabtivity
        restores with `gemini --resume latest`, continuing the project's most-
        recent session, exactly like Grok/Qwen. Same caveat: two Gemini tabs in
        one project share that one latest session. *Files: `stores/tabs.ts`
        (`RESUMABLE_AGENTS.gemini`).* Verified against `gemini --help` (`-r,
        --resume … "latest"`). Not wired into the plan/auto mode table because
        continue-last can't guarantee THIS tab's session on respawn (see
        `components/tabs/agentModes.ts`).
      - [x] **Mistral/vibe.** ✅ Done via **continue-last**. Vibe mints its own id
        with no launch-id control, and `--resume` with no id opens an interactive
        picker (hangs a restore) — but `-c/--continue` "Continue from the most
        recent saved session" is the non-interactive path, so Tabtivity restores with
        `vibe --continue`. Same shared-latest caveat. *Files: `stores/tabs.ts`
        (`RESUMABLE_AGENTS.vibe`).* Verified against `vibe --help`.

    - [x] **39e — Restore hardening (review of 39c/39d, 2026-09-02).** ✅ Code
      done, not run live. Four things the review found, each with a unit test:
      **(1)** the hook accepted any Claude that inherited `TABTIVITY_TAB_UID` — a
      `claude -p` run from the tab's own Bash tool overwrote both the live id and
      the mode record (reproduced live) — so the script now lets only the tab's
      own session move the record (id must be the launch key or the current
      record, else only a `clear`/`resume` start), keyed by a new
      `TABTIVITY_TAB_AGENT` marker, and the Codex binder adopts a hook id only when
      Codex has a rollout for it; **(2)** a box's per-member Claude tab restored
      into the box folder instead of the member root (`restoredAgentCwd` now
      takes the box's member roots as `agentRoots`); **(3)** a restored remote
      Claude tab always launched `--session-id <launch>`, which Claude refuses
      once the host has that transcript ("already in use", reproduced live) —
      the remote command now probes the host and picks `--resume` there
      (`ssh_exec::host_side_resume`); **(4)** the crashed-run transcript harvest
      ran on the off-thread container sweep, racing restored tabs — it is now
      synchronous at startup (`sandbox::harvest_and_clear_stage`), and the
      resolver also probes the project's stage. Verified live along the way: the
      current Claude CLI finds `--resume <id>` from any cwd. *Files:
      `services/agent_session.rs`, `services/ssh_exec.rs`, `services/sandbox.rs`,
      `services/codex_bind.rs`, `lib.rs`, `lib/agents/agentWorktrees.ts`,
      `stores/{tabs,boxes}.ts`; doc `docs/context/agent_sessions.md`.*
      - [x] 🤖 Automated — `hook_script_lets_only_the_tabs_own_session_move_the_record`
        (runs the real `sh` script), `resolve_finds_a_log_under_any_of_several_roots`,
        `remote_command_lets_the_host_decide_a_claude_resume`, and the
        `restoredAgentCwd` / box-restore cases in `AgentWorktreePick`,
        `CenterPanelSessionRestore`, `BoxScopePersistence`.
      - [ ] 🖐️ Manual test (needs a backend rebuild + restart, which rewrites the
        hook script on startup)
        - [ ] In a Claude tab, set a non-default mode (shift+tab), ask it to run
          `claude -p "say ok"`, then restart Tabtivity → the tab resumes *its*
          conversation in the mode you set, not the one-shot run.
        - [ ] `/clear` in a Claude tab, chat, restart → the post-clear
          conversation comes back.
        - [ ] Box scope: "+ → Claude — ⟨member⟩", restart → the tab is in the
          member root (`pwd` in a shell or the tab hover), not the box folder.
        - [ ] Remote project: Claude tab, chat, `tmux kill-server` on the host
          (or reboot it), restart Tabtivity → the tab resumes instead of dying with
          "Session ID … is already in use".
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS

---
