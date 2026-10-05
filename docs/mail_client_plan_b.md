# Mail Client — Plan B: Mail Domain & Security Hardening

> Scope: the mail protocol/domain layer and the security posture of an embedded mail
> client. Tab-system wiring, the Tauri command registration pattern, and the
> Docker/sandbox machinery are Plan A's; this document assumes that integration
> surface exists and names commands only by their contract.
>
> Verification gates for everything below: `npx tsc --noEmit` and
> `cargo test --manifest-path src-tauri/Cargo.toml`. **Never launch Tabtivity to verify.**
> Provider presets in this plan are public consumer/hosting providers only — no
> institutional hostnames anywhere in code, tests, fixtures, or defaults.

---

## 0. Crate selection (verified 2026-07-26, not from memory)

### 0.1 What is already in the tree (reuse, don't duplicate)

From `src-tauri/Cargo.toml` and the workspace `Cargo.lock`:

| Already present | Version | Use for mail |
|---|---|---|
| `tokio` | 1.52.3, `features = ["full"]` | IMAP/SMTP async runtime — no new runtime |
| `rusqlite` | 0.40.1, `bundled` | the local message store (today only used read-only by the SQLite *viewer*; mail is its first write use) |
| `keyring` | 3, `windows-native` + `apple-native` + `sync-secret-service` + `linux-native-sync-persistent` + `crypto-rust` | IMAP/SMTP passwords — via `services::remote_credentials`, never a second keychain path |
| `serde` / `serde_json` | 1 | wire types |
| `base64` | 0.22 | already there (drag preview); mail-parser does its own decoding |
| `mime_guess` | 2.0.5 | extension → MIME for the mismatch check |
| `infer` | 0.19.0 | content sniffing for the mismatch check |
| `zip` | 2, `deflate` | already used by `commands::fs::extract_archive` |
| `opener` | 0.8.4 | behind `commands::ssh::open_external_url` (already refuses non-`http(s)`) |
| `tempfile` | 3 | staging |
| `encoding_rs` | 0.8.35 (transitive) | mail-parser's optional CJK charset support resolves to the same version |
| `tauri-plugin-dialog` | 2 (`rfd` 0.16) | the native save/open dialogs attachments must go through |
| `reqwest` | 0.13.4 (transitive, **no TLS backend enabled**) | remote-image proxy (§2.6) |

**There is no TLS stack in the tree at all today** — `grep 'rustls\|native-tls\|openssl' Cargo.lock`
returns nothing. This is good news: we choose rustls with a clean slate and never
inherit an OpenSSL packaging problem on Windows/macOS.

### 0.2 Verified crate status

All figures checked against crates.io on 2026-07-26.

| Crate | Version | Last release | Recent d/l | Verdict |
|---|---|---|---|---|
| `mail-parser` (stalwartlabs) | **0.11.5** | 2026-07-08 | ~1.07M | **Adopt.** 100% safe Rust, fuzzed + MIRI-tested, RFC 2045–2049 / 2047 / 2231, 41 charsets, Postel-liberal parsing. Exactly the right robustness posture for hostile input. |
| `mail-builder` (stalwartlabs) | **0.4.4** | 2025-08-12 | ~261k | **Adopt.** Older release but stable API and small surface; pulled in by `mail-send`'s `builder` feature so it costs nothing extra. |
| `mail-send` (stalwartlabs) | **0.6.1** | 2026-07-04 | ~75k | **Adopt for SMTP.** rustls-only (no native-tls path exists), `tokio-rustls` 0.26 / `rustls` 0.23 / `rustls-platform-verifier` 0.7 / `smtp-proto` 0.2. Crypto provider selectable: `aws_lc_rs` (default), `ring`, `fips`. |
| `async-imap` (async-email / Delta Chat) | **0.11.3** | 2026-07-17 | ~510k | **Adopt for IMAP.** MSRV 1.88. Default runtime is async-std — **must** use `default-features = false, features = ["runtime-tokio"]`. Declares **no TLS**: we supply `tokio-rustls` ourselves, which is what we want. Production-hardened by Delta Chat. |
| `imap-proto` (djc) | 0.16.7 | 2026-04-21 | ~868k | Transitive via async-imap. Healthy. |
| `imap` (jonhoo, sync) | 3.0.0-alpha.15 | **2025-02-08** | ~337k | **Reject.** Still alpha after 18 months, sync-only (would need `spawn_blocking` for every op), and less actively maintained than async-imap. |
| `lettre` | 0.11.22 | 2026-05-14 | ~4.59M | **Reject for v1, keep as the fallback.** Far more popular and has a built-in `Mechanism::Xoauth2`, but its default features are `native-tls` (must be turned off), and its rustls path is wired to `webpki-roots` rather than the OS trust store — which would mean an admin-installed private CA is not trusted, which in turn creates pressure for the "ignore cert" checkbox this plan forbids. Revisit if `mail-send` stalls. |
| `ammonia` | **4.1.4** | 2026-07-22 | ~2.40M | **Adopt for HTML sanitization.** html5ever-based. Crucially it has `clean_content_tags` (default: `script`, `style` — removed *with their contents*), `attribute_filter` (per-attribute rewrite callback), `filter_style_properties` (CSS property allowlist inside `style=`), `url_schemes`, `url_relative`, `strip_comments` (default true), `id_prefix`. |
| `tokio-rustls` | 0.26.4 | 2025-09-26 | — | Adopt. Matches `mail-send`'s 0.26 exactly → one TLS stack. |
| `rustls` | 0.23 | — | — | Adopt (via the above). |
| `rustls-platform-verifier` | 0.7.0 | 2026-04-12 | ~50.9M | Adopt. Validates against the **OS trust store** (Windows CryptoAPI / macOS Security.framework / Linux CA bundle). Matches `mail-send` 0.6.1's pinned 0.7. |
| `oauth2` (ramosbugs) | 5.0.0 | 2025-01-21 | ~10.8M | **Phase 2 only** (§0.4). |

### 0.3 Prescribed `Cargo.toml` additions

```toml
# ── Mail (see docs/mail_client_plan_b.md) ────────────────────────────────────
# MIME parsing of untrusted network input. Chosen over hand-rolling because it is
# 100% safe Rust, continuously fuzzed and MIRI-checked — this is the crate that
# eats attacker-controlled bytes first, so its memory-safety story is the whole
# argument.
mail-parser = "0.11"
# Outbound MIME construction (plain text + explicitly picked attachments only).
mail-builder = "0.4"
# SMTP over rustls. `default-features = false` drops `dkim` (we sign nothing),
# `digest-md5`/`cram-md5` (weak mechanisms whose mere availability gives a MITM a
# downgrade target — see §4.5), and swaps the default `aws_lc_rs` provider for
# `ring`, which needs no cmake on the Windows runner.
mail-send = { version = "0.6", default-features = false, features = ["builder", "ring", "tls12"] }
# IMAP. `default-features = false` is load-bearing: the crate's default runtime is
# async-std, and `runtime-tokio` puts it on the runtime Tabtivity already has. The
# `compress` feature is deliberately NOT enabled — COMPRESS=DEFLATE lets a hostile
# server hand us a decompression bomb (§3.6).
async-imap = { version = "0.11", default-features = false, features = ["runtime-tokio"] }
# The one TLS stack for both protocols. rustls (no OpenSSL anywhere in the bundle)
# with the OS trust store, so a private CA is added by the system administrator
# rather than by an "ignore certificate" checkbox this client does not have (§4.3).
tokio-rustls = { version = "0.26", default-features = false, features = ["ring", "tls12", "logging"] }
rustls = { version = "0.23", default-features = false, features = ["ring", "tls12", "std", "logging"] }
rustls-platform-verifier = "0.7"
rustls-pki-types = "1"
# HTML sanitization in the backend, before a single attacker byte reaches the
# webview (§2.3). html5ever-based, so it parses hostile markup the same way the
# renderer will rather than pattern-matching it.
ammonia = "4"
# Zero password buffers on drop; nothing in this crate's API can be logged.
zeroize = { version = "1", features = ["derive"] }
# Remote-image proxy (§2.6) — already in the dependency tree with no TLS backend;
# this names it directly and gives it one.
reqwest = { version = "0.13", default-features = false, features = ["rustls-tls", "http2", "charset"] }
# Punycode/IDNA for the link-safety host comparison (§2.5).
idna = "1"
```

**Build hazard to check first (one commit, its own PR):** `rustls` 0.23 panics at
first use with *"no process-level CryptoProvider available"* if more than one
provider is compiled in and none is installed. `reqwest`'s `rustls-tls` may pull
`aws-lc-rs`. Therefore, in `lib.rs`'s setup, **before any TLS is used**:

```rust
// Two crates in the tree can supply a rustls CryptoProvider; rustls refuses to
// guess. Install ours explicitly and ignore an already-installed one.
let _ = rustls::crypto::ring::default_provider().install_default();
```

Acceptance for this commit: `cargo test` passes and a new test
`tls::provider_is_installed()` asserts `rustls::crypto::CryptoProvider::get_default().is_some()`.

### 0.4 OAuth2 / XOAUTH2 — what it actually costs, and why v1 defers it

**What a self-built client must have to use OAuth for mail:**

1. A **registered OAuth client** with each provider (a Google Cloud project; an Entra
   ID app registration), of type *Desktop app*.
2. A **loopback redirect URI** (`http://127.0.0.1:<ephemeral>/`). Google has confirmed
   the loopback flow stays supported for the **desktop** client type (it is being
   deprecated for iOS/Android/Chrome app types). The out-of-band (`urn:ietf:wg:oauth:2.0:oob`)
   flow is dead. This means the app must bind a localhost HTTP listener during sign-in.
3. **PKCE** (RFC 7636) and RFC 8252 native-app rules. A native app cannot keep a client
   secret — and this repo is **public**, so any embedded secret is published on push.
   Google's desktop client type issues a "secret" anyway and expects it in the token
   request; it is a public identifier, not a secret, and shipping it in a public repo
   is exactly what Thunderbird does. That is tolerable but must be a conscious,
   documented choice, and the value must be a **generic Tabtivity-project** credential.
4. **Refresh-token storage** — a long-lived bearer credential for the user's entire
   mailbox, which must live in the same keychain, under the same locked-keychain rules.
5. **XOAUTH2** wire framing: `AUTH XOAUTH2 <base64("user=" user "\x01auth=Bearer " tok "\x01\x01")>`
   for both IMAP and SMTP, plus the empty-`*`-continuation error dance.

**The blocker.** Gmail IMAP requires the `https://mail.google.com/` scope, which Google
classifies as **restricted**. Restricted-scope apps distributed publicly must pass
Google's app verification **plus an independent CASA Tier 2 security assessment** by a
Google-approved lab — a third-party DAST scan, currently in the **US$540–1,000** range,
with an end-to-end timeline of **4–12+ weeks**, and it must be **re-done every 12
months**. Unverified apps are capped at ~100 test users and show an "unverified app"
interstitial. This is a recurring cost and an annual compliance treadmill attached to
what is otherwise a side feature of a developer workspace.

**Provider reality as of today:**

