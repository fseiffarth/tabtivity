# API keys for agent CLIs, and a built-in API chat — plan

Status: Part A built 2026-10-04 (see "Implementation notes (Part A)" at the
end; never live-verified); Part B not scheduled. Reviewed against the code the
same day (see "Review notes").

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
installed here (A0 ran it with a fake key, below); the other rows are
**from docs**, not run. "Aliases" are the other names
that count as user-set (decision 5).

| CLI (registry id) | Provider | Injected variable | Aliases | What the docs say | v1 |
|---|---|---|---|---|---|
| `claude` | anthropic | `ANTHROPIC_API_KEY` | `ANTHROPIC_AUTH_TOKEN` | code.claude.com/docs/en/iam: ranks above `/login`; interactive mode asks once to approve, remembered; `-p` always uses it. Remote Control refuses API-key auth (`--remote-control` still starts, then shows a failure notice). **A0, 2.1.288, scratch `HOME`, fake key:** `-p` sends the key (debug log: "API-key auth precedence active", 401 "API key is invalid", retried 11×, so a bad key in `-p` takes minutes to fail); the TUI, after the theme screen, shows "Detected a custom API key in your environment", the variable's name with the key's last 20 characters, then "Do you want to use this API key? Yes / ❯ No (recommended)". The Remote Control notice was not checked (needs a real key). | yes |
| `codex` | openai | — | — | developers.openai.com/codex/auth: the documented route is `codex login --with-api-key` (writes `auth.json`); `CODEX_API_KEY` is for exec/review/SDK only; interactive use of `OPENAI_API_KEY` is not documented. **A0:** not installed here, so not run — stays out. | **no** |
| `gemini` | gemini | `GEMINI_API_KEY` | `GOOGLE_API_KEY` | geminicli.com auth docs: interactive mode needs "Use Gemini API key" picked in `/auth` (`security.auth.selectedType = "gemini-api-key"`); a home already on Google login keeps it. **From docs** (not installed here). Implemented aliases: `GOOGLE_API_KEY` and `GOOGLE_GENERATIVE_AI_API_KEY` (the provider's, shared with OpenCode). | yes, untested |
| `vibe` | mistral | `MISTRAL_API_KEY` | — | env or `~/.vibe/.env`; which wins when both exist is unverified. **From docs** (not installed here). | yes, untested |
| `opencode` | all four | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `MISTRAL_API_KEY` | google: `GOOGLE_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` | models.dev `env` lists (OpenCode's provider source); precedence against its own `auth.json` unverified. **From docs** (not installed here). | yes, untested |

**Since C2 (Part C) only Claude and Gemini keep a row** — Vibe and OpenCode have no environment variable that points them at the proxy; see "C2 implementation notes". (Part A:) So the OpenAI key serves only OpenCode in v1. Others (Qwen's
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

# Implementation notes (Part A, 2026-10-04)

Built on the plan above with the review notes applied. Never live-verified;
the untested pills are `settings.agentApiKeys`, `settings.agentApiKeys.claude`,
`settings.agentApiKeys.gemini`, `settings.agentApiKeys.vibe`,
`settings.agentApiKeys.opencode` and `mobile.signIn.apiKey`.

**A0.** Only Claude 2.1.288 could be run (scratch `HOME`, `env -i`, off the tab
record, fake key). Verified: the key is used ahead of any login (`-p` sends it;
debug log "API-key auth precedence active"), and the TUI's approval dialog
exists with **No (recommended)** preselected. Not verified: Remote Control's
refusal notice, `/status` on a real key. Reader / phone Focus: nothing renders
this dialog as buttons — its rows are unnumbered, and `selectPrompt` reads only
numbered dialogs it opened itself — so it stays on screen and is answered with
the arrow keys (desktop terminal, or the phone's keys). The dialog prints the
key's **last 20 characters** on screen, so they reach the phone's terminal
mirror while it is up — the CLI's own UI, noted, not changed. Codex, Gemini,
Vibe and OpenCode are not installed here: their rows are from docs.

**Deviations from the plan, and why.**

- Keychain account `agent-key:<provider>` instead of the drafted
  `agent-api-key` prefix: `scripts/privacy-check.sh` reads "api-key", a colon
  and text as a credential
  assignment and blocks every line naming the account. Same service, same
  rules, new accounts either way.
- `opts.local_model` does not exist on `PtyOptions`. A local-model spawn is
  recognised by `agent_api_keys::is_local_model`: the tab's host-bound marker
  (`host_bound_uid`), the model label the frontend puts on every such tab
  (`<APP>_LOCAL_MODEL`), or Vibe's `VIBE_ACTIVE_MODEL`.
- The pure core takes the subcommand flag (captured by each caller before a
  fence rewrites `opts.args`) and Tabtivity's own environment as a function,
  so the tests do not depend on the runner's environment.
- Remote Control is skipped by `launch_prep::local_claude_keyed`: Claude
  switched on **and** an Anthropic key saved (`agent_api_keys::keyed`), not
  the setting alone — a switch left on after the key was removed must not cost
  the tab its Remote Control. One keychain read, only when Claude is switched
  on and Remote Control would be added.
- tmux < 3.2: `launch_prep` records which key variables the tab brought
  before the fence and drops only the ones the fence added
  (`drop_added_api_keys`); one stderr line names them.
- The unfenced-shell fix (`tmux_local::trailing_shell`) covers every
  `SECRET_ENV` name, so the MCP tokens and the Copilot token no longer leak
  into the shell a fenced pane leaves behind either.
- Nothing is logged at injection: in the `--agent-shim` process stderr is the
  user's own terminal.
- The user help went to `docs/help/agent-clis.md` (where the shared-logins
  text lives, served by the help MCP) as well as a short paragraph in
  `DOCUMENTATION.md`'s agent-authority section; `DOCUMENTATION.md` has no
  shared-logins text to sit next to.
- The phone row: `signInOptions` sends `signed_in: true` and `api_key: true`
  for a keyed CLI even where the login store is not shared, and the backend's
  `MobileSignInOption` gained `api_key` (it re-serializes the desktop's answer
  and would otherwise drop the field). The phone pill is
  `mobile.signIn.apiKey`. The phone test went into
  `MobileSignInTab.test.tsx`, where the sign-in list's test already lives.
- `AgentApiKeysRows` is exported for its test; `AgentLoginsRows` re-reads on
  every key or switch change (`refreshKey`).

# Part C — hardening: no key in the agent, a spending limit (2026-10-04)

Status: C1 and C2 built and reviewed 2026-10-04 (see "C1/C2 implementation
notes" and "C1/C2 review notes" at the end; never live-verified); C3 built
2026-10-04 and reviewed (see "C3 implementation notes" and "C3 review
notes"; never live-verified). Fixes the two open risks Part A left: (1) the common
variable names (`ANTHROPIC_API_KEY`, …) sit in the global `update-environment`
of the user's own default tmux server; (2) the agent can read the real key,
and a project's own CLI config (`ANTHROPIC_BASE_URL` in `.claude/settings.json`,
an `opencode.json` `baseURL`, Gemini's project `.env`) can send it to another
host — with no ceiling on what it spends.

## Decisions

1. **The real key never enters an agent process.** A loopback proxy in
   Tabtivity holds the keys. Each keyed agent spawn gets a **per-spawn proxy
   token** (random, revocable, bound to provider + scope + tab, like the MCP
   lanes' per-spawn tokens in `services::root_mcp`) plus the CLI's base-URL
   variable pointing at the proxy. A leaked token is worthless off this
   machine, dies with the tab, and is capped by the budget. A project config
   that redirects the CLI elsewhere sends only that token.
2. **Only proxyable CLIs keep a key.** A CLI is in the table only if an
   environment variable (never a project-writable config) points it at the
   proxy. A CLI that can't be pointed at the proxy loses its row rather than
   getting the raw key back. Expected: Claude (`ANTHROPIC_BASE_URL`, verify
   that `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY` with a proxy URL still
   raises or avoids the custom-key dialog); Gemini (`GOOGLE_GEMINI_BASE_URL`,
   verify); Vibe and OpenCode only if the docs show an env base-URL — else out.
   A project config that overrides the base URL wins in the CLI; that's
   acceptable because only the proxy token leaks.
3. **The proxy forwards only to the provider's own API host** (fixed per
   provider: `api.anthropic.com`, `generativelanguage.googleapis.com`,
   `api.mistral.ai`, `api.openai.com`), HTTPS, a path allowlist per provider
   (e.g. Anthropic `/v1/messages`, `/v1/messages/count_tokens`, `/v1/models`),
   request body size bound, streaming (SSE) passed through unbuffered. It
   strips the incoming auth header and adds the real one. Never logs keys,
   tokens or bodies.
4. **Spending limit, enforced locally, required.** Saving a key requires a
   monthly limit in USD (default proposed in the UI, e.g. 20). The proxy reads
   each response's usage (Anthropic `message_start`/`message_delta` usage incl.
   cache read/write; Gemini `usageMetadata`; Mistral/OpenAI `usage`) and
   prices it from a per-model table in code (`services::api_prices`); an
   unknown model is priced at that provider's most expensive known rate and
   flagged. Ledger `<state_dir>/agent-api-usage.json` (no secrets; month,
   provider, spent, per-model tokens), written atomically, round-trips. Once
   spent ≥ limit, new requests are refused in the provider's own error shape
   (HTTP 429 / provider error JSON, message "<app> monthly API budget for
   <provider> reached — raise it in Manage CLIs") so the CLI shows a readable
   error. A request already streaming finishes; the limit can overshoot by one
   turn — say so in the UI. Also recommend a provider-side limit in the help.
5. **Tabtivity-named variables in tmux (risk 1).** Whatever the spawn must
   carry secretly (now: the proxy token) travels under app-named variables
   (`app_env!("AGENT_KEY_…")`) — the only names added to `SECRET_ENV` — and is
   mapped to the CLI's own names immediately before exec of the agent,
   *inside* the fence, by Tabtivity's own binary (an exec-shim mode like
   `--fence-scope`, but always used, not only when Landlock is available), then
   removed from the environment. Part A's additions of `ANTHROPIC_API_KEY` etc.
   to `SECRET_ENV` are reverted. Non-secret values (base URL) may ride as
   ordinary env. Host-session and Windows spawns need the same mapping — the
   implementer picks the mechanism there (no `/proc` argv exposure, no disk).

## Steps (one implementer subagent each, a reviewer subagent after each)

- **C1 — app-named variables + exec-time mapping.** Revert the common names
  from `SECRET_ENV`; add the mapping shim and its unit tests; cover fenced
  (Linux, with and without the Landlock helper), macOS sandbox-exec, Host
  session, Windows, and the `agent_bin` shim. Still injects the raw key (C2
  replaces it) so C1 is shippable alone.
- **C2 — the proxy.** New AppHandle-free `services::api_proxy`: loopback
  listener (or a route on the existing MCP listener if its bounds fit
  streaming — implementer decides and says why), per-spawn tokens with
  revocation at tab end, host/path allowlists, SSE passthrough, auth swap.
  Injection switches from raw key to token + base URL; drop CLIs not
  proxyable (decision 2) from the table, untested pills and docs. A0-style
  verification for Claude against the proxy with a fake key and a local stub
  upstream (no real network). Started with the app, stopped in
  `RunEvent::Exit` teardown.
- **C3 — spending limit.** `services::api_prices`, usage parsing per provider
  (unit tests on canned SSE/JSON), ledger, refusal, Manage CLIs UI (limit
  field required on save, spent/limit per provider, month reset, raise limit),
  `agent_logins`/phone show "budget reached" where relevant. Docs + QA boxes.

## C1 implementation notes (2026-10-04)

Never live-verified. What was built:

- **Carriers.** `agent_api_keys::CARRIERS` —
  `app_env!("AGENT_SECRET_ANTHROPIC_API_KEY")` and the same for `OPENAI_`,
  `GEMINI_`, `MISTRAL_API_KEY` — replace the four common names in
  `tmux_local::SECRET_ENV`, in the same `update-environment` slots
  (8636–8639), so a tmux server a Part A build touched gets those entries
  overwritten by the next tab rather than keeping them. `inject_env` writes a
  key under its carrier on Linux and macOS; the user-wins check still looks at
  the CLI's names (and their aliases).
- **The mapping step.** `services::agent_exec`, `tabtivity --agent-exec
  <prog> [args…]` (`main.rs`, Unix): every variable named
  `<APP>_AGENT_SECRET_<NAME>` is removed and `<NAME>` set from it (a plain
  variable name, never an app-named one, a non-empty value), then `exec`.
  (Since the review: only the CLIs' key variables, `agent_exec::targets` —
  see "C1 review notes".)
  `fence_scope::run` (`--fence-scope`) applies the same mapping, so a host
  with the Landlock scope still runs one step in front of bwrap, not two.
  The binary is `fence_scope::running_binary` (`/proc/<pid>/exe` once
  replaced) on Linux, `current_exe` on macOS.
- **Per spawn path.**
  - *Fenced Linux* (`wrap_pty_options_bwrap`, also the shell-tab shim):
    injection now runs before the launcher is built, and
    `agent_fence::launcher_step` picks the step in front of bwrap —
    `--fence-scope` where Landlock's scope applies (as before), else
    `--agent-exec` when the environment carries a secret, else none (no
    change for spawns without a key).
  - *macOS sandbox-exec*: `agent_exec::wrap` puts `--agent-exec` in front of
    `/usr/bin/sandbox-exec` when a carrier is present. `cfg(target_os =
    "macos")` code: not compiled here.
  - *Host session* (Linux/macOS): the same `wrap`, in front of the CLI (an off-
    `PATH` CLI resolved first, as `build_command` would have; on `PATH` it
    stays bare and resolves through the agent_bin shim, which passes a Host
    session through).
  - *Windows*: no carrier, no step — the key goes into the ConPTY child's
    environment block under the CLI's own name (no tmux, no fence, no argv).
  - *tmux < 3.2*: `launch_prep` drops the carriers the fence added (was: the
    common names); a step left in front only `exec`s.
  - *Trailing shell*: `env -u` over `SECRET_ENV` now strips the carriers; the
    pane's `sh` never held the CLI's name, so nothing else is needed.

**Deviations, and why.**

- **`AGENT_SECRET_`, not `AGENT_KEY_`.** `brand::Pair::export_both` copies
  every app variable to its legacy-prefix twin unless the name contains
  `TOKEN`, `ASKPASS`, `SECRET` or `PASSWORD`; an `…_AGENT_KEY_…` carrier would
  have been twinned under the old prefix — a name not in `SECRET_ENV` — and
  ridden `new-session -e` on the world-readable tmux argv. A test
  (`agent_exec::tests::carriers_get_no_legacy_twin`) holds this.
- **The step runs in front of bwrap / sandbox-exec, not inside them.**
  Inside bwrap Tabtivity's binary is not reliably reachable: the home is the
  scope home (a dev build lives under it), `/tmp` is a tmpfs that hides an
  AppImage's mount, and the fresh `/proc` has no `/proc/<app pid>/exe`;
  inside Seatbelt the profile would have to grant the binary. Nothing is
  lost: bwrap and sandbox-exec pass the environment through unchanged, so the
  CLI starts with exactly the mapped environment, and the value is in an
  environment (0400) at every hop, never an argv or file.
- **The step is added only when there is something to map** (or, as before,
  for the Landlock scope), not to every spawn, so spawns without a key are
  unchanged.
- **The Host session's trailing shell** (unfenced, no `env -u`) keeps the
  carriers as it kept the MCP tokens and, in Part A, the key itself — the
  Host session is the user's own unfenced shell; left as is.

**Untestable here.** macOS (`cfg` code, no compile); a live tab (never
started — AGENTS.md); Windows only `cargo check` (lib and tests). Covered by
unit tests: the mapping (incl. a real `exec` that sees the variable and no
carrier), `launcher_step`, the shell launcher with both modes, the carriers
in `SECRET_ENV` and off `-e`/the launcher script, `env -u` of a carrier, the
< 3.2 drop, no legacy twin. By hand with the debug binary: the fence's
`sh -c` launcher with each mode in front of a probe (bwrap itself cannot nest
in the sandbox this was built in) — the probe saw `ANTHROPIC_API_KEY`, no
carrier, and the filter on descriptor 9.

## C1 review notes (2026-10-04)

Reviewed 030dcd59/d2b164f3. Fixed:

- **Any plain name → only the key variables.** The step runs *outside* the
  fence (in front of bwrap / `sandbox-exec`, or a Host session's CLI), so a
  carrier able to name any variable could set `LD_PRELOAD`, `PATH`,
  `BASH_ENV` or `NODE_OPTIONS` for the unfenced launcher. No project route to
  a carrier was found (a tab env adopted from a project folder is stripped;
  only `inject_env` and the frontend write `opts.env`), but the list costs
  nothing: `agent_exec::targets()` = `agent_api_keys::ENV_VARS`, extended by
  whatever C2 carries. The "newer binary on disk" reason for a prefix rule
  did not hold on Linux — the step is always the running binary
  (`/proc/<pid>/exe` once replaced); on macOS an updated binary drops a name
  it does not list, which fails safe (no key, the CLI's own login). Every
  carrier is still removed; a non-UTF-8 carrier name is now removed too.
- **Inherited carriers.** Every child inherits Tabtivity's own environment and
  only a spawn whose `opts.env` carries something gets the step, so a
  Tabtivity (or `--agent-shim`) started from a shell holding a carrier would
  have passed it unmapped to every tab. `main` now drops inherited carriers
  in every mode but `--agent-exec` / `--fence-scope`, before any thread.
- **Host session trailing shell** now starts with `env -u` over the carriers
  (only when the tab carries one; MCP tokens unchanged there): the key handed
  to the Host agent is not handed on to what the user runs next.
- **tmux < 3.2** drops *every* carrier, not only those the fence added — a
  carrier is only ever Tabtivity's injection, and one the tab brought would
  have ridden the world-readable argv (`keys_before` removed).
- Tests: the exec test runs the step's own `apply` path (was a copy of it)
  with an unlisted carrier beside the key; dangerous targets; non-UTF-8;
  the Host session's argv and tail; carriers in slots 8636–8639 exactly;
  the < 3.2 drop.

Checked, no change: no value on any argv, launcher script, file or log
(names only); `export_both` skips `…SECRET…`; fd 9 survives the extra step
(Rust's `exec` closes nothing it did not open) and Landlock is still entered
before the mapping and bwrap; spawns without a key get no step; an exec
failure exits 127 with the path only and nothing runs unfenced; the shim
waits for its child, so its `/proc/<pid>/exe` stays valid; mobile headless
spawns go through the same `prepare`; Windows has no carrier; macOS
(`sandbox-exec` keeps `AGENT_FENCE`, so `is_fence` still holds) read, not
compiled.

Not fixed, with reason:

- **Part A global environment.** A tmux server started by a Part A build's
  keyed tab holds `ANTHROPIC_API_KEY` (etc.) in its *global* environment; the
  Part A slots cleared it for every session, the C1 carriers in those slots
  no longer do, so it would reach every later session on that server. Part A
  never left this branch (not on `develop`, no dev build ran it), so no
  migration code; if one did run, `tmux kill-server` (or `tmux
  set-environment -g -u ANTHROPIC_API_KEY`) once.
- A tmux session's own environment keeps the carriers (as it keeps the MCP
  tokens), so a pane the user adds to a Tabtivity session by hand would
  inherit them — the existing `SECRET_ENV` class, out of C1's scope.

## C2 implementation notes (2026-10-04)

Never live-verified. What was built:

- **`services::api_proxy`** (new, `AppHandle`-free, axum + reqwest — no new
  dependency). Started in `setup` beside the MCP listener, stopped in the
  `RunEvent::Exit` teardown right after it (revoke all, stop accepting, 2 s
  drain), before the PTY teardown.
- **Its own loopback listener, not a route on the MCP one.** The MCP listener
  (`commands::root_mcp`) is built for one small JSON-RPC message per socket:
  a 30 s socket lifetime, `Connection: close`, a JSON-only content type and a
  small body bound. A model turn streams for minutes and Claude's request
  bodies run to tens of KiB (72 KB for a bare `-p "say hi"`) up to MiBs with
  images. The proxy's listener keeps a socket cap (64) and a 10 s
  first-byte timeout, no total lifetime; the body bound is 32 MiB (the
  Messages API's own), read with a 60 s bound.
- **Tokens.** 32 random bytes, memory only, `Grant { provider, scope, tab,
  tmux }`. Revoked from `agent_fence::on_tab_gone` (every tab teardown path
  reaches it). A tmux-wrapped tab outlives its PTY — a project switch or a
  window reload runs `pty_kill`, which kills only the tmux client — so a grant
  bound to a tmux session is kept until a sweep (`tmux ls`, off the teardown
  thread) finds the session gone, and a respawn of the same tab gets the same
  token back (`issue` reuses a grant equal in provider, scope, tab and
  session): that is what keeps a re-attached agent working. Every grant goes
  at quit; a clean quit also kills Tabtivity's tmux sessions, so no agent
  outlives its proxy then. After a crash, a re-attached keyed agent holds a
  dead token (and a dead port) — restart the CLI; stated in the help.
- **Forwarding.** `/<provider>/<path>` → `https://<fixed host><path>`:
  `api.anthropic.com`, `generativelanguage.googleapis.com`. Checks in order:
  `Origin` present or `Host` other than `127.0.0.1:<port>` → 403; a token in
  `x-api-key`, `Authorization: Bearer`, `x-goog-api-key` or `key=` (every one
  present must agree, none repeated) that is live and of the route's provider
  → else 401; the path allowlist (Anthropic `POST /v1/messages`, `POST
  /v1/messages/count_tokens`, `GET /v1/models[/<id>]`; Gemini `v1`/`v1beta`
  `GET models[/<m>]`, `POST models/<m>:{generateContent,
  streamGenerateContent, countTokens, embedContent, batchEmbedContents}`;
  every segment `[A-Za-z0-9._:-]`, no `.`/`..`/empty/percent) → else 404; the
  key (memory cache over the keychain, `spawn_blocking` on a cold read, a miss
  remembered 15 s; `set_key` clears it, so a removed key stops running tabs
  at their next request) → else 401 naming Manage CLIs; the bounded body.
  Forwarded: every request header but the credentials, hop-by-hop ones,
  `accept-encoding`, cookies, `origin`/`referer`/`x-forwarded-*` (so
  `anthropic-version`, `anthropic-beta`, `x-claude-code-*` pass unchanged, as
  Claude's gateway guide asks); the real key in `x-api-key` / `x-goog-api-key`;
  the query minus `key`. The client: HTTPS only, no redirects, no automatic
  decompression (the upstream answers unencoded, so C3 reads plain bytes),
  30 s connect, 10 min per-read idle. The answer: status and headers (minus
  hop-by-hop, `content-length`, `set-cookie`), body relayed chunk by chunk.
  Refusals in the provider's error shape with `x-should-retry: false` (true
  only for an unreachable upstream). Nothing is logged.
- **C3 seam.** `usage_tap(grant, chunk)` sees every response chunk of a
  granted request in order, `usage_end(grant)` a clean end; both empty. C3's
  refusal goes beside the `NoKey` check in `handle`.
- **Injection** (`agent_api_keys`): `CLI_ROUTES` replaces `CLI_KEYS` — per CLI
  `(provider, token variable, base-URL variable)`. Claude: token in
  `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/anthropic`;
  Gemini: token in `GEMINI_API_KEY`,
  `GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:<port>/gemini`. The token rides
  the C1 carrier (`<APP>_AGENT_SECRET_ANTHROPIC_AUTH_TOKEN`,
  `…_GEMINI_API_KEY`; `agent_exec::targets` = these two), the base URL plain.
  Windows: both under the CLI's names (C1's rule). The user-wins check covers
  every credential name of the provider (`ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`; `GEMINI_API_KEY`, `GOOGLE_API_KEY`,
  `GOOGLE_GENERATIVE_AI_API_KEY`) and the CLI's base-URL variable. Nothing
  is injected unless the proxy runs in the process and the provider has a key.
- **Decision 2 — which CLIs kept a row** (vendor docs, 2026-10-04):
  - *Claude* — kept. `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` is the
    documented gateway setup (code.claude.com "Connect Claude Code to an LLM
    gateway"; "With `ANTHROPIC_AUTH_TOKEN`, the variable takes precedence
    immediately. With `ANTHROPIC_API_KEY`, you are prompted once").
  - *Gemini* — kept. geminicli.com configuration reference:
    `GOOGLE_GEMINI_BASE_URL` "Overrides the default base URL for Gemini API
    requests (when using `gemini-api-key` authentication)". From docs; not
    installed here.
  - *Mistral Vibe* — dropped. Its docs list only `MISTRAL_API_KEY` and
    `VIBE_HOME` as environment variables; the base URL lives in
    `config.toml` (`[[providers]] api_base`), project-writable at
    `./.vibe/config.toml`, and `VIBE_HOME` would swap the user's whole Vibe
    home.
  - *OpenCode* — dropped. No base-URL variable; the one env route is
    `OPENCODE_CONFIG_CONTENT`, a whole inline config (it does outrank the
    project's `opencode.json`), which Tabtivity already fills for local
    OpenCode with its Ollama model list — merging both, plus four AI-SDK
    base-URL conventions, unverifiable here (not installed). A later row if
    someone verifies it.
  - With them went the OpenAI and Mistral providers (no CLI left uses them),
    the `vibe`/`opencode` switches and pills, and the matching docs; the
    phone label ("Uses an API key") still fits.
- **A0-style check, Claude 2.1.288** (scratch `HOME`, `env -i`/`env_clear`,
  off the tab record, fake key, no network): against a stub upstream
  directly, `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL` → the TUI goes
  theme → security notes → trust prompt → session ("API Usage Billing"), **no**
  "Detected a custom API key" dialog, and answers; `ANTHROPIC_API_KEY` with
  the same base URL still raises the dialog (default *No*) — hence
  `ANTHROPIC_AUTH_TOKEN`. Requests seen: `HEAD /api/hello` (no credential;
  the proxy answers 401, harmless per Claude's docs) and `POST
  /v1/messages?beta=true` with `Authorization: Bearer <token>`. Through the
  real proxy (`api_proxy::tests::claude_cli_talks_to_the_proxy`, `#[ignore]`,
  `C2_PROBE_CLAUDE=<binary>`): `claude -p "say hi"` printed the stub's reply;
  the stub saw `x-api-key` = the fake key and no `Authorization` (the token
  never left the proxy).

**Deviations, and why.**

- **Tab, not spawn.** A token is per tab (and provider and scope), reused by
  a respawn, rather than minted per spawn: a respawn of a tmux tab
  re-attaches the agent that still holds the first token, so a fresh token
  per spawn would have broken every keyed tmux tab at its first project
  switch.
- **The `agent_bin` shim gets no token.** It runs in its own process, where
  no proxy runs; a token minted there would be valid nowhere. A CLI typed into
  a shell tab stays on its own login (Part A gave it the raw key). Fail-safe;
  an IPC to the app for a token would be the fix if wanted.
- **Remote Control skip** (`local_claude_keyed`) now also requires the proxy
  to be running (`agent_api_keys::keyed`); Claude refuses Remote Control with
  a gateway credential or a non-Anthropic `ANTHROPIC_BASE_URL` either way.
- **tmux < 3.2** drops the proxy base URL with the carrier (`drop_carriers`,
  only a value that is a proxy URL): a CLI pointed at the proxy without its
  token would send its own login there and be refused. A fix in code C1
  touched, found while switching the injection.
- **Cost note.** Claude's docs: with `ANTHROPIC_AUTH_TOKEN` (and no
  `ANTHROPIC_API_KEY`), background tasks run on the main model rather than
  Haiku. Accepted for the dialog-free start; C3's limit covers spend.

**Untestable here.** Gemini through the proxy (not installed — path list and
`x-goog-api-key` from `@google/genai`'s documented behaviour); a real
provider (no real key, no network by design); a live tab (AGENTS.md); macOS
(`cfg` code unchanged in shape, not compiled); Windows only `cargo check
--all-targets`. Covered by unit tests: path allowlist, token slots, query and
header stripping, provider error shapes, grant reuse/revocation and the tmux
sweep's retain rule, the key generation guard, end to end against an
in-process stub (key swap, token never forwarded, first SSE chunk arrives
before the upstream finishes, 401/403/404/413 before the upstream sees
anything, revocation, no-key refusal, Gemini query token dropped), and the
injection core (routes, user-wins incl. base URL, carriers, no proxy → no
injection).

## C2 review notes (2026-10-04)

Reviewed 0919499a/e8f664ab. Fixed:

- **Query smuggling.** Every query parameter but `key` was forwarded, so
  `%6Bey=` (which Google decodes as `key`), `$httpMethod=DELETE`,
  `access_token=` or `$callback=` reached the provider. Now a per-provider
  allowlist by exact name (`forwarded_query`, `query_allowed`): Anthropic
  `beta`, `limit`, `after_id`, `before_id`; Gemini `alt`, `pageSize`,
  `pageToken`. The method-override headers (`x-http-method-override`,
  `x-http-method`, `x-method-override`, which Google honours) are stripped
  too — both stepped around the per-path method allowlist. The real key's
  header value is marked sensitive.
- **Sockets held forever.** The only socket bound was a 10 s wait for the
  first byte: after it a trickled head, or an idle keep-alive after any
  answer (a 401 included — no token needed), held one of the 64 slots for
  good, so any local process could stall every keyed tab. Now a socket with
  no request in flight must deliver the next request head within 60 s of the
  accept or of the last answer's end (`IDLE_WAIT`; trickling does not reset
  it), and an answer the client leaves unread for 10 min ends the socket
  (`WRITE_STALL`). A request in flight is never cut: the handler marks its
  connection busy (`ConnectInfo<Conn>`) until the relayed body ends.
- **Memory.** 64 sockets × 32 MiB bodies could hold 2 GiB in the app's own
  process. Bodies held at once are now capped at 256 MiB over all sockets
  (`MAX_BUFFERED`; refused with a retryable 503 in the provider's shape),
  counted until the upstream send returns.
- **Grants that outlived their tab, or died too early.**
  - A tab with a `tmux_session` on a machine without tmux (the wrap is then a
    no-op) got a tmux-bound grant that no sweep could ever revoke (`tmux`
    not runnable → grants left alone). The binding is now `tmux_binding`:
    the session only where tmux runs.
  - An explicit close kills the session (`local_tmux_kill`) after `pty_kill`,
    whose sweep had already found it alive — the grant stayed until some
    other tmux tab ended. The kill now revokes that session's grants
    (`on_tmux_session_gone`), and a sweep runs once a minute while any
    tmux-bound grant is held (a phone-started session or one ended outside
    Tabtivity ends with no PTY to trigger one).
  - A rename (`local_tmux_rename`) left the grant on the old name, so the
    next sweep cut the still-running agent off. It now follows the rename
    (`on_tmux_renamed`).
  - A sweep racing a spawn (grant issued, session not yet created) revoked
    the new grant. A tmux-bound grant is now spared for 60 s after issue
    (`SWEEP_GRACE`). This also removed the test that flipped the global
    `STOPPING` flag to dodge that race.
- **The port after a crash.** A re-attached agent keeps its old base URL; on
  a fresh port its requests — the conversation — went to whatever local
  process (any user's) took the old one. The listener now binds the port of
  the last run again when free (`<state_dir>/api-proxy-port`, not a secret),
  so such an agent meets this proxy's 401. The bind is now synchronous in
  `start`, so tabs restored right after setup no longer race an async bind
  and silently start without the proxy.
- **C3 seam.** `usage_end` ran only on a clean end; an upstream read error
  or a client that went away (the common abort) never reached it. A `Tap`
  guard now calls `usage_end(grant, StreamEnd::{Complete, Failed, Aborted})`
  exactly once per relayed answer, error statuses included.
- Tests: the query allowlist (encoded `key`, `$httpMethod`, cross-provider
  names), the dropped header set (method overrides, `proxy-authorization`,
  `te`, `transfer-encoding`, `content-length`, `origin`), the sweep grace,
  kill/rename, `tmux_binding`, the seam's end on abort and on a broken
  upstream (and once on a clean end), the body budget (503, counter back to
  zero), idle/trickle/keep-alive sockets dropped while a quiet stream
  survives, the remembered port.

Checked, no change:

- **Token comparison.** A `HashMap` lookup keyed by the token: SipHash with
  a random per-process key, so lookup timing cannot be steered toward a live
  token; then an equality on a 64-hex-char value only when hashes collide.
  Not constant-time in the strict sense, not exploitable. Documented in the
  module.
- **Other local users.** Loopback reaches every uid, and the token alone is
  the credential. Acceptable: 256 bits, only in the agent's environment
  (`/proc/<pid>/environ` is owner-only) and as a carrier on the user's own
  tmux server (socket dir 0700), on no argv, file or log; worthless off the
  machine, dead with its tab.
- Token carriers: one value across `x-api-key`, `Authorization: Bearer`,
  `x-goog-api-key`, `key=`; a repeated header refuses; a token of another
  provider refuses on the route; refusals come before the path check and the
  body read, so no unauthenticated request is read past its head.
- Revocation reaches every tab end: `pty_kill`, `pty_kill_scope` (project
  close/delete), `kill_all` (quit), `teardown_taken`, the reader's natural
  exit (`current_spawn_ended`), all through `agent_fence::on_tab_gone`; quit
  revokes everything first. "Same token on respawn" binds provider + scope +
  tab + session, so no other tab or scope can obtain it.
- Forwarding: path segments are plain (`..`, `.`, empty, `%` refused); an
  absolute-form request URI changes nothing (fixed upstream, `Host` must be
  `127.0.0.1:<port>`, HTTP/2 included — a request without one is
  refused); the upstream URL is the fixed HTTPS host + checked path; the
  real key only ever in `x-api-key` / `x-goog-api-key`, never a URL;
  redirects off; `content-length` / `transfer-encoding` never forwarded (the
  body is fully read, reqwest sets its own length); `set-cookie` and
  hop-by-hop response headers dropped (the rest — `request-id`, rate-limit
  headers, `retry-after` — the CLI needs).
- Lifecycle: started in `setup` beside the MCP listener, stopped in
  `RunEvent::Exit` right after it and before the PTY teardown; no panic path
  on the request side (`lock` survives poisoning; the semaphore never
  closes).
- Injection: `CLI_ROUTES` holds only Claude and Gemini; Claude gets
  `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL`, Gemini `GEMINI_API_KEY` +
  `GOOGLE_GEMINI_BASE_URL`; a user-set credential or base URL wins; Windows
  sets the CLI's names; Remote Control is skipped only when `keyed`. No raw
  key reaches any agent environment: `get_key` is read only by
  `api_proxy::key_for` and `has_key`/`status`; the `--agent-shim` process
  never runs the proxy, so `inject_env` gives it nothing.
- Logging: only bind/serve errors (no request data); `launch_prep`'s
  tmux < 3.2 line names variables, never values.

Not fixed, with reason:

- A late `pty_kill` of a tab's previous spawn revokes by tab id, so it would
  also revoke a respawn that reused the token, if the frontend respawned
  before that kill returned. The other per-tab state `on_tab_gone` clears
  has the same rule; not seen in the spawn order, not changed here.
- After a crash the remembered port can only be rebound if nothing took it
  while Tabtivity was down; then re-attached agents talk to that process —
  as before this fix, only in that narrower window.
- A local process can still occupy all 64 slots by reconnecting faster than
  the idle bound — a loopback service cannot prevent that; the bounds keep
  the app's memory and sockets safe, not the proxy's availability against
  a determined local attacker.

## C3 implementation notes (2026-10-04)

Never live-verified. What was built:

- **`services::api_prices`** (pure). Per-model USD/MTok tables read off the
  vendors' pages on **2026-10-04** (`PRICES_DATE`, shown in Manage CLIs):
  platform.claude.com/docs/en/about-claude/pricing (input, 5-minute and 1-hour
  cache writes, cache reads, output for every listed Claude model incl. the
  retired ones; fast mode 2× — Opus 5.5 $8/$40 over $4/$20, Opus 5/4.8
  $10/$50 over $5/$25; `inference_geo: "us"` 1.1×; web search $10/1,000) and
  ai.google.dev/gemini-api/docs/pricing ("Last updated 2026-10-01": paid
  Standard tier; Pro tiers past 200K prompt tokens, audio input rates, cache
  reads, the 3.6–3.8 Flash promotional rates that double from 2027-01, image
  /TTS/embedding models). Ids matched after `normalize` (case, `models/`,
  `anthropic.`, `@…`, `[1m]`, Bedrock `-v1:0`, `-latest`, `-YYYYMMDD`; Gemini
  `-001`, `-preview-MM-YYYY`, `-exp-MMDD` stems) — exact matches only, no
  prefix guessing. Unknown model → per token kind the maximum over the
  provider's current chat models (Anthropic $10/$50, cache read $1; Gemini
  $4/$18, cache $0.40 — retired and media models excluded), flagged.
- **`services::api_meter`** (pure). `billing()` names the paid routes:
  Anthropic `POST /v1/messages`; Gemini `generateContent`,
  `streamGenerateContent`, `embedContent`, `batchEmbedContents`. Counting and
  model reads are neither metered nor refused. A streaming JSON scanner
  follows strings, escapes and nesting through any chunk boundary and keeps
  only the usage object of the top-level answer — Anthropic `usage` at the
  root (non-streaming message, `message_delta`) or under `message`
  (`message_start`), Gemini `usageMetadata` at the root of each response (an
  SSE event, an element of the JSON array a plain `streamGenerateContent`
  sends, or one JSON answer) — and the model beside it. A `usage` inside tool
  input or answer text is not read (an agent cannot make the model print a
  cheaper usage). Each field keeps its maximum (both APIs report running
  totals), so a stream is never counted twice. Bounds: 64 frames, a 128-byte
  string window, a 16 KiB usage capture; an SSE line break resets the
  scanner. `accept-encoding` is not forwarded and the client asks for no
  decompression (C2), so the bytes are plain — checked.
- **`services::api_usage`.** `Ledger` (`<state_dir>/agent-api-usage.json`:
  `version`, `month` UTC `YYYY-MM`, per provider `spent_usd` and per model
  input/output/cache write/cache read/web searches/requests/usd/unknown,
  `previous` month's totals, `restarted`); model names sanitized, 80 chars,
  32 per provider then `(other)`. `Book`: in memory, loaded on first use,
  written with `storage::write_json_atomic` at most 5 s after a change (one
  writer thread per burst) and in `api_proxy::stop_for_exit` after the drain.
  Missing file → empty month; unparseable → moved to
  `agent-api-usage.corrupt.json`, count restarted with `restarted` set and
  shown; unreadable → same note, file left in place; a month ahead of the
  clock is kept (clock went back), a later month rolls over. `limit_for` reads
  `Settings::agent_api_limits` (provider id → USD, `Option`, serde default,
  round-trips) and re-parses only when `settings.json`'s mtime/size changes.
  `Verdict`: `open` / `reached` (spent ≥ limit) / `noLimit`.
- **Enforcement** in `api_proxy::handle`, after the token, path and key checks
  and before the body is read: a billed request whose provider is `reached` or
  `noLimit` gets 429 with `x-should-retry: false` in the provider's shape
  (Anthropic `rate_limit_error`; Gemini `RESOURCE_EXHAUSTED`), message
  "<app> monthly API budget for <provider> reached — raise it in Manage CLIs →
  API keys, or wait for next month" / "<app> has no monthly API budget set
  for <provider> …" (`app_name!`). The seam: `Tap` carries the meter and the
  book; `usage_tap` feeds it, `usage_end` prices and records whatever was
  reported for Complete, Failed and Aborted alike.
- **Commands.** `agent_api_key_set` refuses without a valid limit in settings
  (`agent_api_keys::require_limit`); the UI writes the limit first.
  `agent_api_keys_status` adds per provider `limitUsd`, `spentUsd`, `budget`,
  `unknownModels`, and `month`, `resetsOn`, `ledgerRestarted`, `pricesDate`.
  `agent_logins` sets `api_budget_reached` for a keyed CLI whose every
  provider is not `open`; the phone bridge passes it as a flag
  (`MobileSignInOption::api_budget_reached`).
- **UI.** Manage CLIs → API keys: a limit field (20 proposed) beside the key
  field — Save disabled without a valid one; a saved key's row reads "saved ·
  $x of $y spent this month" / "budget reached ($x of $y) — new requests are
  refused until <date> or a higher limit" / "no monthly limit — requests are
  refused until you set one", with its limit field and **Set limit**; models
  priced at the fallback rate are listed under the row; a help line gives the
  reset date, the overshoot by concurrent turns, the table's date and the
  provider-side limit advice; a restarted ledger is said. Shared-logins row and
  the phone's sign-in list: "API budget reached" in place of "Uses an API
  key". Pills `settings.agentApiKeys.limit`, `mobile.signIn.apiBudgetReached`.

**Deviations, and why.**

- **Overshoot is "the turns in flight", not "one turn".** Decision 4 said one
  turn; several keyed tabs can each be mid-answer when the limit is crossed,
  and every one finishes. The UI and help say so.
- **Embeddings are estimated** (`body bytes / 3` tokens at the model's input
  rate) unless the answer carries usage: Gemini's embed answers report none,
  and leaving them unmetered would be a free route around the limit for a
  token holder.
- **Cache writes without a TTL breakdown count as 1-hour writes**, and a
  remainder the breakdown does not explain too — the dearer reading.
- **Sonnet 4 / 4.5 long-context premium** (2× input, 1.5× output past 200K)
  is from the earlier pricing page; the 2026-10-04 page lists standard 1M
  pricing for 4.6 and later only. Kept as the conservative reading.
- **Image models** are priced at their image-output rate for every output
  token (no split of text and image tokens): an overcount.
- **`AgentLoginsRows` is exported** for its test, as `AgentApiKeysRows` is.

**Not metered (stated in the help):** Gemini Search grounding fees (absent
from `usageMetadata`), Anthropic code-execution hours, refusal-fallback
repricing, spend outside Tabtivity. Output generated after a client abort and
never reported is not seen. Gemini CLI's own retry policy on 429 is its own
(it may retry a few times; each retry is refused before the provider).

**Untestable here.** A real provider and real prices (no real key, no network
by design — the price table was read from the vendor pages, the usage shapes
are the documented ones); Gemini CLI (not installed); a live tab. Covered by
unit tests: price lookup and normalization, every token kind, fast/US
multipliers, long-context tiers, scheduled Gemini raises, unknown-model
fallback; the scanner over every two-way split, sampled three-way splits and
byte-by-byte for Anthropic SSE and JSON, Gemini SSE, pretty JSON arrays and
single answers, decoy `usage` keys in tool input and text, cumulative
counts, broken-off streams, error answers, oversized and deeply nested
answers; ledger round-trip, older/newer files, model-name bounds, rollover
(and clock going back, year boundary, missing month), throttled and explicit
flush, a corrupt file moved aside; end to end through the proxy: a streamed
answer charged (unknown model flagged), count_tokens free, refusal at the
limit in both providers' shapes before the provider sees anything, refusal
without a limit; the status JSON; UI vitest for the required limit, the
written-limit-first order, spent/limit, budget reached, reset date, unknown
models, Set limit, no-limit, the logins row and the phone's label.

## C3 review notes (2026-10-04)

Reviewed bf640037/e6724c2c/234d39f5. Fixed:

- **Hanging up was free.** Only what the provider had reported was charged,
  so a token holder could stream an answer (or let it think — summarized and
  omitted thinking stream little or nothing) and close the socket just before
  Anthropic's `message_delta`: charged `message_start`'s input and *one*
  output token. Leaving before the answer began (a non-streaming turn waits
  for its whole answer; the handler future is dropped then) charged nothing
  at all, and a usage object larger than 16 KiB was dropped silently. The
  provider bills what it generated either way, so all of these spent past the
  limit without bound. Now an answer that did not deliver its final count —
  Anthropic without a root-level usage (`message_delta` / a whole message), a
  Gemini stream that did not end cleanly, a request the client left before
  its answer (`Pending` guard in `handle`, from the send on; only a connect
  error, where nothing reached the provider, stays free), an unreadable usage
  object (too large, cut by an SSE line break, unparseable — `Found::Lost`) —
  is charged an estimate on top of what it reported (`api_meter::End`):
  output = elapsed time × `ANTHROPIC_TOKENS_PER_SEC` (300) /
  `GEMINI_TOKENS_PER_SEC` (600), above any current model of the provider,
  capped by the request's `max_tokens` (Anthropic; a body that does not parse
  or repeats the field gets 128,000) or Gemini's 65,536 + 32,768 (Gemini's
  own fields are not trusted: it also reads snake_case names); input not yet
  reported = body bytes / 3 up to a context window; the request's `model`,
  `speed: "fast"` and `inference_geo: "us"` apply when the answer said
  nothing. A turn the user cancels with Esc now costs a little more here than
  on the provider's bill — the intended direction; help, docs, QA box and
  the untested row say so. Error answers stay free.
- **Two models in one answer** (a server-side fallback) were priced at the
  last one named; now at the dearer (`api_prices::output_rate`).
- **`accept-encoding: identity`** is now sent upstream: with no header at
  all a server may pick any coding, and compressed bytes would have hidden
  the usage (now they would at least be estimated).
- **The limit is checked again after the body is read** (up to 60 s), not
  only before.
- **Settings re-read**: a same-size write within the mtime's resolution was
  never seen; the cached limits are now re-read at least every 10 s
  (`LIMITS_FRESH`).
- **Charges after the exit flush** (an answer cut off by the quit drops its
  tap after `stop_for_exit`'s drain) went to a 5 s flush thread the exit
  outruns; after `flush_for_exit` a charge is written at once (`closing`).
- **An unreadable ledger** (EACCES, I/O) was left in place and replaced by
  the next write, losing its counts; it is now moved aside like a corrupt one.
- **Overflow**: token sums in `api_prices` and `Ledger::add` saturate (a
  debug build could panic inside the tap's `Drop` on absurd counts).
- **UI**: the limit field took `min=1 step=1` while 0.5 or 7.5 are valid
  limits; now `min=0.01 step="any"`, as `parseApiLimit` accepts.
- Tests (14): early hang-up charged by time up to `max_tokens` and a final
  count never estimated over; a request left before its answer (input from
  the body, request model, fast mode, context-window cap, unknown model at
  the top rate); repeated/odd `max_tokens` → largest cap; error answers free
  however they end; oversized and line-broken usage objects unsettled; model
  text forging an SSE `message_delta` with a huge count (never read);
  tool input nested 3× past the tracked depth with `usage`/`model` keys at
  every level, repeated root `usage` keys (per-field max); a fallback's two
  models; Gemini cut during silent thinking and after chunks; escaped or
  overlong model ids not taken; the proxy end to end for a hang-up after
  `message_start` and a client that leaves before the answer; immediate write
  after the exit flush; saturating ledger counts.

Checked, no change:

- **Scanner**: escapes (incl. `\\` before a quote) and strings across any
  split; JSON escapes every raw line break, so model text cannot end an SSE
  line or open structure; keys are classified only at the tracked levels;
  deeper nesting is counted, not stored; memory per answer bounded (64
  frames, 128-byte string window, 16 KiB capture); no index or arithmetic
  that can panic. "Largest value per field" fits both APIs (Anthropic
  `message_delta` repeats cumulative output, and input/cache when server
  tools change them; Gemini chunks carry running totals). A non-SSE JSON
  answer (and Gemini's JSON array) is read. A `usage` object holds no
  model-written strings, so 16 KiB is ample (now fail-closed if not).
- **Routes**: `billing` and `path_allowed` agree exactly (Anthropic
  `POST /v1/messages`; Gemini `POST models/<m>:{generate,streamGenerate}Content`,
  `{embed,batchEmbed}Contents`, exact-case verbs; everything else either free
  by nature — `count_tokens`, `countTokens`, model reads — or refused by the
  allowlist); a verb like `countTokens:generateContent` is refused by both.
  No billable call can travel a free route.
- **Prices**: Anthropic rows match the skill's cached table (Opus 5.5
  $4/$20, cache read $0.20; Opus 5/4.x $5/$25; Sonnet 5.x $2/$10; Sonnet 4.x
  $3/$15; Haiku 4.5 $1/$5; Fable 5.1 cache read $0.25, Fable 5 $1.00); 5m/1h
  writes are 1.25×/2× input throughout; fast mode 2× matches $8/$40 and
  $10/$50; `usage.speed` / `usage.inference_geo` are the documented report
  fields. Gemini 2.5 rows (Pro $1.25/$10, long $2.50/$15; Flash $0.30/$2.50,
  audio $1; Flash-Lite $0.10/$0.40) consistent with the dated comment.
  `normalize` strips only decorations and numeric version tails and then
  needs an exact table match, so no id can land on another family's row;
  the only attacker-chosen id is Gemini's path model, used only when the
  answer names no `modelVersion` — and then it is the model that ran.
  Unknown → per-kind maximum over current chat models.
- **Ledger**: one mutex, atomic write through a same-directory
  `NamedTempFile` (0600) and rename; UTC month; a ledger month ahead of the
  clock is kept; roll-over keeps last month's totals. Settings and ledger
  live in `<state_dir>`, which the Linux fence replaces with a tmpfs
  (`mask_private_state`, only Tabtivity's own support mounts restored, none
  of them these files); on macOS the state dir is not in the Seatbelt
  profile's writable list (read, not compiled here). No fenced agent can
  reset its spend or raise its limit there.
- **Enforcement**: the verdict comes before the body read for every billed
  route; a missing, invalid or unreadable limit is `noLimit` → refused.
- **UI/phone**: Save is disabled without a valid limit and the limit is
  written (awaited) before the key; the backend refuses a key without one;
  the key draft is cleared at once and never echoed; all ten keys are in
  `en` and the four dicts; `settings.agentApiKeys.limit` and
  `mobile.signIn.apiBudgetReached` are literal ids with register rows; the
  phone gets a bare `api_budget_reached` flag — no amount, provider or key.

Not fixed, with reason:

- **Concurrent turns overshoot.** Every billed request that starts while
  the month is under its limit runs to its end; N tabs can overshoot by N
  turns (and the estimate makes aborted ones count, not free). A reservation
  per request in flight would need a cost bound before the answer — the
  estimate's cap is `max_tokens` × output rate, up to several dollars per
  request, which would refuse ordinary turns near the limit. Documented in
  the UI and help, as before.
- **The rate bound is an assumption**: a future model faster than 300
  (Anthropic) / 600 (Gemini) tokens per second, cut before its final count,
  would be under-counted; a complete answer is always charged as reported.
- **A corrupt or unreadable ledger restarts the month at zero** (moved
  aside, shown in Manage CLIs). Only Tabtivity writes the file; failing
  closed (refusing until the user acts) would punish a disk error, and the
  provider-side limit the help recommends is the backstop.
- **Windows** has no fence: an agent there runs as the user and can write
  `settings.json` and the ledger. Out of C3's reach; the provider-side limit
  is the guard there.
- **Lint**: `npm run lint` reports 31 warnings, all in files neither C3 nor
  this review touched (the same tree's pre-existing state).
