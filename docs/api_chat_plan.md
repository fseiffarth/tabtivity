# API keys for agent CLIs, and a built-in API chat — plan

Status: plan only (2026-10-04), reviewed against the code the same day (see
"Review notes" at the end). Nothing built. Part A is scheduled; Part B is
not.

## Why

Every agent tab runs a vendor CLI, and every CLI signs in with whatever its
own login gives it — for most people a subscription (Claude Pro/Max, ChatGPT
Plus). Users who pay per token instead (an API key from their org, a
spend-limited key, a provider with no subscription) have no Tabtivity-side
way in today: the fence hides the user's shell profile, so an `export
ANTHROPIC_API_KEY` line in `~/.bashrc` never reaches a fenced tab, and the
Agents view only knows file logins (`services::agent_auth`) and Copilot's
keyring token (`services::copilot_auth`).

(Two CLIs already have a plaintext route: Mistral Vibe's `~/.vibe/.env` and
Codex's `codex login --with-api-key` → `~/.codex/auth.json` are both login
files `agent_auth` shares across homes. Part A is the keychain route.)

Two ways to serve them:

- **Part A — give the CLIs an API key.** Tabtivity stores a provider key in
  the OS keychain and hands it to the CLIs the user picks, at spawn, as the
  environment variable the CLI already reads. The CLI stays the engine; the
  Reader, the phone Focus chat, resume, hooks — all unchanged.
- **Part B — a built-in chat tab** that calls the provider APIs itself
  (LibreChat-style, chat only). Cheap turns without an agent harness, any
  model, questions that belong to no project.

Part A is small and almost entirely plumbing that exists. Part B is a new tab
kind and is written down here so Part A's storage is shaped to serve it.

## Decisions (both parts)

1. **Keys are per provider, not per CLI.** One Anthropic key serves Claude
   Code, OpenCode and (later) the chat tab. Stored with
   `services::remote_credentials::{get,set,has}` under account
   `agent-key:<provider>` (`anthropic`, `openai`, `gemini`, `mistral`),
   the same service (`brand::KEYRING_REMOTE`) and locked-keyring handling
   `copilot_auth` uses (`agent-token:copilot`). New accounts, so nothing to
   migrate: `get`'s `legacy_get` fallback just misses (one extra read on a
   miss), and nothing is ever written under the old brand.
2. **Never persisted by default; never plaintext.** A key exists only after
   the user types it into the settings row and presses Save. A locked or
   missing keyring refuses the save (`remote_credentials::set` already says
   so); there is no file fallback. No key ever goes into `settings.json`,
   `projects.json`, a session dir, a tmux launcher script, any argv (tmux
   client included), a log, a `{:?}` of a prepared `PtyOptions` (it derives
   `Debug`), or the phone API.
3. **Using a key is a per-CLI choice, off by default.** Claude Code prefers
   `ANTHROPIC_API_KEY` over its subscription login once approved, so
   injecting a stored key into every CLI would silently move the user's
   billing. `Settings::agent_api_key_clis: Option<Vec<String>>` (CLI
   registry ids, the `root_mcp_agents` / `disabled_agents` pattern) lists the
   CLIs that get their key; non-secret. `settings.json` sits in the state
   dir, which the fence masks, so an agent cannot opt itself in.
4. **The CLI's own prompts stay the CLI's.** Claude asks once per agent home
   (i.e. once per project scope) whether to use a detected custom key — its
   default answer is **No** — and remembers the answer in that home's
   `.claude.json` (changeable later with `/config` → "Use custom API key").
   Gemini uses `GEMINI_API_KEY` only once its own `/auth` dialog picked "Use
   Gemini API key" in that home. Those dialogs are left to the user (a real
   PTY) — same rule as `ollama launch`'s own prompt. Tabtivity does not
   pre-answer them or write the CLIs' auth settings. (Whether the Reader /
   Focus render Claude's key dialog as buttons is unverified — nothing
   matches it specifically today; check in A0.)
5. **A value the user set themselves wins.** If the spawn env or Tabtivity's
   own environment already has the variable — or another name the CLI reads
   for that provider (table below) — nothing is injected (the
   `copilot_auth::inject_env` rule).
6. **Local spawns only, sessions only.** Remote (`ssh`) and container
   (`docker`) tabs don't get a key in Part A: the key would cross to another
   machine or image. Local-model tabs (`opts.local_model`) never get one —
   they point the CLI at Ollama, and the direct fallback launches (`vibe`
   with `VIBE_HOME`, `claude` against Ollama) run the real CLI binary, so the
   binary name alone is not enough. Subcommand launches (sign-in tabs,
   `claude auth login`, `codex login` — `agent_fence::runs_subcommand`) get
   none either: a key in a login flow only confuses it.
7. **The key is the agent's to read.** Anything the agent runs can print its
   environment, so a prompt-injected project could leak the key — the same
   exposure as the OAuth token files already sitting in every agent home, but
   a leaked API key spends money without a ceiling. Sharper still: a
   project's own CLI config (`.claude/settings.json` `env` →
   `ANTHROPIC_BASE_URL`, an `opencode.json` provider `baseURL`, Gemini's
   project `.env`) can point the CLI at another host, which then receives
   the key in a request header without any tool call. The settings help
   text says so and recommends a spend-limited key. This is stated, not
   solved.

# Part A — API keys for agent CLIs

## Which CLIs, and how each takes a key

Checked against vendor docs on 2026-10-04; only `claude` 2.1.288 is
installed here, and none was run with a key. "Aliases" are the other names
that count as user-set (decision 5).

| CLI (registry id) | Provider | Injected variable | Aliases | What the docs say | v1 |
|---|---|---|---|---|---|
| `claude` | anthropic | `ANTHROPIC_API_KEY` | `ANTHROPIC_AUTH_TOKEN` | code.claude.com/docs/en/iam: ranks above `/login`; interactive mode asks once to approve, remembered; `-p` always uses it. Remote Control refuses API-key auth (`--remote-control` still starts, then shows a failure notice). | yes |
| `codex` | openai | — | — | developers.openai.com/codex/auth: the documented route is `codex login --with-api-key` (writes `auth.json`); `CODEX_API_KEY` is for exec/review/SDK only; interactive use of `OPENAI_API_KEY` is not documented. | **no** — unless A0 shows the TUI uses `OPENAI_API_KEY` |
| `gemini` | gemini | `GEMINI_API_KEY` | `GOOGLE_API_KEY` | geminicli.com auth docs: interactive mode needs "Use Gemini API key" picked in `/auth` (`security.auth.selectedType = "gemini-api-key"`); a home already on Google login keeps it. | yes, untested |
| `vibe` | mistral | `MISTRAL_API_KEY` | — | env or `~/.vibe/.env`; which wins when both exist is unverified. | yes, untested |
| `opencode` | all four | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `MISTRAL_API_KEY` | google: `GOOGLE_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` | models.dev `env` lists (OpenCode's provider source); precedence against its own `auth.json` unverified. | yes, untested |

So the OpenAI key serves only OpenCode in v1. Others (Qwen's
OpenAI-compatible triple, Crush, Goose, Pi, Droid's `FACTORY_API_KEY`, Amp's
`AMP_API_KEY`) are later rows in the same table: no code beyond a table
entry, plus their names in `SECRET_ENV` (A2). OpenCode's own `auth login`
already writes `.local/share/opencode/auth.json`, which `agent_auth` shares —
that keeps working and is the alternative for users who prefer it.

If a CLI's variable can't be confirmed, the row ships only after
verification, or is left out with a note in this table — never guessed
silently.

## Steps

### A0 — verify the table

For each v1 row with the CLI installed: run it in a scratch `HOME` with only
the variable set (no login file), confirm it starts on the key and which
prompt (if any) it raises — Claude's "Detected a custom API key" dialog,
Gemini's `/auth` choice. Run probes off the tab record (unset both
`TABTIVITY_TAB_UID` and `ELDRUN_TAB_UID`). For Codex, check whether the TUI
uses `OPENAI_API_KEY` at all; if not, it stays out. Record versions and
outcomes in the table above. Rows that cannot be run here keep their
`untested` pill (A4) and say "from docs" in the table.

### A1 — backend service `services::agent_api_keys` (new, AppHandle-free)

`src-tauri/src/services/agent_api_keys.rs`:

- `Provider` enum (`Anthropic`, `OpenAi`, `Gemini`, `Mistral`) with
  `id()`, `account()` → `agent-key:<id>`, `aliases()` (the table's
  user-set names), `from_id(&str)`.
- `const CLI_KEYS: &[(&str /*registry id*/, &[(Provider, &str /*env var*/)])]`
  — the table above (no `codex` row unless A0 adds it).
- `cli_of(cmd) -> Option<&'static str>`: strip the path and `.exe` the way
  `agent_auth::apply_fence_env` does, then
  `commands::agents::agent_id_for_bin` (ids and binaries differ for some
  CLIs — `agy`, `kiro-cli`, `cn`; `agent_auth::registry` already reaches into
  `commands::agents` the same way).
