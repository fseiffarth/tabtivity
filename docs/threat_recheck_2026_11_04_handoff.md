# Threat recheck 2026-11-04 — raw reviewer reports

Five read-only reviewers checked HEAD `b3abe5ba` on 2026-11-04: A agents, fence,
credentials, API proxy, Tabby; B the phone; C remote machines, remote-only
projects, sync, VPN, server mode; D window perimeter, IPC, viewers, desktop voice,
Apps view, supply chain; E mail, calendar, MCP lanes, git-push MCP. Bases:
`ff9f83ab` (the 2026-10-24 full recheck), `0ce3cfd1` for the phone and `9bbbb4e2`
for mail (the 2026-10-26 passes). Code read only: nothing was built, run or
live-checked.

This file is raw material: the reports as written, with line numbers as of
`b3abe5ba`. The merged result is in `docs/threat_model.md` ("Gaps found
2026-11-04"), where the letter IDs below became gap numbers:

| Gap | Report | Gap | Report | Gap | Report |
|---|---|---|---|---|---|
| 74 | C1 + D1 | 85 | C4 | 96 | B4 |
| 75 | E1 | 86 | C5 | 97 | B5 |
| 76 | E2 | 87 | D5 | 98 | B6 |
| 77 | A1 | 88 | E3 | 99 | B7 |
| 78 | A3 | 89 | E4 | 100 | D2 |
| 79 | B1 | 90 | E8 | 101 | D4 |
| 80 | B2 + D3 | 91 | E9 | 102 | E5 |
| 81 | B3 | 92 | A2 | 103 | E6 |
| 82 | B8 | 93 | A4 | 104 | E7 |
| 83 | C2 | 94 | A5 | | |
| 84 | C3 | 95 | A6 | | |


---

## Reviewer A: agents, fence, credentials, API proxy, Tabby

Range: `ff9f83ab..HEAD` (b3abe5ba). Most of the 2026-10-24 fixes sit between `ff9f83ab` and `b76b3eb2`
(the commit that recorded them). I read that part only to check it is still present, and read
`b76b3eb2..HEAD` (612 commits) for new code.

### 1. Range and files read

Read in full or by diff with `-M`, real content only (test modules moved into `tests.rs` files and the
`services/agent/`, `services/api/`, `services/mcp/` moves were not treated as new code):

- Fence and spawn: `services/agent/agent_fence.rs` (roots, `drop_planted`, remote-only `None`, seccomp
  `ioctl` BPF: layout and jump offsets checked by hand), `launch_prep.rs` (pinned refusal, features
  record, `agent_defaults::apply` ordering), `agent_bin.rs` (`opencode2` alias shim), `agent_shim.rs`,
  `sandbox.rs` (`docker_exec_args` quoting), `tmux_local.rs`, `terminal_service.rs`, `terminal/mod.rs`,
  `ai_switch.rs`.
- Credentials: `agent_auth.rs` (OpenCode `admissible`/`opencode_adoption`/`importable`, sweep, wellknown
  flag, sign-out), the auth path list in `agent_registry.rs` against the old one in `commands/agents.rs`
  (identical, 17 entries), `cli_overview.rs`.
- Updates and checks: `agent_latest.rs` (daily check, Antigravity manifest source, store),
  `agent_versions.rs`, `agent_install.rs` (`self_update_argv`), `codex_package.rs` (prefetch),
  `commands/agents.rs` (`update_agent`, `update_command`, `check_updates_of`, daily loop, `agent_usage`,
  `agent_overview`, model-row commands), `commands/ollama.rs` release check (`latest_ollama_tag`,
  `daily_release_check`).
- Defaults and display: `agent_defaults.rs`, `agent_features.rs`, `model_rows.rs`,
  `assistant_model_probe.rs`, `commands/assistant.rs`, `agent/assistant.rs` (system prompt, `@` change),
  `web_lane.rs` diff (only `crate::` paths and `floor_char_boundary`), `agent_turn.rs`
  (`note_input_from`), `commands/terminal.rs` (`pty_input_from`, `agent_tab_features`).
- Readers: `opencode_store.rs`/`opencode_session.rs` (local-model resume, `session_part`),
  `agent_changes.rs`, `agent_history.rs`, `google_chat.rs`, `agent_sqlite.rs` diffs.
- Frontend: `TerminalLimitHandoff.tsx`, `limitHandoff.ts`, `emptyAgentTab.ts`, the reader composer
  and Codex-hook-trust key changes (commits 9f367256, 485c2055, b4e835ad), `TerminalReaderFiles.tsx`.
- API proxy: `api_proxy.rs`, `api_meter.rs`, `api_prices.rs`, `agent_api_keys.rs` diffs from `b76b3eb2`
  are import-path changes only. The OpenAI hardening (gap 48) predates `b76b3eb2` and was not re-audited.
- Presence of the fix code for gaps 42, 49, 50, 54, 55, 56 and the seccomp `ioctl` rule was confirmed by
  grep. 42 was also read through.

Skipped: `commands/ollama.rs` and `services/ollama_client.rs`/`local_drivers.rs` bodies, which are the S5
refactor (a pure move as far as the diff and the tests show; `ollama_http` still calls the
`loopback_owner` check). Phone, remote, voice, supply chain and viewers (other reviewers).
No builds, no test runs, no live check.

### 2. New gaps

### A1. low: a screen line makes the app start a second agent CLI with the transcript

**Row text.** **Open (low).** `TerminalLimitHandoff` scans the last 25 screen rows of a local agent tab for
a line that looks like a usage-limit notice (`hasCliLimitNotice`, a regex over `you've hit your limit`,
`rate limit reached`, `quota exceeded`, …). On a match it offers, and with the remembered "never ask"
choice (`agent_limit_auto_handoff`) silently performs, a switch: a new tab of the next installed CLI in
the user's order, same folder and location, whose first prompt is the last 20 prompts and answers of the
conversation (1200 characters each) as a JSON blob inside a fixed sentence. The screen is the agent's own
output, so a prompt-injected agent (or a hostile file it prints) can fake the notice. What it gets: its
text, reworded as the user's first message, in a fresh session of a different CLI. That CLI runs in its
own permission mode, with its own login and billing, and without the first session's approvals. The new
tab is fenced like any other, and `aiIsOff()` is honoured. The gain is only a more permissive neighbour
CLI; the dialog (without the remembered choice) still needs the user's click.

**You do.** Run a local agent tab in a project with a second CLI installed and, for the silent form, tick
"never ask" once.

**Evidence.** `src/components/terminal/TerminalLimitHandoff.tsx:70-95` (screen check, then `handoffRef`
when `agent_limit_auto_handoff`), `:35-58` (transcript into `initialInput`),
`src/lib/agents/limitHandoff.ts:5-8` (the regex). Not live-run.

**Fix.** Take "limit reached" from a source the agent cannot write (Codex's rollout `rate_limits` via
`cli_overview::codex_limits_in`, Claude's `/usage` panel or hook) instead of the screen. Or never hand off
silently, and show the quoted line in the dialog. Pass the transcript as a file attachment to the new tab
rather than typed text.

### A2. hardening: the tab hover card reads the agent-writable home by path

**Row text.** **Open (hardening).** `agent_features` (hover card Features rows, command
`agent_tab_features`, class core) parses the CLI configs in a tab's agent home by path: `.claude.json`,
`.codex/config.toml`, `.gemini/settings.json`, and `read_dir` of `.claude/skills` or `.codex/skills`.
`read_small` checks `symlink_metadata` of the last component and then `read_to_string(path)`. A directory
the agent replaced with a link on the way (`.codex`, `.claude`) is followed, and a file swapped for a FIFO
between check and read parks a blocking-pool thread for good. The skills listing has no entry cap and
stats `SKILL.md` per entry, so a few hundred thousand planted folders make each hover slow. The output is
names only (cut to 64 characters, control and invisible characters stripped, at most 40), so nothing
leaks and nothing is acted on. It is the one reader of an agent home that skips `HomeFile`/`HomeDir`
(gaps 49 and 55 did the rest).

**You do.** Hover an agent tab.

**Evidence.** `services/agent/agent_features.rs:141-147` (`read_small`), `:167-200`
(`own_mcp_servers`), `:204-215` (`skills`, `read_dir` plus `.is_file()`, which follows links).

**Fix.** Read through `home_io::HomeFile::open_existing(home, rel)` with a size cap and
`within_deadline`. List skills with `HomeDir::names()` capped at a few hundred.

### A3. low: Tabby's `@` attachment exception widens the fetch-URL leak, and its only guard is a prompt line

**Row text.** **Open (low).** Since 0ef9e531 the Tabby system prompt tells the model that a file the user
attaches with `@` "arrives as a Read result", that "the user sent it, so answer from it", and that it
still must not follow instructions in it. Claude Code reads an `@` path itself whatever `--tools` says.
So a chat can now hold the contents of a user file, plus any readable file in the fence the sender
names: the host root is read-only visible, and the Tabby home holds every shared login copy. The same
chat has `web_fetch`/`web_search`, and the lane has no URL allowlist (public addresses only). A hostile
page the chat reads can ask the model to put the attached text into a fetch URL or search query. The
existing residual ("the conversation can leak through fetch URLs and search queries") already covers
typed text; the `@` path adds files and, from a paired phone with Tabby access, any fence-visible path,
with only the model's refusal (the docs measured Haiku refusing `~/.ssh/config` and a home listing) as
the guard. Compare gap 16: a paired phone can already `cat` the same logins in any agent tab, so the
phone part adds nothing new; the file-content-plus-web part does.

**You do.** Attach (or send from the phone) a private file to a Tabby chat and have it read untrusted web
pages in the same chat.

**Evidence.** `services/agent/assistant.rs:35` (prompt exception), `:29-40` (SYSTEM_PROMPT is the same
text for Claude `--append-system-prompt` at `:389`, OpenCode at `:483`, Codex at `:818`),
`docs/context/assistant.md` ("The `@` exception is load-bearing"), `services/mcp/web_lane.rs` (no URL
filter beyond address class).

**Fix.** Once a chat has had an attachment, let the web lane drop query strings and fragments (and cap
the fetched URL's path length) for that tab, or stage each `web_fetch` on a card. Say it in the Tabby
row's residual. A Claude `permissions.deny` for `Read` on the home's credential paths in the assistant
home's `settings.json` would also keep an `@` path from reading the logins (unverified that `@` honours
deny rules).

### A4. hardening: probes and `agy update` run the user's CLI with the user's real `$HOME`, now on a timer and from two new screens

**Row text.** **Open (hardening).** `agent_usage` (`claude -p /usage`), `probe_agent_version`
(`--version` of every installed CLI), the warm-up cron, and `update_agent`'s `agy update` for Antigravity
start the registry CLI on the host, unfenced, with the app's own environment: no `$HOME` override, so
the CLI reads and writes the user's real `~/.claude`, `~/.gemini`, … (Claude files its print-mode session
under `~/.claude/projects/` by cwd, which the code comment accepts). AGENTS.md says an agent's `$HOME`
is its Tabtivity home; these are not tabs, but they are agent CLI processes that now run more often: the
daily release check re-probes any CLI whose cached `--version` went stale, `agent_overview` runs
`claude -p /usage` whenever the CLIs view opens (and for the phone's CLIs section, floored at 10 s and
cached 60 s), and `agy update` replaces a host-installed `agy` too ("a host copy gets it too",
`update_command`), which writes into a path Tabtivity does not own ("Tabtivity never edits another app's
paths or config"). The cwd is `<state>/agent-cron`, which no fence mounts, so a fenced agent cannot plant
a `CLAUDE.md` or `.claude/settings.json` there. There is therefore no escalation; the harm is mixed
accounts (the CLIs view shows the plan from Tabtivity's login store but the usage windows from the real
home's login) and user-owned files touched.

**You do.** Open Models & agents or the CLIs view; click Update on Antigravity; or wait a day.

**Evidence.** `commands/agents.rs:1584-1592` (usage spawn), `:424-433` (`update_command`: `resolve_spec_path`
then `command_no_window(&bin)`), `:1647-1662` (`agent_overview`), `services/agent/agent_registry.rs:657-690`
(`warmup_dir`, `probe_agent_version`), `paths::command_no_window` sets PATH only.

**Fix.** Give these runs an agent home of their own (the `agent-cron` folder as `$HOME`, with the stored
login placed by `agent_auth` the way a spawn does), so the usage numbers match the plan row. Refuse
`update_command` for a binary outside the install home and say so, as `agent_install` already does for
read-only host copies in the fence.

### A5. hardening: OpenCode token rotation takes any token string, and no account guard exists for OpenCode

**Row text.** **Open (hardening).** The gap 42 fix lets a tab's copy of OpenCode's `auth.json` rotate
`refresh`, `access` and `expires` of an `oauth` entry the store already holds, with `type`, `accountId`
and `enterpriseUrl` pinned. The values are not otherwise checked, and for the entries that carry no
`accountId` the pinned fields say nothing about whose token it is. The account guard that stops one
scope from rewriting another's login exists only for Codex (`tokens.account_id`) and Claude (the
`emailAddress` in the home's own, agent-writable `.claude.json`); `account_of("opencode")` is `None`.
A fenced OpenCode that writes tokens of the attacker's own account into the rotation is adopted, and the
shared login then carries every other scope's, the Host session's and Tabby's OpenCode traffic to that
account. Same class as gap 16's accepted residual (every CLI but OpenCode takes the copy as is), narrower
for OpenCode and not mentioned in the gap 42 residual. Unverified in practice: OpenCode's response to a
mismatched `accountId`.

**You do.** Run OpenCode in a scope where an agent is prompt-injected, with a shared OpenCode login.

**Evidence.** `services/agent/agent_auth.rs:354-396` (`opencode_adoption`), `:213-225` (`account_of`).

**Fix.** Pin an identity for an OAuth entry at import (a hash of the first `refresh` prefix, or the JWT
`sub`/`accountId` claim) and refuse a rotation whose identity differs. Alternatively keep the rotation
out of the tab's reach: only the keeper, running outside a fence, refreshes the token.

### A6. hardening: model rows read off a tab's screen are stored per CLI build and shown in other tabs' model sheets

**Row text.** **Open (hardening).** `remember_model_rows` (core) stores the rows the renderer read from a
tab's own model picker, under the CLI's registry id and executable identity (`model_rows.json`: at most
64 rows, 200-character labels, 400-character notes). Another tab of the same CLI build, the phone's model
sheet and Tabby's chip then list them before their own picker is drawn. The picker screen is the agent's
own output, so a fenced agent can draw a fake picker and plant labels (including long, misleading notes) in
other scopes' sheets. A tap is answered in the live picker by its label, and a label the live picker lacks
is never answered, so nothing is typed that the CLI did not offer; the harm is display-only. Tabby's
own list is kept apart (`screens`, from its probe). Unverified which frontend paths call
`remember_model_rows` and whether they check that the picker is the CLI's real one.

**You do.** Open a model sheet in a second tab of the same CLI.

**Evidence.** `commands/agents.rs:1896` (`remember_model_rows`), `services/agent/model_rows.rs:84-100`,
`:118-130`.

**Fix.** Remember rows only from a tab whose hook-recorded state says the CLI is at its picker, or
re-read them from the CLI's own `models` output where it has one. Or keep the cache per scope.

### 3. Regressions

None found in my area. Checked in code: the OpenCode login content check, the startup sweep (window,
sidecar and daemon all call `sweep_unadmissible`), gap 49's `agent_sqlite` opener (now also used for the
new `session_part` table), the gap 50 `loopback_owner` check on `ollama_http`, gap 54's `service.json`
merge, gap 55's handle read, gap 56's `cwd_within`, `drop_planted` in the fence roots (a planted first
root now yields `None`, so the spawn is refused), the seccomp `ioctl` rule (BPF jump offsets and
architecture numbers verified by hand), live-session writes through `write_live_record`, the
`opencode2` alias now shimmed, and `docker_exec_args` now quoting the pidfile. The new
`agent_defaults::apply` sits after `grant_lanes`, so `VIBE_ACTIVE_MODEL` cannot change a Vibe tab's MCP
authority; `is_local_model` is later read only by the keyed-Claude and container-refusal checks, which
are not Vibe-reachable. No permission-mode flag is injected anywhere in the new code (grep of the diff).
Gaps 1 to 41 were not individually re-audited.

### 4. Stale rows

- **"Tabby" tier 3 row** ("Whatever its CLI's pinned tool set allows ... no shell tool, no project
  roots"). Add: "Tabby ships on by default (9833cb7c); `assistant_enabled()` is true for an absent
  setting. A file the user attaches with `@` is read by the CLI itself whatever the tool set says, so a
  chat can hold file contents (gap A3); the model line list (`assistant_claude_models`) starts a
  short-lived Claude in the assistant fence with `--tools ""` and `--strict-mcp-config`, typing only
  `/model`, Enter, Down and Esc, once per Claude build." Replace "Code-read 2026-10-24, not run" with
  "Code-read 2026-11-04, not run". Residual: add "attached files' contents".
- **Gap 57** (`Tabby ignored per-phone lists and was on by default with its experimental flag`). Replace
  the residual with: "with no list set, every paired phone reaches Tabby, and the switch is on in a
  fresh profile (9833cb7c), so a newly paired phone has Tabby until a list is set."
- **"Fenced agent on Linux" row**, sentence "Every CLI install ... is read-only in the fence with its
  updater off (2026-09-26); updates are a reinstall through Manage CLIs." Add: "Antigravity updates with
  its own `agy update` (its installer stops at 'already installed'); Codex's package is fetched ahead of
  the installer and checked against the channel's digest; a daily background check asks each registry
  for the newest version and stores it (display only)." The `opencode2` alias OpenCode's installer
  writes is shimmed like `opencode`; mention it beside the "typed CLI" sentence if one exists.
- **"Scheduled agent prompts / warm-up cron" row** (`Warm-up and the /usage probe run in
  <state>/agent-cron`). Add that the probes run with the user's real `$HOME` (A4), and that the CLIs view
  and the phone's CLIs section now trigger the `/usage` probe.
- **Header paragraph** (ends at the mail pass). Add the 2026-11-04 recheck and the new gap range.
- Module names in prose (`services::agent_auth`, `services::agent_fence`, `services::api_proxy`,
  `services::web_lane`, `services::assistant`) still resolve through the re-exports in
  `services/mod.rs`; only the file paths moved. No edit needed unless the file names are cited.

### 5. New surface with no row

1. **Daily release check** (tier 0). "Background release check | npm (`registry.npmjs.org`), PyPI, GitHub
   (HEAD of the release page, REST fallback), Antigravity's release manifest host, and Ollama via a
   `curl` child, once a day per installed CLI after a 90 s delay, hourly tick | The answer is a version
   string that is parsed, size-capped (4 MiB) and shown; nothing is installed or run from it. A request
   names only the app in its User-Agent; no token, no account. It stores `agent_latest.json`. There is
   no setting to turn it off (it runs in the window; the daemon does not start it). | ✅" Note the missing
   opt-out as a hardening item for the privacy list.
2. **CLI install, update and Codex prefetch** (tier 4). "Update CLI | Re-runs the vendor's installer
   (`curl | sh`) into Tabtivity's install home, or `agy update` on the resolved Antigravity (a host copy
   too). Codex's 200 MB package is fetched first (`codex_package`): channel JSON from the vendor, digest
   `sha256` from that JSON checked, size cap 2 GiB, resumed `.part`, `tar -xzf` into a staging folder
   in the install home, then the installer finds the release complete | You click Update/Install; same
   trust as running the installer yourself. The digest comes from the same channel as the file, so it
   protects against corruption and a bad mirror, not a compromised vendor. | ⚠️ yours"
3. **Launch defaults per CLI** (tier 3). "Default model and effort | `settings.json`
   `agent_launch_defaults`, set in the model pickers or by a paired phone, appended as the CLI's own
   `--model`/`--effort` (or `-c model_reasoning_effort`, or `GOOSE_MODEL`/`VIBE_ACTIVE_MODEL`) to new,
   non-resumed, non-local-model, non-assistant sessions after the MCP lanes are decided; value at most
   256 characters, no control character, not starting `-`, effort from a per-CLI list | Never a
   permission mode. A phone with the setting can change which model a tab starts on (and its API-key
   spend, still limited by the proxy). | ✅" (the phone side is for B).
4. **CLI overview** (tier 2/3). "CLIs view / phone CLIs section | Plan names from the login store
   (`subscriptionType`, `chatgpt_plan_type`, unverified JWT claims, shown only), Codex limits from the
   newest rollouts in every home (agent-writable, read through `HomeDir`, 256 KiB tail), Claude's panel
   from `claude -p /usage` (A4) | A phone gets no account and no path-naming line. A fenced agent can
   forge the Codex numbers shown (display only). | ✅"
5. **Tab hover card Features** (A2) and **Tabby model probe** (in the Tabby row above).
6. **Limit hand-off** (A1), as a tier 3 row if A1 stays open.
7. **`opencode2` shim**: one clause in the fence row (above).

### 6. Handed off

- (C / remote) `services/remote/agent_host_move.rs` copies a Claude transcript from an agent-writable
  home to the remote login's `~/.claude/projects/<slug>/` and the host's Claude resumes it unfenced:
  agent-authored history promoted to a less-confined session. Reads go through `HomeDir` and names are
  uuid-checked; the class is "conversation poisoning across the fence", low.
- (B / phone) `pty_input_from` writes `<uid>.from` into the project slice (agent-writable, handle write)
  and `tabtivity-send` routes files to the phone or desktop by it. An agent can pick the screen. The
  `GET /api/v1/clis` route and the phone's launch-defaults edit.
- (D / viewers) The Reader's new Files tab (`TerminalReaderFiles`, e9b82aba) and chat links (c1753d42)
  render files and open web links named in agent text in the main webview; the link asks first, the file
  viewer does not (gap 21/51 class).
- (E / mail, MCP) `root_mcp` was restructured into `root_mcp/` submodules (S-series); not read.

---

## Reviewer B — the phone (sidecar, browser API, PWA), 2026-11-04

HEAD `b3abe5ba`, range `0ce3cfd1..HEAD` (87 commits touch `mobile_control/` or `mobile-web/`). Read-only; nothing built or run.

### 1. Range and files read

Read in full or in the relevant part (all under `src-tauri/src/services/mobile_control/` unless noted):
- `host.rs`: the whole `router` (8246-8340), every non-GET handler's guard (scripted scan, see below), `create_tab`/`creatable`/`phone_machines`/`master_up`, `move_tab_location`, `launch_defaults`/`save_launch_defaults`/`model_rows`/`remember_model_rows`, `cli_overview`, `diverged_*`, `tab_named_files`, `desktop_images`/`attach_desktop_image`, `open_ticket`/`authenticate_or_ticket`, the whole files block 7470-8140 (`files_scope`, `host_files_scope`, list/entry/search/raw/upload/folder/zip/remarks/upload-undo), the `terminal` upgrade guard, `phone_transcript`, the cache-header sites, `security_headers` and the CSPs.
- `files.rs` diff (synthetic-nonce tokens, `open_served`, `search_in`, `walked_paths`, `lookup`), `serve.rs`, `files_zip.rs`, `uploads.rs` (head, `stage_body`, `make_folder`, `remove_made_folder`), `remarks.rs`, `host_files.rs` (first 330 lines: session, realpath proof), `named_files.rs`, `diverged.rs`, `outbox.rs` diff (`sniff_media`), `deadline.rs`, `presence.rs`, `admin.rs` diff, `pty_bridge.rs` diff, `discovery.rs` diff (root opt-in, `pinned`, `machine_label`, `public_label_of`), `headless.rs` root refusals.
- Outside the dir: `services/agent/agent_defaults.rs`, `cli_overview.rs` (`for_phone`), `model_rows.rs`, `commands/fs.rs` `resolve_text_paths_blocking`, `commands/mobile_control.rs` diff, `src/lib/mobileDiverged.ts`, `MobileBridgeHost.tsx` dispatch, `schema/settings.rs` switches, `tmuxSession.ts`.
- `mobile-web`: `main.tsx`, `voiceProbe.tsx` (header, network calls), `handsFree.ts`, `screens/terminal/useHandsFree.ts`, `useVoiceInput.ts` (dictation path), `forgetDeviceData.ts`, `slashCommands.ts` header, `sw.js` diff, `answerMarkdown.ts` diff, HTML-sink grep, storage grep.

Scripted check (gap 66): I parsed `host.rs` and, for every `post/put/delete` handler in the router (68 of them), checked that its body reaches `exact_origin`, `mutation_guard` or `upload_scope`. All do; the terminal upgrade checks `exact_origin` at 5977.

Skipped: `auth.rs`, `config.rs`, `phone_origin.rs`, `web_client.rs`, `limits.rs`, `push.rs` body (unchanged since `0ce3cfd1` except 13 lines of push; so pairing, challenge, session, tickets' storage and the connection caps are as the last pass left them); `markup*.rs`, `outbox.rs` beyond `sniff_media`, `inbox.rs`, `chat_*`, `git_overview.rs`, `scheduler.rs`, `headless*.rs` beyond the root/create refusals; the mail/calendar/todo handlers; the `mobile-web` screens beyond what is named above (no new HTML sink beyond the two known ones, checked by grep); Windows-only code (`files_windows.rs`); the desktop-side handlers of `Create`/`MoveLocation`; `docs/` other than the threat model and the Phone analysis section.

### 2. New gaps

No high and no medium. Four low, four hardening.

| ID | Sev | Row text | You do | Evidence | Fix |
|---|---|---|---|---|---|
| B1 | low | **Open (low).** Running-shell command lines now cross the browser API. The 2026-10-26 build emptied each running shell's `command` (and `cut`) before the transcript left, and AGENTS.md says commands never cross; `c6fadf19` (10-27) removed that on purpose so the chat can open the whole command. A command line carries absolute host paths, cwd changes and whatever the agent put inline (tokens in headers, passwords on a command line); it reaches every paired phone that sees the tab, in the transcript answer. The phone's Terminal view shows the same screen text, so no new capability, but the invariant and the "Phone analysis" text are now wrong. | — (paired or stolen phone) | `host.rs:4873-4885` (comment: "cross whole, command line included"), `4879` `phone_transcript` no longer calls the old `empty_shell_commands`; `agent/agent_transcript.rs:270` `RunningShell.command`; `git show c6fadf19` (`-empty_shell_commands`) | Either put the stripping back (description only, a "view in Terminal" link) or, if the owner wants the command, change the AGENTS.md invariant and the threat-model text to say running-shell command lines cross, cut at the Reader's bound, and scrub the project root from them. |
| B2 | low | **Open (low).** Hands-free voice (`focusHandsFree`, opt-in, off unset) answers the numbered rows of the question the agent waits on from a single spoken number ("2", "option two"), with no chime and no cancel window; only a dictated prompt gets the 1.5 s window. The mic reopens after every turn, so speech near the phone (a podcast, a passenger, a video call) can answer a permission prompt or pick "don't ask again". Dictation also goes to the browser's speech service unless on-device is available (gap 69), and the same loop reads agent answers aloud. | turn on Hands-free in the Focus menu | `useVoiceInput.ts:126` (`handsFree.pick.current(step.insert)` → `guard.reset()`, returns), `useHandsFree.ts:120-131` (`voicePickRef` → `answerQuestion(option)` at once), `handsFree.ts` `voicePick`; shared `matchOption` accepts a bare digit or ordinal; whether permission dialogs are among the "questions" `liveQuestion` is built from is **unverified** (it is the numbered-dialog parser `selectPrompt.ts`) | Run a voice pick through the same send guard (chime plus cancel window), or refuse voice picks on a dialog whose rows grant a permission or persist a rule; show "Heard: 2" before acting. |
| B3 | low | **Open (low).** A paired phone's **Model and effort** save is a persistent write to the host-wide `settings.json` (`agent_launch_defaults[cli]`), not a per-tab choice: every later launch of that CLI in every scope — the root console and the unfenced Host session included (`apply_in` skips only assistant, login and local-model launches) — starts on the phone's model string. The value is bound only by length 256, no leading `-` and no control characters (the desktop form's rule), then goes into argv/env; it can pick a pricier model or one the user never chose. Revoking the phone does not undo it (unlike gap 14's schedules and rules), and nothing records which phone wrote it. | — (paired or stolen phone) | `host.rs:5829` `save_launch_defaults` → `agent_defaults.rs:318` `save_in` (`patch_json`, `rev += 1`); `agent_defaults.rs:164` `apply_in` skip list; `agent_defaults.rs:293` `check` | Keep the phone's choice per-tab (type `/model` into the live session, as the sheet already can) and leave the saved default to the desktop; or record the writing device and clear its entries on revoke, and refuse the Host session's launches. |
| B4 | hardening | **Open (hardening).** An upload is staged to disk, hashed, **then** checked against the per-project 1 GiB/24 h cap: the cap is `store_staged`'s, after `stage_body`, so a paired phone with Upload here on can stage up to 1 GiB per request in the sidecar's state dir with no cap hit (concurrency bounded only by the 256-connection limit), then be refused. **New folder** has no count cap or log: only bytes are counted, so empty folders are free, and the folder is not in the upload log, so the desktop's "Added to projects" never lists it. | upload / New folder (both switches on) | `host.rs:7918` (`stage_body` before the cap), `uploads.rs:200-240`, `uploads.rs:564-596` (`MADE`, `make_folder` no count), `MAX_UPLOAD_FILE = MAX_UPLOADS_PER_DAY` at `uploads.rs:56` | Reserve the project's remaining daily budget before staging (refuse when the declared length or the remaining budget is exceeded, count in-flight stagings), cap stagings in flight, and give New folder a per-day count and a log line. |
| B5 | hardening | **Open (hardening).** The Diverged **resolve** (take a side, delete the host copy, delete the mirror copy) trusts one client-side confirmation: the sidecar checks `project_sync` and the sealed tokens, then the window runs the orange view's own commands; the route takes no preview token, so a paired phone can call `resolve` without ever calling `preview`, and the window does not repeat the `project_sync` switch (its dispatch comment: "the sidecar has checked its switches"; `shell_tabs`, `root_access` and `local_models` are repeated). `delete_host` removes files on the user's remote account. Whether `careful_hosts`/`hpc_hosts` gating is applied by `resolveAll`/`applyDeleteAll` is **unverified** (not read). | resolve from the phone (`project_sync` on) | `host.rs:2113-2152`, `diverged.rs:33` `sync_open`, `MobileBridgeHost.tsx:3066-3068`, `lib/mobileDiverged.ts:123` `divergedResolve` (`stillStands` re-check is the only server-side guard) | Have `preview` return a short-lived fingerprint token that `resolve` must echo for destructive ops (the `remote_unpair` pattern), and repeat `project_sync` in the window's dispatch. |
| B6 | hardening | **Open (hardening, unverified).** The Download-as-zip entry names are the file names below the folder, written unchanged. On Unix a name may hold `\` or control characters (only `/`, NUL, `.`/`..` are refused; the `\`/`:` refusal is Windows-only), which some phone extractors read as a separator — a zip-slip on the phone's storage by a project-planted file name. Whether the `zip` crate (9.0.5) normalises `\` in `start_file` was not established. | download a folder as zip | `files_zip.rs:78` `zip.start_file(inside.as_str(), …)`, `files.rs:149-155` `plain_segment` (backslash only on Windows) | Skip or rename entries containing `\`, control characters or a leading `-`/`~` before `start_file`. |
| B7 | hardening | **Open (hardening).** Every phone attach runs `tmux set-option -s terminal-overrides[77] vt100:dim=\E[2m` on the **shared default tmux server** — locally (the desktop passes no `-L`) and on a remote host through the ControlMaster. It is in-memory, fixed-slot and matches only a `vt100` client, but it is a server-wide option in the user's own tmux, at an index the user's `tmux.conf` could also use, and "Tabtivity never edits another app's config". | attach a tab on the phone | `pty_bridge.rs:413` `tmux_keep_dim_command`, `ssh_exec.rs:1170-1177` `TMUX_VT100_DIM`/`host_tmux_keep_dim_command`, `tmux_local.rs:85` (no `-L` on the desktop) | `terminal-overrides` is server-wide in tmux, so a per-session form does not exist: either pick the slot by scanning for a free index (or append), or give the phone's attach its own `-L` socket-less alternative (a `TERM` the stock terminfo already gives dim for); and say in the tier rows that attaching a phone sets a tmux server option. |
| B8 | low | **Open (low).** Gap 58's forget misses the composer's **slash-command history**: up to 30 lines (200 chars each, with arguments) per CLI, in localStorage, never cleared by `forgetDeviceData()` on an `unpaired` answer. A revoked or lost phone keeps what was typed after `/`. | — (lost phone) | `forgetDeviceData.ts:22-28` (no slash call), `slashCommands.ts:23-30,266` | Add `forgetSlashCommands()` to `forgetDeviceData`; also `projectOrder`/`seenDone` (ids and counters only, optional). |

### 3. Regressions

None found. Every fixed gap in my area still holds at HEAD:
- 43/44: `MouseReportFilter` is still in the input path (`pty_bridge.rs:748`); the diff only adds an inter-write throttle (`input_gap`, 80/200 ms) and the dim override. Remain-on-exit untouched.
- 45 (browser client), 59 (Funnel): `web_client.rs`, `config.rs` unchanged.
- 57: `assistant_devices` untouched; the only change is `roots.extend(chat_folders(...))` in `drop_box_roots` (sweeping only).
- 58: improved (see 4).
- 60: `desktop_images` handler unchanged in guards; the desktop command now also takes a `chat_uid` and writes into that Tabby chat's own folder (`commands/mobile_control.rs:153-170`), which is a widening of 65, not a break of 60.
- Session/ticket/origin/CORS: `auth.rs` is unchanged since `0ce3cfd1`.
- Path confinement of every new file route holds: sealed tokens opened per request against the project's raw id (a separate binding for the host side and for Diverged), `ProjectDir` held-handle walk for list/entry/search/zip/remarks/upload/folder, `open_served` returns the proven descriptor (never reopens by path), `files::valid_rel` hides `.git`, the project folder and `.env*` everywhere a token opens, `search_in` rejects an invalid `under`, `walked_paths` skips links. Host side: each request proves `realpath(root+rel) == root+rel` (`host_files.rs:277`, `still_proven` after the read; the swap window is documented there).
- Deterministic tokens (`synthetic_nonce`, HMAC of raw id + path under a key derived from the same host key) do not weaken the AEAD (the nonce never repeats for two plaintexts under the same AAD); they only make equal paths seal equal, which the phone was shown anyway. Tests cover project/host/path separation.
- `named_files` cannot be used as a path oracle: `resolve_text_path` joins each phone-sent string to the tab folder/project root, drops anything that does not stay lexically below it before touching the filesystem, canonicalises, requires the real path to stay below the base, then `file_row` proves it again; an absolute or `..` candidate outside the project is never stat'ed.

### 4. Status of gaps 65-70

| Gap | Status | Evidence |
|---|---|---|
| 65 desktop pictures + clipboard | **Unchanged, slightly widened.** Still no switch; `GET`/`POST …/desktop-images` need only a session and a reachable tab. New: the picture can be attached into a Tabby chat's own folder (`chat_uid`), and Tabby can read an attached file with `@` (`0ef9e531`), so the clipboard image can reach an agent that has the web lane. | `host.rs:6271-6385`; `commands/mobile_control.rs:148-170` |
| 66 SameSite / Origin | **Unchanged, holds.** All 68 write handlers (including the 13 added since: diverged preview/resolve, location, launch-defaults, model-rows, folder, upload undo, folder undo, remarks, switch model, etc.) reach `exact_origin` through `mutation_guard`/`upload_scope`/direct. Step P2's router test (every write route refused a foreign/missing Origin) is **still not written** (`host/tests.rs` has only per-route origin cases and `every_data_route_refuses_an_unauthenticated_request`). One side-effecting GET exists: `GET /api/v1/clis?refresh=1` (runs the CLI's `/usage` probe, "still floored"); a same-site tailnet page could trigger it, not read it. | `host.rs:8246-8340`; scripted scan |
| 67 "no shells" bounds tabs not commands | **Unchanged, widened.** Through the same paired session a phone can now also move an agent between machines (`POST …/location`, window respawns the CLI on a host), and, with `project_sync`, delete or overwrite files on the remote account from the Diverged list (B5). Threat-model row 67 and the shell-tabs row mention only `!` and Runs-on. P3 (document in the phone rows/help) not done. | `host.rs:5603`, `2113` |
| 68 Host session excluded by accident | **Unchanged.** Nothing in the Rust catalog or the bridge reads `hostSession` (no hit in `mobile_control/` or `MobileBridgeHost.tsx`); exclusion still rests on `shouldPersistLocalTab` (`tmuxSession.ts:159-174`: root agents never tmux-wrapped, root shells are). New: root is opt-in per phone (below), which narrows who could be hurt by a change to that rule, not what it rests on. Headless create/reopen/undo of a root tab are refused (`headless.rs:993,1079`, `host.rs:5390`). P4 not done. | as cited |
| 69 dictation leaves the tailnet | **Changed (partly stale as worded).** The listening status already says which engine is in use ("Listening on this device…" / "Listening with the phone speech service…", `mobile.voice.listeningLocal/Remote`, since 2026-09-15), so "no mark says which" is wrong; there is also a Focus-menu choice `voiceRemote` that forces the speech service. Still true: where on-device is not offered the fallback to the vendor service is automatic, and there is no "on-device only" setting. Widened by 2026-10-28 voice work: read-aloud (`speechSynthesis`, default voice, no `localService` check) and hands-free (B2); a network TTS voice would receive agent answers (unverified per browser). | `useVoiceInput.ts:94`, `voiceInput.ts:114-146`, `speechOutput.ts:239-252`, `i18n/en.ts:974-982` |
| 70 revoked phone keeps cached files | **Changed (widened, not fixed).** No `Clear-Site-Data` and no `Referrer-Policy` anywhere. Beyond inbox pictures: versioned outbox pictures are now `private, max-age=86400, immutable` too (`5011ae58`); every **project file** the library opens from this computer streams with `Cache-Control: private, no-cache` plus an `ETag` (`serve.rs:21,126`) — `no-cache` stores the body and revalidates, so film/PDF/text bodies and covers sit in the browser's HTTP cache past `forgetDeviceData()`; the zip and the PDF get 5-minute ticket URLs (the zip's `?dir=` token and ticket in history). Improvement inside 58 (below). | `host.rs:6727,6821,6828`, `serve.rs:119-128`, `host.rs:8012` |
| 58 (related) | **Improved.** `forgetDeviceData()` now also calls `forgetFiles()` (favorites, recents, folder colours, file cards, last folders), so the "Files favorites and recents are not forgotten" residual is gone. New miss: B8. | `forgetDeviceData.ts:16,26` |

### 5. Stale rows

1. **Phone bridge** (tier 0), "…Root console from the phone only behind a default-off switch plus write review "all" under a working fence (or with the root MCP tools off); root has no per-phone list, so when on it reaches every paired phone."
   Replace with: "…Root console from the phone only behind a default-off switch plus write review "all" under a working fence (or with the root MCP tools off), **and only for the phones named in `root_devices`**: the list is opt-in (absent, empty or malformed is no phone), so a switch already on gives no phone root until the user ticks one, and a phone paired later starts off root. The list narrows the switch and the review gate; it never opens either (`discovery::root_devices`, `38c9b118`)."
2. **Phone bridge**, "The file browser uses project-bound sealed path tokens." — add: "Tokens are deterministic (same path, same project, same host key seal to the same token, `synthetic_nonce`), so the phone can key covers and favorites by them; the host side and the Diverged list seal under bindings of their own."
3. **Phone project files and PDFs** (tier 4), opening words "A paired phone can browse an enabled local project's tree and read files." — replace "local project's tree" with "an enabled project's tree on this computer and, for a remote project, its tree on the primary host over the desktop's ControlMaster (`?on=host`, read-only, sealed host-side tokens, per-request `realpath` proof; see the new row in section 6)". Add: "This computer's side streams the file from the proven descriptor with no size cap (a text is served as its first 24 MiB), one `Range`, `ETag`/`If-None-Match`, cache policy `private, no-cache`; bytes are typed by magic number, now including films, sounds and HEIC/AVIF (`sniff_media`); Download-as-zip streams up to 2 000 files / 1 GiB of a folder."
4. Same row, "response bytes are capped" → "the remote side and a text are capped at 24 MiB; this computer's other files are not."
5. Same row, "**The one write, Upload here**… ≤ 24 MiB per file… Nothing is staged, committed or synced… the target folder … never created" → "There are now four writes, each behind its own default-off switch that counts only while `project_files` is on: **Upload here** (`project_uploads`; ≤ 1 GiB per file and per project per 24 h, staged on disk first in `mobile-control/upload-staging`, B4), **New folder** (same switch; an empty folder under the phone's name, no dot name, undoable within the hour while empty), **Annotate → Save** (`project_remarks`; appends highlights and sticky notes to an existing PDF as an incremental update: file unchanged since read, regular file, no link, cut back on failure, `remarks.rs`) and the **Diverged list's resolve** (`project_sync`; take a side, delete the host or mirror copy, forget; run by the window over the orange view's commands, B5). Remarks and New folder are not in the upload log."
6. **Pair a phone** (tier 4), "…and a second one under it lets the phone add new files to a project folder it browses (add-only, no dot folders)" — add the two new switches (`project_remarks`, `project_sync`) and "global model/effort defaults (B3)".
7. **Phone — remote-host tabs**, "Nothing raw — host, path, socket, session id — crosses the API" — a machine's **label** crosses and falls back to the host name when the record has no display name (`machine_label`, ≤120 chars; the ＋ sheet, the library's remote side, tab cards). Say so, or make the fallback an opaque "Machine 2".
8. **Phone — remote-host tabs / shell-tabs rows**, gap 67 text: add "move an agent to another machine from the tab menu, and (with `project_sync`) delete host files from the Diverged list".
9. **Phone PWA: agent answers, outbox gallery**, "The phone's own `.tabtivity/inbox/` files are read back by leaf" — add: versioned outbox pictures are kept a day (`immutable`); answer links may carry a `data-path` attribute (allowlisted, only a path the tab's folders resolve); nothing else in the sanitizer changed.
10. **Gap 57** residual and **gap 69** row (see section 4); **gap 70** row: add the project-file and zip cases.
11. `schema/settings.rs:90`: the doc comment on `project_files` ("browse and read (never change)") is stale since uploads, folders and remarks; and the 2026-10-26 plan sentence "Running shells carry the agent's description, never the command line" is stale (B1).

### 6. New surface with no row

| Tier | Item | Mark | Proposed row text |
|---|---|---|---|
| 4 (shared with 292) | **Phone: remote tree of a remote project** (`?on=host` on list, entry, search, raw, ranges) | ✅ / ⚠️ paired-device access | "With `project_files` on, a paired phone reads the remote project's tree on its primary host through the desktop's existing ControlMaster (SFTP subsystem, no-dial argv, nothing of its own to dial or prompt; `host_offline` without a master). Same sealed-token rules under a host-only binding; each request proves `realpath(root+rel)` is itself (no link on the way, leaf included) and again after the read; folders and regular files only, same hidden names; at most 24 MiB per answer; one SFTP session per host, dropped after 60 s; a search walks at most 500 folders / 10 000 names / 10 s. **Residual:** SFTP holds no handle, so a leaf swapped between proof and open is narrowed, not excluded; no `hpc_hosts` gate (each call is user-driven, but a login node sees up to 16 parallel opens per listing). Code-read 2026-11-04, not run." |
| 4 | **Phone: PDF remarks written into a project PDF** (`project_remarks`) | ⚠️ paired-device access | "The one in-place write the phone has to an existing project file: highlights and sticky notes appended to a PDF as an incremental update. Needs `project_files` and `project_remarks` (default off, read per request); body ≤ 2 MiB, marks bounded like markup; file ≤ 24 MiB, `%PDF-` magic, unchanged since the phone read it (size + mtime, rechecked on the open descriptor), no link, regular file, failed append cut back; a PDF in a dot folder is allowed (uploads refuse those). The bake is the sidecar's own PDF parser run on a hostile file (bounded, panics caught). Not logged, no undo beyond truncating. Not live-verified." |
| 4 | **Phone: Diverged list and resolve** (`project_sync`) | ⚠️ paired-device access | "A remote project's mirror-vs-host differences, with a unified diff of one file. Reading needs `project_files`; **resolving** (pull, push, delete host copy, delete mirror copy, forget) needs `project_sync` (default off). Rows cross as display paths plus tokens sealed under their own binding; hidden names cross as a count. The window does the work (no window: `desktop_unavailable`), re-checks each path against a fresh status pass (`stillStands`). The sidecar checks the switch; the window does not repeat it; no preview token binds a resolve to what the phone confirmed (B5). Not live-verified." |
| 4 | **Phone: New folder + Undo**, **Download as zip** | ⚠️ paired-device access | "Upload's switch also lets the phone make an empty folder (never a dot name), undoable for an hour while empty; any folder of this computer's side can be fetched as a stored zip (≤ 2 000 files and 1 GiB, hidden names and build caches skipped, links never followed, every file read through a held folder; 5-minute ticket URL). Entry names are unsanitised on Unix (B6). Not live-verified." |
| 4 | **Phone: model/effort sheet and CLI overview** | ⚠️ | "`GET /api/v1/clis` lists each CLI's plan and usage (account e-mail and path-naming panel lines removed; `?refresh=1` makes the window run Claude's `/usage` probe, floored); `PUT …/launch-defaults` writes the CLI's startup model and effort host-wide (B3); `POST …/model-rows` stores picker rows the phone read off a live screen (≤64 rows, 200/400 chars, cache only, keyed by CLI build)." |
| 4 | **Phone voice: dictation, read-aloud, hands-free, `?voiceProbe`** | ⚠️ | "Dictation uses Chromium's on-device model when offered, else the browser's recognizer (audio may leave the phone: the status line says which; Focus menu can force the service); read-aloud speaks agent answers with the browser's default voice; hands-free sends a dictated prompt after a chime and cancel window and answers numbered questions by a spoken number with no window (B2). `?voiceProbe` renders a developer probe page only with the cached untested-tags flag on: no API call, no pairing needed, microphone only; slated for deletion (S11). `Permissions-Policy` still allows the microphone for the page itself only." |
| 4 | **Root per phone** | ✅ | "`root_devices` (opt-in, empty by default; absent/malformed = none) narrows `root_access` and the review gate; applies to the catalog, terminal re-check, push and every route, since root is a scope with a device list like any other; headless create/reopen/undo refuse root." |
| 0/4 | **Move an agent between machines** (`POST …/location`) | ⚠️ paired-device access | "Takes an opaque location id the sidecar maps against the project's runnable machines, needs a live master (`ssh -O check`) and AI on; the window respawns the CLI there. Only remote projects with two or more places, agents that are resumable." |
| 4 | **Prompt suggestion / Open from Diffs / file find / favorites / auto tab names / held prompts** | ✅ | No new trust boundary: a suggestion read off the screen only fills the draft (never sent); find/entry/favorites go through the same sealed-token routes; a tab's first prompt (≤120 chars) is its label for every phone that sees the tab (`public_label_of`). |

### 7. Handed off

- (A) `agent_defaults::apply_in` injects the saved model into the unfenced Host session and root launches (B3) — A should decide if the Host session should ignore saved defaults.
- (A) Tabby can now read a file attached with `@` (`0ef9e531`) and the phone can attach the desktop clipboard picture into a chat folder (gap 65 widening): the picture plus the web lane is an exfil-shaped path worth A's look.
- (C) Phone `resolve` ends in `useSyncStore.resolveAll`/`applyDeleteAll`: whether `careful_hosts`/`hpc_hosts` and `services::local_loss` apply to phone-driven deletes was not read.
- (C) The phone's remote-side file reads open up to 16 SFTP files at once on an HPC login node; no `hpc_hosts` check.
- (D) The sidecar's `/desktop/*` browser client and `web_client.rs` are unchanged since `0ce3cfd1`; nothing to add.
- Doc nit for the owner: `docs/context/mobile_access.md` still describes root as "every paired phone" only if not updated by `38c9b118` (it was edited in that commit; not re-read).

---

## Reviewer C: remote machines, remote-only, sync, VPN, project transfer, server mode

Range `ff9f83ab..b3abe5ba` (HEAD). Read-only; no builds, no tests, nothing run.

### 1. Range and files read

Read in full or in the changed parts (with `git diff -M`, moves from the S4/S5 refactors treated as moves):

- Remote-only: `services/remote.rs` (posture, `local_copy_in`, `mints_mirror`, projects cache), `schema/project.rs` (`RemoteSpec`), `commands/projects.rs` (create/import posture, `set_remote_mirror_dir` reverse conversion, `move_tree`/`copy_tree_core`), `commands/remote_unpair.rs` (Remote -> Remote-only), `services/launch_prep.rs` (`Pin`, `pinned_spawn_refusal`, synced-worker refusal), `commands/sync.rs` (full diff), `services/remote/{sync_auto,sync_op,worker_sync}.rs` (diffs), `remote/host_search.rs` plus `commands/search.rs` and `commands/fs.rs` host arms, `remote/remote_scaffold.rs`, `commands/git_publish.rs` (host publish), `ssh_exec` host git (`run_git_remote`, `remote_git_init`, `host_hooks_off_refusal`, `host_git` probe), `git/git_peer.rs` (host arm: `remote_git_args`, `hardened_remote_script`, ref writers), `git/git_hardened.rs` (config lists, host-git block; `HARDENED_CONFIG` unchanged vs `ff9f83ab`), `git/git_bounded.rs` diff.
- Host reads and moves: `remote/remote_transcript.rs`, `remote/agent_host_move.rs`, `ssh_exec` `parse_session_agent`/`tmux_start_command_script`, `commands/remote.rs` `remote_tmux_agent`, `src/lib/remote/hostSessionTab.ts`, `commands/agents.rs` host-transcript callers.
- Sync: `remote_sync.rs` (`pull_file_any_size`, `pull_file_streamed_with`, `staged_mirror_file`, `replace_local_atomic`, rsync flags and probes, manifest reader), `sftp.rs` (`list_dir_raw_on`, `read_file_on`, `is_single_component_name`), `tar_stream.rs`.
- Transfer: `commands/project_transfer.rs` (diff, import/scrub path, host-copy export `pack_host_tree`/`pack_tar`, `settle_imported_posture`, `drop_imported_openvpn`, `exported_entry`), `project_transfer/set.rs`, `tree_copy.rs`.
- VPN: `services/openvpn.rs` diff (`pkexec_kill`, `pkexec_argv`, pidfile registry), `paths.rs` (`system_executable`, `elevated_argv`), `commands/openvpn.rs` `vpn_can_connect_silently`, `commands/ssh.rs` (probe classification, `web_url_to_open`), `docs/context/remote_autoconnect.md`, `src/stores/projects.ts` (`hostOptIn`, `reconnectAllHosts`).
- Other: `fs_confine.rs` (first 260 lines only: planted-root fences), `loopback_owner.rs` (logic, not callers), `storage::plain_component`/`remote_project_dir_in` (the `d0cdd7f4` fix), `mobile_control/host_files.rs` (first 330 lines), `services/command_class.rs` and `core_dispatch.rs` diffs, `src-gateway/src/policy.rs` and `services/server/*` diffs.

Skipped or only skimmed: `remote_credentials.rs`, `ssh_common.rs` beyond its diff and the accept-new/first-contact bits, the byte-bundle transport inside `git_peer.rs`, `worker_sync.rs` beyond its diff, `docs/server.md`, `src-serverd`, `src-gateway` beyond `policy.rs`, the rest of `fs_confine.rs` (`open_confined`) and `host_files.rs`, the frontend remote-only cockpit (F1-F10), the phone's remote-only code (B has it).

### 2. New gaps

IDs C1..; renumber into #74+ when merging.

### C1. Medium. An imported project bundle/set adopts the authority-bearing parts of its registry entry

**Row text.** **Open (medium).** Importing a project bundle or a project set (`import_project_export`, member imports too) writes the bundle's registry entry into `projects.json`, the record Tabtivity trusts for "what runs and where". It scrubs only `openvpn` (with `auto_connect`, but only when an `openvpn` block is present), `vm`, `remote_only`, the phone keys and the push/CI confirmations. Everything else travels, and the bundle's author controls it:
(a) A `remote` spec naming the author's host with `auto_connect: true` and `key_auth: true` (the "recorded, not user-set" flag) passes every gate of the unattended-connect rules (own opt-in, eligibility). At the next launch or project activation the app dials that host with `BatchMode` and `StrictHostKeyChecking=accept-new`, offering the user's agent keys and accepting the host key without a click. A worker in `compute_hosts` carries the same two flags. What the author gets: the user's public keys, a trusted host-key entry, and an SFTP/ssh session whose server output the desktop then parses; with a user `ForwardAgent` default also agent use on the host.
(b) A `sandbox` block (`enabled`, `image`, `dockerfile`, `spec_source_hash`): `source_needs_decision` treats a matching `spec_source_hash`, or a `dockerfile`/`image` that detection would not produce, as already decided, so the O#143 "docker build runs RUN steps as root with network" dialog is skipped for a Dockerfile the bundle ships. (Whether the first tab then builds at once was not traced: unverified.)
(c) The push level (`git_push_mcp.level`, test `bundles_carry_no_push_or_ci_confirmations` says "the level and the protected branches travel") and other per-project levels (schedule MCP level: key not traced, unverified) come from the author.

**You do.** Import a project (or project set) file from someone else, then launch or open it.

**Evidence.** `commands/project_transfer.rs:2513-2528` (the whole scrub: `drop_imported_openvpn` at 1878, `settle_imported_posture` at 1027), `:2549-2550` (`vm`, confirmations), test at `:3103` ("the descriptive and settings fields are the whole point - they stay"), `:3194`; `schema/project.rs:108-115` (`auto_connect`, `key_auth` "not user-set"); `src/stores/projects.ts:116-124` (`hostOptIn`: `spec.auto_connect === true` is the opt-in); `services/remote/ssh_common.rs:295` (accept-new); `commands/projects.rs:1700-1716` (`source_needs_decision`); `docs/context/remote_autoconnect.md` (the three gates).

**Fix.** Import adopts an allowlist of descriptive keys and resets the rest to defaults: strip `auto_connect` and `key_auth` from the primary and every worker, drop `sandbox.spec_source_hash` (and `dockerfile`/`image`, or force the confirm), reset the push/schedule/MCP levels to their defaults. Show the host the bundle names in the import dialog.

### C2. Low. Project move/duplicate/convert copies through a path that has no tree_copy guards

**Row text.** **Open (low, availability).** The folder copy behind archive, "move the mirror", Duplicate project (copy) and the Remote -> Remote-only move-out is `copy_tree_core`, not `tree_copy` (gap 47). It calls `fs::copy` on everything that is not a link or directory, so a FIFO a fenced agent planted in the project or mirror blocks the copy forever (opening a FIFO for read waits for a writer; not run). It has no entry, size or depth bound. In the conversion, `move_out_blocking` runs while the project's mutation lock (`sync_op`) is held, so the stuck copy also blocks every manual sync of that project. Links are recreated, not followed, so this is availability only.

**You do.** Archive, duplicate or convert a project whose tree holds a planted FIFO (a cross-device move or a copy; a same-device `rename` skips it).

**Evidence.** `commands/projects.rs:793-815` (`fs::copy(&from, &to)` at 811), `:736` (`move_tree`), `:5657` (`copy_dir_all`), `:4843`; `commands/remote_unpair.rs:528-582` (`move_out_blocking` before `drop(op)` at 582). Unchanged since `ff9f83ab`; gap 47's row lists "cross-device move" but means the file tree.

**Fix.** Use `tree_copy::copy_tree` (links kept, specials skipped, bounded) for `copy_tree_core`, or skip non-regular files with an `lstat` check and add the entry/size/depth bounds.

### C3. Low. Host-fed whole-file reads in the new transcript/move code

**Row text.** **Open (low, availability).** `remote_transcript` and `agent_host_move` size-check a host file from the directory listing and then read it with `sftp::read_file_on`, which reads the whole file into memory with no limit of its own. A host account that grows or swaps the file between the listing and the read (or, for a move, simply holds many large files) can exhaust the desktop's memory: `/proc/<pid>/environ` and `sessions/<pid>.json` (up to 200 pids, 64 KiB each by listing), `agent-<id>.meta.json` (up to 500), and in a move `<id>/…` files (`MAX_BYTES` 256 MiB each, up to 4000 files, all held in a `Vec` before writing). The Reader of a host tab reaches the first two on a 1.5 s clock with no click; a move needs the user to move the tab.

**You do.** Open the Reader or Chat of a tab running on a host (transcript reads); move an agent tab onto or off a host.

**Evidence.** `services/remote/sftp.rs:782` (`read_file_on`), `remote/remote_transcript.rs:411`, `:415`, `grow_subagents` meta reads, `remote/agent_host_move.rs:274-335` (`collect_host`, `MAX_SIDE_FILES` 4000, `MAX_BYTES` 256 MiB, no total).

**Fix.** A bounded reader (`read_up_to(limit)`, as `host_files.rs` has) for these reads, and a total byte budget for a move.

### C4. Low. A hostile or compromised host can steer the ssh probe verdict (and so the headless VPN step)

**Row text.** **Open (low, hardening).** Since `f68033d8` the probe verdict is read from ssh's raw stderr (`ssh_unreachable`: substring markers such as "Connection closed by", "Connection reset", "Host is down"; refused if the text contains "permission denied", "authentication" or "host key"). A server's pre-auth banner and any text before a failed auth reach that stderr, so the host being dialled can make itself read as unreachable (or as rejected). "Unreachable" now drives two things: the re-try timer and, on the first attempt of an auto-connect, the headless OpenVPN step (`pkexec`, so a system polkit dialog) for a project that has a tunnel configured and `vpn_can_connect_silently`. Impact is bounded: it can raise the project's own configured tunnel dial once per activation, or suppress retries. That a banner reaches the captured stderr at default log level is expected from OpenSSH but not run here: unverified.

**You do.** Nothing beyond having the project auto-connect enabled; combine with C1 for a host the attacker chose.

**Evidence.** `commands/ssh.rs:697-717`, `probe_verdict` `:725`; `docs/context/remote_autoconnect.md` ("The classifier reads ssh's raw stderr now").

**Fix.** Classify from ssh's exit code plus a fixed set of lines that start with `ssh: ` (client-generated: `connect to host`, `Could not resolve`) instead of any substring of the whole stderr.

### C5. Low (hardening). Host-chosen sizes with no total bound in a manual pull and in host-copy export

**Row text.** **Open (low, hardening).** A manual pull now streams a file of any size (`pull_file_any_size`; only the per-chunk stall and "no more than the listed size" bound it), the rsync fast path takes `--max-size` = the largest listed file, and a file/folder pull has no free-space or total check (the listing and the sizes are the host's; the user's preview is the only guard). The host-copy export (`pack_host_tree`/`pack_tar`) writes whatever tar stream the host sends into the user's bundle file with no entry, byte or link-list cap (`links` is a `Vec` held to the end). A hostile host can fill the disk or memory on a click the user thinks is bounded. Background auto-sync keeps its 64 MiB per-file cap (still unlimited in count).

**You do.** Pull a big file or folder by hand; export the host's copy of a project.

**Evidence.** `services/remote/remote_sync.rs:1081-1152`, `:1406-1413`; `commands/project_transfer.rs:1227-1330` (no cap in `pack_tar`); `commands/sync.rs` pull arm (`pull_file_any_size`).

**Fix.** A free-space check against the preview's total before a manual pull and a cap (entries, bytes) in `pack_tar` that fails the export, as `tree_copy` does (200 000 entries, 32 GiB).

### Not reported, checked and fine

- `host_search.rs`: every embedded value is `shell_quote`d, `--` before the query, `-F`, `find -type f`, `grep -r` (no link following inside the tree), `validate_rel_root` refuses `/`, `.`/`..`, control characters, hit paths are re-checked by `clean_rel`, output capped 16 MiB, HPC guard, connected-only, never dials.
- Host names written locally (`remote_transcript` copies, subagent folders, `agent_host_move` writes, HPC log pull, mirror pulls): all names come from `list_dir_raw_on`, which drops anything that is not one component; ids are uuid-shaped; local writes go to the state dir or through `HomeDir` handles.
- Host git: `run_git_remote` takes `hardened_git_args`, refuses hook verbs on a git older than 2.9, bounded; lockstep's host arm and scripts are hardened (`remote_git_args`, `hardened_remote_script`); `init_host_repo` commits only the scaffold's own files on an unborn top-level repo, hooks off. Only `remote_git_init`'s `git rev-parse --is-inside-work-tree` runs bare (read-only).
- Sessions-view reopen: the host's start-command word is mapped through `AGENT_ITEMS`/`RESUMABLE_AGENTS` (a built-in only), session id uuid-checked.
- Pinned spawn: `launch_prep` re-derives the posture from `projects.json` (`Pin::of`), so a planted `location: local` cannot pull a tab off the host.
- Gate "every sync command checks the posture" is pinned by a source-scan test in `commands/sync.rs`.

### 3. Regressions

None found. Rows 3, 35, 46, 56, 64 hold in the new code:

- 3: every new host-name join is single-component filtered or uuid-shaped; the `d0cdd7f4` fix (`remote_project_dir_in`, `plain_component`) covers `git_peer`, `local_loss`, `remote_sync`, `worker_sync` joins; `archive_root().join(id)` sites call `validate_project_id`.
- 35: rsync flags are unchanged except `--max-size` now follows the listed maximum (see stale rows).
- 46: all mirror reads in `commands/sync.rs` and `sync_auto.rs` go through `mirror_lstat`/`read_mirror_file`/`push_file_atomic(mirror_root, rel, ..)`.
- 56: the local_only cwd gate in `launch_prep` still compares against `mirror_dir`.
- 64: `diff_no_index_command` is hardened, run from an empty temp dir.

Partial coverage, not a regression: gap 47's `tree_copy` is not used by the project-level move/duplicate path (C2).

### 4. Stale rows

1. **"Byte-sync / worker sync from a remote host"** (tier 1/2): "The rsync fast path lands what the SFTP floor would: listed regular files up to 64 MiB" -> "listed regular files; a manual pull streams a file of any size up to the size the walk listed (bounded chunks, 120 s stall, refuses a file that grows), the rsync fast path runs with `--max-size` = the largest listed file, and background sync still caps a file at 64 MiB. Byte-sync, auto-sync and worker code fan-out refuse or skip a remote-only project (`byte_sync_refusal`, `has_mirror_to_sync`, `wants_code_fanout`)." Add after "Residual": "a manual pull has no free-space or total bound (C5)".
2. **"Connect VPN"** (#868): add "`pkexec`, `openvpn`, `kill` and `sudo` are taken by absolute path from root-owned system directories (`paths::system_executable`/`elevated_argv`), never a bare name on `PATH`; OpenVPN runs with `--persist-key` and (Linux) `--mlock`; a missing root-owned copy fails the connect." Residual unchanged.
3. **"Remote / VPN auto-connect"**: "Spot-checked only." -> "Read 2026-11-04: the VPN step runs only on the first attempt of an auto-connect, only when the probe says unreachable (from raw ssh stderr, C4), skips a tunnel already up or connecting and needs `vpn_can_connect_silently`; re-try timers and Reconnect all never dial it. The opt-in (`auto_connect`, `key_auth`) comes from the project record, which an imported bundle can set (C1). Reconnect all is a click: it dials HPC-tagged hosts too (`background: false`) and never prompts."
4. **"Background git - lockstep / worker sync"**: "Local calls go through `hookless_git_command_in`" -> add "the host arm runs `hardened_git_args` (fsmonitor off, `core.hooksPath=`, no `protocol.ext`) and its batched scripts get a hardened `git()` shim with `--no-ext-diff --no-textconv`; a hook-running verb is refused on a host git older than 2.9; a host repo's own `filter.*` keys and `.git/config` remain the host's business."
5. **Gap 47 row**: add to Residual: "The project-level move/duplicate/convert copy (`copy_tree_core`) is a separate path with none of these guards (C2)."
6. **"Still open" paragraph**, last item ("the bundle-import / gap 33 marker question (moot unless `project_transfer` writes into a local-model home; not traced)"): traced at the import tail: bundle contents land in the project directory, the mirror, `project.json`, the registry and the session file only; no local-model home write seen. Mark it closed/moot, but note the bundle's registry entry is a larger question (C1).
7. **Tier 0/1 rows for sync ("Auto-sync to remotes")**: the "(the notice is in memory only...)" text is still right; no change.
8. **Server mode / Deferred**: add the new `core` commands that act on hosts or conversation stores (`remote_project_init_host`, `remote_unpair_mirror(_preview)`, `agent_tab_move_host`, `remote_tmux_agent`, `sync_scan_host_new`); path arguments of the new bundle/set/mirror commands are in the `core_dispatch` confine table (`export_project_set.destPath`, `inspect_project_bundle.bundlePath`, `set_remote_mirror_dir.path`). Nothing else in the server crates changed except `ollama_listener_uid` (policy field).
9. **Header** ("Gap rows run up to #73", "none fixed yet"): update to this recheck.

### 5. New surface with no row

Proposed rows (tier, mark, text):

- **Tier 1/2, remote-only projects** (a host-pinned project; `RemoteSpec.remote_only`, VM = remote-only + boot) - ⚠️. "No local tree exists, so mirror-based attack surface is gone: no byte-sync, auto-sync, lockstep or synced worker, no local exec_trust subject (git hooks, latexmkrc, project prettier), no local copy of host files except explicit Download-to. The posture is written by the backend only (request-level `remoteOnly`; any `remote_only` inside a renderer-sent spec is stripped; a bundle's is settled from its contents) and re-derived from the state-dir `projects.json` at every spawn (`Pin::of`), so a planted `location: local` cannot pull a tab off the host; local-only tabs, local-model tabs and synced-copy workers are refused with a `{UPPER}_REMOTE_ONLY` sentinel; every mirror reader answers through `mirror_dir_opt`/`local_copy_in`. The host is the whole trust surface: its file names, listings, grep hits, git output and transcripts are untrusted input to the viewers (names single-component filtered, rel paths cleaned of `..`, output and size capped). Host git is hardened and bounded; the host's `.git/config` stays the host's. Residual: the host account can run anything the login can (as for every host tab); unattended connect to the host is gated by the project's `auto_connect` (see C1 for an imported project); conversion keeps the old local copy on disk (never deleted) and refuses while it holds work the host lacks."
- **Tier 2, host search and quick open** - ✅. "One bounded `grep -rnIF`/`find` over the pooled master, never dials, HPC-tagged hosts ask first, every value quoted, results capped (50 000 paths, 16 MiB, 2 000 chars a line)."
- **Tier 2/3, a host tab's conversation read off the host** (Reader, Chat, phone Focus; `remote_transcript`) - ⚠️. "Claude's transcript, the session records under `~/.claude/sessions` and the running CLI's `/proc/<pid>/environ` (compared with the tab's launch id and discarded) are copied over the pooled SFTP session into the project's session folder and parsed by the local transcript reader; the host controls their content (rendered escape-first, tail-limited) and, with C3, their size. Never dials; a transcript over 512 MiB is not copied. Prompts read from it feed the prompt chart."
- **Tier 4, move an agent tab between this machine and a host** (`agent_host_move`, Core command `agent_tab_move_host`) - ⚠️. "Claude's conversation (transcript, subagents, tool results) is copied: host -> here into the scope's agent home (written through `HomeDir` handles), where the local fenced agent resumes it, so host-authored history becomes the local agent's context; here -> host into the login's real `~/.claude/projects` (a Tabtivity write into another app's store on a machine, with an existing diverging host transcript renamed aside to `.replaced`; creation mode is the SFTP default, not checked). A remote-only project refuses the local side. Whole files are read into memory (C3)."
- **Tier 4, Remote <-> Remote-only conversion** - ✅/⚠️. "Remote -> Remote-only is refused while the mirror holds commits or changes the host lacks, unpushed byte-sync edits or a local tab, re-checked under the project lock against the confirmed fingerprint; the mirror is never deleted (moved out of the state dir if it lived there). The reverse (`set_remote_mirror_dir` with `keepLocalCopy`) needs an absolute folder outside the state dir that no other project owns, pins saved tabs to the host first, and pairs through ordinary lockstep. VM projects are refused both ways. Residual: the move-out copy is C2."
- **Tier 4, publish from the host** (`git_publish`, remote-only default) - ⚠️. "`gh`/`glab repo create` runs on the host with the host's credentials (path and name `shell_quote`d); the push is `git push -u origin HEAD` through `run_git_hooked` on the host, so the host repo's pre-push hook runs there as the login. Local publish is refused for a remote-only project."
- **Tier 4, Reconnect all** (Remote machines window) - ✅. "A click: dials every host not connected, HPC-tagged ones included (`background: false`), with what is already there (saved password, key/agent, live login master); never prompts; failures are named."
- **Tier 4, export/import of a project set; export of the host's copy** (`export_project_set`, `inspect_project_bundle`, `MirrorSource::Host`) - ⚠️. "A set is a stored zip of ordinary bundles; a member is read in place through a bounded window, named by a one-component `projects/<n>-…` entry listed in the manifest, then imported by the single-bundle import (zip-slip confinement, links last, untrusted-layout sanitizer). The host's copy is packed from a `tar -cf -` over ssh (`.git` per the checkbox) into the bundle; entries named `..`, empty, or absolute are skipped. Residuals: C1 (the entry is adopted wholesale) and C5 (no total cap on the host stream)."
- **Server mode, new Core commands** (see stale row 8) - ⚠️ (same uid-boundary reasoning as the existing server rows).

### 6. Handed off

- A (agents/fence): C1(b) touches the sandbox spec adoption (`source_needs_decision`) and the agent push/schedule levels; the "moved here" transcript lands in the scope agent home (`agent_host_move::write_here`).
- B (phone): `mobile_control/host_files.rs` (remote-only host browser): first 330 lines read, the canonicalize-proof (`proven`/`still_proven`) looked sound; the rest of the file, the phone's "move agent between machines" use of `agent_tab_move_host` and remote-only headless launches are not read.
- D (window/IPC/viewers/supply chain): `fs_confine.rs` moved from `commands::fs`; I read the planted-root fences only, not `open_confined`. `commands/ssh.rs::web_url_to_open` (url::Url parse, no user info, http/https, no control characters) looks right.
- E / loopback: `loopback_owner.rs` decides on the listener's uid at check time; there is a check-then-connect gap (a listener that appears after the check), and macOS/Windows answer `Ok` with no lookup (already in the "Still open" list). Callers not read.

---

## Reviewer D: perimeter, IPC, viewers, desktop voice, apps, supply chain

Range `ff9f83ab..HEAD` (`b3abe5ba`), `git diff -M`. Read-only; nothing run, nothing built.

### 1. Range and files read

Read (diff or whole file, as needed):
- Perimeter: `src-tauri/tauri.conf.json` (diff), `src-tauri/capabilities/*.json` (unchanged), `tests/capability_scope.rs` (diff), `Info.plist` (new), `entitlements.plist` (diff), `lib.rs` (permission handler, page-load hook), `src-tauri/patches/` (no diff in range), `src/lib/hardenPrototype.ts` and `CspTripwire.test.ts` (only an import-path commit in range, no logic change). `src/lib/transport/commandClasses.ts` old vs new: every added or removed row (33 added, 4 removed, no class changed).
- New commands read: `dev_build_stop`, `export_project_set`, `inspect_project_bundle`, `pty_input_from`, `remember_model_rows`, `privacy_curtain_set`, `presenting_state`, the nine `voice_*`, `agent_tab_features`, `local_tmux_pane_dead`.
- Viewers/renderers: every `dangerouslySetInnerHTML` / `innerHTML` / `srcDoc` / `<iframe>` / `createObjectURL` site in `src/` (grep, then read the new ones: `TerminalReaderView`, `lib/terminal/pathCandidates.ts`, `mobile-web/src/terminal/answerMarkdown.ts` as reused by the desktop chat, `TextView` + `lib/viewers/format.ts` preview CSP, `decorations.ts`, `MarkdownView` print path, `resolve_text_paths` in `commands/fs.rs`). No new `fetch`/`WebSocket`/`window.open`/`postMessage` in added `src/` + `shared/` lines (tests excepted).
- SyncTeX: `3a4dde5a` (confine PDF and map to the viewer's project, FIFO map not opened), `commands/synctex.rs`, `services/synctex.rs` lexical filter still present.
- Voice: `commands/voice.rs`, `services/voice/{mod,ssip,models,gpu,phantom,tts}.rs` and the listen path in `session.rs`, `lib/voice/desktopVoice.ts`, `voiceCommands.ts` (header), `ReaderVoice.tsx` (header), `shared/voice.ts`, `mobile-web/src/handsFree.ts` (voice pick), `TerminalReaderView` pick/read-aloud wiring.
- Apps: `commands/apps.rs` (launch, `close_tracked_window`, prune), `services/proc_table.rs` launch marker, `services/window_registry.rs`, `platform/workspace_settings.rs`, `platform/mod.rs` route, `platform/x11.rs` `gsettings_run`.
- Project bundle import (outside my brief's list but new surface, found while checking `export_project_set` / `inspect_project_bundle`): `commands/project_transfer.rs` (header, entry adoption, tests), `project_transfer/set.rs`, `commands/projects.rs` sandbox toggle, `services/sandbox.rs`.
- Supply chain: `Cargo.lock` (name/version/source diff, all 839 sources are crates.io, none git), `src-tauri/Cargo.toml`, `package.json` + `package-lock.json` (diff; dev-only bumps, no new prod package, no new install script), `.github/workflows/{ci-cd,security,release}.yml`, `.githooks/pre-push`, `.gitleaksignore`, `.github/codeql/reviewed.json` (56 entries differ, nearly all line moves from the refactor; the path-injection ones are the sidecar/state-dir ones, E/B/C own them), `scripts/{package-dev-auto,package-dev,package-local,ci-local,fresh-vm,tabtivity-send.sh,lib/voice_gpu}`, `scripts/privacy-reviewed-binaries.txt`, `src-tauri/build.rs` (web assets), `tauri.vulkan-loader.conf.json`.
- `whisper-rs-sys` 0.15.0 `build.rs` (from the local cargo registry): no download at build time.

Skipped: the bodies of `FileViewerPane.tsx` / `CodeEditor.tsx` / `FileTree.tsx` beyond sink greps (the 10 k-line diff is the S3/S5 split, a move); `TexView`, `TexWorkspaceView`, `ImageView`, `codeTools.tsx`, `TextView` logic other than the preview; `popout_screen.rs` (no fs/exec calls outside tests); `commands/screenshot.rs` (deleted, see section 4); cockpit/steering/hints beyond "which commands do they call" (cockpit calls only `git_push_mcp_proposals` and read-only stores; no approve action); `shared/voiceReading.ts`, `mobile-web/src/voiceProbe.tsx` (phone, B); Windows/macOS `tts` backend (crate not in the local registry: unverified).

### 2. New gaps

### D1: medium. A project bundle's `sandbox` spec (and other autonomy settings) is adopted verbatim, answering the in-repo-Dockerfile confirm in advance

Row text:
**Open (medium).** Importing a `.tabtivityproj` (or a project set) adopts the bundle's `projects.json` entry wholesale except for the keys import explicitly drops (phone access, OpenVPN, `vm`, push/CI confirmations, `open_apps`, tab `env`/`cmd`). That includes `sandbox`: a hostile bundle carries `sandbox = {enabled: true, dockerfile: "Dockerfile", spec_source_hash: <hash of the Dockerfile it ships>}`. The confirm dialog for an in-repo Dockerfile (O#143: `docker build` runs `RUN` steps as root with full network) is skipped because `source_needs_decision` returns false once the stored hash equals the file's, and the container is built and started the first time any tab opens in that project. The same spec can name any `image` instead of a Dockerfile, and the container tab receives the agent API keys found in the app's own environment (tier 4, "Run / terminal"). The registry entry is the trusted store, so the bundle's tree half cannot do this on its own; the manifest half can. Also carried: `git_push_mcp.level` and `protected` (test `bundles_carry_no_push_or_ci_confirmations` pins that they travel), `schedule_mcp` level, `run_host`, `compute_hosts`, `remote`. `docs/context/project_transfer.md` calls the entry's settings "a different risk class: none of those fields is executed by importing"; the sandbox spec is executed by the next tab spawn.

You do: import a bundle someone sent you, then open any tab (shell or agent) in the imported project with a Docker/Podman available. No click on a "Run" is needed.

Evidence: `commands/project_transfer.rs:2531` (entry deserialized from the manifest), `:2549-2550` (only `vm` removed, then `drop_imported_confirmations`); `commands/projects.rs:1700-1712` (`source_needs_decision` is false on a matching `spec_source_hash`); `services/sandbox.rs:721-727` (`enforce_spawn_authority` takes `toggle_on` from the registry), `:236-242` (`image_for`), `:1299-1300` (Dockerfile build, path confined to the project by `resolve_spec_dockerfile`, so the file itself must come from the bundle's tree); `services/sandbox.rs:1539` (`sandbox_spec_for` reads `extra["sandbox"]`).

Fix: make import an allow-list of registry keys (label, git/remote spec, categories, panel prefs) rather than a drop-list; for `sandbox`, import `enabled: false` with `spec_source_hash`, `dockerfile` and `image` cleared (keep resource caps, validate `network`), so the next enable runs the O#143 confirm; reset `git_push_mcp.level` and `schedule_mcp` to the default level and tell the user in the import report (as `vpnDropped` does).

### D2: hardening. The GNOME/Cinnamon workspace-settings restore applies whatever key and value the restore file names

Row text:
**Open (hardening).** The x11 workspace backend takes over desktop GSettings while it runs (Cinnamon's three keys as before; since 2026-10-26 GNOME's four, on X11 and Wayland) and restores them at quit or, after a crash, at the next start from `<state_dir>/workspace_settings_restore.json`. The restore step runs `gsettings set <schema> <key> <value>` for every record in that file without checking that the schema/key is one of the table's four; a changed record can set any GSettings key of the user (a custom keybinding's `command` is a command line the desktop runs). The file is Tabtivity's own, in the state dir that no fence mounts, so only a process outside the fences can plant it; the cost is that it widens "Tabtivity never edits another app's config" from four named keys to whatever the file says. `gsettings` is found through the user's `PATH`.

You do: nothing (runs at every start on Cinnamon/GNOME).

Evidence: `platform/workspace_settings.rs:164-172` (`restore_ops` maps records straight to `Op::Set`), `:187-189` (`take_over` restores `read_restore_file` records first), `:290-300` (`read_restore_file`, parse only), `platform/x11.rs:839-855` (`gsettings_run`).

Fix: in `restore`, drop any record whose (schema, key) is not in the running desktop's table (and any value that does not parse as the key's expected type: int or string list); call `gsettings` by absolute path where it exists.

### D3: low/hardening. Hands-free voice can answer a permission dialog with one spoken number word, and Headset mode keeps the mic open during read-aloud

Row text:
**Open (low).** In hands-free dictation (experimental flag plus the chip) a settled segment that is a single number word ("one", "2") picks that row of the dialog on screen as a click would, including an agent's tool-permission dialog; there is no chime-and-cancel window for this path, only for sending a draft. With Headset mode on, the mic is not muted while the answer is read aloud (`MuteGate::muted` returns false), so on speakers a sentence of the agent's own reply that is a lone "One." (agent text is attacker-influenced, tier 3) can be heard back and pick a row. Default (Headset off) the mic is muted while the voice speaks and for a tail after it; background speech or media saying a number does the same at any time the mic is open. Spoken commands (`voiceCommands.ts`) are not wired on the desktop: only pick and "go on" send exist there. "Go on" at the end of a draft sends it after the chime.

You do: turn on hands-free; for the read-aloud path also Headset mode while using speakers.

Evidence: `TerminalReaderView.tsx:1767-1774` (`pickByVoice` answers any `live.question`), `mobile-web/src/handsFree.ts:46-53` (`voicePick`, numbered rows only), `shared/voice.ts:93-127` (`matchOption`), `services/voice/session.rs:130-135` (`muted`: headset returns false), `:433-436` (a segment during speech only triggers barge-in, then is transcribed), `ReaderVoice.tsx:178`.

Fix: do not voice-pick a dialog that approves a tool/permission (or require the row's words, not its number, and open the same chime-and-cancel window); in Headset mode drop any segment that began while `GATE.speaking()` and was not a barge-in.

### D4: low/hardening. Read-aloud on Linux starts speech-dispatcher outside the quit teardown

Row text:
**Open (hardening).** When no speech-dispatcher socket answers, read-aloud runs `speech-dispatcher --spawn`, found through `PATH`, with null stdio; the server outlives the app until its own idle timeout ("the quit does not stop it", `ssip.rs`). `SPEECHD_ADDRESS` is honoured only as a `unix_socket:` absolute path. The speech text path itself is safe: control characters are folded to spaces, a leading dot is doubled, 8 KiB cap, SSML mode off, language reduced to 2-3 lowercase letters, rate numeric, so spoken (agent-written) text cannot inject an SSIP command.

You do: turn on read-aloud on a machine without a running speech-dispatcher.

Evidence: `services/voice/ssip.rs:362-378` (`spawn_server`), `:27-37` (`encode_body`), `:301-323` (`socket_path`). Not verified: whether the Windows (WinRT) and macOS (AVFoundation) backends of the `tts` 0.26.3 crate take plain text only (crate not in the local registry).

Fix: resolve `speech-dispatcher` from root-owned system dirs as git is (#861), or leave starting it to socket activation and report `no-speech-server`; if kept, register the child in the quit teardown.

### D5: low/hardening. Apps view "Close" signals a recorded pid without a start-time check on the leader

Row text:
**Open (low).** `close_tracked_window` SIGTERMs (then SIGKILLs) the whole subtree of the row's pid. The registry row stores a pid and no process start time for the row's lead (the launch family does store start times, and `reap_with` re-checks each process it signals against the walk's own snapshot, but the leader is taken from the row). A row whose app exited and whose pid was reused before the next prune/read (documented limitation, `docs/CODE_REVIEW_SECURITY.md`) would signal an unrelated process of the user's, subtree included. User-clicked, own uid only, no privilege gain; data-loss class.

You do: click "Close" on a stale Apps row.

Evidence: `commands/apps.rs:2200-2226`, `services/window_registry.rs:15-33` (`TrackedWindow` has `pid`, no start), `terminal/mod.rs:1364-1394`.

Fix: store the lead's `proc_table::start_time` on the row and refuse `close_tracked_window` when it no longer matches.

### Not a gap, checked and fine
- Every new command has a `command_class` row; the classes are right: all `voice_*`, `privacy_curtain_set`, `presenting_state`, `detached_window_screens`, `set_detached_title` are `client`; `dev_build_stop` is `admin` like its siblings; the rest `core`. None is a whole-document save: `remember_model_rows` is a patch of one entry (`commands/agents.rs:1894`), the rest write nothing or one record.
- `pty_input_from` writes `<tab-uid>.from` through `home_io::HomeFile` (no link followed, name from the backend's bindings, value from a two-value enum); `tabtivity-send.sh` reads it with `-f ! -L` and `head -c 16`.
- Voice install: pinned HuggingFace commit URL plus embedded sha256, verified before the rename; script written to `<state_dir>/voice/`, never fence-reachable. No audio is persisted (no file write in `session.rs`/`capture.rs`/`stt.rs`); the GPU-crash marker is an empty file.
- Desktop chat answer rendering (`answerHtml` allowlist rebuild, then `linkPathsInHtml` on a `<template>`), web links only through `confirmLink`; path links resolve only inside the tab's bases, links and `..` refused (`resolve_text_paths`). The second parse/serialize round trip in `linkPathsInHtml` is on already-allowlisted output of plain elements; keep an eye on it if the allowlist ever gains `svg`/`math`/`noscript`.
- Rendered HTML/CSS/SVG preview: CSP `<meta>` is placed before every byte of the file (doctype aside), `sandbox=""`.

### 3. Regressions

None found. Checked against the current code: 51 (`disableFontFace` still set in `lib/viewers/pdfLoad.ts:48-53`), 52 (`.iml` reader: `MAX_IMLS 32`, `IML_CAP 64 KiB` kept through the move), 53 (`is_network_path` / `lexically_within` kept; plus the new project confinement), 62 (preview CSP: `format.ts:131-152`; app CSP carries `object-src 'none'; base-uri 'none'; form-action 'none'`), 63 and 60 (not touched in my files), 12/CSP tripwire (CSP only gained the three directives; `script-src 'self' blob:` unchanged; `capability_scope.rs` only gained the microphone exception and its macOS deny-handler assertion), 47 (skills copy goes through `tree_copy`), 21/26 (`open_external_url` still parses with `url::Url`, http(s) only, no user info). `hardenPrototype.ts`, `capabilities/*.json`, `src-tauri/patches/` have no diff in the range; tauri, wry, tauri-runtime-wry and all plugins have identical versions in `Cargo.lock`.

### 4. Stale rows

1. **"The one fact"**, "The desktop CSP also carries `object-src 'none'; base-uri 'none'; form-action 'none'` (2026-10-24, gap 62, needs a rebuild; ..." Replace the parenthesis with "(gap 62, in the shipped config since 2026-10-24; `CspTripwire.test.ts` pins `script-src`)". Same paragraph: "diffed 2026-10-24" becomes "diffed 2026-10-24 and again 2026-11-04 (no change in the range)". "hundreds of registered `#[tauri::command]`s" is now about 760 (588 core, 100 client, 67 admin, 9 off).
2. **"The one fact"**, plugin sentence: add "The microphone is declared on macOS (`Info.plist` `NSMicrophoneUsageDescription`, entitlement `device.audio-input`) for the Chat's native dictation (`services::voice`, cpal, in the Rust process, not the webview). A browsed page is kept off it by one layer: the app-level `on_permission_request` deny-all (`with_macos_permission_deny`), asserted by `capability_scope.rs` because wry's macOS delegate grants media capture when no handler is set. Linux keeps WebKitGTK's unhandled default (deny), Windows the `commands::browser` deny handler."
3. **Tier 2 "SyncTeX"** (`The .synctex(.gz) beside a PDF is read natively ...`): add "Every `synctex_*` command takes the viewer's `projectId` and refuses a PDF, or a `.synctex(.gz)` beside it, outside that scope's roots (`3a4dde5a`); a map that is not a regular file (FIFO) is not opened. The forward-search caller in `FileViewerPane` still sends no `projectId` (current project plus box siblings)."
4. **Tier 2 "Markdown"** and the phone-answers row: the desktop Chat now renders an agent's answers with the phone's allowlist renderer (`answerHtml`, rebuilt from allowed tags/classes) and dresses file and web links (`linkPathsInHtml`); see the new row in section 5.
5. **Hardening backlog**, "`cargo audit` ignores RUSTSEC-2023-0071 ... and RUSTSEC-2026-0367, -0368 and -0369 (`zip` 8.6 via `calamine` ...)": `Cargo.lock` now holds only `zip` 9.0.5 (calamine 0.38), so the three zip ignores are obsolete (drop them from `.github/workflows/security.yml`; they would mask a future 8.x). Add: "and RUSTSEC-2026-0387 (`crypto-bigint` 0.5.5 timing variability in the RustCrypto 0.13 curve crates, via `p256` for phone pairing and via `pgp` 0.20 for mail; fix needs the `pgp` 0.21 / `p256` 0.14 generation, to be live-checked)."
6. **Gap 20 residual** (dev-build): add that the chip's Stop build / Pause / Build now (`dev_build_stop`, `admin`) also run the checkout's `scripts/package-dev-auto.sh` unfenced; same accepted class (C3).
7. **"Still open"** list: `scripts/fresh-vm.sh` still verifies `SHA256SUMS` only (from the same release, unsigned), and still proceeds with "unchecked" when a release has no `SHA256SUMS` (`scripts/fresh-vm.sh:649-656`). Item stays; add the "proceeds unchecked" half.
8. **Tier 4 "Run / terminal"**: add that a bundle import can switch the container on (D1) until D1 is fixed.

### 5. New surface with no row

1. **Tier 2, "Desktop Chat: agent answers, path and web links, pictures and PDFs an answer names"** ✅/⚠️: "Answers and prompts render through `answerHtml` (escape-first Markdown, then rebuilt from a tag/class/style allowlist; links become `.md-link` spans, images alt text) and `linkPathsInHtml` (path-shaped words become `data-path-link` chips only after `resolve_text_paths` finds the file inside the tab's folders, links and `..` refused, `.tabtivity` never answered). A web link opens only after `confirmLink` names the address (http(s), no user info, punycode host). Pictures/PDFs an answer names are drawn by the shared loaders in the unsandboxed renderer (gap 51)." Status ✅ / ⚠️ 51.
2. **Tier 0/1, "Desktop dictation and read-aloud (`services::voice`, default build)"** ⚠️: "Mic opened by the Rust process (cpal), only on `voice_listen_start` from a window, one session, ended with its window (page-load hook) ; whisper.cpp (`whisper-rs` =0.16.0, `cmake` build, vendored sources) in the unfenced main process on sha256-pinned models (HuggingFace commit URLs, verified before rename); no audio is written; transcripts go to the calling window only. Optional Vulkan/Metal backend (`voice-vulkan` in Linux/Windows bundles and dev builds) loads the system's Vulkan loader, ICDs and layers into the main process, with a crash marker that falls back to CPU after a driver crash. Read-aloud speaks SSIP to speech-dispatcher (Linux, folded to one line, dot-stuffed, SSML off) or the OS voice. A compromised renderer can start the mic (it has the IPC anyway). Hands-free: gap D3." Status ⚠️.
3. **Tier 4, "Export / import a project or a project set"** ⚠️ (until D1): "Manifest and session sanitised (tab commands/env stripped, `open_apps`, phone keys, OpenVPN, `vm`, push/CI confirmations dropped), zip entries confined with `enclosed_name`, links created last, agent history by allow-list with databases re-stripped; `project.json` is rewritten from the manifest. The registry entry's remaining settings are adopted (D1)."
4. **Tier 4/Apps, "Apps view: launch markers and IDE windows"** ✅: "A launched app carries `TABTIVITY_LAUNCH_ID` (random, not a secret) so its processes are found after the launcher exits; found by reading `/proc/<pid>/environ` of the user's own processes only, started no earlier than the launcher; the row's family is pid plus start time. Window titles of other X11/XWayland clients are read to resolve an IDE window to its project. Close signals a pid (D5)."
5. **Tier 0, "Desktop workspace parking (Cinnamon, GNOME on X11 and Wayland)"** ⚠️: "Takes over GSettings workspace keys while running and restores them at quit or next start (D2); on GNOME/Wayland it reaches XWayland windows only."
6. **Supply chain table/backlog**: Vulkan SDK (LunarG, Linux tarball and Windows installer) and the Windows Vulkan runtime zip (`vulkan-1.dll`, shipped beside the installer exe through `tauri.vulkan-loader.conf.json`) are downloaded in the package jobs, each pinned by sha256 in `ci-cd.yml`; the release bundles now link the Vulkan loader (`libvulkan1` is a `.deb` dependency). New Rust crates: `whisper-rs`/`whisper-rs-sys` (pinned `=`, cmake + bindgen at build, no network), `cpal` 0.18.2 (ALSA only on Linux), `tts` 0.26.3 (non-Linux), `bindgen`/`clang-sys`/`cmake` build deps; all from crates.io, no git sources (839 sources, one registry). npm: dev-only bumps. Status ✅ / ⚠️ accepted `RUSTSEC-2026-0387`.
7. **Perimeter, "Privacy curtain / presenting"** ✅: `privacy_curtain_set` takes the label from the calling webview (`Ctx`), never the payload; presentation windows are never protected; no new data is read.

### 6. Handed off

- (C / server) `export_project_set` and `inspect_project_bundle` are `core` and take client-chosen paths (`dest_path`, `bundle_path`), like `export_project`/`import_project`; on a hosted server a client picks files in the daemon's filesystem. Not checked against a server path policy.
- (A) `remember_model_rows` stores rows an agent's own model picker drew (screen text from the PTY) and a model sheet lists them; check they only render as React text and never feed a keystroke sender unvalidated.
- (B) `mobile-web/src/voiceProbe.tsx` (1 276 lines) and `mobile-web/public/silence.wav` (new, in the privacy-reviewed list) ship in the phone bundle; the phone hands-free path shares `voicePick`/`matchOption` with D3.
- (E) `.github/codeql/reviewed.json` grew 56 entries by line move; the `mail_authres`, `mail_crypt`, `mail_store` hard-coded-crypto entries are in E's files.

---

## Reviewer E — mail, calendar, to-do, MCP lanes, git-push/CI MCP

HEAD b3abe5ba, develop. Read-only; nothing built or run.

### 1. Range and files read

Read in full or in the changed parts:
- Git-push lane: `services/mcp/git_push_mcp.rs` (everything outside `mod tests`, lines 1-1646), commits `34732da9` (default branch behind a card) and `d61e5312` (stale-card dismissal) in full, the whole non-test diff of the file against `ff9f83ab`, `git_release.rs` and `git_ci.rs` diffs (mechanical), `commands/root_mcp.rs` decide/clear/proposals, `components/agents/GitPushMcp.tsx` (card and auto-close), `command_class.rs` rows.
- Mail since `9bbbb4e2`: `100c6f22` (IMAP MOVE), `9203e0fd`/`1f8f17e4` (Authentication-Results by name), `a25e1a1a` (private-key import; whole `mail_pgp.rs` diff, 428 lines), `mail_attach.rs`, `commands/mail.rs` diff, `mail_authres.rs` header and `apply_trust`, the UI diffs (cosmetic icon swaps only). Beyond the diff: `signed_part_bytes`, `encrypted_part_bytes`, `verify_detached`, `decrypt_message`, `apply_crypto_at`, `mail_crypto::detect`/`info_for`, the display path `commands/mail.rs:2850-2930`.
- Calendar: old `commands/calendar.rs`, `services/caldav.rs`, `commands/caldav.rs` against the split files by line-set comparison (only `accounts_path_in` moved; no logic changed), month-view drag `11637d93`, `shared_calendar.rs` diff.
- Root MCP: old `root_mcp*.rs` (5 files) against the new `root_mcp.rs` + `root_mcp/*` by line-set comparison (117 new lines: remote-only handling, `servers_of_tab`, `sha256_hex`, `floor_char_boundary`, the calendar_store move; no change to grants, tokens or review), `root_mcp_import.rs` (ICS import) top half, `schedule_mcp`/`help_mcp`/`markup_mcp`/`web_lane` line-set diffs (refactor only), `useOverlayAgent.ts` and `stores/overlayAgent.ts` (overlay dock), `dev_todo.rs`.

Skipped: IMAP sync loop and `mail_engine` beyond the two small hunks (97 KB, not read); S/MIME (unsupported); phone routes into mail/calendar (B); `mail_rekey`; the todo board's frontend; `web_lane` internals; CI log parsing in `git_ci.rs`; mail-parser's actual handling of extra `multipart/signed` children (reasoned from the code, not run).

### 2. New gaps

### E1 — medium: Verified chrome can sit over unsigned parts of a `multipart/signed`

**Row text.** **Open (medium).** `signed_part_bytes` accepts a `multipart/signed` root with two *or more* children (`ids.len() >= 2`), verifies children[0] against children[1] and ignores the rest, while the message pane renders the body, HTML and attachments of the *whole* parsed message and puts the single verdict on top. A sender who holds one genuine signed message from a Verified correspondent (any past mail to them) can add a third part (text, HTML or an attachment) outside the signature. Because `From` is not signed (the pane says so) and the display is not limited to the signed part, the unsigned part is shown under a Verified, aligned verdict. The root-only rule in `detect` closes the nested case; this is the same wrapping idea at the root. Spoofing `From` still has to get past the user's server; gap 72's spoof and this one add up.
**You do.** open a mail from a correspondent whose key you verified.
**Evidence.** `services/mail/mail_pgp.rs:929` (`>= 2`), `:934-935` (children[0], children[1], rest dropped); `commands/mail.rs:789-794` (verdict computed, whole `raw` returned); `commands/mail.rs:2866-2869` and `mail_engine::parse_message` (`msg.html_body`/`text_body` over the whole message); `mail_crypto.rs:353-362` (Verified when trust and alignment hold). Unverified: how `mail-parser` orders and merges text/HTML leaves of a `multipart/signed` with a third child — needs one parse test.
**Fix.** In `signed_part_bytes` and `encrypted_part_bytes` require exactly two children and the second to be `application/pgp-signature` / `application/octet-stream`; any other shape is `Unusable`, never `Verified`. Better, when the root is `multipart/signed`, render only children[0] and list nothing else.

### E2 — medium: a verified key stays Verified when it is re-imported with different user IDs

**Row text.** **Open (medium).** `Verified` is stored per fingerprint, not per fingerprint plus the user IDs the user compared. `PgpKeyring::import` replaces the entry (`entries.retain` + push) with the new key's user IDs and carries only the flag over (`was_verified`). A key's owner can re-sign it with extra or reordered user IDs under the same fingerprint (a fingerprint does not cover user IDs). So a correspondent you verified, or any key you verified for one address, can mail "my updated key" naming someone else's address first; it keeps the green tick, and mail signed by it with `From: <that address>` shows Verified and aligned (alignment reads only the first address, `good_outcome`). The same keeps encrypt-to-address choosing it over the genuine key (`public_for_address` prefers verified). Gap 71 closed the "secret key verifies itself" half; this is the "verified key changes its claim" half.
**You do.** import a key file that is a new copy of a key you already verified (attachment or paste).
**Evidence.** `mail_pgp.rs:356-364` (secret) and `:385-395` (public): flag via `was_verified`, identities from the new key; `:1252-1258` (`was_verified` by fingerprint only); `:871` (`identity: addresses.first()`); `:633` (verified preferred in `public_for_address`).
**Fix.** On a re-import whose user-ID set differs from the stored one, reset `verified` to false (and unbind nothing) and say so in the result; or store the verified IDs with the flag and compare on use.

### E3 — low: no revocation or expiry handling anywhere in the keyring

**Row text.** **Open (low).** Nothing in `mail_pgp.rs` looks at revocation or expiry of a key, subkey, user ID or signature (no match for `revok`/`expir`). A friend who revokes a leaked key and sends the revoked copy still shows Verified for mail signed with it, and `encrypt_to` keeps encrypting to an expired or revoked subkey. `verify_bindings` checks self-signatures only (rpgp's own revocation behaviour not checked: unverified).
**You do.** read mail signed by a key whose owner has revoked it.
**Evidence.** `mail_pgp.rs:657-705` (`verify_detached` returns `Good` on any cryptographic match), `:620-641`, `:822-833`.
**Fix.** Drop revoked/expired keys from `candidates_for` and `public_for_address`, and show "revoked" in the Keys dialog; treat a signature made after expiry or before key creation as `Bad`.

### E4 — low: a pending push card is dismissed on the strength of a ref the agent can write

**Row text.** **Open (low).** `settle_pushed_elsewhere` (run on every card refresh and every `git_push_status`) dismisses a pending push card with the message "Already on the remote: the branch was pushed another way" when the card's commit is an ancestor of `refs/remotes/<remote>/<branch>`. That ref lives in the agent-writable `.git`, so a fenced agent (or another tab on the same checkout) can write it and make a card vanish with a false statement, and then tell the user it went out. Nothing is pushed or approved by this; the cost is a card the user never sees and a misleading message. `supersede_older` likewise lets any tab dismiss another tab's pending push of the same branch by asking again (up to six a minute budget-wise).
**You do.** nothing.
**Evidence.** `git_push_mcp.rs:902-922` (`:912` the `merge-base --is-ancestor` against the tracking ref), `:874-883`.
**Fix.** Settle only when the tracking ref moved since the card was staged *and* the card's `remote_sha` was an ancestor of it, or confirm with `ls-remote` (the user's own click on refresh is already off the UI thread); keep the dismissed card visible with a "dismissed because…" line the agent cannot write.

### E5 — hardening: the approval card for a default-branch push shows agent-written text and a count

**Row text.** **Open (low, hardening).** The card lists `git log --format=%h %s` lines (subjects the agent wrote, not stripped of control or bidi characters) and a `--shortstat` total. For a push to the remote's default branch, which since `34732da9` can be staged and is a release in repos that build on push, the user approves on subjects and a number; no file names. The `note` is cleaned (`strip_invisible`); the subjects are not.
**You do.** press Push on the card.
**Evidence.** `git_push_mcp.rs:552-556` (`commits_between`), `:1343-1348` (note cleaned, subjects not), `GitPushMcp.tsx:132-135` (`<code>{line}</code>`, `key={line}`).
**Fix.** Strip invisible and bidi characters from subjects (same helper as the note), add a capped `--name-status` list (workflow, hook and manifest paths first), and make a `to_default` card say how many files it touches.

### E6 — hardening: only the remote's default branch is forced to a card; a release branch that is not the default is not protected unless listed

**Row text.** **Open (low, hardening).** `is_protected` is now the user's list only (empty by default) and `is_default_branch` is the remote's `HEAD`, with `main`/`master` only as a fallback when the remote says nothing. If the remote's default is `develop` and releases come from `main`, an agent at Apply pushes a fast-forward of `main` with no card. Before `34732da9` the same held (default plus list); the change only made the default branch pushable behind a card. Default level is Propose, so this needs the user to set Apply.
**You do.** set a project to Apply.
**Evidence.** `git_push_mcp.rs:356-370`, `:569`, `:1072-1074`.
**Fix.** Treat `main`, `master` and the branch a release workflow triggers on as "to default" whatever the remote's HEAD says, or offer a one-click "protect main" in the push level menu.

### E7 — hardening: `decide` checks "pending" before taking the project lock, not after

**Row text.** **Open (low, hardening).** `decide` reads the proposal, checks `Pending`, then waits for the project lock. During the wait `supersede_older`, a cancel or a first approval can change the card; after the lock it pushes anyway and writes `Running` over `Dismissed`. Effects: a double-click or a second client pushes the same SHA twice (harmless for a branch); a second Release approval fails `tag_exists` and `fail()` overwrites `Pushed` with `Failed`, so the agent's `git_push_status` reports a failed release that went out; a card superseded while the user clicks still pushes its older SHA (the user did click it).
**You do.** approve a card while a newer request is being planned, or click twice.
**Evidence.** `git_push_mcp.rs:1139-1149` (status read before `:1147` lock), `:1173`, `:1255`.
**Fix.** Re-read and re-check `status == Pending` under the project lock; `fail()` must not replace a `Pushed` record.

### E8 — low (dev builds): the dev Todo view follows links and reads FIFOs in the fence-writable checkout

**Row text.** **Open (low, dev builds).** `dev_todo::list_in`/`read_in` open `<checkout>/todo/*.md` with `fs::read_to_string` (links followed, no regular-file check, no cap). In a dev build the checkout is writable by a fenced agent working on Tabtivity itself, so a planted link shows the first `# ` line of any user-readable file as a group title and its whole text in the viewer (to the user's own window only, no exfiltration), and a FIFO parks a blocking worker each time the view opens (gap 49's class). A write replaces the link with a regular file (temp + rename), so it does not write through. Release builds list nothing.
**You do.** open the dev Todo view.
**Evidence.** `services/dev_todo.rs:126`, `:143`; `commands/debug.rs:168-190`.
**Fix.** Open through the no-follow, non-blocking, regular-on-handle helper that `read_mirror_file` and the viewers use, with a size cap.

### E9 — low: one click binds an imported private key that names only your own address as your identity, and it becomes Verified

**Row text.** **Open (low).** Gap 71 residual (a) covers a key that also names a foreign address. The simpler case is worse than "Known": a private key someone mailed you, made with only your own address on it, can be bound with **Use for this account** and is then Verified, the account's signing key and the encrypt-to-self key. Whoever made the file holds the private half, so they can sign as you, read every encrypt-to-self copy, and their mail from your address gets the tick. The code cannot tell your own backup from a planted file (nothing records `generated` vs `imported`).
**You do.** import a key file from a mail and press Use for this account.
**Evidence.** `mail_pgp.rs:458-483` (`bind_account`: `all_ours` → `verified = true`); `MailKeysDialog.tsx:322-326` (no confirm).
**Fix.** Record the origin; for an imported secret key the bind asks a confirm that names the risk and does not set Verified (the user ticks the fingerprint box like any key).

### 3. Regressions

None found in my area.
- Gap 10 (the card's SHA is pushed, not the branch): intact (`refspec` pins `<sha>:refs/heads/<branch>`, `git_push_mcp.rs:341-345`, `:725`).
- Gap 18 (hook runs in the recorded fence, fails closed): intact (`HookBoundary::Unrecorded`).
- Gap 19 (`repo_changed`, CI repo confirmation): intact on push, release and the three CI tools (`:1615-1619`, `:1627`).
- Gap 26/E2b (http CalDAV refused): `caldav.rs` logic unchanged; `https` only at `:632-633`.
- Gap 25/50 (mail AI local-only, listener owner): `root_mcp_mail.rs` text unchanged.
- Gap 71: the fix holds (verified, see below); no other path sets `verified` (`mail_pgp.rs:306` generate, `:423` user tick, `:481` bind, `:1269` the demotion).
- Gap 27/34 and the approvals-per-group logic: no change in `root_mcp_review.rs` beyond paths.

Behaviour change to record, not a regression: `34732da9` removed the "agent never pushes the default branch" invariant. It is now "never without a card, even at Apply", and the cards of other tabs for the same branch are dismissed when a new one is staged.

Gap 71 verification: import starts Known for secret keys (`:356-359`), re-import keeps the stored flag, `bind_account` refuses a key that does not name the account's address and verifies only if every address is one of the user's accounts' (read from the accounts file, not the caller: `commands/mail.rs:1994-2005`), the one-time demotion of unbound secret keys runs on first read. The residuals (a)-(f) in the row are unchanged; E2 and E9 are two more.

### 4. Status of gaps 72 and 73

- 72: unchanged. `mail_contacts.rs`, the ★ and `harvest` have no change since `9bbbb4e2`; the proposed Personal-only star / DMARC-gated harvest is not built.
- 73: unchanged. `mail_thunderbird.rs` is byte-identical; `trusted_schema = OFF` with the result ignored is still the only hardening (`mail_thunderbird.rs:120`).

### 5. Stale rows

1. **Agent push / release / CI** (tier 4 row beginning "Ask Tabtivity to push the checked-out branch"): "6 push/release per hour, 2 pending" is wrong for pushes. A pending push no longer counts toward the two (`git_push_mcp.rs:1364`, `:1374`), because a new request supersedes. Replace with: "6 push/release per hour; at most one pending push and one pending release per tab (a new request dismisses the tab's older pending one of its kind, and every tab's pending push of the same branch in the same checkout); a card whose commit the branch's remote-tracking ref already holds is dismissed on read (a ref the agent can write, E4); a push or release you approved closes its card once it went through; 2 pending limit applies to the rest."
2. Same row: "Never force, tag, delete, new remote branch or protected branch" — "protected" now means only branches the user lists; add: "the remote's default branch is staged as a card even at Apply (`toDefault` line on the card); other release branches are protected only if listed (E6)."
3. Same row and the `CONTRACT` text: "two pending proposals per tab" — same correction as 1.
4. **Incoming mail** row, last sentence: add that between `9bbbb4e2` and `9203e0fd` (mail-parser 0.11.9) every message showed no verdict (fail-safe), and that the read is by header name (`mail_engine.rs:907-921`), topmost only, authserv-id equality unchanged.
5. **Mail message** row ("only a Verified key whose identity matches `From` gets positive chrome"): add "over the signed part only is not enforced (E1), a Verified flag survives a re-import that changes the key's user IDs (E2), and revocation/expiry are not read (E3)".
6. Gap 71 row, residual list: add (g) = E2 and (h) = E9.
7. **Root console + Tabtivity MCP** row: add "remote-only projects have no local copy; git status/activity skip them (`local_checkout`), `projects_list` says `remote_only`, mail attachments from them are refused (`local_copy_in`)". The row also omits `calendar_import_ics` (see 6).

### 6. New surface with no row

- **`calendar_import_ics`** (root MCP; stages up to 96 KiB of iCalendar text, 5 per tab, 20 total, in `<state>/root_mcp/imports/`). Proposed row, tier 3: `| **ICS import via the root agent** | An agent stages an .ics file; nothing is parsed in the backend | The window parses it with the one ICS parser and imports it into a new calendar only on your ✓; no path or URL argument; needs the all-calendars grant; text capped, reply names the id only; staged files wait on disk until decided | ✅ |`.
- **Overlay agent dock** (Ctrl+1–9 in mail/calendar/to-do): a plain root tab shown beside the app. No mail or calendar data is passed to it; it holds the same root MCP grants and review rules as any root tab. Proposed row, tier 3: `⚠️ bounded` "Same authority as a root console agent (row above); the dock adds no data path. The docked tab keeps running in the root console when replaced."
- **Dev Todo view** (dev builds): E8. Proposed row, tier 2: `| **Dev Todo view** (dev builds only) | The checkout's todo/*.md | Names are bare *.md; compare-and-swap write via temp + rename; reads follow links and FIFOs (E8) | ⚠️ low |`.
- **Card dismissal by tracking ref** (E4) and **cross-tab supersede**: one sentence in the push row (stale row 1).
- **Month-view drag**: no row needed. It goes through `updateEvent`/`updateOccurrence`; read-only calendars are refused in `calendar_store` (`:397`, `:424`), a recurring event moves one occurrence.

### 7. Handed off

- (D / browser client) `git_push_mcp_decide`, `git_push_mcp_clear` and `git_push_mcp_proposals` are `core` in `command_class.rs`, so a logged-in browser desktop client can approve pushes and releases; consistent with its Admin role, but the browser-client row should say so.
- (A / Tabby) `9833cb7c` turns the assistant on by default; the phone gate is `flag_on.unwrap_or(true) && access != Some(false)` — gap 57's residual now applies to every install.
- (C / remote-only) `local_copy_in` is now the single mirror lookup (mail attachments, root MCP); worth a regression test that no other planner still takes `default_mirror_dir_in` directly.
