# Port forwards (the localhost viewer, phase 1)

Why a server a remote tab prints opens the way it does. Plan and decisions:
`docs/localhost_viewer_plan.md`. Code: `services/port_forward.rs`,
`commands/port_forward.rs`, `src/lib/terminal/{serverUrls,serverWatch,linkRoute}.ts`,
`src/lib/remote/portForward.ts`, `TerminalServerChips`, `PortForwardList`.

A program in a tab prints `http://localhost:8888/lab?token=…`. `localhost` is
the loopback of the machine the tab *runs on*. Before this, every click went to
`open_external_url`, so a remote, VM or container tab opened **this** machine's
port 8888 (an error page, or another service). Now the click is routed from the
tab's explicit locality (`tabLocality`: `localOnly`, `sandbox`, `remoteHostId`,
and the project saying it is remote, never the cwd), and the page opens in the
system browser, because Linux has no safe in-app engine (the `webkitgtk-6.0`
helper in `docs/browser_plan_b.md` §8.6 is missing) and an `<iframe>` is ruled
out (CSP perimeter, no site isolation, `frame-ancestors 'self'`).

## Rules (and what keeps each)

1. **Detected from the tab's own output, never scanned.** `findServerUrls` reads
   the screen on the sign-in scan's coalesced 300 ms parse tick (hidden panes
   catch up on show). Nothing is probed; nothing forwards until a click. "Forward
   a port…" is the user naming a port, not a scan.
2. **`-L` only.** `forward_args` has no `-R`/`-D` and no `ClearAllForwardings`
   (it would cancel the `-L`). A test pins the argv.
3. **The local end is `127.0.0.1`**, a constant in the service. The renderer
   never sends a bind address; the local port is the remote's number when free,
   else a free one (`pick_local_port`), retried once on any first failure (the
   master does the bind, and the mux client reports a taken port only as
   "forwarding request failed").
4. **The remote end** is a loopback address or a plain host name
   (`normalize_remote_host`: `validate_arg`, no `:`/`/`/space, `0.0.0.0`/`::` →
   `127.0.0.1`, IPv6 bracketed in `-L`). The confirmation names both ends and is
   asked once per (project, host, remote host, port) for each app session.
5. **Tokens never persist.** The registry rows hold host, ports and ids
   (`ForwardRow`; a test refuses a `url`/`token`/`path` field). The URL with
   `?token=` lives on the screen and in the click.
6. **Nothing outlives a clean quit.** `close_all` runs in `RunEvent::Exit`
   before the pooled connections go (a source-scan test pins the order).
   `close_for_tab` runs from PTY teardown and from the child's own exit;
   `close_for_master` from `remote::teardown_pooled`.
7. **Desktop window only.** The three commands are `Off(DaemonLoopback)` in
   `command_class` (a daemon's loopback is not the browser user's); there is no
   `mobile_control` route.
8. **The HPC tag doesn't block it.** A forward is passive and click-started.

## Mechanics worth knowing

- **It never dials.** `open_via` asks `ssh_exec::master_alive` (strict `-O
  check`) on the socket `resolve_control_path` read from `ssh -G`, and the argv
  is `-F none … ControlMaster=no ProxyCommand=false` on a *literal* control path
  (the `host_mux_args` recipe the phone sidecar uses), so a dead master is an
  exit, never a fresh login. The command also requires the pooled connection
  (`remote::is_connected_host`). The `cm-%C` template is not used: `%C` hashes a
  ProxyJump too.
- **Owners.** A forward holds the set of PTY ids that asked for it; the same key
  from a second tab joins it, and it ends with the last owner. Forwards typed
  into the Ports list are owned by `ports:<project>:<host>` and live until Stop,
  a disconnect or quit.
- **Disconnect.** `teardown_pooled` runs on every project deactivation too, so
  switching away from a remote project ends its forwards even while a persistent
  tab lives on. Re-click the chip to forward again.
- **Windows (phase 1b).** No ControlMaster: `SUPPORTED` is false, the command
  answers `port-forward:unsupported-os`, and the UI says so before it asks. A
  loopback link in a remote tab still never opens the local port there; it shows
  the unsupported message.
- **Containers (phase 3)** route to `unsupported` ("can't open yet"), never to
  the local port.
- Errors cross as `port-forward:<token>[: detail]` and are translated in
  `portForwardErrorText`.
