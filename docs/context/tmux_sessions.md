# tmux session persistence

Referenced from `AGENTS.md`.

**A shell/script tab runs inside a tmux session so a long run survives** (#85) — decoupled from the disposable channel, the tab
**reattaches** on relaunch. It covers **two axes**:

- **Remote** (on the SSH host): survives an SSH drop, a laptop sleep, a VPN drop,
  or Tabtivity quitting. **Default ON** per remote project
  (`RemoteSpec.persist_sessions !== false`; opt out via the pill's "Persistent
  sessions (tmux)"). `ssh_exec::wrap_pty_options` nests the existing `exec …`
  inside `tmux new-session -A -D -s <name>`.
- **Local** (on this machine, Unix only — no tmux on Windows): survives a
  **Tabtivity crash** (the tmux server is a daemon; the PTY only holds a client).
  **Default ON** via `settings.persist_local_sessions`. `services::tmux_local`
  rewrites the local spawn's `{cmd,args}` into a `tmux` argv in
  `commands::terminal::pty_spawn`, *after* the ssh/docker branch so only a
  genuinely local tab is wrapped. The tmux client sends that argv to its
  server in one 16 KB message and exits with `command too long` past it — a
  fenced agent's bubblewrap argv (one mount pair per `~/.claude`/`~/.codex`
  entry and per transcript dir) gets there on a well-used machine. Over a
  budget, the command line moves into `<state_dir>/tmux-launch/<session>.sh`
  and tmux runs the script's path; the script `exec`s the same quoted line.
  Removed with the session (explicit kill, clean quit); a respawn rewrites it.

**A fenced agent's pane ends with the agent** (threat recheck 2026-10-24, gap 43,
decision D3): no trailing login shell — it would run outside the fence and a
phone could type into it with `shell_tabs` off. `tmux_local::local_tmux_args_on_end`
sets `remain-on-exit` on the window instead, so the finished run stays visible
and reattachable but takes no input. The desktop polls `local_tmux_pane_dead`
for a visible local tmux tab and `TerminalDeadPaneCard` offers **Restart**
(`agentClearUndo::relaunch`) and **Open a shell here** (a new shell tab in the
same folder). An unfenced command tab keeps its trailing login shell.

