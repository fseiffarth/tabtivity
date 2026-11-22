# Model tabs on a remote machine's own Ollama — Plan

> **Status (screened against code 2026-11-22):** Nothing is built: no `host_ollama`, `hostModel`/`hostModelTabSpec` or `host_model_spawn` symbol exists in `src/` or `src-tauri/`, and the named `docs/host_models_handoff.md` and `docs/context/host_models.md` do not exist. Code sites were read on `develop` at a368eeeb3; line numbers are approximate. Not live-tested unless the doc/todo says so.

## Context

The user: *"write up a plan how to use local ollama models and tabs on remote
machines eg for remote only projects"*.

Today a local-model tab is tied to this computer twice:

- **The model**: `services/ollama_client.rs` talks to one Ollama, on loopback
  (`ollama_addr`, `owner_gate`).
- **The tab**: kind `local_agent` is always `local_only`
  (`stores/tabs/tabLocation.ts` `effectiveTabLocation`), so it runs here, in the
  project folder or a remote project's mirror.

A remote-only project has no folder here, so `launch_prep::pinned_spawn_refusal`
refuses the tab (remote-only plan D11) and the + menu hides the group. A plain
Remote project can only run the model here, against the mirror, while its GPU
machine sits unused.

**Outcome:** on a connected remote machine (the primary or a worker), the + menu
offers the models installed in *that machine's* Ollama, and the tab, the agent
CLI and the model all run there. Only the terminal crosses SSH. Prompts and
files never reach this computer or a cloud model.

Name used below: a **host-model tab**. It is not a `local_agent` tab.

## Decisions (answered by the user, 2026-11-20)

| # | Question | Answer |
|---|---|---|
| U1 | Where does the model run? | **On the remote machine**, in its own Ollama. No tunnel to this computer's Ollama. |
| U2 | Who installs and starts Ollama there? | **Use it, start it, offer install.** Use a running server that is the user's or the system's; start `ollama serve` in a named host tmux session when only the binary is there; a one-click host tab installs without sudo. Never stop a server Tabtivity did not start. |
| U3 | How much model management? | **Pick + pull in a tab** for the first version. The + menu lists the machine's models; "Pull a model…" opens a visible host tab. The user then asked about the full Models panel per machine: it is Phase 4 below, not dropped. |

## Fixed decisions (mine; change any before the build)

1. **Kind `agent`, not `local_agent`.** A host-model tab is an agent tab whose
   location is the machine (`"remote"` or `host:<id>`), plus a
   `hostModel: { driver, model }` field. Everything a host agent tab already has
   then applies unchanged: tmux persistence, the locality badge, restore, the
   pinned-project rules. `local_agent` keeps meaning "runs here"; D11 stays true.
2. **One driver table.** The launch line comes from `LOCAL_DRIVERS`
   (`services/local_drivers.rs`), the same rows the desktop uses. No second
   table. The direct fallback is preferred where a row has one (OpenCode, Codex);
   `ollama launch <sub> --model <m>` otherwise, and only when the host's Ollama
   has `launch`.
3. **The backend recognises the spawn, the renderer does not declare it.**
   `launch_prep` calls `local_drivers::identify_local_launch(cmd, args)` on the
   pre-wrap argv of a spawn with a remote target. A match is a host-model spawn.
   For it the backend sets `OLLAMA_HOST` and OpenCode's inline config itself from
   the probe, and drops whatever the renderer sent under those names.
