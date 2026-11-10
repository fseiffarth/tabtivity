# Local-models-only projects

Phase 1 of `docs/local_models_only_plan.md`. A project marked **Local models
only** is read by no cloud model: only an agent on an installed local Ollama
model starts in it, nothing in Tabtivity hands its files to a cloud model, and
no other tab's fence can see its folder. The switch below it, **Cut network**
(phase 2, Linux), takes the network away from the project's local tabs: their fence
has none, and the only way out is a relay in the app (see "Cut network" below). On
macOS and Windows it is stored in the record's shape and refused.

The code is `services/agent/agent_privacy.rs` (all of it `AppHandle`-free), the
command `commands/agent_privacy.rs`, the dialog
`src/components/projects/AgentPrivacyDialog.tsx`.

## What it guarantees, and what not

Guaranteed (network on): no cloud agent CLI starts here; a local tab starts only
on a model the loopback Ollama lists without a remote at that moment; Tabtivity
sends nothing from here to a cloud model (audit below).

Not covered, and said so in the dialog: what a local agent does with its own
network (a fetch tool, a prompt-injected `curl`, a `git push`, switching to an
Ollama cloud model mid-session); shell tabs (the user's, unfenced); the root
console's Host session (refused a `cwd` in the project, but it can read the
folder like any host process, decision D1); Windows (no fence, so nothing hides
the folder from other programs, though the gate still refuses cloud CLIs);
git remotes, sync and export (machines, not models, D3).

## The setting

