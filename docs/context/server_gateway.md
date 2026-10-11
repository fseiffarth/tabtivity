# Server gateway, per-user daemons, admin helper

*Design rationale for hosted plan P3, P3b and P5's key broker and OIDC (`docs/tabtivity_hosted_plan.md` §3.1,
§4, §5.1, §5.4, §6.7, §6.8, §8), as built on branch `hosted`. Nothing here has run
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
- **`check` fails while Tailscale Funnel publishes the gateway** (user
  decision, final review): any Funnel-enabled name whose Serve handler
  proxies, or whose TCP forward points, at the gateway's loopback listeners
  (`server.env`, else 8740/8741). Serve alone keeps the sign-in, pairing
  and content routes on the tailnet; another service's Funnel is left
  alone; no `tailscale` answer is a warning.
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
- `user-remove` never deletes the account or its home. It does take the
  account off every shared project (`hub-forget`) and off every
  administrator's key list, with its broker tokens and budgets
  (`<slug>-gateway keys-forget`, the keeper's root-only `forget`; user
  decision, final review): a removed account re-added later starts with no
  key access.
- Every verb is a `Plan` that `--dry-run` prints and the tests snapshot.

## Policy and feature switches

The gateway owns `policy.json` (`0644`, in its state dir): the admin's mail /
calendar / todo / sharing switches and the Ollama allowlist. Daemons read it
(`<PREFIX>SERVER_POLICY_FILE`); unreadable → every switchable feature off and
no model allowed (fail closed). On a server the allowlist is **only** the
policy's — a user's own `settings.json` never widens it, and it holds every
request that names a model, mail's included (`model_allowlist`); a user's
`ollama_host` is ignored on a server, the shared loopback Ollama is the only
endpoint. A user's own switches
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

- **The desktop binary carries a `--serverd` verb** (`src-tauri/src/main.rs`,
  the same entry as `tabtivity-serverd`): a development route for running a
  daemon from a desktop build. Without the unit's environment it exits 2;
  a deployment runs the `app-serverd` crate's binary, which links no GTK.
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
  old wrap. Set-up and a new code need the device's **pairing-key
  signature** over a single-use action nonce (`POST
  /api/v1/secrets/challenge`, `AuthStore::action_challenge`; payload
  `context("action")`, origin, device id, action, nonce, expiry, built on
  the device), like enrolment — a cookie alone gets `403
  signature_required` (decision 2026-10-03). The browser client signs with
  the same origin's IndexedDB key (`mobile-web/src/secretsCore.ts`).
- **Recovery wrap v2.** From the code and a salt: a P-256 key `r` (public
  `R` in the wrap) and an auth key `A`. K is wrapped *to `R`* (ephemeral
  X, ECDH, HKDF, AES-GCM), so a rotation re-wraps the new K for the same
  code without knowing it; `A` is kept sealed under `subkey(K,
  "recovery-auth")`. v1 wraps (K under `HKDF(code)`) still open and are
  rewritten as v2 by the next `recover`; one met by a rotation is dropped
  and the status says `recoveryCode: false` (panel: make a new code).