- Named consts per injected variable (`ANTHROPIC_ENV`, …) and `ENV_VARS: &[&str]`
  — every injected variable, deduped. `tmux_local::SECRET_ENV` lists the
  consts (a const slice cannot be spliced into another), and a test asserts
  every `ENV_VARS` entry is in `SECRET_ENV`.
- `key_shape_ok(&str)` — non-empty, no whitespace/control chars, ≤ 512 bytes.
- `set_key(provider, Option<&str>)` / `has_key(provider)` /
  `get_key(provider)` over `remote_credentials` (`get` is bounded at 4 s and
  never prompts; while the collection is locked it reads the kernel-keyring
  cache only, so a key read once this boot keeps working).
- `enabled_clis() -> Vec<String>`: `Settings::agent_api_key_clis` read from
  `storage::state_dir().join("settings.json")` with `storage::read_json`
  (how `agent_fence::settings()` and `launch_prep::settings_agent_remote_control`
  read it). This works in the `--agent-shim` process too, which has no app
  state.
- `inject_env_with(cmd, args, local_model, enabled, env, get: impl
  Fn(Provider) -> Option<String>) -> Vec<&'static str>` — the pure core:
  nothing for `local_model`, for `agent_fence::runs_subcommand(args)`, or for
  a CLI not in `enabled`; for each `(provider, var)` skip when `env` or the
  process env has `var` or any alias non-empty; else insert `get(provider)`.
  Returns the names it inserted. `inject_env(cmd, args, local_model, env)` is
  the wrapper: settings first, the keychain only for an enabled CLI, so a
  spawn of a CLI nobody enabled never touches the keyring.