4. **Its own home on the host.** `ollama launch` writes agent config under
   `$HOME` (a Codex profile and `model.json`, Pi's `models.json`), and
   `ollama launch opencode` appends to `opencode.jsonc` for good. So a host-model
   tab runs with `HOME` swapped (`remote_agents::home_prelude`) to
   `<base>/<slug>-agent-home-local`, where `<base>` is the machine's Agent folder
   (`RemoteSpec.agent_dir`) or `~/.local/share/<slug>`. The user's own CLI config
   and logins on the host are never written. This is the host twin of the local
   `.local` home.
5. **No cloud credential and no MCP lane rides a host-model spawn.** No API-key
   injection, no Claude token (`claude_token` `SendEnv`), no startup model
   default (`agent_defaults::apply`). It is never `Caller::LocalModel`: this
   computer cannot verify a model on another machine, so mail tools "for local
   models only" must not open for it.
6. **A foreign Ollama is never used.** If the listener on the host's port belongs
   to another ordinary user, prompts would go to their process. The probe reads
   the listener's uid from `/proc/net/tcp{,6}` and accepts the user's own uid,
   root and system uids (the `loopback_owner::Policy` rule). The launch prelude
   checks again right before `exec`.
7. **A server Tabtivity starts uses a per-user port** (`20000 + uid % 20000`,
   next free of ten), never 11434, and records it in
   `<base>/<slug>-ollama/addr`. Models go to `<base>/<slug>-ollama/models`
   when the machine has an Agent folder (small home quota), else Ollama's default.
8. **Probes only on a click, only while connected.** The probe runs when the +
   menu's group opens, through the pooled master, and never dials. An
   HPC-tagged machine (`hpc_hosts`) is never probed on its own: its group shows
   "Check <machine>".
9. **Scope v1:** plain Remote and Remote-only projects, primary and runnable
   workers (`workerRunnable`). Not VM projects, not containers, not the phone.

## What stays as it is

- A plain Remote project keeps its "Local model" group (model here, tab in the
  mirror). The machine's group is added beside it, named after the machine.
- `agent_privacy` (Local models only) keeps refusing remote projects.
- `ollama_host` / `ollama_allow_remote_host` in Settings are untouched.

## Design

### Backend

**`services/remote/host_ollama.rs`** (new, `AppHandle`-free):

- `PROBE`: one POSIX `sh` script run with `ssh_exec::run_remote_script_within`
  (8 s), in the same `"${SHELL:-/bin/bash}" -lc` login environment a tab gets, so
  `PATH` matches what the tab will see (`commands/python.rs` `REMOTE_PROBE` is
  the pattern). It prints tagged lines:
  - `ollama=<path>`, `version=…`, `launch=1` when `ollama launch --help` works;
  - `addr=`: the recorded own server, else `$OLLAMA_HOST`, else `127.0.0.1:11434`;
  - `listener=own|system|foreign|none` from `/proc/net/tcp{,6}` and `id -u`;
  - `tags=<json>` from `/api/tags` (`curl`, else `wget`, else `ollama list`
    names only);
  - `bin=<name>` for each `LOCAL_DRIVERS` bin `command -v` finds;
  - `tmux=1`, `arch=…`.
- `parse_probe` → `HostOllama { installed, version, has_launch, server, models,
  bins, tmux, arch }`. Cloud entries are dropped with `ollama_client::is_remote_entry`
  / `is_cloud_name`: this group lists only what is on the machine.
- A cache keyed like `remote::conn_key` `(project, host)`, 60 s, cleared in
  `remote::teardown_pooled`. Reads require `remote::is_connected_host`.
- `start_script(base, port)`: `tmux new-session -d -s <slug>-ollama` running
  `OLLAMA_HOST=127.0.0.1:<port> [OLLAMA_MODELS=…] exec ollama serve`, then waits
  up to 10 s for `/api/version` and writes `addr`. It passes
  `OLLAMA_CONTEXT_LENGTH` / `OLLAMA_KEEP_ALIVE` from the desktop settings when
  set (`configured_context_length`, `configured_keep_alive`). No tmux on the
  host: refused with a message, no `nohup` fallback.
- `install_line(base, arch)`: the userspace install of Ollama's official Linux
  archive into `<base>/<slug>-ollama/` with a link in `~/.local/bin`. One fixed
  `https` URL constant, no `sudo`.
- `pull_line(model)`, `owner_recheck_prelude(addr)`.

**`commands/host_ollama.rs`** (new; each `#[cfg_attr(feature = "desktop",
tauri::command)]`, `async` over a `*_blocking` body, a `command_class` row, and
`commandClasses.ts` regenerated):

- `host_models(projectId, hostId, refresh)` → the snapshot plus each driver's
  `available` (bin present or installable by a `remote_agents` recipe, and a
  wiring path), reusing `driver_verdict`.
- `prepare_host_launch(projectId, hostId, driver, model)` → `{ cmd, args }`.
  `validate_model_name`; the model must be in the snapshot; one bounded
  `/api/show` on the host answers `tools` and `thinking`, with the same
  "positive knowledge only" rule and messages as `local_launch`
  (`commands/ollama.rs` ~l.4410). Gets a `model_allowlist::MODEL_ARG` row.
- `host_ollama_start(projectId, hostId)` → the address. Refused on a foreign
  result only when no free own port exists.

**Spawn path changes:**

- `services/launch_prep.rs`: a `host_model_spawn` decision (fixed decision 3)
  taken before the lanes. For a match: scrub and set `OLLAMA_HOST` and
  `OPENCODE_CONFIG_CONTENT` (`local_drivers::opencode_ollama_config(addr, …)`,
  ~l.1296 is the local twin), skip `agent_defaults::apply`,
  `agent_api_keys::inject_launch` and the Claude token, grant no lane. A spawn
  whose machine has no fresh `own|system` probe is refused with a message that
  names the + menu. `ai_switch::is_ai_spawn` must count it.
- `services/remote/ssh_exec.rs` `remote_command_in` (~l.551): for a host-model
  line, take the bootstrap recipe of the **driver's** bin, not of `ollama`
  (`remote_agents::recipe_for(driver.bin)`), put the `home_prelude` of the
  `-local` home first, then `owner_recheck_prelude`, then the exec line.
- `services/terminal_service.rs`: `hostModel` survives a load only when
  `local_drivers::local_launch_line_ok(driver, model, cmd, args)` holds, beside
  `keep_valid_local_launch` (~l.597). A tab that fails is not restored as a
  model tab.
- `src-core/src/services/remote_agents.rs`: `agent_home_in` gains the `-local`
  variant; no new recipe rows.

Codex on a host: `ollama launch codex` when the host has `launch` (it writes its
own catalog), else the `--oss` fallback without `--model-catalog` (the catalog
path is a local file here).

### Frontend

- `src/lib/agents/hostModels.ts` (new): `fetchHostModels(projectId, hostId)`,
  gated on connected, called when the group opens.
- `src/lib/agents/localTabSpec.ts`: `hostModelTabSpec(scope, hostId, driver,
  label, model)` → `kind: "agent"`, `location`, `hostModel`, label
  `<model> · <driver>`, env `<APP>_HOST_MODEL` (a label for the usage recap,
  never `LOCAL_MODEL`, which `terminalSpawn.ts` reads as `local_agent`). No
  `hostBoundUid`, no `ensure_ollama_running`.
- `src/stores/tabs/types.ts`: the `hostModel` field (round-trips; absent = old).
- The + menu (`lib/tabs/newTabItems.ts`, handlers in `components/tabs/TabBar.tsx`
  ~l.1095 and `NewTabMenu.tsx` ~l.200): one group per connected, runnable
  machine, **Models on <machine>**. Its rows by state:

  | State | Rows |
  |---|---|
  | not connected | group hidden |
  | HPC-tagged, not checked | "Check <machine>" |
  | no Ollama | "Install Ollama on <machine>…" (host tab) |
  | binary, no server | "Start Ollama on <machine>…" (confirm, once per machine and app session) |
  | foreign listener | one line saying so, then "Start Ollama on <machine>…" |
  | server, no models | "Pull a model…" |
  | server + models | model × agent rows as the local group, then "Pull a model…" |

  The start confirm names the machine, the port and the models folder, and says
  plainly that any user of that machine can reach the server (Ollama has no
  login); on an HPC-tagged machine it adds the login-node warning. Dialogs go
  through `useDialogs()` and the shared frames (`add-menu` skill).
- "Pull a model…": a prompt for the name, checked with the backend's
  `model_name_ok`, then a host shell tab running `ollama pull <name>`.
- The tab hover card names model and machine.
- Strings in `src/lib/i18n/en.ts` (and `de.ts`). `UntestedTag` pills and
  register rows in `src/lib/untested.ts`: `newTabMenu.hostModels`,
  `.hostModels.start`, `.hostModels.install`, `.hostModels.pull`.

## Security notes

- **Shared machines.** Ollama's API has no login. Any user who can log in to the
  machine can use the server Tabtivity started, and can pull or delete models
  through it. v1 says so in the confirm and does not hide it. The safe place is
  a machine only the user can log in to (a compute node as a worker).
- **Nothing here is `local`.** The gate, masks and guarantees of
  `docs/context/local_models_only.md` do not cover a host-model tab.
- **Attacker-controlled input.** The model name is a validated, single-quoted
  argument. Address, port and paths come from the backend's probe, never from
  the renderer or the project folder.
- **Install** runs only from a click, visibly, from one constant URL, without
  `sudo`.
- **The started server outlives a quit on purpose**, like host tmux tabs. It is
  listed in the Sessions view and ends there. Check
  `ssh_exec::session_visible_for_project`: the session belongs to the machine,
  not to one project.

## Steps

**Phase 0 — measure on a real host (user runs one script in a host shell tab).**
`scripts/verify-cli/ollama/host_probe.sh` prints: the archive name and layout of
the current userspace install; where `ollama launch <sub>` writes with `HOME`
swapped; that `/proc/net/tcp` shows the listener's uid; that an exported
`OPENCODE_CONFIG_CONTENT` reaches OpenCode on the host; Codex `--oss` without a
catalog. Record the answers in this plan. Add the archive to
`docs/third_party_update_checklist.md`.

**Phase 1 — use a running server.** `host_ollama` probe + cache,
`host_models`, `prepare_host_launch`, the `launch_prep` and `remote_command_in`
changes, the `-local` home, restore validation, `hostModelTabSpec`, the + menu
group (rows for *server + models* and the plain messages for the other states).

**Phase 2 — start a server.** `start_script`, `host_ollama_start`, the confirm,
the per-user port and `addr` file, the foreign-listener path, the Sessions view
entry.

**Phase 3 — install and pull.** The two host tabs and their menu rows.

**Phase 4 — the Models panel per machine.** See the next section.

**Phase 5 — polish.** Usage recap by host model, reader/chat view for a
host-model Claude or OpenCode tab (`remote_transcript::under` reads the `-local`
home), OpenCode resume on the host, Mistral `vibe` (needs a config file written
on the host).

**Phase 6 — phone.** A machine's model group in `NewTabSheet`, with a new opaque
id (`MobileLaunch.local` is defined as "this machine").

Each phase ends with: file-map rows, `docs/context/host_models.md` (as-built),
one line in `docs/context/remote_projects.md`, the help topic for local models,
and a QA item in `todo/group-g-remote.md` with the four platform child pairs.

## Phase 4 in detail: the Models panel per machine

**Why it is cheaper than it looks.** Almost everything the panel does is plain
HTTP against one address: list and running state (`/api/tags`, `/api/ps`), load
and unload (`/api/generate`), delete (`/api/delete`), details and capabilities
(`/api/show`). `ollama_client` already has `_at(addr, …)` forms
(`ollama_http_at`, `capabilities_of_at`, `model_capabilities_at`). So the panel
needs no over-SSH twin of each command. It needs the machine's Ollama port on
this computer's loopback, and `services/port_forward.rs` already opens exactly
that: `-L` on the pooled master, local end `127.0.0.1`, never dials.

**Design.**

- `host_ollama::forward(project, host)` opens (or joins) a forward to the
  probed `addr`, owned by `models:<project>:<host>`, and returns the local
  address. It is opened when the user picks the machine in the panel (that
  click is the consent rule 1 of `docs/context/port_forwards.md` asks for) and
  closed when the panel leaves the machine, on disconnect and on quit.
- The HTTP commands in `commands/ollama.rs` gain an optional
  `machine: { projectId, hostId }`: `list_ollama_models_detailed`,
  `load_ollama_model`, `stop_ollama_model`, `delete_ollama_model`,
  `ollama_status`, `ollama_registry_details`, `ollama_check_updates` (the
  registry read stays on this computer; only the installed digest comes from
  the machine). Absent = today's behaviour. Each resolves the address in the
  backend; the renderer never sends an address or port.
- A machine switch at the top of the Models hub (`components/models/useModelsHub.ts`,
  `components/layout/LocalModelMenu.tsx`): "This computer" and each connected
  machine that passed the probe. The + menu's group (Phases 1–3) stays as it is.
- **Pull stays a host tab**, in the panel too. `pull_ollama_model` holds a
  stream from this computer, and a forward ends on every project deactivation
  (`teardown_pooled`) and when the laptop sleeps. A pull in a host tmux tab
  survives both. The panel's search (Ollama registry, Hugging Face) works
  unchanged; its Pull button opens that tab for a machine.

**What the panel does not get for a machine.** These read or change this
computer's files or processes, and stay "This computer" only: the models folder
(`ollama_models_dir_plan`), restart (`restart_ollama_server`), half-finished
downloads (`list_orphan_partial_blobs`, pending pulls), the version and upgrade
card (`ollama_version_status`), context and keep-alive plans (a machine's server
has its own environment; the one Tabtivity starts gets them at start, fixed
decision 7), GPU placement beyond what `/api/ps` reports.

**Limits to say out loud.**

- A Windows desktop has no ControlMaster, so no forward
  (`port_forward::SUPPORTED`): there the machine's panel is not offered and the
  + menu group still works.
- The forwarded port puts the machine's Ollama on this computer's loopback, as
  open as the local Ollama is. A model behind a forward is **not local**:
  `agent_privacy` must refuse an endpoint the forward registry owns, so
  `ollama_host` can never be pointed at one and pass as loopback.
- The forward ends when the project is deactivated; the panel then falls back to
  "This computer".

Size: one backend step (forward owner, the `machine` argument, the
`agent_privacy` check, tests) and one frontend step (the switch, hiding the rows
above, pills).

## Not in v1

- This computer's Ollama from a host tab (needs an `-R` forward and a
  token-checking relay; `port_forward` is `-L` only by rule).