- **Revoking rotates K** (`vault/rotation.rs`, decision 2026-10-03). New
  K; the credential store and a device-mode mail `key.json` (with a fresh
  mail master — see the next point) are re-sealed beside the originals
  (`<file>.next`), the recovery wrap re-wrapped, a wrap per remaining
  device; `rotation.json` names the new key id and the files; **commit =
  renaming `wraps.json.next` over `wraps.json`**; then the `.next` files
  move in, the new K goes into the hold, the journal goes. `Vault::new`
  settles a crash: journal kid ≠ `wraps.json` kid → delete the `.next`
  files (old K in force); equal → finish the moves. `wraps.json` keeps a
  `check` (HKDF of K) so a stale K left in the hold is cleared (locked,
  never wrong), and a release puts K in the hold only if it matches that
  check, under the vault's lock (a wrap read just before a commit opens
  the retired K). Every read of K that seals something takes the lock
  first. A device revoked while the vault runs is remembered
  (`Vault::revoked`): a device list a route read before the revoke never
  gets it a wrap again (rotation, `wrap_missing`). The device list is
  saved before the vault hears of a revoke. Locked at revoke: the wrap goes at once, `rotate: true`
  is recorded, the next release rotates before listeners run. Releases
  also drop wraps of devices no longer enrolled (`--revoke-device` with
  the daemon stopped drops the wrap itself via `revoke_offline`);
  `install_vault` resumes a pending rotation while K is held.
  `mail_crypt`'s device mode opens, enables and rewraps under
  `Vault::with_key` (the vault's lock), so nothing reads one K's file
  with another K. A re-enrolment's new ECDH key drops the old wrap
  without rotating (`drop_wrap`). A committed rotation runs the
  `Vault::on_rotate` listeners after the lock is released.
- **Revoking re-keys the mailbox** (decision 2026-10-03). The rotation's
  `key.json` (`mail_crypt::rotate_device_key_file`) has a **fresh mail
  master** and moves every master it held into `previous`, all wrapped
  under the new K — so mail sealed from the switch on opens with no old
  K. The `on_rotate` listener (`commands::mail`, registered before the
  store's first open so a rotation during the open is not missed; with no
  store open it still moves the side files' session keys) switches the open store
  and the session to it (`refresh_keys`: side-file lock, then
  `MailStore::switch_keys` under the connection lock — every write reads
  its keys under that lock, so nothing is sealed under replaced keys) and
  starts the re-key thread (`services::mail_rekey::run`): batches of
  `MailStore::rekey_step` (keyed digests; each table of `SEALED_TABLES`
  by rowid; blob files — re-sealed under their new keyed name, rows
  re-pointed in one join per table per batch, old file deleted after the
  commit; a file already under the new name is adopted only if it opens
  under the current key, synced first; the outbox), each one
  transaction with its `meta` marker (`rekey_cursor`: target fingerprint,
  stage, rowid / last blob name, blob names to unlink), 20 ms apart; then
  the files beside the database (`reseal_side_files`, all synced); then
  `mail_crypt::retire_previous` under `Vault::with_key` drops `previous`
  (synced) — only if `key.json`'s current master is still the target (a
  second revoke mid-way: `Ok(false)`, refresh, the pass restarts towards
  the newest). Reads use `MailKeys::open_any` (current, then each
  previous), so a crash anywhere leaves every value readable by the key
  set on disk; the next open of the store (`store_of`) resumes. Locked
  when everything is moved: status `waiting`, an `on_unlock` listener
  finishes it. Side-file writers (accounts, filters, contacts, the PGP
  keyring) take `mail_crypt::side_files` (holding a switch count): a
  `PgpKeyring` opened before a switch refuses to write after it; a mail
  reset holds the lock until its carried files are written. **Lock
  order:** `REFRESH` → vault lock (released inside `mail_crypt::unlock`)
  → `MailState` (released) → `side_files` → the store's connection; the
  vault's lock is a leaf towards mail (only `key.json` under it), which is
  why `mail_crypt::rewrap`'s non-device branches stay outside it.
  `GET /api/v1/secrets` carries `mailRekey` (`mail_rekey::status`: the
  thread's word, else `waiting` while `previous` is non-empty). Not
  vacuumed, but (user decision, final review) `secure_delete` is on while
  re-keying, so pages freed meanwhile are zeroed, and the pass ends with
  `wal_checkpoint(TRUNCATE)` before the retire, so no WAL frame from before
  it is left; a re-sealed row's same-size record is overwritten in place.
  Pages freed *before* the revoke may still hold old-master ciphertext of
  mail the revoked device could read anyway. `reply_key` digests follow
  the messages batch: for each message's `Message-ID` the replies' digest
  under every previous key is replaced by the current key's (through
  `messages_by_reply_key`); a reply whose original is not in the store
  keeps its old digest until re-synced (equality only). A blob no row
  names at its batch (written under the old keys just before the switch,
  its row still to come) is re-sealed in place under its old name, so the
  late row finds it and the old master opens it no more.
- **New recovery code after a revoke** (decision 2026-10-03).
  `wraps.json`'s `new_code_recommended` is set by every revoke that drops
  a wrap (`revoke_where`, `revoke_offline`; not by `drop_wrap`), carried
  by rotations, cleared only by `new_recovery_code` (the signed route).
  `GET /api/v1/secrets` → `newCodeRecommended`; the browser panel shows a
  card (button while unlocked), the phone a sheet after sign-in
  (`SecretsNewCodeSheet`, signed with its pairing key).
- **Identity re-pin** (decision 2026-10-03). The device's pin is
  first-use only: a different identity at enrolment or in `GET
  /api/v1/secrets` (`identity`) is never adopted — `releaseSecrets`
  answers `untrusted` and the phone/browser asks for the recovery code.
  `POST /api/v1/secrets/repin` (`Vault::repin_offer`, locked or not)
  sends the identity, the recovery wrap's public fields and
  `binding = HKDF(ikm = sealed A, info = context("identity") ‖ origin ‖
  identity)`. The device derives `r` → K and `A` from the code, re-seals
  `A` under `subkey(K)` with the wrap's `authNonce` (AES-GCM is
  deterministic given key and nonce), recomputes the binding and pins
  only on a match (`secrets::check_repin` = `secretsCore.checkRepin`,
  shared vector). The code never leaves the device. Forging a binding
  needs the code or the daemon's `wraps.json` (the sealed A is never
  sent) — a gateway in the middle has neither.
