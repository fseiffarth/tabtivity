# Headless MCP plan — the agent MCP servers for tabs the Mobile host starts

TODO #2339 (`todo/group-z-server.md`). Follows the headless owner work
(`docs/done/headless_owner_plan.md`, `docs/done/headless_owner_handoff.md`, "H3 parity
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

## Phase 1b — the markup lane in the Mobile host

The bug. A phone's markup view never showed ✓ ticks or **Approve all** for an
agent tab the Mobile host spawned: the host did not route `/mcp/markup` and
published `serves_markup: false`, so `grant_lanes` never gave those tabs the
markup server. A CLI reads its MCP config once, at start, so such a tab lacked
`markup_ask` / `markup_withdraw` / `markup_done` for its whole life, window or
not.

### Fixed decisions

- Each process still serves the tabs it spawns. The host now serves the markup
  lane for its tabs (route `/mcp/markup`, `Runtime::serves_markup = true`),
  with its own token store; **a token is valid only on the listener of the
  process that minted it**, and no token or secret touches disk.
- The root lane stays window-only: `/mcp` is routed only with a context, and
  `serves_root` stays false in the host. Only the markup route moved out of
  the `ctx.is_some()` gate.
- Asks and ticks stay **in memory, in the process that took them**. Nothing is
  written to disk; no liveness has to cross a process (`session_alive` is a
  check of the local token store, and stays one).
- Every view that shows a tab's asks reaches both stores; an answer goes to
  the process that holds the ask, and the prompt is delivered the way that
  surface already delivers: the window queues it through its scheduler; the
  host, with no window, uses `headless::hold_prompt` (`markup_here`).
- Raw project ids, paths, commands and tmux targets still never cross the
  browser API: the phone routes are unchanged and still shape the answer
  (leaf names, sealed rows, `valid_tick`, `valid_ask_id`).
- A server daemon is unchanged (it never sets a peer and always answers from
  its own store).

### The design: (b) the host serves its own asks; views route by spawner

- **Host side.** Route `/mcp/markup`; `serve` publishes `serves_markup: true`
  for every listener. The host's markup change hook (`set_change_hook`, a
  `OnceLock` installed by `start_headless` when there is no server context)
  raises `Notice::Markup`, which `host::run` turns into
  `poke_desktop(["markup"])` — the window turns that slice into its own
  `markup-mcp-changed` event (`emitMarkupChanged`), which every markup view
  (`usePdfMarkup`, the cockpit) already re-reads on. The host calls
  `markup_mcp::sweep()` where it revokes tokens (the phone's close; the
  60-s sweep), so an ask dies with its session.
- **Window side.** `commands::markup_mcp`'s commands (`markup_mcp_list`,
  `_ticks`, `_answer`, `_reopen`, `_dismiss`; same names and payloads, now
  `async`) read the window's own store and then the host's, over the admin
  socket (`AdminRequest::MarkupList/Ticks/Answer/Reopen/Dismiss`,
  `commands::markup_mcp::admin_markup` on the host). Asks merge to the newest
  (the stores each hold at most one open ask per tab; two exist only across a
  respawn by the other process, until the old session is swept); ticks union.
  An answer tries the window's store first and, on `gone`, the host's, which
  closes the ask and returns `{ prompt, receipt }` — the window then queues
  the prompt exactly as it does for its own tabs, and a failed queue reopens
  the ask in whichever process holds it. A dismissal goes to both. The peer
  is set by the window only (`use_host_peer`, from `commands::root_mcp::start`);
  with no host running the connect fails at once and the window shows what it
  holds. A host older than this answers an error, read as "no asks".
  The TS callers are unchanged.
- **Phone side (`markup_call`).** With a window open the request goes to the
  window as before; its merged commands include the host's asks, and its
  scheduler delivers an answer. With **no window** (or one that does not know
  the tab), the host answers from its own store (`markup_here`: list, ticks,
  an answer held with `hold_prompt`, a dismissal), but only when it holds
  something for the request (`markup_held_here`); a tab with nothing asked
  stays the quiet `503 desktop_unavailable`, as before.
