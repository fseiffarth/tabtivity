# Markup questions MCP — handoff

Plan: `docs/markup_questions_mcp_plan.md`. Branch `markup-mcp` (worktree
`.claude/worktrees/markup-mcp`), base `34c4b5cb`. Nothing here was run live.

## P1

Done, on `markup-mcp`:

- `8e3fae17` Add the markup questions MCP lane: markup_ask and markup_withdraw
- `1d8c7e8e` Add the window's markup question commands and change event

### What was built

**Service** `src-tauri/src/services/markup_mcp.rs` (`AppHandle`-free).

- Server name `markup_mcp::SERVER_NAME` = `<slug>-markup` (`tabtivity-markup`),
  built with `concat!(app_slug!(), "-markup")`. Route `POST /mcp/markup`.
- Tools `markup_ask` and `markup_withdraw` (`markup_mcp::TOOLS`). They are in
  `root_mcp_security::tool` as family `"markup"`, write, served to
  `Caller::Marker` only (`ToolPolicy::marker`).
- Asks are kept in memory and keyed by `(project, schedule target)`. There is
  one open ask per key: a new one supersedes the open one, and the result
  carries `replaced`. Records live 24 h (`RETENTION`). A record is dropped when
  its `Session::id` is no longer alive, which covers tab close, respawn and
  revoke. The store holds at most 1000 records.
- Budget: 20 `markup_ask` calls per **tab** per rolling hour
  (`ASKS_PER_HOUR`). The counter lives in the service, keyed by tab id. It is
  taken after argument validation and before the file is resolved, so an
  invalid call costs nothing.
- Bounds (characters after cleaning): 1–4 questions; question ≤ 400; header
  ≤ 24; 2–6 options with label ≤ 80 and description ≤ 200; quote ≤ 200;
  page 1..=100000; file ≤ 1024 bytes; Other… ≤ 500. Unknown fields are
  refused (`deny_unknown_fields`). Two options with the same label are
  refused.
- Cleaning (`markup_mcp::clean`): `root_mcp_mail::strip_invisible`, then
  whitespace collapsed to one line. A required text that is empty after
  cleaning is refused; an optional text that is blank counts as absent.
- `file` may be project-relative (an optional leading `./` is allowed) or
  absolute below the project. It is resolved by `resolve_file(root, file,
  prove)`, which runs `markup::resolve_local_source` (plain names only; hidden
  names refused, except the outbox). Then `files::exists` or `outbox::exists`
  proves it is a regular file with no link on the way. Both of those are new
  and open the file without reading it. Backslashes, backticks and control
  characters are refused. The root is `projects.json`'s
  (`markup_mcp::project_root`: remote → `None`). The file is stored
  project-relative; an outbox source is stored as `.tabtivity/outbox/<leaf>`.
- Refusals are a normal tool result:
  `{ status: "refused", category, message }` with category `invalid`,
  `file_not_found`, `budget` (+ `retryAfterSecs: 3600`) or `off`.
  `refusal_reason` maps a reply to that fixed category for the audit.
- `markup_ask` → `{ id: "ask-<16 hex>", status: "shown", replaced?: id,
  message: "Shown beside the PDF in the user's markup view. Their answer
  arrives as your next prompt — end your turn now." }`.
- `markup_withdraw { id }` → `{ status: "withdrawn" | "not_open" }`. Only the
  ask's own (project, target) can withdraw it.
- Answer prompt (`answer_prompt`): English and deterministic.

  ```
  My answers to your markup questions on `docs/paper/draft.pdf`:
  1. <question> → <label>
  2. <question> → <label>; <label>; Other: <typed text>
  ```

  The first line has no `on `…`` part when the ask names no file. A
  multiSelect question lists the picked labels in option order, joined with
  `; `, with `Other: …` last. The prompt is capped at
  `markup::MAX_PROMPT_BYTES` (12 KB). When it would be longer, the question
  texts are cut to 120 characters first, then the answers are cut evenly with
  `…`.
