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