| Provider | Password auth for IMAP/SMTP | Notes |
|---|---|---|
| **Gmail, personal** | ✅ **App Password** (requires 2-Step Verification) | Google discourages it but it works. IMAP is always-on since Jan 2025. |
| **Google Workspace** | ❌ since 2025-05-01 | OAuth only. |
| **Outlook.com / M365** | ❌ being removed | Microsoft is retiring Basic auth for POP/IMAP/SMTP AUTH on Outlook.com; OAuth is the mandated replacement, with the final removal timeline still being communicated. Treat Outlook.com as **OAuth-only** for planning purposes. |
| **Fastmail, mailbox.org, Posteo, Migadu, Zoho, self-hosted Dovecot/Postfix, generic IMAP** | ✅ app passwords / normal passwords over TLS | This is the large majority of servers a developer workspace will actually be pointed at. |

**Recommendation — v1 is app-password / `AUTH PLAIN` over implicit TLS only.**

Reasoning:
- It covers personal Gmail, every generic/self-hosted IMAP server, and every
  privacy-focused provider — i.e. most of the realistic user base for this app.
- It requires **zero** provider registration, zero recurring cost, zero annual audit,
  and no embedded client identifier in a public repo.
- It has a strictly smaller attack surface: no localhost HTTP listener, no browser
  round-trip, no long-lived refresh token, no token-refresh race conditions.
- The remaining work for Phase 2 is *additive and well-isolated*: one `AuthMethod`
  enum variant, one `Xoauth2` mechanism on each protocol, one loopback listener,
  one keychain account key. Design for it now (see below), build it later.

**Design-for-later obligations in v1:**
- `enum MailAuth { Password, XOauth2 }` exists from day one; `Password` is the only
  constructible variant, and the match on it is exhaustive so adding `XOauth2` is a
  compile error at every site that must change.
- The account record carries `auth_method: MailAuth` and an
  `oauth: Option<OAuthConfig>` field, serialized and round-tripped even though unused.
- Provider presets carry an `oauth_required: bool`. When true, the account setup UI
  says *"This provider requires OAuth sign-in, which Tabtivity does not support yet"*
  and refuses to create the account — **it must not** present a password field that
  will fail with an opaque `AUTHENTICATIONFAILED`. Outlook.com/Office 365 presets ship
  with `oauth_required: true` and are visible-but-disabled. That honest dead end is
  worth shipping; a password box that cannot work is not.

---

## 1. Threat model

An embedded mail client inverts Tabtivity's normal trust posture. Every other input the
app handles is something the user chose: a file they opened, a repo they cloned, a
host they configured. **Mail is the first input stream where an anonymous remote party
decides what bytes arrive and when.** Every rule below follows from that one sentence.

Two structural facts about Tabtivity make the mitigations cheaper than they'd otherwise be,
and both must be preserved rather than eroded:

- **The webview already cannot reach the internet.** The app CSP in
  `src-tauri/tauri.conf.json` is
  `default-src 'self'; ...; img-src 'self' data: blob:; connect-src 'self' ipc: http://ipc.localhost`.
  There is no `https:` in any fetch directive. A tracking pixel in a message body has
  no mechanism to load *even if every other control failed*. This is the single
  strongest mitigation in the whole plan and it already exists — **do not add `https:`
  to any CSP directive to implement remote images** (§2.6 gives the alternative).
- **The frontend already has a no-DOMPurify, escape-first, `sandbox=""` convention**
  (`src/lib/viewers/markdown.ts`, `src/components/embed/OdtView.tsx`,
  `RenderedPreview` in `FileViewerPane.tsx`). Mail should extend that convention, not
  introduce a competing one.

### Threat table

