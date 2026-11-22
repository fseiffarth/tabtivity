# One phone, several desktops — plan

> **Status (screened against code 2026-11-22):** PARTIAL. Phases 0-2 and the minimal Phase 3 are in code: `mobile_control/linked.rs`, `src/components/mobile/LinkedDesktops.tsx` (Settings → Mobile), the per-port cookie, `mobile-web/src/shell/` (`DesktopShell`, `DesktopFrame`, `linkedDesktops`, `frameBridge`, plus `frameGuard.ts` / `FrameGuardCard.tsx` which closed the clickjacking gap named in Phase 5), switcher commit `bb964b68b`; register rows `mobile.shell.switcher`, `.framedDesktop`, `.frameGuard`. Not built: Phase 4 (push relay through the home: no `/api/v1/relay`), the picker lamps / badges and deep links listed as out of scope in the handoff. Not live-tested.

Plan text: planned 2026-11-14. TODO: `todo/group-h-crossplatform.md`
31cs (this plan), 31ct (Phase 0's cookie bug). One installed phone app (the
"home": the desktop it was installed from) switches between several running
Tabtivity desktops, one on screen at a time. Access model this extends:
`docs/context/mobile_access.md`; sidecar notes: `docs/context/mobile_sidecar.md`.

## Decided (user, 2026-11-14)

- **One app, switch between desktops** — not one app per desktop, not a merged
  view of all desktops.
- **Framed desktops**, not a cross-origin client. Every other desktop's own
  phone UI is loaded in an iframe from its own sidecar origin. Why: each
  desktop serves the UI built for its own API (no version skew), the home's
  code cannot read a framed desktop (same-origin policy), and the change is
  about half the size. The rejected cross-origin client meant ~3–3.5 k lines
  (api.ts, per-desktop storage, CORS, 51 `exact_origin` sites) and gave the
  home's served code a session on every other desktop.
- **Push from other desktops:** v1 = needs-you badges in the switcher plus,
  on Android, a one-off "turn on notifications in the browser" on that
  desktop's own page; the relay through the home is Phase 4, after a live test.
- **Lock:** a framed desktop keeps its own lock in v1 (two unlocks possible).
  "Trust the home app's lock" per link is a later opt-in.