- **Residuals.** The identity key sits in the home unsealed (it must work
  while locked): a backup plus the gateway's position on a live connection
  could impersonate the daemon to a device, and the same pair could make a
  device re-pin a key of its own if the user then types the code. Root
  reads a live daemon's memory and the keyring (§4.4). **Same-uid unfenced
  processes can read K from the keyring — accepted (decision 2026-10-03):**
  the user's own shell tabs, SSH logins and project code run on the host
  (build scripts, allowed hooks) can `keyctl` it while unlocked; fenced
  agents can't (seccomp; EPERM observed from a fenced tab, 2026-10-03); a
  copy of the home or a backup can't open it. `A` sealed
  under an old K lets a revoked device with old wraps forge re-pin
  bindings until a new recovery code is made — which the Server settings
  now ask for after every revoke (it also needs the gateway's
  position and the user typing the code; the K it then reaches still
  needs the *current* `wraps.json`, which with the gateway's position is
  enough on its own). The recovery code crosses
  the gateway in clear on `recover` (not on re-pin). The "mail locked
  since reboot" push is not built.

## Admin-provided API keys (P3b, §5.2, §5.4; through the API proxy since #2389)

```
admin's browser ─PUT /gateway/v1/agent-keys/<cli>─► gateway (<slug>-gw, role check)
                                                        │ set/remove/status, by uid
                                                        ▼
   /run/<slug>/auth.sock (systemd, 0666) ─► <slug>-gateway keeper (<slug>-auth)
                                                        │ /var/lib/<slug>-auth/<cli>/api-key 0600
                                                        │ meta.json: who may use it
                                                        ▲ get, by uid, if on the list
   user's daemon (user's uid): api_proxy on 127.0.0.1:<port>, per request
        ▲ proxy token + base URL (ANTHROPIC_AUTH_TOKEN / GEMINI_API_KEY)
   the user's agent tab (fenced) — never the key, never a broker token
```

- **A keeper of its own, not the gateway.** The plan puts the keys under
  `<slug>-auth`; the gateway is the tailnet-facing process and holds no
  secret but its cookie key. The keeper is a subcommand of the gateway
  binary (`<slug>-gateway keeper`, no new binary name), started by its
  socket unit, hardened past the gateway (`PrivateNetwork=`, unix sockets
  only, `UMask=0077`, state dir `0700`).
