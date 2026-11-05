# Localhost viewers (JupyterLab & co.) — plan

Status: plan only (2026-11-05). No code yet. Never run live.

A program in a project tab prints `http://localhost:8888/lab?token=…`
(JupyterLab), `Local: http://localhost:5173/` (Vite), `TensorBoard … at
http://localhost:6006/`, and so on. Clicking that link should open **that
program's** page, wherever the program runs: on this machine, on an SSH host,
a cluster login or compute node, a VM, or the project container. Today it
only works locally.

## Why

- **Remote tabs open the wrong port today.** `TerminalView`'s `activateLink`
  (`src/components/terminal/TerminalView.tsx:581`) hands every URL to
  `open_external_url` (`src-tauri/src/commands/ssh.rs:282`). For a remote,
  VM or container tab, `localhost:8888` is the *remote's* loopback, but the
  link opens *this* machine's port 8888. At best that shows an error page.
  At worst it shows a different local service on the same port. This is a bug,
  and phase 1 fixes it.
- **Jupyter on a cluster is the main use.** Today it takes a hand-typed
  `ssh -L 8888:node042:8888 login…`, a free local port and a copied token.
  Tabtivity already holds the ControlMaster connection for that host. One
  `ssh -O forward` over it is the whole tunnel. The TODO already asks for this
  ("SSH `LocalForward` per project", `todo/group-g-remote.md:343`).
- Local tabs already work: the link opens in the system browser after the
  usual confirmation. Phase 1 gives them only the server chip (below).

## What exists, and one hard constraint

- **The in-app live-page window is refused on Linux.**
  `LIVE_SUPPORTED = !cfg!(target_os = "linux")` (`commands/browser.rs:100`).
  The reason: wry builds the WebKitGTK context without WebKit's bubblewrap
  sandbox, so a renderer exploit runs as the user. The planned fix is a
  separate `webkitgtk-6.0` helper process (`docs/browser_plan_b.md` §8.6).
  Until it exists, Linux, the primary platform, has **no in-app engine** that
  can run JupyterLab. The reader-mode pane (`BrowserPane`) runs no JavaScript,
  so it can't run Jupyter either.
- An `<iframe>` in the main window is ruled out:
  - It needs `frame-src http://127.0.0.1:*` in the app CSP
    (`tauri.conf.json:31`), and the CSP is the real perimeter.
  - WebKitGTK has no site isolation, so the framed page (project code, which
    is attacker-controlled by our invariants) would share the main window's web
    process, the one with Tauri IPC.
  - Jupyter Server sends `frame-ancestors 'self'` by default, so it would
    refuse to be framed anyway. Verify this before quoting it elsewhere.
- **So pages open in the system browser.** Its renderer is sandboxed on every
  OS, and `open_external_url` already validates what it hands to the OS
  (`web_url_to_open`: http(s), a host, no userinfo, no control characters).
  An in-app view is a later, optional phase (phase 4).
- SSH: remote channels share a ControlMaster at `control_dir()/cm-%C`
  (`services/remote/ssh_exec.rs`, `ssh_pty_args`, `ssh_control_check_args`).
  `-O check` is already used there. Windows has no ControlMaster
  (`control_master_alive` is `cfg(not(windows))`).
- Terminal link detection: `lib/terminal/terminalUrls.ts`
  (`findWrappedUrls`, `findSignInRequest`, `isSignInUrl`). The sign-in card
  (`TerminalSignInCard.tsx`) is the screen-watching card to copy.
- Containers sit on Docker's bridge network; `host` is refused
  (`services/sandbox.rs:1272`). Nothing is published with `-p`. A server
  bound to `127.0.0.1` inside the container can't be reached from the host
  at all.

## Rules (the security shape)

1. **Detected from the tab's own output, never scanned.** Tabtivity never
   probes ports, locally or remotely. A URL becomes a server only because the
   tab printed it, and nothing opens or forwards until the user clicks.
2. **Local forwards only (`-L`), never `-R`, never `-D`.** A remote forward
   would give the remote side a door into this machine. A SOCKS forward is
   ruled out by the browser plan §9.4.
3. **The local end always binds `127.0.0.1`.** The bind address is never
   taken from the frontend. The local port is chosen in the backend: the
   remote's own number when it is free (some servers put absolute URLs with
   their port into pages: OAuth callbacks, HMR sockets), otherwise a free one.
