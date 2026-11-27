# Several API keys and providers for OpenCode, switched in its model picker — plan

Status: Phase 1 (custom endpoint) being implemented by subagents on branch
`opencode-custom-endpoint` (2026-11-26). Phase 2 is the rest of this plan,
which stays plan only. Handoff: `docs/opencode_api_keys_handoff.md`.

## Phase 1 — custom endpoint first (user decision 2026-11-26)

The user's first need: an **institute API key** (an OpenAI-compatible
endpoint) usable in OpenCode, simple to set up in Tabtivity. They chose to
put it through the proxy: the key stays in the keychain, a monthly token limit
applies, and the endpoint shows in OpenCode's `/model`. Phase 1 builds only
the `custom` kind below. Several keys per built-in provider and the named new
providers are Phase 2.

### Phase 1 fixed decisions (reviewers may not undo these)

1. **`Provider::Custom(u8)`.** Slot `n` runs `1..=MAX_CUSTOM` (`MAX_CUSTOM =
   8`), and its id is `custom-<n>`, taken from a static `[&str; 8]` array, so
   `Provider::id()` stays `&'static str` and `Provider` stays `Copy + Hash +
   Eq`. `Provider::from_id` parses those ids. `Provider::ALL` stays the three
   built-ins. Add `Provider::configured()`: the built-ins plus every custom
   slot in settings. Use it where the status panel, ledger or limits list
   providers. Anything server/admin (`server::agent_keys`, `keys_wire`) never
   sees a custom slot.
2. **Settings.** `Settings::agent_api_custom_endpoints:
   Option<Vec<CustomEndpoint>>`, where `CustomEndpoint { slot: u8, label:
   String, base_url: String, models: Vec<String> }`. It is optional and absent
   when unset, with a round-trip test. The secret is in the keychain under
   `agent-key:custom-<n>` through the existing `set_key`/`get_key`. The limit
   is in `agent_api_token_limits["custom-<n>"]`, required at save as for the
   others. The ledger is under `providers["custom-<n>"]`. A removed slot's
   number is not reused within the same month while its ledger entry holds
   use.
3. **Base URL validation** (at save and again at every use): `https://host[:port][/path]`,
   or `http://` only to `127.0.0.1`, `localhost` or `[::1]`. No userinfo, no
   query, no fragment. The path is kept with any trailing `/` trimmed (for
   example `https://llm.example.org/v1`). Every hostname in tests is
   `example.org`/`example.com`. Never put a real institution host anywhere
   (privacy check).
4. **Proxy.** Prefix `/custom-<n>/…`. The upstream is the slot's `base_url`
   read from settings, so `Upstream::Provider.base(Custom(n))` returns it, and
   `None` (refuse `NoKey`/`NotFound`) when the slot is gone. The key goes in
   `Authorization: Bearer`. `path_allowed`: `POST /chat/completions`, `GET
   /models`, nothing else. No query parameters are forwarded. Redirects are
   still never followed. The module doc's "one fixed host per provider" is
   reworded: the built-ins have a fixed host, and a custom slot has the
   host the user typed in Manage CLIs (settings live in the masked state dir,
   so no agent can set one).
5. **Metering (Chat Completions).** `billing(Custom, "POST",
   "/chat/completions")` → `Billing::Usage`. The scanner captures `usage` and
   `model` at the chunk's root. `merge` maps `prompt_tokens` → input,
   `completion_tokens` → output and `prompt_tokens_details.cached_tokens` →
   cache read. It reuses `OpenAiUsage` semantics, because input includes
   cached. `final_usage` = both totals present. **Refused before forwarding**
   (new `Refusal::NoUsage`, message names the fix): a body that does not
   parse, or `"stream": true` without `"stream_options": {"include_usage":
   true}`. Worst case: output = the body's `max_completion_tokens` or
   `max_tokens`, else 32 768; input = `body_bytes / 3` tokens; 1 000 tokens/s
   for the elapsed-time estimate.
6. **Price.** A custom slot has no price table. Its `Charge` carries
   `usd: 0.0` and `known: false`, and the status panel shows "no price" for
   custom slots (a `priced: false` field on `ProviderStatus`). The slot does
   not go into `unknown_models`, which means "priced at the highest rate". The
   token limit is the guard.
7. **Key check and models at save.** Adding a slot calls `GET <base>/models`
   with the key. A 401/403 refuses the save with a message. The `data[].id`
   listing (at most 200 ids, each at most 128 bytes, plain characters) goes
   into `CustomEndpoint.models`. A "Refresh models" command fetches it again.
   An empty listing is allowed (the user can type model ids in Phase 2), but
   the UI warns. There is no network on the spawn path.