- Public API for P2/P3:
  - `list(project, target, Shown) -> Vec<AskView>`, where `Shown` is `All`,
    `File(rel)` or `Elsewhere`.
  - `answer(project, target, ask_id, &[Answer]) -> Result<String,
    AnswerError>`.
  - `dismiss(project, target, ask_id) -> Result<(), AnswerError>`. It is
    idempotent.
  - `same_file(asked, shown)`: equal paths, or, when either path is in the
    outbox, the same leaf after `outbox::sent_name`.
  - `resolve_file`, `project_root`, `sweep()`, `set_change_hook`,
    `CHANGED_EVENT`.

**Answer checks.** There must be one `Answer` per question, in order. A
single-select question needs exactly one of: one option index, or `other`. A
multiSelect question needs at least one, with unique indices. Indices must be
in range. `other` is cleaned; blank or over 500 characters is refused. Errors
(`AnswerError::code()`):

- `superseded`: a newer ask replaced it.
- `answered`: already answered.
- `gone`: withdrawn, dismissed, expired, session gone, unknown, or another
  target's ask.
- `invalid_answer`: the answers do not fit the questions.

A refused answer changes nothing. A successful one marks the ask answered
**before** returning the prompt.

**Lane** (`services/root_mcp.rs`)

- `Caller::Marker` (serde `"marker"`) is lane 4. It is hidden from
  `sessions()` (MCP session access), refused by `set_access`, and left out of
  `tab_active` and `mark_tab_projects_readable`, like help.
- Env pair: `root_mcp::MARKUP_TOKEN_ENV` = `TABTIVITY_MARKUP_MCP_TOKEN` and
  `root_mcp::MARKUP_URL_ENV` = `TABTIVITY_MARKUP_MCP_URL`.
- `apply_markup_to_spawn_with(opts, runtime, token, tool_models)`:
  - needs `project_id` and a non-empty `schedule_target_id`; not a container
    tab;
  - Claude/Codex are named the server via `wire_named_cli_args`;
  - a tool-tagged Vibe gets it merged into `VIBE_MCP_SERVERS` /
    `VIBE_ENABLED_TOOLS`; an untagged local model gets nothing;
  - other CLIs get the env pair.
- `apply_markup_to_spawn(opts)` for real spawns. It requires an agent, a
  local project (not remote/worker, container or VM project, the same checks
  as git push), a target that passes `agent_tasks::validate_id`, the listener
  up and `Settings::markup_mcp()`. It registers `Identity { caller: Marker,
  project, schedule_target: ScheduleBinding { target, agent } }`.
- `launch_prep.rs` calls it after help, for `agent_spawn && !root_agent &&
  reader_project.is_none()`.
- The token is treated as a secret in several places:
  - `SpawnTokenGuard` holds the markup token too.
  - On PTY exit the token is revoked, then `markup_mcp::sweep()` runs, which
    rings the change hook.
  - `tmux_local::SECRET_ENV` has the key appended last, so existing
    `update-environment` slots don't move.
  - `sandbox::is_secret_exec_env` and the git push preflight's env strip know
    the key.
- `root_mcp_mail::origin_of` maps Marker to `"marker"`.
- `#[cfg(test)] root_mcp::test_session_bound(caller, tab, project, target)`
  is a test helper for bound sessions.

**Listener** (`commands/root_mcp.rs`)

- `.route("/mcp/markup", …)`.
- `path_serves`: `"/mcp"`'s negative list now names `Marker`, and
  `"/mcp/markup" => caller == Marker`.
- The `Marker` branch in `handle`:
  - a revoked session gets 401;
  - otherwise `markup_mcp::handle_message` runs in `spawn_blocking`;
  - the audit row gets session, tool and the fixed category, never text.
- `root_mcp_session_revoke` also calls `markup_mcp::sweep()`.
- `start()` installs the change hook (`commands::markup_mcp::install_change_hook`).

**Tauri commands** (`commands/markup_mcp.rs`, registered in `lib.rs`). JS keys
are camelCase:

- `markup_mcp_list({ projectId, scheduleTargetId, path? })` →
  `AskView[]`. `path` may be the desktop's absolute path or a
  project-relative one; a path that does not resolve lists only the asks
  without a file. Each `AskView` is:

  ```
  { id, file: string|null, fileName: string|null, createdAt: rfc3339,
    questions: [{ question, header?, options: [{ label, description? }],
                  multiSelect, page?, quote? }] }
  ```

