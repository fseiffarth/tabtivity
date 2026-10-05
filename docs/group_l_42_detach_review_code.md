# Code Review — Group L #42 (Detach a Subwindow Out of the Tabtivity Main Window)

Reviewer pass over the #42 implementation on `develop`, cross-checked against
`docs/group_l_42_detach_plan.md`, `docs/group_l_42_detach_plan_review.md`
(whose Blocker/Major items were required fixes), the user-locked decisions, and
the reviewer-mandated fixes. Unrelated uncommitted changes (boxes, tex, ollama,
fs_watch, etc.) were ignored.

## Verdict

**Needs fixes.** The hard cruxes are correct — the attach-only PTY rule and the
X11 parkable-override/parking link are both implemented faithfully and well, and
the persistence-on-switch fix (detached tabs not dropped mid-session) is in
place in BOTH save paths. But the feature is **not runnable as shipped**: the
main window never registers the host side of the detached protocol
(`listenDetachedHost` is dead code), so a popped-out window hangs forever on
"Loading subwindow…". Two user-locked / mandated behaviors are also missing
(Wayland hide() fallback; dock-on-close). None require rework — the architecture
is sound and matches the approved plan — but the wiring gaps must be closed
before this works at all.

## What I verified statically (passing)

- `npx tsc --noEmit`: fails ONLY with the known `SubwindowDetach.test.ts(15,82)`
  TS2556 (see Minor 1). No other type errors; it is not masking anything.
- `npx vitest run src/__tests__/SubwindowDetach.test.ts`: 8/8 pass.
- `cargo test` (full suite): all pass (lib 21, services 25, schema, etc.).
  The new `ParkableState`, `title_matches`, `find_window_for_title`, and
  `window_service` detached-origin tests pass.
