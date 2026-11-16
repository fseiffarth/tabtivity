# Native Android app from the phone PWA — plan

Status: **plan only, 2026-11-15. Nothing here is built.** No TODO entry yet.
Reviewed 2026-11-15 by a Fable subagent against the code and the Android
documentation; its findings are folded in.
Access model this extends: `docs/context/mobile_access.md`; sidecar notes:
`docs/context/mobile_sidecar.md`; the multi-desktop plan it partly replaces on
Android: `docs/phone_multi_desktop_plan.md`; the voice plan whose step 11 it
absorbs: `docs/phone_voice_plan.md`.

## Why

The phone app is a PWA each desktop serves from its own private address. Four
things the user wants cannot be done by a PWA in Chrome:

1. **Voice with the screen off** — today the screen must stay on and the app
   in front (`docs/context/voice.md` "The phone's limits").
2. **Android Auto** — the car reads agent questions aloud and takes a spoken
   reply. Native apps only (`docs/phone_voice_plan.md`, step 11).
3. **Reply from the notification, notices on the tailnet only** — today every
   push crosses the browser vendor's relay (`push.rs`), and a notice can only
   be tapped open.
4. **Several desktops natively** — one app, a native switcher, notices from
   every paired desktop, without the iframe switcher and its push relay.

## Decided (user, 2026-11-14/15)

- **All four goals above are in scope.**
- **Kotlin shell + WebView, neutral bridge.** A small Kotlin app shows each
  desktop's own phone UI in a WebView on that desktop's own origin. The phone
  UI reaches the shell through one platform-neutral contract, so a later Swift
  shell for iOS implements the same contract and the web side is written once.
  Rejected: TWA (cannot listen with the screen off), Capacitor (expects a
  bundled UI; its core HTTP and cookie plugins are callable by any page in the
  view, which cuts across desktop isolation), Tauri Android (same WebView
  limits plus an NDK build, IPC exposed to a remote page), a Compose rewrite
  (every feature built twice).
- **A native iOS app is a future goal**, not part of this plan. Expect it to
  be harder: iOS allows no background connection for notices (Apple's push
  service with a sender key instead) and CarPlay needs an entitlement.
- **Distribution: a signed APK on GitHub Releases.** No Play Store, no
  F-Droid for now; both stay possible (the app has no Google libraries).
- **The agent's own words in a notice are a separate per-phone switch, off
  by default** ("Show the agent's answer in notifications"), clipped to a
  short excerpt. With it off a notice has no Reply and only opens the app.
- **Reply from a notification is a per-phone, per-desktop opt-in, off by
  default.** Off: the notice opens the app, behind the app's lock. On: Reply
  works behind the phone's screen lock, and in the car.
- **In the app an armed hands-free session survives the screen going off and
  another app coming in front.** It ends on Stop (in the app or its
  notification), on the stop command, or after 30 minutes without a
  recognized utterance. The app's screens still lock; only the voice session
  goes on. This replaces, for the app only, the voice plan's decision 4
  ("the page is hidden") and its answered question 2; the PWA keeps both.

Defaults taken from the planning (change them here if wrong):

- **The PWA stays supported on Android.** The app is optional; iOS has only
  the PWA. A phone may be paired as both (two devices).
- **The UI is never bundled in the APK.** The page always comes from the
  desktop (`MOBILE_ASSETS`), as `mobile_access.md` layer 1 requires. Same
  reason as the multi-desktop plan's "framed, not cross-origin".
- **Capability flags, never version compares.** The page asks the shell what
  it can do; a missing capability hides the feature. An older desktop in a
  newer app, and the reverse, both degrade instead of breaking.
- **Notices: the tailnet stream only.** No FCM (a sender key cannot live in a
  desktop app in a public repo). UnifiedPush is a later option, not built.
- **Reply exists only on a finished turn.** A permission, plan or select
  dialog never gets one: it opens the app. This matches the voice plan's
  decision 3 and holds in the car too. Reply is marked
  authentication-required, so a locked phone asks for its screen lock first.
- **No bearer secret at rest.** The notice service proves itself with a
  Keystore key on every connection, as sign-in does, instead of keeping a
  long-lived token (Phase 3).
- **Agent notices still need the desktop window.** The window finds the turn
  edge today; with no window only calendar notices arrive. A sidecar-side
  edge detector is under "Later".
- **Each desktop keeps its own lock** (its own PIN and biometric record).
  There is no app-wide lock in this plan.
- **A hosted server cannot be added as a desktop** in this plan (its pairing
  uses a redirect, and its notice stream is not served).
- **`minSdk` 31 (Android 12), `targetSdk` 36 (Android 16).** 31 gives
  authentication-required notification actions, the on-device recognizer and
  the current foreground-service rules without fallback code. 36 means the
  window is always edge-to-edge and back is predictive. Not 37 until Phase 0
  shows a tailnet address is reachable without the local-network permission.
- **The device key stays in the WebView's IndexedDB in this plan.** Moving it
  into the Android Keystore is a later step (see "Later").
- **Pairing again is accepted.** The app's storage is not Chrome's, so a phone
  that used the PWA pairs anew and is a new device id; per-phone lists need
  re-ticking (`mobile_access.md` "A re-paired phone gets a new id").
