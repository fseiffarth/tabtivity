# Remote auto-connect

Referenced from `AGENTS.md`.

A remote project connects **on demand** (the pill's connection lamp opens the
`RemoteConnectDialog`) — *unless* it opts into `remote.auto_connect`, which
connects it on launch and on activation and **never prompts**. The toggle is only
offered when that promise can be kept: a saved SSH password, or a host the backend
recorded as `remote.key_auth` (it authenticated with no password at all). Whether
the OpenVPN tunnel is needed is a property of the *network*, not the project — the
same host is often reachable directly at one site and only through the tunnel at
another — so `autoConnectRemote` (`src/stores/projects.ts`) probes (`ssh_probe`)
and brings the tunnel up only when the host is genuinely *unreachable*, never when
it merely rejected a credential.

With **`connections_headless` off** the promise is kept differently, because it
cannot be kept that way at all: Tabtivity persists no passwords in that mode, so the
eligibility gate above can never pass and auto-connect used to reject every project
and do nothing, silently. There, "auto-connect" means what it means for a tunnel
armed in the header (`lib/remote/vpn/vpnAutoConnect`): the login opens in the **root
console** as a login tab (its PTY runs ssh itself, no shell — `remote_credentials.md`)
for the user to authenticate, and the pool then rides the ControlMaster
that login leaves behind (`autoConnectInteractive` → `pollRootLoginReady`, the
store-side twin of the Connect dialog's `pollSshReady`). No *modal* is raised on
either path — that is the invariant; a saved credential is only how the headless
path achieves it. The toggle is correspondingly ungated in that mode, and the probe
still decides the VPN: reachable-but-rejected is the normal state of a password host
there and must never be read as "this network needs the tunnel". When the host *is*
genuinely unreachable and the project carries a `.ovpn`, non-headless auto-connect
surfaces the **tunnel's** login in the root terminal too — but it must **never** mark
the machine-wide tunnel `"connecting"` or poll it from this path. A tunnel is
machine-wide and its lamp is shared, so an *unattended* project poll that resolves
late (or not at all, on a switch-away) strands the header on a phantom `"connecting"`
— which `VpnIndicator`'s Disconnect refuses to touch (disabled while connecting) and
the Connect dialog reads as a live tunnel (`anyVpnLive`), so the tunnel is at once
un-stoppable and un-reconnectable. The machine-wide lamp therefore has exactly one
owner that cannot strand it: `VpnIndicator`'s 10 s `refresh` reconcile, driven by the
backend's real tunnel set. Auto-connect just leaves the SSH lamp **red** and returns;
when the reconcile flips the tunnel to `connected` it fires `retryAutoConnectAfterVpn`,
which resets that red lamp and re-runs the connect — now reachable. (For the same
reason `pollVpnUp`, still used by the *manual* reconnect path, polls to a terminal
mark regardless of the active project rather than bailing mid-handshake.) Because the
login tab **is** the connection on that path, closing it is an outcome of its own
(`"closed"`, distinct from `"timeout"`): the lamp goes back to *disconnected*, not
red, since the re-attempt guard only fires from `"off"` — a red lamp would read a
deliberate dismissal as a failure and wedge the project shut. The root-terminal
dedupe (`lib/remote/remoteConnect`) expires with the tab for the same reason: it now maps
each key to the tab carrying it, so a closed login stops claiming the key and the
next activation offers the login again instead of waiting on a master that is never
coming. A `null` mapping is a connection another surface owns (the Connect dialog's
embedded terminal), whose lifetime stays that surface's business.

## The three gates, and why "armed" is not one question but three

`auto_connect` is the *user's* opt-in, and for a long time it was the only thing
checked — which was the bug: a project could be dialled unattended by paths that
never asked. Every unattended connect now passes the same three, in order:

1. **`mayAutoTouch(settings, target)`** (`src/lib/remote/hpc/hpcHost.ts`) — fail-**closed**.
   `isHpcHost` answers `false` for a null settings object, which is right for
   painting a badge and wrong for authorising a connect; the launch sweep runs in
   exactly that window, so it needed a predicate that says *no* while it doesn't
   yet know. `stores/projects`' `load()` additionally awaits the settings store
   before auto-connecting at all.
2. **the host's own `auto_connect`** — primary or worker. This is the one that
   `silentReconnectDeadHost` was missing: a 15 s reconciler re-dialled any host
   whose pool had died, so a single manual connect to a host the user had never
   armed became a permanent reconnect loop, one per `ControlPersist` expiry. Its
   doc comment claimed it applied "exactly the same eligibility bar" as
   `autoConnectPrimary`. It did not; it does now, and a dropped session ends at a
   red lamp rather than a re-dial.
3. **eligibility** — a saved password or `key_auth`, so the promise never to
   prompt is kept.

**A global machine armed for auto-connect is the host's opt-in too** (gate 2,
`machineArmsHost` in `lib/remote/machineSync`, matched by `sameTarget`; only while
the Machines feature is on). There is **one path**: the project's own
(`autoConnectPrimary`/`autoConnectWorker`, `silentReconnectDeadHost`,
`retryAutoConnectAfterVpn`), so HPC, probe, VPN, headless handling and the
no-prompt rule are the same whichever surface armed the host — a local project's
`compute_hosts` included (activation fires for them too), and the launch /
tunnel-up machine sweep ends by re-running it for the active project. *Armed*, not
*connected*: the toggle is the machine twin of `auto_connect`, while a machine's
`connected` lamp is never polled and would hand the dead-host reconciler the very
re-dial loop gate 2 stops. A machine-only opt-in lets the probe stand for
eligibility (no "nothing saved" toast for a key login the project copy never
recorded), opens no root-console login tab non-headless (red lamp instead), and
connects with `viaLogin` so riding the machine's master is never recorded as key
auth. A hand-connected machine still lights the active project on its own
`→ connected` edge (`syncGlobalConnected`), and a project activated while such a
machine is connected rides it once (`syncConnectedMachinesInto`, from an `off`
lamp only; never the dead-host reconciler) — switching away drops a project's
pools, and a tab on that host otherwise stayed held while the machine sat green.

