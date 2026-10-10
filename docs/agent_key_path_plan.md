# One agent-API-key path (#2389)

*Status: in progress on branch `hosted` (2026-10-10). Settles open problem 1
of `docs/server.md` before `hosted` → `develop` (#2386).*

## Why

`develop` (released since v0.1.106) and `hosted` each grew a way to run an
agent CLI on an API key instead of its login:

- **Own keys** (`develop`, `docs/api_chat_plan.md` Parts A/C): a key per
  provider in the OS keychain (`agent_api_keys`), the in-process loopback
  `api_proxy` handing each tab a token (`ANTHROPIC_AUTH_TOKEN` /
  `GEMINI_API_KEY` + the base-URL variable), a required monthly limit in USD
  (`api_usage`, `api_meter`, `api_prices`).
- **Admin keys** (`hosted`, P3b/P5, `docs/context/server_gateway.md`): the
  keeper hands the key (or a broker token) to the user's daemon, which puts
  it into the agent — Claude through `apiKeyHelper` and a helper socket bound
  into the fence, Gemini/Vibe as an env carrier, containers as an exec env —
  with budgets in billed tokens at the broker.

Both set Claude's base URL, both decide which credential an agent runs on,
the daemon has no OS keychain, and the budgets count differently. The user
rule is one mechanism, extended.

## Fixed decisions (user, 2026-10-10 — not up for review)

1. **`api_proxy` is the one delivery path**, desktop and server. Every keyed
   agent spawn gets a proxy token and base URL; no key and no broker token
   ever enters an agent process, its home or a container.
2. **Key sources on a server:** the administrator's key comes from the
   keeper (`get`): direct → the proxy forwards to the provider with the key;
   brokered → the proxy forwards to the broker URL with the user's broker
   token. The user's own key lives in the per-user vault — already the
   server's `remote_credentials` store, so `agent_api_keys::{get,set}_key`
   work unchanged. A user may bring their own key on a server.
3. **One budget model: billed tokens per UTC month** — the broker's
   `keys_wire::billed` (input, cache writes, output in full; cache reads at a
   tenth), generalized to Gemini. The own-key limit becomes a token limit;
   `api_prices` stays only to show an "≈ $" estimate beside the count (no
   second limit). Admin-key grants are not charged against the user's own
   limit: brokered ones are budgeted at the broker, direct ones have none
   (as built).
4. **Mistral Vibe admin keys are dropped**: Vibe has no base-URL variable,
   so it cannot go through the proxy. The keeper and panel accept admin keys
   only for proxy-able CLIs (Claude, Gemini). Back when an override is verified.
5. **Containers:** a container spawn of a CLI on any API key fails, naming
   the way out (container off, or the CLI's own login). Nothing keyed enters
   a container.

## Decisions made while planning (mine; change if wrong)

- **Old USD limits round-trip.** `Settings::agent_api_limits` (USD) stays in
  the schema, read and written back untouched; the new
  `agent_api_token_limits` (provider → billed tokens) is what the proxy
  enforces. A provider with only a USD limit is `NoLimit` (keyed tabs refused)
  until a token limit is set; Manage CLIs shows the old dollar figure as a
  hint. No conversion guess: a wrong price would over- or under-spend.
- **Ledger v2** adds `billed` per provider and per model; a v1 file's
  `billed` is recomputed from its token counts on load (round-trip).
  Reservations become billed tokens (worst case = input estimate + output
  cap, as the USD worst case is built).
- **One credential choice per CLI**: own login (default) / own API key /
  administrator's key (server, offered). Admin and own key are exclusive:
  choosing one switches the other off for that CLI.
- **The helper machinery goes**: `--key-helper`, `serve_helpers`,
  `run_helper`, the helper-dir fence bind, `sync_helper_settings` (a cleanup
  removes our own `apiKeyHelper` value from homes once; a user's own is never
  touched), `CONTAINER_KEY_ENV`, the Gemini/Vibe carrier delivery.
  `agent_auth`'s "never both" (own login copies out of the homes while the
  admin key is chosen) stays.

## Steps

Each ends in a green commit (all gates of `AGENTS.md` plus `cargo test` of
`src-core` and the workspace check).

1. **Token budget** (`api_usage`, `api_meter`, `api_proxy` `Budget`,
   `schema/settings.rs`, `keys_wire::billed` shared): ledger v2 with billed
   tokens, token reservations, `agent_api_token_limits`, `Verdict` in tokens,
   `require_limit` on the token limit; status carries billed + ≈$ estimate;
   Manage CLIs' limit field in tokens (`AgentApiKeysRows`), i18n.
2. **Own keys on a server**: start `api_proxy` in the daemon
   (`server::daemon`, its exit), `agent_api_key_*` / status commands `Core`,
   vault locked → the proxy's refusal names unlocking; the API-key rows shown
   in the browser client.
3. **Admin keys through the proxy**: a grant carries its source
   (`Own` / `Admin { cli }`); the proxy asks the daemon's keeper client per
   request (short cache, as the keychain one) and forwards direct or
   brokered; `inject_env` picks the source from the choice; remove the helper
   path, carriers, `container_env`; keyed container spawns fail; keeper and
   registry drop Vibe; the choice exclusive with own keys.
4. **One Manage CLIs control** per CLI (login / own key / admin key), the
   admin key's broker usage beside it; help text.
5. **Docs**: `server_gateway.md`, `api_chat_plan.md` notes, `server.md`,
   filemaps, help topics, `UntestedTag` rows, TODO #2389 closed.

## Verification

Unit tests per step (proxy forwarding to a test upstream for both admin
modes, budget refusals in tokens, ledger v1 → v2, container refusal, choice
exclusivity). Live, owed: a desktop own key under the token limit; on a test
server, admin key direct and brokered, own key from the vault, a container
refusal.

## Progress

- **Step 1 — token budget: done** (this commit). Ledger v2, token
  reservations (`Meter::worst_case_billed`), `agent_api_token_limits`, the
  old USD limit as a hint, Manage CLIs in million billed tokens with an ≈ $
  estimate, all five dictionaries, help and DOCUMENTATION. Gates: clippy
  clean; `cargo test --workspace` 4143 passed; `npm test` 7681; lint 0
  errors / 28 warnings; build; brand-check.
- **Step 2 — own keys on a server: done.** The daemon starts `api_proxy`
  inside its runtime and stops it (tokens revoked, usage flushed) when it
  exits; `agent_api_key_{set,clear}` and `agent_api_keys_status` are `Core`
  (keys land in the vault through `remote_credentials`); the status names
  its store (`keychain`/`vault`) and a locked vault says to sign in on a
  paired device, with no keyring unlock. Residual: a daemon restart drops
  every token, so a keyed agent in a surviving tmux tab must be restarted
  (as after a desktop crash). Gates as step 1 (Rust 4143, frontend 7682).
