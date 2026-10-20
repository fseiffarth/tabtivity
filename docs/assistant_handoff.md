# Tabby assistant — handoff

Plan: `docs/assistant_plan.md` (in the MAIN checkout, untracked; read it
from `docs/assistant_plan.md`).
Integration branch `assistant-int` (worktree
`.claude/worktrees/assistant-int`),
started from develop 2f0569c5. This handoff file also lives only in the main
checkout. Each agent edits only its own section below (Edit tool, never a
whole-file rewrite: parallel agents share this file).

## Rules for every agent

- AGENTS.md (repo root) is binding. Never start or stop the Tabtivity app.
- Work only in the worktree you were given. Never touch the main checkout's
  tree except this handoff file. Never `git stash`, never reset other
  branches, never push.
- A new worktree: `git worktree add .claude/worktrees/<name> -b <branch>
  <base>` from the main repo, then `cp -al
  node_modules
  <worktree>/node_modules` (hardlinks; never a symlink: pdf.js tests then
  collect 0 tests). Check the vitest test COUNT, not just the exit code.
- Commit in your worktree with `TABTIVITY_NO_AUTO_DEV_BUILD=1 git commit …`
  (no frozen dev build of a branch). Author email must be the GitHub noreply
  one already configured. End messages with
  `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. The pre-commit
  privacy check must pass; never bypass hooks.
- Cargo: `export CARGO_INCREMENTAL=0`. Prefer running only your module's
  tests while other implementers run (`cargo test -p tabtivity --lib --
  <module>`), then the gates your step touches via `scripts/gates.sh` before
  your final commit. A background shell lacks cargo on PATH: `export
  PATH="$HOME/.cargo/bin:$PATH"`.
- Read source with the Read tool or `rtk proxy rg/sed/cat` (the RTK hook can
  rewrite plain Bash output). Lint truth: `rtk proxy npx eslint <files>`.
- Hot shared files (`src/lib/i18n.ts`, `docs/filemap_*.md`,
  `services::command_class` + generated `commandClasses.ts`,
  `src/lib/untested.ts`): if your step is marked PARALLEL, do not edit them;
  list the exact additions under "Hot shared files" below.
- Fixed decisions in the plan may not be changed. A design objection goes
  under "Flagged for user", not into code.
- When done (or low on context), stop at a green commit and write your
  section: commit shas, what you built, choices you made, gotchas, gate
  results with test counts, anything left.

## Hot shared files (apply once, by the main agent)

## S0 — CLI flags (A0) — done

Results are in the plan's pinning table (Claude 2.1.300, Codex 0.162.1,
OpenCode 1.19.1, Ollama 0.40.3). All four profiles offered. User decisions
13 (Codex catalog, fail closed, no `-s`) and 14 (`--allowedTools mcp__web`
for local Claude) added to the plan.

## S0b — skeleton — done

Commit `fce49aab` on `assistant-int` (one commit, 34 files). `scripts/gates.sh`
all PASS (brand, whitespace, lint-fe, clippy, clippy-dlib, clippy-dmn, build,
vitest, test, test-dlib). Vitest 6932 tests / 695 files (was 6931 + 1 failing
i18n coverage test on the first run, fixed with de/es/fr/it strings); cargo
`tabtivity --lib` about 4100 tests. New tests: 6 in `services/assistant.rs`,
1 `storage`, 2 `schema/settings`, 1 `root_mcp_security`, 1 route test in
`commands/root_mcp.rs` (`a_web_token_is_refused_on_every_mcp_path`), 1 brand.
Not run: the Windows/macOS cross-checks (the plan wants them before a push,
not before this commit). No live run, no `backend:stale` needed (nothing
reachable changed).

### The contract (names the next steps must use)

**Brand.** Rust `crate::brand::ASSISTANT_NAME` ("Tabby") and macro
`crate::assistant_name!()` (re-exported in `src-tauri/src/lib.rs`); TS
`BRAND.assistant`, `NAMES.assistant`; dictionaries write `{assistant}`
(filled by `fillBrand`). It is a word of its own, not derived from the slug:
it has no `LEGACY_*` twin and `BrandMirror.test.ts` exempts it from the
"moved with the rename" loop and checks it in its own test.

**storage.rs.** `storage::ASSISTANT_SCOPE = "assistant"`,
`storage::is_reserved_scope(id) -> bool` (root or assistant; trims, reduces
through `project_key`, compares case-insensitively). S1a applies it at the
funnel sites listed in the plan; `box:<id>` callers pass the id part.
Frontend: `src/lib/assistant.ts` exports `ASSISTANT_SCOPE` (S4a imports it).

**Settings** (`schema/settings.rs`, TS `src/types`): `Settings.assistant:
Option<bool>` (the experimental flag; `EXPERIMENTAL_FLAGS` has `"assistant"`;
Settings -> Experimental switch with `settings.assistant` pill and strings in
all 5 languages), `Settings.assistant_settings: Option<AssistantSettings>`
(`default_cli`, `default_model`, `search: Option<AssistantSearchSettings
{ kind, searxng_url }>`, all `Option<String>`, both structs `#[serde(flatten)]
extra`; `ASSISTANT_SEARCH_KINDS = ["searxng","ollama"]`; TS `AssistantSettings`),
`AppMobileHostSettings.assistant_access: Option<bool>`. Gates:
`Settings::assistant_enabled()` = the experimental flag (desktop: commands,
spawn, lane); `Settings::assistant_phone_open()` = flag and `assistant_access
!= Some(false)` (the phone rule; S5a's raw-JSON `assistant_open` mirrors this
one and tests agreement). `MobileSettings.tsx` now carries `assistant_access`
through its three explicit rebuilds of the host block (a settings patch is
shallow: it would have been dropped).

**`services/assistant.rs`** (S1a owns the bodies; signatures are final):
- `SYSTEM_PROMPT: &str` (no `"`, `\`, `$`, backtick, newline; tested).
- `enum AssistantCli { Claude, Codex, OpenCodeLocal, ClaudeLocal }`, serde ids
  `claude`, `codex`, `opencode_local`, `claude_local`; `ALL`, `id()`,
  `from_id(&str)`, `label()`, `bin()` (the tab `cmd`: claude/codex/opencode/
  claude), `is_local()`, `local_driver()` (`"opencode"`/`"claude"`, the
  `LOCAL_DRIVERS` ids).
- `struct AssistantLaunch { cli: AssistantCli, model: Option<String> }`
  (`deny_unknown_fields`, `model` skipped when `None`). Model validation is
  S1a's, inside `launch_line`/`new_chat_record` (needs a `pub(crate)` wrapper
  of the private `commands::ollama::validate_model_name`).
- `enum Refusal { NotBuilt, NotOffered, ModelRequired, BadModel, BadUid,
  NoLane, CodexCatalog }` with `code() -> &'static str` (fixed category) and
  `Display` (user text); `std::error::Error`. S1a may add variants.
- `struct LaneGrant { url, token }` and `LaneGrant::from_env(&HashMap) ->
  Option<Self>` reading `root_mcp::WEB_URL_ENV` / `WEB_TOKEN_ENV`.
- `struct LaunchCtx<'a> { tab_uid, chat_dir_existed, home: &Path, lane:
  Option<&LaneGrant> }`, `struct AssistantSpawn { cmd, args, env:
  HashMap<String,String> }`.
- `launch_line(&AssistantLaunch, &LaunchCtx) -> Result<AssistantSpawn,
  Refusal>`: stub `NotBuilt`.
- `new_chat_record(state_dir: &Path, &AssistantLaunch, uid: &str,
  request_hash: Option<&str>) -> Result<TabEntry, Refusal>`: stub `NotBuilt`.
  Doc says what it must return (agent tab, `cmd = cli.bin()`, `cwd =
  chat_dir`, `sessionId = uid`, `assistant` block, `mobileRequestHash`).
- `is_offered(AssistantCli) -> bool`: real, true for all four (A0 passed).
- `assistant_root(state_dir)`, `work_root(state_dir)` (`<state>/assistant/work`,
  the S1b support mount), `chat_dir(state_dir, uid) -> Result<PathBuf,
  Refusal>` (real: uuid-shaped check via `agent_session::is_uuid_shaped`,
  `Refusal::BadUid` otherwise; builds the path, creates nothing).

**PtyOptions.assistant: Option<AssistantLaunch>** (`#[serde(default,
skip_serializing_if = "Option::is_none")]`), every Rust literal has
`assistant: None`. Frontend `PtyOptions` TS type is not touched (S4a).