- `markup_mcp_answer({ projectId, scheduleTargetId, askId, answers: [{
  options?: number[], other?: string }] })` → `{ prompt }`. The answers are
  strictly shaped: unknown keys and negative indices fail deserialisation.
- `markup_mcp_dismiss({ projectId, scheduleTargetId, askId })` → `null`.
- Errors are strings: `superseded`, `answered`, `gone`, `invalid_answer`,
  `invalid_target` (empty/control-char ids), `markup_failed`.
- Event `markup-mcp-changed`, with no payload. It rings whenever an ask opens,
  closes or expires, or a session sweep drops one. Re-list on it.

**Settings**: `Settings::markup_mcp: Option<bool>` (absent = on) with
accessor `markup_mcp()`. TS: `Settings.markup_mcp?: boolean`. When it is off,
new tabs are not wired, and running tabs' `markup_ask` answers category `off`
(initialize and tools/list still answer).

**TS touched (minimal)**: the `RootMcpSecurity.tsx` `Caller` union gained
`"marker"`; i18n `mcpSecurity.marker` (en/de/fr/it/es), because marker calls
are audited and the audit table labels the class.

### Deviations from the plan, and why

- **Wiring scope**: `apply_markup_to_spawn` uses git push's local checks,
  not `help_reaches`. Help also wires a `local_only` tab of a remote project.
  For such a tab, the project folder a `file` resolves under is remote, and
  the desktop markup refuses remote projects anyway.
- **Budget per tab, in the service** (not a `Session` field like push's).
  This way a respawn does not reset it, and `root_mcp::register_token` stays
  untouched.
- **`off` is a tool result, not a 403.** The plan lists `off` as a refusal
  category, and this way the agent can tell the user where to switch it on.
- **Every question must be answered** (single-select exactly one). The card
  has "Answer in chat instead" for anything else.
- **`files::exists` / `outbox::exists`** prove the path without reading up to
  24 MB. The plan said "the way `pdf_markup.rs` re-proves a path
  (`files::read`)". These are the same checks, minus the read.
- **Server name not in `brand.rs`'s name pairs.** A pair needs a legacy form,
  and `eldrun-markup` never existed.
- **Post-commit dev build skipped** (`TABTIVITY_NO_AUTO_DEV_BUILD=1`). These
  are feature-branch commits in a worktree; the hook would have queued a
  rebuild of the main checkout.
- `npm run backend:stale` not run (it concerns the main checkout's running
  window; as instructed).

### Gotchas for P2/P3

- `markup_mcp_answer` closes the ask before the caller queues the prompt. If
  `queuePromptForTab` / `holdPhonePrompt` then fails, the card is gone. Show
  the error and the prompt text rather than retrying the answer, because a
  retry will say `answered`.
- The event exists only while the root MCP listener runs (`start()` installs
  the hook). Headless there is no listener, so there are no asks (P3:
  `desktop_unavailable`).
- `list` prunes: an expired or orphaned ask can disappear on a list call, and
  the event rings then too.
- Matching a file is `same_file` against the project-relative form. P3 should
  pass the sidecar's resolved project-relative path as `path`. An outbox
  source's rel is `<OUTBOX_DIR>/<leaf>`.
- The phone must get `fileName`, never `file` (decision 8).
- Untested-tag ids are not added yet. P2 adds `desktop.markup.questions` and
  `markupMcp`; P3 adds `mobile.markup.questions`.
- No `DEFAULT_INSTRUCTION` change, no `docs/context/markup_mcp.md`, no help
  doc yet (P4).

### Gates (at `1d8c7e8e`)

- `cargo test`: lib 3257 passed, 2 ignored; all other test binaries green.
  16 new tests: 12 in `services::markup_mcp`, 2 in `services::root_mcp`, 1 in
  `commands::root_mcp`, 1 in `commands::markup_mcp`, and help's tests extended.
- `cargo clippy --all-targets -- -D warnings`: clean (rustc 1.97.1).
- `npm run build`: OK.
- `npm test`: 694 files, 7070 tests passed.
- `npm run lint`: 0 errors. There are 31 warnings, all pre-existing in files
  this phase did not touch (`no-explicit-any` etc.).
- `scripts/brand-check.sh`: OK. `scripts/privacy-check.sh`: OK (also run by
  the pre-commit hook). `git diff --check`: clean.
