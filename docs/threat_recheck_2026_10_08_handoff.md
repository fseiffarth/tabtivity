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