8. **OpenCode spawn.** Each custom slot is a route of the `opencode` CLI,
   built at runtime (`CLI_ROUTES` stays for the built-ins). Token variable and
   carrier per slot come from static arrays of 8:
   `app_env!("CUSTOM_ENDPOINT_KEY_<n>")` and
   `app_env!("AGENT_SECRET_CUSTOM_ENDPOINT_KEY_<n>")`. Both go into
   `ENV_VARS`/`CARRIERS`, `tmux_local::SECRET_ENV` and `agent_exec`'s mapping,
   and the existing tests keeping those lists together must still pass. The
   inline config gets `provider["tt-custom-<n>"] = { "npm":
   "@ai-sdk/openai-compatible", "name": <label>, "options": { "baseURL":
   <proxy base>, "apiKey": "{env:<token var>}", "includeUsage": true },
   "models": { <id>: { "name": <id> } … } }`. It is added to
   `enabled_providers`, and `opencode_routed` recognizes it. The token itself
   never enters the config or an argv. A tab gets the slots exactly when it
   gets the built-in keys today: OpenCode switched on in Manage CLIs, or the ＋
   menu's API pick. `keyed`/`keyable_clis`/`ready_clis` count a custom slot
   as a key of OpenCode's. Before writing code, the implementer verifies with
   the installed OpenCode, without a billed request (`opencode debug config`
   and `opencode models` with `OPENCODE_CONFIG_CONTENT` set), that the block
   is accepted and its models are listed. Check whether OpenCode 2's
   `providers` block needs a twin, and record the answer in the handoff.
9. **UI (Manage CLIs → API keys).** A "Custom endpoints" group under the
   provider rows, with an "Add endpoint" form: name, base URL, API key, monthly
   limit (the same limit control as the others). Each slot's row shows its
   label, host, model count, month use, "Refresh models" and "Remove". All text
   goes through i18n. Add an `UntestedTag` row `opencode-custom-endpoint`.
   New commands `agent_api_custom_endpoint_add`/`_remove`/`_refresh_models`,
   `async` over `*_blocking` bodies where they hit the network or keychain,
   with `#[cfg_attr(feature = "desktop", tauri::command)]`. They get a
   `command_class` row `Core` like `agent_api_key_set`, and
   `commandClasses.ts` is regenerated.
10. **Out of Phase 1:** prices for custom models, typed-in model ids,
    Claude/Codex/Gemini on a custom endpoint, the phone (it must still build
    and not break on the new `providers` entries), and the hosted server.

### Phase 1 agent steps

| Agent | Plan items | Main files |
|---|---|---|
| A1 implementer | decisions 1–7 (backend core) | `services/agent/agent_api_keys.rs`, `services/api/api_proxy.rs`, `services/api/api_meter.rs`, `services/api/api_usage.rs`, `schema/settings.rs`, tests |
| R1 reviewer | security review of A1: proxy, URL validation, metering bypass | same |
| A2 implementer | decision 8 (OpenCode spawn, carriers) | `agent_api_keys.rs` (`inject_launch`, `route_opencode`), `tmux_local`, `agent_exec` |
| A3 implementer | decision 9 (commands, UI, i18n, command classes, filemaps) | `commands/agents.rs`, `command_class.rs`, `AgentApiKeysRows.tsx`, `i18n/en.ts`, `untested.ts`, filemaps |
| R2 reviewer | final review of the whole range | all |

Organisation: a coupled chain, run one agent at a time on the one branch
`opencode-custom-endpoint`. Each agent resets its worktree to the branch tip
and commits there green. The main agent lands the branch on develop at the
end.

## Why

Today Tabtivity holds **one key per provider**, for three providers only
(`agent_api_keys::Provider`: Anthropic, Gemini, OpenAI). OpenCode supports
dozens of providers and can switch between them mid-session, but a keyed
OpenCode tab sees exactly those three, one key each. The user wants:

- **several keys**, including more than one for the same provider (for
  example "OpenAI work" and "OpenAI personal");
- **more providers**: OpenRouter, DeepSeek, Mistral, Groq, xAI, and a custom
  OpenAI-compatible endpoint;
- **switching per tab in OpenCode's own `/model` picker**: every saved key is
  its own provider entry there.

## User decisions (2026-11-26)

1. **Both**: named keys for any provider, new providers and custom endpoints
   included.
2. **Switching happens per tab, in OpenCode's model picker.** No Tabtivity-side
   switch per tab. Manage CLIs sets the defaults.
3. **Spend limit, with "prices from models.dev" picked.** This was asked on a
   wrong premise: the question said the limit is in dollars. It is not. The
   limit is in **billed tokens**
   (`Settings::agent_api_token_limits`, `api_usage` module doc), and dollars
   are only the estimate shown beside it. So the decision becomes: every key
   gets its own monthly billed-token limit, required at save as today. That
   works for every provider, because it needs only the `usage` the answer
   reports. The **dollar estimate** for providers outside `api_prices` comes
   from models.dev's per-model `cost`, and a model with no listed cost shows
   "price unknown". A missing price never refuses a request: the token limit
   is the guard. The user confirmed this on the corrected premise
   (2026-11-26).