- A machine's Ollama from an agent tab on this computer.
- The phone's Local models sheet for a machine.
- VM projects, containers, Cut network, Local models only on a remote project.
- Stopping, upgrading or reconfiguring a server Tabtivity did not start.

## Verification

- **Unit (Rust):** `parse_probe` over recorded outputs (own, system, foreign,
  no `curl`, no Ollama, cloud entries dropped); port choice; `start_script`,
  `install_line`, `pull_line` and the prelude carry no unquoted value; the probe
  script run under `sh` against a stub `ollama` (as `remote_agents`'
  `run_prelude` tests do, `cfg(unix)`); `launch_prep`: a host-model spawn gets
  no key, token, lane or model default and has `OLLAMA_HOST` overwritten, a
  spawn without a fresh probe is refused, `pinned_spawn_refusal` is unchanged
  for `local_agent`; restore keeps `hostModel` only for a line the table builds;
  the AI switch refuses it.
- **Unit (TS):** menu rows per state, `hostModelTabSpec`, pinned project shows
  the machine group and no local group.
- **Phase 4:** the forward's argv is `-L` to the probed address only; a command
  with `machine` never reads `ollama_host`; `agent_privacy` refuses a forwarded
  endpoint; the hub hides the this-computer-only rows for a machine. Live: pick
  a machine in the panel, load and unload a model, delete one, switch projects
  and see the panel return to "This computer".
- **Gates:** `scripts/gates-job.sh start`, then `npm run backend:stale`.
- **Live (the user, never an agent):** on a remote-only project with Ollama
  running on the host: open +, pick a model and OpenCode, ask it to list the
  folder; quit and reopen, the tab reattaches. On a machine with the binary
  only: Start, read the confirm, tab runs, session shows in Sessions, end it
  there. On a machine without Ollama: Install tab, then Pull, then a tab. On a
  shared machine with another user's Ollama on 11434: the group says so and the
  own server takes its own port.

## Organisation

Plan + implement + review routine, one step per phase (0 is the user's),
security finder/verifier review on phases 1 and 2. Choices and "Flagged for
user" go to `docs/host_models_handoff.md`.
