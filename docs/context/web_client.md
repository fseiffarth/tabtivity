# The browser desktop client — why it is the way it is

*Hosted plan P2 (`docs/tabtivity_hosted_plan.md` §3.5, §7.1, §10), built
2026-10-03 on branch `hosted`; per-client PTYs (#2347) the same day;
nothing run live. Handoff:
`docs/hosted_handoff.md` § P2. Files: `src-tauri/src/services/mobile_control/web_client.rs`,
`src-tauri/src/services/core_dispatch.rs` (+ `build.rs`),
`src-tauri/src/services/model_allowlist.rs`, `src-tauri/src/services/pick_grants.rs`,
`src/main-web.tsx`, `src/lib/transport/*`, `src/web/WebShell.tsx`,
`src/components/common/ServerFilePicker.tsx`, `vite.web.config.ts`.*

## What it is

The desktop React app, unchanged, in an ordinary browser on the same machine,
served by the Mobile sidecar (`tabtivity --mobile-host`) at
`http://127.0.0.1:<port>/desktop/`. Every `invoke()` and `listen()` reaches a
`window.__TAURI_INTERNALS__` the web entry installs over one WebSocket; the
sidecar calls the same command bodies the window registers with Tauri. The
browser is a thin client: terminals, agents, files, git and mail run where
the sidecar runs. It is additive — the Tauri window behaves exactly as before.

## Decisions

- **The dispatcher is generated, not written.** `build.rs` parses every
  `src/commands/*.rs` with `syn` and emits one JSON-args wrapper per
  `#[tauri::command]` whose parameters are a `Ctx` and plain values, reading
  each argument under the camelCase key Tauri uses (its default
  `rename_all`) and letting the call infer the type, so a type a command file
  imports privately needs no path. A command still taking `State`,
  `AppHandle`, `Window` or a raw IPC body is listed with the reason and hidden
  through `server_capabilities`. One table cannot drift from
  `generate_handler!`; `core_dispatch::tests` names every `core` row with no
  wrapper (`KNOWN_GAPS`) so a file sliding back to Tauri fails loudly.
- **The class check comes before the arguments.** `core_dispatch::refusal`
  answers unknown / client / admin-for-a-user / off before any argument is
  parsed (P0 handoff). A refusal is `{code, reason?}`; a command's own error
  is whatever it was.
- **The model allowlist is a dispatcher hook, not a UI filter.** Ollama loads
  whatever a request names, so `complete_text`, `prepare_local_agent`,
  `prepare_local_launch` and `ensure_vibe_ollama_model` are held to
  `Settings.ollama_allowed_models` — unset meaning "what the admin pulled"
  (the admin's pull is the act of allowing) — before the body runs. The
  desktop window never checks (server mode is additive). P3 adds the UI.
- **Sessions and login are the browser's own**, separate from the phone's
  `AuthStore`: a different cookie (`<slug>_desktop_session`, no `__Host-`
  because loopback is plain http and that prefix needs `Secure`), a different
  way in (`<control_dir>/web-client.token`, `0600`, the same trust as the
  admin socket next to it — the whole state dir is a tmpfs inside every agent
  fence), and nothing of one is ever accepted by a route of the other.
  Ten failed logins in a minute lock the login route for a minute.
- **Localhost only, enforced per route.** Every `/desktop/*` route and the
  content origin refuse a `Host` that is not a loopback literal on the
  expected port; the socket also requires `Origin` to be `http://` + that same
  host. Tailscale Serve forwards with the tailnet host, so through it the
  routes do not exist. The CSP review and the §11 security review are the
  gate before anything beyond localhost (TODO #2341).
- **The user-content origin is the next port.** Plan §3.5 asks for ticketed
  files on a separate origin with `CSP: sandbox`; on loopback a second port is
  the one unambiguous way (host-name tricks like `localhost` vs `127.0.0.1`
  are two origins too, but a user can open the app on either). Active types
  (HTML, SVG, XML, JS) go as attachments. Tickets live five minutes.
- **Reconnect resumes the client id.** `web-<n>` is also the "window label"
  the terminal router keys viewer registrations by, and the owner the PTY
  registry records for every PTY the client spawned (`PtyMeta::client`), so a
  page that lost its link and comes back with `?resume=<id>` inside
  `RESUME_GRACE` (90 s) keeps its views and its PTYs; a client gone for
  longer has its views dropped and its PTYs released
  (`PtyRegistry::release_client`) — they are tmux clients, the sessions live
  on. A PTY id another page re-spawned meanwhile is recorded as that page's
  and is left alone (P2 review finding 1, now by construction). The page side
  (`terminalBus`) remembers each pane's last end offset and replays only what
  lies past it from `pty_scrollback` — the client's own stream's tail.
- **One PTY per client on a shared tab (#2347).** The tab set is shared and
  the terminal size is per client (plan §3.4–3.5), but a PTY has one size: a
  second page that re-spawned an open tab used to replace the first page's
  PTY and the two then fought over `pty_resize`. Now, when a server client
  (`Caller::Client`) spawns a tab whose PTY is alive, a client of a *local
  tmux* session and another client's, it gets an attach PTY of its own,
  `<tab>@<client>`: `tmux -u attach-session -t =<session>`, never a new
  session, none of the tab's spawn bookkeeping (fence, MCP grants, Codex
  binding, `agent_turn`), `pty_spawn` answering `attached` so the pane types
  no launch line into the running program. The frontend still names the tab
  id everywhere: the `pty_*` id commands resolve a client's id to its own
  PTY (`PtyRegistry::resolve`, including a view registered just before the
  spawn), and the attach PTY's events carry the tab id. The tab's own PTY
  keeps the tab's identity (tab id, session name, agent records, Reader,
  scheduler); when its client leaves for good while another client is still
  attached, it is handed to that client and sized like its attach, so the
  bookkeeping (an agent's MCP grants above all) lives as long as somebody
  looks. A remote tab (ssh, whose wrap is `new-session -A -D`), a container
  tab and every tab on Windows keep the single shared PTY: nothing there to
  attach a second client to.
- **The window follows the client in use: `window-size latest`.** The
  program in the pane sees one size per window, so the choice is whose.
  `largest` (what the wrap set before) panned every smaller client across a
  window sized for the widest — a narrow page saw a cut-off slice;
  `smallest` padded the larger ones and, with the phone adopting the window's
  geometry, could never grow again; `aggressive-resize` only weighs clients
  looking at a window, which all of these are. `latest` — tmux's own default
  since 3.1 — gives whichever client last typed, resized or attached an
  exact fit, and the others pan or pad until they are used. With the phone
  it changes nothing (it resizes only to the window's size), and one client
  alone gets its own size under any policy, so the single desktop window is
  unchanged. Set from tmux 3.2 (the version the wrap already probes), else
  `largest` (`tmux_local::window_size_policy`).
- **A server client's events are addressed (#2345).** A PTY event raised
  for a `Caller::Client` (`terminal-output`/`-replay`/`-ready`/`-exit`/
  `-activity`) is serialized once and delivered under its plain name to each
  client with a view of that PTY, and to nobody else. The desktop keeps
  broadcasting with `:<label>` copies for popouts (`emit_output`), which a
  browser page never subscribed to.
- **Backpressure sheds events, never answers.** Each client has a bounded
  event queue (`EVENT_QUEUE` frames); a full queue drops the event and counts
  it — terminal output is shed oldest-first as `pty_bridge` sheds it, TUIs
  repaint, a pane can catch up. Answers to calls travel on their own channel
  bounded by the calls in flight (`MAX_CALLS_IN_FLIGHT`), so a slow screen
  never loses a `ret`. While the link is down the page sends nothing: every
  pending call rejects with `DisconnectedError`, and `setInterval` callbacks
  are skipped (plan §3.5's poller pause), so 83 pollers go quiet instead of
  each raising an error.
- **Bytes never cross as JSON arrays.** `write_file_bytes` goes as a binary
  frame (`[kind][u32 id][u32 hlen][header JSON][bytes]`), `read_file_bytes`
  answers one; `fs::read_file_bytes_for` / `write_file_bytes_for` are the
  entry points with the same confinement as the IPC shapes.
- **The file picker browses the server.** A browser `<input type=file>` would
  pick from the laptop, the wrong machine. `ServerFilePicker` browses the
  server's filesystem through `list_dir_all` (unconfined, like the folder
  picker's `list_dirs` — the OS dialog it replaces was not confined either).
  `commands::mail` names no location the frontend controls (its rule 2, held
  by `no_command_takes_a_path`), so a mail pick is turned into a single-use
  **grant** the transport mints for that path (`desktop_file_grant`,
  `services::pick_grants`) and the `*_grant` mail commands redeem it: the
  mail subsystem's reach stays "what the user picked a moment ago".
- **`HOST_OS` vs `CLIENT_OS`.** `lib/platform.ts` keeps `IS_WINDOWS`/`IS_MAC`/
  `IS_LINUX`/`PLATFORM` as the client's OS and adds `HOST_OS`/`IS_HOST_*`
  for the backend's. The web entry awaits the server's `hello` and stores
  `hostOs` on the window *before* any app module loads, so the constants are
  right at import like the others. The audit moved tmux persistence and
  close, path separators, install commands and shells, the sign-in terminal,
  the fence hint and script runners to the host; keys, chrome and drag stay
  with the client.
- **One user, role admin.** P2's user owns the box: every web session runs
  with `Role::Admin`, so admin commands (model pulls, CLI installs) are
  served. P3's gateway assigns roles per account; the gate already exists.
- **`switch_project_runtime` is split, not reclassified.** It hides and shows
  OS windows (client) *and* runs the project's name migration, layout save,
  session load and event (backend). `switch_project_session` is the backend
  half; the browser shim answers the client command with it.

## Not done (TODO group Z, #2341–#2346, and #2339)

Popout windows (`?popout=`), browser shortcut alternatives for Ctrl+T/W/N,
`pdf_clip_*`/`run_script_detached`, a stale-bundle notice, the CSP and
security review — and the root MCP listener in the sidecar (#2339: starting a
second listener would sweep a running window's review sandboxes).
