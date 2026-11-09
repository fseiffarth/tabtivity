# Local models only, phase 1 — handoff

Branch `feat/local-models-only` (based on `develop` efb20935). Plan:
`docs/local_models_only_plan.md`. Design, audit and limits as built:
`docs/context/local_models_only.md`. Phase 1 only; phase 2 (network cut, local
lane relay, `--unshare-net`), 3 (macOS) and 4 (containers, VMs) are not started.

## Commits

- `847c7b69` the setting, the spawn gate, the fence masks, containers, tests, plan doc
- `53eb5090` the non-agent paths (Copilot, file drop, root MCP git tools), the audit doc
- `6606519d` the dialog, pill lock, + menus, box lock, strings, register rows, help, file maps, todo
- the commit carrying this file also makes the new tests' tab ids unique (the registry of
  verified tabs is process-wide, and one test failed once under parallel runs)

## Per plan section

| Section | Status | Where |
| --- | --- | --- |
| Settings shape | done | `agent_privacy::{privacy_of, check_enable, set}`; `commands/agent_privacy.rs` `set_project_agent_privacy` (class `client`); `commandClasses.ts` regenerated. Refusals: remote/VM/container, no folder, another project/mirror or a box folder inside, non-loopback `ollama_host`; Cut network always refused. |
| 1a spawn gate | done | `agent_privacy::gate` in `launch_prep::prepare`, `fence_gate` in both fence wrappers (stamp), `agent_shim` refused through the wrapper, docker wrap refuses. Env scrub, no key injection, per-project vibe home + config written by the gate. Enabling ends unverified agent PTYs. |
| 1b keep the folder out | done (Linux, macOS profile written, not compiled here) | `mask_local_models_only` after `mask_private_state`; Seatbelt `hidden`; `compute_box_allowed_roots`, `compute_fence_roots`, `roots_for_scope`, `root_project_read_only_paths`; box editor lock. |
| 1c non-agent paths | done | Copilot, file drop (also Tabby), root MCP git tools closed; the rest audited in the context doc. |
| 1d UI | done | `AgentPrivacyDialog`, pill menu row + lock badge, + menus (`TabBar`, `NewTabMenu`, popout via `localModelsOnly`), box member lock, drop message, i18n in en/de/es/fr/it, `UntestedTag` + three register rows. |
| 1e limits | done | stated in the dialog, the help topic (`docs/help/local-models.md`) and the context doc. |

## Design choices that differ from the plan

- **The driver/model pair is read from the spawn's own argv**, not from a
  `prepare_local_agent` record: `local_drivers::identify_local_launch` tries each
  argument as the model of each driver against `local_launch_line_ok`, so the
  verified line is the line that runs and no renderer or record is trusted. Vibe
  (not in `LOCAL_DRIVERS`) is the one case that reads the model from env
  (`<APP>_LOCAL_MODEL`); the gate then writes its config itself.
- **Two checkpoints with a stamp.** The argv is rewritten between `prepare` and the
  fence wrapper (session resume, flags), so the wrapper cannot re-run
  `local_launch_line_ok`; it checks the stamp env (`STAMP_ENV`, a control variable
  `prepare` strips) instead. A spawn that reaches a wrapper without `prepare` (the
  shell-tab shim) has none and is refused.
- **Subject = runs in the project OR cwd inside its folder**, so the root console's
  Host session and a root-console agent with a cwd there are refused (D1) without a
  special case.
- **Tabby / attachments:** the assistant's fence has no roots, so the real path is a
  file drop; closed in `pty_drop_files` for any agent tab that is not a verified
  local tab of the project.
- **Root MCP:** only the two git tools read the folder; closed for cloud callers.
  `projects_list`, `todo_*` etc. return metadata the user typed, not file content.
- A `cut_network: true` found on disk (hand-edited) refuses every agent spawn in the
  project (fail closed) rather than being honoured as a guarantee.
- Inherited provider keys are removed with `--unsetenv` (Linux fence) and
  `env_remove` (PTY); macOS and Windows rely on the PTY removal only.

## Gotchas

- `agent_privacy::gate` blocks on the Ollama list (cached a minute), so `prepare`
  calls it through `app_core::rt::try_blocking`.
- The vibe home is `vibe_local/<alias>.<project key>` under `home_share_dir()`;
  `agent_session::is_local_vibe_home` accepts it (one component).
- `ProjectEntry` has no `PartialEq`; tests compare through `serde_json::Value`.
- `launch_prep::CONTROL_ENV` now lists `STAMP_ENV`; a new control variable there
  needs `is_control_env`'s legacy-prefix handling, which `app_env!` already covers.
- Building the test target after a cold `target/` takes ~5 minutes; run gates in
  the background.

## Gates

Run on the final tree (Linux only, as the local gates are):

| Gate | Result |
| --- | --- |
| `scripts/brand-check.sh`, `git diff --check`, `scripts/privacy-check.sh` (staged, each commit) | pass |
| `npm run lint` | 0 errors, 29 warnings (the same files as before; none in a file this work touched) |
| `npm run build` | pass |
| `cargo clippy -p tabtivity -p app-serverd --all-targets -- -D warnings` | pass |
| `cargo clippy -p tabtivity --no-default-features --lib -- -D warnings` | pass |
| `cargo clippy -p app-serverd --all-targets -- -D warnings` | pass |
| `cargo test --workspace` | pass: 5396 lib tests (21 new in `agent_privacy`), 143 + 39 + 1 in the other crates |
| `cargo test -p tabtivity --no-default-features --lib --test server_secrets` | pass: 5221 + 1 |
| `npm test` (full) | **3 failures, none from this branch**, 11323 of 11326 pass |

