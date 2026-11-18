# One phone, several desktops — Phase 3 (minimal) handoff

Plan: `docs/phone_multi_desktop_plan.md` (Phase 3, "as built" paragraph).
TODO: `todo/group-h-crossplatform.md` 31cs. Never live: nothing here has run
on a phone.

## Commits

On branch `worktree-agent-af350d50d22ed4e6a`, on top of `develop` 3f7f42625:

- `522038ab1` — feat(mobile): switch between linked desktops on the phone
- the commit adding this handoff — docs(mobile): Phase 3 (minimal) handoff

## What was built

- `mobile-web/src/shell/DesktopShell.tsx`: the page root (`main.tsx`). At the
  top it wraps `App` in the shell context and owns the picker (an
  `OptionSheet`, so `useBackLayer` + `useModalFocus` as every sibling sheet).
  Inside a frame it is just `App`.
- `mobile-web/src/shell/DesktopFrame.tsx`: `DesktopStage` / `DesktopFrame` (one
  iframe made by hand: `allow`, then `src`, then attach; `src` never changed;
  another desktop or Retry = a new frame by `key`), the not-linked / not
  answering panel, and `DesktopSwitchButton`.
- `mobile-web/src/shell/shellContext.ts`: the context `App` reads (selected
  desktop, `canSwitch`, `openPicker`, `setUnlocked`). Without a provider (a
  framed page, or a test rendering `App`) it falls back to "framed → post
  `openPicker`, else nothing".
- `mobile-web/src/shell/linkedDesktops.ts`: the list, names and selection, an
  external store cached under `storageDashKey("linked-desktops")`.
- `mobile-web/src/shell/frameBridge.ts`: `postMessage` with source + origin
  checks both ways; `ready {name, desktopAvailable}` and `openPicker`.
- `App.tsx`: the gate (`pastLock` state → `DesktopStage` → connect step),
  `noteHomeStatus` from the existing 30 s status poll, `ready` posting inside a
  frame, floating switch button on splash / pair / setup / lock screens.