- Attach-only PTY rule (decision #2): correct. `TerminalView` `attachOnly` skips
  `pty_spawn` (`TerminalView.tsx:268`) and skips `pty_kill` on unmount
  (`TerminalView.tsx:323`). `DetachedCenterPanel.tsx:140` passes `attachOnly` and
  uses the SAME id `${scope}:${tab.key}` (`DetachedCenterPanel.tsx:132`) so it
  re-attaches to the broadcast stream. Correct per the broadcast model.
- Parkable override (mandated fix): `ParkableState` is a FIELD on `X11Backend`
  (`x11.rs:43`) with `set_parkable`/`unset_parkable`/`set_main_window_id` trait
  methods defaulting to no-ops on null/Wayland (`platform/mod.rs:78-87`) — the
  trait `hide_window` signature is unchanged. The override is consulted BEFORE
  the `is_protected` early-return in both `show_window` (`x11.rs:148`) and
  `hide_window` (`x11.rs:173`). The main-window guard is structural:
  `add_parkable` refuses `main_window_id` (`x11.rs:60-69`) and the main id is
  recorded at startup (`lib.rs:189-197`). Tests cover all three invariants.
- Title resolver bypasses the protected filter (mandated fix):
  `find_window_for_title` (`x11.rs:541`) scans `list_client_windows` and matches
  `get_window_title` (`_NET_WM_NAME`) via the pure `title_matches`, with NO
  `protected` filtering — exactly the inverse of `find_window_for_pid`. Correct.
- `is_project_owned` includes `ORIGIN_DETACHED_SUBWINDOW`
  (`window_service.rs:78`); `project_window_ids`/`project_tracked_ids` therefore
  pick detached windows into the hide/show + persistence sets; tested.
- DetachedApp renderer is INERT to project switches (mandated fix): `App.tsx`
  branches on `parseDetachedParam` and renders `DetachedApp`, which does NOT
  mount the projects store, `listenProjectRuntimeSwitched`, or CenterPanel's
  scope-switch effect. Confirmed.
- Two WebViews do NOT share a store (mandated fix): detached window has its own
  React state seeded over Tauri events; only the MAIN window writes project.json
  (the detached side never invokes `save_tab_layout`). Confirmed.
- Persistence (decision #3): detached groups are re-docked into the persisted
  tree via `withDetachedDocked` in BOTH `saveLayout` (`tabs.ts:1272`) and the
  `setActive` switch snapshot (`projects.ts:178`). The `setActive` snapshot also
  reads the authoritative `layoutByScope[prevScope]` synchronously before any
  await. So detached tabs are NOT dropped from project.json mid-session. Correct.

---

## Findings

### 1. [Blocker] `listenDetachedHost()` is dead code — the detached window never gets seeded; the whole protocol is non-functional.

`detached.ts:164` exports `listenDetachedHost`, which registers the MAIN
window's listeners for `DETACHED_REQUEST_SEED`, `DETACHED_EDIT`, and
`DETACHED_DOCK`. It is **never called anywhere** (`grep -rn listenDetachedHost
src/` → only its own definition; it is absent from `AppShell.tsx`, `App.tsx`,
`main.tsx`).

Consequence: on mount the detached window emits `DETACHED_REQUEST_SEED`
(`DetachedApp.tsx:56`) and waits for a `detached-seed-<label>` event that the
main window never sends (no listener exists). `DetachedApp` therefore renders
`"Loading subwindow…"` (`DetachedApp.tsx:74-76`) **forever** — no tabs, no
panes, no PTY attach. Edits and dock-back from the detached window are likewise
dropped. The feature does not work end-to-end.

**Fix:** register the host once in the MAIN window only (e.g. in `AppShell`'s
startup effect alongside `listenProjectRuntimeSwitched`, or guarded in
`main.tsx` so the detached branch does NOT also register it). Store the returned
unlisten and call it on teardown. Add a test (or at least a smoke assertion)
that the host is wired in the main-window branch and NOT in the detached branch.

### 2. [Major] Wayland/KDE fallback (user-locked decision #4) is not implemented — a detached window of an inactive project floats over all projects on Wayland.

Decision #4 requires that on Wayland/KDE (where desktop-parking is a no-op) a
detached window of an inactive project be `hide()`/minimized rather than left
floating. `wayland_kde.rs` is unchanged, `NullBackend` likewise, and nothing in
the switch path (`services/project_runtime.rs`) or `subwindow.rs` calls Tauri's
`window.hide()`/`minimize()` for detached windows. On Wayland the backend
`hide_window` is a no-op, so a parked detached window stays visible across every
project switch — the exact bug #42 forbids, just on a different backend.

**Fix:** on the switch path, for `ORIGIN_DETACHED_SUBWINDOW` windows of the
outgoing project, also drive a Tauri-level `WebviewWindow::hide()` (and
`show()`/`unminimize()` on switch-back) when the backend can't desktop-park.
Simplest robust form: always `hide()`/`show()` the detached `WebviewWindow` by
label on switch (works on every backend) instead of relying solely on the X11
desktop move. This is a backend (`subwindow.rs`/`project_runtime.rs`) change, so
it needs a rebuild + live QA. (Plan-review Finding 9 framed this as optional,
but the reviewer brief lists it as a user-locked decision — treat as required.)

### 3. [Major] Closing the detached OS window via the WM orphans the group mid-session (no dock-on-close).

`DetachedApp`/`DetachedCenterPanel` register no `onCloseRequested` /
window-close handler (`grep` for `onCloseRequested|close-requested` → none).
The only path that removes a `DetachedGroup` from `detachedGroupsByScope` and
re-docks it is the explicit "dock back" button → `DETACHED_DOCK` → `attachGroup`
(blocked anyway by Finding 1). If the user closes the detached window with the
WM/title-bar (or it crashes), the group stays in `detachedGroupsByScope`
forever: its tabs are invisible in the main window (its panes are gone) yet its
PTYs survive (good — `attachOnly` never killed them), so the group is stranded
mid-session. On-disk it persists as docked via `withDetachedDocked`, so a
RESTART recovers it; but mid-session it's lost until restart.

**Fix:** in the detached window, register `getCurrentWindow().onCloseRequested`
to emit `DETACHED_DOCK` (preventing default close until the main window has
docked, or fire-and-forget then close). The plan called this out as Phase 5
"dock-on-close (closing the detached OS window re-docks the group rather than
destroying its tabs)".

### 4. [Minor] `SubwindowDetach.test.ts(15,82)` TS2556 — the one known tsc failure.

`vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) =>
invokeMock(...a) }))` spreads into a zero-arg `vi.fn()`. Confirmed this is the
ONLY tsc error and it is a test-typing nit, not a real type error (the test runs
and passes). **Fix:** type the hoisted mock with a rest param, e.g.
`invokeMock: vi.fn((..._a: unknown[]) => Promise.resolve(undefined))`. Must-fix
because `tsc --noEmit` is part of the dev workflow / CI gate.

### 5. [Minor] Cross-scope dock-back is silently ignored with a confused comment.

`listenDetachedHost`'s `DETACHED_DOCK` handler (`detached.ts:181-196`) only
docks when `store.scope === scope`; the `else` branch is an empty no-op whose
comment is self-contradictory ("invoking the backend directly via attachGroup's
bookkeeping is scope-bound, so fall back to a no-scope-change dock by switching
is out of scope here"). In practice a user can only dock-back a *visible*
detached window, and detached windows of inactive projects are parked/hidden, so
this rarely bites — but a dock-back arriving for a non-active scope drops the
request with no user feedback and leaves the OS window open. **Fix:** at minimum
still close the OS window + drop the `DetachedGroup` record for the foreign
scope (call `attach_subwindow` by the stored label and mutate
`detachedGroupsByScope[scope]` directly), and clean up the comment.

### 6. [Minor] `applyDetachedEdit`/`applyEditToSubtree` `reorder` does not refresh `activeKey`; the two reducers also duplicate logic.

`tabs.ts` `applyDetachedEdit` reorder branch sets `tabKeys` but never re-derives
`activeKey` (fine, since reorder preserves membership), whereas the parallel
`detached.ts:applyEditToSubtree` reorder DOES recompute `activeKey`. The two
reducers are near-duplicates that can drift (the file even documents the
duplication to avoid a circular import). Low risk; consider having the main
store reuse the pure `applyEditToSubtree` (import direction permitting) so there
is a single source of truth.

### 7. [Minor] Detached `WebviewWindowBuilder` likely needs an explicit webview-create permission; capabilities only widen the window glob.

`capabilities/default.json` adds `"detached-*"` to `windows` and relies on
`core:default` for the rest. Tauri 2 gates runtime `WebviewWindowBuilder` behind
`core:webview:allow-create-webview-window` (and cross-window `emit`/`emit_to`
behind event permissions). `core:default` may or may not include create-window
depending on the Tauri version. This can't be confirmed statically here (no app
launch). **Action:** verify at runtime that `detach_subwindow` actually builds
the window; if it errors with a permission denial, add
`core:webview:allow-create-webview-window` (and the relevant event permissions)
to the capability. Flag for live QA.

### 8. [Minor] X11 id resolution blocks the `detach_subwindow` command for up to ~2s.

`resolve_detached_window_id` calls `find_window_for_title(title, 20)` with 100ms
sleeps (`subwindow.rs:132`, `x11.rs:557`) **synchronously inside the Tauri
command**, so a slow compositor can block the command (and the calling frontend
`invoke`) for up to ~2 seconds. This is deliberate (reviewer Finding 7: resolve
before returning so the id is always registered before the window is parkable),
and the frontend `invoke(...).catch()` is fire-and-forget so the UI isn't frozen
— but it does tie up a Tauri worker thread. Acceptable for v1; note it. Not a
bug.

---

## Layout-tree integrity / #55 leak check (verified)

- `writeScope` now stamps/repairs `scope` on every tab, DROPS foreign-scope
  tabs, and prunes the in-window layout to surviving keys via
  `pruneLayoutToKeys` (`tabs.ts:511-525`). Detached tab payloads stay in
  `tabsByScope[scope]`, so they are counted in `ownedKeys` and never pruned.
- Detached subtrees live OUTSIDE `layoutByScope`, so `pruneLayoutToKeys` doesn't
  touch them; their integrity is maintained by `applyDetachedEdit`.
- No #55 leak found in the detached path: a detached group's tabs carry the
  owning scope and are persisted only into that scope's project.json (via
  `withDetachedDocked` under the correct `localFile`).