| # | Threat | Concrete mitigation |
|---|---|---|
| **T1** | **Malicious HTML/CSS** in a `text/html` body — mXSS, namespace confusion (`<svg>`/`<math>`), `<base>`, `<meta refresh>`, `<form>` exfil, `position:fixed` overlays that fake app chrome | Backend sanitization with `ammonia` (html5ever parse → allowlist serialize) **before the HTML ever crosses the IPC boundary** (§2.3), plus `filter_style_properties` for a CSS property allowlist, plus render inside `sandbox=""` (§2.2). Three independent layers. |
| **T2** | **Remote-content tracking pixels** — `<img src=https://…/1x1.gif?uid=…>`, CSS `url()`, `@font-face`, `<link rel=stylesheet>`, `srcset`, `<video poster>`, `<input type=image>` | The webview cannot make remote requests at all (app CSP). Belt-and-braces: the sanitizer drops every remote URL attribute (§2.3), the frame's own `<meta>` CSP is `img-src data:` with `default-src 'none'` (§2.4), and remote content is only ever fetched by an explicit, per-message, backend-proxied opt-in (§2.6). |
| **T3** | **JS execution** — `<script>`, `on*` handlers, `javascript:`, `srcdoc`-nested frames, SVG `<animate>`/`<set>` | The message frame is `sandbox=""` (no `allow-scripts`), so scripts are disabled by the *sandbox*, not merely by the sanitizer. `script-src 'none'` in the frame CSP, `clean_content_tags` removes `<script>` with its content, `attribute_filter` rejects every `on*` attribute, `url_schemes` excludes `javascript:`. Four independent controls, any one sufficient. |
| **T4** | **Phishing links** — display-text-vs-`href` mismatch, homograph/IDN hosts, URL-shortener laundering, `data:`/`file:`/`smb:` schemes | The sanitizer **removes every `href`**; links in the body are inert styled text. A parent-rendered Links panel is the only clickable surface, showing display text *and* the real URL with the registrable domain isolated, mismatch and mixed-script flags, and punycode. Opening requires an explicit confirm and routes through the existing `open_external_url`, which already refuses non-`http(s)`. (§2.5) |
| **T5** | **Malicious attachments** — `invoice.pdf.exe`, macro documents, `.lnk`/`.scf`/`.hta`, HTML attachments that open with app privileges | Never auto-written to disk, never auto-opened, stored under content-addressed opaque names, extracted only via an explicit native save dialog per file, executable/script extensions blocked from the in-app Open action entirely. (§3) |
| **T6** | **MIME parser memory-safety bugs** — the classic mail-client RCE class | `mail-parser` is 100% safe Rust, continuously fuzzed and MIRI-checked; no `unsafe` in our own parsing glue. Enforce structural caps (nesting depth 32, part count 512, header line 64 KB, message 50 MB) *above* the parser so a pathological message is refused, not merely survived. Parsing runs on a `spawn_blocking` worker with a wall-clock bound. (§3.6, §7) |
| **T7** | **Homograph / spoofed sender display** — `From: "support@bank.example" <a@evil.example>`, RLO in a display name, duplicate `From:` headers, unicode confusables | The address list UI **always renders the addr-spec**, never the display name alone. Display names are stripped of bidi/format controls and rendered in a visually distinct weight. A display name that itself contains `@` or looks like an address gets a "this is a name, not an address" marker. Duplicate `From:`/`Sender:` headers → the message is flagged *"malformed sender headers"* and all values shown. (§7 fixtures) |
| **T8** | **HTML injection into Tabtivity's own DOM** — the catastrophic case: sanitizer escape becomes app-origin XSS with full Tauri IPC access | The message body is **never** rendered into the app document. There is exactly one `dangerouslySetInnerHTML`-free path: `iframe.srcdoc`, `sandbox=""`. Every other mail-derived string (subject, sender, filename, folder name) reaches React as a **plain text node** — no `dangerouslySetInnerHTML` anywhere under the mail feature, enforced by a source-scanning test (§7.4). |
| **T9** | **Path traversal via attachment filename** — `../../.ssh/authorized_keys`, `..\..\Startup\x.lnk`, RTL-override `invoice⁠\u202Egnp.exe`, `CON`, absolute paths, UNC paths | A single `sanitize_attachment_name()` with 13 enumerated rules (§3.3), applied to *every* filename before it is used in any position, plus the structural guarantee that the internal store never uses the supplied name at all (content-addressed blobs), plus the save path being chosen by the OS dialog rather than by us. Path traversal therefore has to defeat three independent things. |
| **T10** | **Zip / decompression bombs** | IMAP `COMPRESS=DEFLATE` **not enabled** (the crate feature is off) — this is the only compression channel a server controls. MIME nesting/part caps stop `message/rfc822` depth bombs. Archive attachments are **never auto-extracted**; if the user extracts one it goes through `commands::fs::extract_archive`, which must gain an expansion-ratio and total-size cap (it has neither today — see §3.6). |
| **T11** | **IMAP/SMTP MITM** — passive interception, STARTTLS stripping, STARTTLS command/response injection, downgrade to plaintext | Implicit TLS ports only in v1 (993/465). No plaintext fallback exists in the code — the transport constructor returns a `TlsStream`, so there is no type a cleartext connection could inhabit. Certificate validation via the OS trust store, hostname-verified, TLS ≥ 1.2, **no bypass of any kind**. (§4) |
| **T12** | **Credential exfiltration** — secrets in logs, in error strings, in Tauri event payloads, in the frontend, in the message store, in crash dumps | The password never enters the frontend (the `credential_paste_to_pty` precedent). It lives in a `Zeroizing<String>`, is never `Debug`-printed (custom `Debug` prints `<redacted>`), never interpolated into an error, never serialized. Stored only in the OS keychain via `services::remote_credentials`, and **only if the user ticks a box that defaults OFF**. (§5) |
| **T13** | **Reply-address spoofing** — `Reply-To:` pointing somewhere other than `From:`, so a reply goes to the attacker | On Reply, if the resolved recipient's domain differs from `From:`'s, the compose header shows an inline warning naming both, and the recipient chip is rendered in the warning color until acknowledged. Reply-All additionally shows the total recipient count and refuses to silently include `Bcc`-derived addresses. |
| **T14** | **CSS-based exfiltration** — attribute selectors + `background: url()` leaking content, `@import`, `@font-face` | `<style>` blocks removed with their content (ammonia default). `style=` attributes passed through `filter_style_properties` with a fixed property allowlist; any declaration whose value contains `url(`, `expression(`, `@`, `\`, or `/*` is dropped wholesale. `position`, `z-index`, `content`, and all `-webkit-`/`-moz-` properties are **not** on the allowlist. |
| **T15** | **IMAP protocol confusion** — unsolicited untagged responses that mutate client state, huge literals to OOM us, response injection across a command boundary | Untagged responses are only applied inside the command that solicited them; anything else is logged and dropped. A hard cap on accepted literal size (25 MB per `FETCH` chunk) and on total response bytes per command. Every network op has a timeout (§4.6). |
| **T16** | **SMTP header injection** — a CR/LF in a user-supplied `Subject:` or recipient inserting `Bcc:` | Recipients are parsed into typed addresses, never concatenated. `mail-builder` encodes headers, but we additionally reject any header value containing `\r` or `\n` **before** handing it over, and a unit test asserts an injected `Bcc` never appears in the built output (§7.1). |
| **T17** | **Scheme abuse on outbound open** — `file:///`, `smb://`, `vbscript:`, `ms-msdt:` | Only `http`/`https` are ever handed to `open_external_url` (which already refuses everything else). `mailto:` is handled *internally* by opening the compose view — never by the OS handler. Every other scheme is displayed as text and is not clickable. |
| **T18** | **Charset confusion** — a body declared `charset=utf-7` or with a hostile BOM being reinterpreted by the renderer | The backend decodes to UTF-8 using `mail-parser`'s charset handling and emits **only** UTF-8 into the srcdoc, and the srcdoc's first bytes are `<meta charset="utf-8">`. UTF-7 is not in the accepted charset set; an unknown/unsupported charset falls back to a lossy Latin-1 decode with a banner, never to renderer sniffing. |
| **T19** | **Auto-response side channels** — read receipts (MDN), one-click List-Unsubscribe, calendar auto-RSVP | **No outbound message is ever sent without an explicit user action.** MDN requests are ignored and never surfaced as a prompt (a prompt is itself a signal the address is live). `List-Unsubscribe` is displayed as a link in the Links panel like any other, subject to the same confirm; `List-Unsubscribe-Post` one-click is not implemented. Calendar invites are out of scope (§6). |
| **T20** | **SSRF via the remote-content proxy** — an `<img src="http://169.254.169.254/…">` turning our backend into a request oracle for the local network | The proxy resolves the host and refuses any address that is loopback, link-local, private (RFC 1918 / ULA), CGNAT, multicast, or unspecified — **re-checked after every redirect**, with redirects capped at 3. Only `http`/`https`. No cookies, no auth headers, no `Referer`, fixed generic UA, 10 s timeout, 5 MB/image, 20 MB/message. (§2.6) |

---

## 2. HTML rendering — the highest-risk area

### 2.1 The pipeline, end to end

```
IMAP FETCH (TLS)
  └─ raw RFC 5322 bytes                    [backend, untrusted]
      └─ mail-parser  → structured message [backend, safe Rust, fuzzed]
          └─ pick body part (prefer text/plain when the user's setting says so)
              ├─ text/plain → escape → wrap in <pre class="mail-plain">
              └─ text/html  → ammonia sanitize (§2.3)
                              → cid: rewrite to data: URIs (§2.7)
                              → href extraction + strip (§2.5)
                  └─ SanitizedBody { html, links: Vec<LinkInfo>, blocked_remote: u32 }
                      └─ IPC  ─────────── the boundary ───────────
                          └─ frontend builds srcdoc = CSP meta + base CSS + html
                              └─ <iframe sandbox="" srcDoc={…}>   [opaque origin]
```

**The load-bearing decision: sanitize in Rust, in the backend, once, before IPC.**

Argument, against the alternatives:

- **vs. client-side DOMPurify.** DOMPurify is excellent, but placing it in the frontend
  means the raw attacker HTML is already *inside the app origin* as a JS string when
  sanitization runs. Any bug in the surrounding code — a stray log, a devtools hook, a
  future refactor that renders before sanitizing — is app-origin XSS with full Tauri
  IPC. Sanitizing in the backend means **the unsanitized string never exists in the
  webview process at all**. That is a structural property, not a discipline.
  Secondarily: DOMPurify would be a new ~20 KB npm dependency in a repo that has
  deliberately avoided it three times already (`markdown.ts`, `OdtView.tsx`,
  `NotebookView.tsx` all document a no-DOMPurify policy). Introducing it for mail
  would create two competing sanitization conventions.
- **vs. both.** Defence in depth is usually right, but a *second* sanitizer with
  *different* parsing semantics is a known source of mutation-XSS: markup that
  sanitizer A considers inert can be re-parsed differently by sanitizer B's serializer.
  Two allowlists also drift. We get our depth from *different mechanisms* (sandbox,
  CSP, no-href) rather than from a second parser.
- **Why ammonia specifically.** It parses with html5ever — the same HTML5 tree
  construction the renderer uses — and **re-serializes from the tree**. Regex/string
  sanitizers fail on mXSS precisely because they don't share the renderer's parse.
  It also removes `<script>`/`<style>` *contents* by default (`clean_content_tags`),
  which naïve tag-stripping does not.

The frontend still verifies the invariant it depends on: a cheap assertion that the
received `html` contains no `href=`, `<script`, `on…=`, or `srcdoc` before it is put in
the `srcdoc`, failing loudly (render an error card, log) rather than rendering. This is
a tripwire for a backend regression, not a second sanitizer.

### 2.2 The iframe: exact attributes

```tsx
<iframe
  // sandbox="" is the most restrictive value and is load-bearing.
  // NOTHING may be added here. In particular allow-scripts + allow-same-origin
  // together is a full sandbox escape: the frame could reach into this document.
  sandbox=""
  srcDoc={doc}
  referrerPolicy="no-referrer"
  loading="eager"
  title={t("mail.messageBody")}
  className="mail-body-frame"
/>
```

**Tokens that MUST be present:** none. `sandbox=""` is the whole policy.

**Tokens that MUST NOT be present, and why:**

| Token | Why it is forbidden |
|---|---|
| `allow-scripts` | Enables JS in the body. The single most important omission. |
| `allow-same-origin` | Gives the frame the app's origin → `parent.document`, `localStorage`, and `__TAURI__` access. **`allow-scripts` + `allow-same-origin` together is a total escape.** |
| `allow-top-navigation` / `-by-user-activation` | A body could navigate the whole Tabtivity window away. |
| `allow-popups` / `allow-popups-to-escape-sandbox` | Window-open based phishing and sandbox laundering. |
| `allow-forms` | Credential-harvesting forms that POST out. |
| `allow-modals` | `alert`/`prompt` spoofing app dialogs (needs scripts too, but omit anyway). |
| `allow-downloads` | Silent file writes — the exact boundary §3 exists to protect. |
| `allow-pointer-lock`, `allow-presentation`, `allow-orientation-lock` | No legitimate use; each is attack surface. |
| `allow-storage-access-by-user-activation` | Storage/tracking. |

`sandbox=""` gives the frame an **opaque origin**. Two consequences the implementer
must internalize:

1. `blob:` URLs minted by the parent are **not loadable** inside it (they carry the
   parent's origin). Inline images therefore must be `data:` URIs, not blobs (§2.7).
   This differs from every other viewer in the codebase, which uses `useBlobUrl`.
2. `postMessage` from the frame arrives with `event.origin === "null"`. Since v1 has no
   scripts in the frame, the parent installs **no** `message` listener for the mail
   view at all.

**Navigation:** the frame has no `href` anywhere (§2.5), so there is nothing to click
that could navigate it. As a structural backstop, add an explicit `frame-src 'self'` to
the app CSP in `src-tauri/tauri.conf.json`. It changes nothing today (`default-src
'self'` already covers it) but means a future loosening of `default-src` cannot
silently permit a message frame to navigate itself to `https://evil`.

### 2.3 The ammonia configuration

A single `pub fn sanitize_message_html(raw: &str, ctx: &BodyCtx) -> SanitizedBody`
in `src-tauri/src/services/mail/sanitize.rs`. Built once into a `OnceLock<Builder>`.

**Tags — explicit allowlist, replacing ammonia's default entirely** (`Builder::tags`,
not `add_tags`, so a future ammonia default change cannot widen us):

```
a abbr b blockquote br caption cite code col colgroup dd del dfn div dl dt em
figcaption figure h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol p pre q s samp
small span strong sub sup table tbody td tfoot th thead tr u ul var wbr
```

Deliberately **not** allowed: `script style iframe frame frameset object embed applet
form input button select option textarea label fieldset base link meta title head body
html svg math template noscript audio video source track canvas map area marquee
portal dialog details summary slot`.

`clean_content_tags`: `{script, style, title, textarea, noscript, iframe, object, embed,
template, xmp}` — these are removed **with their contents**, which matters because the
contents of `<style>`/`<title>`/`<noscript>` are re-parsed differently and are the
classic mXSS payload sites.

**Generic attributes** (`Builder::generic_attributes`, replacing the default): `{}` —
empty. `title` is *not* generic; `lang`/`dir` are handled per-tag.

**Per-tag attributes** (`tag_attributes`):
- `a`: `{}` — every `a` attribute including `href`, `target`, `rel`, `name`, `download`
  is removed. `data-lid` is injected afterwards by `attribute_filter`'s companion pass
  (see §2.5), not permitted from input.
- `img`: `{alt, width, height}` — **`src` is not here**. `src` is injected only by our
  own `cid:`→`data:` pass. Note that means an attacker-supplied `src` never survives,
  including `data:` ones they wrote themselves.
- `table`/`td`/`th`/`tr`: `{colspan, rowspan}` (numeric-validated by `attribute_filter`).
- `blockquote`: `{cite}` → dropped by `attribute_filter` (it is a URL).
- `ol`: `{start}` (numeric-validated).
- All: `dir` restricted via `tag_attribute_values` to `{ltr, rtl, auto}`.
- All: `style` — allowed, then filtered (below).

**`attribute_filter`** — the belt to the allowlist's braces. Reject (return `None`) if:
- the attribute name starts with `on` (case-insensitive), or contains a control char;
- the attribute name is `src`, `href`, `xlink:href`, `srcset`, `formaction`, `action`,
  `data`, `poster`, `background`, `codebase`, `usemap`, `ping`, `dynsrc`, `lowsrc`;
- the value, after stripping ASCII whitespace **and C0/C1 controls and U+FEFF/U+00AD**,
  case-insensitively starts with a scheme other than `data:image/` for our own injected
  `src`. (Entity decoding is already done by html5ever before the filter sees the value,
  which is precisely why the filter runs at this layer and not on the raw text.)
- the value fails a per-attribute type check (`colspan`/`rowspan`/`start`/`width`/`height`
  must be `\d{1,4}`).

**`filter_style_properties`** — the CSS property allowlist:

```
color background-color font-family font-size font-style font-weight
font-variant text-align text-decoration text-transform letter-spacing
line-height white-space word-break overflow-wrap vertical-align
margin margin-top margin-right margin-bottom margin-left
padding padding-top padding-right padding-bottom padding-left
border border-top border-right border-bottom border-left
border-color border-style border-width border-radius border-collapse border-spacing
width max-width height max-height display list-style-type
```

Deliberately excluded: `position`, `top`/`right`/`bottom`/`left`, `z-index`, `content`,
`background` (shorthand — it can carry `url()`), `background-image`, `cursor`, `filter`,
`transform`, `transition`, `animation`, `clip-path`, `mask`, `mix-blend-mode`, `opacity`,
`float`, `pointer-events`, and every vendor-prefixed property. `display` is allowed but
`attribute_filter` additionally drops the whole declaration if the value is not one of
`{inline, block, inline-block, table, table-row, table-cell, list-item, none}`.

Belt: after `filter_style_properties`, a final pass drops any surviving declaration
whose value contains `url(`, `expression(`, `@`, `\`, `/*`, `<`, or a non-ASCII
character. Test it (§7.1).

**Other builder settings:**
- `url_schemes(hashset!{})` — empty. Nothing in the output carries a URL, so no scheme
  is ever legitimate.
- `url_relative(UrlRelative::Deny)`.
- `strip_comments(true)` (default; state it explicitly — comments are an mXSS vector).
- `id_prefix(Some("m-"))` — prevents a message-supplied `id` colliding with anything,
  though `id` isn't allowed anyway.
- `link_rel(None)` — moot, no links.

### 2.4 The srcdoc document

Assembled in the **frontend** (the backend supplies only the sanitized fragment) so
the CSP nonce/structure lives next to the iframe it protects:

```html
<!DOCTYPE html>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="
  default-src 'none';
  img-src data:;
  style-src 'unsafe-inline';
  script-src 'none';
  object-src 'none';
  frame-src 'none';
  child-src 'none';
  connect-src 'none';
  font-src 'none';
  media-src 'none';
  form-action 'none';
  base-uri 'none';
  frame-ancestors 'none';
  sandbox">
<meta name="referrer" content="no-referrer">
<style> /* our own reset + link styling — see below */ </style>
<div class="mail-body" dir="auto">…sanitized fragment…</div>
```

Notes on each choice:
- **`default-src 'none'`** is the base; every directive that is *not* explicitly listed
  inherits it. `img-src data:` is the only load permitted, and only for our own inlined
  images.
- **`style-src 'unsafe-inline'`** is required for our own `<style>` reset and for the
  surviving `style=` attributes. This is safe here only because scripts are impossible;
  in a scripted context `'unsafe-inline'` style would be a CSP-bypass gadget.
- **`sandbox`** (the CSP directive, valueless) restates the iframe attribute inside the
  document. Redundant on purpose: if the iframe attribute is ever edited away, this
  still yields a fully-sandboxed document.
- The `<meta>` CSP is **first content in the document**, before any element that could
  load. A CSP meta after the first resource-loading element is ignored for that element.

**Why an inline `<meta>` CSP and not the `csp=` iframe attribute:** the `csp=` attribute
(CSP Embedded Enforcement) is a Chromium feature. WebView2 honours it; **WebKitGTK does
not implement it**. Relying on it would produce a policy that silently doesn't exist on
Linux — the worst possible failure mode. Use `<meta>`, which both engines honour.

**Why we don't rely on CSP inheritance either:** the spec says an `about:srcdoc`
document inherits its parent's CSP, and in practice the app's `default-src 'self'`
would already block remote loads. But WebKit's inheritance behaviour for
sandboxed/srcdoc documents has been inconsistent historically, and the W3C issue asking
to *stop* inheriting was closed `wontfix` in Dec 2024 — i.e. the behaviour is in flux
and engine-dependent. **State the policy explicitly inside the document; treat
inheritance as a bonus, never as the mechanism.**

### 2.5 Links: defeating display-text-vs-href

**The rule: no `href` attribute exists anywhere in the rendered body.** Not a sanitized
one, not a rewritten one. This makes an entire attack class structurally impossible
rather than filtered.

**Backend, during sanitization**, a pre-pass over the parsed tree collects every `<a>`:

```rust
pub struct LinkInfo {
    pub id: u32,              // index; the ONLY thing the frontend ever gets back
    pub display_text: String, // the anchor's textContent, control-chars stripped, capped 200
    pub url: String,          // the raw href, scheme-normalized
    pub scheme: String,       // "https" | "http" | "mailto" | other
    pub host_ascii: String,   // punycode / A-label form, lowercased
    pub host_unicode: String, // U-label for display
    pub registrable: String,  // eTLD+1 via a bundled PSL, or "" when unavailable
    pub flags: LinkFlags,     // see below
}