- **By uid, nothing else.** `SO_PEERCRED` → name: the gateway's account may
  `set`/`remove`/`status`/`offered` and never `get`; an account passing the
  helper's own `check_account` (in `<slug>-users`, uid ≥ 1000, in no
  root-equivalent group — so `user-remove`'s `gpasswd --delete` also ends
  its access) may `offered`/`get`/`fingerprints` — for keys whose list
  names it; off the list every answer is the one of a CLI that never had a
  key (`no-key`) — anyone else is refused. The admin's
  name in a `set` is the gateway's word, as the role header is to a daemon:
  a compromised gateway can replace or withdraw keys, not read one. The
  socket is systemd's in the root-owned `/run/<slug>` (nobody squats it);
  `0666` because the gateway and every user must reach it. Fenced agents
  never do: the fence mounts a tmpfs over `/run`.
- **Who may use a key is the administrator's** (user decision 2026-10-03):
  `meta.json` beside the key holds its list of accounts, set by the gateway
  (`PUT /gateway/v1/agent-keys/<cli>/users`, accounts of its table only)
  from the panel's user picker. A new key's list is empty — the admin names
  every user explicitly; replacing the key keeps the list; withdrawing it
  forgets the list (a re-offer starts with nobody). For anyone not on it
  the keeper answers `offered` without the key and `get` with `no-key`,
  exactly as if there were none (nothing learned about others' keys). The
  keeper audits each user added or removed (`agent-key-user-add`/`-remove`,
  the admin as user, `<cli>/<name>` as resource); the gateway one row per
  change.
- **Which CLIs** (#2389): only those the daemon's API proxy serves
  (`keys_wire::KEY_CLIS`: Claude, Gemini; a test holds the list to
  `agent_api_keys`' routes). The keeper refuses `set` for any other CLI
  (`unsupported`): Mistral Vibe has no base-URL variable, so its key could
  only go into the agent, which the one-path decision rules out.
- **The choice is the user's own, one credential per CLI**
  (`<state>/agent-auth/admin-keys.json`), written only by `choose`
  (`agent_login_use_admin_key`), which refuses off a server and, switching
  on, without a key on offer to that user — and switches the CLI's own API
  key off (`Settings::agent_api_key_clis`). Manage CLIs shows the three
  choices in one **runs on** control. A user taken off the list keeps the
  choice; their next spawn fails with the withdrawn message, which names both
  causes.
- **Never both.** For a chosen CLI `agent_auth`'s place step removes the
  user's own login copies (and Claude's `oauthAccount`) from every home
  instead of placing them; the store keeps them, switching back places
  them again. The adopt step still runs, so a tab from before the switch
  refreshing its token is not lost — but a file holding the admin's
  current *or earlier* key is never adopted, and nothing is adopted when
  that cannot be told: the admin's key never becomes the user's own login.
  The keeper answers that by fingerprints (length + SHA-256 of the current
  key and the last 32 replaced or withdrawn ones, `<cli>/previous.json`),
  which a user on the key's list may ask for — no key travels, and the
  comparison is not audited as a delivery (P3b review findings 7, 8). Off
  the list the keeper answers `no-key`, as for a CLI that never had a key
  (user decision, final review A6: an unlisted user learns nothing of a
  key's existence, length or rotations); the daemon reads that as "holds
  none", so a key file left from while the user was listed is treated as
  theirs — withdrawing someone is a reason to rotate the key. Such an undecidable file also stays in the home until
  it can be told (it may be the only copy of a rotated refresh token); the
  same keeper answer fails every new spawn meanwhile (P3b review).
- **Delivery: the API proxy, as for the user's own key** (user decision
  2026-10-10, #2389). Every local agent spawn of a chosen CLI — the fence
  wraps and the root console's Host session — passes
  `agent_keys::admin_for_spawn` (the keeper's `offered` names the CLI, else
  the spawn fails naming the way back) and gets an `api_proxy` grant marked
  with the CLI (`Grant::admin`): a proxy token under its app-named carrier
  and the CLI's base-URL variable, exactly what an own key gets. The proxy,
  in the user's daemon, asks the keeper for the key per request
  (`agent_keys::for_proxy`: the choice still on, then `get`), keeps the
  answer 60 s and drops it on an upstream 401, and forwards with it — so no
  key enters an agent process, its environment, its home, a file or a
  container, and Claude asks no API-key question (the token is
  `ANTHROPIC_AUTH_TOKEN`). A withdraw, a removal from the list or the user's
  switch back reaches running agents within that minute.
- **What has no proxy, has no key.** A CLI typed into a shell tab runs in
  the `--agent-shim` process, which runs no proxy: a chosen CLI fails there,
  naming the agent tab. A project container cannot reach the daemon's
  loopback: a container spawn of a CLI on any API key fails before the
  container starts (`agent_api_keys::refuse_in_container`). Remote agents and
  Codex get nothing (decided, #2359/#2361). On a server, a tmux older than
  3.2 fails a keyed spawn (it cannot keep the token off its argv).
- **Not charged to the user's own limit.** An admin grant is never metered
  into the user's own ledger: a brokered key is budgeted at the broker, a
  direct one has no per-user budget (§5.4).
- *History:* P3b first delivered Claude's key through its `apiKeyHelper`
  (a helper socket per daemon, bound read-only into Claude's fence),
  Gemini's and Vibe's as env carriers, and every chosen CLI's into project
  containers; none of it shipped, and #2389 replaced it all with the proxy.
- **Fair share at the keeper** (P3b review finding 6): at most 32
  connections, at most 4 per caller uid (counted at accept, by
  `SO_PEERCRED`), each exchange 2 s; a connection over a cap is closed
  unanswered. One user holding connections open leaves the other 28 slots
  to everyone else. The daemon's own requests only read, so one closed
  unanswered is sent again up to 3 times (150/300/450 ms apart): a burst of
  the user's own spawns must not fail a start; the proxy's minute cache
  keeps per-request asks off the keeper. (P3b decisions review.)
- **Audit.** The keeper's `audit.jsonl` (set, remove, and fetches at most
  once per user and CLI per 10 minutes, so a user cannot flood the log)
  and the gateway's own rows for the admin's requests; no key, no
  fragment. The admin panel's "used lately by" is read from the keeper's
  rows (30 days).
- **Residuals, as §5.4 accepts them.** No agent can read the key, but
  every agent of a user who chose it can spend through its tab's token while
  the tab lives (as with an own key). A listed user's own unfenced processes
  can fetch the key from the keeper, chosen or not: the choice picks what
  the agents run on; the admin's list is the access control. Direct mode has
  no per-user budget (the broker is P5). A daemon restart drops every token,
  so a keyed agent in a tmux tab that outlived it must be restarted.

## The key broker (P5, §5.4)

```
agent (fenced, host netns) ─ANTHROPIC_BASE_URL=http://127.0.0.1:8739/claude─►
   <slug>-gateway broker (<slug>-auth, port held by <slug>-keybroker.socket)
      token → user (<cli>/tokens.json) · list/broker/budget (meta.json)
      the key in the provider's header ──HTTPS──► the provider
      usage from the answer ──► /var/lib/<slug>-broker/<cli>/usage/<user>.json
```

- **The broker holds the keys read-only** (final review A3). It is the
  `<slug>-auth` account's only network-facing process, so it does not get
  the keeper's `StateDirectory=`: under `ProtectSystem=strict` (and an
  explicit `ReadOnlyPaths=`) it reads the keys, user lists and tokens but
  cannot write them; its own `StateDirectory=<slug>-broker` holds the month
  counts and its audit rows, which the keeper reads. A memory-safety flaw in
  its TLS/HTTP/JSON handling can still read every key (one account), not
  plant or change one.

- **What changes for a user**: nothing they choose. The administrator
  switches a key's delivery to the broker (per CLI, Agent credentials
  panel); the keeper then answers a listed user's `get` with that user's
  **broker token** (minted at the first fetch, `<cli>/tokens.json` `0600`)
  plus the broker's URL, and its `offered` names the URL. The user's
  daemon's API proxy then forwards that user's requests to the broker URL
  with the token in `x-api-key` (over a plain-HTTP client for loopback
  only; the URL is checked to be `http://127.0.0.1:<port>/<cli>`) — the
  agent holds only its proxy token (#2389). The key never leaves
  `<slug>-auth`, the broker token never leaves the daemon.
- **Which CLIs**: only rows of `keys_wire::BROKER_CLIS`, i.e. a CLI whose
  base-URL override the vendor documents (Q2's broker question): Claude.
  Gemini CLI and Mistral Vibe stay direct-only until their overrides are
  verified; the keeper refuses `delivery: broker` for them (`unsupported`).
- **Why loopback HTTP, and why systemd holds the port.** Fenced agents share
  the host's network namespace (`project_fence_abstract_sockets`), so a
  loopback port is the one place every user's fenced agent can reach
  without a bind mount; plain HTTP because it never leaves the host. Any
  local process can connect, hence the per-user token. The port belongs to
  `<slug>-keybroker.socket` from boot: if the broker were down and the port
  free, another account could listen there and collect the tokens other
  users' agents send. A request with an `Origin` header (a browser page
  aiming at loopback) is refused before anything else.
- **What is forwarded**: `POST v1/messages`, `POST v1/messages/count_tokens`,
  `GET v1/models[/<id>]` — nothing else (no Files, Batches or admin API on
  the administrator's key); a fixed list of request headers, the token
  replaced by the key in the provider's key header (the client's `x-api-key` and
  `Authorization` both dropped), cookies and everything else stay behind.
  Streamed answers pass back as they arrive (`reqwest` `chunk()` → axum
  body); a metered JSON answer is read whole and metered first (its
  `usage` comes last, so a client could otherwise take the content and
  leave before the count).
- **Budgets and metering.** Monthly (UTC calendar month), in *billed
  tokens*: input, cache writes and output in full, cache reads at a tenth
  (`keys_wire::billed`, roughly the price ratio; one number whatever the
  model). Per user, else the key's default, else no cap. Checked before a
  `messages` request is forwarded — so the cap is soft by the requests in
  flight — and a refusal is the provider's error shape (`403
  permission_error`, so Claude shows it rather than retrying). Usage is
  read from the provider's own answer: the JSON `usage`, or the stream's
  `message_start` / `message_delta` events (each field the larger seen).
  The meter records on drop, so a client gone mid-stream still pays for
  what was produced until then; a stream's output count comes only in its
  closing `message_delta`, so one left before it bills the streamed text
  instead (deltas' bytes at three a token — an interrupted answer is billed
  a little high, never free). Twelve months kept per user.
- **"Into the user's own stats"**: the user's daemon asks the keeper for
  its own month (`Request::Usage`, listed users only) and Manage CLIs shows
  it beside the switch; the transcripts the token-stats recap already reads
  count the same tokens, as for any Claude session.
- **Revocation without rotating the key**: taking a user off the list,
  **Renew token** (drops one user's token), withdrawing the key or
  switching back to direct delivery all remove tokens; the broker looks the
  token up per request, so the next request is a `401` — on which the
  daemon's proxy drops its cached token and asks the keeper again, getting
  the user's current answer for the request after it.
- **Fair share**: 256 requests in flight in all, 16 per user (`429
  rate_limit_error` beyond, which the CLI retries); 32 MiB per request
  body; 10-minute read timeout towards the provider.
- **Hardening**: the unit runs as `<slug>-auth` (the keeper's account — it
  reads the key and the token file directly), `ProtectSystem=strict`, no
  capabilities, `AF_UNIX AF_INET AF_INET6` only; not `PrivateNetwork`
  (it calls the provider). TLS through the app's own `reqwest`/rustls stack
  with the platform verifier; redirects never followed.
- **Containers**: a project container's network namespace does not reach
  the host's loopback, so a container spawn of a CLI on any API key — brokered,
  direct or the user's own — fails, naming the way out (container off, or the
  user's own login; #2389).
- **Audit**: the broker appends to the keeper's `audit.jsonl` — a user's
  brokered use at most once per 10 minutes per CLI
  (`agent-key-brokered`), a budget refusal likewise
  (`agent-key-over-budget`); the keeper adds `agent-key-delivery`,
  `agent-key-budget`, `agent-key-token-renew`, `agent-key-token-delivered`.
  Never a key, a token or a prompt.
- **Residuals**: a user's token is readable by every agent of that user
  that runs the CLI (as the key was) — but it spends only that user's
  budget and dies on its own. The broker sees prompts and answers in
  transit (it is the administrator's process, like the key). A user over
  budget can still run on their own login. Not run against the provider:
  the broker was tested against a fake provider on loopback only (#2377).

## OIDC sign-in (P5, §4.1)

```
browser ─POST /gateway/v1/oidc/start {public_key}─► gateway: state, PKCE, binder cookie,
        ◄─ provider URL (nonce = H(public_key)) ───        nonce bound to the key
        ─► provider sign-in ─► GET /gateway/v1/oidc/callback?code&state (+binder cookie)
gateway ─code+secret+verifier─► token endpoint ─► ID token
        ─route by the account linked to its person (gateway.json `oidc`)─►
daemon  POST /api/v1/pair {oidc_token, public_key}: signature (issuer's JWKS),
        iss/aud/exp/iat, nonce == H(public_key), its own binding (oidc.json) ─► device
browser ◄─ 303 /?oidc=paired&device=<id>: the pending key becomes the pairing record
```

- **What it replaces**: the invite code, and only that. A provider sign-in
  pairs a device key; sessions remain device-key challenge/response and
  the gateway's routing cookie. Invites keep working beside it.
- **Two copies of the link, as with invites.** The admin helper's
  `user-oidc NAME --sub ID` writes the link into the
  gateway's table (routing: which account's daemon gets the token) and, by
  the user's own uid (`<slug>-serverd --write-oidc-binding`, JSON on stdin),
  the daemon's `mobile-control/oidc.json` with the issuer and client id —
  what the daemon checks against. One person routes to one account. The
  gateway never decides: it cannot pair a device for an account without a
  token the provider signed for that account's person and **for that key**
  (the nonce is a hash of the public key being paired), and the daemon
  spends each nonce once.
- **The gateway as relying party.** `oidc-set --issuer https://… --client-id
  … --name …` reads the client secret from stdin into `oidc.json` in the
  gateway's state (`0600`, handed to `<slug>-gw`); discovery from the
  issuer's `.well-known/openid-configuration` (cached for an hour, the
  `issuer` inside must match). Start: PKCE S256, `scope=openid email`, a
  random `state`, and a **binder** — random, its hash kept with the pending
  sign-in, the value only in a `__Host-oidc_binder` cookie (`Secure`,
  `HttpOnly`, `SameSite=Lax` because the provider's redirect back is a
  cross-site top-level navigation). The callback takes the pending sign-in
  by `state` and the binder together, one try, ten minutes: a sign-in URL
  someone else started (with their own key) and sent to a victim cannot be
  completed in the victim's browser — the classic login-CSRF that would
  otherwise pair the attacker's key to the victim's account. The code is
  exchanged with the secret (`client_secret_post`) and the verifier; the ID
  token from the token endpoint is read unverified **for routing only**.
- **The daemon verifies.** `services::server::oidc::check`: RS256 (`ring`)
  or ES256 (`p256`) only — never `none`, never HMAC (the client secret
  could sign that); the key by `kid` from the issuer's JWKS (`jwks_uri`
  from discovery, HTTPS, cached an hour, re-fetched at most once a minute
  for an unknown `kid`); then `oidc_wire::check_claims`: `iss`, `aud` (and
  `azp` when several), `exp` (2 min skew), `iat` no older than 10 minutes,
  `nonce`, and the person (`sub` exactly, or `email` case-insensitively
  only with `email_verified: true`).
- **Rate and noise**: start and callback count against the gateway's
  stranger windows; at most 256 sign-ins pending; audit rows `pair-oidc`
  (`ok`, `refused`, `unknown`) without the person's identity or any token.
- **Residuals**: a compromised gateway (it holds the client secret and
  terminates the callback) can pair a key of its own to an account whose
  person signs in *through it* — no worse than its position on live
  sessions (§ Shape). The daemon fetches the provider's keys itself (it has
  network; the gateway is not trusted for them). Links are by `sub` only
  (user decision, final review): an email link would trust the provider's
  `email_verified`, and where the address is a mutable profile field that
  is a takeover path. Not run against a real provider (#2378).

## Host-channel inventory (§4.4)

| Listener | Who opens it | Protection | Server status |
|---|---|---|---|
| Daemon socket `/run/<slug>/users/<u>.sock` | systemd (socket unit) | `root:<slug>-gw 0660` in a `0750 root:<slug>-gw` dir + daemon's peer-uid check | closed to users |
| Gateway `127.0.0.1:8740/8741` | `<slug>-gw` | routing cookie / pairing; the daemon's own auth behind it | reachable by every local user, same as through Tailscale |
| Sidecar loopback port + content port | desktop only | token link, loopback Host/Origin checks | **not opened** by a daemon (`Listen::Unix`) |
| tmux server | tmux unit | `/run/<slug>/tmux/<u>` `0700` | closed |
| Key keeper `/run/<slug>/auth.sock` | systemd (socket unit) | `0666`, decided per caller uid (`SO_PEERCRED`): gateway sets/lists, a server user fetches, others refused; hidden from fences (`/run` tmpfs) | open to every local account by design; a server user can read an offered key |
| Key broker `127.0.0.1:8739` | systemd (`<slug>-keybroker.socket`, held from boot) | per-user broker token per request; `Origin` refused; fixed paths only | reachable by every local account by design; spends only the token holder's budget |
| Share hub `/run/<slug>/hub.sock` | systemd (socket unit) | `0666`, per caller uid (`SO_PEERCRED`): server users only, owner/member rules per share; hidden from fences (`/run` tmpfs) | open to every local account by design; a non-member learns nothing about a share ([`sharing.md`](sharing.md)) |
| Shared-calendar service `/run/<slug>/calendar.sock` | systemd (socket unit) | `0666`, per caller uid and per calendar part; hidden from fences | open to every local account by design; a non-member learns nothing ([`sharing.md`](sharing.md)) |
| Daemon admin socket | daemon | `<state>/mobile-control/admin.sock` in a `0700` dir | closed |
| Agent MCP listener (`root_mcp.rs` `start_headless`) | each user's daemon, `127.0.0.1:<random>` | per-tab bearer token, one route per lane, the daemon's own token store | reachable by every local account; serves every lane the window's does — root, local-model, reader, markup, schedule, push, help (2026-10-11, #2390/#2391) |
| Shared Ollama `127.0.0.1:11434` | admin's system service | none (decided 2026-10-03) | residual: any shell can drive it; model changes are `admin` |
| VM egress proxy (`vm_proxy.rs`) | admin's VMs | per-VM `Proxy-Authorization` credentials (`<vm dir>/proxy.token`), `407` without — server only; a desktop VM's proxy stays open (one account on its loopback; not every agent CLI is known to send proxy credentials) | closed to other users (`45d1920d`, never booted) |
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