## Fixed decisions

- **A key is a slot.** `KeySlot { id, kind, label, base_url }`, kept in
  `settings.json` as `agent_api_key_slots` (no secrets). Its secret is in the
  keychain or vault under `agent-key:<slot id>`. `kind` is the wire format
  plus the host: `anthropic`, `gemini`, `openai` (existing), and new
  `openrouter`, `deepseek`, `mistral`, `groq`, `xai`, `custom`.
- **Existing keys migrate in place.** The first slot of a built-in kind has
  `id == kind` (`"openai"`). Its keychain account (`agent-key:openai`), its
  limit key and its ledger entry are unchanged, so no data moves. An absent
  `agent_api_key_slots` means "one slot per built-in kind that has a key
  saved". Later slots get `"<kind>-<n>"`, or `custom-<n>`. An id is never
  reused after its slot is deleted: its ledger month may still hold use.
- **`Provider` becomes `kind` + slot.** The enum stays as the *wire format*
  (`Anthropic`, `Gemini`, `OpenAi`, new `OpenAiChat` for Chat Completions).
  Everything keyed today by `Provider`: grants, the key cache, limits, the
  ledger, `opencode_models`. Each of those is keyed by **slot id** instead.
  `Provider::id()` call sites that mean "which key" move to the slot id.
- **Upstream hosts stay fixed per kind.** Each built-in kind has one
  compiled-in HTTPS host (`upstream_host`). Only `custom` takes a
  user-typed base URL. It is accepted only from Manage CLIs, and
  `settings.json` sits in the masked state dir, so no agent or project can set
  or change it. It must be `https://`, or `http://` to a loopback address. The
  proxy still never follows a redirect. The module doc's claim "one fixed host
  per provider" is reworded to match.
- **Other CLIs keep one key per provider.** Claude, Codex and Gemini use the
  kind's **primary** slot: `agent_api_key_primary` (kind → slot id), default
  the slot whose id equals the kind. Manage CLIs shows a "Used by
  Claude/Codex/Gemini" marker per kind. New kinds are OpenCode-only
  (`CLI_ROUTES`).
- **OpenCode gets every keyed slot.** `route_opencode` writes one provider
  block per slot. A slot whose id is OpenCode's own provider id (`anthropic`,
  `google`, `openai`, `openrouter`, `deepseek`, `mistral`, `groq`, `xai`) gets
  that native block, so OpenCode's catalog models appear. Any other slot gets
  a block under `tt-<slot id>` with `name: <label>`, the kind's `npm` SDK
  package and a `models` map. For a second key of a native kind, the map is
  the kind's catalog models (from models.dev, already cached by
  `opencode_models`). For `custom`, it is the endpoint's `/v1/models` listing.
  Every slot's block goes into `enabled_providers`. The token rides as today:
  `{env:<var>}` naming one carrier **per slot**.
- **The token travels in one variable per slot.** Today there is one
  `ENV_VARS`/`CARRIERS` entry per provider. OpenCode needs N.
  Add a numbered carrier family
  (`<APP>_AGENT_SECRET_OPENCODE_KEY_<n>`, `n` < a fixed `MAX_SLOTS = 16`), so
  `tmux_local::SECRET_ENV` and `agent_exec::targets` stay static lists. The
  inline config names the carrier itself (no plain variable).
- **Chat Completions metering fails closed.** A new `Billing` arm reads
  `usage` from a Chat Completions answer (`prompt_tokens`,
  `completion_tokens`, `prompt_tokens_details.cached_tokens`). A streamed
  request without `stream_options.include_usage: true` is refused with a
  message, like today's `background`/`service_tier` refusals. The inline
  config sets `includeUsage: true` so OpenCode always sends it.
- **A hosted server's admin keys stay as they are** (three built-in kinds,
  one key each). Out of scope.

## Steps

### S0 — verify OpenCode (no code)

Run the real OpenCode 2 binary outside the app (`verify-cli` skill), against
a stub HTTP server, not a billed account. Check:

- a custom provider id with `npm: "@ai-sdk/openai"`, `options.baseURL`,
  a key option naming an environment variable and a `models` map shows in `/model` under its
  `name` and calls `<baseURL>/responses`;
- the same with `@ai-sdk/openai-compatible` and `includeUsage: true` sends
  `stream_options.include_usage` to `/chat/completions`;
- native `openrouter`/`deepseek`/`mistral`/`groq`/`xai` blocks accept a
  `baseURL` override, and the path each one appends;
