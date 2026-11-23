# Windows session host — plan

> **Status (screened against code 2026-11-22):** PARTIAL. P0–P3 are in code: `src-tauri/src/services/session_mux/` (`tmux.rs`, `winhost.rs`), `services/session_host/` (`protocol.rs`, `server.rs`, `table.rs`, `client.rs`, `win/{conpty,job,pipe}.rs`, `launch.rs`), pipe-backed PTY instead of an attach client (see "P0 outcome"). P4 (shells, local Sessions view on Windows, flag default on) is open per `todo/group-h-crossplatform.md` 31g-1; the flag `windows_session_host` is still off by default. Line numbers below are stale; re-grep. Not run live on Windows.

## Problem

Tabtivity Mobile reaches a desktop tab only through tmux: local tabs run
inside a tmux session, and the sidecar attaches its own tmux client, captures
scrollback, reads the window size and types scheduled prompts with
`send-keys`. tmux also keeps a tab alive with no window (headless spawn,
scheduler) and across a desktop crash. Windows has no tmux: desktop tabs are
portable-pty ConPTYs inside the desktop process, every `tmux_local` entry point
no-ops, and `discovery::terminals_support_on` (`discovery.rs:1470`)
hard-codes `unsupported` for any Windows build. Installing tmux (MSYS2/WSL)
would not help — it cannot reach the desktop's ConPTYs.

Goal: agent tabs on the phone on Windows, with the same semantics as Unix.

## Decision

A **session mux** trait in front of every local tmux use (tmux backs it on
Unix, unchanged) and, on Windows, a **native session host**: a persistent
process that owns ConPTYs and plays tmux server's role over a named pipe.

Rejected:
- *Desktop relay* (stream the desktop's ConPTY over the existing desktop
  bridge): smaller, but the phone loses tabs whenever the window is closed, and
  headless create, the no-window scheduler and crash survival stay broken.
- *Bundling a Windows tmux* (Cygwin/MSYS2 or a port): native console CLIs
  (`claude.exe`, node) are unreliable under a Cygwin pty; a third-party runtime
  to ship and update; against the one-click install rule.

## 1. Session mux trait — `services/session_mux/`

`mod.rs` (trait, types, shared `normalize_scrollback`, `mux()` selector),
`tmux.rs` (`TmuxMux { socket, isolated }` — `isolated` reproduces tests'
`-L x -f /dev/null`), `winhost.rs` (`cfg(windows)`, `Unavailable` until the host
lands). AppHandle-free, builds in the daemon (`--no-default-features`). Sync
and blocking, `Arc<dyn SessionMux>`: today's callers already sit in
`spawn_blocking` / `rt::blocking`.

```rust
pub trait SessionMux: Send + Sync {
  fn kind(&self) -> MuxKind;                 // Tmux | WinHost -> phone `terminals`
  fn available(&self) -> bool;
  fn wrap(&self, opts: &mut PtyOptions);     // create-or-attach launch; marks opts as mux-backed
  fn spawn_detached(&self, opts: &PtyOptions) -> Result<(), MuxError>;
  fn attach_client(&self, name: &str, for_phone: bool) -> Result<ClientCmd, MuxError>;
  fn prepare_viewer(&self) {}                // keep_dim; no-op on WinHost
  fn list(&self) -> Result<Vec<SessionInfo>, MuxError>;   // name, created, activity, attached, cwd, cmd
  fn has(&self, name: &str) -> Result<bool, MuxError>;
  fn pane(&self, name: &str) -> Result<PaneInfo, MuxError>; // dead, pid, created, activity, (cols,rows)
  fn screen(&self, name: &str) -> Result<String, MuxError>;
  fn scrollback(&self, name: &str, lines: usize) -> Result<Vec<u8>, MuxError>;
  fn send_keys(&self, name: &str, keys: &[Key]) -> Result<(), MuxError>; // Named | Ctrl(char) | Literal
  fn paste(&self, name: &str, text: &str, bracketed: bool) -> Result<(), MuxError>;
  fn env_text(&self, name: &str) -> Option<String>;
  fn kill(&self, name: &str) -> Result<(), MuxError>;      // already gone ⇒ Ok
  fn rename(&self, old: &str, new: &str) -> Result<(), MuxError>;
}
enum MuxError { NoServer, NotFound, Unavailable(String), Refused(String), Io(String) }
```