- **Code lives in this repo under `android/`.** One version, the brand
  modules and the i18n dictionaries are shared.
- **Order:** probes → the project, brand and gate → shell at parity (with
  the desktop list) → release → notices and reply → Android Auto → voice
  with the screen off. "Order and size" at the end has the steps.

## Facts this rests on

Checked in code:

- Each sidecar is its own HTTPS origin (Tailscale Serve); the session cookie
  is `__Host-…; Secure; HttpOnly; SameSite=Strict` (`host.rs` `login`), and
  mutating routes check `exact_origin` (`host.rs:383`). A WebView that loads
  the origin itself satisfies both with no sidecar change.
- The pairing key is a non-extractable ECDSA P-256 WebCrypto key in IndexedDB
  (`mobile-web/src/auth.ts`, `authStore.ts`); sign-in signs a text the page
  builds itself (`checkedLoginPayload`).
- The page's CSP is `default-src 'self'`, `connect-src 'self'`
  (`host.rs` `PHONE_CSP`); `MOBILE_PERMISSIONS_POLICY` grants the microphone
  to `self`.
- Browser APIs the page uses that matter here: Push + Notification
  (`push.ts`, `sw.js`), `SpeechRecognition` (`voiceInput.ts`,
  `voiceSession.ts`), `speechSynthesis` (`speechOutput.ts`), WebAuthn
  (`localLock.ts`: `rpId = location.hostname`, platform authenticator),
  `navigator.share` (`outboxShare.ts`, `FilesLibrary.tsx`), `window.print`
  (`print.ts`), Screen Wake Lock and `getUserMedia` (`voiceSession.ts`),
  `<input type=file>` (`phonePicks.tsx`, `Terminal.tsx`, one with
  `capture`), `showOpenFilePicker` (`api.ts` `pickPhoneFiles`),
  `navigator.clipboard` (`writeText` in five files, `readText` in
  `SignInSheet.tsx`), `download` anchors (six files), `window.open`
  (`api.ts`, `LinkSheet.tsx`), history `popstate` (`backStack.ts`),
  `display-mode` (`platform.ts` `isInstalledApp`), a service worker,
  IndexedDB and Cache Storage.
- `voiceSession.ts` `startDictation` already takes the recognizer
  constructor as an argument; `speechOutput.ts` calls
  `window.speechSynthesis` directly in three places.
- Push state lives inside `AuthStore` (`push.rs` `PushStore`), so revoke and
  Forget all drop a subscription; endpoints are held to a vendor-host
  allowlist (`allowed_push_host`); budgets are `NOTICE_BUDGET_PER_MINUTE` 30
  and a 30 s per-tab cooldown.
- A `Phone` is minted only by the auth helpers in `host.rs`
  (`authenticate` and `authenticate_or_ticket` construct it; `section_guard`
  and `mutation_guard` wrap `authenticate`), and every phone route resolves
  ids through `catalog(state, &Phone)`.
- An agent notice starts in the desktop window, not in the sidecar:
  `MobileBridgeHost.tsx` finds the turn edge (`lib/mobileAgentTurns.ts`) and
  sends the admin request `agent_turn` (`admin.rs`). With no window no agent
  notice is sent (`alarms.rs` covers calendar reminders only). A `question`
  notice is the hooks' `decision` state: a permission request or an
  elicitation dialog (`agent_session.rs`, the hook script's `turn=decision`
  lines). Its body is the fixed "Needs your answer"; a `done` notice quotes
  the user's own prompt, never the agent's words (`push.rs`
  `AgentTabRef::notice`). The `.turn` record holds the state word and a
  time, nothing about which kind of prompt is open (`agent_turn.rs`
  `parse_turn_record`).
- A phone's words reach an agent tab in two ways. They are typed through the
  terminal WebSocket (`host.rs` `terminal`, which needs the session;
  `sent_prompt` only records them afterwards). Or they are held
  (`hold_prompt`: the window's `HoldPrompt`, else `headless::hold_prompt`
  and `scheduler::PhoneHolds`). A held prompt is never typed while the tab
  is on a `decision` (`scheduler.rs` `queueable_while_busy`, the window's
  `phoneHolds.ts`).
- The multi-desktop plan's Phases 0–2 (cookie per port, `linked.rs`,
  Settings) and a minimal Phase 3 are built, never live: `main.tsx` mounts
  `shell/DesktopShell.tsx`, which wraps `App` and frames a linked desktop
  (`shell/DesktopFrame.tsx`, `frameBridge.ts`, `linkedDesktops.ts`), and
  `pushSupport()` has a `"framed"` state. Its Phase 4 (push relay) is not
  built.
- The phone voice plan's app-level session (its steps 2–7) is not built:
  no armed session in `App.tsx`, no Media Session anywhere in the page.
  What exists is the Focus loop (`screens/terminal/useHandsFree.ts`,
  `voiceSession.ts`), "Tabby navigate" and the probe page, whose step 0
  results are "Not run yet" (`phone_voice_plan.md`). `startDictation` ends
  its session when `document.hidden`.
- The desktop's identifier is `io.github.fseiffarth.tabtivity`
  (`src-tauri/tauri.conf.json`); releases are cut by `release.yml` on every
  green push to `main`.

Checked on the web (2026-11-14), to be re-checked by Phase 0:

- An Android WebView exposes neither the Web Speech API (`speechSynthesis`
  is `undefined`, no `SpeechRecognition`) nor the Push API.
- WebAuthn in a WebView (`androidx.webkit` ≥ 1.12,
  `setWebAuthenticationSupport`) needs the app tied to the site through
  Digital Asset Links, which a per-user private address cannot provide.
- Android 15 caps `dataSync` foreground services at 6 h per 24 h;
  `remoteMessaging` and `specialUse` are the candidate types for a
  long-lived connection.

Checked on the web in the review (2026-11-15):

- Neither candidate type is on Android 15's list of types a
  `BOOT_COMPLETED` receiver may not start; `dataSync` and `microphone` are.
  A `microphone` service cannot be created while the app is in the
  background (developer.android.com, foreground service types and
  background-start restrictions).
- Android Auto wants the Reply action's `PendingIntent` mutable (it writes
  the `RemoteInput` into it), both actions handled by a `Service`, never an
  Activity, and Mark as read is required
  (developer.android.com/training/cars/communication/notification-messaging).
- For an app that targets Android 15, `setStatusBarColor` does nothing and
  the window is edge-to-edge; the opt-out is gone at target 36.
- Media buttons go to the app that last played audio itself; `TextToSpeech`
  sound comes from the engine's process (Google issue 65344811).
