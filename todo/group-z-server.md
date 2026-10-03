## Group Z — Tabtivity Server: one server, several users, thin clients

*Plan only; nothing is built. Design: [`docs/tabtivity_hosted_plan.md`](../docs/tabtivity_hosted_plan.md).
One Linux server runs every user's projects, terminals and agents. Desktop
browsers and the phone PWA are thin clients. Each user gets a daemon under
their own uid and signs in to their own agent CLIs (the admin may offer API
keys). A shared project is a bare hub repo with one clone per member. Mail,
calendar and todo are per user: mail is always private, a calendar or todo
list can be opened to other users, and the admin and each user can switch
each of the three off.*

*Rewritten 2026-09-29. The earlier sync-server design (a Pi with sshd,
Radicale and bare git repos; items #173–#199) was removed with its plan and
lives on in git history at `1441eb0e`. Only its design-independent
prerequisites remain below. Backlog items for the new plan's phases P0–P5 are
added here once §12 Q1, Q3 and Q4 are answered.*

---

### Z.0 — Prerequisites and pre-existing debt (#169–#172)

*Kept from the removed sync-server design because each is worth doing on its
own. #171 and #172 are H0 of [`docs/headless_owner_plan.md`](../docs/headless_owner_plan.md),
the desktop groundwork the hosted plan's P1 builds on.*

169. **Live-test the CalDAV push work.** *Code-complete as of 2026-07-29 (still
    uncommitted at time of writing).* `caldav_push` / `caldav_delete` /
    `caldav_resource_etag` / `caldav_refresh_access`, `put_resource` /
    `delete_resource` / `WriteCondition`, `CalDavAccount::allow_write`, the
    conflict dialog this item asked for (`CalDavConflictDialog`, three answers and
    no *merge*), and the `UID`/`RECURRENCE-ID` round-trip the resource
    serialization needs are all in the tree with tests; `todo/group-x-caldav.md`
    #160 and `docs/context/caldav.md` now describe that state rather than denying
    it. What is left is the part no test can stand in for: **nothing in the CalDAV
    stack has ever spoken to a real server.** Still riskier than its size, and
    a prerequisite for offering CalDAV on the server (plan Q7).
    - [x] 🤖 Automated test — a create sends `If-None-Match: *` and an update
      `If-Match`; a write with no known ETag is **refused** rather than sent
      unconditionally (`services::caldav::an_update_with_no_known_etag_is_refused…`);
      the local gate needs both the user's opt-in and the server's
      (`commands::caldav::a_write_needs_both_the_users_opt_in_and_the_servers`);
      the store-level gate and the refused-delete rejection
      (`src/__tests__/calendar/CalDavPushGate.test.ts`).
    - [ ] 🖐️ Manual test — Radicale in a container + Thunderbird: create/edit/
      delete an event and a task from Tabtivity and see them in Thunderbird; a
      concurrent edit from Thunderbird surfaces as a named conflict rather than
      being overwritten; a recurring series' "this occurrence only" edit
      round-trips.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

170. **Generic remote URL publishing — Group P #79's one open bullet.**
    `git remote add/set-url origin <url>` + `git push -u origin <branch>`, with
    no host CLI, routed through the existing `PublishSite` / `origin_site` logic
    so `describe_mirror_guard`'s stale-mirror refusal applies. `git_publish.rs:69`
    currently rejects anything that is not GitHub or GitLab, and
    `git remote add origin` appears nowhere in the tree. Build once and it serves
    self-hosted Gitea/Forgejo/bare-SSH alike.
    The GitHub *and* GitLab `Provider` dispatch is already shipped
    (`commands/git_publish.rs:57-69`) — do not rebuild it.
    - [ ] 🤖 Automated test — URL validation accepts `ssh://`, `git@host:path` and
      `https://`, rejects the shapes `validate_clone_url` rejects; publishing
      flips `git_type` to `remote-private`.
    - [ ] 🖐️ Manual test — publish a local project to a bare repo in `/tmp` and
      confirm the history with `git log` on the bare repo.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

171. **Compare-and-swap on `calendar.json` writes.** `write_data`
    (`commands/calendar.rs:44-51`) is whole-file read-modify-write with no
    revision check, so **two Tabtivity windows already lose the loser's edit
    silently, today, on one machine** — the board writes on every drag, from a
    second window as well. Add a per-record `rev` and make writes CAS. Worth
    doing on its own merits and a hard prerequisite for anything multi-writer.
    - [x] 🤖 Automated test — two interleaved read-modify-write sequences: the
      second write is rejected and retried against fresh state rather than
      clobbering.
    - [ ] 🖐️ Manual test — two windows, same board, drag a card in each within a
      second; neither edit vanishes.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

172. **`fsync` in `write_json_atomic`.** `storage.rs:36-50` does `fs::write(tmp)`
    then `fs::rename(tmp, path)` with **no `sync_all()` on either the file or the
    parent directory**, so the rename can be ordered ahead of the data. An
    accepted trade on a desktop; a data-loss path on a machine defined by being
    unplugged rather than shut down. **Must land before any Tabtivity-authored JSON
    is ever written server-side**, and it is a two-line change worth making
    regardless.
    - [x] 🤖 Automated test — the write path calls `sync_all` on the temp file and
      on the parent directory handle before returning (assert via a seam, not by
      pulling the power).
    - [ ] 🖐️ Manual test — n/a beyond "nothing regressed"; correctness here is not
      observable without a crash rig.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

2339. **Serve the agent MCP servers from the Mobile host (headless spawns).**
    The schedule, git-push, help and root MCP listener and the per-run tokens
    it checks live in the window process (`services::root_mcp::runtime()`).
    An agent tab the phone creates with no window open, or that the sidecar's
    scheduler restarts (`docs/headless_owner_handoff.md`, H3 parity gaps),
    therefore starts without `tabtivity-schedule` / `-git` / `-help`, and
    keeps running without them after a window attaches. Move the listener and
    token minting into the sidecar (it becomes the per-user daemon in
    [`docs/tabtivity_hosted_plan.md`](../docs/tabtivity_hosted_plan.md) P1),
    keeping the window as the place approval cards appear; until then, a tab
    started headless needs a restart from a window to get its tools.
    *P2 (2026-10-03) looked and did not do it:* `commands::root_mcp::start`
    begins with `root_mcp_review::sweep_sandboxes(state_dir)` ("no tab is
    live yet, so every one of them goes"), so a sidecar starting its own
    listener beside a running window would sweep the window's live review
    sandboxes. The move has to be a move — one listener, in the sidecar, the
    window a client of it — not a second copy. Agents a browser starts
    through the sidecar today get no `tabtivity-*` MCP tools.
    - [ ] 🤖 Automated test — a headless `Create` of a Claude tab records
      `PtyOptions` carrying the schedule/help MCP config and a token the
      sidecar's listener accepts; a token minted by one process is refused by
      the other's listener after a restart.
    - [ ] 🖐️ Manual test — with no window open, create a Claude tab from the
      phone; in it, `/mcp` lists `tabtivity-schedule` and `tabtivity-help`;
      a schedule proposal waits for approval and the card appears once a
      window opens.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

2340. **Show on the phone why a new tab could not be opened.** (2026-10-02,
    found in the headless owner's live test.) A failed ＋ shows only a short
    red flash: `Project.tsx`'s create `catch` sets the error and then calls
    `load()`, whose success path clears it again (`setError("")`). Keep the
    error until the user dismisses it or starts another action. Also say
    *why*: the Mobile host only sends `launch_failed` / `persist_failed` and logs the
    reason to the journal (`host.rs`, "a create with no window failed"), so
    the phone can only say "The desktop could not open that tab." Add a short
    fixed set of reason codes the phone maps to text (e.g. the agent
    sandbox is unavailable, a remote project needs the window, the agent
    failed to start). Never send the raw message: it carries paths and
    commands, which must not cross the browser API (`services::mobile_control`).
    - [ ] 🤖 Automated test — a create that fails leaves the error visible
      after the follow-up reload; each new reason code has phone text.
    - [ ] 🖐️ Manual test — with the window closed and the cause still
      present (or one forced), ＋ → Claude on the phone shows a lasting
      message naming the reason.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

### Z.2 — Left by P2 (the browser desktop client; `docs/hosted_handoff.md` § P2)

2341. **CSP and §11 security review of the browser client before anything
    leaves localhost.** `web_client.rs` refuses every non-loopback `Host`
    and inexact `Origin` today; `page_csp` is the desktop CSP plus the socket
    and inline-script hashes. Before Tailscale Serve may forward `/desktop/*`:
    the cookie flags on https (`Secure`, maybe back to `__Host-`), the WS
    Origin check against the served origin, the ticket routes' path
    confinement (today `fs::read_file_bytes_for`'s), rate limits on
    `/desktop/login`, and the CSP's `connect-src`/`frame-src` lines.
    - [ ] 🤖 Automated test — a request with the Tailscale origin is refused
      on every `/desktop/*` route and on `/content/*`; a cookie set over
      https carries `Secure`.
    - [ ] 🖐️ Manual test — review notes filed in `docs/context/web_client.md`.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

2342. **Popout windows in the browser client.** Plan §3.5: `window.open` of
    the same bundle with `?popout=<kind>`, each popout its own connection to
    the same workspace, which removes `detachedContext` write forwarding.
    Today the shim answers `plugin:window|*` for one page and the `detached_*`
    client commands with nothing, so the popout controls do nothing in a
    browser. `web_client.rs` already keys views by client id, so a second
    page is a second client.
    - [ ] 🤖 Automated test — a `?popout=` page subscribes to
      `terminal-output:<its id>` and sees only its PTYs.
    - [ ] 🖐️ Manual test — pop a tab out in the browser; type in both windows.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

2343. **Browser shortcut alternatives for the chords a browser reserves**
    (plan §7.1): Ctrl+T, Ctrl+W, Ctrl+N (and Ctrl+Shift variants) are the
    browser's; `lib/shortcuts` keeps the desktop chords keyed by `CLIENT_OS`
    and has no web alternatives yet. Install-as-PWA helps only partly.
    - [ ] 🤖 Automated test — with `isServerClient()`, the defaults for new
      tab / close tab / new window differ from the reserved chords.
    - [ ] 🖐️ Manual test — in the browser, the new-tab chord opens a tab in the
      app, not a browser tab.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

2344. **The remaining `core` commands the dispatcher cannot serve.**
    `pdf_clip_get`/`pdf_clip_set` take `State<PdfClipboard>` (a singleton the
    core state does not manage; it carries pages between two windows),
    `run_script_detached` sits in `apps.rs` with the window commands, and
    `browser_check_url`/`browser_reader_fetch` in `browser.rs` — P3's split
    of the mixed files (`core_dispatch::tests::KNOWN_GAPS` names them).
    - [ ] 🤖 Automated test — `KNOWN_GAPS` shrinks to the five mail dialogs
      and the two raw-body commands.
    - [ ] 🖐️ Manual test — n/a.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

2345. **Route terminal output by client in the server's sink.** ✅ **Done**
    (2026-10-03, `804bc196`, with #2347; never live): a PTY event raised for a
    server client (`Caller::Client`) goes, serialized once, under the plain
    name to each client with a view of that PTY and to nobody else — no
    `:<label>` copies; `terminal-ready`/`-exit`/`-activity` the same way. The
    desktop keeps its broadcast plus popout copies. Was: `emit_output`
    still emits every chunk once under the plain name and once per non-main
    viewer window (`terminal-output:<label>`); a browser client is such a
    "window", so each chunk is serialized twice for it and the suffixed copy
    is dropped unsubscribed. (Browser popouts, #2342, will register their
    views under their own client id and get the same routing.)
    - [x] 🤖 Automated test — one browser client, one chunk, one frame
      (`terminal::client_tests::a_server_clients_chunk_is_one_frame_to_its_viewer_only`;
      the desktop's broadcast: `…a_desktop_windows_chunk_is_still_broadcast_with_popout_copies`).
    - [ ] 🖐️ Manual test — n/a (perf monitor shows one emit per chunk).
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

2346. **Tell the user the web bundle is stale.** The sidecar serves
    `web-dist/` from disk (the dev checkout's, or `<control_dir>/web-dist`);
    a `src/` edit reaches the browser only after `npm run web:bundle`, and
    `scripts/backend-stale.sh` does not say so. Either add the bundle to the
    stale report, or let `package-dev.sh` build and install it beside the
    frozen binary.
    - [ ] 🤖 Automated test — `backend-stale.sh` reports a `src/` edit newer
      than `web-dist/index.html` when Browser access is on.
    - [ ] 🖐️ Manual test — edit a label, run the script, see the line.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

2347. **One PTY per browser client, not per tab.** ✅ **Done** (2026-10-03,
    `a4061281`, `804bc196`, `a4501d22`; never live — see
    `docs/hosted_handoff.md` § #2347). A second client opening a tab another
    client runs in local tmux gets an attach PTY of its own,
    `<tab>@<client>` (`terminal::join_tab`; `pty_spawn` answers `attached`
    and the pane types nothing); the `pty_*` id commands resolve a client's
    ids to its own PTY; ownership is the registry's (`PtyMeta::client`), and
    a gone owner's tab PTY passes to a client still attached
    (`release_client`), or — the last client gone — is left to nobody
    while its tmux session lives, MCP grants and all (review). tmux windows now follow the client in use
    (`window-size latest` from tmux 3.2). A remote, container or Windows tab
    keeps the one shared PTY. Was: In the sidecar a PTY id is
    the tab id, the same in every page of the workspace: a second page that
    opens a tab the first page has open calls `pty_spawn` with the same id,
    and `PtyRegistry::insert` kills the first page's attach client and puts
    the second's in its place. Both pages then read and write one PTY, so
    `pty_resize` fights — plan §3.5 asks for a size per client through one
    tmux attach per client. Needs a per-client PTY id (`<tab>@<client>`) in
    the router and the registry, or a per-viewer size in the router. Until
    then the handoff's live check 5 ("each has its own terminal size") fails
    by construction. (P2 review, 2026-10-03.)
    - [x] 🤖 Automated test — two clients spawn the same tab id; both PTYs
      live; each `pty_resize` reaches its own
      (`terminal::client_tests::two_clients_on_one_tmux_tab_each_get_their_own_size_and_stream`,
      a real tmux server of the test's own; also one client leaving, the
      hand-over and per-client output; registry and resume:
      `…a_client_resolves_to_its_own_attach_and_a_gone_owner_hands_the_tab_over`,
      `web_client::tests::pty_ownership_lives_in_the_registry_and_a_resume_keeps_it`).
    - [ ] 🖐️ Manual test — two browser pages on one shell tab, different
      window sizes: no reflow fight.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

2348. **A browser whose session ended reconnects forever.** When the socket
    upgrade answers 401 (the session idled out or hit `SESSION_MAX`),
    `WsClient` cannot see the status: it retries at the capped 10 s backoff
    under the "reconnecting…" banner and never tells the user to sign in
    again. After a few failed opens, probe `/desktop/` with the cookie; a 401
    stops the retries and shows a "session ended, open the sign-in link"
    state instead. (P2 review, 2026-10-03.)
    - [ ] 🤖 Automated test — the fake socket fails three opens, the probe
      answers 401, no fourth open is scheduled, the banner changes.
    - [ ] 🖐️ Manual test — wait out the idle timeout; the page says so.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

### Z.3 — Left by P3 (multi-user; `docs/hosted_handoff.md` § P3)

2349. **Finish the crate split; the daemon still links GTK.** ✅ **Done** (2026-10-03, `3c090785`): the library's toolkit deps sit behind a default `desktop` feature; the daemon is its own crate `src-serverd/` built with `default-features = false`, `ldd` shows libc/libm/libgcc_s only, and CI's test job fails on a desktop library (the box below is that step). Was: `tabtivity-serverd` is a second `[[bin]]` of `src-tauri`, so it links the
    desktop library: `ldd` shows `libgtk-3`, `libgdk-3`, `libxcb*` and
    `libdbus-1` (no WebKit). A headless server must install them until the
    command bodies move into `app-core` and the daemon becomes its own crate
    (plan §3.2; the 126 `services → commands` back-references of the P1
    handoff). (P3, 2026-10-03.)
    - [x] 🤖 Automated test — a CI step runs `ldd` on the daemon binary and fails on any GTK/X library (`ci-cd.yml`, "Daemon links no desktop libraries").

2350. **Wire the device-released secrets key (§6.8).** ✅ **Built** (2026-10-03, `c23b3a57`, `fbf124c9`; never on a server): `services::server::vault`, the PWA's `secrets.ts`, `mail_crypt`'s device mode, the sealed credential store, the Server settings' secrets panel (UntestedTag `server.secrets`). **Vault decisions (user, 2026-10-03) built** (`0e6ba828`, `f49778aa`; never on a server): revoking a device rotates K (crash-safe, deferred to the next release while locked; the recovery code follows); set-up and a new recovery code need the pairing-key signature; a lost identity key is re-pinned with the recovery code (UntestedTag `server.secrets.repin`); same-uid unfenced readers of the keyring accepted and documented. **Revoke follow-ups (user, 2026-10-03) built** (never on a server; `docs/hosted_handoff.md` § Mail re-key on revoke): a revoke re-keys the mailbox in the background, crash-safe and resumable (UntestedTag `server.secrets.mailRekey`), and the Server settings and the phone recommend a new recovery code until one is made (UntestedTag `server.secrets.newCodeAdvice`). **Still open:** the "mail locked since reboot" push. Was: `services::server::secrets` has the primitives (per-device wraps, the
    recovery code, the persistent keyring). Missing: the device's ECDH key
    made at pairing (PWA and browser, next to the signing key), the unlock
    exchange on connect (X's public key out, the shared value back encrypted
    to a per-connection key the device pinned at pairing), `mail_crypt`
    taking K as its KEK in a device-released mode, the sealed opt-in password
    store (IMAP/SMTP/CalDAV/SSH), the recovery-code dialog, and the "mail
    locked since reboot" push. (P3, 2026-10-03.)
    - [x] 🤖 Automated test — the §11 secrets tests: the store opens only after a device releases K; K survives a daemon restart, not a keyring flush; a copy of the home plus the gateway database cannot open it; the recovery code does (`vault::tests`, `tests/server_secrets.rs`, `mail_crypt::tests::a_device_mode_store_opens_only_with_the_released_key`, `MobileSecretsRelease.test.ts`).
    - [x] 🤖 Automated test — the vault decisions: a revoke rotates K and a revoked device with an old `wraps.json` opens nothing new; locked, the wrap goes at once and the next release rotates; offline revokes and stale wraps rotate on release/start; a crash at each of six rotation steps loses nothing; v1 recovery wraps upgrade; set-up/new code refuse a cookie alone, another key and a replay; the re-pin binding checks only with the right code (Rust/WebCrypto shared vector) (`vault::tests`, `secrets::tests`, `auth::tests::signed_actions_need_the_pairing_key_and_are_single_use`, `tests/server_secrets.rs`, `MobileSecretsRelease.test.ts`, `MobileSecretsRepin.test.tsx`, `ServerSecrets.test.tsx`).
    - [ ] 🖐️ Manual test — on a server: pair a phone, set up mail, restart the daemon (mail stays unlocked), reboot (mail locked until the phone connects).
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
    - [ ] 🖐️ Manual test — on a server with a phone and a paired browser: Set up from the browser works (signed); revoke the phone → mail and saved passwords still open, after a reboot the browser releases the key and the old recovery code still unlocks; revoke while locked → the next unlock rotates; delete `secrets/identity.key`, restart → the phone shows "identity key changed", a wrong code is refused, the right one re-pins and mail opens.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

2351. **Decide: stop idle daemons, or keep them for their timers.** ✅ **Decided** (2026-10-03, the user): idle daemons keep running — no idle stop is built; plan §3.1 and `docs/context/server_gateway.md` say so. Plan §3.1 stops a daemon with no client after an idle timeout, but the
    same daemon runs the user's timers (scheduled prompts, alarms, Web Push)
    with no client connected (§3.4, §6.7). Socket activation restarts a
    stopped daemon on the next connect, not on a timer. P3 keeps daemons up
    once started; needs the user's decision (timers vs. memory per idle
    user) before an idle stop is built. (P3, 2026-10-03.)

2352. **Move Web Push delivery into the gateway.** Daemons still deliver their own (already encrypted) pushes to the push
    services as the user's uid. §6.7 moves delivery into the gateway, which
    would then forward ciphertext only; until then every daemon needs
    outbound HTTPS. (P3, 2026-10-03.)

2353. **Security review of the gateway and the admin helper before any user logs in.** Partly done 2026-10-03: the P3 review (`docs/hosted_handoff.md` § P3 review); rate limits per device/account/source with strangers kept off known users' budget, and no pair to an account without a pending invite or recent use (`2e2e70b5`); root-equivalent accounts refused (sudoers + docker/lxd/incus-admin/libvirt/disk, `8f41c8b8`). **Still open:** the helper's own review (argument validation, `runuser` environment, `gpasswd`/`useradd`) and a body cap at the gateway. §11: the helper is the only root code and gets a review of its own
    (argument validation, `runuser` environment, the `O_NOFOLLOW` walks,
    `gpasswd`/`useradd` arguments); the gateway's rate limits are
    server-wide windows (20 pairings and 240 challenge/session calls a
    minute), not per device or per account; proxied request bodies are not
    size-capped at the gateway (the daemon caps them). (P3, 2026-10-03.)

2354. **Manage CLIs on a server: "ask your admin".** ✅ **Done** (2026-10-03, `44a1db52`, never live; UntestedTag `agents.askAdmin`). Install, update and uninstall are `admin` and, on a server, refused for
    every daemon with the helper command to run (`cli-install`). The panel
    still shows the buttons and surfaces the refusal as an error; show the
    installed versions read-only and the sentence instead. (P3,
    2026-10-03.)
    - [ ] 🖐️ Manual test — as a user in the browser, Manage CLIs shows no Update button.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

2355. **Loopback listeners every server user can reach.** VM egress proxy ✅ **done** (2026-10-03, `45d1920d`): per-VM credentials, `407` without them; never booted. The other rows of the inventory stand as decided/acceptable. The §4.4 inventory (`docs/context/server_gateway.md`): the VM egress
    proxy (`vm_proxy`, no token; admin VMs only), the VM SSH forward (key
    auth), OpenVPN's management port (password file; admin), the shared
    Ollama (decided, no token), CLI sign-in listeners (the relay now only
    reaches the caller's own). Move the VM proxy to a unix socket or give it
    a token. (P3, 2026-10-03.)

2356. **Account administration from the browser.** Accounts, invites, roles and device revocation are admin-helper verbs
    run with `sudo` on the server; the gateway has no root path (there is no
    polkit rule). An admin page would need one: a polkit rule letting the
    gateway's account run exactly `invite`/`device-revoke` through the helper,
    with the helper's rules unchanged. (P3, 2026-10-03.)

2357. **Run P3 live on a real server with two accounts.** The steps are in `docs/hosted_handoff.md` § P3 "Live steps": install,
    `user-add` twice, pair a browser and a phone per user, an agent on each
    user's own login, a daemon restart under a running agent, the policy
    switches, then `scripts/server-isolation-test.sh ALICE BOB`. (P3,
    2026-10-03.)
    - [ ] 🖐️ Manual test — the whole § P3 live list on one server, both users, browser and phone.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

2358. **A second browser page re-types a shared-PTY tab's launch input.**
    Scheduled prompts, auto-continue and the warm-up cron are *not* doubled
    by two pages: their hosts tick only while the page holds the timer lease
    (`stores/timerLease.ts`, one holder per state dir). What two pages can
    still both do is type a tab's **initial input** (a command tab's run
    line, an agent's launch line or `/rename`): `claimInitialInput` is per
    page, and a page that re-spawns a tab no local tmux holds — a remote
    (ssh, `new-session -A -D` re-attaches the running remote session), a
    container or a Windows tab, which keep one shared PTY (#2347) — types it
    again into what may be the running program. A local tmux tab is safe
    since #2347 (`pty_spawn` answers `attached`; a tab whose last page left
    is attached to as well since the #2347 review). Check whether a remote
    tab's respawn really re-types (the desktop's webview reload takes the
    same path), and if so let the backend answer `attached` for a re-attach
    the remote wrap reports, or keep the claim server-side per tab.
    (#2347 review, 2026-10-03.)
    - [ ] 🤖 Automated test — a second page's respawn of a remote tab types
      no launch input.

### Z.4 — Left by P3b (the administrator's agent API keys; `docs/hosted_handoff.md` § P3b)

2359. ~~**Deliver an administrator's key to a CLI that takes one only in its login file (Codex).**~~
    **Decided no** (user, 2026-10-03; § P3b decisions): Codex is not
    offered an administrator's key. Its interactive session takes a key
    only from `~/.codex/auth.json`, the very file `agent_auth` shares as
    the user's own login, and the admin's key must never become that. The
    Agent credentials panel has no Codex card (no `api_key_env`). (P3b,
    2026-10-03.)

2360. **Verify the three admin-key rows live (plan Q2) and the CLIs' first-use prompts.**
    The variables come from the vendors' documentation, not from a run.
    Claude no longer takes the key from its environment: since the P3b
    decisions it runs `apiKeyHelper` (`<slug>-serverd --key-helper`), so
    its "use this API key?" question never comes up — verify that `/status`
    names the helper and no prompt appears, also in a project container.
    Gemini may need "Gemini API key" picked once in `/auth`; Vibe should
    start without its key prompt. If those prompts get in the way,
    pre-answer them per home or drop the row. (P3b, 2026-10-03; Claude
    updated by the P3b decisions.)
    - [ ] 🖐️ Manual test — on a server, each of Claude, Gemini and Vibe on the admin's key starts a session that answers a prompt.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

2361. ~~**Decide: does the admin's key reach remote and container agents?**~~
    **Decided** (user, 2026-10-03; § P3b decisions): **containers yes —
    done**: a project container's agent tab gets the key in its `docker
    exec` environment (`agent_keys::container_env`; named bare on the argv,
    the value only in the docker client's environment; Claude's helper
    prints `<PREFIX>ADMIN_KEY_SECRET` there). **Remote agents no**: a machine
    the administrator does not run never gets the key; a remote project's
    agents use the user's own login there. (P3b, 2026-10-03.)
    - [x] 🤖 Automated test — `agent_keys::tests::
      a_container_agent_gets_the_key_in_its_exec_environment`,
      `sandbox::tests::exec_argv_carries_no_admin_key_value`.

2362. **The daemon runs the window's agent start-up work.** ✅ **Done** (final
    fix round, 2026-10-04, never live). Found during P3b and widened by the
    final review (B3): the per-user daemon started none of what the window's
    setup starts for agents, so every registered hook ran a missing script
    (no turn records, no live session ids, `--resume` after `/clear` followed
    the wrong session, the H2 scheduler fell back to its quiet heuristic), no
    `agent-turn` reached a browser client, a token refresh reached other
    scopes' running tabs only at their next spawn (and "never both" beside
    the administrator's key held only at spawns), and stale ssh ControlMaster
    sockets and askpass shims piled up in the private `/tmp` the daemon shares
    with the tmux unit. `daemon::start_agent_work` now writes the hook and
    hint scripts, starts `agent_auth::start` and both ssh sweeps;
    `host::enable_background_relays` starts `agent_turn::start` for the
    browser clients (the desktop sidecar too, when Browser access is on) and,
    on a server only, `usage_stats`/`net_usage`. Deliberately **not** on a
    server: the stage wipe and the container/VM orphan sweeps (a server's
    tabs live in the tmux unit across daemon restarts, so nothing a previous
    daemon started is an orphan), and `agent_auth`/`agent_global::import_once`
    (they adopt a desktop's own `~/.claude` etc., which a server account does
    not have). Left: phone push notices for "question"/"done" come from turn
    edges the desktop window's `MobileBridgeHost` detects; a server has no
    window, so none are sent — #2384.
    - [ ] 🖐️ Manual test — on a server, an agent tab's turn state shows in the browser client and survives `/clear`; restart the daemon, `ls /tmp/<slug>-ssh-<uid>` (as the user, in the unit's namespace) holds no dead masters.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

2363. **Run P3b live on a real server.** The steps are in
    `docs/hosted_handoff.md` § P3b "Live steps": install (the keeper's
    account and socket), the admin offers a key, Alice stays on her own
    login and Bob picks the admin's key for the same CLI at once, the key
    reaches only Bob's agents, a withdraw fails Bob's next spawn, the audit
    rows, `scripts/server-isolation-test.sh`'s keeper checks. (P3b,
    2026-10-03.)
    - [ ] 🖐️ Manual test — the whole § P3b live list on one server with two users.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

2364. **A login shell that resets `PATH` loses the agent shims (Debian's `/etc/profile`).**
    Found in the P3b review. Shell tabs reach the `agent_bin` shims only
    through the `PATH` the tab inherits (on a server since `a368b3bc`,
    `new-session -e PATH=…`), but tmux starts a shell tab's shell as a
    login shell, and Debian's `/etc/profile` sets `PATH` unconditionally
    (Ubuntu's does not). There a typed `claude` misses the shim: the CLI
    is not found, or a copy in the user's own `~/.local/bin` runs unfenced
    on the user's real home without the administrator's key — the same as
    running it by absolute path, so no new exposure, but the shim's promise
    breaks. Same on a Debian desktop. Re-prepend the shims after the
    profile (e.g. an `ENV`/rc snippet in the tab's environment, or tmux's
    `default-command`), keeping the user's own `~/.tmux.conf` in the loop.
    (P3b review, 2026-10-03.)
    - [ ] 🖐️ Manual test — on a Debian server and a Debian desktop, `command -v claude` in a new shell tab names the shim.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

2365. **Run the P3b decisions live: per-key users, Claude's `apiKeyHelper`, container agents.**
    The steps are in `docs/hosted_handoff.md` § P3b decisions "Live steps":
    a new key is offered to nobody; Alice allows Bob; Bob's Claude starts
    with no API-key prompt and `/status` names the helper, nothing of the
    key in `.claude.json` or the environment; a typed `claude`, the Host
    session and a container agent tab work too; a daemon restart leaves a
    running Claude working; taking Bob off the list fails his next tab with
    the message and his running Claude within minutes; the keeper's
    per-uid cap holds under a flood. (P3b decisions, 2026-10-03.)
    - [ ] 🖐️ Manual test — the § P3b decisions live list on one server with two users.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

### Z.5 — Left by P4 (sharing; `docs/hosted_handoff.md` § P4)

2366. **Run P4 live on a real server.** The steps are in
    `docs/hosted_handoff.md` § P4 "Live steps": install (the hub's and the
    calendar service's accounts and sockets, `/srv/<slug>/shared` `0711`),
    Alice shares a project, Bob as viewer clones and fetches but cannot
    push, Carol as editor pushes `carol/main`, Alice merges it after the
    agent-facing review, revoke and delete grey the rows, a fenced agent
    sees only its own hub; the P4c exit (Alice opens a calendar's events to
    Bob as viewer and its to-do list to Carol as editor; Bob can't write,
    Carol's edit reaches Alice's open page within one change, a task's mail
    link never reaches Carol, a revoke stops Bob's next read);
    `scripts/server-isolation-test.sh`'s hub and calendar sections. (P4,
    2026-10-03.)
    - [ ] 🖐️ Manual test — the whole § P4 live list on one server with three users.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

2367. **Presence on the project pill and a "whose" label on busy state (§6.4).**
    The hub keeps presence by uid (`Request::Presence`, ten-minute
    expiry, the browser re-reports every four minutes) and the Sharing
    panel shows "Open now: …"; the member-count chip on the project pill
    and the "whose" label in `hostBusy` / the tmux Sessions view are not
    built. (P4, 2026-10-03.)

2368. **A fenced agent's push in a shared project, through a Tabtivity-side proxy (§6.3).**
    The fence hides the hub's socket (`/run` is a tmpfs), so an agent cannot
    push a shared clone; `share_push` is the user's button only. The plan's
    answer is a proxy of `tabtivity-git`'s `git_push` shape: route the
    `git_push` MCP tool of a shared project to `share::push_in` (owner by
    name, editor under `<user>/`), with the same budget and card. Today the
    tool would push to the clone's upstream — the hub path — and fail on
    the hub's permissions, harmlessly. (P4, 2026-10-03.)

2369. **Shared calendars on the phone's headless views and in headless reminders.**
    `calendar_load` merges shared calendars for every page, so a browser or
    phone *page* shows them and fires their reminders per user; but the
    Mobile host's headless answers (`mobile_control::headless` month,
    `headless_board`) and the no-window alarm loop (`mobile_control::alarms`)
    read `calendar.json` only. Merge through `shared_calendar::global()`
    there too (read-only on the headless board). (P4c, 2026-10-03.)

2370. **A shared to-do list's own board columns and card order.**
    The service stores the owner's columns with the list (`Change::Columns`
    exists) but the board renders the viewer's own `task_columns`, and a
    drag of a shared card changes only its column (`todo_move_tasks` routes
    a `PutTask` with the new column; its rank within the column is not
    shared in v1). Show a shared list's columns on the board and carry the
    rank. (P4c, 2026-10-03.)

2371. **Decide: per-author trust for the agent-facing review (sync plan Q9).**
    Every agent-facing change from another member is reviewed today
    (`share::unreviewed`, a merge's review bound to its digest). The
    leaning answer is per-author trust (review once per co-member, then
    trust their commits) — but authorship in git is the committer's claim;
    the hub would have to record who pushed which commit (it knows the
    pusher's uid) for that to mean anything. (P4b, 2026-10-03.)

2372. **Hub housekeeping: objects of refused pushes, a size bound per hub.**
    A push unbundles its objects before the ref rules and the CAS decide,
    so a refused or stale push leaves unreferenced objects in the hub until
    a `git gc` the hub never runs; and nothing bounds a hub's size beyond
    the 4 GiB per push. Add a periodic `gc --prune` (as the hub, hooks off)
    and a per-hub or per-owner quota. (P4, 2026-10-03.)

2373. **"No longer shared" / "deleted by owner" on the project itself (§6.6).**
    The user's map keeps the state (`share::Link.state`) and the Sharing
    panel greys the row, but the project pill and the projects list show
    the clone as an ordinary project. Show the state where the project is
    (a greyed chip), never removing it. (P4, 2026-10-03.)

2374. **Decide: which program-naming git config keys a shared project refuses.**
    The strict sanitizing of gate 1 fails closed on the desktop's denylist
    (`filter.*`, `diff.*.textconv/command`, `include*.path`). git's other
    keys that run a program are not on it: `merge.<driver>.driver` (a merged
    `.gitattributes` names the driver; `share_merge` runs a merge),
    `remote.<name-or-path>.uploadpack`/`receivepack` (Tabtivity fetches the
    hub by path), `core.sshCommand`, `core.gitProxy`, `gpg.program` /
    `gpg.*.program`, `credential.helper`, `core.askPass`, `core.editor` /
    `sequence.editor`, `url.*.insteadOf`. No co-member can write a member's
    `.git/config` (separate uids, the fence binds it read-only); a
    container agent could (a member may turn the container on for a clone
    after sharing). Stripping them breaks legitimate setups (`merge.ours.driver
    = true`, signing); pinning exact keys with `-c` cannot reach named
    drivers. Choose per key: strip, refuse, or pin. (P4 review, 2026-10-03.)

2375. **Decide: accepting a review that was cut at 256 KB.**
    `share::review_of` caps the text at 256 KB and binds the digest to what
    was shown; the panel marks the cut with "…" and still offers **I have
    reviewed these** / **Merge after review**. A padded `CLAUDE.md` can put
    its payload past the cut. Refuse acceptance of a cut review (review in a
    terminal instead), or page the whole text. (P4 review, 2026-10-03.)

2376. **Calendar service: per-user quotas and a cheaper wait.**
    A calendar is bounded (12 MB) but the number a user may share is not,
    and every pending `wait` re-reads every calendar file once a second (one
    per daemon since the review). Bound calendars per owner and keep each
    file's owner/members/revision in memory by mtime. (P4 review,
    2026-10-03.)

### Z.6 — Left by P5 (options; `docs/hosted_handoff.md` § P5)

2377. **Run the key broker live (P5, §5.4).** The steps are in
    `docs/hosted_handoff.md` § P5 "Key broker — live steps": install (the
    `<slug>-keybroker.socket` holding `127.0.0.1:8739`), a real Anthropic
    key switched to broker delivery, Bob on its list and on the key: his
    Claude tab answers with `ANTHROPIC_BASE_URL` pointing at the broker and
    no key anywhere in his processes; the card counts his month; a small
    budget refuses the next prompt; Renew token cuts a running Claude off
    once and it continues on the new token; Deliver directly restores the
    P3b behaviour; the isolation script's broker section. Also the open
    research of Q2: that Claude Code accepts a plain-HTTP loopback base URL
    with an `apiKeyHelper` and re-runs the helper on a 401. (P5,
    2026-10-03.)
    - [ ] 🖐️ Manual test — the § P5 broker live list on one server with two users.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

2378. **Run OIDC sign-in live against a real provider (P5, §4.1).** The steps
    are in `docs/hosted_handoff.md` § P5 "OIDC — live steps": register the
    server's callback at the provider (a Keycloak test realm is enough),
    `oidc-set` with the secret on stdin, `user-oidc bob --sub …`; Bob's new
    browser shows Sign in with …, comes back paired and signs in; an
    unlinked person comes back "not linked"; a sign-in URL opened in a
    second browser comes back "started in another browser"; the gateway's
    audit has `pair-oidc` rows without identities; both RS256 and ES256
    realms if the provider allows. (P5, 2026-10-03.)
    - [ ] 🖐️ Manual test — the § P5 OIDC live list with a real provider.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

2379. **Run the desktop's Connect mode live; finish its client half (P5, §7.2).**
    Steps in `docs/hosted_handoff.md` § P5 "Connect mode — live steps": pair
    the desktop with a server by invite code, open the server window, work
    in it (terminal, agent, files) beside the standalone window, clipboard
    and notifications native, Open on a server PDF downloads and opens it,
    a server restart reconnects. Not built yet: the Connect window's
    popouts and presenter, native print of a server file, a sign-out inside
    it, a webview profile of its own on macOS (`data_store_identifier`), and
    the secrets key (final review B12): the Connect window's pairing key is a
    Rust file (`services::connect`) that never enrols an ECDH key or releases
    the server's secrets key, so Set up / New recovery code cannot be signed
    there and a Connect-only user's mail and saved passwords stay locked
    after a server reboot until a phone or browser signs in (Server → Secrets
    says so in Connect mode). Do the enrol/release exchange in Rust after
    sign-in. (P5, 2026-10-03.)
    - [ ] 🖐️ Manual test — the § P5 Connect live list against a real server.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

2380. **Run rootless Podman project containers live (P5, §9).** Steps in
    `docs/hosted_handoff.md` § P5 "Rootless Podman — live steps": Podman
    and uidmap installed, subordinate ranges, the admin switch on; Bob's
    container project: the build tab builds into Bob's store, tabs run in
    it as Bob's uid, files written are Bob's, Alice and rootful Podman see
    nothing, memory counts in Bob's slice; the switch off refuses new tabs.
    Open questions only a run answers: rootless Podman from a system
    service with no user session (no lingering) — `XDG_RUNTIME_DIR` falls
    back to `/tmp/podman-run-<uid>` in the units' shared private `/tmp`;
    whether the cgroupfs manager needs `Delegate=yes` on the daemon unit.
    (P5, 2026-10-03.)
    - [ ] 🖐️ Manual test — the § P5 rootless Podman live list on a server.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS



2381. **Run the worktree review gate of a shared project live (P5, §6.3).**
    Steps in `docs/hosted_handoff.md` § P5 "In-tree worktrees — live steps":
    in a shared clone make a worktree, merge a co-member's `AGENTS.md`
    change there in a terminal, an agent tab in the main checkout and one in
    the worktree are both refused, the review names the worktree, accepting
    it lets both start; a commit in the worktree runs no hook. Pushing a
    worktree's branch through the app is not built. (P5, 2026-10-03.)
    - [ ] 🖐️ Manual test — the § P5 worktree list on a server with two users.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

2382. **Decide and build pair mode (P5, §6.3).** Designed, not built:
    `docs/context/sharing.md` § Pair mode. The decision: a shared `.git`
    (needs #2374 settled — every program-naming git config key refused —
    and stays exposed to new git keys) or a tree without `.git`, members
    committing from their own clones, with a content gate for agent files
    edited live. Either way: named-user `rwX` ACLs by the hub, the fence
    binding only the scope's own tree, no in-tree session files there.
    (P5, 2026-10-03.)

2383. **A shared consumer login stays off until Q2's research is done per CLI (P5, §5.4).**
    Q2 (answered 2026-09-29) keeps the option but enables it "per CLI
    after that CLI's row is verified": does a refresh rotate the refresh
    token, do two holders refreshing at once invalidate each other, does
    the CLI run on a replica it cannot write back or on an access token
    alone, how is a leaked token revoked. None of that can be answered
    without a real login, so P5 built nothing (`docs/hosted_handoff.md` §
    P5, item 2). To do: run those four checks for Claude and Codex (and any
    other CLI whose login `agent_auth` keeps as a file) on a
    throwaway subscription, record each row in plan Q2, then build the
    §5.4 keeper-refreshed, access-token-only replica for the CLIs that pass,
    with the terms quoted in the panel (Q11). (P5, 2026-10-03.)

2384. **Phone push notices for turn edges on a windowless host.** A
    "question"/"done" notice to the phone comes from turn edges the desktop
    window's `MobileBridgeHost` (`mobileAgentTurns.ts`) detects. A server
    daemon — and a desktop whose window is closed — has the turn relay
    (`agent_turn`, #2362) but no window, so no notice is sent. Move the edge
    detection beside the relay in the host process (`mobile_control`), with
    the window's copy standing down while a window runs. (Final review B3,
    2026-10-04.)