`projects.json` entry, `agent_privacy: { local_models_only, cut_network }`.
Never in the in-folder `project.json`. Absent or `null` is off; a value of any
other shape than the one the setter writes reads as **on** (fail closed).
Unknown fields round-trip. Written through `project_registry::patch_project_entry`
by `agent_privacy::set`. `save_projects` (the pill list's whole-list save)
touches only status and position, so a stale window cannot clear it.

`set_project_agent_privacy` (`command_class` `client`: desktop only, decision
D4; the phone reads the record and has no setter) refuses with a message naming
the project when the project is remote, VM or has its container on; its record
names no folder; another registered project's folder (or mirror) or a box folder
lies **inside** it; `ollama_host` is not loopback (`mail_ai::resolve_endpoint`,
which refuses a remote host even with `ollama_allow_remote_host`). It refuses
Cut network where the sandbox cannot cut the network (`cut_platform`, Linux only; the text is
`CUT_NETWORK_UNAVAILABLE`) and without Local models only (`check_set`, pure). Turning the switch on ends
every running agent PTY the gate did not verify **whose fence can see the folder**
(whole subtree, the local tmux session too; `agent_privacy::ptys_to_end`): the
project's own, a parent project's, a box's, the root console's with the read-only
project view or an allowlist that covers it. Each fence's view is recorded when it
is built (`agent_fence::note_fence_view`: visible roots, allowlist and root-console
grants, and the locked folders it masked), so a tab spawned after the switch, whose
fence masked the folder, is left alone. A container agent records the mounted
project folder as its view (`container_fence_view`), since a container hides nothing.
`closed_tabs` carries the PTY ids
(`<scope>:<tab key>`); the store closes exactly those tabs, in every scope, and no
other (a verified local tab the backend kept is not closed). Unfenced agents (the
Host session, Windows) have no recorded view and are not touched: D1.

Agents **no registry PTY holds** are swept too (`commands::agent_privacy::
end_detached_agents`, `agent_privacy::tmux_sessions_to_end`): a tab the phone started
headless (`prepare`, a detached `tmux new-session`, `commit`: the commit records the
fence view and the tmux session on the live spawn) and an agent tmux session that
outlived a crash, which a respawn would attach to (`new-session -A`, while the fence
built for the respawn describes a new process, not the old one). The app's sessions
are listed with `tmux ls`; an agent session (`<prefix><project key>--agent-…`) no PTY is
a client of ends when its recorded view shows the folder, or when its view is
unknown and it is the project's own, its pane folder lies in, at or above the
locked folder, or names none (fail closed). A known view that hid the folder, a
verified tab and shell sessions stay. Each goes with its whole process subtree (the
pane's process found before the session is killed) and then the session
(`closed_sessions` in the answer). A verified local tab that survived a crash has no
recorded view and is ended too, by the same rule.

## The gate

Two checkpoints, because the argv is rewritten between them (session resume,
Codex `--no-daemon`, OpenCode flags):

1. `launch_prep::prepare` calls `agent_privacy::gate` right after the authority
   and cwd checks (before the scope env, MCP grants, tokens or any home exist).
   It runs for every window spawn, phone spawn (`mobile_control` headless),
   scheduled prompt and restore, since they all pass `prepare`.
2. Both fence wrappers (`wrap_pty_options_bwrap`, `wrap_pty_options_sandbox_exec`)
   call `agent_privacy::fence_gate`, which checks the **stamp** the first gate left
   (`STAMP_ENV`, a control variable, stripped from anything a tab brings). The
   `agent_shim` of a shell tab builds its opts itself and carries no stamp, so a
   cloud CLI typed into a shell tab in a locked project is refused here, in the gate's
   words (`unstamped_reason`): the driver-specific text for OpenCode with the network on
   (or an unverified driver with the cut on), else the general text, and both name the local
   agents that can run for the project's mode. The refusal is the stamp's; only its text is built.

A spawn is *subject* to a locked project when it runs in that project
(`project_id`) or its `cwd` lies in the project's folder (`path_inside`: the
spelling, the lexical `..` fold and the resolved path; any one saying "inside"
counts). Only agents are gated; a shell tab is the user's.

A subject spawn is allowed only when `vet` accepts it:

- not remote, not a worker host, not a container, not the Host session, not the
  assistant, Cut network not recorded on the project. A `remote` or `vm` value of
  `null` on the record is absent, in the setting and in the gate alike
  (`remote_or_vm`, the reading `remote_target_for` has);
- **the argv is a launch line Tabtivity builds for a local driver**
  (`local_drivers::identify_local_launch` tries each argument as the model of each
  `LOCAL_DRIVERS` entry against `local_launch_line_ok`: an exact enumeration, no
  parsing), or a `vibe` tab with args `[]`, `--continue` or `--resume <uuid>` whose
  `<APP>_LOCAL_MODEL` env names the model. The renderer's `PtyOptions.local_model`
  is never read for the decision; the plan's "`prepare_local_agent` record" is
  not needed because the argv itself is what runs;
- Cut network not recorded on the project, or `Probe::can_cut` (`cut_platform`, Linux);
  when it is recorded and the platform cannot cut, the project is closed to agents;
- the driver is allowed for the project's mode. **Network on:** not **OpenCode**
  (`agent_privacy::REFUSED_DRIVERS`): a launch line that would be OpenCode's is refused,
  before Ollama is asked, with "OpenCode cannot be kept on the local model in a Local models
  only project that keeps its network" and the local agents that can run
  (`agents_that_can_run_locked(pins_claude, cut)`: the `LOCAL_DRIVERS` labels but OpenCode,
  Claude Code only where it can be pinned, and Mistral (vibe)). **Cut network on:** only
  `CUT_VERIFIED_DRIVERS` (OpenCode, Claude Code, Codex; the per-driver table below); any other
  driver is refused naming itself ("has not been verified with the network cut"). Every route
  into a locked project passes `vet` or the fence's stamp check (window, phone, restore,
  schedule, a box tab or the root console with a cwd inside, the shell-tab shim). The ＋ menus
  follow (`driversForLockedProject(drivers, cut)`, `LOCKED_REFUSED_DRIVERS` and
  `CUT_VERIFIED_DRIVERS` in `localModelsOnly.ts`, `vibeOfferedInLockedProject`; the phone's
  sheet lists all rows, as it does the cloud ones, and gets the backend's text);
- `OLLAMA_HOST` of the Tabtivity process, if set, is loopback;
- the endpoint is the loopback `ollama_host`, and
  `ollama_client::tab_model_is_local_at` passes: a listed model without a remote,
  no other model sharing its alias, the listener owner check
  (`LISTENER_REFUSED`). Ollama down, an unreadable list or a foreign listener
  refuse.

On success `apply` scrubs the renderer's env down to the two variables the frontend
sets itself (`<APP>_TAB_UID`, `<APP>_LOCAL_MODEL`; a list of keys and base URLs cannot
keep up with what a CLI reads: `vibe` takes every `VIBE_*` as config, Codex `--oss`
reads `CODEX_OSS_BASE_URL`), forces
`local_model` (the scope's `.local` home, which holds no logins), stamps the
env, and pins `OLLAMA_HOST` to the verified endpoint. API-key injection
(`agent_api_keys::inject_launch`, the hosted admin key, `inject_api_keys` of the
Host/platform arms) is skipped for a stamped spawn. Inherited provider keys are
removed by `--unsetenv` in the Linux fence and `env_remove` on the PTY
(`terminal::build_command`).

**Vibe** gets a per-project home, `vibe_local/<alias>.<project key>`, instead of the
`vibe_local/<alias>` every scope shares (gap 30), and the gate writes its
`config.toml` itself (`local_drivers::vibe_local_config`: the verified model on the
verified endpoint, one provider, tools off), so the config that runs is the one that
was checked, not what the renderer's `prepare_local_agent` call left.

Refusals start with `Local models only: "<project>" is set to Local models only, so
...` and end naming the switch. They reach the tab like any spawn error.

## Keeping the folder out of every other fence

- `agent_fence::mask_local_models_only` (Linux) splices `--tmpfs <dir>` for every
  locked project's folder (given and resolved spelling, existing dirs only) after
  `mask_private_state`, in every fence except the project's own tabs'. That covers a
  parent project, the `agent_fence_paths` allowlist, the root console and one-shot
  preflights. macOS adds the same folders to the Seatbelt profile's `hidden` list.
- `box_store::compute_box_allowed_roots` skips locked members, so a box tab never
  gets the folder; `compute_fence_roots`/`roots_for_scope` give a locked project's own
  tabs **its folder only**, no box roots.
- `root_project_read_only_paths` skips locked projects.
- A container never carries one: `set_project_sandbox*` refuse for a locked project and
  `sandbox::wrap_pty_options_docker` refuses an agent whose project is locked or
  whose mount contains a locked folder.

- A fence that cannot read the project list is not built: `mask_dirs_now` is an error,
  not "no masks", and every fence caller propagates it.

The box editor marks a locked member with a lock.

## The folder's own CLI config (a verified tab's fence)

The project folder is attacker-controlled and the CLIs read config from it, so a
verified local tab could be re-aimed at a cloud provider by a file in the folder.
`agent_privacy::project_config_masks` lists, in the tab's cwd and every folder above
it up to its root (walked as the folder the process is really in: a link or `..` in
the cwd is resolved, so a link inside the folder does not skip a parent), the names
below that **exist**; both fence wrappers cover them for
a verified tab (`mask_project_config`: `--ro-bind /dev/null` over a file, `--tmpfs`
over a folder; macOS adds them to the Seatbelt `hidden` list, not compiled here).
Existing paths only: a mount over nothing makes bubblewrap create a placeholder file
in the project. A file created later is covered at the next spawn, which looks again;
within a running session a CLI that re-reads its settings picks up a file its own
agent writes — see "A CLI re-reads its settings mid-session" below for what is pinned
against that, per CLI. A name that is
a link to nowhere refuses the spawn. An empty file reads as no config in every CLI
below that was run.

| CLI | Project config it loads | Result |
| --- | --- | --- |
| Claude Code 2.1.319 | `.claude/settings.json`, `.claude/settings.local.json` | **Checked.** The `env` block of the project settings beats the process environment: with `ANTHROPIC_BASE_URL` set by the launcher and another URL in the project file, the conversation (`POST /v1/messages`) went to the project's. `--setting-sources user` closes it, but the launch line is `ollama launch claude --model m` and takes no flags, so the mask is the closure. An empty or `{}` file reads as no settings. |
| OpenCode 2.2.6 | `opencode.json`, `opencode.jsonc` in the cwd and every folder above it, and `.opencode/` | **Checked** (`opencode debug config` lists them; a `.env` in the folder is not read). `OPENCODE_DISABLE_PROJECT_CONFIG` / `OPENCODE_CONFIG_PROJECT_DISABLE` exist in the binary but did not change that listing, so they are not relied on. An empty `opencode.json` loads as nothing. |
| Codex 0.167.0 | `.codex/config.toml` of a trusted project | **Checked.** It ignores `model_provider`, `model_providers`, `openai_base_url`, `chatgpt_base_url`, `profile`, `profiles` there (it says so at start), but `model` and `oss_provider` apply, and the launcher's `-c`/`-m` outrank them. Masked anyway. |
| Pi, Droid (`.factory/`), Cline (`.cline/`), OpenClaw (`openclaw.json`, `.openclaw/`), Mistral Vibe (`.vibe/`) | project folders named from the CLIs' documentation | **Not verified**: the binaries are not installed here. Masked by name; if one reads a project file under another name it is not covered. Vibe also reads only the per-project home the gate writes unless the folder is trusted in that home, which nothing trusts. |

Not covered: `.mcp.json` and other project MCP servers (tools, not a model location);
a CLI's env-var switches for ignoring project config (above: not effective or not
checked).

## A CLI re-reads its settings mid-session

The masks above cover config that exists at spawn. Measured with the installed CLIs
(fix round 3, a plain process, an isolated `HOME`, two loopback listeners standing for
"Ollama" and "an attacker"; first prompt, then settings files written, then the next
prompts):

| CLI | Re-reads mid-session? | What pins it |
| --- | --- | --- |
| Claude Code 2.1.319 | **Yes**, project `.claude/settings.json`, `.claude/settings.local.json` and the user's `~/.claude/settings.json` (the agent home's, writable in the fence). An `env.ANTHROPIC_BASE_URL` moved the next `POST /v1/messages`; so did `env.HTTP_PROXY`/`HTTPS_PROXY` (the whole request goes through the proxy even to a loopback base URL) and `env.CLAUDE_CODE_USE_BEDROCK` + `ANTHROPIC_BEDROCK_BASE_URL` (the request went to the attacker as `/model/<m>/invoke-with-response-stream`). | A **managed-settings file** (`local_drivers::claude_managed_settings`), written by the backend into `<state>/claude_managed/<digest>/claude-code/managed-settings.json` (content-addressed, `home_io` handles, pinned by inode and re-checked last by `verify_control_pins`) and bound read-only into the fence at Claude's machine-wide path `/etc/claude-code/managed-settings.json`. It outranks project and user settings. It pins `env` (`ANTHROPIC_BASE_URL` to the verified endpoint, the model variables `ollama launch claude` sets, the proxy and `CLAUDE_CODE_USE_*` variables emptied, `NO_PROXY` to loopback), `model`, `availableModels: [model]` and `allowedProviders: ["customEndpoint"]` (Claude Code refuses a session on any other provider; the custom endpoint is admitted only at the value this file pins). Built from what the gate recorded for the tab (driver, model, endpoint), not from the argv. |
| OpenCode 2.2.6 | **Yes**: a project `opencode.json` / `.opencode/opencode.json` written mid-session moved the next request when the provider came from a project file (`opencode mini --standalone`). | **Nothing holds it, so OpenCode is refused in a locked project until Phase 2.** An inline `OPENCODE_CONFIG_CONTENT` (which fix round 3 gave a verified tab) pinned the `ollama` provider's endpoint, but config arrays merge as a union: a project file that adds a provider and sets `enabled_providers`, `model`, `small_model` or a per-agent `model` still lists and uses its own (`opencode models --standalone`, review 3). The only closure would be to create the files in the project to mask them, which the app must not do. The inline-config code in `apply` is removed (it is in git history, `17f447d3`); `local_drivers::opencode_ollama_config` stays, since `launch_prep` builds the loaded-models config with it for every other OpenCode tab. |
| Codex 0.167.0 | **No** (measured): `.codex/config.toml` written mid-session with another `model`/`model_provider`/`openai_base_url` changed nothing; later requests kept the launch model on the launch endpoint. The provider keys in a project file are ignored at start anyway. | Nothing needed. |
| Pi, Droid, Cline, OpenClaw, Vibe | Not installed, not measured. | The spawn-time masks only. Vibe's home is pinned read-only. |

