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
the sidecar runs. It is additive — the Tauri window behaves as before — but
the two processes share one state dir with separate in-process registries,
so what both can run is coordinated across processes (below).

## One state dir, two processes (final review B4)

The window and the sidecar each keep their own registries (containers, VMs,
sync loops, manifest cache). Without coordination a browser's project switch
removed the window's running container, the window's start-up sweeps reaped
the sidecar's containers and VMs, and both ran one remote project's sync
loops against one mirror and one `sync.json`. Now:

- **Leases** (`services::process_lease`, advisory file locks under
  `<state_dir>/leases/`, gone with their process): a container is *held*
  (shared) by every process with tabs in it and removed — by a switch, an
  exit or a start-up sweep — only when no other process holds it; `up`
  refuses to recreate one the other still uses. A VM is *claimed*
  (exclusive) by the process that boots it: the other one is refused, and
  never reaps it. Each remote project's auto-sync and lockstep loops run in
  the one process that claimed them; the other skips starting them.
- **`sync.json` is compare-and-swap across processes** (G7 for real): under
  the file's lock, a manifest is written only while the file is still the
  version this process's cache read; otherwise nothing is written, the cache
  re-reads, and the caller gets "changed by another window — try again".
- **Shared writers locked across processes**: an agent home's preparation
  (seeding, global layer, hooks, logins), every `agent_auth` adopt/place
  step, `exec_trust` approvals (`patch_json`); settings, tab sessions and the
  other `patch_json` stores already were.