- A custom scheme can be claimed by any other installed app.
- Developer verification (press reports, not Google's own page): enforced
  since 2026-09-30 in Brazil, Indonesia, Singapore and Thailand, everywhere
  in 2027. An unregistered app then installs only through ADB or an
  "advanced flow" with a 24 h wait; a free limited-distribution account
  covers 20 devices.

Not checked — each is a Phase 0 probe: whether a stopped Activity's WebView
keeps running JavaScript under a foreground service; whether Android Auto
shows a sideloaded app's notices only with its "Unknown sources" developer
setting; whether Google's developer-verification rule for sideloaded apps
applies to this APK by the time it ships; `env(safe-area-inset-*)` and
`visualViewport` under Android 15's forced edge-to-edge; whether Android
Auto honours `setAuthenticationRequired` and fires Reply with the phone
locked; whether `SpeechRecognizer` starts a new utterance with the screen
off; whether an app that targets Android 17 reaches a tailnet address
without the new local-network permission (Android's list of local ranges
includes the carrier-grade NAT range tailnet addresses come from, its rule
excludes VPN interfaces); whether Google
can verify Digital Asset Links for a host only the tailnet reaches.

## Shape

```
android/ (Kotlin)                          desktop sidecar (unchanged origin)
┌──────────────────────────────┐
│ DesktopActivity              │   https://<host>.<tailnet>.ts.net/
│  └ WebView, one per desktop ─┼──────────────► the phone UI, as today
│     bridge "nativeBridge"    │                (cookie, exact origin, SW)
│ NoticeService (foreground) ──┼──────────────► GET /api/v1/notices (stream)
│ VoiceService  (foreground)   │   opened with the notice key, tailnet only
│ DesktopStore (paired list)   │
└──────────────────────────────┘
```

- **One WebView per desktop, on that desktop's own origin.** Where the
  WebView supports it (`WebViewFeature.MULTI_PROFILE`), each desktop gets its
  own WebView profile, so cookies, storage and service workers of two
  desktops never share a store; otherwise the default profile (origins still
  separate them).
- **Navigation is confined.** The view loads only its desktop's origin; any
  other URL, `window.open` and `target=_blank` go to the system browser.
  `allowFileAccess` and `allowContentAccess` are off, mixed content is
  blocked, and a TLS error is never overridden.
- **The bridge is scoped to the exact origin.**
  `WebViewCompat.addWebMessageListener(view, "nativeBridge", setOf(origin), …)`
  (the rule carries the port when it is not 443) and the listener also
  checks `isMainFrame`: the object is injected into every frame of a
  matching origin, so the check is what keeps a same-origin frame out. The
  sealed pdf frame (opaque origin) and any framed desktop never get it.
- **Native services never use the page's session.** They hold their own
  narrow credential (Phase 3's notice key).
- **Nothing leaves the tailnet.** The manifest switches off the WebView's
  Safe Browsing lookups and its metrics upload (flag names to be confirmed
  when written), and the app has no update check of its own.

### The bridge contract (platform-neutral)

Lives in `mobile-web/src/native/` and is the only place the page knows a
native app exists. (Not `shell/`: that folder is the iframe switcher.)

- `bridge.ts`: `nativeBridge()` returns `null` in a browser. Otherwise
  `{ platform, contract, caps: Set<string>, call(name, args), on(event, cb) }`
  after a `hello` handshake that also tells the app the page's language.
  JSON messages, each bounded in size; an unknown call answers
  `unsupported`. On Android the transport is the injected `nativeBridge`
  object; an iOS app later uses `window.webkit.messageHandlers`. Nothing
  outside `bridge.ts` touches either.
- Capabilities, each detectable alone:

  | Capability | Replaces | Phase |
  |---|---|---|
  | `lock.biometric` | WebAuthn in `localLock.ts` | 1 |
  | `share.files` | `navigator.share` | 1 |
  | `print` | `window.print` | 1 |
  | `files.save` | saving a page-made blob (downloads by URL need no call) | 1 |
  | `screen.awake` | Screen Wake Lock | 1 |
  | `chrome.icons` | light or dark system-bar icons (the bars cannot be coloured at this target; the page paints behind them) | 1 |
  | `speech.recognize`, `speech.speak` | Web Speech | 1 |
  | `desktops` | the iframe switcher | 1 |
  | `notices` | Web Push | 3 |
  | `voice.background` | — (new) | 5 |

- Rules for every call: the shell trusts nothing the page sends. A paired
  desktop may be hostile to another paired desktop, so no call reads files
  the user did not pick, starts an intent without a visible chooser, makes a
  request to another origin, or returns anything about another desktop.
- **Grants are per desktop.** Android's microphone permission is per app, so
  the app keeps its own grant per desktop in `DesktopStore` for the
  microphone, speech and notices, and asks once per desktop. A second
  desktop never inherits the first one's microphone. Every `files.save`
  shows what was saved.
- File bytes cross as a same-origin URL the app fetches itself (GET, that
  origin only), or as an `ArrayBuffer` message for page-made blobs under a
  fixed cap. For the fetch, prefer the sidecar's existing open ticket
  (`host.rs` `authenticate_or_ticket`: five minutes, bound to one URL) over
  handing the session cookie to app code.

## Phase 0 — probes (throwaway debug APK, no product code)

A bare `android/` project with one WebView on a real paired desktop. Each
probe has a pass line and names what it decides. Results go into this file.

| # | Probe | Decides |
|---|---|---|
| P1 | Pair, sign in, reopen: the cookie, the IndexedDB key and the service worker survive an app restart and a reboot | whether the device key can stay in the WebView (default) |
| P2 | Terminal WebSocket, xterm, the pdf frame, Mark up with a pen, file chooser, downloads, clipboard | Phase 1's parity list |
| P3 | Which of push, speech, share, print, wake lock, `navigator.credentials`, `navigator.clipboard` (write and read), `showOpenFilePicker` are absent or refuse | the capability table (a `clipboard` row if it refuses) |
| P4 | Back gesture through `backStack.ts`, keyboard resize, `visualViewport`, `env(safe-area-inset-*)` on Android 15+ | edge-to-edge or padded view |
| P5 | The bridge is absent in the pdf frame and in an iframe of another origin | the bridge's scoping |
| P6 | A stream to the sidecar held by a foreground service for 12 h with the screen off, on Wi-Fi and mobile data, with and without the battery exemption | the service type (`remoteMessaging` or `specialUse`) and whether the exemption is required |
| P7 | The stopped Activity's WebView keeps running JS, its WebSocket and bridge events for 30 min under a microphone service; what `document.visibilityState` says there and how often a timer fires | whether Phase 5's voice logic can stay in the page, and which `document.hidden` checks it must change |
| P8 | `SpeechRecognizer` (on-device where offered) restarted per utterance: start beeps, latency, German and English; the same with the screen off under the microphone service; `TextToSpeech` voices | Phase 1's speech shim, Phase 5 |
| P9 | With a Bluetooth car or earbuds: does the native recognizer on the phone's own mic leave A2DP playing; do the buttons reach the app's media session while only `TextToSpeech` speaks | whether the car's call mode can be avoided; whether Phase 5 still needs the app to play audio itself |
| P10 | A MessagingStyle notice with Reply in Android Auto (Desktop Head Unit and a real car) from a sideloaded build, with the phone locked and `setAuthenticationRequired(true)` on Reply | Phase 4's install note; whether the keyguard rule holds in the car |
| P11 | Sideload install of a signed release build on a certified phone, current Play Protect and developer-verification rules | Phase 2's release path |
| P12 | Multi-profile WebViews: two desktops, no shared cookie or storage | profiles or default store |

**Stop rules.** P1 or P2 failing on a current WebView stops the plan. P7
failing does not: Phase 5 then needs its listening loop moved into Kotlin and
gets its own plan. P6 failing without the exemption makes the exemption part
of onboarding.

## Phase 1 — the shell at parity

Goal: everything the PWA does today works in the app, plus the desktop list.

**App (`android/app/src/main/…`)**

- `DesktopStore`: the paired desktops `{ origin, name, colour, order,
  profile, grants }` in app-private storage. An origin is `https` only and
  is saved only after the user confirmed its host on a sheet.
- Adding a desktop, two ways, no camera permission:
  - the pairing page in the phone's browser gets an **Open in the app**
    button: an `intent:` link that names the app's package and carries
    origin and code. The app shows "Pair with ‹host›?" before it loads
    anything. The code lives five minutes (`auth.rs`), so the sheet says
    when it has run out;
  - typing the address in the app, then the code on the page as today.

  The scheme in that link is as permanent as the `applicationId` and is
  written in the same one allowed file.
- `DesktopActivity`: the WebView as "Shape" describes; `OnBackPressedCallback`
  → `goBack()` else leave (predictive back, as target 36 requires);
  `onShowFileChooser` opens the system file picker (several files, camera
  capture); `DownloadListener` saves a download by URL; `onPermissionRequest`
  grants audio capture only to a desktop holding the microphone grant; a
  Reload action (a WebView has no pull-to-refresh of its own); the Activity
  follows the system's day or night theme so the page's
  `prefers-color-scheme` stays right.
- A native "cannot reach this desktop" page (no network, VPN off with a
  button that opens Tailscale, host down) for the first load only. After
  that the service worker serves the cached page, which explains
  unreachability itself (`connection.ts`).
- Desktop switcher: a native sheet (colour, name, a `/healthz` lamp); one
  live view, the last one kept warm.
- The page tells the app when the desktop forgot this device
  (`forgetDeviceData.ts`); the app then drops that desktop's notice key and
  stops its stream.
- Bridge handlers for the Phase 1 capabilities:
  - `lock.biometric`: a Keystore P-256 key that requires user authentication
    signs a page-made challenge through `BiometricPrompt`; the page keeps the
    public key and verifies the signature.
  - `share.files`, `print` (`PrintManager` with the view's print adapter),
    `files.save` (MediaStore Downloads), `screen.awake`, `chrome.icons`.
  - `speech.recognize` (`SpeechRecognizer`, on-device preferred) and
    `speech.speak` (`TextToSpeech`), foreground only in this phase.
- Manifest: no backup (`allowBackup=false`, data-extraction rules exclude
  everything), only the launcher and the pairing intent exported, immutable
  `PendingIntent`s (Phase 3's Reply action is the one exception: a
  `RemoteInput` needs a mutable one), and the recents thumbnail hidden
  (`setRecentsScreenshotEnabled(false)`, Android 13+) so an unlocked page is
  not left readable in the app switcher. Screenshots stay allowed.
- A WebView version floor: below it the app says "update Android System
  WebView" instead of loading.
- If no `hello` arrives a few seconds after load, a banner says this desktop
  needs an update for the app's native features; the page still works.

**Phone UI (`mobile-web/src`)**

- `native/bridge.ts` (above) and `native/speechShim.ts`: with the speech
  capabilities present, install `SpeechRecognition`, `speechSynthesis` and
  `SpeechSynthesisUtterance` look-alikes over the bridge before the app
  mounts (`main.tsx`), covering exactly what the page uses: for output
  `speak`, `cancel`, `lang`, `rate`, `onend`, `onerror`; for input the
  constructor (looked up once, in `voiceInput.ts`), its six handlers and
  `start`/`stop`/`abort`. One code path stays. Two traps: the static
  `available` stays undefined, or `openMicMeter` opens a second capture;
  and `stepUtterances` is tuned to Chrome's result pattern, so the shim
  reproduces the `results` list shape and is tested with sequences recorded
  in P8.
- Seams, each a small branch on a capability:
  `localLock.ts` (`platformBiometricAvailable`, `enrollBiometric`,
  `verifyBiometric`; record kind `"native"`), `outboxShare.ts`
  (`canShareFiles`, the share itself), `print.ts` (a WebView's
  `window.print()` does nothing and `afterprint` never fires, so the seam
  ends the print itself), `voiceSession.ts` `holdScreenAwake`, `platform.ts`
  `isInstalledApp` (true in the app), `push.ts` `pushSupport` (a new
  `"native"` state that shows "notifications arrive with a later app
  version" until Phase 3), the clipboard calls if P3 shows they refuse. The
  download anchors need no seam: every one is a same-origin URL with
  `?download=1`, which the `DownloadListener` takes.
- Pairing link: `screens/Pair.tsx` gets the **Open in the app** button,
  Android only, in a browser only. A browser that is already paired (the
  phone moving from the PWA to the app) drops a `#pair=` code at load today
  (`takeLinkedPairingCode`) and never shows that screen: it offers the same
  button instead of dropping the code.
- With `desktops` present the page's own switcher entry calls the native
  sheet. The iframe switcher (multi-desktop Phase 3, built) is not needed
  inside the app and stays a PWA/iOS matter: with the bridge present
  `shell/DesktopShell.tsx` never frames a desktop, whatever the desktop's
  `linked_desktops` says, and `DesktopSwitchButton`
  (`shell/DesktopFrame.tsx`) shows by the capability, not by that list.
- i18n keys `mobile.native.*` in `src/lib/i18n/en.ts` and the other four
  dictionaries; `UntestedTag` rows `mobile.android.*` in `src/lib/untested.ts`
  for each entry point the page draws. Native surfaces (the switcher and
  pairing sheets, notifications) cannot draw the pill: each still gets its
  register row, so `npm run untested -- list` shows it.

**Sidecar:** no change. `npm run mobile:bundle` rebuilds the page; the app
needs a desktop that carries it.

## Phase 2 — build, CI, release

Order: the project, brand, strings, icons and gate items come before Phase
1's first commit, because `brand-check.sh` and `privacy-check.sh` run on
every commit and push. Release and "Getting the app" come after Phase 1.

- `android/`: Gradle (Kotlin DSL), one `app` module, Kotlin, plain Views (no
  Compose). Direct dependencies: `androidx.core`, `activity`, `webkit`,
  `biometric` — nothing from Google Play services. The larger part of the
  supply chain is what they pull in and the Gradle plugins: all pinned,
  under Gradle dependency verification, with the wrapper's checksum. A row
  for Gradle and the Android plugin goes into
  `docs/third_party_update_checklist.md`.
- Brand: no file under `android/` spells the app's name. A small script
  prints the names from `scripts/lib/brand.sh` for Gradle (`resValue`,
  manifest placeholders). The `applicationId` is permanent once released (a
  later rename cannot change it without losing updates), so it is written
  once in one file with a `brand-check: allow` line that says so.
  `brand-check.sh` also reads tracked paths, and it takes a comment in a
  file type it does not know for code: the Kotlin `namespace`, and with it
  the source folders and every `package` line, is a neutral name and not
  the `applicationId`, and the script learns `kt`, `kts` and `java`.
- Strings: `scripts/android-strings.mjs` turns the `mobile.native.*` keys of
  all five dictionaries into `strings.xml` at build time (not tracked).
- Icons: vector drawables made from `mobile-web/public/icons/icon.svg`. Any
  tracked binary (the Gradle wrapper jar) gets its blob id in
  `scripts/privacy-reviewed-binaries.txt`.
- Gate: `scripts/gates.sh` gains `android` (unit tests, Android lint with
  warnings as errors, `assembleDebug`), run only when `android/` or its
  generators changed. Without a JDK or the Android SDK it reports
  "unavailable" out loud. AGENTS.md's gate list gets the line.
- CI: a job in `.github/workflows/ci-cd.yml` (Linux) runs the same gate,
  and `scripts/ci-local.sh` gets the matching step. `security.yml`, which a
  release also waits for, gains `java-kotlin` in its CodeQL matrix, and
  `dependabot.yml` the `gradle` ecosystem.
- Release: `release.yml` rebuilds nothing (its own rule: the assets are the
  ones the green ci-cd run built). So ci-cd builds the unsigned release APK
  as an artifact, and `release.yml` only signs it (`apksigner`, keystore
  from the `release` environment's secrets), names it
  `<slug>-<version>.apk` and lists it in the signed `SHA256SUMS` like every
  other asset. Every green push to `main` is a release: until the user says
  the app may ship, a repository variable keeps the APK off it.
  `versionName` is the repo version; `versionCode` is derived from it and
  only ever grows. `docs/context/release_signing.md` gets the Android key:
  how to make it, back it up, and what losing it costs (every user
  reinstalls and pairs again).
- Developer verification: if P11 finds that an unregistered APK installs on
  a certified phone only through ADB or a flow with a day's wait, the user
  decides then whether to register the package and signing key with Google
  (press reports say a free limited-distribution account covers 20 devices).
  That keeps "APK on GitHub Releases"; it is asked at that point, not now.
- Getting the app: the phone PWA's settings and the desktop's Settings →
  Mobile link to the latest release's APK. The app itself never calls
  outside the tailnet; the page shows "app update available" when the shell
  lacks a capability the page knows.
- Docs: file-map rows for `android/` (one line) and
  `mobile-web/src/native/`; a new `docs/context/android_app.md` (the bridge
  contract, the per-desktop grants, the notice key); a section in
  `docs/help/mobile.md`; a TODO entry in `todo/group-h-crossplatform.md`.

## Phase 3 — notices on the tailnet, reply from the notification

**Sidecar (`src-tauri/src/services/mobile_control/`)**

- **A channel subscription.** `push.rs`: a device's subscription is either
  Web Push (as today) or a **channel**: the public half of a P-256 key the
  app made in the Android Keystore for this desktop. The page registers it
  (`PUT /api/v1/push` with `{ channel: { public_key }, …prefs }`, in its
  signed-in session with the exact origin; the app hands the page the public
  key through the bridge and learns the device id from it). `DELETE` drops
  it; revoke and Forget all drop it as they drop an endpoint. New fields are
  optional and `PUSH_SCHEMA` is not bumped: `AuthStore::open` fails on an
  unknown schema, so a downgrade would otherwise stop the sidecar.
- **Opening the stream proves the key.** `POST /api/v1/notices/challenge`
  and `POST /api/v1/notices/open` mirror `auth.rs`'s `challenge` and `login`
  with their own context string: the app signs a text it builds itself from
  the nonce and expiry. The answer is a notice ticket held in memory only,
  like a session, and good for exactly three things: read this device's
  notices, answer a notified turn, mark seen. Failed attempts go through the
  existing `rate_limit`. The ticket mints a `Phone` through one new auth
  helper, so the catalog filter and `phone_origin` apply unchanged.
- `GET /api/v1/notices`: a server-sent-event stream, `Authorization: Bearer
  <notice ticket>`, no cookie. A heartbeat every 25 s (every byte re-arms
  `limits::IDLE_TIMEOUT`, so the stream stays open); one stream per device
  (a new one replaces the old). Notices that found no stream are kept in
  memory (≤ 20, for `TTL_SECONDS`) and delivered with ids on reconnect; each
  is checked against the device's pairing and the scope's list again when it
  is flushed, not only when queued. A request carrying an `Origin` other
  than the host's own is refused, as is any CORS preflight. An older sidecar
  answers a plain 404, which the app shows as "this desktop needs an update".
- **Prefs.** The existing `calendar`, `agents` and `details`, with the same
  budgets and cooldown, plus two for a channel only, both off by default:
  `agent_text` (the user's decision: the agent's last message, clipped, read
  from the transcript the sidecar already reads for local tabs) and `reply`
  (the user's decision). The agent's text therefore never crosses a push
  vendor's relay. `reply` needs `agent_text` and `agents` set to "all",
  because Reply lives on `done` notices; the settings say so instead of
  offering a Reply that can never appear.
- **What can be answered.** Checked 2026-11-15 (see "Checked in code"): the
  sidecar cannot tell a free-text question from a permission or select
  prompt, and does not have to. Every `question` notice is a `decision` (a
  permission, plan or select dialog), and a held prompt is never typed onto
  one. A question the agent asks in plain text ends its turn and arrives as
  `done`. So a `reply` token goes on `done` notices only, for a local tab
  whose hooks write the `.turn` record (a CLI without hooks gets none). The
  token is sealed under `host.key` (device, opaque tab id, the record's
  `done` time, expiry ≤ 1 h) and is single-use: spent tokens are remembered
  across a sidecar restart for that hour, or a replay would type the prompt
  twice.
- `POST /api/v1/notices/reply` (notice ticket, reply token, text): goes down
  `hold_prompt` (`host.rs`; its two branches, the window's `HoldPrompt` and
  `headless::hold_prompt`) with the phone's `device_id`, so the rule is the
  phone's and is cancelled like any other. Not `sent_prompt`, which only
  records history. `headless::held_words` keeps refusing session commands
  such as `/clear`. Refused `stale` once the tab's `.turn` record is no
  longer that `done`, behind `ai_off_guard`, and never offered for a
  remote-host tab (`not_on_host`, which answers `409 tab_on_host`).
- `POST /api/v1/notices/seen`: the tab-seen mark, for "Mark as read".
- Not served behind the gateway (`Listen::Unix`) in this phase: 404 there.
- Limit kept from today: an agent notice exists only while the desktop
  window runs (the window finds the turn edge). Help says so.
- Docs: `mobile_access.md` ("Where it is enforced": the new helper),
  `mobile_sidecar.md` (`push.rs`), command-class rows only if a Tauri
  command is added (none is planned).

**App**

- `NoticeService`: one foreground service holding one stream per desktop
  with notices on; reconnect with backoff and on network change; a quiet
  permanent notification that names the state ("2 desktops", "Tailscale is
  off"). It starts at boot, which Android allows only after the first
  unlock, and never after a force stop or before the app's first launch;
  help says so. It holds no secret at rest: the notice key never leaves the
  Keystore.
- Notification channels: agent questions, agent done, calendar, the service
  itself. Agent notices are `MessagingStyle`, one conversation per tab, with
  **Mark as read** and tap-to-open (desktop + tab, through the page's
  `lastPlace` path), and **Reply** (`RemoteInput`,
  `setAuthenticationRequired(true)`) only where the notice carries a reply
  token. Both actions are handled by a `Service`, as Android Auto requires.
  After a reply the notification is updated to say it was queued, or that
  the turn had moved on.
- Language: a notice uses the language its desktop's page last reported in
  `hello`, not the phone's system language, so it matches the page. With
  `details` off the titles are the generic ones from the generated strings.
- Onboarding asks for the notification permission and, if P6 requires it,
  the battery exemption, each with one sentence of why.
- Bridge `notices`: the page's notification settings (`push.ts` and its
  sheet) ask the app for the notice key, register it themselves, and tell
  the app to start or stop that desktop's stream. The two new switches sit
  there, each with a sentence on what it exposes (lock screen, the car's
  assistant, apps with notification access). The needs-you badge on the
  desktop switcher counts from the streams.

**Tests:** Rust (they run on Linux, Windows and macOS in CI: paths through
`Path::join`, no Unix-only fixture) — a channel is dropped by revoke and
Forget all; a narrowed list stops notices, queued ones too; a wrong or
replayed signature opens no stream; a reply after the turn moved on is
`stale`; a spent reply token is refused, also after a restart; a reply
token of another device is refused; no `reply` token without both
switches; the stream refuses a foreign `Origin`; budgets hold; an old
`push.json` still opens. Kotlin (JVM) — the stream parser, backoff,
reply-token handling. TS — the settings sheet in the `"native"` state.

## Phase 4 — Android Auto

- Manifest: the `com.google.android.gms.car.application` meta-data with
  `<uses name="notification"/>`; Phase 3's notices already have the shape
  Auto needs (MessagingStyle, Reply and Mark-as-read as semantic actions that
  show no UI).
- Car rules come from Phase 3 unchanged: only a finished turn is answerable
  and only with both switches on, approvals say to look when parked, notice
  text stays short. If P10 shows the car fires Reply with the phone locked,
  the `reply` switch's explanation says so.
- This replaces step 11 of `docs/phone_voice_plan.md` (update that step to
  point here). Spoken replies are transcribed by the car's assistant.
- Help: the install note P10 decides (the Android Auto developer setting for
  a sideloaded app).

## Phase 5 — voice with the screen off

- `VoiceService`: a foreground service of type `microphone`, started when a
  hands-free session is armed (the app is visible then, as Android
  requires) and stopped when it is disarmed. It owns the recognizer, the
  speech output, audio focus and a media session whose earbud and
  steering-wheel buttons reach the page as bridge events (P9 decides whether
  this replaces the silent-audio trick, or the service must play the speech
  itself). Its notification shows the armed state and Stop.
- While armed the Activity does not pause its WebView; the hands-free state
  machine, the command matcher and the reading cursor stay in the page
  (`handsFree.ts`, `speechOutput.ts`, `voiceInput.ts`) — if P7 passed.
- Capability `voice.background` lets the page drop its "keep the screen on"
  requirement and wording.
- Unchanged: the voice plan's fixed decisions (armed session plus command
  word, no approvals by voice while driving). Changed for the app, by the
  user's decision above: a hidden page no longer ends the session. It ends
  on Stop, the stop command, or 30 minutes without a recognized utterance.
- The lock while armed: the app's screens lock as usual, but the lock must
  not sign the page out while a session is armed (today it sends
  `DELETE /auth/session`), or the voice session could no longer send a
  prompt or read an answer. So in the app the lock covers the screens and
  keeps the sign-in until the session ends; the session's idle limit
  (`auth.rs` `SESSION_IDLE`, 15 minutes) is slid by the session's own
  requests. `docs/phone_voice_plan.md` gets a note pointing here.
- Built on the voice plan's steps 2–7 (the app-level session, Media
  Session, driving mode), which are not built. Every place the page stops
  on `document.hidden` needs a look: `voiceSession.ts` (`startDictation`,
  `holdScreenAwake`), the lock effect in `App.tsx`, `visiblePoll.ts`,
  `useTerminalSocket.ts`.

## Later (not in this plan)

- The device key in the Android Keystore, signing through the bridge (the
  shell builds the sign-in text itself, as `checkedLoginPayload` does).
- A share-sheet target that drops a shared file into an inbox.
- A "needs you" widget and quick-settings tile.
- Agent notices with no desktop window: a sidecar-side edge detector over
  the `.turn` records, under the `timer_lease` rule as `scheduler.rs` and
  `alarms.rs` use it.
- Answering a select or permission prompt from a notice: needs keys through
  tmux and the prompt's kind in the `.turn` record. Its own plan.
- One app-wide lock in place of a lock per desktop.
- The notice stream behind the hosted gateway, and a hosted server as a
  desktop.
- UnifiedPush as a second notice transport.
- The iOS shell on the same bridge contract.

## Threat notes

- **A hostile paired desktop.** It controls its own page and may call every
  bridge capability. The contract's rules (no cross-origin request, no file
  outside a user pick, no silent intent, nothing about other desktops), the
  per-desktop grants (the microphone above all) and the per-desktop profile
  are what contain it.
- **The pairing intent.** Any web page can fire it. Nothing is loaded or
  sent before the user confirms the host shown. Any other app can claim the
  same scheme and would then receive the code: the button uses an `intent:`
  link that names the app's package.
- **The notice key** never leaves the Keystore and there is no bearer secret
  at rest; a notice ticket lives in memory on both sides. It reads notices
  and answers notified turns only; revoking the device kills it.
- **Notices on the lock screen** show what a push shows today, under the
  same `details` choice. The agent's own words appear only with
  `agent_text` on, and then also to the car's assistant and to any app the
  user gave notification access.
- **The app's lock versus the services.** The notice stream outlives the
  app's lock, as a push subscription does today. With `reply` on, so does
  the Reply action: its only gate is the phone's screen lock (in Android
  Auto, whatever P10 finds), and an app with notification access can fire
  it. An armed voice session outlives the lock too, with voice-only reach.
  Nothing else does.
- **Supply chain.** Four direct AndroidX libraries plus what they and the
  Gradle plugins pull in, all verified; no analytics, no Google services,
  no network call off the tailnet.
- **A new attack surface review** (bridge, intent, stream, reply) belongs in
  the next threat recheck before the first release.

## Verification

- Gates per phase: `scripts/gates.sh` (the new `android` gate with the
  others). Backend edits: `npm run backend:stale`.
- Nothing here can be verified without a real phone. Each phase ends with a
  🖐️ list in `todo/group-h-crossplatform.md` and click-through steps for the
  user; the app is "never live" until then. Its ✅/❌ pairs say **Android
  app**: "Works on Android" in that file already means the PWA in Chrome.
- Phase 0's table is the first such list and gates everything after it.

## Order and size

| Step | Depends on | Size |
|---|---|---|
| Phase 0 probes | a paired desktop, a phone, the Android SDK | small; needs the user's phone |
| Phase 2a project, brand, strings, icons, gate, CI | Phase 0 | medium; before any Phase 1 commit |
| Phase 1a the app: confinement, `DesktopStore`, pairing, `hello`, file chooser, downloads, back | 2a | medium |
| Phase 1b capability seams (lock, share, print, save, awake, icons) | 1a | medium |
| Phase 1c speech shim | 1a, P8's recordings | medium |
| Phase 1d desktop switcher | 1a | small |
| Phase 2b release signing, getting the app, docs | Phase 1 | small |
| Phase 3a sidecar: channel, key proof, stream (testable with curl) | — | medium |
| Phase 3b `NoticeService` and notifications | 3a, 2b | medium |
| Phase 3c agent text and Reply | 3b | medium |
| Phase 3d the page's settings | 3a | small |
| Phase 4 Android Auto | Phase 3 | small |
| Phase 5 voice with the screen off | Phase 1, P7–P9, the voice plan's steps 2–7 | medium, or its own plan if P7 failed |

Phases 1 and 3 have no new feature for the user until their last step; the
parity work in Phase 1 is the largest part of the plan.
