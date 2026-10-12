# Threat recheck 2026-10-08 fixes — handoff

Plan: [`docs/threat_recheck_2026_10_08_plan.md`](threat_recheck_2026_10_08_plan.md)
("Run 2026-10-08" section). Branch `threat/1008`, worktree
`.claude/worktrees/threat1008`. Each implementer and reviewer appends a short
section: commits (shas), files, tests added, gates with results and test
counts, choices made, gotchas, and "Flagged for user".

## Agent step 1 — implementer (gap 16, A1 per-scope)

**Commit:** `6b0e0649` Stop sharing dotenv and config files as agent logins.

**Files:** `src-tauri/src/commands/agents.rs` (Cline, Vibe, aider,
mini-swe-agent `auth_paths: &[]`; `auth_paths` doc comment; CodeBuddy/Kimi
rows name their `DirNames`), `src-tauri/src/services/agent_auth.rs`
(`AuthKind::Dir(DirNames)`, `DirNames::{Json, CodeBuddyInfo}::admits`,
allowlist in `reconcile_dir`, `status_in` signed-in and importable,
`remove_copies`, import's one-level `copy_dir_logins` replacing the recursive
`copy_dir`; `RETIRED` + `retire_shared_paths_in`/`retire_dir_names`; module
docs), `src-tauri/src/lib.rs` (`retire_shared_paths()` before
`import_once`), `services/agent_home.rs` (stale "hard-linked" prose),
`commands/ollama.rs` (comment), English + de/es/fr/it
`settings.agentLoginsHelp`, `docs/help/agent-clis.md` (Sign in + API-key
paragraph), `docs/context/agent_authority.md` (item 4 + "One login per
CLI"), `docs/filemap_backend.md` (`agent_auth.rs` row),
`docs/third_party_update_checklist.md`, `docs/threat_model.md` row 16
(**Fixed, not live-verified.** with the residual).

**Tests added** (`agent_auth.rs`): `no_registry_row_shares_an_env_or_config_file`,
`retiring_a_shared_path_keeps_scope_copies_and_clears_the_hosts` (store dir
gone; fenced and `.local` copies kept; Host copy equal to the store removed,
Host copy equal to its `.placed` record removed, divergent Host copy kept; a
later scope write no longer spreads; second run a no-op),
`retiring_drops_unlisted_names_from_login_folders`,
`a_login_directory_shares_only_allowlisted_names` (Kimi temp + `x.env`,
CodeBuddy backup + `.logged-out` neither adopted nor placed, nor counted as
signed in), `dir_names_admit_only_the_login_file_shapes`,
`import_copies_only_allowlisted_names_of_a_login_folder`. Updated:
`a_local_model_home_receives_logins_but_never_feeds_them_back` now uses
`.codex/auth.json`; `a_login_directory_is_reconciled_file_by_file` uses
`kimi-code.json`.

**Gates (at `6b0e0649`):** `npm run build` ok; `npm test` 735 files / 7555
tests passed; `cargo test` 3733 passed, 3 ignored, 0 failed (lib 3565 +
integration); `npm run lint` 0 errors, 28 advisory warnings (none in touched
files; no TS logic changed); `cargo clippy --all-targets -D warnings` clean;
`scripts/brand-check.sh` ok; `git diff --check` clean;
`scripts/privacy-check.sh` clean. `npm run backend:stale` not run (main
agent at landing).

**Choices:**
- The allowlist is an enum (`DirNames`) on `AuthKind::Dir`, not a fn pointer,
  so `AuthPath` keeps its derives without fn-pointer comparisons.
- `retire_shared_paths_in` keys on the retired CLI's store dir existing (no
  marker). If removing the Host copy fails, the store dir is kept so the
  next start can still tell Tabtivity's copy from the Host session's own.
- The Host-copy check compares the raw file digest with the store file's
  digest and with `.placed/host/<leaf>`.
- Folder cleanup removes a home's unlisted name only where its digest equals
  that home's placed record, then deletes the unlisted store files and their
  `.placed/*/<leaf>_<name>` records in every record dir.
- `status_in.importable` for a login folder now means "holds an admitted
  file", so an import of a folder with only strays reports the existing
  "no login file" error instead of copying nothing.
- No `UntestedTag`: no new UI; Settings drops the four CLIs from the
  shared-login list by `LoginStatus.shared` alone.
- Test fixtures use neutral `VIBE_FIXTURE`/`AIDER_FIXTURE` names, not API-key variable names, which
  the privacy check flags.

**Gotchas:** the first cargo build in this worktree took over 10 minutes; a
foreground `timeout 590` run printed nothing. Run cargo in the background.

**Flagged for user:**
- Vibe, Aider, mini-swe-agent and Cline now sign in once per project. Existing
  project homes keep the login they had; the Host session loses a copy
  Tabtivity put there. One key everywhere: put the file into the global agent
  config (Settings → Agent sandbox → Global agent config → Open folder).
- Residual (row 16): content planted before the fix stays in the fenced homes
  it reached; Goose `secrets.yaml`, OpenCode `auth.json`, Qoder `.auth` are
  still shared on the 2026-09-25 survey, not re-surveyed.
- Not live-verified; the allowlists are read off CodeBuddy 2.162.0 and Kimi
  Code 2.1.1 bundles. A newer CLI that renames its login file would stop
  being shared (fails safe: it signs in per project).

## Agent step 1 — reviewer

Reviewed `0ac7eaf9..5200f442` (`6b0e0649`, `5200f442`) against the gap 16
row, Steps row 1, the fixed decisions and the agent step 1 review notes.
**No code change; no confirmed bug.**