- `Home.tsx`: the switch button in the header (before 🔍).
- `Pair.tsx`: "‹phone› via ‹home›" inside a frame (home = first DNS label of
  the shell's origin).
- `push.ts` / `NotificationsSheet.tsx`: `pushSupport()` returns `framed` in a
  frame; the sheet says to open this desktop in the browser, with a
  `target=_blank` link to its own origin.
- `forgetDeviceData.ts`: clears the switcher cache.
- i18n `mobile.shell.*` (10 keys, en/de/es/fr/it), untested ids
  `mobile.shell.switcher`, `mobile.shell.framedDesktop`, CSS at the end of
  `style.css`, file-map rows.

## Choices and why

- **The gate lives in `App`, the picker in the shell.** The lock state is
  `App`'s, so `App` renders `DesktopStage` itself: a lock re-renders `App` into
  its lock screen and the frame is gone in the same commit. The picker is the
  shell's; `App` reports "past my lock" through a layout effect, so the picker
  closes before paint on a lock. "Past the lock" is its own state, set by
  `resume()` (every caller comes after an unlock, a pairing that set the lock
  up, or a grace) and cleared by `begin()` and both lock paths.
- **Selection persists.** The cache holds the selected desktop; a cold open
  unlocks the home and goes straight to that frame (the home connects behind
  it). Flagged below.
- **Home idle lock while framed.** Touches in a cross-origin frame never reach
  the home's document, so the home's 3-minute idle lock would fire while the
  reader works in B. While a frame is on screen and the page is visible, the
  home counts that time as use (timer, going hidden, `pagehide`, the 401
  handler); it still locks a page left hidden past the window, and B keeps its
  own idle lock. Flagged below.
- **While framed, the home's own Back layer and steering are off**, and a failed
  home connect does not do its one-time `location.reload()` (it would reload B).
- **`/healthz` probe is `no-cors`.** A desktop that has not linked this app
  sends no CORS header, so a CORS probe could not tell it from one that is down;
  an opaque fetch resolves for any answer and rejects only on no answer. The
  home's `connect-src` already lists the linked origins. Phase 1's CORS on
  `/healthz` is therefore unused by the phone for now (harmless; kept for lamps).
- **Frame-side origin trust.** `location.ancestorOrigins[0]` when the browser
  has the list (Chrome, Safari) — then authoritative, no fallback even if empty.
  Without it (Firefox), the origin of `document.referrer`: the default
  `strict-origin-when-cross-origin` policy gives the shell's origin, and the
  sidecar sets no `Referrer-Policy`. It fails closed: own origin, empty, or
  non-https → no shell (the switch button hides, nothing is posted). Every send
  names its target origin, so a wrong guess is a dropped message; who may frame
  the page at all is the sidecar's `frame-ancestors`.
- **Client-side origin check** reuses `src/lib/linkedDesktops.ts`
  (`normalizeOrigin`, `tailnetOf`) plus "same tailnet as this page, not this
  page, ≤ 8"; anything else — and any cached entry this build would refuse — is
  dropped. A selection no longer listed falls back to the home.
- **Switch button**: Home's header (Home renders the header, not `App`), and a
  floating one on screens with no header. In the shell it shows only past the
  home's lock and with a non-empty list; inside a frame it shows on every such
  screen, including B's lock and pairing, so a reader is never stuck in B.
  Not on the project, terminal or section screens: Back to Home first.
- **Not-linked panel** covers the frame but keeps it mounted, so a slow desktop
  that says `ready` late still shows. Buttons: Try again (new frame), Choose a
  desktop (picker).
- **No shell → frame messages yet**; `acceptsFromShell` exists and is tested so
  the check is in place before the first one.
- **`desktopAvailable`** is stored per row (`available`) but shown nowhere yet
  (lamps are out of scope).

## Gotchas

- Tests need the page origin to be a `ts.net` https origin (the own-tailnet
  check): `// @vitest-environment-options {"url": "https://home.example.ts.net/"}`
  under `// @vitest-environment jsdom`.
- jsdom never loads a cross-origin iframe; its `contentWindow` is an
  `about:blank` window, which is enough for `event.source` checks. A
  `MessageEvent`'s `source` must be a real window.
- Frame-side tests stub `window.parent` with `vi.spyOn(window, "parent", "get")`
  and define `location.ancestorOrigins` by `Object.defineProperty` (jsdom has
  none); remove it in `afterEach`.
- `shell/` is split in three so `App` → `shellContext`/`DesktopFrame` and
  `DesktopShell` → `App` never import each other.
- `mobile-dist/` is not tracked; `npm run build` builds the phone bundle (it is
  part of the build gate), nothing to commit.

## Gates

`scripts/gates-job.sh start` (frontend change only): brand PASS, whitespace
PASS, lint-fe PASS, build PASS (tsc + desktop, mobile, web bundles), vitest
PASS (`--changed`; the job keeps no count on a pass). Rust gates skipped: no
Rust change. A first run failed `npm run build`'s tsc on the test's
`fetchMock.mock.calls[0][1]` (the mock declared one parameter); fixed.

Run by hand before the gate: `src/__tests__/mobile` 244 files / 2604 tests
passed (before the framed-page file was added); the three new files
`MobileDesktopShellCore` (14), `MobileDesktopShell` (6),
`MobileDesktopShellFramed` (3) pass. Nothing failed under load.

## Out of scope (later)

- Lamps (`/healthz` + last-known) and needs-you badges in the picker.
- `?desktop=<origin>&open=…` deep links.
- The steering "Switch desktop" key and `pickerKey` from a frame.
- Per-phone colour and order of desktops.
- Shell → frame `open {section, projectId, tabId}`.
- The push relay through the home (Phase 4).
- Phase 5 docs (`docs/context/mobile_access.md` "Linked desktops" layer,
  `mobile_sidecar.md`, DOCUMENTATION.md § Mobile).

## Flagged for user

Decisions:
1. **Home idle lock while a frame is on screen**: visible time counts as use
   (B keeps its own idle lock). The alternative is an `activity` message from
   the frame — a third message type the brief did not allow. Keep, or switch?
2. **Selected desktop persists across launches** (unlock → straight into B).
   Alternative: every launch starts at the home.
3. **"Hasn't linked this app yet" also covers a B that loads but predates
   Phase 3** (Phase 1 headers, no bridge): it is linked but too old, and the
   text then misleads. Say "…or needs an update"?
4. Switch button only on Home's header and header-less screens; not inside a
   project or terminal.

Real-phone checks (the plan's "Must verify" list, all still open), plus:
- Back across switching: B's `history.back()` traverses the joint session
  history and can pop the home's entries; after switching away from a desktop
  with open layers, a Back may cost one extra press (entries of a removed frame).
- Back with the picker open over B: B is `inert` behind the sheet; check B's
  own guard (if it had one) stays below the home's.
- Firefox Android: no `ancestorOrigins`; the referrer fallback should still
  find the shell.
- The not-linked panel appears after ~8 s for a desktop that refuses the frame
  (Chrome shows its broken-frame page until then).
- Focus lands in the frame after a switch (keyboard).
- iOS: safe-area padding of the stage (the shell pads; `env()` reads 0 inside).

### Reviewer (independent review, 2026-11-14)

Fixed (the `fix(mobile)` commit on top of 51a0782c8, each with a regression
test that fails without it):
- **The home's lock never fired while the home was down or connecting.**
  `App`'s idle `lock()` returned unless `auth === "paired"`, but the frame is
  shown from `loading`/`unavailable` too (the home-down case). A phone left
  hidden past the idle window with B framed came back to B with the home's
  lock skipped. Now `lock()` also locks (and so unmounts the frame) when a
  frame is on screen in those states; a `lockGen` counter makes a `resume()`
  started before the lock drop its late answer, which would otherwise have
  set `auth` back to `paired`/`unavailable` past the lock. Tests:
  `MobileDesktopShell.test.tsx` "the home's lock still takes the frame away
  while the home is down", "a connect still running at the lock does not undo
  it".
- **A frame whose parent's origin is unknown became a shell of its own.**
  `DesktopShell` chose the shell by `shellOrigin() !== null`, so without
  `ancestorOrigins` and without a referrer (Firefox; a self-navigated frame; a
  `no-referrer` parent) a framed B rendered `TopShell` and, with a selection
  cached in B's own storage, framed a third desktop inside A's frame. Any
  parent now means "framed" (plain `App`, no switch button) — fail closed, as
  the bridge's comment says. Test: `MobileDesktopShellFramed.test.tsx` "is
  never a shell of its own in a frame whose parent it cannot name".

Flagged, not changed:
- In such an unknown-parent frame `pushSupport()` still says `supported` (it
  asks `isFramed()`, i.e. a known shell origin), so the Notifications sheet
  offers a permission prompt a cross-origin frame cannot get. Cosmetic; could
  use "any parent" as well.
- The test "Back closes the picker and leaves the frame; the frame's own pops
  never reach the home" dispatches `popstate` on the iframe's own `about:blank`
  window, which by construction can never reach the home's listener — it does
  not test the real risk. That risk is B's own `history.back()` (its guard
  coming off) traversing the joint session history while the home's picker
  guard is the current entry: it pops the home's guard, and the home's
  `onPopState` (no `ownPops` pending) takes it for a user Back and closes the
  picker. jsdom has no joint history; device check only.
- A connect started before a lock that answers `paired` afterwards is ignored
  but leaves that sign-in's session open on the home until it expires (no
  `logoutAuth`, deliberately: a newer unlock's sign-in may already be running).
- With the home paired and a frame visible, the home never idle-locks while
  the screen stays on, even untouched (decision 1 above): only B's own idle
  lock stands then. Worth weighing when deciding 1.