- The window opening later needs nothing: the asks are in the host's memory
  and the window reads them on its first list; the host's pokes ring the
  views.

### Alternative rejected: (a) a shared on-disk store

Asks and ticks in a 0600 file under the state dir, file-locked like
`agent_tasks.json`. Rejected because it moves the hard parts rather than
removing them: liveness (a session id is checkable only in the process that
minted it, so each entry would carry its owner and a dead owner's entries would
sit until the 24-h retention — today a crash loses them, correctly); change
notification both ways (the host can poke the window, but the window→host
direction needs a second mechanism, or a polling timer); the answer path
(still has to pick the delivering surface); rate windows (per tab, in memory
today); and a persisted-JSON round-trip for stores that are deliberately
ephemeral ("nothing survives a restart", `docs/context/markup_mcp.md`). It also
turns every 3-s phone poll into a locked file read. The in-memory design adds
one admin request family and one poke slice, and every existing invariant
(tokens only in memory, `session_alive` local, 24-h retention) holds.

### Steps

1. `commands::root_mcp`: route `/mcp/markup` unconditionally (`/mcp` stays
   gated); `serve` publishes `serves_markup: true`; `Notice::Markup`;
   `start_headless` installs the hook for a host without a context; `start`
   sets the peer. `Runtime` docs.
2. `services::markup_mcp`: `Deserialize` on the view types, `Serialize` on
   `Answer`; `merge_asks` / `merge_ticks`; `MAX_PEER_TICKS`; a test-only
   second store (`as_host`) so a test can model the two processes.
3. `protocol` + `admin`: `AdminRequest::Markup*`, `AdminResponse::Markup*`,
   `AdminContext::markup` handler.
4. `commands::markup_mcp`: the merged async commands, `*_with(peer, …)` for
   tests, `admin_markup`, `use_host_peer`.
5. `host.rs`: `Notice::Markup` → poke; handler on the admin context;
   `markup_call` fallback + `markup_held_here`; `sweep()` after revokes;
   `poke_desktop` tolerates a thread outside the runtime.
6. `MobileBridgeHost.tsx`: the `markup` refresh slice → `emitMarkupChanged`.
7. Docs, filemaps, todo, handoff.

### Tests (phase 1b)

- `host/tests.rs` `a_headless_claude_tab_is_handed_the_hosts_mcp_servers`
  (extended): a headless create through `grant_lanes` gets the markup server
  (env, argv, bound to the tab's project and target); the host listener
  admits the markup token on `/mcp/markup` over HTTP, refuses the other
  lanes' tokens there (and the markup token elsewhere), still 404s `/mcp`
  for it; another process's store refuses it; a targetless spawn or a runtime
  that holds no asks gets none; the phone's close revokes it.
- `host/tests.rs` `a_tab_the_host_spawned_gets_its_markup_answered_by_the_host_without_a_window`:
  asks and ticks made through the host's lane are listed to the phone with no
  window; the answer is held with `hold_prompt`; a tab with nothing asked is
  `desktop_unavailable`; with a window the request is forwarded and nothing is
  held by the host (the window delivers); a window that does not know the tab
  falls back to the host.
- `commands::markup_mcp` `the_window_reaches_the_asks_and_ticks_the_host_holds`
  (two stores, a real admin socket): the window lists the host's asks and
  ticks and its own, with and without a host; answers, reopens and dismisses
  go to the holder, a window ask never leaves memory.
- `commands::root_mcp`: the headless router routes the markup lane (not `/mcp`);
  the host's hook notifies its sink.
- `markup_mcp`: merge rules; the second store is isolated.
- `MobileMarkupPoke.test.ts`: the `markup` slice rings `markup-mcp-changed`.

Not verifiable here: nothing is started live (AGENTS.md). Manual steps are in
`docs/context/markup_mcp.md` ("Host-spawned tabs").
