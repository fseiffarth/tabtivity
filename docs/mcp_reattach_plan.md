# Plan: Tabtivity MCP tools after a reattach

Status: Phase 1 and Phase 2 implemented 2026-11-18 (I1, I3, I2, R1, V0, I4,
R3, F; history in `docs/mcp_reattach_handoff.md`), never run live; the Windows
host code is compiled by CI only. How it works now: `docs/context/tmux_sessions.md`
("The MCP stamp of a local agent session") and `docs/context/agent_mcp_wiring.md`
§3–5; the residual is in `docs/threat_model.md` (loopback row). Where the result
differs from the plan below:

- **Stamp** is `<nonce>:<grant|->:<port>` (the port too, for the foreign-nonce
  probe); its grant is the first *revivable* lane's hash. tmux sets it with
  `set-option -q -o`, so an attach that loses the listing race never overwrites
  it. Unknown (no stamp listing) grants as before; a stamp with `-` is NoGrant
  (nothing minted, nothing flagged).
- **Stale** is flagged for every reattached local agent without a working
  grant, and for a partly revived tab (its revived lanes work, the card still
  says disconnected).
- **Frontend:** the continue-latest set is every resumable CLI not resumed by
  id (Antigravity, Copilot, Muse and custom agents too); a hookless agent's
  "when this turn ends" fires when its bytes go quiet.
- **Revived lanes** are cockpit, help, markup and print everywhere, git and tabs
  only on Linux, where a revived token is honoured only from processes of its
  own session's pane tree (R3's peer check, the user's decision on the
  interception finding); never schedule, root, reader, local model or web.
- **CLIs revived:** Claude, Codex, OpenCode, an unwired CLI (`<slug>-mcp`);
  Copilot only under 50 s of downtime; never a local Vibe model; assistant
  chats get no record.
- **Revival also within one run** (a PTY teardown releases the tokens in memory
  only), but never in a run whose listener fell back to another port.
- **A reviving launch only attaches**; a session that ended meanwhile is not
  created again. A revived session is re-stamped with this run's nonce (tmux;
  the Windows host cannot).
- **Beyond the plan:** `503` to a previous run's revivable bearer until its row
  is settled; a revoke stays revoked across a write in flight; the cap reads a
  clock anchored on the monotonic clock.
- **Unverified:** how each CLI treats `503` or a later `401`; a CLI that makes
  itself non-dumpable fails the peer check (its tab then has dead tools).

## The bug

A local agent tab runs in its own tmux session (`services::tmux_local`). After a
crash the session lives on and the next launch reattaches it with
`tmux new-session -A`, which ignores the new command and its `-e` env. The
agent keeps the MCP URLs and tokens it was started with:

- the listener's port is ephemeral per process (`commands/root_mcp.rs:541`,
  `bind(LOOPBACK)` on port 0);
- tokens live only in process memory (`root_mcp::tokens()`).