- Refusal rather than routing: a VM the window runs cannot be used from the
  browser (and the reverse) until the owner shuts it down. Not covered: a
  browser opening a local-tmux tab the window has attached gets its own
  attach client (#2358 covers only the shared-PTY case).

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
- **The model allowlist is a check at the request, not a UI filter and not a
  settings guard.** Ollama loads whatever a request names, so on a server
  every request that names a model is held to the admin's policy list —
  unset meaning "what the admin pulled" (the admin's pull is the act of
  allowing): the dispatcher's `complete_text`, `prepare_local_agent`,
  `prepare_local_launch` and `ensure_vibe_ollama_model`, and `mail_ai::chat`
  (summaries, drafts and the classifier every inbox sync runs; final review
  A1 — the P2 review's "the browser cannot write the model" was wrong:
  `patch_settings` is `core` and must stay so, being the browser's only
  settings write). The dispatcher runs it off the async workers, the
  installed list asked within 2 s and reused for 5 s, a wedged Ollama
  answering `ollama-unreachable` (B6). On a server `ollama_host` and
  `ollama_allow_remote_host` are ignored (`ollama::host_setting`): the
  endpoint is the shared loopback Ollama, so a user can neither egress
  elsewhere nor aim the daemon at another account's loopback port (A2). The
  desktop — window and sidecar — never checks and keeps both settings. The
  root MCP's local-model lane (#2339) must call `check_model` once the daemon
  serves it.
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
  attached, it is handed to that client and sized like its attach. When the
  last client leaves, it is left to nobody (`PtyMeta::client = None`)
  instead of ended: the tmux session lives on, and so does the tab's
  bookkeeping (an agent's MCP grants above all — ending the PTY revoked them
  under the running agent, and a later page's respawn minted ones it never
  saw); the next page attaches to it, and the session's end (a tab close,
  the agent exiting) or a clean stop ends it (#2347 review). A shared PTY
  (below) whose spawner leaves passes to a page still viewing it rather
  than being killed under it. A client never addresses another client's
  attach PTY by its id, nor spawns over one. A remote tab (ssh, whose wrap is `new-session -A -D`), a container
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

## The desktop's Connect mode (P5, plan §7.2)

The desktop app as a client of a server, in a **Connect** window beside its
own standalone workspace (Q12). As built:

- **The code is the app's, not the server's.** §7.2 says the shell "loads the
  same web bundle from the gateway". It does not: the Connect window loads
  *this binary's* `index.html?connect=1` (`main-connect.tsx`). Loading the
  server's bundle would give a remote origin the window's IPC — any XSS on the
  server, or the server itself, would then run with this desktop's native
  commands; the capability files forbid a `remote` entry for that reason.
- **A narrow native surface** (user decision, P5 review finding 10). The
  window has its own capability, `capabilities/connect.json` (window
  controls, notifications, the events its bridge needs — no dialog, drag,
  path, app, menu, tray or webview creation; `default.json` no longer
  reaches it), and its app commands are narrowed in Rust before they run:
  `commands::connect::gate_connect_window` wraps the invoke handler and
  admits only `CONNECT_WINDOW_COMMANDS` (the socket bridge, the download
  opener, `open_external_url`, the clipboard). A script injected through
  server-rendered data, or a co-member's file, reaches nothing else of the
  desktop's IPC. A Tauri app-manifest ACL would do the same but needs every
  one of the main windows' ~1000 commands listed; the wrapper keeps those
  untouched.
  Cost: the desktop and the server must speak the same protocol version (the
  `hello` says which), as the phone and its host already must.
- **The socket is Rust's** (`services::connect`, `commands::connect`). The
  window's origin is the app's, so it cannot carry the server's
  `SameSite=Strict` session or pass the socket's exact-`Origin` check. The
  backend signs in with the device key (challenge, raw `r‖s` signature,
  session) and opens `wss://…/api/v1/desktop/ws` with the cookies, the
  server's own `Origin` and the desktop subprotocol, over the app's
  tokio-rustls stream (platform verifier). Frames are bridged both ways:
  `connect_ws_open` (on an event name the window registered first, so the
  `hello` is never emitted unheard), `connect_ws_send`, `connect_ws_close`;
  binary frames as base64. Only the `connect` window may use them.
- **Pairing** is the browser's: an invite code (`user:digits`) pairs a P-256
  key generated in Rust, kept in `<state>/connect/device.key` (`0600`,
  PKCS#8; the state dir is masked in every fence). The server sees one more
  device. **Forget** removes the key and the record here; revoke the device
  on the server too.
- **Its own webview profile** (`<state>/connect/webview`, Linux and Windows;
  macOS shares the profile — #2379): the server's frontend state never mixes
  with the standalone workspace's local storage.
- **Native where it is the user's machine**: `wsInternals.ts` takes the
  window's own Tauri internals (captured before the shim replaces them) and
  answers `CONNECT_NATIVE` client commands (clipboard, `open_external_url`)
  and the window and notification plugins natively;
  `open_file` asks the server for a download ticket and
  `connect_open_download` fetches it (the server's host, `/content/` only,
  a safe file name — no Windows stream, device or trailing dot either —
  never overwriting) into `~/Downloads` and opens it with the system's
  default app only when it is an inert viewer type
  (`connect::opens_as_inert_viewer`: an allowlist of documents, pictures,
  plain text, media; never a program per `opens_as_program`); anything else
  is kept and shown in its folder — the server or a co-member named it, and
  a denylist misses what nobody foresaw (`.terminal`, `.fileloc`,
  `.library-ms`, `.iso`, extensionless scripts; final review A4). On Windows
  the file gets the Mark of the Web (`Zone.Identifier`, Internet zone). Every other command routes exactly as in a
  browser (`core` to the server, other `client` commands to the browser
  adapters).
- **Not built**: popouts and the presenter of the Connect window (the adapter
  answers them as a browser does), native print of a server file, the
  desktop's own shortcuts outside the window, a sign-out in the Connect
  window (WebShell's sign-out navigates to `/desktop/`, which the Connect
  window does not serve) — #2379.

## Not done (TODO group Z, #2341–#2346, and #2339)

Popout windows (`?popout=`), browser shortcut alternatives for Ctrl+T/W/N,
`pdf_clip_*`/`run_script_detached`, a stale-bundle notice, the CSP and
security review — and the root MCP lane in the sidecar (#2339: starting a
second root listener would sweep a running window's review sandboxes). The
sidecar's own listener serves the schedule, push and help lanes; a server
daemon's serves the markup lane too (2026-10-11), so the browser client's
markup view and the phone read the asks its tabs make.
