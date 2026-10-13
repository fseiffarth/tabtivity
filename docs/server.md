# Tabtivity Hosted — the server version

The front door for everything about the server version: where it stands,
what the user decided, what is open, and which document holds the detail.
Read this first; keep it current when a decision or an open point changes.

## Status (2026-10-11)

- **Built, reviewed, unmerged, never run live.** Branch `hosted`
  (`.claude/worktrees/hosted`), `f3efd50b..` — every phase of the plan
  (P0–P5) plus follow-up steps, each with its own reviewer, then two final
  reviewers and a final fix round. All gates green, including the Windows
  and macOS all-targets checks and a GTK-free server daemon (`ldd`: libc
  only).
- **`develop` merged in (2026-10-07).** `develop` `a6ed2c7a` (214 commits
  past the branch base, incl. #2339 and the desktop's own agent API keys) is
  merged into `hosted`; 39 conflicted files, how each was resolved is in
  `hosted_handoff.md` § "Merge `develop` → `hosted`". The other direction,
  `hosted` → `develop`, is still owed (#2386). Merged again 2026-10-10
  (`develop` `6754d5cd`, 13 conflicted files; § "Merge `develop` → `hosted`
  (2026-10-10)") and twice 2026-10-11 (`develop` `32d65f6a`, one conflicted
  file; then `80142cc7`, the performance work, 13 conflicted files —
  § "Merge `develop` → `hosted` (2026-10-11, the performance work)"). All
  gates green incl. the Windows/macOS cross-checks and the daemon's `ldd`.
- **One agent-API-key path built (2026-10-10, #2389).** Admin keys, a
  server user's own key and the desktop's own key all reach agents through
  `api_proxy`; limits in billed tokens; one "runs on" control per CLI.
  `docs/agent_key_path_plan.md` (steps 1–5, `1db2a95a..`).
- **Markup questions on a server built (2026-10-11, #2390).** The daemon
  serves the markup MCP lane itself (it has no window), so a server user's
  agents get `markup_ask`/`markup_done` and the browser client and phone
  show their cards.
- **Phone Local models on a server: the administrator's phone only
  (2026-10-11, #2392).** The daemon answers the list, Load, Unload and
  Start itself (no window); every other account's phone gets
  `local_models_disabled` and leaves the section out — the shared Ollama is
  the admin's (§3.3). With markup, the two phone requests `develop` added
  after the branch base are now answered on a server.
- **Every agent MCP lane on a server (2026-10-11, #2391).** The daemon's
  listener serves the root lane (the root console's mail, calendar, to-do
  and ICS-import tools, the staged-write review, the overlay-docked agent),
  local-model and reader lanes too, with their controls and events in the
  browser client — everything the window's listener serves.
- **Nothing has run on a real server** or in the user's running window.
  Every new user-visible feature carries an `UntestedTag`.

## Where the detail lives

| Document | What it is |
|---|---|
| [`guide/server.md`](guide/server.md) | The step-by-step setup guide for administrators (linked from the README). |
| [`tabtivity_hosted_plan.md`](tabtivity_hosted_plan.md) | The design: processes, crate split, command classes, identity, logins, sharing, threat model, phases, §12 questions with the user's answers. |
| [`hosted_handoff.md`](hosted_handoff.md) | The build log, one section per step and per review: commits, design as built, gate counts and **the live steps of each step**. History; don't rewrite it. |
| [`context/server_gateway.md`](context/server_gateway.md) | Rationale for the gateway, per-user daemon, admin helper, units, secrets vault, admin keys, key broker, OIDC, Connect, Podman — and the listener/socket inventory. |
| [`context/web_client.md`](context/web_client.md) | Rationale for the browser client: dispatcher, transport, roles, per-client PTYs. |
| [`context/sharing.md`](context/sharing.md) | Rationale for hubs, editor-share gates, shared calendars and to-dos, pair mode (dropped). |
| `DOCUMENTATION.md` § "Hosted server: …" | User docs (sign-in, containers, desktop as client, secrets key, admin keys, sharing, browser access). |
| `todo/group-z-server.md` | The server backlog. |
| [`headless_owner_plan.md`](headless_owner_plan.md) and its handoff/review/merge files | P1's groundwork (the sidecar as headless owner), merged and user-verified before the server work started. Frozen. |

## What runs where (server mode)

Reached only through Tailscale Serve (443 → gateway, 8443 → content origin);
the gateway refuses to bind anything but loopback, and nothing faces the
public internet (plan Q8).

| Piece | Runs as | Talks on |
|---|---|---|
| Gateway (`<slug>-gateway`) | `<slug>-gw` | `127.0.0.1:8740` app, `:8741` content origin |
| Per-user daemon (`<slug>-serverd@<user>`, socket-activated, own binary, no GTK) | the user | `/run/<slug>/users/<user>.sock`, only the gateway's uid may connect |
| tmux unit | the user | `/run/<slug>/tmux/<user>` (0700); tabs outlive daemon restarts |
| Key keeper (`<slug>-gateway keeper`) | `<slug>-auth` | `/run/<slug>/auth.sock` |
| Key broker (`<slug>-gateway broker`) | `<slug>-auth` | `127.0.0.1:8739`, held by `<slug>-keybroker.socket` from boot |
| Hub (shared projects) | `<slug>-hub` | `/run/<slug>/hub.sock`; repos in `/srv/<slug>/shared` (0711) |
| Calendar service | `<slug>-cal` | `/run/<slug>/calendar.sock` |
| Shared Ollama | the admin's service | `127.0.0.1:11434` |
| Admin helper (`<slug>-admin-helper`) | root, via `sudo` | — (every verb has `--dry-run`) |

The full listener and socket inventory with each one's guard is in
[`context/server_gateway.md`](context/server_gateway.md) (table near the end).
A server user's daemon keeps its state in `~/.local/share/<slug>-server` and
projects in `~/<slug>-server`, apart from the desktop app's.

## The user's decisions

All answered 2026-09-29 … 2026-10-10; the plan's §12 holds Q1–Q14.

**Who and how**
- A few trusted users; tailnet only via Tailscale Serve (Q1, Q8).
- The server may also be someone's desktop: the desktop app, its phone
  sidecar (moved to Serve port 10000 on such a machine) and the same user's
  server daemon run side by side; `/proc` is `hidepid=invisible` with a
  `<slug>-proc` exception group holding polkit only — add a service only
  after a live failure shows it is needed.
- Running the whole server in a VM (2026-10-12): a recommended deployment
  for a server that shares someone's desktop, set up by hand with libvirt
  (`guide/server.md` § "Run the server in a virtual machine"). No code;
  Tabtivity's own VMs don't fit (they stop with the app). Cost: no GPU for
  Ollama without passthrough.
- Account admin is `sudo` + the admin helper only (no polkit rule, no
  browser admin page yet, #2356). Accounts that are root-equivalent
  (any sudoers rule; `docker`, `lxd`, `incus-admin`, `libvirt`, `disk`) are
  refused, admins included.
- Idle daemons keep running (they run their user's schedules and alarms).
- Sign-in: invite or pairing code, or OIDC linked by the provider's `sub`
  only (no email links).

**Agents, CLIs and models**
- One shared Ollama; only the admin pulls, deletes, loads, stops or starts
  models (`ensure_ollama_running` too). Users use only the admin's allowed
  models; every server request path is checked (dispatcher, mail AI).
- Only the admin installs, updates and removes agent CLIs, into one
  server-wide root; CLI self-updaters never install per user.
- Admin API keys: offered per CLI to a per-key list of users (a new or
  re-offered key starts with nobody); a withdrawn key fails the next start
  with a message; running agents lose it within a minute of a withdraw, a
  removal from the list or the user's own switch back. Remote agents and
  Codex never get it. Removing a user does not rotate a key — the admin
  replaces it. (Delivery as amended by #2389, below.)
- Key broker: Claude only, budgets in billed tokens per UTC month (cache
  reads at a tenth), 403 when spent.
- Shared consumer login (one subscription for several users): dropped.
- **One agent-API-key path (#2389, 2026-10-10):** develop's `api_proxy` is
  the one delivery path, desktop and server alike. On a server its keys
  come from the keeper/broker (the admin's key) or the user's per-user
  vault (their own key), never an OS keychain. One budget model: billed
  tokens per UTC month (the broker's); the desktop's USD figure stays only
  as an estimate. Mistral Vibe admin keys are dropped (no base-URL
  variable). A keyed container spawn fails, naming the way out. Built
  2026-10-10 (`docs/agent_key_path_plan.md`).

**Secrets and mail**
- Same-user unfenced processes can read the vault key; accepted and
  documented. Revoking a device rotates the key and re-keys the mailbox in
  the background; Server settings then asks for a new recovery code. A lost
  identity key is re-pinned with the recovery code. Setting up the key and
  making a new code need the device's signature.

**Browser, terminals, files**
- Recent Downloads are always the client device's own.
- Dropping OS files onto a terminal tab (`pty_drop_files`) is `Client`
  (2026-10-10): the paths are the client machine's; a browser client has
  none.
- Each client gets its own terminal attachment; tmux `window-size latest`
  (desktop sessions too).
- Content origin on the main port + 1. Crate split kept as a `desktop`
  cargo feature; the core crate stays `app-core`.
- Connect mode (desktop app as a client) runs its own local frontend, keeps
  its pairing key in a 0600 file, and is narrowed to its own commands.
  `open_external_url` is dropped from it (#2387, 2026-10-10): links in
  server content never reach the client's OS browser handler. Built
  2026-10-11.
- Server containers are rootless Podman per user, off by default (admin
  switch).

**Sharing**
- Hubs owned by the hub account; shared clones commit and push without
  hooks; any program-running git config key refuses git there; every change
  to an agent instruction file from a co-member is reviewed (no per-author
  trust), and only after the whole diff was shown.
- Sharing state lives in the hub and calendar services; the default
  calendar can't be shared; the owner keeps their own stripped task links;
  "Sharing projects" admin switch defaults on. Pair mode: dropped for now.

## Open problems

1. **Two agent-API-key systems (#2389): settled and built 2026-10-10.**
   One path (`api_proxy`) for every key, one budget unit (billed tokens),
   one credential choice per CLI — `docs/agent_key_path_plan.md`. Left as
   a known residual: a daemon restart drops every proxy token, so a keyed
   agent in a tmux tab that outlived it must be restarted. Never run live.
2. **The merge (#2386).** `develop` → `hosted` done 2026-10-07 (39
   conflicts, class rows and desktop-feature attributes for develop's new
   commands included; TODO numbers did not collide), again 2026-10-10 and
   2026-10-11. Owed: `hosted` → `develop`. (The root MCP's local-model lane
   needs no model-allowlist call: it forwards no model to Ollama.)
3. **Agent tools on a server: settled and built 2026-10-11 (#2390,
   #2391).** The daemon serves every lane the window does. Left as a known
   residual, as for the API proxy: a daemon restart drops every MCP token,
   so an agent in a tmux tab that outlived it has no tools until restarted.
4. **Built 2026-10-11:** `open_external_url` dropped from the Connect
   window (#2387, decided 2026-10-10).
5. **Still deferred:** phone push for turn edges with no window (#2384); a
   second page re-typing a shared-PTY tab's launch input (#2358); the rest
   of the gateway/helper security review and a gateway body cap (#2353);
   Connect's Rust enrol/release half (#2379); hub GC and quotas (#2372);
   shared calendars in the phone's no-window views (#2369); presence chip and
   "no longer shared" pill (#2367, #2373); an agent's push through a proxy
   (#2368); shared to-do column order (#2370); the 31 lint warnings on
   `develop` (#2385). `macOS-schema.json` is committed (#2388, 2026-10-11).

## Open decisions

None. #2389 and #2387 were answered 2026-10-10 and are built; #2388
2026-10-11 (commit the macOS schema). The agent MCP lanes on a server were asked for 2026-10-11 and built. `hosted` → `develop` (#2386) waits by the user's
call (2026-10-10) while heavy work continues on `develop`; re-merge
`develop` → `hosted` as needed.

## Live runs owed, in order

Each step's exact clicks are in its `hosted_handoff.md` section.

1. P2 — the browser client on localhost against the desktop sidecar
   (Settings → Mobile → Browser access).
2. P3 — a server with two accounts, ending with
   `sudo scripts/server-isolation-test.sh alice bob` (#2357); then P3 part 2,
   the vault and mail re-key steps.
3. P3b admin keys (#2363, #2365) and the key broker (#2377).
4. P4 sharing with three accounts (#2366) and the worktree gate (#2381).
5. OIDC (#2378), Connect mode (#2379), rootless Podman (#2380).
6. The final fix round's 15 steps.
7. The one agent-API-key path (#2389): its five steps in
   `hosted_handoff.md` § "#2389".
8. Markup questions on a server (#2390), the root, local-model and reader
   lanes (#2391) and the admin's phone Local models (#2392): the TODOs'
   manual tests.

An `UntestedTag` is cleared only when the user says that item is tested.