Semantics every backend keeps:
- Names validated by `ssh_exec::valid_tmux_session_name`; matching is always
  exact (tmux impl adds `=`).
- `wrap`/`spawn_detached` are create-or-attach: an existing session ignores the
  new command and env. Detached create takes cols×rows (200×50 headless).
- Attach never evicts; the window follows the latest client to type/resize/
  attach (`window_size_policy`, `largest` fallback); the phone adopts
  `pane().window`.
- End of command: fenced → remain-on-exit (dead pane, no input); `ends`
  (assistant chat) → session ends; unfenced → trailing login shell.
- Scrollback ≤ `TMUX_HISTORY_LINES`, wrapped rows joined, SGR kept, stops one
  line above the visible screen; LF→CRLF via `normalize_scrollback`.
- Under flood the server never drops bytes mid-stream: it back-pressures, then
  discards and repaints the whole screen (tmux `tty_block_maybe`;
  `pty_bridge.rs:539` relies on it).
- `list`: `Ok(vec![])` on `NoServer`, `Err` otherwise (the `CatalogCache`
  contract). `kill` maps "already gone" / `NotFound` to `Ok`.

`tmux_local` stays as the argv library (remote uses it). Remote/SSH tmux
(`AttachTarget::Host`, `ssh_exec::host_*`, `wrap_pty_options`, `remote_tmux_*`,
`host_live.rs`) stays out of the trait.

### Inventory of local tmux call sites

- Create-or-attach wrap: `tmux_local::wrap_pty_options_local` (`tmux_local.rs:781`),
  `local_tmux_argv` (:800), `local_tmux_args_on_end` (:544), launcher script
  past 12 KB (:805). Callers `launch_prep.rs:1577`, `terminal/mod.rs:1252`.
- Detached create: `spawn_detached_with` (:890) ← `mobile_control/host.rs:170`
  (`HeadlessSpawner`, used by `headless.rs` `launch_minted`/`create_chat`),
  `agent/assistant_model_probe.rs:178`.
- Attach client: `attach_argv` (:697) ← `commands/terminal.rs:78`,
  `terminal::join_tab`; phone `pty_bridge::tmux_attach_command` (`pty_bridge.rs:343`).
- Probes: capture / window size / `keep_dim` (`pty_bridge.rs:380–448`).
- Screen (`capture-pane -p -J`): `terminal.rs:285`, `pty_bridge.rs:279`
  `send_now`, `claude_token.rs:333`, `assistant_model_probe.rs:277`.
- Input: `scheduler.rs:414` (`send-keys C-a C-k`, `load-buffer` +
  `paste-buffer -r [-p]`, `Enter`), `pty_bridge.rs:289`.
- Session facts: `scheduler.rs:397`, :463 (`pane_pid`), `agent_fence.rs:2921`.
- Pane dead: `terminal.rs:261`. Has-session: `tmux_local::app_session_alive`
  (:171) ← `launch_prep.rs:1639`.
- Listing: `discovery.rs:1441` `live_tmux`, `agent_privacy.rs:1215/1289`,
  `api_proxy_port.rs:111`, `services/api/api_proxy.rs:288`.
- Kill/reap/rename: `terminal.rs:202/306`, `kill_app_sessions` (:115, also
  `lib.rs:2917` clean quit), `scheduler.rs:458`, `agent_privacy::end_sessions_in`,
  `api_proxy_port.rs:147`.
- Availability gates: `tmux_available` at `boxes.rs:716`, `projects.rs:2314`,
  `terminal.rs:208–310`, `api_proxy.rs:211`; `terminals_support_on`;
  `host_tabs_on` (`discovery.rs:1540`, tied to "no ControlMaster on Windows",
  not tmux — split it); `cfg(unix)` in `host.rs:165/188`; `cfg!(windows)`
  early returns `scheduler.rs:398/459`.
- Implicit detection: `terminal/mod.rs:1926` (`PtyMeta.local_tmux` from
  `opts.cmd == "tmux"`), `is_tmux_wrapped` (:857) → replace with an explicit
  `PtyOptions` marker set by `wrap`.

**Found bug (verified):** `api_proxy::live_tmux_sessions` (`api/api_proxy.rs:288`)
runs a bare `tmux ls` without `tmux_local::socket_args()`, so in server mode it
lists the wrong tmux server. Fixed for free when it moves onto the trait.