An armed project that fails (3) is no longer *silent*. It used to `return` with no
lamp, no toast and no console line, which reads exactly like "auto-connect is
broken" — and, since a locked keyring answers the same as an empty one, that is
what the user saw when their credential had merely become unreadable. It now says
which of the two happened (`remote_saved_password_state` returns
`{ saved, keyring }`, not a boolean), and the keyring case offers the same
**Unlock keyring** action the VPN side has had all along.

## Unreachable is re-tried; rejected is not

Every unattended path tries **once**, and for a long time an unreachable host
ended there, at a red lamp only a tunnel coming up (`retryAutoConnectAfterVpn`)
cleared. That made reconnecting a matter of timing: the dead-host reconciler
notices a dropped master within 15 s, and after a wake or a Wi-Fi hop the network
is often not back yet; a launch that beats the network fails the same way. So a
host whose probe says `unreachable` (nothing answered, no credential presented) is
re-tried on a backoff to a five-minute cadence (`scheduleUnreachableRetry` in
`stores/projects`), and the webview's `online` event runs pending re-tries at once
(`lib/remote/remoteAutoReconnect`). Each re-try re-checks the gates and that the
lamp is still the red one it left, so the user connecting, disconnecting or
switching away ends it. A host that answered and said no is **never** re-tried —
that would replay a rejected login. Non-headless, an unreachable host opens no login
tab (ssh in it could only fail); the login opens on the re-try that finds the host
answering, and a re-try never re-opens the tunnel's login. The dead-host path no
longer gives up outright non-headless either: the probe is its eligibility check,
so a key host reconnects and a password host goes red.

Two gaps stayed after that (2026-10-29). "Unreachable" now also covers a
connection dropped *before* authentication (reset, closed during the key
exchange — sshd's `MaxStartups` does that to a burst of connects to one
cluster — or a network that is down), unless the text names an auth or
host-key failure (`ssh_unreachable`). And a connect that throws *after* its
probe passed re-probes (`retryAfterFailedConnect`): unreachable joins the loop,
a host that lets us in gets three re-tries and then stays red. The Remote
machines window's **Reconnect all** (`reconnectAllHosts`) is the click for
whatever is left: every host not connected, no opt-in needed, never a prompt,
the errors named under the button.

Everything above leans on `SshProbe.unreachable`, and until 2026-10-30 that flag
was false for the failures it exists for. `ssh_probe` classified the message
`explain_ssh_error` had already rewritten for a person ("No route to the host…"),
which holds none of OpenSSH's phrases, so a timeout, a missing route or a failed
DNS lookup read as "the host said no": no re-try, and a project recovered only
through a tunnel coming up, which is why reconnecting seemed to need the VPN even
on the network that doesn't. The classifier reads ssh's raw stderr now
(`run_ssh_auth_raw`, `probe_verdict`), and the explained text stays for display.

Finally, none of this is the only line of defence: the backend refuses a
background dial to a tagged host inside the ssh-argv builders themselves
(`docs/context/hpc_careful_mode.md`, "The dial policy"). The frontend gates decide
what to *offer*; the backend decides what may *happen*.
