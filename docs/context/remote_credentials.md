# Remote credentials & host security

Referenced from `AGENTS.md`.

- **A locked keychain is not an empty one, and Tabtivity must never confuse the two.**
  On Linux the Secret Service collection holding every saved SSH/VPN credential can be
  *locked*, and through the `keyring` crate a locked collection reads exactly like an
  empty one: every lookup answers "nothing saved". That is not a cosmetic difference —
  it silently un-saves the credentials the user explicitly asked to keep, so a restart
  brings back a blank password prompt, no silent connect, and an armed auto-connect
  that quietly does nothing (reads used to *hang* there instead, which is why
  `remote_credentials::read_timed` bounds them at 4 s — the bound turned a freeze into
  this silence). So the lock is a first-class state: `keyring_state`
  (`unlocked`/`locked`/`unavailable`) and `keyring_unlock` (`commands::credentials`,
  `src/lib/keyring.ts`), the latter raising the *system's* unlock dialog and therefore
  only ever reachable from a click — never from a launch path, which promises not to
  prompt. Because the keychain cannot be asked while locked, the **intent** to remember
  a tunnel lives outside it, in `settings.vpn_saved_configs` (paths, never secrets);
  it is what lets the VPN menu's "Save login credentials" toggle show the truth at
  startup, lets Connect know an unlock is worth raising, and is reconciled back against
  the keychain whenever that *is* readable. The header's VPN menu is where all of this
  surfaces: a locked banner with **Unlock keyring**, and the per-config save toggle
  beside "Connect on launch" — which is also the only place a **non-headless** user can
  hand Tabtivity a VPN secret at all, since that mode otherwise has no password fields.
  In that mode the header's Connect uses saved credentials when it has them and
  otherwise opens the connect command in the **root terminal**; it never raises a modal.
  - **A locked collection is never dispatched to, and mostly does not have to be.**
    `read_timed` bounds the *caller*, but the abandoned worker stays parked inside the
    Secret Service call for as long as the unlock prompt goes unanswered — one thread
    holding one open D-Bus connection, per read, on every connect path. When the process
    exits they all drop mid-request, which is the state `gnome-keyring-daemon` aborts on;
    systemd then restarts it *without* the login password PAM gave the original, so the
    collection comes back locked and the next run parks its reads again. `get`/`set`
    therefore ask `cached_keyring_state()` (one prompt-free probe per 10 s) **first** and
    refuse to dispatch while locked — a write says so, a read falls to the cache below.
    That cache is the other half: on Linux the store is `keyutils_persistent` — the
    **kernel keyring in front of** the Secret Service, which stays the half that survives
    a reboot — so only the first read of an account per boot is a D-Bus call at all, and
    every later one is a syscall that cannot block, cannot prompt, and does not care that
    the collection is locked. It is built by hand (`KeyutilsPersistentCredential`), not
    via `keyring::Entry`: keyring 3.6's builder for that store returns a plain
    secret-service credential, so the feature alone would be a silent no-op. The
    consequence for callers is that **a lock is no longer proof that the silent path is
    dead** — ask `canConnectVpnSilently` first and read the lock only to explain a *no*,
    or a connect that needed nothing raises a system password dialog.