The three failing vitest tests fail identically at `efb20935` (no stylesheet or those
keys are touched here): `shell/i18n.test.ts` (en keys `agents.tools.*` and
`agents.defaultsCustomModel`/`agents.defaultsNoModels` from `e1c67df2` have no
de/es/fr/it text), `theme/CursorPacks.test.ts` (bare `cursor: pointer`/`text` at
`subwindows.css:4388` and `header-menus.css:1444`) and `theme/TypeScale.test.ts`
(`font-size: 11px` at `subwindows.css:4386`). `scripts/gates.sh` is fail-fast, so it
stops at vitest; the Rust gates above were run directly. The new
`LocalModelsOnly.test.tsx` (8 tests) passes.

## Flagged for user

- **The `develop` baseline has three red vitest tests** (above). They are another
  session's (`e1c67df2` and a stylesheet change); left alone, so `scripts/gates.sh`
  cannot go green on this branch until they are fixed.

- **Live verification is yours** (nothing was run live; the app was never started).
  Steps are in the plan's "Live verification" and the new `todo/group-o-security.md`
  box. After merging run `npm run backend:stale`: the backend half is not in a
  running window.
- **macOS Seatbelt** changes (`hidden` entries, no `--unsetenv`) are written but not
  compiled here (Linux only gates); CI's macOS leg is the check.
- **Phone ＋ sheet** still lists cloud rows in a locked project; the spawn is refused
  with the backend's text. Hiding them needs a catalog field in `mobile_control` and a
  mobile-web change (`npm run mobile:bundle`), not done.
- **A restored local tab needs Ollama up**: the gate refuses when the model list
  cannot be read, so a local tab reattached after a restart with Ollama down is
  refused (fail closed, as the plan says).
- **Surviving cloud tmux sessions:** enabling the switch ends live PTYs and their
  tmux sessions, but a session no PTY holds (window crashed, headless owner) is only
  refused at its next spawn, not killed.
- **To-do cards** of a locked project remain readable by the cloud root agent
  (`todo_list`, `projects_list` names and folder paths); only file-derived data
  (git tools) is closed. Say so if the cards should count.
- **Send to project** (file tree) can still copy a locked project's file into a
  project cloud agents read; it is a user's file copy, left alone.
- A project with a **Windows**-style fence-less platform gets the gate but no mask
  (documented in the dialog).
- Cut network (phase 2) is intentionally unreachable: the switch is disabled in the
  UI and `set` refuses it.

## Review findings — flagged for user

A review of `efb20935..5395708d` (2026-11-08) fixed three holes (commits
`fix(local-models): …` on `review/local-models-only`: the renderer-env allowlist, the
root MCP local-model check, the completion guards). What follows is what was found and
**not** changed: design objections and anything not confirmed.