- No double project.json writer: the detached window never calls
  `save_tab_layout`; only the main window persists.

## What genuinely needs LIVE QA (cannot be checked statically)

1. End-to-end pop-out: a borderless OS window appears, seeded with the group's
   tabs, panes working (REQUIRES Finding 1 fixed first — currently it hangs).
2. PTY did-not-respawn: detached terminal attaches to the live PTY (no scrollback
   loss, agent session intact) — the attach-only code is correct but the X11
   broadcast attach is runtime-only.
3. Parking on X11: switching projects parks the detached window on the hidden
   desktop and re-shows on switch-back; the MAIN window is NEVER parked.
4. X11 id resolution race: a detached window resolves its id before the first
   switch (else it floats transiently).
5. Wayland degradation (Finding 2): currently the window floats; after the fix,
   it should hide()/minimize.
6. Capability/permission for runtime `WebviewWindowBuilder` + cross-window
   `emit` (Finding 7).
7. Dock-on-close (Finding 3) and dock-back button round-trip.

## Test-coverage gaps

- **No host-wiring test** — the dead `listenDetachedHost` (Finding 1) would have
  been caught by a test asserting the main branch registers it.
- **No `detached.ts` reducer tests** — the plan called for `DetachedParam.test`
  and `DetachedSync.test`. `parseDetachedParam`, `buildSeed`,
  `applyEditToSubtree`, `applyRenameToTabs` are untested.
- **No attach-only TerminalView test** — assert that `attachOnly` prevents
  `pty_spawn`/`pty_kill` (mockable invoke). This is the riskiest correctness
  crux and currently has zero automated coverage.
- **No `withDetachedDocked` + `setActive` integration test** — `SubwindowDetach`
  tests `withDetachedDocked` in isolation but not that the project-switch
  snapshot actually persists detached tabs.

---

## Must-fix list for the next coder (priority order)

1. **[Blocker]** Wire `listenDetachedHost()` into the MAIN window startup (once),
   with teardown; ensure the detached branch does NOT register it. Without this
   the feature does nothing.
2. **[Major]** Implement the Wayland/KDE/null fallback (decision #4): `hide()` /
   `minimize()` the detached `WebviewWindow` for the outgoing project on switch
   and restore on switch-back (simplest: always hide/show the detached window by
   label regardless of backend).
3. **[Major]** Dock-on-close: detached window's `onCloseRequested` emits
   `DETACHED_DOCK` so closing the OS window re-docks the group instead of
   stranding it mid-session.
4. **[Minor]** Fix `SubwindowDetach.test.ts:15` TS2556 (rest-param the mock) so
   `tsc --noEmit` is clean.
5. **[Minor]** Make cross-scope dock-back close the window + drop the record (or
   document the limitation) and fix the misleading comment (`detached.ts:189-195`).
6. **[Minor]** Verify the runtime webview-create / emit capability; add the
   permission if `detach_subwindow` fails at runtime.
7. **Tests:** add `detached.ts` reducer tests, an attach-only TerminalView test,
   and a host-wiring assertion.