**Where the managed file goes (Linux).** Claude Code reads `managed-settings.json` and the
drop-in folder `managed-settings.d/` under `/etc/claude-code` (strace). The environment
override of that path is compiled out of the release build (`CLAUDE_CODE_MANAGED_SETTINGS_PATH`
names a function that returns nothing), so the file has to sit at the real path. The fence root
is `--ro-bind / /`, and bubblewrap cannot create a mount point in it, so
`agent_fence::managed_claude_args` covers the host's `/etc/claude-code` with an empty tmpfs when
it exists (hiding an administrator's own policy in this fence), binds the file in and remounts the
tmpfs read-only (no drop-in can be added); when there is none it overlays `/etc` read-only with the
file's layer as a second source (`--overlay-src /etc --overlay-src <layer> --ro-overlay /etc`). The
mounts come right after the root bind. **The bubblewrap argv is a unit test; it was not run**:
this session's fence forbids a nested namespace, so neither the overlay nor the tmpfs case was
mounted, and the overlay needs bubblewrap 0.8 and an overlayfs that unprivileged user namespaces may
mount (a failure refuses the spawn, closed). Bubblewrap's version is read once from the binary the fence
runs (`agent_fence::bwrap_version`, `bwrap --version`, cached per binary file) and, when the overlay form is
the one to use, a version below 0.8 or one that cannot be read refuses the spawn with a message naming the
version found and 0.8 (`overlay_bwrap_check`), instead of bubblewrap's bare "unknown option". The tmpfs form
uses nothing newer than bubblewrap has had for years and is not checked. A host whose `/etc` holds bind mounts of its own (a
container's `resolv.conf`) is the case to watch for the overlay. The pinned precedence was measured
by pointing the real binary at an equivalent file through a ptrace path rewrite (a test tool, not
part of the product); the real bind mount was not exercised.

The pin is built from the gate's record of the tab, which is kept per tab id; a Claude launch whose
record is missing or not Claude's (a second spawn of the id replaced it) refuses instead of starting
unpinned (`agent_privacy::claude_managed_for` also reads the launch's own argv).

**macOS and Windows.** Seatbelt cannot bind a file to `/Library/Application
Support/ClaudeCode/managed-settings.json`, and Windows has no sandbox: `vet` refuses a
verified Claude tab there (`Probe::pins_claude`, `CLAUDE_NOT_PINNABLE`), and the Seatbelt wrapper
repeats the refusal. The other local agents are unaffected.

## Audit of the non-agent paths to a cloud model

| Path | Result |
| --- | --- |
| Copilot inline completion | **Closed.** `commands/copilot.rs` `authorize_in` answers `copilot_local_only` for a locked project (the editor falls back to the local model) and `copilot_set_project_policy` refuses to switch Copilot on for one. A file of a locked project opened through a project that contains it is refused by path (`inside_locked`, in `copilot_complete`). |
| Ollama text completion (`complete_text`) | **Closed for a locked `project_id`.** Loopback host only, and the model must pass `model_is_local_at` (an Ollama cloud model on the loopback endpoint is answered on ollama.com). A locked file opened through a parent project carries the parent's id and is not covered (flagged in the handoff). |
| Tabby (chat assistant) reading project files | Not a path by `@` mention: the assistant's fence has **no roots** (`check_assistant_spawn`), so it cannot open a project file. The way in is a **file drop**, below. |
| Dropping a project file onto an agent tab (the inbox copy, also the Tabby chat) | **Closed.** `pty_drop_files` refuses (`local_models_only`) any path inside a locked folder unless the tab is a gate-verified local tab of that project (`agent_privacy::drop_refused`). Inbound drops into a locked project are fine. |
| Clipboard image, phone upload | Not project files. |
| Send to project (file-tree copy into another project, `import_external_file`) | **Treated as the user's own file copy** (a plain copy command, no agent involved), left allowed: a copy out of a locked project puts the file where cloud agents of the destination read it. Flagged; inbound copies into a locked project are fine. |
| Markup rounds | **Closed for a file reached through another project.** A Submit (`pdf_markup_submit`, the phone's markup route) is refused (`local_models_only`) when the file lies in a locked folder and the project the prompt goes to is not that folder itself (`agent_privacy::foreign_source`): the tabs of the locked project are the gate's local ones, those of a parent project are not. The guard is in the two command layers, not the shared core. |
| Prompt library, scheduled prompts, anything typed into a tab (`pty_write`), "send selection" style insertions | **A limit.** The backend sees the text and the target tab but not where the text came from: no command takes a source path. A scheduled launch in a locked project passes `prepare`, so a cloud CLI is refused; a prompt the user builds from a locked file and sends to a cloud tab is the user's act. No separate "send selection to tab" command exists in the code. |
| Root MCP `project_activity` / `projects_git_status` | **Closed.** Commit subjects and branch state are the folder's own text: skipped unless the caller is a `LocalModel` tab whose model passes `local_model_confirmed` (`hidden_from`): a Mistral tab on an Ollama cloud model is hidden from like a cloud agent. The `LocalModel` class itself is no longer the renderer's label: `grant_root` makes a root agent one only when `agent_privacy::local_vibe_launch` reads a loopback Ollama model out of the `vibe_local/<alias>[.<key>]` home it runs from (a plain `vibe` argv, no `VIBE_*` override but the two the frontend sets, a `config.toml` that is byte for byte what `vibe_local_config` writes). The endpoint and the model recorded in the session come from that config. A spawn that only claims to be local (the label, a user's home, a cloud argv) gets no root token at all. The mail local-read path reads the same session identity. Residual: the home is read at spawn; the tab's own fence can rewrite it afterwards (as before). |
| Root MCP `projects_list`, `todo_*`, `boxes_list`, `time_summary`, `usage_recap` | Not a path: names, ids, folder paths and the to-do cards the user typed in Tabtivity; no file content. Flagged: to-do cards of a locked project stay readable to the cloud root agent. |
| Mail AI, voice | Do not read project files (mail text and microphone audio). |
| Warm-up cron (`agent_warmup`) | Runs a CLI in the probe home with a fixed word, not in a project. |
| `git_push` / CI lanes of a local tab | The user's machines, not models (D3). |
| A server share | Warns on the hosted server (D3), unchanged in phase 1. |

## Tests

`agent_privacy/tests.rs`: setting shapes and round trip; subject detection (links,
`..`, siblings sharing a prefix); masks; env scrub; the gate for each launch kind
(cloud CLI, a genuine local line on a local model, a local line on a cloud model,
the renderer's `local_model` on a cloud argv, Ollama down, a remote host, a foreign
listener, an alias clash, the Host session, remote, container, Cut network); vibe
home and config; the fence repeat; box roots; the root read-only list; the source
scans that name every spawn site (`prepare` calls the gate before the scope env;
both wrappers call `fence_gate` and skip key injection; the docker wrap refuses;
only four files wrap an agent in the fence).

## Cut network (phase 2, Linux)

`cut_network` on a Local models only project (`agent_privacy::cut_platform`: Linux; macOS is phase 3 and
Windows has no sandbox, both refuse with `CUT_NETWORK_UNAVAILABLE` and the gate closes a project that
has it recorded) gives its verified local tabs a bubblewrap fence with `--unshare-net`. bubblewrap
brings `lo` up in the new namespace itself (`loopback_setup`, RTM_NEWADDR/RTM_NEWLINK; the strings
are in the installed 0.11.1), so the agent's loopback is its own and the host's Ollama and Tabtivity MCP
ports are not there. The abstract-socket Landlock scope is unchanged (abstract sockets are per network namespace, so the host's are out of reach anyway). `insert_local_lane` also drops the fence's `/run/systemd/resolve` bind: systemd-resolved's varlink socket there is mode 0666 and answers `ResolveHostname` from any namespace, a DNS channel out. The fence decision is the gate's
record (`Verified::cut`) checked against the registry (`fence_cut_in`): the switch moved on while a tab
started refuses (open it again), moved off keeps the cut.

**The local lane** (`services::local_lane`, Unix only, `AppHandle`-free, builds in the daemon):

- *Host side* (`server.rs`, `policy.rs`, `http.rs`): per tab two Unix sockets in `<state_dir>/local-lane/`
  (`<hash of the pty id>.sock` for Ollama, `….mcp.sock` for the tools; mode 0600 in a 0700 folder; a long
  state dir is reached through `/proc/self/fd/<dir>/` because `sun_path` holds about 100 bytes). Opened by the
  Linux wrapper after every mask, closed by `on_tab_gone` / `abandon_spawn`, at the app's `RunEvent::Exit`
  and the Mobile host's stop (`stop_for_exit`); files an earlier run left are swept at the first open. Every
  connection is one request: a strict parser (no chunked body, no upgrade, no compressed body, one
  `Content-Length`, no bare line feeds, `Expect: 100-continue` answered), a path allowlist, then the request
  is **rebuilt** and sent on to the verified loopback endpoint (only `Content-Type`, `Accept`, `User-Agent`
  and a `Host` of the lane's choosing; `Connection: close`; identity encoding), after
  `ollama_client::owner_gate` on every connect. Streaming passes through byte for byte; a client that hangs
  up drops the upstream connection (the generation stops). Limits: 32 MiB body, 15 s head, 120 s body, 15 min
  idle, 4 h per exchange, 32 exchanges per lane. Refusals are JSON in the shape of the API asked
  (native, OpenAI, Anthropic).
- *Routes*: the plan's list (`/api/chat`, `/api/generate`, `/api/embed`, `/api/embeddings`, `/api/tags`,
  `/api/show`, `/api/ps`, `/api/version`, `/v1/chat/completions`, `/v1/completions`, `/v1/embeddings`,
  `/v1/models`, `/v1/messages`) **plus two the drivers needed**, found by running them: `GET|HEAD /`
  (`ollama launch` probes it first and stops with "something went wrong" without it) and
  `POST /v1/responses` (Codex's wire API). Everything else is refused (`pull`, `push`, `create`, `copy`,
  `delete`, `blobs`, `/api/status`, `/api/experimental/*`, `/api/hello`, `/v1/messages/count_tokens` ...).
- *Models*: every model a body names (`model`; `name` too on `/api/show`) passes
  `ollama_client::model_is_local_at` (60 s cache). Go's JSON decoder folds key case and takes the last
  match, so a body that spells `model` twice or in another case is refused, as is a non-string, a padded or
  empty name. `/api/tags` drops entries naming a remote; `/v1/models` keeps ids the same check accepts.
- *Tools*: the second socket forwards `POST` to `/mcp/cockpit`, `/mcp/help` and `/mcp/markup` of this
  process's MCP server only (`MCP_ALLOWED`); `/mcp/web`, `/mcp/git`, `/mcp/schedule` and `/mcp` are refused.
  Bearer tokens are unchanged and forwarded. The phone send (`tabtivity-send`) needs no relay at all: it is a
  shell script that writes into the project's outbox folder, which the fence binds read-write.
- *Fence side* (`relay.rs`, `main.rs`): the fence's command becomes the app's own binary,
  `<binary> --local-relay PORT=SOCKET… -- <cli> …`, bound read-only at `/run/<slug>-lane/relay`, with the
  sockets bound beside it (right after the `--tmpfs /run`, before the home is replaced, so the sources under the
  state dir resolve). It listens on `127.0.0.1` (and `::1`) at **the same ports** the CLI is configured with
  (the verified Ollama port, the MCP port), so the Claude pin, `OLLAMA_HOST`, the OpenCode inline config and
  every MCP URL keep working; the pins name `127.0.0.1:<port>` whatever spelling `ollama_host` has
  (`fence_endpoint`). It forks a pump process (own process group, no terminal, `PR_SET_PDEATHSIG`) and
  **execs the CLI in the same process**, so the tab keeps its process, terminal and signals. A client hang-up
  closes the exchange.

**Why the app's own binary, not a helper (the spike).** The plan asked to check the binary is reachable and
what it costs. Measured on the debug build here: 125 shared libraries (the host's `/usr/lib`, visible through
`--ro-bind / /`), 40 to 80 ms to start (the mode is dispatched in `main` before anything of Tauri starts, as
`--fence-scope` and `--agent-exec` already are), 57 MB resident. It can be bound whatever its path is, including
under `$HOME`, which the fence otherwise hides. The cost is that an **AppImage** keeps its libraries in a FUSE mount
under `/tmp` that the fence hides, so `relay_exe_check` refuses a cut spawn there with the reason; the static
helper in `<state_dir>/bin` the plan names as the fallback is **not built** (it needs a second build target and
packaging, which this change could not exercise). *Not run:* the bind mount and the relay inside a real
`--unshare-net` bubblewrap, because this session's fence forbids a nested namespace.

**Tests.** Real sockets and no namespace: an in-process in-fence listener (`Relay`), the Unix socket, the host
side and a stub Ollama (`local_lane/tests.rs`): routes, refusals, models (cloud name, cloud model listed under a
local name, duplicate-case keys), list filtering, body cap and framing, slow head, `100-continue`, streaming
as produced, hang-up cancels, MCP lanes, socket mode and teardown, long paths; the real binary's mode in
`tests/local_lane_relay.rs` (the command is the relay's own process and its exit code, the pump goes with it,
a taken port fails closed); the bubblewrap argv shape in `agent_privacy/tests.rs`.

**Per-driver run with the network cut.** Done as plain processes, no namespace: `netcut`, a seccomp
user-notification supervisor (a test tool, not in the product) that fails `connect`/`sendto`/`sendmsg` like a
fresh namespace would: loopback ports that something on the *host* listens on refuse, ports the CLI's own
tree opens are allowed, everything else is `ENETUNREACH`, and the stub resolver `127.0.0.53:53` refuses.
In it, `<binary> --local-relay` and the harness `examples/local_lane_harness.rs` (the lane's host half
against the real Ollama on 127.0.0.1:11434) with `nemotron-3.5-bolt:e4b`; a permissive logging proxy was
used first to learn which paths each CLI asks for. Each CLI ran in an isolated `HOME`, a scratch project,
under a pty. "Edit" is a non-interactive run in a scratch project.

| Driver | Starts | Answers a prompt through the relay | Edits a file | Update check, telemetry, login probe | Lane paths used | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code 2.1.319 | 0.6 s | yes (`ollama launch claude` too, once `HEAD /` is carried) | yes (`claude -p`, `acceptEdits`) | Without the quiet switches it sends `HEAD /api/hello` (refused, harmless) and tries the resolver; with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and `DISABLE_AUTOUPDATER=1` it sends nothing but the model call. No hang either way | `POST /v1/messages?beta=true`; `HEAD /`, `POST /api/show`, `GET /api/tags` (+ refused `/api/status`, `/api/experimental/model-recommendations`) through `ollama launch` | **verified** |
| OpenCode 2.2.6 | 1.0 s (`mini --standalone`, its own server on a random loopback port, which a namespace's loopback allows) | yes (`opencode run`) | yes (`Wrote file successfully`) | The resolver is tried and refused at once; `OPENCODE_DISABLE_AUTOUPDATE`, `_MODELS_FETCH`, `_FREE_MODELS` silence it. No hang | `GET /api/tags`, `POST /api/show` for **each installed model** (a cloud-flagged one is refused by the lane, which the CLI shrugs off), `POST /v1/chat/completions` | **verified** for `run`; the interactive `mini` TUI started but a prompt typed through the harness's pty never produced a request (not diagnosed, so the typed-prompt path is **not** verified) |
| Codex 0.167.0 | 0.7 s | yes (interactive) | **not verified**: its own sandbox needs a user namespace and exits at "Codex's Linux sandbox uses bubblewrap" here; the unsandboxed form was not run | The resolver is tried and refused at once; no env switch exists. No hang | `GET /v1/models`, `GET /api/version`, `GET /api/tags`, `POST /v1/responses` | **verified** to start and answer; edit not exercised |
| Pi, Droid, Cline, OpenClaw | not installed | | | | | **refused** in a cut project, naming it |
| Mistral (vibe) | not installed | | | | | **refused** in a cut project, naming it |

`CUT_VERIFIED_DRIVERS` is `opencode`, `claude`, `codex`; `cut_quiet_env` sets the switches above on a cut tab.
The ＋ menus, the allowed-agents list and the phone's sheet follow it (`offeredLocalAgents`).

**The phone's ＋ sheet** (`NewTabSheet`, `localChoiceRows`) reads the same rule as the desktop menus:
`PublicProject` (`mobile_control::discovery`) carries `local_models_only` and `cut_network` as plain booleans,
absent when off (read with `agent_privacy::privacy_of_value`, so a malformed record counts as locked, as in
the gate). In a locked project the sheet lists the local model's agents (OpenCode only with the cut on, and then
only the verified drivers) and shells, not the cloud agents, their cloud sessions, the API and sign-in rows;
`cloudRowsOffered`, `offeredLocalAgents` are the one shared TS rule. `the_frontends_driver_lists_are_the_backends`
ties the Rust and TS driver lists. The baked PWA needs `npm run mobile:bundle` to carry the sheet change.

## Not done

macOS Seatbelt network denial (phase 3: Cut network is refused there), container and VM projects
(phase 4), and what "Cut network (phase 2, Linux)" below lists as not run in a real namespace.