- whether `enabled_providers` takes the custom ids, and whether the OpenCode 2
  `providers` block needs a twin entry (as `hide_in_picker` does today).

Record the results in this file. Any "no" changes the matching step before
code is written.

### S1 — slots (backend, no behaviour change)

`services::agent_api_keys`: `KeySlot`, `slots()` (with the
implicit migration), `set_slot`/`remove_slot`, `get_key(slot)`, `has_key(slot)`,
`agent_api_key_primary`. `schema/settings.rs`: the two new optional fields,
with round-trip tests (absent stays absent, and an old file reads as before).
Switch the key cache (`api_proxy::keys`), `forget_key`, `opencode_models`
listings and `api_usage` limits/ledger from `Provider` to slot id. The ledger
file format is unchanged, because its map is already keyed by the id string.
Tests: an old settings file plus `agent-key:openai` reads as one `openai`
slot, and its ledger and limit are found.

### S2 — proxy: per-slot routes, new kinds, Chat Completions meter

`api_proxy`: `Grant.slot`, a base path `/<slot id>`, `is_proxy_base` per slot,
`upstream_host(kind)` for the new kinds, the `custom` base URL (validated at
save and again at use), and `path_allowed` for the new kinds
(`/chat/completions`, `/models`). `api_meter`: a `Billing::Usage` arm for Chat
Completions, `worst_case_billed` from the request's `max_tokens` (else the
models.dev output limit, else a fixed cap), and the `include_usage` refusal.
`api_prices`: dollar estimate from models.dev `cost` for the new kinds, with
"price unknown" kept apart in `unknown_models`. Tests extend
`api_proxy/tests.rs` (Upstream::Test) for one slot of each new kind and for
two OpenAI slots charged to separate ledgers.

### S3 — OpenCode spawn

`inject_launch`/`route_opencode`/`opencode_inline_with`: one block per keyed
slot as fixed above, the numbered carriers (`CARRIERS`,
`tmux_local::SECRET_ENV`, `agent_exec` mapping, and a test that keeps them
together), `only_keyed_providers` over the slot ids, `opencode_routed` over
every slot, and `opencode_models` catalog and listing per slot (custom: its
`/models`). Keep today's rule that a provider the user's own inline config
sets wins. Tests are pure over `opencode_inline_with`: two OpenAI slots, one
custom slot, the user's own `openai` block.

### S4 — Manage CLIs UI

`AgentApiKeysRows.tsx`: a list of slots instead of three fixed rows. **Add
key** → kind, label, key, monthly limit (and base URL for custom), plus
rename, remove and "Used by Claude/Codex/Gemini" for kinds with 2+ slots.
Each slot shows its own month and model rows (existing). New commands
`agent_api_key_slot_add`/`_update`/`_remove`
(`#[cfg_attr(feature = "desktop", tauri::command)]`, a `command_class` row
`client`, regenerate `commandClasses.ts`). `agent_api_key_set`/`_clear` keep
working for the built-in ids. i18n keys in `en.ts`. `UntestedTag` row
`opencode-api-slots`. Use the shared menu/dialog scheme (`add-menu` skill)
for the add form.

### S5 — phone status, docs, filemaps

Phone API-key status (A5) lists slots. Update rows in `docs/filemap_backend.md`
(`agent_api_keys.rs`, `opencode_models.rs`, `api_proxy.rs`, `api_meter.rs`)
and `docs/filemap_frontend.md` (`AgentApiKeysRows.tsx`). Add the user help
topic text: one key per row, switch in `/model`, a custom endpoint receives
your key. Update `docs/api_chat_plan.md` decision 1 to point here. Add a QA
item with the 🖐️ per-platform pairs in `todo/group-s-agents.md`.

## Verification

- Gates per AGENTS.md for each step. S2 and S3 touch the daemon build
  (`--no-default-features`) through `agent_api_keys`.
- `npm run backend:stale` after landing; the user restarts the app.
- Click-through for the user (never run live by the agent): Manage CLIs →
  API keys → add a second OpenAI key "work" and an OpenRouter key, with limits.
  Open an OpenCode tab with the API pick, then `/model`: you should see
  "OpenAI", "OpenAI (work)" and "OpenRouter". Send one prompt on each, and each
  slot's month count rises on its own row.

## Open questions

- Should Claude/Codex/Gemini also get a per-tab key choice in the ＋ menu
  later? Not planned.

## Organisation

Coupled chain, one subsystem per step: S1 → S2 → S3 → S4 → S5. S4 depends
only on S1's status shape, so it could run beside S2/S3. The proxy and spawn
steps (S2, S3) are security work, and each gets its own review. Run in the
main loop unless the user asks for the subagent routine.
