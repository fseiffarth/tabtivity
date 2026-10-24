# Threat recheck 2026-10-24 — reviewer handoff

Raw material behind `docs/threat_recheck_2026_10_24_plan.md`: the shared brief, the three round-1 drafts (A, B, C) and the three round-2 cross-reviews, as the reviewers wrote them. Line numbers are at `21eadf64` (round 1) and `ff9f83ab` (round 2). Read-only reviews; nothing was run. Never read this file whole: `rg -n`.


---

<!-- BRIEF.md -->

## Threat recheck 2026-10-24 — shared brief for reviewers A, B, C

Repo: the project checkout (Tabtivity: Tauri 2 + React/TS
desktop app, `src/` frontend, `src-tauri/` Rust backend, `mobile-web/` phone PWA,
plus a server mode: daemon `app-serverd`, gateway, web client).
Read `AGENTS.md` first (rules, invariants, where to look).

HEAD is `21eadf64`. The last threat recheck landed at `eacfa41a` (2026-10-13).
Since then ~460 commits and ~29k inserted lines in `src-tauri/src` alone.
`git log --oneline eacfa41a..HEAD -- <paths>` and
`git diff eacfa41a..HEAD -- <paths>` show what changed in your area.

## Threat docs (the map you are re-checking)

- `docs/threat_model.md` — the model. Tiers 0–4, gap rows 1–41, hardening
  backlog. Lines are long; read only the rows in your area (`rg -n`).
