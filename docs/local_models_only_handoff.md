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
