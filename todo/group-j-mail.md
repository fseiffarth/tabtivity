## Group J — Web & Mail Surfaces: Routing, In-App Mail & Browser
*Three related surfaces for web/mail content sharing where-it-lives (right-panel
view vs. center tab vs. global-app surface), security, and auth decisions. #33
routes links **out** to the user's configured external apps; #65 and #61 are the
**in-app** counterparts (read mail / browse the web without leaving the
workspace). Files: `src/components/layout/GlobalAppBar.tsx` (roles +
launch-or-raise), `src-tauri/src/commands/apps.rs` (`launch_app`, `open_file`),
terminal/file-tree link handling (the global-apps suite is already implemented —
#33 is its last remaining item); plus, for the in-app surfaces, a new
`commands/mail.rs` + `schema/mail.rs` + `src/components/mail/` (mail) and a Tauri
webview surface + `src/components/browser/` (browser), and `types/index.ts`.
Mail (#65) and the browser (#61) are both built as of 2026-07-26 and share one
sanitizer (`services/web_safety.rs`); neither has been runtime-verified.*

33. **URI scheme routing** (migrated from TODO `G6.7`). ✅ Implemented ·
    🧪 Awaiting live QA. Intercept `http://`,
    `https://`, `mailto:`, and `webcal:` links opened from within terminals or
    the file tree and route them through the global-app launch-or-raise flow
    (`launch_app`, keyed by the `browser` / `mail` / `calendar` roles) instead of
    a bare `xdg-open` call, so links open in the user's configured global app.
    - Shipped as a pure/total router plus a separate performer:
      `src/lib/linkTarget.ts:124 routeUri` (URI + context → `LinkTarget`) and
      `:341 openRoutedUri` (performs it: browser tab, `launch_app`, or fallback).
    - [x] 🤖 Automated test — `src/__tests__/browser/LinkTarget.test.ts:22-64` covers the
      scheme→role mapping and the fallback path.
    - [ ] 🖐️ Manual — click an `http`/`mailto`/`webcal` link in a terminal and in
      the file tree; confirm each raises the configured global app rather than
      `xdg-open`'s default.

65. **Include a mail viewer in Tabtivity.** Add an in-app email reader so mail can be
    read without leaving the workspace. Scope to be defined when picked; open
    questions to settle first: protocol (IMAP vs JMAP vs a provider API like
    Gmail), auth model (app password vs OAuth, mirroring the SSH "no in-app
    passwords" stance where possible), read-only vs send/reply, and where it lives
    (right-panel view like Git/Files, a dedicated center tab, or a global-app
    surface). Pairs naturally with #33 (`mailto:` routing) once present.
    - **Where it lives is settled: the header's ✉ overlay, and only that.** It
      was built as a tab *and* a global-app overlay; the tab is retired
      (`stores/tabs`' `RETIRED_TAB_CMDS`), because the mail store is global — a
      scoped tab could only ever show the same mailbox the overlay does while
      still belonging to a project you switch away from. One switch too:
      `mail_global_app` went with the tab, since a toggle hiding the only
      surface while leaving mail "on" has nothing left to mean.
    - **Important / Urgent lists (BUILT, untested).** A right-click on any row
      files a message under one of two marks, and each mark has a rail entry
      listing **every account's** marked mail together. It is a *mark, not a
      move*, and that is forced rather than chosen: no IMAP folder can hold two
      accounts' mail, so a cross-account list can only be a local column
      (`messages.priority`, `schema::mail::MailPriority`). Cost stated in the
      UI: the mark is this machine's and no other mail client sees it.
    - **Keyword filters (BUILT 2026-07-29, untested).** The manual half of
      "file it for me": a rule is a list of words plus where to look (subject,
      sender, recipients, or the stored body *snippet*), and a message arriving
      with a hit is marked Important or Urgent. Deliberately literal rather than
      model-driven — the words are the user's own, so *why* something was filed
      is answerable by reading the rule; a local-model classifier is a separate,
      later thing (#169) and must not be able to pass for this one.
      - `services/mail_filters.rs` is the whole matcher, pure and tested;
        `filters.json` (sealed beside `accounts.json`, its own AAD) is the store;
        `mail_filters_{list,set,apply}` the surface; the dialog is
        `src/components/mail/MailFiltersDialog.tsx` + `src/lib/mailFilters.ts`.
      - Four limits, each stated in the dialog rather than in a tooltip: the mark
        is local (nothing moves, nothing uploads), rules run on **arriving** mail
        plus an explicit re-run, they search the preview and not the body (a sync
        fetches headers — full text would mean downloading every message of every
        folder on every check), and Sent/Drafts/Trash/Junk are out of scope.
      - **A message the user has filed by hand is never touched**, on either
        path, and the automatic pass runs once per message — otherwise every
        re-sync would resurrect a filing the user had corrected.
      - Order is data: the first matching rule wins, so the list is reorderable
        and saved wholesale. "Test" is a **dry run of the apply itself**, not a
        second matcher in TypeScript.
    - [x] 🤖 Automated test — `src/__tests__/mail/MailPriority.test.ts` (the
      folder/priority fork), `services::mail_store::tests` (the column, the
      cross-account query, that a re-sync never wipes a mark, and the filter
      scan's folder-kind refusals), `services::mail_filters::tests` (14 cases:
      case-folding, whole-word boundaries, `match_all` across fields, first-rule-
      wins, never overwriting a mark), `src/__tests__/mail/MailFilters.test.ts`
      (term parsing, field toggles, ordering, the i18n coverage check)
    - [ ] 🖐️ Manual test — write a rule, check mail, confirm the arrival lands in
      the named list and the strip says how many were filed; then "Apply to mail
      I already have" and confirm the count matches the dry run
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
    - **The rail is two zones now** (2026-07-29): account-*independent* above
      (Important/Urgent + the filter rules that fill them), account-*dependent*
      below (the accounts, and the selected one's folders, whose heading now
      names that account). One column of four headings had made two
      cross-account lists read as though they belonged to the first account.
      The toolbar carries the same split as a hairline: account actions left,
      mailbox-wide ones (the store key, the keyring) right.

166b. **Fixed 2026-07-29 — "my configured mail account vanished".** On an
    encrypted store the account list is `accounts.json.enc`, and
    `read_accounts` could only find it once `SESSION_KEYS` was published — which
    only *opening the database* did. But `mail_accounts_list` is the first mail
    command a launch runs (the header badge calls it), so on a cold process it
    found no key, skipped the sealed file, looked for the plaintext one the
    migration had deleted, and answered **an empty list**. The account had not
    gone anywhere; nothing had asked for the key yet. The write half was worse:
    re-adding the account in that state wrote a *cleartext* `accounts.json`
    beside the sealed file that every later read prefers — vanished twice, and
    with an unencrypted copy of the account list left on disk.
    - Fix: the sealed files resolve the key themselves (`file_keys`, one silent
      unlock attempt per process, degrading to `None`), and a plaintext write is
      **refused** while a sealed twin exists (`sealed_write_refusal`) instead of
      being silently shadowed. The sealed twin is now derived from the path the
      caller passed, so a read against any other directory can no longer reach
      the real mailbox.
    - Reproduced and verified with `cargo run --example mail_probe` — 0 accounts
      before, 1 after, on the same on-disk store.
    - [x] 🤖 Automated test — `commands::mail::tests::{a_plaintext_write_is_
      refused_while_a_sealed_file_exists, the_sealed_files_resolve_their_own_key}`
    - [ ] 🖐️ Manual test — launch with the mail overlay closed, open it, confirm
      the account is listed on the first paint.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

61. **Include a browser in Tabtivity. (BUILT — reader mode; live pages opt-in.)**
    Shipped as two surfaces, because the obvious third one is not buildable:
    `tauri-runtime-wry` packs a child webview into the window's `GtkBox`, where
    `set_bounds` is a no-op, so an in-pane embedded browser renders as a vertical
    stack on Linux (tauri#10420 / #11376). Plans:
    `docs/browser_plan_{a,b,c}.md`; audit findings and residual risk are in
    plan B and in `services/browser_engine.rs`'s module header.
    - **Reader tab** — backend fetches over rustls, sanitizes through the mail
      client's `ammonia` pipeline, renders inert HTML in a `sandbox=""` frame.
      No JavaScript ever runs. Every platform.
    - **Live page** — a separate hardened `WebviewWindow`, ephemeral profile,
      behind `browser_live_pages` (default off, and off in debug too). Refused
      on Windows: WebView2's default permission state draws Edge's own prompt.
    - [x] 🤖 Automated test — tripwire suites both sides; a defence that is
      deleted fails a test rather than shipping.
    - [ ] 🖐️ Manual test — **nothing here has been runtime-verified.** The
      gating check: from a live page's devtools, `invoke('list_projects')` must
      reject naming the ACL. If it resolves, stop.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

61a. **Containerise live pages. (DEFERRED — do not build without new evidence.)**
    Plan, kept for reference: `docs/browser_sandbox_plan.md`. It would run the
    live browser in a container with its own network namespace and a single
    writable bind mount, closing the two findings the audit could not — a page
    reaching loopback services by any hostname that resolves there, and `ws://`
    reaching them regardless of the scheme allowlist — by topology rather than by
    policy. Reuses `services/sandbox.rs` (#38). Reader mode is untouched either
    way. Deferred on 2026-07-26 for four reasons, in order of weight:
    - **It would buy a browser's patch cadence, permanently** (plan §6 q2). A
      stale browser in a container is a worse browser than a current one outside
      it, so this is an ongoing upstream-CVE commitment for a side feature —
      plus image provenance and size, a supply-chain question the current
      feature does not have.
    - **The go/no-go is only knowable after it is built** (plan §5.6). Usability
      runs through a nested display server on a host that software-renders
      because DMABUF is off app-wide (`project_webkit_paint_perf`). Phases 0–5
      would be built to discover whether scrolling and video are tolerable.
    - **Zero UX gain.** Plan §1.1: the container's window is still a separate
      top-level OS window, exactly what ships today. Pure security spend.
    - **Linux-only.** Windows is already refused; macOS Docker Desktop is a VM
      with a different display story again (§6 q4). A one-platform feature with
      a three-way matrix in every doc and settings pane.
    The standing alternative — reader mode as an in-app tab plus the user's own
    browser for live pages, already the `browser_link_target` default — has none
    of these holes and comes with the user's password manager, extensions and
    Mozilla's patch cadence.
    **What would reverse this:** using live pages often enough in real work to be
    annoyed that they are a detached window with disclosed holes. That is a
    verdict from use, not from analysis, so the next step on this axis is #61's
    manual QA, never Phase 0 here. If the answer instead turns out to be "never
    reach for them", the live window should be *deleted* (plan §0) and reader
    mode kept.
    - [ ] 🤖 Automated test — n/a while deferred
    - [ ] 🖐️ Manual test — n/a while deferred
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

61b. **Readability extraction for reader mode.** The change that would make the
    reader tab a *reading* surface rather than a sanitized document dump, and the
    one worth making instead of #61a. Today `fetch_reader` sanitizes the whole
    document: `<style>` elements are dropped with their contents
    (`mail_sanitize.rs` `RM_WITH_CONTENTS`), external CSS never loads, and only
    inline `style=` survives against the property allowlist. Typography is
    **not** the gap — `lib/browser.ts`'s `READER_FRAME_STYLE` already sets a
    46rem measure, 1.7 line-height, capped images, wrapped `pre`. The gap is
    **boilerplate**: nav menus, sidebars, footers and cookie banners arrive as
    long bullet lists ahead of the article, because there is no extraction pass
    anywhere in `browser_engine.rs`.
    Extract the article and drop the page chrome **before** handing the fragment
    to the sanitizer, so the security pipeline is unchanged and extraction is a
    pure pre-pass. It **must** run pre-sanitizer: Readability scores nodes on
    `class`/`id` hints, and `mail_sanitize` sets `generic_attributes(HashSet::
    new())`, so afterwards the signal it needs is gone. Cross-platform, no
    container, no new attack surface — the opposite trade to #61a on every axis.
    **The crate** (checked 2026-07-26): `dom_smoothie` (MIT, 0.18.0, ~18 minor
    releases since Dec 2024, by `dom_query`'s author) returns an `Article` with
    both `content: StrTendril` (HTML — the field to feed `ammonia`) and
    `text_content`. Most of its tree is **already in `Cargo.lock`** via ammonia
    and Tauri — `html5ever` 0.39, `tendril` 0.5, `cssparser` 0.37, `foldhash`
    0.2, `phf`, `bit-set`, `once_cell`, `unicode-segmentation`, `thiserror` 2 —
    so the genuinely new crates are `dom_query`, `selectors` 0.38 (beside the
    existing 0.36), `flagset`, `gjson`, `html-escape`. Its `is_probably_readable()`
    is the honest-failure gate below, for free. Rejected: `readabilityrs` (0.1.x,
    one author, pulls **two** DOM libraries — `kuchikikiki` *and* `scraper` — and
    an exact-pinned `v_htmlescape`); `readable-readability` (last release 2022).
    Note it is 0.x on a fast minor cadence: pin it, and expect an upgrade to be
    a real edit every few months.
    **Sequencing:** do #61's manual QA first on ten pages actually worth reading
    in a work session. That says whether the reader tab is a docs-and-articles
    surface worth investing in, or a niche tool for opening agent-supplied links
    safely (no JS, no cookies, no `Referer`, `resolve_hop` closing the DNS hole)
    — which is worth keeping either way, and is the thing the user's own browser
    is genuinely worse at.
    Watch for: a JS-rendered SPA has no article to extract and must keep failing
    honestly rather than rendering an empty frame; extraction must never
    reintroduce a tag or attribute the sanitizer would have removed.
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

---

66. **Encrypt the local mail store, and add OpenPGP. (BUILT — every phase,
    never live-tested.)** Two features, deliberately sequenced, rationale in
    `docs/context/mail_encryption.md`.

    **At rest (phases 1–2).** Every sensitive value in the mail store is an
    XChaCha20-Poly1305 envelope (`services/mail_crypt.rs`), sealed *per value*
    rather than per file — which is what keeps plaintext out of the WAL and the
    freelist, and why converting an existing store ends in `VACUUM INTO` a new
    file rather than an in-place `UPDATE`. Every ciphertext is bound to its row
    by AAD, so an attacker with disk *write* access cannot relocate one
    message's body onto another's row. Search becomes bounded decrypt-on-scan
    and **says when it stopped**; blind indexes were rejected (a deterministic
    per-token fingerprint answers "does this mailbox contain word X", which is
    most of what the encryption was for). An unreachable key **degrades to a
    memory-only store** rather than locking the mailbox — the locked-keyring
    failure class this project has already been bitten by.

    **End to end (phases 3–8).** OpenPGP via rPGP; S/MIME is detected, named and
    deferred (no certificate is issued, so there is no credential to load). Key
    generation is **Curve25519 only**, which is a security decision rather than
    a preference: `pgp` depends on `rsa` unconditionally and RUSTSEC-2023-0071
    is unpatched, but the oracle is in RSA decryption and nobody can encrypt to
    a key we do not have. Sign-inside-then-encrypt; a missing recipient key
    **refuses the send** rather than degrading to plaintext; decrypted bodies
    are never written to disk (caching one would make the store key equivalent
    to the mail private key). IMAP `APPEND` lands last and only with
    encrypt-to-self — before it there was no Sent copy at all, which was
    accidentally the most private behaviour available.

    Only `verified` earns positive chrome, and only an explicit "I compared this
    fingerprint" produces it: OpenPGP has no authority to ask instead.

    - **Open, and the user's call:** whether to un-defer S/MIME if a work
      certificate ever appears (plan §5, pre-costed, drops in behind the §4
      seam); whether inline (pre-MIME) signatures are worth verifying rather
      than merely reporting.
    - **Known limitation, recorded not hidden:** folder ids are an unkeyed
      `sha256(path)[..8]`, so a wordlist recovers folder names. Keying them
      means re-deriving every message id — which is also every AAD row key.
    - [x] 🤖 Automated test — `services::mail_crypt` (AAD relocation, envelope
      rejection, Argon2 round-trip), `services::mail_store::tests::encrypted`
      (nothing readable on disk, migration, restartability, bounded search),
      `services::mail_pgp` (sign/verify/encrypt round trips, sign-inside-encrypt),
      `tests/mail_hostile_crypto.rs` (a decrypted body still meets the sanitizer;
      a real signature over a different body is refused),
      `src/__tests__/mail/MailCryptoDisplay.test.ts` (only `verified` is positive)
    - [ ] 🖐️ Manual test — **the whole feature.** Nothing here has run against a
      real server or a real correspondent: interop with Thunderbird and Outlook,
      unlock latency on the slowest machine, keychain-locked behaviour, and the
      migration of a store that actually holds mail.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

---

167. **Reuse one IMAP session per account instead of logging in per operation.**
    ✅ Implemented · 🧪 Awaiting live QA. The gating defect for pointing the mail
    client at a **primary** account, and the reason it was found: every
    `MailEngine` method opened its own connection — `imap_login` → `SELECT` →
    one command → `logout`, eight times over in `services/mail_engine.rs`. So
    reading twenty messages was twenty TLS handshakes and twenty `LOGIN`s, and
    the cost is not latency but **the provider's opinion of it**: Gmail,
    Fastmail and every hosted Exchange rate-limit authentication attempts long
    before they rate-limit commands, and answer a client that reauthenticates
    per click with throttling, a temporary lock, or a "suspicious sign-in"
    mail. `set_flags_bulk` already existed *for exactly this reason* ("a few
    hundred logins, and a server with any connection-rate limit answers that
    with a ban") — this generalizes that insight from one method to the module.
    - **A process-wide pool keyed by `host:port|user`**, not an engine field:
      `InProcessEngine` is a unit struct constructed at each call site
      (`InProcessEngine.body(…)`), so making the pool an instance field would
      have meant threading state through 2 789 lines of `commands/mail.rs` for
      no gain. The pool is genuinely process-global — one app, one mailbox.
    - **`keep` defaults to `false`**, and only `Lease::finish` sets it true.
      Anything that is not a clean success — an error, an early `?`, a panic, a
      future dropped mid-command by a cancelled sync — therefore closes the
      socket instead of pooling it. The inverse default is the bug this design
      exists to make unwritable: a session returned mid-command hands the *next*
      caller a stream positioned inside someone else's response.
    - **Test on borrow, but only when it can have gone stale** (`NOOP` above 30 s
      idle, 10 s cap; entries over 5 min are closed unread). A server closing an
      idle connection is normal, so a pool without a liveness check trades
      logins for intermittent failures — which is a worse client, not a cheaper
      one.
    - **`SELECT` is cached per session** (`ensure_selected`) for the operations
      that only address messages by UID (flag, bulk flag, move, body fetch).
      `headers` still `SELECT`s unconditionally, because it reads `EXISTS` off
      the response and a cached selection would page from a stale count.
    - **`probe` is deliberately exempt** (`Acquire::Fresh`): "Test account" that
      answers out of a pool tests nothing, and would report success for a
      password the user had just changed to a wrong one.
    - Pooled sessions are evicted on account upsert, account delete and
      "forget password" — the three moments the credential behind a live
      authenticated socket stops being the one the user believes is in use.
    - SMTP is untouched: a send is user-initiated and rare, and many providers
      cap messages per connection, so there is no login storm to fix there.
    - [x] 🤖 Automated test — `services::mail_engine::tests::{pool_key_*,
      pool_entry_*, every_imap_operation_goes_through_the_pool}`; the last is a
      tripwire that reads this module's own source and fails if a method starts
      logging in directly again (the same shape as
      `no_certificate_verification_escape_hatch`).
    - [ ] 🖐️ Manual test — with a real account: read ten messages and confirm
      the provider's "recent activity" page shows **one** sign-in, not ten; then
      leave the app idle 10 min and read another to confirm the stale-session
      path recovers rather than erroring.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

168. **OAuth 2.0 / `XOAUTH2` for the big providers.** Not built, and the plan is
    mostly *not* about IMAP. Today `imap_login` sends `LOGIN user pass`, which
    means: **Microsoft consumer accounts cannot connect at all** (basic auth for
    IMAP/SMTP was withdrawn for outlook.com in 2024), Gmail needs an app
    password with 2-Step on (`docs/mail_qa_gmail.md` already walks that), and
    Yahoo/AOL likewise. Everything self-hosted, university, Fastmail and
    Mailbox.org is unaffected — which is why this ranks below #167.
    - **The protocol half is nearly free.** Both crates already support it:
      `async_imap::Client::authenticate("XOAUTH2", …)` takes an `Authenticator`
      whose `process` returns the `user=…\x01auth=Bearer …\x01\x01` string, and
      `mail_send::Credentials::new_xoauth2` exists for the SMTP side. Neither
      needs a new dependency.
    - **The cost is the flow around it**, and it is all Tabtivity-side: a loopback
      `http://127.0.0.1:<port>` redirect listener, PKCE, the refresh token in
      the OS keychain beside the passwords (`remote_credentials`), silent
      refresh before each connect, and a `MailAccount.auth` discriminant so a
      password account and a token account can coexist. The token — not a
      password — becomes the thing the sealed store must never touch.
    - **The consent page opens in the user's own browser, never in a webview.**
      Google blocks embedded-webview OAuth outright, and the reasons this repo
      already refuses to embed live pages (`browser.rs`'s `LIVE_SUPPORTED`,
      #61a) apply with more force to a page the user types a password into.
      Thunderbird's own table has grown `useExternalBrowser` /
      `useSchemeRedirect` fields for exactly this migration.
    - **Refresh belongs inside `acquire` (#167), single-flight.** A token
      client that refreshed per operation would burn refresh quota the same way
      the per-operation login burned auth quota — and with a pool in place, N
      concurrent leases must not each mint a token.
    - **The two providers are not one job, and should not be one item.**
      Checked 2026-07-29:
      - **Microsoft is cheap and is the whole point.** An Entra app
        registration is free, self-service and carries **no security review**:
        audience "any organizational directory *and* personal Microsoft
        accounts", a Mobile-and-desktop platform with an `http://localhost`
        loopback redirect (public client, no secret), delegated
        `https://outlook.office.com/IMAP.AccessAsUser.All` +
        `…/SMTP.Send` + `offline_access`, against
        `login.microsoftonline.com/common`. Microsoft's own doc settles the
        question third-party guides get wrong: OAuth2 for IMAP/POP/SMTP "is
        available for both Microsoft 365 … and **Outlook.com** users" — the
        "not supported for personal accounts" claim found elsewhere is about
        the *client-credentials* flow, not the interactive one.
      - **Google is disproportionate, and for one user it is worse than what
        we have.** `https://mail.google.com/` is a **restricted** scope. In
        "Testing" publishing status the app is capped at 100 test users **and
        Google revokes the refresh token after 7 days** — i.e. re-authenticate
        every week, which is strictly worse than an app password. Lifting that
        means publishing, verification, and for a restricted scope a **CASA
        Tier 2 third-party assessment, annually**, for an app with no
        publisher entity.
    - **Therefore: build Microsoft, keep app passwords for Gmail.** An app
      password is individually revocable, has no 7-day clock, and needs no code
      at all; a Google refresh token would be a longer-lived credential bought
      at a much higher price. `docs/mail_qa_gmail.md` already documents the
      app-password path.
    - **Do not copy Thunderbird's client id.** Its issuer table
      (`mailnews/base/src/OAuth2Providers.sys.mjs`) ships ids and "secrets" in
      public source — legitimately, because a native app is a *public* client
      and PKCE, not the secret, is what protects it — but the file says in as
      many words: "Don't copy these values for your own application — register
      one for yourself!" Reusing it would attribute this app's traffic to
      Mozilla's client and put their quota at risk.
    - **`privacy-check.sh` will flag the client id**, since a public client id
      is indistinguishable from a leaked token by pattern. It needs an explicit
      expected-match entry or the pre-push hook blocks every push.
    - Sequencing: after #167 (a token client that reauthenticates per operation
      would burn refresh quota the same way), and after #65/#66's live QA — this
      is the wrong thing to build against a client that has never met a server.
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

202. **The local model a mail task runs on — the tag exists, the task does not.**
    The 🧠 menu's role chips gained a **Mail** tag (2026-07-30), stored at
    `settings.ollama_roles.mail` beside `autocomplete`/`grammar`/`tabs`, and
    **nothing reads it yet**. Only the tag shipped, deliberately: which model may
    see someone's mail is the user's statement, and the honest order is to let
    them make it in the same menu they assign every other local job in, rather
    than bolt a model picker onto whatever mail feature lands first.
    - What would read it: an **importance/urgency classifier** — the model-driven
      half of the filing #65's keyword filters do by hand — plus summaries or a
      draft reply. The filters' rule stands and must not be blurred: a keyword
      rule is answerable by *reading the rule*, a model's verdict is not, so a
      classifier is a **separate** mark path and may never present itself as a
      filter hit. (The stale `#169` reference in #65's filter note above meant
      exactly this item; that number belongs to Group Z's CalDAV push.)
    - Prerequisites it inherits rather than invents: the model has to be
      **resident** to answer unattended, which is what `ollama_autoload_models`
      (the "On start" chip) already exists for; the mail store may be **locked**
      (`Unlock::Unavailable`), in which case there is nothing to classify and the
      absence must read as "locked", never as "nothing important"; and mail is off
      by default (`mail_client`), so no timer here may run before that gate and
      the tag are both set.
    - The chip's tooltip and the lesson text say **nothing reads this yet**, in
      all five languages. Both come out when the consumer lands (the `pending`
      flag on `MODEL_ROLES` in `LocalModelMenu.tsx` is the single switch), and the
      fallback chain is the existing one: no tag ⇒ `ollama_model` ⇒ any loaded
      model — an unassigned tag must not mean "never run".
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

---

---

823. **VPN-only mail account.** `require_vpn` on `MailAccount` (dialog checkbox
    *Only connect while the VPN is up*). An institutional mailbox reachable only
    from inside its network used to fail every interval check while the tunnel
    was down — a connect timeout per tick, a red ✉, and no catch-up when the
    tunnel came back. Now the header's tick skips the account while no OpenVPN
    tunnel Tabtivity knows about is up (its tooltip says *n account(s) waiting for
    the VPN*), and checks it the moment one comes up — on a reconciled
    `false → true` only, so the store's first sight of a tunnel at launch is not
    a check at mount. The backend enforces the same rule before every engine
    operation (`mail_engine::vpn_gate`), so a manual *Check mail*, a body fetch,
    a flag write and a send all refuse with the one shared sentence
    (`services::openvpn::VPN_GATE_REFUSAL`). Known limit, stated in the hint:
    only tunnels started from Tabtivity count. Design note in
    `docs/context/openvpn.md`; helper in `src/lib/remote/vpn/vpnGate.ts`.
    - [x] 🤖 Automated test — `VpnGate.test.ts` (the three-valued hook, the
      rising edge), `openvpn::tests` (the gate's truth table),
      `mail_engine::tests` (the shared sentence), `schema::mail` round-trip.
    - [ ] 🖐️ Manual test — with the tunnel down, an account with the box ticked
      shows no error strip after an interval passes and the ✉ tooltip says it is
      waiting; *Check mail* refuses with the VPN sentence; connecting the VPN from
      the header checks it within seconds; an unticked account is unaffected.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

825. **In-pane PDF preview for mail attachments.** *Preview* on a PDF attachment
    used to say "no in-app preview for this file type", which sent every
    invoice and paper through the save dialog just to be read. Now
    `MailPdfPreview` draws the pages with pdf.js onto plain canvases, right in
    the attachment row — **canvas only, by design**: no text layer, no link
    annotations, no outline, no forms, since a PDF's links are a way out of the
    app and the attachment boundary exists so nothing an attachment carries can
    open anything. Six pages at first, *Show n more pages* for the rest; the
    document's Worker is destroyed when the preview closes (`pdfLoad` rules).
    Detection is by the `%PDF-` magic, not the declared type — mailers send PDFs
    as `application/octet-stream`. A blob the 4 MB IPC preview bound cut short
    is refused as *too large* rather than parsed (no xref table at the end).
    Nothing in `src-tauri/` changed; hot-reloads.
    - [x] 🤖 Automated test — `MailPdfPreview.test.tsx` (magic detection over
      declared type, truncated blob never parsed, page steps, destroy on
      unmount, failed open says so).
    - [ ] 🖐️ Manual test — open a mail with a PDF attachment and click
      *Preview*: pages render sharp at the column's width, *Show more* appends
      the next six, *Hide preview* removes them; a PDF over 4 MB shows the
      too-large note; an attachment declared `application/octet-stream` that is
      really a PDF previews as one; clicking on a rendered page does nothing.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

### Mail security audit — 2026-09-17 (#847–#858)

*A read-only, four-reviewer audit of the mail client (rendering, IPC/filesystem,
network/credentials, storage/crypto) whose findings each reviewer
cross-checked against the code. **Fixed 2026-09-17 (✅ Done · 🧪 untested
live)** except where an item says otherwise — `cargo test`, clippy,
`npm run build` and vitest green; nothing was run in a live Tabtivity, and every
backend part needs a rebuild + restart. Line numbers below are the audit's,
as of `504bc19`. Everything the audit found **done
well** — Rust-side sanitizing with no surviving `href`, `sandbox=""` frame, no
remote loads, implicit-TLS-only with platform verification, path-free async
commands, the attachment-name sanitizer, XChaCha20-Poly1305 + Argon2id, legacy
no-MDC OpenPGP refused — is deliberately not re-listed here.*

847. **🔴 High — partial-signature spoofing and nested-ciphertext decryption.**
    `mail_crypto::detect` (`mail_crypto.rs:209-225`), `mail_pgp::signed_part_bytes`
    (`:810`) and `encrypted_part_bytes` (`:848`) take the *first*
    `multipart/signed` / `multipart/encrypted` anywhere in `msg.parts`, while
    `apply_crypto` (`commands/mail.rs:463-494`) renders the **whole** message.
    `multipart/mixed[attacker text/html, <Alice's genuine signed part>]` with
    `From: alice` shows "Signature: verified" over the attacker's unsigned HTML.
    The same nesting wraps a captured ciphertext: it auto-decrypts under the
    attacker's From/Subject, and a reply quotes the plaintext back in the clear
    (`MailComposeDialog.tsx:70`). Fix: only treat the *root* (or the root's sole
    rendered child) as signed/encrypted; anything else is "partially signed" with
    no positive chrome, and never auto-decrypt a nested part.
    - **Fixed:** `detect`, `signed_part_bytes` and `encrypted_part_bytes` read the
      root part only; inline armor counts only as the message's sole body; a
      reply/forward quoting decrypted mail starts with Encrypt ticked and warns
      when unticked (`mail.crypto.quotesDecrypted`); decrypt recursion capped at
      two layers.
    - [x] 🤖 Automated test — `a_nested_crypto_part_does_not_speak_for_the_message`,
      `inline_armor_counts_only_as_the_sole_body`.
    - [ ] 🖐️ Manual test — a `multipart/mixed` wrapping a genuinely signed mail shows
      no signature chrome; replying to a decrypted mail has Encrypt ticked.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

848. **🔴 High — "Save to project" writes through symlinks.**
    `commands/mail.rs:3244-3280`: `create_dir_all(<project>/tabtivity-emails)` accepts
    a symlinked dir, `unique_in_dir` checks `Path::exists()` (false for a dangling
    link), then a plain `fs::write` follows it. A cloned repo committing
    `tabtivity-emails -> ~/.config/autostart` (or the project root / `~/.claude/`)
    plus a mailed `x.desktop` / `CLAUDE.md` is code execution on the user's
    click. **A fenced agent can plant the link itself** (the project is a
    read-write bind), so the unfenced Tabtivity process writes outside the fence —
    a fence escape. The companion `ensure_generated_dir_ignored`
    (`commands/projects.rs:2681-2702`) appends through a symlinked `.gitignore`.
    Fix: refuse a symlinked `tabtivity-emails`/`.gitignore` (`symlink_metadata`),
    `OpenOptions::create_new` + `O_NOFOLLOW`, canonical parent must stay under
    the project root. Also: on a remote project `project_directory` is the local
    state dir, so the file lands there instead of on the host (`:3243`).
    - **Fixed:** `emails_dir_in` refuses a non-directory/symlinked
      `tabtivity-emails` and checks its canonical parent; files are written
      `create_new` + `O_NOFOLLOW` (`write_unique_in_dir`); agent instruction
      names (`CLAUDE.md`, `AGENTS.md`, …) get an `attachment-` prefix;
      `ensure_generated_dir_ignored` refuses a symlinked `.gitignore`; remote
      projects are refused (and the button hidden).
    - **Screenshot half fixed 2026-09-30 (🧪 untested live)** — at the source,
      `fs::canonical_or_new`: a dangling link resolved to where it points, and
      `missing/../..` resolved lexically, both used to pass confinement (the
      write then left the project). Every local project write
      (`write_project_file{,_bytes}_local`, `create_file_local`,
      `create_dir_local`, the clipboard PNG save) now writes the resolved path,
      the file opened `O_NOFOLLOW`. Tests:
      `write_project_file_never_follows_a_dangling_link_out_of_the_project`,
      `write_project_file_blocks_escape_through_a_missing_folder`,
      `write_project_file_still_saves_through_a_link_inside_the_project`.
    - [x] 🤖 Automated test — `the_emails_folder_must_be_a_real_folder_inside_the_project`,
      `a_save_never_follows_or_clobbers_what_is_already_there`,
      `agent_instruction_names_are_defused`,
      `ensure_generated_dir_ignored_never_writes_through_a_symlink`.
    - [ ] 🖐️ Manual test — save an attachment to a local project; with
      `tabtivity-emails` replaced by a symlink the save is refused.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

849. **🔴 High — decrypted OpenPGP attachments are persisted.**
    `commands/mail.rs:2086-2091` `put_blob`/`put_attachment`s every attachment of
    the *decrypted* inner message before the `if !decrypted` guard (`:2102`),
    which only skips the raw blob and body cache. `docs/context/mail_encryption.md`
    promises decrypted plaintext never reaches a blob; on an unencrypted store
    it is written in the clear (`mail_store.rs:612-617`). Fix: move the loop
    under the guard (keep attachments of decrypted mail in memory only).
    - **Fixed:** no blob/row for a decrypted message's attachments; opening one
      forgets leftovers (`forget_message_content`, refcounted blob prune); save
      and preview re-fetch and re-decrypt via `load_attachment`.
    - [x] 🤖 Automated test — `forgetting_a_message_removes_only_blobs_nothing_else_names`.
    - [ ] 🖐️ Manual test — an encrypted mail with a PDF: preview and save work, and
      no new file appears under `mail/blobs/`.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

850. **🟠 Medium — a stalling IMAP server hangs sync for good.**
    `mail_engine.rs:1458/1526/1569/1610/1648`: `timeout()` wraps only
    `session.fetch(..)`, which in async-imap 0.11 returns once the command is
    *sent*; the `while let Some(item) = stream.next().await` drain is untimed and
    the socket has no read timeout. Cancel is checked only between steps
    (`commands/mail.rs:1758`) and `MailIndicator.tsx:171` skips an account still
    syncing, so polling stops until restart. async-imap also buffers a literal
    up to 512 MiB before `MAX_MESSAGE_BYTES` is checked — check `RFC822.SIZE`
    first. Fix: time the whole drain (per-item idle timeout).
    - **Fixed:** every response drain runs under `next_before` with the command's
      total deadline; `body` checks `RFC822.SIZE` before `BODY.PEEK[]`. No
      automated test (needs a stalling IMAP server).

851. **🟡 Low — session password follows an IMAP/SMTP host edit.**
    `resolve_password` (`commands/mail.rs:869-885`) looks up the in-memory
    session secret by `account.id`; `mail_account_upsert` (`:975-1017`) keeps it
    on a blank password field, so a typo'd/lookalike host (valid cert) receives
    the real password, and "remember" writes it under the new host's keychain
    key (`:1004`). Keychain-only secrets don't follow. Fix: drop the session
    secret when host/port/user change.
    - **Fixed:** the session password is dropped when the IMAP/SMTP user, host or
      port changes and no new password was typed.

852. **🟡 Low — link host display and phishing flags.**
    - `web_safety.rs:217` `host_of` / `:192` `has_userinfo` don't split on `\`:
      `https://evil.example\@bank.example/` is labelled **bank.example** in
      `LinkConfirmDialog` (`MailMessageView.tsx:464`) while browsers open
      evil.example. The mismatch strip still fires, but its wording ("text names
      a different site") is wrong for this case. Fix: `url::Url::parse().host_str()`.
    - `host_in_text` (`:260`) checks only the first word of link text; a quoted
      `data-lid="0"` in text can misalign link-text lookup
      (`mail_sanitize.rs:725-744`). Locate links from the anchor only.
    - `idna_display` (`:226`) shows punycode as Unicode with no confusable
      check; show the ASCII form beside it when they differ.
    - Bidi controls are stripped from display names but not from the address
      part (`mail_engine.rs:609`).
    - **Fixed:** http(s) hosts/userinfo parsed with `url::Url`; `hosts_in_text`
      checks every word (with a suffix filter against `e.g.`/`report.pdf`);
      IDN hosts shown as `unicode (xn--…)`; `data-lid` found only inside tags;
      addresses stripped of controls. `SANITIZER_VERSION` → 3. **Not done:** the
      mismatch strip's wording for the userinfo case.
    - [x] 🤖 Automated test — four new `mail_sanitize` tests.

853. **🟡 Low — the machine hostname leaks in every sent mail.**
    `mail-builder` default `gethostname` feature makes `Message-ID`
    `<rand@hostname>` (builder at `mail_engine.rs:1851` sets none), and
    `mail-send` EHLOs with `gethostname()` (`:1757-1763`, no `helo_host`). Fix:
    set `.message_id()` with the account address's domain and `.helo_host(..)`.
    - **Fixed:** `outgoing_message_id` (random @ sender domain) and
      `helo_host("[127.0.0.1]")`.
    - [x] 🤖 Automated test — `a_sent_message_id_names_the_sender_domain_not_this_machine`.

854. **🟡 Low — at-rest key and store lifecycle gaps.**
    - `mail_encryption_reset` (`commands/mail.rs:1195-1220`) mints a new master
      key but leaves `pgp.json` (sealed private keys; no secret export exists)
      and `filters.json.enc` unreadable, and deletes `accounts.json.enc` despite
      the "accounts.json deliberately survives" comment. Warn/export first.
    - A missing `key.json` with `mail_encrypt_store == Some(true)` →
      `open_unencrypted_or_enable` (`:336-356`) overwrites the keychain KEK,
      killing recovery from a backed-up `key.json`. Refuse instead.
    - `seal_existing` commits `META_ENCRYPTED=1` (`mail_store.rs:1918-1922`)
      before `vacuum_into_place`; a crash/disk-full leaves plaintext in free
      pages forever. Set the flag after the vacuum.
    - `priority_source`/`priority_reason` are missing from the `seal_existing`
      column list (`:1883-1891`).
    - `open_text` (`:261-290`) accepts plaintext TEXT in an encrypted store
      without a "damaged" marker (needs local write access).
    - `reseal_blobs` (`:~2140`) trusts `looks_sealed` for `ELMC\x01`-prefixed
      attachments; Argon2 `m_cost` is read unbounded from `key.json`; a
      passphrase change doesn't rotate the master key; `delete_account_mail`
      leaves blobs/drafts/outbox and runs no vacuum.
    - **Fixed:** reset carries accounts, filters and the PGP keyring across to the
      new key when unlocked, and moves the sealed files + `key.json` into
      `pre-reset-<unix>/` when locked; a missing `key.json` beside sealed data
      opens the memory-only store with a note instead of re-keying; the
      encrypted mark is set after the vacuum; priority columns sealed (plus a
      one-time pass for already-marked stores); plaintext in a completed sealed
      store reads as damaged; blobs re-sealed unless they actually open; Argon2
      parameters bounded; account delete prunes blobs and `VACUUM`s.
      Drafts/outbox of a removed account are kept on purpose.
    - **Passphrase rotation — not applicable (2026-09-30).** There is no
      passphrase-change action: the only way to get a new passphrase is
      `mail_encryption_reset`, which mints a new master key. The key-keeping
      `mail_crypt::rewrap` has no caller; its doc comment now says it must not
      back a "change passphrase" button without a re-seal.
    - [x] 🤖 Automated test — `plaintext_planted_in_a_sealed_store_reads_as_damaged`.

855. **🟡 Low — crypto chrome vanishes on reopen.** A body-cache hit returns
    `crypto: None` (`commands/mail.rs:2024`), but signed-only and
    failed-to-decrypt mail *is* cached, so "does not check out" / "no key" /
    "encrypted, locked" disappear on the second open. Cache the crypto verdict
    with the body (or don't cache those).
    - **Fixed:** only bodies with no crypto verdict are cached (version bump drops
      the old copies).

856. **🟡 Low — recipient addresses reach `RCPT TO` loosely validated.**
    `validate_recipient` (`mail_engine.rs:1798`) / `one_addr` (`:597`) let `<`,
    `>`, tab and other controls through; reply-all copies them from a received
    message into Cc. Accept a strict RFC 5321 address only.
    - **Fixed:** strict dot-atom local part, hostname domain, no format chars.
    - [x] 🤖 Automated test — `a_recipient_must_be_a_plain_address`.

857. **🟡 Low (latent) — `mail_move` uses the first id's account/folder for all
    UIDs** (`commands/mail.rs:2872-2890`), moving unrelated mail that shares UID
    numbers when ids span folders/accounts. No component calls `mailMove`
    (`src/lib/mail.ts:209`) yet. Group by (account, folder) or refuse mixed sets.
    - **Fixed:** refused unless every id shares the first one's account and folder,
      and the destination is in the same account.

858. **⚪ Info / hardening.**
    - No app ACL manifest in `build.rs`, so any *local-origin* webview can call
      every `mail_*` command (tauri 2.11 `webview/mod.rs:1823`); remote origins
      are blocked. `capabilities/browser.json`'s "resolves to no command" is
      wrong for app commands — correct the description, consider an app manifest.
    - Tabtivity Mobile reads mail with pairing as the only gate
      (`mobile_control/host.rs:981-1060`); writes have `mail_actions`/`mail_reply`,
      reading has no switch of its own.
    - Fenced agents can't see `state_dir()/mail` on Linux/macOS, except when
      `TABTIVITY_STATE_DIR` sits outside `$HOME` (read-only `/` bind); Windows is
      unfenced. `tabtivity-emails/` is always agent-readable.
    - Password copies escape `Password`: frontend `String`,
      `expose().to_string()` into async-imap/mail-send (`mail_engine.rs:1107`,
      `:1762`), `session_secret` returns `String`.
    - decrypt → `apply_crypto` recursion has no depth limit.
    - No revocation checking on Linux (`rustls-platform-verifier`);
      `require_vpn` checks a tunnel is up, not that mail routes through it.
    - **Fixed:** `browser.json`'s description corrected (no app manifest added);
      new phone switch `mail_read` (default on) gates every phone mail request;
      the fence tmpfs-hides `<state_dir>/mail` when the state dir is outside
      `$HOME` (Linux); IMAP login borrows the password, IPC/session copies are
      `Zeroizing`; decrypt depth capped. **Not done:** an app ACL manifest,
      revocation checking, VPN route verification, macOS fence equivalent,
      and `mail-send`'s owned credential copy.

859. **Deleting mail, and picking several messages at once** (user, 2026-09-17).
    ✅ Implemented · 🧪 Awaiting live QA. The header list had no delete at all
    and no way to act on more than one message, and its right-click *opened* the
    row it was invoked on — which marks it read and fetches its body for someone
    who was only reaching for a menu.
    - Right-click no longer opens a message: it **ticks** the row instead, which
      keeps the old guarantee (the menu cannot act on mail other than the one it
      names) without the side effects. A row already in the selection is left
      alone, so a right-click inside a set of ten does not throw nine away.
    - Ctrl-click adds a row, Shift-click takes a range, and every menu action —
      both priority marks, the unmark, and the delete — applies to the whole set;
      the menu's caption names the count in place of a subject. The ticks live in
      `stores/mail`'s `checkedIds` and are cleared by `loadPage`, since a folder
      change, a re-sort, a search keystroke or a pager step leave ids naming mail
      that is off screen.
    - **Delete is a move to Trash wherever there is one** (`mail_move`,
      recoverable on the server) and only otherwise permanent. `planMailDelete`
      (`src/lib/mail.ts`, pure) groups the rows per folder — one command selects
      one mailbox, and a cross-account priority list can be four groups across
      two accounts — and both the confirmation and the commands are computed from
      it, so the sentence the user reads and the delete that runs cannot
      disagree. The permanent half is confirmed (`useDialogs`, danger zone in the
      menu) and names how many messages it covers; Junk still moves to Trash,
      spam being a classification rather than a delete.
    - The permanent path is the new `mail_purge` command: `\Deleted` +
      **`UID EXPUNGE`**, and **UIDPLUS or a refusal** — a plain `EXPUNGE` removes
      every `\Deleted` message in the mailbox, including ones another client
      flagged and has not expunged, so a server without RFC 4315 is told to move
      the mail to Trash instead. The server is asked before the index, so a
      refused expunge leaves rows for mail that is still in the mailbox rather
      than the other way round.
    - `mail_move` now refreshes both folders' counters as well: a mail moved out
      of the inbox — which a delete-to-Trash is — was still counted there by the
      rail's unread badge until the next sync.
    - [x] 🤖 Automated tests — `MailDelete.test.ts` (the plan, the ticks,
      `deleteMessages`' grouping), `MailListSelect.test.tsx` (right-click opens
      nothing, modified clicks, the menu's wording and target),
      `mail_store::deleting_a_message_takes_its_row_body_and_attachments`.
    - **Live QA:** delete from the inbox → the message is in the server's Trash
      and off the rail's unread count; delete *in* Trash → the red-fenced
      confirm, then gone from the server; Ctrl/Shift-click a few rows → one
      delete moves all of them; right-click an unread row → it stays unread.

860. **Show the answers already written to a message** (user, 2026-09-21).
    - **Built:** `messages.reply_key` (keyed digest of `In-Reply-To`, written by
      the sync via `MailStore::set_reply_key`), `mail_replies` →
      `MailStore::replies_to` (Sent folders of any account, oldest first, local
      index only), and the "You replied (n)" strip in `MailMessageView`; a row
      unfolds the reply's plain text in place. Converting a plain store drops
      the cleartext keys; the next check writes keyed ones.
    - **Limits:** direct replies only (`In-Reply-To`, not `References`); a reply
      shows once its Sent folder has been checked; mail synced before this
      build gets its key on the next check.
    - [x] 🤖 Automated test — `replies_to_lists_the_users_own_answers_oldest_first`,
      `a_message_without_a_message_id_has_no_replies`,
      `converting_a_plain_store_drops_cleartext_reply_keys`, `MailReplies.test.tsx`.
    - **Needs a rebuild + restart** (backend).
    - [ ] 🖐️ Manual test — after a check, open an inbox message you answered →
      the strip lists the reply with date and recipient; click → its text
      unfolds. Reply to another message, check mail → its strip appears. A
      message never answered shows no strip.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

### Mail tools for agents — root MCP (#859)

- [x] **#859 Mail tools for the root agent and the contained reader** —
  ✅ Done · 🧪 untested live (2026-09-19). Rationale: `docs/context/root_console.md` §Mail, `docs/context/vm_projects.md`
  §"The contained mail reader".
    - A **root tab** writes mail drafts and never reads mail; a **contained
      reader** (agent tab in a `mail_reader` VM under default Proxy egress)
      reads and drafts. Nothing flags, moves, deletes or sends. Nine tools in
      `services::root_mcp_mail`, class table in `root_mcp::served`.
    - Per-account opt-in `MailAiPrefs.agent_access` (account dialog), VM switch
      "Mail reader" (VM settings), knob guards in `vm_set_spec` /
      `vm_allow_temporarily` / byte-sync, second `guestfwd`, `Reader` token at
      `pty_spawn`, reader writes always staged + tainted.
    - Frontend: composer banner (+ reader variant, empty-`to` note, Discard),
      "Drafted by agents" strip in the mail view, agent drafts as rows in the
      root review strip, ⚿ badge counts them and shows ✉ while an account is
      open to agents.
    - [x] 🤖 Automated tests — `root_mcp_mail::tests` (allowlist, schema scan,
      default-off, locked, no-trace, caps, envelope, invisible corpus, no-URL,
      encrypted, drafts, isolation, thread), `root_mcp::tests`
      (class × tool table, reader wiring, per-tab tokens), `mail_reader::tests`,
      `root_mcp_review::a_readers_writes_always_stage_and_carry_the_mark`,
      `vm::netdev_reader_adds_the_mcp_guestfwd_beside_the_proxys`,
      `MailAgentDrafts.test.tsx`, `RootOverlay.test.tsx`.
    - [x] **Three-state per-account switch** (2026-09-23, 🧪 untested live):
      Off / *Marked messages only* / *Whole account* in the account dialog
      (`MailAiPrefs.agent_scope`, unset = marked). Marks are local rows
      (`agent_marks`, store id + keyed `Message-ID` digest, never an IMAP
      keyword), set from the list's right-click group (one, by sender, whole
      folder), the open message's button, shown as ⚿ on the row and behind the
      *Shared* chip. A reader in marked scope gets the marked set everywhere —
      search, folder counts, thread, `reply_to_message_id`; an unmarked id
      answers like an invented one. Badge: ✉ marked, ✉✉ whole account. Tests:
      `root_mcp_mail::tests::{marked_only_*, unmarking_between_*, an_unset_scope_*}`,
      `mail_store::tests::an_agent_mark_*`, `MailAgentScope.test.tsx`.
      **Live QA:** turn an account on → it lands on *marked*, `mail_accounts_list`
      shows `scope: marked`, search empty, folder counts zero; share one message
      from the menu → search finds it, `mail_read` reads it, the thread shows it
      alone, it stays unread; stop sharing → the next `mail_read` is "unknown
      message"; in another client no new IMAP keyword; switch to *whole
      account* → the rest appears; back → only the mark.
    - [x] **Local-model tabs read shared mails** (user, 2026-09-23, 🧪 untested
      live): Settings → Root console and MCPs → *Local models may read the
      mails you share* (`Settings.root_mcp_mail_local_read`, absent = off).
      A Vibe local-model tab (MCP chip) gets the four read tools over the
      **marked messages only**, whatever the account's scope, of accounts with
      `agent_access` on (drafts still need no consent); refused with
      `LOCAL_READ_REMOTE` while `ollama_host` is not loopback. Its first read
      latches `Session::has_read_mail`: every later calendar/board write
      stages with the taint mark even at review `off`, and its drafts carry
      origin `reader`. Cloud root tabs still never read (`Policy::reads_mail`).
      Tests: `root_mcp_mail::tests::{a_local_model_reads_marked_mails_only,
      local_reads_need_the_switch_*}`,
      `root_mcp_review::tests::a_local_model_that_read_mail_stages_its_writes`,
      `root_mcp_security::tests::only_readers_and_opted_in_local_models_read_mail`,
      `RootMcpMailLocalReadSetting.test.tsx`.
      **Live QA:** mail tools on, the new switch on, one account on *marked*,
      share one message; open a local-model tab (MCP chip) → "what's in my
      shared mail" lists that message only and reads it (it stays unread); an
      unshared message id is "unknown message"; a Claude root tab still lists no
      read tool. Ask it to reply → the draft has the sender as `to` and the
      *mail-reading agent* banner. Ask it to add a board card → a proposal with
      the reader mark, even with review `off`. Point `ollama_host` at another
      machine → reads refused.
    - **Needs a rebuild + restart** (backend). The reader half also needs the
      VM tier's first live boot.
    - **Live QA, root tab:** a root Claude tab lists the draft tools and no read
      tool; "check my inbox" ends in "I have no tool for that". Ask for a draft
      → it shows in the mail view's "Drafted by agents" strip and the root
      review strip, opens with the banner, empty `to`, no attachment; Save, then
      ask the agent to change it → refused. Lock the keyring / never open mail →
      "mail is locked", no prompt. Check the mail overlay opens **above** the
      root console when a draft is opened from the review strip.
    - **Live QA, reader:** flag a VM project with default egress; with every
      account's switch off `mail_accounts_list` is empty. Turn one on: search,
      read — the message stays unread. `curl` from the reader fails and shows in
      the blocked log. Allow GitHub → refused until the flag is cleared, and the
      other way round. A subject with a bidi override / zero-width run and a
      body holding the envelope's closing marker read inert. A reply draft has
      the thread's recipients and the reader banner; an address outside the
      thread is refused; a root tab does not list the reader's draft. Ask the
      reader to add a board card → a proposal carrying the reader mark. An
      ordinary project agent tab has no `tabtivity` MCP server at all.

### Address book (#870)

- [x] **#870 Address Book for the mail client (Thunderbird-style)** —
  ✅ Done · 🧪 untested live (2026-09-25). Code: `services/mail_contacts.rs`
  (pure), `commands/mail.rs` §address book, `MailAddressBook.tsx`,
  `MailRecipientField.tsx`, `lib/mailContacts.ts`. Pills:
  `npm run untested -- list mail.contacts`.
    - Personal + Collected books; cards (names, nickname, several addresses,
      phones, org/title, postal address, website, birthday, notes); mailing
      lists; search; Write per address / to a list; move Collected → Personal.
    - Collect-on-send (after SMTP accepted, best effort, switchable); every
      send bumps the matching card's popularity (the autocomplete tie-break).
    - To/Cc/Bcc autocomplete (nickname > name prefix > address prefix >
      substring); lists expand to members; bare addresses only.
    - ☆/★ beside a message's sender: add to / open in the Address Book.
    - vCard import (2.1/3.0/4.0, QP, Windows-1252, merge by address) and 3.0
      export, through backend-raised dialogs; sealed `contacts.json` under
      its own AAD, carried across an encryption reset.
    - Not built: CardDAV sync, contact photos, CSV import/export, a contacts
      sidebar in the composer, agent/MCP access (deliberately none).
    - [x] 🤖 Automated tests — `services::mail_contacts::tests` (19),
      `src/__tests__/mail/MailContacts.test.tsx` (12)
    - [ ] 🖐️ Manual test — Address Book button → tab opens once; New Contact
      with two addresses saves; a bad address is refused by name; type part of
      the name in To → suggestion, Enter inserts the address; a list expands;
      send a mail to a stranger → they appear under Collected Addresses; the ☆
      on a received message pre-fills a card, ★ once saved; import a
      Thunderbird/Google `.vcf`, re-import it → merged, not doubled; export and
      re-import round-trips; with store encryption on, only
      `contacts.json.enc` exists in the mail dir.
        - [ ] ✅ Works on Linux (X11)
        - [ ] ❌ Doesn't work on Linux (X11)
        - [ ] ✅ Works on Linux (Wayland)
        - [ ] ❌ Doesn't work on Linux (Wayland)
        - [ ] ✅ Works on Windows
        - [ ] ❌ Doesn't work on Windows
        - [ ] ✅ Works on macOS
        - [ ] ❌ Doesn't work on macOS