- `applies_to(cmd, settings)` — settings-only (no keychain): the CLI is in
  the table and enabled. Used by A2's Remote Control rule.
- `status() -> ApiKeyStatus { readable, providers: [{ id, saved }], clis: [{
  id, enabled, providers: [id], ready }] }` — `readable` =
  `remote_credentials::store_readable()` (a locked store answers every `has`
  with "not saved", so the UI must say "locked", not "not saved");
  `ready` = enabled and at least one of its providers has a key. Never the
  key. `#[serde(rename_all = "camelCase")]` (new struct, the commands
  convention).

Unit tests (all through `inject_env_with`, never the real keyring):
injection only for enabled CLIs; user-set value and each alias win; no key →
nothing inserted; path/`.exe` stripping; `local_model` and a subcommand argv
get nothing; `ollama` maps to nothing; shape check; `ENV_VARS ⊆ SECRET_ENV`.
Fake keys use the privacy-check placeholder words (`sk-test`, `fake`, …) or
carry `// privacy-check: ok — fake test key`; never a real-looking
`sk-ant-api03-…` / `sk-proj-…` / `AIza…` shape.

Register in `services/mod.rs`; one row in `docs/filemap_backend.md`.

### A2 — inject at spawn, keep it off disk and argv

**Where.** Every local agent spawn reaches one of three places:

- `src-tauri/src/services/agent_fence.rs` `wrap_pty_options_bwrap` (Linux)
  — right after the `copilot_auth::inject_env` block (~line 1316). `agent_cmd`
  (the CLI, taken before `opts.cmd` becomes `/bin/sh`) and
  `opts.local_model` are in scope; `opts.args` is not the CLI's any more by
  then (it is the bwrap argv), so capture `runs_subcommand(&opts.args)` at
  the top, next to `agent_cmd`. bwrap has no `--clearenv`; the
  launcher is `/bin/sh -c` + `exec`, so `opts.env` reaches the CLI (the same
  path that carries `COPILOT_GITHUB_TOKEN`).
- `wrap_pty_options_sandbox_exec` (macOS) — after its
  `agent_auth::apply_fence_env` (~line 1563; there is no Copilot call here).
  Capture the subcommand flag before `opts.args` is rewritten (~line 1553).
  `sandbox-exec` passes the environment through.