4. **The remote end** is the printed host and port:
   - The host is loopback (`localhost`, `127.0.0.1`, `::1`; `0.0.0.0`/`::`
     mean loopback) or a host name the tab printed (a compute node,
     `node042`).
   - Every host goes through `ssh_common::validate_arg` (no leading `-`, no
     whitespace or control characters).
   - The confirmation names both ends: *"Forward port 8888 on node042 (via
     cluster-a) to this computer?"* It is asked once per (host, remote host,
     port) for each app session.
5. **Tokens never persist.** The URL with its `?token=` lives in the tab's
   screen and in the click. The forward registry stores host, port and local
   port only.
6. **Nothing outlives a clean quit.** Every forward is cancelled
   (`ssh -O cancel`) in the `RunEvent::Exit` teardown. A master kept alive by
   `ControlPersist` must not keep a local port bound after Tabtivity exits.
7. **Desktop window only.**
   - Server mode: the commands are `Off` in `command_class`. The daemon's
     loopback isn't the browser user's.
   - Phone: no route. Raw ports never cross `mobile_control`.
8. **The HPC tag doesn't block it.** A forward is passive (no background
   load, no probe), and it starts only on a click. `hpc_hosts` gates
   background behaviour, so nothing here runs on its own.

## Design

### Server detection — `src/lib/terminal/serverUrls.ts` (pure)

`findServerUrls(getLine, cols, fromY, toY)` uses `findWrappedUrls` and keeps
http(s) URLs that have:
- a host that is loopback, `0.0.0.0`, `::` or a bare single-label name;
- an explicit port;
- **not** `isSignInUrl`, so an agent CLI's OAuth `localhost` callback never
  becomes a server chip.

It returns `{ url, host, port, kind }`. `kind` is a small label table that
reads the line the URL is on and is display-only:

| kind | recognised by |
|---|---|
| `jupyter` | path `/lab` or `/tree`, `token=` query, "Jupyter Server … is running at" |
| `tensorboard` | "TensorBoard … at" |
| `vite` | "Local:" + "VITE" in the lines above |
| `streamlit` / `gradio` | "Local URL:" / "Running on local URL:" |
| `generic` | anything else that passes the host/port filter (Flask, Django, `http.server`, mlflow) |

**TensorBoard** (`tensorboard --logdir runs` prints `TensorBoard 2.x at
http://localhost:6006/ (Press CTRL+C to quit)`) goes through the same path as
Jupyter. It has no token, so rule 3's `127.0.0.1`-only bind is its only
protection, which is the same as running it locally. `--port 0` and
`--host <node>` both show up in the printed URL and need nothing extra.
For the curves alone, without a server, see `docs/tensorboard_viewer_plan.md`
(event files read and drawn natively).

**Servers that print nothing to a tab.** `%tensorboard` inside a notebook
starts TensorBoard from the kernel, and the notebook cell then frames
`localhost:6006` in the user's browser. That needs port 6006 forwarded as
well, but no tab printed it. The Ports list therefore has **"Forward a
port…"**: the user types a port (and optionally a host), and it goes through
the same confirmation and `port_forward_open`. That doesn't break rule 1,
because the user names the port and nothing is scanned. (The other route,
`jupyter-server-proxy` serving TensorBoard under Jupyter's own port, needs
nothing from Tabtivity.)

Keep only the newest URL per port. When a later screen shows the program
stopped (a shell prompt below the URL with no newer URL), drop the chip. Copy
`findSignInDone`'s look-below approach.

### Where a link goes — `src/lib/terminal/linkRoute.ts` (pure)

`routeLink(url, tabLocality)` returns one of:
- `"external"`: not a loopback URL, or a local tab. Same as today.
- `{ forward: { hostId, remoteHost, remotePort, pathAndQuery } }`: a loopback
  or printed-host URL in a remote, VM or worker-host tab.
- `{ container: … }` (phase 3) or `"unsupported"` until then. For
  `unsupported`, the click shows a message saying the server runs inside the
  container and can't be opened yet. It never opens the local port.

`activateLink` and the server chip both call it. This is the bug fix.
Remoteness comes from the tab's `projectId` + `remoteHostId` (explicit, per
the invariants), never from the cwd.

### Forward service — `src-tauri/src/services/port_forward.rs`

AppHandle-free and unit-testable.