Defaults taken from the planning (change them here if wrong):
- The link list lives **on each desktop**, entered on both sides.
- A phone the home forgets (unpaired/revoked) also forgets its switcher list.
- **One live frame at a time**; switching reloads (cheap with B's SW cache).
- Off-screen desktops' lamps come from a `/healthz` probe plus last-known values.

## Facts this rests on (checked in code)

- Each sidecar is its own HTTPS origin via Tailscale Serve (`config.rs`
  `serve_origin`); a second instance on one machine uses Serve port 10000.
- `ts.net` is on the Public Suffix List, so `a.<tailnet>.ts.net` and
  `b.<tailnet>.ts.net` are **same-site**: B's `SameSite=Strict` session
  cookie is sent to B's frame inside A. `*.c.ts.net` names are their own
  suffix and must be refused.
- `exact_origin` (`host.rs`) stays as is: requests from B's frame carry
  `Origin: B`.
- Today the phone page sends `frame-ancestors 'none'`, has no `frame-src`
  (`host.rs` `security_headers`), `/pdf-frame.html` sends `SAMEORIGIN`
  (`pdf_frame_policy`), and `MOBILE_PERMISSIONS_POLICY` grants the microphone
  to `self` only, which an iframe `allow=` cannot widen.
- `/api/v1/status` needs a session; only `/healthz` is open.
- Notification permission cannot be asked from a cross-origin frame.

## Phase 0 — cookie collision (pre-existing, fix first) — done 2026-11-14, never live

Cookies ignore ports. The phone session cookie `__Host-<slug>_session` is the
same name for a desktop phone host on `HOST:10000` and the server gateway's
daemon on `HOST:443` (`docs/context/server_gateway.md`, "Tailscale Serve is
the one shared resource"), so the two overwrite each other's sign-in on one
machine. Verify, then put a non-default port into the cookie name
(`…_session_10000`), reading the old name for one release (`brand::PAIR`
legacy-style lookup). Test: two ports, two cookies, no cross-read. Framed
siblings on one machine depend on this.

## Phase 1 — sidecar (`src-tauri`) — done 2026-11-14, never live

As built: `mobile_control/linked.rs`; the list is written like `root_devices`
(the desktop's whole-block settings writes carry it), so no new Tauri command
or `command_class` row — the desktop's own check on add comes with Phase 2.
`/assets/*` keeps the closed headers (never framed). Lock down keeps the list:
with every phone forgotten a link grants nothing.


- `config.rs`: `MobileHostSettings.linked_desktops: Vec<String>`, read from
  `settings.json` per request (like `files_open`). `validate_linked_origin`:
  `validate_origin` + host exactly `<machine>.<tailnet>.ts.net` with this
  desktop's own tailnet, any port, not its own origin, no `c.ts.net`, ≤ 8.
  Ignored entirely behind the gateway (`Listen::Unix`). Unreadable settings →
  empty list.
- `host.rs` `security_headers`, per request; **empty list = byte-identical
  headers to today**:
  - PWA documents: `frame-ancestors <list>`, `frame-src 'self' <list>`,
    `connect-src 'self' <list>` (for the `/healthz` probe only); no
    `X-Frame-Options` on these documents (it cannot name several origins).
  - Permissions-Policy per response: `microphone=(self "<B>" …)`, same for
    `on-device-speech-recognition`.
  - `pdf_frame_policy`: append the list (frame-ancestors checks every
    ancestor, so B's PDF frame would be blocked under A); drop `SAMEORIGIN`
    when the list is non-empty.
  - `/api/*`, `/desktop/*`: unchanged (`DENY`, `'none'`).
- `/healthz`: `Access-Control-Allow-Origin: <Origin>` + `Vary: Origin` only
  for a listed origin; body unchanged.
- `/api/v1/status`: `linked_desktops: [{origin}]` for the shell.
- ~~Tauri command `mobile_linked_desktops_set`~~ — not built, by decision: the
  list rides the desktop's whole-block settings write (see "As built" above), so
  there is no command, `command_class` row or `commandClasses.ts` change.
- After edits: `npm run backend:stale`.

## Phase 2 — desktop Settings → Mobile — done 2026-11-14, never live

As built: `mobile/LinkedDesktops.tsx` (under "This computer", hidden in the
browser client), its add check `src/lib/linkedDesktops.ts` mirroring
`linked.rs` plus duplicate and limit; without a saved `ts.net` Serve origin it
says so instead of offering the field. One `UntestedTag` id,
`mobile.linkedDesktops`; strings in all five languages. Tests:
`src/__tests__/mobile/MobileLinkedDesktops.test.tsx`.

`src/components/mobile/MobileSettings.tsx`: a **Linked desktops** section —
this desktop's own address with Copy, add (validation errors: invalid, other
tailnet, limit), remove, and a note that each desktop needs the other on its
list. i18n `mobile.linkedDesktops*` (English holds every key), `UntestedTag`
rows in `src/lib/untested.ts`. Type in `src/types/index.ts` beside
`browser_client`.

## Phase 3 — phone (`mobile-web/src`) — minimal shell done 2026-11-14, never live

As built (minimal): `shell/DesktopShell.tsx` (wraps `App`, owns the picker, an
`OptionSheet`), `shell/DesktopFrame.tsx` (`DesktopStage`: one hand-made iframe,
`allow` and `src` set before attach; the 8 s not-linked/not-answering panel,
its `/healthz` probe `no-cors` so an unlinked desktop is told from a down one;
the switch button), `shell/shellContext.ts`, `shell/linkedDesktops.ts` (cached
list + selection + names, every origin re-checked with `lib/linkedDesktops.ts`
and this page's own tailnet), `shell/frameBridge.ts` (`ready`, `openPicker`;
frame trusts `ancestorOrigins[0]`, else the referrer's origin, failing closed).
`App`'s gate sits after its lock, before its connect step; while a frame is on
screen the home's idle clock counts visible time as use (touches in the frame
never reach it), its Back layer and steering are off, and a failed connect does
not reload the page. Pairing in a frame suggests "‹phone› via ‹home›";
`pushSupport()` is `framed` there. UntestedTag ids `mobile.shell.switcher`,
`mobile.shell.framedDesktop`. Not yet: lamps, needs-you badges, `?desktop=`,
the steering key / `pickerKey`, colour and order, `open` shell → frame. Handoff:
`docs/phone_multi_desktop_handoff.md`.

- New `shell/`:
  - `DesktopShell.tsx` wraps `App`: home renders natively; another desktop is
    one `DesktopFrame` (`src` set before attach, so no history entry;
    `allow="microphone; on-device-speech-recognition; web-share;
    clipboard-write; publickey-credentials-get; screen-wake-lock"`).
  - `linkedDesktops.ts`: the list from home's status, cached under
    `storageKey` so the shell works with home down; last-known name, state,
    needs-you count per origin; the phone's own colour and order.
  - `frameBridge.ts`: postMessage both ways, checked by `event.source`
    *and* origin (frame → `location.ancestorOrigins[0]`; shell accepts only
    its iframe's `contentWindow` from a listed origin). Messages: `ready
    {name, desktopAvailable, needsYou}`, `openPicker`, `pickerKey`;
    shell → frame `open {section, projectId, tabId}`.
- `App.tsx`: the desktop-switch button in the header (shown when the list is
  non-empty or the page is framed; in a frame it posts `openPicker`); the
  shell's gate goes **above** A's connect step, so A's unavailable screen
  shows only while A is selected; `?desktop=<origin>&open=…` deep links.
- Picker sheet: shell-owned, `useModalFocus`, a `useBackLayer`; rows = colour,
  name (`status.host`, else first DNS label), lamp (`connection.ts`
  taxonomy), needs-you badge. No `ready` within ~8 s while `/healthz` answers
  → "‹B› hasn't linked this app yet: add ‹A› in its Settings → Mobile". An
  older B answers `frame-ancestors 'none'` and never loads — said the same way.
- Lock: A's lock covers the shell and unmounts the frame; B keeps its own.
- Back: frame history joins the top page's; never change an attached frame's
  `src`; the shell pushes a guard only for the picker. Test that B's
  `popstate` cannot consume A's `ownPops` (`backStack.ts`).
- Keyboard: focus `iframe.contentWindow` after a switch; steering action
  "Switch desktop" (`steering/phoneSteeringKeys.ts`), forwarded from a frame
  as `pickerKey`.
- `Pair.tsx`: inside a frame, suggest the device name "‹phone› via ‹A›"
  (iOS will pair again in the frame, see below).
- `push.ts`: inside a frame, the push section says "open ‹B› in the browser
  to turn on notifications" with a link that opens it outside the app.
- `forgetDeviceData.ts`: also clears the switcher cache. B's data is cleared
  only when B rejects the device.
- Phone i18n `mobile.shell.*`; `UntestedTag` ids for the switcher and the
  framed desktop; `npm run mobile:bundle`.

## Phase 4 — push relay through the home (after live test of 1–3)

A mints a per-device relay token; the shell hands it to B's frame, which
registers `PUT /api/v1/push {relay:{origin,token}}` (B checks the origin is
listed). B's `push.rs` POSTs notices to `https://A/api/v1/relay` (push-vendor
allowlist extended to linked origins); A checks token, sender origin and a
rate limit, pushes with its own VAPID key carrying `desktop: <origin>`; `sw.js`
opens `/?desktop=…`. Trust cost, to confirm with the user then: A sees B's
notice text; revoke of the A device or removal of the link kills the token.
The only option that reaches iOS.

## Phase 5 — docs

Done for Phases 0–2 (2026-11-14): `mobile_access.md` § Linked desktops,
`mobile_sidecar.md` (`linked.rs`), file-map rows for `linked.rs` and
`mobile/LinkedDesktops.tsx`, `server_gateway.md` (the per-port cookie),
DOCUMENTATION.md § Tabtivity Mobile, `docs/help/mobile.md` § Linking several
computers. With the minimal Phase 3 (2026-11-15): the `mobile-web/src/shell/`
file-map rows and the help section's switcher paragraph are done too.

`docs/context/mobile_access.md`: a "Linked desktops" layer (the new trust
edge: a listed origin may frame this desktop's phone UI; known gap:
clickjacking by a linked origin — since closed by the frame's own guard,
`shell/frameGuard.ts`; machine host names reach paired phones),
one line in `mobile_sidecar.md`, file-map rows for `mobile-web/src/shell/`
and `MobileSettings`, DOCUMENTATION.md § Tabtivity Mobile.

## Tests

- Backend (`mobile_control/host` tests, `config.rs`): empty list ⇒ identical
  headers; a listed origin in frame-ancestors / frame-src / connect-src /
  Permissions-Policy, `X-Frame-Options` gone on documents only; `/api/*` and
  `/desktop/*` still `DENY`/`'none'`; pdf frame names the list; `/healthz`
  CORS only for listed origins; `exact_origin` still refuses a listed origin
  on `/api/v1/auth/*`; validator refuses other tailnet, `c.ts.net`, a path,
  own origin, a 9th entry; Phase 0 cookie per port; Phase 4 relay token
  refused after revoke, from an unlisted sender, over the rate limit.
- Frontend (`src/__tests__/mobile/`): shell with home down still picks B;
  lock unmounts the frame; `?desktop=` deep link; unknown origin dropped;
  bridge ignores wrong source/origin; back stack with the picker over a
  frame; Settings add/remove.
- Gates via `scripts/gates-job.sh start`; the sidecar code is in the daemon
  library, so the `--no-default-features` test and clippy apply.

## Must verify on a real phone (before Phase 3 is called done)

Android Chrome, installed PWA:
- B's frame loads under A, Strict cookie sent, **B's existing pairing, PIN
  and SW reused** (Chrome's storage key for a same-site frame = B's own).
- Dictation in the frame; share, download, clipboard from the frame.
- Back gesture order: B's layers → picker → leave app.
- A frame-ancestors refusal is told apart from a down host.
- B opened from the frame (Custom Tab) can subscribe to push.

iOS Safari, Home Screen app:
- The frame loads; **a new pairing inside the frame persists across
  restarts** (Home Screen apps keep their own storage, so B pairs again).
- **On-screen keyboard and `visualViewport` in B's terminal composer inside
  the frame** — the largest iOS risk.
- Safe-area insets (`env()` reads 0 in a frame; the shell pads), `display-mode`.
- WebAuthn unlock in the frame (or PIN only).
- With A's sidecar stopped, the cached shell still frames B.

Both: a second instance on port 10000 as a sibling (needs Phase 0);
switching between three desktops leaks no memory.

## Order

0 → 1 → 2 → a minimal Phase 3 (shell, one frame, no picker polish) for the
device checks above → rest of 3 → 5. Phase 4 only after the user confirms
its trust cost.