bitflags LinkFlags {
    TEXT_LOOKS_LIKE_URL,   // display_text parses as/contains a hostname
    DOMAIN_MISMATCH,       // that hostname's registrable != url's registrable
    IDN,                   // host_ascii starts with "xn--" in any label
    MIXED_SCRIPT,          // host_unicode mixes Latin with Cyrillic/Greek/etc.
    NON_WEB_SCHEME,        // not http/https/mailto
    IP_HOST,               // host is a bare IP literal
    USERINFO,              // url contains "user@" before the host (the classic
                           // https://bank.example@evil.example trick)
    LONG_SUBDOMAIN,        // > 4 labels or > 60 chars before the registrable domain
}
```

Each `<a>` in the output becomes `<a data-lid="{id}" class="mail-link">…text…</a>` with
**no other attributes**. It is styled as a link (underline + accent color) so the
message reads naturally, plus a small trailing `↗` glyph via CSS `::after` on
`.mail-link` — wait, `content` is not on the CSS allowlist for *message* CSS, but this
rule is in **our** `<style>` reset, which is trusted; that's fine and worth a comment so
a later reader doesn't "fix" it.

**Frontend, in the app's own DOM** (not the frame): a `MessageLinks` panel below the
body, collapsed by default with the header *"Links (n)"*, expanded automatically when
any link carries `DOMAIN_MISMATCH | MIXED_SCRIPT | USERINFO | NON_WEB_SCHEME`. Each row:

```
  "Click here to verify your account"        ← display text, quoted, muted
  https://  secure-login.evil.example  /a/b  ← scheme dim · registrable BOLD · path dim
  ⚠ The link text names bank.example but this goes to evil.example
```

Clicking a row opens `LinkConfirmDialog`:
- the **full** URL, monospace, `word-break: break-all`, **never truncated with an
  ellipsis** — truncation is itself the attack (`https://bank.example.evil.tld/…` reads
  as `https://bank.example…`);
- the URL split onto three lines — scheme / **host** / path+query — with the host on its
  own line at a larger size, since the host is the only part that decides where you go;
- every applicable flag as a named warning line, not an icon;
- for `IDN`: both the Unicode and the `xn--` forms, with the `xn--` form labelled *"the
  actual domain"*;
- buttons: **Cancel** (default focus), *Copy link*, *Open in browser*.
- Only `http`/`https` render an *Open in browser*. `mailto:` renders *Compose to …*
  which opens the internal composer. Everything else renders *Copy link* only.

**Opening** calls `open_external_url` with the URL **read from the parent's own
`LinkInfo` table, keyed by `id`** — never a string that came back from anywhere else.
That command already refuses non-`http(s)`, so we get a second, independent check.

**Why not `allow-scripts` + a nonce'd click-forwarder in the frame?** That is the
approach that gives natural in-body clicking, and it is defensible: without
`allow-same-origin` the frame is still an opaque origin that cannot reach the parent
DOM, and a `script-src 'nonce-…'` policy with a per-render random nonce would admit only
our forwarder. But it re-admits JS execution into a document built from attacker bytes,
which means a CSP nonce-leak or dangling-markup gadget turns into script execution — and
it makes the whole design's safety contingent on getting CSP exactly right on **two**
engines whose CSP behaviour we just established differs. For v1 the cost (links are
clicked in a panel instead of in the body) is small and the guarantee is absolute.
**If a later phase wants in-body clicking, the requirements are:** `sandbox="allow-scripts"`
only (never with `allow-same-origin`); `script-src 'nonce-<32 random bytes, per render>'`;
the forwarder posts only `{type:"link", id:<int>}`; the parent's listener asserts
`e.origin === "null"`, `e.source === frameRef.current.contentWindow`, and that `id` is
an integer index into its own table; and **the parent still never accepts a URL from the
frame**. That last rule is what preserves the anti-phishing property regardless.

### 2.6 Remote content: blocked by default, opt-in via a backend proxy

The webview's top-level CSP has no `https:` in any fetch directive, so the frame
*cannot* load remote content by any mechanism. Therefore the opt-in cannot work by
relaxing a policy — and it should not, because relaxing a CSP per-message is exactly the
kind of state that gets left on. Instead:

**"Load remote images" is a backend action, not a policy change.**