So every Tabtivity MCP tool of a reattached agent is dead (live 2026-11-18: 72
of ~180 agents on the previous run's port). Meanwhile:

- `launch_prep::prepare` still mints fresh tokens for the reattach
  (`launch_prep.rs:1150` → `grant_lanes`) that the process never sees, and the
  hover card (`servers_of_tab`, `root_mcp.rs:353`) reports them as live;
- `TokenStore::register` (`root_mcp.rs:264`) revokes the tab's earlier token
  per lane, so a same-id respawn inside one run kills a running agent's tokens
  too;
- the listener binds asynchronously (`commands/root_mcp.rs:535`), so a tab
  restored before `runtime()` is set gets no lanes at all.

## Two designs considered

**A. Keep the old credentials valid** (persist `sha256(token)` → identity per
tmux session, re-bind the old port, re-register on reattach). Running agents
reconnect without a restart, and no plaintext goes to disk (`Session::id` is
already the hash). But:

- a fenced agent shares the host network and knows the old port, so it can
  listen while the app is down and collect other tabs' bearers, which revival
  then makes *live* (worst: the schedule lane, a cross-project prompt
  injection);
- every lane's authentication moves to a hash-keyed store;
- identity fields (fence scope, push dir, `git_at_spawn`, mail taint) must be
  re-validated;
- whether Claude/Codex/OpenCode/Copilot retry an MCP server after "connection
  refused" is unverified (verify-cli).

About 1000 LOC.

**B. Detect, don't mint, offer a resume-restart.** Nothing on disk, no change to
authentication; the cost is one CLI restart per stale tab, and CLIs without
resume stay toolless. About 750 LOC plus tests.

Both planners recommended B now, A as a later option.

## Phase 1: what to build

1. **Stable port, synchronous bind.** Copy the API proxy (`api_proxy.rs:821-870`):
   remember the port in `<state_dir>/root_mcp/port`, bind it with std before
   restored tabs spawn, fall back to port 0, log the holder
   (`loopback_owner::occupants`). This fixes the startup race and narrows the
   fake-server window. The Mobile host's `start_headless_on` re-binds if its
   ephemeral port lands on the window's remembered one.
2. **Stamp each session at creation.**
   - Value: the tmux user option `@<slug>_mcp = <listener_nonce>:<grant_id>`.
     The nonce is random per listener (a new `Runtime.generation`); `grant_id`
     is the first lane's `Session::id`, or `-` for no grant.
   - Carrier: `PtyOptions.mcp_mark`, backend-only, `#[serde(skip)]`.
   - `local_tmux_args_on_end` appends `set-option` only on a create; create
     vs attach is decided in Rust.
3. **One listing per restore.**
   - `tmux_local::mcp_marks()` runs one `tmux ls -F '#{session_name}\t#{@<slug>_mcp}'`,
     cached about 3 s behind a single flight.
   - It also answers `reattaches_session` for every tab, instead of one
     `has-session` each.
   - Windows and no-tmux answer "unknown".
4. **Classify, pure** (`root_mcp::classify_reattach`):
   - **Create**: grant as today, set the mark.
   - **Live**: own nonce with the grant still held, or a foreign nonce whose
     listener confirms. Mint nothing, so the running agent's tokens survive.
     `TokenStore::adopt` re-keys the identity to the new PTY id.
   - **Stale**: no mark, dead listener or revoked grant. Mint nothing, flag
     the tab stale.
   - Foreign-nonce probe: unauthenticated `GET /mcp/grant/<hash>` → 204/404,
     with a 300 ms timeout.
5. **Truthful UI.**
   - `agent_features` gets `app_mcp_stale`; `servers_of_tab` is empty for a
     stale tab.
   - The hover card says "Tabtivity tools disconnected".
6. **Reconnect** (frontend):
   - A `TerminalMcpStaleCard`, modelled on `TerminalDeadPaneCard`.
   - Reconnect = `agentClearUndo::relaunch` (kill the session, relaunch with
     `resumeArgsOf`).
   - While the agent is working: "Reconnect when this turn ends", armed by the
     user and fired on `done`.
   - `--continue`-latest CLIs: behind a confirm, never in bulk. No resume:
     notice only.
   - One toast after restore: "N agent tabs lost Tabtivity tools — Reconnect
     idle ones", for id-resumable idle tabs only, at most 4 at a time.
   - Never automatic: a restart drops composer text, background shells and
     session approvals.
   - i18n in all five dictionaries, `UntestedTag` rows, the shared surface
     scheme, hidden-pane gating.
7. **Tests.** tmux argv and parser; a real-tmux private-socket test
   (`#[cfg(unix)]`, skipped without tmux); the classifier table; `grant_lanes`
   minting nothing on stale; the GET route; the port fallback; vitest for the
   card, bulk filter and hover row. Update the source-scan tests around
   `prepare`.
8. **Docs.** `tmux_sessions.md` (and its out-of-date line 38),
   `agent_mcp_wiring.md`, `threat_model.md` (the new GET route), filemap rows.

## Phase 2: revival without restart

Builds on Phase 1's stable port and session stamp. A tab Phase 1 would flag
**Stale** is revived instead when every condition below holds; otherwise it
stays Stale and gets Phase 1's Reconnect.

0. **Verify first** (verify-cli skill, real binaries outside the app): do
   Claude, Codex, OpenCode and Copilot call an MCP server again after it
   refused connections (the app down), or mark it failed for the session?
   Record the answer per CLI in `agent_mcp_wiring.md`. A CLI that never
   retries is not revived (its tab goes the Phase 1 way), so Phase 2 only
   wires the CLIs that pass.
1. **Hash-keyed TokenStore** (`root_mcp.rs:225-287`). `authenticate` hashes the
   bearer and looks up `sha256(token)` (already `Session::id`). `register`,
   `revoke_token`, `stamp_push_*` and `SpawnTokenGuard` (:968) hash their
   input; `register_hashed(hash, identity)` revives one. No plaintext token is
   kept in the map or written anywhere.
2. **Record per session** (new `services/root_mcp/root_mcp_reattach.rs`, no
   AppHandle):
   - The file is `<state_dir>/root_mcp/reattach.json`, written through
     `storage::patch_private_json` (0600, atomic, unknown fields kept). It is
     hidden in the fence (`private_state_paths` already covers `root_mcp`).
   - One row per tmux / session-host session name:
     `{port, nonce, project, cmd_stem, created, lanes:[{caller, hash, schedule_target, push_dir, git_at_spawn, fence_scope, unfenced_host}]}`,
     plus `last_alive`, refreshed every 5 minutes.
   - The row is written in `PreparedLaunch::commit` (`launch_prep.rs:803`) for
     a fresh session, after the fence stamps (:1625-1637). It goes into the
     record file of the listener that granted it: the window's or the Mobile
     host's (fixed decision 7).
3. **Revive on reattach** (`launch_prep.rs:1150`): `grant_lanes` still decides
   lane eligibility against *current* settings. Then
   `root_mcp_reattach::revive` handles each lane:
   - It swaps the fresh token for the recorded hash when the recomputed
     inputs match: `project`, `schedule_target`, push `dir` (from
     `projects.json`), `fence_scope`, `unfenced_host`. `git_at_spawn` comes
     from the record and is never recomputed (gap 19).
   - Otherwise it revokes the fresh token.
   - It strips the token env pairs from `opts.env`, so the session env is
     cleared.
   - The identity's `tab` becomes the new PTY id, so every revoke path still
     works.
4. **Lanes:** git, cockpit, help, markup, print, tabs. Never schedule (fixed
   decision 6). Never root, reader or LocalModel either: their mail taint and
   projects grant are keyed by the unstable PTY id.
5. **Guards against interception:** revive only when
   - the remembered port was bound on the first try,
   - the record's `nonce` belongs to the previous run of the same listener
     (the window or the Mobile host), and
   - the downtime (`now - last_alive`) is under the cap.

   On any port fallback, purge the whole file.
6. **Record lifecycle:**

   | Event | Action |
   |---|---|
   | `local_tmux_kill` (`terminal.rs:232`) | drop the row |
   | Clean quit (`kill_app_sessions`) | delete the file |
   | Rename (`terminal.rs:325`) | re-key the row |
   | Window start | prune rows whose session is gone; purge everything past the cap |
   | User revoke / lane switched off (`revoke_tab`, `revoke_session`) | drop the hashes |

   PTY teardown (`root_mcp_review::on_tab_gone`) switches to a memory-only
   `release_tab` that keeps the row.
7. **UI:** a revived tab shows its lanes as usual. A lane that failed
   revival makes the tab Stale as in Phase 1.
8. **Threat model** (`docs/threat_model.md`:346): record the residual. A
   fenced agent that binds the freed port while the app is down can collect
   other tabs' bearers, and revival makes them live, bounded by the guards
   above.
9. **Tests:**
   - record round-trip, including older and unknown fields;
   - the `revive` decision table: port mismatch, nonce mismatch, downtime
     expired, project / target / push dir / fence mismatch, root never, lane
     turned off since the crash, CLI not verified;
   - no plaintext in the store;
   - `release_tab` keeps the row and `revoke_*` purges it;
   - clean quit deletes the file;
   - port fallback purges the file.

About 1000 LOC with tests on top of Phase 1.

## Fixed decisions (user, 2026-11-18)

1. **Scope: Phase 1, then Phase 2.** Phase 1 lands first and works on its own;
   Phase 2 starts with the verify-cli check.
2. **Mid-turn:** a stale tab's button becomes "Reconnect when this turn ends".
   The user arms it per tab, and it fires on the turn hook's `done`. Nothing
   restarts unasked.
3. **`--continue`-latest CLIs** (Cursor, Grok, Qwen, Droid, Gemini) get
   Reconnect behind a confirm that warns it may resume a different
   conversation; never in the bulk toast.
4. **Windows session host now:** extend `session_mux/winhost.rs`'s protocol to
   carry the stamp in the same change. It answers "unknown" only where no
   session host runs. CI is its only test bed (cross-OS test rules, a
   `CI-Only: windows` trailer where a commit is Windows-only).
5. **Phase 2 downtime cap: 30 minutes** (`now - last_alive`); past it, the
   tab goes the Phase 1 way.
6. **Phase 2 never revives the schedule lane.** Revived lanes are git,
   cockpit, help, markup, print and tabs; scheduling comes back only through
   Reconnect.
7. **Phase 2 covers the Mobile host too.**
   - The host's listener (`start_headless_on`) remembers its own port in
     `<state_dir>/root_mcp/host-port`, binds it first and gets its own nonce.
   - It keeps its own record file, `<state_dir>/root_mcp/reattach-host.json`,
     with the same rows, guards and lifecycle. Its tabs are revived by the
     host's spawn path, never the window's.
   - Each listener reads and writes only its own file, so the two never race
     on one record.
   - The host's port must never equal the window's remembered port (Phase 1,
     step 1).

## Organisation

Shape: security work across coupled subsystems → a mostly serial chain,
with independent reviewers on the token and authentication work. At most 2
agents run at once (another session's agents are building too). Every
agent works in its own `isolation: "worktree"` and first runs
`git reset --hard <base>` (a worktree starts at origin/main). Each agent
commits green and appends to `docs/mcp_reattach_handoff.md`.

| Agent step | Plan sections | Main files | Base |
|---|---|---|---|
| I1 Phase 1 backend | Phase 1 steps 1–5, 7 (Rust), 8 | `commands/root_mcp.rs`, `services/root_mcp.rs`, `services/launch_prep.rs`, `services/tmux_local.rs`, `agent_features.rs` | develop |
| V0 verify-cli (runs beside I1) | Phase 2 step 0 | `docs/context/agent_mcp_wiring.md` only | develop |
| I2 Windows session host | Fixed decision 4 | `session_mux/winhost.rs` + its protocol | I1 |
| I3 Phase 1 frontend (beside I2) | Phase 1 step 6, 7 (vitest) | `TerminalView.tsx`, new `TerminalMcpStaleCard.tsx`, `TabHoverCard.tsx`, i18n, `untested.ts` | I1 |
| R1 Phase 1 review | bugs only, regression test each | I1–I3 range | I2+I3 merged |
| I4 Phase 2 | Phase 2 steps 1–9, fixed decisions 5–7 | `services/root_mcp.rs`, new `root_mcp_reattach.rs`, `launch_prep.rs`, `commands/root_mcp.rs`, Mobile host spawn | R1 |
| R2 finder + R3 verifier | Phase 2 security review, no shared context | I4 range | I4 |
| F final review | whole range: i18n, UntestedTag, filemaps, brand, privacy | all | R2/R3 |

The main agent merges each step into an integration branch, runs the gates on
it, and lands it on develop.