- **Tabs started before the switch keep their fence.** Turning it on ends only the
  project's own unverified agent PTYs. A cloud agent of a parent project that contains
  the folder, of a box the project belongs to, or the root console's (read-only view
  switch on) was fenced at its spawn and still sees the folder until it is restarted.
  Fix idea: also end (or ask to end) every live agent PTY whose scope's roots include
  the folder, and say so in the dialog (`agentPrivacy.closeNote` counts only this
  project's tabs).
- **A spawn racing the switch survives.** `close_unverified_agents` sees registered
  PTYs only; a cloud spawn that passed `prepare` just before `set` landed registers
  after it. The next spawn is refused, this one is not. Needs a generation check in
  `register` or a second sweep after a short delay.
- **Project content can re-aim a verified local line.** What sits in the project folder
  is attacker-controlled (AGENTS.md), and the CLIs read it: OpenCode's `opencode.json`
  (a project `ollama` provider with another `baseURL`; the inline config wins only when
  `/api/ps` answered), Claude Code's `.claude/settings.json` `env` block
  (`ANTHROPIC_BASE_URL`), Codex's `.codex/config.toml`. The gate checks the model on the
  loopback Ollama, not where the CLI ends up sending it. Pinning each driver's endpoint
  by flag or managed config per CLI is a design decision (and phase 2's relay closes it
  for good).
- **Codex `--oss` does not read `OLLAMA_HOST`.** It dials `CODEX_OSS_BASE_URL` or
  `localhost:11434`; with `ollama_host` on another loopback port the model was verified
  on one listener and Codex talks to the default one (a different process, same
  machine). Pre-existing for every Codex local tab; setting `CODEX_OSS_BASE_URL` from
  the verified endpoint in `apply` would close it (not done: the variable name is from
  memory of the Codex source, not verified against the installed binary).
- **A root MCP caller's "local model" is a label.** `Caller::LocalModel` comes from
  `<APP>_LOCAL_MODEL` / `VIBE_ACTIVE_MODEL` in the spawn env (`agent_api_keys::
  is_local_model`), not from the vetted argv. After the fix a cloud root agent has to
  name an installed non-cloud model to read a locked project's git state; it still can.
  The CSP is what keeps the renderer honest here (same caveat as `is_host_bound_local_agent`).
- **Copilot's language server** is started with the editing project's folder as its
  workspace. For a parent project that contains a locked one, the server process could
  read the locked files itself (neighbour-file context); only the text the editor sends
  is guarded. Not verified whether the server reads the workspace.
- **Ollama completion carries a project id, not a path.** A locked file opened through a
  parent project is completed under the parent's id, so `complete_text` cannot tell; the
  frontend only offers loaded (running) models, which excludes Ollama cloud models in
  practice. Passing the document path to `complete_text` would let the backend decide.
- **`mask_dirs_now` fails open** on an unreadable registry (no mask, fence built). The
  roots lookup reads the same file a moment earlier and would have failed first, so this
  needs a torn read between the two; making the wrapper refuse is a one-liner.
- **Plan 1c "nothing from this project goes to a tab outside it" is not built** beyond
  file drops: Send to project (already flagged above), "send selection to agent tab" and
  markup prompts can still carry a locked project's text to a tab of another project.
- **`remote: null` on a record**: `check_enable` reads it as local, the gate
  (`contains_key`) as remote and refuses every spawn. Fails closed, but the project can be
  locked and never start an agent.
- **macOS**: provider variables the app itself inherits are removed from the PTY
  (`env_remove`), but a tmux server that already runs keeps them in its global
  environment and Seatbelt has no `--unsetenv`; a local agent there can read them. No
  cloud call by Tabtivity, but a prompt-injected `curl` could send them (the network is
  on in phase 1).
- **Vibe home name** `vibe_local/<alias>.<project key>` can equal another model's shared
  home if a model is named `<alias>.<project key>`; project keys are uuids, so not
  practical.

## Fix round 2

Branch `fix/local-models-holes` (from `develop` 4a77207f). Six holes from the review
findings above, each with a test that names it (all in
`services/agent/agent_privacy/tests.rs` unless noted). Commits: `a2177e8a` (the six fixes and their tests), then a
lint fix and this documentation (`git log 4a77207f..fix/local-models-holes`).

| # | Hole | Fix | Test |
| --- | --- | --- | --- |
| 1 | Project config re-aims a verified launch | A verified tab's fence covers the folder's CLI config that exists from its cwd up to its root: `--ro-bind /dev/null` over files, `--tmpfs` over folders (`agent_privacy::project_config_masks`, `agent_fence::mask_project_config`; macOS: Seatbelt `hidden`). A link to nowhere refuses the spawn. Per-CLI result: `docs/context/local_models_only.md`, "The folder's own CLI config" | `a_verified_tabs_fence_hides_the_projects_cli_config`, `a_dangling_config_link_refuses_the_spawn` |
| 2 | Root MCP "local model" was a label | `grant_root` makes a root agent a `LocalModel` caller only when `agent_privacy::local_vibe_launch` reads a loopback Ollama model out of the exact `vibe_local` home config it runs from; endpoint and model come from that config; a spawn that only claims it gets no root token. The mail local-read path reads the same session identity | `root_mcp/tests.rs` `a_local_tab_is_what_its_home_says_and_starts_with_the_models_taint` (label alone, user's home, label naming another model, env override, extra flags, cloud CLI with label, remote endpoint, edited config) |
| 3 | Already-open tabs keep the folder | Each fenced spawn records what its fence shows (`FenceView`: roots, allowlist, root-console grants, masked locked folders); turning the switch on ends every unverified agent PTY whose view shows the folder (`agent_privacy::ptys_to_end`, whole subtree and tmux session, same path as before); the store closes the matching tabs in every scope | `turning_the_switch_on_ends_every_live_tab_whose_fence_shows_the_folder`, `the_wrappers_record_their_view_and_the_switch_uses_it`; vitest `LocalModelsOnly.test.tsx` |
| 4 | `mask_dirs_now` failed open | Returns `Result`; the four fence builders propagate it | `an_unreadable_registry_builds_no_fence_instead_of_one_without_masks` |
| 5 | Content leaving by send paths | Markup Submit (desktop `pdf_markup_submit`, phone route) refuses a file inside a locked folder when the destination project is not that folder (`foreign_source`, `foreign_source_at`). Send to project (`import_external_file`) treated as the user's own file copy and left; free-text insertions (`pty_write`, schedules) have no source the backend can see: a documented limit | `a_locked_projects_file_is_not_marked_up_into_another_projects_prompt` |
| 6 | `remote: null` | One reading (`remote_or_vm`: non-null) in the setting and the gate, as `remote_target_for` | `a_null_remote_or_vm_is_local_for_the_setting_and_the_gate_alike` |

### Per-driver config findings (item 1)

Run against the installed CLIs, in a scratch folder with an isolated home:

- **Claude Code 2.1.319**: confirmed hole. A project `.claude/settings.json` with
  `env.ANTHROPIC_BASE_URL` beat the process environment; the `POST /v1/messages` went to the
  project's URL. `--setting-sources user` closes it, but `ollama launch claude --model m`
  takes no flags, so the mask is the closure. Empty and `{}` settings read as none.
- **OpenCode 2.2.6**: `opencode.json[c]` is loaded from the cwd and every folder above it,
  plus `.opencode/`; `.env` is not read. `OPENCODE_DISABLE_PROJECT_CONFIG` and
  `OPENCODE_CONFIG_PROJECT_DISABLE` exist in the binary but changed nothing in
  `opencode debug config`, so they are not relied on. An empty file loads as nothing.
- **Codex 0.167.0**: loads `.codex/config.toml` of a trusted project, but ignores provider
  keys there (`model_provider(s)`, `openai_base_url`, `chatgpt_base_url`, `profile(s)`);
  `model` and `oss_provider` apply, the launcher's `-c`/`-m` win. Masked anyway.
- **Pi, Droid, Cline, OpenClaw, Mistral Vibe**: not installed here. Masked by the folder
  names their docs give (`.pi`, `.factory`, `.cline`, `.openclaw[.json]`, `.vibe`); not
  verified, and a different name would not be covered.

Could not test the mask itself under bubblewrap (this session's fence forbids a nested
namespace); the argv shape is a unit test, and the bwrap behaviour (bind over an existing
file or folder) is the same as the other masks. Existing paths only are masked, because a
bind over a missing path makes bubblewrap create a placeholder in the project.

### Gates (Linux, this tree)

| Gate | Result |
| --- | --- |
| `npm run build` | pass |
| `npm test` | 11324 of 11327 pass; the same 3 known failures (`shell/i18n`, `theme/CursorPacks`, `theme/TypeScale`) |
| `npm run lint` | 0 errors, 29 warnings (unchanged) |
| `cargo test --workspace` | pass: 5408 lib tests (12 new), 143 + 39 + 1 in the other crates |
| `cargo test -p tabtivity --no-default-features --lib --test server_secrets` | pass: 5233 + 1 |
| clippy (workspace all-targets, no-default-features lib, `app-serverd`) | pass at zero warnings (the workspace run is the one repeated after a `from_ref` lint fix in the new tests) |
| `scripts/brand-check.sh`, `git diff --check`, `scripts/privacy-check.sh` (each commit's hook) | pass |

### Verification notes

- The fence of an agent tab replaces `projects.json` with an empty file, so a unit test that
  reads the live registry fails inside Tabtivity (not in CI): the markup guard is kept out
  of the shared `markup` core for that reason, and the phone route reads the registry of its
  own state dir.

### Flagged (updated)

Fixed and removed from the list: findings 1, 5 (root MCP label), 8, 9 (markup part), 10.

Still flagged:
- **Switch race** (a spawn racing `set`), Codex `--oss` / `OLLAMA_HOST`, Copilot language
  server workspace, `complete_text` path vs project id, macOS tmux keys, Vibe home name
  collision: unchanged, out of scope here.
- **Config created mid-session** by the agent itself is masked only from the next spawn; a CLI
  that hot-reloads settings could apply it in the running session (Claude Code watches
  settings; whether it re-reads `env` live was not tested). Same class as a prompt-injected
  `curl` until phase 2.
- **Unverified driver config names** (Pi, Droid, Cline, OpenClaw, Vibe above).
- **`.mcp.json`** and other project MCP servers are not masked (tools, not a model location).
- **Send to project** and free-text sends (`pty_write`, schedules, the prompt library) can
  still carry a locked project's content to a cloud tab: the user's own act, no backend source.
- **Unfenced agents** (the Host session, Windows) are not ended when the switch goes on
  (no recorded view; D1).
- **Root MCP home read at spawn**: the vibe home is checked when the tab starts; the fenced tab
  can rewrite its own home afterwards.
- macOS `hidden` entries for the config masks and the fence view are written, not compiled here.

## Review 2 findings — flagged for user

Review of `4a77207f..c5506b55` on `review2/local-models-only`. Fixed (with a regression test
each): the cwd chain of the config masks (`the_config_chain_follows_the_directory_the_process_is_in`)
and running container agents (`a_running_container_agent_is_ended_when_a_folder_inside_its_mount_is_locked`).
The rest is flagged, not changed.

- **Claude Code re-reads project settings during a session (measured).** Claude Code 2.1.319, an
  interactive session on a loopback listener A with `ANTHROPIC_BASE_URL=A`, no project settings. After
  the first reply the test wrote `.claude/settings.json` with `{"env":{"ANTHROPIC_BASE_URL":B}}` into the
  cwd; the next prompt's `POST /v1/messages` went to B. So "masks only what exists at spawn" does not hold
  against anything that writes the file later: the agent itself (a prompt-injected local model) or a
  command it runs. The same should hold for the agent home's own `~/.claude/settings.json`, which by
  the fence code is bound writable (only the vibe home's control paths are read-only pins; not run). Claude reads project settings
  from the cwd only, not from parent folders (measured: settings in the parent were not applied).
  Closures, each a design call: (a) bind a read-only empty mount over the absent `<cwd>/.claude` (bubblewrap
  then creates an empty `.claude` folder in the project, which the implementer avoided); (b) a managed
  settings file bound into the fence at `/etc/claude-code/managed-settings.json` (managed outranks
  project and user settings); (c) accept it as the same class as a prompt-injected `curl` until phase 2.
  OpenCode and the others: not tested whether they watch their config.
- **Agents that survive without a registry PTY are not ended by the switch.** `close_unverified_agents`
  walks `PtyRegistry::ai_ids`. (1) A tab the phone started headless (`HeadlessSpawner`: `prepare` +
  `spawn_detached_with`, then `commit`) has a live spawn record and a fence view but no PTY until a window
  attaches; a cloud agent started that way before the switch keeps running. (2) After a crash or restart the
  local tmux session of an agent outlives the app; a respawn of the tab attaches to it
  (`new-session -A`) while the fence argv built for that respawn (and the view recorded from it) describes
  a *new* fence, not the old process. `live_unfenced_by_scope` has the same caveat in its own doc. Closing
  this needs the tmux session names of agent tabs (workspace records) at switch time.
- **macOS / unfenced agents** (Host session, Windows) unchanged from round 2: no view, not ended.
- **Handoff round 2 says the vibe home "can be rewritten by the fenced tab afterwards"** (root MCP flag).
  `local_model_mounts` pins `config.toml`, `hooks.toml`, `.env`, tools etc. read-only for the tab's own
  home, so the config `local_vibe_launch` read stays what the process runs. The residual is only the
  window between that read and the fence being built.
- **Store closes every own-scope agent tab** in the UI when the switch goes on (`projects.ts`), including a
  verified local tab that the backend keeps alive (by reading: turn the switch off, then on again with a
  verified tab open; not run): the tab would disappear, its PTY keep running. Backend `closed_tabs` is the better source.
- **Config names:** `.mcp.json` and project MCP servers (code that runs in the fence with network), Pi,
  Droid, Cline, OpenClaw, Vibe folder names stay unverified; unchanged from round 2.

## Fix round 3

Branch `fix3/local-models` (from `develop` 0229355d). The three items the user chose after
review 2. Commits: `f4c8979b` (store), `17f447d3` (Claude pin, OpenCode inline config),
`d81706b3` (switch sweep), `a1f0aa4c` (TS type), a final tweak (`--agent-` match, two test-only lints; the `a--b` project-id case in `an_unknown_view_…` was reasoned to fail on the old `split_once` match, not run), then this documentation
(`git log 0229355d..fix3/local-models`).

| # | Hole | Fix | Test (saw fail by) |
| --- | --- | --- | --- |
| 1 | Claude Code re-reads project and user settings mid-session, so a file the agent writes re-aims the next request | A managed-settings file written by the backend (`local_drivers::claude_managed_settings`, built from the gate's record of driver, model and endpoint) under `<state>/claude_managed/<digest>/…`, written through `home_io`, pinned by inode and checked last (`write_managed_claude`, `verify_control_pins`), bound read-only at `/etc/claude-code/managed-settings.json` (`managed_claude_args`: tmpfs over an existing folder, else a read-only overlay of `/etc`). Pins `env` (base URL, the model variables, proxy and `CLAUDE_CODE_USE_*` variables emptied, `NO_PROXY`), `model`, `availableModels`, `allowedProviders: ["customEndpoint"]`. macOS and Windows refuse a verified Claude tab (`Probe::pins_claude`, repeated in the Seatbelt wrapper). A verified OpenCode tab also gets an inline `OPENCODE_CONFIG_CONTENT` from the verified endpoint and model | `the_managed_claude_settings_pin_…`, `the_gate_remembers_a_claude_tabs_endpoint_and_model_for_the_fence`, `claude_is_refused_where_the_sandbox_cannot_pin_its_settings`, `a_verified_opencode_tab_runs_on_an_inline_config_…`, the two argv tests, `the_pinned_settings_file_is_written_once_per_content_and_pinned_by_inode`, `both_wrappers_pin_or_refuse_a_verified_claude_tab`. Mutated, three failed: the gate's OpenCode inline config disabled, the Claude refusal disabled, the wrappers' call replaced by `None`. The new functions did not exist before, so the rest failed to compile |
| 2 | The switch missed agents with no registry PTY (phone-started headless tabs; tmux sessions that outlived a crash) | The live spawn records its tmux session at `commit` (the headless owner already commits, so its fence view was recorded; now checked by a test). `tmux_sessions_to_end` (pure) over the app's `tmux ls`: a known unverified session ends when it is the project's own or its recorded view shows the folder; an unknown view ends when it is the project's own, its pane folder is in, at or above the locked folder, or empty (fail closed). `end_detached_agents` reaps the pane's whole subtree, then kills the session; `closed_sessions` in the answer | `the_switch_ends_a_phone_started_headless_agent_and_a_session_that_outlived_a_crash`, `an_unknown_view_that_overlaps_the_folder_is_ended_and_one_that_does_not_is_left`, `the_headless_spawn_records_its_view_and_session_and_the_switch_sweeps_them`. Mutated (the sweep's filter forced empty, the command's call removed): all three failed |
| 3 | The store closed every own-scope agent tab, including a verified local one the backend kept | The store closes exactly the tabs in `closed_tabs`, in every scope | vitest `keeps a verified local agent tab the backend did not end` (failed with the old condition restored: `expected ['p1:cloud','p1:verified'] to deeply equal ['p1:cloud']`) |

### Live measurements (item 1)

Done in the session scratchpad with the installed binaries as plain processes: an isolated
`HOME`, two loopback listeners (A the verified "Ollama", B the "attacker"), `claude --model m`
in a pty, a first prompt, then `.claude/settings.json`, `.claude/settings.local.json` and
`~/.claude/settings.json` written with the hostile values, then two more prompts; requests per
listener counted.

- **Control (no managed file)**: the settings written mid-session moved every later request
  to B. Reproduces review 2.
- **Where Claude reads policy**: `strace` of 2.1.319 shows it reading
  `/etc/claude-code/managed-settings.json` and the drop-in folder `/etc/claude-code/managed-settings.d`
  and nothing else on Linux. The env override of that path is compiled out of the release build, and this
  session can neither write `/etc` nor create a namespace (`bwrap --ro-bind / / true` and `unshare -Ur`
  fail), so the real bind mount was **not** tested. To test precedence with the real binary a small
  ptrace tracer rewrote `/etc/claude-code` to a scratch folder in the path arguments of
  `openat/statx/access/readlink/…` (a `LD_PRELOAD` shim did nothing: the binary makes its own
  syscalls). The file was owned by the user, mode `0444` in a `0555` folder, and also `0644` in a
  writable one; both behaved the same.
- **With the managed file**: all hostile settings written mid-session changed nothing: base URL
  to B (A kept every request, B none), `ANTHROPIC_MODEL`/`model` to another name (requests kept
  the managed model, also with a colon in it: `nemotron-3.5-bolt:e4b`), `HTTP_PROXY`/`HTTPS_PROXY`/
  `http_proxy`/`ALL_PROXY`/`CLAUDE_CODE_*PROXY`/`GLOBAL_AGENT_HTTP_PROXY` to B (without the proxy pins the
  whole request went through B; with them B saw nothing), and `CLAUDE_CODE_USE_BEDROCK` +
  `ANTHROPIC_BEDROCK_BASE_URL` to B (without `allowedProviders` and the emptied `USE_*` it went to B; with
  either one, no request left, the session refused).
- What was **not** verified live: the actual bind mount or overlay inside bubblewrap; the
  managed file's behaviour when a real read-only mount reports `EROFS` for a write (the test file
  was only made unwritable by mode); the drop-in folder being absent in the fence; Claude Code
  versions other than 2.1.319.

### Reload per CLI

- **Claude Code 2.1.319**: reloads (above). Pinned.
- **OpenCode 2.2.6** (`opencode mini --standalone --model ollama/m`; the `opencode --model` form
  of the fallback line is refused by this version's top-level command: `Unrecognized flag: --model`,
  not changed here, check what the app runs): reloads project config. With the provider in a project
  file, an edit mid-session moved the next requests to B (4 of 4). With the provider in the inline
  `OPENCODE_CONFIG_CONTENT` (how the app launches it), the same edits left every request on A (4 of 4).
  A project config that adds a provider or sets `enabled_providers`/`model` does take effect in
  `opencode models` over the inline one. The gate now sets the inline config. Not run: the
  background-service mode (`opencode` without `--standalone`; a service process of 19 hours old
  that is not mine was left alone).
- **Codex 0.167.0** (`--oss -c oss_provider="ollama" -m m`, `CODEX_OSS_BASE_URL` at A): does
  not reload. `.codex/config.toml` written mid-session with `model`, `model_provider`,
  `openai_base_url` and a provider table changed nothing; later requests kept `model=m` on A.
  Residual: the requests after the write were retries of a failing turn plus two prompts,
  all with the launch model.

### Gates (Linux, this tree)

| Gate | Result |
| --- | --- |
| `npm run build` | pass |
| `npm test` | 11325 of 11328 pass (11327 + 1 new); the same 3 known failures (`shell/i18n`, `theme/CursorPacks`, `theme/TypeScale`) |
| `npm run lint` | 0 errors, 29 warnings (unchanged) |
| `cargo test --workspace` | pass: 5420 lib tests (12 more than before), 143 + 39 + 1 + 136 + 101 in the other targets |
| `cargo test -p tabtivity --no-default-features --lib --test server_secrets` | pass |
| clippy: workspace all-targets, no-default-features lib, `app-serverd` | pass at zero warnings (the workspace run was repeated after two test-only lints, `cloned_ref_to_slice_refs` and `needless_borrow`) |
| `scripts/brand-check.sh`, `scripts/privacy-check.sh`, `git diff --check` | pass |

### Flagged (updated)

Fixed and removed from the list: the Claude Code mid-session re-aim (Linux), agents with no registry
PTY, the store closing a kept verified tab.

Still flagged:
- **The bubblewrap mounts for the Claude pin were not run.** `/etc/claude-code` is added with a tmpfs
  (folder exists) or a read-only overlay of `/etc` (none): both are argv unit tests only. The overlay
  needs bubblewrap 0.8+ and overlayfs in an unprivileged user namespace; a failure refuses the spawn
  (closed) but would make a verified Claude tab unusable on that machine. First thing to try live:
  open a local Claude tab in a locked project and see that it starts (bubblewrap's error is the
  spawn error otherwise), then have it write a `.claude/settings.json` with another `ANTHROPIC_BASE_URL`
  and check the next prompt still reaches Ollama. A host whose `/etc` holds submounts
  (a container's `resolv.conf`) is the likely casualty of the overlay.
- **An administrator's own `/etc/claude-code` policy is hidden** inside a verified Claude tab's
  fence (the tmpfs case), by design: the pinned file must be the only policy.
- **OpenCode**: the inline config pins the provider endpoint, but a project config written
  mid-session that adds a provider or sets `model` / `enabled_providers` is not pinned and takes a user
  action (a new session or a model switch) to use. `opencode mini` vs `opencode --model` on 2.2.6
  and the background-service mode were not checked against what the app runs.
- **Codex**: no reload measured, so nothing done; `--oss` / `OLLAMA_HOST` stays out of scope.
- **A verified local tab that survived a crash** is ended by the next switch-on (no recorded view,
  overlaps): intended, fail closed.
- **Unfenced agents** (the Host session, Windows), the sweep's `pane_current_path` for an agent that
  `cd`s elsewhere (the project key rule still catches the project's own sessions) and an
  unknown-view session of another scope whose pane folder is unrelated to the locked one (left running).
- Unchanged from earlier rounds: the switch race, Codex `--oss`/`OLLAMA_HOST`, Copilot language-server
  workspace, `complete_text` path vs id, macOS tmux keys, `.mcp.json`, unverified Pi/Droid/Cline/
  OpenClaw/Vibe config names, free-text sends, macOS `hidden` entries not compiled here (the new
  Seatbelt refusal is not compiled here either).

## Review 3 findings — flagged for user

Review of `0229355d..6624eae9` (fix round 3), branch `review3/local-models`.

Fixed (one commit): `claude_managed_for` took the pin from the per-tab-id gate record alone, so a
second verified spawn of the same tab id under another driver (a respawn racing the first, or a
renderer that sends two spawns) replaced the record and the first, Claude, launch was fenced with no
pin at all. It now also judges its own argv: a Claude launch whose record is not Claude's refuses.
Test `a_claude_launch_is_not_left_unpinned_when_a_second_spawn_of_its_tab_id_replaced_the_record`
(failed before: `Ok(None)`).

Checked and found sound (by reading; not run, because nested namespaces are forbidden here):
- The Claude pin argv. `--ro-bind / /` is the first mount and the pin follows it directly, before
  `--dev`, home and every allowlist bind, so the bind sources under the state dir are resolved
  before the home tmpfs and the final masks (`mask_private_state` shadows the state tree afterwards;
  the bound inode survives that). `--tmpfs` + `--ro-bind` + `--remount-ro` is valid for bubblewrap 0.11.1
  (installed here); `--overlay-src A --overlay-src B --ro-overlay DEST` is valid (man page: first source
  at the bottom, `--ro-overlay` needs two, no source may be an ancestor of another; the state dir is
  not under `/etc`). Apparmor's `bwrap` profile on this host allows `mount`. A failure of either form
  is a bubblewrap error, so the tab does not start (closed).
- Nothing the renderer or the project writes reaches the pinned values: model and endpoint come from the
  gate's record; the file and its digest folder sit in the state tree, which every fence shadows.
  `CLAUDE_CODE_USE_*` in the 2.1.319 binary: BEDROCK, VERTEX, FOUNDRY, MANTLE, ANTHROPIC_AWS,
  ANTHROPIC_GOOGLE_CLOUD, GATEWAY are all in the emptied list (the others, `_CCR_V*`, `_COWORK_PLUGINS`,
  `_NATIVE_FILE_SEARCH`, `_POWERSHELL_TOOL`, are not providers). The `*_BASE_URL` variables of those
  providers only act with their switch.
- `opencode_session.rs:262` inserts `mini` in `launch_prep` (line ~1130), after the gate (line ~951), so the
  gate judges `opencode --model ollama/<m>`, the form the app builds; nothing is refused or accepted
  because of the rewrite. `apply`'s inline config is not unset by `unset_names` (no `OPENCODE_*` in
  `PROVIDER_ENV`) and `launch_prep` does not overwrite an inline config that is already set.
- Sweep (item 2): session names are `<prefix><key>--agent-<uuid>`; a project key cannot contain `--agent-`
  unless the id does. Shell sessions are never ended. `parse_tmux_pane_pids` keeps the first pane; the
  rest of the session goes with `kill-session`. A session that starts after the listing is gated by the
  stored setting (the switch race stays as flagged earlier).

Flagged, not changed:
1. **OpenCode cannot be pinned against a project `opencode.json` by the inline config.** Measured on
   2.2.6 with `opencode models --standalone`: a project file with a provider `evil` plus
   `enabled_providers: ["evil"]` still lists `evil/x` when the inline config sets
   `enabled_providers: ["ollama"]` (arrays are unioned, not replaced), and a project provider with no
   `enabled_providers` is listed as before. `model`, `small_model` and a per-agent `model` in a file the agent
   writes mid-session therefore stay unpinned (OpenCode reloads project config). Only the `ollama`
   provider's endpoint is pinned. With network open the agent can reach any endpoint by `curl` anyway; the
   gap is in "no cloud model reads the folder through OpenCode", not in the Phase 2 cut. A fix would
   mean creating the files in the project to mask them, which the app must not do.
2. **The overlay needs bubblewrap 0.8 and overlayfs in a user namespace (kernel 5.11+).** On a host with no
   `/etc/claude-code` (every default install) the overlay is the path taken, so a host with bubblewrap
   0.6 (Ubuntu 22.04) fails to start a verified Claude tab, with bubblewrap's "unknown option" as the
   error, not a message. There is no version check. Overlayfs does not follow bind mounts under the lower
   `/etc` (a container's `resolv.conf`): they show as the underlying file. On this host `/etc` has no
   submounts. An alternative that needs neither is a tmpfs over `/etc` with each entry re-bound and
   links re-made, which is a larger change.
3. **`forget()` can drop a record between the gate and `begin_spawn`.** The gate stores the verified record
   (`launch_prep` ~951) and the spawn generation begins later (~1048). A kill of the same tab id that
   lands in between runs `on_tab_gone` -> `forget(tab)` for the old generation and erases the new record;
   since round 3 that makes the Claude pin refuse the launch ("not verified for this tab, open it
   again"). Closed, but a restart of a Claude tab in a locked project can fail once. A fix is to begin the
   generation before the gate, which moves a lot of `prepare`.
4. **Settings that run code or send data other than the model request are outside the pin.** Claude Code
   2.1.319 still honours `apiKeyHelper`, `awsAuthRefresh`, `otelHeadersHelper`, `statusLine`, `hooks` and MCP
   servers from the user's and the project's settings, and `WebFetch`/`WebSearch`; none carries the model
   request (the base URL, proxies, providers and every model name are pinned), and they run inside the
   fence. Phase 1 does not cover them.
5. **Sessions without the `--agent-` token are not swept.** A tmux session minted before the kind token
   existed reads as "other" (`sessionKindFromName`). It is left running even if it is an agent.
6. **Sweep over-reach by key collision.** `project_key` maps every character outside `[A-Za-z0-9_-]` to `_`,
   so locking project `a.b` also matches the sessions of an unlocked `a_b`. Project ids are uuids in
   practice.
7. **`kill-session -t <name>` is not an exact match** (`local_tmux_kill_args`, shared with the quit path): if
   a session ended between the listing and the kill, tmux prefix-matches a sibling. Names end in a
   uuid, so a prefix of another is not possible for the names Tabtivity mints.

## Fix round 4

Branch `fix4/local-models` (from `develop` 854e436f). The two items the user chose after review 3
(flagged items 1 and 2). Commits: `62ba71ff` (OpenCode refused, ＋ menus, docs), `07e9abac` (bubblewrap version message), then this section (`git log 854e436f..fix4/local-models`).

| # | Hole | Fix | Test (saw fail by) |
| --- | --- | --- | --- |
| 1 | OpenCode cannot be pinned: config arrays merge as a union, so an `opencode.json` the agent writes mid-session adds a provider and model that OpenCode reloads (review 3) | OpenCode is refused in a locked project until Phase 2. `vet` turns a launch line that identifies as the `opencode` driver (`REFUSED_DRIVERS`) away before it asks Ollama, with "OpenCode cannot be kept on the local model in a Local models only project yet" and the agents that can run, derived from `LOCAL_DRIVERS` (`agents_that_can_run_locked`: no OpenCode, Claude Code only where it can be pinned, plus Mistral (vibe)). Every route passes `vet` or the fence's stamp check (window, phone, restore, schedule, box or root tab with a cwd inside, shell-tab shim), so nothing else was needed. The ＋ menus (`TabBar`, popout `NewTabMenu`) drop the OpenCode row through `localModelMenuGroup`'s `lockedProject` (`driversForLockedProject`). The OpenCode inline config `apply` wrote was dead and is removed (`17f447d3` has it); `local_drivers::opencode_ollama_config` stays, `launch_prep` uses it. Docs: context doc, help topic, file map, the todo's manual-test line (a Pi tab, not OpenCode) | `opencode_is_refused_in_a_locked_project_whichever_way_it_gets_to_the_gate` (own project, root console and another project with a cwd inside, Ollama down, no Claude where it cannot be pinned, the shim) and `the_agents_a_locked_project_can_run_are_derived_from_the_driver_registry`; vitest `hides OpenCode, which the backend refuses…`. The first failed on the old gate (`unwrap_err()` on an `Ok`: the line passed and carried the inline config); the vitest with the filter forced off (`expected [...] to deeply equal ['pi','vibe','claude']`, OpenCode present). The tests that used OpenCode as the "genuine local line" fixture now use Pi/Codex |
| 2 | Bubblewrap older than 0.8 fails a verified Claude spawn with bubblewrap's bare "unknown option" (the overlay form on a host with no `/etc/claude-code`) | `agent_fence::parse_bwrap_version` (pure) and `overlay_bwrap_check(host, version)` (pure): only the overlay form is checked; below 0.8 or unreadable refuses with "pinning Claude Code to the local model needs bubblewrap 0.8 or newer on this machine, and the installed bubblewrap is X.Y.Z" (or "could not be read"). `bwrap_version` runs `<bwrap> --version` for the binary the wrapper will run (the root-owned system copy) and caches the answer per binary file (mtime and size), so an upgrade is seen without a restart; a failed probe is not cached. The wrapper checks before it writes the pinned file or builds the mounts | `an_old_or_unreadable_bubblewrap_is_refused_by_name_where_the_pin_needs_the_overlay` (`bubblewrap 0.6.1`, `0.11.1`, `0.8`, `0.9.0-rc1`, garbage; old, boundary, unknown; the tmpfs form unchecked; a source scan that the wrapper checks before `insert_managed_claude`). Saw it fail with the two functions as stubs (parse returning `None`, check returning `Ok`): `left: None, right: Some((0, 6, 1))` |

### Gates (Linux, this tree)

| Gate | Result |
| --- | --- |
| `npm run build` | pass |
| `npm test` | 11329 tests, 3 known failures (`shell/i18n`, `theme/CursorPacks`, `theme/TypeScale`); one run also failed `MobileTerminalTranscript` ("keeps the chat while a /clear sent mid-turn waits…") under load while cargo ran alongside, 33 of 33 pass alone and in the run that followed; one existing `+ menu` test needed its mock to answer `list_local_drivers` with an array (it answered `null`, which the old code never iterated) |
| `npm run lint` | 0 errors, 29 warnings (unchanged) |
| `cargo test --workspace` | pass: 5423 lib tests (3 new, 1 replaced), 143 + 39 + 1 + 136 + 101 in the other targets |
| `cargo test -p tabtivity --no-default-features --lib --test server_secrets` | pass |
| clippy: workspace all-targets, no-default-features lib, `app-serverd` | pass at zero warnings |
| `scripts/brand-check.sh`, `scripts/privacy-check.sh 854e436f..HEAD`, `git diff --check` | pass |

### Flagged (updated)

Fixed and removed from the list: review 3 items 1 (OpenCode, by refusing it) and 2 (the bubblewrap version
message). Still flagged:
- **OpenCode is unavailable in a locked project** until Phase 2 (`--unshare-net`), by decision. The phone's ＋
  sheet still lists its local row (it lists the cloud rows of a locked project too); the spawn is refused with the
  new text. Every OpenCode-specific path in the fence (its config masks) is now unreachable for a verified tab and kept.
- **The overlay still needs overlayfs in a user namespace (kernel 5.11+)** and does not follow bind mounts under the
  lower `/etc` (a container's `resolv.conf`); only the version is checked. The bubblewrap mounts were not run.
- A bubblewrap with the right version number whose build lacks overlay support still fails with bubblewrap's own error.
- Review 3 items 3 to 7 and the earlier rounds' list are unchanged (the `forget()` window, settings that run code,
  sessions without `--agent-`, key collision, `kill-session` prefix match).

## Review 4 findings — flagged for user

Review of `854e436f..577ff673` (fix round 4). No bug confirmed, so no code changed; `cargo test -p tabtivity --lib
agent_privacy` passes (47). The OpenCode refusal holds on every route read: the gate runs before anything is built
(`launch_prep::prepare`), `identify_local_launch` compares `cmd` and args exactly, so a full path, `.exe`, `opencode2`,
resume args, `ollama launch opencode` or the `mini` form never identify as a verified line and are refused (generic text
for those, the OpenCode text for the exact line); nothing after the gate rewrites `cmd`; the shell-tab shim has no
stamp and is refused at the fence; the Tabby chat runs with its cwd in its own chat folder, locked folders masked, and
the inline `OPENCODE_CONFIG_CONTENT` of an unlocked project still comes from `launch_prep`. Flagged, not changed:

1. **The phone's ＋ sheet still lists the OpenCode row** in a locked project (known, round 4 flag). `localChoices` in
   `MobileBridgeHost.tsx` knows the scope and could apply `driversForLockedProject`; the row is also the first one the
   sheet offers (light harness), so the likeliest phone tap in a locked project ends in the refusal.
2. **A typed `opencode` in a shell tab is refused with the fence's generic text** ("was not started as a local-model tab.
   Open a local model from the ＋ menu"), not the one naming the agents that can run. The manual-test line in
   `todo/group-o-security.md` and the context doc say it names them. The ＋ menu it points to has no OpenCode row.
3. **`bwrap --version` runs `.output()` inside the async `prepare`** (the wrapper is called from it directly), and also
   when the host has `/etc/claude-code` (the tmpfs form, where the result is not used). Once per binary file, a few ms,
   the same pattern as `bwrap_available`; the cache key is mtime and size, not the inode, so a same-size, same-mtime
   replacement would keep a stale answer (not realistic for a package upgrade).
4. **The allowed-agents list is advisory**: it names Claude Code on every Linux, although the overlay form can still
   refuse it for an old bubblewrap, and it names agents that are not installed.
5. **Two lists to keep equal**: `REFUSED_DRIVERS` (Rust) and `LOCKED_REFUSED_DRIVERS` (TS) have no test tying them.
6. **A locked agent can start OpenCode itself**: inside a verified Pi or Codex fence the shim steps aside and runs the real
   `opencode` (or `opencode2`), with that fence's home and no network cut. Same class as a `curl` from the agent (Phase 2).
   A spawn with `cmd` `opencode2`, `npx` or `bunx` and `agent: false` is not an agent to `is_agent`; only a renderer
   that lies about `cmd` can send it (the CSP's case); typed into a shell tab it is the user's own shell, or the shim.
7. The one `＋ menu` test mock that answered `null` now answers `[]` for `list_local_drivers`: the backend always answers
   an array, and a locked project's menu filters it. No regression hidden.