- `docs/threat_recheck_2026_10_08_plan.md` — last run. Read lines 1–110
  (resume state + open follow-ups) and 1120–1152 ("Decisions", "Not
  reviewed"). The handoff file next to it is 335 KB: never read it whole,
  `rg -n` only.
- `docs/safe_for_everyone_plan.md`, `docs/sandbox_hardening_plan.md`,
  `docs/CODE_REVIEW_SECURITY.md`, `todo/group-o-security.md` (big: `rg -n`
  only), `docs/server.md` + `docs/tabtivity_hosted_plan.md` (server
  threat model), `docs/context/<subsystem>.md` for your area.
- File maps: `docs/filemap_backend.md`, `docs/filemap_frontend.md` — grep, never
  read whole.

## Your job (round 1)

1. **Row audit.** For each threat-model row/gap in your area: does the stated
   defence still hold in HEAD? Is the text stale (code moved, feature changed,
   residual since closed, new residual)? Cite `file:line` at HEAD.
2. **New surface.** Review the code added or changed since `eacfa41a` in your
   area for attack paths the model does not list. Same attacker model as the
   threat doc: hostile project folder / repo, hostile remote host, hostile
   mail/CalDAV/web content, prompt-injected agent inside the fence, other local
   users, a paired-but-hostile or stolen phone, a hostile server-mode user
   (other tenant). Out of scope: malware already running as the user.
3. **Open follow-ups** from the last plan (lines 37–84) in your area: still
   open, fixed since, or moot?
4. **"Not reviewed"** leads (plan lines 1132–1152) assigned to you below.
5. **Fix plan.** Implementer-sized steps, one area each, with files and the
   concrete fix; flag any that need a user decision (give options and your
   recommendation).

Be concrete and evidence-based: confirm in code, state confidence
(confirmed / plausible / from docs). Prefer fewer real findings over many
speculative ones. Severity: high / medium / low, as the 2026-10-08 run used.

**Write-up style (important):** a previous reviewer's write-up was stopped
twice by a safety filter. Describe each issue defensively — what defence is
missing, where, what an attacker could reach, how to fix. **No exploit code,
no payloads, no step-by-step attack recipes.**

## Rules

- **Read-only on the repo.** Do not edit, create, stage, stash, checkout or
  commit anything in the repo (other sessions have uncommitted work there).
  Never start or stop the app. You may run read-only commands (`rg`, `git
  log/diff/show`, `cargo metadata`), but no builds or tests are needed.
- Your only output file: `/tmp/opencode/threat1024/<YOUR LETTER>.md`.
- Use subagents of your own (explore) if it helps to cover ground.

## Output format for `/tmp/opencode/threat1024/<X>.md`

```
## Reviewer <X> — <area>  (HEAD 21eadf64)

## Summary
3–6 lines: counts by severity, the one or two that matter most.

## Row audit
| Row / gap | Holds? (yes / partly / no) | Stale text or regression → proposed new wording | Evidence |

## New findings
| ID (<X>1, <X>2…) | Sev | Finding (evidence file:line) | You do (tier 0–4) | Confidence |

## Last run's follow-ups and "Not reviewed" leads
| Item | Status now | Evidence / note |

## Proposed fix steps
| Step (<X>-1…) | Findings | Files | Fix | Decision needed? |

## Decisions for the user
Each: question, options, your recommendation.

## Cross-area notes
Things you saw that belong to another reviewer's area (A/B/C), for them.

## Not reviewed
What you did not get to.
```

## Areas

**A — Agent containment, credentials, MCP lanes, host execution.**
`agent_fence` (Linux bwrap, macOS Seatbelt, Windows), `agent_home`,
`agent_auth`, `agent_global`, `launch_prep`, `terminal/mod.rs` env handling,
`terminal_service` sanitizers, `agent_relocate` (moving running agents
between worktrees), the assistant/Tabby scope (`services::assistant`,
`commands/assistant.rs`, `services::web_lane`, `docs/context/assistant.md`),
`api_proxy` / `agent_api_keys` / `api_meter` / `api_prices` (new: OpenAI/Codex
and OpenCode routed through the proxy, key checks with providers,
`opencode_models`), OpenCode 2 (`opencode_session`, `opencode_store`), Codex
hooks trust (`c4545ce9`), `agent_session`, `agent_turn`, `agent_transcript`,
`agent_chats`, `agent_changes`, `skills`, `ai_switch`, the MCP lanes (root,
schedule, git push/CI, help, markup, reader), `exec_trust`, the hardened git
builder (`96961006`, `git_bounded`, `git_guard`), `tmux_local`, containers
(`services::sandbox`), VM projects. Not-reviewed leads: processes left
detached inside a fence; approval-card races; agent-written `.tabtivity`
marker files; `tabtivity-send`; OSC 8 link spoofing and PTY output forging the
Focus/Reader parsers' states; `exec_trust` fingerprinting; `home_io`/
`agent_global` merge internals; `agent_session` transcripts through linked
directory components; the gap 16 residual (re-survey Goose `secrets.yaml`,
OpenCode `auth.json` — now OpenCode 2 —, Qoder `.auth`).

**B — Phone, remote, sync, server mode.** `services::mobile_control/*`
(host, discovery, headless, assistant, chat_uncommitted, web_client,
protocol, scheduler, uploads, files, inbox/outbox), the PWA (`mobile-web/src`,
new FilesLibrary, thumbs, Terminal, cloud-session link + teleport `f37b64c0`,
phone worktree moves `b7d0f61f`, phone Tabby, the CSP `blob:` change
`2f1c74c1`, API-key starts from the phone `20d7be47`), Tailscale Serve/Funnel
drift check, the desktop bridge for sidecar requests; server mode: daemon,
gateway, `core_dispatch`, `services::command_class` and the generated
`src/lib/transport/commandClasses.ts`, the web client, sharing, per-user
confinement (`6e8ae492`, `30c02942`, `a41799cc`, `f664c6e9`), signed `.deb`
server release; remote / SSH (`remote_target_for*`, `services::remote`,
remote credentials, multi-host), `worker_sync`, `git_peer` lockstep (new
"Local wins" `16e4f0d1`), byte-sync, `remote_sync`, `sync_auto`, `local_loss`
completeness, OpenVPN changes, HPC hosts. Not-reviewed leads: phone IndexedDB
after revoke; clock changes against limits and expiry; the hosted and
headless trust boundaries; inotify exhaustion as it affects sync.

**C — Desktop perimeter, viewers, mail/calendar, supply chain.** The webview
perimeter: capabilities, CSP (incl. `script-src blob:`, `base-uri`,
`form-action` backlog), `services::nav_gate`, popout/present/detached URL
handling, the in-app browser (`fb6232f1` refuses live-page windows on Linux;
`browser_engine` incl. `fetch_document_image` SSRF rules; Windows WebView2
`target=_blank`), WebKit GPU compositing (`cde65763`); viewers and their
parsers/save paths (`commands/fs.rs` changes, `synctex.rs` rewrite, `tex.rs`,
`presenter.rs`, `pdf_markup`/`pdf_clip`, `highlight.ts`, compare/merge views,
CSV size handling, ODT, PDF, the open-externally path and `os_open` launcher
lists), `commands/credentials.rs` (851 changed lines) and keychain call sites,
`ide_detect`/`default_apps`/`ide.rs`, `google_chat`, mail (`mail_engine`,
IMAP sync, PGP/S-MIME, filters, the review panel), CalDAV and ICS subscribe
hops (`ics.ts`, `icsSafety.ts`), the mail_reader VM lane; supply chain:
`.github/workflows/*` (ci-cd, release, security), release signing,
`scripts/` and `.githooks/`, `src-tauri/patches`, dependency pinning and
audit ignores, privacy checks, dev builds (gap 20 residual). Not-reviewed
leads: crash reports and logs (secrets in logs); `core.excludesFile` pointing
at a FIFO; other loopback services in the shared network namespace (Ollama,
dev servers) as reached from the app; WebKitGTK `about:srcdoc` CSP
inheritance; boxes and brand-migration adoption.

---

<!-- A.md -->

## Reviewer A — Agent containment, credentials, MCP lanes, host execution  (HEAD 21eadf64)

Note on HEAD: the checkout has moved on to `caf2260a` (10 mobile-only commits after
`21eadf64`: `mobile_control/*`, `ssh_exec.rs`, `remote.rs`, `paths.rs`). None of the
files cited below changed between `21eadf64` and `caf2260a`, so the `file:line`
references hold at both. Uncommitted edits in the working tree are frontend-only
(`src/`) and outside this area.

## Summary

1 high, 1 medium, 2 low new findings; 1 last-run lead confirmed (low). No earlier
gap in this area regressed.

- **A1 (high):** the shared-login keeper still shares OpenCode's `auth.json` with
  no content check. OpenCode treats a `wellknown` entry in that file as more than a
  credential: it loads remote configuration from the named origin (confirmed in the
  installed OpenCode 2.1.2 binary; OpenCode 1.x also sets a process environment
  variable from it). One fenced agent can therefore reach every other scope's
  OpenCode, the unfenced Host session's OpenCode, and the Tabby OpenCode chat
  (getting around its pinned tool set). The gap 16 residual ("credential-only per the
  2026-09-25 survey") is wrong for OpenCode.
- **A2 (medium):** the new OpenAI route through the API proxy does not handle
  Responses features that the meter cannot see. Above all, a `background` request
  answers before its usage exists, is charged almost nothing, and is billed in full
  by OpenAI later. Injected code holding a keyed Codex/OpenCode tab's proxy token can
  spend past the monthly limit without bound.
- The Tabby assistant, the web lane, Codex hook trust, the agent-global merge, the
  hardened-git source scan and approval-card digests all hold as built.

## Row audit

| Row / gap | Holds? | Stale text or regression → proposed new wording | Evidence |
|---|---|---|---|
| 1 (`~/.local/bin`, system helpers, Windows admin-locked) | yes | — | `private_file.rs:217,284`; `agent_fence.rs:1436` (`system_executable("bwrap")`) |
| 2 (hooks off, `GIT_COMMON_DIR` pinned) | yes | — | `commands/git.rs:454-475,610,631`. Every bare `git` spawn is now policed by a source-scan test (`commands/git.rs:5917ff`, commit `96961006`); the only bare spawns left in `src/` are in test modules |
| 4 (tokens off argv, tmux ≥ 3.2) | yes | Add the new slots: the web-lane token (8638) and the OpenAI carrier (8639) are in `SECRET_ENV` | `tmux_local.rs:461-489` |
| 5 (`~/.gemini` staging; OpenCode residual) | yes (not re-traced) | The residual names OpenCode `snapshot/` (V1). OpenCode 2 keeps its store in SQLite. Re-check which V2 folders stay writable and what the shared background service/PTY daemon keeps there (see "Not reviewed") | — |
| 6 (rustfmt toolchain) | yes | — | `commands/format.rs:143,257` |
| 7 (local-model homes) | yes (anchors only) | — | `agent_fence.rs:1047`; `agent_home.rs:71,85` |
| 8 (Gemini grounding metered) | yes for Gemini | **Extend:** the proxy now also forwards OpenAI `/v1/responses`. OpenAI server-tool fees (web search, file search, code-interpreter containers, image generation) are not charged after the answer (A2) | `api_meter.rs:848-858` (OpenAI usage = tokens only) |
| 9 (in-flight reservation) | partly | **New residual (A2):** an OpenAI `background` response, `service_tier` pricing and agent-chosen `OpenAI-Organization`/`OpenAI-Project` headers are outside the reservation and the meter | `api_meter.rs:683-686,948,953,970-977`; `api_proxy.rs:1271-1275,1365-1399` |
| 10 (push sends card SHA) | yes (not re-traced) | — | `git_push_mcp.rs:214` (`stale_approval`) |
| 13 (`info/exclude` by handle) | yes (anchors only) | — | `git_guard.rs` helpers |
| 15 (`git_bounded`) | yes | — | `exec_trust.rs:419-431,472-495` (bounded, fails closed into a subject) |
| 16 (shared logins) | **no** (residual wrong) | **Replace the residual:** "OpenCode `auth.json` is not credential-only: a `wellknown` entry makes OpenCode load remote configuration (2.x, verified in the binary) and, in 1.x, set an environment variable. It is shared to every home, the Host and assistant homes included, with no content check (A1). Goose `secrets.yaml` and Qoder `.auth` were not re-surveyed." Also: OpenCode 2 keeps later sign-ins in SQLite, which is not shared, but it imports a placed legacy `auth.json` | `agent_auth.rs:265-275` (`names_command` is Pi-only), `285-316` (`adopt`: account guard + Pi check only); `commands/agents.rs:258` (`auth_paths` for opencode); Host home placement `agent_auth.rs:1000-1011`, tests `:1538-1615` |
| 17 (persisted env, control vars) | yes | Add to the text: the new lane variables (web, help, markup) are control variables too | `launch_prep.rs:32-54,60-80,712`; `terminal_service.rs:517-532` |
| 18 (pre-push only in recorded fence; spawn generations) | yes | — | `launch_prep.rs:562-612`; `agent_fence.rs:2059,2123` |
| 19 (CI repo confirm, `git_at_spawn`) | yes | **Stale residual:** "Windows records only whether a `.git` was there" no longer holds. Windows now records the `.git` entry's volume serial and file id (`20b7e6a6`). The doc comment at `git_push_mcp.rs:1470-1472` is stale too. "No UI to revoke `git_ci_repos`" still holds | `git_push_mcp.rs:1473-1491`; no `git_ci_repos` UI in `src/` |
| 25 (local model confirmed local) / 33 (read-mail taint) | yes (anchors only) | — | `root_mcp.rs:304,775-789`; `root_mcp_mail.rs:70,1169` |
| 29 (agent-written records by `open_regular`) | yes for leaves | Add: "folders above the leaf are the caller's to vouch for" (`home_io.rs:891`). The Claude Resume menu does not vouch for them (A3) | `home_io.rs:888-911` |
| 30 (control pins; bwrap by name) | yes; residual unchanged | — | `agent_fence.rs:1019`; no `--ro-bind-fd` anywhere |
| Tier 0 "Loopback listeners" | partly (stale) | "The window serves `/mcp`, schedule, git, help, markup **and `/mcp/web`** (assistant lane); the Mobile host serves schedule, git, help **and web**" | `commands/root_mcp.rs:596,920,608-621`; `mobile_control/host.rs:9626` |
| Tier 0 "Agent API proxy" | partly (stale) | "Provider keys (Anthropic, Gemini, **OpenAI**) …; a keyed Claude, Gemini, **Codex or OpenCode** tab gets a per-tab token (OpenCode through its inline config, token by `{env:…}`)…; saving a key sends it once to the provider's own `/v1/models` to check it." Add A2's residual | `api_proxy.rs:112-116,662-733`; `agent_api_keys.rs:473-508,661-680` |
| Tier 3 "Fenced agent on Linux" | yes; text stale | "A keyed Claude/Gemini tab" → "a keyed Claude, Gemini, Codex or OpenCode tab". The fence has no `--new-session`. TIOCSTI is handled by the tmux trailing-shell drain plus the pid namespace (`tmux_local.rs:360-397`, `agent_fence.rs:1372-1373`); say so in the row | `agent_fence.rs:3257` asserts no `--new-session` |
| Tier 3 "Host session" | partly | Add: the Host home receives every shared login file, so A1 reaches an OpenCode started there | as row 16 |
| Tier 3 — **missing row: Tabby assistant + web lane** | new | Proposed row: "**Tabby (assistant scope)**: reserved scope `assistant`, empty chat folder, no roots and no allowlist, a home of its own without the agent-global layer. The CLI's tool set is pinned (web search; lane `web_fetch`/`web_search`; help docs). Page fetches run on the host through `services::web_lane` (public addresses only, DNS-pinned per hop, no proxy, text only, 120 calls/tab/hour). **Residual:** the conversation can leak through fetch URLs; every shared login is in the home (reachable by the user's own `!`); see A1 for OpenCode." | `assistant.rs:335-480,797-910`; `launch_prep.rs:369-417`; `agent_fence.rs:369-470` (diff); `browser_engine.rs:771-811,1054-1075,1101-1124`; `root_mcp.rs` `admit_web_rate`, `grant_assistant` |
| Tier 3 "Agent-session hooks" | yes; text stale | Add the OpenCode session plugin (`<state>/hooks/<slug>_opencode_session`, listed in each home's `opencode.json`, read-only in the fence). Add Manage CLIs' "Trust in every agent home" for Codex hooks: it writes `trusted_hash` only for handlers whose command is exactly Tabtivity's hook, and the hash covers event, matcher, command and timeout, so a mis-indexed entry fails safe | `opencode_session.rs:44-82,168-246`; `agent_session.rs` `trust_codex_hooks_in` (commit `c4545ce9`) |
| Tier 4 Python/Format/exec_trust | yes | — | `exec_trust.rs:411-520` (hooks, scoped exec keys, hook managers; unreadable → subject) |

## New findings

| ID | Sev | Finding (evidence file:line) | You do (tier 0–4) | Confidence |
|---|---|---|---|---|
| A1 | high | **Shared OpenCode login can carry configuration.** The keeper adopts a changed `~/.local/share/opencode/auth.json` from any scope's home and places it in every home, the Host home and both assistant homes included (`commands/agents.rs:258`; `agent_auth.rs:285-316`, `1000-1011`). The only content checks are Codex/Claude's account guard and Pi's command check (`agent_auth.rs:220-230,265-275`). OpenCode reads a `wellknown`-type entry as an integration. In 2.1.2 (installed binary) a legacy `auth.json` `wellknown` entry is imported into the credential store, and at each start `Config.loadWellknown` fetches that origin's remote config and parses it as a config document (MCP servers, plugins, permissions). OpenCode 1.x also sets a process environment variable from the entry. **What an attacker reaches:** a prompt-injected agent in one fence writes its own copy, and from the next keeper pass every other scope's OpenCode loads attacker-served config. That runs programs in those fences, unfenced in a Host-session OpenCode, and inside the Tabby OpenCode chat, where the remote config's plugins/MCP servers start despite the pinned tool set and next to every shared login. Same class as the original gap 16. | nothing beyond starting OpenCode in another scope, the Host session or Tabby (tier 3) | Tabtivity side **confirmed** in code. OpenCode 2 side **confirmed** from the installed binary's strings (`Config.loadWellknown`, "Failed to load wellknown remote config from", the legacy importer's `Q.type==="wellknown"` branch). Whether V2 re-runs the import on every start is unverified. OpenCode 1.x env-var behaviour is from upstream source as recalled, not re-read for 1.19.x |
| A2 | medium | **OpenAI through the proxy: spend the meter cannot see.** `/v1/responses` bodies are forwarded as they are (`api_proxy.rs:1271-1275`). The meter reads only `model` and `max_output_tokens` (`api_meter.rs:683-686`), and an answer counts as settled only when a final usage object with both totals arrives (`:857,948`). (a) A **`background: true`** request returns at once with no usage. It is charged the elapsed-time estimate (`:953,967,970-977`, about 1,000 tokens/s), its reservation is released, and OpenAI bills the whole run later. Repeating it spends without bound past the monthly limit. (b) **`service_tier`** (priority) is priced at the standard rate (`api_prices.rs:87-96`). (c) OpenAI **server-tool fees** (web search, file search, code-interpreter containers, image generation) only widen the reservation (`api_meter.rs:587-588`) and are never charged afterwards. This is gap 8's shape. (d) The agent's **`OpenAI-Organization` / `OpenAI-Project`** headers pass through (`DROP_REQUEST`, `api_proxy.rs:1365-1399`), so a tab chooses which org/project of a multi-org key is billed, unlike Anthropic's pinned workspace (`:1518-1522`). | nothing (keyed Codex/OpenCode tab, prompt-injected) | (a)–(d) **confirmed** in code. OpenAI's background mode, service tiers and tool fees are from OpenAI's public docs (not live-checked) |
| A3 | low | **Last run's unowned lead, confirmed for folders.** The Reader's Resume menu and stored-chat read follow a *linked folder* in the agent-writable home. `claude_folders` takes `<home>/.claude/projects/<slug>` with `is_dir()` (follows links) and `claude_candidates` uses `read_dir` on it (`agent_chats.rs:291-296,303-319`); `claude_chat_log` checks only the leaf (`agent_session.rs:683-689`); `open_regular` vouches for the leaf only (`home_io.rs:891`). A fenced agent that turns its slug folder into a link to another scope's folder (the Host home's root-console folder has a predictable path) makes this tab's Resume menu list that scope's Claude conversations by first and last prompt, and open them in the Reader. Codex is not affected: its rollouts are filtered by recorded `cwd` and root-canonicalized (`agent_chats.rs:341-349`, `agent_transcript.rs:889-906`). **Reach:** desktop only (`agent_tab_chats` is a window command; no phone route found). Nothing flows back to the agent, and a resume of such an id fails inside the fence. A user-confusion and integrity issue, not exfiltration. | open the Resume menu (tier 2) | **confirmed** in code |
| A4 | low | **Path-shape checks that trust agent-writable shapes.** (a) The O#149 cwd gate is lexical: `Path::starts_with` does not resolve `..`, so a cwd of `<root>/../elsewhere` passes (`launch_prep.rs:484-486`; same helper shape `sandbox.rs:1739-1741`). Untrusted layouts keep a tab's `cwd` (`terminal_service.rs:553-577`). (b) `agent_relocate::is_agent_folder` accepts any `<root>/.tabtivity/worktrees/<name>`, a link included (`agent_relocate.rs:233-245`, `105` uses `is_dir()`, which follows). The Git view, by contrast, accepts only live `git worktree list` entries. (c) `git_guard::guard_paths` reads `.tabtivity/worktrees/*` and binds a found `.git` pointer file read-only **without** the `inside(roots)` check the other paths get (`git_guard.rs:77-83,92-94`), so a planted link exposes one outside `.git` pointer file (a path string) read-only in the fence. Under bwrap none of these widens what the fence can write; they are the shapes the gate exists to refuse. | open/relocate a tab (tier 3–4) | **confirmed** in code. Impact judged minimal |

## Last run's follow-ups and "Not reviewed" leads

| Item | Status now | Evidence / note |
|---|---|---|
| Pin allowed roots / refuse a root resolving elsewhere | still open | `agent_fence.rs:268-330` (`compute_fence_roots`): no canonicalisation or link check |
| gap 19 `repo_changed` race (pass spawn-time `GIT_DIR`) | still open | `git_push_mcp.rs:665` only *removes* `GIT_DIR`, does not pin it |
| `local_model_of` trusts the env pair (require `VIBE_HOME` leaf) | still open | `root_mcp.rs:775-789` unchanged |
| `prepare` at quit escapes `kill_all`; closing a tab during `prepare` orphans its PTY | still open | `commands/terminal.rs` `pty_spawn` awaits `prepare` with no closed-meanwhile check. The new `route_spawn_live` (`terminal/mod.rs:794`) is used only by the login-PTY paste |
| gap 30 residual (`--ro-bind-fd`) | still open | no `bind-fd` in `src-tauri/src` |
| gap 16 residual re-survey (Goose `secrets.yaml`, OpenCode `auth.json`, Qoder `.auth`) | **OpenCode: not credential-only → A1.** Goose, Qoder: not re-surveyed | Goose/Qoder only get keyring-off env (`agent_auth.rs:726,729`) |
| `agent_session` transcripts through linked folder components | **confirmed → A3** (Claude). Codex holds | see A3 |
| Processes left detached inside a fence | holds | `--unshare-pid --die-with-parent` (`agent_fence.rs:1372-1373`, one-shot `:833-834`): when the agent exits, its pid namespace and every detached process die before the pane's trailing shell runs. Containers: not reviewed |
| Approval-card races | holds where checked | root writes are bound to the shown digest (`root_mcp_review.rs:758,845`); push sends the card's SHA (gap 10); `exec_trust_approve` re-collects and refuses a change (`exec_trust.rs:261-285`); schedule MCP has no update tool (only propose and cancel, `schedule_mcp.rs:194-196`); Codex hook trust is hash-bound |
| Agent-written `.tabtivity` marker files | holds for the drop box (gap 12); minor for `worktrees/` | `.tabtivity/worktrees/*` is read by `git_guard` and `agent_relocate` without a link check → A4(b)(c) |
| `tabtivity-send` | no new authority | It is an in-fence script that writes into `.tabtivity/outbox` (`agent_bin.rs:24`). An agent can write there directly; the boundary is the outbox server (gap 12, B's area). The desktop Chat's "pictures a reply names" read through `read_file_bytes` with the tab's `projectId` (confined; `2c786455`) |
| OSC 8 link spoofing | holds | OSC 8 and plain links go through the same click delay, a confirm showing the real URL, and `open_external_url`, which accepts only `http(s)://` (`TerminalView.tsx:560-569,634-636`; `commands/ssh.rs:259-264`) |
| PTY output forging Focus/Reader states | not a boundary in A's area | Parsed states drive buttons that type into the same agent. The one cross-boundary consumer is the phone's loopback OAuth-callback GET (B) |
| `exec_trust` fingerprinting | holds | hooks via `--git-path hooks` (honours `core.hooksPath`), exec-capable local/worktree config keys, hook-manager configs; anything unreadable becomes a subject (`exec_trust.rs:411-520`). Hook managers beyond pre-commit/lefthook/husky (e.g. config in `package.json`) count under the stated "an approved hook runs other project code" residual |
| `home_io` / `agent_global` merge internals | holds | Every home write goes through `HomeFile` (`agent_global.rs:135-208`). The per-home manifest is agent-writable, but it can only make Tabtivity unmerge or remove things inside that same home |
| Codex hooks trust (`c4545ce9`) | holds | trusts only handlers whose command equals Tabtivity's hook. The recorded hash covers event, matcher, command and timeout, so a mis-indexed key yields a hash mismatch, never trust |
| Assistant: Codex catalog from a sibling home (agent-writable) | holds | built from an allowlist, tool fields forced, prompt replaced, re-checked after the write (`assistant.rs:484-760`); sibling reads are no-follow and capped |
| Assistant: OpenCode inline config | holds as far as Tabtivity controls it | Its `tools` wildcard comes first and the lane pattern last (`assistant.rs:451-480`). Config files in the assistant home are written only by the chat's own CLI, except for A1 |

## Proposed fix steps

| Step | Findings | Files | Fix | Decision needed? |
|---|---|---|---|---|
| A-1 | A1 | `services/agent_auth.rs` (+ tests) | Generalise `names_command` into a per-CLI admissibility check run at **adopt and at place**. For `opencode`: a JSON object whose every entry has `type` `api` (string `key`, optional `metadata`) or `oauth` (`refresh`/`access`/`expires`, optional `accountId`/`enterpriseUrl`), no other type and no unknown fields; refuse `wellknown` and anything else, record `Blocked{command}`. At startup, sweep every home (Host and assistant homes first) and rename aside (`.pre-scope` pattern, `retire_shared_paths_in`) any placed OpenCode `auth.json` that fails the check. Then survey Goose and Qoder the same way. | **Yes**, see D1 |
| A-2 | A2 | `services/api_proxy.rs`, `services/api_meter.rs`, `services/api_prices.rs` | For a metered OpenAI request, refuse (fixed `Forbidden`/`NotFound` category) a body with `background: true`, and also a body that does not parse (as Gemini's by-reference rule does). Refuse `service_tier` other than absent/`auto`/`default`, or price `priority` with its multiplier. Count `web_search_call`, `file_search_call`, `code_interpreter_call` (per container) and `image_generation_call` output items and charge their per-call fees, keeping the worst-case reservation per tool. Drop `openai-organization` and `openai-project`, or pin them to values saved with the key, like Anthropic's workspace. | no (D2 only if keeping background) |
| A-3 | A3 | `services/agent_chats.rs`, `services/agent_session.rs` (`claude_chat_log`, `read_agent_transcript_from` folder search) | Open `<home>/.claude/projects/<slug>` through `home_io::HomeDir::open_existing` (no-follow per component from the home) and list and open by handle. Or canonicalise the folder and require it under the scope home's canonical `.claude/projects`, like `codex_rollout_in`. Add a test with a linked slug folder. | no |
| A-4 | A4 | `services/launch_prep.rs:484`, `services/sandbox.rs:1739`, `services/agent_relocate.rs:105,233`, `services/git_guard.rs:79,93` | `cwd_within`: refuse any `..`/`.` component (and, for local tabs, compare canonical paths). `move_session`: require `symlink_metadata(to)` to be a real directory and a live entry of the repo's hardened `git worktree list`, as the Git view does. `guard_paths`: skip a worktree entry that is a link, and push a pointer file only when `inside(dot_git)`. | no |
| A-5 | hardening (no finding) | `services/agent_fence.rs` (`keyring_seccomp_filter`) | Add `ioctl` with `TIOCSTI` / `TIOCLINUX` → `EPERM` to the fence's seccomp program, as a second line behind `FENCE_INPUT_DRAIN`, which only covers tmux-wrapped panes and the shim. | no |
| A-6 | docs | `docs/threat_model.md` | Apply the row-audit wording: rows 4, 5, 8, 9, 16, 17, 19, 29; Tier 0 loopback + API proxy rows; Tier 3 Linux, Host, hooks rows; the new Tabby/web-lane row. Add A1–A4 as gaps 42+ when fixed. | no |

## Decisions for the user

- **D1 — OpenCode login sharing (A1).** Options: (a) keep sharing behind a strict
  content check (A-1). OpenCode stays signed in everywhere; anything but a plain key
  or OAuth token is refused and shown in the Agents view. (b) Make OpenCode's
  `auth.json` per scope, as the 2026-10-08 decision did for the dotenv files and
  Cline. Each scope then signs in once; one key everywhere comes through the API
  proxy route (`1e3a0d55`) or the global agent config. (c) (a), and also never place
  OpenCode's file into the Host and assistant homes. **Recommendation: (a)**, with the
  startup sweep. It closes the hole without new sign-ins, and the Host home keeps
  working. If the OpenCode 2 import turns out to re-run each start, also consider (c).
- **D2 — OpenAI `background` requests (A2).** Options: (a) refuse them on proxied
  tabs (Codex and OpenCode do not use them); (b) allow them but hold the full
  worst-case reservation until a later poll proves completion (the proxy cannot poll:
  `GET /v1/responses/{id}` is not forwarded). **Recommendation: (a).**

## Cross-area notes

- **B:** (1) The Mobile host now serves `/mcp/web` (`host.rs:9626`), so a phone-started
  Tabby chat fetches pages from the desktop. The lane's SSRF rules are
  `browser_engine::fetch_for_agent` (Agent origin). Worth a look from the headless
  owner's side (its process environment, proxy variables). (2) The phone's loopback
  OAuth-callback GET is the one place a parsed PTY state (forgeable by agent or
  remote output) leads to a network request. Check that the callback URL the phone
  sends cannot come from terminal text alone. (3) A3 is desktop-only today. If a phone
  Resume menu is added, it inherits A3 across per-phone project lists. (4) Phone
  "desktop images" (`desktop_images`) were not reviewed by A.
- **C:** (1) `open_external_url` (`commands/ssh.rs:259`) is shared by terminal links
  and more. It checks only a case-sensitive `http(s)://` prefix; the URL still goes to
  the system handler after the confirm. (2) Login PTY paste (`commands/credentials.rs:83-95,297,421`)
  is scoped per target and per spawn sequence; C should confirm it cannot paste into
  a respawned non-login PTY. (3) `browser_engine` is C's file. A reviewed only
  `FetchOrigin::Agent` (hop 0 judged, userinfo refused, no proxy, DNS pin per hop via
  `resolve_to_addrs`, own-address probe), which holds (`browser_engine.rs:771-811,1029-1075,1101-1200`).

## Not reviewed

- macOS Seatbelt and Windows runtime paths (only diffs read; nothing run).
  Containers (`services::sandbox`: mounts, in-container processes that outlive a tab,
  shared pid namespace between tabs of one project container). VM projects.
- **OpenCode 2's shared background service and its PTY daemon** (`PersistentPty.daemon.*`,
  discovered through a `service.json`). Tabtivity adds `--standalone` to its own
  launches (`opencode_session.rs:231-246`), but not to an `opencode` typed into a shell
  tab through the agent shim. If V2's service or PTY daemon listens on loopback TCP
  without a credential, any fenced agent (shared network namespace) or other local
  user could drive it. Needs a probe of where they listen.
- Help MCP and schedule MCP internals beyond the token-class and approval checks.
  `agent_turn`. `tmux_local` beyond `SECRET_ENV` and the drain. `api_proxy`
  streaming/relay internals beyond the OpenAI parity check. `agent_global`'s one-time
  import from the user's home.
- Codex's own honouring of `features.shell_tool=false` and the forced catalog fields
  across releases (relied on the plan's 0.162.1 probe).
- Goose `secrets.yaml` and Qoder `.auth` formats (A-1 asks for that survey).
- The AI switch (`ai_switch.rs`) as a control: it stops new starts and input, not
  running agents. Not a containment boundary and not reviewed as one.

---

<!-- B.md -->

## Reviewer B — Phone, remote, sync, server mode  (HEAD 21eadf64)

Line numbers are from a `git archive 21eadf64` export, not the working tree.
The repo's HEAD has since moved to `caf2260a`: 12 more mobile commits that add
remote-host tabs on the phone (a new ssh lane from the sidecar). I only
spot-checked those; see "Not reviewed".

## Summary

- **2 medium, 4 low, 3 informational/hardening.** Nothing high. No earlier gap
  in my area regressed (gaps 3, 12, 14, 20, 35 and #863 still hold).
- **B1 (medium):** background auto-sync pushes a mirror file through a symlink.
  If a fenced agent swaps an already-synced file for a link, the unfenced app
  reads the link's target (any file the user can read) and uploads it to the
  remote host. The threat model says "symlinks never mirrored", which is only
  true of the manual walk.
- **B2 (medium, dev builds only):** the browser desktop client is served from
  the dev checkout's `web-dist/`, which fence-writable agents can change. This
  is the same pattern gap 20 removed for the phone app (`live_pwa`), and the
  user's own daily build is affected.
- **Doc gap:** `docs/threat_model.md` has no server-mode rows. It does not
  mention the browser desktop client's origin or listener at all. The
  hosted-plan §4.4 table lives only in the plan.

## Row audit

| Row / gap | Holds? (yes / partly / no) | Stale text or regression → proposed new wording | Evidence |
|---|---|---|---|
| "The one fact…" (phone PWA CSP paragraph) | yes, text stale | The phone CSP now has `img-src 'self' data: blob:` (2f1c74c1: library covers are object URLs; images only, no script). Add a sentence: **the browser desktop client (`/desktop/`) is a third origin.** Script there can call every `core` command, and also `admin` commands on the desktop sidecar, where every web session is `Role::Admin`. Its CSP is `script-src 'self' blob:` plus inline-script hashes computed from whatever `index.html` is on disk, and `style-src 'unsafe-inline'`. | host.rs:708-710; web_client.rs:1489-1493, 951-980; docs/context/web_client.md:220-222 |
| Tier 0 Phone bridge | partly | The Serve/Funnel claim is stronger than the code (B3): only the configured authority is checked for Funnel. The new routes `GET /tabs/{id}/worktrees`, `POST /tabs/{id}/worktree`, `POST /tabs/{id}/teleport` and `GET /tabs/{id}/uncommitted` all resolve through the device-filtered catalog. The POSTs use `mutation_guard` or `exact_origin` plus `ai_off_guard`, so they hold. Add: the assistant scope (Tabby) is listed to every paired phone, like root, with **no per-phone list**, and is on by default once the experimental flag is on (B6). | config.rs:251-298; host.rs:3606-3667, 4789-4870, 4204-4235; discovery.rs:752-791, 1252-1268 |
| Tier 0 Phone bridge — lost/stolen phone | partly | Revoke ends server-side access. The phone's own storage is never cleared on revoke or unpair, though: project-file covers (pictures and first PDF pages), markup layers including the PDF words under marks, prompt drafts and held prompts all stay in IndexedDB or localStorage (B4). Also add the newer powers a stolen phone has: start "<agent> (API)" tabs that spend the monthly API budget (20d7be47), move agents between worktrees (b7d0f61f), teleport cloud sessions into new worktrees (f37b64c0), and read and drive Tabby chats. | App.tsx:335-336, 455-457; thumbs.ts:14-19, 185; markup/store.ts:72; drafts.ts:71-80; terminal/heldPrompts.ts:56 |
| Tier 0 Loopback listeners and local sockets | partly (text incomplete) | Missing: the sidecar's **browser-client** routes on the bridge port, and the user-content origin on port+1 (both loopback, token or ticket gated, localhost `Host`/`Origin` only). Another local user can lock the client's login route by failing 10 logins a minute (DoS only). On a server, per-user daemons talk over `/run/<slug>/users/<user>.sock` with a peer-uid check (unchanged). | web_client.rs:718-765, 1443; docs/context/web_client.md:86-101 |
| Tier 0 Background git — lockstep / worker sync | yes; add the new mode | "Local wins" (16e4f0d1) is new: an opt-in per project where commits travel only mirror → host. A host branch that moved on its own is backed up to `refs/<slug>/backup/*` and reset, with the same refusals as "Use local". Setting it is a `core` IPC command (`git_peer_set_local_authoritative`), not something a project can write. The destructive steps either refuse on a dirty tree, keep a backup ref, or record through `local_loss` (spot-checked, not exhaustive). | git_peer.rs:2686-2711, 3986-3996, 2191-2219, 1711-1740, 2172 |
| Tier 0 Byte-sync / worker sync | **partly** | "Symlinks never mirrored" holds for walks and pulls, but **not for the auto-sync push**: a mirror leaf symlink at an already-synced path is followed and its target uploaded (B1). Also, a FIFO there blocks a runtime thread while the project's sync lock is held (B5). Pulls now keep the host's permission bits masked to `0o777`, through the umask, never setuid/setgid/sticky (a6d451ea, 153c28b8). Unknown host stats fail closed (ffcf0db9). One mutation lock per project covers byte-sync and lockstep (adc6f76b). A pull explicitly started on a path inside an excluded tree waives the exclusions on and above it (ee8f0508, a user click). Proposed residual text: "…the push side reads mirror files by path, following a symlinked leaf or folder (B1)." | sync_auto.rs:647-660, 717-735; remote_sync.rs:218-220, 1432-1445, 1046-1068, 1501-1540 |
| Tier 0 Remote / VPN auto-connect | yes | Unchanged. The interactive connect is now an argv (`pkexec openvpn --config … --script-security 1 …`), no longer a shell string typed into a tab; `openvpn_login_command` is gone. | openvpn.rs:472-512, 669-670 |
| Tier 1 Auto-sync to remotes | partly | Add: "…and a fenced agent in the mirror can make the background pass upload any file you can read (B1)". The open item "files over 64 MiB are skipped with only a log line" is still true. | sync_auto.rs:706, 719, 746; remote_sync.rs:40 |
| Tier 1 Agent-authored schedules (Mobile host half) | yes | The scheduler's delivery strips control characters except `\n` (`agent_tasks::sanitize_message`). Since 1d5003fe, unbracketed text goes in 256-char pieces, still through a 0600 paste file and `paste-buffer -r`. A restart of a bound container agent now runs where it always ran (`restart_options`, 418f327b). | scheduler.rs:80-98, 305-317, 414-450; agent_tasks.rs:146-154; headless.rs:839-881 |
| Tier 2 Phone PWA answers / outbox | yes | Unchanged. The answer renderer is still an allowlist rebuilt from an inert `<template>`. | answerMarkdown.ts:60-160; Terminal.tsx:514-524 |
| Tier 2 Phone shell tabs | yes | `shells_open` is still read per catalog load. Teleport and worktree moves are agent-only (`cloud_tab_required` / `agent_tab_target`). | host.rs:3640-3645, 3905-3911 |
| Tier 2 Phone project files and PDFs | yes; add one note | Folder rows now carry an item count from a budgeted held-handle scan (20 000 entries per listing). PDF covers are drawn by the sealed pdf.js frame; picture covers are fetched by sealed token. Add: "covers are cached on the phone (IndexedDB, up to 600) and survive revoke (B4)." | files.rs (item_count, `ITEM_SCAN_BUDGET`); thumbs.ts:1-40 |
| Tier 2 Phone git overview | yes | git_overview.rs changed by 5 lines only. The residual (a linked-worktree probe can sanitize another local repo's config) stands. The new `uncommitted` read uses hardened git with `:(literal)` pathspecs. | chat_uncommitted.rs:195-205 |
| Tier 4 Connect VPN | yes | The residuals (plugin/log/status/cd as root, the polkit-prompt race) stand. | openvpn.rs:472-487 |
| Tier 4 Phone CLI sign-in | yes | sign_in.rs is unchanged. On a server, only a listener owned by the daemon's own uid is contacted. | sign_in.rs:120-150 |
| Tier 4 PDF markup (phone half) | yes | Already updated for `visibleText` (160e2bb3). Not re-audited (parsers not reviewed). | — |
| Tier 4 Pair a phone | partly | List the new powers: API-key starts (spend the budget, refused once it is spent: MobileBridgeHost.tsx:976-990), worktree moves, cloud-session teleport, Tabby chats (no per-phone list), uncommitted-file counts. | as above |
| Tier 4 Phone starts a tab with no window | yes; text stale | Add: (a) the owner also starts **assistant chats** with no window, from the record's validated launch only (`assistant_launch_options`); (b) persisted `env` is stripped on every headless launch (`strip_persisted_env`), which closes the last run's "headless relaunch skips the load sanitizer" note for this seam; (c) a remote project's phone agent runs in the mirror with `location: local`; (d) the scheduler restarts a container agent in its container (`restart_options`); (e) API-key requests need the window. | headless.rs:963-1020, 839-906 |
| Tier 4 Local models from the phone | yes | local_models.rs changed by 2 lines. | — |
| Gap 3 (SFTP names) | yes | `refuse_symlinked_components` is still applied to every mirror write. | remote_sync.rs:252-296 |
| Gap 12 (drop boxes) | yes | `files::ProjectDir` held-handle walk unchanged; `each_entry` refactor only. | files.rs |
| Gap 14 (revoke cancels) | yes | phone_origin.rs changed by 1 line. The new phone actions are immediate, so there is nothing queued to cancel. | phone_origin.rs |
| Gap 20 (dev builds, phone app from disk) | yes for the phone; **sibling open** | `live_pwa` is gone (host.rs:6664-6676, mod.rs:38). The **browser desktop client** still serves `<checkout>/web-dist` in dev builds (B2). | web_client.rs:725-735 |
| Gap 35 (rsync fast path) | yes | `--no-links --no-devices --no-specials --max-size`, `--files-from`, no `-r`. | remote_sync.rs:1163-1190 |
| **(missing) Server mode** | — | No row exists. Proposal: a "Server mode (hosted)" section pointing to `tabtivity_hosted_plan.md` §4.4, with a one-line summary. The uid is the boundary (per-user daemon); `core_dispatch` user confinement is defence in depth (6e8ae492, 30c02942). Gateway routing headers are trusted only from the socket peer uid. Shared Ollama is reachable by every shell. Decision change a41799cc (2026-10-15) dropped the "approve client ssh hosts" gate from f664c6e9, because a non-admin client exists only on a per-user daemon whose account already has a shell. Logins are still limited to stored hosts, with argv built from the stored spelling. List the deferred items (#2353 gateway body cap, etc.). | docs/server.md; hosted plan §4.3-4.4; core_dispatch.rs |

## New findings

| ID | Sev | Finding (evidence file:line) | You do (tier 0–4) | Confidence |
|---|---|---|---|---|
| B1 | **medium** | **Background auto-sync follows a symlinked mirror file on push.** The pass builds candidates from host walks and single-file markers, then stats the mirror copy with `std::fs::metadata` (follows links, sync_auto.rs:656). It pushes through `push_file_atomic`, which also uses `metadata` and `std::fs::read` by path (remote_sync.rs:1437, 1445). `mirror_local_path` checks the path lexically only, with no link check on reads (remote_sync.rs:218-220). The manual walk uses lstat (remote_sync.rs:1506, 1538), but the auto-sync path never does. **Reach:** a prompt-injected, fenced local agent (it can write the mirror, and creating a link needs no read access to the target) replaces an already-synced file in an auto-synced folder with a link to a host file outside its fence: an SSH key, a cloud CLI login, a file in Tabtivity's state dir. The next unattended pass reads that file as the user and uploads it to the remote host. Anyone with read access there gets it, including a remote agent tab of the same project. The same read-through-link applies to the manual `sync_push` in the gap between its lstat walk and the read (commands/sync.rs:1615). | 1 (auto-sync set up) + 3 (agent hijacked) | confirmed (code path); not run |
| B2 | **medium** (dev builds only) | **The browser desktop client is served from the fence-writable dev checkout.** `bundle_dir` tries `WEB_DIST`, then `dev_build::SOURCE_ROOT/web-dist`, then `<control_dir>/web-dist` (web_client.rs:725-735). `SOURCE_ROOT` is set for every build from a checkout: frozen dev builds and the hot-reload window (dev_build.rs:15-29). `serve_bundle` reads the file from disk on every request and allowlists `index.html`'s inline scripts by hash (web_client.rs:951-980). **Reach:** an agent working in the checkout (an everyday case for this repo) changes `web-dist/`. With Browser access on, the next time the user opens the localhost client, that script runs with a `Role::Admin` session that can call `core` and `admin` commands of an unfenced process: spawn terminals, git, settings. That is a fence escape needing one ordinary user action. This is the pattern decision B1 removed for the phone app; the browser bundle was not covered. | 2 (open the browser client) | confirmed (code); not run |
| B3 | low | **The Funnel drift check looks at one authority only.** `verify_serve_json` checks only the configured `host:port` handler and `AllowFunnel[that authority]` (config.rs:251-298). The 30 s loop calls only that check (host.rs:7180-7193). A second Serve mapping, or a TCP forward to the same `127.0.0.1:<port>` on another Funnel-enabled port (443/8443/10000), puts the bridge on the public internet undetected. Auth still holds (8-digit pairing code only while pairing is open, device signature). Exposed are the pre-auth routes and the 256-connection cap (lockout DoS). A non-browser client can forge `Origin`. The threat-model text ("refuses to start if Funnel exposes it") overclaims. | 1 (user adds a second mapping) | confirmed (code) |
| B4 | low | **Phone-side data outlives revoke and unpair.** On `unpaired` the app only calls `forgetLastPlace()` (App.tsx:335-336, 455-457). It never clears the cover cache (thumbs.ts:185, up to 600 covers of project pictures and first PDF pages), markup layers including the PDF words under sent marks (markup/store.ts:72; layer.ts:83-87), prompt drafts (drafts.ts:71-80) or held prompts (heldPrompts.ts:56). A project removed from a phone's list likewise leaves its covers behind. The local lock gates the UI, not this storage. Revoking a stolen phone therefore does not remove what it cached. | — (lost/stolen phone) | confirmed |
| B5 | low | **A FIFO in the mirror wedges auto-sync.** A FIFO reads as size 0, so it differs from the base and passes the 64 MiB check. `std::fs::read` then blocks inside an async future (remote_sync.rs:1445). `run_bounded`'s `tokio::time::timeout` (sync_auto.rs:65-75) cannot interrupt a blocking syscall. A runtime worker thread hangs, and the pass keeps the project's `sync_op` mutation lock, which also stalls lockstep for that project. A fenced agent can cause it. | 3 | confirmed (code); plausible effect |
| B6 | low | **The assistant (Tabby) scope ignores per-phone lists and is on by default.** The scope has `devices: None` (discovery.rs:1262-1263). `assistant_open` treats an unset `assistant_access` as on (discovery.rs:757-791) whenever the experimental flag is on. A phone narrowed to no projects can still read Tabby conversations started on the desktop (`/tabs/{id}/transcript`) and start cloud or local chats on the user's account. Root has the same "no per-phone list", but root is behind a default-off switch. | — (paired phone) | confirmed |
| B7 | low (hardening) | **`sync_diff` runs bare git.** It calls `git diff --no-index` through `command_no_window("git")` with the app's inherited cwd, without `--no-ext-diff --no-textconv` and without the hardened builder (commands/sync.rs:2014-2018). AGENTS.md lists `diff` among verbs that must not run bare. Exposure depends on the cwd the app was launched from being inside a repo whose config or attributes name a diff driver. Low because `.git/config` is fence-guarded, but cheap to close. | 2 (view a sync diff) | plausible |
| B8 | info | **Clocks.** Phone sessions (15 min idle / 12 h max), challenges, pairing codes and tickets expire on wall-clock seconds (auth.rs:288-291; clock.rs:14-16). Moving the clock back (root, or unauthenticated NTP on a hostile network) stretches a live session or an open pairing code. The 5-try cap and the signature still apply. Hardening: in-memory deadlines on `Instant`/boot time. | — | confirmed (code) |
| B9 | info | **inotify.** Auto-sync attaches one recursive watcher per marked mirror, one watch per directory (sync_auto.rs:316-366). If watches run out it falls back to the interval, so sync is only slower and nothing is lost. A fenced agent creating many directories does use up the user-wide `max_user_watches`, which other watchers (file tree, transcript watch, other apps) share. DoS only. | 3 | plausible |

## Last run's follow-ups and "Not reviewed" leads

| Item | Status now | Evidence / note |
|---|---|---|
| Background `sync_auto` skips files over 64 MiB with only a log line | **open** | sync_auto.rs:706, 719, 746 (eprintln only); remote_sync.rs:1438-1443 |
| `workspace_sync` serves stored tabs without the load sanitizer; headless relaunch of an adopted tab has no `TAB_UID` | **sanitizer: fixed**; `TAB_UID`: not re-checked | workspace.rs:815-830 (sanitize_loaded_layout / sanitize_scope_layout); headless.rs:848-853 strips persisted env |
| B: Tailscale Serve/Funnel drift check | reviewed → **B3** | config.rs:251-298 |
| B: headless launch assembly | reviewed, holds | headless.rs:839-906, 963-1020 |
| B: scheduler typing path | reviewed, holds | scheduler.rs:80-98, 305-317, 414-450 |
| B: desktop bridge for sidecar requests | spot-checked, holds | MobileBridgeHost.tsx:880-1000 repeats `phoneMayCreate`, the `shell_tabs` check, API-key saved/budget checks and teleport validation (`cleanCloudSession`, local projects only); tab_worktrees/move resolve opaque ids (2659-2700). `desktop-control.sock`: same-uid peer check, unchanged. |
| B: `git_peer` in depth, `local_loss` completeness | spot-checked | "Local wins" plus the reset/clean/update-ref sites: refusal on a dirty tree, a backup ref, or a `local_loss` record. Not exhaustive. |
| B: markup parsers, VM projects | not reviewed | — |
| Lead: phone IndexedDB after revoke | reviewed → **B4** | — |
| Lead: clock changes against limits and expiry | reviewed → **B8** (info). API-budget month boundaries are A's (`api_meter`). | — |
| Lead: hosted and headless trust boundaries | partly reviewed | Headless: holds (above). Hosted: the uid boundary is unchanged since eacfa41a. Gateway diff is RNG only (invite codes now uniform, helper.rs `eight_digits`). a41799cc/f664c6e9 decision noted. `core_dispatch` confinement not graded row by row (defence in depth only). |
| Lead: inotify exhaustion and sync | reviewed → **B9** (info) | — |
| Open decision from merge: bundle import brings a local model's Vibe conversations without the gap 33 marker | not mine (A/C) | — |

## Proposed fix steps

| Step | Findings | Files | Fix | Decision needed? |
|---|---|---|---|---|
| B-1 | B1, B5 (and the 64 MiB note) | `services/remote_sync.rs` (`push_file_atomic`, `local_meta`/`local_size_mtime` callers), `services/sync_auto.rs:647-735`, `commands/sync.rs:~1600-1620` | Read every mirror file to push through one helper. It opens the file under the mirror root with no link on the way: reuse `refuse_symlinked_components` for the folders plus an `O_NOFOLLOW \| O_NONBLOCK` leaf open (or the `files::ProjectDir` held walk). It then `fstat`s the open handle, refuses anything that is not a regular file, applies the 64 MiB cap from that `fstat`, and reads from the same handle inside `spawn_blocking`. Use lstat for the divergence stat too, so a link reads as "not a file", is skipped and is reported. Surface skips (link, special file, too large) as a per-project notice instead of only `eprintln`. Tests: a leaf link, a linked folder, a FIFO, and a swap between walk and read. | no |
| B-2 | B2 | `services/mobile_control/web_client.rs:725-735` | Drop the `SOURCE_ROOT/web-dist` candidate. Either (a) embed the web bundle in the binary as the phone app is, or (b) have `package-dev.sh` (outside the fence) copy `web-dist` into `<app_dir>/dev-builds/web-dist` with a hash in the `verified` file, and serve only that. Release builds keep `WEB_DIST` / `<control_dir>/web-dist`, both fence-hidden. Also refuse symlinks in `serve_bundle` (`is_file` follows them). | **yes**: (a) embed or (b) verified copy. Recommend (a) if binary size allows, else (b). |
| B-3 | B3 | `services/mobile_control/config.rs:251-298` (+ tests) | In `verify_serve_json`, also walk every `Web[*].Handlers[*].Proxy` and every `TCP[*].TCPForward`. If any of them targets `127.0.0.1:<port>` or `127.0.0.1:<port+1>` (or `localhost`/`[::1]`) under an authority or port with `AllowFunnel` true, refuse. Optionally also refuse a second non-Funnel mapping to the bridge port. Update the Tier 0 row. | small: whether a second private mapping to the bridge port should also refuse. Recommend refusing Funnel only. |
| B-4 | B4 | `mobile-web/src/App.tsx` (unpaired branches), `thumbs.ts`, `drafts.ts`, `terminal/heldPrompts.ts`, `markup/store.ts`, `authStore.ts` | One `forgetDeviceData()` on a definite `unpaired` (revoked or unknown device, not offline). It deletes the covers DB, drafts, held prompts and the auth record, and, per the decision, markup layers. When a project leaves the phone's list, drop that project's covers on the next catalog load. | **yes**: should unsent markup (the user's own work) be wiped on revoke? Recommend wiping covers, drafts and held prompts always; wipe markup only on revoke, not on a plain sign-out. |
| B-5 | B6 | `services/mobile_control/discovery.rs:752-791, 1252-1268`; settings schema; Mobile settings UI | Give the assistant scope a per-phone list as projects and boxes have (`assistant_devices`, absent = every phone, empty = none). Or make `assistant_access` default off (explicit opt-in like root). | **yes**: per-phone list, or default-off switch. Recommend the per-phone list (Tabby holds the user's private chats). |
| B-6 | B7 | `commands/sync.rs:2014-2018` | Add `--no-ext-diff --no-textconv`, set `current_dir` to the temp dir, and set `GIT_CEILING_DIRECTORIES`/`GIT_CONFIG_NOSYSTEM`. Or route it through a hardened builder variant for no-index use. | no |
| B-7 | docs | `docs/threat_model.md` | Apply the row-audit wording above. Add a short "Server mode" section that points to hosted plan §4.4 and lists its residuals and the a41799cc decision. Add the browser-client origin to "The one fact" and the loopback row. Note B1–B6 as gap rows 42+ once fixed. | no |
| B-8 | B8 (hardening) | `services/mobile_control/auth.rs` | Keep in-memory session, challenge and ticket deadlines on `Instant`. Keep the wall clock only for persisted invites. | no |

## Decisions for the user

1. **B-2: how should a dev build serve the browser client?** Options: (a)
   embed `web-dist` in the binary, as the phone app is; (b) serve a copy that
   `package-dev.sh` makes outside the fence and hash-verifies; (c) keep it and
   document it as part of the C3 residual ("the next dev build runs agent code
   anyway"). Recommendation: **(a)**. Unlike the binary, this bundle takes
   effect with no rebuild and no relaunch, which is exactly why `live_pwa` was
   removed.
2. **B-4: what does the phone forget when it is revoked?** Options: wipe
   everything; wipe everything except unsent markup; wipe only covers and
   drafts. Recommendation: wipe covers, drafts and held prompts whenever the
   host says the device is unknown. Wipe markup layers too on revoke, since
   they hold the document's words.
3. **B-5: assistant scope on the phone.** Options: a per-phone list
   (`absent = all`, like projects); default-off switch; leave it.
   Recommendation: **per-phone list**.
4. **B-3 strictness** (minor): refuse only Funnel mappings to the bridge, or
   any second mapping. Recommendation: Funnel only.

## Cross-area notes

- **A:** Phone worktree moves call the Reader's `moveAgentToWorktree`
  (agent_relocate). The phone's teleport creates a worktree with
  `git_worktree_add` and then launches `--teleport <id>` there; please confirm
  `run_worktree_git` stays hookless, since `worktree add` fires
  `post-checkout` (commands/git.rs:3399-3445). The scheduler's container
  restart (`restart_options`, headless.rs:839-881) `docker exec`s with no
  window, so the container env-key forwarding residual (#869) applies to
  phone-made schedules too. Tabby chats start headless from the phone
  (headless.rs `create_chat`/`start_chat`); the web lane refuses
  private/loopback targets (web_lane.rs:148), so a phone cannot use Tabby to
  reach the LAN. `assistant_new_chat` has a `MODEL_ARG` row.
- **C:** The web client page CSP is `script-src 'self' blob:` plus inline
  hashes and `style-src 'unsafe-inline'` (web_client.rs:1493); the same
  `base-uri`/`form-action` backlog applies, and it has `form-action 'self'`.
  The server guide verifies the `.deb` against a public key fetched from the
  same GitHub repo (docs/guide/server.md:116-120): trust is the same as the
  repo, so consider printing the key fingerprint in the release notes. The
  gateway invite-code modulo bias is fixed (src-gateway helper.rs
  `eight_digits`).
- **Post-baseline (all):** `21eadf64..caf2260a` adds phone attach to a remote
  project's **host** tabs over the desktop's ssh ControlMaster
  (`host_live.rs`, `ssh_exec::host_mux_args`, `pty_bridge.rs` +306). From a
  read of the commit messages and headers: no-dial argv (`ControlMaster=no`,
  `ProxyCommand=false`, `BatchMode`, `--`), tmux names limited to
  `[A-Za-z0-9_-]`, gated on a live phone session and `hpc_hosts`, shells still
  behind `shells_open` (discovery `host_of_tab(…, shells, …)`), and `ssh -G`
  bounded since it runs the user's `Match exec`. It needs its own review
  before it is called done.

## Not reviewed

- The `21eadf64..caf2260a` remote-host-tab commits beyond the spot check
  above.
- `markup.rs` / `markup_pdf.rs` parsers; `files_windows.rs` (+43); VM
  projects.
- `core_dispatch` `USER_CONFINED` rows one by one (defence in depth on a
  server); hub, calendar, keeper, broker and OIDC internals (unchanged since
  eacfa41a except RNG); vault rotation.
- `git_peer` beyond "Local wins" and the destructive-step spot check;
  `local_loss` completeness was not proven exhaustive.
- The `TAB_UID` half of the headless-relaunch follow-up.
- Remote credentials (`commands/credentials.rs`, reviewer C), HPC mode
  details, `worker_sync` beyond c945de15.

---

<!-- C.md -->

## Reviewer C — Desktop perimeter, viewers, mail/calendar, supply chain  (HEAD 21eadf64)

Read-only review. All line numbers are from a `git archive 21eadf64` copy of the tree. (The live checkout's HEAD has moved on to `caf2260a`, but every commit after `21eadf64` is mobile or remote-host work in B's area.) "Confirmed" means I read it in the code. "Plausible" means the code path is there but the outcome depends on platform or engine behaviour that I did not run.

## Summary

New findings: **0 high, 3 medium, 5 low**. No regression in gap rows 20–28 or 31–41 (spot-checked in code; see Row audit).

The two that matter most:
- **C1:** on Linux, the main, detached and present windows render hostile bytes in a WebKitGTK renderer with **no sandbox**. That renderer also holds the full IPC bridge. The code itself already says this for live browser pages (`fb6232f1`), but the threat model still files engine bugs under "out of scope / keep the package updated".
- **C3:** "Open in IDE" detection now runs **automatically** whenever the side panel shows a project. It reads project-controlled `*.iml` files with an unbounded, link-following, blocking read. A linked or oversized file can exhaust memory and kill the app.

Also medium:
- **C2 (Windows):** SyncTeX canonicalizes `Input:` paths named by the map. On Windows that can contact a network host named in a hostile `.synctex(.gz)`.
- **C4:** the loopback Ollama endpoint is trusted by address alone. Another local user, or another tenant on a hosted server, who binds 11434 first receives mail text and editor buffers.

## Row audit

| Row / gap | Holds? | Stale text or regression → proposed new wording | Evidence |
|---|---|---|---|
| "The one fact" | partly | Accurate about IPC, but silent on the Linux renderer having no sandbox. Add: "On Linux the WebKitGTK web process of every app window runs **without** WebKit's bubblewrap sandbox (wry 0.57 never enables it on the GTK3 API), so a WebKit memory-safety bug reached by content an app window renders (PDF fonts, images, SVG, media, HTML preview) is code execution as the user with the IPC bridge, with no second escape needed." (C1) | `commands/browser.rs:78-100`; `docs/browser_plan_b.md:1068-1080`; wry 0.57 `webkitgtk/` has no `sandbox` call |
| CSP / hardening backlog (#869 batch) | yes (unchanged) | Still `script-src 'self' blob:`, no `base-uri`, `form-action` or `object-src`. The backlog item is still open; no text change needed. | `src-tauri/tauri.conf.json:31`; `CspTripwire.test.ts:69-74` |
| Capabilities | yes | `default.json` is scoped by webview label, `browser.json` is empty, `connect.json` is narrowed. No change. | `src-tauri/capabilities/*.json` |
| `src-tauri/patches/tauri-runtime-wry` (Tauri 2.12 bump `d40529e9`) | yes | Diffed against crates.io `tauri-runtime-wry` 2.12.1 (checksum `7f9e7e0c…57d22` matches the index). The only change is the documented `TABTIVITY PATCH` (`main_thread` behind an `Arc`). Add to the model: "the patched crate differs from upstream 2.12.1 only by the `TABTIVITY PATCH` hunks". | `Cargo.toml:6-12`; patch `src/lib.rs:239-245, 2777-2783, 3121-3129` |
| In-app browser | partly (stale) | (a) Linux no longer opens live-page windows (`LIVE_SUPPORTED = !cfg!(linux)`, `fb6232f1`), so Linux is reader mode only. (b) The 🔍 on Windows `target=_blank` can be closed by code: wry 0.57's WebView2 `NewWindowRequested` handler calls `SetHandled(true)` on `Deny`. New text: "Linux: reader mode only (live windows refused until a sandboxed renderer exists). Windows/macOS live windows: the `on_new_window → Deny` handler is honoured by WebView2 (`SetHandled(true)`; code-checked, not live-verified)." | `commands/browser.rs:100, 372`; wry-0.57.0 `src/webview2/mod.rs:763-848` |
| Markdown (remote images) | yes | One new residual (C8): document-image fetches honour `HTTP(S)_PROXY`. With a proxy set, the proxy resolves the name, so the DNS pin and the own-address check do not bind it. | `browser_engine.rs:1013-1036, 1060-1073` |
| Notebooks, ODT, SVG, Code/YAML/CSV, md-graph | yes | ODT now uses the shared `useDiskReloadPoll` (no security change). CSV goes through `read_file_text` (8 MiB cap). | `OdtView.tsx` diff; `fs.rs:1522-1583` |
| HTML / CSS preview | yes (plausibly) | The text says "no scripts, no same-origin". Blocking remote sub-resources (beacons) also relies on WebKit carrying the app CSP into `about:srcdoc`. The preview has no CSP of its own, unlike mail. Add "remote loads blocked by the inherited app CSP (not live-verified)", or add a CSP meta (C5). | `FileViewerPane.tsx:5949-5960`; `format.ts:150-165`; contrast `lib/mail.ts:1050` |
| PDF | yes | pdf.js is now 6.4.299. The desktop loader passes default options (`FontFace` on), so embedded fonts are parsed by WebKit (see C1). | `pdfLoad.ts:48`; `package-lock.json` |
| SQLite | yes | Guard unchanged. | `commands/sqlite.rs:79-92` |
| Spreadsheets (gap 24) | yes | Residual unchanged (no `RLIMIT_AS` on macOS, no Job object on Windows). | `services/sheet_reader.rs:219, 346` |
| GIF (gap 41) | yes | — | `lib/viewers/gif.ts:293-308` |
| Audio / video | yes (⚠️) | Same residual. Note it is also C1's surface (GStreamer runs in the unsandboxed web process). | — |
| TeX hover (gap 36) | yes | `tex.rs` lost ~570 lines, but they were the move of SyncTeX into `synctex.rs`. `-no-shell-escape`, `openout_any=p`, `openin_any=p` and `preview_engine` are all still present. | `tex.rs:548, 563, 590, 618` |
| **SyncTeX (new, `synctex.rs` rewrite)** | n/a → new row | Not in the model. Proposed row: "SyncTeX (click-sync / forward search): the `.synctex(.gz)` beside a PDF is read natively, capped at 512 MiB inflated. The source paths it names are canonicalized (C2: on Windows a network path there is contacted)." | `synctex.rs:641, 772-789, 611-636` |
| Mail message | yes | The ammonia sanitizer drops every `href` (`data-lid`); the frame keeps its own CSP; IMAP MOVE quotes the destination mailbox and refuses CR, LF and NUL. | `mail_sanitize.rs:18-24, 423-451`; `lib/mail.ts:1050`; `mail_engine.rs` (`move_uid_chunk`) |
| Incoming mail | yes | Add one line: the "loopback Ollama" is trusted by address only (C4). | `mail_ai.rs:126-136, 239` |
| Calendar sync (CalDAV, gap 26) | yes | — | `services/caldav.rs:833` |
| ICS subscribe | yes | The `.ics` "Refresh from URL" uses the reader's user-origin rules (hop 0 may be loopback or private, later hops re-judged and pinned). Fine on the desktop; see the cross-area note for the server. | `browser_engine.rs:952`, `commands/calendar.rs:1563` |
| 21 (open externally) | yes | Lists unchanged. The candidate extensions from the last run's follow-up have not been added (see follow-ups). | `services/os_open.rs:52-74, 124` |
| 22 (viewer writes) | yes | `open_confined` is still the path for reads, stats and saves. | `fs.rs:1477, 1582, 1922` |
| 23 (deck figures) | yes | — | `figureTarget` present |
| 25 (mail AI local-only) | yes | Add the C4 residual. | `ollama.rs:1124`; `mail_ai.rs:239` |
| 27 (mail → root agent) | yes | — | `root_mcp.rs:1929, 1941` |
| 28 (YAML depth, error boundary) | yes | — | `yaml.ts:572`; `FileViewerPane.tsx` (3 uses of `ViewerErrorBoundary`) |
| 31 (attachment save) | yes | — | `commands/mail.rs:4803-4865` |
| 32 (CalDAV dirty) | yes | Residual unchanged (no UI shows a row waiting to be pushed). | `caldav.ts:384-389, 749` |
| 37, 39 (SQLite caps, confinement) | yes | — | `sqlite.rs:79-92` |
| 38 (nav gate) | yes | Residual "refused navigation is stderr-only" still holds. | `lib.rs:581-600, 649-665` |
| 40 (markdown alt) | yes | — | — |
| 20 (dev builds) | yes | `package-dev-auto.sh` only gained `low_priority.sh`. The pre-push hook now bumps from a private index (a hardening). Residual C3 is unchanged. | `.githooks/pre-push` diff |
| App updates / Install update | yes | `app_update` now never picks the `*-server_*.deb` as a desktop update. | `services/app_update.rs` (`is_server_package`) |
| Extract archive | yes (⚠️) | Still no size or entry cap. Also: confinement is checked by path, then `File::create` follows links, so a concurrent writer in the project (a fenced agent) could race a link into the fresh folder. Add that to the residual. | `fs.rs:1293-1346` |
| Supply chain (security.yml, release.yml, dependabot) | yes | `cargo audit` now also ignores RUSTSEC-2026-0367/0368/0369 (`zip` 8.6 via `calamine`, `extract()` never called; our own `zip` is 9). The model's backlog line lists only RUSTSEC-2023-0071; add the three. Dependabot is weekly with a 7-day cooldown and Tauri/wry pinned out; release uses `workflow_run` gated to a push on main of this repo. Signing is unchanged. | `security.yml:47-56`; `release.yml:35-57, 150-160, 218-245`; `.github/dependabot.yml` |
| WebKit GPU compositing (`cde65763`) | n/a | No security impact: DMA-BUF stays off unless the experimental setting is on (read from the state dir), and 2D canvas acceleration is off on every webview. Optional one line in the model. | `lib.rs:603-643, 1310-1321` |
| Credentials (`commands/credentials.rs`) | yes, improved | New: a saved secret is pasted only into a PTY the backend itself spawned running that credential's login (`LoginTarget`), and a server client's ssh login is limited to configured hosts. Worth a line in the model (it closes "paste a saved password into any PTY"). | `credentials.rs:24-60, 421-462` |
| Not in model: native PDF print | — | The print path hands the arranged PDF (attacker pages included) to the OS engine: PDFium in a script-enabled WebView2 window (Windows, `file:` spool, no IPC), CUPS filters (Linux), PDFKit (macOS). User-initiated; suggest one tier-4 line. | `commands/print_native.rs:1-27, 167-210` |

## New findings

| ID | Sev | Finding (evidence file:line) | You do (tier 0–4) | Confidence |
|---|---|---|---|---|
| C1 | medium (model gap + decision) | **The app windows' renderer is unsandboxed on Linux and parses hostile bytes.** The code and docs established on 2026-10-14 that wry 0.57 never calls `webkit_web_context_set_sandbox_enabled`, so WebKitGTK web processes run unsandboxed (`commands/browser.rs:78-100`, `docs/browser_plan_b.md:1068-1080`). The fix only covered live browser pages. The `main`/`detached-*`/`present-*` webviews hold the full IPC bridge and parse: PDF embedded fonts (pdf.js default `FontFace`, `pdfLoad.ts:48`), raster and SVG images (markdown local and remote images, `DOCUMENT_IMAGE_TYPES` incl. AVIF/WebP/ICO/BMP, `browser_engine.rs:973-983`; the GIF native fallback), audio/video (GStreamer), and the HTML/CSS preview. A WebKit memory-safety bug reached through any of these is code execution as the user with every command, with no second escape. The threat model calls a compromised WebKitGTK out of scope and treats media as "keep updated", which understates this: on Linux there is no process boundary at all. | 2 (open a file / mail) | confirmed (config); exploitation needs an engine bug |
| C2 | medium on Windows, low elsewhere | **SyncTeX touches paths named by a hostile map.** `Spelling::absolutise` runs `std::fs::canonicalize` on every `Input:` path the `.synctex(.gz)` names (`synctex.rs:611-636`). `status()` does this for every source-extension input **before** filtering to the document's tree (`synctex.rs:719-723`); its `root` itself comes from the map (`synctex.rs:751-758`). Reverse and forward search do it too (`:820`, `:889`). On Windows, canonicalizing a UNC path opens it, so clicking a PDF that a hostile repo ships with a crafted map can make the machine contact a network host, which can carry the user's network sign-in (the class gap 38 closed for markdown links). On Linux and macOS the calls are `stat`/`realpath` only. | 2 (click-sync or forward search in a hostile project's PDF) | code confirmed; Windows network behaviour plausible (standard Win32) |
| C3 | medium (availability) | **IDE detection reads project files unbounded, automatically.** Since `304184ed`, `ProjectFilesView` mounts `IdeHeaderButton` (`ProjectFilesView.tsx:1624`), whose effect calls `detect_project_ides` on every project shown (`IdeMenuItems.tsx:39-44`, `commands/ide.rs:108-110`). For a project with `.idea/` (`ide_detect.rs:579`), `jetbrains_product` reads every top-level and `.idea/*.iml` with `fs::read_to_string` (`ide_detect.rs:498-499, 524-531`): it follows links, has no size cap and opens blocking. `.idea/.name` is opened blocking too (`:335-336`, read capped at 256 bytes). A hostile repo or tarball, or a fenced agent in the project, can make that read exhaust memory (a link to an endless device, or a huge sparse file), aborting the app with every window and tab. A named pipe at either name parks one blocking-pool thread per detection. Same class as gaps 24 and 29. | 0–2 (show a project in the side panel) | confirmed |
| C4 | medium on a hosted server or shared machine, low on a single-user desktop | **The loopback Ollama endpoint is trusted by address, not by owner.** `mail_ai::resolve_endpoint` accepts any loopback `host:port` (`mail_ai.rs:126-136`). Gap 25's `model_is_local_at` asks that same endpoint which models are local (`ollama.rs:1124`), so whoever listens there answers for itself. No caller checks the listener's owning account. Another local user (in scope per "Out of scope"), or another tenant on a hosted server sharing `127.0.0.1:11434` (hosted plan §3.3), who binds the port while the real Ollama is down receives mail bodies (including background auto-classify of new mail), local-completion buffers and local-model reads. The model lists the reverse case for MCP ports (row "Loopback listeners", residual) but not this one. | 0 (auto-classify) / 2 | confirmed (no owner check exists); squatting plausible |
| C5 | low | **The HTML/CSS/SVG preview has no CSP of its own.** `buildPreviewDoc` inserts only `<base href="about:srcdoc">` (`format.ts:150-165`). With `sandbox=""` nothing runs, but blocking remote sub-resources (a beacon showing the file was opened, plus the user's IP) relies on WebKit inheriting the app's header CSP into `about:srcdoc`. WebKit's owner-inheritance rule should make it hold, but this was not checked live (the "not reviewed" lead). Mail sets its own frame CSP (`lib/mail.ts:1050`). | 2 | plausible-holds |
| C6 | low | **Repo config can name a FIFO that the pre-check does not see.** Gap 15's `git_bounded::hazard` stats only fixed names (`git_bounded.rs:14-20`), and the config sanitizer does not touch `core.excludesFile`, `core.attributesFile`, `mailmap.file` or `blame.ignoreRevsFile` (no match in `commands/git.rs` sanitizer tables). A hostile repo's (or tarball's) `.git/config` naming a FIFO in the tree makes every background `status`/`diff` block until `READ_TIMEOUT` (2 min) kills it. It is bounded, so availability only, but the file tree and switcher polls stall. (The "core.excludesFile → FIFO" lead.) | 0 (open the folder) | confirmed by code; git blocking behaviour from gap 15 |
| C7 | low | **The Antigravity transcript DB is opened by path after the check.** `google_chat::database` checks the file through `HomeFile::open_read`, then has SQLite open it again by name (`google_chat.rs:199-208`). A fenced Antigravity agent can swap in a FIFO in between, and SQLite's read-only `open()` then blocks that transcript read. (SQLite's own `-wal`/`-shm` opens use `O_NOFOLLOW`, checked in the bundled 3.x source, so there is no write-through-link issue.) | 0 (agent-written) | plausible |
| C8 | low | **Document and reader fetches honour the proxy environment.** `honours_proxy_env` keeps `HTTP(S)_PROXY` for `FetchOrigin::Document` and `User` (`browser_engine.rs:1032-1036, 1071`). With a proxy configured, the proxy resolves the name itself, so the DNS pin and `judge_own` do not bind a document-chosen image URL. A corporate proxy may then reach intranet hosts that a markdown file names, after the user presses Load. | 2 (Load remote images) | confirmed |

## Last run's follow-ups and "Not reviewed" leads

| Item | Status now | Evidence / note |
|---|---|---|
| Pin allowed roots / refuse a root that resolves through a planted link | **Partly fixed.** Server `user_roots` refuses a root reached through a link inside another root (`through_planted_link`). The desktop `compute_allowed_roots` still canonicalizes each root as found. | `fs.rs:2000-2049` vs `fs.rs:2152-2154, 2199-2201` |
| Candidate launcher extensions (Windows `.ws`, `.wsc`, `.sct`, `.xll`, `.msu`, Access, `.jnlp`, `.appx`/`.msix`, `.theme(pack)`, `.search-ms`, `.iso`/`.vhd(x)`; macOS `.webloc`/`.inetloc`/`.afploc`; Linux `.jnlp`, `.flatpakref`, `.deb`/`.rpm`) | **Open** (none added) | `os_open.rs:52-74`. The ask-first question still applies, so these only miss the "refused outright" layer. |
| UI: CalDAV row waiting to be pushed | **Open** | `caldav_dirty` is only in the store (`caldav.ts:384-389, 749`); no component renders it |
| UI: refused navigation is stderr-only | **Open** | `lib.rs:588-595` |
| CalDAV overlapping syncs / in-flight guard per collection | **Open** | no in-flight guard in `commands/caldav.rs` |
| Approved agent CalDAV write unmarked if the app dies before push | **Open** (unchanged) | gap 32 residual |
| Deck "Edit" saves through a linked figure folder; `compile_tex` own-folder check path-based | **Unchanged** (accepted, no decision needed) | — |
| `dev_git` cannot switch off `filter.*` / `core.worktree` for the freeze-tree checkout | **Unchanged** | inside the C3 residual of gap 20 |
| "Not reviewed" C: popout/present URL handling | **Holds** | `detached_query` percent-encodes scope and group (`subwindow.rs:66-90`); presenter labels are charset-checked (`presenter.rs:41-48`); both use `WebviewUrl::App`. New `presenter_next_monitor` is a pure monitor move. |
| "Not reviewed" C: `default_apps.rs` / `ide.rs` | **Reviewed** | `default_apps` is a state-dir map (`Core`; the program runs only through `open_file`, `Client`). `ide.rs`/`ide_detect.rs` → C3. The launch target is the folder or a top-level `.sln`/`.code-workspace`/`.sublime-project` (absolute path, so no leading `-`). |
| "Not reviewed" C: keychain call sites | **Improved** | login-PTY gate (`credentials.rs:24-60, 421-462`); `keyring_*` is `Off` on servers |
| "Not reviewed" C: `scripts/`, `.githooks/` | **Reviewed (diff)** | pre-push bump from a private index; `low_priority.sh` benign. `fresh-vm.sh` checks assets against the release's `SHA256SUMS` but not its signature, and proceeds unchecked without one (`fresh-vm.sh:561-567`; dev tooling, low). |
| "Not reviewed" C: `src-tauri/patches` | **Holds** | upstream-identical apart from the documented patch (checksum-matched) |
| "Not reviewed" C: dependency pinning | **Holds** | Lockfiles committed; `npm ci --ignore-scripts` in CI (`ci-cd.yml:39-45`); Tauri/wry excluded from Dependabot; `serde_yaml` → `serde_norway` and xterm 6, vite 8, vitest 5 bumped (no finding) |
| "Not reviewed" C: boxes and brand-migration adoption | **Mostly holds** | Boxes with a reserved scope id are dropped on read and refused on save (`boxes.rs` diff). Brand migration renames only a real directory and runs hookless git. One unverified edge: `repair_worktrees` passes every `<.tabtivity>/worktrees/*` with a `.git` *file* to `git worktree repair` (`brand_migration/project.rs:160-180`). The pointer in a hostile folder could name another repo's worktree admin dir, and `repair` would rewrite that dir's `gitdir` (integrity of another repo's worktree link; only during the old-name transition; low, plausible). |
| "Not reviewed" D: `highlight.ts`, compare/merge | **Not re-reviewed** (no change since) | — |
| "Not reviewed" D: `pdf_markup`/`pdf_clip` | **Spot-checked** | 4-line change in `pdf_markup.rs`, no new parser |
| "Not reviewed" D: CSV size handling | **Holds** | `read_file_text` 8 MiB cap (`fs.rs:1522-1583`); a pathological single-row CSV can still make the renderer slow (no cap on columns), low |
| "Not reviewed" D: `fetch_document_image` SSRF rules | **Holds**, plus C8 | `https` only; hop 0 judged as server-chosen; every resolved address must be global; own addresses refused; pinned; 2 MiB; image types only (`browser_engine.rs:742-786, 968-1024, 1104-1220`) |
| "Not reviewed" D: WebKitGTK `about:srcdoc` CSP inheritance | **Plausible-holds** | C5 |
| "Not reviewed" E: PGP/S-MIME internals, IMAP loop, filters, review panel, `mail_reader` VM lane | **Not reviewed in depth** | Only the diff since `eacfa41a` was read: IMAP MOVE UID mapping is bounded and validated (`mail_engine.rs` `move_uid_pairs`/`validate_move_uids`), and the TLS config no longer panics on an unreadable trust store |
| "Not reviewed" E: ICS subscribe hops, `ics.ts`/`icsSafety.ts` | **Holds** | `fetch_ics` uses the reader's hop discipline; recurrence expansion is bounded by the window and `MAX_OCCURRENCES` (`recurrence.ts:44, 125-245`) |
| Lead: crash reports and logs | **Holds** | `crash.log` sits in the 0700 state dir, is capped at startup (`state_gc.rs:83`) and is never sent anywhere (no reader in `src`/`mobile-web`). Frontend errors are clipped (`commands/crash.rs:9-38`) but not newline-escaped, so they can forge header lines in the log (cosmetic). No secret-bearing `eprintln!` found; the nav gate logs only scheme and host. |
| Lead: `core.excludesFile` → FIFO | **Bounded gap** | C6 |
| Lead: other loopback services in the shared netns, as reached from the app | **Gap** | C4 (Ollama squatting). The reader's hop 0 to loopback is the user's own typed aim, and later hops and document/agent hops refuse private and own addresses. |

## Proposed fix steps

| Step | Findings | Files | Fix | Decision needed? |
|---|---|---|---|---|
| C-1 | C1 | `docs/threat_model.md` ("One fact", "Out of scope", Audio/video, PDF, In-app browser rows); `src/lib/viewers/pdfLoad.ts`; `docs/browser_plan_b.md` §8.6 | Document that app windows on Linux run an unsandboxed renderer holding IPC. Reduce reachable parser surface where it is cheap: pass `disableFontFace: true` to pdf.js on the desktop loader (glyphs are drawn by pdf.js, so WebKit's font parser never sees embedded fonts). Track the GTK4 / `webkitgtk-6.0` route (tauri#12561) as the real fix. Optionally re-encode remote markdown images in Rust (decode with the `image` crate, emit PNG) so WebKit decodes only Tabtivity's own PNG. | **Yes**: font fidelity and speed vs surface (see Decisions) |
| C-2 | C2 | `src-tauri/src/commands/synctex.rs` | In `Spelling::absolutise`, refuse (return absolutised-only, never canonicalize) any input that is a network path: on Windows a `\\`/`//` prefix or a verbatim-UNC form, after the `Path::join` with the base. In `stale_inputs`, filter by lexical `starts_with(root)` on the joined path **before** `absolutise`, and refuse a `root` that is a network path. Optionally skip inputs outside the PDF's own project roots altogether. Add Windows-only tests mirroring gap 38's. | no |
| C-3 | C3 | `src-tauri/src/services/ide_detect.rs` | Read `*.iml` and `.idea/.name` through a bounded regular-file reader (the `home_io::open_regular` / `git_bounded::read_small_regular` pattern: `O_NOFOLLOW \| O_NONBLOCK`, regular file on the opened inode, 64 KiB cap; Windows: open without following reparse points). Cap the number of `.iml` files examined (e.g. 32). Unit tests: a link to a device, a FIFO, an oversized file. | no |
| C-4 | C4 | `src-tauri/src/commands/ollama.rs` (new `loopback_listener_owner`), `services/mail_ai.rs`, the completion and local-model read paths | Before sending private content to a loopback Ollama, look up the listening socket's owner. On Linux, match the port in `/proc/net/tcp{,6}` (listening state) and read its `uid` column. Accept only the user's own uid, root, or a system account (uid below `SYS_UID_MAX`, which covers the `ollama` service user); on a hosted server, the uid the admin configured. Otherwise refuse with a translated "another account is listening on the Ollama port" reason. Cache per (addr, inode) for a short time like gap 25's verdict. macOS/Windows: document the residual (or use `lsof`/`GetExtendedTcpTable` owning PID → user). | **Yes**: which owners to accept (see Decisions) |
| C-5 | C5 | `src/lib/viewers/format.ts` | In `buildPreviewDoc`, add a `<meta http-equiv="Content-Security-Policy">` right after the base tag for `html` and `css`: `default-src 'none'`, inline styles, `data:` images and fonts only. Add a `CspTripwire`-style test that the preview document always carries it. For `svg`, wrap the source in a minimal HTML document that carries the same meta. | no |
| C-6 | C6 | `src-tauri/src/services/git_bounded.rs` | Extend `hazard()` to read the repo-local (and common-dir) config through the existing sanitizer parse, and `stat` the values of `core.excludesFile`, `core.attributesFile`, `mailmap.file` and `blame.ignoreRevsFile` with the same "FIFO/socket/device → refuse" rule. Leave the user's global values alone. | no |
| C-7 | C7 | `src-tauri/src/services/google_chat.rs` | Open the checked descriptor itself. On Linux, open SQLite on `/proc/self/fd/<n>` of the `HomeFile` handle (read-only, `immutable=1` only if the WAL is copied too). Or copy the db and its `-wal` through held, non-blocking handles into a private temp dir and open the copy. | no |
| C-8 | C8 | `src-tauri/src/services/browser_engine.rs` | Make `honours_proxy_env` false for `FetchOrigin::Document` too, or keep the proxy but refuse when one is configured and the document asks for a host that is not resolvable to a global address locally. Recommendation: no proxy for document images (same reasoning as decision 15 for agents). | small: users who reach the internet only via a proxy lose remote markdown images. Recommend accepting that. |
| C-9 | follow-up | `src-tauri/src/commands/fs.rs` | Apply `through_planted_link` (with the same fences) to the desktop `compute_allowed_roots`, so a registered root reached through a link planted inside another root is dropped there too. | earlier decision still pending (last run's follow-up 1); recommend yes |
| C-10 | follow-up | `src-tauri/src/services/os_open.rs` | Add the listed candidate extensions to the per-OS lists, with tests. | no (recommend yes) |
| C-11 | doc | `docs/threat_model.md` | Row text updates from the Row audit: In-app browser (Linux reader-only; WebView2 `_blank` closed by code); SyncTeX row; credentials login-PTY line; `cargo audit` ignores; native print line; extract-archive race; C4 residual on "Incoming mail" and "Loopback listeners". | no |

## Decisions for the user

1. **C1: how far to go on the unsandboxed Linux renderer.**
   - (a) Document only.
   - (b) Also turn off pdf.js `FontFace` on the desktop, so embedded PDF fonts are never handed to WebKit. Cost: slightly slower text rendering and some fidelity differences; selection and search are unaffected.
   - (c) (b) plus re-encoding remote markdown images in Rust.
   - (d) Plan the move of all hostile-content rendering to a sandboxed helper (the browser plan's `webkitgtk-6.0` route).
   - **Recommendation: (b) now, record (d) as the real fix.** (c) only if remote images are used much.
2. **C4: which listener owners count as "your Ollama".**
   - (a) Own uid only (breaks the common Linux install, where Ollama runs as the `ollama` system user).
   - (b) Own uid, root, or any system account below `SYS_UID_MAX`.
   - (c) (b) plus an explicit uid the user or the hosted admin names.
   - **Recommendation: (c).** On a hosted server, require the admin-configured uid.
3. **C8: document images and proxies.** Drop the proxy for document fetches (recommended), or keep it and accept the pin bypass when a proxy is set.
4. **Last run's follow-up 1 (C-9): pin desktop roots like the server's.** Recommendation: yes. Same rule, one implementation.

## Cross-area notes

- **A:**
  - C7 (Antigravity transcript open-by-path) is in `services::google_chat`, which serves `agent_transcript`/`agent_chats`. Despite the name it is not Google Chat: it reads Gemini/Antigravity transcripts from agent homes.
  - C4 also feeds local-model agent tabs and `complete_text`/Copilot-adjacent completion. Every local-model read of mail goes to a squatted port the same way.
  - xterm moved 5 → 6 (`package.json`). Re-check the OSC 8 and OSC 52 handling A owns against the new addon versions (`@xterm/addon-web-links` 0.12).
  - New commands `clipboard_file_paths` and `pty_paste_clipboard_image` (`lib.rs` handler list) were not reviewed here.
- **B:**
  - On a hosted server, `browser_reader_fetch`, `calendar_fetch_ics` and `markdown_remote_image` are `Core` (`command_class.rs:328, 344, 636`). The first two keep the **user** hop-0 rule (`browser_engine.rs:782`): a tenant's first hop may name the server's loopback, LAN or link-local address, and the reader returns the sanitized text. Users already have shells, so the reach is not new today, but if shells' network is ever narrowed this becomes the gap. Suggest judging a non-local caller's hop 0 like `Document`.
  - C4 is cross-tenant on the shared `127.0.0.1:11434` of hosted plan §3.3.
  - The desktop root-pinning difference (C-9).
  - `synctex_*` and `calendar_*_ics` paths are held by `core_dispatch` `UserPath` (`core_dispatch.rs:283-313`). Fine.
- **A/B:** the new login-PTY gate in `credentials.rs` interacts with `pty_id_for` for server clients (`credentials.rs:430`). I checked only that the gate is applied before the keychain read.

## Not reviewed

- PGP/S-MIME internals, the IMAP sync loop beyond the diff, mail filters and the review panel's rendering, the `mail_reader` VM lane (no relevant diff since `eacfa41a`).
- `highlight.ts` and the compare/merge views (unchanged since the last run).
- `PdfViewer.tsx` (+380 lines) beyond the SyncTeX click path; `TableView.tsx`/`tableSelection.ts` beyond the read cap.
- The live behaviour of C1, C2 (Windows) and C5. Nothing was run; every verdict is from code and documentation.
- The 700+ commands one by one (still: any script in an app origin is full compromise).
- `scripts/server-vm.sh` and `package-server-deb.sh` in depth (server packaging is B's).
- macOS Seatbelt and Windows specifics of the open-externally path beyond the extension lists.

---

<!-- ROUND2.md -->

## Round 2 — cross-review (A, B, C)

Round 1 is done: `/tmp/opencode/threat1024/A.md`, `B.md`, `C.md` (format and
rules in `BRIEF.md`, still binding: read-only on the repo, defensive write-up,
no exploit code or payloads). The repo's HEAD has moved past `21eadf64`
(`git log --oneline 21eadf64..HEAD`); cite lines at current HEAD for new work.

Your job now — write `/tmp/opencode/threat1024/<X>_review.md`:

1. **Answer the cross-area notes addressed to you** in the other two drafts:
   confirm or refute each in code, with `file:line`. A confirmed one becomes a
   finding with an ID continuing your series (A5…, B10…, C9…).
2. **Review the other two drafts' findings and fix steps** where they touch
   your area or overlap yours: agree / disagree (with evidence) on severity
   and confidence, spot duplicates, fix steps that conflict or should merge,
   and fixes that would break something in your area.
3. **Close the most important gap in your own "Not reviewed"** (listed below
   per reviewer).
4. **Priority.** Propose one ordered list of every step across A, B and C
   (`A-1`, `B-2`, `C-3`, …), highest value first, with one line of reasoning
   each, and say which steps can run in parallel (different files).

Format:

```
## Reviewer <X> — round 2 review
## Answers to notes addressed to me
| Note (from) | Verdict | Evidence | New finding? |
## Review of the other drafts
| Item | Agree? | Comment / evidence |
## New findings (if any)
| ID | Sev | Finding (evidence) | You do | Confidence |
## Extra fix steps (if any)
| Step | Findings | Files | Fix | Decision? |
## Proposed overall order
1. <step> — why
## Parallel groups
```

Per-reviewer focus for item 3:

- **A:** OpenCode 2's shared background service and its PTY daemon: where do
  they listen (loopback TCP? Unix socket? credential?), and can a fenced agent
  or another local user drive them? Check whether an `opencode` typed into a
  shell tab (agent shim) gets `--standalone` or another guard. Also: does the
  OpenCode 2 legacy `auth.json` import re-run on every start (matters for D1)?
  Probe only by reading code/binary strings/docs; do not start OpenCode
  servers.
- **B:** the remote-host tab work after `21eadf64` (phone attach to a remote
  project's host tabs over the desktop's ssh ControlMaster: `host_live.rs`,
  `ssh_exec::host_mux_args`, `pty_bridge.rs`, discovery `host_of_tab`, and any
  later commits) — a full review of that new lane.
- **C:** `PdfViewer.tsx` beyond the SyncTeX click path and the new commands
  `clipboard_file_paths` / `pty_paste_clipboard_image`; and judge B2 (dev
  browser client served from the checkout) against gap 20's C3 residual — is
  it really new, and is "embed" feasible in the build (`build.rs`, bundle
  size)?

---

<!-- A_review.md -->

## Reviewer A — round 2 review

HEAD is now `ff9f83ab`. The 13 commits after `21eadf64` are mobile/remote-host work
plus one hook fix. None of them touches a file in area A, so every line cited
below holds at `21eadf64` and at `ff9f83ab`. The OpenCode probe read the installed
binaries' strings only (Tabtivity's copy at `agents/install/.opencode/bin/opencode`
is 2.1.3, `~/.opencode/bin/opencode` is 2.1.2). Nothing was started.

## Answers to notes addressed to me

| Note (from) | Verdict | Evidence | New finding? |
|---|---|---|---|
| Phone teleport: `git_worktree_add` → is `run_worktree_git` hookless? (B) | **Holds.** `run_worktree_git` → `run_git` → `run_git_as(…, Hooks::Off)` → `git_command_in`, which sanitizes the repo config, pins `GIT_COMMON_DIR` and adds `-c core.hooksPath=`. So `post-checkout` does not run on the host. The checkout that `--teleport` then makes is the agent CLI's own, inside its fence. | `commands/git.rs:3321-3323, 693-700, 712-726, 655-676, 2984` | no |
| Scheduler container restart and the #869 key forwarding (B) | **Confirmed it applies; not new.** `restart_options` → `options_for(…, restart=true)` → the normal `launch_prep` container path. Key forwarding belongs to every container tab, whoever starts it. A schedule can only target an existing tab, and that tab already received the keys when it was created. Add "and scheduled restarts" to the Tier 4 Run/terminal row. | `mobile_control/headless.rs:842-887`; `docs/threat_model.md:195` | no |
| Web lane refuses private targets; `assistant_new_chat` has a `MODEL_ARG` row (B) | **Agree.** Loopback, private, link-local, internal-name and redirect-to-private all map to `NotPublic`. | `web_lane.rs:146-150`; `model_allowlist.rs:51` | no |
| API-budget month boundaries vs clock changes (B, via B8) | **Out of scope.** Moving the wall clock needs root. A fenced agent cannot do it. | `api_meter.rs` (month key from wall clock) | no |
| Bundle import brings a local model's Vibe conversations without the gap 33 marker (B, "A/C") | **Still open, narrowed.** `agent_history::ROOTS` carries `.vibe/logs/session` and `.vibe/vibehistory` from the *scope* home. Local-model tabs use a separate per-model home (`agent_home::local_model_home`). I did not trace whether `project_transfer` ever writes into a local-model home. If it does not, the decision is moot. | `agent_history.rs:104-113` | no (open) |
| C7: Antigravity DB is checked, then opened by path (C) | **Confirmed**, low as C rates it: `HomeFile::open_read` refuses a non-regular file, then SQLite reopens by name. **Worse siblings in area A:** OpenCode's and Codex's stores are opened with none of `google_chat`'s guards, and one of them is opened on the spawn path → **A6**. | `google_chat.rs:199-208` | yes → A6 (C7 folded in) |
| C4 also reaches local-model agent tabs and completion (C) | **Confirmed, and wider than C states.** The "kept to local models" switches (`root_mcp_local_only`, `root_mcp_mail_local_only`) and the gap 33 mail read decide "local" by asking the endpoint itself (`tab_model_is_local_at`). Whoever holds the port answers. **Also:** fenced agents share the host's network namespace and run as the user's own uid, and Tabtivity starts Ollama on demand (`commands/ollama.rs:3076-3100`). A fenced agent can therefore take `127.0.0.1:11434` while Ollama is down, and C-4's proposed "own uid is fine" rule would accept it. | `root_mcp.rs:3596-3608`; `root_mcp_mail.rs:1144-1160`; `mail_ai.rs:126-136`; `agent_fence.rs:1371-1373` (only `--unshare-pid`) | yes → **A7** |
| xterm 5 → 6: OSC 8 / OSC 52 (C) | **Holds.** OSC 52 writes need pane focus and live output (not a catch-up). Only the `c` register is accepted, read-back is refused, CR/LF are stripped, and the cap is 4096 characters. OSC 8 goes through `linkHandler` into the same delayed confirm and `open_external_url` path as plain links. `allowProposedApi: false`. Hardening only: other C0 characters (ESC, ^C, …) survive in an OSC 52 payload. Stripping all C0 except tab would be cheap. | `TerminalView.tsx:520, 560-569, 636, 1140-1151`; `terminalControl.ts:189-208` | no |
| `clipboard_file_paths` / `pty_paste_clipboard_image` not reviewed (C) | **Spot-checked only** (C's round-2 focus). Both are `Client` class, so desktop only. The image goes through `inbox::store` (gap 12 drop box) or the global inbox. The renderer's `agent` flag only picks which inbox. Unlike `pty_write`, it does not call `pty_id_for`, but `Client` keeps it off server callers. | `command_class.rs:363, 962`; `commands/terminal.rs:388-412` | no |
| Login-PTY gate vs `pty_id_for` for server clients (C, A/B) | **Holds; fails closed.** The resolved id is used for both the spawn-mark lookup and the input sender. A mismatch answers "not a login" and never names another PTY. | `commands/credentials.rs:428-441, 453-457`; `commands/terminal.rs:18-23` | no |

## Review of the other drafts

| Item | Agree? | Comment / evidence |
|---|---|---|
| **B1** auto-sync pushes through a symlinked mirror file | **Agree, medium. I would put it at the top of medium.** | From the containment side, this is the one finding that gives a fenced agent a *read* outside its fence with no user action: `$HOME` is replaced and the state dir is masked (`agent_fence.rs:1350-1352, 1397-1410`), but creating a link needs no read access to its target. The copy then sits on the remote host, which a remote agent tab of the same (equally prompt-injected) project can read. B-1's held-handle read matches the `home_io` pattern; no conflict. |
| **B2** dev browser client served from the checkout | **Agree, medium. Do it early.** | Confirmed that the checkout is a fence-writable root whenever an agent works on this repo. That is this user's normal setup, and the daily build is a dev build. `SOURCE_ROOT`'s only other runtime reader is `dev_todo` (markdown data, `dev_todo.rs:166`). Precedent for (a) embed: the help corpus is already compiled in through `build.rs` (`help_mcp.rs:6-8, 32-34`). |
| B3, B4, B8 | agree (low/info) | Not my area. |
| **B5** FIFO in the mirror wedges auto-sync | agree, low | Same "regular file on the opened handle" rule as A6 and C3. One shared helper should serve all three (see the merged steps below). |
| **B6** Tabby ignores per-phone lists | agree, low | Area-A context: the assistant home holds every shared login (A1), so a phone that can start a Tabby chat starts a CLI next to all of them, even though its tool set stays pinned. That supports B's per-phone list. No conflict with `services::assistant` pinning: B-5 only filters discovery. |
| **B7** `sync_diff` runs bare git | agree, low (hardening) | It is a deliberate allowlist row, `BARE_GIT_ALLOWED` ("`diff --no-index` of two files", `commands/git.rs:5820`), so B-6 must also delete that row or the source-scan test fails as stale. Exposure needs a diff driver in a config the fence keeps read-only. The two `dev_build` bare spawns (`:5821-5822`) run in the same fence-writable checkout. They are read-only verbs, so this is hardening too. |
| **C1** unsandboxed Linux renderer | **Agree, medium. Reachable by a fenced agent, not just by opening a file.** | An agent reply that names a picture or PDF is rendered by the desktop chat (`read_file_bytes` with the tab's `projectId`, commit `2c786455`; the tabtivity agent hint tells agents to do exactly that). A fenced agent can therefore place attacker-made image or PDF bytes in front of WebKit or pdf.js in the IPC-holding main window, with no user action beyond looking at the chat. Add "agent reply" to C1's "You do" column (tier 2 → tier 3, agent hijacked). C-1(b) (`disableFontFace`) helps here too. |
| C2 SyncTeX UNC | agree | Not my area. |
| **C3** IDE detection unbounded read | agree, medium | Same class as A6: agent-plantable `.idea/*.iml` links. Use the shared bounded reader. |
| **C4** Ollama trusted by address | **Agree; the fix needs widening (A7).** | C-4's owner rule "own uid, root, or a system account" accepts a **fenced agent** (same uid, shared network namespace). The check must also refuse an own-uid listener whose process runs in another pid namespace than the app (every bwrap fence has `--unshare-pid`), or accept own-uid only for the Ollama process Tabtivity itself started (`record_owned_server`). It must also cover `tab_model_is_local_at`, not only `mail_ai`. |
| C5, C8, C10 | agree | C-8 lines up with decision 15 (no proxy on the agent lane). |
| **C6** repo config naming a FIFO | agree, low | `git_bounded` is area A. Note the fence already keeps `.git/config` read-only, so the attacker is a copied folder or tarball, not an agent. C-6's "stat the configured paths" fits `hazard()`. Read the repo-local file only and leave the user's global values alone, as C says. |
| **C7** | agree, low | Folded into A6/A-7 (one opener for every agent-written SQLite store). |
| **C-9** pin desktop roots like the server | **Agree; merge with last run's fence-root follow-up.** | The same planted-link rule is missing from `agent_fence::compute_fence_roots` (`agent_fence.rs:268-330`). Implement it once, and **drop** a root that resolves through a link planted inside another root; do not rewrite it to its canonical path. bwrap binds each root at its own path and the agent's cwd must keep its absolute path, so canonicalizing would break running layouts. |
| C-1(b), C-5 | agree | No interaction with area A. |

## New findings (if any)

| ID | Sev | Finding (evidence) | You do | Confidence |
|---|---|---|---|---|
| A1 (update) | high (unchanged) | **The OpenCode 2 import is a one-time database migration.** The legacy importer is migration `20260805200742_import_legacy_credentials`. It reads `<data>/auth.json`, skips integrations already in the `credential` table, and records `wellknown` origins under `wellknown:sources`. `Config.loadWellknown` then fetches those origins at **every** start (binary strings). **Consequence:** under V2 a planted `auth.json` takes effect in every home whose database is created or migrated *after* the plant: every new project's home, the first Tabby OpenCode chat, the first Host-session OpenCode. After that it persists in SQLite, where removing `auth.json` no longer helps. Under 1.x every home is affected at each start. **Also:** for V2 the keeper's sharing is almost inert after a home's first start, since later sign-ins and refreshes live in SQLite. Its remaining value is seeding new homes, which is exactly the attack path. Separately, an `api`/`oauth` entry swapped for the attacker's own account is an account-swap channel (Codex and Claude have an account guard for this; OpenCode has none). | — | migration + `loadWellknown`: confirmed from strings; "runs once per DB" assumes the usual migration bookkeeping (plausible-high) |
| A5 | low | **OpenCode 2's background service uses one fixed loopback port shared by every home, and typed `opencode` does not opt out.** The service is `opencode serve --service` on `127.0.0.1` (default hostname), at a fixed port per release channel (49374 for `latest`, 49375 `local`, else derived from the version). It uses HTTP basic auth with a random 32-byte password stored in the starting home's `$XDG_STATE_HOME/opencode/service.json`. The PTY daemon (`opencode-pty` 0.3.1) is spawned detached and talks over a Unix socket in a 0700 runtime dir under the home's state dir. Under bwrap, `/tmp`, `/run` and `$HOME` are private, and the pid namespace kills both daemons when the agent exits, so neither is reachable across homes. Tabtivity adds `--standalone` (private server, ephemeral port, random password) to its own launches (`launch_prep.rs:979-984`, `opencode_session.rs:231-247`). It does **not** add it to `opencode` typed into a shell tab (agent shim, `agent_shim.rs:51-109` passes args through) or to `opencode` run inside a fence or in the Host session (the shim script `exec`s the real CLI unchanged). **Reach:** all homes share one network namespace, so whichever home binds the port first blocks every other home's service ("Managed service port … already in use"). A client that holds a stale registration of its own also probes the port with its own password before the pid check (`/api/info`). A fenced squatter answering that probe receives the stale password, and if it guesses the pid (fenced pids are small), it becomes that client's server: it sees that home's prompts and controls what the TUI shows. Another local user can reach the port but cannot authenticate. | type `opencode` in a shell tab or the Host session (tier 2–3) | ports, auth, socket, `--standalone` gap: **confirmed** (strings + code). Impersonation: plausible |
| A6 | medium | **Agent-written SQLite stores are opened without the guards `google_chat` uses, one of them on the spawn path.** `opencode_store::open_store` (`opencode_store.rs:66-67`) and `codex_store` (`codex_store.rs:96, 113, 129, 191`) open DBs in the agent-writable home by path, with `READ_ONLY` only: no no-follow, no regular-file check, no `TRUSTED_SCHEMA` off, no `DEFENSIVE`, no length limit, no progress-handler deadline. `token_stats::codex_db_threads` checks the leaf first, then opens by path with no schema guards (`token_stats.rs:733-756`). Compare `google_chat::database` (`google_chat.rs:199-208`) and `agent_history::open_untrusted` (`agent_history.rs:376-395`). **Reach:** a fenced agent controls `.local/share/opencode/opencode.db` and `.codex/state*.sqlite` in its own home. (1) A **FIFO** there makes SQLite's `open()` block forever. `opencode_session::resolve` and `codex_session_exists` run synchronously inside the async `launch_prep::prepare` (`launch_prep.rs:847-851`; `agent_session.rs:44-51, 206-227`; `opencode_session.rs:320-336`). Each new OpenCode or Codex spawn in that scope then parks a runtime worker thread, and enough of them freeze the window. Reader polls park blocking-pool threads. (2) A **hostile schema**: `session_v2`, `session` or `threads` defined as a view over an unbounded recursive query runs with no deadline inside the app → CPU pinned or memory exhausted (app abort, every tab with it). (3) A **link** to another scope's store (box vs. project scopes share a directory) lists that scope's conversations in this tab's Reader. This is display-only, like A3. Gap 29 covers leaves read by `open_regular`; these opens bypass it. A6 also makes A7(b) a chain: an agent that can crash the app can then take the proxy port. | open the tab or its Reader; or nothing (restored tab spawn) (tier 0–3) | code paths **confirmed**; FIFO blocking open is standard POSIX; view-based DoS plausible-high |
| A7 | medium | **Fenced agents can take loopback ports the app later trusts.** The fence unshares only the pid namespace (`agent_fence.rs:1371-1373`). Local agents run in tmux and survive a crash (`launch_prep.rs:1303-1316`; `docs/context/tmux_sessions.md:13-14`). (a) **Ollama** (`127.0.0.1:11434` or the configured host): Tabtivity starts it on demand (`commands/ollama.rs:3076-3100`), so there are windows where nothing listens. A fenced agent bound there receives mail bodies (`mail_ai`, background classify), local completion buffers, and the root local-model tab's mail reads. The local-only gates ask the squatter itself (`root_mcp.rs:3602-3608`, `root_mcp_mail.rs:1152-1160`). The squatter is also the root local-model tab's model, so it steers that tab's tool calls (root writes still go through review cards). (b) **API proxy after a crash**: the proxy re-binds the port of the last run and otherwise any free port (`api_proxy.rs:817-834`; module doc `:46-52` names the risk "whatever else on the machine took the port"). A surviving fenced agent knows that port from its own base-URL variable and can bind it in the crash→restart gap. Every other surviving keyed agent (other scopes) then sends its requests there: the whole conversation (project files it read) and a dead token. The squatter's answers are taken as model output, so it drives tool calls inside *other* fences. (c) OpenCode service port: see A5. | (a) nothing / open mail; (b) an app crash (A6 can cause one) | (a), (b) code paths **confirmed**; timing plausible |

## Extra fix steps (if any)

| Step | Findings | Files | Fix | Decision? |
|---|---|---|---|---|
| A-1 (amended) | A1 | `services/agent_auth.rs`, `services/opencode_store.rs` (read-only check) | As in round 1, plus: (i) **adopt** an OpenCode change from a home only when it keeps the same entry names and types and only updates `access`/`refresh`/`expires` of an existing `oauth` entry (token rotation). Refuse any new entry, new or changed `api` key, type change, `wellknown`, or change of `enterpriseUrl`/`accountId`, and show the refusal in the Agents view ("sign in through Manage CLIs"). (ii) **place** only files that pass the same schema check. (iii) The startup sweep also opens each home's V2 DB read-only (through A-7's opener) and flags a non-empty `wellknown:sources` or `wellknown` credential, offering "sign OpenCode out in this scope". | D1 (updated below) |
| A-7 | A6, C7 | new `home_io::open_agent_sqlite` (or `services/agent_sqlite.rs`); `opencode_store.rs:66`, `codex_store.rs:96-191`, `token_stats.rs:733-756`, `google_chat.rs:199`; callers `opencode_session.rs:320-336`, `agent_session.rs:206-227` | One opener for every agent-written DB: walk the home with `HomeDir` (no-follow), check the leaf is a regular file on an `O_NONBLOCK` handle, open with `SQLITE_OPEN_NOFOLLOW`, then set `TRUSTED_SCHEMA` off, `DEFENSIVE` on, `SQLITE_LIMIT_LENGTH`, and a progress-handler deadline, as `google_chat::database` does. Run the spawn-time checks (`resolve`, `codex_session_exists`) in `spawn_blocking` under a short timeout, treating a timeout as "no session", so a swapped-in FIFO parks a blocking thread, never a runtime worker. Allow at most one open in flight per DB path. Tests: FIFO, link, a view-based schema. | no |
| A-8 | A5 | `services/opencode_session.rs` (`register_in_home`), `services/agent_home.rs` | In every Tabtivity-owned home (scope, Host, assistant, local-model), merge `{"disabled": true}` into `.config/opencode/service.json` through `HomeFile`. OpenCode 2 then uses a private server for every launch from that home, typed ones included (`cli.server-connection.resolve`: `standalone \|\| disabled === true`). Keep `--standalone` on Tabtivity's own launches. Tolerate a 1.x home (the file is ignored there). | small: whether the Host home also gets it (recommend yes; the shared fixed port is the problem) |
| A-9 | A7 (+C4) | `commands/ollama.rs` (new `loopback_listener_ok`), `services/mail_ai.rs`, `tab_model_is_local_at` callers (`root_mcp.rs:3602`, `root_mcp_mail.rs:1160`), completion; `services/api_proxy.rs:817-860` | **Merge with C-4; one helper.** On Linux, find the listening socket in `/proc/net/tcp{,6}` → uid + inode. For the user's own uid, find the pid holding the inode and **refuse** when its pid namespace (`/proc/<pid>/ns/pid`) differs from the app's (a fence) or when it is not the Ollama process Tabtivity started. Other uids follow C-4's decision. **Proxy:** at start, when the remembered port is taken, run the same check. If a fenced or foreign process holds it, notify the user and end (or mark) the tmux-held keyed agents whose base URL names that port; their tokens died with the crash anyway. Never fall back silently. | C-4's owner decision; plus D3 below |
| A-3 / A-4 / A-5 | as round 1 | as round 1 | Unchanged. A-5 (seccomp `TIOCSTI`) and C-9's fence-root part both edit `agent_fence.rs`: do them in sequence. | — |

## Decisions for the user (updated or new)

- **D1 (updated): OpenCode login sharing.** Given A1's update, the options are:
  (a) content check only;
  (b) per-scope `auth.json`;
  (c) (a) plus nothing placed into the Host and assistant homes;
  (d) **(a) plus an account guard: adopt only token rotation, never a new or changed key, entry or endpoint.**
  **Recommendation: (d)**, with the V2 DB sweep. It keeps the one useful effect, seeding new homes with the user's own sign-in, and removes every path for an agent to put its own entry in. If the user rarely uses OpenCode in new scopes, (b) is simpler and costs little under V2.
- **D3 (new): network isolation of the fence.** Options:
  (a) client-side checks only (A-9);
  (b) also restrict TCP `bind` inside the fence with Landlock (kernel ≥ 6.7, `LANDLOCK_ACCESS_NET_BIND_TCP`). Landlock allows only listed ports, so "everything but Ollama, the proxy port and 49374" means a large allow-set; dev servers inside the fence keep working;
  (c) `--unshare-net` with a forwarder (pasta/slirp) for the internet and Tabtivity's own lanes.
  **Recommendation: (a) now, (b) as tracked hardening.** (c) changes too much: every MCP lane and the proxy would need forwarding.

## Proposed overall order

1. **A-1** — high: one fenced agent reaches every other scope's OpenCode, the unfenced Host session and Tabby. It persists in V2 databases, so every week of delay means more homes to clean.
2. **B-2** — fence escape with one routine click, on the build this user runs every day. Small fix.
3. **B-1** (with B5) — the only no-click read past the fence (SSH keys, logins → remote host).
4. **A-7** (with C7) — any fenced agent can freeze or crash the whole app, and the crash enables A7(b).
5. **A-9 + C-4** (merged) — mail and editor text to a fenced agent or another user; cross-fence steering after a crash.
6. **C-3** — automatic app crash from a hostile repo or a fenced agent, just by showing the project.
7. **A-2** — unbounded spend past the monthly limit from a keyed Codex/OpenCode tab.
8. **C-1** (b now, d tracked) — shrinks what agent-placed bytes reach in the IPC-holding renderer.
9. **A-8** — closes A5 and also makes typed OpenCode match Tabtivity's own launches. A one-file change.
10. **C-2** — Windows: a click on a hostile PDF sends the user's network sign-in.
11. **B-5** — Tabby holds private chats and every shared login; per-phone list.
12. **B-4** — a revoked phone keeps document covers and markup words.
13. **C-9** (with the `agent_fence` roots part) — the last run's open follow-up, one rule in two places.
14. **A-3** — the Resume menu follows linked folders (display/integrity).
15. **B-3** — the Funnel drift check sees one mapping only.
16. **C-6** — FIFO via repo config keys (bounded).
17. **A-4** — lexical path-shape gates.
18. **B-6** — bare `diff --no-index` (remove the allowlist row too).
19. **C-5, C-8, C-10** — preview CSP, proxy for document images, launcher extensions.
20. **A-5, B-8** — defence in depth (seccomp TIOCSTI, monotonic deadlines).
21. **A-6, B-7, C-11** — threat-model text. One editor, after the fixes land, so gap numbers 42+ are assigned once.

## Parallel groups

These can run at the same time (disjoint files). Within a line, run the steps in the order given.

- **G1** `agent_auth.rs`: A-1. A-1(iii) uses A-7's opener, so either land A-7's helper first or stub it.
- **G2** `mobile_control/web_client.rs`: B-2 · `mobile_control/config.rs`: B-3 · `mobile_control/discovery.rs` + settings UI: B-5.
- **G3** `remote_sync.rs`, `sync_auto.rs`, `commands/sync.rs`: B-1, then B-6 (same `commands/sync.rs`; B-6 also edits `commands/git.rs` `BARE_GIT_ALLOWED`, which no other step touches).
- **G4** `home_io.rs` (new opener), `opencode_store.rs`, `codex_store.rs`, `token_stats.rs`, `google_chat.rs`, `opencode_session.rs::resolve`: A-7. Then **A-8** (also `opencode_session.rs`, after A-7).
- **G5** `commands/ollama.rs`, `mail_ai.rs`, `root_mcp.rs`/`root_mcp_mail.rs` local check: A-9 (Ollama) + C-4.
- **G6** `api_proxy.rs`, `api_meter.rs`, `api_prices.rs`: A-2, then A-9's proxy part (same `api_proxy.rs`).
- **G7** `ide_detect.rs`: C-3 (reuse G4's or `git_bounded`'s bounded reader).
- **G8** frontend: `pdfLoad.ts` (C-1b), `format.ts` (C-5) · `mobile-web/` (B-4).
- **G9** `synctex.rs`: C-2 · `browser_engine.rs`: C-8 · `os_open.rs`: C-10 · `git_bounded.rs`: C-6 · `mobile_control/auth.rs`: B-8.
- **G10** `agent_chats.rs`, `agent_session.rs` (`claude_chat_log`): A-3. It does not overlap G4: A-7 changes only the `codex_session_exists` call site in `agent_session.rs`, so coordinate that one hunk.
- **G11** `commands/fs.rs` + `agent_fence.rs` (roots): C-9, then A-5 (`agent_fence.rs` seccomp) · `launch_prep.rs`/`sandbox.rs`/`agent_relocate.rs`/`git_guard.rs`: A-4.
- **G12** `docs/threat_model.md`: A-6, B-7, C-11, done by one editor, last.

---

<!-- B_review.md -->

## Reviewer B — round 2 review

Repo HEAD for this round is `ff9f83ab`. `21eadf64..ff9f83ab` holds 12 mobile
commits (remote-host tabs on the phone) and one `.githooks/pre-push` fix. New
line numbers are at `ff9f83ab`; round-1 line numbers in A.md and C.md still
hold for the files I re-opened. Read-only throughout. Nothing was run except
`tmux -V` and `strings` on the installed tmux binary.

## Answers to notes addressed to me

| Note (from) | Verdict | Evidence | New finding? |
|---|---|---|---|
| A (1): the Mobile host serves `/mcp/web`, so a phone-started Tabby chat fetches pages from the desktop. Check the headless owner's side (process env, proxy variables). | **Holds.** The sidecar route runs the same `web_lane` handler as the window. The fetch is `browser_engine::fetch_for_agent` (Agent origin), which never honours the proxy environment, so the sidecar's inherited `HTTP(S)_PROXY` plays no part. The rate cap is per lane session (`admit_web_rate`). Tokens of other lanes are refused on `/mcp/web`. `Ctx::live()` reads the assistant switch and search settings fresh on each request. On a hosted per-user daemon the same Agent-origin rules apply, so a tenant cannot use Tabby to reach the server's loopback or LAN. | `web_lane.rs:591` (fetch), `:646` (rate), `:534-545` (`Ctx::live`); `browser_engine.rs:1032-1034` (`honours_proxy_env` false for Agent); `host.rs:9766-9782` (lane-token tests) | no |
| A (2): the phone's loopback OAuth-callback GET is the one place a parsed PTY state leads to a network request. Can the callback URL come from terminal text alone? | **Holds; small residual.** The callback is sent only from what the user pastes into the sign-in sheet (`pastedCallback(text)`), never from parsed screen text. The sidecar then accepts only plain `http` to a loopback literal on an explicit port ≥ 1024 (not its own), with `state` plus `code`/`error` present. It sends one GET with no proxy and no redirects, and returns only the status. Residual: forged terminal output can still show a link that ends on a loopback address, and the user may paste it back. On the **desktop** the delivery is not narrowed to listeners owned by the user's own uid (`own_targets` runs only when `is_server()`), so another local account's listener on that port would receive the code. | `SignInSheet.tsx:111`; `sign_in.rs:40-87`, `141-160` (server-only owner filter) | **B14** (low) |
| A (3): A3 is desktop-only; a phone Resume menu would inherit it. | **Refuted for today's phone.** The router has no resume/chat-list route (`host.rs:6806-6962`). The phone's transcript route reads only the tab's own recorded id (`headless::transcript` → `agent_session_transcript` → `claude_transcript`). `claude_session_log` does walk `projects/*` with `is_file()`, which follows links (`agent_session.rs:418-425`). But it needs a uuid the fenced agent cannot learn from the other scope, and the leaf is opened by `home_io::open_regular` (`agent_transcript.rs:1051`). A-3 should still cover `claude_session_log`, so the phone path gets the same folder rule. | as cited | no (A-3 scope note) |
| A (4): phone "desktop images" were not reviewed. | **Reviewed → B13 (low).** No path crosses the API: ids are path hashes, and attaching one re-scans the same folders. But (a) `scan` follows a symlinked image name in `~/Downloads`/`~/Desktop`/`~/Pictures` (`desktop_images.rs:186-214`, with a comment that accepts this). A link that arrived inside an extracted download, named like a picture, is copied into the project inbox with its target's bytes. (b) The phone can read back what it attached (`GET /tabs/{id}/inbox/{name}`, `host.rs:5764-5788`). So a paired phone can read any picture-named file of up to `MAX_INBOX_FILE` in those folders. The lost-phone row does not list this. | `desktop_images.rs:78-97, 186-262`; `host.rs:5336-5360, 5764-5788` | **B13** (low) |
| C (1): on a server, `browser_reader_fetch` / `calendar_fetch_ics` are `Core` and keep the **user** hop-0 rule, so a tenant's first hop may name the server's loopback/LAN. | **Confirmed as described; no new reach today.** `command_class.rs:328, 344` (Core); `browser_engine.rs:782` (`(User, 0) => Ok(())`). A non-admin client exists only on a per-user daemon whose account already has a shell (decision a41799cc). Sharing gives no other account `Core` calls. So the reach equals the tenant's own `curl`. It becomes a gap only if shells' network is ever narrowed, or `Core` reaches a non-account role. Recommend recording that condition in the server section (B-7), and C's change (judge hop 0 like `Document` for `Caller::Client` on a server) as a cheap guard for that day. `markdown_remote_image` is already `Document`. | as cited | no (doc + optional hardening, folded into B-7) |
| C (2): C4 is cross-tenant on the shared `127.0.0.1:11434`. | **Agree; medium on a hosted server.** The daemon sends mail bodies and editor buffers to whoever holds the port while the system Ollama is down. `sign_in.rs:90-137` already has a `/proc/net/tcp{,6}` listener→uid parser and an owner filter: C-4 should reuse it rather than add a second one (merge with B-12). | `mail_ai.rs:126-136`; `sign_in.rs:90-137` | (C4) |
| C (3): desktop root pinning (C-9). | **Agree, and extend.** The phone's file browser, drop boxes and the desktop viewers' confined reads all start at `files::ProjectDir::open_root`, which `canonicalize()`s the registered root (`files.rs:219-225, 268-275`). A root reached through a link planted inside another root is followed there too. C-9 should apply `through_planted_link` in `canonical_root` as well, or the phone stays the unpinned path. | `files.rs:219-275`; `fs.rs:2038-2049` | no (C-9 scope) |
| C (4): `synctex_*` / `calendar_*_ics` held by `core_dispatch` `UserPath`. | agree, nothing to do | `core_dispatch.rs:283-313` | no |
| A/B (C's note): the login-PTY gate × `pty_id_for` for server clients. | **Holds.** `pty_id_for` maps a client's id to its own attach PTY or the id itself. Another client's attach id resolves to a name that matches nothing (`terminal/mod.rs:1617-1638`). A login spawn that would join a running tmux tab is refused before its argv is built (`commands/terminal.rs:60-62, 138-142` `login_would_join`). The paste needs the mark of the exact spawn sequence (`credentials.rs:306-312, 440-458`). Several clients on one per-user daemon are the same account. | as cited | no |

## Review of the other drafts

| Item | Agree? | Comment / evidence |
|---|---|---|
| A1 (high, OpenCode `auth.json` `wellknown`) | agree | It touches my area: `agent_auth::link_into_home` → `reconcile_home_in` runs inside `agent_home::prepare` (`agent_home.rs:282`), which the **sidecar's** headless launches also run. With no window, a phone-started OpenCode tab (or a Tabby OpenCode chat) gets the poisoned file the same way. So A-1's content check must live in `reconcile_home_in` itself, not in a window-only keeper task, and the startup sweep must also run when the sidecar starts. For D1 I prefer (a) + (c): drop the file from the Host and assistant homes. The phone can start Tabby chats with no window, so the assistant home is reachable from a paired phone. |
| A2 (medium, OpenAI proxy spend) | agree | The phone's "<agent> (API)" start (20d7be47) needs the window and goes through the same proxy, so a stolen phone driving a keyed Codex/OpenCode tab inherits A2. No change to the severity. |
| A3 (low) | agree | Not reachable from the phone today (see answer A3). Please let A-3 also cover `claude_session_log`'s `projects/*` walk (`agent_session.rs:418-425`). |
| A4 (low) | agree | A4(b) is not reachable from the phone's worktree move: the phone lists targets from one hardened `git worktree list` (`host.rs:1722-1735`), and the desktop's `agentWorktreeSwitch` accepts only live entries. A-4's `cwd_within` change does not affect phone launches (absolute cwds; the teleport worktree path comes from `git_worktree_add`). |
| A "processes left detached": holds | agree, with a caveat | It is true for the fence. But the pane's **trailing login shell after a fenced agent exits is unfenced**, and the phone reaches it (B10 below). That is not a fence escape for the agent (`FENCE_INPUT_DRAIN` plus the pid namespace), but it is a way past the phone's "No shells" control. |
| A-5 (seccomp `TIOCSTI`) | agree | Independent of B-9. If B-9 takes option (b) (no trailing shell), `FENCE_INPUT_DRAIN` loses its reason, but keep A-5 anyway. |
| C1 (medium, unsandboxed WebKitGTK) | agree | The phone PWA and the browser desktop client run in the user's own sandboxed browser, so C1 does not reach them. C-1(b) (`disableFontFace` in `src/lib/viewers/pdfLoad.ts`) does not affect the phone's sealed pdf.js frame, which loads through `mobile-web`. |
| C2, C3, C5, C6, C7, C10 | agree | Not my area; no conflict with B steps. |
| C4 (medium on server) | agree | Merge the owner lookup with B-12 (one helper over `/proc/net/tcp{,6}`, now in `sign_in.rs`). For the decision, prefer (c), with the hosted admin's uid **required** on a server. |
| C8 (low, proxy for document fetches) | agree, one caution | On a hosted server whose only way out is an admin proxy, C-8's "no proxy for document images" turns remote markdown images off for every tenant. That is acceptable, but say so in the server guide. |
| C-9 | agree; widen | Include `mobile_control::files::canonical_root` (answer C3). |
| C "fresh-vm.sh" checks SHA256SUMS but not the signature | agree (low) | Same family as my round-1 note on the server `.deb` key being fetched from the repo itself. |
| B2 vs gap 20 (C's round-2 item) | — | Left to C. My view: the difference from C3's residual is that `web-dist` takes effect on the next page load with no rebuild or relaunch. That is the property that removed `live_pwa`. |

## New findings (if any)

| ID | Sev | Finding (evidence) | You do | Confidence |
|---|---|---|---|---|
| B10 | **medium** | **"No shells on the phone" does not hold for local agent tabs: the pane ends in an unfenced login shell that the phone can type into.** Every local command tab's tmux target runs a trailing login shell after its command exits. After a fenced agent this shell is **unfenced** (`tmux_local.rs:383-398`, `trailing_shell`; only assistant chats end with no shell, `:334-345`). The phone's catalog lists the tab by its saved kind (`agent`) and a live session (`discovery.rs:1825-1850`); nothing looks at what the pane runs now. The bridge writes the phone's input frames to the PTY as they come (`pty_bridge.rs:820`; the AI switch filters only while AI is off). So any paired phone that may open an agent tab can end the agent and then use a full shell as the user, outside the fence. This happens in the default configuration, where `shell_tabs` is off precisely because "a shell is the whole account with nothing between it and a lost phone" (`discovery.rs:1262-1266`; threat model row "Phone shell tabs", `threat_model.md:160`). Remote host agents are `exec`'d without a trailing shell (`ssh_exec.rs:572`), so B10 is local only. This predates `21eadf64`; it is new to the model. | — (paired or stolen phone; ordinary phone UI, no crafted input) | **confirmed** in code; not run |
| B11 | **medium** (same reach as B10; needs crafted input) | **`prefix None` does not keep phone input in the pane: tmux's default root-table mouse bindings open the pane menu.** Tabtivity sessions run with `mouse on` and `prefix None` (`tmux_local.rs:625-661`; remote `ssh_exec.rs:458-470`). `root_console.md:852-859` concludes from this that "no keystroke from a paired phone can … spawn past the review gate". But tmux (3.6 here, checked in the binary's built-in key table) binds right-click and Alt+right-click on a pane in the **root** table to a menu. The menu can split the window (a new pane running the default shell), respawn, or kill. Alt+right-click shows it even while the program in the pane has mouse tracking on. Nothing in Tabtivity unbinds these or restricts the session's key table (no `unbind`/`key-table` in `src-tauri/src`). The phone bridge forwards raw input, mouse reports included (`pty_bridge.rs:820`). The genuine PWA never sends any (its xterm has `disableStdin: true`, `Terminal.tsx:1474`), but a stolen phone or any client holding a session can. **Reach:** an unfenced local shell beside a fenced agent. On a **remote-host tab** (new lane, see below), a host shell for an agent tab while `shell_tabs` is off. The same holds for any tmux client whose input is not the user's own. | — (stolen phone / client holding a phone session) | tmux behaviour **plausible-high** (default bindings read from the 3.6 binary; key handling not run); Tabtivity side **confirmed** |
| B12 | info | **Host-tab tmux targets match by prefix.** `host_tmux_attach_command` / `capture` / `window_size` pass `-t '<name>'` without the `=` exact prefix (`ssh_exec.rs:1076-1101`; the local lane uses `=`, `tmux_local.rs:699-703`). If the exact session is gone, tmux falls back to a unique prefix match. That could attach the phone to a session of the user's own on the host whose name extends the tab's, and that session has its prefix key. Names are validated (`[A-Za-z0-9_-]`, so there is no glob) and the `has-session` guard runs first. It needs an odd session name on the user's own host. The plan's reason for omitting `=` (tmux 1.8 on RHEL 7 era HPC nodes) is valid. Hardening: use `=` when the host's tmux supports it, or check the exact name against the `tmux ls` answer (already done with the window up, `host_live.rs` `has_session`). | — | confirmed (code); tmux matching from its documented rules |
| B13 | low | **Desktop images follow links and are readable back by the phone** (answer A4). `desktop_images::scan` uses `fs::metadata` (follows), and the copy reads the link target. The phone can then read the inbox copy (`host.rs:5764-5788`). | — (paired phone; link must already be in Downloads/Desktop/Pictures) | confirmed |
| B14 | low | **Desktop sign-in callbacks are not owner-checked** (answer A2). `sign_in::deliver` narrows targets to the caller's uid only on a server. On a shared Linux desktop, another account listening on the CLI's callback port receives the OAuth code. Phishing-shaped forged links can also make the sidecar GET any loopback port ≥ 1024 (status only). | 2 (paste a callback) | confirmed (code) |

### Item 3 — the remote-host tab lane (`21eadf64..ff9f83ab`), full review

What I read: `ssh_exec.rs` (`host_mux_args`, `literal_control_path`,
`master_check_args`, `master_alive`, the three host tmux commands,
`resolve_control_path` + `RESOLVE_TIMEOUT`), `host_live.rs` (all), `pty_bridge.rs`
(`AttachTarget`, `attach_end_reason`, `recheck`), `discovery.rs` (`TabPlace`,
`ProjectHosts`, `host_of_tab`, `host_probe_targets`, listing), `host.rs` (every
`not_on_host` refusal, `terminal_target`, the refresher wiring), `headless.rs`,
`scheduler.rs`, `auth.rs` (`has_live_session`), `remote.rs` value helpers,
`MobileBridgeHost.tsx`/`projectTabHost.ts` (`phoneListsTab`, `activate`), and the
plan's §"no-dial" section.

| Property | Verdict | Evidence |
|---|---|---|
| Cannot dial, cannot prompt | **holds** | `BatchMode=yes`, `ControlMaster=no`, a literal `ControlPath`, `ProxyCommand=false` (the command line wins over a configured `ProxyCommand`/`ProxyJump`), `ClearAllForwardings`, `ForwardAgent/X11=no`, `PermitLocalCommand=no`, `RemoteCommand=none`, `-e none`, `--` before the host command (`ssh_exec.rs:970-1008`). The `-O check` argv adds `ProxyCommand=false` too (`:1027-1045`). One nuance: with a user `CanonicalizeHostname always`, ssh may still do a **DNS lookup** before falling through (no TCP connect). Reword the plan's "no DNS lookup" accordingly. |
| Socket path cannot be steered | **holds** | Read from `ssh -G` and accepted only when its parent is `control_dir()` (`controlpath_of`). Literal check: absolute, no `%`, no whitespace or control characters, `validate_arg` (`ssh_exec.rs:1011-1022`; `controlpath_of` `:193-199`). `control_dir()` is the state dir, `$XDG_RUNTIME_DIR/<slug>-ssh` (fence tmpfs over `/run`), or an owned `0700` `/tmp` dir (`:74-145`). A fenced agent cannot plant a socket in any of them. |
| Host, user, port come from app state only | **holds** | `ProjectHosts::of` reads `projects.json` `remote`/`compute_hosts`; a worker id that no longer resolves gives no host (`discovery.rs:565-600`). `ssh_target` refuses a leading `-`/`@`/whitespace. Nothing comes from the in-folder `project.json` or the phone. |
| Host command injection | **holds** | Session name must pass `expected_tmux` (scope-keyed, `[A-Za-z0-9_-]`, length) and `valid_tmux_session_name`, then is `shell_quote`d; a hostile name is refused, not quoted (`discovery.rs:934-948, 1349`; `ssh_exec.rs:1076-1101`; tests `:2173-2200`). |
| Nothing raw crosses the API | **holds** | Only `on_host`, plus the `host_offline` / `tab_on_host` / `session_gone` codes. The attach script silences tmux's errors (which carry the raw scope id), and ssh runs with `-q`. Test `host.rs` `a_host_tab_is_listed_on_host…` asserts no host, path, socket or session id in the detail. Residual: a user `Match exec` or `ssh_config` that prints to stderr would reach the phone's screen through the attach PTY. That is the user's own config (info). |
| Shell gating, kinds | **holds** | Host shells only behind `shells_open`; sign-in, cloud, ephemeral and `tmux_attach` tabs never listed (`discovery.rs:1334-1356`). Not covered: **B11** (mouse menu) is the way past it on the host side. |
| Routes that would act locally | **holds** | `tab_on_host` on inbox, desktop images, markup submit, sign-in and its callback, activate, and with no window: schedules, held prompts, send-now, undo-clear (`host.rs` `not_on_host` call sites; test covers all 14). Transcript and readings skip host tabs (`headless.rs:321-325, 465-467`). The scheduler never restarts a host tab (test `scheduler.rs:1034-1052`). The window side refuses activate for a host tab (`MobileBridgeHost.tsx:1339-1343`). |
| Background behaviour, HPC, ControlPersist | **holds** | No probes while no phone holds a live session. With no window, socket presence only (no `-O check`, so a quitting window's master is not kept alive). `hpc_hosts` is read from the sidecar's own settings, and an unreadable file counts as "all HPC". `ssh -G` (which runs the user's `Match exec`) is bounded at 5 s and cached 1–5 min (`host_live.rs:213-300, 311-340`). The window-size poll (every 5 s, one mux session each) runs only while a phone is attached. Info: on a host with many desktop tabs, the phone's extra mux sessions can hit sshd `MaxSessions`; the **desktop's** next `ControlMaster=auto` spawn then falls through to a fresh login (a prompt in a desktop tab). Availability only. |
| Revocation / recheck | **holds** | The 5 s `recheck` keeps the catalog's grant rule. A host tab that went unavailable closes final (`host_offline`/`session_gone`). Exit code 255 vs others decides which (`pty_bridge.rs:523-530, 894-907`). |
| Clock dependence | info | `has_live_session` and the timer lease use wall-clock seconds (B8 family). Moving the clock only changes whether probes run. |
| Server daemon | holds (as stated in the plan) | Same code; it never dials. Whether a browser client holds the lease only picks a liveness branch. |

Net: the lane itself is sound. The two real issues reachable through it (B11
on the host side, B12 as hardening) are about tmux, not ssh. Proposed threat
model row (Tier 0, phone): **"Phone — remote-host tabs.** The sidecar reaches a
remote project's host tabs only through the desktop's existing ssh master
(literal socket, no-dial argv, no prompt), with validated session names and
nothing raw on the API. Probes run only while a phone is signed in, never
`tmux ls` on HPC hosts, socket presence only with no window. Routes that would
act on this machine answer `tab_on_host`. Residual: tmux's root-table mouse
menu (B11); prefix-matched targets (B12)."

## Extra fix steps (if any)

| Step | Findings | Files | Fix | Decision? |
|---|---|---|---|---|
| B-9 | B10 | `services/tmux_local.rs` (`trailing_shell`, `local_tmux_args_on_end`), `services/mobile_control/discovery.rs`, `pty_bridge.rs`, docs (`threat_model.md:160`, `context/mobile_access.md`) | Options: **(a)** keep the trailing shell for **unfenced** command tabs only. A **fenced** agent's pane ends with tmux `remain-on-exit` (the finished run stays visible and reattachable, but takes no input). The desktop offers "Restart" or "Open a shell here" as explicit actions. This also takes away the landing spot `FENCE_INPUT_DRAIN` guards. **(b)** Keep the shell, but mark it: the pane command sets a pane user option before it `exec`s the shell. The catalog then lists such a tab as a `shell` (behind `shells_open`), and the bridge stops writing input and closes `access_revoked` once the mark is seen (checked at attach, at the 5 s recheck, and before writing a frame that contains a line end). (b) has a small window between the agent's exit and the next check. Tests either way: a phone attached to an agent tab whose agent exited cannot type into a shell while `shell_tabs` is off. | **yes**: (a) changes desktop behaviour after an agent exits. **Recommend (a)** for fenced agents: race-free, and it also removes the TIOCSTI landing spot. Fall back to (b) if the user wants to keep the trailing shell. |
| B-10 | B11 (+B12) | `services/mobile_control/pty_bridge.rs` (input path), `services/tmux_local.rs` + `ssh_exec.rs` (session options), `docs/context/root_console.md:852-859` | (1) In the bridge, drop mouse-report sequences (X10, SGR and urxvt forms) from phone input frames before they reach the PTY. Use a small stateful filter that carries a trailing partial escape over to the next frame, with a short flush timer so a lone Esc still goes through. The genuine PWA never sends mouse reports (`disableStdin`), so nothing is lost. This covers local and host tabs and every tmux version. (2) As defence in depth where tmux supports it: give Tabtivity sessions a session `key-table` of a Tabtivity-owned table that binds only the wheel and drag keys the desktop uses, so no menu, split or command prompt is bound in them. The user's root table is not edited. (3) B12: use `=<name>` on hosts whose tmux supports it (probe once per host), else keep the validated bare name. (4) Correct the root_console.md claim. | small: (2) is optional. Recommend (1) now, (2) when B-9 lands. |
| B-11 | B13 | `services/desktop_images.rs` (`scan`, `resolve`), the copy in `mobile_control/inbox.rs` call site, `docs/threat_model.md:118` | List with `symlink_metadata` and skip links. Open the chosen file `O_NOFOLLOW \| O_NONBLOCK`, `fstat` it as a regular file, and copy from that handle. Optionally require an image magic number. Add to the lost-phone row: "reads pictures in your Screenshots/Pictures/Desktop/Downloads folders". | no |
| B-12 | B14 (+C4) | new shared helper (e.g. `services::loopback_owner`, from `sign_in.rs:90-137`), `sign_in.rs:141-160`, C-4's `ollama.rs`/`mail_ai.rs` | Move `listeners`/`own_targets` into one helper. Apply the own-uid filter on every Linux build, not only on a server: fenced agents share the user's uid, so their CLIs' listeners still qualify. C-4 uses the same helper with its accepted-owner set. macOS/Windows: document the residual. | no (C-4's owner set is C's decision) |
| B-7 (amended) | docs | `docs/threat_model.md` | Also add: the remote-host-tab row above; B10/B11 under "Phone shell tabs" and the root console; C's server hop-0 condition in the server section. | no |

## Proposed overall order

1. **A-1** — the only high: one fenced agent reaches every OpenCode, including Host and Tabby (also with no window, via the sidecar). Contained fix in `agent_auth.rs`.
2. **B-9** — a paired phone gets an unfenced full shell in the default "no shells" configuration with ordinary UI input. Small code change, but needs the user's (a)/(b) call first.
3. **B-1** — unattended exfiltration of any user-readable file to a remote host by a fenced agent, plus the FIFO stall. Self-contained in the sync files.
4. **B-2** — dev-build fence escape through `web-dist` needing one routine click. This is the user's own daily build. Decision (embed vs verified copy).
5. **A-2** — unbounded API spend past the hard limit; money, not access.
6. **B-10** — closes the crafted-input route to the same shell as B-9 (and to host shells). Do it right after B-9 so the "phone input reaches the pane only" claim becomes true.
7. **C-3** — automatic, project-triggered crash of the whole app (every tab). Tiny bounded-read fix.
8. **C-1(b)** — cheap removal of the largest hostile-parser surface in an unsandboxed renderer that holds IPC.
9. **C-4 + B-12** — one listener-owner helper: closes Ollama squatting (cross-tenant on servers) and owner-checks OAuth callbacks.
10. **C-2** — Windows network contact from a hostile SyncTeX map.
11. **B-5** — Tabby's per-phone list (private chats visible to every phone). Needs a decision.
12. **B-4** — wipe phone caches on revoke. Needs a decision about markup.
13. **C-9** (with `files::canonical_root`) — pins roots for desktop viewers and the phone together.
14. **A-3**, **A-4** — agent-written path shapes; low impact, quick.
15. **B-3** — Funnel drift check over every mapping.
16. **B-11**, **C-6**, **C-7**, **C-8**, **B-6** — bounded or low-reach hardening.
17. **C-5**, **C-10**, **A-5**, **B-8** — defence in depth.
18. **A-6 + B-7 + C-11** — one serialized pass over `docs/threat_model.md`, after the code steps above land, so rows describe what shipped.

## Parallel groups

Each group touches its own files and can run at the same time as the others;
steps within a group run in order.

- **G1:** A-1 (`agent_auth.rs`).
- **G2:** B-9 → B-10 (`tmux_local.rs`, `pty_bridge.rs`, `discovery.rs`; B-10 also touches `ssh_exec.rs`). Serialize with A-5 only if B-9 option (a) drops `FENCE_INPUT_DRAIN` (comment and test churn in `tmux_local.rs`).
- **G3:** B-1 → B-6 (`remote_sync.rs`, `sync_auto.rs`, `commands/sync.rs`).
- **G4:** B-2 (`mobile_control/web_client.rs`, maybe `scripts/package-dev.sh`).
- **G5:** A-2 (`api_proxy.rs`, `api_meter.rs`, `api_prices.rs`).
- **G6:** C-3 (`ide_detect.rs`).
- **G7:** C-1(b) (`src/lib/viewers/pdfLoad.ts`) and C-5 (`format.ts`); different files, same reviewer.
- **G8:** B-12 → C-4 (shared helper first, then `ollama.rs`/`mail_ai.rs`).
- **G9:** C-2 (`synctex.rs`).
- **G10 (phone, separate files):** B-5 (`discovery.rs` scope rows + settings schema + Mobile settings UI; run **after G2's discovery change**), B-4 (`mobile-web/src/*`), B-3 (`mobile_control/config.rs`), B-11 (`desktop_images.rs`), B-8 (`mobile_control/auth.rs`).
- **G11 (independent hardening):** A-3 (`agent_chats.rs`, `agent_session.rs`), A-4 (`launch_prep.rs`, `sandbox.rs`, `agent_relocate.rs`, `git_guard.rs`), C-9 (`commands/fs.rs`, `mobile_control/files.rs`), C-6 (`git_bounded.rs`), C-7 (`google_chat.rs`), C-8 (`browser_engine.rs`), C-10 (`os_open.rs`), A-5 (`agent_fence.rs`).
- **Shared hot spots, serialize:** `src/lib/i18n.ts` + `i18nDicts/*` (B-4, B-5, B-9, C-4 add strings), `src/lib/untested.ts` (any new pill), `docs/threat_model.md` (last, one editor), `docs/filemap_backend.md` (B-12's new helper row).

---

<!-- C_review.md -->

## Reviewer C — round 2 review

The repo's HEAD is now `ff9f83ab`. Of the 13 commits after `21eadf64`, 12 are mobile remote-host work (B's area). The last, `ff9f83ab`, is a pre-push hook change in my area: it pins the bump commit's identity to `git config` and privacy-scans the bump itself. That is a hardening, with no finding. None of the files I cite below changed between `21eadf64` and `ff9f83ab`, so every `file:line` here is valid at both. Uncommitted edits in the working tree are in files I don't cite. As before, everything is read-only and from code: nothing was built or run.

## Answers to notes addressed to me

| Note (from) | Verdict | Evidence | New finding? |
|---|---|---|---|
| A-C1: `open_external_url` checks only a case-sensitive `http(s)://` prefix, then hands the URL to the system handler | **Holds. Optional hardening only.** All three `opener` 0.8.5 backends dispatch on the scheme, and a string that starts with `http(s)://` can't be read as an option or a file. Linux runs `xdg-open <url>` (or its bundled copy) with the URL as one argv. macOS runs `open <url>`. Windows uses `ShellExecuteW("open", url)` and refuses NUL. The case-sensitive check only over-refuses `HTTPS://`. Every caller in the renderer goes through `routeUri` first. `routeUri` strips TAB/CR/LF before it reads the scheme, lowercases the scheme, and passes on the despaced string. One quirk: when the first `ShellExecuteW` fails, `opener` on Windows retries with the string normalized as a *path*. That only matters if a file with that odd name exists in the app's cwd, which is negligible. If wanted: parse with `url::Url`, require a host, refuse userinfo and control characters, and pass on the re-serialized URL (C-15). | `commands/ssh.rs:255-264`; `opener-0.8.5/src/windows.rs:15-48`, `linux_and_more.rs:69-81`, `macos.rs:6-7`; `src/lib/linkTarget.ts:100-140` | no (C-15, optional) |
| A-C2: can a login PTY paste reach a respawned, non-login PTY? | **Holds.** Every `pty_spawn` first drops the id's mark (`forget_login_pty`) before anything else. Only a login spawn that succeeded sets a mark, keyed by `(pty id, spawn seq)`. The paste looks up the mark's seq and then needs `input_sender_of_spawn(pty, seq)`, which matches only when the registry entry still runs that same seq. Seqs come from a global monotonic counter and are never reused. A respawn gets a new seq, so even a stale mark that races in finds no sender. The child's exit (`forget_login_pty_spawn`) and a kill also drop the mark. One case is stated and accepted in the code: after a successful ssh login the PTY is the remote shell of that same account. | `commands/terminal.rs:55, 66, 106-120`; `commands/credentials.rs:276-339, 421-462`; `terminal/mod.rs:1603-1610, 2189`; `agent_fence.rs:2045-2053` | no |
| A-C3: `browser_engine` `FetchOrigin::Agent` holds | **Agree.** This matches my D-lead review of the Document origin. The one proxy residual (C8) applies to `Document`/`User` only. `Agent` already ignores the proxy, which is the rule C-8 proposes for `Document`. | `browser_engine.rs:1029-1075` | no |
| B-C1: the web client page CSP needs the same `base-uri`/`form-action` backlog | **Refuted for the web client.** The web client is already stricter than the desktop: `object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`. So is the phone PWA. The backlog is open **only** for the desktop window (`tauri.conf.json`). Useful corollary: the same React bundle already runs under `base-uri 'none'` and `form-action 'self'` in the browser client, so bringing the desktop CSP up to that level is low-risk (C-13). The web client's real CSP weakness is the inline-script hashes, computed from whatever `index.html` is on disk. That is part of B2. | `web_client.rs:1493`; `host.rs:711, 731`; `tauri.conf.json:31` | no (C-13) |
| B-C2: the server guide checks the `.deb` against a public key fetched from the same repo | **Confirmed. Info.** The guide fetches `release-signing.pub.pem` from `raw.githubusercontent.com/.../main` and verifies `SHA256SUMS.sig` with it. That protects against tampered release assets, but not against someone who can change both `main` and the release. That is first-install trust in the repo; updates are stronger because the desktop updater compiles the key in. Cheap improvement: print the key's SHA-256 fingerprint in `docs/guide/server.md` and on the project site, so the two are compared through a second channel, and keep it stable across releases. Mention key rotation in `release_signing.md`. | `docs/guide/server.md:110-120`; `docs/context/release_signing.md:1-12` | no (fold into C-11) |
| B-C3: gateway invite-code bias fixed | Noted. Outside my area. | — | — |

## Review of the other drafts

| Item | Agree? | Comment / evidence |
|---|---|---|
| **B2** (dev browser client served from the checkout), asked to judge against gap 20's C3 residual | **Agree it is real and outside C3. Not new code, but a new finding. It is worse than written (C10).** (1) **Not new code:** the `SOURCE_ROOT/web-dist` candidate came in with `a084b436` on 2026-10-03, which is before `eacfa41a`. The 2026-10-08 run removed `live_pwa` but missed this sibling. (2) **Not covered by C3.** C3 accepts that "an agent's commit runs at the next dev build", because building agent code means trusting it. B2 needs no commit, no build and no relaunch. `web-dist/` is gitignored (`.gitignore:12`), so changes never show in `git status`. It is rewritten by every `npm run build` (`package.json:12` runs `web:bundle`), including one an agent runs inside a fence. And it is read from disk on every request (`web_client.rs:951-980`). That is exactly the property `live_pwa` was removed for. (3) **Worse than written (C10):** hashed assets are served **before authentication** (`web_client.rs:939-947`). `serve_bundle` uses `is_file()` and `std::fs::read`, both of which follow links, with no size cap (`:955, 962`). The fence does not unshare the network namespace (`agent_fence.rs:1372` has `--unshare-pid` only, and there is no `--unshare-net`). So with Browser access on, a fenced agent in the checkout can reach any file the user can read through the unfenced sidecar, with no user action. Precondition: a dev build, with the Mobile sidecar running and `browser_client` on (default off, `config.rs:41-44`; `host.rs:7142-7149`). Severity: keep **medium** (dev builds and opt-in), but rank it near the top. The maintainer runs dev builds daily with agents in this very checkout. |
| B-2 option (a) "embed": is it feasible? | **Yes, as a dev-only embed.** `web-dist` is 17 MB in 292 files (`dist` 17 MB, `mobile-dist` 7.3 MB). Release desktop builds ship **no** `web-dist` today: nothing in `tauri.conf.json` bundles it, and `bundle_dir` falls back to `WEB_DIST` or `<control_dir>/web-dist`. So embedding only when `<UPPER>_DEV_SOURCE_ROOT` is set at compile time leaves release size unchanged. `package-dev.sh` already runs `npm run build` (which builds `web-dist`) before `cargo build` (`package-dev.sh:101-137`), so the bundle is frozen with the binary it is adopted with. That is the C3 trust level. **Don't reuse `build.rs`'s `rust_bytes`** (`build.rs:13-23`, decimal byte literals). For 17 MB it would generate roughly 60 MB of Rust source. Emit one `include_bytes!` per file instead, which is cheap for rustc, and add `cargo:rerun-if-changed=../web-dist` as `generate_mobile_assets` does. Optionally pre-gzip the files and serve them with `Content-Encoding: gzip`, which brings the extra binary size to about 4–5 MB. Keep `WEB_DIST` for the server `.deb` (`/usr/share/<slug>`, root-owned, `package-server-deb.sh:58-81`). Whichever option is picked, `serve_bundle` should also open with no-follow and check that the target is a regular file. That closes C10 for the `WEB_DIST`/`control_dir` cases too. |
| B1 (auto-sync push follows a mirror symlink) | **Agree, medium.** Same class as my new **C9** (an unfenced copy dereferences a link an agent planted) and as C3/C7/A3 (link- or FIFO-following reads by the unfenced app). The steps should reuse the same existing primitives instead of each building its own: `home_io::open_regular`/`HomeDir` (A-3, C-7), `git_bounded::read_small_regular` (C-3, C-6), and the `files::ProjectDir` held walk (B-1, C-12). No new shared step is needed, but one reviewer should check that all five use the same rule: no-follow, non-blocking, regular file checked on the opened handle, size cap. |
| B5 (FIFO wedges auto-sync) | Agree, low. Same class as C3 and C6. |
| B7 (`sync_diff` runs bare git) | **Agree, low.** It does run with the app's inherited cwd (`commands/sync.rs:2014-2018`). In the hot-reload window that cwd is the checkout, which agents work in. A diff driver or textconv still needs a *config* entry, and `.git/config` is fence-guarded, so it stays low. One caution on B-6: if it goes through the hardened builder, make sure `--no-index` still runs with `current_dir` set to the temp dir, plus `GIT_CEILING_DIRECTORIES`, `--no-ext-diff` and `--no-textconv`. Don't pin `-C <repo>`. |
| B's server-mode doc section (B-7) | Agree. Add my **C4** there (a squatted shared `127.0.0.1:11434` crosses tenants on a hosted server) and the hosted reader hop-0 note from my round 1. Also: `import_external_file` is `Core` with `sourcePath: UserPath` (`core_dispatch.rs:294`), so C9's link-following copy reaches server users too. There the copy runs as the user's own uid, so it reaches nothing new across accounts. |
| B3, B4, B6, B8, B9 | No overlap with my area. No objection. |
| **A1** (OpenCode `auth.json` `wellknown`) | No overlap. Severity looks right if the binary evidence holds. Its only touchpoint with my area: OpenCode would make the remote-config fetch from inside the fence, so `web_lane`/`browser_engine` rules don't apply. That is expected and is not a reason to lower it. |
| A2 | No overlap. |
| A3 (Claude Resume folder through a link) | Agree, low. A-3 and my C-7 (`google_chat` open-by-path) touch sibling transcript readers. Give both to one implementer, with the same `HomeDir`/`HomeFile` approach. |
| A4 | No overlap. |
| A's open follow-up "pin allowed roots" (`agent_fence::compute_fence_roots`) vs my **C-9** (`fs.rs::compute_allowed_roots`) | **Merge the decision.** It is the same follow-up (last run's #1), and it needs one user answer. The two code changes are in different files and can run in parallel, but they should share one helper: `through_planted_link`, now in `fs.rs:2000-2049`, which the server roots already use. |
| A-5 (seccomp `TIOCSTI`) | No conflict with my area. |
| **Conflicts with my area** | (1) B-2's embed must not drop `WEB_DIST`, because the server `.deb` uses it. (2) If C-13 (`base-uri 'none'` on the desktop) lands before C-5, the HTML preview's `<base href="about:srcdoc">` is blocked by inherited CSP, and relative URLs in a previewed page resolve to the app origin. With C-5's own `default-src 'none'` meta in place this is harmless, so do **C-5 first**. The web client already has this ordering problem today, which C-5 also fixes. (3) C-12 must keep following the **top-level** source of an OS drop or paste (that is the user's own pick, e.g. a link on the desktop) and stop following only inside the copied tree. Otherwise `importDrop`/`DownloadsSection` regress. |

## New findings (if any)

| ID | Sev | Finding (evidence) | You do | Confidence |
|---|---|---|---|---|
| C9 | **medium** | **File-tree copy, the cross-device move fallback and folder imports dereference links inside the copied tree.** `copy_recursive` decides by `is_dir()` and copies with `fs::copy`, and both follow links. It has no check on entries below the top level, no special-file check and no size cap (`commands/fs.rs:1420-1434`; its doc comment says the opposite). `resolve_transfer` canonicalizes and confines only the top-level source (`fs.rs:1389-1418`). Callers: `copy_path` (`fs.rs:1113`, the file tree's Copy/Paste, `FileTree.tsx:3472, 3518`), the cross-device fallback of `move_path` (`fs.rs:1152`), and `import_external_file` (`fs.rs:1255`: OS drop, Downloads, and the new **system-clipboard paste** of `42a848c4`, `clipboard.rs:63-71`, `FileTree.tsx:3565`). **What is missing:** a no-follow rule for entries below the top level. **What an attacker reaches:** a prompt-injected fenced agent can plant a link inside a project folder pointing at a host file it can't see, such as an SSH key or a CLI login. Making the link needs no access to its target. The next time the user copies, pastes or duplicates that folder, the unfenced app writes the target's *contents* into the project as a regular file, which the agent can then read or commit. The same applies to a folder from a hostile archive or repo that the user drops or pastes in. A FIFO in the tree parks a blocking-pool thread, and a link to an endless device fills the disk. Pre-existing (`8d7a9bab`, 2026-06-24) and not in the threat model; the clipboard-paste route is new since `eacfa41a`. | 2 (copy, paste or drop a folder) + 3 (agent plants the link) | **confirmed** (code) |
| C10 | medium (dev builds, Browser access on); extends B2 | **The dev browser client serves pre-auth assets by a link-following read.** `assets/*` is answered without a session (`web_client.rs:939-947`). `serve_bundle` reads through `is_file()`/`std::fs::read`, which follow links, with no cap (`:951-962`). The bundle folder is the fence-writable checkout's `web-dist/` (`:725-735`). The Host guard only checks a loopback literal (`:670-676, 858-860`), and fenced agents share the loopback network (`agent_fence.rs:1372`, no `--unshare-net`). **What is missing:** no-follow reads, and a bundle location agents can't write. **What an attacker reaches:** with Browser access on in a dev build, an agent in the checkout can read any file the user can read through the unfenced sidecar, with no user action. Another local user on the machine can too, as long as such a link exists. Fixed by B-2 plus a no-follow `serve_bundle` (merged into C-14 below). | nothing (with Browser access on in a dev build) | **confirmed** (code); not run |

Item 3 (my own "Not reviewed"), closed:

- **`PdfViewer.tsx` beyond SyncTeX: no new finding.**
  - External PDF links take only pdf.js's scheme-checked `url`, never `unsafeUrl` (`embed/pdf/links.ts:230-247`). They then go through a confirm dialog and `routeUri` with `origin: "viewer"`, so they can never become a live page in one click (`PdfViewer.tsx:3869-3905`), and then to `open_external_url`.
  - Internal destinations only scroll, with a back stack capped at 20 entries.
  - There is no `innerHTML`/`dangerouslySetInnerHTML` anywhere in `src/components/embed/pdf`.
  - pdf.js 6.4.299 no longer has any `new Function`/eval path in its worker. I checked `node_modules/pdfjs-dist/build/pdf.worker.mjs`, so no `isEvalSupported` change is needed.
  - The new "open the `.tex` by name" path (`4db6d459`) derives the candidate from the PDF's own path and checks it through the scoped `fileMtime`.
  - Page drag/paste uses the in-memory token store (`pdf_clip.rs:83-98`).
  - The presenter calls are monitor and sleep only.
  - The remaining surface is C1: embedded fonts and images parsed by WebKit, which has no sandbox on Linux.
- **`clipboard_file_paths`: no finding of its own.** It reads paths only, capped at 1000, absolute only, `metadata` only (`clipboard.rs:53-94`). On Windows, a UNC path on the clipboard is `stat`ed when the context menu opens. But only another local program can put a file list on the clipboard: web pages can't write `text/uri-list` or `CF_HDROP` through the async clipboard API. So the reach goes through C9's import path.
- **`pty_paste_clipboard_image`: no finding.** The destination is the PTY's backend-set drop dir (`commands/terminal.rs:388-411`, `drop_dir` set from `prepared.drop_dir`, `:121`). The write goes through the gap-12 drop box (`inbox.rs:223-249`: held handle, `O_EXCL`, per-file and total caps). A shell tab gets a copy in `<state_dir>/inbox`, which is total-capped. It is read under a 3 s timeout, and only when the clipboard has no text and the user pressed paste (`TerminalView.tsx:1251-1263`). `Client`-class, so a daemon never reads its own clipboard.

## Extra fix steps (if any)

| Step | Findings | Files | Fix | Decision? |
|---|---|---|---|---|
| C-12 | C9 | `src-tauri/src/commands/fs.rs` (`copy_recursive`, its three callers) | Keep the top-level source as resolved today (the user's pick). Below it, walk with `symlink_metadata`. Recreate a link as a link on Unix, matching `cp -R`/file-manager behaviour, and skip it on Windows. Skip FIFOs, sockets and devices. Open regular files with `O_NOFOLLOW \| O_NONBLOCK`, check the opened handle with `fstat`, and copy from that handle. Bound total bytes and entries per operation (for example the disk-free check plus an entry cap), and return a "skipped N links/special files" note to the UI. Tests: a link to a file outside the root, a linked folder, a FIFO, a device link, and a loop. | small: copy links as links (recommended) or skip them |
| C-13 | backlog (#869) | `src-tauri/tauri.conf.json`, `src/__tests__/…/CspTripwire.test.ts` | After C-5, add `object-src 'none'; base-uri 'none'; form-action 'none'` to the desktop CSP, matching the web client and PWA (`web_client.rs:1493`, `host.rs:711`). Extend the tripwire. | no |
| C-14 | B2 + C10 (merge into B-2) | `src-tauri/build.rs`, `services/mobile_control/web_client.rs` | **Now:** `serve_bundle` opens no-follow, requires a regular file on the opened handle, and caps size. In dev builds (`SOURCE_ROOT` set), stop serving pre-auth `assets/` from disk. **Then:** when `<UPPER>_DEV_SOURCE_ROOT` is set at compile time, `build.rs` generates `include_bytes!` rows for `../web-dist` (optionally pre-gzipped). `bundle_dir` drops the `SOURCE_ROOT/web-dist` candidate, and the embedded bundle is served from memory, with inline-script hashes computed at build time. Release builds are unchanged (`WEB_DIST`/`control_dir`). | B's decision (embed vs verified copy). I recommend the dev-only embed, which is feasible as above. |
| C-15 | A-C1 (hardening) | `src-tauri/src/commands/ssh.rs:259` | Parse with `url::Url`. Accept `http`/`https` in any case with a host. Refuse userinfo and any control or whitespace character. Pass `url.as_str()` to `opener`. | no |

## Proposed overall order

1. **A-1** (OpenCode `auth.json` content check plus sweep): the only high. One fenced agent gets code running in every scope, including the unfenced Host session and Tabby, with no user action.
2. **B-2 + C-14** (dev browser bundle): a fence escape in the builds the maintainer runs every day. C10 makes it a no-action file read when Browser access is on. The stopgap (no-follow, no pre-auth assets from disk) is tiny.
3. **B-1** (auto-sync no-follow push): an unattended read-and-upload of any user file, triggered by a fenced agent.
4. **C-12** (no-follow copy): the same fence read-escape class, triggered by one routine user action. A one-function fix.
5. **A-2** (OpenAI meter gaps): unbounded spend past the user's monthly limit.
6. **C-3** (bounded IDE-detect reads): a hostile repo can crash the app automatically, just by being shown.
7. **C-1** (desktop pdf.js `disableFontFace` plus model text): a cheap cut of the parser surface that the unsandboxed Linux renderer exposes. Needs decision 1.
8. **C-4** (Ollama listener owner): cross-tenant exposure on hosted servers, and mail auto-classify on shared machines. Needs a decision.
9. **C-2** (SyncTeX network paths on Windows): a network-credential leak from a click in a hostile repo's PDF.
10. **C-9 together with A's fence-roots follow-up**: one decision, two files. It closes last run's #1.
11. **B-5** (Tabby per-phone list): private chats on narrowed phones. Needs a decision.
12. **B-4** (phone wipe on revoke): what a stolen phone keeps.
13. **A-3, C-7** (transcript readers by handle): low, one implementer.
14. **C-5, then C-13** (preview CSP meta, then desktop CSP parity): defence in depth. The order matters.
15. **A-4, C-6, B-6, B-3, C-8**: low-severity shape and bound fixes.
16. **C-10, C-15, A-5, B-8**: hardening.
17. **A-6 + B-7 + C-11** (all `docs/threat_model.md`): one serial docs pass at the end. It also takes the C9/C10 rows, the `.deb` fingerprint note and the server-mode section.

## Parallel groups

Steps that edit different files can run at once. Within a group, run the steps in the order listed.

- **G1** `services/agent_auth.rs`: A-1
- **G2** `api_proxy.rs`, `api_meter.rs`, `api_prices.rs`: A-2
- **G3** `services/mobile_control/web_client.rs`, `build.rs`: B-2/C-14
- **G4** `remote_sync.rs`, `sync_auto.rs`, `commands/sync.rs`: B-1, then B-6 (B-6 shares `commands/sync.rs`)
- **G5** `commands/fs.rs`: C-12, then C-9
- **G6** `services/agent_fence.rs`: A's fence-roots follow-up, then A-5
- **G7** `services/ide_detect.rs`: C-3
- **G8** `commands/synctex.rs`: C-2
- **G9** `commands/ollama.rs`, `services/mail_ai.rs`: C-4
- **G10** `src/lib/viewers/format.ts`, then `tauri.conf.json` and the tripwire test: C-5, then C-13. `pdfLoad.ts` (C-1 code part) can go in parallel with this group.
- **G11** `services/git_bounded.rs`: C-6
- **G12** `services/google_chat.rs`, `agent_chats.rs`, `agent_session.rs`: C-7 and A-3 (separate files; one implementer is preferred)
- **G13** `services/browser_engine.rs`: C-8
- **G14** `services/os_open.rs`: C-10
- **G15** `commands/ssh.rs`: C-15
- **G16** `launch_prep.rs`, `sandbox.rs`, `agent_relocate.rs`, `git_guard.rs`: A-4
- **G17** phone and sidecar, each in a separate file: `mobile-web/src/*` (B-4), `discovery.rs` (B-5), `config.rs` (B-3), `auth.rs` (B-8)
- **Serial, last:** `docs/threat_model.md` (A-6, B-7, C-11)

None of these steps adds a Tauri command, so `commandClasses.ts` doesn't need regenerating. C-14 changes `build.rs`, so after a backend edit run `npm run backend:stale`, and give the dev build a full `package-dev` pass, not a hot reload.
