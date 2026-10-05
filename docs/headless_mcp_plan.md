# Headless MCP plan — the agent MCP servers for tabs the Mobile host starts

TODO #2339 (`todo/group-z-server.md`). Follows the headless owner work
(`docs/headless_owner_plan.md`, `docs/headless_owner_handoff.md`, "H3 parity
gaps").

## The problem

The schedule / git / help / root MCP listener and its per-spawn tokens live in
the window process (`commands::root_mcp::start`, `services::root_mcp::runtime()`).
The Mobile host (`tabtivity-mobile-host`, the sidecar) spawns agent tabs with no
window open — a phone ＋ `Create`, and the scheduler restarting a stopped tab —
through `HeadlessSpawner` → `launch_prep::prepare`. There `runtime()` is `None`,
so every `apply_*_to_spawn` is a no-op: the tab starts without
`tabtivity-schedule` / `-git` / `-help`, and keeps lacking them after a window
attaches (a CLI reads its MCP config only at startup).

## Design: each process serves the tabs it spawns

- **The window keeps its listener**, unchanged. With Mobile off there is no
  sidecar and nothing else changes.
- **The sidecar runs its own listener** (same code: `commands::root_mcp`'s
  router and admission, generalised over who it reports to), on its own
  loopback port, with its own in-memory token store. It serves the
  `/mcp/schedule`, `/mcp/git` and `/mcp/help` lanes and **never the root lane**
  (`/mcp` is not routed there, and `Runtime::serves_root = false` makes
  `apply_to_spawn` / `apply_reader_to_spawn` / the VM guestfwd hand out
  nothing). The phone can never reach the root scope anyway
  (`headless::create_tab` refuses it).
- Because `runtime()` is now `Some` in the sidecar, `launch_prep::prepare`
  wires a headless spawn exactly as a window spawn: same gates, same argv /
  env recipes, tokens minted and registered in the sidecar's store.
- **Tokens never touch disk**, as before (`services::root_mcp` module doc).
  They exist in the spawning process's memory, the tab's environment and its
  tmux session environment — the same places a window spawn's tokens live.
  The fence gives every agent its own pid namespace and a private `/tmp`
  (no tmux socket, no other process's `/proc`), so a fenced agent cannot read
  either process's store. There is no shared token file to protect.
- **A token is valid only on the listener of the process that minted it.**
  A sidecar restart (rebuild, Mobile switched off and on) forgets its tokens:
  a headless tab then gets `401` from a dead or new port until it is
  restarted — from a window (window tokens) or by the scheduler (sidecar
  tokens). This is the same property a window restart already has for tabs
  that survive in tmux.

### Why not the alternatives

- *Move the listener into the sidecar only* (the TODO's first idea): with
  Mobile off there is no sidecar, so the window must serve anyway; every
  window spawn would need an IPC round trip to mint; the root lane's mail,
  review and MCP-session-access state is window-bound. Two listeners that
  each serve their own spawns is the smaller change, and collapses to "the
  daemon serves everything" once the sidecar becomes the always-on per-user
  daemon (`docs/tabtivity_hosted_plan.md` P1).
- *Either process serves, tokens shared through a 0600 file + lock*: puts
  bearer tokens on disk (the root MCP design rules that out), and the
  per-session state beside each token (revocation flag, rate windows, mail
  taint, projects grant) would need cross-process sync too.

### Approval cards

- **Schedule**: proposals are rows in `agent_tasks.json` under its file lock
  (H2 made those transactions process-safe), with no tie to a live session in
  the window. The sidecar's schedule lane writes them; it then pokes an open
  window over `desktop-control.sock` (`DesktopRequest::Refresh`, slice
  `schedules`), which re-reads the loaded rows. With no window the row waits
  in the file and the card shows when a window loads it.
- **Git push / release**: proposals live in the serving process's memory and
  the push needs the user's token from the OS keychain. The sidecar **never
  reads the git token** (it is the process that faces the phone; on Linux a
  locked Secret Service collection would also turn a read into an unlock
  prompt or a parked D-Bus call). So in the sidecar:
  - `git_push` / `git_release` answer a fixed category `window_required`,
    saying the tab was started with no window open and how to get pushes back
    (restart the tab from the window). Phase 2 replaces this with a queue.
  - `ci_runs` / `ci_run` / `ci_security_alerts` run without the token (public
    repos work; a private one answers `not_available` naming why).
  - `git_push_status` / `git_push_cancel` work on the sidecar's own (empty)
    proposal list.

### Hygiene

- The sidecar revokes a headless tab's tokens when the phone closes it, and a
  sweep (every 60 s, missed ticks delayed, not bursted) revokes a tab's
  tokens once its tmux session has been gone at three consecutive looks —
  the window closed the tab, or something killed the session. A CLI that
  merely exits does **not** end the session (it runs a login shell after
  the CLI), so the tokens live as long as the session, as a window tab's
  live as long as its PTY. Misses count per token generation (the tab's
  session ids), and only that generation is revoked, so a tab the
  scheduler restarts meanwhile keeps its new tokens.
- The listener stops with the sidecar's shutdown watch; nothing outlives it.
  A failed first bind is logged and retried with backoff (5 s doubling to
  5 min) until it binds or the sidecar stops; tabs spawned meanwhile go
  without the tools.

## Phases

1. **Sidecar listener + headless wiring** (this sitting).
   - `Runtime { port, serves_root }`; root/reader/VM gates on `serves_root`.
   - `TokenStore` instance behind the global store, so a test can model two
     processes; the listener authenticates against the store it was given.
   - `commands::root_mcp`: `ServerState` holds an optional `AppHandle` (root
     lane, window only) and a `Notice` sink; `start` (window) and
     `start_headless` (sidecar) share `bind` + `serve`.
   - `services::mobile_control::host::run` starts the headless listener before
     the scheduler, pokes the window on schedule changes, runs the sweep. The
     window turns a `schedules` poke into its own `agent-schedules-changed`
     event, so `AgentScheduleHost` and popouts react as to a window notice.
   - `git_push_mcp::serve_without_keyring()` (set by the sidecar):
     `creds()` withholds the token, push/release answer `window_required`.
   - `launch_prep` makes one call, `root_mcp::grant_lanes(opts, agent,
     runtime(), tokens(), state_dir)`, which reads every gate from that state
     dir (settings, the scope's `projects.json` entry) — so a test drives the
     real gates against a fixture.
   - Docs: `docs/context/agent_schedule_mcp.md`, `git_push_mcp.md`,
     `help_mcp.md`; filemap rows; `UntestedTag` row `mcpSecurity.headless`
     (a note in MCP session access, where the window says these sessions are
     the Mobile host's and not listed).
2. **Git requests queued for the window's card** (later). A shared,
   file-locked queue (`<state>/root_mcp/git_queue.json`, 0600, no secrets):
   the sidecar records the request (tab, project, trusted dir, the tab's
   fenced scope, requested branch/tag, note, budget) and answers `queued`;
   a window picks queued records up (startup, a `git` refresh slice, a
   timer), plans and preflights them **inside the recorded fence scope**
   (never `fenced_scope_of_tab` of its own registry, which does not know the
   sidecar's tabs — that would run the hook unfenced), stages or pushes as
   for its own tabs, and mirrors the outcome back into the record so the
   sidecar's `git_push_status` reports it. A host-queued record without a
   fence scope on a fenced platform fails closed (`fence_unavailable`).
3. **Parity** (later): list the sidecar's sessions and audit rows in the
   window's MCP session access (an admin-socket request), with Revoke.

## Tests (phase 1)

- `host.rs`: `start_headless` publishes the runtime (no root lane); a
  headless `Create` of a Claude tab runs `grant_lanes` against the fixture's
  state dir and records `PtyOptions` carrying the schedule, git and help
  servers; the bound listener admits each token over HTTP on its own route
  and a fresh store refuses them; root and reader spawns get nothing from
  that runtime; the phone's close revokes the tokens. The sweep's
  per-generation counting has its own test.
- `commands::root_mcp`: the headless router has no root route; a token from
  one store is refused by a listener over another.
- `root_mcp`: `serves_root = false` hands a root spawn nothing.
- `git_push_mcp`: without the keyring, `git_push` / `git_release` answer
  `window_required` and spend no budget beyond admission.

Not verifiable here: nothing is started live (AGENTS.md). Manual steps are in
`docs/context/agent_schedule_mcp.md` and the final report.
