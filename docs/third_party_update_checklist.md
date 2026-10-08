# Third-party update checklist

Tabtivity wraps a lot of software it does not control: agent CLIs, Ollama,
Tailscale, tmux, Docker, QEMU, bubblewrap, OpenVPN, OpenSSH, SLURM, TeX, mail
and CalDAV servers, desktop shells, and the GitHub API. Each of those ships on
its own schedule, and every one of them is wired in through a *specific*
assumption — a flag, a file path, a JSON field, a line of TUI text. This file
collects those assumptions in one place so that "X released a new version" is a
checklist rather than an archaeology dig.

How to use it:

1. When a tool below updates (or a distro upgrade drags one along), open its
   section, walk the **Assumes** list against the new release notes, and run
   the **Verify** steps.
2. Every "verified against" version noted here or in a code comment is the last
   release someone actually checked. Bump it when you re-verify, in the code
   comment first.
   For the agent CLIs those notes also exist as data, in
   `services::agent_versions::VERIFIED` (one row per *check*, not per agent —
   Codex has four, because four surfaces are verified separately).
   That is what makes "did anything move?" answerable:
   `cargo run --example agent_versions --manifest-path src-tauri/Cargo.toml`
   prints installed-vs-verified for every installed CLI and exits non-zero on
   drift, and Manage Agents shows the same verdict per row. Re-verifying a
   surface means bumping **both** its row and the prose note here, in one
   commit; a version only Tabtivity can read and a version only a human can read
   drift apart exactly like the two install tables did.
3. A breakage found this way is a normal fix: patch the one place named under
   **Where**, add a test alongside the existing ones, update the version note.

Automated gates cover none of this — `cargo test` / `npm test` pin *our* parsers
to *sample* output, not to what the current binary prints. Only running the real
tool does that; the **Verify** steps say how without needing a window.

---

## 1. Agent CLIs (all of them)

The registry in `src-tauri/src/commands/agents.rs` (`AGENTS`) is the one list of
installable agents: Claude, Codex, Antigravity, Gemini, Kiro, Cline, Vibe,
Aider, OpenCode, Cursor, Copilot, Droid, Grok, Qwen, OpenClaw, Auggie, Kilo
Code, Continue.dev, Junie, CodeBuddy, Goose, Pi, Plandex, SWE-agent,
mini-SWE-agent, Crush, Amp, Kimi, Qoder, Muse. Everything below applies per
agent; the agent-specific sections that follow list what is *additionally*
coupled.

**Added 2026-09-18.** Droid (Factory), Auggie (Augment), Kilo Code, Continue.dev
(`cn`), Junie (JetBrains) and CodeBuddy (Tencent). Droid was already half here —
a `LOCAL_DRIVERS` row in `commands/ollama.rs`, a name in `sandbox.rs` and
`terminal_service.rs` — so it could be driven by a local Ollama model while
being uninstallable and unlaunchable as itself. Only Droid resumes
(`--resume`, cwd-scoped, `~/.factory/sessions` mounted in the fence); the other
five launch only, because a `--continue` whose session store the fence does not
map exits on "no conversation to continue" and takes the restored tab with it.

**Retired, 2026-09-18.** Mentat (repo archived), gpt-engineer (archived
2026-04-22, and pinned below Python 3.13) and the OpenHands CLI (upstream says
it is no longer actively maintained and points at Agent Canvas, a self-hosted
platform rather than a terminal agent) left the registry. Their metric leaves
stay in `src/lib/usageMetrics.ts`, which is a decode table for counters already
written, not a roster. Two more are on watch: Plandex's cloud wound down in
Oct 2025 (the OSS repo still moves), and Gemini CLI stopped serving free,
AI Pro and AI Ultra accounts on 2026-06-18 — it still works on a paid API key
or Code Assist Standard/Enterprise, and Antigravity (`agy`) is Google's
successor, already in the registry.

**Two names that are not the obvious one.** Kiro installs as `kiro-cli` (it is
the renamed Amazon Q Developer CLI, so no separate `q` row is needed), and two
different CLIs install as `grok` — the registry now installs xAI's own Grok
Build, not the third-party `@vibe-kit/grok-cli` it used to.

**Where**

- `commands/agents.rs` — `AGENTS` (binary name, official install one-liner per
  OS, extra user-install paths, docs URL, npm package for uninstall),
  `WARMUPS` (per-agent one-shot/print argv used by the scheduled warm-up).
- `services/remote_agents.rs` — the *same* install one-liners restated as a
  POSIX-sh prelude for remote hosts (userspace, no sudo). Two tables that must
  say the same thing; they have drifted before.
- `src/stores/tabs.ts` (`RESUME_ARGS` near the bottom) — per-agent "continue
  last session" flags used on relaunch/restore.
- `src/lib/agents/agentPrefaces.ts` — default slash commands offered per agent
  (`/clear`, `/compact`, `/new`, `/status`, …) and `DEFAULT_AGENT_MODELS`.
- `src/lib/agents/prompt/prompt.ts` — `looksLikeDecisionPrompt`: the regexes that turn a
  tab's output tail into the "needs a decision" lamp (pointer glyphs, numbered
  choices, yes/no pairs). Every agent's approval prompt has to keep matching.
- `mobile-web/src/terminal/{agentModes,statusLine,selectPrompt,readableScreen}.ts`
  — phone-side parsers of each TUI's status line, mode names, `/model`
  pickers, and box-drawing frames.
- `services/agent_fence.rs` — which per-agent home files/dirs the bubblewrap
  fence binds (`~/.claude`, `~/.claude.json*`, `~/.claude/settings*.json`,
  `~/.codex/config.toml`, `~/.local/share/claude/versions`, `~/.local/bin`).
- `services/sandbox.rs` — the same set for the Docker container.

**Assumes**

- The binary name and the install script URL are stable; `extra_paths` covers
  where the installer drops the binary when it is not on `PATH`.
- The print/one-shot mode listed in `WARMUPS` still exists and still exits on
  its own with no TTY (`-p`, `exec`, `run`, `-x`, `run -t`). An agent not in
  `WARMUPS` is refused, never guessed — keep it that way.
- The resume flag in `RESUME_ARGS` still means "continue the most recent
  session non-interactively" (a flag that now opens a picker hangs a restore).
- Approval prompts still render as a pointer (`❯`/`›`/`>`), numbered options,
  or a yes/no pair — otherwise the decision lamp goes dark.
- Config/state lives in the home paths the fence binds; a CLI that moves its
  config (e.g. into `~/.config/<agent>`) silently loses login inside the fence.

**Verify**

```sh
<agent> --version
<agent> --help | grep -iE 'print|resume|continue|session'   # flags still there?
cargo test --manifest-path src-tauri/Cargo.toml agents::     # WARMUPS/registry tests
npx vitest run src/__tests__/agents/agentPrompt.test.ts              # decision-prompt corpus
```

Then open one tab per updated agent, trigger a permission prompt, and check
the tab lamp turns to "decision"; close and reopen Tabtivity and check the tab
resumes.

### 1.1 Claude Code (deepest coupling)