- A `Forward { key: (target_key, remote_host, remote_port), local_port,
  owner_tab_uid, control_path }` registry behind a `Mutex`.
- `forward_args(spec, local, remote_host, remote_port) -> Vec<String>`:
  `ssh -S <control_dir>/cm-%C -O forward -L 127.0.0.1:<local>:<remote_host>:<remote_port> [-p port] <target>`.
  Built like `ssh_control_check_args` and tested the same way. There's a
  matching `cancel_args` with `-O cancel`.
- `pick_local_port(preferred)`: bind `127.0.0.1:<preferred>`, else
  `127.0.0.1:0`, read the port and drop the listener. If ssh then reports the
  bind failed, retry once with a fresh port. The race is real but harmless.
- `open(...)`: reuse an existing forward for the same key. Otherwise check
  that the master is alive (`control_master_alive`). If it isn't, return
  `not_connected`. **Never dial from here**; the tab's own connection is what
  makes the master. Run the `-O forward` and record it.
- `close(key)`, `close_for_tab(uid)`, `close_for_master(control_path)`,
  `close_all()`. Each runs `-O cancel`, with failures ignored: a dead master
  already took the forward with it.
- **Windows (phase 1b):** no ControlMaster, so a forward is its own
  `ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -L …` child. It is
  kept in the registry, killed with its subtree on close and at exit, and
  `BatchMode` makes sure it never prompts.

### Commands — `src-tauri/src/commands/port_forward.rs`

- `port_forward_open { projectId, hostId?, tabUid, remoteHost, remotePort }`
  → `{ localPort }`. Async over a `*_blocking` body, since it runs
  `ssh -O`.
  - The spec is resolved through `remote::remote_target_for_host`, never taken
    from the frontend.
  - It refuses a local project and a reserved scope
    (`storage::is_reserved_scope`).
- `port_forward_list` → the rows for the UI: host label, remote host:port,
  local port. No paths, no tokens.
- `port_forward_close { key }`.
- Each command uses `#[cfg_attr(feature = "desktop", tauri::command)]` and has
  a `command_class` row of `Off("port forwards bind the daemon's loopback")`.
  Regenerate `commandClasses.ts`.
- The frontend rewrites the URL itself:
  `http://127.0.0.1:<localPort><pathAndQuery>`. Not `localhost`: Jupyter's
  and Vite's host checks accept `127.0.0.1`, and it avoids a `::1` versus
  `127.0.0.1` mismatch. Then it calls `open_external_url`, unchanged.

Teardown hooks:
- **Tab closed** (`pty kill` path): `close_for_tab`. When the tab that printed
  the URL is gone, so is the server.
- **Remote disconnected**: when `services::remote` tears a master down, call
  `close_for_master`.
- **`RunEvent::Exit`**: `close_all`.

### UI

- **Server chip** on the terminal pane. It copies the `TerminalSignInCard`
  layout and class (one shared card style). Example:
  *"JupyterLab · node042:8888 — Open · Copy link · ✕"*.
  - Shown while the URL is on screen and the pane is visible. It scans on the
    same coalesced 300 ms parse tick as the sign-in scan, and a hidden pane
    catches up when shown.
  - In a remote tab, the first Open asks through `useDialogs()` (rule 4).
    Later Opens reuse the forward.
  - Once forwarded, the chip reads *"→ 127.0.0.1:8888 · Stop"*.
- **Link clicks** go through `routeLink` (above). A loopback link in a remote
  tab gets the same confirmation and forward as the chip.
- **Ports list**: one row per active forward, with Stop. It goes in the
  project's remote host menu, next to the connection state. Grep
  `filemap_frontend.md` for the remote status cluster before choosing the
  file.
- All text through `useT()` (`terminal.server.*`, `portForward.*` keys in
  `i18n/en.ts`).
- `UntestedTag` rows: `terminal.serverChip`, `remote.portForward`,
  `terminal.remoteLoopbackLink`.

## Phases

### Phase 1 — remote forward + chip (Linux/macOS)

1. `serverUrls.ts` + `linkRoute.ts` with unit tests (the table below).
2. `services/port_forward.rs`: argv builders, port pick, registry, close
   paths. Unit tests for the argv (with `-p` and without, IPv6 host bracketed
   in `-L`, a `-`-leading host refused), key reuse and `close_for_*`.