Scoped to **shell tabs** (Python runs open one; a command runs inside the
session's login shell, which outlives it → the run reattaches, not re-runs) and,
**since the remote-agent extension**, to **remote agent tabs** (Claude, Codex,
any SSH-hosted agent). A **local** agent tab is wrapped like any other once it
carries a `tmux_session` name (`launch_prep::prepare` wraps whatever the ssh and
docker branches left local; a fenced agent's pane is the dead-pane case above) —
the claim that a local agent was never wrapped is long out of date, and it is why
a reattached local agent can hold MCP credentials nobody honours
([MCP stamp](#the-mcp-stamp-of-a-local-agent-session)). An agent tab now carries a persisted tmux name
**in addition to** its `--resume` restore, and the two **compose** through
`new-session -A`: when the host session is still alive (the laptop-shutdown case)
the wrap **reattaches** the still-running agent and the `--resume` target is ignored;
when it is gone (host rebooted, session killed) `-A` creates a fresh session that runs
`--resume`, so the conversation resumes exactly as it did before. The agent bootstrap
prelude is nested inside the tmux target unchanged, the same way a shell tab's login
shell is. The session name is a **`tabtivity-<scope>--<kind>-<uuid>` the frontend mints
once per tab and persists** (`TabEntry.tmuxSession`, `lib/terminal/tmuxSession.ts`'s
`newTmuxSessionName`) — *not* derived from the PTY id, which `loadFromLayout`
regenerates on restore (a derived name would fork a second session on relaunch
instead of reattaching); `tmux_attach` overrides it for a Sessions-view attach.
The `<kind>` token (`agent`/`shell`) sits at the *front of the uuid half*, after
the `--`, so it never disturbs the `tabtivity-<scope>--` prefix the project filter
matches on, and a uuid (hex) can never begin with `agent`/`shell` so an older
tokenless name reads back cleanly as neither. `sessionKindFromName` is the pure
inverse, and it is the whole basis of the Sessions view's **second** grouping:
rows are grouped **first by machine** (`tmux-machine-group`), then **by session
type** within each machine (Agents / Shells / Other sub-headings,
`tmux-kind-group`), an empty bucket dropped and `Other` — foreign/legacy/renamed
sessions — shown only when non-empty. The grouping is entirely a function of the
name; the backend `TmuxSession` carries no kind field and did not need one.
**Scoping the Sessions view to one project** (`remote_tmux_list` →
`ssh_exec::filter_sessions_for_project`) matters because the host is usually
shared — a cluster login node carries several Tabtivity projects' runs and other
people's. It reads **two** signals, and the second is the load-bearing one:
the **name** settles a session outright when it carries a project id (this
project's prefix ⇒ shown, `tabtivity-<other-project>--` ⇒ hidden), but that only
ever covers sessions minted *after* the name was scoped. Every session already
running on a host — the `tabtivity-<uuid>` ones — and every hand-started session
carry no id at all, and on a cluster those outlive the change by weeks, so a
name-only rule leaves the view looking exactly as unscoped as before. Those are
attributed by **working directory** instead (`#{pane_current_path}` in
`tmux_ls_script`, `TmuxSession.current_path`): a session whose active pane sits
inside this host's `remote_path` is this project's, one running elsewhere is
not. A row whose host reported no path (older format) is shown rather than
silently dropped. Nothing is unreachable: the view's **"All host sessions"**
checkbox passes `include_all`, returning the host listing untouched, so an
orphaned run outside every project tree can still be attached to or killed.
**An empty list must mean "we asked and there is nothing"**, and for a while it
did not. `tmux_ls_script` ends in `|| true` so an absent tmux or a stopped
server is a clean empty listing rather than an error — but `run_remote_script`
only errors when `ssh` fails to *spawn*, so a failed **login** (exit 255, empty
stdout) parsed to the same empty list, and the frontend poll's `.catch(() => [])`
did the same for a hard rejection. Both said "no persistent sessions on the
host" about a host full of them. It is not a rare path: this probe spawns its
**own** `ssh` riding the shared `cm-%C` socket rather than the pooled session,
so whenever that socket is missing or being replaced (`remote::connect_host`
reopens a master whose socket went away; a sibling teardown, an `ssh -O exit`)
it falls back to a fresh login with no credential to answer, fails for one 7 s
tick and succeeds on the next — a Sessions view that blanks and comes back.
`remote_tmux_list` now returns `Err` on a non-zero exit status, and
`stores/remote/hostSessions`' poll carries a **failed host's previous rows forward**
rather than folding them into the reading; a host that answers with nothing
still empties, or a killed session would never leave the list. This is the same
rule `release` already kept the last reading for.
**Kill vs. detach**: closing a tab **detaches a remote session and ends a
local one**. `lib/remote/closeRemoteTab.ts`'s `closeTabInScope` (the desktop ×,
context menu, close chord, bulk closes, and the phone's ✕ all go through it)
`removeTab`s — killing the ssh/PTY client — and then `local_tmux_kill`s the
local session the tab minted (`mintedLocalSessionOf`; never an attach tab's,
which may be a session made outside Tabtivity). A remote session lives on under
its host's tmux daemon; a crash or a respawn **leaves any session alive**, and
so does an app exit for a **remote** session. A **clean quit ends every local `tabtivity-*` session** —
the window's × runs `local_tmux_kill_app_sessions` before `destroy()`, and
`RunEvent::Exit` runs the same `tmux_local::kill_tabtivity_sessions` as the net for
exits that never reach frontend code (the dev launcher's Ctrl+C: SIGTERM/SIGINT
are routed into `app.exit()` on Unix). Only a crash leaves local sessions
behind, and those are what the next launch reattaches.
A **stopped** agent tab (`docs/context/agent_sessions.md`, "Stopped tabs")
ends its minted local session like a close but keeps the tab; showing it
creates the session afresh on the resume args.
Disconnecting a remote
machine is deliberately different: `remote_disconnect` and
`remote_disconnect_all_hosts` end *every* tmux session on each currently
connected host before tearing down its pool. A session's **×** remains the way to
terminate just that one session (`remote_tmux_kill`/`local_tmux_kill`). Global
machines also issue `remote_kill_all_jobs` before closing their master.
Because a session outlives its tab, a host
can hold runs no tab points at; the **Sessions view** (`☰` toggle in
`ProjectFilesView`, mirrors the Orange view) makes them discoverable —
**multi-host** (aggregated across the primary and every connected worker via
`remote_tmux_list`, each row host-tagged), click a row to attach, per-row **×**
(kill) and **Rename** (`remote_tmux_rename`, updates the owning tab's persisted
name). tmux-absent falls back to today's plain `exec` + a notice.

**Several clients, one session.** A local session can have more than one
client: the desktop window's, the phone's `pty_bridge` attach, and — in the
browser client — one attach PTY per page (`terminal::join_tab`, hosted TODO
#2347; rationale in `docs/context/web_client.md`). Each holds its own PTY and
size; the pane's program sees one size per window, and the wrap sets
`window-size latest` (tmux 3.2+, else `largest`;
`tmux_local::window_size_policy`): the window follows whichever client last
typed, resized or attached, and the others pan or pad until used. A single
client gets its own size under any policy.

## The MCP stamp of a local agent session

A reattach (`new-session -A` finding the session alive) ignores the new command
and `-e` env: the agent keeps the MCP URLs and tokens it was **started** with,
and tokens live only in the starting process's memory. After a crash they belong
to nobody. `docs/done/mcp_reattach_plan.md` is the design; this is how the tmux side
works.

- **The stamp.** A session `launch_prep::prepare` finds absent is created with a
  tmux user option, `@<slug>_mcp = <nonce>:<grant>:<port>` (`root_mcp_mark`):
  `nonce` is random per listener (`Runtime::generation`, new on every start),
  `grant` the `Session::id` (SHA-256 of the token) of the first revivable lane
  (`root_mcp_reattach::stamp_grant`; any lane when none is revivable, `-` for a
  spawn granted nothing), `port` the listener's. It rides `PtyOptions::mcp_mark`
  (`#[serde(skip)]`: a payload cannot stamp a session) as one more command of the
  same tmux argv (`tmux_local::mcp_mark_args`, appended in `local_tmux_argv`). A
  launch that reattaches carries no mark, so the stamp is the one the session was
  created with. Create-vs-attach is decided in Rust from one listing; a second
  launch inside the cache's life sees the new session because `commit` notes it
  (`SessionMux::note_mcp_mark`). The listing can be stale by then (the Mobile
  host created the session inside the 3 s cache, or two spawns of one id raced),
  and `new-session -A` then attaches: the stamp is `set-option -q -o`, which sets
  the option only where it is unset and fails silently otherwise, so an attach
  never overwrites the stamp of the grant its agent holds (R1's race; the tmux
  equivalent of the Windows host's `Created::New`). Residual: a session made by
  a build before stamps (no stamp at all) that loses that race is stamped by the
  attach.
- **One listing per restore.** `SessionMux::mcp_marks()` is one
  `tmux ls -F '#{session_name}\t#{@<slug>_mcp}'`, cached about 3 s behind a single
  flight (the lock is held across the `tmux ls`), dropped by `kill`, `rename`
  and the quit reap. The AI switch's rejoin is never judged from it: with
  AI off a launch goes through only when the mux's live `has` finds the session
  (`launch_prep::local_session_live`), and is then attach-only. Its plan reads
  the listing again past the cache when the cached one does not name the
  session yet (`SessionMux::fresh_mcp_marks`), and a create verdict for an
  attach-only launch becomes NoGrant (`launch_prep::attach_only`): an attach
  never hands the agent its environment, so nothing is minted or recorded for
  nobody. A private socket (a test) is never cached. A backend that cannot answer (the trait default,
  `Unavailable`) is "unknown": the launch grants as before and `has` answers the
  rejoin.
- **Windows session host.** The same stamp rides the host's create-or-attach
  `Spawn` (`mcp_mark`, kept only when that `Spawn` creates the session, at most
  256 printable ASCII bytes) and comes back in one `List` (`SessionInfo::mcp_mark`;
  `WinHostMux::mcp_marks`, the same 3 s cache per pipe). Additive, no protocol
  bump: a host announces `CAP_MCP_MARK` (`"mcp-mark"`) in `Welcome`, and a host
  without it (an older one still serving its sessions) is "unknown", never
  "no stamp", so its tabs are never flagged stale on a guess
  (`session_host::route::marks_answer`). No host running is "none" (stamp the
  create) only while the setting is on; off, no session will exist, so
  "unknown". The stamp never reaches `sessions.json`.
- **The verdict** (`root_mcp_mark::classify_reattach`, pure):

  | Session | Verdict | Grant | Tab |
  |---|---|---|---|
  | absent, or backend cannot tell | Create | as ever, then stamp | tools |
  | no stamp (older build, hand-made) | Stale | none | flagged |
  | stamp, no grant (`-`) | NoGrant | none | nothing to report |
  | this run's nonce, grant still held | Live | none; `TokenStore::adopt` re-keys the held lanes to the new PTY id | tools |
  | this run's nonce, grant gone | Stale (or revived, below) | none | flagged |
  | another nonce on this listener's port, grant held here (revived), previous run within the cap | Live | none; adopted | tools |
  | another nonce on this listener's port, otherwise | Stale (or revived) | none | flagged |
  | another nonce, listener confirms | Live | none | tools |
  | another nonce, no confirmation | Stale (or revived) | none | flagged |

  The confirmation is `GET /mcp/grant/<hash>` on the stamp's port
  (`probe_grant`, 300 ms for connect and answer; no answer is Stale), served by
  every listener, 204 or 404, no credentials. A stamp on this listener's own
  port is never probed (it would ask itself), and neither is one on the port
  this listener remembered but lost (whoever took it would answer). Nothing is
  minted for Live or Stale: the session ignores a new environment, and
  `TokenStore::register` would revoke the running agent's tokens (it replaces a
  tab's token per lane).
- **Revival** (Phase 2, `root_mcp_reattach`, `docs/context/agent_mcp_wiring.md`
  §5). A Stale verdict whose session has a row in this listener's reattach
  record is revived when every guard holds: the remembered port bound on the
  first try, the stamp's and the row's port this listener's, the stamp's nonce
  the row's and that one this run's or the previous run's of the same
  listener, the downtime under 30 minutes, the stamp's grant the row's, and the
  CLI one that reconnects. The launch then grants as a create, and after the
  fence each fresh session whose identity matches the recorded one takes the
  recorded hash; the rest are revoked and the fresh tokens are stripped from the
  attach's environment. Only cockpit, help, markup and print come back
  everywhere; git and tabs only on Linux, where a revived token is honoured
  only over a connection held by processes of the session's own pane tree
  (`root_mcp_reattach::peer_in_session`, else `401`). A reviving launch only
  attaches (`host_attach_only`; on tmux the argv becomes the attach client's,
  `launch_prep::attach_only_client`): a session that ended since the listing
  is never created again, the tab's client exits, and the commit drops the
  row. At commit the session is re-stamped with this run's
  nonce (`SessionMux::restamp_mcp`, `set-option -t =<name>:`; the Windows host
  cannot, so its revived sessions are found by their grant on the own port
  instead, only while the previous run's 30 minutes last, and are not revived
  by a later run). A recorded lane that does not come back (schedule, root, git
  and tabs off Linux, a lane switched off, a changed identity) leaves the tab
  Stale.
- **The record's lifecycle** follows the session: `local_tmux_kill` drops the
  row, `local_tmux_rename` re-keys it, the Sessions view's end-all clears the
  rows, the clean quit deletes the file (`commands::root_mcp::stop_for_exit`), and
  the listener's heartbeat (at start, then every 5 minutes) refreshes
  `last_alive` and drops rows of sessions the backend no longer lists. A PTY
  teardown (`root_mcp_review::on_tab_gone`) only releases the tokens in memory
  (`release_tab`), so a reattach later in the same run is revived from the row;
  a revoke (`revoke_tab`, `revoke_session`) drops the hashes for good.
- **Stale** sets `PreparedLaunch::mcp_stale` -> `pty_spawn`'s answer carries
  `mcpStale`, and `root_mcp::tab_stale` makes `servers_of_tab` empty and
  `agent_features` report `appMcpStale`. A revived tab can also go stale
  later: when the peer check refuses a revived token because no holder of
  the client socket can be read (`loopback_owner::PeerTree::Hidden`, a
  non-dumpable CLI), `commands::root_mcp::admit_with` sets
  `root_mcp::mark_tab_stale` and rings `root-mcp-sessions-changed` with
  `{ "staleTab": <PTY id> }` once; the terminal's store
  (`stores/agents/mcpStale`, listening while an agent terminal is mounted)
  raises the card and the bulk toast. A peer seen outside the tree does not
  flag the tab. The flag lives until the tab's next launch or its
  teardown (`root_mcp_review::on_tab_gone`). What the user can do about it is the
  frontend's Reconnect (kill the session, relaunch with the CLI's resume).
- **Stable port.** The window binds `<state_dir>/root_mcp/port` (0600) with a
  synchronous std bind before restored tabs spawn, falling back to a free port
  (never the Mobile host's remembered one) and logging the holder. The Mobile
  host (and a server daemon) remembers its own in `<state_dir>/root_mcp/host-port`
  and binds it first, never the window's (`bind_host`, `bind_avoiding`). This
  keeps a stale agent's URLs pointing at this program and fixes the old startup
  race (a tab restored before the async bind got no lanes). Any fallback purges
  that listener's reattach record.
