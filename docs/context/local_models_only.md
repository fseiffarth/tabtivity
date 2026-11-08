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
the project's running agent PTYs the gate did not verify (whole subtree, the
local tmux session too); the store closes their tabs.

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
  assistant, Cut network not recorded on the project;
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

The box editor marks a locked member with a lock.

## Audit of the non-agent paths to a cloud model

| Path | Result |
| --- | --- |
| Copilot inline completion | **Closed.** `commands/copilot.rs` `authorize_in` answers `copilot_local_only` for a locked project (the editor falls back to the local model) and `copilot_set_project_policy` refuses to switch Copilot on for one. A file of a locked project opened through a project that contains it is refused by path (`inside_locked`, in `copilot_complete`). |
| Ollama text completion (`complete_text`) | **Closed for a locked `project_id`.** Loopback host only, and the model must pass `model_is_local_at` (an Ollama cloud model on the loopback endpoint is answered on ollama.com). A locked file opened through a parent project carries the parent's id and is not covered (flagged in the handoff). |
| Tabby (chat assistant) reading project files | Not a path by `@` mention: the assistant's fence has **no roots** (`check_assistant_spawn`), so it cannot open a project file. The way in is a **file drop**, below. |
| Dropping a project file onto an agent tab (the inbox copy, also the Tabby chat) | **Closed.** `pty_drop_files` refuses (`local_models_only`) any path inside a locked folder unless the tab is a gate-verified local tab of that project (`agent_privacy::drop_refused`). Inbound drops into a locked project are fine. |
| Clipboard image, phone upload | Not project files. |
| Send to project (file-tree copy into another project) | A user's file copy between folders, not a model call; but a copy **out** of a locked project puts its files where cloud agents read them. Left to the user; the dialog is unchanged. Flagged. |
| Markup rounds, prompt library, scheduled prompts | A markup/scheduled prompt goes to a tab of its own project; the tab in a locked project is local by the gate. A scheduled launch in a locked project passes `prepare`, so a cloud CLI is refused. |
| Root MCP `project_activity` / `projects_git_status` | **Closed.** Commit subjects and branch state are the folder's own text: skipped unless the caller is a `LocalModel` tab whose model passes `local_model_confirmed` (`hidden_from`): a Mistral tab on an Ollama cloud model is hidden from like a cloud agent. |
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
project (the spawn is refused with the backend's text), killing a cloud agent's
surviving tmux session that no live PTY holds.
