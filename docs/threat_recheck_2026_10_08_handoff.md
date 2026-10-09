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
