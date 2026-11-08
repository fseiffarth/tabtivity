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