1. During sanitization the backend records every remote URL it dropped into
   `SanitizedBody.remote_refs: Vec<(placeholder_id, url)>` and sets
   `blocked_remote: n`. The body shows a placeholder box per image (sized from `width`/
   `height` when given, so layout doesn't jump) and a banner:
   *"Tabtivity blocked n remote images. Loading them tells the sender you opened this
   message."* with buttons **Load images once** / **Always for this sender**.
2. On **Load images once**, the frontend calls
   `mail_load_remote_images(account_id, message_id)`. The backend fetches each URL with
   `reqwest`, applying the T20 guard, and returns `Vec<(placeholder_id, data_uri)>`.
   The frontend rebuilds the srcdoc with the `data:` URIs substituted into the
   placeholders' `src`.
3. **The frame's CSP never changes.** It remains `img-src data:` forever. There is one
   policy in the codebase, and every test asserts that exact string.

Advantages beyond CSP hygiene: no cookies are ever attached (the app webview shares a
cookie jar; a direct load could carry a `SameSite=None` cookie for the tracker's
domain), no `Referer`, no real UA, no HTTP cache entry, and the SSRF/size/timeout
guards live in one place instead of being the webview's business.

**"Always for this sender"** stores the *addr-spec* (not the display name, not the
domain) in a `mail_remote_allow` table. Never offer "always for all senders" — a
one-click global disable of the feature is a footgun that will get clicked.

**`is_public_http_url()` — the T20 guard, unit-tested (§7.1):** scheme in
`{http, https}`; no userinfo; resolve the host; **every** resolved address must be
globally routable — reject loopback (`127.0.0.0/8`, `::1`), link-local
(`169.254.0.0/16`, `fe80::/10`), private (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`),
CGNAT (`100.64/10`), multicast, broadcast, unspecified, and IPv4-mapped IPv6 forms of
any of the above. Redirects: max 3, and the guard re-runs on each hop (a public host
that 302s to `http://169.254.169.254` is the standard bypass). Timeout 10 s, 5 MB per
image, 20 MB per message, `Content-Type` must sniff (via `infer`) as a real image or the
result is discarded.

### 2.7 Inline (`cid:`) images

`multipart/related` parts referenced by `cid:` are legitimate and must render offline.
Because the frame has an opaque origin, `blob:` will not work — inline as `data:`:

- Accept only `image/{png,jpeg,gif,webp,bmp,svg+xml→NO}`. **SVG is never inlined** — it
  is a scriptable document format, and `img-src data:` with an SVG payload is a real
  historical XSS vector in some engines. An `image/svg+xml` inline part renders as a
  placeholder with *"inline SVG images are not displayed"*.
- Verify the bytes with `infer` and use the **sniffed** type in the data URI, not the
  declared one.
- Per-message inline budget: 10 MB total, 2 MB per image, 50 images. Over budget →
  placeholder.
- A `cid:` with no matching part → the `<img>` is dropped entirely (not left with a
  broken `src`).
- The `Content-ID` match is exact after stripping `<`/`>`; no fuzzy matching.

### 2.8 WebKitGTK vs WebView2 — the differences that matter here

| Behaviour | WebKitGTK 4.1 (Linux) | WebView2 (Windows) | Consequence for this design |
|---|---|---|---|
| `csp=` iframe attribute (CSP Embedded Enforcement) | **Not implemented** | Implemented | **Never use it.** Policy goes in an inline `<meta>`, which both honour. |
| CSP inheritance into `about:srcdoc` | Historically inconsistent | Inherits | Don't rely on inheritance; state the policy inline. Treat inheritance as a bonus. |
| `sandbox` attribute tokens | Supported | Supported | `sandbox=""` behaves identically. This is the one control we can rely on equally. |
| Opaque-origin `blob:` loads | Blocked | Blocked | Consistent — hence `data:` for inline images on both. |
| `srcdoc` with multi-MB content | Works; attribute parsing is the cost | Works | Set `srcdoc` via the **DOM property** on a ref rather than as a React attribute for bodies > ~256 KB, to avoid re-serializing the string through React's attribute path on every render. Memoize the doc string. |
| Very large / deeply nested DOM | WebKitGTK is the slower of the two; a 100k-node body can jank the whole GTK main loop, which is the *same* loop Tabtivity's UI runs on | Runs the frame off-process | Enforce the backend node cap (§3.6) — it is a **Linux responsiveness** requirement, not only a security one. |
| Default scrollbars inside web content | Ignores page `scrollbar-color`; Tabtivity already injects a GTK CSS provider to recolor them (`webkit2gtk` + `gtk` deps) | N/A | The message frame inherits that existing treatment; nothing new needed. |
| Text selection / context menu inside a sandboxed frame | Available | Available | Provide our own context menu suppression only if the default exposes "Open link" — with no `href` present it does not. Verify by inspection, not by launching. |
| `-webkit-` CSS that can fetch (`-webkit-image-set`, `cursor: url()`) | Present | Present-ish | Vendor-prefixed properties are not on the CSS allowlist; `img-src data:` blocks the fetch regardless. |
| Printing a message | `window.print` in a sandboxed frame is unavailable | Same | Printing routes through the existing `printHtmlBody` path in `src/lib/viewers/print.ts` with the **sanitized** HTML — and that path uses a same-origin srcdoc frame, so it must re-apply the same restrictions. Flag as a follow-up; v1 can omit message printing. |

---

## 3. Attachments and the file boundary

**The boundary rule, stated once:** *the only bytes that cross from mail into the user's
filesystem are bytes the user selected in an OS-native dialog, one file at a time; and
the only bytes that cross from the filesystem into mail are files the user selected in an
OS-native dialog.* Everything in this section implements that sentence.

### 3.1 Inbound: nothing is auto-written

- Attachment **metadata** is parsed and stored at sync time; **payloads are fetched
  lazily** on first view/save (`FETCH BODY.PEEK[<part>]`) unless the message is under the
  "download full message" size threshold.
- Payloads are written to the mail store only (`§5`), never to `~/Downloads`, never to a
  temp dir, never next to a project.
- Blob filenames are **content-addressed and opaque**: `blobs/<sha256-hex>` with no
  extension. The sender-supplied name lives only as a *column in SQLite* and as a *label
  in the UI*. Consequence: a filename attack has no filesystem to attack — the name
  never reaches a syscall.
- Store directory is created `0o700` on Unix (mirror `services::ssh_common`'s existing
  `set_permissions(from_mode(0o700))` pattern).
- **No preview auto-renders an attachment.** Images/PDFs get a preview only on explicit
  click, and PDFs go through the existing in-app `PdfViewer` (pdf.js, already sandboxed
  by being our own canvas rendering) — never the OS PDF handler.

### 3.2 Saving: one native dialog per file

- The Save action calls `@tauri-apps/plugin-dialog`'s `save({ defaultPath: safeName })`
  and writes to exactly the path it returns.
- **No "Save all attachments".** No directory-target bulk export. If a message has eight
  attachments, saving them is eight dialogs. This is deliberate friction at the exact
  point where the boundary is crossed, and it is the difference between "the user
  exported three files" and "a message wrote eight files somewhere".
- No drag-out of attachments in v1 (Tabtivity has `tauri-plugin-drag` for file drag-out;
  wiring it to attachments would be a silent multi-file export path — defer, and if
  added later, gate it behind the same per-file confirm).
- The write is a plain `fs::write` of the already-decoded blob to the dialog's path. We
  do not create directories, do not follow the name, do not append.

### 3.3 `sanitize_attachment_name()` — the exact rules

One function, in `src-tauri/src/services/mail/filename.rs`, returning
`SafeName { value: String, changed: bool, reason: Option<&'static str> }`. Applied to
**every** filename: the save-dialog default, the UI label, the export list, everywhere.

Rules, in order:

1. **Decode first.** `mail-parser` has already done RFC 2047 / RFC 2231 decoding and
   percent-decoding of `filename*`. Operate on the decoded string. *(Sanitizing before
   decoding is the classic bypass — `%2e%2e%2f`.)*
2. **Normalize to NFC.** Prevents decomposed sequences that render as one thing and
   compare as another.
3. **Take the last path component**, splitting on **both** `/` and `\` (a Unix host must
   still defend against `..\..\`), and on `:` when the segment matches a Windows drive
   or ADS pattern (`C:`, `file.txt:zone`). Then, if the remainder is exactly `.` or `..`
   or empty, it becomes `attachment`.
4. **Strip C0/C1 controls**: `U+0000`–`U+001F`, `U+007F`–`U+009F`.
5. **Strip bidi and invisible formatting**: `U+200E U+200F U+202A U+202B U+202C U+202D
   U+202E U+2066 U+2067 U+2068 U+2069 U+061C U+00AD U+FEFF U+200B U+200C U+200D
   U+2060 U+180E`. *This is the `invoice\u202Egnp.exe` → displays as `invoicexe.png`
   attack; a test fixture asserts no character from this set survives.*
6. **Replace Windows-illegal characters** `< > : " | ? *` with `_`.
7. **Windows reserved device names**: if the name **before the first dot**, uppercased
   and trailing-space-trimmed, is one of `CON PRN AUX NUL COM1..COM9 COM¹ COM² COM³
   LPT1..LPT9 CONIN$ CONOUT$`, prefix with `_`. (Match with or without an extension —
   `CON.txt` is still the device.)
8. **Strip trailing dots and spaces** (Windows silently strips them, so `evil.exe. ` and
   `evil.exe` are the same file to the OS but not to a naïve extension check).
9. **Leading `-` → prefix `_`** (a saved file whose name starts with `-` becomes an
   argv flag to any tool the user later runs on it).
10. **Leading `.` → prefix `_`** (no silently-hidden files).
11. **Collapse runs of whitespace to a single space; trim.**
12. **If empty after all of the above → `attachment`.**
13. **Truncate to 200 bytes**, on a UTF-8 char boundary, **preserving the extension**:
    keep the last `.`+ext (max 16 bytes) and truncate the stem. Filesystem limits are
    255 bytes; 200 leaves room for the OS dialog's `(1)` disambiguation.

`changed: true` whenever the output differs from the input; the UI then shows the
original name struck through beside the safe one and the tooltip *"renamed for safety"*.
**Never silently rename** — a user who cannot see that a name was altered cannot notice
that it was hostile.

### 3.4 No auto-execution, ever

- There is **no** "open attachment" that hands a path to the OS by default. The only
  in-app open is a preview by our own viewers (image, PDF via pdf.js, text/markdown via
  the existing viewers, with the same escape-first rules).
- If an *"Open with system default"* action is added, it must: (a) require the file to
  be saved first via §3.2, (b) require a second confirm naming the resolved extension,
  and (c) be **hard-refused** for a deny-list, checked against the *sanitized* name's
  final extension, case-insensitively:
  `exe com scr pif bat cmd msi msp cpl hta js jse vbs vbe wsf wsh ps1 psm1 sh bash zsh
  jar apk app dmg pkg lnk url scf reg inf desktop appref-ms library-ms gadget chm
  msc ade adp mde mdb`
  — and for any name with **two extensions** where the *last* is in that list.
- HTML attachments (`.htm/.html/.xhtml/.svg/.mht/.mhtml`) are previewed only inside the
  same `sandbox=""` frame with the same sanitization, never opened externally.

### 3.5 MIME-type-vs-extension mismatch

Three signals per attachment: **declared** (`Content-Type`), **sniffed**
(`infer::get(&bytes[..8192])`), **implied** (`mime_guess::from_path(safe_name)`).

Surface a warning when:
- sniffed ≠ declared at the top-level type (e.g. declared `image/png`, sniffed
  `application/x-msdownload`);
- sniffed indicates an executable format at all — `MZ` (PE), `\x7fELF`, Mach-O magics,
  `#!` at offset 0, Java `.class`/`PK` with `META-INF/MANIFEST.MF` — **regardless of
  declaration or extension**. This is the strongest single signal and gets its own
  loud banner: *"This attachment is a program."*
- implied ≠ sniffed (extension lies about content);
- the name has a double extension whose last component is in the §3.4 deny-list.

The warning is a persistent banner on the attachment row, not a dismissible toast.

### 3.6 Size limits and decompression-bomb guards

| Limit | Value | Enforced where |
|---|---|---|
| Raw message accepted from `FETCH` | 50 MB | before handing to `mail-parser` |
| MIME nesting depth | 32 | a wrapper walk over `mail-parser`'s tree, before body extraction |
| MIME part count | 512 | same |
| Single header line | 64 KB | pre-parse scan |
| Total header block | 1 MB | pre-parse scan |
| Single attachment | 100 MB | at fetch |
| Body HTML input to sanitizer | 5 MB | pre-sanitize |
| Sanitized output node count | 20 000 elements | post-sanitize count; over → truncate with a banner (WebKitGTK responsiveness, §2.8) |
| Inline images total / each / count | 10 MB / 2 MB / 50 | §2.7 |
| Remote images total / each / count | 20 MB / 5 MB / 50 | §2.6 |
| Outbound message total | 25 MB | compose, with a pre-send warning |
| IMAP literal per FETCH chunk | 25 MB | transport |
| Parse wall-clock | 5 s per message, on `spawn_blocking` | a watchdog that logs and marks the message unrenderable |

**Compression channels, enumerated:**
- **IMAP `COMPRESS=DEFLATE`** is the only server-controlled compression stream. The
  `async-imap` `compress` feature is **deliberately not enabled**, and a comment in
  `Cargo.toml` says why. If it is ever enabled, it needs an output-byte cap per read.
- **MIME transfer encodings** (base64, quoted-printable) *shrink*; no bomb.
- **Archive attachments** are never auto-extracted by mail.
- **Existing gap to fix, in scope for this feature:** `commands::fs::extract_archive`
  correctly handles path traversal (`ZipFile::enclosed_name` + `enforce_confinement`)
  but has **no total-size or expansion-ratio cap**, so a 42 KB zip bomb extracted
  through the file tree fills the disk. Since mail makes it far likelier that a hostile
  zip reaches that function, add: total uncompressed budget 2 GB, per-entry budget
  512 MB, entry count 10 000, and a per-entry compression-ratio cap of 200:1 measured
  on the bytes actually copied (`std::io::copy` into a counting writer that errors
  past the budget — do **not** trust the header's declared size). Unit-test with a
  synthetic high-ratio archive built in the test.

### 3.7 Outbound attachments: the same rigor, reversed

- The only way to attach is `@tauri-apps/plugin-dialog`'s `open({ multiple: true,
  directory: false })`. **No directory attach, no glob, no drag-and-drop-a-folder, no
  "attach the file I'm looking at", no clipboard-path attach.**
- Note the app window sets `"dragDropEnabled": false`; do not enable it for compose.
- Every picked path is read once at **send time**, not at attach time (so a file is not
  held open, and the bytes sent are the bytes at send).
- The MIME `filename` parameter carries **only the basename**, run through
  `sanitize_attachment_name()`. `/home/<user>/work/secret-project/notes.pdf` must never
  leave as a path — that is a directory-structure disclosure and a username leak.
- Attachment list shows the full local path in the composer (so the user can see what
  they're about to send) but the sent header shows only the basename; the composer
  states this.
- 25 MB total cap with an explicit warning; per-file 20 MB.
- Symlinks are resolved and the **target's** metadata is what's shown; a symlink outside
  the user's home gets a note. (We don't refuse it — the user picked it — we make it
  visible.)
- No auto-attach of anything, ever: no "last screenshot", no "current file", no
  "project archive".

---

## 4. Transport security

### 4.1 Implicit TLS only in v1

| Protocol | Port | Mode |
|---|---|---|
| IMAP | **993** | implicit TLS (IMAPS) |
| SMTP | **465** | implicit TLS (SMTPS, RFC 8314) |

STARTTLS on 143/587 is **not implemented in v1**. Rationale: implicit TLS has no
cleartext phase, so there is nothing for an active attacker to strip and no
pre-handshake data to inject. RFC 8314 already recommends implicit TLS as the preferred
submission/access mechanism, and every provider worth supporting offers 993/465.

When STARTTLS is added (v1.1, for the servers that genuinely only offer 587):
- It is **required, never opportunistic**. If `STARTTLS` is absent from the capability
  list, or the `STARTTLS` command fails, the connection is **closed** — never continued
  in cleartext. There is no setting that changes this.
- The capability list is **re-read after the handshake**, and the pre-TLS capability list
  is discarded. Anything the server sent before `STARTTLS` is not carried forward.
- The receive buffer is **explicitly drained and asserted empty** immediately before the
  TLS handshake begins. Bytes pipelined after `STARTTLS` and before the handshake are the
  STARTTLS command-injection bug (CVE-2011-0411 and its long tail); an assertion that the
  buffer is empty turns it into a hard error.
- Credentials are sent only after the handshake, and only after re-reading capabilities.

### 4.2 TLS parameters

```rust
// One config, built once, shared by IMAP and SMTP.
fn tls_config() -> Arc<rustls::ClientConfig> {
    // rustls 0.23 defaults: TLS 1.3 + 1.2 only (no 1.0/1.1 exist in the crate at all),
    // no renegotiation, no compression, no session resumption to a different host.
    // Restricting further to 1.3-only would break too many still-current servers.
    ClientConfig::builder_with_protocol_versions(&[&rustls::version::TLS13,
                                                   &rustls::version::TLS12])
        .with_platform_verifier()   // rustls-platform-verifier: the OS trust store
        .with_no_client_auth()
}
```

- Minimum **TLS 1.2**. rustls 0.23 does not implement TLS 1.0/1.1, so "minimum 1.2" is
  structural rather than a setting that could be misconfigured.
- **Hostname verification always on**, against the *configured* hostname. `ServerName`
  is built with `ServerName::try_from(host)`; an IP-literal host is accepted only if the
  certificate has a matching IP SAN (rustls handles this) — we never disable it, and we
  never verify against an IP we resolved ourselves.
- **SNI always sent.**
- No custom cipher suite list — rustls's defaults are the right answer and hand-picking
  suites is how you end up with a stale list.

### 4.3 Certificate validation — no escape hatch

**There is no "accept this certificate anyway" control in Tabtivity's mail client. Not
hidden, not behind a setting, not behind a dev flag.**

This is enforceable rather than aspirational because of the trust-store choice: using
`rustls-platform-verifier` means we validate against the **OS trust store**. A user with
a self-hosted server using a private CA, or an organization with an internal CA, adds
that CA **once, to their operating system**, through the mechanism their OS already has
— and every application including this one then trusts it. That is strictly better than
a per-app exception: it is auditable, revocable, and managed by whoever is supposed to
manage it. Removing the escape hatch does not remove the capability; it moves it to the
right layer.

A CI check (a Rust test that scans the mail module's own sources) asserts that the
strings `dangerous`, `ServerCertVerifier`, `danger_accept_invalid`, and
`with_custom_certificate_verifier` do not appear anywhere under
`src-tauri/src/services/mail/`. Cheap, and it makes "just add a checkbox" a failing
test rather than a code review argument.

**Error presentation.** A validation failure must say *what* failed, in the user's
language, because "certificate error" produces exactly the pressure that creates
override buttons:
- *hostname mismatch* → "The server presented a certificate for `<cert name>`, but you
  connected to `<host>`. Check the server address for a typo."
- *unknown issuer* → "This server's certificate is signed by an authority your system
  doesn't trust. If this is a private server, install its certificate authority in your
  operating system's trust store."
- *expired / not yet valid* → "…expired on `<date>`. This is usually the server
  administrator's problem, not yours."
- *revoked* → "…has been revoked. Do not enter your password."

### 4.4 First-contact and subsequent certificate changes

Because trust is CA-based, not TOFU, there is no first-contact prompt — a valid chain is
accepted silently and an invalid one is refused without an override. That is the correct
default and it differs deliberately from Tabtivity's SSH `guard_first_contact` (SSH has no
CA infrastructure, so TOFU is the only option there; mail does not have that excuse).

We nonetheless **record**, on each account's first successful connect, the SHA-256 of the
server certificate's **SPKI** and the issuer's subject DN, in the mail store. On later
connects:
- SPKI unchanged → nothing.
- SPKI changed, **issuer unchanged** → nothing (this is ordinary renewal, including
  every 60–90 day ACME rotation; alerting here would train users to click through).
- SPKI changed **and issuer changed** → a **non-blocking, dismissible** banner:
  *"This server's certificate is now issued by `<new issuer>` instead of `<old issuer>`.
  This is normal if your provider changed certificate authorities."* The connection
  proceeds — the chain is valid, and a hard block on a legitimate CA migration would
  strand users with no remedy.

Advisory-only is the right call for v1. Hard pinning is a Phase-2 feature that needs an
un-pin path, and an un-pin path is an escape hatch by another name.

### 4.5 Authentication mechanisms

- Allowed: `PLAIN`, `LOGIN` — **only over an established, verified TLS channel** (which
  is the only kind of channel that exists, per §4.1).
- **Refused: `CRAM-MD5`, `DIGEST-MD5`, `NTLM`, `GSSAPI`, `APOP`, `LOGIN` pre-TLS.**
  This is why `mail-send` is built with `default-features = false` (its defaults enable
  `digest-md5` and `cram-md5`). These mechanisms are weak *and* their availability gives
  an active attacker a mechanism-downgrade target; since TLS already authenticates the
  server and protects the password, a challenge-response mechanism buys nothing.
- `XOAUTH2` is added in Phase 2 as an additional allowed mechanism, never as a fallback.
- The mechanism is **chosen by us from the post-TLS capability list**, not negotiated
  down by the server. If neither `PLAIN` nor `LOGIN` is offered post-TLS, we fail with
  *"This server doesn't offer a password mechanism Tabtivity supports; it may require OAuth"*
  — which is the honest message for Outlook.com.
- On `AUTHENTICATIONFAILED`, **do not retry**. One attempt per user action. A retry loop
  against a provider lockout policy is how accounts get locked, and it is also how a
  saved-credential bug becomes a lockout (Tabtivity already learned this from
  `remote_credentials`).

### 4.6 Timeouts, and the reason every one of them exists

Every network operation is wrapped in `tokio::time::timeout`. An operation without a
timeout is an operation that can wedge a background task forever — the same class of bug
as the locked-keychain hang documented in `docs/context/remote_credentials.md`.

| Operation | Bound |
|---|---|
| TCP connect | 15 s |
| TLS handshake | 15 s |
| IMAP greeting | 15 s |
| Any IMAP command | 60 s |
| `FETCH` of a large body | 300 s |
| SMTP session (whole) | 300 s |
| IDLE re-issue | 25 min (RFC 2177's 29-minute guidance, with margin) |
| Reconnect backoff | 5 s → 5 min, exponential with full jitter, and **it stops** after 10 consecutive failures until a user action |

---

## 5. Data at rest

### 5.1 Layout

```
~/.local/share/tabtivity/               (storage::state_dir(), existing)
└── mail/                            0700 on Unix
    ├── mail.db                      SQLite (rusqlite, already a dependency)
    └── <account-id>/
        └── blobs/
            └── <sha256-hex>         raw MIME parts, opaque names, no extensions
```

`mail.db` schema (all with a `schema_version` row, migrated forward like any other
Tabtivity store):

- `accounts` — id, display label, email address, IMAP/SMTP host+port, auth method,
  `remember_password: bool`, TLS pin (SPKI hash + issuer DN), sync settings.
  **No secret of any kind.**
- `folders` — account, name, UIDVALIDITY, UIDNEXT, HIGHESTMODSEQ, unread/total counts.
- `messages` — account, folder, UID, `Message-ID`, `In-Reply-To`, `References`,
  `From`/`To`/`Cc` (both display name and addr-spec, stored separately), `Subject`,
  `Date`, `Reply-To`, flags, size, `has_attachments`, `body_blob` (sha256 of the raw
  MIME), plus a `malformed_headers` bitfield (duplicate `From:`, 8-bit headers, etc.)
  so the UI can flag T7 without re-parsing.
- `bodies_cache` — message, the **sanitized** HTML and the plain-text alternative. Cached
  because sanitization is the expensive step; **invalidated wholesale on any change to
  the sanitizer's version constant**, so a sanitizer fix retroactively protects already-
  synced mail. That version constant is a `const SANITIZER_VERSION: u32` bumped by hand,
  and a code comment says bumping it is mandatory for any sanitizer change.
- `attachments` — message, MIME part id, declared type, sniffed type, declared name,
  sanitized name, size, blob sha256.
- `mail_remote_allow` — addr-specs allowed to load remote content (§2.6).

### 5.2 Encryption: deliberately none in v1

**Recommendation: do not encrypt the message store in v1.** Reasoning, stated plainly so
it can be argued with rather than assumed:

- This is what the reference clients do. Thunderbird's mbox/maildir, Evolution's cache,
  and Apple Mail's `.emlx` files are all plaintext on disk; they rely on the OS's
  full-disk encryption and file permissions. "As safe as common mail programs" is the
  bar, and this is where that bar is.
- The threat encryption addresses is *offline access to the disk*. Against that,
  FileVault / BitLocker / LUKS is the correct and complete answer, and it protects the
  rest of the user's data too. An app-level encrypted mailbox on an unencrypted disk
  next to unencrypted SSH keys, project files, and `~/.local/share/tabtivity/*.json` is
  security theatre.
- The key would have to live somewhere. The only sensible place is the OS keychain — and
  **Tabtivity has a documented, painful hazard exactly there**: a locked Secret Service
  collection reads identically to an empty one, and reads against it used to hang
  forever (`docs/context/remote_credentials.md`). Making the *entire mailbox* unreadable
  when the keychain is locked is a strictly worse user-facing failure than an unencrypted
  cache on a session the user has already unlocked. We would be trading a threat the OS
  already handles for an availability failure we know we have.

**What we do instead, and must do:**
- `0700` on `mail/` and `0600` on `mail.db` and every blob (Unix). On Windows, inherit
  the per-user profile ACL (`%LOCALAPPDATA%` is already user-scoped).
- The account-setup UI states, in plain language: *"Messages are stored unencrypted in
  your user profile, like Thunderbird and Apple Mail. Use your operating system's disk
  encryption to protect them."*
- A **"Delete local mail for this account"** action that removes the rows and the blob
  directory, offered on account removal and available independently.
- **Phase 2, opt-in:** SQLCipher (rusqlite has a `sqlcipher` feature) or an age-encrypted
  blob store, keyed by a **user-entered passphrase prompted at unlock time** — explicitly
  *not* keychain-derived, precisely to avoid the locked-keychain failure. Opt-in, with
  the trade-off ("you will be asked for this passphrase every time Tabtivity starts")
  stated up front.

### 5.3 Credentials

- **Passwords are not persisted by default.** The account dialog's "Save password"
  checkbox is **unchecked by default**, matching `docs/context/remote_credentials.md`'s
  rule for every other credential in the app.
- Storage is the OS keychain via **`services::remote_credentials`** — the existing
  module, not a new one. Account keys: `mail:imap:{user}@{host}:{port}` and
  `mail:smtp:{user}@{host}:{port}` (separate, because they are separate credentials even
  when they usually match). Follow the existing convention that the **backend owns the
  account-string spelling** and the frontend never mints one.
- This gets us, for free and already tested: the 4-second `read_timed` bound, the
  `cached_keyring_state()` short-circuit that refuses to dispatch to a locked collection,
  and the Linux `keyutils_persistent` cache that makes all but the first read per boot a
  non-blocking syscall.
- **The locked-keychain rules apply verbatim:**
  - A locked collection must render as *"Keyring locked — unlock to use the saved
    password"* with an **Unlock keyring** button (`keyring_unlock`, already a command),
    **never** as "no password saved".
  - **`false` must be unrepresentable** on the remember flag. Use the existing
    `rememberArg(checked) → true | null` helper and the `Remember` enum; clearing a
    credential happens **only** through an explicit "Forget saved password" action. The
    bug this prevents is documented and real: an async keychain read that hasn't landed
    yet sends `false`, which deletes the password it just authenticated with.
  - **An unreadable store is never licence to delete** — reuse `remember_secret`'s
    existing guard.
  - A failed write must surface (`{ saved, save_error }`), never `let _ = set(...)`.
  - No keychain read on any **launch path**. Account sync at startup uses a saved
    password only if `cached_keyring_state()` already says unlocked; otherwise the
    account shows a red lamp and connects on the user's click. Launch paths promise not
    to prompt, and that promise is load-bearing.
- **The password never enters the frontend.** The compose/setup dialog sends it once, to
  the backend, in the `mail_account_add` / `mail_connect` call; it is never returned,
  never echoed in an event, never in an error string. Follow the
  `credential_paste_to_pty` precedent — the backend is where secrets live.
- In memory: `Zeroizing<String>` (via the `zeroize` dep), with a hand-written `Debug`
  impl printing `Password(<redacted>)`. A unit test asserts
  `format!("{:?}", pw)` contains neither the value nor any substring of it.

---

## 5.4 Sender authentication: `Authentication-Results` (added after v1)

PGP/S-MIME stays deferred (§6), but the *practical* authenticity question — "did
this really come from the domain it claims?" — is already answered in every
message by the receiving MTA, in an `Authentication-Results` header (RFC 8601).
Reading it costs a header parse and no crypto, and it is what §6's PGP row is
mostly wanted for. Implementation: `services::mail_authres`.

**The header is ordinary message text.** Anyone can write one; a phisher writes
`dmarc=pass` and hopes. Two rules are what make reading it worth anything, and
neither is optional:

1. **Only the topmost instance is read.** Headers are prepended, so the top one
   was written by the last MTA to touch the message — yours.
2. **Only if its `authserv-id` matches the id configured on the account**
   (`MailAccount.authserv_id`, unset by default). Rule 1 identifies a *position*,
   not an author: if your server adds no header, the sender's forgery *is* the
   topmost one.

With no configured id the state is `unconfigured` and **no verdict is shown**.
That is deliberate and is the whole posture: a tick nobody checked is worse than
no tick, because it trains the user to believe something an attacker can draw.

**Alignment is shown, never folded away.** `dkim=pass header.d=evil.example` on a
message claiming to be from a bank is a *real* pass by the wrong signer — the
most common way these headers are misread. Every clause therefore carries its
identifier and an `aligned` flag against the visible `From`, and an unaligned
pass is toned as a warning on both sides of the IPC boundary.

**The residual risk, stated rather than glossed:** if the provider adds no header
and an attacker forges one bearing that provider's `authserv-id`, this believes
it. No client can distinguish those cases — RFC 8601 §5 puts the duty to strip
forged instances on the receiving MTA. Hence the setting's help text says to take
the id from a message known to be genuine, and hence the trust state is disclosed
in the UI instead of being reduced to a bare tick.

Tests: `services::mail_authres` (24, incl. comment stripping, an equality-not-
suffix id match, a forged header below a genuine one, and a totality fuzz),
`commands::mail` (5, the serve-boundary rule incl. a deleted account),
`tests/mail_hostile_message.rs` (the fixture forges its own all-pass header), and
`src/__tests__/MailAuthDisplay.test.ts` (15, the display rules).

---

## 6. Explicitly out of scope for v1

Each entry says what a later phase would need, so "out of scope" is a plan rather than a
refusal.

| Deferred | Why | What a later phase needs |
|---|---|---|
| **PGP / S-MIME** | Cryptographic UI is the one place where a *half*-implementation is worse than none: a green checkmark that means "the bytes were signed by some key" while the user reads it as "this is really from my bank" is a new attack, not a mitigation. Key discovery, trust models, expiry, revocation, and the sign-vs-encrypt distinction are each their own design problem. | `rpgp` (pure-Rust OpenPGP) or `cms`/`x509-cert` for S-MIME; a key store with its own at-rest story; WKD/Autocrypt discovery; a verification UI that distinguishes *valid signature* from *key I have a reason to trust*; a decryption path that never writes plaintext to the cache in §5. |
| **Calendar / iCalendar invites** | `text/calendar` is another untrusted-input parser, and RSVP is an *outbound side effect triggered by attacker-controlled content* (T19). Tabtivity already has a calendar, which makes the integration tempting and therefore exactly the thing that needs a deliberate design pass rather than a quick wire-up. | An iCalendar parser with the same fixture discipline as §7.2; an RSVP flow where every send is an explicit click; a rule that an invite never mutates the local calendar without confirmation; free/busy left out. |
| **Contacts / CardDAV sync** | A second protocol, a second auth surface, a second credential in the keychain, and a second store — for a convenience feature. | A CardDAV client, a contacts store, and a decision about whether a contact's presence is ever used as a trust signal (it must not be — "known sender" is a phishing amplifier). |
| **HTML compose editor** | Composing HTML means *generating* HTML that other clients must trust, plus an outbound sanitization problem, plus a rich-text editor. Plain-text compose sidesteps all of it and is what a developer tool's users mostly want anyway. | A constrained editor emitting a small, fixed subset; outbound sanitization; a `multipart/alternative` builder; and a quoting scheme that can't be used to smuggle markup into the recipient. |
| **Threading beyond `References` / `In-Reply-To`** | Subject-based ("Jamie Zawinski") threading merges unrelated conversations, and — worse — **any threading is spoofable**: an attacker sets `References` to a header they observed and their mail appears inside a trusted thread. | If added: keep threading a *display* grouping only, never a trust signal; never render "part of your conversation with X" as provenance; consider showing a marker when a message joins a thread from a sender not otherwise in it. |
| **OAuth2 / XOAUTH2** | §0.4 — CASA Tier 2, annual re-audit, US$540–1,000/yr, 4–12 week lead time, and an embedded client identifier in a public repo. | The `MailAuth::XOauth2` variant already stubbed in v1; a loopback listener with PKCE; refresh-token storage under the same keychain rules; per-provider registration. |
| **Server-side search, IMAP NOTIFY, QRESYNC, multiple identities per account, filters/rules, drafts sync, message printing, attachment drag-out** | Each is real work with no security content; they compete with getting §§1–5 right. | Ordinary feature work once the security core is settled. |
| **One-click `List-Unsubscribe-Post`, read receipts (MDN), auto-download of full mailboxes** | These are not "deferred", they are **rejected**: each is an outbound action or a network fetch triggered by attacker-controlled headers (T19). | Nothing. MDN requests are ignored permanently and are not a setting. |

---

## 7. Security test checklist

All Rust tests run under `cargo test --manifest-path src-tauri/Cargo.toml`; all TS tests
under `npm test` (vitest, already configured with jsdom). **The two acceptance gates are
`npx tsc --noEmit` and `cargo test`** — the vitest suite is additionally expected to pass
but is not a gate per the project constraint.

Fixtures live in `src-tauri/tests/fixtures/mail/`. Every fixture uses only
`example.com` / `example.org` / `evil.example` style domains — **no real institution or
provider hostnames**, since the repo is public.

### 7.1 Sanitizer fixtures — `services::mail::sanitize` (table-driven)

A single `#[test] fn sanitizer_fixtures()` over `&[(name, input, &[must_not_contain])]`,
plus a blanket assertion applied to **every** case's output:

```rust
const FORBIDDEN_IN_ANY_OUTPUT: &[&str] = &[
    "<script", "</script", "javascript:", "onerror", "onload", "onclick", "onfocus",
    "onmouseover", "href=", "src=http", "src='http", "src=\"http", "srcset",
    "<style", "<iframe", "<object", "<embed", "<form", "<input", "<base",
    "<meta", "<link", "<svg", "<math", "<template", "<noscript", "<audio",
    "<video", "<source", "background=", "@import", "expression(", "url(",
    "vbscript:", "data:text/html", "<!--",
];
```

Cases (each named, each asserted individually as well as by the blanket rule):

1. `<script>alert(1)</script>` → no script, **and no `alert(1)` text** (content removed).
2. `<img src=x onerror=alert(1)>` → `<img>` with no `src`, no `onerror`.
3. `<a href="javascript:alert(1)">click</a>` → `<a data-lid="0">click</a>`; link table
   records the URL with `NON_WEB_SCHEME`, and the UI must not offer *Open*.
4. `<a href="&#106;avascript:alert(1)">` — entity-encoded scheme.
5. `<a href="  &#x0A;javascript:alert(1)">` — leading whitespace + newline entity.
6. `<a href="jav&#x09;ascript:alert(1)">` — tab inside the scheme.
7. `<svg><script>alert(1)</script></svg>` — namespace confusion.
8. `<math><mtext><table><mglyph><style><!--</style><img src onerror=alert(1)>` — the
   canonical mXSS payload.
9. `<noscript><p title="</noscript><img src=x onerror=alert(1)>">` — mXSS via noscript.
10. `<style>@import url(https://evil.example/x.css)</style>` → nothing survives.
11. `<div style="background:url(https://evil.example/pixel.gif)">x</div>` → the `style`
    attribute survives with the declaration removed, or is removed entirely.
12. `<div style="position:fixed;top:0;left:0;width:100%;height:100%;z-index:9999">` →
    no `position`, no `top`/`left`, no `z-index`.
13. `<div style="width:100px;color:red">` → **both survive** (positive control — the
    filter must not be a blanket strip).
14. `<base href="https://evil.example/">`.
15. `<meta http-equiv="refresh" content="0;url=https://evil.example">`.
16. `<form action="https://evil.example"><input name=p type=password></form>`.
17. `<iframe src="https://evil.example">`, `<object data=…>`, `<embed src=…>`.
18. `<img srcset="https://evil.example/a 1x, https://evil.example/b 2x">`.
19. `<body background="https://evil.example/p.gif">`.
20. `<link rel=stylesheet href="https://evil.example/s.css">`.
21. `<input type=image src="https://evil.example/p.gif">`.
22. `<video poster="https://evil.example/p.gif"><source src="…"></video>`.
23. `<a href="https://ok.example" target="_top" rel="opener" download="x.exe">t</a>` →
    only `data-lid` survives.
24. `<scr\0ipt>alert(1)</scr\0ipt>` — NUL in a tag name.
25. `<![CDATA[<script>alert(1)</script>]]>`.
26. `<template><script>alert(1)</script></template>`.
27. `<div>` × 100 000 (unclosed) — must **return** within the 5 s bound and must not
    stack-overflow. (html5ever's tree builder is iterative; this test proves it and
    guards against a future recursive post-pass.)
28. A 6 MB body → rejected by the pre-sanitize size cap with a typed error, not OOM.
29. A body producing 50 000 elements → truncated to 20 000 with the truncation marker.
30. `cid:` present in `multipart/related` → `src` becomes `data:image/png;base64,…`.
31. `cid:` **not** present → the `<img>` is removed entirely (no broken `src`).
32. `Content-Type: image/svg+xml` inline part → placeholder, never a `data:` URI.
33. An inline part declared `image/png` whose bytes sniff as `application/x-msdownload`
    → not inlined.
34. **Idempotency:** for every case, `sanitize(sanitize(x).html) == sanitize(x).html`.
35. **Positive control:** a realistic newsletter-style HTML body → tables, colors, and
    text still present; assert on a few expected substrings so a regression that
    over-strips is caught too.

### 7.2 Hostile MIME fixtures — `services::mail::parse`

Each is an `.eml` file; each test asserts **no panic**, a bounded runtime, and the
specific expected outcome:

1. 64-level nested `message/rfc822` → `Err(MailError::TooDeep)`, no stack overflow.
2. 10 000 MIME parts → `Err(TooManyParts)`.
3. Truncated base64 / bad padding → part decodes lossily or is marked undecodable; never
   panics.
4. A single header line of 1 MB → `Err(HeaderTooLong)`.
5. RFC 2047 `=?x-unknown-charset?B?…?=` → falls back, does not panic.
6. RFC 2047 `=?utf-8?B?` whose payload is invalid UTF-8 → lossy, no panic.
7. Unterminated `multipart/*` boundary.
8. A boundary string that also appears in the body text.
9. `Content-Disposition: attachment; filename*=UTF-8''%2e%2e%2f%2e%2e%2fetc%2fpasswd`
   → `sanitize_attachment_name` yields `passwd`.
10. `filename="invoice\u{202E}gnp.exe"` → output contains no U+202E and does not end
    `.png`.
11. **Two `From:` headers** → `malformed_headers` has `DUPLICATE_FROM` set and the API
    returns both values (the UI must not silently pick one).
12. `From: "security@bank.example" <attacker@evil.example>` → the parsed display name and
    addr-spec are separate fields; a test asserts the UI-facing struct exposes the
    addr-spec unconditionally.
13. 8-bit bytes in a header value.
14. `Content-Type: text/html; charset=utf-7` with a `+ADw-script+AD4-` payload → the
    decoded output does **not** contain `<script`.
15. A message with no `Content-Type` at all, and one with `Content-Type:` empty.
16. A 60 MB message → rejected pre-parse.
17. A message whose only body part is `application/octet-stream` → renders as
    "no displayable content", not as raw bytes.
18. A `multipart/alternative` where the `text/plain` part is empty and the `text/html`
    part is hostile → the HTML path is still sanitized (i.e. the plain-text preference
    doesn't accidentally bypass sanitization when it falls through).

### 7.3 Filename sanitization — table-driven, `services::mail::filename`

| input | expected |
|---|---|
| `report.pdf` | `report.pdf`, `changed: false` |
| `../../etc/passwd` | `passwd` |
| `..\..\Windows\System32\evil.exe` | `evil.exe` |
| `/absolute/path/x.txt` | `x.txt` |
| `C:\Users\x\y.txt` | `y.txt` |
| `file.txt:hidden` | `file.txt` |
| `invoice\u{202E}gnp.exe` | contains no U+202E; does not end in `.png` |
| `\u{200E}\u{200F}\u{202A}\u{2066}` (only bidi controls) | `attachment` |
| `CON` | `_CON` |
| `con.txt` | `_con.txt` |
| `COM1.log` | `_COM1.log` |
| `AUX ` (trailing space) | `_AUX` |
| `.bashrc` | `_.bashrc` |
| `-rf` | `_-rf` |
| `--force.txt` | `_--force.txt` |
| `a\u{0000}b.txt` | `ab.txt` |
| `x\u{007F}\u{0009}y.txt` | `xy.txt` |
| `"quoted"<>|?*.txt` | `_quoted______.txt` (illegal chars → `_`) |
| `trailing...` | `trailing` |
| `trailing.  ` | `trailing` |
| `` (empty) | `attachment` |
| `.` | `attachment` |
| `..` | `attachment` |
| `   ` | `attachment` |
| 500 × `a` + `.pdf` | ≤ 200 bytes, still ends `.pdf` |
| 300 × `é` + `.pdf` | ≤ 200 bytes, valid UTF-8 (boundary-safe truncation), ends `.pdf` |
| `naïve café.txt` (NFD input) | NFC output, unchanged otherwise, `changed: true` |
| `photo.jpg.exe` | unchanged name, but the caller's mismatch check flags double-ext |

Plus a property test: for 10 000 random byte strings interpreted as lossy UTF-8, the
output always (a) is non-empty, (b) contains no `/`, `\`, NUL, or any char from the bidi
set, (c) is ≤ 200 bytes, (d) is valid UTF-8, and (e) is not a reserved device name.

### 7.4 Structural / anti-regression tests

These are cheap source scans that turn "don't do X" into a failing test. Put them in
`src-tauri/src/services/mail/mod.rs`'s test module and a matching vitest file.

1. **No cert-verification escape hatch** — `include_str!`/read every `.rs` under
   `services/mail/` and `commands/mail.rs`; assert none contains `dangerous`,
   `ServerCertVerifier`, `danger_accept_invalid`, `with_custom_certificate_verifier`,
   or `NoCertificateVerification`.
2. **No cleartext transport** — assert no mail source contains `TcpStream` being used
   for a protocol command (i.e. every protocol type is parameterized over
   `TlsStream<TcpStream>`); simplest testable form: assert the strings `:143`, `:110`,
   `:25`, `:587` do not appear as default ports in the provider presets.
3. **Sandbox tokens** (vitest) — read `MessageBody.tsx` as text; assert it contains
   `sandbox=""` and contains none of `allow-scripts`, `allow-same-origin`,
   `allow-top-navigation`, `allow-popups`, `allow-forms`, `allow-modals`,
   `allow-downloads`.
4. **No app-origin HTML injection** (vitest) — read every file under
   `src/components/mail/`; assert none contains `dangerouslySetInnerHTML`.
5. **The frame CSP is exactly one string** (vitest) — assert the built srcdoc's meta CSP
   equals the expected constant character-for-character, and that `img-src` is `data:`
   with no `http`/`https` anywhere in the policy.
6. **`SANITIZER_VERSION` is bumped** — a test that hashes the sanitizer's builder
   configuration and compares to a checked-in constant, failing with *"you changed the
   sanitizer; bump SANITIZER_VERSION so cached bodies are re-sanitized"*.
7. **Password redaction** — `assert!(!format!("{:?}", Password::new("hunter2")).contains("hunter2"))`.
8. **Remember flag** — a compile-fail-style test (or a type-level assertion) that the
   remember parameter cannot be `Some(false)`.

### 7.5 Link-safety tests (vitest + Rust)

Rust (`LinkInfo` construction):
- `https://bank.example@evil.example/login` → `USERINFO`, `host_ascii == "evil.example"`.
- Text `www.bank.example`, href `https://evil.example` → `TEXT_LOOKS_LIKE_URL |
  DOMAIN_MISMATCH`.
- Text `https://bank.example/x`, href `https://bank.example/y` → **no** mismatch (same
  registrable domain).
- `https://xn--80ak6aa92e.example/` → `IDN`; `host_unicode` renders the Cyrillic form and
  `host_ascii` keeps `xn--`.
- `https://аpple.example` (Cyrillic а) → `IDN | MIXED_SCRIPT`.
- `https://192.0.2.1/x` → `IP_HOST`.
- `https://login.secure.account.verify.evil.example/` → `LONG_SUBDOMAIN`.
- `file:///etc/passwd`, `data:text/html,…`, `smb://x/y` → `NON_WEB_SCHEME`; no *Open*
  affordance.

Vitest:
- `LinkConfirmDialog` renders the full URL with no ellipsis for a 600-char URL.
- Clicking *Open in browser* calls `open_external_url` with the URL **from the parent's
  table**, verified by passing a deliberately different URL in the click payload and
  asserting it is ignored.
- The Links panel auto-expands when any flag in the auto-expand set is present.

### 7.6 SSRF guard tests — `is_public_http_url()`

Reject: `http://127.0.0.1/`, `http://localhost/`, `http://[::1]/`,
`http://169.254.169.254/latest/meta-data/`, `http://10.1.2.3/`, `http://172.16.0.1/`,
`http://192.168.1.1/`, `http://100.64.0.1/`, `http://[fc00::1]/`, `http://[fe80::1]/`,
`http://0.0.0.0/`, `http://[::ffff:127.0.0.1]/`, `http://2130706433/`,
`http://0x7f000001/`, `http://017700000001/`, `file:///etc/passwd`,
`ftp://example.com/`, `http://user:pw@example.com/`, and a mock resolver where
`public.example` resolves to `10.0.0.1`.
Accept: `https://example.com/a.png`, `http://93.184.216.34/a.png` (documentation IP,
globally routable).
Redirect test: a public URL that 302s to `http://169.254.169.254/` is rejected at hop 2.

### 7.7 SMTP construction tests

- `build(subject: "hello\r\nBcc: evil@evil.example")` → the serialized message contains
  no `Bcc:` header and no bare CRLF inside the subject (folded or encoded).
- `build(to: ["a@example.com\nCc: b@evil.example"])` → address parsing rejects it.
- An attachment picked from `/home/tester/secret-project/notes.pdf` → the serialized
  `Content-Disposition` contains `filename="notes.pdf"` and **not** the directory.
- Total size over 25 MB → `Err(TooLarge)` before any network call.

### 7.8 Archive-extraction hardening tests (`commands::fs::extract_archive`)

- A synthetic archive with one entry whose uncompressed size exceeds the per-entry
  budget → `Err`, and the partially-written output is removed.
- A synthetic archive whose declared sizes are small but whose actual stream expands past
  the total budget → `Err` (proves the counting writer, not the header, is authoritative).
- 10 001 entries → `Err`.
- Existing traversal behaviour (`../`, absolute, drive-prefixed entries) still skipped —
  keep/extend the existing coverage.

### 7.9 Manual QA (cannot be unit-tested; do **not** launch Tabtivity to satisfy these —
they are for the user's own session after a rebuild)

- A real HTML newsletter renders legibly with images blocked and the count shown.
- "Load images once" loads them and the setting does not persist to the next message.
- A message with a 20-link footer opens the Links panel without jank on WebKitGTK.
- Saving an attachment produces exactly one dialog and one file.
- Pointing an account at a server with a self-signed cert fails with the "unknown issuer"
  message and offers no override anywhere in the UI.
- Locking the Secret Service (`gnome-keyring` lock) and restarting shows *"Keyring
  locked"* with an Unlock button, not *"no password saved"*, and does not hang the UI.

---

## 8. Suggested build order

Each step ends green on both gates.

1. **Deps + crypto provider** (§0.3) — add crates, install the rustls provider, one test.
2. **`filename.rs`** (§3.3) + its full table (§7.3). Pure function, no dependencies,
   maximum test value per line.
3. **`sanitize.rs`** (§2.3) + the fixture table (§7.1) + `SANITIZER_VERSION`.
4. **`parse.rs`** — mail-parser wrapper with the structural caps (§3.6) + hostile
   fixtures (§7.2). Still no network.
5. **`transport.rs`** — the rustls config, the IMAP/SMTP connectors, timeouts, mechanism
   allowlist (§4) + the local-rustls-server cert-rejection test + the structural scans
   (§7.4 items 1–2).
6. **`store.rs`** — SQLite schema, blob store, `0700` (§5.1).
7. **Credentials** — the `remote_credentials` account keys, the remember discipline (§5.3).
8. **Frontend read path** — `MessageBody.tsx` (the iframe + srcdoc, §2.2/§2.4),
   `MessageLinks` + `LinkConfirmDialog` (§2.5), attachment list + save (§3.1–3.2), plus
   the vitest structural tests (§7.4 items 3–5) and link tests (§7.5).
9. **Compose + send** (§3.7, §7.7).
10. **Remote-image proxy** (§2.6) + the SSRF table (§7.6).
11. **`extract_archive` hardening** (§3.6, §7.8) — independent of the rest; can land any
    time and should not block mail.