- Mobile send hint (2026-09-14): installed CLI is 2.1.270. The official
  [hooks reference](https://code.claude.com/docs/en/hooks#sessionstart) specifies
  SessionStart stdout as model context. Tabtivity prints `tabtivity-send <file>` only
  after session continuity accepts the payload, with `TABTIVITY_TAB_AGENT=claude`
  (or `codex`, see 1.2) and `TABTIVITY_PROJECT_DIR` set; tests execute the hook
  and prove nested startups, Stop and unscoped invocations stay silent. Verify
  context ingestion again on CLI upgrades; an authenticated live Claude round
  trip remains QA.


**Where** `services/agent_session.rs`, `services/agent_usage.rs`,
`commands/terminal.rs` (`--remote-control`), `commands/ollama.rs`
(`LOCAL_DRIVERS`), `src/lib/agents/agentPrefaces.ts`, `src/lib/agents/fastMode.ts` is *not*
Claude's `/fast` — different thing.

**Assumes**

- Root console (`services::root_mcp`): `--mcp-config <inline json>` with an
  HTTP server whose `headers` value `Bearer ${TABTIVITY_ROOT_MCP_TOKEN}` is
  **expanded from the environment** — verified on 2.1.276 against a logging
  loopback server (`headersHelper` worked too). If expansion ever stops, the
  root tools fail with 401 rather than leaking; the fallback is
  `headersHelper`, never the literal token (it would reach the tmux launcher
  script on disk).
- Flags: `--session-id <uuid>`, `--resume <uuid>`, `--permission-mode <mode>`,
  `--dangerously-skip-permissions` (detected, never added),
  `--remote-control` (added by default, setting `agent_remote_control`),
  `--name=<project>` (host binary only, gated on the probed version ≥
  `CLAUDE_NAME_FLAG_SINCE` = 2.1.76; below that, or in a container/remote, the
  tab types `/rename <project>` instead),
  `-p <prompt>`, `-p "/usage" --output-format json`.
- Permission modes are exactly `default | plan | acceptEdits | auto | dontAsk |
  bypassPermissions` (`is_permission_mode`); anything else is dropped.
- Hooks: `SessionStart`, `Stop`, `UserPromptSubmit`, `PostToolUse`,
  `Notification` and `SessionEnd` (`HOOK_EVENTS`) are registered in
  `~/.claude/settings.json` under `hooks.<Event>[].hooks[]` as
  `{type:"command", command:…}`, no matchers. The hook payload carries
  `session_id`, `hook_event_name`, (on `Stop`) `permission_mode`, and (on
  `Notification`) `notification_type` — the tab's working / decision / done
  marks (`services::agent_turn`) read `permission_prompt`,
  `elicitation_dialog` and `idle_prompt` off it; a renamed type means the
  decision lamp for a Claude tab falls back to the screen. The hook script
  greps those keys with `sed`, so a renamed key breaks resume silently.
  Verified against Claude Code 2.1.282 (2026-09-25, live: a `/clear`'s
  SessionStart carried `session_id` + `source: clear`, a Stop carried
  `permission_mode`, and a `/clear` fires no Stop event); re-checked against
  2.1.284 (2026-09-29, live: the tab records of a 2.1.284 session show
  `source: clear` / `startup`, `session_id` and `permission_mode` parsed off
  its payloads — and that a `claude -p` run from a Bash tool in another cwd
  passed the nested-startup guard and took the tab's record over; the guard
  now looks for the tab's transcript in every project folder); re-checked
  against 2.1.285 (2026-09-30, live, `-p` with an inline `--settings` hook
  dumping every payload: SessionStart `source: startup` / `resume`, Stop and
  UserPromptSubmit `permission_mode`, `session_id` equal to the
  `--session-id` passed, SessionEnd `reason`; the transcript at the path
  below, `--resume <uuid>` reopening it); re-checked against 2.1.286
  (2026-09-30, live, the same `-p` dump: identical keys and values); re-checked
  against 2.1.287 (2026-10-02, live, the same dump: identical keys — Stop now
  also carries `effort`, `last_assistant_message`, `background_tasks`, a
  resume start `seconds_since_last_response` and `context_tokens`, none read).
  That run, a `claude -p --resume <id>` from the tab's Bash tool, took the
  tab's record over: every hook, the tab's own included, gets `CLAUDECODE=1`,
  `CLAUDE_CODE_CHILD_SESSION=1` and its own `CLAUDE_CODE_SESSION_ID`, so the
  env cannot tell a nested CLI from the tab's; the hook now refuses a foreign
  `clear`/`resume` start sent by a `claude` with another `claude` above it
  among the processes carrying the tab's id (`/proc`, POSIX only). Re-checked
  against 2.1.288 (2026-10-02, live, the same dump: identical keys and values,
  `--permission-mode manual` reported as `default`; new and unread:
  `prompt_id` on every event but SessionStart, Stop `session_crons`, a resume
  start `estimated_cache_write_usd` and `prompt_cache_likely_expired`; the
  hook's `sed` extractions match `jq` on every payload). Re-checked against
  2.1.291 (2026-10-06, live, the same dump with both `*_TAB_UID` names unset:
  identical keys on all six events; `-p --resume` does not restore `plan`, the
  2.1.290 plan restore is terminal-only, so `agent_session`'s re-applied mode
  stays needed; `/usage` parsed into three meters, resets resolved; the
  binary still carries the three notification types and six modes; 2.1.290's
  `❯` on the selected `/`/`@` suggestion row does not trip `POINTER_WORD`,
  which needs a bare word right after the glyph). Re-checked against 2.1.292
  (2026-10-06, live, the same dump, both `*_TAB_UID` names unset: identical
  keys on SessionStart startup/resume, UserPromptSubmit, PostToolUse, Stop and
  SessionEnd, `session_id` equal to the `--session-id` passed, the hook's `sed`
  extractions match `jq` on every payload; its changelog's "plan mode not
  being restored when resuming" fix still does not reach `-p --resume` — a
  `plan` session resumed without a mode flag reports the default (`auto`
  here), so the re-applied
  mode stays needed; `/usage` three meters, resets resolved; the binary's
  notification-type and mode-label strings count the same as 2.1.291's).
  Re-checked against 2.1.294 (2026-10-08, live, the same dump, both
  `*_TAB_UID` names unset: identical keys on all five events it fired,
  `session_id` equal to the `--session-id` passed, `sed` matching `jq`
  throughout; `-p --resume` of a `plan` session still reports the default;
  `/usage` three meters, resets resolved; the three notification types and
  the cycle's mode labels count the same as 2.1.292's). 2.1.293 makes
  `claude-haiku-5-5` the default Haiku: the transcript reports that id, and
  `services::api_prices` now prices it (it had fallen to the dearest rate,
  about 100× over). An earlier probe unset only
  `TABTIVITY_TAB_UID`; the hook's legacy preamble filled it back in from the
  pre-rename name and the `/proc` walk, matching the current name only,
  counted no `claude` — the `--resume` took the record again, emptying the
  Reader's chat and Changes panel. The walk now matches the tab's id under
  any `*_TAB_UID` name. **Probing from a tab:** unset both names, or none and
  let the guard refuse it. The turn
  events against 2.1.272 by
  reading the binary's strings, not live — 2.1.288 still carries
  `permission_prompt`, `elicitation_dialog`, `idle_prompt` and the same six
  permission modes.
- Session logs: `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`; `--resume` is
  emitted only when that file exists.
- The model tag in the Agents views (`agent_session_model`) reads the tail of
  that log for the last `{"type":"assistant","message":{"model":…}}` record,
  skipping `<synthetic>`. A renamed key or type means no tag, never a wrong one.
- The last-prompt line (`agent_session_last_prompt`) reads the same tail for
  the last `{"type":"user","message":{"content":…}}` record that is a prompt:
  `isMeta`/`isSidechain` records, `tool_result` blocks, and string content
  opening with `<local-command-caveat>`, `<local-command-stdout>`,
  `<task-notification>`, `<bash-stdout>`, `<system-reminder>`,
  `<persisted-output>`, `<stdin>` or `[Request interrupted` are skipped;
  `<command-name>…<command-args>` reads as `/name args`, `<bash-input>` as
  `! cmd`. A new wrapper tag shows up as a prompt until it is added here.
- `/usage` in print mode returns a JSON envelope with `result` (panel text),
  `is_error`, `num_turns: 0` (re-checked live against 2.1.286, 2026-09-30,
  its panel fed through `parseUsageReport`: three meters, the
  "What's contributing" lines kept as notes; 2.1.287, 2026-10-02, prints the
  same layout plus a `Last 7d` block of the same shape; 2.1.288, 2026-10-02,
  unchanged, every reset resolved by `resolveResetAt`). The
  panel text is parsed by `shared/usageReport.ts` for the phone's bars, the
  prompt chart's reset lines and auto-continue (five-hour / weekly windows,
  per-model lines) — a re-layout may cost figures. `resolveResetAt` places the
  reset phrase in time: 2.1.272 prints `resets Sep 15, 10:30pm (Europe/Berlin)`
  (a year only when it is not the current one, the zone always; 2.1.282 drops
  the minutes on the hour, `resets Sep 25, 1pm`) where earlier
  builds printed `resets 6:20pm` / `resets Mon 9am`. 2.1.284 appends a
  "What's contributing to your limits usage?" section (`Last 24h · N
  requests · N sessions`, `Top subagents: general-purpose 39%, …`); a meter
  needs its percentage to *lead* the value, so those shares stay notes. A shape it does not know
  resolves to nothing, which silently empties the chart's reset lines and
  leaves auto-continue unable to arm.
- Model short names `opus | sonnet | haiku | fable` for the `/model` chips.
- Preface commands `/clear /compact /context /cost`.
- Home files: `~/.claude/`, `~/.claude.json` (+ `.bak`, `.backup.N`),
  `~/.claude/settings.json`, `settings.local.json`,
  `~/.local/share/claude/versions/`.
- `claude update` and the background auto-updater (native installer) share
  one write path, read out of the 2.1.270 bundle (2026-09-14): the download
  is staged under `$XDG_CACHE_HOME/claude/staging/<v>` (`~/.cache/…`),
  **copied** (`copyFile`, not `rename`) to
  `~/.local/share/claude/versions/<v>.tmp.<pid>.…`, renamed into place,
  and the `~/.local/bin/claude` symlink is swapped by rename; a per-version
  lock lives under `$XDG_STATE_HOME/claude/locks/`; the result lands in
  `~/.claude/.last-update-result.json`. `agent_fence::updatable_install_dirs`
  hands `~/.local/bin` and `~/.local/share/claude` back read-write; staging
  and locks stay in the fence's tmpfs home, which is fine precisely because
  the staging→versions hop is a copy — a release that switches it to a rename
  breaks with `EXDEV` inside the fence (also across two separate bind mounts).
  The whole sequence was dry-run inside a fenced tab on 2026-09-14 and
  passed. Reading the result file: `status: "install_failed"` with
  `version_to: null` means the updater threw *before* resolving the target
  version — the version check talks to `downloads.claude.ai`, which is
  IPv4-only, so an IPv6-only moment on the host produces exactly that record
  while every directory is writable.
- Credentials: the OAuth record is `~/.claude/.credentials.json`
  (`{"claudeAiOauth":{accessToken, refreshToken, expiresAt, …}}`, 0600). The
  CLI opens it with `O_NOFOLLOW` — a symlink is refused (`refused-symlink`,
  `ELOOP`) — and **rotates it by atomic rename** (temp file + `rename(2)`),
  so the path gets a new inode on every refresh. `services/agent_creds.rs`
  relies on all three: the fence mounts a Tabtivity-owned mirror *file* (not a
  link, not the host inode) at that path and rewrites it in place; a
  cleared record has empty token strings and `expiresAt: 0`, which the mirror
  never copies back to the host. Verified against Claude Code 2.1.263. A moved
  file, a new key layout, or a CLI that starts writing in place changes what
  the keeper must watch — and a CLI that starts *following* symlinks would let
  the file join the staged shadows instead.
- Ollama-side: `ollama launch claude --model <m>` is the only way an
  Anthropic-compatible endpoint is stood up for Claude (Ollama ≥ 0.15).
- Mobile: mode family `default | accept edits | plan | auto | bypass
  permissions` — the cycle's labels `accept edits on`, `plan mode on`, `auto
  mode on` read out of the 2.1.272 bundle (unchanged in 2.1.288) — `default` draws `⏸ manual mode on`
  (seen live on 2.1.284 and 2.1.286; older builds drew nothing), which no mode
  pattern names, so it reads as the silent default. Shift+Tab is the legacy
  backtab `ESC [ Z`.
- Permission prompt (2.1.286, live capture): the command sits between dashed
  `╌` rules with no blank line before `Do you want to proceed?`.
  `readableScreen` drops the rules as frame; the line under one carries
  `afterRule`, and `selectPrompt`'s heading stops there — without that the
  phone dialog went untitled. Desktop lamp unaffected (`❯ 1.` rows). 2.1.287
  draws MCP/other tool prompts and a held message from another session the
  same way (changelog); the rule handling is not Bash-specific, but no such
  prompt has been captured live yet.

**Verify**

```sh
claude --version
claude --help | grep -E 'session-id|resume|permission-mode|remote-control|output-format|--name'
claude -p "/usage" --output-format json | head -c 600
grep -A4 SessionStart ~/.claude/settings.json
stat -c '%i %a' ~/.claude/.credentials.json   # note the inode, then after a refresh: a new one
cargo test --manifest-path src-tauri/Cargo.toml agent_auth
cargo test --manifest-path src-tauri/Cargo.toml agent_session
cargo test --manifest-path src-tauri/Cargo.toml agent_usage
```

Check the release notes for: hook event renames or payload changes, new
permission modes (add to `is_permission_mode` *and* `agentModes.ts`), session
directory moves, `--remote-control` becoming default or removed, new model
aliases, and anything about where or how credentials are stored.

### 1.2 Codex

**Where** `services/agent_session.rs` (`resolve_codex_session`,
`register_codex_hook`, `codex_hook_state`), `services/codex_bind.rs`,
`src/lib/agents/codexHooks.ts`, `commands/ollama.rs` (`non_thinking_args`,
`write_local_catalog`), `mobile-web/src/terminal/agentModes.ts`,
`src/lib/agents/prompt/prompt.ts` + `src/stores/activity.ts` (the decision lamp).

- Mobile send hint (2026-10-01): the Codex [hooks
  docs](https://learn.chatgpt.com/docs/hooks) say plain SessionStart stdout
  "is added as extra developer context", so the hook prints the same
  `tabtivity-send <file>` line as for Claude (1.1) and the project scaffold's
  `AGENTS.md` no longer carries it. Never verified live.

**Assumes**

- **0.161.0 (2026-10-07), live but outside Tabtivity** — the GitHub release's
  musl build (npm's linux-x64 tarball was not served yet) run in a private
  tmux with its own `CODEX_HOME`, inside a fenced agent tab, `--no-daemon`.
  `--version` prints `codex-cli 0.161.0`; `resume [SESSION_ID]`,
  `exec --skip-git-repo-check`, `--no-daemon`, `--oss`, `-m`, `-c` stand and
  `-a` still takes `on-request | never`. Verified live and fed to the parsers
  as captured: the approval menu (same three labels as 0.159.2, `›` on row 1,
  `looksLikeDecisionPrompt` true, `readSelectPrompt` reads all three) and its
  title frames `[ ! ]`/`[ . ] Action Required | <action> | <dir>`; both
  `/model` steps (heading, two blank lines, rows from 1, row 5
  `More reasoning…`, footer `enter default · s session · esc back`); the mode
  line — CSI-u Shift+Tab (and tmux's backtab) toggles the silent default and
  `Plan mode`, which `sessionStatus` / `currentMode` read as `working` and
  `plan`; the rollout's first line `session_meta` with `session_id` and `cwd`,
  then `turn_context.model` and user prompts as `response_item` user messages
  (no `event_msg` `user_message`, as since 0.158.0). Hook events unchanged
  (`PreToolUse` … `Interrupt`, `UserPromptSubmit`, `Stop`; still no
  `Notification`). The writer lock is markers only (`active writer`,
  `thread-writer-locks`); its lifecycle was last probed on 0.154.0. The
  installed 0.160.1 matched 0.159.3 on the same binary markers and rollouts.
  New: the TUI runs shell commands through a sibling `codex-code-mode-host`
  and fails closed ("host executable is missing") without it. The standalone
  package ships it in `bin/` next to `codex`, a directory the fence already
  binds because it is on the binary's symlink chain; keep it that way if the
  binding is ever narrowed to the one file. Re-checked against 0.161.0 on
  2026-10-08 (still the latest release), same musl build, private
  `CODEX_HOME`, a local Ollama model: npm's linux-x64 tarball is now served
  and carries the same-size `codex` with `codex-code-mode-host` beside it in
  `vendor/<triple>/bin/`; `exec --skip-git-repo-check` (the warm-up) runs and
  exits on its own without a TTY. Hook payloads captured live (exec with
  `--dangerously-bypass-hook-trust`, then a TUI `resume`): every event carries
  `session_id`, `hook_event_name`, `transcript_path`, `cwd`; SessionStart adds
  `source` (`startup`, `resume`), UserPromptSubmit `prompt`, SessionEnd
  `reason`; `PreToolUse` and `PostToolUse` fire around a shell call. Plain
  SessionStart stdout lands in the rollout as a developer message; a Stop hook
  that prints non-JSON is reported "Failed" (ours prints nothing there).
  Trusting through the startup "Hooks need review" menu writes a bare
  `trusted_hash` under `[hooks.state."<config>:session_start:0:0"]`, what
  `codex_hook_state_in` reads. Writer lock, live: a TUI `resume` holds
  `thread-writer-locks/<id>.lock`, a second `exec resume` exits 1 with
  "already has an active writer", and after the TUI is SIGKILLed the same
  resume succeeds (the empty lock file stays). Rollouts now number each line
  (`ordinal`) and add `world_state` and `token_usage_record` records; the
  `event_msg` `token_count` totals that `token_stats` reads are unchanged.
  Two things that already held on 0.160.1 (same strings in its binary), both
  fixed 2026-10-08: Codex clamps a SessionEnd hook's timeout to 3s and warned
  about our `timeout = 10` on every start (`⚠ … warnings` in the TUI footer) —
  `register_codex_hook_as` now writes 3 there and lowers an older block in
  place (live: the trust hash does not cover the timeout, so the lowered hook
  stays trusted and the warning goes); and that "Hooks need review" menu
  (`Review hooks` / `Trust all and continue` / `Continue without trusting`)
  has no deny option, so it never lit the decision lamp — `prompt.ts` now
  matches its heading plus a numbered `Trust` row.
- **0.159.3 (2026-10-01), binary and rollout check** — the installed standalone
  CLI prints `codex-cli 0.159.3`. Its help still accepts `resume [SESSION_ID]`,
  `exec --skip-git-repo-check`, `--no-daemon`, `--oss`, `-m` and `-c`.
  The binary retains the model-sheet headings, mode names, `Action Required`,
  numbered approval choice text, `active writer` / `thread-writer-locks`, hook
  events, and `session_meta` / `turn_context` / `user_message` records. Recent
  rollouts written by 0.159.3 still start with `session_meta` carrying
  `session_id`. The parser regression tests below pass; the 0.159.3 TUI
  screens were inspected as binary markers rather than captured live.
  This was not a live approval, mode-cycle, model-picker or two-writer test;
  the latest live UI check remains 0.159.2 and the writer-lock lifecycle's
  offline probe remains 0.154.0. The four `VERIFIED` rows record this checked
  patch release with those limits, as 0.157.0 did for its binary check.
- **0.159.2 (2026-09-30), live but outside Tabtivity** — the npm linux-x64 build
  run in a private tmux with its own `CODEX_HOME`, inside a fenced agent tab.
  Verified live: the approval menu (labels below) and its title frames, the
  two-step `/model` screens (both fed to `looksLikeDecisionPrompt` and
  `readSelectPrompt` as captured), the rollout header and records, and that
  `resume <id>` / `exec --skip-git-repo-check` / `--oss` / `-m` / `-c` stand.
  `-a` now takes only `on-request | never` (Tabtivity passes none). Hook events
  are unchanged since 0.157.0 (`PermissionRequest` and `Interrupt` exist; still
  no `Notification`). Not verified: mobile mode lines, and the writer lock in
  a fenced (in-process) tab.
- **The shared app-server daemon.** Since at least 0.157.0
  (`daemon_auto_start`, stable, on) a TUI may detach a
  `codex app-server --managed-daemon` (own session, reparented to init) out of
  `$CODEX_HOME/packages/app-server-daemon/`, socket under
  `/tmp/codex-daemon-<uid>/`, and every later TUI on that `CODEX_HOME` attaches
  to it — a second `resume <id>` of a live thread then *joins* it instead of
  reporting an active writer. Fenced tabs have so far run in-process (the
  scope's log says `rpc.transport="in-process"` on 0.158.0) for a reason not
  pinned down; a TUI that does choose the daemon but cannot use it — only
  `current/bin` of the standalone install is bound, a sibling tab's socket is
  in another fence's private `/tmp` — exits 1 with "rerun … with
  `--no-daemon`". So Tabtivity appends `--no-daemon` to every host Codex TUI
  launch (fresh, `resume`, `--oss`; not `login`/`exec`/…) once the probed
  version is ≥ `CODEX_NO_DAEMON_SINCE` = 0.156.0, the release that brought
  both the daemon and the flag (0.155.x exits on it; unknown version → no
  flag, as with Claude's `--name`). Containers, remote hosts and
  `ollama launch codex` run their own Codex and get no flag.
- **0.157.0 (2026-09-25) was checked from the binary's strings, not live** —
  launching a Codex TUI from an agent tab was refused, so all four
  `VERIFIED` rows moved to 0.157.0 on this evidence: `--help` still lists
  `resume [SESSION_ID]` and `exec --skip-git-repo-check`; the binary still
  carries `Select Model and Effort`, `Select Reasoning Level for`,
  `More reasoning`, `Action Required`, the three approval labels quoted
  below, the mode names, `session_meta` / `turn_context` / `user_message`,
  the `active writer` message and `thread-writer-locks`. None of that proves
  the screen layout, title timer or lock release still behave as described;
  the next live check of each surface should say so here.
- `codex resume <uuid>`; `codex exec --skip-git-repo-check <msg>` (warm-up).
- Codex 0.154.0 reports an active writer when two processes resume one thread.
  An isolated offline app-server probe verified that killing the writer releases
  the lock. Keep the binder's within-pass claims exclusive and its spawn-time
  duplicate guard independent of hook trust; duplicates use the documented
  `codex resume` picker (no id). Never delete Codex's writer locks to force a
  resume. Verify this lifecycle again when its thread store changes (last
  checked live on 0.161.0, with the CLI itself: a SIGKILLed writer releases
  the lock).
- Session rollouts at `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl`
  whose **first line** is `{"type":"session_meta","payload":{"session_id","cwd",…}}`.
  This is the hook-free binding path; a new layout or header breaks every
  restored Codex tab.
- The model tag reads the same rollout's tail for the last
  `{"type":"turn_context","payload":{"model":…}}` record; the last-prompt
  line reads it for the last `{"type":"event_msg","payload":{"type":
  "user_message","message":…}}` or `response_item` user `message` whose
  `input_text` does not open with `<` (environment context, user
  instructions) or `#` (`AGENTS.md`). The 0.153.4 thread store holds no
  messages, so on that release the line falls back to the `› …` echo on the
  pane's screen (mobile `chatTurns`).
- User hooks in `~/.codex/config.toml` as `[[hooks.SessionStart]]` with
  `matcher = "startup|resume|clear|compact"` and `[[hooks.SessionStart.hooks]]`
  `type="command"`, plus — since 2026-09-15, for the tab's working / done
  marks — `[[hooks.UserPromptSubmit]]`, `[[hooks.PostToolUse]]`,
  `[[hooks.Stop]]` and `[[hooks.SessionEnd]]` without matchers
  (`CODEX_HOOK_EVENTS`; 0.154.0 names those events and no `Notification`, read
  off the binary's strings, not live — so a Codex approval wait is still read
  off its screen). Their payloads carry `session_id` and `hook_event_name`
  like Claude's (verified live on 0.161.0). Trust state is read from
  `[hooks.state."…"]` tables (`trusted_hash`, enabled flag), each hook by
  position, so the new blocks need the same one-time `/hooks` trust.
  Text-appended per event, never reserialized.
- Local models: `codex --oss -c oss_provider="ollama" -m <model>` as the
  fallback when `ollama launch codex` cannot be used; reasoning is turned off
  with `-c model_reasoning_effort="none"`; the model catalog Codex expects is
  `model.json` (written under Tabtivity's own state dir, not `~/.codex`).
- Preface commands `/new /compact /status`; `/status` is *not* available in
  exec mode, so there is no usage recipe.
- The decision lamp reads Codex's screen off the PTY, and two habits of its
  ratatui TUI are load-bearing (verified against 0.153.0; live again on 0.161.0):
  - **A blocked Codex is not a quiet Codex.** It keeps repainting its terminal
    title on a ~100ms timer — a braille frame while working, and while blocked
    an `ESC ] 0 ; [ ! ] Action Required BEL` alternating with `[ . ]`. Those
    frames paint no text, and `notePtyOutput` therefore drops them; if a
    release starts animating VISIBLE cells behind an approval instead, the tab
    never goes quiet and the orange bar never lights.
  - **An idle Codex is not a quiet Codex either** (0.154.0). Once the terminal
    answers its `OSC 11` background query, it animates a field of braille dots
    (U+2800–U+28FF) around the composer every ~150ms, indefinitely.
    `notePtyOutput` drops braille cells before judging a frame, or a finished
    turn reads as "working" forever. An animation in any other glyph range
    brings that back. (0.159.2 under tmux: an idle TUI wrote nothing for 4s;
    a blocked one only the title, now `[ ! ] Action Required | <action> |
    <dir>` about once a second.)
  - **Approval menus are numbered rows whose labels decide, not their index.**
    Codex offers two flavours of yes before the no — on 0.159.2 "Yes, proceed
    (y)", "Yes, and don't ask again for commands that start with `…` (p)",
    "No, and tell Codex what to do differently (esc)"; earlier "Yes, just this
    once" / "…for this command in this session" — and the diff renderer skips unchanged cells
    so the row arrives as `2.Yes,and…` — spaces gone, glued to the row above.
    `agentPrompt.ts` matches the first word of each option; renaming the
    options away from yes/no/allow/cancel wording is what would break it.
- Mobile: modes `working (silent) | plan | read only | auto | full access`;
  Shift+Tab is sent as CSI-u. Verified against codex-cli 0.151.0; live on
  0.161.0, where Shift+Tab toggles only the silent default and plan (the
  other three are not on its cycle).
- Mobile's model sheet reads `/model` off the screen, and Codex answers it in
  **two steps** — `Select Model and Effort`, then `Select Reasoning Level for
  <model>` (whose row 5, "More reasoning…", opens a third). Each step is a
  heading, blank lines (one through 0.153.4, two on 0.159.2), then rows `N. Label  Description` numbered from 1 with
  the highlight marked `›`; the sheet holds until a *different* list is drawn
  and closes when none is. Renumbering, dropping the heading, or drawing the
  next step without clearing the previous one is what would break it. Verified
  against codex-cli 0.153.4 and live against 0.159.2 and 0.161.0, whose reasoning step's
  footer reads `enter default · s session · esc back`: the Enter the sheet
  sends saves the pick as the default, `s` would keep it to the session.

**Verify**

```sh
codex --version
codex --help; codex exec --help | grep skip-git-repo-check
head -c 300 "$(ls -t ~/.codex/sessions/*/*/*/rollout-*.jsonl | head -1)"
grep -n 'hooks' ~/.codex/config.toml
cargo test --manifest-path src-tauri/Cargo.toml codex
npx vitest run src/__tests__/agents/agentPrompt.test.ts
npx vitest run src/__tests__/mobile/MobileSelectPrompt.test.ts src/__tests__/mobile/MobileModelSheetSteps.test.tsx
```

### 1.3 Gemini CLI

**Assumes** `gemini --resume latest` (index or `latest`, not a uuid),
`gemini -p`; preface `/clear /compact /stats`; footer says `NN% used`
without the word "context" (mobile `statusLine.ts`). The approval mode is text
on the row **above** the input box (`ApprovalModeIndicator`):
`auto-accept edits Shift+Tab to plan|manual`, `plan Shift+Tab to manual`,
`YOLO Ctrl+Y`, and in default mode only `Shift+Tab to accept edits` — read by
`statusLine.ts`, walked by the Gemini family in `agentModes.ts` (YOLO is on
Ctrl+Y, off the Shift+Tab cycle; its prompt turns `*`). Answers open with `✦ `
(`chatTurns.ts`). Inline unless `ui.useAlternateBuffer`. Read out of the
installed 0.56.0 bundle and the 0.60.0 npm bundle (2026-09-15; not live).
Install via `npm install -g @google/gemini-cli`. The 0.59.0 bundle still
defines `--resume` (alias `-r`) and renders the `NN% used` footer (read out of
the package, 2026-09-15; not live).

- No transcript is read: the Agents view's last-prompt line comes from the
  prompt echo on the pane's screen (`> …`, parsed by the mobile `chatTurns`),
  so a changed echo marker or an unindented multi-line echo loses the line.

**Verify** `gemini --help | grep -E 'resume|prompt'`; open a tab, `/stats`.

### 1.4 Qwen Code

**Assumes** `qwen --continue`, `qwen -p`; mode phrases `ask permissions |
plan | auto-accept | auto | yolo` on the Shift+Tab cycle, and `*` as the
YOLO input-line marker (mobile `statusLine.ts`, which takes a `*` with a draft
only beside the word YOLO). Answers open with `◆︎ ` (U+25C6 U+FE0E) since 0.23
(`chatTurns.ts`). **0.23.4 draws on the alternate screen by default**
(`ui.useTerminalBuffer`, "Virtualized History"), so Focus hands a Qwen tab to
Terminal unless `~/.qwen/settings.json` sets `"ui": {"useTerminalBuffer":
false}` (read out of the 0.23.4 bundle, 2026-09-15; not live).
`npm install -g @qwen-code/qwen-code`.
The last-prompt line reads the screen echo, as for Gemini.

### 1.5 Everyone else

| Agent | Resume flag | Warm-up | Install |
|-------|-------------|---------|---------|
| Vibe (Mistral) | `--continue` (`--resume` alone opens a picker — never use) | `-p` | `curl … mistral.ai/vibe/install.sh` |
| OpenCode | `--continue` | `run` | `curl … opencode.ai/install` / `npm i -g opencode-ai` |
| Copilot | `--continue` | `-p` | `npm i -g @github/copilot` |
| Cursor agent | `--continue` | `-p` | `curl … cursor.com/install` |
| Grok | — (0.0.34 keeps no sessions; `--session` is an unknown option) | `-p` | `npm i -g @vibe-kit/grok-cli` |
| Antigravity (`agy`) | `--continue` | — | `curl … antigravity.google/cli/install.sh` |
| Kimi | — | `-p` | `curl … code.kimi.com/install.sh` |
| Pi | — | `-p` | `npm i -g @earendil-works/pi-coding-agent` |
| Amp | — | `-x` | `npm i -g @sourcegraph/amp` |
| Goose | — | `run -t` | GitHub release `download_cli.sh` |
| Crush | — | `run` | `npm i -g @charmland/crush` |
| Aider | — | refused (no print mode) | `curl … aider.chat/install.sh` (uv) |
| Kiro, Cline, OpenClaw, OpenHands, Plandex, SWE-agent, mini-SWE-agent, Mentat, gpt-engineer, Qoder | — | — | see `AGENTS` |

Version probes (`agent_versions::VERSION_ARGV`) exist for Antigravity
(`agy --version` → `1.2.9`) and Muse (`muse --version` →
`Muse Code 1.3.0 (1.3.0-R3057.1)`) as well. Muse's launcher script starts a
background self-update on any invocation once its interval has passed, so its
probe sets `MUSE_NO_AUTO_UPDATE=1` (`VERSION_ENV`); a launcher that renames
that switch turns the daily probe into an updater. Muse has a recipe but no
recorded check, so Manage CLIs calls it unverified; the 1.4.1-era launcher
(`api.meta.ai/muse-launcher.sh`, fetched 2026-09-30) still honours the switch
and still defaults the login to `$XDG_CONFIG_HOME` or `~/.config/muse/auth.json`.
Copilot's row is 1.0.89 (2026-09-30, from the npm package, not live): `-p`,
`--continue`, `session-state` under `COPILOT_HOME`/home, and `authTokens` /
`storeTokenPlaintext` in the runtime it unpacks into `~/.cache/copilot/pkg/`.

The `tabtivity-send` hint (`services/agent_hint.rs`, 2026-10-01) leans on each
CLI's session-start context channel; re-check it on update. Gemini, Qwen,
Auggie, CodeBuddy: `settings.json` `hooks.SessionStart[].hooks[]`, stdout JSON
`hookSpecificOutput.additionalContext` (Gemini requires stdout to be JSON only).
Droid: `~/.factory/hooks.json` with the events at the top level, plain stdout.
Cursor: `~/.cursor/hooks.json` `hooks.sessionStart[]`, `{"additional_context"}`
(its forum reports the context dropped on some first messages). Copilot: every
`*.json` in `~/.copilot/hooks/`, the `bash`/`powershell` command printing
`{"additionalContext"}` — probed live on 1.0.88 (2026-10-01). Vibe (hooks are
`pre_tool`/`post_tool`/`post_agent` only) and OpenCode (no start hook outside
the experimental plugin API) get instructions instead: a marker block in
`~/.vibe/AGENTS.md`, and for OpenCode `<state_dir>/hooks/tabtivity_agent_hint.md`
in `~/.config/opencode/opencode.json` `instructions` (its global `AGENTS.md`
would shadow the `~/.claude/CLAUDE.md` fallback). All but Copilot are from the vendors'
docs, not live.

A fenced tab resumes only if its session store is mounted into the fence:
`sandbox::agent_home_mounts` lists each continue-last agent's store (OpenCode
`~/.local/share/opencode`, Qwen `~/.qwen/projects`, Copilot
`~/.copilot/session-state`, Cursor `~/.cursor/chats`, Vibe `~/.vibe/logs`;
Antigravity rides on `~/.gemini`). A CLI that moves its store breaks resume
silently — re-check the path on update.

Copilot's fenced sign-in (`services/copilot_auth.rs`) depends on its config
layout: a `/login` with `storeTokenPlaintext` on writes the token to
`~/.copilot/config.json` under `authTokens` (earlier 1.0.88 runtimes:
`copilotTokens`; 0.0.x: `copilot_tokens`), keyed
`"<host>:<login>"`, beside `lastLoggedInUser`; Copilot reads
`COPILOT_GITHUB_TOKEN` before any stored login. Checked against 1.0.88. If a
release moves the token, fenced tabs go back to asking for a login each time
(nothing breaks). Check with `strings` on
`~/.cache/copilot/pkg/linux-x64/<ver>/prebuilds/linux-x64/runtime.node | grep
-E 'authTokens|storeTokenPlaintext'` and
`cargo test --manifest-path src-tauri/Cargo.toml copilot_auth`.

**OpenCode's minimal interface** is read by the phone since 2026-09-18
(`mobile-web/src/terminal/openCodeMini.ts`, verified against 1.18.31 by live
capture). It assumes, of `opencode --mini`: the status row ` BUILD  223.0K
(21%) · ctrl+p cmd` as the last row of every frame (agent in capitals, a notice
slot, tokens used); the turn footer `▣ Build · <model> · 6.2s`; the tool glyphs
`→ ✱ ◈ % ✗` and `# … Task`; the banner `█▀▀█  OpenCode`; the box hint `Ask
anything…`; that it wraps its own rows at the pane width; that **no key
switches its agent** in mini (Tab/Shift+Tab and `<leader>` are the full TUI's);
that there is **no `/model`** (`/editor /exit /init /new /review /skills` only)
and the picker opens with ctrl+p → `model` → Enter, filters on typed text and
clears with ctrl+u. A release that changes any of those degrades the phone's
Focus view for OpenCode; a release that adds an agent switch to mini would let
the `fixed` flag in `agentModes.ts` be dropped.

**Antigravity's model and effort** are read by the phone since 2026-09-20
(`mobile-web/src/terminal/antigravity.ts`, verified against 1.2.7 by a pty
capture; 1.2.14 by a tmux capture at 80×24 on 2026-09-30, run through
`readableScreen` and the parsers: six rows, `[1-6 of 7 items]`, three effort
stops — the 1.2.11 gauge rework left the slider's shape as below, and 1.2.9's
dialog is byte-identical). Since at least 1.2.9 an underline row
(`──────────`) sits under `Search:`; `readableScreen` drops it, so a parser fed
raw rows would miss the list. A fresh home opens on a theme picker, a
data-sharing opt-in (leave it unticked) and a folder-trust prompt. It assumes, of `agy`: the footer row under the input box, with
`? for shortcuts` on the left and the model right-aligned, the reasoning effort
after a ` · ` where the model has one (`Gemini 3.8 Flash · high`); the `/model`
dialog's heading `Switch Model` and its `Search:` field; unnumbered rows, two
spaces in, the highlighted one marked `>` and the session's own noted
`(current)`; the window note `[1-6 of 7 items]`, which is what numbers the rows;
and the effort slider `Effort ◂ ●━━━◉───○ ▸` over a row of stop labels, moved
one stop per ←/→ and applied with the model on Enter. The dialog is drawn
*below* the input box, which is where `inputFrameStart` cuts. A release that
changes any of those leaves the model chip on the tab's last known model and
the sheet without its rows. `agy models` lists the model ids and their efforts
(`gemini-3.1-pro-{high,low}` — no medium), which is the quickest check that the
list still looks as the sheet expects.

Vibe and Copilot are full-screen (alternate-screen) TUIs, as plain `opencode`
is; the phone's Focus view cannot read them — a release that changes that is an
*opportunity*, not a break. Copilot has been alt-screen unconditionally since 1.0.12 (its
`--alt-screen` flag was removed). Copilot 1.0.81–1.0.82 also offered to restore
interrupted sessions at startup, a prompt a restored tab would open on; 1.0.83
turned it off by default. Vibe 2.25.4 still has `-c/--continue` and
`-p/--prompt` (read out of the wheel, 2026-09-15); 2.25.8 too (2026-09-30),
with `--resume [SESSION_ID]`, the `post_agent` hook type in `hooks.toml` whose
payload carries `session_id`, and `logs/session/unified/<id>/CURRENT` — what
`resolve_vibe_session` relies on. Cursor 2026.09.28 keeps `-p/--print`,
`--continue` and its chats under `~/.cursor`. Aider 0.86.2 (latest) needs
only its binary name and `aider.chat/install.sh`, still served. Droid, OpenClaw and OpenCode are also `LOCAL_DRIVERS` (Ollama-backed
tabs via `ollama launch <agent>`).

### 1.6 Token usage records (Claude, Codex)

**Where** `services/token_stats.rs` (scan + cache), `commands/usage_stats.rs`
(`usage_token_stats`), `src/lib/tokenStats.ts` (the recap's Tokens section).
Plan: `docs/token_stats_plan.md`; context: `docs/context/usage_stats.md`.

**Assumes** (checked against live files, 2026-10-01)

- **Claude** — `<home>/.claude/projects/<slug>/<session>.jsonl` and
  `<slug>/<session>/subagents/agent-<id>.jsonl`. Assistant records carry
  `message.usage` with `input_tokens` (fresh, **excludes** cache),
  `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`
  (thinking included), plus `message.model`, `message.id`, top-level
  `requestId` and an ISO-UTC `timestamp`. `<synthetic>` models are skipped.
- **Claude writes one message on several adjacent lines**, one per content
  block, and they are *not* identical: the first is written mid-stream, so
  `output_tokens` can **grow** from one line to the next (1727 of 56728
  duplicate lines on live data). The scan keys a message on
  `(message.id, requestId)` and keeps the **largest value per field** — not
  the first line, not the sum. A release that stops repeating lines is
  harmless; one that spreads a message's lines further apart than the dedupe
  window (`DEDUPE_WINDOW`) would double-count.
- **Codex** — `<home>/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`,
  `event_msg` records with `payload.type == "token_count"` and
  `payload.info.total_token_usage` {`input_tokens` (**includes** cached),
  `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`}. Codex
  repeats a `token_count` without a new turn, so the scan counts **deltas of
  `total_token_usage`** between events, never `last_token_usage`; a total that
  goes *down* restarts the baseline (a new thread in the same file). Input is
  normalized: fresh = `input − cached − cache_write` (floor 0), cache read =
  `cached_input_tokens`, cache write = `cache_write_input_tokens`. The model
  comes from the preceding `turn_context`'s `payload.model`.
- **Codex fallback** — a thread with no rollout counts
  `threads.tokens_used` from `state_<n>.sqlite` as an unsplit `tokens.total`
  (shown as "no split reported").

**Verify** after a Claude or Codex update: `cargo test --manifest-path
src-tauri/Cargo.toml token_stats`; then in a fresh tab do a turn and compare the
recap's Tokens row with the CLI's own `/usage` (Claude) or `/status` (Codex)
for that session. Grep a new transcript for the field names above — a renamed
field reads as zero tokens, not as an error. If a field's meaning changes
(e.g. Claude's `input_tokens` starts including cache), bump `CACHE_VERSION` in
`token_stats.rs` so the cache rebuilds.

---

## 2. Ollama

**Where** `commands/ollama.rs` (everything), `services/mail_ai.rs`,
`src/lib/ollamaStatus.ts`, `src/lib/agents/localDrivers.ts`, `src/lib/gpu.ts`.
Headless probe: `cargo run --example ollama_probe --manifest-path src-tauri/Cargo.toml`.

**Assumes**

- HTTP/1.0 over a raw TCP stream to `127.0.0.1:11434` (or `Settings::ollama_host`),
  endpoints `/api/tags`, `/api/ps`, `/api/show`, `/api/pull`, `/api/generate`,
  `/api/chat` (mail assistant, `system` role, verified against llama3.2:3b),
  `/api/version`.
- Fields read: `models[].{name,size,digest,details.{family,parameter_size,
  quantization_level}}`, `/api/ps` `size_vram` and `expires_at`, `/api/show`
  `capabilities` (`tools`, `thinking`, `embedding`) and `model_info.*.context_length`
  (matched by *suffix*, so new architectures need no table entry), `keep_alive`,
  `options.num_gpu` (`auto` omits it, `gpu` = `MAX_GPU_LAYERS`, `cpu` = `0`).
- Registry update check: HEAD on the model manifest, `ollama-content-digest`
  response header compared with the local digest.
- `ollama --version` prints `ollama version is X.Y.Z` (a warning line may
  precede it; `parse_version` scans for a version token). Newest release via
  the GitHub releases API.
- `ollama launch <agent> --model <m>` exists since **0.15** and is the only way
  to hand Claude Code an Anthropic-compatible endpoint; sub-commands used:
  `claude`, `codex`, `droid`, `openclaw`, `pi`, `cline` (OpenCode never goes
  through it). `ollama launch --help` is read to learn whether the subcommand
  exists. `launch` writes `~/.codex/model.json`, Pi's `models.json` (and
  migrates a legacy `@mariozechner/pi-coding-agent` install with `npm -g`),
  and Cline's `providers.json` + `globalState.json` — Cline's login file
  (per scope since 2026-10-08, not shared); a local-model home stays
  receive-only in `agent_auth` for every shared login. Before ~0.34 it forwarded
  no extra flags; 0.34 passes args after `--`, which Tabtivity doesn't use yet.
- **≥ 0.32 drops integrated GPUs** unless `OLLAMA_IGPU_ENABLE=1`; Tabtivity sets it
  on the server it spawns and offers a systemd drop-in for the unit. The flag's
  existence is read from `ollama serve --help`, not from the version.
- `OLLAMA_HOST`, `OLLAMA_MODELS` env semantics (a bare number is a port).
- systemd unit named `ollama` (`systemctl is-active/show -p User/start/stop`),
  install via `curl -fsSL https://ollama.com/install.sh | sh`, `winget
  install --id Ollama.Ollama`, macOS `launchctl setenv`.
- Error strings matched literally: `does not support tools`,
  `"<model>" does not support thinking`, `dropping integrated GPU`,
  `Model metadata for '<model>' not found`.
- Default model names used as examples in tests/UI (`qwen2.5-coder:7b`,
  `qwen3-coder`, `llama3.2`, `nomic-embed-text`, …) — cosmetic, but a
  renamed tag makes an example install fail.

**Verify**

```sh
ollama --version; ollama serve --help | grep -i igpu; ollama launch --help
curl -s localhost:11434/api/show -d '{"model":"<any>"}' | jq '.capabilities, (.model_info|keys)'
cargo run --example ollama_probe --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml ollama
```

Release-note triggers: any `/api/*` shape change, a new capability keyword,
`launch` gaining/losing agents or flags, GPU discovery changes, the version
string format, a rename of the systemd unit.

---

### 2.1 Copilot Language Server (autocomplete, Group M #45a)

**Where** `services/copilot/`, `src/lib/viewers/completion/completionProvider.ts`,
`scripts/copilot-probe.py`, `docs/context/copilot_completion.md`.
`commands/copilot.rs`, `CopilotCompletionCard.tsx`. Separate from the Copilot
agent CLI. Behind the `copilot_completion` experimental flag; the pinned version
is `services/copilot/process.rs` `SERVER_VERSION` (install dir and npm spec follow it).

**Protocol reference** [GitHub's official server](https://github.com/github/copilot-language-server-release).
Inspected/probed **1.547.0**, Linux x64, 2026-09-18. Native npm packages list
Linux/macOS/Windows x64/arm64; upstream also documents Node >=20.8.

**Assumes** stdio Content-Length framing; initialize/initialized; incremental
didOpen/didChange/didClose plus didFocus; inlineCompletion includes document
version and returns original items; cancel uses `$/cancelRequest`; shown and
partial acceptance preserve the full original item, with cumulative UTF-16
acceptedLength; full acceptance executes the returned command. Status and
account/billing messages must be handled. Recheck all fields on server upgrades.

**Credential finding** 1.547.0's bundled implementation creates `auth.db` with a
plaintext writer. Do not infer keychain protection from its keytar dependency.
The synthetic probe blocks that file and exercises the in-memory fallback;
authenticated behavior and production credential policy are still unverified.

**Unverified calls** `signIn` (→ `userCode`, `verificationUri`, `command`),
finishing it via `workspace/executeCommand`, `signOut` and `checkStatus`
(→ `status`, `user`) are written from upstream's README and tested only
against a fake server. `didChangeStatus` `kind`/`message` likewise.

**Verify** after bumping `SERVER_VERSION`, the real server inside the real fence:
`TABTIVITY_COPILOT_INSTALL=<npm prefix> cargo test --manifest-path src-tauri/Cargo.toml --lib copilot -- --ignored`
(initialize + unauthenticated error 1000 through `session.rs`). Also
`python3 scripts/copilot-probe.py /absolute/path/to/copilot-language-server`
without launching Tabtivity. It currently verifies initialization, unsaved document
sync, unauthenticated error 1000 and cancellation -32800 only. Before release,
also verify device sign-in/sign-out, credential persistence policy, exclusions,
workspace filesystem reads, quota messages and accepted-item offsets against a
real signed-in session. Never capture tokens or raw protocol logs.

---

## 3. Tailscale (Tabtivity Mobile)

**Where** `services/mobile_control/config.rs` (`verify_tailscale_serve`,
detect settings), `services/mobile_control/host.rs`, `src/components/mobile/
MobileSettings.tsx` (the guide command), `mobile-web/src/connection.ts`.

**Assumes**

- `tailscale serve status --json` exists and returns `Web.<authority>.Handlers.
  "/".Proxy` plus `AllowFunnel.<authority>`; exactly one eligible HTTPS
  mapping proxying to `http://127.0.0.1:<port>`; Funnel must be **off** (refused
  otherwise).
- The guide tells the user `tailscale serve --bg http://127.0.0.1:<port>`.
- MagicDNS `*.ts.net` origins; re-verification after a `tailscaled` restart.

**Verify**

```sh
tailscale version; tailscale serve status --json | jq '.Web, .AllowFunnel'
cargo test --manifest-path src-tauri/Cargo.toml mobile_control::config
```

Triggers: `serve` JSON schema changes (they have renamed keys before), `--bg`
semantics, Funnel defaults, a new "Services" mapping type that the detector
should treat as eligible or not.

---

## 4. tmux

**Where** `services/tmux_local.rs`, `services/remote.rs` (remote tabs),
`src/lib/terminal/tmuxSession.ts`, `services/mobile_control/*` (phone replay),
`docs/context/tmux_sessions.md`.

**Assumes** `tmux -V` parses as `tmux <major>.<minor>[letter]` (`next-3.4`
too); `-e KEY=VAL` on `new-session` needs **≥ 3.2** (older exports the key
from the shell instead); `history-limit` option; `ls -F …`, `kill-session -t`,
`rename-session -t`, `capture-pane` before attach; standalone `;` splits argv;
new sessions inherit the *server's* global environment; the client refuses an
argv over `MAX_IMSGSIZE` (16384 bytes) with `command too long`, which is why a
long command line (a fenced agent's bubblewrap argv) is moved into
`<state_dir>/tmux-launch/<session>.sh` (`tmux_local::TMUX_ARGV_LIMIT`). That
script is on disk, so `tmux_local::SECRET_ENV` values never go into it. The pane
runs its command through `sh -c` and follows it with the login shell; after a
fenced command it first drains the input queue with `stty -g`, `stty raw -echo
min 0 time 0` and `cat` (POSIX `stty`, where `min 0 time 0` makes an empty queue
read as end-of-file).

**Verify** `tmux -V`; `cargo test --manifest-path src-tauri/Cargo.toml tmux`.
Also check the remote host's tmux, which is usually older.

---

## 5. Docker (project containers)

**Where** `services/sandbox.rs`, `docs/context/docker_containers.md`.

**Assumes** `docker --version`, `ps --filter label=… --format`, `run -d --init
--name --label --user 1000:1000 --cap-drop --security-opt --pids-limit
--memory --cpus --network --read-only --tmpfs … sleep infinity`, `exec`,
`rm -f`, `build -t`, `pull`; the image tag Tabtivity builds/pulls; bind-mount of
the project at its identical absolute path.

**Verify** `docker --version; docker run --help | grep -E 'pids-limit|init'`;
`cargo test --manifest-path src-tauri/Cargo.toml sandbox`. Podman is not
supported; a `docker` shim over podman will surface here.

---

## 6. QEMU / cloud images (VM projects)

**Where** `services/vm.rs`, `commands/vm.rs`, `docs/context/vm_projects.md`.

**Assumes** `qemu-system-x86_64` (`qemu-system-aarch64` on arm64 hosts) with
`-enable-kvm` / `-accel hvf` / `-accel whpx` per host, `-daemonize` except on
Windows (spawned detached, pidfile polled), virtio devices, `qemu-img`, one of
`genisoimage -output … | mkisofs | cloud-localds` for the cloud-init seed or
the in-process `services::iso9660` writer, a `qmp.sock` (loopback TCP on
Windows), `qemu.pid`, `serial.log`, the arm64 `edk2-aarch64-code.fd` firmware
under QEMU's share dir; the cloud image
download URL + `SHA256SUMS` of the chosen distro release; a proxy at
`http://10.0.2.100:3128` <!-- privacy-check: ok — QEMU slirp, not a real host -->for the egress knob. Never live-booted so far — a
distro that rotates its cloud-image URL or checksum file name breaks silently.

The doctor's install button additionally assumes **package names**: apt
`qemu-system-x86` / `qemu-system-arm` + `qemu-utils` + `qemu-efi-aarch64` +
`genisoimage`, Homebrew `qemu` + `xorriso`, and the winget id
`SoftwareFreedomConservancy.QEMU`. A renamed package makes the button fail in
its terminal tab (visibly, at least) rather than silently.

**Verify** `qemu-system-x86_64 --version; qemu-img --version`; the image URL
resolves; the package names above still resolve (`apt-cache policy <pkg>`,
`brew info qemu`, `winget show SoftwareFreedomConservancy.QEMU`);
`cargo test --manifest-path src-tauri/Cargo.toml vm::`.

---

## 7. bubblewrap (agent fence)

**Where** `services/agent_fence.rs`, `src/lib/agents/agentFence.ts`,
`docs/context/agent_authority.md`.

**Assumes** `bwrap` flags `--ro-bind --ro-bind-try --bind --bind-try --dev
--proc --tmpfs --symlink --unshare-pid --die-with-parent --chdir` — **not**
`--new-session` (see `docs/context/agent_authority.md`: it costs the agent
`SIGWINCH`; `TIOCSTI` is handled by the tmux pane's drain instead); unprivileged user namespaces allowed (AppArmor on Ubuntu ≥ 23.10
restricts them); missing/unusable bwrap **fails closed**. The per-agent home
list in §1 is what the fence exposes. A `--bind` of a single *file* pins its
inode and makes `rename(2)` onto it `EBUSY` — which is why the config shadows
are symlinks into one mounted stage and the Claude credential file is an
in-place-rewritten mirror (§1.1).

**Verify** `bwrap --version; bwrap --ro-bind / / --unshare-pid true`;
`cargo test --manifest-path src-tauri/Cargo.toml agent_fence`.

---

## 8. OpenVPN + polkit

**Where** `services/openvpn.rs`, `commands/openvpn.rs`,
`docs/context/openvpn.md`.

**Assumes** `pkexec openvpn --config --daemon --writepid --log --management
--verb --mute --connect-retry-max --connect-timeout --persist-tun
--auth-nocache` and, depending on the config, `--auth-user-pass` (file) or
`--askpass`; the management-interface protocol (`>PASSWORD:`, `>STATE:`, <!-- privacy-check: ok — OpenVPN management-protocol tokens, not a credential -->
`>HOLD:` lines) for status and teardown; `openvpn.exe` on Windows; config
directives `auth-user-pass` / encrypted key detection by text.

**Verify** `openvpn --version`; connect once via the header indicator and
watch the progress stream; `cargo test --manifest-path src-tauri/Cargo.toml openvpn`.

---

## 9. OpenSSH, SFTP, rsync, git

**Where** `services/remote.rs`, `ssh_common.rs`, `ssh_exec.rs`, `sftp.rs`
(`openssh-sftp-client` crate), `remote_credentials.rs`, `remote_sync.rs`,
`worker_sync.rs`, `git_peer.rs`, `docs/context/remote_credentials.md`,
`docs/context/git_sync.md`.

**Assumes**

- `-o ControlMaster=auto -o ControlPath=<state>/ssh-control/cm-<hash>
  -o ControlPersist=… -o ServerAliveInterval/CountMax`; `SSH_ASKPASS` +
  `SSH_ASKPASS_REQUIRE=force` (OpenSSH **≥ 8.4**) for passwords on Unix,
  `sshpass -e` on Windows; OpenSSH re-asks a rejected passphrase three times.
- `ssh-keygen -F/-l/-lf -/-t ed25519`, `ssh-keyscan` for host keys.
- rsync present on **both** ends for the bulk fast path (`rsync >/dev/null
  && echo tabtivity-rsync-yes`), pull-only.
- `git bundle create … --not …` and git's literal refusal text; `-c
  core.hooksPath=` suppresses hooks (verified against git 2.53.0);
  `GIT_OPTIONAL_LOCKS=0`.
- The import dialog's visibility probe (`git_remote_visibility`) reads
  `git ls-remote`'s **exit status plus its refusal wording** — "could not read
  Username", "Authentication failed", "terminal prompts disabled", "Repository
  not found", "access denied", 403/404 — to tell a private repo from an
  unreachable host, with `-c credential.helper=` clearing the helper list and
  `http.lowSpeedLimit`/`http.lowSpeedTime` bounding a stall. Reworded errors
  degrade to "unknown", which leaves the field on its private default.
- `keyring` crate → Secret Service / KWallet / keyutils / Windows Credential
  Manager / macOS Keychain; a locked keyring answers within 4 s or shows amber.

**Verify** `ssh -V; rsync --version | head -1; git --version`;
`cargo test --manifest-path src-tauri/Cargo.toml remote`; connect a remote
project and run the lockstep matrix (`docs/git_lockstep_case_matrix.md`).

---

## 10. GPU tooling, SLURM, HPC probes

**Where** `src-tauri/src/gpustat.rs`, `sysstat.rs`, `services/remote_usage.rs`,
`commands/slurm.rs`, `src/lib/remote/hpc/slurm.ts`, `services/hpc_mode.rs`,
`docs/context/hpc_careful_mode.md`.

**Assumes**

- `nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu,
  temperature.gpu,power.draw,power.limit,clocks.sm,clocks.mem,fan.speed,
  driver_version,pcie.link.gen.current,pcie.link.width.current
  --format=csv,noheader,nounits` and `--query-compute-apps=pid,process_name,
  used_memory`; `[N/A]` cells; the same parser runs on remote hosts.
- AMD/Intel via `/sys/class/drm/card*` and `/sys/class/hwmon/hwmon*`;
  `/proc/{stat,meminfo,loadavg,uptime}`; `ps -eo user,pid,pcpu,pmem,comm`.
- SLURM: `squeue --me --noheader -o '%i %j %T %M %R'` (falls back to `-u`),
  `scontrol show job <id>`, `sbatch`, `scancel`, `srun --pty … bash -l`;
  `command -v sbatch` to classify a host; the literal `sbatch: error: Batch
  job submission failed` text.

**Verify** `nvidia-smi --query-gpu=… --format=csv` on the driver in question;
`squeue --version` on the cluster; `cargo test --manifest-path
src-tauri/Cargo.toml -- gpustat slurm`.

---

## 11. TeX toolchain

**Where** `commands/tex.rs`, `commands/synctex.rs`, `src/lib/viewers/tex/texPdfLink.ts`,
`src/lib/viewers/*`, `docs/context` (none) — see `src-tauri/CLAUDE.md`.

**Assumes** `latexmk` argv per engine (pdflatex/xelatex/lualatex, shell-escape
opt-in), `bibtex`/`biber` reruns, `kpsewhich`, the `.synctex(.gz)` record
format (`Input:` mid-file, `72/72.27` sp→bp; LuaTeX + `luaotfload` tag
artefacts; beamer `\end{frame}` runs), `synctex edit` CLI as fallback, and
`pdfjs-dist` **≥ 6.x** for beamer shadows (below 6, black bars).

**Verify** `latexmk --version; synctex help`; `cargo run --example
synctex_probe --manifest-path src-tauri/Cargo.toml`; compile a beamer deck
after any TeX Live / pdf.js bump.

---

## 12. Mail servers (IMAP/SMTP)

**Where** `services/mail_engine.rs` (`async-imap`, `mail-send`, `mail-parser`,
`rustls-platform-verifier`), `mail_authres.rs`, `mail_sanitize.rs`
(`ammonia`), `docs/context/mail_encryption.md`, `docs/mail_qa_gmail.md`.

**Assumes** IMAP `IDLE`, `MOVE`, folder listing; Gmail's `[Gmail]/All Mail`,
`[Gmail]/Entwürfe` (modified-UTF-7 names) and app-password login (no OAuth);
`Authentication-Results` header grammar for the DKIM/SPF lamps; provider TLS
certs validated by the platform verifier. Rust crates own the protocol — an
`async-imap` / `rustls` major bump is the real risk.

**Verify** `cargo run --example mail_probe --manifest-path src-tauri/Cargo.toml`
against a test account, then the `docs/mail_qa_gmail.md` checklist;
`cargo test --manifest-path src-tauri/Cargo.toml mail_`.

---

## 13. CalDAV servers

**Where** `services/caldav.rs`, `commands/caldav.rs`, `src/lib/calendar/caldav*.ts`,
`docs/context/caldav.md`.

**Assumes** RFC 4791/6578 REPORT bodies, `/.well-known/caldav` discovery,
Radicale path-only hrefs, SOGo's namespace-prefix pickiness, merge-by-resource-URL
sync. A server upgrade (Nextcloud, Radicale, SOGo, iCloud) can change href
shape or ctag/sync-token behaviour.

**Verify** sync against the server in question, then `cargo test
--manifest-path src-tauri/Cargo.toml caldav`.

---

## 14. Desktop shells and host tools

**Where** `src-tauri/src/platform/{x11,wayland_kde,windows,macos,null}.rs`,
`commands/{default_apps,apps,workspace,screenshot,printing,clipboard,format}.rs`.

**Assumes**

- KDE: DBus `org.kde.KWin` scripting + `org.kde.KWin.VirtualDesktopManager`,
  `org.kde.plasmashell`; `workspace.*` JS API inside KWin scripts (Plasma 6
  renamed several members once already).
- Cinnamon/Muffin: `gsettings` schemas `org.cinnamon.desktop.wm.preferences`,
  `org.cinnamon.muffin`; X11 EWMH atoms `_NET_CLIENT_LIST(_STACKING)`,
  `_NET_WM_DESKTOP`, `_NET_CURRENT_DESKTOP`, `_NET_NUMBER_OF_DESKTOPS`,
  `_NET_WM_PID`, `_NET_WM_NAME`; `XDG_CURRENT_DESKTOP`, `XDG_DATA_{HOME,DIRS}`.
- Default apps: `xdg-mime query/default`; app launch via `.desktop` files.
- Screenshots: `spectacle | flameshot | gnome-screenshot | scrot | maim | grim |
  import`, `screencapture` (macOS), PowerShell (Windows) — first one found wins.
  Under Wayland with no tool configured, the desktop portal comes first:
  `org.freedesktop.portal.Screenshot.Screenshot` with `interactive: true`, the
  `Response` signal on `/org/freedesktop/portal/desktop/request/<sender>/<token>`,
  and a `file://` `uri` in its results (`commands/screenshot.rs`, `portal`).
- Wayland: `WAYLAND_DISPLAY` decides that X11 window scans are skipped
  (`platform::x11::session_is_wayland`), that popout positions are treated as
  unreadable, and that the presenter fullscreens by output index through
  `gtk_window_fullscreen_on_monitor` (GDK's monitor order == tao's).
- Printing: `lp`, `lpstat` (CUPS). The print preview's job progress also asks
  CUPS over IPP — one `Get-Jobs` for `job-impressions-completed` (falling back to
  `job-media-sheets-completed`), `job-impressions`, `time-at-processing` and
  `job-printer-up-time` (the same epoch clock, verified against CUPS 2.4) — at
  `CUPS_SERVER`, `client.conf`'s `ServerName`, the local socket or
  `localhost:631`, loopback only; Windows reads `Get-PrintJob`'s
  `PagesPrinted`/`TotalPages`. Clipboard: `arboard` with
  `wayland-data-control`. Formatters: `prettier`, `rustfmt`, `black`, `gofmt`.
- Power: `systemctl`, `starship-battery`; network: `ss`.

**Verify** after a desktop-environment upgrade: switch projects and confirm the
workspace follows; run `xprop` on the window (see
`memory: project_xprop_window_debug`); take a screenshot from the tab menu — on
Wayland, that is the shell's own picker via the portal.

---

## 15. Git hosting CLIs

**Where** `commands/git_hosting.rs`, `git_fork.rs`, `git_publish.rs`,
`services/git_credentials.rs`.

**Assumes** `gh auth login/status`, `gh api`, `gh repo create`; `glab auth
login`, `glab api`, `glab repo create/edit`; the login-status text each
prints (parsed to learn the account); token env vars honoured by each CLI.

**Verify** `gh --version; glab --version`; publish a throwaway repo.

---

## 16. Python environment tooling

**Where** `commands/python.rs`, `src/lib/terminal/pythonRun.ts`.

**Assumes** `conda env list` output shape (`#` comments, `name  prefix`),
`poetry env info`, active venv detection; interpreter precedence is ranked in
the backend only. `uv`, `pixi`, `pyenv` are not ranked — a user on those sees
the system interpreter.

**Verify** `conda env list; poetry --version`; `cargo test --manifest-path
src-tauri/Cargo.toml python`.

---

## 17. Spell dictionaries

**Where** `services/spell.rs` (`spellbook` crate), `commands/spell.rs`,
`src/lib/spellDictionaries.ts`.

**Assumes** `https://raw.githubusercontent.com/wooorm/dictionaries/main/
dictionaries/<code>/index.{aff,dic}` layout and Hunspell locale codes
(`hunspellToBcp47`); LibreOffice-style `.aff/.dic` pairs.

**Verify** fetch one dictionary from the UI after a `wooorm/dictionaries`
restructure or a `spellbook` bump.

---

## 18. Agent Skills

**Where** `services/skills.rs`, `commands/skills.rs`, `src/lib/agents/skills.ts`,
`docs/skills_plan.md`.

**Assumes** the `SKILL.md` frontmatter (`name`, `description`), install
target `.claude/skills/<name>/`, catalog source
`https://github.com/anthropics/skills` (cloned). Other agents' skill dirs are
not written.

**Verify** import one skill from the catalog after an upstream spec change;
`cargo test --manifest-path src-tauri/Cargo.toml skills`.

---

## 19. Runtime and dependency floors

| Dependency | Pinned / floor | Why it is load-bearing |
|------------|----------------|------------------------|
| WebKitGTK | 2.52 observed | no renderer-pid API (watchdog probes instead); scrollbar built once; DMABUF off (flicker + SIGBUS) |
| Tauri / wry / plugins | `^2` | IPC fallback path evaluates PDF bytes as script — keep the custom protocol |
| `tauri-runtime-wry` | patched 2.11.3 (`src-tauri/patches/`, root `Cargo.toml` `[patch.crates-io]`) | `Context.main_thread` behind an `Arc`, or off-thread `AppHandle` clones race tao's Linux `Rc` and corrupt the heap. On a tauri bump: re-copy the new version and re-apply the `TABTIVITY PATCH` hunk, or drop the patch once upstream fixes it |
| `@xterm/xterm` + addons | `^5.5`, webgl `^0.18` | key encodings (`ESC [ Z`, CSI-u) the mobile bridge relies on |
| `pdfjs-dist` | `^6.3` (floor 6.0) | beamer shadow compositing |
| `portable-pty` | 0.9 | PTY registry / reconnect |
| `keyring` | 3 | platform credential stores |
| `async-imap`, `mail-send`, `mail-parser`, `rustls` 0.23 | see `Cargo.toml` | mail protocol + TLS |
| `openssh-sftp-client` | 0.15 | SFTP over the ControlMaster |
| `zbus`, `xcb` | — | DBus/X11 desktop integration |
| `spellbook` | 0.4 | Hunspell-compatible checker |
| `mermaid`, `katex` | `^11`, `^0.17` | markdown viewers |

On a bump: `npm run build && npm test`, `cargo test`, `cargo clippy
--all-targets -- -D warnings` (CI uses *today's* stable — `rustup update`
first), then `npm run package:dev` and click through the viewers.

---

## 20. Tabtivity's own updater

**Where** `services/app_update.rs`, `commands/app_update.rs`.

**Assumes** `https://api.github.com/repos/fseiffarth/tabtivity/releases/latest`
(unauthenticated, rate-limited), asset names
`tabtivity_<v>_amd64.AppImage`, `Tabtivity_<v>_x64-setup.exe`, `.dmg`, `.deb`,
download only from `https://github.com/fseiffarth/tabtivity/releases/download/`.
A GitHub API or release-naming change breaks the update banner.

**Verify** `curl -s https://api.github.com/repos/fseiffarth/tabtivity/releases/latest | jq '.assets[].name'`.

---

## 21. Quick routine after any update

```sh
rustup update && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
npm run build && npm test && npm run lint
cargo run --example ollama_probe --manifest-path src-tauri/Cargo.toml   # if Ollama moved
cargo run --example agent_versions --manifest-path src-tauri/Cargo.toml -- --refresh
tmux -V; bwrap --version; docker --version; tailscale version; ssh -V; git --version
for a in claude codex gemini qwen vibe opencode copilot; do command -v $a >/dev/null && $a --version; done
```

The `agent_versions` example answers only for the CLIs with a recipe in
`VERSION_ARGV`; the loop below it is what covers the rest, and what a new
recipe gets added from.

Then, in a window the user launched: one agent tab per updated CLI (prompt →
decision lamp → resume after relaunch), one Ollama-backed tab, the phone's
status sheet, and a project switch on the desktop in question. Record the
verified versions in the code comments named above.
