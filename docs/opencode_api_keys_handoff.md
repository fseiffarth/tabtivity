# Custom endpoint for OpenCode — agent handoff

Plan: `docs/opencode_api_keys_plan.md`, "Phase 1". Branch `opencode-custom-endpoint`.
Each agent adds its own section below; read the ones above yours first.

## A1 — backend core (decisions 1–7)

Commits on `opencode-custom-endpoint` (on top of `683e61dea`): `daf0df0df` (all of
A1's code and tests), then the commit that adds this sha to the doc.

### What exists now (exact names)

`services::agent_api_keys` (`src-tauri/src/services/agent/agent_api_keys.rs`):

- `Provider::Custom(u8)`; `Provider::custom(slot) -> Option<Provider>` (slot
  `1..=MAX_CUSTOM`, `MAX_CUSTOM = 8`); `Provider::ALL` is still the three
  built-ins; `Provider::SLOTS` / `Provider::index()` (a cell per provider, for
  tables); `.id()` is `custom-<n>` (static), `.account()` is
  `agent-key:custom-<n>`; `.slot()`, `.is_custom()`, `.priced()` (false for a
  custom slot), `.bearer()`, `.opencode_custom_id()` (`tt-custom-<n>`, `None`
  for a built-in); `Provider::from_id` parses exactly `custom-1`..`custom-8`.
- `Provider::configured()` (reads settings) / `Provider::configured_with(&[CustomEndpoint])`:
  the built-ins plus every custom slot in settings.
- `schema::settings::CustomEndpoint { slot, label, base_url, models }` and
  `Settings::agent_api_custom_endpoints: Option<Vec<CustomEndpoint>>` (absent
  when unset, round-trip test in `schema/settings.rs`).
- Reading: `custom_endpoints()` (cached like `api_usage::limit_for`: one `stat`
  per call, re-read when the settings file changed or after 10 s; empty on a
  hosted server), `custom_endpoint(slot)`, `custom_base(slot)` (the saved base
  URL validated again, `None` when the slot is gone or the URL no longer
  validates), `custom_endpoints_in(&Settings)` (pure).
- `validate_base_url(raw) -> Result<String, String>` (decision 3; returns the
  normalised URL without a trailing `/`), `base_url_host(url)`,
  `clean_model_ids(iter)` (<= 200 ids, each 1..=128 bytes of `[A-Za-z0-9._:/@+-]`,
  no duplicates).
- Service API for the commands (A3 wraps these; none is a Tauri command):
  - `async add_custom(label, base_url, key, limit_tokens) -> Result<CustomEndpoint, String>`
    validates the form, calls `api_proxy::custom_check` (GET `<base>/models`
    with the key), then — under the settings file lock — picks the lowest
    slot that is neither configured nor holding ledger use this month, writes
    the endpoint **and** `agent_api_token_limits["custom-<n>"]`, then stores the
    key (`set_key`); if the keychain refuses, the endpoint is taken out again.
    The limit is therefore written by this call: A3 does **not** write
    `agent_api_token_limits` for a custom slot before it. The returned endpoint's
    `models` may be empty (the UI warns).
  - `async refresh_custom(slot) -> Result<CustomEndpoint, String>`: stored key
    against the saved base, keeps the new listing. A refused key or an
    unreachable endpoint changes nothing.
  - `remove_custom(slot) -> Result<(), String>` (sync, blocking: keychain):
    key first (a locked keyring refuses and nothing changes), then endpoint and
    limit. The ledger row stays for the month.
  - `custom_draft(label, base_url, limit) -> Result<CustomDraft, String>`:
    just the form validation (no network, no save), if the UI wants to check
    before asking for the key.
  - `set_key(Provider::Custom(n), Some(key), None)` also works to **replace** the
    key of an existing slot (refuses a slot with no endpoint, and a workspace);
    `agent_api_key_set`/`agent_api_key_clear` on `custom-<n>` therefore work
    through `api_key_provider` (`from_id`) and `api_proxy::check_key`, which
    checks a custom slot's key against its saved endpoint. `agent_api_key_clear`
    on a custom slot only drops the key, not the endpoint: use `remove_custom`.
- Status: `status()` / `ProviderStatus` now has `priced: bool` (false for a custom
  slot: show "no price") and `endpoint: Option<EndpointStatus { slot, label,
  baseUrl, host, modelCount }>` (absent for a built-in; serde camelCase,
  `endpoint` omitted when none). The provider list is
  `Provider::configured_with(settings endpoints)`: the three built-ins, then the
  custom slots by settings order sorted by slot. `spent_usd` is 0 for a custom
  slot and `unknown_models` is empty for it.
  **`CliStatus.providers` (the CLI rows) still lists the built-ins only: A2 adds the
  custom slots to OpenCode's.**

`services::api_proxy`:

- Route prefix `/custom-<n>/…`; `base_url(Provider::Custom(n))` is
  `http://127.0.0.1:<port>/custom-<n>`; `is_proxy_base` handles it. The
  OpenCode `baseURL` for a slot is exactly that URL (no `/v1`: the proxy path
  below it is `/chat/completions`, `/models`).
- `issue(Provider::Custom(n), None, scope, tab, tmux)` hands out a token only
  when the proxy runs, a key is saved **and** the slot's endpoint exists and
  validates; it refuses an `admin` grant for a custom slot. So A2's spawn
  wiring can call it per slot like for the built-ins and gets `None` for a
  slot that is not usable.
- `Upstream::Provider.base(provider) -> Option<String>` (was `String`); a custom
  slot's is `custom_base(n)`. `upstream_host(provider) -> Option<&'static str>`.
- `check_key(Custom(n), ..)` → checks against the saved endpoint; `key_models(Custom)`
  → `None` (a custom slot's models live in settings, not OpenCode's picker
  cache); `custom_check(base_url, key) -> Result<Vec<String>, String>` (async,
  validates the URL and key shape first; 20 s; 2 MiB cap; Bearer; no redirect;
  plain http only to loopback).
- Request path: `Authorization: Bearer <key>`; `POST /chat/completions` and
  `GET /models` only; no query is forwarded; a removed slot / URL that no
  longer validates → `Refusal::NoEndpoint` (404, before the key is read); a
  body that is not one JSON object, or `"stream": true` without
  `stream_options.include_usage: true` → `Refusal::NoUsage` (400). Errors are
  in OpenAI's shape. Plain `http://` (loopback only) uses the loopback client.
- `api_meter`: `billing(Custom, "POST", "/chat/completions")`, Chat Completions
  scanner/merge, `custom_refusal`, `CUSTOM_MAX_OUTPUT = 32_768`, 1 000 tokens/s,
  input `body_bytes / 3` (capped at `api_prices::CUSTOM_WINDOW`);
  `api_prices::price_custom` → `usd: 0.0`, `known: false`.
- `api_usage`: reservation cells per slot (`Provider::SLOTS`), `Ledger::add`
  never marks a custom model `unknown`; limits (`limits_in`/`limit_for`) already
  accept `custom-<n>` through `from_id`.

Arms left conservative for A2 (marked `// A2:` in the code): `opencode_provider`
(`tt-custom-<n>`, empty path suffix), `opencode_models::opencode_id` / `extra` /
`listed_ids`. `CLI_ROUTES`, `ENV_VARS`, `CARRIERS`, `route_opencode`,
`opencode_routed`, `keyed`/`keyable_clis`/`ready_clis` do not know custom slots yet.
`Provider::credential_names()` is empty for a custom slot (so `credential_names()`
free fn, `Route::user_names`, are unchanged).

### Choices made inside the fixed decisions

- The slot a new endpoint gets is chosen inside the settings write (under the
  file lock) from "not configured and not holding ledger use": a removed slot's
  number returns next month (the ledger row is rolled away).
- A listing answer that is HTTP 404/405/501 is accepted as an **empty** listing
  (an endpoint that has no `/models`, the key cannot be checked); 401/403 refuse;
  any other non-2xx, an unreachable host and a 2xx that is not an OpenAI-style
  `{"data":[{"id":..}]}` listing refuse with a message (a wrong base path mostly
  shows as one of these, or as the empty listing for 404 — the UI warns on empty).
- Base URL: besides the decision-3 rules, the typed address may not hold `\`, `%`
  or a `.`/`..` segment, every path segment is `[A-Za-z0-9._~-]`, 512 bytes at
  most; `https` is allowed to any host (also private IPs); `http` only to the
  literal `127.0.0.1`, `[::1]` and `localhost`.
- Max request-side bound: `max_tokens` and `max_completion_tokens` both read,
  the larger bounds the worst case; neither → 32 768.
- A custom slot never has input "by reference" held at a context window
  (`names_input_by_reference` is skipped for it): an unknown window is not a
  reason to refuse small limits.
- Server: `custom_endpoints()` is empty on a hosted server and `add_custom` /
  `remove_custom` / `refresh_custom` refuse there; the keeper/broker paths never
  see a custom provider (`Grant.admin` + custom is refused in `issue`).
- Label: 1..=48 characters, no control characters (A3 may show the host beside it).

### Gotchas for the next agents

- `Provider` is no longer `ALL`-complete: iterate `Provider::configured()` where
  a custom slot matters, `Provider::ALL` where only the built-ins do
  (`credential_names()`, the models.dev catalog).
- `ProviderStatus` has two new fields (`priced`, optional `endpoint`);
  the TS type (`src/types`) and `AgentApiKeysRows.tsx` are A3's.
- `Settings` TS type needs `agent_api_custom_endpoints?: CustomEndpoint[]`
  (A3). A frontend whole-`updateSettings` must not clobber it: it round-trips
  through the Rust `Settings`, but the frontend store type should list it.
- Settings writes of the endpoint list use `patch_json` under the file lock and
  bump `rev`; after a write call nothing yourself — `forget_endpoints` is
  private and run by the service functions (a hand edit of `settings.json` is
  seen within 10 s or at once on a changed stamp).
- The proxy never reads the listing in `CustomEndpoint.models`; A2 puts those
  ids in the OpenCode config.
- Tests that touch `custom_endpoints()` would read the developer's real
  settings file: the new tests use pure `*_in`/`*_at` functions with a tempdir.

### Gates (run in the worktree; the last edit after them was a test-only
fixture address rename, `agent_api_keys` tests re-run: 38 passed)

- `cargo test -q -p tabtivity --lib`: 6636 passed, 23 ignored (no flake seen).
- `cargo test -q -p tabtivity --no-default-features --lib --test server_secrets`:
  6428 passed, 20 ignored (2 suites).
- `cargo test -q -p tabtivity --test it`: 144 passed.
- `cargo clippy --workspace --all-targets -- -D warnings`: clean.
- `cargo clippy -p tabtivity --no-default-features --lib -- -D warnings`: clean.
- `cargo clippy -p app-serverd --all-targets -- -D warnings`: clean.
- `scripts/privacy-check.sh` (staged): clean (it flags private-range IPs, even in
  tests: the fixtures use the documentation range `203.0.113.x`).
- `scripts/brand-check.sh`: one hit, **not mine and not in this range**:
  `scripts/verify-cli/opencode/queue.py:26` spells the env-var name in a
  comment. Nothing of A1 spells the app name.
- `git diff --check`: clean. Frontend not touched (no `npm` gate run).
- New tests: settings round-trip (1), providers/ids (2), configured list (1), base URL
  validation (1), model id cleaning (1), draft form (1), add/remove/refresh on a
  temp settings file (3), ledger holds (1), status (1), workspace refusal (1) in
  `agent_api_keys`; reservation cells + custom ledger row (2) in `api_usage`;
  meter: Chat Completions splits/estimate/worst case/refusals/billing (5);
  proxy: route + path allowlist (1), end-to-end through `Upstream::Test`: SSE
  stream charged to `custom-3` with Bearer in and token never out (1), whole
  answer + unmetered listing + paths + wrong-slot token (1), unmeterable bodies
  refused before sending (1), per-slot limit / no limit / worst case / no key
  (1), key refused (1), removed-slot refusals (1), `custom_check` (1).

### Flagged for user (not acted on)

- **Key not checked on a 404/405/501 from `/models`.** An endpoint with no
  listing is accepted with an empty model list (plan decision 7 allows an
  empty listing); the key is then only tried at the first real request. A
  wrong base path (a typo in `/v1`) most often shows as a 404 too, so the UI
  warning for "no models found" matters. Alternative: refuse 404.
- **Billed tokens for a custom endpoint** use the generic billed-token rule
  (cache reads at a tenth). An institute that counts cached tokens in full will
  see the limit run slower than its own bill.
- **`https://` to any host is accepted**, including private IPs and names
  that resolve to them (decision 3 only restricts `http://`). Only the user can
  type one; no agent or project can set it.
- **Model ids with characters outside `[A-Za-z0-9._:/@+-]` are dropped** from
  the saved listing (they could not be chosen in OpenCode's picker either).
- **A request with `"stream": true` but no `stream_options.include_usage`
  is refused (400)** instead of forwarded; A2 must make sure OpenCode's block
  has `includeUsage: true` (decision 8) or every streamed turn fails with that
  message.
- **`agent_api_key_clear` on a custom slot** only drops the key (the endpoint
  stays, "not saved"); the UI's Remove must call `remove_custom`.
- A hand edit of `settings.json` that adds, changes or removes an endpoint
  takes effect within 10 s (or at once when the file stamp changes); a slot
  whose saved URL stops validating is refused (404) at the proxy.

## R1 — security review of A1 (`683e61dea..6a17ef48f`)

Fixed on top of `6a17ef48f`, each with a test that fails without it.

### Confirmed and fixed

- **`n > 1` slipped past the worst-case reservation** (`fa964b4d5`). A Chat
  Completions body asking for `n` answers holds `max_tokens` once, but the
  endpoint generates and bills every choice, so one request could overshoot
  the limit by a factor of `n`. `Meter::request` now reads `n` (a mistyped or
  repeated `n` is refused as unreadable, `null`/`0` mean 1) and the worst
  case and the elapsed-time estimate scale with it (saturating). Test:
  `a_custom_request_asking_for_several_answers_holds_the_cost_of_each`.
- **A settings patch could retarget a saved key** (`f0f57b670`).
  `patch_settings` (class Core, so also a paired browser client) and
  `save_settings` write any `Settings` field, `agent_api_custom_endpoints`
  included: changing a slot's `base_url` sent that slot's real key to the new
  host at the next request, a read primitive that `agent_api_key_set` (write
  only) never gave. Like `git_token`, the list is now the add/remove/refresh
  commands' alone: `patch_settings_at` drops it from a patch and
  `save_settings_at` keeps the file's. Test:
  `a_patch_or_a_save_cannot_retarget_a_custom_endpoint`. The limit
  (`agent_api_token_limits["custom-<n>"]`) stays patchable (a user setting,
  no key movement).

### Checked and rejected (no bug)

- **Base URL validation**: userinfo (`user@`, `user:pw@`), backslash, `%`
  escapes, `.`/`..` segments, empty segments, `https:host`, `https:///host`,
  query/fragment (also empty `?`/`#`), tabs/newlines, `localhost.example.org`,
  trailing-dot `localhost.`, IPv4-mapped IPv6, `0.0.0.0`, `127.0.0.2`,
  IDNA/fullwidth lookalikes (normalised to `localhost` and so really
  loopback), default ports and case are all refused or normalised correctly;
  the URL is rebuilt from the parsed parts, and the plain-HTTP client is
  picked from that rebuilt string.
- **Redirects**: both clients use `Policy::none()`; a 3xx on `/models` at save
  is an error, on a request it is passed back unfollowed. The key is only ever
  put on the request to the validated base.
- **Token reach**: `grant.provider == provider` keeps a token to its slot (and
  from built-ins); `issue` refuses a slot with no valid endpoint or an admin
  grant; removal makes `Upstream::base` return `None` (404) before the key is
  fetched, at once (`forget_endpoints` on every in-process write). No key,
  token or body is logged or put on an argv in this range.
- **Smuggling**: custom paths pass the plain-segment filter, exactly two
  routes; no query is forwarded; agent credential headers are dropped
  (`authorization`, `x-api-key`, ...) and the key header is `insert`ed.
- **Meter**: duplicate/mistyped `stream`, `stream_options`, `max_tokens`
  and `model` refuse as unreadable (serde rejects duplicates and floats);
  non-2xx answers charge nothing; a stream with no final usage is charged the
  estimate; `usage: null` chunks, the `choices: []` final chunk and `[DONE]`
  are read correctly (tests exist); only root-level `usage`/`model` count.
- `final_usage` is assigned, not OR-ed, in `merge`: a `usage: null` chunk
  *after* the final one would reset it and add the estimate on top. Only
  over-charges, no server sends it; left alone.
- A compressed answer (an upstream ignoring `accept-encoding: identity`) is
  read as unparsable and charged the estimate: same as the built-ins.

### Flagged for user (not acted on)

- **System proxy variables and plain-HTTP loopback endpoints.** The
  `loopback` client (and `custom_models_at` for `http://`) is a default
  `reqwest` client, which honours `HTTP_PROXY`/`ALL_PROXY` from the app's
  environment. With one set and no `NO_PROXY` for `127.0.0.1`/`localhost`, a
  `http://localhost:...` custom endpoint's Bearer key would travel in clear to
  that proxy. The built-ins are HTTPS (CONNECT) and unaffected. A
  `.no_proxy()` on the loopback client would close it (the key broker's
  loopback URL too); not done because it cannot be tested without changing the
  process environment, and it changes the broker path.
- **Slot reuse and running tabs.** A removed slot with no use in the ledger
  is free at once; a tab started before still holds a valid `custom-<n>`
  token, and after the user adds another endpoint under that number the old
  tab's requests go to the new endpoint with the new key. Decision 2 only
  protects slots with ledger use. Both endpoints are the user's own.
- **An omitted `max_tokens` is assumed 32 768** (decision 5). An endpoint
  whose own default is larger (some servers default to the model's whole
  window) can bill more than reserved; the answer's reported usage is still
  charged in full, so only the pre-check is loose.
- `https://` to link-local/private addresses is accepted (already flagged by
  A1).

### Gates (after both fixes)

- `cargo test -q -p tabtivity --lib`: 6638 passed, 0 failed, 23 ignored.
- `cargo test -q -p tabtivity --no-default-features --lib --test server_secrets`:
  6429 + 1 passed, 0 failed, 20 ignored.
- `cargo clippy --workspace --all-targets -- -D warnings`, `-p tabtivity
  --no-default-features --lib`, `-p app-serverd --all-targets`: clean (exit 0).
- `scripts/privacy-check.sh`: passes. Frontend untouched.

## A2 — OpenCode spawn (decision 8) and two R1 fixes

Commits on top of `c37bf3203`: `82761cc5e` (all code and tests), then the commit
that adds this section.

### What exists now (exact names, all in `agent_api_keys.rs` unless noted)

- **Static arrays of 8**: `CUSTOM_TOKEN_ENV` (pub; `CUSTOM_ENDPOINT_KEY_<n>`),
  `CUSTOM_CARRIER` (pub; `app_env!("AGENT_SECRET_CUSTOM_ENDPOINT_KEY_<n>")`),
  `CUSTOM_BASE_ENV` (private; `app_env!("CUSTOM_ENDPOINT_BASE_<n>")`, the
  per-slot base var). `ENV_VARS`/`CARRIERS` are now 3 + 8 long, index for index
  (so `agent_exec::targets()` maps a custom carrier with no change of its own);
  `tmux_local::SECRET_ENV` has the eight carriers appended (slots 8645-8652,
  23 entries; `key_carriers_hold_the_slots_after_the_mcp_tokens` updated).
- **Routes.** `CLI_ROUTES` is unchanged (the built-ins). `CUSTOM_ROUTES: [Route; 8]`
  (const `custom_route(i)`) and `routes_with(cli_id, &[CustomEndpoint]) ->
  Vec<Route>`: the built-ins' routes plus, for `opencode` only, one route per
  *configured* slot (so an unconfigured slot never costs a grant or a keychain
  read). `spawn_endpoints(&Settings)` = the endpoints of the settings, none on a
  hosted server.
- **Spawn.** `inject_env_at(.., endpoints)` is the new pure core
  (`inject_env_with` is now a `#[cfg(test)]` wrapper with `&[]`, so every
  built-in test is unchanged); `inject_env` passes `spawn_endpoints`. Custom
  routes get `api_proxy::issue(Custom(n), ..)`, which already returns `None`
  without a key or a valid endpoint. `route_opencode_with(env, injected,
  ambient, picker, endpoints)` is the core (`route_opencode` is a `#[cfg(test)]`
  wrapper with `&[]`); `opencode_inline_with(.., endpoints)` builds the block
  with `custom_block(endpoint, token_var, base)`. The per-slot base var is
  removed from `env` again in `route_opencode_with` (it only names the route).
- **Inline block** (exactly decision 8): `provider["tt-custom-<n>"] = {npm:
  "@ai-sdk/openai-compatible", name: <label>, options: {baseURL:
  "<proxy base>/custom-<n>" (no `/v1`), the key field = `{env:CUSTOM_ENDPOINT_KEY_<n>}`,
  includeUsage: true}, models: {<id>: {name: <id>}}}`. `enabled_providers`
  gets `tt-custom-<n>` (built-ins first, then slots by number, then `ollama`).
  A user config that already has a block of that name (in `provider` or in
  OpenCode 2's `providers`) keeps it: the slot is left out and its token,
  carrier and base var are removed again (like a built-in); it still counts in
  `enabled_providers` (it is theirs). No `providers` twin and no
  `hide_in_picker` for a custom slot.
- `opencode_routed` also tests the eight `tt-custom-<n>` blocks (path suffix `""`,
  `is_proxy_base(.., Custom(n))`), so `launch_prep::drop_api_keys_for_old_tmux`
  refuses a custom-only route on tmux < 3.2 too.
- **Counting as a key of OpenCode's**: `keyed`, `refuse_in_container`,
  `ready_clis`/`keyable_clis` (`ready_clis_with(enabled, endpoints, has)`),
  `budget_blocked_with(ready, endpoints, limits, ledger)` and `status_with` all
  use `routes_with(id, endpoints)`.
- **`CliStatus.providers` for OpenCode** is now `["anthropic","gemini","openai",
  "custom-<n>"..]` for every configured slot (slot order); `ready` is true when a
  slot's key is saved. Other CLIs' rows are unchanged. `status()` passes
  `spawn_endpoints`, so on a hosted server none appear.
- `opencode_models`: `hidden_for`, `extra_for` and `refresh` drop custom providers
  at the top (nothing hidden, nothing fetched, no background refresh started for
  a slot); both `// A2:` notes resolved.

### The two R1 fixes

1. **Stale tokens after slot reuse.** `api_proxy::revoke_provider(provider)`
   drops every grant of a provider at once. `remove_custom` now goes through
   `remove_custom_in(path, slot, clear_key)`, which revokes right after the key
   is cleared (a refused key removal changes nothing, grants included).
   `add_custom_blocking` revokes the new slot's number before saving its key and
   again if the keychain refuses (covers a hand edit of `settings.json` that
   dropped a slot under a running tab). Tests:
   `removing_a_custom_slot_revokes_its_grants_and_only_its_grants`
   (`agent_api_keys`) and `revoking_a_provider_takes_only_its_grants`
   (`api_proxy`). Grants are one process-wide map shared by parallel tests: these
   tests use slots 6/7/8 (nothing else holds grants there) - keep it that way.
2. **System proxy leak.** `api_proxy::client_builder(https_only)`: the plain-HTTP
   (loopback) client, used for a `http://` loopback custom endpoint and the key
   broker, is built with `.no_proxy()`. Test
   `the_loopback_client_ignores_a_system_proxy_and_the_https_one_keeps_it`: a
   built `reqwest::Client` prints `proxies` in `Debug` only when it holds some,
   and one that honours the environment always holds the system matcher, so no
   env var is touched. The HTTPS client is unchanged (see "Flagged for user").

### OpenCode verification (2.4.2, real binary, no billed request)

Binary `~/.local/share/tabtivity/agents/install/.opencode/bin/opencode`
(`opencode --version` -> `opencode v2.4.2`; the `opencode` on PATH is
Tabtivity's agent shim, which execs the app binary, so it was not used). Run
with `env -i`, throwaway `HOME`/`XDG_*` dirs under the worktree (deleted
afterwards), a dummy env var, and `OPENCODE_CONFIG_CONTENT` = the block above
with `baseURL http://127.0.0.1:9/custom-1` and two models.

- `opencode debug config`: accepted. OpenCode 2 converts the legacy block into
  its own `providers["tt-custom-1"]` (`package: "aisdk:@ai-sdk/openai-compatible"`,
  `settings` with apiKey (masked as stars), baseURL, includeUsage: true, both models) and
  `enabled_providers` became the policies `deny provider.use *` + `allow
  tt-custom-1`. **No twin in `providers` is needed.** (The built-ins' twin in
  `hide_in_picker` exists to carry a model `disabled` list, or a block the user
  already has in `providers`; a custom block hides nothing.)
- `opencode models`: `tt-custom-1/llama-3.3-70b` and `tt-custom-1/qwen3-32b`,
  nothing else (the policy hides every other provider).
- `includeUsage` is the right option name: `opencode run --standalone -m
  tt-custom-1/llama-3.3-70b "say ok"` against a local fake server on
  `127.0.0.1` (dummy value, nothing billed) sent `POST /custom-1/chat/completions`
  with `Authorization: Bearer <the env var's value>`, `"stream": true` and
  `"stream_options": {"include_usage": true}` (a title request without
  `max_tokens`; the chat turn with `max_completion_tokens: 32000`, which the
  meter's worst case reads). So the proxy's `NoUsage` refusal is not hit by
  OpenCode's own requests.
- Gotcha: a bare `opencode models`/`debug config` starts a **background service**
  (`opencode serve --service`) that outlives the command; use `--standalone` where
  the command takes it. I stopped the one I started (it ran in the throwaway
  HOME). No OpenCode, fake server or Tabtivity process of mine is left.

### Choices inside the fixed decisions

- **The token variable is not app-named.** The plan wrote
  `app_env!("CUSTOM_ENDPOINT_KEY_<n>")` for it, but `agent_exec` maps a carrier to
  the name *after* `CARRIER_PREFIX`, and the existing test holds `carrier ==
  carrier_name(var)`. So the carrier is `app_env!("AGENT_SECRET_CUSTOM_ENDPOINT_KEY_<n>")`
  as planned and the variable OpenCode reads is the plain
  `CUSTOM_ENDPOINT_KEY_<n>` (like `OPENAI_API_KEY` for the built-ins). Only the
  carrier is a tmux secret.
- A custom route is shadowed by no credential name (`credential_names()` is empty);
  only its own base var in the spawn env or Tabtivity's counts as "user set".
- A user's block is a conflict by name alone (any `provider` or `providers`
  entry `tt-custom-<n>`), stricter than the built-ins' "has a baseURL/apiKey" rule:
  a custom block without a base URL is not usable anyway.
- A slot with a saved key but an unusable endpoint gets no token (`issue` -> None);
  it is not in `injected`, so no block is written for it.
- Models: the saved `CustomEndpoint.models`, each as `{name: id}`; an empty
  listing writes `models: {}` (the provider is enabled but lists nothing).

### Gotchas for A3 and later

- `CliStatus.providers` of OpenCode lists `custom-<n>` ids; the TS consumer must
  not assume the three built-ins.
- Old tests keep calling `inject_env_with`/`route_opencode` (built-ins only); new
  tests use `inject_env_at`/`route_opencode_with` with `&[CustomEndpoint]`.
- `ENV_VARS`/`CARRIERS` grew by 8: anything that iterates them (the tmux
  `update-environment` slots, `agent_exec::targets`) sees the custom ones.
- The post-commit hook reports the embedded mobile PWA as stale; this change
  does not touch it.

### Gates (worktree, last code edit before them)

- `cargo test -q -p tabtivity --lib`: 6648 passed, 23 ignored with `--test-threads=6`.
  A default-threads run had one failure in `sysstat::tests::relaxed_lookup_reuses_an_entry_the_default_would_recompute`
  (load flake, unrelated: passes alone and under `--test-threads=6`).
- `cargo test -q -p tabtivity --no-default-features --lib --test server_secrets`:
  6440 passed, 20 ignored (2 suites).
- `cargo test -q --workspace -- --test-threads=6`: 7083 passed, 23 ignored (13 suites).
- `cargo clippy --workspace --all-targets -- -D warnings`, `-p tabtivity
  --no-default-features --lib`, `-p app-serverd --all-targets`: no issues.
- `scripts/brand-check.sh`: only the old hit in `scripts/verify-cli/opencode/queue.py:26`.
- `scripts/privacy-check.sh` (staged): clean. `git diff --check`: clean. Frontend untouched.
- New tests: 8 in `agent_api_keys` (alone, beside a built-in, user's own block,
  routes only when configured, `opencode_routed` custom-only, carriers in step,
  status/ready/budget, remove revokes) + 2 in `api_proxy` (revoke, loopback client).

### Flagged for user (not acted on)

- **The main HTTPS client honours `HTTPS_PROXY`/`ALL_PROXY`** (it is the built-ins'
  client too). For an `https://` custom endpoint the key rides a CONNECT tunnel
  inside TLS to the endpoint, so the proxy cannot read it, but it learns the
  host, and an institute endpoint on an internal name is sent *through* the
  system proxy unless `NO_PROXY` lists it (it can then fail to connect, or reach a
  gateway that terminates TLS for you). A per-slot "ignore system proxy" choice
  would be the fix; left alone because some networks need the proxy.
- **A hand edit of `settings.json` that drops or retargets a slot** does not revoke
  its grants by itself (only the add/remove commands do): the proxy refuses a
  dropped slot at once (404, before any key is read), but a slot re-added by hand
  under the same number inside the 10 s settings cache keeps the old tab's token
  until the next `add_custom`/`remove_custom` for it.
- Slot grants are keyed by provider only: `revoke_provider` ends them for every tab,
  which is what a removal wants.

## A3 — commands, UI, i18n, docs (decision 9)

Commits on top of `72535df49`: `af0a13b75` (all code, tests, i18n, docs), then the
commit that adds this section.

### What exists now

- **Commands** (`commands/agents.rs`, `#[cfg_attr(feature = "desktop", tauri::command)]`,
  registered in `lib.rs`, class `Core` in `services::command_class`,
  `commandClasses.ts` regenerated):
  `agent_api_custom_endpoint_add { label, baseUrl, key, limitTokens }` (`async`,
  straight over `agent_api_keys::add_custom`, which does its own network and
  `try_blocking`), `agent_api_custom_endpoint_remove { slot }` (`async` over
  `try_blocking(remove_custom)`: keychain), `agent_api_custom_endpoint_refresh_models
  { slot }` (`async` over `refresh_custom`). Add and refresh answer with the saved
  `CustomEndpoint` (snake_case, as the Rust struct serialises; the UI ignores it and
  re-reads the status).
- **`agent_api_key_clear` on a custom slot refuses** (chose refuse over routing to
  `remove_custom`: a silent endpoint delete from a "clear key" call is a surprise):
  "a custom endpoint's key is removed together with the endpoint: use Remove
  endpoint". Test `clearing_the_key_of_a_custom_endpoint_is_refused_and_points_at_remove`.
  `agent_api_key_set` on a custom slot still works (replaces the key); the UI does
  not offer that.
- **Types**: `src/types/index.ts` has `CustomEndpoint` and
  `Settings.agent_api_custom_endpoints?`. The status payload type moved out of
  `AgentApiKeysRows.tsx` into `settings/agentApiKeysShared.ts` (`AgentApiKeyStatus`,
  `ApiProviderStatus` with `priced`/`endpoint`, `ApiEndpointStatus`, `parseApiLimit`,
  `asMillions`, `tokenCount`, `usd`, `DEFAULT_API_LIMIT_MTOK`, `apiProviderName`) so
  the two row files do not import each other.
- **UI**: `settings/AgentCustomEndpointsRows.tsx`, rendered by `AgentApiKeysRows`
  under the built-in rows (the built-in loop now skips providers that carry an
  `endpoint`). Inline add form (name, base URL with `https://llm.example.org/v1`
  placeholder, password field, limit in M tokens, default 5), per-slot row: label,
  state (saved / not saved / locked), host, "Models: n", "no price", billed tokens of
  the limit (no dollar figure), limit field + Set limit (an ordinary
  `agent_api_token_limits` settings write, as for built-ins), Refresh models, Remove
  (asks through `useDialogs().confirmAction`, `danger`), per-model usage lines
  without `≈ $`, and the 0-model warning (host named, missing `/v1` hint). Help in a
  fold. Hidden on a hosted server (`store === "vault"`: the service refuses there).
  The Add form is gone at 8 slots. The key field is cleared the moment Add is
  pressed. The `UntestedTag` row is `opencode-custom-endpoint`.
- **CLI rows** name a `custom-<n>` provider by the slot's label
  (`apiProviderName`), e.g. "my API key (Anthropic, Institute API)".
- **i18n**: 16 `settings.agentCustom*` keys in en/de/es/fr/it (the repo's
  `every language covers every English key` test requires all five; the first full
  vitest run caught it). German/Spanish/French/Italian are mine, not a native
  review.
- **Phone**: `npm run build` includes `mobile:build` and `web:bundle`, both green.
  The phone never reads the provider list (only the keyable/ready flags), so the new
  `custom-<n>` entries cannot crash it; no phone UI added.
- **Docs**: help topic `docs/help/agent-clis.md` ("Custom endpoint (OpenCode)"
  paragraph after the monthly-limit one), rows of `docs/filemap_frontend.md`
  (the settings row) and `docs/filemap_backend.md` (`commands/agents.rs`). The
  backend filemap rows for `agent_api_keys.rs`/`api_proxy.rs` still do not mention
  the custom slots (A1/A2 did not touch them; I did not rewrite them).

### Gotchas

- A custom slot's limit is written by `add_custom`; the UI therefore does **not**
  write `agent_api_token_limits` before Add (unlike a built-in's Save). A later
  limit change goes through `updateSettings`, which R1's patch rule leaves alone.
- `updateSettings` in the frontend must never be given `agent_api_custom_endpoints`
  (the backend drops it from a patch and keeps the file's on a save); the field is in
  the TS type only so the store type matches the file.
- `status.providers` now carries custom entries with `endpoint`; any other consumer
  that maps `providers` by id must filter or use `apiProviderName`.

### Gates (worktree, after the last code edit)

- `npm run build`: clean (tsc, desktop, mobile, web bundles).
- `npm test -- --reporter=dot`: 1319 files, 13894 tests passed (full suite; 9 of them
  are the new `AgentCustomEndpoints.test.tsx`).
- `npm run lint`: 0 errors, 31 warnings, none in a file I touched.
- `cargo test -q -p tabtivity --lib`: 6649 passed, 23 ignored (no flake).
- `cargo test -q -p tabtivity --no-default-features --lib --test server_secrets`:
  6440 + 1 passed, 20 ignored.
- Clippy `--workspace --all-targets`, `-p tabtivity --no-default-features --lib`,
  `-p app-serverd --all-targets`: clean.
- `scripts/brand-check.sh`: only the old `scripts/verify-cli/opencode/queue.py:26`.
  `scripts/privacy-check.sh` (staged): clean. `git diff --check`: clean.
- The generated-file test `the_generated_command_classes_ts_is_current` passes.

### Flagged for user (not acted on)

- Not run live (rule: never start the app). `npm run backend:stale` was not run in
  this worktree: the three commands are a backend change, so the running window needs
  a new build before the Add/Remove/Refresh buttons work (the rows render, then the
  command fails as unknown).
- Remove deletes the key and endpoint at once; this month's ledger row stays, so the
  slot number is not reused until next month and the row is simply gone (the use is
  no longer visible in the panel).
- A locked keyring disables Refresh/limit/Remove/Add (same as the built-ins: nothing
  to do without the key store); there is no "replace the key" action in the UI.
- Non-English strings are machine-grade (see above).

### Click-through for the user (needs the backend of this branch in the running window)

1. Settings → Manage CLIs → Agent accounts → API keys; scroll below the three
   provider rows to **Custom endpoints** (an "untested" pill beside it). Open "How
   custom endpoints work" to read the help.
2. In the **Add endpoint** row: Name `Institute API`, base URL of your endpoint
   (`https://…/v1`), paste the key, keep or change the limit (M tokens / month), press
   **Add endpoint**. The key field empties at once; a wrong key or URL shows an error
   under the group. On success a row appears: name, host, "Models: n", "no price",
   "0 of 5M billed tokens this month".
3. If it shows "Models: 0" and the yellow warning, fix the base URL (add `/v1`), remove
   the endpoint and add it again, or press **Refresh models** after the server is fixed.
4. Under "Runs on" for OpenCode, pick "my API key (… Institute API)".
5. Open a new local OpenCode tab, type `/model`: the endpoint's models are listed under
   "Institute API". Send one short prompt; back in Manage CLIs the row's billed tokens
   rise within seconds.
6. Change the limit to a tiny number (for example 0.001) and press **Set limit**: the
   next request is refused with the budget message; set it back.
7. Press **Remove**: a confirm dialog names the endpoint; Cancel keeps it, Remove deletes
   it and the row disappears; the OpenCode row falls back to its other keys.

## R2 — final review of the whole range (`02ad378e9..e05ddca52`)

Fixes on top of `e05ddca52`: `b769b3f52` (limit write), then the filemap commit,
then the commit that adds this section.

### Confirmed and fixed

- **A limit write erased the limit of an endpoint added after the window loaded
  its settings** (`b769b3f52`). `add_custom` writes `agent_api_token_limits["custom-<n>"]`
  in the backend and nothing refreshes the window's cached settings; a settings
  patch replaces the whole `agent_api_token_limits` map, and both "Set limit"
  (`AgentCustomEndpointsRows`) and a built-in's Save (`AgentApiKeysRows.writeLimit`)
  spread the cached map. Add endpoint A, add B, set a limit on A: B's limit was
  gone, B showed "no limit" and every request of it was refused until the user
  noticed. Both writers now start from `currentApiLimits()`
  (`agentApiKeysShared.ts`: the file's map through `get_settings`, the cache only
  when that cannot be read). Test: `writes a limit over the file's limits, not the
  window's cached copy` (`AgentCustomEndpoints.test.tsx`), failed before the fix.
  A read-then-patch window of a few ms remains (same as every other whole-map
  setting); a backend merge command would close it.

### Checked and rejected (no bug)

- UI to backend chain: `agent_api_custom_endpoint_add { label, baseUrl, key,
  limitTokens }` maps to `base_url`/`limit_tokens`, slot ids `custom-<n>`, OpenCode
  ids `tt-custom-<n>`, models from the saved listing, limit key
  `agent_api_token_limits["custom-<n>"]` written by `add_custom` (the UI does not
  write it first), proxy base `<proxy>/custom-<n>` (no `/v1`) and `{env:CUSTOM_ENDPOINT_KEY_<n>}`
  all line up. Every `settings.agentCustom*` key used exists in en/de/es/fr/it.
- A2 spawn: the token only travels under `CUSTOM_CARRIER` (all eight in
  `tmux_local::SECRET_ENV`, mapped back by `agent_exec::targets` over `ENV_VARS`),
  never in the inline config (`{env:…}`), an argv or a log; a user's own
  `tt-custom-<n>` block (either shape) wins and takes its token/base/carrier back
  out; local-model tabs (including the assistant's `OpenCodeLocal`), subcommands,
  the locked-project gate (`agent_privacy`), containers (`refuse_in_container`) and
  remote spawns never reach `inject_env_at`; `opencode_routed` and
  `base_of_carrier` cover the custom slots, so tmux < 3.2 refuses a custom-only route.
- Revocation: `remove_custom` clears the key, revokes the slot's grants, then
  writes; `add_custom` revokes before and after. The loopback client has
  `.no_proxy()`. `custom_base` is read per request (404 before any key read).
- R1's guard: `patch_settings_at` drops and `save_settings_at` keeps
  `agent_api_custom_endpoints`; no other settings writer takes caller data
  (`patch_json` writers each set their own field and round-trip the list).
- Hosted server: `custom_endpoints()` and `spawn_endpoints()` are empty, the
  commands refuse, `issue` refuses admin + custom, `server/` never names `Provider`.
  The `--no-default-features` lib and `server_secrets` pass.
- No leftover `// A2:` notes or TODOs; the `#[cfg(test)]` items
  (`inject_env_with`, `route_opencode`, `issue_provider_for_test`) are test-only
  wrappers, not in a production path. No `any`, no bare `listen()`, confirmation
  through `useDialogs()`, `UntestedTag` row `opencode-custom-endpoint` present and
  used. `scripts/brand-check.sh` shows only `scripts/verify-cli/opencode/queue.py:26`;
  `scripts/privacy-check.sh 02ad378e9 HEAD` is clean (12 commits).

### Flagged for user (not acted on)

- **The three commands are class Core (fixed by the plan), so a paired browser
  can call them.** `agent_api_custom_endpoint_add` makes the desktop `GET
  <any https URL>/models` with a key the caller chose (an SSRF-like probe that
  returns the listed model ids), and a new endpoint is a route OpenCode tabs
  send prompts to. Unlike `agent_api_key_set` (fixed host) it changes where
  data goes. Consider class Client/Admin for add/refresh.
- **`opencode_models::listed_ids` strips a leading `models/` from every id**,
  also for a custom endpoint. An endpoint that lists and requires the id
  `models/x` (Google's OpenAI-compatible listing does, and accepts both) would be
  called with `x`. Not confirmed to break a real endpoint; a one-line skip for
  `Provider::Custom` if it does.
- **Inline-config size.** Up to 200 model ids per slot and 8 slots go into one
  `OPENCODE_CONFIG_CONTENT` env string; with long ids that could pass Linux's
  128 KiB per-string limit (spawn would fail). Realistic lists are far smaller.
- **Settings read twice per spawn** (`inject_env`, then `inject_launch`): an
  endpoint removed between the two leaves its carrier and base variable in the
  env for that one spawn (the token is that tab's own proxy token, which the
  removal already revoked). Narrow; not fixed.
- Earlier flags still stand: the HTTPS client honours the system proxy
  (A2), `https://` to private addresses is accepted (A1), no key check on a
  404/405/501 from `/models` (A1), cached tokens count at a tenth (A1), 32 768
  assumed when `max_tokens` is absent (R1), non-English strings are machine-grade (A3).

### Filemap rows updated

`docs/filemap_backend.md`: `agent/agent_api_keys.rs`, `api/api_proxy.rs`,
`api/api_meter.rs`, `api/api_usage.rs`, `commands/settings.rs` (patch/save guard),
`schema/settings.rs` (`CustomEndpoint`), one clause each.

### Gates (after the last edit, worktree)

- `npm run build`: exit 0 (tsc, desktop, mobile, web bundles).
- `npm test -- --reporter=dot`: 13 895 passed (the full suite; 13 894 + 1 new).
- `npm run lint`: 0 errors, 31 warnings (same count as before this review).
- `cargo test -q --workspace -- --test-threads=6`: 7084 passed, 23 ignored, no flake.
- `cargo test -q -p tabtivity --no-default-features --lib --test server_secrets`:
  6441 passed, 20 ignored.
- Clippy `--workspace --all-targets`, `-p tabtivity --no-default-features --lib`,
  `-p app-serverd --all-targets`: clean.
- `scripts/brand-check.sh`: only the old `queue.py:26` hit. `scripts/privacy-check.sh`:
  clean. `git diff --check 02ad378e9`: clean.
- Not run live (rule: never start the app).
