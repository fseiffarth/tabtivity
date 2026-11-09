# Local-models-only projects

Phase 1 of `docs/local_models_only_plan.md`. A project marked **Local models
only** is read by no cloud model: only an agent on an installed local Ollama
model starts in it, nothing in Tabtivity hands its files to a cloud model, and
no other tab's fence can see its folder. The switch below it, **Cut network**,
is stored and shown, and refused until phase 2 (nothing enforces it yet).

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
Cut network outright (`CUT_NETWORK_UNAVAILABLE`). Turning the switch on ends
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
   cloud CLI typed into a shell tab in a locked project is refused here.

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
| OpenCode 2.2.6 | **Yes**: a project `opencode.json` / `.opencode/opencode.json` written mid-session moved the next request when the provider came from a project file (`opencode mini --standalone`). | The gate puts an **inline `OPENCODE_CONFIG_CONTENT`** on a verified tab, written from the verified endpoint and model (`opencode_ollama_config`). Measured: with the inline config set, the same mid-session project files moved nothing (all later requests went to the inline endpoint). Not pinned: a project config that adds a new provider or sets `model`/`enabled_providers` (the project's `enabled_providers` replaced the inline list in `opencode models`); it takes a user action (a new session, a model switch) to use. Flagged. |
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
mount (a failure refuses the spawn, closed). A host whose `/etc` holds bind mounts of its own (a
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

## Not done in phase 1

Phase 2 (`--unshare-net`, the local lane relay, Cut network), macOS Seatbelt network
denial, container and VM projects, the phone's ＋ sheet hiding cloud rows in a locked
project (the spawn is refused with the backend's text).
