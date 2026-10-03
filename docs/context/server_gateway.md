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
- **Strangers never spend a known user's budget** (`rate.rs`). Pair and
  challenge/session requests are sorted first: a request naming nobody the
  gateway knows (an unknown account, an account with no invite pending and
  no recent use, an unknown device id) is counted per source and in one
  shared stranger window; a paired device is counted per device, per account
  and under its own ceiling — never per source, because the source is the
  rightmost `X-Forwarded-For` of a loopback peer (Tailscale Serve writes it)
  and a local account can forge that header. A pair reaches a daemon only
  while the helper's invite is pending (`gateway.json` `invite_until`) or the
  account was routed lately, so a pair attempt never starts an idle daemon
  and otherwise answers exactly like an unknown account. What remains: a
  stranger who knows a name can still burn that user's invite (five wrong
  codes, the daemon's rule) or fill that account's pair window.

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
- **The machine may be someone's desktop** (user decision 2026-10-03).
  `install` creates `<slug>-proc`, gives `polkit.service` that group by a
  `SupplementaryGroups=` drop-in and prints — never applies — the fstab
  line `hidepid=invisible,gid=<that gid>`; `check` fails `hidepid` on a
  machine with an active display manager unless the gid and the drop-in
  are in place, and fails `proc_group` when a server user is in the group;
  the helper never links a member. Only polkit is listed: logind, GDM's
  workers, accounts-daemon and colord run as root or look at their own
  processes — add a unit only for a failure seen with hidepid on.
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

## Secrets (§6.8): the device-released key

`services::server::secrets` holds the primitives: per-device wraps
(ephemeral P-256 ECDH → HKDF-SHA256 → AES-256-GCM, device id as AAD), a
128-bit recovery-code wrap, `wraps.json` `0600`, K in the kernel persistent
keyring. `services::server::vault` wires them:

- **Only a daemon has a vault** (`serverd`'s `main` installs it, never
  `run`, so a test serving a daemon cannot turn its test binary into a
  server). Every caller asks `vault::vault()`; `None` is the desktop, whose
  keychain and mail encryption are untouched.
- **K is read from its `KeyHold` on every use** — the kernel keyring on a
  server — never cached: a daemon restart finds it, a keyring flush (reboot)
  locks at once. `PR_SET_DUMPABLE=0` is set before K can enter memory.
- **Enrolment, not pairing.** After each sign-in the PWA enrols a
  non-extractable ECDH key with a signature of its pairing key (a stolen
  session cookie cannot enrol an attacker's key) and pins the daemon's
  identity key (`<state>/secrets/identity.key`, P-256). Enrolling after
  pairing also covers every device paired before this existed.
- **The exchange.** `POST /api/v1/secrets/unlock` → X (the device's wrap's
  ephemeral key) and a fresh transport key E, both under the identity
  key's signature over context, origin, device id and exchange id; the
  device answers `ECDH(device, X)` sealed under `HKDF(E‖T, ECDH(T, E))`
  (AES-GCM, AAD device id + exchange id). Single use, 60 s, bound to the
  session's device. The TLS-terminating gateway sees only ciphertext. The
  HKDF vector is pinned on both sides (`vault::tests`, the vitest).
- **What K opens:** `mail_crypt`'s `Device` mode (KEK = `HKDF(K,
  "mail-kek")`; on a server new stores are only ever sealed — locked or not
  set up, mail waits in memory and reopens on release) and the sealed
  credential store (`<state>/secrets/credentials.json`, `HKDF(K,
  "credentials")`) behind `remote_credentials`/`git_credentials`, where
  "locked" reads like a locked OS keyring.
- **Set-up and recovery** are the Server settings' secrets panel: the
  recovery code is shown once and stored nowhere; a new code retires the
  old wrap.
- **Residuals.** The identity key sits in the home unsealed (it must work
  while locked): a backup plus the gateway's position on a live connection
  could impersonate the daemon to a device. Root reads a live daemon's
  memory and the keyring (§4.4). Same-uid unfenced processes (the user's
  own shell, a desktop app of the same account) can read the keyring entry;
  the fence's seccomp keeps every agent out (EPERM observed from a fenced
  tab, 2026-10-03). The "mail locked since reboot" push is not built.

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
| VM egress proxy (`vm_proxy.rs`) | admin's VMs | per-VM `Proxy-Authorization` credentials (`<vm dir>/proxy.token`), `407` without | closed to other users (`45d1920d`, never booted) |
| VM SSH forward (`vm.rs` `alloc_loopback_port`) | admin's VMs | SSH key auth | acceptable |
| OpenVPN management port | admin | password file | acceptable (admin-only feature) |
| CLI OAuth callback listeners | a user's CLI | the CLI's `state` | the relay only reaches the caller's own (this phase) |
| CLIs' own IDE/helper ports | a user's CLI | per CLI | unknown; `server-isolation-test.sh` lists each user's listeners |
| Abstract unix sockets | anyone | none | residual (§4.4); no session bus or X server on a headless server |

## Side by side with the desktop app (plan Q12)

One account may run the desktop app and have a server daemon on the same
machine. They are separate apps: the daemon's `main` sets its own state dir
and app home (`daemon::server_dirs`: `~/.local/share/<slug>-server`,
`~/<slug>-server`) unless the unit's environment names others, so
`projects.json`, sessions, the mobile control dir (admin socket, device
keys, token), agent homes and logins, the agent-global layer, calendar and
the mail store are never shared (two writers would corrupt each; the
daemon could not open a keychain-sealed desktop mailbox anyway). tmux:
the desktop's default server vs. the daemon's `-L <slug>` under
`/run/<slug>/tmux/<user>`. Ports: the desktop sidecar's 8742/8743 vs the
gateway's 8740/8741; the daemon only listens on its unix socket. Units: the
desktop's user unit `<slug>-mobile-host` vs the system units
`<slug>-serverd@`/`<slug>-tmux@`/`<slug>-gateway`. Tailscale Serve is the one
shared resource: the gateway takes HTTPS 443 and 8443, so a desktop Mobile
host on the same machine needs the third Serve port (`--https=10000`,
origin `https://HOST:10000`). Shared Ollama: the admin's service owns
11434; the desktop's own `ensure_ollama_running` only starts a user-level
one when nothing answers. Not run live.