**`root_mcp.rs`:** `Caller::Web` (serde `web`), `lane()` = 5,
`WEB_TOKEN_ENV`/`WEB_URL_ENV` (`<UPPER>_WEB_MCP_TOKEN/_URL`),
`Runtime.serves_web` (false at all four literals: S2 sets it true in
`commands/root_mcp.rs::serve` for the window and in the Mobile host's
runtime, false for the daemon), `Web` excluded from `mark_tab_projects_readable`,
`tab_active`, `sessions()`, and refused by `set_access`.
`root_mcp_security`: `Policy::serves` is now positive (`Agent | LocalModel |
Reader`), `ToolPolicy` has a private `web: bool` field (all rows false; S2 adds
the web tool rows with `web: true` and `serves(Caller::Web) => self.web`),
`Access::initial(Web)` is empty and read-only, `reads_mail` has a `Web` arm.
`root_mcp_mail::origin_of(Web) = "web"`. `commands/root_mcp.rs`: `path_serves`
"/mcp" is positive; `/mcp/web` is not routed yet (the `_ => false` arm);
`handle()` has a second wall for `Caller::Web` right after the batch check
(S2 replaces it with the lane's branch).

### Choices and gotchas

- `launch_line` takes a `LaunchCtx` instead of the plan's three positional
  args, because it needs the lane (url + token: Claude takes `Bearer
  ${WEB_MCP_TOKEN}` through env expansion as `wire_named_cli_args` does, but
  OpenCode's inline config carries the token in env) and the home (Codex's
  catalog file, decision 13). **Order for S1a/S2:** `grant_lanes`' assistant
  arm must run first (it puts `WEB_URL_ENV`/`WEB_TOKEN_ENV` in `opts.env`),
  then `LaneGrant::from_env(&opts.env)`, then `launch_line`, whose
  `AssistantSpawn` replaces `cmd`/`args` and its env is merged over a cleaned
  env. A cloud profile runs with `lane: None` (native search only); a local
  one answers `Refusal::NoLane`.
- S3 cannot see a happy `new_chat_record` until S1a lands: it should test its
  command against the refusal and the flag, and inject nothing.
- `ToolPolicy`/`Access::allows`: a web tool's `family` ("web") is not in
  `Access::validate`'s four families, so `allows()` would refuse it. S2's
  handler must gate with `security::tool(name).is_some_and(|t|
  t.serves(Caller::Web))` like `help_mcp` does, not through `Access`.
- `serves_mail` was left as it was (the existing test pins it for every
  class); `Web` is kept out by `Policy::serves` and `ToolPolicy::serves`.
- Untested register: the registry test fails on a row no source file uses, so
  `src/lib/assistant.ts` holds `ASSISTANT_PENDING_PILLS` (`untested:
  "assistant.overlay" | "assistant.newChat" | "assistant.search" |
  "mobile.assistant"`) as the rows' placeholder call sites. S4b deletes its
  three entries when it adds the real `<UntestedTag>`s, S5b the last, then the
  constant. The Settings switch wears its own row `settings.assistant`.
- The i18n suite requires every key in all 5 languages; S4b's new keys need
  de/es/fr/it too.
- Nothing is routed to `/mcp/web` yet; no `*_MCP_TOKEN` of the web class can
  be minted (no `grant_*` exists), so the refusal is exercised through
  `test_session(Caller::Web)`.

### Hot shared files (applied here, one line each left for the main agent)

Applied: `untested.ts` (5 rows), `i18n.ts` + the four dictionaries
(`settings.assistant`, `settings.assistantHelp`). Not applied (S5c): filemap
rows for `services/assistant.rs` and `lib/assistant.ts`.

## S1a — scope, spawn profile, registry funnel

Commit `b17b92d8` on `assistant-s1a` (one commit, 16 files, on 2b29680e).
`scripts/gates.sh`: brand, whitespace, clippy, clippy-dlib, clippy-dmn, test,
test-dlib all PASS (no frontend change). New tests: 30 (assistant 15,
launch_prep 8, terminal_service 3, ollama 1, projects 1, boxes 1, discovery 1,
agent_prompts 1, agent_shim 1, token_stats 1, usage_stats 1); the 187-test
module run is green. Not run: Windows/macOS cross-checks (plan: before a
push). No live run, no `backend:stale` (nothing reachable: flag off).

### A0 points verified (real OpenCode 1.19.1 against mock MCP and LLM servers)
- `{env:NAME}` IS substituted in `mcp.*.headers` of `OPENCODE_CONFIG_CONTENT`.
  The config holds `Bearer {env:<UPPER>_WEB_MCP_TOKEN>}`; the token stays only
  in the spawn env (`LaneGrant.token` is therefore unused by launch_line).
- With the tools map set false for the 15 names, the model sees only
  `web_web_search` (the lane's tool); the token arrived as `Bearer tok-xyz`.
- `--continue` continues the latest session of the WORKING FOLDER only (two
  folders, continuing in A extended A, not B), and in a folder with no session
  it just starts fresh (exit 0). So `--continue` iff the chat folder existed.
- Not checked (no Codex binary fetched): `codex -c … resume <id>` ordering
  (there is repo precedent: `grant_*` prefix `-c` before `resume`), and Codex
  accepting a `model_catalog_json` file built from `models_cache.json`.

### What exists (names for the next steps)
- `assistant::validate_launch`, `AssistantCli::uses_lane()` (false for Codex:
  **S2's `grant_assistant` should mint the lane only for `uses_lane()`
  profiles**), `record_launch(&TabEntry) -> Option<AssistantLaunch>`,
  `ASSISTANT_KEY`, `claude_local_tail_ok`, `Refusal::Config` (new variant,
  code `config`). `LaunchCtx` got `visible_home` (path the process sees the
  home at: real home path on Linux fence, the home itself elsewhere) and
  `opencode_provider` (the caller reads it: `ollama::opencode_assistant_provider`).
- `new_chat_record`: kind `agent`, `assistant` block, `sessionId = uid`,
  `launchedAt`, optional `mobileRequestHash`; NO `args`/`env`/`scheduleTargetId`.
  The window/phone derive `TAB_UID` from `sessionId`: **S5a's `launch_options`
  and S4a's spawn must put `env {TAB_UID: sessionId}` and
  `PtyOptions.assistant = tab.extra.assistant` themselves** (the gate demands a
  uuid-shaped `TAB_UID` in env and ignores every other env key).
- Launch profiles exactly as the plan table. Claude: `--session-id <uid>`
  first (resolve turns it into `--resume`), then `--model=`, `--tools
  WebSearch --strict-mcp-config [--mcp-config <lane, Bearer ${WEB token env}>]
  --disable-slash-commands --append-system-prompt`. Local Claude: `ollama
  launch claude --model m -- <tail>`, tail starts `--session-id uid`, or
  `--continue` when a transcript for uid exists in `<home>/.claude/projects`
  (a reused `--session-id` is a hard error); `LOCAL_MODEL` and `TAB_AGENT`
  env set. Local OpenCode: `opencode --model ollama/m [--continue]` plus
  `OPENCODE_CONFIG_CONTENT` and `LOCAL_MODEL` (so the user's API-key proxy is
  skipped). Codex: no `--model` unless chosen; catalog file
  `<home>/.codex/assistant_models.json` written through `home_io` and verified.
- `commands::ollama`: `pinned_local_line`, `model_name_ok`,
  `opencode_assistant_provider`, `catalog_arg_pair` now `pub(crate)`;
  `local_launch_line_ok("claude", …)` accepts `… --model m -- <exact tail>`.
- `launch_prep::prepare`: `assistant_gate` right after `strip_control_env`
  (refuses: flag off, plain shell/agent in the scope without a launch, a launch
  outside the scope, reserved id spellings, bad/missing `TAB_UID`, host
  session, remote host, login, tmux attach; rewrites cwd/env/cmd/args/flags;
  clears schedule and host-bound ids). For a chat it skips enforce_spawn_authority, VM
  refusal, mirror cwd, O#149 gate, project_dir, the early resolve/reserve,
  the OpenCode loaded-models step and `--remote-control`; `fence_roots =
  Some(vec![])` (independent of S1b's `roots_for_scope`). After `grant_lanes`
  it calls `prepare_assistant_home(local, chat_dir)` (S1b), then
  `launch_line`, then resolves the session; the fence arms (Fenced and
  platform) reuse that home; any other decision refuses the chat.
  Codex resume: the resolver replaces the whole argv, so it is run on an empty
  argv and the pinned args are put in FRONT of `resume <id>`.
  `CONTROL_ENV` has the web vars; `SpawnTokenGuard` revokes the web token
  (small hunk in `root_mcp.rs`, S2 will merge it trivially).
- Funnel: `is_reserved_scope` in `commands::projects` (`read_projects_list`
  drops, `patch_projects_list_at` drops then refuses, `validate_project_id`),
  `commands::boxes` (`read_boxes_at` drops, `write_boxes_stamped` refuses),
  `discovery::scope_sources`, `sandbox::project_dir_for`.
  `terminal_service::sanitize_assistant_layout` (applied in `load_terminal_session`,
  `write_terminal_session`, `workspace::snapshot` and `workspace::sync`;
  `workspace::mint_for_created` mints no schedule binding for the scope;
  `after_state_session_write` never writes an export copy there).
  `agent_shim::plan` refuses the scope. `agent_prompts::record{,_at}` and
  `headless::record_prompt` record nothing for it. Usage: `known_scope_ids` and
  `token_stats::scan_with` always include the scope.

### Gotchas / for others
- **Codex needs `<assistant home>/.codex/models_cache.json`** (Codex writes it
  after a run with a login). A home Codex never ran in refuses with
  `CodexCatalog`, and the assistant fence never gets to run it: chicken and
  egg for a first-ever Codex chat. I did NOT seed it from another home or the
  user's `~/.codex` (a planted cache in a project home would steer the
  catalog). Flagged for the user below; S1b/S3 may decide on a seed.
- `services::remote::remote_target_for("assistant")` and other direct
  `projects.json` readers still see a planted record; the spawn path never asks
  for the scope (gate-skipped) and the registries drop it. Not closed in
  `services/remote.rs` (hot path, not in my list).
- Local profiles do not check Ollama's `tools` capability or `ollama launch`
  availability (`prepare_local_launch` does); S3's options command should.
- `workspace::sync_in` itself is unchanged (path-based): sanitising is in the
  project-keyed `sync`/`snapshot` wrappers. S5a's sidecar creates through
  `create_tab_in`/`edit_in` with `new_chat_record`, which already conforms.
- OpenCode's tools map names are from the plan; OpenCode `run` needs its
  provider npm package (it fetched one at first run); not an issue for chats.
- Hot shared files: none edited. Filemap rows to add (S5c): `services/assistant.rs`
  (profiles/launch_line/new_chat_record), `launch_prep.rs` row mention of the
  assistant gate.

## S1b — agent home + fence

Commit `21c2fb34` on `assistant-s1b` (from `assistant-int` 2b29680e); only
`services/agent_home.rs` and `services/agent_fence.rs` touched.

**Gates** (`scripts/gates.sh --base 2b29680e`): brand, whitespace, clippy,
clippy-dlib, clippy-dmn, test (`tabtivity` + `app-serverd`), test-dlib all
PASS, zero warnings. 12 new tests (5 `agent_home`, 7 `agent_fence`), the two
modules 58/58. Windows `cargo clippy --target x86_64-pc-windows-msvc
--all-targets -D warnings` clean (after fixing one `useless_vec`);
`cargo clippy -p tabtivity --all-targets --target aarch64-apple-darwin -D
warnings` (check-only CC/AR shims) clean. Not run: the whole-workspace darwin
`cargo check`, Windows/macOS tests, anything live.

**What S1a must know**
- `agent_home::prepare_assistant_home(local, chat_dir)`: `chat_dir` must be
  strictly below `assistant::work_root(state_dir)`, no `..`, else
  `InvalidInput` (creates no home). It **does not create `chat_dir`**, so
  compute `chat_dir_existed` before or after, either is safe; create it
  (0700) yourself before the wrap. It returns the `assistant` or
  `assistant.local` home. Failure to write the trust files returns `Err`:
  refuse the spawn.
- The fences: pass `roots = &[]` (`roots_for_scope(Some("assistant"), _)` now
  gives `Some(vec![])`, so `launch_prep` can keep its normal call; mind code
  after it that picks an "own" root from an empty list). `scope_id` must be
  `"assistant"` and `scope_home` the home above. Both wrappers call
  `check_assistant_spawn` first and refuse (`Err`, fixed text) on non-empty
  roots, a foreign home, or a `cwd` that is not a plain path below
  `work_root` (so `opts.cwd` must already be the chat dir when wrapping).
- Matching uses `agent_fence::is_assistant_scope` (`project_key` + trim +
  case-insensitive), so `Assistant` or ` assistant` are the scope too.
  `compute_fence_roots` also returns `Some([])` and `attach_roots` returns
  `None` for it (mail attach refuses).
- `status_for_scope("assistant")` answers `enforced: false, reason:
  "assistant scope", roots: []`; `one_shot_command` returns `Err` for it on
  every OS. `agent_shim` still needs your own refusal (not touched here).

**Choices and gotchas**
- New `Seed::Assistant`; `prepare_home_in` is now a wrapper over
  `prepare_home_with(.., trust: Option<&Path>)`, so the trust write happens
  inside the per-home lock (two chats starting at once cannot lose each
  other's entry in the shared `.claude.json` / `config.toml`).
- Seeded with nothing; `agent_global::apply_to_home` and
  `copilot_auth::prepare_home` skipped; hooks and `agent_auth::link_into_home`
  kept. Claude: `.claude.json` gets `projects.<dir>.hasTrustDialogAccepted`
  (raw path plus its resolved form) and `hasCompletedOnboarding` only if
  absent (the login keeper fills the user's own identity/theme).
  Codex: `[projects."<dir>"] trust_level = "trusted"` via `toml_edit`
  (other tables and hook order untouched). An unparsable or wrong-shaped file
  is renamed to `<name>.unreadable` and rebuilt; a link at the path is never
  followed (`HomeFile`).
- **Live check (A0 open item):** real Claude 2.1.300 in a scratch HOME with
  exactly that `.claude.json` (fake API key) showed neither the theme/
  onboarding screen nor the folder-trust dialog; an empty `.claude.json`
  showed the theme picker. Codex could not be run (its binary is hidden inside
  my fence): its trust format is the one existing tests use, but it is **not
  verified live**. Also unverified: Codex's hook review. Tabtivity's Codex hook
  has no `trusted_hash` in a fresh home, so the first start may still ask the
  user to review it (same as any new scope home; not changed here).
- The work mount is `<state>/assistant/work` as a whole (the plan's
  design), so a chat can see other chats' folders. They are empty scratch
  folders with the file tools off; flagged below.
- macOS: `sandbox_exec_inputs` now builds its inputs through the pure
  `seatbelt_scope_inputs` / `seatbelt_mount_paths` (same output as before for
  other scopes), so the empty-roots profile is tested on Linux. CLI install
  paths (`command_bind_paths`, `agent_install::fence_read_only_paths`) stay
  readable, since the CLI must run; only the user's allowlist and the root
  project view are dropped. On Linux the CLI install dir and `--ro-bind / /`
  system folders remain visible, as the plan notes.

**Flagged for user**: all assistant chats share one read-write `work` bind;
binding only the chat's own folder would need the uid in `agent_state_mounts`
(a plan change, not made).

## S2 — web lane

Commit `9a6c5b5b` on `assistant-s2` (one commit, on `assistant-int` 2b29680e).
`scripts/gates.sh` all PASS (brand, whitespace, clippy, clippy-dlib, clippy-dmn,
test, test-dlib; no frontend change). New tests: 16 in `services/web_lane.rs`,
4 + 1 in `browser_engine` (hop 0 literals, scheme/userinfo, 3 hops, mixed DNS
answer, loopback socket end to end incl. redirect), +~15 cases in
`web_safety`, `web_route_is_its_own_lane`, the router/audit end-to-end test,
`an_assistant_spawn_gets_the_web_lane_alone_…`, 2 in `root_mcp_security`,
1 in `remote_credentials`; `a_headless_claude_tab_is_handed_…` (Mobile host)
extended. Not run: Windows/macOS cross-checks, no live run (nothing reachable
until the app is rebuilt; `backend:stale` applies after merge).

### Contract for S1a's `launch_line`

- `grant_lanes` assistant arm (`root_mcp::grant_assistant(opts, runtime, store,
  state)`) runs first. It puts `WEB_URL_ENV` = `http://127.0.0.1:<port>/mcp/web`
  and `WEB_TOKEN_ENV` in `opts.env` **only if** `runtime.serves_web` AND
  `settings.json` has the `assistant` flag on (`Settings::assistant_enabled`)
  AND the profile wants it. Claude, OpenCodeLocal, ClaudeLocal: yes. Codex: no
  (a private `assistant_wants_lane` match in root_mcp.rs; assistant.rs untouched).
  Otherwise nothing is added, so `LaneGrant::from_env` is `None` (cloud profile
  runs on native search; local profile answers `NoLane`).
- Token: `Caller::Web`, bound to `opts.id` (the tab), no project; revoked by
  `revoke_tab`; one per tab (a respawn replaces it). It is the only `*_MCP_TOKEN`
  an assistant spawn holds (tested with every other lane's switch on and a
  `schedule_target_id` sent). `CONTROL_ENV` and `SpawnTokenGuard` (S1a) must list
  both env names.
- MCP server name `web`, tools `web_fetch {url}` and `web_search {query,
  count?}` (both always listed; a cloud Claude may call `web_search` and gets
  `search_not_configured` unless a backend is set).
- `serves_web`: true for the window (`start`) and a desktop's Mobile host
  (`start_headless_on` with `ctx == None`); false for a server daemon
  (`ctx.is_some()`). The only real `Runtime` literal is in
  `commands::root_mcp::serve` (new `serves_web` param); host.rs only has a test
  literal (the window's, now `true`).

### Choices and gotchas

- Fixed categories: `not_public, too_large, unsupported_type,
  search_not_configured, key_unreadable, budget, off` plus three I had to add:
  `invalid` (bad URL/scheme/userinfo/args), `fetch_failed`, `search_failed`.
  `too_large` is for a search reply over 1 MB; an over-5 MB *page* is served
  truncated with `truncated: true` (like the reader), not refused.
- Budget: 120 calls (fetch + search together) per tab per rolling hour
  (`Session::admit_web_rate`, `web_lane::CALLS_PER_HOUR`); schema-invalid and
  `off` calls cost nothing. Whole call deadline 15 s (socket life is 30 s).
- Audit: tool name + fixed category only; the handshake is not audited.
- `browser_engine`: `FetchOrigin::Agent` (hop 0 judged like a later hop, http
  allowed, userinfo refused on every hop with token `userinfo`),
  `fetch_for_agent`, `judge_resolved` split out of `resolve_hop` (mixed answers
  testable). `fetch_reader` now shares `fetch_page`.
- `web_safety` gaps closed (shared with mail/browser): the "this network",
  benchmarking and reserved IPv4 blocks; IPv6 NAT64 (well-known prefix) and
  6to4, IPv4-compatible and IPv4-translated forms judged as their embedded v4;
  local-use NAT64, Teredo and site-local IPv6 refused. The documentation
  ranges stay "global" (existing tests use them). Exact blocks: see the
  `web_safety.rs` tests.
- For S3: read helpers are `web_lane::validate_searxng_url(&str) ->
  Option<Url>`, `SearchConfig::from_settings`, and write the key with
  `remote_credentials::set(&web_search_account("ollama"), Some(key))`.
- Privacy hook: IP literals in tests carry `// privacy-check: ok` markers.
- Hot shared files for the main agent: filemap_backend row for
  `services/web_lane.rs` ("assistant web lane: guarded fetch + search on
  /mcp/web"), plus the new rows' mention in `browser_engine.rs`.

### Flagged for user

- (web lane verifier) **Search backend client honours proxies.** `search_client()`
  has no `.no_proxy()`: behind `HTTP(S)_PROXY` the SearXNG/Ollama requests go
  through the proxy. Decision 15 names the agent *fetch* only, and the
  configured backend is the user's own trusted address (a proxy is a way to
  reach it), so left as is. One line (`.no_proxy()`) if you want it uniform;
  it would break a proxy-only network for search.
- (web lane verifier) **DNS split-horizon oracle accepted.** `not_public` vs
  `fetch_failed` lets a model tell whether a name resolves to a private address
  (for internal names). It learns existence of a name only, never content; the
  alternative (one category for both) hides real failures from the user.
- (web lane verifier) **Any TCP port on a public host is allowed.** Public
  hosts only, so a port is no more than that host already exposes; limiting to
  80/443 would stop legitimate docs and APIs on other ports. Left.
- (web lane verifier) **Hairpin via NAT stays open** (see finding 1): a host
  whose only address is private can reach itself through its router's public
  IPv4 if the router loops back. Not detectable locally; fixed decision 5 keeps
  the lane's resolved-address rule as the line.

- `reader_client` honours `HTTP(S)_PROXY`; behind a proxy the DNS pin/check is
  bypassed (the proxy resolves). Same posture as the reader; for Tabby it means
  an SSRF guard depends on the proxy's own network. Left unchanged.

## S3 — commands + settings

Commit `e39d1ad4` on `assistant-s3` (based on `assistant-int` 2b29680e; 7 files,
+675). Gates (`scripts/gates.sh`, load avg ~70 so slow): brand, whitespace,
lint-fe, clippy, clippy-dlib, clippy-dmn, build, vitest (`--changed`, nothing
new to run), test (`cargo test -p tabtivity -p app-serverd`), test-dlib: all
PASS, zero new warnings. 8 new tests in `commands::assistant` (module run:
30 passed with the allowlist/command_class filters). Not run: Windows/macOS
cross-checks; no live run; no `backend:stale` needed in this worktree.

### What S4b / S5a call (TS wrappers in `src/lib/assistant.ts`)

All three are `core`, refuse with the wire code `assistant_off` while
`Settings::assistant_enabled()` is false (a missing settings file = off). A
refusal of `services::assistant` comes as `"<code>: <text>"` (`not_offered`,
`model_required`, `bad_model`, `no_lane`, `codex_catalog`, `not_built` until
S1a lands). `assistantErrorCode(err)` extracts the code.

- `assistant_options()` -> `AssistantOptions { clis: [{ id, label, local,
  installed, signedIn: bool|null, ready }], localModels: string[],
  ollamaReachable, defaultCli, defaultModel, search: SearchState }`.
  `id` is the `AssistantCli` id (`claude|codex|opencode_local|claude_local`).
  `signedIn` is null for local CLIs; `ready` = installed and (signed in, or
  Ollama reachable with a model). Ollama is probed with a 3 s read timeout.
  TS: `assistantOptions()`.
- `assistant_new_chat({ cli, model? })` -> `{ tabId, uid, scope: "assistant",
  version }`. `model` required for local CLIs (S1a validates). TS:
  `assistantNewChat(cli, model?)`. It mints a uuid (`projects::uuid_v4`), calls
  `assistant::new_chat_record(state_dir, launch, uid, None)`, appends via
  `workspace::create_tab_in(terminal_service::state_session_path("assistant"),
  "assistant", ...)` and emits `workspace:patch`
  `{ scope, version, ops: [{ op: "created", id }] }` (the same event
  `workspace_sync` emits; the headless/mobile create does not emit it from
  Rust). **S4a: confirm WorkspacePatchHost mounts a `created` op for the
  assistant scope.**
- `assistant_set_search({ kind, url?, key? })` -> `{ search: SearchState,
  settings: Settings }`. `kind` = `searxng` (needs `url`) | `ollama` (needs a
  stored or given `key`) | `none`. `url` http/https, host required, no
  userinfo, no fragment, stored normalised (`Url::to_string`). `key` goes to
  the keychain only (never in `settings.json`, never returned); empty `key`
  removes it (then `kind` may not be `ollama`). Errors: `invalid_kind`,
  `invalid_url`, `url_required`, `invalid_key`, `key_required`, or the
  keychain's own text (locked: "the OS keyring is locked, so nothing was
  saved"). Keychain is written first, then settings (`rev` bumped). The
  caller should broadcast `settings` like `persistSettingsPatch` does
  (`set({settings})` + `SETTINGS_CHANGED_EVENT`). TS: `assistantSetSearch(kind,
  { url, key })`.
- `SearchState { kind: "searxng"|"ollama"|null, searxngUrl, ollamaKeyStored:
  bool|null (null = keychain unreadable), keyring: unlocked|locked|unavailable,
  configured }`. Unknown stored kinds read as null.

### Choices / for the merge

- **Merge swap (S2):** `OLLAMA_SEARCH_ACCOUNT = "web-search:ollama"` is a
  local const in `commands/assistant.rs` with a `// S2: replace with
  remote_credentials::web_search_account("ollama")` note.
- `command_class`: three `Core` rows under `// commands/assistant.rs`;
  `commandClasses.ts` regenerated (+3 lines); `MODEL_ARG` row
  `("assistant_new_chat", "model")`. `NOT_DISPATCHABLE` needed nothing (the
  build's wrapper reads `Ctx` + `Option<String>` signatures fine).
- Settings round-trip: tests cover an absent block and unknown keys in the
  block and the search block (kept through `assistant_set_search`).
- `new_chat_at` test is tolerant of both the skeleton (`not_built`) and S1a's
  real body; after the merge add a happy-path test that asserts the stored tab
  carries the `assistant` block and the patch event.
- The cloud model id passes the `MODEL_ARG` check on a server too; the plan
  keeps the assistant off servers, so this only matters if that changes.

## S4a — tabs store + pane layer

Commit `8f5d5df5` on `assistant-s4a` (on `assistant-int` 87592f42;
17 files, frontend only). Gates (`scripts/gates.sh`): brand, whitespace, lint-fe, build
PASS (no new eslint warnings; the 3 in TerminalView are pre-existing). Vitest:
full run 847 files / 8579 tests, all green after fixing my own test's type
errors (`TypeCheckGate` type-checks tests); the `gates.sh` `--changed` run hit
one load-flake (`MobileIndicator`, passes alone). 13 new tests in
`src/__tests__/assistant/AssistantScope.test.tsx`. No Rust touched, no
`backend:stale` needed, not run live.

### API for S4b (and S5a's window half)

- `src/stores/assistantScope.ts` (new): `ensureAssistantScopeHydrated():
  Promise<boolean>` (lazy restore; true once the key exists, false in a popout;
  call it when the overlay first opens), `assistantTabs()`,
  `assistantTabById(tabId)`, **`mountAssistantChat(tabId)`** (hydrates first,
  re-reads the stored set if the `workspace:patch` has not landed; resolves the
  `TabEntry` or null), `revealAssistantChat(key)`, `addTabToAssistant(spec,
  onOpened?)` (frontend add path; normally unused).
- **New chat flow for S4b:** `await ensureAssistantScopeHydrated()` BEFORE
  `assistantNewChat(...)`, then `const tab = await mountAssistantChat(res.tabId)`
  (`tabId` = `TabEntry.id`, not `key`). Confirmed: `WorkspacePatchHost` ->
  `applyWorkspacePatch` mounts a `created` op for a LOADED scope only (an
  unloaded scope takes the snapshot at its hydrate), so the hydrate-first order
  is required; the two paths never double-mount (id/session dedupe).
- Chat list = `useTabsStore(s => s.tabsByScope[ASSISTANT_SCOPE])` (oldest
  first; `tab.assistant` = `{cli, model?}`, `tab.sessionId` = uid, `tab.label`).
  Closing a chat = `removeTabInScope(ASSISTANT_SCOPE, key)`; the persist host
  saves it.
- **`components/layout/AttachedAgentPane.tsx`** (new): `<AttachedAgentPane
  scope tab focused readerAlways? />` is the attach-only view (sets
  `TabScopeContext`, marks the key in `useOverlayAgentStore.assistantShownKeys`
  while mounted so the panel's copy counts as drawn elsewhere). Mount it
  only while drawn and only once per tab. `OverlayAgentColumn` now takes `scope`
  (default root), `badge`, `readerAlways` and uses it; with a non-root scope it
  has no rights badge, no open-in-console button, no `overlayAgent.dock` pill.
- **Always-Reader:** `readerAlways` is threaded `AttachedAgentPane` -> `TabPane`
  -> `TerminalView`: the Reader is offered in an attach-only mirror, is on
  regardless of the per-CLI preference (which is not touched), and the prompt
  strip's Reader toggle is hidden. S4b needs no TerminalView change.
- `AssistantScopeHost` (mounted in `AppShell` after `RootOverlayHost`)
  persists the scope (`persistScope("assistant", "")`, 300 ms debounce, only
  once the key exists).

### What changed in existing code

- `TabEntry`/`SavedTabEntry.assistant` (`AssistantLaunch` in `lib/assistant.ts`,
  `readAssistantLaunch` reads it defensively); `toSavedTabEntry` saves it;
  `restoreSavedTab` keeps it ONLY when the scope is `assistant` (a project's
  layout file cannot plant one), keeps the saved cwd, mints no
  `scheduleTargetId`; hydrate and the `created`-arrival filter drop an
  assistant-scope tab with no readable launch. No `hostSession` for the scope.
- Spawn: `tabTerminalSpawn` for the assistant scope sends `args []`, `env =
  {TAB_UID: sessionId}`, `assistant: tab.assistant`, no schedule target;
  `TerminalView` puts `assistant` into `pty_spawn` opts (snake `assistant`) and
  into the spawn key; `project_id` is `"assistant"` (scope id).
- `PaneSlot`: a Tabby chat is tmux-wrapped like a Mobile-scope agent (the
  `mobileAgentTmuxReady` answer is true for the scope), so the phone side
  (S5a) has a tmux session to attach to; the backend's `assistant_access`
  switch still gates the phone.
- `CenterPanel`: the scope is never `isCurrentScope`; its chats' panes stay
  mounted (PTY owner, hidden) and get `drawnElsewhere` while an attached view
  draws them. `overlayAgent` store: `assistantShownKeys`, `markShown(key,
  scope?)`/`unmarkShown(key, scope?)` (root default, existing tests unchanged).
- `tabJump.bringUpScope`: the Tabby scope is a no-op (no `setActive`);
  `jumpToTab(ASSISTANT_SCOPE, key)` only reveals the tab. `StatsRecap` labels
  the id `NAMES.assistant`. `AppShell`: nothing else needed; a test shows
  hydrating/mounting leaves `activeId` and the store `scope` alone.

### Gotchas / for others

- **Every restored chat spawns** when the scope hydrates (panes of all loaded
  scopes stay mounted, as for project tabs). Many old chats = many CLIs at the
  first overlay open. S4b/main may want to cap what the overlay hydrates or
  close old chats; I did not invent a cap.
- `statusJump`/`jumpToTab` can target a chat that wants a decision but only
  reveal it; S4b should make `jumpToTab(ASSISTANT_SCOPE, …)` open the overlay
  (it has no overlay store to call yet).
- S5a: `MobileBridgeHost` should call `ensureAssistantScopeHydrated()` /
  `mountAssistantChat` instead of its own hydrate for the scope.
- Hot shared files: none edited, none needed (no new i18n key; the recap label
  is `NAMES.assistant`). Filemap rows (S5c): `stores/assistantScope.ts`,
  `components/layout/AttachedAgentPane.tsx`, `AssistantScopeHost.tsx`.

## S4b — overlay + settings UI

Commit `353b37d1` on `assistant-s4b` (on `assistant-s4a` 8f5d5df5; 28 files,
frontend only, no Rust, no MobileBridgeHost). Gates (`scripts/gates.sh`):
brand, whitespace, lint-fe, build, vitest all PASS; no new eslint warnings
(`rtk proxy npx eslint` on every touched file: clean). Full vitest run: 849
files / 8605 tests, all green (S4a: 847 / 8579). New tests: 15 in
`AssistantOverlay.test.tsx` (button gate, closed = no reads, newest first,
jump opens on a chat, Escape/backdrop, lazy spawn, delete, new chat cloud and
local, sign-in card, Ollama down, refusal, signed-out restored chat), 10 in
`AssistantSettings.test.tsx` (page, round trip, write-only key, nav entry, the
phone switch), 1 lazy-spawn test added to `AssistantScope.test.tsx` (its two
pane-layer tests now start the chat first). Not run live; no `backend:stale`
needed.

### What changed

- **Lazy spawn.** `useOverlayAgentStore.assistantStartedKeys` +
  `markAssistantStarted`; `CenterPanel` mounts an assistant-scope pane (= the
  PTY owner) only for keys in it. `stores/assistantScope.startAssistantChat(key)`
  is the door: `mountAssistantChat` and `addTabToAssistant` call it (a chat just
  made / the phone opening one), the overlay calls it for the chat it shows.
  **S5a:** the phone path that attaches to a RESTORED chat must call
  `startAssistantChat(tab.key)` (or `mountAssistantChat`, which now does) or the
  CLI never starts. Nothing ever un-starts a chat.
- **Header button** `header/AssistantButton.tsx` (twin of `HelpAgentButton`'s
  shape, `AssistantGlyph` in `HeaderGlyphs`), `useExperimental("assistant")`,
  in `HeaderBar` after the to-do button. CSS: `.assistant-indicator-*` added to
  the shared header-button lists in `mail-todo.css`.
- **Overlay** `components/assistant/AssistantOverlay.tsx` (`AssistantOverlayHost`,
  lazy in `AppShell` after the Models overlay, before the root console so a
  sign-in tab opens on top). Store `stores/assistantOverlay.ts` (`open`,
  `selectedKey`, `composing`, `openOverlay(key?)`). `jumpToTab(ASSISTANT_SCOPE,
  key)` now opens the overlay on that chat (S4a's open item). The chat is
  `AttachedAgentPane` directly (`readerAlways`), not `OverlayAgentColumn`: the
  chat is the main pane here, not a docked column, so the column's dock state
  and width cap would only be in the way. Delete = `removeTabInScope` (the
  root console's ×; the pane unmounts and the PTY is reaped).
- **New chat** `AssistantNewChat.tsx`: CLI dropdown from `assistantOptions`,
  model dropdown for local CLIs, preselect = settings default, else the
  backend's, else the first ready one; order `ensureAssistantScopeHydrated` ->
  `assistantNewChat` -> `mountAssistantChat` -> select.
- **Cards** `AssistantCards.tsx`: sign-in (the intro wizard's flow:
  `runInstallInTab` with `<bin> auth login --claudeai` / `codex login
  --device-auth` from `signInLaunch`, shell "default"), not installed (-> opens
  Settings agents), Ollama down / no model (-> Settings ollama), search setup
  for local CLIs when `search.configured` is false (full form in the new-chat
  view, folded behind "Set up search" above an open local chat).
- **Settings.** New main page `assistant` (group Agents, nav label =
  `settings.assistant`, shown only while the experimental switch is on):
  `AssistantSettings.tsx` (default CLI / model into
  `Settings.assistant_settings`, other keys of the block kept) +
  `AssistantSearchSetup.tsx` (shared with the overlay card): kind dropdown,
  SearXNG URL, Ollama key as a `PasswordInput` that is never filled from the
  backend; Remove key with kind ollama falls to `none` (the backend refuses
  ollama without a key); the returned settings are written to the store and
  emitted on `SETTINGS_CHANGED_EVENT`. Phone switch: `MobileSettings` row
  "{assistant} from the phone" (`assistant_access`, default on so only `false`
  is stored; shown while the experimental switch is on), in `setMailGate`.
- **Untested.** `assistant.overlay` (overlay bar), `assistant.newChat` (new-chat
  form), `assistant.search` (search setup form) on their real surfaces and
  removed from `ASSISTANT_PENDING_PILLS` (only `mobile.assistant` left for
  S5b). One new row `settings.assistantPhone` for the Mobile switch.
- **i18n.** 64 keys (`assistant.*`, `mobile.assistantGate*`) in en/de/es/fr/it,
  appended as one block at the end of each dictionary.

### Gotchas

- Options poll: `useAssistantOptions(active)` = `usePoll` at 15 s (quiesce-aware,
  paused when blurred); the overlay host renders null when closed, so it never
  runs hidden; the Settings page polls only while mounted and enabled.
- The overlay shows the newest chat on open (starting its CLI); with no
  selection and no composing it never shows an empty pane.
- Selecting a chat whose CLI is signed out still starts it (the card sits above).
- Filemap rows (S5c): `components/assistant/*`, `stores/assistantOverlay.ts`,
  `header/AssistantButton.tsx`.

### Click-through for the user (frontend hot-reloads; none of it needs the backend half except step 5+)

1. Settings -> Experimental: switch Tabby on. A chat-bubble button appears in the
   header after the to-do button; Settings -> Agents group now lists a Tabby page.
2. Click the button: the overlay opens (same size/chrome as mail). With no chats it
   shows the New chat form. Pick Claude (signed in), Start chat: the chat appears
   in the list and on the right in Reader mode (needs the backend with S1a-S3).
3. Pick Codex while signed out: the sign-in card appears and Start is disabled;
   "Sign in to Codex" opens a terminal tab in the root console running the login;
   after signing in, "Check again" (or the 15 s poll) lifts the card.
4. Pick the local OpenCode profile: a model dropdown and the "Set up web search for
   local models" card appear. Settings -> Tabby: choose SearXNG and an address, or
   Ollama and paste a key; Save. The card disappears; the key field stays empty.
5. Make two chats, close the overlay, restart the app (frozen build), open the
   overlay: both chats are listed, only the newest one is running (check the
   Sessions view / tmux); click the older one and it starts. Delete (x) on a row
   kills that chat. Escape / click outside closes the overlay; the chats keep
   running.
6. Settings -> Mobile: "Tabby from the phone" is on by default, appears only with
   the experimental switch on.

## S5a — sidecar + bridge

Branch `assistant-s5a` (worktree `.claude/worktrees/assistant-s5a`, on `assistant-int`
87592f42): `806348a7` (Rust sidecar), `e6713e1a` (window-up bridge + tests),
`4b418572` (a TS lib fix). Whole step done, nothing left over except what is listed below.

**Gates** (`scripts/gates.sh --base 87592f42`, all PASS, zero new warnings): brand,
whitespace, lint-fe, clippy, clippy-dlib, clippy-dmn, build, vitest (`--changed`),
test (`tabtivity` + `app-serverd`), test-dlib. New tests: 25 Rust (discovery 5,
`mobile_control/assistant.rs` 4, headless 2, host 3, protocol 1 extended, agent_session 1,
...) and 10 vitest (`src/__tests__/mobile/MobileAssistantAccess.test.tsx`). Not run: Windows/macOS
cross-checks, anything live. Backend change: `npm run backend:stale` applies after merge.

### What exists
- `discovery.rs`: `ScopeKind::Assistant` (serde `"assistant"`), `assistant_open(state_dir)` (raw JSON,
  flag incl. the debug/`experimental_explicit` fallback, `assistant_access != false`, wrong-typed value
  closes; test holds it equal to `Settings::assistant_phone_open` over 81 combinations),
  `is_assistant_scope_id`, source `raw_id "assistant"` label `ASSISTANT_NAME` rooted in
  `assistant::work_root` (listed even before the folder exists, so the first chat can be started),
  `assistant_chat()` keeps only tabs with a strict valid `assistant` block, `cmd == bin`,
  uuid `sessionId`, plain agent, cwd exactly `work/<uid>`. `ScopeAccess` follows the same gate
  (`Err` while settings unreadable). Domain `"assistant"` added to the opaque allow-list.
- `mobile_control/assistant.rs` (new): opaque launches. Id = `key_id(host_key, "assistant",
  "<cli>" | "<cli>:<model>")` (= `opaque_control_id(state, "assistant", ..)`), built from the desktop's
  own `commands::assistant::assistant_options()` through a `HeadlessSpawner.assistant_options` seam.
- `protocol.rs`: `CreateTabRequest.assistant: Option<String>`, alone (agent kind, 1..=128, no other field,
  also excluded by `local`).
- `headless.rs`: `create_tab` takes `assistant: &[Choice]`; chat arm (`create_chat`) re-checks
  `assistant_open`, resolves the handle, `new_chat_record` + `create_tab_in`, detached launch, removes the
  record on a failed launch; `launch_options` assistant arm (reads only the validated block and the uid;
  `args`/`env`/schedule/sandbox/localLaunch never read; invalid record -> `assistant: None`, which the gate
  refuses). This is the seam for create, reopen, undo-clear relaunch and the scheduler relaunch.
  `record_prompt` already skipped the scope (S1a).
- `host.rs`: create dispatch (assistant scope needs `assistant`, no other scope takes it; window up ->
  window creates, down -> owner creates), launch-options answered by the sidecar (window or not),
  `has_folder()` refusal (`404 not_a_project`) for tab/project inbox, outbox, desktop-images,
  uncommitted, markup (submit, questions, answer, dismiss, undo), `no_schedules_here()` (`404 not_a_project`)
  for schedules, schedule mutation and collected prompts, sign-in tab -> `400 unsupported_sign_in`,
  detail `agents: []`. Existing `== ScopeKind::Project` gates (git, files, uploads, worktrees, activate,
  row seals) exclude the kind; one test (`the_assistant_scope_is_no_project_to_any_folder_route`) lists 30
  routes. NOTE: inbox/outbox/markup/uncommitted were NOT Project-gated before (they act on
  `project.root`); the plan said "for free", it was not true.
- `pty_bridge`: no code change; the catalog drops the scope when the gate closes, so `recheck` returns
  `access_revoked` (test `an_open_chat_loses_its_grant_when_the_gate_closes`).
- `agent_session::claude_projects_roots`: the assistant scope also lists the local-model home (local
  Claude chats' transcripts live there; the Focus view needs it).
- `MobileBridgeHost.tsx`: `assistantPhoneOpen()` (via `experimentalEnabled`), `mobileAssistantScope()`
  (`cwd ""`), `ensureAssistantScopeHydrated()` (local; S4a may offer its own), in `allMobileScopes`,
  `agentTurnScopes`, `restoreScope`, `enterScope` (no scope switch), `create` -> `createAssistantChat`
  (resolves the handle against `assistantOptions()` + `mobile_opaque_id`, calls `assistantNewChat`,
  `refreshWorkspaceScope`, `revealTabInScope`; idempotent per request key in memory), no prompt history,
  reopen reveals. **Depends on S4a**: the window must adopt the tab from `workspace:patch` keeping the
  `assistant` block, and a mounted pane must spawn it with `PtyOptions.assistant` + `TAB_UID = sessionId`.

### Phone API (for S5b)
- `GET /api/v1/projects`: the scope is a row with `kind: "assistant"`, `label: "Tabby"`, opaque `id`
  (listed only while the gate is open; hide the project-only affordances for this kind).
- `GET /api/v1/projects/{id}/launch-options` ->
  `{ worktrees: [], cloud: [], sign_in: [], local: null, assistant: { ollama_reachable: bool,
  launches: [{ id, label: "Claude"|"Codex"|"OpenCode", local: bool, model?: string, ready: bool,
  default: bool }] } }`. Only installed CLIs; local ones once per Ollama model; `ready` false -> dim it.
  `503 assistant_unavailable` if the options cannot be read.
- `POST /api/v1/projects/{id}/tabs` body `{ project_id, kind: "agent", assistant: "<launch id>",
  idempotency_key }` (16..128 chars) -> `201 { tab }` like any create (`desktop_available: false`
  when made without a window). Errors: `400 invalid_request` (shape, shell, plain agent),
  `400 unknown_agent` (handle not derived by the host), `400 assistant_off` (gate closed at use),
  `400 <assistant refusal code>` (`not_offered`, `model_required`, `bad_model`, `no_lane`,
  `codex_catalog`, `config`, ...), `502 launch_failed`.
- Tab routes work as for any agent tab (terminal, transcript, prompt, rename, color, close, reopen,
  status). Chat tab fields: `kind: "agent"`, `local_model` true for local profiles, no schedules.
  Not available (404 `not_a_project`): files, git, outbox, inbox, uploads, markup, uncommitted,
  schedules, collected prompts, desktop-images. Held prompts (`/held`) answer `tab_not_found` (no
  schedule binding): the composer should send straight to the terminal.

### Hot shared files (for the main agent)
- filemap_backend: new row `services/mobile_control/assistant.rs` ("assistant scope: opaque launches from
  the desktop's options, handle resolve"); mention the assistant scope in the `discovery.rs`,
  `headless.rs` (`create_chat`, `launch_options` arm), `host.rs` (`has_folder`, `no_schedules_here`) rows.
- filemap_frontend: `MobileBridgeHost.tsx` row: assistant scope next to root.
- No i18n, untested.ts or command_class changes (no new Tauri command). `mobile.assistant` pill stays S5b's.

### Flagged
- The window-up create goes through `assistant_new_chat`, which takes no request hash, so the bridge
  dedupes retries in memory only (a window restart forgets it).
- `docs/context/mobile_access.md` / `root_console.md` untouched (S5c).

## S5b — mobile-web

Branch `assistant-s5b` (S5a + assistant-int aa333c1c merged as 925e0470): `9f22579a` (merge
task: bridge + one small backend addition), `6a2f59c8` (mobile-web, i18n, tests), `e3e41c48` (test
tidy). `mobile-dist/` is gitignored, so no bundle is committed; `npm run mobile:bundle` builds clean.

**Gates** (`scripts/gates.sh --base 2f0569c5`, i.e. the whole S0-S5 tree merged, all PASS): brand,
whitespace, lint-fe (no new warnings; the two `exhaustive-deps` in `Terminal.tsx` 1347/2007 are old),
clippy, clippy-dlib, clippy-dmn, build (tsc + desktop/mobile/web bundles), vitest `--changed`
(701 files / 7005 tests, all green), test (`cargo test -p app-core -p tabtivity -p app-serverd`),
test-dlib. New tests: 10 in `src/__tests__/mobile/MobileAssistantScreens.test.tsx`, 2 added to
`MobileAssistantAccess.test.tsx` (now 12), 1 Rust (`an_activation_may_name_only_a_tab_of_its_own_scope`,
plus the activate round-trip extended). `backend:stale` applies (host.rs/protocol.rs changed). Not run
live; no Windows/macOS cross-checks.

### Merge task (MobileBridgeHost)
- Uses `stores/assistantScope` now: the local `ensureAssistantScopeHydrated` copy is gone. A phone-created
  chat goes `ensureAssistantScopeHydrated` -> `assistant_new_chat` -> **`mountAssistantChat(chat.tabId)`**
  (adopts the `workspace:patch` created tab with its `assistant` block, starts the CLI) -> reveal. A reopened
  chat calls `startAssistantChat`. The existing S4a tests already pin created-patch -> `assistant` block ->
  `PtyOptions.assistant`; the bridge test now pins "created chat is started".
- **Gap found and closed (the one backend change):** a chat restored with the desktop has no process under the
  lazy spawn, so the catalog lists it `available:false`, the terminal route answers `410 session_gone`, and the
  phone had no request that reaches the window with a tab. `POST /projects/{id}/activate` takes an optional
  `?tab=<tab id>` (deny-unknown query struct; the tab must belong to that scope, else `404 tab_not_found`),
  `DesktopRequest::Activate` carries `tmux_session: Option<String>` (default/skip when None), and the window's
  `activate` starts that one chat (`startAssistantChat`) for the assistant scope only. No tab named = none
  started (laziness kept). With no window the route still answers `503 desktop_unavailable` for the scope
  (as before).

### What the phone has
- **Home:** the catalog row `kind: "assistant"` (label from the host's `ASSISTANT_NAME`, never spelled in
  mobile-web) is a normal row, caption `✦ chat assistant` (`mobile.home.scopeAssistant`), untested pill
  `mobile.assistant`. `ProjectRow.kind` gained `"assistant"` (`ScopeKind` in `api.ts`).
- **Chat list = the existing Project screen** with `detail.project.kind === "assistant"`: newest first (no sort
  menu, no reorder), ✕ on each card closes (existing close route), swipe-close works, no ◷ schedule, no
  collected-prompts section, no drawer (files/outbox/git), no outbox poll. A chat that is not running shows
  "Not running. Tap to start it."; tapping posts `activate?tab=` and polls the project each second (25 tries)
  until `available`, then opens it.
- **New chat:** `screens/NewChatSheet.tsx` (header ＋), same sheet/tile classes as the project ＋ and the local
  model group; fed by `launch-options`' `assistant.launches` (opaque ids only; CLIs and local models in two
  groups, default first, `ready:false` dimmed with the reason, "Ollama is not running" note). Create =
  `POST .../tabs {kind:"agent", assistant:<id>, idempotency_key}`.
- **Focus chat (`Terminal.tsx`):** `useScopeKind(project)` (`mobile-web/src/scopeKind.ts`: remembered from Home
  and the project screen, else one detail read). For the assistant scope it drops: project files drawer + swipe,
  outbox gallery/poll, composer **+** (all attach tiles = inbox), Commit chip + uncommitted poll, Mark up
  (target and questions poll), and the held-prompt path (words go straight to the CLI queue).
- **i18n:** 13 keys `mobile.assistant.*` + `mobile.home.scopeAssistant` in en/de/es/fr/it (appended at the end).
  **Untested:** `mobile.assistant` pill on the Home row, the Tabby screen title and the New chat sheet;
  `ASSISTANT_PENDING_PILLS` deleted from `lib/assistant.ts` (it was the last entry).

### Gotchas / for others
- The scope kind for a chat opened from the cross-project Agents list is unknown for one read; the composer
  shows the file affordances for that instant (a project kind default) until it answers.
- A chat the desktop cannot start (no window) just stays "Not running" after the 503; the message is the
  generic connection error.
- Filemap rows (S5c): `mobile-web/src/scopeKind.ts`, `mobile-web/src/screens/NewChatSheet.tsx`;
  `mobile_control` rows: `host.rs` activate `?tab=`.

### Click-through for the user (needs the backend half: `npm run backend:stale`, then a rebuild/relaunch; the phone bundle is baked in)
1. Settings -> Experimental: Tabby on; Settings -> Mobile: "Tabby from the phone" on (default).
2. Phone Home: a "Tabby" row with "chat assistant" and the untested pill. Open it: the chat list (empty text).
3. Tap ＋: the New chat sheet lists the desktop's CLIs; a signed-out one is dimmed with a note; local models show
   under "Local models" (note when Ollama is down). Pick Claude: the Focus chat opens, send a message, get an answer.
4. In that chat: no ☰ drawer, no 🖼, the composer has no **+** and no Commit chip.
5. Back to the list, make a second chat: it is listed above the first. ✕ on a card closes it.
6. Restart Tabtivity (frozen build). Phone list: the chats show "Not running". Tap one: "Starting…", then it opens
   on its conversation; the other stays not running.
7. Turn "Tabby from the phone" off on the desktop: the row disappears from Home.

## S5c — docs

Commit `0bd4d598` on `assistant-s5c` (on assistant-int 3865ef3e; docs only, 8
files). `scripts/gates.sh` (brand, whitespace; nothing else selected),
`privacy-check` and the pre-commit hook pass. Not run: `cargo test help_mcp`
(the new help topic is embedded by `build.rs`; `real_corpus_parses` and
`the_topics_section_names_every_topic` should be run once with the merge;
the topic's `related` ids all exist and `assistant` is added to
`ask-tabtivity.md`'s Topics list).

- `docs/context/assistant.md` (new): two layers and why both, per-chat work
  bind, the web lane and why it is outside the fence (rules, categories,
  budget, search backend), the profile table as built (decisions 13-17, lazy
  spawn, Codex catalog and seed), the reserved scope and its funnel,
  the phone gate and `activate?tab=`, the accepted limits (search via proxy,
  DNS oracle, any public port, NAT hairpin, URL leak, every CLI's login in the
  home, `--ro-bind / /`, Windows has no fence). The verifier's intended spawn
  behaviour (Codex catalog allowlist, no shell after a Tabby CLI exits, pinned
  tmux name, web token in `SECRET_ENV`) is one short paragraph: check it against
  that branch's final wording.
- `AGENTS.md`: tool-set exception + no `agent_global` + no fetch inside the
  fence (Agents), one Conventions line on `storage::is_reserved_scope`,
  `assistant` in the `docs/context` list.
- Filemaps: new rows `services/assistant.rs`, `services/web_lane.rs`,
  `commands/assistant.rs`, `mobile_control/assistant.rs`, `assistant/` +
  `AssistantButton`, `AttachedAgentPane` + `AssistantScopeHost`, the three
  assistant lib/stores, `scopeKind.ts` + `NewChatSheet.tsx`; one-sentence
  updates to storage, commands/root_mcp, root_mcp, root_mcp_security,
  browser_engine, web_safety, launch_prep, agent_home, agent_fence,
  `mobile_control/` (covers discovery/headless/host/activate), MobileBridgeHost,
  CenterPanel, OverlayAgentColumn, `lib/experimental.ts`.
- User docs: `docs/help/assistant.md` (help MCP topic, sourced from
  `docs/help/*.md`) and a "Tabby Assistant (experimental)" section in
  `DOCUMENTATION.md` before "Ollama Model Management".
- QA: one item "Tabby assistant" at the end of `todo/group-s-agents.md` with 8
  manual boxes (desktop cloud, local OpenCode, local Claude, web lane refusals,
  phone chat, phone headless, lazy spawn, flag off), four platform pairs each,
  none ticked.
- Gotcha: `privacy-check` flags CIDR literals even in docs;
  the docs say "reserved IPv4 blocks" instead.

## Integration fixes

Five commits on `assistant-int` (on 87592f42), one test-carrying commit per fix:

- `f18c7b74` **Decision 17, per-chat work bind.** `agent_fence::assistant_work_mount`
  became `assistant_chat_mount(state_dir, cwd)`: `cwd` must be exactly one
  uuid-shaped component below `work_root`, a real directory (no link at the chat
  name or at `work`), else the spawn is refused (`scope_extra_mounts` and
  `agent_state_mounts` now take `cwd`). Bound read-write after the state mask
  (bwrap support mount) and in the Seatbelt `writable` list. The ONE creator of
  the folder stays `launch_prep::ensure_chat_dir` (assistant gate, 0700); the
  fence never creates it and refuses a missing one. S1b's three tests were
  updated; new assertions: a sibling chat folder and the work folder are in no
  bind (bwrap) and not in the SBPL profile; bad shapes/links refused.
- `1289c415` **Decision 15.** `browser_engine::reader_client(pin, origin)` calls
  `.no_proxy()` unless `honours_proxy_env(origin)` (false only for `Agent`).
  Test sets `HTTPS_PROXY`, inspects the built clients' `Debug` (User and
  Document hold the proxy, Agent holds none).
- `044fab88` **Decision 16.** `assistant::seed_codex_models_cache(home)` runs
  first in `write_codex_catalog`: only when the home has no `models_cache.json`
  and sits in a folder named `agent-homes`, it copies the newest usable one
  (mtime; must pass `build_codex_catalog`) from a sibling home, read via
  `HomeFile::open_existing(..).open_read()` (dirfd-relative, no-follow, regular
  file only, 8 MiB cap), written via `HomeFile::write`. New
  `agent_home::existing_homes_under(homes_root)`. `Refusal::CodexCatalog` text
  now ends "Start Codex once in any tab, then try again." Tests: seeded from the
  newest sibling (a junk newer one skipped, no re-seed later), none anywhere ->
  refusal, a stray non-`agent-homes` parent never scanned, symlink / FIFO /
  linked `.codex` in siblings ignored (FIFO read under a deadline).
- `8aec501d` **One lane rule.** `root_mcp::assistant_wants_lane` deleted;
  `grant_assistant` uses `AssistantCli::uses_lane()`. New test over
  `AssistantCli::ALL`; S2's tests unchanged and green.
- `d730abca` **S3 happy path.** `commands::assistant`: the refusal test is
  strict (`not_offered`, `model_required`, nothing stored); a new test asserts
  the success shape (uuid uid, scope, version, one stored tab with the launch
  block, `sessionId` = uid, cwd = chat dir, no folder created by the command).
  The flag-off test (`the_flag_gates_every_command`) is kept. The test reads
  the scope's own session, so it carries `// project-tree-read: ok`
  (the `project_tree_intent` scan caught it on the first gate run).

**Gates** (`scripts/gates.sh --all`, second run after the marker fix, all PASS):
brand, whitespace, lint-fe, clippy, clippy-dlib, clippy-dmn, build, vitest,
test (`cargo test --workspace`), test-dlib. Counts (first run, same code but
the two comment lines): vitest 846 files / 8566 tests; lib 4182 passed, 4
ignored; `it` 144 (143 + the one the scan failed on, green after the fix);
the second run's vitest took 390 s. **Cross-checks** (shims installed): Windows
`cargo clippy --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc
--all-targets -- -D warnings` clean; `cargo check --workspace --all-targets` for
x86_64-pc-windows-msvc and aarch64-apple-darwin (check-only CC/AR stand-ins) clean.
Not run: Windows/macOS tests, anything live; no `backend:stale` (flag off).

**Notes / flagged for user.** (1) The work folder is no longer bound at all; a
chat whose folder a fenced process swapped for a link is refused at the next
spawn (gate and mount both check). (2) The seed trusts any sibling home's
cache by shape only (decision 16 as written); a sibling the project's agent
wrote can choose the model list, never a tool setting (`apply_patch_tool_type`
is forced null). (3) `CodexCatalog`'s new sentence also shows for a malformed
own cache, where starting Codex elsewhere does not help; the home's own cache
is never overwritten.

## Reviews

### Web lane verifier

One commit `b06da7d2` on `assistant-v2` (on `assistant-int` aa333c1c), all backend
(`browser_engine`, `web_lane`, `root_mcp` service and command, `commands::assistant`;
`web_safety` untouched). `scripts/gates.sh --base aa333c1c` all PASS (brand,
whitespace, clippy, clippy-dlib, clippy-dmn, test, test-dlib); no Windows or
macOS run (no `cfg` code added; std only). Not live: needs `backend:stale`
after merge.

1. **Own-interface / hairpin: CONFIRMED (medium), fixed.** `judge_resolved` and
   a new literal check in `resolve_hop` refuse, for `Agent` and `Document` hops
   (and every redirect hop of any origin), an address the host owns, as
   `not_public`. Mechanism: bind a UDP socket to the address (`EADDRNOTAVAIL`
   unless the host owns it; same on Linux, macOS, Windows), no getifaddrs, no
   new dependency, no cache needed (live, one syscall). Guard: if a documentation
   address binds (`ip_nonlocal_bind=1`) the probe is distrusted and skipped,
   never refusing everything. **Known limit:** a host with only a private
   address behind NAT has nothing local to match, so a hairpin through the
   router's public IPv4 is not detected. Tests: injected-probe unit test (v4,
   v6, mapped, per origin and hop) and a real-bind test (loopback, a real
   local address, literal hops).
2. **Invisible Unicode: CONFIRMED, fixed in the lane only.** Not in
   `FORMAT_CHARS`: it is mirrored in `src/lib/textSafety.ts` and used for
   mail names, tab titles and filenames, where U+FE0F and the tag block are
   part of emoji (keycaps, flag sequences), so stripping there would be wrong.
   `web_lane::printable()` now also drops tag chars, variation selectors
   (both blocks), U+3164/FFA0/115F/1160, Khmer U+17B4/5, U+034F, U+180B-F,
   U+2060-206F, U+2800, U+FFF9-FFFC, musical/shorthand format controls. Applies
   to page text (including numeric references), titles, snippets. The
   private-use BREAK marks are unaffected. Test covers all three surfaces.
3. **Search client proxies: NOT CHANGED** (decision 15 names the agent fetch
   only). See Flagged.
4. **Lane starvation: CONFIRMED, fixed.** A web call held one of 8 shared
   global permits for up to 15 s. `Caller::Web` now draws from its own pool of
   8 (`request_pool`); other lanes' pool is unchanged. Test: with every web slot
   held, agent, help and markup requests are admitted.
5. **Validator mismatch: CONFIRMED, fixed.** `commands::assistant`'s validator
   is now a wrapper over `web_lane::validate_searxng_url` (adds the control-char
   check; the lane's own checks: no query, 512 bytes, now also on the
   normalised form). The setter therefore rejects `?query` and over-512 URLs
   with `invalid_url` up front, and `search_state.configured` is the lane's
   verdict (`SearchConfig::from_settings`), so a stale saved URL shows as not
   configured. Behaviour change: URLs with a query or 513-2048 bytes, accepted
   before, are now rejected when saved. Test: everything the setter stores is
   read back by the lane; the rejected shapes.
6. **Budget resets on respawn: CONFIRMED, fixed.** The 120/h budget is a
   process-wide map keyed by `identity.tab` (pruned of expired entries on every
   admit, at most 512 tabs, oldest-called evicted), no longer a `Session`
   field. Test: respawn keeps the exhausted budget; map stays bounded.
7. **DNS oracle: NOT CHANGED.** See Flagged.
8. **Uncapped URL/title: CONFIRMED, fixed.** `clean_url` (2048 bytes, cut on a
   boundary with an ellipsis) and `clean_title` (300 chars, printable, one line)
   are applied in `render_page` and in the structured result; the reply is
   bounded by `MAX_REPLY_BYTES` (text cap + 4 KB, asserted). Test with a 1 MB
   Location, a 100k-emoji title and a huge page.
9. **Sync sanitising on the async worker: CONFIRMED, fixed.** `fetch_page`
   (shared by the reader and the agent fetch; it is the same call) now runs
   decode, title extraction and `sanitize_message_html` in `spawn_blocking`.
   The lane's 15 s deadline still cannot preempt a running blocking task
   (it ends when the task does), but no runtime worker is held.
10. **Any port: NOT CHANGED.** See Flagged.

### Spawn/fence verifier

One commit `ab0a9f31` on `assistant-v1` (on `assistant-int` aa333c1c), backend only
(`tmux_local`, `terminal/mod.rs`, `launch_prep`, `assistant`, `terminal_service`,
`workspace`, `agent_prompts`, `agent_fence`, `storage`, `commands/ollama`).
`scripts/gates.sh --base aa333c1c` all PASS (brand, whitespace, clippy, clippy-dlib,
clippy-dmn, test, test-dlib). Windows `clippy --target x86_64-pc-windows-msvc
--all-targets -D warnings` clean; `cargo check --workspace --all-targets` clean for
x86_64-pc-windows-msvc and aarch64-apple-darwin. ~14 new tests. Not live; needs
`backend:stale` after merge. Real Codex 0.162.1 and OpenCode 1.19.1 were run against
mock model servers in the scratchpad (removed afterwards).

1. **Web token not in tmux `SECRET_ENV`: CONFIRMED (medium), fixed.** Appended
   `root_mcp::WEB_TOKEN_ENV` (slot 8638); `WEB_URL_ENV` is a loopback URL and needs nothing.
   Tests: `the_web_lane_token_is_a_secret_like_every_other_lane_token` (no argv item,
   launcher script or assistant argv carries the value; `update-environment` lists it; the
   fenced trailing shell's `env -u` list has it), plus the extended
   `no_argv_item_carries_a_secret_value`.
2. **Web token not revoked on exit: CONFIRMED (low), fixed** in `terminal/mod.rs` beside the
   other lanes. Test `a_chats_web_lane_token_dies_with_its_process` (real PTY running
   `sh -c "exit 0"`; fails without the fix). Not added to `sandbox::is_secret_exec_env` or the
   push-preflight env scrub: an assistant chat is never a docker/ssh/push tab.
3. **Codex catalog checks one field: CONFIRMED (medium), fixed.** Probed against the real
   binary: a planted `experimental_supported_tools` adds a tool (`test_sync_tool` showed up in
   `exec`'s nested set), `apply_patch_tool_type: freeform` adds `apply_patch`, an entry's
   model slug not in the catalog runs on Codex's built-in fallback info (different tool set),
   and the home `config.toml`'s `model` IS honoured (a CLI `-m` beats it). Now:
   `CODEX_ENTRY_FIELDS` is an allowlist (type- and size-checked; entries failing it are left
   out; none left refuses), the tool-bearing fields are forced (`apply_patch_tool_type: null`,
   `experimental_supported_tools: []`, `shell_type: "disabled"`, `node_repl_disabled: true`),
   `tool_mode` is kept only as `code_mode_only` (the A0 value), `model_messages` is cut to
   `instructions_template` (Codex refuses an entry with neither that nor `base_instructions`;
   the other required fields were found by dropping each in turn with `codex debug models`),
   everything else (`base_instructions`, `availability_nux`, `service_tiers`, `upgrade`,
   `node_repl_auto_review_required`, unknown future fields) is dropped. The written file is
   re-checked as a fixed point of the same allowlist (`checked_codex_catalog`). `--model=` is
   now always on argv: the chosen slug, else the listed entry with the lowest `priority`
   (what Codex picks itself), and it must be a catalog slug (`BadModel` otherwise). Run
   against real Codex: the allowlisted catalog parses, and the tool set it yields is a subset
   of the unfiltered cache's. Tests: `a_planted_model_cache_cannot_widen_the_tool_set_or_rewrite_the_prompt`,
   `a_malformed_cache_entry_is_left_out_not_repaired`, the seeding test (planted sibling),
   the fail-closed mutations, the model-in-catalog refusal.
4. **Unfenced login shell after the CLI exits: CONFIRMED (low, guarantee-breaking), fixed.**
   `local_tmux_argv` passes `ends = opts.assistant.is_some()`; the pane's command is then the
   bare fenced line with no `; exec "$SHELL" -l`, so the pane and session end with the CLI
   (reopening a chat starts a fresh session with `--resume`). The non-tmux spawn has no
   trailing shell. Tests: `an_assistant_chats_pane_ends_with_its_cli_and_leaves_no_login_shell`
   (claude, bwrap, sandbox-exec, both tmux generations, launcher form; a project tab keeps
   its shell).
5. **`tmux_session` unconstrained: CONFIRMED (low), fixed.** `assistant::tmux_session_for(uid)`
   (`<prefix>assistant--agent-<uid>`, passes the phone's `expected_tmux` shape). The spawn gate
   overwrites a caller's name when it sent one (none stays none), the layout sanitiser rewrites
   `tmuxSession` on load/save/sync, and `new_chat_record` mints it. Test
   `a_caller_supplied_tmux_session_never_reaches_tmux` (five hostile names; the built
   `new-session -s` argv).
6. **Exact `== ASSISTANT_SCOPE`: CONFIRMED (low), fixed.** `storage::is_assistant_scope`
   (same reduction as `is_reserved_scope`; `agent_fence::is_assistant_scope` delegates).
   Used at `terminal_service` (save/load via `sanitize_scope_layout`, export via
   `export_target`), `workspace` (snapshot, sync, `mint_for_created`) and
   `agent_prompts::records_nothing_for`. Tests with `Assistant`, ` assistant`, `ASSISTANT`,
   `assistant\n` in each module. **Not edited (phone lane):** `services/mobile_control/headless.rs:980`
   (`record_prompt`): change `project_id == storage::ASSISTANT_SCOPE` to
   `storage::is_assistant_scope(project_id)` at the merge.
7. **`local_launch_line_ok` accepts the tail for every scope: CONFIRMED (low), fixed.** The
   `--` tail branch is gone from `commands::ollama::local_launch_line_ok`; a project tab's
   `localLaunch` matches the plain line exactly as before. `claude_local_tail_ok(tail,
   lane_url)` is now called only by `launch_line`, with the granted lane's URL, pinning host,
   port and path (a well-formed lane on another port is refused). Test
   `only_the_assistants_launch_path_takes_the_pinned_claude_tail`.
8. **OpenCode deny-list: VERIFIED, hardened.** Wildcards work in 1.19.1: `{"*":false}` leaves
   no tools; `{"*":false,"web_web_*":true}` leaves exactly `web_web_search` and
   `web_web_fetch`. **Order matters** (last match wins: wildcard-last turns the lane off),
   so the map is built `*` first, the 15 explicit names, the lane pattern last, and a test
   pins the order in the serialized config. The pattern is `web_web_*` (`<server>_<tool>`),
   not `web_*`, so a future built-in named `web_...` stays off.

**Phone-side items for the merge:** (a) `headless.rs:980` as above. (b) `headless::launch_options`'
assistant arm may keep passing `tmux_session` from the record; the gate overwrites it with the
uid-derived name either way. (c) A chat's tmux session now ends when its CLI exits: a phone
tab that was attached sees the session vanish and must reopen (the existing reopen relaunch
starts it fresh); `discovery` should treat a missing session of an assistant tab as "ended",
not as an error to retry.

**Flagged for user:** (1) The catalog's `instructions_template` (the model's system prompt)
still comes from the cache: Codex cannot start a model without it, and a bundled prompt would
couple us to Codex's version. A sibling project home that plants a cache can therefore change
the assistant's base prompt (never its tools); the length is capped at 256 KiB. Closing it
means a bundled template per Codex version or reading the cache only from the assistant home
itself (undoing decision 16's seed). (2) The assistant home's `config.toml` is still the CLI's
own: `model` no longer applies (argv wins), but `[mcp_servers]` or other tables written by
whoever can write the home (the fenced CLI itself, the user's `!` escape) are honoured by
Codex; I could not make a planted stdio MCP server show up in a mock run, so this is not
shown to be exploitable, and not closed. (3) Codex with no chosen model now always runs
the catalog's default model (lowest `priority` among listed), not the model the user last
picked with `/model` in the home's `config.toml`.

### Final review

Three commits on `assistant-int` (on `9cf6d67d`): `a608a78b` (Codex base prompt + MCP
strip), `c1df17c8` (ended chats restart), `91ea6ba3` (dead `NotBuilt` removed, docs).
Real Codex 0.162.1 (`npm pack @openai/codex@0.162.1-linux-x64`, scratch only, deleted) against
a mock Responses server that logged every request.

**Traced, no defect:** desktop new chat -> `assistant_new_chat` -> `workspace:patch` ->
`mountAssistantChat` -> `startAssistantChat` -> pane spawn (`PtyOptions.assistant` +
`TAB_UID = sessionId`, `tmux_session` rewritten to `tmux_session_for(uid)`) -> `assistant_gate`
-> `grant_lanes` -> `prepare_assistant_home` -> `launch_line` -> fence; restore with lazy
spawn; phone create headless and window-up; the tmux name: the record's `tmuxSession`
(minted by `new_chat_record`, rewritten by the layout sanitiser), the gate's overwrite and
`discovery::expected_tmux("assistant", "agent", ..)` all give `<prefix>assistant--agent-<uid>`,
so desktop and phone attach to one session. Flag off: header button (`useExperimental`),
the three commands (`assistant_off`), the spawn gate, `grant_assistant` (no lane), the
lane (`off`), the phone catalog (`assistant_open`) all read the one flag. The Codex
`-c ... resume <id>` order parses (`codex --model=.. -c .. resume <id> --help`).

**Bugs found and fixed**
1. **A chat whose CLI quit could never be started again (`c1df17c8`).** The spawn-verifier
   change (no trailing shell, session ends with the CLI) left the desktop pane on
   `[process exited]` for good: `startAssistantChat` was idempotent, the overlay had no
   Restart, and the phone's "Not running. Tap to start it" -> `activate?tab=` reached the
   same no-op with the window up, and answered `503 desktop_unavailable` with none. Fix:
   started chats watch their PTY (`terminal-exit`/`terminal-ready`, new
   `assistantEndedKeys`); `startAssistantChat` respawns an ended one (`relaunchTabInScope`);
   the overlay shows a note with Restart (two new i18n keys, 5 languages); with no window
   `activate?tab=` starts the stored chat detached (`headless::start_chat`, only when the
   catalog says it is not running, gate re-checked, record re-validated). Tests:
   `AssistantRestart.test.tsx` (2), `opening_an_ended_chat_with_no_window_starts_it_again`.
2. **Codex base prompt came from the cache (flagged item 1 of the spawn verifier, `a608a78b`).**
   Probed: Codex refuses an entry with neither `base_instructions` nor
   `model_messages.instructions_template` (so it cannot simply be dropped), accepts either, and
   puts it in the request as the first developer message. Every catalog entry now carries
   Tabtivity's own `CODEX_BASE_INSTRUCTIONS`; the cache's `model_messages` and
   `base_instructions` are never copied. Request checked with the Rust-built catalog from a
   real 0.162.1 cache: our base prompt + `developer_instructions`, same tool set as before.
   Tests: the planted-cache test now asserts no planted prompt text reaches the file.
3. **Home `config.toml` `[mcp_servers]` (item 2 of the spawn verifier, `a608a78b`).**
   Probed: a planted stdio server IS started by Codex (marker file), and
   `-c mcp_servers={}` does NOT remove it (tables merge; `[]`/`""` fail to load; only a
   per-name `-c mcp_servers.<n>.enabled=false` works). So the override the review suggested
   cannot work; instead `agent_home::with_codex_trust` removes `mcp_servers` from the assistant
   home's `config.toml` at every spawn (inside the home lock, other keys/hooks untouched).
   Test: `a_planted_mcp_server_is_removed_from_the_assistant_homes_codex_config_at_every_spawn`.
4. Leftover: `Refusal::NotBuilt` (unreachable since S1a) removed (`91ea6ba3`). No other
   TODO/`not built` stub, no `ASSISTANT_PENDING_PILLS`, no new `any`, no new lint warning,
   i18n keys 82/82 in all five languages and all used, filemap rows present (the
   `assistant/` directory row covers the six components), privacy-check over `2f0569c5..HEAD`
   clean (12863 added lines, 38 commits).

**Gates** (`scripts/gates.sh --all`, all PASS, zero warnings): brand, whitespace, lint-fe,
clippy, clippy-dlib, clippy-dmn, build, vitest, test, test-dlib. **Counts after the fixes:**
vitest **852 files / 8628 tests**, all collect tests; cargo `--workspace` 4625 tests in 6
binaries (tabtivity lib 4214 passed + 4 ignored, `it` 144, 136, 101, 29, 1). The two earlier
vitest numbers were not a collection problem: 8605/849 was the S4b branch alone, 7005/701 was
`vitest --changed` (S5b's gate). The full run of this tree before my frontend edits was
851 / 8626. No `Denied ID`, no empty file (hardlinked `node_modules`).
**Cross-checks (shims installed), clean:** Windows `cargo clippy --manifest-path
src-tauri/Cargo.toml --target x86_64-pc-windows-msvc --all-targets -D warnings`; `cargo check
--workspace --all-targets` for x86_64-pc-windows-msvc and aarch64-apple-darwin (check-only
CC/AR). `npm run mobile:bundle` builds clean. `backend:stale` applies (Rust changed). Not run
live (rule); nothing Windows/macOS-specific executed.

**Added to "Flagged for user":** the project-layer config in the chat folder (below); the
loss of Codex's own 20 KB base prompt.

## Merge notes (main agent)

- After S4a/S4b and S5a meet: `MobileBridgeHost.tsx`'s assistant reveal/open
  path must call `startAssistantChat(key)` (or `mountAssistantChat`) from
  `src/stores/assistantScope.ts` for a restored chat, or its CLI never starts
  (S4b made spawn lazy). S5a's branch predates S4a, so this is done at or
  after the merge (S5b's job if not done in the merge).

## Flagged for user

- (main agent, decided 2026-10-15) S1b's shared `work` bind lets a chat see
  sibling chat folders. Decided: bind only the chat's own `work/<uid>`
  folder (it is the spawn's `cwd`, known at wrap time). Done as an
  integration fix after S1a merges; the S1 reviewers check it.
- (S1a) Codex chat in a fresh assistant home: decision 13 reads
  `<home>/.codex/models_cache.json`, which does not exist until Codex has run
  in that home, and Codex is not started without the catalog. The first Codex
  chat therefore refuses with the catalog message. Options: seed the cache
  from the user's own `~/.codex/models_cache.json` (reads another app's path,
  trusted file) or from the Host-session home; left unimplemented.
- (final review) **Codex runs on a short bundled base prompt, not its own 20 KB one.** To close
  the planted-cache hole the catalog's `base_instructions` is a fixed sentence
  (`CODEX_BASE_INSTRUCTIONS`); Codex's own template (personality, formatting, and text about a
  shell and patch tool the chat lacks) is gone. Answers may read plainer than a normal Codex
  tab; Tabby's own prompt still rides as `developer_instructions`. Not compared live.
- (final review) **A trusted chat folder can carry its own CLI config.** Probed: Codex loads
  `<cwd>/.codex/config.toml` (including `[mcp_servers]`) for a project the home trusts, and the
  home trusts the chat folder to avoid the dialog; Claude is expected to read `.claude/settings.json` likewise (not probed)
  there. Only something that can write the chat folder can plant it, and the pinned CLI has no
  write tool, so it is not exploitable from a prompt; the user's `!` escape or a Windows
  (unfenced) process could. Closing it would mean refusing a spawn when the folder holds a
  `.codex`/`.claude`/`.mcp.json` entry. Not done.
