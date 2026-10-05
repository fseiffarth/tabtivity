# In-App Browser — Plan B: Threat Model & Security Architecture

> Scope: the security posture of an embedded web browser (TODO group J, #61). Tab/UI
> integration is Plan A's; engine and Tauri-API feasibility is Plan C's. This document
> owns the threat model, the isolation boundary, and every defence — it names Plan A's
> and Plan C's surfaces only as contracts.
>
> Verification gates for everything below: `npx tsc --noEmit` and
> `cargo test --manifest-path src-tauri/Cargo.toml`. **Never launch Tabtivity to verify.**
> Every example host in this document and in every test fixture is a neutral public
> or RFC 2606 / RFC 6761 reserved domain — no institution, lab, or employer hostnames
> anywhere, since the repo is public.
>
> Companion reading: `docs/mail_client_plan_b.md`. The mail client is the precedent this
> plan is measured against, and §8 is entirely about the one place where a browser
> **cannot** be as strict as the mail viewer.

---

## 0. The one-paragraph version

The mail client's security rests on a single structural fact: **the message body is never
allowed to execute**. Everything else — the `sandbox=""` frame, the `default-src 'none'`
CSP, the `href`-less anchors — is scaffolding around that. A browser cannot have that
fact. The whole design therefore moves the guarantee down one level: **arbitrary JS runs,
and is worth nothing, because the process it runs in has no privileged bridge, no
persistent storage, no filesystem verb, and no path argument to traverse.** Where mail
says "no script can run", the browser says "a script that runs reaches nothing". The rest
of this document is the enumeration of what "reaches nothing" has to mean, and the tests
that keep it true.

---

## 1. Crate selection (verified against crates.io on 2026-07-26, not from memory)

### 1.1 What is already in the tree (reuse, do not duplicate)

From `Cargo.toml` and `Cargo.lock` at the repo root:

| Already present | Locked version | Use for the browser |
|---|---|---|
| `tauri` | **2.11.3** | the webview host; `wry` **0.55.1** underneath (§2) |
| `url` | 2.5.8 (transitive, re-exported as `tauri::Url`) | the scheme/host gate (§3) — name it directly, do not re-parse by hand |
| `idna` | 1.1.0 (added for mail) | punycode ↔ Unicode for the address bar (§7) |
| `ammonia` | 4.1.4 (added for mail) | **Reader mode** (§8) — the same sanitizer, unchanged |
| `infer` | 0.19.0 | download content sniffing (§6) |
| `mime_guess` | 2.0.5 | extension → MIME for the download mismatch check (§6) |
| `tempfile` | 3.27.0 | download quarantine staging (§6) |
| `sha2` | 0.10.9 | content-addressed quarantine names (§6) |
| `tauri-plugin-dialog` | 2 | the mandatory native save dialog (§6) |
| `opener` | 0.8.4 | behind `commands::ssh::open_external_url`, which already refuses non-`http(s)` |
| `keyring` | 3 (via `services::remote_credentials`) | **not used by the browser.** See §4.6 — there is no second keychain path and no password manager |
| `reqwest` | 0.13.4 (transitive, **no TLS backend enabled**) | Reader-mode fetch (§8) — needs a feature block, exactly as the mail plan specified |
| `zeroize` | 1.9.0 | not needed; the browser holds no secret of its own |

`grep -rn "register_uri_scheme_protocol" src-tauri/src` returns **nothing**. That is
load-bearing and §2.4 explains why: every custom protocol Tabtivity registers is, by
Tauri's own definition, a *local* origin.

### 1.2 Verified crate status for the additions

| Crate | Version | Last release | Recent d/l | Verdict |
|---|---|---|---|---|
| `psl` (addr-rs) | **2.1.222** | **2026-07-25** | ~4.55M | **Adopt.** Compiled Mozilla Public Suffix List with a generated matcher; exactly one dependency, `psl-types ^2.0.11`. No I/O, no network, no build script that fetches. This is what makes the address bar bold the *registrable* domain rather than the last two labels (§7.2). |
| `psl-types` | 2.0.11 | — | — | Transitive via `psl`. |
| `publicsuffix` | 2.3.0 | 2024-11-14 | ~9.90M | **Reject.** More popular but it is a *parser* for a list you must ship and refresh yourself. That turns an evergreen data problem into a vendored file nobody updates. |
| `ipnet` | **2.12.0** | 2026-03-03 | ~117M | **Adopt.** RFC 1918 / ULA / CGNAT / link-local range tests for the loopback-and-intranet navigation gate (§9.3). `std::net`'s `is_global()` is still unstable, so this is the stable replacement rather than a convenience. |
| `unicode-security` | 0.1.2 | 2024-09-12 | ~2.93M | **Adopt, narrowly.** UTS-39 mixed-script and confusable detection for the address bar (§7.3). Old but the spec it implements is old too, and the alternative is hand-rolling script-range tables. Used only for a *display warning*, never for a block decision — so a bug in it degrades a hint, not a gate. |
| `reqwest` | 0.13.4 | — | — | Already resolved in the tree with **no TLS backend**. Reader mode gives it one (§8.3). |

### 1.3 Prescribed `Cargo.toml` additions

```toml
# ── In-app browser (see docs/browser_plan_b.md) ──────────────────────────────
# eTLD+1 for the address bar's origin emphasis. `registrable()` in
# `services::mail_sanitize` is a two-label approximation with a comment saying a
# real PSL is the Phase-2 refinement; this is that phase, and mail moves onto it
# (§7.2) so there is ONE implementation, not two.
psl = "2"
# Stable RFC-1918 / ULA / CGNAT / link-local classification for the intranet
# navigation gate (§9.3). `IpAddr::is_global()` is still unstable.
ipnet = "2"
# UTS-39 mixed-script detection for the address bar's homograph warning (§7.3).
# Advisory only — it colours a warning, it never blocks a navigation.
unicode-security = "0.1"
# Reader mode (§8.3) fetches pages in the backend. Already in the dependency tree
# via tauri with no TLS backend; this names it directly and gives it one. Same
# feature block the mail plan specified for the remote-image proxy, so the two
# uses share one rustls stack and one crypto provider.
reqwest = { version = "0.13", default-features = false, features = ["rustls-tls", "http2", "charset"] }
```

**Build hazard, identical to the mail plan's:** `reqwest`'s `rustls-tls` may pull
`aws-lc-rs`, and `rustls` 0.23 panics at first use when more than one `CryptoProvider` is
compiled in and none is installed. The mail plan already prescribes
`rustls::crypto::ring::default_provider().install_default()` in `lib.rs`. If that landed,
this adds nothing; if it did not, it is a prerequisite commit here.

**No new crate is added for:** URL parsing (`url` is present), punycode (`idna` is
present), HTML sanitization (`ammonia` is present), content sniffing (`infer`), archive
handling (the browser never extracts anything), or credentials (there are none — §4.6).

### 1.4 Supply-chain posture on `psl`

`psl` republishes on roughly every upstream PSL change — 2.1.222 landed **yesterday**. A
dependency that moves that often is itself a risk if bumps are rubber-stamped. The rule,
written into the `Cargo.toml` comment:

> A `psl` bump is a **data-only** diff. Review it as data: `cargo update -p psl` followed
> by a diff that touches only the generated list is fine; a diff that touches the matcher
> or adds a dependency is a code change and gets read line by line.

The one place a malicious PSL could hurt us is the address bar's origin emphasis — it
could make `evil.example` bold the wrong label. It cannot reach the navigation gate
(§3), which never consults the PSL, and it cannot reach the IPC boundary (§2), which
never consults anything.

---

## 2. The isolation boundary — the centerpiece

### 2.1 What Tauri 2.11.3 actually does (read from the source, not from docs)

Four facts, each verified in
`~/.cargo/registry/src/*/tauri-2.11.3/`. Every design decision below hangs off them.

**Fact 1 — the IPC bridge is injected into *every* webview Tauri creates, including one
pointed at `https://example.com`.** `src/manager/webview.rs:157–224` assembles the
initialization scripts unconditionally: `window.isTauri`, `window.__TAURI_INTERNALS__`,
the invoke script (carrying `__TAURI_INVOKE_KEY__`), the window/webview metadata, the IPC
and pattern init. There is **no builder switch that skips it.** Consequence: any page
Tabtivity loads in a Tauri webview can read `window.__TAURI_INTERNALS__.invoke` *and the
invoke key baked beside it*. The invoke key is therefore **not** a defence against page
JS; it only stops content that never received the init script.

**Fact 1a — the scripts are `for_main_frame_only: true`.** Iframes inside a browsed page
do **not** get `__TAURI_INTERNALS__`. That is a real, if narrow, win: third-party ad and
widget frames are structurally further from the bridge than the top document is.

**Fact 2 — the ACL, not the bridge's absence, is what rejects the call.**
`src/webview/mod.rs:1742 on_message` computes
`is_local = self.is_local_url(&request.url)`, sets
`acl_origin = if is_local { Origin::Local } else { Origin::Remote { url } }`, and then:

```rust
if (plugin_command.is_some() || has_app_acl_manifest || !is_local)
  && request.cmd != crate::ipc::channel::FETCH_CHANNEL_DATA_COMMAND
  && invoke.acl.is_none()
{ /* reject */ return; }
```

So for a **remote** origin, *every* command — plugin or custom — is rejected unless a
capability explicitly resolves for that origin. Tauri's own test
`remote_origin_blocked_for_custom_commands_without_app_manifest`
(`src/webview/mod.rs:2424`) pins this.

**Fact 3 — "remote" is defined by exclusion, and the exclusion list is larger than it
looks.** `is_local_url` (`src/webview/mod.rs:1698`) returns **true** when the URL is:

1. the `tauri://` (Windows/Android: `https://tauri.localhost`) protocol origin; **or**
2. relative to the app URL — `frontendDist` in release, **`devUrl` in dev**, which for
   this repo is `http://localhost:1420`; **or**
3. under **any** URI scheme the app registered with `register_uri_scheme_protocol`.

Consequence, stated as sharply as it deserves: **a browser webview that navigates to
`http://localhost:1420/anything` in a dev build is a LOCAL origin.** So is one that
navigates to `tauri://localhost`. Either would clear the origin half of the ACL gate.

**Fact 4 — capability `windows: [...]` grants the whole window, every webview in it.**
`tauri-utils`'s `Capability` doc, verbatim: *"If a window label matches any of the
patterns in this list, the capability will be enabled on all the webviews of that window,
regardless of the value of [`webviews`]."* Resolution
(`src/ipc/authority.rs:resolve_access`) is
`origin.matches(&cmd.context) && (webviews.any(match) || windows.any(match))`.

Tabtivity's `src-tauri/capabilities/default.json` today reads
`"windows": ["main", "detached-*", "present-*"]` with **no `webviews` field**. A browser
webview added as a child of the `main` window therefore satisfies the window half of that
condition. The *only* thing between it and `core:default` + `dialog:default` +
`drag:default` + `notification:default` is Fact 3 returning `false`.

That is one gate. One gate is not an architecture.

### 2.2 The contract

Six requirements. Each is a "must be true" with an owner and a test.

| # | Requirement | Enforced in | Test |
|---|---|---|---|
| **BC-1** | The capability grant is scoped by **webview label**, never by window label. `default.json` drops `windows` entirely and uses `webviews`. | `src-tauri/capabilities/default.json` | §12.1 |
| **BC-2** | No capability file anywhere contains a `remote` key, and none sets `"local": false` on a grant intended for the app. | same | §12.1 |
| **BC-3** | The browser webview's label matches `browser-*` and **no** capability pattern matches it. | `commands/browser.rs::spawn_browser_webview` | §12.1 |
| **BC-4** | Tabtivity registers **zero** custom URI scheme protocols for as long as an in-app browser exists. | anywhere (`register_uri_scheme_protocol`) | §12.2 |
| **BC-5** | The navigation gate hard-refuses the app's own origin, `tauri:`, and the dev-server origin — in **both** debug and release builds. | `services::browser_policy::navigation_allowed` | §12.3 |
| **BC-6** | `withGlobalTauri` stays absent/false and `app.security.pattern` is untouched. | `tauri.conf.json` | §12.1 |

**BC-1 is the load-bearing one.** With it, the browser webview fails *both* halves of
`origin.matches(...) && (webviews.any(...) || windows.any(...))`, independently. A
regression in the navigation gate (BC-5) no longer becomes IPC access; it becomes a
cosmetic bug where a page renders Tabtivity's own UI inside a browser tab. That is the
difference between a defence and an architecture.

The exact file, complete:

```json
{
  "$schema": "../node_modules/@tauri-apps/cli/schema/capability.json",
  "identifier": "default",
  "description": "Tabtivity default capabilities — commands and window management. Scoped by WEBVIEW label, deliberately: a capability with a `windows` list grants every webview inside that window, which would include the in-app browser's child webview (docs/browser_plan_b.md §2.1 Fact 4). There is no `remote` key here and there must never be one — a `remote` entry is the single line that would hand a browsed page the Tauri IPC bridge.",
  "webviews": ["main", "detached-*", "present-*"],
  "permissions": [
    "core:default",
    "core:window:allow-minimize",
    "core:window:allow-maximize",
    "core:window:allow-unmaximize",
    "core:window:allow-toggle-maximize",
    "core:window:allow-is-maximized",
    "core:window:allow-close",
    "core:window:allow-destroy",
    "core:window:allow-start-dragging",
    "core:window:allow-set-position",
    "core:window:allow-set-size",
    "core:window:allow-current-monitor",
    "core:window:allow-set-fullscreen",
    "core:event:allow-emit",
    "core:event:allow-emit-to",
    "core:event:allow-listen",
    "core:event:allow-unlisten",
    "core:webview:allow-create-webview-window",
    "core:webview:allow-set-webview-zoom",
    "dialog:default",
    "drag:default",
    "notification:default"
  ]
}
```

Note the label arithmetic this depends on: a `WebviewWindow` creates a webview whose label
equals the window's, so `main`, `detached-<id>`, `present-<id>` keep working unchanged.
**This must land as its own commit, before any browser code**, with §12.1's tests, and be
smoke-checked by the user on a rebuild — a capability typo is a silently dead UI, and the
failure mode ("nothing works") is loud enough that it will be caught, but only if it is
isolated.

### 2.3 Surface choice, and why the security answer is "either, once BC-1 holds"

Two shapes are possible, and Plan A/C own the choice. The security review of each:

**(A) Child webview inside the `main` window** (`Window::add_child`). Gives a real in-tab
browser. Requires the `tauri` crate's **`unstable`** feature —
`src/window/mod.rs:1127` is `#[cfg(any(test, all(desktop, feature = "unstable")))]`, and
`Cargo.toml` currently declares `tauri = { version = "2", features = [] }`. Security cost
before BC-1: catastrophic (§2.1 Fact 4). After BC-1: none — the webview label is the gate,
and the window it happens to live in is irrelevant.

**(B) A separate `WebviewWindow`** labelled `browser-<id>`. Stable API; Tabtivity already
does this twice (`commands/presenter.rs`, `commands/subwindow.rs`). Security cost before
BC-1: none, because `browser-*` matches none of `main`/`detached-*`/`present-*`. After
BC-1: none.

**Recommendation:** land BC-1 first and then let Plan A pick on UX grounds. Do **not**
adopt (A) without BC-1 — that ordering is the entire difference between the two options'
risk, and it is easy to get backwards because (A) *looks* safe (the origin gate holds
today).

One consequence of (A) that is a security problem and not only a layout one: **a child
webview is a native view composited above the window's HTML.** Tabtivity's own overlays —
modals, the file-tree panel, menus — will render *underneath* it. A confirmation dialog
raised over a browser tab may be invisible. Therefore:

> **Every security-relevant browser prompt is either a native OS dialog
> (`tauri-plugin-dialog`, raised from Rust as `commands::mail` already does) or is shown
> only after the browser webview has been programmatically hidden or resized to zero.**
> An HTML confirm painted "over" a child webview is not a confirm.

This is §5's and §6's prompt contract, handed to Plan A.

### 2.4 The residual: `plugin:__TAURI_CHANNEL__|fetch`

The ACL check in Fact 2 carries one exemption, marked `// TODO: Remove this special check
in v3`:

```rust
&& request.cmd != crate::ipc::channel::FETCH_CHANNEL_DATA_COMMAND
```

`src/ipc/channel.rs:318` shows what that command is: it reads `Tauri-Channel-Id` from the
request headers, parses it as a `u32`, and `remove`s the matching entry from a
**process-global** `ChannelDataIpcQueue` — no webview check, no origin check. The ids come
from `static CHANNEL_DATA_COUNTER: AtomicU32`, i.e. they start at 0 and increment.

So: **a browsed page can enumerate channel-data ids and read large `Channel` payloads
queued for Tabtivity's own webview.**

Why this is survivable today, and what keeps it that way:

- `grep -rn "ipc::Channel" src-tauri/src` returns **nothing**. Tabtivity uses events
  (`Emitter::emit`), not channels, so the queue is permanently empty and there is nothing
  to steal. Events are pushed to a labelled target and are not readable this way.
- A **tripwire test** (§12.2) asserts that `tauri::ipc::Channel` appears nowhere in
  `src-tauri/src`, failing with: *"Channels are readable by any webview via
  `plugin:__TAURI_CHANNEL__|fetch`, which bypasses the ACL origin check. Use an event, or
  read docs/browser_plan_b.md §2.4 first."*
- The `tauri` dependency is pinned in `Cargo.lock` at 2.11.3; a bump is reviewed against
  this section.

Residual risk: **low today, unbounded the moment someone adds a Channel.** Named, tested,
and not hidden.

### 2.5 Fallback if the platform cannot honour the contract

If Plan C finds that BC-1 cannot be expressed (a Tauri regression, a label-matching
surprise, `add_child` unusable without `unstable` and `unstable` unusable for another
reason), the fallback is **not** "ship it anyway with the origin gate alone". It is:

**Fallback F1 — reader-mode-only browsing.** Drop the engine webview entirely. Pages are
fetched by the backend (`reqwest`), sanitized by `ammonia` with the mail configuration,
and rendered in the *existing* `<iframe sandbox="" srcdoc>` inside the app webview — the
`MailMessageView` pattern, verbatim. There is then no second webview, no second origin,
and no new IPC boundary at all; the browser becomes a fetch-and-sanitize feature with
exactly the mail client's proven security properties. It is a much worse browser (§8) and
a completely safe one.

**Fallback F2 — hand off to the external browser.** `commands::ssh::open_external_url`
already exists, already refuses non-`http(s)`, and already routes through the user's
configured global app (TODO J #33). "We could not build this safely" is a legitimate
outcome, and it is one line of code.

Ship F1 as the reader mode regardless (§8) — that way F1 is not a contingency to be
written under pressure, it is a mode that already exists and passes tests.

---

## 3. Navigation and scheme policy

### 3.1 Where the check runs

**In the backend, in `on_navigation`, in Rust.** Not in the address-bar component, not in
a React effect. The frontend's address bar is an *input*, not a gate: a page can navigate
itself, a redirect can move it, a `target=_blank` can spawn it, and none of those pass
through React.

```rust
// src-tauri/src/services/browser_policy.rs
pub enum NavDecision { Allow, Block(BlockReason), Confirm(ConfirmReason) }

/// The single navigation gate. Pure, total, and unit-tested against §12.3's table.
/// Takes `&Url` (already parsed by the `url` crate — never a &str, so there is no
/// second parser to disagree with the first).
pub fn navigation_allowed(url: &Url, ctx: &NavCtx) -> NavDecision;
```

Wired in exactly one place:

```rust
WebviewBuilder::new(label, WebviewUrl::External(start_url))
    .on_navigation(move |url| matches!(policy::navigation_allowed(url, &ctx), NavDecision::Allow))
```

**Verified platform behaviour (wry 0.55.1, `src/webkitgtk/mod.rs:548`):** the handler is
connected to `decide-policy` and runs for `PolicyDecisionType::NavigationAction` only —
which covers **top-level *and* iframe navigations**, and does **not** cover subresource
loads (`fetch`, `XHR`, `<img>`, `<script>`). Two consequences that must be written into
the code comment so nobody re-derives them wrong:

1. The gate is stricter than expected: a page's own `<iframe src>` is filtered by the same
   allowlist. That is desirable, and it means `about:blank` and `about:srcdoc` must be
   **allowed** or ordinary pages break.
2. The gate is weaker than expected: **it cannot stop a page from `fetch()`-ing
   anything.** §9 is where that is dealt with; do not pretend §3 covers it.

`on_navigation` on the `NewWindowAction` decision type returns `false` (default handling)
— popups are gated separately, by `on_new_window` (§5.4).

### 3.2 The scheme allowlist

**Allow — and nothing else:**

| Scheme | Condition |
|---|---|
| `https` | always |
| `http` | allowed, with the mixed-content and downgrade rules of §3.4 |
| `about` | only the exact URLs `about:blank` and `about:srcdoc`. `about:config`, `about:cache`, anything else → block |

**Hard-block, with the reason surfaced in an in-app error page (not a native dialog — a
blocked navigation is a page state, not an interrupt):**

| Scheme | Why |
|---|---|
| `file` | reads the user's disk into a scriptable document; `file:` → `file:` linking is a directory-listing exfiltration primitive. There is **no setting** that enables it. |
| `tauri`, `asset`, `http(s)://*.localhost` for any registered protocol name | Fact 3: these are *local* origins. This is BC-5. |
| the app URL origin (`frontendDist` in release, `devUrl` in dev) | Fact 3 again. The dev case is the easy one to forget and the dangerous one. |
| `javascript` | top-level `javascript:` navigation runs in the *current* document's origin — the classic self-XSS-into-anything primitive. |
| `data` | top-level `data:` gets an opaque origin in modern engines, but the phishing value of a full-page `data:text/html` with a fake address bar is high and the legitimate value is zero. |
| `blob` | a `blob:` top-level navigation inherits the creator's origin. |
| `ws`, `wss`, `ftp`, `smb`, `gopher`, `vbscript`, `chrome`, `chrome-extension`, `resource`, `moz-extension`, `ms-*`, `search-ms`, `intent`, everything else | no legitimate top-level use, several are historical RCE handlers. |
| `mailto`, `tel`, `webcal`, `magnet`, `sms` | **not blocked, not navigated.** Handled internally: `mailto:` opens Tabtivity's own composer (the mail client exists), the rest route through TODO J #33's `launch_app` role dispatch. Never handed to `opener::open` from browsed content without a confirm that names the target (§3.6). |

The list is expressed as an **allowlist plus an explicit deny-list**, not as a deny-list
alone, and `navigation_allowed` returns `Block(UnknownScheme)` for anything it does not
recognize. A scheme invented after this document is written is blocked by default.

### 3.3 Redirect chains

`on_navigation` fires for each hop, so the gate runs on every one — but three rules
matter beyond that:

1. **A redirect that lands on a blocked scheme is blocked at the hop, and the error page
   names the *whole chain*.** `https://short.example/x → http://192.168.1.1/` must not
   read as "example.com failed"; the user needs to see where it actually went.
2. **Redirect depth is capped at 20**, tracked per-tab in `NavCtx`. Over the cap the tab
   stops with a "redirect loop" page. (WebKit and WebView2 both cap internally; this is
   ours so the behaviour is identical on both and so the *count* is available to the UI.)
3. **A cross-origin redirect resets the per-host confirmations of §9.3.** A user who
   confirmed "yes, reach `192.168.1.10` this once" has not confirmed the host it
   redirects to.

### 3.4 http → https, downgrade, and mixed content

- **HTTPS-first, not HTTPS-only.** A URL typed or clicked without a scheme is attempted as
  `https://` first; on a connection-level failure (not a 4xx/5xx) it falls back to
  `http://` **and the address bar shows a persistent "Not secure — this page was sent
  unencrypted" chip that cannot be dismissed for the life of the tab.** Silent fallback is
  the norm in shipping browsers and it is the wrong default for a tool whose users are
  often on a VPN or a lab network.
- **An `https:` page that navigates itself to `http:` on the same host is blocked**, with
  a "this site tried to downgrade the connection" page and a *Continue on http* button
  that is not the default focus. A downgrade mid-session is the shape of an active
  attacker; a first-hop `http:` is usually just an old site.
- **Mixed content: passive is blocked, active is blocked, and neither is overridable.**
  This is the engine's default in both WebKitGTK and WebView2 for active content; for
  passive (images) both engines default to *allow*. We do not currently have an API to
  tighten passive mixed content, so: **residual risk, disclosed** — a mixed-content image
  on an https page can still act as a tracking beacon. The address bar shows the
  broken-lock state when the engine reports it (`WebKitWebView::is-loading` /
  `tls-errors`; Plan C to confirm the exact signal).
- **There is no "ignore certificate" control anywhere in this browser.** See §7.5.

### 3.5 What the user sees when a navigation is blocked

An **in-app** error page, rendered by Tabtivity's own React (not injected into the browser
webview — never inject HTML we wrote into an origin a page controls), stating:

- the scheme or rule that blocked it, in words;
- the **full** URL, monospace, `word-break: break-all`, **never ellipsis-truncated** —
  truncation is itself the attack (`https://example.com.evil.tld/…` reads as
  `https://example.com…`);
- for a blocked redirect, every hop;
- exactly two actions: **Back** (default focus) and **Copy link**. For `http(s)` URLs
  blocked by the intranet rule (§9.3) there is additionally **Open anyway, once**. For
  every other block reason there is **no override at all**, and the page says so.

### 3.6 Handing a URL outward

The only route from the browser to the OS is `commands::ssh::open_external_url`, which
already refuses non-`http(s)`. The browser adds a second gate on top: an *Open in your
browser* action exists on a page, and it hands `open_external_url` a URL read from the
**backend's own per-tab record**, never a string round-tripped through the frontend. Same
rule as mail's link table (`docs/mail_client_plan_b.md` §2.5), same reason.

---

## 4. Storage, sessions, and credentials

### 4.1 The decision: ephemeral by default, and that is the whole design

**v1 browses in one ephemeral profile per Tabtivity run. Nothing is written to disk.
Everything is gone at quit.**

Mechanism: `WebviewBuilder::incognito(true)`, verified in wry 0.55.1 to mean:

- **Linux (WebKitGTK):** `WebContext::new_ephemeral()`; wry's own doc note is *"WebContext
  will be ignored if incognito is enabled"* — no `WebsiteDataManager` base directory, no
  cookie file, no cache directory.
- **macOS/iOS (WKWebView):** the `nonPersistent` `WKWebsiteDataStore`.
- **Windows (WebView2):** InPrivate profile; requires WebView2 Runtime ≥ 101.0.1210.39 and
  is a **silent no-op on older runtimes** (wry documents this explicitly). See §4.5.

What ephemeral buys, stated as the threats it retires outright:

| Retired threat | Because |
|---|---|
| Cookie/session theft from disk | there is no cookie jar on disk |
| Cross-project session bleed | there is no session to bleed; a project switch is not a boundary that has to hold |
| Third-party tracking across launches | every launch is a fresh profile with no identifiers |
| Service-worker persistence (a script that outlives the tab that installed it) | the SW registration store is in the ephemeral data store and dies with it |
| "Which browser profile did Tabtivity read?" (#60's rule) | Tabtivity's browser reads no profile at all — not its own, and never, ever another browser's |
| A malicious page seeding IndexedDB with a payload that a later, more-trusted page reads | nothing survives |

What it costs, stated honestly and shown in the UI: **every site looks logged out, every
launch.** The address bar carries a permanent "Private — nothing is saved" chip, and the
first browser tab of a session shows a one-line notice with a *Learn more* that explains
the trade and points at *Open in your browser* for anything the user actually wants to
stay signed in to.

### 4.2 Per-project partitioning

**Not implemented, because ephemeral makes it moot** — with nothing persisted, the storage
partition and the project lifetime already coincide, and a second partitioning axis would
be state that pretends to be a boundary.

There is, however, one thing worth doing and it is free: the browser's data store is
**per Tabtivity run, not per tab**, so two tabs share a login within one session (a user who
signs into a site in tab 1 expects tab 2 to be signed in). Do **not** add per-tab
partitioning; it produces a browser that behaves like nothing the user has used.

**Phase 2, if persistence is ever added** (see §10 for why it is not v1): the profile
directory is `<state_dir>/browser/profiles/<uuid>/`, `0700` on Unix, one directory per
*named* profile the user creates explicitly, never one per project — because a project is
a code location and a login is an identity, and conflating them means renaming a project
logs you out. Phase 2 must additionally answer: what happens to the profile when the
project is deleted, what the "clear this profile" verb is, and whether the profile is in
the privacy-check scan's blast radius.

### 4.3 The one path that touches disk

Downloads (§6), and only via quarantine → native dialog. There is no other write.
`<state_dir>/browser/` therefore contains, at rest, **nothing but an empty (or transient)
`quarantine/` directory**, created `0700`, swept at startup exactly as
`services::sandbox::sweep_orphans` sweeps stale containers: anything left there from a
previous run is by definition abandoned and is deleted.

### 4.4 What Tabtivity must never touch

Restating the repo's standing rule (TODO O #60, `docs`-level policy) in browser terms,
because a browser is precisely the feature that will tempt someone to break it:

> **Tabtivity never reads, writes, imports from, or "detects" another browser's profile,
> preferences, cookie jar, bookmark file, password store, or download directory.** Not
> Firefox's `prefs.js`, not Chromium's `Preferences`, not `~/.mozilla`, not
> `~/.config/google-chrome`, not the macOS `Safari` container, not the WebView2 user data
> folders of other apps. Not to import bookmarks, not to "continue where you left off",
> not to read a proxy setting, not to reset anything.

`commands/downloads.rs` was deleted for exactly this and must not come back under a new
name. §12.2 has the source-scanning test.

### 4.5 The Windows `incognito` no-op

wry's own documentation says `incognito` "does nothing on older versions" of the WebView2
Runtime (< 101.0.1210.39, i.e. pre-May-2022). A silent no-op here means **the entire
storage story of §4.1 silently does not apply** — cookies and cache land in a persistent
user-data folder.

Handling, and it is not "hope":

- At browser first-use on Windows, read the runtime version
  (`GetAvailableCoreWebView2BrowserVersionString`, already reachable via the
  `webview2-com` dependency Tauri pulls in on Windows) and **refuse to open a browser tab
  at all** below 101.0.1210.39, with a message naming the required runtime version and a
  link to Microsoft's evergreen installer (opened via `open_external_url`).
- This is the same posture Tabtivity already takes for the Docker sandbox on Windows (TODO O
  #86): *refuse rather than silently do something weaker than the user was promised.*

### 4.6 Credentials: there is no password manager, and there will not be one

- **The browser offers no password saving, no autofill, and no credential storage of any
  kind.** Not off-by-default — absent. The repo's stance is that passwords are not
  persisted by default (`docs/context/remote_credentials.md`); a browser password manager
  is the single largest secret store an app can have, and this one would be built by an
  app whose actual job is running terminals.
- **No `keyring` call is made from any browser code path.** There is one keychain path in
  Tabtivity (`services::remote_credentials`) and the browser does not open a second. §12.2
  asserts `keyring` and `remote_credentials` appear nowhere under the browser modules.
- Because the profile is ephemeral, the engines' own autofill stores have nothing to
  persist to anyway. On Windows, WebView2's general autofill is additionally disabled
  explicitly if Plan C can reach `IsGeneralAutofillEnabled` /
  `IsPasswordAutosaveEnabled`; if it cannot, InPrivate mode already disables password
  autosave, and this is recorded as a **residual to verify**, not as done.
- A site's own "remember me" cookie dies at quit. That is the feature.

---

## 5. Permissions

### 5.1 The default-deny table

| Capability | v1 | Mechanism |
|---|---|---|
| Camera (`getUserMedia` video) | **Deny, no prompt** | §5.2 |
| Microphone (`getUserMedia` audio) | **Deny, no prompt** | §5.2 |
| Screen capture (`getDisplayMedia`) | **Deny, no prompt** | §5.2 |
| Geolocation | **Deny, no prompt** | §5.2 |
| Notifications | **Deny, no prompt** — Tabtivity owns the notification surface (`tauri-plugin-notification`, used for calendar reminders); a browsed page must not be able to raise something the user reads as a Tabtivity alert | §5.2 |
| Clipboard **read** (`navigator.clipboard.readText`) | **Deny** | §5.3 |
| Clipboard **write** on user gesture | Allow (engine default; a copy button must work) | — |
| MIDI (`requestMIDIAccess`) | **Deny** | §5.2 |
| WebUSB / Web Serial / WebHID / Web Bluetooth | **Deny** | not implemented by WebKitGTK or WKWebView at all; on WebView2 they fall under §5.2 |
| Persistent storage / quota | **Deny** (moot — ephemeral) | §4.1 |
| Fullscreen API | **Deny if reachable** | §5.5 — residual |
| Popups / `window.open` | **Deny as an OS window; redirected into a tab** | §5.4 |
| Autoplay with sound | **Cannot be disabled today** | §5.5 — residual |
| Browser extensions | **Deny** — `browser_extensions_enabled(false)` and no `extensions_path` is ever set | §12.2 |
| DevTools | debug builds only (Tauri's default); never in release | §12.2 |
| Drag-and-drop of local files into a page | **Deny** — the window already sets `"dragDropEnabled": false`; do not enable it for the browser | §12.1 |
| Web Speech, WebXR, idle detection, wake lock, sensors | **Deny** (fall under §5.2's blanket) | §5.2 |

### 5.2 The mechanism, per platform, verified

**Linux (WebKitGTK) — deny is the default, and we get it for free.** WebKitGTK's
`WebKitWebView::permission-request` documentation states that if the signal is not
handled, `webkit_permission_request_deny()` is called. `grep -rn "permission" wry-0.55.1/src/webkitgtk/`
returns nothing — wry does not connect the signal. Therefore **every** permission request
on Linux is denied with no prompt, today, with no code from us.

The requirement is therefore a *negative* one, and it is the one that can regress:

> Tabtivity must never call `enable_clipboard_access()` on any webview, and must never
> connect `permission-request`. §12.2 tests both.

**macOS (WKWebView) — deny by omission, structurally.** WKWebView routes media capture
through `WKUIDelegate`'s `webView:requestMediaCapturePermissionForOrigin:…`; wry's
`WryWebViewUIDelegate` does not implement it, so WebKit denies. More importantly, macOS
gates camera/microphone/location at the **process** level on `Info.plist` usage-description
keys. Tabtivity's `tauri.macos.conf.json` declares none, so those APIs are unavailable to the
whole process regardless of what any delegate does.

> **Never add `NSCameraUsageDescription`, `NSMicrophoneUsageDescription`,
> `NSLocationWhenInUseUsageDescription`, `NSLocationAlwaysAndWhenInUseUsageDescription`,
> or `NSBluetoothAlwaysUsageDescription` to any macOS bundle config.** §12.1 tests it.
> This is the strongest single permission control in the plan: it is enforced by the
> operating system, not by us.

**Windows (WebView2) — the gap, and the decision.** Verified: WebView2's
`PermissionRequested` default state is `CoreWebView2PermissionState.Default`, which
**shows WebView2's own permission prompt**. wry registers a `PermissionRequested` handler
**only when `clipboard` is enabled**, and that handler only sets `ALLOW` for
`COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ`
(`wry-0.55.1/src/webview2/mod.rs:497–515`). Everything else falls through to the Edge
prompt.

That is not default-deny. It is default-*ask*, with a dialog Tabtivity did not write, whose
"Allow" grants a browsed page the camera.

**Decision: the in-app browser does not ship on Windows in v1.** The Windows build shows
the browser entry with a disabled state and the message *"The in-app browser is not
available on Windows yet"*, and link clicks route to the external browser via
`open_external_url` — the behaviour Windows users have today. Precedent:
`services::sandbox` is `#[cfg(unix)]` and Windows gets a clear refusal rather than a
silently weaker sandbox (TODO O #86). Same call, same reason.

Re-enabling Windows needs exactly one of: (a) an upstream wry/Tauri passthrough for a
per-permission handler (file the issue when this lands — the API shape is a
`Fn(&Url, PermissionKind) -> PermissionState`), or (b) our own `add_PermissionRequested`
via the `webview2-com` crate already in the Windows dependency set, reaching the raw
`ICoreWebView2` through `Webview::with_webview`. (b) is genuinely feasible and is the
recommended Phase-2 path; it is out of v1 because it is Windows-only unsafe COM code
against a raw pointer, and that deserves its own review, not a paragraph in a browser PR.

### 5.3 Clipboard read

Denied on all platforms by the above. Worth calling out separately because it is the
permission a developer tool is most tempted to grant: a page that can read the clipboard
reads whatever the user last copied, and in this application that is disproportionately
likely to be **a password, an SSH command line, or an API token** — Tabtivity has a
`credential_paste_to_pty` path precisely because credentials move through this app.
Clipboard *write* on a user gesture stays allowed because a "copy" button that does
nothing is a bug report, and write leaks nothing.

### 5.4 Popups and `window.open`

`WebviewBuilder::on_new_window` is supported on all three desktop backends (verified in
wry: `webkitgtk/mod.rs:487`, `webview2/mod.rs:696`, `wkwebview/mod.rs:600`) and returns
`NewWindowResponse::{Allow, Create, Deny}`.

**Policy: always `Deny`, then open the URL as a new tab in Tabtivity's own browser chrome,
through the §3 gate.**

Reasoning: `NewWindowResponse::Allow` produces a **chromeless OS window with no address
bar** — the ideal canvas for painting a fake Tabtivity dialog or a fake bank login. `Create`
would let us supply the window, but a second window shape is a second thing to secure for
no user benefit. Denying and re-opening as a tab means every page the user ever sees is
inside chrome that shows the real origin.

Consequences to handle in Plan A: `window.open(...)` returns `null` to the page, so sites
that drive a popup handle (OAuth popups, print dialogs, payment flows) will break. That is
an accepted, disclosed limitation (§11) with a documented workaround: *Open in your
browser*.

`target="_blank"` and `rel="noopener"` are moot under this policy — there is no window
handle to leak.

### 5.5 The two residuals we cannot close today

**Autoplay.** wry's `WebViewAttributes::autoplay` defaults to `true`
(`wry-0.55.1/src/lib.rs:843`) and **Tauri never sets it** — `autoplay` does not appear in
`tauri-runtime` or `tauri-runtime-wry` at all. So on Linux wry applies
`WebsitePolicies { autoplay: Allow }` and on Windows it passes
`--autoplay-policy=no-user-gesture-required`. There is no Tauri API to turn it off.
Impact: a page can play audio and video the instant it loads. Not a confidentiality
problem; a startle-and-annoyance problem and a small resource one. Mitigations: reader
mode has no media elements at all (they are not in ammonia's tag allowlist); the tab shows
an audio indicator with a mute (Plan A); upstream ask filed for
`WebviewBuilder::autoplay(bool)`. **Disclosed, not fixed.**

**Fullscreen API.** WebKitGTK exposes `WebKitSettings::enable-fullscreen`; wry does not
expose it and Tauri does not either. A page that calls `requestFullscreen()` on a child
webview inside the `main` window could plausibly take the GTK window fullscreen, which is
the classic full-screen phishing setup. Mitigations: Tabtivity already owns `F11` and a
fullscreen toggle, so the state is visible and reversible from a key the page cannot
consume; the child webview is clipped to its rect, which bounds (but does not eliminate)
the effect. **Plan C must verify the actual behaviour on WebKitGTK before v1 ships**; if a
page can genuinely take the whole window, the interim control is to intercept the
resulting Tauri window-resize/fullscreen event and immediately revert it with a
"a page tried to go fullscreen" toast. **Disclosed, verification assigned.**

---

## 6. Downloads

### 6.1 The rule

> **The page chooses the bytes. It never chooses the path.** Every download lands in a
> quarantine directory Tabtivity picked, is inspected there, and reaches the user's
> filesystem only through an OS-native save dialog raised from Rust, one file at a time.

This is the mail client's boundary rule (`docs/mail_client_plan_b.md` §3) with one
difference: mail can refuse to write at all, and a browser cannot — "download" is the
verb. So the browser keeps the dialog and drops the refusal.

### 6.2 The flow

Tauri's `on_download` gives us both ends (`DownloadEvent::Requested { url, destination:
&mut PathBuf }` and `Finished { url, path, success }`), and wry implements it on all three
backends. **wry's default handler is `|_, _| true` — it allows every download to a default
location.** Installing our handler is therefore not an enhancement, it is the difference
between "we control downloads" and "the page does".

```
DownloadEvent::Requested
  ├─ tab must be user-initiated?  NO — see §6.3, we allow and quarantine instead
  ├─ *destination = <state_dir>/browser/quarantine/<uuid>/<safe_name>
  │     safe_name  = sanitize_download_name(url, content_disposition)   [§6.4]
  │     dir        = created 0o700
  └─ return true            (allow — so the engine's session cookies are used)

DownloadEvent::Finished { success: false }  → delete the quarantine dir, toast the failure
DownloadEvent::Finished { success: true }
  ├─ metadata: size cap (2 GB/file, 8 GB/session) → over → delete, refuse
  ├─ chmod 0o600 and CLEAR every execute bit (Unix)          [§6.5]
  ├─ sniff = infer::get(&head[..8192])
  ├─ implied = mime_guess::from_path(safe_name)
  ├─ classify → Ok | TypeMismatch | IsAProgram                [§6.6]
  ├─ raise the NATIVE save dialog from Rust (DialogExt → oneshot, never blocking_*)
  │     defaultPath = safe_name, starting dir = the OS downloads dir
  ├─ user cancels → delete the quarantine file, nothing was written
  └─ user confirms → move (fs::rename, falling back to copy+remove across devices)
```

Every step of that lives in `src-tauri/src/commands/browser.rs` and
`src-tauri/src/services/browser_download.rs`.

### 6.3 Why quarantine-then-dialog rather than deny-then-refetch

The obvious alternative is to return `false` (deny), then have the backend fetch the URL
itself with `reqwest` and stage it. **Rejected**: the download is very often
session-authenticated — a file behind a login, a signed URL with a short TTL, a POST
result. The backend has no cookies (§4.1's ephemeral store belongs to the engine), so a
refetch would 403 on exactly the downloads people actually want. Letting the engine
complete the transfer into a directory we chose keeps the session and keeps the boundary.

The cost is that bytes touch the disk before the user consents. That is why quarantine is
`0700`, mode-`0600`, non-executable, swept at startup, and outside every project tree —
and why nothing ever *opens* a quarantined file (§6.7).

### 6.4 `sanitize_download_name()`

The filename source is attacker-controlled twice over: the URL path and the
`Content-Disposition` header. The mail client already has the exact function for this —
`sanitize_attachment_name()` in `services::mail_sanitize`, with 13 enumerated rules
(path-component splitting on `/` and `\`, C0/C1 stripping, the bidi-control set that kills
`invoice\u{202E}gnp.exe`, Windows reserved device names, trailing dots/spaces, leading `-`
and `.`, NFC, 200-byte extension-preserving truncation).

**Do not write a second one.** The work is:

1. Move `sanitize_attachment_name` (and `link_info`, `registrable`, `idna_display`,
   `host_of`, `scheme_of`) out of `services::mail_sanitize` into a new
   `services::web_safety`, re-exported from `mail_sanitize` so mail's call sites and its
   entire existing test table are untouched.
2. The browser calls `web_safety::sanitize_attachment_name`.
3. `registrable()` — currently a documented two-label approximation — is upgraded to use
   `psl`, which retroactively improves the mail client's phishing detection. Mail's
   `SANITIZER_VERSION` must be bumped in the same commit (its doc comment already says
   any change to that pipeline requires it).

A browser-specific pre-step before calling it: derive the name from
`Content-Disposition`'s `filename*`/`filename` when present, else the URL's last path
segment percent-decoded, else `download`; and **if the result has no extension, do not
invent one** — an extensionless file is harmless, a guessed `.exe` is not.

### 6.5 Executable bits and the exec class

- On Unix, the quarantined file is created/`set_permissions`'d to `0o600`. Any execute bit
  the engine set is cleared. After the move to the user's chosen path, the mode is
  **not** re-applied — the file inherits the user's umask like any other saved file, but
  it never *gains* `+x` from us.
- The move never follows a symlink at the destination and never creates directories.
- On macOS the quarantine attribute (`com.apple.quarantine`) that the OS sets on
  browser downloads is **not** something we can set from Rust portably; note it as a
  residual — a file saved through Tabtivity may not carry Gatekeeper's quarantine bit that
  the same file downloaded through Safari would. Phase-2 fix: set the xattr explicitly.
  **Disclosed.**
- **`Finished` on macOS always reports `path: None`** (Tauri documents this as an API
  limitation). So the destination must be tracked by us, keyed by the URL we assigned it
  to at `Requested` time, in a `Mutex<HashMap<Url, PathBuf>>` — never read back from the
  event.

### 6.6 MIME/extension mismatch, and the one loud case

Three signals, exactly as mail does it: **declared** (`Content-Type` from the response,
when the engine gives it to us — Plan C to confirm; if unavailable, two signals),
**sniffed** (`infer` over the first 8 KB), **implied** (`mime_guess` from the sanitized
name).

The save dialog is preceded by a banner in the download row when:

- sniffed ≠ implied at the top-level type — *"This file is named `.pdf` but its contents
  are a `<sniffed>` file."*
- the name has a double extension whose last component is in mail's executable deny-list
  (`exe com scr pif bat cmd msi msp cpl hta js jse vbs vbe wsf wsh ps1 psm1 sh bash zsh
  jar apk app dmg pkg lnk url scf reg inf desktop appref-ms library-ms gadget chm msc ade
  adp mde mdb`) — *"`invoice.pdf.exe` is a program, not a document."*
- **sniffing finds an executable format at all** — `MZ`, `\x7fELF`, Mach-O magics, `#!` at
  offset 0, a `PK` zip containing `META-INF/MANIFEST.MF` — regardless of name or
  declaration. This gets its own persistent, non-dismissible red banner: **"This download
  is a program."**

Unlike mail, a program download is **not refused** — people download installers, and a
browser that cannot is broken. It is labelled, quarantined non-executable, and saved only
through the dialog. The difference from mail is deliberate and is exactly the "where a
browser cannot be as strict" honesty this plan owes.

### 6.7 What downloads never do

- **Never auto-open.** There is no "open when done". The download row's actions are
  *Save…*, *Show in folder* (only after a save, and only on the folder the user chose),
  and *Delete*. There is no verb that hands a downloaded path to `opener::open`.
- **Never write into a project directory automatically.** #60's rationale generalizes: a
  file routed into a project tree can be `git add -A`'d and pushed. The save dialog's
  starting directory is the OS downloads dir, never the active project. If the user
  navigates the dialog into a project, that is their explicit choice, made in an OS dialog.
- **No "save all", no directory target, no drag-out** in v1. `tauri-plugin-drag` exists in
  the tree and wiring it to downloads would be a silent multi-file export path.
- **Never extract an archive.** A downloaded `.zip` is a file. If the user later extracts
  it through the file tree, that goes through `commands::fs::extract_archive` — which the
  mail plan §3.6 already flagged as missing an expansion-ratio cap. That hardening is a
  shared prerequisite; this plan restates it rather than duplicating it.
- **No download is initiated without a page action.** A page can absolutely trigger a
  download without a click (`<a download>` + `.click()`, `Content-Disposition` on
  navigation) — that is the drive-by case, and the answer is not to detect the click, it
  is that the drive-by lands in quarantine and dies there unless the user opens a dialog
  and saves it.

---

## 7. Phishing, link safety, and the address bar

### 7.1 The address bar is a security control, not a text field

Rendered by Tabtivity's own React, in the app webview, **never** by anything the page can
touch. Rules:

1. **The origin is emphasized and everything else is de-emphasized.** Layout:
   `scheme-dim ‖ subdomains-dim ‖ **registrable-domain-bold** ‖ :port-dim ‖ path/query-dim`.
   The registrable domain comes from `psl` (§1.2), because the two-label approximation
   bolds `co.uk` for `shop.example.co.uk`, which is worse than not bolding at all.
2. **Never ellipsis-truncate the host.** Long paths may be elided from the *right*; the
   scheme, userinfo indicator, host, and port are always shown in full. If the host does
   not fit, it wraps or the bar scrolls — it does not shorten.
3. **Userinfo is stripped from the displayed URL and flagged.**
   `https://example.com@evil.example/` displays as `evil.example` with a warning chip
   *"This link tried to look like example.com"*. The `url` crate parses this correctly;
   the display must not re-derive the host by string search.
4. **Punycode reveal.** If any label of the ASCII host starts with `xn--`, the bar shows
   the **Unicode** form with the **ASCII** form immediately beside it in monospace, labelled
   *"actual domain"*. Never the Unicode form alone. `idna::domain_to_unicode` is already in
   the tree (used by `mail_sanitize::idna_display`); use the same helper after the move
   in §6.4.
5. **Mixed-script warning.** `unicode-security`'s UTS-39 mixed-script check on the
   *Unicode* host: Latin mixed with Cyrillic/Greek/Armenian gets an amber chip *"This
   address mixes alphabets"* and the bar switches to ASCII-only display until dismissed.
   Advisory, never a block — a legitimately non-Latin domain is not an attack.
6. **A bare IP host** is shown as-is with an *"IP address"* chip; a *decimal* or *octal* or
   *hex* IP literal (`http://2130706433/`) is **normalized to dotted-quad for display**
   and flagged, because those forms exist for exactly one reason.
7. **The TLS state is a word, not only an icon.** `Secure` / `Not secure` / `Certificate
   problem`, with the host. Icons alone are a solved failure — users do not read them.
8. **The address bar never shows the page's `document.title` in place of the URL**, and
   the tab title is always rendered as plain text with bidi and format controls stripped
   (`stripFormatControls` already exists in `src/lib/mail.ts` — reuse it). A tab titled
   `example.com — Secure  ⁧` is a real technique.

### 7.2 Reusing mail's link machinery

`services::mail_sanitize::link_info()` already produces exactly the record the browser
needs: `href`, `display_host`, `mismatch`, `scheme_warning`, with userinfo detection and
`registrable()` comparison. After the §6.4 move it becomes
`services::web_safety::link_info()` and both features share one implementation, one test
table, and one set of bugs.

The browser adds one field mail does not need: `punycode_ascii: Option<String>`, the
`xn--` form when the host has one, so the address bar's rule 4 does not have to re-derive
it in TypeScript.

### 7.3 Where the phishing check *cannot* run

Mail can strip every `href` and route all clicking through a confirm dialog, because a
mail body is a document. A browser cannot: clicking links **is** browsing. So:

- **In-page link clicks are not confirmed.** Confirming every click trains the click.
- The compensating control is the address bar after the fact, plus the §3 gate for
  schemes, plus a **hover/status readout** in the browser chrome that shows the resolved
  target of the hovered link with the same origin-emphasis rules — which is where a
  display-text-vs-href mismatch actually becomes visible to a user.
- The **one** place a confirm is warranted is a link that leaves the app entirely
  (§3.6's *Open in your browser*) and a link with a non-`http(s)` scheme that would reach
  an OS handler (§3.2's `mailto:`/`webcal:` row). Both are rare, both are consequential,
  both get the mail client's `LinkConfirmDialog` treatment: full URL, no ellipsis, host on
  its own line, Cancel focused.

Residual risk: **a user can be phished by a page that looks like a login form.** No
in-app browser defence stops that, and this plan does not claim one. What it does claim
is that the address bar tells the truth, that the page has no credential store to
auto-fill, and that the session dies at quit.

### 7.4 Certificates: no escape hatch, and why it is structural

**There is no "proceed anyway", no "add exception", no "ignore certificate errors"
control in Tabtivity's browser. Not hidden, not behind a setting, not behind a dev flag.**

This is enforceable rather than aspirational, exactly as in the mail client, and for the
same reason: the engines validate against the **OS trust store**. A user with an internal
CA installs it **once, in their operating system**, through the mechanism their OS already
has — and every application including this one then trusts it. Removing the escape hatch
does not remove the capability; it moves it to the layer that can audit and revoke it.

Mechanically, on Linux the override would have to be one of
`webkit_web_context_allow_tls_certificate_for_host()` or
`WebContext::set_tls_errors_policy(TLSErrorsPolicy::Ignore)`. wry calls neither, so an
unhandled `load-failed-with-tls-errors` fails the load. **§12.2 asserts those two strings,
plus `danger_accept_invalid`, `ServerCertVerifier`, and `NoCertificateVerification`, appear
nowhere under the browser modules.** A future "just add a checkbox" becomes a failing
test rather than a code-review argument.

Error presentation matters here for the same reason it matters in mail — vague errors are
what create pressure for override buttons. The blocked page names the specific failure:
hostname mismatch (naming both names), unknown issuer (with the *"install the CA in your
operating system"* instruction), expired (with the date), revoked (*"do not enter your
password"*).

On Windows, WebView2 shows **its own** SSL interstitial when
`ServerCertificateErrorDetected` is unhandled, and that interstitial may offer a continue
path we do not control. This is a second, independent reason for §5.2's "no browser on
Windows in v1".

---

## 8. What arbitrary JS execution actually means

### 8.1 The honest list of what is not defensible

Once a page's JS runs, the following are **not preventable** by anything in this plan, and
the plan does not pretend otherwise:

| Not defensible | Note |
|---|---|
| Reading and exfiltrating everything on its own origin | that is the web |
| Fingerprinting the machine — GPU (WebGL is on: `set_enable_webgl(true)` in wry), fonts, canvas, timing, screen metrics | ephemeral storage stops *linking* sessions, not fingerprinting one |
| `fetch()`/`XHR`/`WebSocket` to any host the machine can reach, including loopback and RFC 1918 (`on_navigation` does not see subresources — §3.1) | §9 |
| Burning CPU/memory/battery: cryptomining, a `while(1)`, a 100k-node DOM | §8.2 |
| Exploiting a bug **in the rendering engine itself** — a WebKitGTK or WebView2 RCE | §8.4 |
| Social engineering: a convincing fake login, a fake system dialog drawn in the page | §7.3 |
| Playing audio/video on load | §5.5 |

### 8.2 The Linux-specific one: the page shares Tabtivity's main loop

This is not a generic browser concern, it is a Tabtivity concern and it is already documented
in the mail plan (§2.8): **WebKitGTK renders on the same GTK main loop as Tabtivity's UI.** A
page with a pathological DOM or a spinning script can jank the whole window — the same
class of failure the mail sanitizer's 20 000-element cap exists to prevent, except here
the content is a live document we cannot cap.

Controls:
- A per-tab **responsiveness watchdog**: the backend pings the browser webview
  (`eval` of a trivial expression, or `on_page_load` timing) and, if the tab is
  unresponsive past a threshold, surfaces *"This page has stopped responding"* with
  **Close tab** / **Wait** — the browser-standard affordance, which exists precisely
  because this is unfixable.
- Browser tabs are **destroyed, not hidden**, when their tab group closes; a background
  webview still runs script.
- **Only one browser webview may exist at a time in v1** — additional browser tabs
  reuse it by navigation, or are lazily created on activation and destroyed on
  deactivation (Plan A's choice). N live engine instances on the GTK loop is N times this
  risk for no benefit.

### 8.3 Reader mode — the script-less path, reusing mail verbatim

**Reader mode is not a fallback. It is a first-class mode that exists from day one**,
because it is also fallback F1 (§2.5) and because it is the right default for a URL the
user did not type.

```
User/agent/mail hands Tabtivity a URL
  └─ backend fetch (reqwest, rustls, OS trust store, no cookies, no Referer,
     fixed generic UA, 15 s timeout, 8 MB cap, ≤3 redirects, is_public_http_url()
     re-checked at every hop — §9.3)
      └─ decode to UTF-8 (charset from Content-Type, then <meta>, never renderer sniffing)
          └─ ammonia, THE SAME BUILDER the mail client uses
              → no href survives, no remote URL attribute survives, script/style
                removed with contents, CSS property allowlist
              └─ SanitizedBody { html, links, blocked_remote }
                  └─ IPC ───────── the boundary ─────────
                      └─ <iframe sandbox="" srcDoc=…> with the mail CSP
                         (default-src 'none'; img-src data:; script-src 'none'; sandbox)
```

Every property the mail client proved applies unchanged: the unsanitized bytes never exist
in the webview process, no script can run because the *sandbox* forbids it rather than the
sanitizer, links are `data-lid` markers resolved against a backend table, and
`bodyLooksUnsafe` (`src/lib/mail.ts`, tested by `src/__tests__/MailTripwire.test.ts`)
already exists as the render-time tripwire.

Deliberate limitations, stated in the mode's own banner: no images from the network
(the app CSP has no `https:` in any fetch directive and **must not gain one** — the mail
plan's backend-proxy pattern is the only way remote images ever load), no CSS from the
network, no interactivity, no login, no forms. It renders articles, documentation and
READMEs, and it is useless for a web app.

### 8.4 The no-script middle mode

`WebviewBuilder::disable_javascript()` exists in Tauri 2.11.3
(`src/webview/mod.rs:1158` → `webview_attributes.javascript_disabled` →
`settings.set_enable_javascript(false)` on WebKitGTK). It gives the **real engine** with
**no JS**: real CSS, real layout, real images, real fonts — and no script execution, so
§8.1's entire first column collapses to "reading its own origin".

It is set at webview creation, so switching modes recreates the webview and reloads. That
is fine; it is a deliberate, infrequent action.

### 8.5 The recommendation

**Ship all three, per tab, with the default chosen by where the URL came from.**

| URL origin | Default mode | Reason |
|---|---|---|
| Typed or pasted into the address bar by the user | **Full** | the user asked for a browser |
| Clicked inside an already-Full tab | **Full** | mode is sticky within a browsing session |
| A link from a **mail message**, from terminal output, from an agent's response, from a file the user is viewing | **Reader** | this is untrusted content choosing a destination — exactly the mail client's threat, so it gets the mail client's answer |
| The Tabtivity UI's own links (docs, release notes) | **Reader** | they are articles |

The mode is shown as a segmented control in the address bar (`Reader · No script · Full`),
switching is one click and one reload, and the current mode is *always* visible — a
security mode the user cannot see the state of is not a security mode.

Why not reader-only for v1: it is not a browser, and TODO J #61 asks for a browser
(and #53 asks to drag a tab into a *browser upload field*, which reader mode cannot have).
Why not full-only: the highest-risk navigations in this app are the ones that arrive from
content Tabtivity already treats as hostile, and for those we already own a proven renderer.
Shipping both costs one backend fetch path we need for F1 anyway.

### 8.6 Engine RCE — the threat with no in-app answer

A memory-safety bug in WebKitGTK or WebView2 gives an attacker code execution in the
**renderer process**, and from there Tabtivity's process boundary is whatever the engine's
own sandbox provides — which on WebKitGTK is a real bubblewrap sandbox and on WebView2 is
the browser sandbox, in both cases outside our control.

What this plan does about it:

- **Nothing pretends otherwise.** §11 lists it.
- The engine version is the OS's or the runtime's, which means it is patched by the
  channel the user already trusts for their real browser. This is an argument *for* using
  the platform webview and *against* bundling one.
- The `deb` bundle already depends on `libwebkit2gtk-4.1-0`; the browser feature adds a
  runtime check that logs the WebKitGTK version at first browser use so a bug report
  carries it.
- **Should the browser run inside the existing Docker sandbox (`services::sandbox`)?**
  **No.** Assessed and rejected: that machinery bind-mounts the *project directory at its
  identical absolute path* and exists to contain **agent processes writing project
  files**. A webview is not a process we spawn — it is a view composited into our own
  window by our own process. Containerizing it would require an entirely different
  mechanism (a separate process with its own display connection), the container mounts
  would be exactly wrong for it (it needs no project bytes at all), and it is Unix-only
  and hidden on Windows. The browser's isolation story is §2 and §4, not §sandbox.
  Recorded here because "why not just use the sandbox we already have" is the first
  question a reviewer will ask.

---

## 9. Egress: the VPN and SSH pivot

### 9.1 The situation

Tabtivity is not an ordinary app on the network. At any moment it may hold: an OpenVPN tunnel
that, per `docs/context/openvpn.md`, is **machine-wide and elevated**, passes no routing
flags, and so *"a config that pushes `redirect-gateway` reroutes the whole computer's
traffic — browser included"* including DNS; one or more SSH ControlMaster sessions to
remote hosts, possibly including HPC login nodes; and shells running inside those.

A page that can drive requests from inside this process is therefore a pivot into networks
the user's real browser cannot see.

### 9.2 The decision on the tunnel

**Browser traffic traverses an active tunnel, exactly like every other process on the
machine, and Tabtivity does not try to change that.**

Rejected alternatives and why:

- **Bypass the tunnel with `proxy_url`.** Setting a per-webview proxy to route browser
  traffic around a VPN would be a *split tunnel Tabtivity invented*, silently contradicting
  what the user's `.ovpn` asked for and what the header's VPN indicator says. Worse, it is
  a leak: a user who turned on a VPN to browse safely would be browsing outside it because
  of a security feature. TODO #82 tracks split tunnelling as a deliberate, user-visible
  design — not something a browser tab decides.
- **Refuse to browse while a tunnel is up.** Absurd; browsing through a VPN is a normal
  reason to have a VPN.

**What the user is told**, because "the app does what the OS does" is only acceptable if
it is visible:

- The address bar carries a **VPN chip** whenever `src/stores/remote/vpn/vpnStatus.ts` reports an
  active tunnel, naming the config, and clicking it opens the header's VPN menu. Present
  on every browser tab, not dismissible.
- The **first** browser tab opened while a tunnel is up shows a one-line notice:
  *"A VPN tunnel is active. Pages you open here go through it, like every other program on
  this computer."* Once per session, not per tab.
- When a tunnel comes up **while** a browser tab is open, the chip appears and a toast
  says so — the routing of an already-loaded page just changed, and that is worth a line.

### 9.3 The intranet gate

The tunnel is not the sharp edge; **loopback and RFC 1918 are**. A hostile page in this
app can reach: Tabtivity's own dev server on `127.0.0.1:1420` (which, per §2.1 Fact 3, is a
*local origin* in dev builds), any dev server a project tab is running, an Ollama endpoint
on `11434`, a Docker API if the user exposed one on TCP, a printer, a router admin page,
and — through an active tunnel — the entire remote network the tunnel joined.

**Rule: top-level navigation to a non-globally-routable address requires a per-host,
per-session confirmation.**

```rust
// services/browser_policy.rs — pure, table-tested (§12.3)
pub fn is_globally_routable(host: &Host) -> bool
```

Reject (i.e. require confirmation for) loopback `127.0.0.0/8` and `::1`, link-local
`169.254.0.0/16` and `fe80::/10`, private `10/8` `172.16/12` `192.168/16` `fc00::/7`,
CGNAT `100.64/10`, multicast, broadcast, unspecified `0.0.0.0`/`::`, IPv4-mapped IPv6
forms of any of the above (`::ffff:127.0.0.1`), and the literal hostnames `localhost` and
anything under `.localhost`, `.local`, `.internal`, `.home.arpa`. Decimal/octal/hex IPv4
literals are normalized before the check (`http://2130706433/` is `127.0.0.1`). `ipnet`
does the range arithmetic; `std::net::IpAddr::is_global()` is still unstable.

Confirmation UX: the §3.5 block page with an **Open anyway, once** button, naming the
resolved address in words (*"This is an address on your own computer"* / *"…on your local
network"* / *"…on the network your VPN tunnel joined"*). The grant is keyed by
`(host, port)`, lives in memory only, and is cleared on tab close, on VPN state change,
and on any cross-origin redirect.

**Deliberately allowed without confirmation:** nothing. Not `localhost:3000`, not the
project's own dev server. A developer browsing their own dev server will confirm once per
session, and that is a fair price for the one place this app is genuinely different from
a normal browser.

**The honest residual:** `on_navigation` does not fire for subresources (§3.1, verified in
wry's `decide-policy` handler, which only acts on `PolicyDecisionType::NavigationAction`).
So a page loaded from `https://example.com` **can** `fetch("http://127.0.0.1:11434/")`
and port-scan the machine. Nothing in this plan stops that, and no in-app browser can
without an engine-level request filter Tauri does not expose. What bounds it:

- Tabtivity's own IPC is **not** HTTP-reachable — `http://ipc.localhost` is a WebView-internal
  custom-protocol origin, not a listening socket, so a scanner finds no Tabtivity port to
  talk to;
- the ephemeral profile means a scanner's findings cannot be persisted or correlated across
  sessions;
- CORS still applies to reading responses (though not to *sending* requests, which is
  enough for CSRF against a badly-built local service);
- the intranet **navigation** gate at least prevents the far more dangerous case: the page
  *becoming* a local origin.

This is written down rather than glossed because it is the single largest gap between
what this plan can promise and what "the browser is sandboxed" would imply. Upstream ask:
a wry/Tauri resource-request filter hook. Until then: **disclosed**.

### 9.4 SSH

**There is no "browse through this host" feature, and there must not be one in v1.** No
`ssh -D` dynamic SOCKS forward is ever created for the browser, and `proxy_url` is never
pointed at one. Reasons: it would give a page the network identity of a machine the user
has privileged access to (often a cluster login node — see `docs/context/hpc_careful_mode.md`
for how carefully this app already treats those); the SOCKS port would be reachable by any
local process, not only the browser; and per `docs/context/multi_host_remote.md` the remote
side is deliberately push-only and read-only, a posture a browsing pivot inverts.

What a later phase would need if this is ever wanted: a per-tab (not per-app) proxy bound
to `127.0.0.1` with a random port and a per-session credential, an explicit indicator in
the address bar naming the host every request goes through, an HPC-tag check that refuses
it on a cluster login node outright, and a design pass on what it means for the block page
in §3.5 (a "private" address is now private *on the remote side*).

---

## 10. Rejected designs

| Rejected | Why |
|---|---|
| **Grant the browser webview a narrow `remote` capability** (e.g. just `core:event:allow-emit`) so the page can talk to Tabtivity's chrome | This is the one line that undoes the entire plan. A `remote` entry is matched by URL pattern, patterns get widened, and "just events" is a message channel into privileged code. Everything the browser chrome needs — title changes, navigation state, downloads — is available to the **backend** via `on_page_load` / `on_document_title_changed` / `on_navigation` / `on_download` and is relayed to the app webview as a Tauri event. The page is never a party to it. §12.1 fails the build if a `remote` key appears. |
| **Persistent profiles in v1** | Persistence is what turns "a page ran some JS" into "a page has a foothold". It also creates a directory full of session cookies inside `~/.local/share/tabtivity/`, which changes the privacy-check story, the backup story, and the "delete my data" story all at once. Ephemeral first; persistence when there is a concrete need and a design for clearing it. |
| **A built-in password manager or autofill** | §4.6. The repo's stance is no password persistence by default; the largest possible secret store is not the place to make an exception. |
| **Per-project cookie partitioning** | Solves a problem ephemeral already solves, and introduces a mapping (project ↔ identity) that breaks on rename and confuses on switch. §4.2. |
| **DOMPurify (or any second sanitizer) for reader mode** | The mail plan rejected it for the same three reasons and they all still hold: the raw bytes would exist inside the app origin; two parsers with different serializers is a known mXSS source; and the repo has a documented no-DOMPurify convention in four places. Reader mode uses the shipped `ammonia` config, unchanged. |
| **Running the browser inside `services::sandbox` (Docker)** | §8.6. Wrong mechanism for a composited view, wrong mounts, Unix-only. |
| **Tauri's Isolation Pattern (`app.security.pattern`)** | It hardens the *app's own frontend* against a compromised app frontend by routing IPC through a sandboxed iframe. It does nothing about a separate webview on a remote origin, which is this plan's actual threat, and it adds a build-time asset pipeline and a second CSP to reason about. Revisit only if Tabtivity's own frontend ever loads third-party JS, which it should not. |
| **`NewWindowResponse::Allow` for popups** | A chromeless OS window with no address bar. §5.4. |
| **Bypassing an active VPN with `proxy_url`** | A split tunnel the user did not ask for, contradicting the header indicator. §9.2. |
| **Browsing through an SSH dynamic forward** | §9.4. |
| **A "trusted sites" list that relaxes any of §3, §5, or §9** | Every such list is a list of origins an attacker wants to be on, and the relaxation always outlives the reason for it. The only per-host state in this plan is §9.3's in-memory, single-session, single-host grant. |
| **Shipping the browser on Windows in v1** | §5.2: WebView2's default is to *prompt* for camera/microphone/geolocation with a dialog Tabtivity did not write, and its TLS interstitial may offer a continue path we do not control. Refuse, as `services::sandbox` already refuses. |
| **An "ignore certificate errors" setting, in any form** | §7.4. Enforced by a source-scanning test, not by convention. |
| **Bundling a browser engine** (Chromium/Servo/Ladybird) | A 100+ MB bundle whose security updates become Tabtivity's responsibility. The platform webview is patched by the OS. |
| **`enable_clipboard_access()` on the browser webview** | It is the one call that installs an *allow* handler for `CLIPBOARD_READ` on Windows (verified in wry). §5.3. |
| **Browser extensions** (`browser_extensions_enabled`, `extensions_path`) | An extension in this webview would run with the page's privileges *and* whatever the extension API grants, in a process that also hosts Tabtivity's window. No. |

---

## 11. What this browser deliberately cannot do

Written for the user-facing docs as much as for reviewers. Each line is a *design output*,
not a missing feature.

1. **It cannot keep you logged in.** The profile is ephemeral; quitting Tabtivity signs you
   out of everything. Use *Open in your browser* for anything you want to stay signed
   into.
2. **It cannot save passwords, and it will never offer to.**
3. **It cannot open pop-up windows.** `window.open` returns `null`; the URL becomes a new
   tab. OAuth popups, some payment flows, and some print dialogs will not work.
4. **It cannot use your camera, microphone, screen, or location** — those are denied
   without a prompt, and on macOS they are unavailable to the whole process by
   construction.
5. **It cannot read your clipboard.**
6. **It cannot install extensions.**
7. **It cannot open `file://` URLs**, view local files, or be pointed at your disk.
8. **It cannot be told to ignore a certificate error.** If your organization runs a private
   CA, install it in your operating system's trust store and this browser — and every other
   program — will trust it.
9. **It cannot save a download without asking you where.** Every download goes through a
   native save dialog, one file at a time, and nothing is written anywhere else.
10. **It cannot download something and then run it.** There is no "open when done".
11. **It cannot reach a local or private network address without you confirming that
    specific address**, once per session.
12. **It cannot see or change any other browser's settings, bookmarks, cookies, or
    download folder**, and it never looks for them.
13. **It cannot leave a VPN tunnel.** While a tunnel is up, pages here go through it, like
    everything else on the computer.
14. **It cannot run on Windows in v1.**
15. **It cannot protect you from a phishing page that you type your password into.** It
    can only tell you truthfully what site you are on.
16. **It cannot protect you from a bug in the operating system's web engine.** Keep your
    system updated; that is the same protection your normal browser has.
17. **Reader mode cannot log in, submit a form, run an app, or load images from the
    network.** It renders text.

---

## 12. Tripwire tests

The rule, borrowed from the mail client: **every defence in this document has a test that
fails if someone deletes it.** Rust tests run under
`cargo test --manifest-path src-tauri/Cargo.toml`; TS tests under `npm test` (vitest,
already configured). The two acceptance gates are `npx tsc --noEmit` and `cargo test`.

New files: `src-tauri/src/services/browser_policy.rs` (tests inline),
`src/__tests__/BrowserTripwire.test.ts`.

### 12.1 Configuration tripwires — `browser_policy::tests` + vitest

Cheap file reads that turn "don't configure X" into a red build.

1. **`capabilities/*.json` contain no `remote` key.** Parse every file in
   `src-tauri/capabilities/` as JSON; assert no capability object has `remote`. Failure
   message: *"A `remote` capability hands a browsed page the Tauri IPC bridge. See
   docs/browser_plan_b.md §2.2 BC-2."*
2. **`default.json` has no `windows` key and its `webviews` list does not match
   `browser-…`.** Assert `webviews` is present, `windows` is absent, and for the literal
   label `browser-0` no pattern in `webviews` matches (glob-match with the same semantics
   Tauri uses). BC-1 and BC-3.
3. **No capability sets `"local": false`.**
4. **`tauri.conf.json`**: `app.withGlobalTauri` is absent or `false`; `app.security.pattern`
   is absent; `app.windows[0].dragDropEnabled` is `false`; `app.security.csp` contains
   **no** `https:` in any fetch directive (reader mode must never be "fixed" by relaxing
   the app CSP — §8.3); `app.security.assetProtocol` is absent or disabled;
   `dangerousDisableAssetCspModification` is absent. BC-6.
5. **macOS bundle config declares no capture usage descriptions.** Read
   `src-tauri/tauri.macos.conf.json` (and any `Info.plist` template) as text; assert it
   contains none of `NSCameraUsageDescription`, `NSMicrophoneUsageDescription`,
   `NSLocationWhenInUseUsageDescription`, `NSLocationAlwaysAndWhenInUseUsageDescription`,
   `NSBluetoothAlwaysUsageDescription`, `NSScreenCaptureDescription`. §5.2.
6. **The `tauri` dependency's `unstable` feature and the `add_child` route are consistent:**
   if `Cargo.toml` enables `unstable`, assert the browser module exists and BC-1's test
   passes; the point is that enabling `unstable` cannot land without this file's tests
   being present.

### 12.2 Source-scan tripwires — `browser_policy::tests`

Read every `.rs` under `src-tauri/src/commands/browser.rs`,
`src-tauri/src/services/browser_*.rs`, and every `.tsx`/`.ts` under
`src/components/browser/`, and assert:

1. **No certificate escape hatch** — none of `allow_tls_certificate_for_host`,
   `set_tls_errors_policy`, `TLSErrorsPolicy`, `danger_accept_invalid`,
   `ServerCertVerifier`, `with_custom_certificate_verifier`, `NoCertificateVerification`.
   §7.4.
2. **No clipboard-read grant** — `enable_clipboard_access` appears nowhere in the whole
   backend (this one scans all of `src-tauri/src`, not only browser files). §5.3.
3. **No permission handler that allows** — `permission-request`, `connect_permission_request`,
   `add_PermissionRequested`, `COREWEBVIEW2_PERMISSION_STATE_ALLOW` appear nowhere.
   Deny-by-default is achieved by *not* handling; a handler is how it regresses. §5.2.
4. **No extensions** — `browser_extensions_enabled(true)` and `extensions_path` appear
   nowhere.
5. **No custom URI scheme protocol** — `register_uri_scheme_protocol` and
   `register_asynchronous_uri_scheme_protocol` appear nowhere in `src-tauri/src`. BC-4,
   because every registered scheme is a *local* origin (§2.1 Fact 3).
6. **No `ipc::Channel`** — `tauri::ipc::Channel` / `ipc::Channel<` appear nowhere in
   `src-tauri/src`, with the §2.4 failure message.
7. **No second keychain path** — `keyring::` and `remote_credentials` appear nowhere under
   the browser modules. §4.6.
8. **No foreign browser profile access** — the whole backend contains none of `prefs.js`,
   `.mozilla`, `google-chrome/Default`, `chromium/Default`, `Preferences"` in a path
   context, `Library/Safari`, `browser.download.dir`. This re-arms TODO O #60's deletion.
   §4.4.
9. **No command takes a path** — the browser's `#[tauri::command]` argument names are
   scanned against the same `RESERVED` list `commands::mail::tests::no_command_takes_a_path`
   uses (`path`, `dest`, `dir`, `file`, `filename`, `glob`, `cwd`, `root`, `target`,
   `location`, …), with **one deliberate exception**: `url`, which the browser's
   `browser_navigate` must take. That exception is spelled out in the test with a comment
   explaining that `url` is safe here only because it is passed to
   `browser_policy::navigation_allowed` before anything else touches it.
10. **`disable_javascript` is reachable** — assert the string `disable_javascript` appears
    in the browser spawn path, so the no-script mode cannot be quietly deleted (§8.4).
11. **`on_download` is installed** — assert `on_download` appears in the browser spawn
    path, with the message *"wry's default download handler allows every download to a
    path the page chose. See §6.2."*
12. **`on_new_window` is installed and returns `Deny`** — assert both `on_new_window` and
    `NewWindowResponse::Deny` appear. §5.4.
13. **`incognito(true)` is set** — assert the literal appears. §4.1.

### 12.3 `navigation_allowed()` — the table

One `#[test] fn navigation_table()` over `&[(url, expected)]`. Blocked unless noted.

**Schemes:** `file:///etc/passwd`, `file://server/share/x`, `tauri://localhost/`,
`https://tauri.localhost/`, `javascript:alert(1)`, `JaVaScRiPt:alert(1)` (case),
`java\tscript:alert(1)` (embedded tab), `data:text/html,<script>alert(1)</script>`,
`blob:https://example.com/uuid`, `ws://example.com/`, `ftp://example.com/`,
`smb://host/share`, `vbscript:msgbox`, `ms-msdt:/id`, `search-ms:query=x`,
`chrome://settings`, `moz-extension://x/y`, `about:config`, `about:cache`,
`view-source:https://example.com/`, `jar:https://example.com/a.jar!/b`,
`intent://x#Intent;end`, and a scheme that does not exist (`tabtivity-nonsense://x`).
**Allowed:** `https://example.com/`, `http://example.com/`, `about:blank`,
`about:srcdoc`.

**App-origin (BC-5), asserted in both `cfg(debug_assertions)` and release paths:**
`http://localhost:1420/`, `http://localhost:1420/index.html`, `http://127.0.0.1:1420/`,
`https://tauri.localhost/index.html`, `tauri://localhost/assets/x.js`. All blocked.
Positive control: `http://localhost:8080/` is **not** blocked by *this* rule (it is
`Confirm` under the intranet rule below, not `Block`) — proving the app-origin rule is
about the origin, not about localhost generally.

**Userinfo:** `https://example.com@evil.example/` → allowed to navigate, but the returned
decision carries `NavFlags::USERINFO` and the parsed host is `evil.example`. A test asserts
the *host*, because a string-search implementation would say `example.com`.

**Intranet (`is_globally_routable`, §9.3) → `Confirm`:** `http://127.0.0.1/`,
`http://localhost/`, `http://[::1]/`, `http://169.254.169.254/latest/meta-data/`,
`http://10.1.2.3/`, `http://172.16.0.1/`, `http://172.31.255.255/`, `http://192.168.1.1/`,
`http://100.64.0.1/`, `http://[fc00::1]/`, `http://[fe80::1]/`, `http://0.0.0.0/`,
`http://[::ffff:127.0.0.1]/`, `http://2130706433/`, `http://0x7f000001/`,
`http://017700000001/`, `http://router.local/`, `http://box.internal/`,
`http://x.home.arpa/`, `http://svc.localhost/`.
**→ `Allow`:** `https://example.com/`, `http://93.184.216.34/` (globally routable
documentation address), `http://172.32.0.1/` (just outside `172.16/12` — the classic
off-by-one), `http://100.128.0.1/` (just outside CGNAT), `http://11.0.0.1/`.

**Redirects:** a chain of 21 hops → `Block(RedirectLoop)`; a chain ending in
`file:///etc/passwd` → blocked at that hop with the full chain in the error; an
`https://example.com` → `http://example.com` same-host hop → `Block(Downgrade)`.

**Idempotency / totality:** a property test over 10 000 random strings — `navigation_allowed`
never panics, and any input that fails to parse as a `Url` yields `Block`.

### 12.4 Download tests — `browser_download::tests`

1. `sanitize_download_name` is the shared `web_safety` function: assert the browser's
   entry point and mail's produce **byte-identical** output for the mail plan's whole §7.3
   table (this is the test that proves there is one implementation, not two).
2. `Content-Disposition: attachment; filename*=UTF-8''%2e%2e%2f%2e%2e%2fetc%2fpasswd` →
   `passwd`.
3. `Content-Disposition: attachment; filename="invoice\u{202E}gnp.exe"` → no U+202E in the
   output and it does not end in `.png`.
4. A URL whose last path segment is `..` / `.` / empty → `download`.
5. A URL segment with no extension → the name has no extension (we never invent one).
6. The destination assigned at `Requested` is always under
   `<state_dir>/browser/quarantine/` — a property test over 10 000 hostile names asserts
   `dest.starts_with(quarantine_root)` and `dest.components()` contains no `ParentDir`.
7. Bytes that sniff as `MZ` / `\x7fELF` / `#!` → `Classification::IsAProgram` regardless of
   the name or the declared type.
8. Declared `application/pdf`, name `report.pdf`, bytes sniffing as `application/zip` →
   `TypeMismatch`.
9. On Unix: after staging, the quarantined file's mode is `0o600` and no execute bit is
   set, even when the source stream would have implied one.
10. `Finished { success: false }` removes the quarantine directory; a property test asserts
    the quarantine root is empty afterwards.
11. **Cancelling the save dialog leaves nothing on disk** — the quarantine file is removed.
12. **The save path comes from the dialog, never from the URL**: a test drives a mock
    dialog returning `/tmp/x/chosen.bin` for a download named `evil.sh` and asserts the
    written path is exactly the dialog's.

### 12.5 Frontend tripwires — `src/__tests__/BrowserTripwire.test.ts`

1. **No `dangerouslySetInnerHTML` under `src/components/browser/`.** (Mirrors mail's
   §7.4 item 4.)
2. **The reader-mode frame carries `sandbox=""` and none of `allow-scripts`,
   `allow-same-origin`, `allow-top-navigation`, `allow-popups`, `allow-forms`,
   `allow-modals`, `allow-downloads`** — read the component as text, same as mail's
   sandbox-token test.
3. **The reader-mode CSP string is character-for-character the mail constant**, and
   contains no `http`/`https` anywhere.
4. **`bodyLooksUnsafe` is called before reader-mode content is rendered** — assert the
   import and the call site exist.
5. **Address-bar formatting** (`formatAddressBar(url)` unit tests):
   - a 600-character URL renders the full host with no ellipsis;
   - `https://example.com@evil.example/` emphasizes `evil.example` and shows the userinfo
     warning;
   - `https://xn--80ak6aa92e.example/` shows both the Unicode and the `xn--` form;
   - `https://shop.example.co.uk/x` bolds `example.co.uk` (the psl test — the two-label
     heuristic would bold `co.uk` and this is the assertion that catches a regression to
     it);
   - `http://2130706433/` displays as `127.0.0.1` with the IP chip;
   - a tab title containing U+202E renders with it stripped.
6. **The mode indicator is always rendered** — the address bar component always emits the
   `Reader · No script · Full` control, and a snapshot asserts the active mode is
   visually distinguished (a security mode with no visible state is not one).
7. **Every browser confirm is native or gated** — assert no browser component renders a
   `createPortal`-based modal without first calling the "hide the browser webview" helper
   (§2.3). Implemented as a source scan for the helper's name in every file that imports
   `createPortal`.
8. **The `UntestedTag` is present** on the browser's entry points until the user confirms
   testing (repo rule) — assert `UntestedTag` is imported by the browser tab's chrome.

### 12.6 Manual QA (for the user's own session after a rebuild — **do not launch Tabtivity**)

- A browser tab opens, loads a public site, and the address bar bolds the right domain.
- `file:///etc/passwd` typed into the address bar shows the block page with no override.
- `http://localhost:1420/` typed in a **dev** build shows the block page (this is the one
  that proves BC-5 in the build where it matters).
- Clicking a download link produces exactly one native save dialog and one file; cancelling
  leaves nothing in `~/.local/share/tabtivity/browser/quarantine/`.
- Downloading an `.sh` shows the "This download is a program" banner and the saved file is
  not executable.
- A site calling `getUserMedia` fails with no prompt.
- A site calling `window.open` produces a new **tab in Tabtivity's chrome**, not an OS window.
- With a VPN tunnel up, the VPN chip is present on the address bar and the one-time notice
  appeared.
- Reader mode on a documentation page renders legible text with no images-from-network.
- Quitting and relaunching leaves every site logged out.
- A page that spins the CPU eventually shows "This page has stopped responding" and the
  rest of Tabtivity's UI still accepts clicks (the WebKitGTK main-loop test — §8.2).

---

## 13. Suggested build order

Each step ends green on both gates and is independently reviewable.

1. **BC-1: re-scope `capabilities/default.json` from `windows` to `webviews`** + §12.1's
   tests. **No browser code.** One commit, its own PR, smoke-checked by the user on a
   rebuild. Nothing else in this plan is safe to build first.
2. **`services::web_safety`** — move `sanitize_attachment_name`, `link_info`, `registrable`,
   `idna_display`, `host_of`, `scheme_of` out of `mail_sanitize`, re-export from it, adopt
   `psl` for `registrable`, bump `SANITIZER_VERSION`. Mail's existing tests must pass
   unchanged; that is the whole acceptance criterion.
3. **`services::browser_policy`** — `navigation_allowed`, `is_globally_routable`, the
   scheme tables, plus §12.3's full table. Pure functions, no webview, maximum test value
   per line.
4. **`services::browser_download`** — quarantine, sniffing, classification, the native
   dialog bridge (`DialogExt` → `oneshot`, never `blocking_*` — `commands::mail`'s rule 1
   applies verbatim), plus §12.4.
5. **Reader mode** — the `reqwest` fetch with the §9.3 guard, the existing `ammonia`
   pipeline, rendered in the existing `sandbox=""` frame. **This is a complete, shippable
   feature on its own** and it is fallback F1; if steps 6–8 stall, the browser still exists.
6. **The source-scan tripwires** (§12.2) — land them *before* the webview code they guard,
   so the guarded code cannot be written wrong even once.
7. **The browser webview** — spawn with `incognito(true)`, `on_navigation`, `on_new_window`,
   `on_download`, `on_page_load`, `on_document_title_changed`, `browser_extensions_enabled(false)`,
   no `enable_clipboard_access`. Windows: refuse (§5.2). Plus the WebView2 runtime-version
   check (§4.5).
8. **The chrome** — address bar with §7.1's rules, the mode control, the VPN chip, the
   block/error pages, the download rows, plus §12.5.
9. **`extract_archive` hardening** (expansion-ratio and total-size caps) — shared with the
   mail plan, independent of everything here, should not block the browser.