3. `commands/port_forward.rs` + `lib.rs` registration + `command_class` rows
   + the regenerated `commandClasses.ts`. Hook `close_for_tab` into the PTY
   kill path, `close_for_master` into the remote teardown, and `close_all` into
   `RunEvent::Exit`.
4. `activateLink` → `routeLink`. This fixes the wrong-port bug for remote and
   VM tabs, and container tabs get the "can't open yet" message.
5. Server chip + confirmation + Ports list + i18n + `UntestedTag` rows.
6. Filemap rows (frontend: `serverUrls`, `linkRoute`, chip; backend:
   `port_forward`). Then a `docs/context/port_forwards.md` with rules 1–8 and
   the reasons.

### Phase 1b — Windows

The `ssh -N -L` child variant in `port_forward.rs`, cfg-gated. Tests compare
the spawned program by file stem (cross-OS rule).

### Phase 2 — compute nodes and multi-host

- A host name printed by a job on a SLURM node (`node042`) is forwarded from
  the login node's master. The confirmation names both hosts.
- A `host:<id>` worker tab forwards over that worker's master
  (`remote_target_for_host`), not the primary's.

### Phase 3 — containers

The project container is on the bridge network with nothing published, and a
server bound to `127.0.0.1` inside it can't be reached by IP. The approach:

- A local listener in `port_forward` on `127.0.0.1:<local>`.
- For each accepted connection, `docker exec -i <container> <relay>` with the
  sockets piped.
- `<relay>` is the first one found in the container: `socat`, `nc`, or a
  `python3 -c` one-liner. A container running Jupyter has `python3`.
- `services::sandbox` keeps ownership of the container. This adds a client of
  it, not a second lifecycle. The relay is killed with its subtree.

### Phase 4 (optional) — in-app view

Only if the user wants it after phase 1:
- macOS/Windows: reuse `browser_open_live` with a dev-server record whose
  navigation gate allows exactly `127.0.0.1:<localPort>`, without the
  per-session confirm. The user already confirmed the forward.
- Linux: blocked on the `webkitgtk-6.0` helper (`browser_plan_b.md` §8.6).
  No workaround: no iframe, and no unsandboxed live window.

## Tests

`serverUrls` table:
- Every kind above.
- `0.0.0.0` rewrites to `127.0.0.1`.
- An OAuth `localhost` callback is **not** a server.
- A URL wrapped across rows.
- A URL with no port is ignored.
- A non-loopback dotted host is ignored, since that's an ordinary web link.

`linkRoute`:
- A local tab gives `external`.
- A remote tab with a loopback URL gives `forward`.
- A remote tab with a public URL gives `external`.
- A container tab gives `unsupported`.
- A missing locality gives `external`, never a forward guessed from the cwd.

Rust:
- argv shape;
- the bind address is always `127.0.0.1`;
- registry reuse and close paths;
- `Off` class present;
- the Exit hook calls `close_all`. Do this as a source scan, like the existing
  `commands/*/tests.rs` scans.

## Manual QA (todo entries, 🖐️ with per-platform ✅/❌ pairs)

1. A remote project: run `jupyter lab --no-browser` in a remote tab. The chip
   appears; Open, confirm, and JupyterLab loads in the system browser with the
   token. Run a cell.
2. In the same tab, click the printed link directly. It goes through the same
   forward, and no local port 8888 opens.
3. Close the tab, and `ss -ltn` shows the local port gone. Quit Tabtivity with
   a forward open, and nothing stays listening.
4. With a local service already on 8888, the forward picks another port and
   the page still loads.
5. `tensorboard --logdir runs` in a remote tab: the chip reads TensorBoard,
   and Open shows the scalars. Then `%tensorboard` inside the forwarded
   JupyterLab, with port 6006 added through "Forward a port…": the cell
   shows the dashboard.
6. Phase 2: Jupyter in an `srun` job on a compute node, forwarded via the
   login node.
7. Phase 3: Jupyter in the project container.

## Decisions (user, 2026-11-05)

1. **Where pages open:** the system browser. An in-app view stays optional
   phase 4; Linux has no safe in-app engine yet.
2. **Forward lifetime:** until the tab that printed the URL closes, or the
   user presses Stop, or the host disconnects, or the app quits.
3. **Container support (phase 3):** after phases 1–2, not with them.
4. **Local tabs:** they get the server chip too (Open + Copy link, no
   forward), so a Jupyter link looks the same in every tab.