- `src-tauri/src/services/launch_prep.rs`, the two
  `FenceDecision::NotApplicable` arms (Host session, Windows `"platform"`,
  ~lines 690–711), after `agent_auth::apply_fence_env`. `opts.cmd` is still
  the CLI there. The `local_agent` guard already excludes `ssh`/`docker`.

The two wrap functions are also what the `agent_bin` shim calls
(`services/agent_shim.rs` ~line 90, in the separate `--agent-shim`
process, never through `launch_prep`) — so the injection must live inside
them, not only in `launch_prep`. The shim passes `local_model: false` and
the shell's whole environment as `opts.env`, so a key the user exported in
that shell wins. The mobile headless spawn (`mobile_control/host.rs` →
`launch_prep::prepare` → `tmux_local::spawn_detached_with`) goes through
the same `prepare`, so it is covered. The scheduled warm-up and the usage
panel spawn the CLI outside all of this, in the user's own home, and get no
key — leave them.

**Blocking.** `launch_prep::prepare` is `async`; a keychain read blocks its
thread for up to 4 s (`read_timed`). Copilot's injection already does the
same on the same path; acceptable because the read happens only for an
enabled CLI.

**Remote Control.** `launch_prep` adds `--remote-control` to Claude tabs
(~line 517) before the fence. Claude refuses Remote Control under API-key
auth and shows a failure notice, so skip the flag when
`agent_api_keys::applies_to("claude", &settings)` and the spawn is local
(`!remote_agent_run && !opts.sandbox && !opts.local_model`, all known at
that point). A user who then declines the key in Claude's dialog runs
without Remote Control for that tab — accepted.

