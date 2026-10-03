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

2345. **Route terminal output by client in the server's sink.** `emit_output`
    still emits every chunk once under the plain name and once per non-main
    viewer window (`terminal-output:<label>`); a browser client is such a
    "window", so each chunk is serialized twice for it and the suffixed copy
    is dropped unsubscribed. The P1 gotcha: a server sink can target the
    `ClientId` and drop the suffixing — once the browser also learns to
    subscribe to its own name (popouts, #2342, need the same).
    - [ ] 🤖 Automated test — one browser client, one chunk, one frame.
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

2347. **One PTY per browser client, not per tab.** In the sidecar a PTY id is
    the tab id, the same in every page of the workspace: a second page that
    opens a tab the first page has open calls `pty_spawn` with the same id,
    and `PtyRegistry::insert` kills the first page's attach client and puts
    the second's in its place. Both pages then read and write one PTY, so
    `pty_resize` fights — plan §3.5 asks for a size per client through one
    tmux attach per client. Needs a per-client PTY id (`<tab>@<client>`) in
    the router and the registry, or a per-viewer size in the router. Until
    then the handoff's live check 5 ("each has its own terminal size") fails
    by construction. (P2 review, 2026-10-03.)
    - [ ] 🤖 Automated test — two clients spawn the same tab id; both PTYs
      live; each `pty_resize` reaches its own.
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

2349. **Finish the crate split; the daemon still links GTK.** `tabtivity-serverd` is a second `[[bin]]` of `src-tauri`, so it links the
    desktop library: `ldd` shows `libgtk-3`, `libgdk-3`, `libxcb*` and
    `libdbus-1` (no WebKit). A headless server must install them until the
    command bodies move into `app-core` and the daemon becomes its own crate
    (plan §3.2; the 126 `services → commands` back-references of the P1
    handoff). (P3, 2026-10-03.)
    - [ ] 🤖 Automated test — a CI step runs `ldd` on the daemon binary and fails on any GTK/X library.

2350. **Wire the device-released secrets key (§6.8).** `services::server::secrets` has the primitives (per-device wraps, the
    recovery code, the persistent keyring). Missing: the device's ECDH key
    made at pairing (PWA and browser, next to the signing key), the unlock
    exchange on connect (X's public key out, the shared value back encrypted
    to a per-connection key the device pinned at pairing), `mail_crypt`
    taking K as its KEK in a device-released mode, the sealed opt-in password
    store (IMAP/SMTP/CalDAV/SSH), the recovery-code dialog, and the "mail
    locked since reboot" push. (P3, 2026-10-03.)
    - [ ] 🤖 Automated test — the §11 secrets tests: the store opens only after a device releases K; K survives a daemon restart, not a keyring flush; a copy of the home plus the gateway database cannot open it; the recovery code does.
    - [ ] 🖐️ Manual test — on a server: pair a phone, set up mail, restart the daemon (mail stays unlocked), reboot (mail locked until the phone connects).
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

2353. **Security review of the gateway and the admin helper before any user logs in.** §11: the helper is the only root code and gets a review of its own
    (argument validation, `runuser` environment, the `O_NOFOLLOW` walks,
    `gpasswd`/`useradd` arguments); the gateway's rate limits are
    server-wide windows (20 pairings and 240 challenge/session calls a
    minute), not per device or per account; proxied request bodies are not
    size-capped at the gateway (the daemon caps them). (P3, 2026-10-03.)

2354. **Manage CLIs on a server: "ask your admin".** Install, update and uninstall are `admin` and, on a server, refused for
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

2355. **Loopback listeners every server user can reach.** The §4.4 inventory (`docs/context/server_gateway.md`): the VM egress
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