## 2. Windows session host — `services/session_host/`

### Process

- Same binary, `--session-host`, dispatched in `main.rs` beside
  `--mobile-host`. Runs from its own copy `<control_dir>/session-host/<version>/`
  — not `bin/<version>/` (`prune_old_versions` and a mobile update would kill
  it) and not the installed exe (the updater replaces it). Its prune skips the
  running version.
- Lazy start, no Run-key autostart (sessions die at logoff anyway): the first
  client gets "no such pipe", starts the host `DETACHED_PROCESS |
  CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB`,
  retries ≤ 3 s. Either the desktop or the sidecar may start it.
- Single instance: `first_pipe_instance(true)` + a `Local\` mutex named by a
  state-dir hash; the loser exits 0.
- Version skew: integer `PROTO` negotiated in `Hello` + capability strings. A
  newer client speaks the older host's level; a host below the client's
  minimum is retired only when idle (`Shutdown{if_idle}`). Running agents are
  never killed for an update.
- Idle exit after 60 s with no sessions and no connections. A desktop clean
  quit sends `KillPrefix{LOCAL_TMUX_PREFIX}` (the `kill_app_sessions` twin).
- Host exit ⇒ its sessions die (`KILL_ON_JOB_CLOSE`), like a tmux server crash.
  It writes `session-host/sessions.json` (name, cwd, created); desktop restore
  respawns through `agent_session` `--resume`.

### Protocol (pure, `protocol.rs`)

Length-prefixed frames, 1-byte kind (0 JSON control, 1 output, 2 input), ≤ 1 MiB;
`serde(tag)` with an `Unknown` variant → `Error{unsupported}`.

- `Hello{token, proto_min, proto_max, client_version}` → `Welcome{proto, host_version, pid, caps}`.
- `Spawn{name, argv, env, cwd, cols, rows, remain_on_exit, size_policy, create_only, mcp_mark?}`
  (create-or-attach; `mcp_mark` is kept only on a create and listed back in
  `List`, behind the `mcp-mark` cap: `docs/context/tmux_sessions.md`), `Attach{name, cols, rows, history_lines}` (connection
  becomes a stream), `Resize`, `Input{bytes}`, `Paste{text, bracketed}`,
  `Capture{name, join_wrapped, history_lines}`, `Info{name}`, `List`, `Kill`,
  `KillPrefix`, `Rename`, `Shutdown{if_idle}` → `Ok{..}` / `Error{code,msg}`.
- Stream events: `Snapshot` (screen + history, under the same lock as the live
  fan-out, so no gap), `Output`, `Exit{code}`, `Dead`.

### Per session

- ConPTY. `argv[0]` must be absolute; the host never searches PATH (no planted
  binary). Env is exactly what the client sends; carry `PATH` explicitly
  (`launch_prep.rs:1571` server case). Env travels over the pipe, never argv.
- Subtree reaping: Job Object, `Kill` = `TerminateJobObject`. Assigning after
  `CreateProcess` races grandchildren: (a, preferred) own ConPTY spawn with
  `PROC_THREAD_ATTRIBUTE_JOB_LIST`; (b) portable-pty through a `--session-exec`
  shim that waits for `IsProcessInJob`.
- Screen: a `vt100` parser per session (real screen, `Capture` joins wrapped
  rows like `-J`) + a 4 MiB raw byte ring. vt100 is ~40 B/cell: measure; may cap
  history near 2k lines.
- `Paste{bracketed}` wraps in `ESC[200~…ESC[201~` only when the screen has mode
  2004 (`paste-buffer -p`); newlines pass through (`-r`). `C-a C-k`, `Enter`
  map to bytes in the trait layer.
- `remain_on_exit`: exited child keeps its screen, `dead`, refuses input.
- Resize policy `latest`/`largest`, pure in `table.rs`.
- Backpressure: the ConPTY reader never waits on clients; each client has a
  bounded queue; overflow drops that client's queue, marks it behind, sends a
  full repaint when it catches up.
- `List` cwd: spawn cwd, updated from OSC 7 / OSC 9;9.

### Security

- Pipe: explicit protected DACL `D:P(D;;GA;;;NU)(A;;GA;;;<user SID>)(A;;GA;;;SY)`
  (deny first: Windows stops at the first ACE that grants access)
  via `create_with_security_attributes_raw`, remote clients rejected; no
  AppContainer/restricted SID, so a future sandboxed agent fails closed.
- Auth: move `admin.rs`'s `pipe` module to `services/local_pipe.rs` (token file,
  constant-time compare, busy retry); add a client-SID check
  (`GetNamedPipeClientProcessId`) and a server-SID check
  (`GetNamedPipeServerProcessId`). Give the admin pipe the same DACL — its
  default one is broader.
- Windows has no `agent_fence` (`platform_fenceable()` false); an agent there
  runs with the user's rights under the `platform_accepted` consent. The host
  adds no reach: it runs only argv an authenticated client sends, so
  `exec_trust` / `projects.json` stay in `launch_prep`. Session names and pipe
  paths never cross the browser API; the token is never in a session's env.

### Modules

Pure (Linux CI): `protocol.rs`, `ring.rs`, `screen.rs`, `table.rs` (names,
create-or-attach, size policy, dead, idle decision), `server.rs` (dispatch,
generic over `AsyncRead + AsyncWrite` and a `Pty` trait), `client.rs`
(connect, lazy start, handshake — backs `winhost.rs`). `cfg(windows)`:
`win/pipe.rs`, `win/conpty.rs`, `win/job.rs`, `launch.rs` (copy, start, prune).

Dependencies: new `vt100`; `windows` features `Win32_System_JobObjects`,
`Win32_Security_Authorization` (+ `Win32_System_Console` for option a).
Present: portable-pty, tokio named pipes, getrandom, subtle.

## 3. Integration

> **As built (2026-11-14), superseding the attach-client bullets below:**
> `SessionMux::wrap` on Windows only sets `mux_wrapped`; `spawn_pty` calls
> `winhost::open_tab` (connect, `Spawn` create-or-attach with argv+env over the
> pipe, `Attach`) and registers a pipe-backed `terminal/host_pty.rs` entry
> behind the `PtyMaster` trait. Routing is `session_host::route::routes_through_host`
> (flag + `persist_local_sessions` + local AI tab with a session name; never
> root/Host session/batch), fallback is `route::decide`: absent → in-process +
> event `session-host-fallback` `{id, reason}` once per run; silent/refused →
> `pty_spawn` rejects `session_host_silent: …` / `session_host_refused: …`.
> Killing a tab detaches (like a killed tmux client); the session ends via
> `local_tmux_kill` / `kill_app_sessions` (host `Kill`, Job terminate). The phone
> uses `SessionMux::attach_stream` (`MuxStream`), never an attach client.

- **Desktop tab.** Wire at the tmux spot: on Windows `launch_prep.rs:1565`
  rewrites `cmd/args` into `<host-copy>.exe --session-attach <name>`
  (create-or-attach over the pipe). `terminal::spawn_pty`/`launch`
  (`terminal/mod.rs:1907,2062`), the `terminal-*` events to xterm.js,
  `pty_resize` and `pty_write`'s `ai_switch::filter_while_off`
  (`commands/terminal.rs:473`) stay unchanged — the filter runs before the
  client's stdin. agent_home, the agent_bin shim and `--resume` are built by
  `launch_prep::prepare` before the wrap and ride inside `Spawn`.
  Cost: double ConPTY (as tmux re-renders); a later optional phase may add an
  in-process pipe-backed `PtyEntry` instead of the client.
- **`--resume` composition** as in `docs/context/tmux_sessions.md`:
  create-or-attach by `TabEntry.tmuxSession` (`newTmuxSessionName`,
  `lib/terminal/tmuxSession.ts:51`).
- **Which tabs:** the `shouldPersistLocalTab` rule (`tmuxSession.ts:159`):
  never a root-scope agent (the Host session stays in-process). Windows phase
  2: agents only (the `mobileAgentTmuxReady` path); shells in phase 4.
- **Commands:** `local_tmux_kill`/`_kill_app_sessions`/`_rename`/`_pane_dead`/
  `_screen` (`commands/terminal.rs:202-330`) dispatch through the trait; names
  and `command_class` rows unchanged. A new `session_host_status` (Settings)
  gets a row beside `local_tmux_kill` (`command_class.rs:1002`) + regenerated
  `commandClasses.ts`.
- **Phone:**
  - `pty_bridge.rs:242-320` `AttachTarget::Local` uses `mux.attach_client`;
    Capture/WindowSize/KeepDim/`send_now` call the trait.
  - `discovery.rs:1441` `live_tmux` → `mux.list()`; `terminals_support_on(windows,
    host_enabled)` returns `"native"` (setting read per load, like `shells_open`).
    Keep `host_tabs_here` off on Windows.
  - `scheduler.rs:321` `Runner` seam: a mux runner; drop the `tmux_available()`
    gates (:1316, :1361).
  - `host.rs:164` headless launch → `mux.spawn_detached` (the sidecar may start
    the host).
  - Presence/viewers key on session name: unchanged.
  - `mobile-web/src/api.ts:261` → `"tmux" | "native" | "unsupported"`;
    `Project.tsx:261` already tests `!== "unsupported"`, check `TabCard.tsx:228`.
    `npm run mobile:bundle`.
- **Frontend:** the `IS_HOST_WINDOWS` gates become one
  `localSessionsAvailable()` (setting + backend status): `CenterPanel.tsx:209`,
  `stores/projects.ts:1754`, `MobileBridgeHost.tsx:1381`,
  `BoxEditorDialog.tsx:380`, `TerminalDeadPaneCard.tsx:37`, `PaneSlot.tsx:49`,
  `closeRemoteTab.ts:103`, `SettingsPanel.tsx:1345`, `MobileSettings.tsx:612`.
  `tmuxSession`/`tmuxAttach` field names stay (persisted JSON). Neutralise
  "tmux" copy in `i18n/en.ts` (:371, :544, :1678, :2487, :4890–4893) and all
  languages. The Sessions view (`ProjectFilesView.tsx`) is remote-only; a local
  Windows listing is phase 4.

## 4. Rollout

- **Flag:** experimental `windows_session_host` (TS + Rust `Settings`,
  `useExperimental`), off by default; off = today's behaviour.
- **Fallback vs fail closed:** host *definitively absent* (flag off, failed to
  start, version refused) → in-process ConPTY + one-time notice. Host *present
  but silent* (pipe or pid alive, no answer) → fail closed with Retry: a
  fallback would start a second `--resume` agent on the same conversation and
  worktree. Define "silent" precisely (deadline, which probe).
- **Untested ids:** `terminal.windowsSessionHost`, `mobile.windowsAgentTabs`,
  `settings.experimental.windowsSessionHost`, `terminal.sessionHostFallback`;
  reword `mobile.project.terminalsUnsupported` (`untested.ts:938`) and
  `mobile.windowsTerminalsNote`.
- **Docs:** file-map rows for `session_mux`, `session_host`, the attach client;
  update `tmux_sessions.md`, `mobile_sidecar.md`, `mobile_access.md:31,53`.
- **Tests:** pure predicates as table tests on every OS (`terminals_support_on`,
  persistence rule, fallback decision); a trait-conformance suite run against
  tmux (Unix, skipped without tmux) and the host (Windows). Linux CI: protocol
  round-trip/negotiation incl. unknown, exact-name attach, size policies, dead
  refuses input, idle exit on a fake clock, capture joins wrapped rows, paste
  brackets only under 2004, overflow → repaint, server over `tokio::io::duplex`
  with a fake PTY (bad token closes; snapshot then live output, in order).
  Windows CI: DACL read back via `GetSecurityInfo`, second host refused, real
  ConPTY echo, kill reaps a grandchild (`cmd /c start /b ping`, Toolhelp), host
  kill reaps jobs; per-test pipe names; spawned exe compared by file stem.

## 5. Phases

- **P0 — spike (riskiest, needs a live Windows check by the user):** a
  standalone attach client inside a ConPTY. Ctrl+C must arrive as 0x03, not a
  CTRL_C_EVENT that kills the client (raw VT input, processed input off);
  resize through `ReadConsoleInput`; Claude/Codex TUIs survive the double
  ConPTY (alt-screen, bracketed paste, dim). If it fails: skip the client and
  give `pty_bridge.rs:1011` and `terminal/mod.rs` a pipe-backed `ClientIo` seam.
- **P1 — trait, no behaviour change**, one green commit each:
  1. module + `TmuxMux`, no callers (argv compared with `tmux_local` builders);
  2. pty_bridge `Local` arm (pinned by `tmux_attach_uses_a_non_alternate_screen_mobile_client`,
     `capture_stops_above…`, `window_size_is_probed…`, `keeping_dim…`,
     `the_attach_client_receives_dim_text`, `local_send_now_presses…`,
     `captured_scrollback_uses_terminal_line_endings`, `sidecar_tmux_spawns_use_app_path`);
  3. scheduler runner (real-tmux tests `scheduler.rs:1316/1361`);
  4. discovery `live_tmux` + `terminals_support`, split `host_tabs_on`;
  5. commands + `HeadlessSpawner` (keep the `spawn_detached_with(` text or
     update the source scans `agent_privacy/tests.rs:1492,1793`; keep
     `assistant_attach.rs:471` passing);
  6. remaining consumers (agent_privacy, agent_fence, api_proxy — fixes the
     socket bug — api_proxy_port, claude_token, assistant_model_probe,
     launch_prep, `lib.rs:2917`, boxes, projects);
  7. explicit `PtyOptions` marker replaces `cmd == "tmux"` (pin with the
     `join_tab` tests near `terminal/mod.rs:4026`).
  Gates per step: `cargo test --workspace`, both clippy variants, daemon build,
  `npm test`.
- **P2 — host + attach client** behind the flag, desktop agents only, with the
  fallback. Gates + Windows CI + `npm run build` + `backend:stale`.
- **P3 — phone wiring** (bridge, discovery, scheduler, headless), `mobile:bundle`,
  i18n, Untested rows, todo 🖐️ boxes. `host/tests.rs:1418`-style detail tests
  for `"native"`, scheduler recorder tests.
- **P4 — shells, local Sessions view on Windows,** flag default on after the
  🖐️ Windows boxes are ticked.

## P0 outcome (2026-11-14): pipe-backed, no attach client

The attach client worked in tests (Ctrl+C as 0x03, resize, bracketed paste,
exit codes) but cannot ship: the release exe is GUI-subsystem
(`windows_subsystem = "windows"`), and a GUI process spawned into a ConPTY
gets no console (`AllocConsole` does not attach it either). Rather than ship a
second console-subsystem binary, the plan's own fallback is taken: the desktop
terminal registry and the phone's `pty_bridge` speak the host protocol
directly (`Attach` stream over the pipe) through a pipe-backed PTY backend.
This also removes the double-ConPTY rendering risk and the spawn-spec file:
the desktop sends `Spawn` (argv, env) over the authenticated pipe itself.
`SessionMux::wrap` on Windows therefore marks the launch for the host instead
of rewriting argv, and `attach_client` gives way to a stream attach.

## Risks

- Older ConPTY may not pass mode 2004 / bracketed paste, or its own repaint may
  confuse the parser. Mitigation: ship `conpty.dll`/OpenConsole beside the exe.
- `CREATE_BREAKAWAY_FROM_JOB` denied when the desktop runs inside a job (an
  IDE, Windows Terminal). Fallback: a one-shot `schtasks /run`.
- vt100 memory at 10k history lines.
- Sessions die with the host (crash, logoff); recovery is `--resume`, not
  reattach.
- Job assignment race: own spawn (a) vs shim (b).
- An app update with a live host: old copy kept until its last session ends.

## Defaults taken (2026-11-14, pending user confirmation)

Implementation started without answers; these defaults are in force and can be
reversed:

1. Agents only through the host; shells stay in-process on Windows (phase 4).
2. A clean desktop quit ends Tabtivity's host sessions (the Unix rule).
3. Windows uses the host when the `windows_session_host` flag **and**
   `persist_local_sessions` are on (same switch as Unix).
4. remain-on-exit for every agent tab except assistant chats (`ends`).
5. The host is independent of Mobile (desktop tabs benefit too); flag-gated.
6. Phone wire value `"native"`; old phones treat any non-`unsupported` value
   as supported (`Project.tsx:261`).

## Open questions for the user

1. Phase 2: agents only, or shells too? (Recommended: agents only — phone
   shell access is off by default.)
2. On a clean desktop quit, do Windows host sessions end (the Unix rule) even
   while a phone is attached?
3. Does `persist_local_sessions` also govern Windows, or is the host always
   used once the flag is on?
4. Without a fence on Windows, which agent tabs get remain-on-exit?
   (Recommended: every agent tab except assistant chats.)
5. Host only while Mobile is enabled, or always? (Persistent desktop tabs help
   without a phone too.)
6. Phone wire value `"native"`, or reuse `"tmux"` for old phones?