**Checked and fine:**
- No env/config file left in the registry: Cline, Vibe, aider and
  mini-swe-agent rows are `&[]`; the remaining shared files are the
  credential files the plan lists. Nothing else writes into
  `agent-auth/<cli>/` for them (only `import_from_user_home_in` creates an
  empty store dir on a direct invoke, which returns an error, and the next
  start's retire removes it). No other module copies those paths into a home
  (`agent_global` copies only the user's layer).
- Allowlist: `DirNames::admits` refuses empty names, leading dots (so `.`,
  `..`, `..json`), `/` and `\`. Upper-case or Windows-mangled names fail
  closed. Every home read and write goes through `home_io` handles
  (`O_NOFOLLOW`, regular file only on read), so a symlink, FIFO or directory
  named `x.json` is neither adopted nor followed. Store-side listings keep
  regular files only.
- Applied in `reconcile_dir` (adopt and place), `status_in` (signed in and
  importable), `remove_copies` (sign-out and import) and the one-level
  `copy_dir_logins`. `import_once` skips the four CLIs (`shared: false`), and
  Settings and the phone bridge filter on `shared`.
- Retire: runs once per start, synchronously in setup before `import_once`
  and the keeper (`lib.rs:1303`), which are the only entry points, so it
  cannot race the keeper. It is idempotent: the store dirs are gone after
  the first run, the folder records for unlisted names are gone, and no code
  path writes either again. Store keys come from `store_dir_in`/`leaf_of`
  like the keeper's, and the `host` record key matches `home_key`. If the
  Host copy cannot be removed, the store is kept for the next start. The
  Host session has no `.local` home (`launch_prep` always uses
  `prepare_host_home`). On Windows every scope home is already unfenced, so
  the copies kept there add nothing.
- Tests fail on the old code for the right reason (`x.env` and the temp were
  adopted before; the retired rows were in the registry). The rewritten
  local-model test still covers receive-only on a remaining shared file.
- i18n: `settings.agentLoginsHelp` changed in en/de/es/fr/it, the only
  dictionaries. Docs (`agent_authority.md`, `help/agent-clis.md`,
  `threat_model.md` row 16, file map, checklist) match the code. The
  remaining mentions of the old paths are plan or history prose.

**Gates (at `5200f442`, nothing changed):** `cargo test -q` 3733 passed,
3 ignored, 0 failed (`--lib agent_` subset 359 passed);
`cargo clippy --all-targets -D warnings` clean. The npm gates were not rerun
(no TS changed since the implementer's run).

**Flagged for user:**
- The Host cleanup also removes a Host-session login that the keeper had
  adopted into the store. An adopted copy and a placed copy leave the same
  record (`.placed/host/<leaf>` = digest), so the code cannot tell a Vibe,
  Aider, mini-swe-agent or Cline login made in the Host session from one
  Tabtivity put there. That file goes, including any other settings the
  user had added to it. This is the plan's chosen rule, and it is the safe
  side. The implementer's note "the Host session loses a copy Tabtivity put
  there" understates it: after the first start, sign in to those CLIs again
  in the Host session. If keeping such a file matters, rename it aside
  (for example to `<file>.tabtivity-retired`) instead of deleting it. That
  is a design change, not made here.
- The same applies, on a small scale, to the folder cleanup: a CodeBuddy
  `.logged-out` marker or logout backup in the home that wrote it has a
  matching placed record (from its adoption) and is removed there too.
- Sign out now removes only allowlisted names. A CodeBuddy logout backup
  (`<stem>.<time>.<pid>.<uuid>.info`, which holds the old token) or a
  leftover Kimi temp file stays in the home whose CLI wrote it. These files
  are that scope's own and are not shared. Earlier, Sign out wiped the whole
  folder in every home.
- Dead data: an import by the old recursive `copy_dir` could leave
  subdirectories in `agent-auth/{kimi,codebuddy}/<leaf>/`. Those were never
  placed and still are not, and the retire does not remove them (it only
  removes regular files).

## Agent step 2 — implementer (gap 17)

**Commit:** `7677ff7f` Drop env and embedExec from untrusted tab layouts and
refuse planted control variables.

**Files:** `src-tauri/src/services/terminal_service.rs` (`CustomAgentSpec
{resume, env}` from `custom_agent_specs`, now `pub(crate)`;
`sanitize_untrusted_layout_with` drops `env`/`embedExec` and re-inserts a
registered custom agent's spec env; `persisted_env_denied` +
`strip_persisted_env` in `sanitize_tab_layout`'s known-command branch;
`ENV_KEY`/`EMBED_EXEC_KEY`), `services/launch_prep.rs` (`CONTROL_ENV`,
`is_control_env`, `strip_control_env` right after `adopt_legacy_env`,
`set_scope_env` with `insert`), `services/mobile_control/headless.rs`
(`launch_options` filters a clone of the record), `src/stores/tabs.ts`
(`restoreSavedTab` rebuilds `TAB_UID` for every `isResumableAgentTab` with a
`sessionId`), docs: `threat_model.md` row 17 (**Fixed, not live-verified.**
+ residual), `context/project_transfer.md`, `context/agent_authority.md`
(shell-tab shim paragraph), `filemap_backend.md` (`terminal_service.rs`,
`launch_prep.rs` rows).

**Tests added:** `terminal_service`:
`untrusted_layouts_drop_env_and_embed_exec_for_known_commands` (`""`,
claude, bash, sh, zsh, vibe), `an_untrusted_custom_agent_tab_gets_its_settings_env_only`,
`a_state_dir_layout_loses_loader_and_control_variables` (PATH, LD_*, DYLD_*,
BASH_ENV, PROMPT_COMMAND, GIT_*, SSH_ASKPASS, XDG_CONFIG_HOME, NODE_OPTIONS,
VIBE_MCP_SERVERS, HOME, HOST_SESSION/AGENT_FENCE/SCOPE/ROOT_MCP_TOKEN, legacy
HOST_SESSION gone; VIBE_HOME, TAB_UID, LOCAL_MODEL, XDG_SESSION_TYPE stay;
non-object env dropped), `a_custom_agents_spec_env_survives_and_a_differing_value_is_dropped`;
the trusted-path test is now `known_commands_keep_every_field_except_resume_args_and_denied_env`
(fixture env gained VIBE_HOME/TAB_UID and an `embedExec`; both kept, LD_PRELOAD
gone). `launch_prep`: `a_planted_scope_and_host_session_never_reach_the_spawn`
(incl. legacy spellings, MCP token/URL, key carrier),
`a_root_tab_gets_the_root_scope_and_no_project_dir`,
`control_names_are_matched_exactly`. `headless`:
`a_stored_records_env_is_filtered_before_launch`. Frontend
(`CenterPanelSessionRestore.test.tsx`): `an agent tab adopted with no env gets
its TAB_UID back from sessionId`.

**Gates (at `7677ff7f`):** `npm run build` ok; `npm test` 735 files / 7556
tests passed; `cargo test -q` 3741 passed, 3 ignored, 0 failed; `npm run
lint` 0 errors, 28 advisory warnings (unchanged, none in touched files);
`cargo clippy --all-targets -D warnings` clean; `scripts/brand-check.sh` ok;
`git diff --check` clean; `scripts/privacy-check.sh` clean.
`npm run backend:stale` not run (main agent at landing).

**Choices:**
- `prepare` has no full-path unit test (it needs the state dir, fence and
  tmux). The env steps are pure helpers (`strip_control_env`,
  `set_scope_env`) called from `prepare`; the test runs them in `prepare`'s
  order with `adopt_legacy_env`. Callers checked: `pty_spawn` and the
  headless `HeadlessSpawner` are the only `prepare` callers; no caller or
  internal `PtyOptions` builder puts a control variable in `env` before
  `prepare` (they are all inserted later in `prepare` or its callees).
- Control list (both spellings, legacy via `adopt_legacy_env` then matched
  again in `is_control_env`): `AGENT_FENCE`, `HOST_SESSION`, `SCOPE`,
  `PROJECT_DIR`, `TAB_AGENT`, `STATE_DIR`, `HOME` (the app's), `PUSH_PREFLIGHT`,
  `GIT_TOKEN`, the five `*_MCP_TOKEN` **and** `*_MCP_URL` vars, and every
  `AGENT_SECRET_*` carrier. Added beyond the review note: the MCP URLs, the
  app's `STATE_DIR`/`HOME` (a planted one would point the shim's
  `--agent-shim` at another state dir) and `TAB_AGENT`.
- Persisted-env denylist adds a few to the review list: `MANPAGER`,
  `BROWSER`, `LESSOPEN`, `LESSCLOSE`, `PERL5DB`, `JDK_JAVA_OPTIONS`,
  `XDG_*_DIRS`, and the spawn-time CLI configs Tabtivity itself sets
  (`VIBE_MCP_SERVERS`, `VIBE_ENABLED_TOOLS`, `OPENCODE_CONFIG_CONTENT`), each
  of which can name a program the CLI starts. The custom-agent exception
  applies to the whole list (a control variable is then still dropped at
  `prepare`).
- At the untrusted doors a registered custom agent's env is rebuilt from its
  settings entry (the source the window used to create it), rather than left
  empty.
- `TAB_UID` is overwritten from `sessionId` for every resumable agent, not
  only filled in when missing: `buildStaticTabSpec` sets both from one uuid
  and nothing changes a tab's `sessionId` later (only `duplicateSpec`, which
  swaps both).
- No `UntestedTag`: no new UI.

**Gotchas:** cargo was warm this time (~3 min for clippy, under a minute
for the targeted test build). `serde_json::json!` accepts
`crate::app_env!(..)` as an object key.

**Flagged for user:**
- A tab adopted from a folder or an import bundle no longer brings its
  environment. A local-model Vibe tab from another machine loses its
  `VIBE_HOME` (it was that machine's path anyway); a custom agent gets the
  env from this machine's settings.
- State-dir layouts now lose the listed variables on every load. Built-in
  tabs never persist them; a hand-edited `terminals.json` that set `PATH`
  for a shell tab loses it (the log names the dropped keys).
- Not traced: the headless owner relaunches a stored record with the
  record's `env` (`launch_options`). An agent tab adopted from a folder has
  no `TAB_UID` in its state-dir record until a window restores and re-saves
  it, so a phone-started reopen of such a tab before that runs without turn
  binding. Low impact (the window rewrites the record on first load).
- Not live-verified: import a `.tabtivityproj` / adopt a folder layout with
  a planted `env`, open the shell tab, check `env` in it; type `claude` in a
  shell tab of a layout carrying `TABTIVITY_HOST_SESSION=1` and check it
  runs fenced.

## Agent step 2 — reviewer

**Range reviewed:** `9baa2945..05781677` (code `7677ff7f`).

**Traced, no bug found:**
- Untrusted doors: `.tabtivityproj` import (`project_transfer.rs` →
  `adopt_untrusted_session`), folder adoption (`adopt_folder_tab_layout` →
  `adopt_project_tree_session`), `migrate_project_sessions_once`. All three
  run `sanitize_untrusted_layout`; `read_project_tree_session` has no other
  caller. The frontend only ever sees the stored (sanitized) copy, via
  `load_tab_session`/`workspace_snapshot`/`project-runtime-switched`; no tab
  layout is kept in browser storage; popouts get tabs from the main window.
  `tab_groups` carries no tab specs.
- Headless owner: every `launch_options` caller (create, reopen, undo-clear
  relaunch) filters; `prepare` strips control variables for both `pty_spawn`
  and the headless spawner.
- Tabtivity-inserted variables: every control-variable insert (`TAB_AGENT`
  in `agent_session`, MCP tokens/URLs in `root_mcp::grant_lanes`, key
  carriers, `HOST_SESSION`, `AGENT_FENCE`, the macOS/Windows `home_env`) runs
  after the strip in `prepare`. The frontend's fresh-spawn env
  (`buildStaticTabSpec`, sign-in, cloud, local-model, Run tab, custom agent
  `item.env`) sets no denylisted key except what a custom agent's settings
  name, which the exception keeps.
- `restoreSavedTab` TAB_UID: every creator sets `TAB_UID = sessionId`
  (`newTabItems.ts`, `localTabSpec.ts`, headless `tab_record`,
  `duplicateSpec` swaps both); non-resumable and `localLaunch` tabs have no
  `sessionId` and are untouched.

**Finding 1 (fixed, `07868c59`):** the filters matched names exactly, but
Windows environment names are case-insensitive — `portable_pty` lowercases
the key on Windows (`EnvEntry::map_key`), so a persisted `Path` replaced the
`PATH` Tabtivity set, and a lower-case `tabtivity_host_session` /
`tabtivity_scope` survived `strip_control_env` (for `SCOPE`, which of the two
entries won then depended on `HashMap` order). `persisted_env_denied` and
`is_control_env` now upper-case the key first (legacy prefix too). Also
added the Windows counterparts of listed entries to the persisted denylist:
`PATHEXT`, `COMSPEC`, `PSMODULEPATH`, `USERPROFILE`, `APPDATA`,
`LOCALAPPDATA` (`USERPROFILE` is one of the `home_env` keys applied with
`or_insert`, so a persisted one would have won on Windows).
Tests: `terminal_service::a_persisted_env_is_matched_in_any_letter_case`,
`launch_prep::a_planted_control_variable_in_another_letter_case_is_dropped`.

**Gates (at `07868c59`):** `npm run build` ok; `npm test` 735 files / 7556
tests passed; `cargo test -q` 3743 passed, 3 ignored, 0 failed; `npm run
lint` 0 errors, 28 advisory warnings (unchanged); `cargo clippy
--all-targets -D warnings` clean; `scripts/brand-check.sh` ok; `git diff
--check` clean; `scripts/privacy-check.sh` clean. `npm run backend:stale`
not run (main agent at landing).

**Flagged for user:**
- `workspace_sync` answers with the stored tabs raw (no load sanitizer) and
  its patch ops carry other clients' tabs. Today every writer is a window
  (already sanitized), the headless owner (Tabtivity-built record) or
  `reopen_tab_in` (a closed record, only reached with no window), so no
  untrusted tab gets through; it is a load path the denylist does not cover
  if a new writer appears.
- Agree with the implementer's headless `TAB_UID` note: an adopted agent
  tab's state-dir record has no `TAB_UID` until a window restores and saves
  it. The headless paths that relaunch a stored record (reopen of a closed
  tab, undo-clear relaunch of a live one) only meet records a window or the
  owner already wrote, so it is unreached in practice; mirroring the
  `restoreSavedTab` rebuild in `launch_options` would close it.
- On macOS/Windows/Host session `home_env` keys are applied with
  `or_insert`, so a persisted `CARGO_HOME`, `RUSTUP_HOME` or `DOCKER_CONFIG`
  in a state-dir layout still wins over the user's. Not on the denylist
  (the user may set them for a shell tab); state-dir only.

## Agent step 3 — implementer (gap 18)

**Commit:** `716e6ccc` Run the push preflight only in the tab's recorded
fence and guard tab teardown by spawn generation.

**Files:** `services/root_mcp.rs` (`PushBinding::fence_scope`,
`TokenStore::stamp_push_fence_scope`), `services/git_push_mcp.rs`
(`HookBoundary {Fence, Unrecorded, #[cfg(test)] Host}`, `preflight_command`
/`preflight` take it, `Proposal::fence_scope` copied in `new_proposal`,
`run_request` uses it), `services/launch_prep.rs` (`SpawnGeneration` guard,
`PreparedLaunch::{spawn_seq, fenced_scope, generation}`, `commit` →
`register_tab(id, scope, seq)` and host-agent tracking only while current,
`push_fence_scope` + the stamp after the fence match, `pub fn
on_tab_gone(id, seq)`), `services/agent_fence.rs` (registry is now
`TabSpawns {latest, live}`: `next_spawn_seq`, `begin_spawn`,
`register_tab(id, Option<scope>, seq) -> bool`, `abandon_spawn`,
`on_tab_gone(id, seq) -> bool`; `fenced_scope_of_tab` is `#[cfg(test)]`),
`terminal/mod.rs` (`PtyEntry::seq`, `insert(.., seq)`, `spawn_pty(.., seq)`,
`route_open_at(id, seq)` with a test-only `route_open`, `ROUTE_SEQ` gone,
`kill_all`/`teardown_taken` → `launch_prep::on_tab_gone(id, seq)`, reader
end → `agent_fence::on_tab_gone(id, route_seq)`), `commands/terminal.rs`
(`pty_spawn` passes `spawn_seq()`; `pty_kill`/`pty_kill_scope` leave the
cleanup to the teardown, skipped when `take` finds nothing),
`services/api_proxy.rs` (test-only `issue_for_test`). Docs:
`threat_model.md` row 18 (**Fixed, not live-verified.** + residual),
`context/git_push_mcp.md` (preflight step 1, QA step 6),
`context/agent_authority.md` ("Spawn generations" paragraph, proxy-token
lifetime), `filemap_backend.md` (`launch_prep.rs`, `agent_fence.rs`,
`git_push_mcp.rs`, `terminal/mod.rs` rows), `headless_mcp_handoff.md`
(the queued-push fence gotcha now points at the binding's scope).

**Tests added:** `agent_fence`:
`a_stale_teardown_leaves_the_respawns_registration_and_proxy_tokens` (stale
before and after the respawn's commit), `a_kill_of_an_uncommitted_spawn_beats_its_commit`,
`an_abandoned_spawn_falls_back_to_the_live_one` (and a failed first spawn
drops its proxy token), `an_unfenced_spawn_registers_without_a_scope`.
`launch_prep`: `a_stale_teardown_keeps_the_respawns_tokens_and_turn_binding`
(fence scope, MCP token, proxy token, `agent_turn` binding all survive the
stale teardown and go with the current one), `a_dropped_launch_abandons_its_generation`,
`only_a_fenced_local_agent_stamps_its_push_binding` (every `FenceDecision`,
Host session and ssh/docker included). `root_mcp`:
`only_a_pusher_binding_takes_a_fence_scope`. `git_push_mcp`:
`a_pusher_with_no_recorded_fence_scope_is_refused_and_its_hook_never_runs`
(also an unbuildable scope refuses, hook marker never written),
`the_proposal_carries_the_fence_scope_its_binding_recorded`. The existing
hook test runs on `HookBoundary::Host`.

**Gates (at `716e6ccc`):** `npm run build` ok; `npm test` 735 files / 7556
tests passed; `cargo test -q` 3753 passed, 3 ignored, 0 failed (lib 3585);
`npm run lint` 0 errors, 28 advisory warnings (unchanged; no TS touched);
`cargo clippy --all-targets -D warnings` clean; `scripts/brand-check.sh` ok;
`git diff --check` clean; `scripts/privacy-check.sh a842b990..HEAD` clean.
`npm run backend:stale` not run (main agent at landing).

**Choices:**
- **The generation starts in `prepare`, not at `reg.insert`** (a deviation
  from the review note's wording, same intent). `prepare` hands out the MCP
  tokens (`grant_lanes`), the turn binding (`bind_tab`) and the proxy tokens
  (`inject_api_keys`) long before the PTY exists, and `api_proxy` gives a
  respawn the *same* proxy token back. A seq minted at insert left the
  likelier ordering open: the old kill's teardown landing while the
  respawn is still in `prepare` matched the old registration and wiped
  what the respawn had just been handed. So `SpawnGeneration::begin` runs
  right before `grant_lanes`; `spawn_seq()` rides into `spawn_pty`, the
  `PtyEntry` and the output route (one counter, `agent_fence::next_spawn_seq`,
  so the reader end's `route_seq` *is* the spawn seq). `commit()` needs no
  argument.
- Registry rule: `on_tab_gone(id, seq)` is current when the id has no entry
  or `latest == seq`; then the entry goes with untrack, proxy tokens and the
  keeper kick. Otherwise it only clears `live` if that was its own spawn.
  `register_tab` records only while `latest == seq` (a kill of the PTY
  before its commit wins). A spawn dropped uncommitted (prepare error,
  crash-loop guard, `spawn_pty` error, headless non-unix) falls back to the
  live spawn, or with none removes the entry and its proxy tokens.
- Every spawn registers (shells and unfenced tabs too, scope `None`), so the
  generation check covers the Host session's and Windows tabs' proxy tokens
  and turn bindings, not only fenced ones.
- `launch_prep::on_tab_gone(id, seq)` is the one teardown for kill paths:
  fence-level, then (current only) `root_mcp_review::on_tab_gone` and
  `agent_turn::on_tab_gone`. `teardown_taken` and `kill_all` call it, so
  `pty_kill`/`pty_kill_scope` no longer repeat the calls after the await
  (they used to run each twice) and `kill_all`/`registry.kill` now also drop
  the turn binding. The reader end keeps calling only the fence-level one
  (its per-token revokes were already generation-safe).
- Stamp: the push token is read from `opts.env[GIT_TOKEN_ENV]` right after
  `grant_lanes` (before any wrap rewrites the env) and stamped after the
  fence `match`, so a failed wrap (which returns) never stamps. The stamp
  only touches a `Caller::Pusher` session with that exact token.
- Refusal text: Windows keeps its message, now under `fence_unavailable`
  (was `preflight_failed`); elsewhere "no recorded sandbox … restart the
  tab, or push from the git bar". Agent-facing MCP text, English like the
  rest of the lane (not i18n).
- No `UntestedTag`: no new UI.

**Gotchas:**
- The match-guard-then-`map.remove` pattern in `agent_fence::on_tab_gone`
  compiles under NLL; no Polonius workaround needed.
- `pty_kill`'s `take` could in theory take the *respawn's* PTY if the
  respawn inserted first; the frontend sends the kill before the spawn and
  `take` runs on the kill's first poll, while the spawn awaits `prepare`.
  Not changed.

**Flagged for user:**
- On Windows an agent push in a repo with a `pre-push` hook now reports
  `fence_unavailable` instead of `preflight_failed` (same message, same
  outcome: push from the git bar). macOS is unchanged (`fence_unavailable`,
  no one-shot fence there).
- A tab started before this build and re-attached from a surviving tmux
  session gets a fresh Pusher token with the scope stamped at the respawn,
  so nothing changes for it. A Pusher token minted by an older running
  window (no stamp) does not exist past a restart of the window.
- A stale teardown skips the old spawn's `root_mcp_review` sandbox cleanup;
  the respawn's own teardown (same tab id) does it later.
- Not live-verified. Click-through (Linux, dev build with this commit):
  1. In a local project with `.githooks/pre-push` (this repo works), open a
     Claude tab and set the project's agent pushes to Propose.
  2. Remount the pane a few times (switch the split layout or move the tab
     to another pane and back) so the tab respawns under the same id.
  3. Ask the agent to commit something and call `git_push`. Expect the
     preflight to run fenced: the hook's output on the card, and a hook
     that writes `touch ~/preflight-probe` leaves no file in `$HOME`.
  4. With the API-key proxy on, after the remount the agent's model calls
     still work (its proxy token survived), and the tab's turn state (the
     working/done marks) still follows the agent.
  5. Close the tab: its MCP session disappears from MCP session access.

## Agent step 3 — reviewer

**Reviewed:** `a842b990..605edd71` (code `716e6ccc`) against the gap 18 row,
Steps row 3, the run's fixed decisions and the agent step 3 review notes.

**Verdict on minting the seq in `prepare`:** correct. `prepare` hands out the
MCP tokens, the turn binding and the (same-per-tab) proxy token long before
the PTY exists, so a seq minted at `reg.insert` would let the old kill's
teardown, landing during the respawn's `prepare`, match and wipe them. Minting
in `prepare` creates one new hazard, though: spawn order (`latest`) and
registry insert order can now disagree (finding 1).

**Checked, no change needed:**
- No host path left for the hook: `HookBoundary::Host` exists only under
  `#[cfg(test)]` and `HookBoundary::of` never yields it; the transport push
  is `--no-verify` through `hardened_git_command_in`; `fenced_scope_of_tab`
  has no production caller.
- The stamp covers every legitimate Pusher: `grant_lanes` gives the push lane
  only to local, non-container, non-remote, non-VM project agents (`!sandbox`,
  `!off_host`), and on Linux/macOS `decide` answers `Fenced` for each of them.
  Resumed tabs, phone-opened tabs (both through `pty_spawn`) and the headless
  owner (`HeadlessSpawner` → `prepare`, the same process-global `tokens()`)
  take the same path. The stamp lands before the tmux wrap. Container and
  remote tabs get no Pusher; any mismatch now fails closed.
- `pty_kill_scope`, `kill_all` and `teardown_taken` pass the taken entry's
  seq; the reader-task end passes `route_seq`, which is the spawn seq.
- Lock order: registry → fence map (`kill_all`, and now `insert_current_spawn`),
  never the reverse; `abandon_spawn`/`on_tab_gone` drop the map lock before
  `api_proxy`/untrack; the stamp takes only the token-store lock. The new
  `agent_turn::on_tab_gone` under `kill_all`'s registry lock takes only
  agent_turn's own locks.
- The implementer's tests discriminate (the preflight test's `unwrap_err`
  proves the hook was resolved before the refusal).

**Findings:**
1. **Fixed: an older spawn could replace a newer one's PTY.** Two spawns of
   one id in `prepare` at once (a remount while the old mount's spawn is
   still preparing, e.g. a remote tab's `connect_host`) can finish out of
   order. The older one's `reg.insert` killed the newer PTY and took its slot.
   From then on the older PTY's teardown was stale (`latest` = newer), and the
   newer spawn's reader end lost `route_close`. So the newer spawn's
   registration, MCP and proxy tokens and turn binding were never torn down,
   not even by `kill_all` at quit (no registry entry). This is a regression:
   the old unconditional teardown cleaned them. `spawn_pty` now inserts
   through `PtyRegistry::insert_current_spawn`, which checks
   `agent_fence::is_current_spawn` under the registry lock. A refused spawn
   reaps its own child and returns an error, which the cancelled mount
   ignores (`TerminalView` returns on `cancelled`).
2. **Fixed: a failed spawn's tab state was never torn down.** `pty_kill` now
   skips teardown when `take` finds nothing. But a spawn that fails after
   `prepare` made grants (fence refusal, `HPC_GUARD`, crash-loop guard,
   `spawn_pty` error) leaves no PTY, and the reader end never clears turn
   bindings. The same holds after a stale kill of the old spawn followed by
   a failed respawn, where the old spawn's `revoke_tab` and review cleanup
   were skipped. Closing such a tab left its turn binding, review sandbox and
   any unrevoked tab tokens behind until quit. `abandon_spawn` now answers
   whether the id ended. When it did, `SpawnGeneration::drop` also runs
   `root_mcp_review::on_tab_gone`, `agent_turn::on_tab_gone`,
   `codex_bind::untrack_now` and `sandbox::kill_tab_process`.
3. **Fixed (sibling, same race): `teardown_taken` ran `codex_bind::untrack_now`
   and `sandbox::kill_tab_process` unguarded.** A stale kill dropped the
   respawn's Codex tracking and resume claim, so the next relaunch could not
   resume it. It also TERMed the respawned container agent, because the
   respawn's `register_exec_tab` had replaced the record and already ended
   the old in-container process. Both now run only when the teardown is
   current. `kill_all` keeps them unconditional, since the app is quitting.

**Fix commit:** `7c0ac8ee` Keep an older spawn out of a newer one's PTY slot
and end a failed spawn's tab state. Docs: `context/agent_authority.md`
("Spawn generations"), `filemap_backend.md` (`terminal/mod.rs` row).

**Tests added** (each fails with its fix disabled, checked):
`terminal::tests::an_older_spawn_never_replaces_a_newer_ones_pty`,
`terminal::tests::a_stale_kill_leaves_the_respawns_codex_resume_claim`,
`launch_prep::tests::a_failed_spawn_with_none_live_ends_the_tabs_tokens_and_turn_binding`
(also: a failed respawn with an earlier spawn still live leaves that spawn's
token and binding alone).

**Gates (at `7c0ac8ee`):** `npm run build` ok; `npm test` 735 files / 7556
tests passed; `cargo test -q` 3756 passed, 3 ignored, 0 failed; `npm run
lint` 0 errors, 28 advisory warnings (unchanged); `cargo clippy --all-targets
-D warnings` clean; `scripts/brand-check.sh` ok; `git diff --check` clean;
`scripts/privacy-check.sh a842b990..HEAD` clean. `npm run backend:stale` not
run (main agent at landing).

**Flagged for user:**
- **Closing a tab while its spawn is still being prepared** (no earlier PTY,
  or the kill landed stale) still lets that spawn start. The PTY then runs
  with no tab until quit. This predates the step. The backend cannot tell a
  close from a remount's kill+spawn without a frontend signal (for example,
  `pty_kill` naming the mount it ends).
- **Overlapping spawns where the newer one fails:** the older spawn may
  already sit in the registry unregistered (its commit came after the newer
  one's `begin`). The newer one's abandon then ends the tab's tokens, proxy
  token and turn binding under that running PTY. Its lane tokens were already
  revoked by the newer `grant_lanes` before this step, so it was half-broken
  anyway. This is a rare edge and was left alone.
- **Spawns in `prepare` at quit** are not in the registry, so `kill_all`
  misses them. This predates the step.
- **The headless owner never tears down its `TabSpawns` entries.** Every
  spawn registers now, not only fenced ones. The map is bounded by tab ids,
  since a respawn reuses its entry.
- **The implementer's flag about tmux re-attach is unverified.** It says a
  re-attached tab "gets a fresh Pusher token with the scope stamped". But the
  agent process inside a surviving tmux session keeps the token from its
  original environment, and a respawn's `grant_lanes` replaces that token's
  lane session. Whether a re-attached agent can push at all was not checked.
- **No test drives `prepare` to the stamp itself.** Only `push_fence_scope`
  and `stamp_push_fence_scope` are unit-tested. A refactor that moves the
  stamp out of the fence block would pass the gates.

## Agent step 4 — implementer (gaps 29, 30)

**Commit:** `a3692f25` Read agent-written records without blocking and pin
local-model control paths.

**Files:** `services/home_io.rs` (`RECORD_CAP` = 64 KiB, path-based
`open_regular` (`O_NOFOLLOW|O_NONBLOCK`, regular file on the opened inode;
Windows keeps the `lstat` check) and `read_record`; `HomeFile::ensure(dir)`
makes a name a file/folder through the handle (link/FIFO/socket
`unlinkat`-ed, `O_CREAT|O_NOFOLLOW|O_NONBLOCK` or `mkdirat`, `Meta` with the
inode read off a no-follow handle); test helpers `within_deadline` (5 s) and
`mkfifo`, both `cfg(all(test, unix))`). Readers converted:
`agent_turn.rs` (`bind_tab`'s leftover checks, `resolve_event` on the watcher
thread), `agent_session.rs` (id record, `.src`, `.mode`, `.prev`, Vibe
`meta.json`, `with_transcript_tail`, Codex `config.toml` in
`codex_hook_state_of_home`), `git_guard.rs` (`commondir`, `.git` pointer),
and siblings `mobile_control/headless.rs` (`turn_record`, the phone's read
of the same `.turn`) and `codex_bind.rs` (`read_rollout_meta`).
`agent_fence.rs`: `ControlPin {path, ino}`, `local_model_control_paths` →
`Result<Vec<ControlPin>, String>` via `HomeDir`/`HomeFile::ensure`,
`verify_control_pins`, `local_model_mounts`/`agent_state_mounts` return
`Result<(mounts, pins)>`; `wrap_pty_options_bwrap` verifies right before
`seccomp_launcher` builds the final argv; macOS `sandbox_exec_inputs` returns
the pins (its `protected` list now comes from them instead of a second setup
call) and `wrap_pty_options_sandbox_exec` verifies before building the
`sandbox-exec` argv. Docs: `threat_model.md` rows 29 and 30 (**Fixed, not
live-verified.**, 30 with its residual), `context/agent_authority.md` (new
"Agent-written files…" paragraph), `context/agent_sessions.md` (records
paragraph), `filemap_backend.md` (`home_io.rs`, `agent_fence.rs` rows).

**Tests added:** `home_io`: `a_record_reads_whole_up_to_the_cap_and_not_past_it`,
`a_record_is_never_read_through_a_link_or_from_a_fifo`,
`ensure_replaces_a_link_or_fifo_and_keeps_what_is_real`. `agent_session`:
`planted_fifos_links_and_oversized_records_read_as_nothing` (FIFO at the id
record, `.src`, `.mode`, `.prev` one at a time with the others valid, so each
reader reaches its own file; link; 64 KiB+1 refused while exactly 64 KiB
reads; Vibe `meta.json` FIFO; transcript FIFO; Codex config FIFO).
`agent_turn`: `a_planted_fifo_link_or_huge_turn_record_reads_as_nothing_without_blocking`.
`git_guard`: `a_fifo_linked_or_huge_commondir_or_pointer_is_not_read`.
`headless`: `a_fifo_turn_record_reads_as_nothing_without_blocking`.
`codex_bind`: FIFO case in the rollout-meta test. `agent_fence`:
`a_control_path_swapped_after_setup_refuses_the_spawn` (raced link at a file
and at a folder, a new inode, a removed path) and
`a_fifo_at_a_control_path_is_replaced_without_blocking`; the existing mount
and symlink tests now also check the pins. Every FIFO read runs under
`within_deadline`, so a regression fails instead of hanging the suite (an
early draft of my own test did hang on a `write` into a FIFO — that is what
the deadline is for; only reads are wrapped, so keep writes off FIFOs).

**Gates (at `a3692f25`):** `npm run build` ok; `npm test` 735 files / 7556
tests passed; `cargo test -q` 3765 passed, 3 ignored, 0 failed (lib 3597);
`npm run lint` 0 errors, 28 advisory warnings (unchanged); `cargo clippy
--all-targets -D warnings` clean; `scripts/brand-check.sh` ok; `git diff
--check` clean; `scripts/privacy-check.sh cca43e77..HEAD` clean. Windows
`cargo clippy --target x86_64-pc-windows-msvc --lib --tests` (shims): no
finding in any touched file; 15 findings elsewhere (`commands/apps.rs`,
`network.rs`, `screenshot.rs`, `platform/{mod,windows}.rs`,
`project_runtime.rs`, `vm.rs`, and the test-only `HookBoundary::Host` dead
variant from step 3) are in files this step does not touch, so pre-existing
(not re-run at `cca43e77`). macOS not compiled (no Apple `cc`); its arm was
checked by reading. `npm run backend:stale` not run (main agent at landing).
One run of the targeted tests failed
`codex_bind::tests::a_watched_tree_is_walked_only_after_a_change` (inotify
timing, under load from a parallel build); it passed in the full run and the
re-run. Untouched by this step.

**Choices:**
- One helper pair in `home_io`, no new module. `open_regular` is for
  transcripts and rollouts (the caller keeps its tail/head cap);
  `read_record` for whole small records. Both refuse a link at the last
  component, including transcripts (the note asked only for `O_NONBLOCK` +
  `fstat`; nothing in Tabtivity makes a transcript a link, and a link there
  would let an agent point the host's reader at any file).
- The watcher's per-event read stays on its thread: with `O_NONBLOCK` and a
  regular-file check it cannot block, so no second thread.
- Siblings fixed too (same records, same hazard): the phone's `turn_record`,
  Codex rollout heads in `codex_bind`, Codex `config.toml` in the hook check.
- Gap 30: a link, FIFO or socket at a control name is unlinked and replaced;
  a regular file or folder already there is kept and mounted read-only
  *whichever kind was asked for* (a folder at `config.toml` is RO-bound
  rather than left writable; the old code skipped such a path, leaving it
  unmounted and agent-writable). Any setup failure now **refuses the spawn**
  (it used to skip the path). `register_vibe_hook_in` stays first: its write
  replaces `hooks.toml`'s inode, and it is idempotent (no write when the
  content matches), so two tabs of one model starting together do not trip
  each other's pins.
- The verify sits after `guard_paths`/masks/keyring filter, right before the
  final argv, which is as late as the wrapper allows; the PTY spawn (tmux
  wrap) follows.
- Refusal messages are English like the rest of the fence's
  (`fence_unavailable_message`); no UI, so no `UntestedTag`.

**Gotchas:**
- The worktree's cargo target dir is `<worktree>/target`, not
  `src-tauri/target`.
- A FIFO left in a test dir makes any later `std::fs::write` to that path
  block forever (open for write waits for a reader): remove it first.

**Flagged for user:**
- **Residual of gap 30:** bubblewrap (and Seatbelt) still open the control
  paths by name after `verify_control_pins`, so a swap in that window is
  missed; closing it needs `--ro-bind-fd` with descriptors passed through
  the PTY spawn.
- **Behaviour change:** a local-model tab whose control path cannot be set
  up (or changes during startup) is now refused with an "Agent sandbox: …"
  message instead of starting with that path unmounted.
- macOS arm not compiled here; CI `test-macos` is the check.
- Not live-verified. Click-through (Linux, dev build with this commit):
  1. Open a Claude tab in a project and let it finish a turn; in a
     terminal, `mkfifo` over its `.turn` record:
     `rm <state_dir>/live_sessions/<project_key>/<uid>.turn && mkfifo …`.
     Send another prompt; other tabs' working/done marks must keep updating
     (before: every tab's turn state froze).
  2. `mkfifo <project>/.git/commondir` (with `.git` a folder), then open a
     new agent tab in that project: it starts (before: the spawn hung).
     Remove the FIFO afterwards.
  3. Start a local-model (Ollama/Vibe) tab; it works as before. In
     `<state_dir>/vibe_local/<model>/`, replace `tools` with a symlink and
     start a second tab of that model: it starts, and `tools` is a real
     folder again.

## Agent step 4 — reviewer

**Reviewed:** `cca43e77..a001ddef` (code `a3692f25`) against plan step 6, the
gap 29/30 rows and the agent step 4 review notes.

**Findings:**
1. **Fixed (`1c52e7a0`): Vibe's `meta.json` refused past 64 KiB.** It is not
   a small record: Vibe writes its full config dump, every tool schema and
   the whole first system message (project context, the user's `AGENTS.md`)
   into it (checked against mistral-vibe's `session_logger.py`). Under
   `RECORD_CAP` a legacy-layout session with a real `meta.json` stopped
   matching and `--resume` fell back to a fresh session. Now
   `read_record_capped(…, VIBE_META_CAP = 16 MiB)` (made `pub`); still no
   FIFO, link or special file. Regression: the legacy entry in
   `vibe_resumes_its_own_recorded_session_and_preserves_legacy_fallback` is
   now ~128 KiB (fails with the 64 KiB cap, checked).
2. **Fixed (`94f02b56`): unconverted sibling readers.**
   `agent_transcript::read_transcript_in` (the phone's Focus transcript) and
   `agent_changes::read_changes` opened agent-written transcripts with
   `File::open`; `agent_transcript::claude_spawned` read every subagent
   `agent-*.meta.json` with `fs::read` after a following `metadata` size
   check (a FIFO reports 0 bytes). Now `open_regular` / `read_record`.
   Tests: `a_fifo_transcript_or_subagent_meta_reads_as_nothing_without_blocking`,
   `a_fifo_or_linked_transcript_reads_as_nothing_without_blocking` (both under
   `within_deadline`). Docs: `threat_model.md` row 29 and
   `context/agent_authority.md` name them and the meta cap.
3. Checked, no bug: `O_NONBLOCK` stays on the returned fds but only ever on
   regular files (both Linux and macOS ignore it there); the turn watcher's
   per-event read cannot block or drop a well-formed record (a `.turn` is
   written by the hook as a plain file); `HomeFile::ensure` unlinks only
   links, FIFOs and sockets — a real file or folder of either kind is kept,
   never a user's data; Codex `config.toml` and transcripts are uncapped or
   keep their own tail/head caps; the `.git` pointer is only read when
   `lstat` already says regular file; cfg arms for Windows (`ensure`,
   `open_regular`, `ControlPin.ino = None` on both sides) and macOS
   (`sandbox_exec_inputs` → `Result`, its one caller uses `?`) read
   correctly; every new FIFO test reads under `within_deadline` and removes
   the FIFO before any later write.
4. `verify_control_pins` false positives: nothing between the pins and the
   check writes a control path; `prepare_local_agent`'s `config.toml` write
   is in place (same inode); `register_vibe_hook_in` writes only when the
   block differs. One narrow case remains (flagged below).

**Gates (at `94f02b56`):** `npm run build` ok; `npm test` 735 files / 7556
passed; `cargo test -q` 3767 passed, 3 ignored, 0 failed (lib 3599); `npm run
lint` 0 errors, 28 advisory warnings (unchanged); `cargo clippy --all-targets
-D warnings` clean; `scripts/brand-check.sh` ok; `git diff --check` clean;
`scripts/privacy-check.sh cca43e77..HEAD` clean. macOS not compiled.
`npm run backend:stale` not run (main agent at landing).

**Flagged for user:**
- **Concurrent first spawns of one local model can refuse one tab.** When
  `hooks.toml` must be (re)written — a model's first tab ever, or after an
  update changes the hook block — two spawns of that model starting at once
  can both see stale content; the second's write (temp + rename, a new
  inode) lands after the first pinned the old inode, and the first is
  refused with "changed while this tab was starting". A retry works. Closing
  it would need the rewrite done in place, or one lock held from the
  rewrite to the PTY spawn.
- **A host rewrite of `hooks.toml` unmounts it in running tabs (needs a
  check).** Linux (3.18+) detaches a mount whose mount point is renamed over
  from another namespace, so when a spawn replaces `hooks.toml`, running tabs
  of that model lose its read-only bind and can write the file until they
  respawn. Each later spawn rewrites it again (the app-owned block is reset
  whenever it differs), so the effect is bounded; an in-place write would
  avoid it. Not verified live.
- Not re-reviewed beyond gap 29's scope: `agent_fence::shebang_interpreter`
  and `venv_base_prefix` read the resolved agent executable and its
  `pyvenv.cfg` with plain reads (install paths, not agent records).

## Agent step 5 — implementer (gaps 24, 37, 39)

**Commit:** `edff58e5` Parse spreadsheets in a limited child process and bound
SQLite viewer queries.

**Files:** new `services/sheet_reader.rs` (`MODE_FLAG = --sheet-read`,
`child_main`, `read_in_child`/`run_reader`, `kill_all_for_exit`, `format_of`,
cell-by-cell `.xlsx` reader, `Grid` caps, `viewer-limit:sheet-*` codes);
`commands/sheets.rs` (thin: extension check, `confine_project_path`, child
read; `project_id` argument); `commands/sqlite.rs` (`guard`, `sql_err`,
truncating `stringify`, page clamp and byte cap, `project_id` on both
commands); `main.rs` (mode dispatch before Tauri); `lib.rs` (`RunEvent::Exit`
calls `sheet_reader::kill_all_for_exit`); `paths.rs` (`hide_command_window`
now `pub(crate)`); `Cargo.toml` (rusqlite `hooks` + `limits`; dev-dep `cfb`
0.7, already in the tree via `infer`). Frontend: `TableView.tsx`,
`SqliteView.tsx` (pass `projectId` from `useFileScope()`, render errors via
`viewerErrorText`), new `src/lib/viewers/limitError.ts`, six
`viewerLimit.*` keys in all five dictionaries. Docs: `threat_model.md` rows
24, 37, 39 (**Fixed, not live-verified.**, 24 and 37 with residuals),
`filemap_backend.md` (`sqlite.rs + sheets.rs`, `sheet_reader.rs`),
`filemap_frontend.md` (`limitError.ts`). No `docs/context/` file covers the
viewers, so none was changed.

**Tests added:** `sheet_reader`: `a_sparse_a1_xfd1048576_sheet_is_refused_without_allocating`
(in-process on purpose; with the declared `A1:XFD1048576` dimension it is
refused, without it the far row is dropped, and A1+XFD20000 is refused on
the cells), `rows_past_the_cap_are_dropped_and_long_text_is_cut`,
`reads_a_small_sheet_from_its_first_used_cell`,
`only_the_three_viewer_extensions_are_read`, `the_child_answers_a_good_workbook`,
`a_crafted_xls_dimensions_record_ends_the_child_not_the_app` (a CFB v3
`.xls` built in-test; checked by hand that the child dies on "memory
allocation of 687194767360 bytes failed", exit 134),
`a_crash_a_hang_garbage_and_a_flood_map_to_viewer_errors` (SIGABRT, exit 101,
garbage, no output, a refusal reply, a 300 ms timeout, 300 MB of output),
`the_quit_teardown_kills_a_running_reader`, `cell_to_string_maps_variants`
(moved). `sheets`: `a_path_outside_the_scope_is_refused_before_any_read`,
`an_unsupported_extension_is_refused`. `sqlite`:
`a_recursive_view_is_interrupted_at_the_deadline`,
`a_value_past_the_length_limit_is_refused`,
`long_text_is_cut_and_the_page_size_is_clamped`,
`a_split_character_at_the_cut_is_dropped_not_garbled`,
`a_path_outside_the_scope_is_refused` (both commands). Vitest:
`src/__tests__/viewers/SheetSqliteScope.test.tsx` (both viewers pass
`projectId`; crashed/timeout codes render translated; code mapping).

**Gates (at `edff58e5`):** `npm run build` ok; `npm test` 736 files / 7561
passed (a first run under concurrent cargo load had 1 failing test that
passed on the rerun; its name was lost to the RTK-filtered output);
`cargo test -q` 3782 passed, 3 ignored, 0 failed (lib 3614) — a first run
under load failed the timing-based
`api_usage::the_book_writes_on_flush_and_reads_its_file_back` (sleeps past
`FLUSH_DELAY`), which passed alone and in the full rerun; `npm run lint` 0
errors, 28 advisory warnings (unchanged); `cargo clippy --all-targets -D
warnings` clean; `scripts/brand-check.sh` ok; `git diff --check` clean;
`scripts/privacy-check.sh` (staged) clean. macOS and Windows not compiled.
`npm run backend:stale` not run (main agent at landing).

**Choices made:**
- Child = the main binary (`/proc/self/exe` on Linux, so a rebuilt or
  updated binary still execs the running image; `current_exe()` elsewhere),
  stdin/stderr null, `CREATE_NO_WINDOW` on Windows. The reply is the last
  non-empty stdout line (`{"ok": SheetData}` / `{"err": code}`); the child
  writes a newline first. That is what lets the tests run the *test binary*
  as the child (`tests::child_entry`, env `SHEET_READER_TEST_CHILD`) despite
  libtest's preamble.
- Limits: Linux `RLIMIT_AS` = address space at child start + 2 GiB (a fixed
  2 GiB would already be exceeded by the 1 GB debug test binary's mappings),
  `RLIMIT_CPU` 30 s, `RLIMIT_CORE` 0 and `PR_SET_DUMPABLE` 0; macOS
  `RLIMIT_CPU` and core only. Wall 30 s, stdout cap 224 MiB. After the child
  exits the drain thread gets 5 s; a timeout does not wait for it at all (a
  grandchild holding the pipe cannot stall the command).
- Caps: rows 20 000 counted from the first used row (kept from v1:
  truncation, not refusal); grid cells (kept rows × used width) 2 000 000 —
  checked on the sheet's declared `<dimension>` before any cell is read and
  again on the cells — refused past it; cell text 32 KiB, all text 32 MiB.
  The grid starts at the first used row/column as calamine's `Range` did, so
  sheets look as before. `.xls` is parsed by calamine whole inside the child
  (no streaming reader), then the same area check and caps.
- SQLite: progress handler every 1000 VM ops with one 5 s deadline per
  command (open, list, `COUNT(*)`, page); `LENGTH` 16 MiB, `SQL_LENGTH`
  1 MiB, `EXPR_DEPTH` 100; `trusted_schema=OFF`, `query_only=1`; `limit`
  clamped to 1000; text cut to 4 KiB (a split character dropped, `…`
  appended); a page past 32 MiB of cell text is refused. Interrupt and
  TOOBIG map to `viewer-limit:sqlite-timeout`/`-too-large`.
- Confinement copies `read_file_bytes_local` (`confine_project_path` with the
  viewer's scope; root scope = current project + root folder). No remote
  branch: a remote project's non-mirror path never opened locally before
  either; it is now refused as "not in the current project" instead of
  failing to open.
- Errors are fixed `viewer-limit:*` codes mapped to i18n keys by
  `limitError.ts`; any other error (confinement, OS, SQLite) still shows as
  the backend wrote it. No `UntestedTag`: no new feature surface, only error
  strings in existing viewers.
- The TeX workspace has no spreadsheet call site of its own; the mocked
  `read_spreadsheet` in `TexWorkspace.test.tsx` renders `TableView`
  directly, which now passes the scope.

**Gotchas:**
- RTK rewrites `npm run lint` into a global ESLint 6 that finds no config;
  run it as `rtk proxy npm run lint`.
- calamine refuses a CFB *version 4* file whose root has no mini stream
  ("Empty Root directory"); the `cfb` crate's `create` defaults to v4, so
  the test uses `create_with_version(V3, …)`.
- calamine's `get_dimension` subtracts `u32`s unchecked, so a reversed
  `<dimension ref="B2:A1">` panics a debug build — inside the child now, so
  it reads as "reader stopped".

**Flagged for user:**
- **Residual (row 24):** macOS ignores `RLIMIT_AS` and Windows gets no
  limit, so a large-but-possible allocation there uses memory until the 30 s
  kill; only an impossible one aborts at once. A Windows Job object (memory
  limit) would close it.
- **Residual (row 37):** a view with many computed columns each just under
  16 MiB can hold a lot of memory in one row before the deadline.
- **Behaviour changes:** a wide sheet whose first 20 000 rows times its used
  width pass 2 000 000 cells is now refused ("too large to show here")
  instead of shown; a SQLite table holding a value over 16 MiB, or a page
  over 32 MiB of (already cut) text, now errors; `.ods`/`.xlsb` were never
  routed to the viewer and are refused by the command.
- Each spreadsheet open or sheet switch spawns one short-lived child of the
  app binary; it appears in process lists as `tabtivity --sheet-read …`
  (Linux: `/proc/self/exe --sheet-read …`).

**Live click-through (not run):**
1. Open a normal `.xlsx` in a project's file tree: the table shows as
   before; switch sheets with the sheet picker.
2. Open a normal `.xls` and an `.xlsm`: both show.
3. Craft an `.xlsx` with cells at A1 and XFD1048576 and a matching
   `<dimension>` (as the unit test does) and open it: the viewer says the
   spreadsheet is too large; every window and terminal stays up.
4. While a large spreadsheet loads, quit the app: `pgrep -af -- --sheet-read`
   afterwards finds nothing.
5. Open a SQLite file with `CREATE VIEW forever AS WITH RECURSIVE n(i) AS
   (SELECT 1 UNION ALL SELECT i+1 FROM n) SELECT i FROM n;` and click the
   view: after ~5 s the grid says reading took too long; other tables still
   open.
6. Open a normal `.db`: tables list, paging and long text cells (cut with
   `…`) work.
7. Switch the app language to German and repeat 3 or 5: the message is
   German.

## Agent step 5 — reviewer

**Range reviewed:** `91b28c6d..1b657629` (code `edff58e5`) against plan step 8
(backend), gaps 24/37/39 and the agent-step-5 plan review notes.

**Findings:**
1. **Fixed — SQLite limits refused whole databases** (`749cabe9`).
   `SQLITE_LIMIT_SQL_LENGTH` (1 MiB) and `SQLITE_LIMIT_EXPR_DEPTH` (100) also
   apply when SQLite parses the file's own `CREATE` statements at open. One
   ordinary view with a 150-term `a OR b OR …` chain (one depth level per
   term) or a `CREATE` over 1 MiB made every table unreadable ("malformed
   database schema (v) - Expression tree is too large (maximum depth 100)" /
   "string or blob too big"); probed before the fix. `SQL_LENGTH` now equals
   the 16 MiB `LENGTH` limit (which already bounds a schema row's `sql`
   text), `EXPR_DEPTH` is SQLite's default 1000, set explicitly. Test
   `an_ordinary_deep_or_long_view_keeps_the_database_readable`.
   `threat_model.md` row 37 updated.
2. **Checked, no regression — confinement.** `TableView`/`SqliteView` render
   only inside `FileViewerPane`, which publishes the same `projectId` that
   `readFileBytes` uses (popouts, box siblings and root scope included), and
   the commands call the same `confine_abs` as `read_file_bytes_local`. A
   remote project's host path never opened before (both commands read the
   local fs only); a mirror path still opens. No other caller exists: the
   phone app and the TeX workspace never call these commands, and no Rust
   code calls them.
3. **Checked — child process.** Dispatched in `main.rs` before Tauri/GTK and
   after only `hits::install` and `forget_inherited_carriers`; arguments are
   positional (a `-`-leading path or sheet name is data); reaped on every path
   (spawn failure, missing pipe, exit, timeout, quit); stdout framing is the
   last non-empty line of single-line JSON; `/proc/self/exe` matches the
   existing self-exec in `lib.rs`. `/proc/self/statm` stays readable after
   `PR_SET_DUMPABLE 0` (checked), so the `RLIMIT_AS` step is not silently
   skipped. The child starts without WebKit/GTK initialised, so its start
   size is the mapped binary and libraries only.

**Gates (at `749cabe9`):** `npm run build` ok; `npm test` 736 files / 7561
passed; `cargo test -q` 3783 passed, 3 ignored, 0 failed (lib 3615);
`rtk proxy npm run lint` 0 errors, 28 advisory warnings (unchanged); `cargo
clippy --all-targets -D warnings` clean; `scripts/brand-check.sh` ok; `git
diff --check` clean; `scripts/privacy-check.sh` (staged) clean.
`npm run backend:stale` not run (main agent at landing). macOS and Windows
not compiled.

**Flagged for user:**
- **Declared `<dimension>` refusal (row 24).** `read_xlsx` refuses a sheet
  whose *declared* dimension passes the cell cap (kept rows × width > 2 M)
  before reading a cell. calamine's old `worksheet_range` used the dimension
  only as a reserve hint and built the grid from non-empty cells. Excel's
  declared range counts formatted blank cells, so a sheet with formatting
  over more than 100 columns × 20 000 rows and little data used to open and
  is now refused. The check adds no safety: the cell-level caps (`Grid::push`
  2 M cells / 32 MiB text, `finish` area check before allocating) already
  stop the A1+XFD1048576 bomb, which without the declared check shows one
  cell. I left it because the plan's test list asks for a *refusal* there.
  To open such sheets, drop the `check_area` call on `reader.dimensions()` and
  change the first assertion of
  `a_sparse_a1_xfd1048576_sheet_is_refused_without_allocating`.
- No test shows the `RLIMIT_AS` cap applies. The `.xls` bomb asks for
  687 GB, which fails without any limit too.
- The child has no `PR_SET_PDEATHSIG`. If the app is killed rather than quit,
  a running reader lives until its 30 s CPU limit or until its next stdout
  write fails. A clean quit kills it.

## Agent step 6 — implementer (gaps 28, 40, 41, ODT #869)

**Commit:** `f235b678` Bound viewer parsers and catch viewer render errors in
their pane.

**Files:** `src/lib/viewers/yaml.ts` (`MAX_YAML_DEPTH` = 512,
`Parser.checkDepth` at the top of `parseMap`, `parseSeq` and
`parseFlowCollection`, throwing the existing `Bail` with `yamlParse.tooDeep`);
new `src/components/embed/ViewerErrorBoundary.tsx` (boundary, crash card,
read-only source view); `FileViewerPane.tsx` (boundary around
`<Suspense>{view}</Suspense>`, `TEXT_SOURCE_VIEWERS`); `src/lib/viewers/gif.ts`
(screen check before the canvas, frame-larger-than-screen check before
`lzwDecode`); new `src/lib/viewers/odtArchive.ts` (`unzipOdt`), `OdtView.tsx`
uses it, `odt.ts` header; `src/lib/viewers/markdown.ts` (`attrText` split
spelled with `\u0000` escapes; the file now holds no NUL bytes);
`src/styles/viewers.css` (`.viewer-crash-source`); nine new i18n keys in all
five dictionaries (`yamlParse.tooDeep`, `odt.errTooLarge`, `viewerCrash.*`);
`src/lib/untested.ts` row `viewerCrash.title`. Docs: `threat_model.md` rows
28, 40, 41 (**Fixed, not live-verified.**), the ODT tier-2 row (#869 residual
fixed, status ✅) and the Code/YAML row; `filemap_frontend.md`
(`FileViewerPane`, new `ViewerErrorBoundary`, `yaml.ts`, `gif.ts`, new
`odtArchive.ts`).

**Tests added:** `src/__tests__/viewers/ViewerBounds.test.tsx` — deep flow
(`[`×100 000, and 50 000-deep strict JSON) and deep block (`- `×50 000, and
518 indented `k:` maps) each give `yamlParse.tooDeep` with `{max: "512"}` and
no throw; exactly 512 nested levels still parse; a deep `.json` and a deep
`.yaml` rendered through `FileViewerPane` show the tree's notice, not the
crash card; the boundary shows its card for a throwing child, stays on it for
the same key, recovers on Try again and on a new `resetKey`; Show source reads
the file through `read_file_text` into a `<pre>`; two panes side by side — the
ODT pane (mocked viewer throwing a `RangeError`) shows the card while the YAML
pane keeps its unsaved edit and still saves it, and the ODT pane recovers on
the next file. `Gif.test.ts` — a <64-byte GIF claiming 65535×65535 throws
`GifDecodeError` "screen too large" (not a RangeError, so before allocation),
the caller's cap is honoured; a frame claiming 65535×65535 on a 2×2 screen is
refused, after one good frame it ends the stream as truncated.
`odtArchive.test.ts` — only `content.xml` and `Pictures/` come out; a
`content.xml` declaring 2 GiB is refused; an extra part declaring ~4 GiB is
never inflated and the document opens; an over-budget picture listed before
`content.xml` is skipped without spending the body's budget; 10 001 entries are
refused. `Markdown.test.ts` — for inline, local and remote images, no
`md-math`, `<code>` or NUL reaches the output and `alt` is the spans' text.

**Gates (at `f235b678`):** `npm run build` ok; `npm test` 738 files / 7577
passed; `cargo test -q` 3783 passed, 3 ignored, 0 failed (lib 3615); `rtk
proxy npm run lint` 0 errors, 28 advisory warnings (unchanged); `cargo clippy
--all-targets -D warnings` clean; `scripts/brand-check.sh` ok; `git diff
--check` clean; `scripts/privacy-check.sh` (staged) clean. `npm run
backend:stale` not run (no backend change; main agent at landing).

**Choices made:**
- Depth is the node's `path` length: every parser recursion (block map, block
  seq, `- - x`, `- key:`, bare `-`, same-indent seq, flow) adds one path
  segment per level, so one check in the three collection entry points bounds
  them all, and the O(depth²) `path` copies with them.
- The boundary resets on a `resetKey` prop (`viewer` + NUL + `effectivePath`),
  compared in `getDerivedStateFromProps`, not a React `key`: a key would
  remount every healthy viewer (and drop its in-memory state) on each
  Local/Remote flip. It wraps only the viewer (`Suspense` inside it), not the
  presentation overlay.
- It catches only render/lifecycle errors; save, autosave and reload errors
  live in promises and handlers and never reached a boundary. On a catch React
  unmounts the viewer subtree, so `DraftSaver.dispose` flushes the crashed
  pane's draft when autosave is on — the same path as closing the tab.
- "Show source" is a read-only `<pre>` of `read_file_text` (first 2 Mi chars),
  not the code editor: nothing parses it, and it cannot write the persisted tab
  state. Offered for text viewers only (`text`, `markdown`, `tex`,
  `texworkspace`, `html`, `yaml`, `bib`, `eldeck`, `notebook`); binary viewers
  and the diff/merge views (whose `path` means something else) get Try again
  and Open externally only. Card shaped like `RemotePaneHold`
  (`center-placeholder` + `btn-primary`).
- **ODT deviates from the review note's "three XML parts":** `extractOdt`
  reads only `content.xml` (plus `Pictures/` for inline images); `styles.xml`
  and `meta.xml` are never read, so they are not inflated, and images are kept
  — the note's set would have dropped every inline picture. One 64 MiB budget
  from declared sizes (`max(size, originalSize)`), body first; images past it
  are skipped, not refused. Two passes over the central directory (list, then
  inflate by position), so a duplicated name cannot get a second copy past the
  budget. fflate 0.8.3 inflates into a buffer of exactly the declared size and
  never grows it (`inflt` with `st.i == 2`), so the declared size is the real
  bound.
- GIF: the frame check refuses only a frame wider or taller than the screen
  (that is what makes `lzwDecode`'s buffer exceed the screen budget); an offset
  that pushes a screen-sized frame past an edge still draws clipped, as before.
  A refused GIF takes the existing decode-error path (native `<img>` fallback).

**Gotchas:**
- Gap 40 was already fixed: `attrText`'s split held literal NUL bytes
  (`/(\0[CML]\d+\0)/`), which most tools print as spaces — so it read like the
  old ` L0 ` markers. The existing test "resolves code and math in an image alt
  to their text" already passed. The change is the escape spelling plus the
  broader regression test; row 40 says so.
- React 18 in development re-dispatches a caught render error to `window`,
  and jsdom prints it with a stack; the new test file mutes it with a
  `preventDefault` on `window` `error` plus a `console.error` spy.

**Flagged for user:**
- Row 40 was a false positive (see Gotchas); marked fixed with that
  explanation rather than left open.
- ODT keeps inline images (budget-limited) instead of the review note's
  three-XML-parts list; a document whose pictures pass 64 MiB in total shows
  the later ones as missing.
- A crashed pane's unsaved draft survives only with autosave on (the default);
  with autosave off it is lost with that pane, but no longer the window's.
- New UI with an `UntestedTag`: `viewerCrash.title`.

**Live click-through (not run):**
1. In a project, create `deep.json` holding 5000 `[` then 5000 `]`, open it:
   the Tree view says it can't read the file, nesting deeper than 512 levels;
   Source shows the text; the window stays up.
2. Create `deep.yaml` holding `- ` repeated 5000 times then `x`, open it: same
   notice.
3. With an unsaved edit in another tab (autosave off in Settings to see it
   stay dirty), repeat 1: the other tab keeps its edit.
4. Open a normal `.yaml`/`.json`: tree as before.
5. Craft `big.gif` (header `GIF89a`, screen `ff ff ff ff`, a 1×1 frame) and
   open it: the GIF viewer shows its decode-failed note with the native image
   fallback; memory does not jump (watch with a system monitor).
6. Open a normal animated GIF: transport works as before.
7. Open a normal `.odt` with pictures: text and pictures render. Patch a copy's
   central-directory size of `content.xml` to `ff ff ff 7f`: the viewer says
   the document is too large to show.
8. The crash card itself has no in-app trigger left once 1–7 hold; it is
   covered by the unit tests only (the pill stays until the user sees it).

## Agent step 6 — reviewer

**Range reviewed:** `9391be71..88de8592` (code `f235b678`, handoff `88de8592`).

**Findings:**
1. **ODT budget bounded memory, not work — fixed (`739c2647`).** The
   implementer's note that "the declared size is the real bound" holds for
   the buffer only: fflate 0.8.3's `inflateSync` with an `out` buffer keeps
   decoding the whole stream and drops the out-of-range writes. A part
   declaring 1 KiB over a deflate bomb therefore decoded every byte of it;
   measured 3.5 s of renderer main thread per 1 MiB of compressed bomb, so a
   ~64 MiB part (it fits the `max(size, originalSize)` budget) would freeze the
   window for minutes. `unzipOdt` now keeps pass 1 (fflate listing) and the
   selection, then locates each chosen entry's data itself (`dataStarts`,
   the same end-record / zip64 walk `unzipSync` makes) and inflates through
   fflate's streaming `Inflate` in 64 KiB pieces; the first part whose real
   output passes its declared size refuses the file (`odt.errTooLarge`).
   Work is bounded by the budget plus one chunk's expansion (~66 MiB).
   Stored parts are copied as before; images are still kept.
2. YAML/JSON depth cap — no bug. Depth is `path` length (keys/indices from
   the root), checked in `parseMap`, `parseSeq` and `parseFlowCollection`;
   indentation columns, `- key:` items and same-indent sequences under a key
   each add exactly one segment per real collection level, so k8s manifests,
   workflows, OpenAPI specs and lockfiles stay far below 512. The editing
   functions never re-enter the parser with a path offset, so surgical edits
   are untouched; a file past the cap just falls back to Source.
3. Error boundary — no bug. `resetKey` = viewer + effective path covers file,
   viewer-kind and Local/Remote switches; popouts render through the same
   `TabPane` → `FileViewerPane`. A same-path external fix needs Try again
   (the crashed viewer is unmounted, so nothing polls) — acceptable. The card
   is in-pane (not portaled), so it inherits the pane's colour, and copies
   `RemotePaneHold`'s classes. Show source goes through `read_file_text`,
   which the backend caps at 8 MiB and UTF-8, then shows ≤ 2 Mi chars.
   Open externally calls the pane's existing `openExternally`
   (`open_file`), the same callback every viewer header already offers for
   the same file, behind a click — no new no-prompt launcher; files with no
   viewer (gap 21) never reach `FileViewerPane`.
4. GIF — no bug for valid files: exactly screen-sized frames, offset frames
   (clipped as before) pass; a zero-size logical screen was already refused
   before this change. A screen over the budget now throws instead of
   ending with zero frames — both callers (`GifView`, deck `deckAssets`)
   catch it.
5. Markdown — the old split already held literal NULs (verified with
   `cat -A` on `9391be71`); the `\u0000` spelling is byte-equivalent output.
6. i18n: nine keys in all five dictionaries; `UntestedTag` id
   `viewerCrash.title` matches its register row.

**Tests added (`odtArchive.test.ts`):** a content.xml and a picture each
declaring 1 KiB over 8 MiB of zeros are refused (both fail on `f235b678`,
which returned a silently truncated part); content.xml plus a deflated and a
stored incompressible picture spanning several 64 KiB pushes come out byte for
byte.

**Gates (at `739c2647`):** `npm run build` ok; `npm test` 738 files / 7580
passed; `rtk proxy npm run lint` 0 errors, 28 advisory warnings (unchanged);
`scripts/brand-check.sh` ok; `git diff --check` clean;
`scripts/privacy-check.sh` (staged) clean. No Rust touched: cargo not run.
`npm run backend:stale` not run (per instructions).

**Flagged for user:**
- GIF: a frame wider or taller than the logical screen is now refused
  (per the plan's review note) where it used to draw clipped. Such files
  break the GIF spec but exist; the first-frame case falls back to the native
  `<img>` (which browsers render by growing the screen), a later frame ends
  the animation as truncated. A looser bound (`w*h*4 ≤ maxPixelBytes`) would
  keep them animated with the same memory bound, if wanted.
- ODT: a part whose real size disagrees with its declared size now refuses
  the whole document (a real archive never does that; previously it rendered
  truncated or padded).
- Viewers that never offered Open externally (`syncmerge`, `gitmerge`) get it
  on the crash card, opening the pane's `path` with the OS handler on click.

## Agent step 7 — implementer (gaps 35, 36; plan steps 13, 14)

**Commit:** `f3260ec6` Hold the rsync pull fast path and TeX previews to
their confinement.

**Files:** `services/remote_sync.rs` (new `rsync_pull_flags`, `rsync_pull_args`
builds on it; `rsync_may_transfer`, `rsync_pulled_base`); `commands/sync.rs`
(`try_rsync_pull` leaves files over the cap out of the list; the record loop
after an rsync uses `rsync_pulled_base`); `commands/tex.rs`
(`OPENOUT_PARANOID` set in `run_in_within_env`, `preview_env(scratch)`,
`preview_engine`, `PREVIEW_NO_LUATEX`, `preview_main_file`; the preview run and
the preview format build use them); `services/sandbox.rs` (login-dirs line
deleted from the mount list comment). Docs: `threat_model.md` rows 35, 36
(**Fixed, not live-verified.**), the byte-sync tier-0 row, the TeX hover
preview tier-2 row, the build/TeX compile row, and the Send-to-desktop upload
in the phone-bridge row; `remote_sync_guide.md` §2.5; `context/git_sync.md`
(rsync bullet); `filemap_backend.md` (`tex.rs`, `remote_sync.rs`).

**rsync argv now:** `-t -c --no-links --no-devices --no-specials
--max-size=67108864 --exclude=/.git --exclude=.tabtivity --exclude=.git
--from0 --files-from=<list> -e <ssh …> <host:src/> <dest/>`. Kept: timestamps
(`-t`), checksum compare (`-c`), the NUL files-from list, the excludes, the
ControlMaster ssh transport, and the local/host availability probes with their
SFTP fallback (untouched).

**Tests added/changed:**
- `remote_sync.rs`: the args test asserts `-t`/`-c`, no `-a --archive -r
  --recursive -l --links -D -p -o -g`, no bundled short flags, and the
  presence of `--no-links --no-devices --no-specials --max-size=<cap>`;
  `rsync_size_gate_matches_the_floor`;
  `rsync_pulled_base_records_only_regular_files_within_the_cap` (regular file
  yes; host-listed over cap, missing, directory, sparse over-cap file, symlink
  to a file, FIFO no); `rsync_pull_flags_land_only_listed_regular_files_within_the_cap`
  runs the real flags local→local (rsync 3.4.1 here): a listed path under a
  dir swapped for a FIFO, a listed FIFO, a listed path that became a directory
  full of unlisted files, a symlink and a 64 MiB + 1 file never land; the
  listed regular file lands with its mtime. Skips without rsync on PATH.
- `tex.rs`: `a_preview_never_enables_shell_escape` also asserts
  `openin_any=p`, `TEXMFOUTPUT=<scratch>` and `OPENOUT_PARANOID`;
  `a_hover_preview_never_runs_luatex` (pure: explicit non-Lua engines kept
  without reading the preamble; Lua hint or `% !TEX program = lualatex` → no
  preview even with LuaLaTeX requested; LuaLaTeX request → pdfLaTeX, fontspec
  → XeLaTeX, else pdfLaTeX; only LuaLaTeX installed → no preview; Build's
  `engine_for_hint` still picks LuaLaTeX); `a_hover_preview_reads_only_below_the_document`
  (real engine, in a `/tmp/.tmpXXXX` dot dir like the state dir: absolute
  `\input` refused — and only because of the mode, a control run with
  `openin_any=a` reads it — `../` refused, relative `\input{macros}` plus
  `amsmath` typesets, a decoy `p.tex` in the document folder is not used);
  `a_build_engine_run_confines_luatex_writes` (real LuaLaTeX: with
  `openout_any=a` reaching the engine `io.open` writes an absolute path; through
  `run_in_within_env` neither the absolute nor the `../` write lands and the PDF
  is built). The existing #867 end-to-end test now picks pdfLaTeX/XeLaTeX only.

**LuaTeX write check (review note):** on LuaHBTeX 1.22.0 (TeX Live
2025/Debian, `texmf.cnf` `openout_any = p`, `openin_any = a`), a Build-like
`lualatex -no-shell-escape -output-directory=…` run of a document whose
`\directlua` does `io.open("<abs>", "w")` and `io.open("../x", "w")`, plus an
`\openout` to an absolute path: with the environment unset and with
`openout_any=p` all three are refused; with `openout_any=a` in the
environment all three are written. So LuaTeX's `io.open` honours
`openout_any`, the environment outranks `texmf.cnf`, and Build was confined
only by the distribution default. **Chosen:** every engine run sets
`openout_any=p` itself (one `.env` in `run_in_within_env`, after the inherited
environment, before the caller's `envs`) — Build through latexmk (which hands
the environment to the engine), the direct engine path, bibtex, the document
and preview format dumps and previews. `io.open` reads stay open on LuaTeX
(`/etc/hostname` read fine under `openin_any=a`), and LuaLaTeX does not start
at all under `openin_any=p` (luaotfload cannot open its font cache), so Build
gets no `openin_any`.

**Choices made:**
- **Wrapper by name, not path (deviation found by the test):** kpathsea's
  paranoid input mode refuses any path with a dot component
  (`TEXMFOUTPUT` set or not — measured), and the preview scratch dir is
  `~/.local/share/tabtivity/tex-preview/…` on Linux. Passing the absolute
  wrapper path would have broken every preview there. The preview run and its
  format build now pass `tabtivity-preview.tex` by name; web2c looks in
  `-output-directory` first, so the scratch copy wins even over a same-named
  file in the document folder (tested). `-fmt=<abs dotted path>` is not
  subject to the check (measured, and the format run typesets).
- `TEXMFOUTPUT` is pinned to the scratch dir in `preview_env`, so a user's own
  `TEXMFOUTPUT` cannot widen where a preamble reads by absolute path.
- Preview engine: the requested engine is used if installed and not LuaLaTeX
  (no preamble scan, same cost as before); otherwise the preamble hint decides
  with LuaLaTeX removed — Lua hint or a LuaLaTeX magic comment → `Err("no
  hover preview for a LuaLaTeX preamble")`, which the hover card shows like
  any failed preview (no new UI, no new string key — backend errors were
  English already). A fontspec preamble previews with XeLaTeX (verified under
  `openin_any=p`), else pdfLaTeX (fails over to the existing body-only
  fallback document).
- rsync: no `--no-recursive` added (the review note's "drop `--recursive`" is
  the spec; `--files-from` never implies `-r`). Files over the cap are
  filtered before the list is written; if nothing within the cap remains, the
  fast path is skipped (the SFTP floor refuses them per file as before).
  After rsync, a listed file over the cap, or a local path that is not a
  regular file (lstat) or exceeds the cap, is not recorded and is reported
  with the existing `sync_pull: skip` line. Nothing that rsync left on disk is
  deleted (destructive moves in the mirror are out of scope).

**Gates (at `f3260ec6`):** `npm run build` ok; `npm test` 738 files / 7580
passed; `cargo test -q` 3789 passed, 3 ignored, 0 failed (lib 3621, +6);
`rtk proxy npm run lint` 0 errors, 28 advisory warnings (unchanged); `cargo
clippy --all-targets -D warnings` clean; `scripts/brand-check.sh` ok; `git diff
--check` clean; `scripts/privacy-check.sh` (staged) clean. `npm run
backend:stale` not run (per instructions).

**Gotchas:**
- `tempfile::tempdir()` lives in `/tmp/.tmpXXXX` — a dot dir — so any test
  that runs TeX under `openin_any=p` with an absolute input fails there for
  the same reason production would under `~/.local/share`.
- The existing #867 end-to-end test (`…runs_no_shell_command…`) skips on this
  Debian TeX Live ("pdflatex ignores shell_escape=t here"); new engine checks
  went into their own tests so they do not hide behind that skip.
- rsync exits 23 when a listed path vanished or turned into something else;
  `rsync_pull_dir` treats any non-zero exit as failure, so such a race falls
  back to the SFTP floor (as before).
- The test suite writes nothing to the state dir for the new tests; there is
  no end-to-end `preview_snippet_blocking` test because the state dir is not
  isolated in tests (it would write the real `~/.local/share/tabtivity`).

**Flagged for user:**
- **Residual (row 35):** `--max-size` is enforced from sizes the host's own
  rsync reports; a host account that replaces `rsync` on its PATH can still
  land a big file in the mirror (left unrecorded, not deleted).
- **Residual (row 36):** a Build of a document that asks for LuaLaTeX still
  runs LuaTeX with reads open (it cannot run under `openin_any=p`); TeX Live
  < 2023 without the CVE-2023-32700 patch remains exposed on Build. MiKTeX
  ignores both kpathsea variables.
- **Behaviour changes:** a LuaLaTeX-only preamble (luacode, `\directlua`,
  luatexja, `% !TEX program = lualatex`) no longer gets hover previews; a
  fontspec preamble previews with XeLaTeX instead of LuaLaTeX (fonts may
  differ slightly); a preamble that `\input`s an absolute path or `../` gets
  no preview. A user whose `texmf.cnf` set `openout_any = a` can no longer
  have a Build write outside the document folder / output dir. On an old
  macOS rsync 2.6.9 or Apple's openrsync, an unknown flag makes rsync fail and
  the pull falls back to SFTP (slower, same result) — not checked on macOS.
- No `UntestedTag`: no new UI.

**Live click-through (not run):**
1. Remote project with rsync on both ends: Remote tree → right-click a folder
   holding a few files → Pull. Files arrive, rows go green, timestamps match
   the host.
2. On the host, `mkfifo pipe` and `truncate -s 70M big.bin` inside that
   folder, Pull again: neither appears in the mirror; the rest still pulls.
3. TeX: in a `.tex` with a plain `amsmath` preamble and `\input{macros}`
   (a `macros.tex` beside it), hover `$\frac{a}{b}$`: the preview renders and
   uses the macros.
4. Add `\usepackage{luacode}` to the preamble and hover again: the card shows
   "no hover preview for a LuaLaTeX preamble". Press Build: it still builds
   with LuaLaTeX.
5. Replace with `\usepackage{fontspec}` and hover: the preview renders (via
   XeLaTeX).
6. Add `\input{/etc/hostname}` to a preamble and hover: no preview; Build is
   unchanged by this step (reads stay open on Build).
7. With `openout_any=a` exported in the environment that starts Tabtivity, Build
   a LuaLaTeX document whose `\directlua` does
   `io.open("/tmp/tt-escape.txt","w")`: no `/tmp/tt-escape.txt` appears; the
   PDF builds.

## Agent step 7 — reviewer

**Range:** `a783c001..c949f046` (code `f3260ec6`). **Fix:** `3854356d` (docs and
a test comment only).

**Findings:**
1. **Doc overstated the preview's read confinement — fixed (`3854356d`).**
   `openin_any=p` checks the *name* a preamble asks for, not where it lands:
   a symlink inside the document folder (`link -> /elsewhere`, which a cloned
   repo can carry) is still followed. On TeX Live 2025, with `openin_any=p`,
   `\input{link/s}` read a file outside the folder. `threat_model.md` row 36
   and the Tier-2 hover-preview row now say "by name" and list it as a
   residual (pdfLaTeX/XeLaTeX only; writes stay confined, and LuaTeX never
   runs on a hover). No code change: refusing symlinks is a design call (see
   Flagged). The test doc comment that still said the wrapper goes by absolute
   path is corrected. Docs only, so there is no regression test.
2. **Build under `openout_any=p` — no regression found.** TeX Live's own
   `texmf.cnf` default is already `p` (Debian TL 2025 here: `openout_any = p`,
   `openin_any = a`), so a Build changes only for someone who overrode it to
   `a`. The engine checks the relative name before it prepends
   `-output-directory`, so a project or output dir under a dotted path is
   fine. Measured with `openout_any=p`, the project in `.proj/` and latexmk
   4.87:
   `-outdir=<abs>/.proj/.build` with bibtex and makeindex, and
   `-outdir=../rel-build` with `\include{sub/ch}` (latexmk makes the subdir
   and reruns), both built every artefact.
3. **Dotted state dir for previews — verified OK.** A wrapper named by
   absolute path is refused under a dot dir. Named by file name, it works,
   even with the doc folder itself dotted. A format dumped under `openin_any=p`
   and loaded with `-fmt=<abs dotted path>` typesets. So does XeLaTeX with
   `fontspec` and `unicode-math` in a dotted dir.
4. **Preview engine fallback** only picks from installed, non-Lua engines.
   An `Err` (Lua preamble) is cached by `renderTexPreview` like any failure
   and is shown on the card. No bug.
5. **rsync flags on old/foreign rsync — verified from source, no bug.**
   rsync 2.6.9 `options.c` has `no-links`, `no-devices`, `no-specials`,
   `max-size`, `from0` and `files-from`, and `--files-from` there sets
   `xfer_dirs=1` (implied `--dirs`) and cancels `-a`'s recursion. Apple's
   openrsync (`apple-oss-distributions/rsync`, `openrsync/main.c`) has every
   flag used. An unknown option would exit non-zero (`ERR_SYNTAX`), and
   `rsync_pull_dir` → `try_rsync_pull` would fall back to SFTP. So the
   implementer's "unknown flag on macOS" caveat does not arise.
6. **Manifest / local_loss — no bug.** An over-cap or non-regular file is
   never recorded. A stale earlier entry is left as it was, which matches the
   SFTP floor. Deletion propagation keys on "in manifest, missing locally",
   and nothing here removes a local file, so a skipped file cannot turn into
   a pushed deletion.
7. **Inbox doc row** matches `host.rs` `global_inbox_upload` and
   `inbox.rs`: `authenticate` plus `exact_origin` and no catalog lookup, 24
   MiB per file, 1 GiB in total, `<stamp>-<safe name>`, `create_file`
   (create_new), `<state_dir>/inbox`.
8. **Tests** skip cleanly without TeX or rsync. CI installs no TeX, so the
   engine tests run only locally.

**Gates (at `3854356d`):** `npm run build` ok; `npm test` 738 files / 7580
passed; `cargo test -q` 3789 passed, 3 ignored, 0 failed (lib 3621); `rtk
proxy npm run lint` 0 errors, 28 advisory warnings (unchanged); `cargo clippy
--all-targets -D warnings` clean; `scripts/brand-check.sh` ok; `git diff
--check` clean; `scripts/privacy-check.sh` (staged) clean. `npm run
backend:stale` not run (per instructions).

**Flagged for user:**
- **Preview reads through in-folder symlinks** (finding 1). Could be closed
  by refusing a preview whose preamble's `\input`/`\usepackage` targets
  resolve outside the folder, or by running previews in a fence. The
  read lands only in the local hover card (pdfLaTeX/XeLaTeX have no network
  or command channel there), so it is left as a documented residual.
- **Multi-file previews degrade to the body-only fallback:**
  `\documentclass[../main.tex]{subfiles}` (when the chapter is its own root)
  and `\input{../preamble}` are now refused under `openin_any=p`, so such a
  hover renders without the macros and with the fallback note. This is the
  plan's choice; say so if it should widen to the project root instead.
- **A Lua-only preamble gets no preview at all.** It could instead render
  the body-only fallback document under pdfLaTeX, as other failed preambles
  do. That is a UX choice, not a bug.
- **Files over 64 MiB in a pulled folder are skipped silently.** Before,
  they arrived on the rsync path. The SFTP floor already behaved this way:
  only `eprintln!("sync_pull: skip …")`, and the pull still counts them as
  done. The row stays "host only", but there is no toast. Research datasets
  hit this.
- **macOS CI** now runs the real-rsync test with Apple's rsync/openrsync.
  The flags are supported (finding 5), but the exact exit code for a vanished
  listed path (asserted `0 | 23`) is not checked on openrsync. Watch the
  first macOS run.

## Final review

**Range:** `6c420e42..a8064db4` (steps 1–7 with their reviews), reviewed as a
whole; per-step reviews not redone.

**Fix commits:** `7c8b87a0` (Rust + docs: hooks in place, sheet dimension,
reader death signal, Lua preamble preview), `3ed6003f` (frontend: GIF frame
bound, merge-view crash card).

### Part A — whole-range findings

- **Steps 2/3/4 in one `prepare` compose.** Order: `adopt_legacy_env` →
  `strip_control_env` (step 2) → … → `SpawnGeneration::begin` → `grant_lanes`
  (inserts the push token after the strip, so a planted `GIT_TOKEN` can never
  be the one stamped) → push token read → fence `match` (step 4's
  `local_model_mounts` + `verify_control_pins` inside `wrap_pty_options_bwrap`;
  a refusal returns, the generation abandons, the token guard revokes) → stamp
  (step 3) → `export_both` → tmux wrap. `terminal/mod.rs` seq plumbing and
  `home_io` additions (step 4 readers, step 1 login I/O) do not overlap.
- No leftover TODO/FIXME/`dbg!`/`console.log` in the range.
- i18n: all 16 new/changed keys (`settings.agentLoginsHelp`, six
  `viewerLimit.*`, `yamlParse.tooDeep`, `odt.errTooLarge`, seven
  `viewerCrash.*`) are in all five dictionaries and used.
- `UntestedTag`: the one pill (`viewerCrash.title`) has its register row
  (row text updated for the merge-view change).
- Filemap rows exist for `sheet_reader.rs`, `limitError.ts`, `odtArchive.ts`,
  `ViewerErrorBoundary.tsx`; updated for this review's changes (`home_io.rs`,
  `sheet_reader.rs`, `tex.rs`, `gif.ts`, `ViewerErrorBoundary.tsx`).
- `threat_model.md`: rows 16, 17, 18, 24, 28, 29, 30, 35, 36, 37, 39, 40, 41
  all read "**Fixed, not live-verified.**" with residuals. **Fixed here:**
  tier-2 rows that cite them were stale — the SQLite row still said only
  "opened read-only; table names quoted" (now names the row 37/39 bounds), no
  spreadsheet or GIF row existed (added, citing rows 24/39 and 41), and the
  agent-push row did not say the preflight's fence comes from the scope the
  push token recorded (gap 18). Rows 24, 30, 36, 41 and the hover-preview row
  updated for Part B.
- brand-check, `git diff --check`, privacy-check over `6c420e42..HEAD`: clean.

### Part B — decided fixes (each with a regression test)

1. **`hooks.toml` rewritten in place.** New `HomeFile::write_in_place`: opens
   the name `O_WRONLY|O_NOFOLLOW|O_NONBLOCK` relative to the handle, writes
   only into a regular file with one link (offset 0, then `set_len`), creates
   a missing one `O_EXCL` (so two racing creators share one inode), and falls
   back to temp + rename for a link, FIFO, socket or hard link. Used by the
   app-owned (local-model) branch of `write_vibe_hooks`. Tests:
   `agent_session::a_hooks_rewrite_between_pin_and_verify_keeps_the_pin_valid`
   (fails with the old `write`, checked),
   `home_io::an_in_place_write_keeps_the_inode_and_replaces_what_is_not_plain`.
2. **Declared `<dimension>` no longer refuses a sheet.** Test renamed
   `a_sparse_a1_xfd1048576_sheet_never_allocates_its_box` (first assertion now
   "one cell"); new `a_huge_declared_dimension_with_few_cells_opens`.
3. **Reader child dies with the app (Linux).** `die_with_parent` in a
   `pre_exec`: `PR_SET_PDEATHSIG(SIGKILL)` then `getppid()` against the
   captured parent pid (no allocation). The kernel's "parent" is the spawning
   *thread*; `run_reader` waits for the child on that thread (inside
   `spawn_blocking`), so it outlives the child. Test:
   `the_reader_child_dies_with_its_parent` (spawned from a thread that ends,
   child gets SIGKILL).
4. **GIF frame bound by memory.** `w*h*4 > maxPixelBytes` refuses before
   decoding; an oversize frame within it decodes and draws clipped. Tests:
   "refuses a frame claiming a huge size before decoding it" (GifDecodeError,
   and truncation after a good frame under a small cap), "animates a frame
   wider than the screen, drawn clipped".
5. **Crash card on merge views.** `onOpenExternally` is `null` for
   `syncmerge`/`gitmerge` (`NO_OPEN_EXTERNALLY_VIEWERS`), and the card leaves
   the button out. Test: "offers no Open externally for the merge views…"
   (fails without the fix, checked; a file viewer still offers it).
6. **LuaLaTeX preamble → body-only preview.** `preview_engine` returns
   `PreviewPlan::{Preamble, BodyOnly}`; a Lua hint gives `BodyOnly(pdflatex)`
   (else another non-Lua engine; only LuaLaTeX installed → still no preview),
   and the run goes straight to `fallback_preview_document` (no format dump,
   preamble never run), reported with `fallback: true`. Test:
   `a_hover_preview_never_runs_luatex` rewritten for the plan.

### Gates (at `3ed6003f`)

`npm run build` ok; `npm test` 738 files / 7582 passed; `cargo test -q` 3793
passed, 3 ignored, 0 failed (lib 3625); `rtk proxy npm run lint` 0 errors, 28
advisory warnings (unchanged); `cargo clippy --all-targets -D warnings` clean;
`scripts/brand-check.sh` ok; `git diff --check` clean;
`scripts/privacy-check.sh` clean (staged and `6c420e42..HEAD`). No flakes this
run. `npm run backend:stale` not run (per instructions). macOS/Windows not
compiled.

### Flagged for user (consolidated, all steps)

- **Step 1 Host-home cleanup (superseded: follow-up step 8 renames aside):** the first
  start removes a Vibe/Aider/mini-swe-agent/Cline login file from the Host
  home when it matches the store or its placed record, including one the user
  made there; sign in again in the Host session. Alternative: rename aside.
  Same on a small scale for CodeBuddy `.logged-out` markers/backups.
- Step 1: those four CLIs now sign in once per project; Goose `secrets.yaml`,
  OpenCode `auth.json`, Qoder `.auth` still shared (not re-surveyed); old
  recursive-import subdirectories in `agent-auth/{kimi,codebuddy}` stay as dead
  data; Sign out leaves CodeBuddy logout backups/Kimi temps in their own home.
- Step 2: adopted/imported tabs lose their `env` (custom agents get this
  machine's settings env); state-dir layouts lose denylisted variables
  (`PATH` for a shell tab included); `workspace_sync` serves stored tabs raw
  (no untrusted writer today); headless relaunch of an adopted agent tab before
  a window re-saves it has no `TAB_UID`; persisted `CARGO_HOME`/`RUSTUP_HOME`/
  `DOCKER_CONFIG` still win on macOS/Windows/Host session.
- Step 3: closing a tab while its spawn is still in `prepare` lets that PTY
  start orphaned (pre-existing); overlapping spawns where the newer fails can
  end the older one's tokens; spawns in `prepare` at quit escape `kill_all`;
  headless `TabSpawns` entries never torn down (bounded); whether an agent in a
  re-attached tmux session can still push is unverified; no test drives
  `prepare` to the stamp itself. Windows push with a `pre-push` hook now says
  `fence_unavailable`.
- Step 4: residual of gap 30 (bwrap/Seatbelt open the control paths by name
  after the check; needs `--ro-bind-fd`); a local-model tab whose control path
  cannot be set up is now refused; macOS arm not compiled. (The concurrent
  `hooks.toml` refusal and mount detach flagged by the step 4 reviewer are
  fixed here.)
- Step 5: macOS ignores `RLIMIT_AS`, Windows has no limit (Job object would
  close it); a SQLite view with many near-16 MiB computed columns; no test
  shows `RLIMIT_AS` applies; a SQLite value over 16 MiB or a page over 32 MiB
  now errors; each spreadsheet open spawns a short-lived `--sheet-read` child.
- Step 6: ODT keeps inline images within a 64 MiB budget (later pictures
  missing past it) and refuses a part whose real size disagrees with its
  declared size; a crashed pane's draft survives only with autosave on; gap 40
  was a false positive (marked fixed with that note).
- Step 7: residual — `--max-size` trusts the host rsync's sizes; a LuaLaTeX
  Build still reads freely; MiKTeX ignores the kpathsea variables; previews
  follow in-folder symlinks by name; multi-file previews (`subfiles`,
  `\input{../preamble}`) degrade to body-only; files over 64 MiB in a pulled
  folder are skipped with no toast; watch the first macOS CI run of the
  real-rsync test (exit code for a vanished path on openrsync).
- This review: `write_in_place` is not atomic for a reader (Vibe could read a
  half-written `hooks.toml` during the rare rewrite; it then fails to parse
  that one file once); `PR_SET_PDEATHSIG` is Linux-only (macOS/Windows readers
  still live to their wall/CPU limit if the app is killed).

### Live click-through (consolidated, not run)

Linux, the frozen dev build with these commits.

1. **Logins (step 1):** in a project, sign in to Vibe; open Vibe in a second
   project: it asks to sign in again. Put `.vibe/.env` into Settings → Agent
   sandbox → Global agent config: both projects start signed in.
2. **Tab layouts (step 2):** import a `.tabtivityproj` (or adopt a folder
   layout) whose shell tab carries `env: {"LD_PRELOAD": "/x", "PATH": "/x"}`
   and an agent tab with `TABTIVITY_HOST_SESSION=1`; open them: `env` in the
   shell shows neither; `claude` typed in it runs fenced; the agent tab keeps
   its turn marks (TAB_UID rebuilt).
3. **Push preflight (step 3):** local project with `.githooks/pre-push`, agent
   pushes on Propose; remount the Claude tab a few times (move it between
   panes); ask it to commit and `git_push`: the hook output shows on the card,
   a hook doing `touch ~/preflight-probe` leaves nothing in `$HOME`; with the
   API-key proxy on, model calls and turn marks still work after the remount;
   closing the tab drops its MCP session.
4. **Records (step 4):** `mkfifo` over a Claude tab's `.turn` record; other
   tabs' working/done marks keep updating. `mkfifo <project>/.git/commondir`
   (with `.git` a folder); a new agent tab still starts. Remove the FIFOs.
5. **Local model (steps 4 + this review):** with no local-model tab open,
   delete `<state_dir>/vibe_local/<model>/hooks.toml`, then open two tabs of
   that model at once (e.g. restore a layout holding both): both start. With
   one running, append a line to its `hooks.toml` and open another: it starts,
   the file is reset, and in the first tab `echo x >> $VIBE_HOME/hooks.toml`
   still fails (read-only bind kept). Replace `tools` with a symlink and start
   a tab: it starts and `tools` is a folder again.
6. **Spreadsheets (step 5 + this review):** a normal `.xlsx`, `.xls`, `.xlsm`
   open and switch sheets. An `.xlsx` with cells at A1 and XFD1048576 shows one
   cell, every window stays up. A sheet with formatting over ~200 columns ×
   30 000 rows and little data opens. While a large sheet loads, `kill -9` the
   app: `pgrep -af -- --sheet-read` finds nothing afterwards (also after a clean
   quit).
7. **SQLite (step 5):** a recursive view errors after ~5 s ("reading took too
   long") while other tables still open; a normal `.db` lists, pages, cuts long
   text with `…`; in German the messages are German.
8. **YAML/JSON + crash card (step 6 + this review):** `deep.json` with 5000
   `[`…`]` and `deep.yaml` with `- `×5000 show the 512-levels notice; another
   tab's unsaved edit survives. (The crash card itself has no in-app trigger;
   unit tests only. On a merge view it would show no Open externally.)
9. **GIF (step 6 + this review):** a GIF claiming `ffff×ffff` shows the
   decode-failed note with the native image, memory flat; a normal animated
   GIF plays; a GIF with one frame larger than its screen (out-of-spec export)
   animates, clipped.
10. **ODT (step 6):** a normal `.odt` with pictures renders; a copy with
    `content.xml`'s central-directory size patched to `ff ff ff 7f` says too
    large.
11. **rsync pull (step 7):** Pull a remote folder: files arrive with host
    timestamps; a host-side FIFO and a 70 MB file in it do not appear.
12. **TeX (step 7 + this review):** hover a formula under a plain `amsmath`
    preamble with `\input{macros}`: renders with the macros. Add
    `\usepackage{luacode}`: the hover renders the formula without the preamble
    (fallback note), and Build still builds with LuaLaTeX. With `fontspec`:
    renders (XeLaTeX). `\input{/etc/hostname}` in a preamble: falls back.
    With `openout_any=a` exported when Tabtivity starts, Build a LuaLaTeX
    document whose `\directlua` does `io.open("/tmp/tt-escape.txt","w")`: no
    file appears, the PDF builds.

## Follow-up step 8 — implementer (user decisions 2026-10-09: gap 16 rename, gap 35 notice)

**Commits:** `f5b86a5b` Rename retired Host-home login copies aside instead of
deleting them; `3e79717d` Name the files over 64 MiB a folder pull leaves on
the host.

**Files (gap 16):** `services/home_io.rs` (`HomeFile::rename_aside` +
`rename_noreplace`: `renameat2(RENAME_NOREPLACE)` on Linux glibc,
`renameatx_np(RENAME_EXCL)` on macOS, else — and on `EINVAL`/`ENOSYS`/`ENOTSUP`
— an `fstatat` check before `renameat`; Windows path-based),
`services/agent_auth.rs` (`PRE_SCOPE_SUFFIX`, `move_aside`; used by
`retire_shared_paths_in` for the Host copy and by `retire_dir_names` for a
home's copy of an unlisted name; doc comment), `docs/threat_model.md` row 16,
`docs/context/agent_authority.md` (retire paragraph + login-folder sentence),
`docs/help/agent-clis.md` (Sign in: the `.pre-scope` file),
`docs/filemap_backend.md` (`agent_auth.rs`, `home_io.rs`).
`settings.agentLoginsHelp` (en/de/es/fr/it) does not mention removal, so it
is unchanged.

**Files (gap 35):** `services/remote_sync.rs` (`SkippedFile`, `PullOutcome`
with `tally`, `rsync_transfer_list`; `pull_file` now wraps `pull_file_with`,
which takes the host read as a closure), `commands/sync.rs` (`sync_pull`,
`sync_whole_project`, `pull_subtree` return `PullOutcome`; `try_rsync_pull`
uses `rsync_transfer_list`), `src/stores/remote/sync.ts` (`SyncSkippedFile`,
`SyncPullOutcome`, `toPullOutcome`; `pull`/`syncWholeProject` return it),
new `src/components/files/SyncSkippedLarge.tsx`, `FileTree.tsx` (Pull result
line; take-host in the push-conflict queue), `ProjectFilesPane.tsx` (*Sync
all* result line), `i18n.ts` + de/es/fr/it (`projectFilesPane.syncSkippedLarge`,
`…SyncSkippedShow`, `…SyncSkippedHide`), `src/lib/untested.ts`
(`projectFilesPane.syncSkippedLarge`), docs: `remote_sync_guide.md` §2.5 +
symptom row, `threat_model.md` row 35, `filemap_backend.md` (`remote_sync.rs`),
`filemap_frontend.md` (new `SyncSkippedLarge.tsx` row).

**Tests added/changed:**
- `agent_auth.rs`: `retiring_a_shared_path_keeps_scope_copies_and_clears_the_hosts`
  now asserts the Host copies (store-equal Vibe, placed-record Cline) are at
  `<name>.pre-scope` with their content, the original names are gone, the
  divergent Aider copy is not moved, fenced/local homes have no `.pre-scope`,
  and a second run leaves exactly one `.pre-scope` (no `.1`);
  new `retiring_a_host_copy_picks_a_free_pre_scope_name` (`.pre-scope` and
  `.pre-scope.1` taken → `.pre-scope.2`, the old ones untouched);
  new `retiring_keeps_the_store_when_the_host_copy_cannot_be_moved` (read-only
  `.vibe` → store and Host copy kept; next run renames and drops the store;
  skips as root); `retiring_drops_unlisted_names_from_login_folders` now
  asserts `x.env.pre-scope` with content in the matching homes, none in the
  divergent one, and that a keeper pass neither adopts nor places it (store
  unchanged, a new home gets only `kimi-code.json`), second run no `.1`;
  `no_registry_row_shares_an_env_or_config_file` also asserts no
  `auth_paths` contains `.pre-scope` and no `DirNames` admits
  `<name>.pre-scope[.1]`.
- `home_io.rs`: `a_rename_aside_takes_a_free_name_and_never_follows_a_link`.
- `remote_sync.rs`: `a_pull_reports_files_over_the_cap_on_the_rsync_path`
  (real rsync local→local with `rsync_transfer_list` + `rsync_pull_flags`,
  `rsync_pulled_base` + `tally`; skips without rsync),
  `a_pull_reports_files_over_the_cap_on_the_sftp_path` (`pull_file_with`
  over a local "host": the big file is never read, the rest lands),
  `a_pull_outcome_is_camel_case_and_defaults_to_nothing_skipped`.
- Frontend: new `src/__tests__/files/SyncSkippedLarge.test.tsx` (count +
  names with sizes; nothing for an empty list; five files fold behind
  Show files / Hide files); `SyncStore.test.ts` (both actions return the
  outcome; a bare-count answer reads as nothing skipped).

**Gates (at `3e79717d`):** `npm run build` ok; `npm test` 739 files / 7586
passed; `cargo test -q` 3799 passed, 3 ignored, 0 failed (lib 3631) — first
run had 1 failure, the known timing flake
`commands::sqlite::tests::an_ordinary_deep_or_long_view_keeps_the_database_readable`
(`viewer-limit:sqlite-timeout`, run concurrently with `npm test`); rerun
clean; `rtk proxy npm run lint` 0 errors, 28 advisory warnings (unchanged);
`cargo clippy --all-targets -D warnings` clean; `scripts/brand-check.sh` ok;
`git diff --check` clean; `scripts/privacy-check.sh` (staged) clean.
`npm run backend:stale` not run (per instructions).

**Choices:**
- The login-folder cleanup renamed too (it deleted from every home where the
  copy matched that home's placed record); it still acts only on those
  copies. Fenced/local homes keep their retired-file copies untouched, as
  before.
- No-replace rename instead of check-then-rename where the OS has one; the
  fallback check is fine at startup (before the keeper and any tab).
- The Pull result is a struct now (`{pulled, skippedTooLarge}`) instead of a
  bare count; no frontend caller used the count. `pulled` counts files that
  landed (the old count included skipped ones). `skippedTooLarge` is
  `#[serde(default)]`, and the store reads a bare number or a missing field as
  nothing skipped.
- "Too large" means the host walk listed the file over the cap. A file that
  grew past the cap between the walk and the transfer, or failed for another
  reason, stays a stderr `sync_pull: skip` line.
- The take-host action of the push-conflict queue also shows the notice
  (without a "Synced" text), since it pulls through the same command.
- Reused shared styling only: the existing `.project-files-sync-result` line,
  `ErrorNote`'s `.inline-link-btn` toggle and `.error-note-raw` list. No new
  CSS.
- The SFTP path test runs `pull_file`'s whole per-file rule through
  `pull_file_with` with a local read in place of the SFTP read. The wire
  itself has no test double in this repo.

**Gotchas:** RTK cuts `rg` output in this worktree; use `rtk proxy rg`.
`libc::renameat2` exists only for linux-gnu in libc 0.2.186, hence the cfg.

**Flagged for user:**
- The Host session sees `.vibe/.env.pre-scope` (etc.) after the first start
  with this build if Tabtivity had placed or adopted that file. Sign in again
  there, or copy settings back from it. The files are never cleaned up
  automatically.
- Not reported in the UI: big files skipped by the background auto-sync pass
  (`sync_auto`) and by the orange-files "take host" batch (`resolveAll`),
  which ignores pull results. Both still log to stderr only.
- macOS (`renameatx_np`) and Windows paths of `rename_aside` are not compiled
  here.

**Live click-through (not run):**
1. Host-home rename: with a build before `f5b86a5b`, sign in to Vibe in a
   project tab, then open a Host session (root console `+` → Host session)
   so `<state_dir>/agent-homes/host/.vibe/.env` exists. Start this build:
   that file is now `.vibe/.env.pre-scope` with the same content; `.vibe/.env`
   is gone; stderr shows `agent_auth: vibe: no longer shared, moved … aside
   to .env.pre-scope`. Restart: nothing changes (no `.pre-scope.1`).
2. Big-file notice: remote project, host folder `data/` with a few small
   files and `truncate -s 70M data/big.bin`. Remote tree → right-click
   `data` → Pull → confirm. The line under the tree reads "Synced data from
   the host. · 1 file(s) over 64 MiB were not pulled — they stay on the
   host:" with `data/big.bin (70.0 MB)` and the untested pill; the small
   files are green, `big.bin` is not in the mirror. Repeat with rsync
   missing on the host (or locally): same line.
3. Add four more 70 MB files and use *Sync all*: the line under the sync
   row shows "5 file(s) …" and a Show files link that reveals the list.
4. A folder with no big file: Pull shows only "Synced … from the host.".
5. German UI: the line reads "… Datei(en) über 64 MiB wurden nicht geholt …".

## Follow-up step 8 — reviewer

Range `1c798ae8..e1ffdc3f` (`f5b86a5b`, `3e79717d`, `e1ffdc3f`) against the
two decisions: Host-home login copies renamed to `<name>.pre-scope[.N]`,
never deleted; a pull that skips files over 64 MiB names them on both paths,
cap kept.

**Findings:**
1. **Fixed (`2a1864a7`).** `HomeFile::rename_aside`'s fallback, taken when
   `renameat2(RENAME_NOREPLACE)` answers `EINVAL`/`ENOSYS` (NFS homes, old
   kernels), musl, or macOS `renameatx_np` answers `EINVAL`/`ENOTSUP`, was
   `fstatat` then a plain, replacing `renameat`. Now `link_aside`: `linkat`
   (flags 0, so a symlink is linked as itself) to the free name, refused with
   `EEXIST` when taken, then `unlinkat` of the old name only while it is still
   the same `(dev, ino)`; if the name was replaced in between, the newcomer
   stays and the old file is the one at `.pre-scope`. A filesystem with
   neither no-replace rename nor hard links refuses the move (the store is
   kept, as for any failed move). Windows (no fence) keeps check-then-rename.
2. **Checked, fine.** Linux `renameat2` + `RENAME_NOREPLACE` (`c_uint`) is
   linux-gnu only in libc 0.2.186, matching the cfg. macOS: `renameatx_np(c_int,
   *const c_char, c_int, *const c_char, c_uint)` and `RENAME_EXCL: c_uint`
   exist in libc 0.2.186 `unix/bsd/apple`. The full crate cannot be
   cross-checked here (a C build dependency needs an Apple `cc`), so the unix
   function, `link_aside` included, was compiled in a scratch crate against
   libc 0.2.186 for `aarch64-apple-darwin` and linux-gnu: clean. The Windows
   branch uses std only (`self.dir.path`, `self.path()` exist there). Suffix
   loop bounded at 1000; a name with `/` or `\` is refused.
3. **Checked, fine.** `.pre-scope[.N]` is never shared: no `auth_paths` row
   contains it, neither `DirNames` admits it (`.json`/`.info` suffix), the
   keeper's adopt/place goes through those, and `status_in`'s `signed_in`
   reads the store, not the homes.
4. **Checked, fine.** `PullOutcome` callers: only `src/stores/remote/sync.ts`
   invokes `sync_pull`/`sync_whole_project`; no `mobile-web/`, headless-owner
   or Rust caller. `toPullOutcome` reads a bare count or a missing field.
5. **Fixed (`1e6646ac`).** User-initiated pulls still silent: the diverged
   view's *take host for all* (`resolveAll`) and its per-row *take host*
   ignored the outcome. `resolveAll` now returns the skipped files (empty for
   "local"), and both show the shared `SyncSkippedLarge` line (same
   `.project-files-sync-result` chrome, close button) atop the diverged view,
   outside the empty-list branch. Untested row text widened.
6. **Fixed (`1e6646ac`), sibling.** The push-conflict queue's take-host
   replaced the skipped line on every big file, so a second one hid the
   first; it now appends to a skipped-only line.
7. **Checked, fine.** i18n: the repo has no plural forms; `{count} file(s)`
   matches the sibling keys; all five dictionaries carry the three keys.
   Styling reuses `.inline-link-btn` / `.error-note-raw`.
8. **Fixed (`3a64da68`).** Timing flake
   `an_ordinary_deep_or_long_view_keeps_the_database_readable`: it tests the
   schema limits, not speed, but ran four opens (the `long` view's 250 000-entry
   `IN` list, ~1 s unoptimised) under the 5 s production deadline. New
   `sqlite_tables_within(path, budget)`; the test runs tables and pages under
   120 s.

**Tests added:** `home_io.rs`
`the_link_fallback_never_replaces_and_never_follows` (taken name →
`AlreadyExists`, both files intact; a file moves; a symlink moves as a link,
its target untouched); `SyncStore.test.ts` "resolveAll on the host side
collects the files left on the host as too large" (big file collected, a
failed path skipped, "local" returns `[]`).

**Gates (at `1e6646ac`):** `npm run build` ok; `npm test` 739 files / 7587
passed; `cargo test -q` 3800 passed, 3 ignored, 0 failed (lib 3632), run
after `npm test`, not alongside; `rtk proxy npm run lint` 0 errors, 28
advisory warnings (unchanged); `cargo clippy --all-targets -D warnings`
clean (Linux; macOS/Windows clippy not runnable here); `scripts/brand-check.sh`
ok; `git diff --check` clean; `scripts/privacy-check.sh` (staged) clean.
`npm run backend:stale` not run (per instructions).

**Flagged for user:**
- The background auto-sync pass (`sync_auto`) still skips files over the cap
  with a stderr line only; nobody clicked anything, so there is no result
  line to put it in. A persistent marker on the row would be a design call.
- The 5 s SQLite deadline covers the schema parse, `COUNT(*)` and the page
  together. On a slow disk or machine an ordinary large table (millions of
  rows; `COUNT(*)` walks the whole b-tree) or an aggregating view can pass
  it and the viewer shows the timeout instead of the data. Options: a longer
  budget, or a count that may time out on its own and show "?" while the
  page still loads.
- A single-file Pull of a file over the cap reads "Pulled X from the host. ·
  1 file(s) over 64 MiB were not pulled" — informative but contradictory; the
  done text could be dropped when nothing landed.
- The diverged view's per-row take-host still drops a rejected pull without
  any message (unhandled promise), as before this range.
- macOS/Windows branches of `rename_aside` remain unrun; CI on those
  platforms is the first real compile of the whole crate there.

## Merge with develop (2026-10-09, merge `33120f2e`)

`develop` at `e54adf3d` (25 commits, mostly the macOS/Windows completion run,
osfix A1–A9) merged into the branch at `8b1e5238`; merge base `6c420e42`.

**Conflicts:**
- `agent_fence.rs` `sandbox_exec_inputs` (macOS): develop's
  `seatbelt_git_guard(&mut inputs, …)` and `pinned` field kept, the branch's
  `Result<(SeatbeltInputs, Vec<ControlPin>), String>` return kept
  (`Ok((inputs, control_pins))`). Its one caller,
  `wrap_pty_options_sandbox_exec`, still destructures the pair and runs
  `verify_control_pins` last before the argv; develop's Seatbelt changes do
  not touch that path.
- `docs/context/git_push_mcp.md`: one paragraph — scope from
  `PushBinding::fence_scope`, no scope → `fence_unavailable`, never the host
  (gap 18), the one-shot boundary bubblewrap on Linux and develop's
  `preflight.sb` Seatbelt profile on macOS, Windows `fence_unavailable`
  ("push from the git bar"). Develop's "an unfenced tab's hook runs
  unfenced" and Windows `preflight_failed` sentences are superseded by
  gap 18 and dropped.
- `docs/filemap_backend.md`: `home_io.rs` row is the branch's (superset);
  `agent_turn.rs` row is develop's (process-table walk, macOS `pbi_comm` +
  `KERN_PROCARGS2`); `agent_fence.rs` row is the branch's plus develop's
  `one_shot_command` / Seatbelt git-guard sentence and "Linux only" on
  `live_unfenced_by_scope`.
- `docs/threat_model.md` Agent push row: develop's text plus the branch's
  "built from the scope the push token recorded at spawn (no scope: refused,
  never on the host — gap 18)"; develop's `seatbelt_git_guard` residual kept.
  Also edited (no conflict): gap 18's residual no longer says macOS cannot
  push a repo with a hook — macOS now runs it in the one-shot Seatbelt
  profile in the recorded scope (not run on a Mac).

**Semantic check (no further code change needed):**
- Push preflight: develop changed only `agent_fence::one_shot_command`
  (new macOS arm), never `git_push_mcp.rs`. The branch's `preflight_command`
  calls `one_shot_command(scope, …)` only for `HookBoundary::Fence(scope)`,
  so the merged result is fail-closed on every platform and uses the
  Seatbelt one-shot on macOS when a scope is recorded. The macOS arm's
  helpers (`cargo_credential_paths`, `settings`, `roots_for_scope`,
  `sandbox::stage_dir`, `git_guard::guard_paths`) exist with the signatures
  it uses; `guard_paths` now reads `commondir` / `.git` pointers through
  `home_io::read_record` (gap 29), so the macOS one-shot inherits that.
- `fenced_scope_of_tab` stays `#[cfg(test)]`; develop added no caller.
- `agent_turn.rs`: develop's `ProcProbe` walk reads `/proc` (Linux) and
  `sysstat` (macOS) — kernel process data, not agent-writable files; the
  branch's `.turn` reads keep `home_io::read_record`. No new develop reader
  of `.turn`/session/live records bypasses `read_record`/`open_regular`
  (grep of every added `read_to_string`/`fs::read`/`File::open` in
  develop's backend diff).
- `agent_session.rs` (develop's `ps` fallback in the hook script vs the
  branch's record readers), `terminal/mod.rs` (`cmd /D` vs spawn
  generations), `agents.rs`, `ollama.rs`, `paths.rs`, `lib.rs`, `mod.rs`,
  and the frontend overlaps (`FileTree.tsx`, `FileViewerPane.tsx`,
  `tabs.ts`, i18n dicts, `untested.ts`) touch disjoint code.

**Gates (at `33120f2e`):** `npm run build` ok; `npm test` 741 files / 7609
passed; `cargo test -q` 3826 passed, 3 ignored, 0 failed (lib 3658), run
after `npm test`; `rtk proxy npm run lint` 0 errors, 28 advisory warnings
(unchanged); `cargo clippy --all-targets -D warnings` clean (Linux);
`scripts/brand-check.sh` ok; `git diff --check` clean;
`scripts/privacy-check.sh e54adf3d HEAD` clean (41 commits).
`npm run backend:stale` not run (per instructions).

**Flagged:**
- macOS and Windows were not compiled: `cargo check --target
  aarch64-apple-darwin` stops in `objc2-exception-helper`'s build script (no
  Apple-capable C compiler here), `--target x86_64-pc-windows-msvc` in
  `tauri-winres` (no `llvm-rc`) and `libsqlite3-sys` (no MSVC compiler). The
  merged macOS fence code (`sandbox_exec_inputs`, `one_shot_command`) was
  read-verified only; CI on those platforms is its first compile.
- The macOS push preflight with a `pre-push` hook is now reachable for an
  agent (scope recorded) and has never run on a Mac.

# Run 2026-10-12

Plan: "Run 2026-10-12" section of the plan. Branch `threat/1012`, worktree
`.claude/worktrees/threat1012`, from develop `5d82c988`. Same rules as above:
each implementer and reviewer appends a short section (commits, files, tests,
gates with counts, choices, gotchas, "Flagged for user").

## Agent step 1 — implementer (gap 19, A2) — 2026-10-12

**Commit:** `04a0b8b2` fix(git-mcp): read CI only for the confirmed repo (gap 19).

**Files:** `src-tauri/src/services/git_push_mcp.rs` (`git_ci_repos` helpers
`ci_repo_key`/`ci_repos`/`ci_repo_allowed`/`add_ci_repo`/`allow_ci_repo`;
`Category::{CiRepoUnconfirmed, RepoChanged}`, `Status::Allowed`,
`Kind::CiRepo`, `Proposal::repo`; `stage_ci_card`, `ci_unconfirmed`,
`ci_target`, `call_ci`, `release_ci_gate`, `release_failure`,
`decide_ci_repo`; `git_entry_identity`, `repo_changed`; pending-limit counts
skip CI cards; tool descriptions, `CONTRACT`, `INSTRUCTIONS`),
`services/git_ci.rs` (`resolve` → `CiRepo`; `runs`/`run`/`security_alerts`
take the resolved repo), `services/git_release.rs` (`plan` takes a
`ci_allowed` gate, checked right after `local_target`, before any request),
`services/root_mcp.rs` (`PushBinding::git_at_spawn`, set in
`grant_git_push`), `commands/git.rs` (Release button passes `|_| true`),
`services/git_guard.rs` (module doc), `src/components/agents/GitPushMcp.tsx`
("Allow CI" card, `statusLabel`), `src/types/index.ts`, `src/lib/i18n.ts` +
de/es/fr/it (`gitPushMcp.ciStatus.*`, `ciAllowTitle`, `ciAllowHelp`,
`ciAllow`; `gitPushMcp.help` sentence), `src/lib/untested.ts`
(`gitPushMcp.ciAllow`), `docs/context/git_push_mcp.md` (CI repo rule, card,
`repo_changed`, known limit, QA step 11), `docs/threat_model.md` (row 19
**Fixed, not live-verified.**; the agent push/release/CI row's macOS
residual no longer claims CI redirection), `docs/filemap_backend.md`
(`git_push_mcp.rs`, `git_ci.rs` rows).

**Tests added:** `git_push_mcp.rs`:
`ci_reads_go_only_to_a_confirmed_repo_and_stage_one_card` (confirmed URL
passes across spellings and case; unconfirmed refused with one card, deduped
across calls and tabs; another repo's confirmed URL does not cover it; a
second repo gets its own card; CI cards leave push admission's pending slots
free; Dismiss; Allow records the repo and the next read passes; `not_github`
stages nothing; the keyring-free host refuses without a card),
`a_release_refused_for_an_unconfirmed_ci_repo_stages_the_card`,
`the_ci_repo_list_is_optional_lowercase_and_outside_the_policy_block` (old
entry round-trips unchanged; once-only, lowercase-only, malformed rows
ignored; the strict policy block untouched),
`a_repo_made_after_spawn_is_refused_for_push_release_and_ci` (`git init`
after spawn → `repo_changed` for `git_push`, `git_release`, `ci_runs`,
`ci_run`, `ci_security_alerts` through the RPC, nothing staged; the spawn
repo passes; a nearer `.git` planted under a parent repo is refused; none at
spawn is refused). `git_release.rs`:
`an_unconfirmed_github_repo_is_refused_before_any_ci_read` (gate asked with
the URL, refused before `ls-remote`/`tip_ci`; non-GitHub never asks).
`root_mcp.rs`: `a_push_grant_records_the_git_dir_found_at_spawn`.
`GitPushProposals.test.tsx`: two card tests (Allow through
`git_push_mcp_decide`, allowed outcome, Dismiss).

**Gates (at `04a0b8b2`):** `npm run build` ok; `npm test` 798 files / 7980
tests passed; `cargo test --workspace` 4233 passed, 4 ignored, 0 failed (lib
3834); `cargo test -p tabtivity --no-default-features --lib --test
server_secrets` 3735 + 1 passed, 4 ignored; `npm run lint` (via `rtk proxy`)
0 errors, 28 warnings (unchanged count, none new); the three clippy gates
clean; Windows cross-check (`clippy --target x86_64-pc-windows-msvc
--all-targets -D warnings` and `cargo check --workspace --all-targets`)
clean; `aarch64-apple-darwin` `cargo check --workspace --all-targets` with
the ci-local check-only CC/AR stand-ins clean (5 pre-existing warnings in the
vendored `tauri-runtime-wry`); `scripts/brand-check.sh` ok;
`scripts/privacy-check.sh` clean; `git diff --check` clean.
`npm run backend:stale` not run (main agent at landing).

**Choices:**
- The gate lives in `git_push_mcp::ci_target`, which resolves the repo once
  (`git_ci::resolve`) and hands the same `CiRepo` to the read, so nothing
  re-reads `.git/config` between the check and the request.
- The release gate is a `ci_allowed` closure on `git_release::plan`, checked
  right after `local_target` (before `ls-remote` and `tip_ci`) and only for a
  github.com URL. The user's Release button and its preview pass `|_| true`
  (the user acts there and the workflow names reach only the dialog).
  A gated release, at `git_release` or when the user presses Release on the
  card, fails `ci_repo_unconfirmed` and stages the same "Allow CI" card.
- `git_entry_identity` takes the nearest `<ancestor>/.git` via
  `symlink_metadata` (folder, pointer file or link, never followed). Bare
  layouts need no check (`safe.bareRepository=explicit`). On non-Unix it
  records presence only as `(0, 0)`: std has no stable file index, and there
  is no fence on Windows.
- The `repo_changed` check runs after the keyring-free `window_required`
  short-cut and after admission (an inadmissible call costs nothing), before
  the policy read.
- Allowed repos are appended through `projects::patch_project_entry`; a
  malformed `git_ci_repos` value is read as empty and replaced on the next
  Allow.
- The card id prefix is `ci-`; `git_push_cancel` withdraws a tab's own
  waiting CI card like a push.

**Gotchas:**
- `ProjectEntry.extra` is a `HashMap`: compare a round-trip as
  `serde_json::Value`, not as a string (key order varies between runs).
- `scripts/untested.mjs check` only sees literal `UntestedTag id="…"`; an id
  inside a three-way ternary counted as unused, so the CI card renders its
  own `<UntestedTag id="gitPushMcp.ciAllow" />`.
- `t()` takes `TranslationKey`; a template key whose status union includes
  `allowed` fails `tsc` for push/release, hence the typed `statusLabel`.

**Flagged for user:**
- Behaviour change: an agent's `ci_runs`/`ci_run`/`ci_security_alerts` in a
  project whose push URL was never confirmed now asks once per repo ("Allow
  CI for <owner/repo>" card in the git bar / Agents view) instead of reading
  at once. An agent `git_release` there is refused with the same card.
- Behaviour change: a tab started in a folder with no repo (or before you ran
  `git init` yourself) gets `repo_changed` for push, release and CI until
  you restart it.
- Residuals: an allowed repo stays allowed for the project (no UI lists or
  removes `git_ci_repos`; edit `projects.json` by hand). After a Dismiss the
  next CI read stages a new card (bounded by the 60 reads/hour budget).
  Windows records only whether a `.git` was present. The card is per
  project, so another project with the same repo asks again.
- Not verified live; the card has the `gitPushMcp.ciAllow` untested pill.

**Live click-through (user only):**
1. Load a build with this backend. In a project whose push URL is
   confirmed, ask the agent for `ci_runs`: runs come back, no card.
2. In the tab, `git remote set-url origin https://github.com/<other>/<repo>`
   and ask for `ci_runs`: expect `ci_repo_unconfirmed` and an "Allow CI for
   <other>/<repo>" card; ask again, still one card.
3. Press Allow; ask again: runs come back. Restore the URL.
4. Open a project folder with no git repo, start a fresh agent tab, have it
   `git init` and add a github `origin`, ask for `ci_runs` and a push:
   both `repo_changed`. Restart the tab: the lane works (CI then asks via
   the card, step 2).
5. Ask for `git_release` with an unconfirmed repo: refused
   `ci_repo_unconfirmed`, the same card shows.

## Agent step 1 — reviewer — 2026-10-12

**Reviewed:** `git diff 3df3ff27..04a0b8b2` and the implementer section above.
**Fix commit:** `c723c06b` fix(git-mcp): review fixes for gap 19 (empty .git,
bundle consent).

**Checked, no change needed:**
- The CI gate resolves the repo once (`git_ci::resolve`) and hands that
  `CiRepo` to the request, so nothing re-reads `.git/config` between the
  check and the call. The release gate uses the same `url` that `tip_ci` and
  `ls-remote` then use, and runs before both. The user's Release button is
  ungated, as planned. No other caller of `git_ci` reads with the token.
- Card dedupe (per project and repo while pending), CI cards left out of
  both pending-limit counts, `git_push_cancel`/Dismiss/`clear` on a CI card,
  prune and session revocation, and the keyring-free host path (no card
  staged). A card flood is bounded by the 60-reads/hour CI budget, which
  `admit` charges before the gate.
- `projects.json`: `git_ci_repos` sits outside the strict `ProjectPolicy`.
  `save_projects` copies only status and position, so the frontend's
  whole-list save cannot drop the key. Folder imports build the entry from
  scratch (`project_extra`) and adopt no extras.
- The frontend: the only consumer of push cards is `GitPushMcp.tsx` (git
  bar and Agents view). Nothing else matches on statuses or kinds, and the
  phone shows no push cards. All 7 new i18n keys are in all five
  dictionaries. The `gitPushMcp.ciAllow` UntestedTag row is there.
- No new commands, so no `command_class` rows. Services stay
  AppHandle-free. `PushBinding` is not persisted, so the new field needs no
  serde shape.

**Bugs found and fixed (`c723c06b`):**
1. **An empty `.git` at spawn passed `repo_changed`.** `git_entry_identity`
   took any `<ancestor>/.git`. Git passes over an empty or half-made `.git`
   folder, and `git init` fills one in place, so the inode stays the same.
   An agent in such a folder could make a repo whose `.git/config` was
   never guarded, and the check passed. Now a folder counts only when it
   holds `HEAD`, `objects` and `refs`, as git requires (`git_entry_at`).
   Pointer files always count. Sibling bug: a `.git` link was identified by
   the link's own inode, so swapping the folder it names went unnoticed. A
   link now counts as its target. Test:
   `git_push_mcp::a_git_init_into_an_empty_dot_git_after_spawn_is_refused`
   (empty `.git` plus `git init` gives `repo_changed`; the link target
   swapped gives `repo_changed`). It fails against the old walk.
   `root_mcp::a_push_grant_records_the_git_dir_found_at_spawn` now builds
   real git dirs.
2. **Project bundles carried CI and push consent.** `exported_entry` and
   the import kept `git_ci_repos` and `git_push_mcp.confirmed_url`. A
   `.tabtivityproj` naming the user's private repo therefore opened that
   repo's CI to the project's agents with no card, and skipped the first
   push's URL check. Both are now dropped on export and on import
   (`git_push_mcp::drop_confirmations`, `drop_imported_confirmations`, the
   same treatment as phone access). The level and protected branches still
   travel. Test:
   `project_transfer::bundles_carry_no_push_or_ci_confirmations`.
   `docs/context/git_push_mcp.md` is updated for both fixes.

**Gates (at `c723c06b`):** `npm run build` ok. `npm test`: 798 files / 7980
tests passed. `cargo test --workspace`: 4235 passed, 4 ignored, 0 failed.
`cargo test -p tabtivity --no-default-features --lib --test server_secrets`:
3737 + 1 passed, 4 ignored. `npm run lint` (via `rtk proxy`): 0 errors, 28
warnings (unchanged). All three clippy gates clean. Windows cross-check
(`clippy --target x86_64-pc-windows-msvc --all-targets -D warnings` and
`cargo check --workspace --all-targets`) clean. `aarch64-apple-darwin`
`cargo check --workspace --all-targets` with the check-only stand-ins clean
(the 5 vendored `tauri-runtime-wry` warnings were already there).
`scripts/brand-check.sh` ok. `scripts/privacy-check.sh` clean.
`git diff --check` clean. `npm run backend:stale` was not run (main agent,
at landing).

**Flagged for user:**
- Behaviour change from fix 2: a project moved by bundle asks again before
  its first agent push, and again for CI ("Allow CI" card), on the new
  machine. A bundle still carries the push *level*, so a bundle can arrive
  set to Apply. The URL check still stops the first push, but you may want
  the level dropped on import too (left as it was: it isn't consent for a
  repo).
- A residual race in the defence in depth: `repo_changed` is checked before
  the lane's git reads the repo, not pinned to it. If the tab had no `.git`
  of its own at spawn (only a parent repo), an agent looping
  `git init`/`rm -rf .git` can sometimes win the window between the check
  and the read. The A2 confirmed-repo gate still holds then: an unconfirmed
  repo only gets a card. Closing the race fully would mean passing the
  spawn-time git dir to every lane git call (`GIT_DIR`). That is a design
  change, so it is not made here.
- A `.git` pointer *file* is identified by its inode. Its contents are
  protected only by git_guard's read-only bind, which covers the start dir's
  pointer. A folder whose `HEAD` holds garbage but which has `objects` and
  `refs` still counts as a repo here, while git rejects it. Both are edge
  cases behind the A2 gate.
- The implementer's residuals stand: there is no UI to list or remove
  `git_ci_repos`; Dismiss followed by another read stages a new card;
  Windows records presence only.

## Agent step 2 — implementer (gaps 22, 31, D1) — 2026-10-12

**Commit:** `f69aee8e` fix(fs,mail): viewer and attachment I/O through held
folder handles (gaps 22, 31).

**Files:** `src-tauri/src/commands/fs.rs` (`open_confined` + `Confined`
{Read, Stat, Overwrite, Write}, `read_opened`, `write_opened`,
`outside_roots`; `read_file_text_local`, `write_file_text_local`,
`write_file_bytes_local`, `read_file_bytes_local`, `file_mtime_local`,
`file_size_local`, `detect_mime_local` go through it;
`resolve_for_confinement` returns `Option`, refuses `..`, uses
`symlink_metadata` and falls back to `canonical_or_new`; dead
`confine_abs_write` removed), `src-tauri/src/commands/mail.rs`
(`save_into_emails_dir` = `open_emails_dir` + `save_unique_in`, replacing
`emails_dir_in` + `write_unique_in_dir`; the toast path goes through
`fs::display_path`), `src-tauri/src/services/mobile_control/files.rs`
(Unix `ProjectDir` and `open_root`/`lookup_dir`/`create_dir`/`create_file`
`pub(crate)`; new `lookup_file`, `open_existing_for_write`, `into_file`;
shared `WriteRefusal` {Link, NotFile, Io}),
`services/mobile_control/files_windows.rs` (`open_existing_for_write`:
`FILE_OPEN` + `FILE_GENERIC_WRITE|FILE_READ_ATTRIBUTES` +
`FILE_OPEN_REPARSE_POINT`, a reparse point is `Link`; `into_file`;
`create_dir`/`create_file` `pub(crate)`; `STATUS_FILE_IS_A_DIRECTORY` →
`IsADirectory`), `src/components/embed/fileAccess.ts`
(`describeFileErrorKey` → `fileError.link`), `DeckView.tsx` (figure poll),
`PdfViewer.tsx` ("Open as deck"), `src/lib/i18n.ts` + de/es/fr/it
(`fileError.link`), `docs/threat_model.md` (rows 22 and 31 **Fixed, not
live-verified.**), `docs/filemap_backend.md` (`fs.rs`,
`mobile_control/files_windows.rs` rows).

**Tests added:** `fs.rs`:
`a_viewer_save_refuses_a_dangling_leaf_link_and_creates_nothing_at_its_target`
(out-of-root and in-root dangling targets, Write and Overwrite),
`a_viewer_save_refuses_an_in_root_link_that_still_reads` (save refused,
read and stat follow it, a link out of the project neither reads nor stats),
`a_viewer_save_through_a_linked_folder_inside_the_project_still_works`,
`a_viewer_save_rewrites_a_regular_file_in_place` (truncates; inode and
`0640` kept on Unix), `a_viewer_save_creates_a_missing_file_but_never_a_missing_folder`
(Overwrite never creates; folders are "not a file" but stat),
`open_confined_refuses_dot_components_outside_roots_and_relative_paths`,
`open_confined_walks_from_the_longest_root`,
`read_opened_refuses_a_file_over_the_cap`,
`confine_abs_within_refuses_a_dot_dot_through_a_missing_folder`,
`confine_abs_within_judges_a_dangling_link_by_its_target`, Windows-only
`a_viewer_save_refuses_a_reparse_point_leaf_on_windows` (returns early
without the symlink privilege). `confine_abs_within_allows_paths_inside_current_project`
now uses a real temp root (the old literal `/home/u/...` root only passed
through the removed literal fallback). `mail.rs`: the two old tests
rewritten for `save_into_emails_dir` (linked folder and a file at the name
refused, nothing through the link; dangling link and existing name skipped
to `x (3).desktop`), plus
`a_save_makes_the_folder_and_never_clobbers_a_file_already_there`
(cross-OS), `an_emails_folder_swapped_for_a_link_after_it_was_opened_gets_nothing_through_it`,
`a_project_root_swapped_for_a_link_after_it_was_opened_gets_nothing_through_it`.
Frontend: `src/__tests__/files/FileErrorKey.test.ts`.

**Gates (at `f69aee8e`):** `npm run build` ok; `npm test` 799 files / 7982
tests passed (798 + the new file); `cargo test --workspace` 4248 passed, 4
ignored, 0 failed (lib 3849); `cargo test -p tabtivity --no-default-features
--lib --test server_secrets` 3750 + 1 passed, 4 ignored; `npm run lint` (via
`rtk proxy`) 0 errors, 28 warnings (unchanged); the three clippy gates
clean; Windows cross-check (`clippy --target x86_64-pc-windows-msvc
--all-targets -D warnings`, `cargo check --workspace --all-targets`) clean;
`aarch64-apple-darwin` `cargo check --workspace --all-targets` with the
ci-local check-only CC/AR stand-ins clean (the 5 vendored
`tauri-runtime-wry` warnings as before); `scripts/brand-check.sh` ok;
`scripts/privacy-check.sh` clean (staged and `301d67d1..HEAD`);
`git diff --check` clean. `npm run backend:stale` not run (main agent at
landing).

**Choices:**
- `open_confined` is the confinement for the viewer helpers (it checks the
  roots itself with the same "not in the current project" message), so
  there is no separate check-then-open. `detect_mime_local` keeps its
  `confine_abs_read` first, so a refused path still errors while an
  unopenable one falls back to the extension, as before.
- Saves canonicalize only the folder; the leaf is opened by name with
  `O_NOFOLLOW` / `FILE_OPEN_REPARSE_POINT`. `Write` tries the existing file
  first, then `create_file` (`O_EXCL`), and on `AlreadyExists` tries the
  existing-file open once more (a link that appeared is still refused).
  Text saves (`Overwrite`) never create, as before.
- `Stat` serves a folder too (`lookup_file`, then `lookup_dir`), and the
  root itself, since `file_mtime` may be asked for one.
- Size caps run before the open, so an oversized save no longer empties
  the file first; reads cap on the handle's length and on the bytes read.
- `resolve_for_confinement` (used by `confine_project_path` /
  `confine_user_path`: sqlite, spreadsheets, `run_script_detached`, the
  browser's file grants) now resolves a missing path by its nearest
  existing ancestor (`canonical_or_new`) instead of the literal path.
- Mail: the folder is made with `mkdirat` then opened with `lookup_dir`
  (refuses a link or a file at the name); the returned path is display
  only. `mark_downloaded` stays by path (accepted residual, see below).
- `write_project_file{,_bytes}_local` untouched, per the plan review (the
  pinning test still passes).

**Sibling fixes (same hazard, in the touched code):**
- "Open as deck" (`PdfViewer.tsx`) decided "no deck yet" from
  `readFileText` failing, which also fails for a non-UTF-8 or over-cap
  `.eldeck.json`; that deck was then overwritten with an empty one. It now
  asks `fileMtime`. (Step 3's note covers the same bug in `generateBase`.)
- The deck figure poll swallowed every write error and retried each tick;
  a PNG that is a link would have re-rastered forever. It now records the
  PDF's mtime and shows `fileError.link` once.
- `detect_mime_local` opened the file with a blocking `File::open`; a FIFO
  at the path hung the command. The walk opens `O_NONBLOCK` and requires a
  regular file.

**Gotchas:**
- `clippy::cloned_ref_to_slice_refs` fires on `&[root.clone()]` in tests;
  use `std::slice::from_ref(&root)`.
- `ProjectDir`'s inner `File` is private; `into_file` exists for the
  metadata-only (`Stat`) path.
- No figure-poll test harness exists (step 3 reworks the poll for D3); the
  poll change is covered only by the `describeFileErrorKey` test.

**Flagged for user:**
- Behaviour change (D1): saving from the text editor, PDF viewer, deck,
  image annotator or TeX create-file onto a file that is a symlink — even
  one pointing inside the project — now fails with "This file is a link, so
  it was not saved…" (the PDF and annotator show the backend sentence
  "… is a link; viewers do not save through links"). Opening/reading such a
  file still works. Drag-and-drop and project writes still follow in-root
  links.
- Behaviour change: a viewer path with `..` in it is refused (the frontend
  sends tree paths, so this should not show).
- Windows (unverified, alpha): `ProjectDir` refuses *every* reparse point,
  not only links. Files or folders that are reparse points for other
  reasons — OneDrive Files On-Demand placeholders, dedup — can no longer be
  opened or saved by the viewers (the phone browser and mail `attach`
  already behaved so). If projects in OneDrive matter, the walk would need
  to refuse only name-surrogate tags (`FileAttributeTagInfo`).
- Residuals: the allowed root itself is opened by path (it comes from
  `projects.json`; replacing it needs write access to its parent). The
  mail download mark (macOS quarantine, Windows `Zone.Identifier`) is set
  by path after the write, so a swapped-in link can at most get the mark
  onto its target. Linux needs read permission on each folder of the walk
  (`O_RDONLY|O_DIRECTORY`), where the path-based code needed only search
  permission; an `--x` folder inside a project now fails viewer I/O.
  `sqlite`/`spreadsheet` still open by path after `confine_project_path`.
- Not verified live; no new UI, so no untested pill.

**Live click-through (user only):**
1. Load a build with this backend. Open a Markdown file in a project, edit,
   let it save: saved as before; `ls -i` shows the same inode.
2. In a terminal, `ln -s notes.md link.md`; open `link.md`: it shows the
   text. Edit it: the save fails with the link message; `notes.md` is
   unchanged.
3. `ln -s /tmp/planted.png figure.png` (target missing); open an image and
   "Save as" onto `figure.png` (or annotate an image named so): refused,
   `/tmp/planted.png` does not exist.
4. With the deck presenter on, make a deck's TeX figure PNG a symlink and
   recompile the figure's `.tex` in its own tab: the deck shows the link
   notice once, not every second.
5. Open a PDF whose `.eldeck.json` holds non-UTF-8 bytes and press "Open as
   deck": the sidecar is opened (and reported broken), not overwritten.
6. Mail: "Save to project" an attachment twice: `tabtivity-emails/name`
   and `name (2)`. Replace `tabtivity-emails` with a symlink to `/tmp` and
   save again: refused ("not a plain folder"), nothing in `/tmp`.

## Agent step 2 — reviewer — 2026-10-12

**Reviewed:** `git diff 301d67d1..f69aee8e` and the implementer section
above. **Fix commit:** `66447df8` fix(deck,files): review fixes for gaps
22/31 (deck `..` assets, link error key).

**Checked, no change needed:**
- `open_confined`: saves canonicalize only the folder and open the leaf by
  name with `O_NOFOLLOW` / `FILE_OPEN_REPARSE_POINT`, so a link at the leaf
  (dangling or not) never gets written through, and a folder swapped
  between canonicalize and the walk fails the walk. Reads open the
  canonical path through the same walk. `Write` falls back to `O_EXCL`
  and then to the no-follow open once more. Truncation happens only after
  `fstat` proves the file regular. FIFOs are opened non-blocking and
  refused. Size caps run before the open.
- Windows: `:` (ADS) and `\` names are refused by `plain_segment` in
  `nt_create`. A trailing-dot or trailing-space leaf goes to NT unstripped,
  so it names a different (odd) file inside the folder, not a link. An 8.3
  leaf naming a link opens the link itself and is refused. Verbatim
  `\\?\` input with `/` in it fails `plain_segment`. Roots and targets are
  both canonical (verbatim), so `starts_with` matches. Share mode is
  read|write|delete, as `fs::write` used. `FILE_GENERIC_WRITE` carries the
  `SYNCHRONIZE` that `FILE_SYNCHRONOUS_IO_NONALERT` needs. The new
  `STATUS_FILE_IS_A_DIRECTORY` → `IsADirectory` mapping changes nothing for
  the phone browser: its callers only match `NotFound`/`AlreadyExists`.
- Ordinary use: saves in the project root and in subfolders work. Like
  `fs::write` before, a save never creates a folder; TeX create-file makes
  the folder first. `Overwrite` (text saves, `HpcPipelineWizard`, deck
  `create.ts`, merge views) still needs an existing file, as before. The
  inode, owner and mode are kept. Atomicity is unchanged: `fs::write`
  truncated in place too. Remote (SFTP) projects route before the
  `_local` helpers, and mail refuses remote projects first. Mail checks: a
  name taken by a file or a link is skipped (`O_EXCL`), and the folder is
  `mkdirat` + no-follow lookup. Opening files for `Stat` raises inotify
  `IN_OPEN`/`IN_CLOSE_NOWRITE`; `fs_watch::is_read_only_access` already
  drops those, so the 1 s mtime polls cause no watcher loop.
- Callers of every changed command in `src/` (99 sites): TeX, markdown
  images, the md graph, completion context, Python go-to-definition,
  remarks and the PDF viewer all build paths through `resolvePath` /
  `normalizePath`, so they send no `..`. The deck did not (bug 1).
- "Open as deck" by `fileMtime`: a dangling or out-of-project link there
  counts as "no deck", and the write that follows is refused as a link.
  The figure-poll change marks the PDF version done only on the link
  refusal.
- `resolve_for_confinement` callers (`sqlite`, `sheets`,
  `run_script_detached`, `core_dispatch::user_path`): the server picker
  navigates by the backend's `parent`, never by `..`.

**Bugs found and fixed (`66447df8`):**
1. **Deck assets above the deck stopped loading.** `deckRelative` stores a
   figure beside or above the deck as `../figures/x.png` on purpose (V #108,
   and step 3's plan note keeps such reads). `resolveRel` joined it as
   `<deck dir>/../figures/x.png`, and `open_confined` refuses any `..`, so
   those images, fonts, interstitial GIFs and a relative `base` PDF all
   failed to load in the editor, the audience window and the PDF export.
   Now `resolveRel` folds `.`/`..` segments (`normalizePath`) and leaves
   other paths exactly as joined. The backend rule stays as it is. Test:
   `DeckView.test.ts` "resolveRel" (round trip of a `deckRelative` path, a
   Windows path, plain paths unchanged). The implementer's note "the
   frontend sends tree paths, so this should not show" was wrong for decks.
2. **The link refusal could read as a permission error.**
   `describeFileErrorKey` tested `/permission|denied/` first, and the
   refusal quotes the path. A project under a folder named e.g.
   `permissions` showed the wrong sentence, and the deck figure poll, which
   stops retrying only on `fileError.link`, went back to re-rastering every
   tick. The link check now comes first. Test: `FileErrorKey.test.ts`.

**Gates:** (at `66447df8`) `npm run build` ok. `npm test`: 799 files / 7984
tests passed (7982 plus the 2 new `resolveRel` cases). `cargo test
--workspace`: 4248 passed, 4 ignored, 0 failed. `cargo test -p tabtivity
--no-default-features --lib --test server_secrets`: 3750 + 1 passed, 4
ignored. `npm run lint` (via `rtk proxy`): 0 errors, 28 warnings
(unchanged). All three clippy gates clean. Windows cross-check (`clippy
--target x86_64-pc-windows-msvc --all-targets -D warnings` and `cargo check
--workspace --all-targets`) clean. `aarch64-apple-darwin` `cargo check
--workspace --all-targets` with the check-only CC/AR stand-ins clean (the 5
vendored `tauri-runtime-wry` warnings as before). `scripts/brand-check.sh`
ok. `scripts/privacy-check.sh` clean. `git diff --check` clean. `npm run
backend:stale` was not run (the main agent runs it at landing). Nothing was
run live.

**Flagged for user:**
- **Windows + OneDrive (biggest practical risk):** the walk refuses *every*
  reparse point, including the root (`plain_metadata`). Under OneDrive
  Files On-Demand every file and folder carries a cloud reparse tag. With
  Known Folder Move, `Documents` lives there, so viewer reads and saves,
  `file_mtime` polls and mail "Save to project" would all fail for a
  project in `Documents`. The implementer flagged it too. A fix means
  refusing only name-surrogate tags (`FileAttributeTagInfo`), plus
  checking how a placeholder behaves when opened as the reparse point
  itself. That is a design call, so it is not made here.
- **Roots nested inside another root's tree:** `compute_allowed_roots`
  canonicalizes each root on every call, and `open_root` canonicalizes it
  again. When project B (a box member, or a box sibling) sits inside
  folder A that an agent can write, the agent can replace B's folder (or a
  folder above it) with a link. B's root then *becomes* wherever the link
  leads, for every confined command, not only these. This was there
  before the change, and the held-handle walk does not close it, since the
  root set itself moves. A fix would pin roots, or refuse a root that
  resolves outside where it is registered. Picking the shortest root in
  `open_confined` would close only the race window, so it is not made here.
- **Error wording for unreadable paths:** `lookup_file`/`lookup_dir` drop
  the OS error. An unreadable file therefore reports "not a file", and an
  unreadable (`--x`) folder reports "… changed while it was opened (a
  folder on the way is now a link or gone)" instead of "Permission
  denied". `file_mtime`/`file_size` on a file without read permission now
  fail, where `stat` used to work. On Windows, `Stat` opens with
  `FILE_READ_DATA`, so a file another program holds with a deny-read
  share mode now fails `file_mtime`, where `fs::metadata` did not.
- `open_confined_walks_from_the_longest_root` cannot tell which root was
  walked: both succeed. It shows only that nested roots work.
- The implementer's residuals stand: the root is opened by path, the mail
  download mark is set by path, and `sqlite`/`sheets` open by path after
  `confine_project_path`.

## Agent step 3 — implementer (gaps 23, 38 hosts, D3; Windows reparse fix) — 2026-10-12

**Commits:** `5edc4353` fix(files,windows): refuse only link-type reparse
points (OneDrive placeholders) · `0be5b884` fix(deck,markdown): deck writes
only its own figure PNGs; no link navigates the app (gaps 23, 38) · this
handoff commit (also two `threat_model.md` wording fixes for rows 12 and the
phone-files surface).

**Files:**
- Item 0 (step 2 review, Windows): `services/mobile_control/files_windows.rs`
  (`is_name_surrogate`, `Unlinked`, `by_handle`, `identity`, `unlinked`,
  `ProjectDir::open_unlinked`; `open_root`, `lookup_dir`, `lookup_file`,
  `open_existing_for_write`, `child_dir_meta`, `entries` use them;
  `plain_metadata` removed), `files.rs` (`WriteRefusal::Link` doc, 2 tests),
  doc comments in `commands/fs.rs` (`open_confined`) and
  `services/mail_attach.rs`, `docs/filemap_backend.md` row,
  `docs/threat_model.md` rows 22, 31 (+ row 12 and the phone-files surface).
  `commands/fs.rs` and `commands/mail.rs` have no reparse check of their own:
  every Windows refusal is in `files_windows.rs`.
- Gap 23: `src/components/embed/deck/deckAssets.ts` (`texFigureDir` moved
  here, `figureTarget`, `figureSource`), `DeckView.tsx` (`refuseFigure`,
  `rasterizeInto(pdfAbs, src)` re-checks, guards in the poll, Recompile and
  Edit, `addTexFigure` passes the deck-relative `src`; `generateBase` by
  `fileMtime`), i18n `deckView.figureOutside` in all five dictionaries.
- Gap 38: new `src/lib/viewers/markdownLinks.ts` (`onMarkdownLinkClick`,
  `resolveLocalHref` moved from `FileViewerPane.tsx`, `uncShare`),
  `FileViewerPane.tsx` (`openMarkdownTarget` exported; `onPreviewClick`'s
  link half → helper), `NotebookView.tsx`, `SkillsLibraryView.tsx`,
  `MarkdownPromptField.tsx`, `DevTodoView.tsx` (helper),
  `src/lib/viewers/markdown.ts` (`urlForm`, `namesAnotherHost`; `safeHref`
  now exported for tests; `isLocalHref` and `imgSrc` use the same rules),
  `docs/filemap_frontend.md` row, `docs/threat_model.md` rows 23 (fixed) and
  38 (partly fixed; D6 gate still open).

**Item 0, how it works:** each name is still opened first with
`FILE_OPEN_REPARSE_POINT`. `FileAttributeTagInfo` on that handle: no reparse
attribute → the handle is used as is (one open, as before); a name-surrogate
tag (`0x20000000`: symlink, junction/mount point, WSL link) → refused as a
link; any other tag (cloud, dedup, WOF, …) → the same name is opened again
without the flag (the filter serves/hydrates it) and that handle is kept only
when its `FileIdInfo` (volume serial + 128-bit id) equals the first one's, so
a link swapped in between the two opens is refused. The root (opened by path)
gets the same treatment. Listings keep entries whose `EaSize` (the reparse
tag, MS-FSCC 2.4.17) is not a name surrogate. `remove_file` still deletes the
reparse point itself (a placeholder or a link, never a target).

**Tests added:**
- Windows-only (compile here, run on Windows CI):
  `only_name_surrogate_reparse_tags_count_as_links` (tag table),
  `unlinked_keeps_plain_handles_refuses_links_and_tells_files_apart` (plain
  file/folder kept without a second open, junction refused, `identity` same
  for two opens of one file and different for two files, the walk refuses the
  junction). No test creates a real cloud placeholder: that needs the cloud
  filter and a sync root (or a third-party tag the OS refuses to open). The
  existing junction tests still cover link refusal.
- `src/__tests__/deck/DeckView.test.ts`: `figureTarget / figureSource` table
  (accepts own folder, Windows deck path, round trip of what Add stores;
  refuses absolute, Windows absolute, drive-relative, `..` in three places,
  other folder, another deck's folder, beside the deck, nested, empty
  component, `.svg`, bare `.png`, `:` stream, control char, empty).
- `src/__tests__/deck/DeckFigurePoll.test.tsx` (new, RTL on the real
  `DeckView`): the poll re-rasters an own-folder figure; a deck with five
  hostile figures writes nothing and shows the notice exactly once;
  `generateBase` does not write over an unreadable existing `.tex`, still
  writes the starter when there is none.
- `src/__tests__/viewers/Markdown.test.ts`: network paths refused by
  `safeHref` and `isLocalHref` (`//h`, `\\h`, `/\h`, `\/h`, `/\t/h`, `\t//h`,
  `/\n/h`, `\u0001//h`, `file://h/…`, `file:\\h\…`), `java\tscript:`
  refused, `docs/a.md`, `C:\x`, absolute, `file:///`, `file://localhost/`,
  `https:` and `#` kept; a network-path image renders no `<img>`.
- `src/__tests__/viewers/MarkdownLinks.test.tsx` (new): helper behaviour
  (local link → `open` with the resolved path; no `basePath` → stopped, no
  open; `#` scrolls; `target=_blank` left alone; a bare targetless anchor
  stopped; non-link clicks pass), `resolveLocalHref` network rules, and an
  RTL click on every link in each real host (prompt preview, dev to-do,
  Skills preview, notebook cell) is default-prevented (external ones not).

**Gates (at `0be5b884`, Rust unchanged since `5edc4353`):** `npm run build`
ok (only the usual chunk-size notes). `npm test`: 801 files / 8033 tests
passed (799 + 2 new files). `cargo test --workspace`: 4248 passed, 0 failed,
4 ignored (the new tests are Windows-only). `cargo test -p tabtivity
--no-default-features --lib --test server_secrets`: 3750 + 1 passed, 4
ignored. `npm run lint` (via `rtk proxy`): 0 errors, 28 warnings
(unchanged). The three clippy gates clean. Windows cross-check (`clippy
--target x86_64-pc-windows-msvc --all-targets -D warnings`, `cargo check
--workspace --all-targets`) clean. `aarch64-apple-darwin` `cargo check
--workspace --all-targets` with the check-only CC/AR stand-ins clean (the 5
vendored `tauri-runtime-wry` warnings as before). `scripts/brand-check.sh`
ok. `scripts/privacy-check.sh` clean (staged and `529b20ca..HEAD`). `git
diff --check` clean. `npm run backend:stale` not run (main agent at landing).
Nothing run live.

**Choices:**
- The helper lives in `lib/` and takes the opener as `open` instead of
  importing `openLinkedFile`: `FileViewerPane.tsx` imports the helper, so
  the reverse import would be a cycle. `FileViewerPane.openMarkdownTarget`
  is the one opener (tab, `:line` jump, cross-file `#fragment`), passed by
  the viewer and the notebook. The Skills preview (a catalog body, no local
  file), the prompt field and the dev to-do board have no file context:
  their local links are stopped and open nothing, `#` anchors scroll.
- Notice once per object for the poll, every time for a Recompile/Edit
  click. `rasterizeInto` re-checks as a backstop and throws (unreachable
  from today's callers).
- `figureTarget` accepts `.PNG` (case-insensitive extension) and either
  separator in the deck-relative `src`; it returns `<figure dir>/<name>`
  joined with `/` as `addTexFigure` always did.
- No untested pill: no new UI surface, only a notice string.

**Sibling fixes (same hazard, in touched code):**
- `generateBase` decided "no `.tex`" from a failed read (plan review note):
  a non-UTF-8 or over-cap source was overwritten. Now `fileMtime`.
- `imgSrc` classified `//host/x.png` and `\\host\x.png` as local images,
  which the viewer resolves and reads on render (no click): Windows would
  contact the host over SMB. Now refused, as is `file://host/…`.
- `file://host/…` links passed `safeHref` and opened `\\host\…` in a viewer
  tab; an encoded `%5C%5Chost/x` link decoded to the same. Both refused
  (`namesAnotherHost`, `resolveLocalHref`'s own-share rule).
- `java\tscript:` slipped past the scheme check (the URL parser drops the
  tab); the check now runs on the parser's form. The link regex excludes
  whitespace, so this was not reachable from `[x](…)` today.

**Gotchas:**
- The deck's sidecar poll also calls `file_mtime`; a test fake that changes
  every mtime triggers a sidecar reload whose notice overwrites the one under
  test. `DeckFigurePoll.test.tsx` changes only `.pdf` mtimes.
- The "Create a starter" button shows only for a deck with no slides and a
  TeX engine (`tex_capability.available`).

**Flagged for user:**
- Behaviour change (D3): an existing deck whose TeX figure files are not
  directly in `<deck>.tex-figures` (renamed deck, hand-edited JSON, a figure
  moved elsewhere) no longer recompiles or re-rasters; Recompile and Edit
  show "This TeX figure's files are outside the deck's own figure folder…".
  The image still shows. Re-adding the figure fixes it.
- Behaviour change (gap 38): absolute `\\server\share\…` and
  `file://server/…` links and images in Markdown no longer render as links
  or images; relative links in a Markdown file that itself sits on a UNC
  share still work (same share only).
- Windows OneDrive fix is unverified at runtime: placeholder handling,
  hydration on the second open and `FileIdInfo` equality across the two
  opens are per the documented API, not observed. A filter that redirects a
  reparse point to another file id (e.g. container layers) is refused, on
  purpose.
- Gap 38 stays open until agent step 4 lands the D6 navigation gate.

**Live click-through (user only):**
1. Deck presenter on. Open a deck, "Add TeX figure", edit its `.tex` in the
   tab that opens, Compile: the slide updates within ~2 s, as before.
2. Close the deck. In its `.eldeck.json`, set that figure's `src` to
   `../elsewhere.png` (or an absolute path). Reopen, recompile the `.tex`:
   one notice "…outside the deck's own figure folder…", no
   `elsewhere.png` appears; Recompile shows the notice again.
3. Deck with no slides and a TeX engine: put non-UTF-8 bytes in
   `<deck>.tex`, press "Create a starter presentation": the file is
   unchanged (compile fails or recompiles), not replaced by the starter.
4. Markdown file with `[a](docs/x.md)`, `[b](#heading)`,
   `[c](https://example.com)`, `[d](//example.com/x)`: a opens a tab, b
   scrolls, c opens in the browser, d renders as text. Same links in a
   notebook markdown cell, the Agents prompt preview, a Skills preview and
   the dev to-do board: the app window never reloads.
5. Windows, project in OneDrive (Files On-Demand, file online-only): open a
   Markdown file in the viewer, edit and save; "Save to project" a mail
   attachment; browse the project from the phone. All work, the file
   hydrates. A junction or symlink in the project is still refused.

## Agent step 3 — reviewer — 2026-10-12

**Commits:** `bd31612d` fix(markdown): no mermaid label or `_self` link
navigates the app (gap 38 review) · this handoff commit. Reviewed
`529b20ca..0be5b884` plus `1425194e`.

**Checked:**
- Windows reparse (`files_windows.rs`): `is_name_surrogate` is
  `IsReparseTagNameSurrogate` (bit `0x20000000`); the tag table matches the
  SDK values (symlink `0xA000000C`, mount point `0xA0000003`, LX symlink
  `0xA000001D` are surrogates; cloud, dedup, WOF, AppExecLink, AF_UNIX/LX
  FIFO are not, and none of the non-surrogates is followed by a name
  lookup). The first handle stays open across the re-open, which is
  relative to the same held folder handle (the root by its canonical path),
  so a link swapped in reaches another file id and is refused by the
  `FileIdInfo` (volume serial + 128-bit id) compare; a link that leads back
  to the same file id is that same file. All `nt_create` opens share
  read/write/delete, so the second open never hits a sharing violation from
  the first. Both handles are owned `File`s (no leak). `EaSize` holds the tag
  only when `FILE_ATTRIBUTE_REPARSE_POINT` is set (MS-FSCC 2.4.17), which is
  how `entries` reads it. FAT/exFAT have no reparse points, so `identity`
  is never asked there. The msvc clippy and check gates compile the two new
  Windows tests.
- Deck: every write path (`rasterizeInto`, poll, Recompile, Add, Edit,
  autosave of the sidecar, export, `generateBase`) — only the figure paths
  come from the JSON, and all three of their callers plus the backstop go
  through `figureTarget`/`figureSource`. `figureFile` splits on both
  separators, compares the folder exactly (case, Unicode and drive tricks
  only refuse more), refuses `:`, controls, `.`/`..`, nesting and absolute
  forms; percent escapes are never decoded on the write path. Deck in a
  subfolder, at a project root and on a Windows path (`deckRelative` round
  trip `talk.tex-figures/abc.png`) all work. Existing decks: Add has always
  stored `<deck>.tex-figures/<id>.png`. Presenter/audience windows and the
  sidecar parser do not write.
- Markdown: all `renderMarkdown` hosts (viewer, notebook, Skills, prompt
  preview, dev to-do) use the helper; the renderer emits only `target`-less
  file/`#` links and `_blank` external ones, KaTeX runs `trust: false`, the
  notebook drops `text/html` outputs. Keyboard Enter on a link is a click.
  `safeHref`/`isLocalHref`/`imgSrc`/`resolveLocalHref` probed with
  `file:///\\host`, `file:/\host`, `\\?\UNC\…`, `%2F%5Chost`, `%2F%2Fhost`,
  `file:///%5C%5Chost`: none resolves to a network path (the slashes are
  collapsed or the share rule refuses them); `docs/a.md`, `C:\x`, `#x`,
  `mailto:` are kept. Tests do test what they claim (the generateBase test
  fails on the old read-based check; the hostile-poll deck covers absolute,
  `..`, absolute `texSrc`, `.svg` and nested). `deckView.figureOutside` is in
  all five dictionaries.

**Bug found and fixed (`bd31612d`):**
- Mermaid's `securityLevel: "strict"` still keeps HTML in a node label, and
  its DOMPurify hook restores an HTML `<a>`'s `target`. Verified with the
  real mermaid 11.17.2: `A["<a href=https://evil.example target=_self>x</a>"]`
  renders `<a href="https://evil.example" target="_self">`, and
  `<form action=https://evil.example><button>` survives as is. The helper
  left every anchor with *any* `target` alone, so a click on that label in a
  README's diagram navigated the main window (to an attacker page on every
  platform), and the form's button submitted it. Fix:
  `onMarkdownLinkClick` leaves only `target="_blank"` alone and also stops
  image-map `<area>`s; `markdownEnrich.ts::neutralizeDiagram` drops every
  `target`, `form` and `formaction` in a rendered diagram and unwraps its
  forms. Threat model row 38 updated. Tests (fail without the fix):
  `MarkdownLinks.test.tsx` — anchors with `_self`, `_top`, `_parent`,
  `_SELF`, empty and a named target are stopped; an `<area>` with and
  without a target is stopped. `MarkdownEnrich.test.ts` — "defuses label HTML
  that could navigate the app window" (mermaid mocked with the shape the
  real one renders: no `target`/`form`/`formaction` left, and a click on
  each of the three diagram links is default-prevented).

**Gates (at `bd31612d`; Rust unchanged since `5edc4353`):** `npm run build`
ok. `npm test`: 801 files / 8041 tests passed (8033 + 8 new). `cargo test
--workspace`: 4248 passed, 0 failed, 4 ignored. `cargo test -p tabtivity
--no-default-features --lib --test server_secrets`: 3750 + 1 passed, 4
ignored (the first run, alongside the npm gates, failed
`codex_bind::a_watched_tree_is_walked_only_after_a_change` at its third
assert, a late inotify event under load; code untouched here, the rerun
passed). `npm run lint` (via `rtk proxy`): 0 errors, 28 warnings
(unchanged). The three clippy gates clean. Windows cross-check (`clippy
--target x86_64-pc-windows-msvc --all-targets -D warnings`, `cargo check
--workspace --all-targets`) clean. `aarch64-apple-darwin` `cargo check
--workspace --all-targets` with the check-only CC/AR stand-ins clean (the
vendored `tauri-runtime-wry` warnings as before). `scripts/brand-check.sh`
ok. `scripts/privacy-check.sh` clean (staged and `529b20ca..HEAD`). `git
diff --check` clean. Nothing run live; `npm run backend:stale` not run.

**Flagged for user:**
- D3 residual, folder link: `figureTarget` is a lexical check. If
  `<deck>.tex-figures` itself is a symlink (a fenced agent can create one
  pointing at a box-sibling project it cannot see), `open_confined`
  canonicalizes the folder (D1 refuses only a linked *leaf*), so the poll
  writes `<name>.png` into the sibling whenever its `<name>.pdf` changes
  (e.g. the sibling's own `paper.pdf` → `paper.png` created or clobbered),
  and Recompile compiles the sibling's `<name>.tex`. Narrow (needs a
  matching PDF there; PNGs only), but it is outside "the deck's own figure
  folder". A fix needs a backend write mode that refuses a link at any
  component below the project root (D1 extended to folders) or a
  no-follow check of the figure folder; a design call, not made here.
- Middle click / `auxclick` on a Markdown link is not handled by the helper
  (React `onClick` does not fire for it); what the webview does with it (a
  new-window request for a file link's app-origin URL, or for an external
  one) is the D6 gate's job in agent step 4. Make sure that gate also covers
  new-window requests, not only navigations.
- Windows, unverified at runtime: the first open of a placeholder in
  `open_existing_for_write` asks for `GENERIC_WRITE` on the reparse point
  itself (`FILE_OPEN_REPARSE_POINT`). If the cloud filter refuses a write
  open of the raw placeholder, OneDrive saves still fail; the first open
  could then ask only `FILE_READ_ATTRIBUTES` when it turns out to be a
  reparse point. Also, a link swapped in during the window between the two
  opens is followed once by the re-open before the identity check refuses
  it, so a symlink to a UNC path could make Windows contact that host (a
  racing writer in the project is needed; no fence on Windows).
- Within the own figure folder an NTFS 8.3 alias (`EVIL~1.PNG` for
  `evil.pngx`) passes `figureTarget` and overwrites that non-PNG sibling in
  the same folder. Only a file already in the deck's figure folder, so it
  is noted, not fixed.

## Agent step 4 — implementer (gaps 21, 38, C2, D6; review items) — 2026-10-12

**Commits:** `fade72f8` fix(open,nav): ask before OS hand-offs, refuse
launchers; app navigation gate (gaps 21, 38; C2, D6) · this handoff commit.

**Files:**
- Gap 21 / C2 backend: new `services/os_open.rs` (`check`, `is_launcher_name`
  per `Os`, `is_launcher_on_any_os`, `REFUSED_LAUNCHER`);
  `commands/apps.rs` (`open_file` takes `check_only`, returns
  `Option<TrackedWindow>`; `effective_handler` + `open_goes_ahead` split out
  of `open_file_blocking`); `commands/mobile_control.rs`
  (`global_inbox_open` check + `check_only`); `commands/projects.rs`
  (`open_in_file_manager` refuses a macOS bundle); `services/connect.rs`
  (`opens_as_program` also takes every OS list).
- Gap 21 frontend: new `stores/openExternal.ts`, `lib/openExternal.ts`
  (`confirmOsOpen`, `isLauncherRefusal`, `showLauncherRefusal`),
  `components/common/OpenExternalHost.tsx` (mounted in `AppShell`,
  `DetachedApp`); `stores/windows.ts` (`openFile` asks when no handler,
  resolves `null` when nothing opened); `header/InboxIndicator.tsx`;
  `monitoring/DiskUsagePane.tsx` (was a bare `open_file` invoke: files via
  the store, folders via `open_in_file_manager`); `files/FileBrowser.tsx`
  ("reveal" a folder via `open_in_file_manager`, no question);
  `transport/clientAdapters.ts` + `wsInternals.ts` (`checkOnly` answers
  `null` in the browser and the Connect window); i18n `openExternal.*` (7
  keys) in all five dictionaries; `untested.ts` row `openExternalConfirm`.
- D6 / gap 38: new `services/nav_gate.rs` (`gate_for`, `AppOrigins`,
  `may_navigate`, `new_window`); `lib.rs` (`app_origins`, `nav_gate_plugin`
  registered with `.plugin(…)`, `app_new_window`, `create_main_window`
  called first in `setup`); `tauri.conf.json` + `tauri.macos.conf.json`
  (`label: main`, `create: false`); `commands/subwindow.rs`,
  `presenter.rs`, `connect.rs` (`.on_new_window(crate::app_new_window(…))`);
  `lib/viewers/markdownLinks.ts` (doc comment).
- 0b: `commands/fs.rs` (`Confined::WriteOwnFolder`,
  `NO_FOLDER_LINK_HEADER`, `write_file_bytes{,_local,_routed,_for}` carry
  it); `services/mobile_control/web_client.rs` (reads the header);
  `commands/tex.rs` (`compile_tex` `own_folder_unlinked`,
  `own_folder_unlinked_check`); `embed/fileAccess.ts` (`writeFileBytes`
  `opts.ownFolderUnlinked`, `describeFileErrorKey` also maps the folder
  refusals to `fileError.link`); `deck/DeckView.tsx` (every figure write and
  figure compile asks for it); `deck/deckAssets.ts` (`figureFile` refuses
  `~`).
- 0c: `services/mobile_control/files_windows.rs`
  (`open_existing_for_write` probes with `FILE_READ_ATTRIBUTES|SYNCHRONIZE`;
  new `reopened`).
- Docs: `docs/threat_model.md` rows 21 (**Fixed, not live-verified.**), 22
  (0c), 23 (0b), 38 (**Fixed, not live-verified.** with residuals);
  `docs/filemap_backend.md` (`apps.rs` row; `nav_gate.rs`, `os_open.rs`
  rows); `docs/filemap_frontend.md` (`OpenExternalHost` row).

**How it works:**
- `openFile(path)` without a handler: `open_file {…, checkOnly: true}` →
  backend resolves the program (`effective_handler`); only when the OS picks
  it, `os_open::check` runs (canonicalize; refuse when the given or the
  resolved leaf is a launcher for this OS, or a regular file has any `x`
  bit; folders pass except macOS bundles) → `Ok(None)`, nothing opened →
  the dialog ("Open <name> with the system's default app?", Cancel focused)
  → the real `open_file`, which runs the same check again. A refusal shows
  the "<name> was not opened" note (OK only) and resolves `null`; so does a
  refusal on the real call (file changed in between). A handler passed by
  the caller (Open with…, EmbedPane's exec, a drop's resolved handler) is
  not asked about. The confirm still shows when the user has a default app
  configured for the type (the store cannot tell); the backend does not
  judge that case.
- Nav gate: plugin `on_navigation` for every webview; labels `browser-*` /
  `print-*` → their own gate; everything else → app origin
  (`tauri://localhost`; `http(s)://tauri.localhost` on Windows; the `devUrl`
  origin only when `tauri::is_dev()`), `about:blank`, `about:srcdoc`,
  `blob:` whose inner URL is an app origin. A refusal logs scheme and host
  to stderr. New windows: Tauri's default (no handler) already denies on all
  three platforms (wry: WebKitGTK `create` unconnected, WebView2
  `SetHandled(true)`, WKWebView delegate returns nil), so a middle click on
  an external Markdown link used to do nothing; now `app_new_window` hands
  an off-origin `http(s)` URL to `open_external_url` on a thread and returns
  `Deny` for everything.
- 0b: `WriteOwnFolder` canonicalizes the **grandparent** (the deck's
  folder) and walks `<deck>.tex-figures` by name through the held-handle
  walk, so that folder being a link or junction — even one to a box-sibling
  root — fails the walk ("… is in a folder that is a link; viewers do not
  save through links"); a missing figure folder is made (`mkdirat`, then the
  no-follow lookup).

**Tests added:**
- Rust: `os_open.rs` (6: per-OS launcher tables incl. case, documents and
  per-OS separation, Windows `PATHEXT` and trailing dot/space, check by
  either name, Unix link name/target, exec bits `744/654/645` vs a folder,
  folder only as a macOS bundle); `nav_gate.rs` (5: label table; Linux/macOS
  and Windows/dev origin tables; new-window table; the wiring test that
  every app-window builder has `.on_new_window(crate::app_new_window(`,
  `lib.rs` registers the plugin and builds `main`, and every config window
  has `create: false`); `apps.rs`
  `an_os_default_open_refuses_launchers_and_a_check_opens_nothing`;
  `fs.rs` `a_figure_save_makes_its_own_folder_and_refuses_an_8_3_alias`,
  `a_figure_save_refuses_a_figure_folder_that_is_a_link_even_to_a_root`
  (Unix; also shows the plain mode writing into the sibling, and a dangling
  folder link not "made"); `tex.rs`
  `a_deck_figure_compiles_only_from_its_own_unlinked_folder`; Windows-only
  `files.rs`
  `a_save_probes_with_attribute_access_and_writes_through_the_second_open`
  (compiles in the msvc cross-check, runs on Windows CI).
- Frontend: new `src/__tests__/files/OpenExternalConfirm.test.tsx` (check →
  question naming the file → open; Cancel opens nothing; launcher note, no
  real call; refusal after the check; explicit handler not asked; a backend
  without `checkOnly` not opened twice; other errors surface; browser
  `checkOnly` opens no download; folder-link refusals map to
  `fileError.link`); `InboxIndicator.test.tsx` (check, question, open; a new
  case for decline and launcher refusal); `DeckFigurePoll.test.tsx` (every
  figure write carries `x-no-folder-link: 1`); `DeckView.test.ts` (8.3 alias
  refused).

**Gates (at `fade72f8`):** `npm run build` ok. `npm test`: 802 files / 8052
tests passed. `cargo test --workspace`: 4264 passed, 0 failed, 4 ignored
(lib 3865). `cargo test -p tabtivity --no-default-features --lib --test
server_secrets`: 3766 + 1 passed, 4 ignored. `npm run lint` (via `rtk
proxy`): 0 errors, 28 warnings (unchanged). The three clippy gates clean.
Windows cross-check (`clippy --target x86_64-pc-windows-msvc --all-targets
-D warnings`, `cargo check --workspace --all-targets`) clean.
`aarch64-apple-darwin` `cargo check --workspace --all-targets` with the
check-only CC/AR stand-ins clean (the 5 vendored `tauri-runtime-wry`
warnings as before). `scripts/brand-check.sh` ok. `scripts/privacy-check.sh`
clean. `git diff --check` clean. No Tauri command added (`open_file`,
`global_inbox_open`, `compile_tex` gained arguments), so `command_class` /
`commandClasses.ts` unchanged. `npm run backend:stale` not run (main agent
at landing); the daemon crate was not touched beyond the library's
`web_client.rs`, so no `ldd` run. Nothing run live.

**Choices:**
- The launcher refusal is per OS (a `.js` or `.py` is refused only on
  Windows, `.desktop` only on Linux), with Wine's `.exe`/`.msi`/`.bat`/…
  added on Linux; `connect::opens_as_program` (files that may open on
  another machine) takes the union.
- The name as given and the resolved name are both checked: file managers
  judge by the name they are given, so `run.desktop -> notes.txt` is
  refused as well as `notes.txt -> run.desktop`. The OS still gets the
  original path (no verbatim `\\?\` surprises on Windows).
- `main` is built in `setup` from its config entry: the only way to give a
  config window a new-window handler. Everything else about it (size,
  `maximized`, `visible: false`, decorations, macOS overlay title bar) still
  comes from the config entry via `WebviewWindowBuilder::from_config`.
- 0b: "no link below the root" is implemented as "canonicalize only the
  deck's own folder, walk the figure folder by name": the deck's folder is
  where the user opened the deck, and a lexical-root search cannot tell a
  legitimately symlinked project parent from an attack. The compile check
  is path-based (see residuals).
- 0c: only the save path changed. Reads keep one `FILE_READ_DATA` open with
  `FILE_OPEN_REPARSE_POINT` (a placeholder is reopened through the filter
  as before); a cloud filter refusing *read-data* opens of raw placeholders
  is not known.

**Sibling fixes (same hazard, in touched code):**
- `DiskUsagePane`'s "Open externally" called `open_file` directly, past the
  store; now through it (folders to `open_in_file_manager`).
- `open_in_file_manager` (and the file browser's reveal, moved onto it) ran
  a macOS `X.app` folder instead of showing it; now refused.
- "Add TeX figure" on a deck with no figure folder yet failed: no write
  ever made `<deck>.tex-figures` (`fs::write` never did either). The
  own-folder mode now makes it.

**Gotchas:**
- Tauri's plugin builder has `on_navigation` but no new-window hook; the
  handler must be on each `WebviewWindowBuilder`.
- A hot-reloaded frontend against an older backend: `open_file` ignores
  `checkOnly` and opens on the check — the store sees the returned window
  and does not open again; `global_inbox_open` returns nothing either way,
  so on such a backend the inbox file opens on the check and again after
  Open. Gone once the backend is rebuilt.
- The deck poll's `writes` fake reads headers, so a test asserting the
  strict header must look at the third `invoke` argument.

**Flagged for user:**
- Behaviour change (C2): every open of a file without a viewer (and
  Shift+double-click, Downloads previews, terminal path links to such files,
  Reader change cards, phone inbox files, disk usage) now asks first, even
  for a PDF or image the OS would just show, and even when you set a default
  app for the type. Scripts, launchers, installers and any file with an
  execute bit are no longer opened at all (note: "run it from a terminal").
  On Linux that includes executables you build yourself.
- Behaviour change (D6): `target=_blank` / middle-click on an external link
  now opens in the **system browser**, ignoring the in-app-browser link
  setting (the click handlers that route through it are unchanged).
  `mailto:` and other non-web `_blank` links open nothing.
- **Startup change, unverified:** the main window is now created by our
  `setup` code instead of by Tauri from `tauri.conf.json`. Code-reviewed
  only; if the window misbehaves at start (size, maximize, macOS title bar,
  the first-paint reveal), this is the first suspect.
- A refused navigation is silent in the UI (stderr only).
- Residuals: the launcher check and the open are by path (a racing swap in
  between is not caught); a configured default app or explicit handler is
  not judged; `compile_tex`'s own-folder check is path-based, so a folder
  swapped in the moment after it compiles in the swapped-in folder (the PNG
  write afterwards is still refused); remote (SFTP) figure writes follow
  remote links as before; reads on Windows still ask `FILE_READ_DATA` on
  the raw placeholder first.

**Live click-through (user only):**
1. Start a build with this backend: the main window opens maximized as
   before (Linux; on macOS the overlay title bar), popouts and the deck
   presenter open, the Connect window opens.
2. Double-click a `.xyz` file in the tree: "Open data.xyz with the system's
   default app?"; Cancel opens nothing; Open opens it. Same from Downloads,
   a terminal path link, a Reader change card and the header's phone inbox.
3. `printf '[Desktop Entry]\nType=Application\nExec=xterm\n' > run.desktop`
   in a project; double-click it (and Shift+double-click it): "run.desktop
   was not opened", nothing starts. `ln -s run.desktop notes.txt`, open
   `notes.txt`: same. `chmod +x` a plain `.txt`-less file and open it: same.
4. Open a file with "Open with…" a chosen app: no question.
5. Markdown preview: middle-click `[c](https://example.com)` → system
   browser; middle-click `[a](docs/x.md)` → nothing (left click still opens
   the tab). A page reload (Ctrl+R / Vite reload in a dev run) still works.
6. Mail HTML, the PDF viewer, the presenter, a popout and the in-app
   browser's live page: links behave as before.
7. Deck: on a deck with no figure folder, "Add TeX figure" now works. Then
   `rm -r talk.tex-figures && ln -s ../other talk.tex-figures`, Recompile:
   the link notice, nothing written into `../other`.
8. Windows + OneDrive (online-only file): edit and save in the viewer; the
   save works and the file hydrates.

## Agent step 4 — reviewer — 2026-10-12

**Commits:** `cc5af5de` fix(open): dropped files ask too; queue open
questions (gap 21 review) · this handoff commit. Reviewed
`47d08646..fade72f8` plus `96c8e183`.

**Checked:**
- Main window in `setup` (tauri 2.11.3 source read): Tauri's own `setup()`
  builds each `create: true` config window with exactly
  `WebviewWindowBuilder::from_config(app.handle(), cfg)?.build()?`, then
  `assets.setup` (a no-op for embedded assets), then the user `setup`;
  `create_main_window` is that same call plus `.on_new_window`, as the first
  line of the user `setup`, so every property (size, min size, maximized,
  `visible: false`, decorations, transparent, title, macOS `titleBarStyle`/
  `hiddenTitle`, `dragDropEnabled`, url `index.html` → `devUrl` in dev) comes
  from the same merged config entry. `tauri.macos.conf.json`'s `windows`
  array replaces the base one (merge patch), and both carry `create: false`;
  there is no Windows/Linux/dev override file, and no build script or CI step
  passes `--config` (`package-dev.sh`'s `cargo build --features
  custom-protocol` embeds the same merged config). Nothing before the user
  `setup` needs the window: the only plugins are dialog/drag/notification (no
  window-state, single-instance, deep link or tray); the crash-reporter
  install, X11/HWND/NSWindow id binds and `restore_main_window` (the reveal)
  all run later in `setup`; macOS's crash hook and Quit menu are app-wide
  and look the window up at event time. Built once (no other config window
  creation anywhere). The daemon build has none of it (`desktop`-gated).
- Nav gate: wry hands `on_navigation` every frame's navigation on WebKitGTK
  (`decide-policy` NavigationAction) and WKWebView, top level only on
  WebView2 (`NavigationStarting`). App frames are `srcdoc`/blank only (mail,
  reader, HTML preview, print preview), the app registers no URI scheme and
  never uses the asset protocol, downloads go through the backend, no code
  sets `location` or calls `window.open` in a desktop window, renderer reloads
  and the crash reporter's `reload()` stay on the origin. `about:srcdoc#x`
  keeps path `srcdoc`. Origin compare: case-folded host, `port_or_known_default`
  (`:80`/`:443` equal, any other port refused), userinfo cannot change the
  host; `javascript:` never reaches the policy (and the CSP has no
  `unsafe-inline`). No OAuth flow uses an app webview.
- New-window handler: on all five builders; wry's deny path (`SetHandled`,
  `None`/nil) cannot loop; Tauri's wrapper denies an unparsable URL itself;
  `open_external_url` re-checks `http(s)`. The Settings/intro `<a
  target="_blank">` links (Node, agent docs, Ollama) were dead before (Tauri's
  default denies) and now open in the system browser.
- C2: in-app-viewable files reach the OS only on explicit or pre-existing OS
  paths (Shift+double-click, "Open externally", a viewer the user disabled,
  Downloads previews, the blob pane, the phone inbox) — none of them opened
  in-app before, so no in-app open became a prompt. Launcher check:
  case-folded, Windows trailing dots/spaces, last extension only (a double
  extension opens as its last one), given and canonical name both (links,
  8.3 aliases; `.lnk`/`.url` themselves refused), exec bit on the resolved
  file, folders pass except macOS bundles. `open_file`'s new return type:
  every desktop caller only `.catch`es; the browser and Connect transports
  answer `checkOnly` with `null`; the phone never calls it.
- 0b: `x-no-folder-link` only makes a save stricter (plus a one-level
  `mkdirat` under a held handle, then the no-follow lookup; a racing link
  fails the lookup, a racing folder fails with EEXIST); the web client
  forwards it; all three deck figure paths send it. `compile_tex`'s check
  refuses a linked leaf or folder (Windows junctions read as symlinks) and
  compares canonical parents.
- 0c: both second opens are identity-compared against the attribute-only
  probe (`FileIdInfo` needs only `FILE_READ_ATTRIBUTES`, which both hold); a
  plain file's re-open on the name itself opens a swapped-in link as itself.
  Compiles in the msvc clippy/check gates.

**Bugs found and fixed (`cc5af5de`):**
- Dropped files skipped C2 entirely. A no-viewer file dropped on a tab bar
  (embed tab) or dragged out of the window was opened with
  `embed_capability`'s `resolved_exec` — usually the OS's own default for the
  type (xdg-mime, `AssocQueryString`, LaunchServices) — passed as an explicit
  handler, so the store did not ask and the backend did not judge: a dropped
  `evil.js` ran in `WScript.exe`, a `.py` in `py.exe`, a `.command` in
  Terminal, an `.exe` in Wine. The plan listed `EmbedPane.tsx` and
  `commitFileDrop.ts` as hand-offs to cover. `EmbedPane` now opens with no
  handler (`exec` stays on the tab for the later embedding phase) and the
  drag-out passes only the explicit `fileExec` hint (no caller sets one), so
  both go through the question and `os_open::check`; a default app the user
  configured is still found by `open_file`. Threat model row 21 says so.
  Tests (fail without the fix): `OpenExternalConfirm.test.tsx` "a dropped
  file's embed tab" (an EmbedPane with a WScript `exec` makes only the
  `checkOnly` call, handler `null`, and shows the refusal);
  `EmbedCapabilityGate.test.ts` drag-out of `evil.js` with a WScript
  `resolved_exec` passes no handler (and the existing drag-out case now
  expects none).
- Several opens at once lost all but the last. `stores/openExternal.ts` let
  a new question supersede (decline unseen) the pending one, so of a
  multi-file drop or drag-out of no-viewer files only the last file could
  open (the others' embed tabs said "opened externally"). Questions now
  queue; the dialog is keyed per question so the next one starts on Cancel,
  not on the Open just pressed. Test: "asks for each of several files opened
  at once, in turn" (fails on the old store; the focus assertion fails
  without the key).

**Gates:** `npm run build` ok. `npm test`: 802 files / 8055 tests passed
(8052 + 3). `cargo test --workspace`: 4264 passed, 0 failed, 4 ignored.
`cargo test -p tabtivity --no-default-features --lib --test server_secrets`:
3766 + 1 passed, 4 ignored (no flake this time). `npm run lint` (via `rtk
proxy`): 0 errors, 28 warnings (unchanged). The three clippy gates clean.
Windows cross-check (`clippy --target x86_64-pc-windows-msvc --all-targets
-D warnings`, `cargo check --workspace --all-targets`) clean.
`aarch64-apple-darwin` `cargo check --workspace --all-targets` with the
check-only CC/AR stand-ins clean (the 5 vendored `tauri-runtime-wry`
warnings). `scripts/brand-check.sh` ok, `scripts/privacy-check.sh` clean,
`git diff --check` clean. Rust untouched by this review; nothing run live,
`npm run backend:stale` not run.

**Flagged for user:**
- Exec-bit refusal on mounts without Unix modes: vfat/exFAT USB sticks,
  ntfs-3g, CIFS shares and WSL's `/mnt/c` usually show every file as
  `0755`/`0777`, so every no-viewer file there is refused ("not opened").
  That is what C2 says; say if such mounts should be judged by name only.
- Launcher lists, candidates not added (none runs code silently by default,
  or it depends on what is installed): Windows `.ws`, `.wsc`, `.sct`,
  `.xll` (Excel add-in), `.msu`, `.mde`/`.accde`/`.ade`/`.adp`, `.jnlp`,
  `.appx`/`.msix`, `.theme`/`.themepack` and `.search-ms` (can make
  Windows contact a host), `.iso`/`.vhd(x)` (mount; mark-of-the-web
  bypass); macOS `.afploc`/`.inetloc`/`.webloc` (open a share or URL),
  `.jnlp`, a folder with the bundle bit but no `.app` name; Linux `.jnlp`,
  `.flatpakref`/`.deb`/`.rpm` (installer UIs), `.chm` via Wine.
- The blob pane (`ProjectBlobPane`) hands every clicked file to the OS, PDFs
  and images included, and so now asks every time; it could open in-app
  viewers via `openFileEntry` instead (pre-existing routing, a design call).
- Deck "Edit" of a figure `.tex` opens it in the ordinary editor, whose
  saves use plain `Confined::Write` (the folder resolved), so with a linked
  figure folder the edit is saved into the link's target. The editor shows
  that file's content, so the user sees what they edit; not changed.
- Nav gate residuals: `about:blank`/`about:srcdoc` are allowed at top level
  too (the handler cannot tell frames apart), so a top-level navigation
  there would blank the app (no surface found that can trigger one);
  WebView2 frames are not gated (the CSP's `default-src 'self'` bounds
  them).
- Minor, not fixed: the Connect window's `open_file` answers a path string,
  which the store tracks as if it were a window row (pre-existing); on macOS
  revealing an `X.app` folder in the file browser or disk usage shows the
  raw `open_refused_launcher` code in their error line.
- The `ExecTrustHost` store has the same supersede pattern; two gated
  actions at once decline the first unseen (not this step's code).

## Agent step 5 — implementer (gaps 25, 33) — 2026-10-12

**Commit:** `0e98f604` fix(mail,ollama): mail AI and local reads only on a
local model; keep the taint (gaps 25, 33) · this handoff commit.

**Files:** `src-tauri/src/commands/ollama.rs` (`ollama_http_at` split out of
`ollama_http_within`; `is_cloud_name`; `is_remote_entry` also honours the tag;
`MODEL_NOT_RUNNING`, `model_is_local_in` (pure), `LocalityCache` (60 s,
definite verdicts only), `model_is_local_at`; `#[cfg(test)] test_tags`
thread-local `/api/tags` stand-in, unset = no server; `sanitize_alias` now
`pub(crate)`), `services/mail_ai.rs` (`preflight` + `chat_with`;
`cloud_model_reason`, `unlisted_model_reason`; module doc),
`services/root_mcp.rs` (`Identity::model`; `local_model_of`; `grant_root`
records it; `model_read_mail_marker`, `record_read_mail(state, tab, model) ->
io::Result<()>`, `marker_present`, `model_read_mail`, `spawn_read_mail`;
`local_model_confirmed` used by `handle_message` for `root_mcp_local_only`
and `root_mcp_mail_local_only`; test helpers `test_session_model`,
`TEST_LOCAL_MODEL`), `services/root_mcp_mail.rs` (`LOCAL_READ_CLOUD`,
`LOCAL_READ_UNRECORDED`; read gate), `services/root_mcp_review.rs` (test call
site), `src/stores/agents/ollamaActivity.ts` (`LocalModelInfo.remote`),
`src/components/layout/LocalModelMenu.tsx` (auto-assign skips `remote`),
`src/components/models/ModelsHubSections.tsx` (cloud model's Mail chip
disabled unless on, with the reason; `UntestedTag`), `src/lib/untested.ts`
(`localModelMenu.mailCloud`), `src/lib/i18n.ts` + de/es/fr/it
(`localModel.mailCloudTitle`), `docs/threat_model.md` (rows 25, 33
**Fixed, not live-verified.**; the incoming-mail and root-console rows),
`docs/context/root_console.md` ("Local means the model", per-model taint and
its trade-off, refusal names), `docs/filemap_backend.md` (`ollama.rs`,
`root_mcp.rs`, `root_mcp_mail.rs`), `docs/filemap_frontend.md`
(`LocalModelMenu.tsx`), `docs/help/local-models.md`,
`docs/help/mail-calendar.md`.

**Tests added:** `ollama.rs`: `cloud_names_are_judged_by_their_tag`,
`a_model_is_local_only_when_the_list_says_so` (local, `-cloud`, a cloud entry
copied under a plain name, unlisted, empty body, `{"models":[]}`, read error,
no server), `locality_verdicts_are_kept_a_minute_and_failures_not_at_all`,
`the_test_tags_hook_fails_closed_until_set`, plus a tag-only case in
`remote_entries_name_a_remote`. `mail_ai.rs`:
`a_cloud_mail_model_is_refused_before_the_chat_request` (`chat_with` answers
the cloud reason, never reaching capabilities or `/api/chat`; default model
too; unlisted/unreadable → unlisted reason; no server → `not_running`;
loopback still first). `root_mcp.rs`:
`a_local_tab_records_its_model_and_starts_with_the_models_taint` (the
`local_model_of` table; `grant_root` records model and endpoint; after one
tab's read, a new tab of the model — raw or alias-only — starts tainted,
another model does not, a cloud agent records no model),
`local_only_switches_refuse_a_local_tab_on_a_cloud_model` (cloud, unlisted
and no-model tabs refused under each switch; the installed model served; no
server refuses). `root_mcp_mail.rs`:
`local_reads_refuse_a_cloud_or_unconfirmed_model` (five models × search/read
→ `LOCAL_READ_CLOUD`, nothing latched in memory or on disk, drafts still
work; unreadable list / empty body / no server refused; the installed model
reads and writes both markers),
`a_read_whose_taint_marker_cannot_be_written_is_refused` (state is a file →
`LOCAL_READ_UNRECORDED`, in-memory latch set). `LocalModelMenu.test.tsx`: a
sole resident cloud model gets no roles; a local one beside a cloud one gets
them; the cloud model's Mail chip is disabled with the reason, the local
one is not. The existing local-read fixture (`local_reader`) now sets the
tags stand-in and writes markers into its temp dir.

**Gates (at `0e98f604`):** `npm run build` ok; `npm test` 802 files / 8058
tests passed; `cargo test --workspace` 4273 passed, 0 failed, 4 ignored;
`cargo test -p tabtivity --no-default-features --lib --test server_secrets`
3775 + 1 passed, 4 ignored (no flake); `npm run lint` (via `rtk proxy`) 0
errors, 28 warnings (unchanged); the three clippy gates clean; Windows
`clippy --target x86_64-pc-windows-msvc --all-targets -D warnings` clean
(no path/spawn/platform `cfg` code touched, so the `cargo check` and
`aarch64-apple-darwin` checks were not run); `scripts/brand-check.sh` ok;
`scripts/privacy-check.sh` clean; `npm run untested -- check` agrees;
`git diff --check` clean. `npm run backend:stale` not run (main agent at
landing). The commit hook printed "MOBILE BUNDLE IS STALE" — no
`mobile-web/` file is in this step; it predates it.

**Choices:**
- One gate for both paths: `model_is_local_at(addr, model)` asks the
  endpoint that will run the model — the settings' loopback address for the
  mail assistant, the spawn-recorded endpoint for a tab (`ollama_http_at`),
  not today's `ollama_host`. 10 s read timeout. Only `Ok` and
  `model_not_local` are cached (keyed by endpoint and model), so a server
  that comes up or a model just pulled is seen at once.
- `is_cloud_name` (`:cloud` or `…-cloud` tag) is a second opinion beside
  the list's `remote_*` fields, checked before the list is read; it also
  feeds `is_remote_entry`, so the phone load and the brain menu's `remote`
  flag agree. A plain-named copy of a cloud model is caught by the fields.
- `mail_ai::chat` maps no server to the `not_running` sentinel (the 🧠 UI
  branches on it), a cloud model to its own reason, anything else to the
  unlisted reason.
- `local_model_of`: raw `TABTIVITY_LOCAL_MODEL` wins; a raw/alias pair that
  disagrees, an alias no chipped model has, or one two models share is
  `None` (the tab then reads nothing). A local-model token always wears the
  MCP chip, so mapping the alias through `ollama_mcp_models` covers restored
  alias-only tabs.
- Read gate order: switch → loopback endpoint → model confirmed →
  latch in memory → write markers (refuse on error). A session-less
  local-model call (none exists outside tests) has no model and is refused.
- Model marker key: hash of `sanitize_alias(model)` under
  `root_mcp/read_mail_model/`. `marker_present` treats anything but
  `NotFound` as present (fail closed), for the tab marker too.
- Sibling, same hazard, fixed: `root_mcp_local_only` / `root_mcp_mail_local_only`
  served any `Caller::LocalModel` tab, a Vibe tab on a `-cloud` model
  included. `handle_message` now asks `local_model_confirmed` (the same
  gate, spawn endpoint + model): unconfirmed → "MCP access unavailable"
  under the first, `MAIL_LOCAL_ONLY` for mail tools under the second. Only
  asked while a switch is on.

**Gotchas:**
- Any test that drives a local-model mail read now needs
  `commands::ollama::test_tags::set(Some(body))` on its thread (unset reads
  as no server) and a writable `Stores::state` (the old fixture's
  `/nonexistent` now refuses the read with `LOCAL_READ_UNRECORDED`).
- `test_session_with(Caller::LocalModel, …)` records `TEST_LOCAL_MODEL`
  (`llama3:latest`); use `test_session_model` for another or none.
- The cache is skipped entirely under `cfg(test)` (the stand-in answers
  first), so `LocalityCache` is tested on its own.

**Flagged for user:**
- Behaviour change: with a Mail role (or default model) set to an Ollama
  cloud model, every mail AI action — summarise, formalise, event/task
  extraction, auto-classify — now answers "…is an Ollama cloud model…"
  instead of running. A model Ollama does not list (typo, deleted) answers
  the unlisted reason. The Mail chip of a loaded cloud model is greyed out.
- Behaviour change (gap 33 trade-off, as planned): once any tab of a local
  model reads mail, every later tab of that model starts tainted — all its
  calendar/board writes stage and its drafts are reader drafts — until you
  delete the marker under `<state>/root_mcp/read_mail_model/` by hand. There
  is no "clear conversations" action to hang it on; say if you want one
  (e.g. in the brain menu), or a narrower key.
- Behaviour change (sibling): with "keep the tools local" or "mail only for
  local models" on, a Vibe tab on a cloud model (or one whose model Ollama
  does not list, or while Ollama is down) gets no tools / no mail tools.
- Residuals: a verdict is reused up to a minute (a same-name swap to a cloud
  copy inside it is missed); the `-cloud` name rule could refuse a
  hand-named local model with that tag; a remote (non-loopback) endpoint
  under `root_mcp_local_only` is judged by its own `/api/tags`.
- Not verified live; the Mail chip has the `localModelMenu.mailCloud`
  untested pill.

**Live click-through (user only):**
1. Load a build with this backend, mail client on, a local model loaded and
   set as Mail: Summarise a mail — works as before.
2. `ollama pull gpt-oss:120b-cloud` (signed in to Ollama), load it: its Mail
   chip is greyed with "…is an Ollama cloud model…"; if it is the only
   loaded model, it is not given the roles.
3. Set the Mail role to it via `settings.json` (`ollama_roles.mail`):
   Summarise answers the cloud refusal; nothing reaches ollama.com (watch
   `ollama serve`'s log).
4. With "Let local models read mail" on, give the cloud model the MCP chip,
   open a Mistral Vibe tab on it in the root console and ask it to search
   mail: refused with "…could not confirm that this tab's model is one…".
5. On an installed local model's tab, read a mail; open a *new* tab of the
   same model and add a to-do: it stages (tainted). A tab of another model
   does not.
6. Turn "keep the tools local" on; the cloud-model Vibe tab gets no tools.
