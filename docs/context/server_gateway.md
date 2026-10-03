# Server gateway, per-user daemons, admin helper

*Design rationale for hosted plan P3 (`docs/tabtivity_hosted_plan.md` §3.1,
§4, §5.1, §6.7, §6.8, §8), as built on branch `hosted`. Nothing here has run
on a real server yet; the live steps are in `docs/hosted_handoff.md` § P3.*

## Shape

```
Tailscale Serve (TLS) ─► 127.0.0.1:8740  tabtivity-gateway  (user tabtivity-gw)
                     ─► 127.0.0.1:8741  user-content origin (same process)
                              │  unix socket, SO_PEERCRED both ways
                              ▼
          /run/tabtivity/users/<user>.sock  (root:tabtivity-gw 0660, socket unit)
                              ▼
          tabtivity-serverd@<user>.service  (User=<user>, slice tabtivity-users-<user>)
          tabtivity-tmux@<user>.service     (tmux -L tabtivity -D, same slice, same /tmp)
```

- **One daemon per Unix account.** A request of Alice's can only ever reach
  a process running as Alice; "Alice touched Bob's file" is a kernel refusal,
  not a forgotten check (§3.1).
- **The gateway decides routing, never identity.** Pairing is routed by the
  `user:` prefix of the code and checked by the user's daemon against the
  invite the helper wrote; a challenge/session is routed by the device id's
  owner in the gateway's table and the daemon checks the signature. Only
  after the daemon says 200 does the gateway mint its routing cookie. A
  compromised gateway can intercept live sessions but cannot mint one.
- **The daemon is its user's, so its answers are untrusted.** A device id a
  daemon returns from a pair is validated and refused if it already routes
  to another account; names and ids that reach the table are charset-bound.
- **Header hygiene.** The gateway strips every client-sent `x-gateway-*`
  header and its own routing cookie before forwarding, then sets
  `x-gateway-user/role/device`. The daemon trusts them only because its
  socket admits the gateway's uid alone.
- **The role is the gateway's alone.** Behind the gateway the daemon signs a
  browser in only by its device-key session; the single-user token link
  (`/desktop/login`, an `Admin` session) is a 404 there, because the token
  file sits in the account's own state dir. A socket's role is fixed at its
  upgrade, so the gateway closes an account's live sockets when its role
  changes.
- **Bounded like the sidecar.** Both listeners are `limits.rs`'s
  `GuardedListener` (compiled in by `#[path]`): a connection cap and
  handshake/body/idle deadlines, so idle connections from a tailnet peer or
  a local user cannot exhaust the gateway for everyone.

## Why socket activation instead of the helper starting daemons

§3.1 had the helper start a user's units on first login. A socket unit does
the same with no root path from the gateway at all: systemd owns the socket
(`root:<slug>-gw 0660` in a root-owned directory), the first connect starts
the daemon, and no user can create or squat a socket path. The gateway checks
the daemon end's peer uid is the account's — or root, which is what a
socket-activated socket reports. The daemon adopts fd 3 (`LISTEN_PID`/
`LISTEN_FDS`) and never deletes a socket it did not bind.