- **Passwords are never persisted by default**, and the opt-in that persists them is
  the same in every remote menu — the Connect modal *and* the new-project /
  extend-to-remote dialogs (`useRemoteSession`, rendered by `RemoteProjectSection`).
  It can be, because the keychain is keyed by **host target** (`ssh:user@host:port`)
  and **config path**, never by project id: there is one saved credential per host and
  per tunnel, whichever menu saved it. Hence the toggle is *pre-ticked* when the target
  already has one (an untick is an explicit delete, so connecting with it unticked
  would clear another project's saved password), and a blank password field means "use
  the saved one", not "authenticate with nothing". The extend dialog hands the
  credential it authenticated with straight to its `remote_connect` (never written to
  disk, never parked in the frontend — the old `stashRemotePassword` map was
  write-only and was deleted, screen 2026-10-15 #11): connecting it password-less
  would work — it rides the ControlMaster the dialog left up — but the backend reads
  "no password given, none saved" as *key* auth and would record `key_auth: true` on
  a password host, which auto-connect later believes.
  That inference is now the caller's to disclaim, because handing over the password is
  only one of several ways a connect ends up credential-less. `remote_connect` takes
  **`via_login`**: "this may be riding a master somebody else authenticated" — the
  non-headless login terminal, the session an add-machine/extend dialog left up, a
  global machine's master. `commands::remote::record_key_auth` then answers `None`
  ("this proves nothing, write nothing down") instead of `Some(true)`. A *password*
  is still recorded either way: that is an observation, not an inference.
  The create dialogs (`ProjectDialog`, `HpcPipelineWizard`) now open the new
  project's first pooled connect themselves, as the extend dialog does
  (`lib/remote/remoteConnect`'s `connectCreatedRemoteProject`): the typed password if
  there is one, else `via_login` — a credential-less first connect there can only be
  riding the dialog's login master. Before, nothing connected a new project until the
  lamp was clicked, and that connect (blank password, riding the dialog's master)
  could record `key_auth: true` on a password host.
- **Headless is a default, not a trap: every login section can be switched to a
  terminal, for one connect.** Tabtivity's own login can only ask what it has fields for —
  an SSH password, an OpenVPN password and key passphrase. A host or tunnel is free to
  ask something else (keyboard-interactive challenge, a one-time code, an expired
  password), and then no number of retries can succeed; the observed symptom is a loop
  of *credentials rejected → prompt → rejected*. So both connect dialogs carry
  **"Sign in in a terminal"** (`components/projects/TerminalSignInToggle`) on both
  channels, **default off**, which swaps the password fields for the same embedded
  login terminal `connections_headless: false` uses — the server asks its own
  questions, the user answers them, Tabtivity still never sees a secret. The VPN password
  modal has the same escape hatch as a button (`stores/remote/vpn/vpnPrompt`'s
  `handoffToTerminal`), since it has no fields to swap. Four rules make it safe:
  it is **per connect** and never writes `connections_headless`; it is **not offered on
  Windows**, which has no ControlMaster for a terminal login to leave behind (the
  `winManual` reason); a started terminal **keeps the login section**, so flipping back
  cannot orphan a live session; and it **never touches a saved credential** — the Save
  password/passphrase row is rendered from *both* halves of the section (`sshSaveRow` /
  `vpnSaveRow`), because the secret belongs to the host, not to how you happened to
  sign in this time, and only an explicit untick ever deletes one. A terminal login
  leaves no credential, so its connect must go out with `via_login` — otherwise its
  credential-less success is read as key auth by the rule above. (The dialogs' old
  `stashRemoteViaLogin` mark had no reader and was deleted with `stashRemotePassword`.)
  - The **add-a-machine** form (`RemoteMachinesWindow`) had no terminal login at all —
    only the password field, in *both* modes — so it now grows the same one, and its
    switch **defaults to on in non-headless mode**, where a password field was never
    supposed to be. It cannot reuse the dialogs' plumbing (that lives in
    `useRemoteSession`/`useRemoteReconnect`, which are per-project), so it drives the
    shared browse hook directly: open an ssh login PTY in an embedded terminal,
    poll a credential-less `ssh_connect` until the login's ControlMaster answers, then
    `useRemoteBrowse.openSession` — freeze the session the user just authenticated,
    with no second login. Its "Save password" row is *disabled* rather than hidden in
    that path: the toggle only ever acts through `ssh_connect`'s `remember`, which a
    terminal login never calls, so the keychain is left exactly as found.
  - The header's **Machines** add form (`MachinesIndicator`) gets the same switch, but
    its login goes to the **root terminal** rather than an embedded one: that menu
    closes 250 ms after the pointer leaves it, which is no place to keep a live PTY —
    and it is what the VPN indicator beside it already does in that mode. The finisher
    differs too: there is no folder to browse, so once the poll sees the master it
    calls the store's `register` (persist without authenticating) instead of `add`
    (which would `ssh_connect` a second time and re-ask for the password this mode
    exists to avoid). The label and "Connect on launch" fields are read through refs —
    a poll re-schedules itself through the closure of the render that started it, and
    a label typed while the login is still open is exactly the case that would drop.
- **A terminal login and a saved credential are not a contradiction, so the keychain
  is reachable from one — by the user's click, and only then.**
  `connections_headless: false` (and every "Sign in in a terminal" flip above) means
  Tabtivity does not *handle* the secret: the host asks its own questions in a terminal
  the user is watching. It never meant the keychain was empty — a password saved from
  a headless connect, or from the header's VPN menu, sat there unreachable while it
  was retyped into every login. `components/projects/CredentialPasteBar` is the way
  in: a **"Type it for me"** row above each embedded login terminal, with a button per
  credential the target actually has (`sshPasteEntries`/`vpnPasteEntries`, one
  definition for all three surfaces). Five things keep it inside the policy above.
  The secret **only reaches a login the backend itself is running**: a login
  terminal is a *login PTY* — `pty_spawn` with `login: {kind: "ssh", user, host,
  port}` / `{kind: "vpn", config}` — whose program is the ssh / OpenVPN argv the
  backend builds for that target (`ssh_exec::interactive_login_args`,
  `openvpn::interactive_connect_argv`), spawned directly with the caller's
  `cmd`/`args`/`env` discarded and no shell before or after it. Only such a spawn
  marks its PTY as a paste target, for that target's own accounts; the mark goes
  when the login's child exits, when the PTY is killed, and on any respawn of the
  id. A login cannot ride with a project, agent, container, Host session, tmux or
  schedule flag, and a VPN login is refused for a browser client (the tunnel is the
  desktop's). A browser client's ssh login must name a host a remote project
  (primary or worker) or a global machine already stores — same user, host and port,
  compared as the keychain account spells them — so a client cannot make the server
  dial any host; the desktop window keeps any host, since adding a machine or project
  logs in before it is stored. Accepted residual: after a successful ssh login the PTY *is* the
  remote shell of the account the credential authenticates, and a paste there
  stays allowed — same trust domain. (It replaced a gate that marked a shell PTY
  once a backend-minted login command line was typed into it, which left a
  shell running before and after the login — a paste target the login no longer
  held.) The frontend asks for one with `TabEntry.login` (the root console's login
  tabs, `lib/remote/remoteConnect`'s `openConnectionInRoot`) or `TerminalView`'s
  `login` prop (the dialogs' embedded logins); target type and dedupe key live in
  `lib/remote/loginTarget`. A login tab is never persisted or restored (a restored
  one would prompt at launch), never tmux-wrapped, and once its login exits it no
  longer counts as the connection's open terminal, so the next request opens a
  fresh one.
  The secret **never enters the frontend**: `credential_paste_to_pty`
  (`commands::credentials`) reads the keychain and writes the bytes into the PTY
  *inside the backend* — no field, no component state, no event payload; only the
  non-secrets (an SSH login name, a VPN auth username already shown in a plain field)
  are pasted from JS via the ordinary `pty_write`. It is **user-initiated, at a
  terminal the user is looking at** — the distinction that matters against the
  next bullet: Tabtivity still never *answers a prompt* on its own, it types what it was
  asked to type, where the user put the cursor. It **submits nothing** (no newline), so
  a paste into the wrong prompt is still correctable on the line — a paste is not a
  login. And it **stores and deletes nothing**: an unsaved target (or a locked keyring,
  which reads identically) reports "nothing saved for this login" rather than pasting
  an empty secret. The SSH target carries the login name **being typed into that
  terminal**, not the persisted one, because the keychain is keyed per login.
- **A password Tabtivity sends *by itself* is answering exactly one question, at a machine
  that has already been vetted.** It never goes through a PTY — nothing writes into a
  terminal but the user, or the paste they just clicked (above) — so a remote shell,
  MOTD or script that asks for a secret gets nothing. It goes to OpenSSH's own `SSH_ASKPASS`, and what makes that safe is the
  **argv**, not the shim: `ssh_password_{,master_}base_args` set
  `PubkeyAuthentication=no` (no passphrase prompt),
  `PreferredAuthentications=password` (no keyboard-interactive, the one channel where
  the *server* writes the prompt text), `StrictHostKeyChecking=accept-new` (no yes/no
  confirmation) and `NumberOfPasswordPrompts=1`, leaving `ssh` exactly one prompt it
  can raise. Because that invariant is invisible from the shim, it is enforced twice
  more, in both directions. **Upward**, `make_askpass` takes the ssh argv and
  *refuses to build* against a command missing any of those four options
  (`missing_single_prompt_opt`) — so a future caller cannot attach a password to a
  command nobody vetted, which is a silent failure that would look exactly like a
  working connect. **Downward**, the Unix shim re-states the same rule at the prompt
  it is handed: it answers only OpenSSH's `…'s password:` request
  (`prompt_is_password_request`) and writes anything else to a reject file, answered
  with nothing, which the caller turns into "the host asked for something else, so
  nothing was sent" (`unexpected_prompt_error`) instead of a bare `Permission denied`.
  The **Windows** shim is deliberately prompt-blind: testing the prompt there means
  forwarding it through `cmd`, which re-parses batch-argument expansions, so the check
  would trade a narrow disclosure for a command injection. Windows therefore rests on
  the argv restrictions — which is exactly why `make_askpass`'s refusal is not
  defence in depth there but *the* defence — plus the gate below.
  That gate is the other half, and it is the one thing `accept-new` does **not**
  cover: it silently trusts a *first* key. That is the ordinary TOFU bargain for key
  auth, but for a password it means the secret goes to whoever answered, with nobody
  ever shown the fingerprint they were implicitly trusting. So every password path
  calls `guard_first_contact` **before** the askpass is attached and refuses an
  unknown host with an `UNKNOWN_HOST_KEY`-marked error;
  `HostKeyConfirmDialog` (raised via `lib/remote/hostKey.ts`'s `withHostKeyConfirm`, which
  reads the target out of that error and retries once) shows the fingerprints and, on
  a yes, writes them to `known_hosts` — which is what clears the gate, so there is no
  second "confirmed" state to keep in step. Interactive connects opt in; **background
  and launch paths deliberately do not** (they promise never to prompt), so an unknown
  host simply leaves auto-connect's lamp red until the user connects by hand — and
  goes red *at once* rather than after a retry loop, since the refusal is a decision
  that will repeat identically, not a race worth waiting out. (The one retry loop
  left that can meet an unknown host, extend-to-remote's, asks **once** and holds the
  answer for the rest of the loop — `lib/remote/hostKeyOnce.ts`.)
  The bulk machine **import** loop is exempt for the same reason in reverse: one modal
  per imported host would be a wall of prompts, so each lands as a red row whose
  Connect asks once. The gate itself runs two short *local* subprocesses (`ssh -G` to
  resolve `~/.ssh/config` aliases — checking the alias would call a long-trusted host
  unknown — and `ssh-keygen -F`), so the async SFTP openers reach it through
  `guard_first_contact_async` rather than blocking a tokio worker on it.

## A connect must never be able to forget

`ssh_connect` resolves the credential it will use as `typed || saved`,
authenticates, and *then* applies the `remember` flag. So `remember: false`
— `Remember::Clear` — deleted the password it had just successfully authenticated
with. Not a rare path: the flag was seeded by an **async** read of the keychain, so
pressing Connect before that read landed sent `false`; an unreadable keyring
answered "nothing saved", which unticked the toggle, which then deleted what was
actually there; and two surfaces (the Machines add form, the bulk import) never
queried at all, so adding a host that already had a saved password wiped it. The
observed symptom was one host's credential missing while fifteen others survived —
the one host reconnected by hand through the Connect dialog.

Two rules close it, and both are structural rather than careful:

- **`false` is unrepresentable.** `rememberArg(checked)` returns `true | null`, and
  the connect helpers' parameter types forbid the third value. Clearing a
  credential is now *only* what the explicit untick / "Forget saved password" does,
  through `remote_forget_password`. Every surface reaches the keychain through one
  hook (`useSavedCredential`), so there is no second place to get this wrong.
- **An unreadable store is never licence to delete.** `remember_secret` skips
  `Clear` entirely unless the keyring is readable — a locked collection reads
  identically to an empty one, and treating "I can't tell" as "there's nothing
  there" is exactly how a password gets thrown away.

Symmetrically, a *failed* write no longer reports success: `set`'s error used to be
discarded (`let _ = set(...)`) while the UI set its "saved" state from the
**request**. `ssh_connect` now returns `{ saved, save_error }` and the toggle
renders what the keychain actually did, with the reason inline when it refused.