**tmux (Linux/macOS persistent tabs).** A fenced agent tab with a
`tmux_session` is wrapped last (`tmux_local::wrap_pty_options_local`); on
tmux ≥ 3.2 every `opts.env` pair rides `new-session -e KEY=VALUE` — on the
world-readable client argv — **except** `SECRET_ENV`, which tmux copies from
the client's environment through fixed global `update-environment` slots
(8630…, #864).

- `src-tauri/src/services/tmux_local.rs`: append the `agent_api_keys`
  consts to `SECRET_ENV` (append only — each existing key keeps its slot;
  the new ones take 8636…). Extend `no_argv_item_carries_a_secret_value`
  (~line 977) and the launcher-script test (~line 927) with one API key
  variable: not on any argv, not in the launcher script, listed in its
  `update-environment` slot. `docs/context/root_console.md` (~line 171)
  describes those slots; add the names.
- **Side effect, accepted and documented:** production uses the **default**
  tmux server — the user's own (`spawn_detached_with`: "production passes
  `None` and shares the default server"). `set-option -g
  update-environment[n] ANTHROPIC_API_KEY` stays on that server until it
  exits, so on every later `new-session`/`attach` by any client — the user's
  own terminals too — the session's copy of that variable is taken from the
  client or marked removed. A user whose key lives only in the server's
  global environment (exported in the shell that started tmux, not in an rc
  file) would see new panes lose it. `COPILOT_GITHUB_TOKEN` already has this
  property; the API-key names are far more commonly exported. Alternative if
  that is unacceptable: Tabtivity-named carrier variables in `SECRET_ENV`
  mapped to the real names inside the fence launcher (`SECCOMP_LAUNCHER` on
  Linux; macOS has no shell step) — more code, not v1.
- **tmux < 3.2:** there is no `update-environment` step and secrets ride the
  tmux argv as an `env K=V` prefix (the documented #864 limit). For a
  long-lived key that is not acceptable: in `launch_prep`, before the tmux
  wrap, when the spawn will be tmux-wrapped and
  `!tmux_supports_session_env()` (make it `pub(crate)`), remove the names
  `inject_env` returned from `opts.env` and log once (names only). The CLI
  then falls back to its login — the safe direction.
- **Trailing login shell:** the pane runs `sh -c '<fenced cmd>; <drain>exec
  "$SHELL" -l'`, and that `sh` has the session environment, so the
  **unfenced** shell left in the tab after the agent exits inherits the key
  (and today the MCP tokens and Copilot token). For fenced lines, end with
  `exec env -u K1 -u K2 … "${SHELL:-/bin/bash}" -l` over `SECRET_ENV`
  (`env -u` exists in GNU and BSD `env`); test it beside the drain test.
- Disabling a CLI or removing a key affects new sessions only: a
  tmux-persisted tab re-attaches to the process it started with (`-A`).
  Say so in the help text.

Windows: no tmux, no fence; the key reaches the ConPTY child through the
environment block (`terminal::build_command`), never argv.

### A3 — settings field and commands

- `Settings::agent_api_key_clis: Option<Vec<String>>` with
  `#[serde(default, skip_serializing_if = "Option::is_none")]`, beside
  `root_mcp_agents` in `src-tauri/src/schema/settings.rs` (~line 444); a
  round-trip test with an old file that lacks it. TS: `agent_api_key_clis?:
  string[]` in `src/types/index.ts` `Settings`, beside `disabled_agents`.
- The per-CLI toggle writes through `useSettingsStore.updateSettings({
  agent_api_key_clis })` — `patch_settings` merges under the storage lock and
  every window gets the result — like `disabled_agents`. No backend "use"
  command: ids not in the table are harmless (nothing maps to them).
- `src-tauri/src/commands/agents.rs` (beside `agent_logins`):
  `agent_api_keys_status`, `agent_api_key_set { provider, key }` (unknown
  provider → error; shape check; then `set_key`; the keyring's error text
  passed through), `agent_api_key_clear { provider }`. All keychain work in
  `tauri::async_runtime::spawn_blocking`, as `agent_logins` does. Register in
  `lib.rs`'s handler list. A locked store: the panel offers the existing
  `keyring_unlock` command (`commands/credentials.rs`), never a launch-path
  prompt.
- `agent_auth::LoginStatus` gains `api_key: bool` (the CLI is enabled and
  one of its providers has a key). Fill it in `commands::agents::agent_logins`
  (already inside `spawn_blocking`) from `agent_api_keys::status()`, **not**
  in `agent_auth::status_in`, whose tests must stay keyring-free. The struct
  has no `rename_all`, so the field is `api_key` (snake_case like
  `signed_in`). Update every `LoginStatus { … }` literal (it derives
  `PartialEq`; tests build it).

### A4 — desktop UI

`src/components/layout/SettingsSubPanels.tsx`, a new `AgentApiKeysRows`
right after `<AgentLoginsRows />` (~line 1009), built from the same classes
(`settings-subheader`, `settings-help`, `settings-toggle-card-row`,
`ollama-action-btn`, `ToggleRow`) — no new styling:

- Subheader "API keys" + `<UntestedTag id="settings.agentApiKeys" />`; help
  text: per-token billing; the agent can read the key and a project's CLI
  config can redirect it (decision 7) — use a spend-limited key; Claude asks
  once per project and its default answer is No (change later in `/config`);
  Gemini needs "Use Gemini API key" in its `/auth` once per project; keyed
  Claude tabs run without Remote Control; changes reach new tabs only.
- One row per provider: saved / not saved / "keyring locked" (from
  `readable`, with an Unlock button → `keyring_unlock`); a password input +
  Save when not saved (the input is cleared after save; the key is never read
  back); Remove when saved. Keyring errors shown in `settings-help`.
- One `ToggleRow` per CLI in the table: "Use API key for <CLI>" with the
  provider(s) it uses, disabled while none of its providers has a key. The
  per-CLI pills come from a const table with **literal** ids
  (`{ cli: "gemini", untested: "settings.agentApiKeys.gemini" }`):
  `scripts/untested.mjs check` (run by `UntestedRegistry.test.ts`) only sees
  literal `<UntestedTag id="…" />` / `untested: "…"`, and fails on a row no
  call site uses.
- `AgentLoginsRows`: a CLI with `api_key` shows "Uses API key" (next to its
  signed-in state when it has both).
- All strings via `useT()`; every new key in English (`src/lib/i18n.ts`)
  **and** in all four dicts (`src/lib/i18nDicts/{de,es,fr,it}.ts`) —
  `src/__tests__/shell/i18n.test.ts` fails on a missing key. The app's name
  only as `{app}` (brand check).
- Register the untested ids in `src/lib/untested.ts` (area `layout`, next to
  `settings.agentLogins`).

### A5 — phone (status only)

- `src/components/mobile/MobileBridgeHost.tsx`: `AgentLoginRow` gains
  `api_key?: boolean`; `signInOptions` sends `signed_in: login.signed_in ||
  login.api_key` and, when keyed, `api_key: true`. Nothing else crosses: no
  key, no provider names, no entry from the phone in v1.
- `mobile-web/src/api.ts` `SignInRow` gains `api_key?: boolean`;
  `mobile-web/src/screens/NewTabSheet.tsx` `SignInList` shows
  `mobile.signIn.apiKey` ("Uses an API key") for such a row. The
  missing-login count already follows `signed_in`. An older phone bundle
  just shows "Signed in". Rebuild with `npm run mobile:bundle`; extend
  `src/__tests__/mobile/MobileNewTabSheet.test.tsx`.
- Not changed by this: the Terminal screen's banner
  (`mobile-web/src/terminal/signIn.ts` `readSignedOut`) reads the live
  screen, not `agent_logins`. A keyed tab that prints "Invalid API key"
  still gets "needs you to sign in", and for Claude a sign-in cannot help
  (the env key outranks `/login`). Known v1 limit; the help text says to
  fix or remove the key.

### A6 — docs and QA

- `DOCUMENTATION.md`: a short "API keys" paragraph next to the shared-logins
  text (`rg -n "shared login" DOCUMENTATION.md`, ~line 2160), with decision
  7's warning and decision 4's dialogs.
- `docs/context/agent_authority.md`: a short section after the Copilot
  keyring paragraph (~line 364) — what is injected where, the `SECRET_ENV` /
  trailing-shell rules, the tmux-server side effect, decision 7. That file
  has uncommitted edits from another session: edit only that range.
- `todo/group-s-agents.md` (holds the agent-login items): a 🖐️ manual box
  "API key reaches a fenced Claude tab and the CLI runs on it" with the
  four platform children, plus one box per other v1 CLI.
- Tests: Rust unit tests from A1/A2 (incl. the tmux and Settings round-trip
  ones); a vitest for `AgentApiKeysRows` (saved state, Save clears the
  input, toggle disabled without a key, locked state) in the style of the
  existing Settings tests; the phone test from A5.

## Verification (Part A)

Gates from `AGENTS.md`, all at zero warnings (clippy also on Windows/macOS
cfgs where possible: the injection call sites are `cfg`-split), plus
`scripts/privacy-check.sh` and `npm run backend:stale` reported. Live
(user): Manage CLIs → API keys → save an Anthropic key → enable Claude →
open a new Claude tab → Claude asks once to use the key (pick **Yes**; No is
the default) → `/status` shows API-key auth and no Remote Control failure
notice; `ps -eo args | grep -c <key prefix>` finds nothing and the tmux
launcher dir has no key; disable → a new tab is back on the subscription
login. Restart Tabtivity: the key is still there (keychain); a locked
keyring: saving refuses with the locked message and the row says "locked".

## Out of scope (Part A)

Remote and container tabs; Codex (unless A0 proves env use); entering keys
from the phone; validating a key against the provider; per-project keys;
base-URL overrides (Bedrock, Vertex, proxies); the warm-up and usage panel
(they run the CLI in the user's own home).

# Part B — built-in API chat tab (not scheduled)

A tab kind `chat` that talks to a provider API directly. **Chat only: no
tools, no file access, no shell.** Tools would mean a second agent harness
inside Tabtivity, outside the fence — that is the CLIs' job.

## Shape

- **Backend `services::api_chat`** (AppHandle-free): provider adapters behind
  one trait — Anthropic Messages, OpenAI Chat Completions, Gemini, and
  OpenAI-compatible (which covers Ollama, vLLM, LM Studio and reuses
  `commands::ollama`'s address rules). Streaming over `reqwest` SSE; keys from
  Part A's store, read in Rust only. All HTTP from the backend, never the
  webview — the CSP stays the perimeter. A Part A key goes only to its
  provider's fixed API host; an OpenAI-compatible base URL the user typed
  never receives one (it gets its own key, if any).
- **Commands** `api_chat_send { chatId, model, messages }` streaming deltas as
  events keyed by a request id, `api_chat_cancel`, `api_chat_models
  { provider }`. Usage (tokens in/out) returned per turn.
- **Storage**: `<state_dir>/sessions/<id>/chats/<chat-id>.jsonl`, one line per
  message, written by the backend. Never in the project folder. A chat is a
  tab like any other (`tabs` store kind `chat`), restored with its file.
  The state dir is masked from fenced agents (`mask_private_state`) — keep
  it so; chats may quote private files.
- **Frontend**: a `ChatTabView` that reuses the Reader's rendering —
  `transcriptTurns`/`answerHtml`/`chatTimes`, the composer, KaTeX/Mermaid —
  by writing turns in the transcript shape the Reader already reads. Model
  output is untrusted (an attached file can carry an injection): it goes
  through the same sanitizer as agent answers, never raw HTML. Model picker
  from `api_chat_models`; token and cost line under each answer.
- **Context**: explicit only — a file attached by the user (picker or drag),
  read through the confined read commands, never a crawl of the project.
- **Phone**: later, through `mobile_control` endpoints that carry opaque
  chat handles and text only (no project ids, paths, file names or keys).

## Phases

- **B1** backend: Anthropic + OpenAI-compatible adapters, streaming, cancel,
  JSONL store; unit tests against canned SSE.
- **B2** desktop tab: `chat` kind in the tab store and + menu, `ChatTabView`
  on the shared Reader pieces, model picker, usage line; untested pills.
- **B3** OpenAI + Gemini adapters; attachments.
- **B4** phone: chat list and composer in Focus over new endpoints.
- **B5** docs, QA boxes, `docs/context/api_chat.md`.

## Open questions (Part B)

Whether a chat belongs to a project (sessions dir) or to the root console
only; whether Ollama chats replace the local-model tabs' quick-question use;
cost tables (hard-coded per model vs. read from usage only).

# Review notes (2026-10-04)

Checked against the code and vendor docs; what changed:

- **CLI table.** Codex moved out of v1: its docs document only `codex login
  --with-api-key` for interactive use (`CODEX_API_KEY` is exec-only).
  Claude: approval default is No, remembered per agent home; Remote Control
  refuses API-key auth. Gemini needs its own `/auth` pick per home. OpenCode
  names taken from models.dev. Aliases added for the user-wins check.
- **Injection points confirmed**, with corrections: `opts.args` is already
  the bwrap/sandbox-exec argv inside the wrap functions, so the subcommand
  flag must be captured first; the macOS function has no Copilot call to sit
  next to; the shim calls the wrap functions directly (separate process, no
  `launch_prep`), which is why injection lives there. Local-model tabs can
  run `vibe`/`claude` directly, so `opts.local_model` (not the binary) is the
  test; sign-in subcommands excluded.
- **Settings**: `Option<Vec<String>>` per the schema's convention; toggles go
  through `patch_settings` like `disabled_agents`, so the planned
  `agent_api_key_use` command was dropped. Read at spawn from
  `settings.json` (works in the shim process).
- **tmux**: the server is the user's default one — the global
  `update-environment` side effect is now stated; tmux < 3.2 must drop the
  key (argv leak); the trailing unfenced login shell inherited secrets
  (existing tokens too) — now stripped with `env -u`.
- **Remote Control** flag skipped for keyed local Claude tabs.
- **LoginStatus.api_key** filled in the command, not `status_in`; phone gets
  `api_key` plus a label; `readSignedOut` stays screen-based (limit noted).
- **Keychain**: `has()` reads "not saved" while locked → `readable` +
  `keyring_unlock`; reads cost up to 4 s on the async spawn path, as
  Copilot's do; new accounts need no brand migration.
- **Missing steps added**: i18n test requires all four dicts; untested ids
  must be literal; privacy-check placeholder keys; `agent_authority.md` and
  `root_console.md` context updates; `npm run mobile:bundle`.
- **Part B**: key-to-host binding, sanitizer, state-dir mask, opaque phone
  handles.

Open for the implementer:

- Codex env behaviour, Vibe `.env` vs env precedence, OpenCode env vs
  `auth.json`, and whether Reader/Focus render Claude's key dialog as
  buttons — A0, not settled.
- The tmux global-option side effect on the user's own server is accepted
  for v1 on Copilot's precedent; the carrier-variable alternative is noted.
- Decision 7's base-URL redirect from project config has no fix; it is the
  main reason to insist on a spend-limited key.
- The kernel-keyring seccomp filter that stops a fenced agent from reading
  *other* providers' keys out of the session keyring was committed but never
  live-verified.