Consequence: there is **no polkit rule**; the helper is only ever run by the
admin with `sudo` (account admin stays sudo-only for now, #2356). **Idle
daemons keep running** (user decision 2026-10-03, #2351): the daemon also
runs the user's timers, and socket activation only restarts on a connect.

## Slices and units

`<slug>-users-<user>.slice` nests under `<slug>-users.slice` because systemd
reads dashes as nesting — which is why account names may not contain one
(`wire::valid_account_name`). The daemon unit `JoinsNamespaceOf=` the tmux
unit so both see one private `/tmp`; tmux's socket lives in the tmux unit's
`RuntimeDirectory` (`/run/<slug>/tmux/<user>`, `0700`) via `TMUX_TMPDIR`. No
`ProtectSystem=`/`ProtectHome=`/`RestrictNamespaces=`/`NoNewPrivileges=` on
those two units: bubblewrap needs user namespaces and the home (§8). The
gateway unit, which runs no fence, is hardened (`ProtectSystem=strict`, …).

## The admin helper's rules (the only root code)

- Names, never paths; every path is built from fixed roots.
- Links an existing account only if uid ≥ 1000 (not 65534), already in
  `<slug>-users` (the admin's deliberate step), not a service account, and
  **not root-equivalent** — re-checked at execution, after `useradd`:
  no `sudo`/`wheel`/`admin`/`root` and no `docker`/`lxd`/`incus-admin`/
  `libvirt`/`disk` membership (each is root on the host by a socket or a
  device), and no sudoers rule naming it in any way (`src-gateway/src/
  sudoers.rs`: `/etc/sudoers` and its includes parsed read-only, any user
  list mentioning the account, its groups, its uid, an alias of them,
  `ALL` or a netgroup counts, whatever the rule grants). Fail closed: an
  unreadable file or an nsswitch `sudoers:` source other than `files`
  refuses. Parsing rather than `sudo -l -U`: no logging, no plugins, no
  side effects. Admin-role accounts are held to the same rule (user
  decision 2026-10-03) — an admin keeps a separate unlinked account for
  Docker and VMs.
- Never copies or chowns a user's tree: one `fchmod 0700` of the home
  through `O_NOFOLLOW | O_DIRECTORY`. The invite and a device revocation are
  done by the user's own uid (`runuser … env -i … <serverd> --write-invite`),
  the secret on stdin, never in `argv`.
- CLI installs run as `<slug>-cli` into `/opt/<slug>/agents` with
  `<PREFIX>SERVER_CLI_ROOT` set; every daemon refuses install/update/remove
  with the helper command (even the admin's daemon: the root is not theirs).
- `user-remove` never deletes the account or its home.
- Every verb is a `Plan` that `--dry-run` prints and the tests snapshot.

## Policy and feature switches

The gateway owns `policy.json` (`0644`, in its state dir): the admin's mail /
calendar / todo / sharing switches and the Ollama allowlist. Daemons read it
(`<PREFIX>SERVER_POLICY_FILE`); unreadable → every switchable feature off and
no model allowed (fail closed). On a server the allowlist is **only** the
policy's — a user's own `settings.json` never widens it. A user's own switches
are `Settings.disabled_features`. Off = `core_dispatch` refuses with
`feature-off`, the phone's routes answer 403, alarms pause; nothing is
deleted.

## Sign-in relay (§5.1)

On a server the phone's `sign-in-callback` relay reads `/proc/net/tcp{,6}`
and contacts only a listening socket owned by the daemon's own uid. The other
condition of §5.1 ("a sign-in tab of that user is open") is the route's
existing agent-tab check, which only knows this user's tabs.

## Secrets (§6.8), primitives only

`services::server::secrets`: per-device wraps (ephemeral P-256 ECDH →
HKDF-SHA256 → AES-256-GCM, device id as AAD), a 128-bit recovery-code wrap,
`wraps.json` `0600`, and K in the kernel persistent keyring. From a fenced
agent tab `keyctl(KEYCTL_GET_PERSISTENT)` fails with EPERM (observed on the
development machine, 2026-10-03), which is the seccomp filter of `f55f070f`
doing its job. The exchange and `mail_crypt` integration are TODO #2350.

## Host-channel inventory (§4.4)

| Listener | Who opens it | Protection | Server status |
|---|---|---|---|
| Daemon socket `/run/<slug>/users/<u>.sock` | systemd (socket unit) | `root:<slug>-gw 0660` in a `0750 root:<slug>-gw` dir + daemon's peer-uid check | closed to users |
| Gateway `127.0.0.1:8740/8741` | `<slug>-gw` | routing cookie / pairing; the daemon's own auth behind it | reachable by every local user, same as through Tailscale |
| Sidecar loopback port + content port | desktop only | token link, loopback Host/Origin checks | **not opened** by a daemon (`Listen::Unix`) |
| tmux server | tmux unit | `/run/<slug>/tmux/<u>` `0700` | closed |
| Daemon admin socket | daemon | `<state>/mobile-control/admin.sock` in a `0700` dir | closed |
| Root MCP listener (`root_mcp.rs`) | desktop window | bearer token | not started by a daemon (#2339) |
| Shared Ollama `127.0.0.1:11434` | admin's system service | none (decided 2026-10-03) | residual: any shell can drive it; model changes are `admin` |
| VM egress proxy (`vm_proxy.rs`) | admin's VMs | none | residual, TODO #2355 |
| VM SSH forward (`vm.rs` `alloc_loopback_port`) | admin's VMs | SSH key auth | acceptable |
| OpenVPN management port | admin | password file | acceptable (admin-only feature) |
| CLI OAuth callback listeners | a user's CLI | the CLI's `state` | the relay only reaches the caller's own (this phase) |
| CLIs' own IDE/helper ports | a user's CLI | per CLI | unknown; `server-isolation-test.sh` lists each user's listeners |
| Abstract unix sockets | anyone | none | residual (§4.4); no session bus or X server on a headless server |
