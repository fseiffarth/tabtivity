# Localhost viewer — phase 1 handoff

Branch `localhost-viewer` (from `develop` ee3685eb). Plan: `docs/localhost_viewer_plan.md`;
rationale for the shipped shape: `docs/context/port_forwards.md`. **Never run live** in the app.

## Commits

- `314f2bd9` feat(remote): forward a tab's localhost server and open it
- the commit adding this sha to the handoff (docs only)

## Choices where the plan was silent

- **Literal control path, not `cm-%C`.** `forward_args`/`cancel_args` ride the socket
  `ssh_exec::resolve_control_path` read from `ssh -G` (the phone sidecar's `host_mux_args`
  recipe: `-F none`, `ControlMaster=no`, `ProxyCommand=false`), because `%C` hashes a
  ProxyJump too and a dead master must be an exit, never a fresh login. Made
  `ssh_exec::literal_control_path` `pub(crate)` for it.
- **Liveness is strict**: `ssh_exec::master_alive` (a failure to ask is "not alive"), plus
  the command requires `remote::is_connected_host`. Either missing → `port-forward:not-connected`.
- **Retry on any first failure.** The master does the bind, and the mux client reports a
  taken port only as "forwarding request failed", so there is no "address in use" text to key on.
- **Owner = the PTY id** (`TerminalView`'s `id`, what `pty_kill` takes). A forward is a set
  of owners and ends with the last; the same key from a second tab joins it. "Forward a
  port…" uses the owner `ports:<project>:<host>` (lives until Stop / disconnect / quit).
  The command arg is `tabUid`.
- **Wire errors** are `port-forward:<token>[: detail]` (`not-connected`, `unsupported-os`,
  `not-remote`, `invalid`, `failed`), translated in `portForwardErrorText`.
- **New `OffReason::DaemonLoopback`** (`daemon-loopback`) with a refusal sentence
  (`transport.refusal.off.daemonLoopback`) — no existing reason fit.
- **Locality** (`tabLocality`) mirrors `launch_prep`: container = `sandbox && !localOnly`;
  remote = non-local tab of a remote project (a *local* project's shell tab also carries
  `remoteHostId: "primary"`, so the project must say it is remote). Box/assistant scopes are
  local. A project not loaded → `unknown` → loopback links get the "can't open" message.
- **A loopback link with no port** in a non-local tab is a server on 80/443 (never the local
  port); a bare node name needs an explicit port to count.
- **Teardown hooks:** `close_for_tab` in `terminal::teardown_with` (explicit kill) *and* the
  reader task's end (the program quit by itself); `close_for_master` in
  `remote::teardown_pooled`; `close_all` in `RunEvent::Exit` right after the PTY `kill_all`
  and before the pool teardown (`ssh -O cancel` needs the master).
- Server-chip Open in a *local* tab skips the link confirmation for loopback hosts (the
  sign-in card doesn't ask either); a bare node name still asks.
- The Ports list is in each host card of `RemoteMachinesWindow` (primary and workers), as
  `PortForwardList`; the store refreshes on open and after each action, not by polling.

## Gotchas

- `teardown_pooled` runs on every project deactivation, so switching away from a remote
  project ends its forwards even if a persistent tab lives on (plan rule: "host disconnects").
- Windows: `SUPPORTED` is false; the command answers `unsupported-os` and the UI says so
  before asking. A loopback link in a remote tab on Windows still never opens the local port.
- `lib.rs`, `command_class.rs`, `commandClasses.ts`, `en.ts`, `untested.ts` and both
  filemaps each got one compact block — expect merge conflicts there.

## Gates

All green at zero warnings on the final tree (Linux only; not run on Windows/macOS):

- `scripts/brand-check.sh`, `git diff --check`: pass.
- `npm run lint`: pass, no new warnings (3 pre-existing `exhaustive-deps` in `TerminalView`).
- `npm run build` (tsc + bundles): pass.
- `npm test`: 1085 files, **11121 tests** passed (new: `ServerUrls` 13, `LinkRoute` 9, `PortForward` 7).
- `cargo test --workspace`: pass; `tabtivity` lib 5129 passed, 11 ignored (new: 16 in
  `services::port_forward::tests`, 5 in `commands::port_forward::tests`).
- `cargo test -p tabtivity --no-default-features --lib --test server_secrets`: 4959 + 1 passed.
- `cargo clippy` (workspace/all-targets, the `--no-default-features` lib, `app-serverd`): `-D warnings` pass.
- Under heavy machine load (load average 60+) the `--changed` vitest run timed out on unrelated
  tests (FileTreeRowMemo, Mobile*, TeX, TerminalXtermContract); they pass alone and in the full run.

i18n: the repo's test requires **every language** to carry every English key, so the new
keys are also in de/es/fr/it (my translations; worth a native read).

## Flagged for user

- Not run live. Manual QA list is the plan's items 1–5.
- Forwards end on a project switch (above); say if that is wrong for persistent tabs.
- Phase 1b (Windows `ssh -N -L` child), phase 2 (compute-node extras beyond the node-name
  host that already falls out), phase 3 (containers) are untouched.

## Security review (2026-11-05) — nothing run live

Fixed in the review commit (each with a test): loopback spellings the clean URL parse does not
take (`localhost.`, `*.localhost`, userinfo, IPv4-mapped IPv6) opened **this** machine's port from
a remote/container tab; the sign-in card opened a loopback sign-in link without routing; a local
tab's chip skipped the confirmation for any node name starting `localhost`; a failed browser
open put the forwarded `?token=` URL into a toast; a forward row outlived a replaced master
(the pool reaps dead connections without `teardown_pooled`) and was reused for a port nothing
listens on, so the next program to bind it got the page and token (`Mux::master_pid`).

### Flagged for user (design / plausible, not changed)

- **Origin `127.0.0.1:<port>` for a remote page.** The forwarded page's origin is a loopback
  address, so a browser's Private Network Access does not treat its requests to other
  `127.0.0.1` ports (Ollama, other dev servers) as public-to-local. A hostile remote server
  gets the reach of a local page, and cookies on `127.0.0.1` are shared across ports. A
  per-forward name such as `<id>.localhost` would isolate cookies and storage; it needs the
  server to accept that `Host` (Jupyter/Vite host checks), so it is a product decision.
- **Any local user or process can connect to the forwarded port** (`127.0.0.1` is shared on a
  multi-user host). Jupyter's token protects it; TensorBoard has no auth. A unix socket cannot
  serve a browser URL, so this is inherent to `-L`.
- **Crash leaves forwards.** `close_all` runs only on a clean quit. After a crash a
  `ControlPersist` master keeps its forwards bound until it expires; the registry is gone, so
  nothing sweeps them on the next start.
- **Timeouts can orphan a forward.** `-O forward` that times out client-side (8 s) may still
  have succeeded in the master; the retry then opens a second one on another port and the first
  is never cancelled. Likewise `open_via` treats a master that misses the 4 s `-O check` as dead
  and drops its rows without cancelling.
- **Open racing tab close.** `close_for_tab` between the ssh call and the registry insert finds
  no owner; the forward is then owned by a gone tab until Stop, a disconnect or quit.
- **`close_for_master` is keyed by socket**, which several projects on one ssh target share:
  deactivating project A also ends project B's forwards on that host.
- **Typed ssh in a login/root console tab** (`login` is "local"): a loopback link there opens
  this machine's port, since nothing says the tab's shell is on another host.
- **Pid check is best effort.** If `ssh -O check` prints no pid, a replaced master is not noticed.
- **A remote can print any `name:port`** that forwards to a host its network can reach (the
  chip names it, the dialog asks once per session per target); a second click on the same
  target does not ask again.
