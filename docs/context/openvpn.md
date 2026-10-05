# OpenVPN tunnel

Referenced from `AGENTS.md`.

- The **OpenVPN tunnel is machine-wide, not project-scoped.** It runs elevated
  (`pkexec openvpn`) and Tabtivity passes it no routing flags, so a config that pushes
  `redirect-gateway` reroutes *the whole computer's* traffic — browser included — for
  as long as it is up, whichever project asked for it. Two consequences are baked in:
  it is tracked machine-level in `src/stores/remote/vpn/vpnStatus.ts` (keyed by config path, with
  a holder refcount — `releaseVpn` means a project logging out never pulls a tunnel out
  from under another project) and surfaced in the header by `VpnIndicator`, which is
  always present, lists every stored `.ovpn`, and can bring a tunnel **up or down with
  no project behind it**. Every UI that can start a tunnel says so before it does —
  and none of them offers a *second* one: while a tunnel is up machine-wide, every
  project-scoped OpenVPN block (the Connect modal, and the SSH section the
  new-project and extend-to-remote dialogs share) collapses to a one-line
  "tunnel already up" notice pointing at the header, via the shared
  `useVpnSectionVisible` gate + `VpnTunnelUpNotice`. The exception the gate keeps:
  a tunnel *that* dialog itself brought up stays expanded, so its log and its
  Disconnect remain where the user started it.
  Interactive (non-headless) tunnels are *armed* at command-build time —
  `interactive_connect_command` appends a `--writepid` Tabtivity owns and registers it —
  so a tunnel typed into a terminal tab is as visible and as killable as a headless
  one, and no longer outlives the app still owning the routing. Split-tunnelling is
  **not** implemented: whatever the `.ovpn` pushes still applies (TODO #82).
- **A headless login that cannot work is escapable, per tunnel.** Tabtivity's own login
  models exactly two secrets (account password, key passphrase); a config whose server
  asks anything else — a challenge/OTP, a second prompt — is unanswerable from the
  modal, and no amount of retyping changes that. The symptom is a loop: the saved
  credentials fail, the prompt opens, the password typed into it fails too. So every
  headless VPN surface offers the **non-headless flow for that one connect** —
  `VpnPasswordPrompt`'s "Log in in terminal" (always present, disabled only while an
  attempt is in flight, since that attempt's teardown is by *config* and would take the
  terminal tunnel with it), and, after a failed connect, the same offer in the two
  connect dialogs, which open their own embedded login terminal instead of a root tab.
  It is deliberately a **local** switch and never writes `connections_headless`: a mode
  is how the user wants Tabtivity to behave, not something a failed handshake decides for
  them. `lib/remote/vpn/vpnAutoConnect`'s `openVpnLoginInTerminal` is the one implementation of the
  handoff (arms the tunnel, opens the root tab, polls), shared with the paths that are
  always non-headless. The prompt rejects its caller with `VPN_TERMINAL_HANDOFF` —
  checked by every caller of `request`, because it is *not* a failure: the lamp is
  amber, the poll owns the outcome, and reading it as "no tunnel" would paint a login
  the user is still typing red.
- A tunnel can also be armed to **connect on launch** (`settings.vpn_auto_connect`,
  toggled per config in the `VpnIndicator` menu; `src/lib/remote/vpn/vpnAutoConnect.ts`). It is
  the machine-level twin of a project's `remote.auto_connect` and keeps the same
  promise — *it never prompts*: the opt-in is only offered when the credentials make
  the connect silent, and it is re-checked at launch, so a stale opt-in leaves the
  tunnel down. One config, not a set: two would be two claims on one machine's routing.
  With `connections_headless` off it instead opens the connect command in the root
  terminal, since Tabtivity handles no passwords in that mode.
- **Never elevate on a connect that cannot succeed.** `pkexec` authenticates the user
  *before* OpenVPN reads the config, so a doomed attempt is not a cheap failure — it
  costs a polkit dialog, and the modal that then collects the missing credential costs
  a second one. Every silent-connect path therefore asks `vpn_can_connect_silently`
  first (`src/lib/remote/vpn/vpnConnect.ts`) and goes straight to the modal when the answer is no.
  The missing credential was usually the `auth-user-pass` **username**: it lived only
  on a project's `OpenVpnSpec`, so a tunnel started from the header had none — the
  backend now keeps a copy beside the saved password (`openvpn_user_account`), saved
  and cleared by the same opt-in checkbox as the secrets.
- **One polkit prompt per tunnel, on connect — and closing Tabtivity never traps you.**
  Elevation is unavoidable to *build* a tunnel (tun device + routing), but stopping
  one is not: every tunnel Tabtivity starts, headless or typed into a terminal tab,
  carries an owner-only `--management` socket on loopback, and teardown asks the root
  daemon to `signal SIGTERM` **itself** — nothing to elevate, so no second password.
  The endpoint sits beside the pidfile so a tunnel from a previous run stays
  stoppable after a restart. It is deliberately an *optimization*: an unconfirmed
  shutdown (or a config carrying its own `management` directive, which `--management`
  twice would turn into an options error) falls back to the old `pkexec kill`, so no
  path can silently strand a tunnel. And that fallback is asked **at most once** — on
  the close path, while the window is still on screen. Declining it does **not** block
  the quit: Tabtivity warns that the tunnel stays up and closes anyway, and records the
  refusal so the exit-time teardown does not raise a second, parentless polkit dialog
  after the window is gone (which is what used to leave the machine unusable).
- **A VPN-only mail or CalDAV account** (`require_vpn` on `MailAccount` /
  `CalDavAccount`, 2026-09-09) is the tunnel's one consumer outside remote projects.
  An institutional mailbox or calendar server is often reachable only from inside
  its network; without the gate every interval check burned a connect timeout,
  painted the header red, and nothing caught up when the tunnel returned. "VPN on"
  means **a tunnel this registry knows about** — `any_tunnel_up()` is
  `!active_configs().is_empty()`, headless or terminal-tab — so a tunnel from
  NetworkManager or WireGuard is invisible and a gated account never syncs; the
  dialogs say so. Enforced at each subsystem's one choke point (`mail_engine`'s
  `vpn_gate` before every operation, `commands::caldav::credentials` before the
  keyring is even read) with one shared sentence, `VPN_GATE_REFUSAL`. The frontend
  schedulers (`MailIndicator`, `CalDavSyncHost`; `src/lib/remote/vpn/vpnGate.ts`) skip a gated
  account quietly while down and check it on the tunnel's **rising edge** — a
  reconciled `false → true` only, never the store's first sight of a tunnel at
  launch, which would be a check at mount by the back door.
