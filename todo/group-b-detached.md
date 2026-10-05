## Group B — Detached Windows: Parity & Cross-Window Correctness

- [ ] 🖐️ **A popout whose screen is gone stays detached, on the main window's
  screen (2026-10-05).** Still after the 2026-09-29 fix (Wayland): unplugging
  docked DS_GNN_GED's and DS_ShareGNN's popouts. Disconnecting stalls the main
  window, a respawned popout gave up on its seed three times in a minute, and
  that docked it; a failed rebuild docked after ~30 s. Now only ≥3 min of
  nothing but give-ups docks (a rebuild retries ~3.5 min). A Wayland respawn
  whose screen is gone goes fullscreen-hop onto the main window's screen (size
  capped to it), not the pointer's; X11/Windows/macOS centre it on the main
  window's screen. Check: popouts on the external screen (also of a project
  you are not in), unplug, keep working, switch projects. Expect every popout
  its own window on the laptop panel. Not run live (`subwindow.rs`,
  `detached.ts`).
  - [ ] ✅ Works on Linux (X11)
  - [ ] ❌ Doesn't work on Linux (X11)
  - [ ] ✅ Works on Linux (Wayland)
  - [ ] ❌ Doesn't work on Linux (Wayland)
  - [ ] ✅ Works on Windows
  - [ ] ❌ Doesn't work on Windows
  - [ ] ✅ Works on macOS
  - [ ] ❌ Doesn't work on macOS
- [ ] 🖐️ **Switching to one screen keeps popouts separate (2026-09-29).**
  Still after the 2026-09-24 retry fix: going from several screens to one
  docked popouts into the main window's subwindow. A compositor may drop a
  popout at each step of the display switch, and the third death within a
  minute docked it. Now only a popout that gave up on its own (no seed, so it
  cannot render: `DETACHED_GAVE_UP`) is ever docked; any other death reopens it
  from its record, backing off from the third death on, and a failed rebuild
  retries for ~30 s instead of 3 s. Check: popouts on the external screen,
  switch to the built-in display only (Super+P or unplug), then back. Expect
  every popout still its own window. Not run live (`detached.ts` host).
  - [ ] ✅ Works on Linux (X11)
  - [ ] ❌ Doesn't work on Linux (X11)
  - [ ] ✅ Works on Linux (Wayland)
  - [ ] ❌ Doesn't work on Linux (Wayland)
  - [ ] ✅ Works on Windows
  - [ ] ❌ Doesn't work on Windows
  - [ ] ✅ Works on macOS
  - [ ] ❌ Doesn't work on macOS
- [ ] 🖐️ **Wayland popout respawns on its own screen (2026-09-25).** A popout
  closed by a project switch (no unsaved work) came back on the pointer's
  screen, while one kept minimized for unsaved work kept its screen — so one
  project's popouts "worked" and another's didn't. The retire now records the
  popout's monitor (GDK's output for its surface); the respawn is shown
  fullscreen on that monitor and dropped out of fullscreen at once, which is
  where Mutter then places it, and gets its size back. Check: two projects,
  each with a popout on the second screen and the main window on the first;
  switch back and forth; also a popout with an unsaved edit. Expect a brief
  fullscreen flash on the right screen, then the popout at its size there.
  Not run live (`subwindow.rs` `present_on_monitor`).
  - [ ] ✅ Works on Linux (Wayland)
  - [ ] ❌ Doesn't work on Linux (Wayland)
- [ ] **GNOME Wayland monitor retention (2026-09-17): live verification.**
  Scope switches now minimize popouts and present their existing surfaces on
  return. Hiding destroyed GTK's Wayland toplevel and lost GNOME's monitor
  placement; desktop coordinates cannot restore it. Parking requests are
  tracked independently of GTK's unreliable minimized flag, including renderer
  polling/streaming and bounds-save gating. Minimized popouts may remain in
  GNOME's overview/window switcher. After a backend restart, place two popouts
  on different monitors, switch projects and back repeatedly, then try root/box
  scopes and unplugging a monitor while parked. Check placement, size, focus,
  and that every popout returns. Not run live.

*Created 2026-09-01 from a two-agent code audit (one agent for feature parity
inside a popout, one for every cross-window action), each finding then
spot-checked by hand against the tree.*

*Implemented 2026-09-01. #224–#238 and #240 are **code-complete and under
automated test**; every ✅/❌ manual box below is still open — nothing in this
group has been run live, and the backend half needs a restart to be in the
window at all. #239 is a decision list and is **partly** done: the items worth
building are built and ticked individually; the rest are documented in place.*

*Review hardening integrated 2026-09-01: StrictMode now preserves the popout
store seam; close/hide/dock destruction is host-owned; settings patches are an
atomic backend transaction with ordered refreshes; terminal scrollback and live
events share byte offsets; box records plus primary/worker status are seeded;
and seed replies wait until the complete host protocol is registered. Automated
gates are green; live boxes remain open.*

*Files: `src/stores/detached.ts`, `src/stores/tabs.ts` (the `*Detached*`
actions), **`src/stores/detachedContext.ts`** (new — the popout's store seam),
`src/components/layout/DetachedApp.tsx`,
`src/components/layout/DetachedCenterPanel.tsx`,
**`src/components/layout/DetachedCloseChoice.tsx`** (new),
`src/components/layout/CenterPanel.tsx` (respawn effect, drag END ladder),
`src/components/tabs/detachedDropTargets.ts`,
**`src/components/tabs/detachedDragNet.ts`** (new), `src/components/tabs/TabPane.tsx`,
`src/components/terminal/TerminalView.tsx`, `src/stores/settings.ts`,
`src/stores/activity.ts`, `src/stores/usage.ts`, `src/stores/remote/hpc/hpcGuardPrompt.ts`,
`src-tauri/src/commands/subwindow.rs`, `src-tauri/src/commands/terminal.rs`,
`src-tauri/src/terminal/mod.rs`, `src-tauri/src/services/project_runtime.rs`,
`src-tauri/src/lib.rs` (`WindowEvent::Destroyed`).*

**The shape of the fix.** Three seams carry most of it. (1)
`stores/detachedContext` — a popout installs a context saying "this heap does
not own the tabs", and the STORES consult it, forwarding a pane's write to the
main window as the matching edit instead of dropping it into an empty store. So
a pane behaves identically wherever it is mounted, and no call site had to learn
about windows. (2) The host now **subscribes** to the tabs/projects/remote-status
stores and reseeds the popouts a change touches, so main-side edits no longer
wait for an unrelated reseed. (3) `WindowEvent::Destroyed` reports every popout
death to the frontend, which docks a surviving record back — the single choke
point that turns "the window is gone" from tab loss into a dock-back.

**Why this is its own group.** L#42 built the popout; this group is what the
audit found once the popout had been lived in. The theme across the first eight
items is one fact: a popout is a **second React root with its own Zustand
heap**, kept in step by a streamed protocol — and every place that forgot this
(a store write that lands in the popout's empty store, an id minted from the
popout's counter, a settings snapshot taken once) becomes a silent no-op or a
silent overwrite. The second fact turned several of these into **tab loss**:
there was **no dock-back gesture any more** — no ⤓ button, no whole-popout
drag-dock — so any path that lost the popout window lost the tabs. #224, #225,
#228 and #237 were the tab-loss set and outranked the rest. #237 is now a ⤓ in
the popout's title bar plus a dock-or-close question on the WM ✕, which is what
makes the rest recoverable rather than merely rarer.

**Orientation** (the memory notes and L#42's text predate these): detach spawns
the OS window at the drop point on release, it no longer `startDragging`s; the
popout's `TerminalView`s are attach-only and the main window keeps rendering
every pane so it owns all PTYs; the popout renders from streamed props and its
`useTabsStore` still holds **no** tabs or layout — what changed is that its
writes are now forwarded rather than dropped.

---

### B.1 — Tab loss and data loss

224. **Box-scope detach can never seed, and a popout that fails to come up
     strands its tabs.** `detachGroup` builds `?detached=${scope}:${groupId}`
     (`tabs.ts:2699`, `subwindow.rs:46`); a box scope is `box:<id>`
     (`boxes.ts:10`), and `parseDetachedParam` splits on the **first** colon
     (`detached.ts:53-56`) → the popout asks for scope `"box"`, group
     `"<id>:g-3"`. The host finds no record, never answers, and after 8 s the
     popout `destroy()`s itself (`DetachedApp.tsx:465-470`). The main store
     still holds the detached record: the group's tabs are gone from the
     layout with no window and no dock-back path, their PTYs run hidden, and
     the record is persisted `detached:true` so the respawn repeats the failure
     at every launch. The same store-side hole is what makes *any* popout
     failure lossy: `detachGroup` records first and swallows a
     `detach_subwindow` error (`tabs.ts:2739-2753`); the seed-timeout
     self-destroy and the `WindowEvent::Destroyed` hook (`lib.rs:1338-1354`)
     free only backend state. Fix both halves: parse the scope from the **last**
     colon (or pass the group as its own query key), and make every
     popout-failure path — creation error, seed timeout, unexpected `Destroyed`
     — dock the record back into the main layout instead of leaving it.
     **Fixed.** The query is two keys now — `?detached=<scope>&group=<gid>`,
     percent-encoded (`subwindow.rs`'s `detached_query`) — so the scope is
     opaque and a colon in it cannot re-split; `parseDetachedParam` reads that
     form and still accepts the legacy one, splitting it on the LAST colon. The
     store-side hole is closed by `recoverDetachedGroup`, which docks a record
     back into the live layout (active scope) or the stored one (parked), called
     from all three failure paths: `detachGroup`'s rejected `detach_subwindow`,
     and — via the new `detached-window-destroyed` event the `Destroyed` hook
     emits — the seed-timeout self-destroy and any unexpected death. A record
     dropped before its window (every legitimate teardown) is not there to
     recover, so the ordinary paths are untouched.
     - [x] 🤖 Automated test — `parseDetachedParam` yields scope `box:abc` from
       both query forms; a `detachGroup` whose `detach_subwindow` rejects leaves
       the group in the main layout with no detached record; a
       `detached-window-destroyed` for a live record docks its tabs back
       (`DetachedTwoHeap.test.ts`, `DetachedSync.test.ts`,
       `subwindow.rs`'s query tests).
     - [ ] 🖐️ Manual test — open a box scope, drag a subwindow out: it comes
       up seeded, and a relaunch respawns it. Then kill a popout with
       `xkill`: its tabs reappear docked in the main window.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

225. **A main-window reload orphans every popout and spawns duplicates.** The
     renderer watchdog (U#223), the crash reporter and a dev full reload all
     re-hydrate the scope from disk (`CenterPanel.tsx:208-266`); that mints
     fresh tab keys (`tabs.ts:3862-3871`) and group ids, the `detached:true`
     groups queue a respawn, and `detachGroup` opens **new** popouts under new
     labels (`CenterPanel.tsx:323-332`; `subwindow.rs:148-151` is idempotent
     by label, so it does not reuse the old window). Nothing tells the old
     popouts: they only re-request a seed until their first one lands
     (`DetachedApp.tsx:412, 466-479`), so they stay on screen showing stale
     tabs, their `DETACHED_EDIT`s hit no record and are dropped
     (`tabs.ts:3363-3364`), and their PTY ids are orphaned in the backend
     registry — still interactive in a zombie window until app exit. There is
     no `beforeunload`/`pagehide` handler anywhere but `DeckView.tsx:473`.
     Given the 2026-09-01 30 s reload loop with a 4.7 GB popout open, this is
     the likeliest single source of "detached windows are error prone". Fix:
     on hydrate, either **adopt** live `detached-*` windows by label (re-seed
     them under the re-minted ids) or destroy every popout of the scope before
     rehydrating — never both old and new.
     **Fixed** by the destroy half, deliberately: adoption is not available,
     because a popout's group id is baked into its URL at spawn, so a window
     opened under the pre-reload id can never be re-seeded under the re-minted
     one without reloading it anyway. `closeOrphanedPopouts` runs once as the
     shell mounts — the instant at which the store is still empty, so every live
     `detached-*` window is by construction a leftover from a previous page load
     of this same renderer (a fresh launch has none). `destroy()`, not `close()`:
     the old window's own close handler would emit `DETACHED_CLOSE` and take the
     group's tabs with it. The tabs come back in the freshly respawned window.
     - [x] 🤖 Automated test — with two `detached-*` windows live and an empty
       store, startup destroys both and leaves the main window alone; a popout
       the store still tracks is not destroyed (`DetachedTwoHeap.test.ts`).
     - [ ] 🖐️ Manual test — with a popout open, trigger a main-window reload
       (debug footer → reload, or the watchdog's dev override): exactly one
       popout remains and its terminal still accepts input.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

226. **A popout writes the whole `settings.json` from a snapshot loaded
     once.** `updateSettings` spreads the cached `settings` object and saves
     the entire file (`settings.ts:410-418, 451-475`); `DetachedApp` loads
     settings once at mount (`DetachedApp.tsx:106-108`) and the only
     cross-window updates it receives — `THEME/LANGUAGE/APPEARANCE_CHANGED`
     (`:249-291`) — touch the DOM, not the store. Writers reachable from inside
     a popout: `CustomAgentDialog` (custom agents), `SystemMonitorPane:847,870`
     (careful-mode toggle), `useAlertsFeed` (alert mute),
     `ProjectFilesSettings` (tree grouping/alerts from the docked ◫ column's
     ⚙), `DeckThemePanel`, `FileViewerPane:5661` (`setPythonRunArgs`). Open a
     popout, change the theme / add an `hpc_hosts` entry / rebind a shortcut
     in main, then mute one alert in the popout → `settings.json` is rewritten
     from the popout's stale copy and the main-window changes are gone at next
     launch; mirror image for a custom agent added in the popout. Same root
     cause on the read side: the popout's `useSettingsStore` never sees later
     changes, so `TerminalView.tsx:319` keeps the old xterm palette after a
     theme switch (the chrome recolours, the terminal does not), `:362`
     `terminal_webgl`, `fastMode.ts:64` (Fast mode toggled in main does not
     reach an open popout, contrary to the comment at `DetachedApp.tsx:134-138`),
     `DetachedCenterPanel.tsx:436-437` (rebound shortcuts), `:332-333` (min
     subwindow size), and the energy-saver preference. Fix: a
     `SETTINGS_CHANGED` broadcast that refreshes every window's store, **and**
     `baseForWrite` re-reading `get_settings` in any window that does not own
     the tabs (the branch already exists; gate it on `!ownsTabs`).
     **Fixed**, both halves. `SETTINGS_CHANGED_EVENT` carries the whole settings
     object after every write and `listenSettingsChanged` applies it to the
     store in every window (mounted by `AppShell` *and* `DetachedApp`) — so a
     popout's xterm palette, shortcut map, Fast mode, min-subwindow size and
     energy-saver preference all follow a change made anywhere. And
     `baseForWrite` re-reads `get_settings` whenever `isDetachedWindow()`, so a
     popout's own write merges onto what is on disk rather than onto the
     snapshot it took at mount. The per-document appliers keep their dedicated
     events: a popout must not inherit the main window's zoom.
     - [x] 🤖 Automated test — a popout's `updateSettings` after an out-of-band
       change writes a file holding both; the broadcast moves another window's
       store, not just its DOM (`DetachedTwoHeap.test.ts`).
     - [ ] 🖐️ Manual test — theme switch in main, mute an alert in a popout,
       relaunch: the theme survives; the popout's terminal palette follows the
       theme switch live.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

227. **Layout node ids are minted per JS heap.** The popout's optimistic
     `split` edit runs `splitSubtree` (`detached.ts:404-407`), which mints
     `nextGroupId()` from the popout's **own** `_nodeCounter`
     (`tabs.ts:1361-1367, 1566-1568`); main mints a different id when it
     applies the same edit (`tabs.ts:3422-3426`). From then on every popout
     edit naming a node — `resize splitId`, `move targetGroupId`,
     `files groupId`, `add targetGroupId` — refers to an id main does not
     have: `applyResize` and `moveKeyInTree` no-op, `addDetachedTabSplit`
     returns `{}` and the drop is silently lost (`:3551`), `addDetachedTab`
     falls back to the first pane (`:3508`). The popout's counter starts at 1,
     so its `g-1` can collide with a real id in the seeded subtree — a `files`
     toggle then hits the *wrong* pane. The next reseed replaces the popout's
     tree with main's ids; `renderNode` keys groups by `child.id`
     (`DetachedCenterPanel.tsx:1550`), so groups remount and every attach-only
     xterm is disposed and recreated blank (#235). Divider positions never
     persist. Fix: mint in main only — make the popout's `split` edit
     non-optimistic (wait for the reseed) or have main return the minted ids.
     **Fixed** by a third route that keeps the optimism: the popout mints the
     ids and **ships them in the edit** (`mintDetachedSplitIds`, namespaced by
     the popout's window label so two counters cannot collide), and the main
     store adopts them. That much predates this group; what it was still missing
     is a collision check — the counter restarts at 0 when the popout's webview
     reloads, so a post-reload split could re-mint an id the tree still carried,
     and `splitSubtree` would quietly swap in a fresh one the popout never
     learns about. `mintDetachedSplitIds` now takes the tree's existing ids
     (`allNodeIds`) and skips past them. With the names agreed, the seed-driven
     remount that blanked every attach-only xterm does not happen; #235's
     catch-up makes any remount harmless regardless.
     - [x] 🤖 Automated test — a `split` edit applied in both heaps yields trees
       with identical node ids; a fresh heap cannot re-mint an id its tree
       already carries; a following `resize` from the popout changes main's
       fraction (`DetachedTwoHeap.test.ts`, `DetachedSplitIds.test.ts`).
     - [ ] 🖐️ Manual test — split a popout, drag the divider, relaunch: the
       divider is where it was left and no pane went blank.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

228. **"Close all tabs" with a popout open orphans its PTYs.** `closeAllTabs`
     (chord `useKeyboard.ts:339-342`, TabBar menu `TabBar.tsx:1613`) writes
     `writeScope(target, [], null)` (`tabs.ts:2308-2321`), dropping the popout
     tabs' payloads too. Their main panes unmount while the detached record
     still exists, so `isDetachedPtyId` skips `pty_kill`
     (`TerminalView.tsx:1033`) → PTYs orphaned; the record keeps keys with no
     payload, the popout keeps rendering them against the orphan, any reseed
     empties it, and its × → `close` edit is a no-op. Fix: `closeAllTabs`
     (and every other scope-emptying path) destroys the scope's popouts and
     drops their records **before** emptying, the way `unloadScope` does
     (`tabs.ts:2323-2355`).
     **Fixed.** `closeAllTabs` kills each popout tab's PTY explicitly (mirroring
     `closeDetachedGroup` — the popout's panes are attach-only, so nothing else
     would), closes the OS windows, and drops the scope's `detached`, `hidden`
     and `pendingRespawn` records along with its payloads; it also purges the
     per-PTY prompt state, which the old version skipped. `unloadScope` was
     corrected in the same pass — it closed the windows BEFORE dropping their
     records, which now reads as a crash to the `Destroyed` hook (#224), so the
     order is records first, windows second.
     - [x] 🤖 Automated test — `closeAllTabs` on a scope with a detached record
       kills the detached tabs' PTYs, closes the window and leaves no record
       (`DetachedTwoHeap.test.ts`).
     - [ ] 🖐️ Manual test — popout open, Close all tabs: the popout closes,
       `ps` shows no surviving shell for it.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

229. **Root and box popouts closed while another project is active come back
     at next launch.** The `DETACHED_CLOSE`/`DETACHED_HIDE` handlers persist
     only `if (localFile)` (`detached.ts:669-672, 686-689`) and
     `shutdownDetachedWindows` skips scopes without a `project.json`
     (`:725-728`) — but root now persists under `sessions/root/`
     (`tabs.ts:4142-4147`). Root was last persisted at switch-away with the
     popout still detached, `onCloseRequested` saves only the active project
     (`AppShell.tsx:614-620`), so a closed root popout returns (a hidden one
     returns floating). Root popouts are also never parked (#238), so this is
     an everyday path. Fix: persist through the same scope-aware writer the
     tab store uses, for every scope that has a session directory.
     **Fixed.** One `persistScopeNow(scope)` helper behind the close, hide and
     dock handlers, and in `shutdownDetachedWindows`: it looks up a `local_file`
     if there is one and passes `""` otherwise, which is exactly what the
     backend wants for a scope with no project-tree export copy. The `if
     (localFile)` gate is gone from all four — it read "no project.json" as
     "cannot persist", when root and `box:<id>` scopes persist under their own
     session directory and differ only in the export path.
     - [x] 🤖 Automated test — the quit teardown persists a scope with no
       project entry as `{ projectId, localFile: "" }` rather than skipping it
       (`DetachedHost.test.ts`).
     - [ ] 🖐️ Manual test — pop out a root subwindow, switch to a project,
       close the popout via the WM, relaunch: it stays closed.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

230. **`reseedDetached` drops `remote`.** `detachedDropTargets.ts:189-195`
     calls `buildSeed` with five arguments (no `remoteInfoForScope`), unlike
     the host's seed/add paths (`detached.ts:587-595, 618-626`), and
     `DetachedApp` applies `setRemoteInfo(ev.payload.remote)` unconditionally
     (`DetachedApp.tsx:436`). Every main→popout dock, popout→popout move,
     popout→main dock (source reseed), `closeTabsForDeletedPath` and rename
     retarget therefore wipes a remote project's popout: locality badges and
     menu vanish, the docked viewer loses `project` (Local/Remote switch,
     run-host picker) and reads the tree as a plain local folder. One-line
     fix; add the sixth argument.
     **Fixed** by deleting the duplicate rather than adding the argument to it:
     `reseedDetached` now lives in `stores/detached` beside the host's own seed
     path and is the ONE reseed in the app (`detachedDropTargets` re-exports it
     so the drop sites' imports are unchanged). Two copies of "build a seed" is
     what let one of them forget a field.
     - [x] 🤖 Automated test — a reseed after a dock carries the same project
       context as the initial seed (`DetachedTwoHeap.test.ts`).
     - [ ] 🖐️ Manual test — remote project, popout, drag a tab from main into
       it: the locality badges stay.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

### B.2 — Parity inside the popout

231. **Pane code that writes the tabs store silently no-ops in a popout.**
     The popout's `useTabsStore` has no tabs or layout, so everything below
     finds no tab and returns, or adds a tab to an invisible phantom layout:
     Ctrl+click on a file link in a popped-out README / SyncTeX source jump /
     md graph / orange-list open (`FileViewerPane.tsx:735-780`
     `openLinkedFile`, callers `:6398, :6474, :919, :717`,
     `ProjectFilesView.tsx:1840, 2035`); **viewer state never persists**
     (`FileViewerPane.tsx:218-224` → `tabs.ts:2411-2416` `if (!tab) return {}`
     — scroll/zoom/font/sort/delimiter and **Python breakpoints** set in a
     popped-out editor are lost on relaunch); Git "resolve in terminal"
     (`GitHistory.tsx:570`); Sessions view open/kill/rename/owner marks
     (`ProjectFilesView.tsx:712-778` — a renamed tmux session reattaches to
     the old name next launch); `SyncMergeView.tsx:117` Close;
     `DiskUsagePane.tsx:240` "reveal in Files"; `CustomAgentDialog.tsx:115` →
     `installCommand.ts:80-89` Install (tab into the phantom root scope, and
     the overlay store is popout-local — host only in `AppShell.tsx:1038`).
     Tree double-click and drops are fine (they go through
     `FileDropContext.openTab`). Fix: one routed writer — every tabs-store
     write from a pane goes through a `useTabActions()` seam that, in a
     popout, emits the corresponding `DETACHED_EDIT` (`add`, `setViewerState`,
     `setTabTmuxName`, …) instead of touching the local store.
     **Fixed**, and one level below the suggested seam: rather than a
     `useTabActions()` hook every pane has to remember to use, the STORE
     ACTIONS consult `stores/detachedContext` and forward. A pane calls
     `useTabsStore.getState().setViewerState(...)` exactly as it always did and
     it works in both windows; a future pane gets the behaviour for free instead
     of having to opt in. Routed: `addTab`/`addTabToScope` (a tab for another
     scope rides `addToScope`), `splitWithNewTab`, `setActive`, `removeTab`
     (through the popout's own close, so the last tab still closes the window),
     `renameTab`, `setViewerState` (which also updates the popout's seed
     registry, so a pane remounting before the next reseed still recovers it),
     `setTabTmuxName`, `setTabFolder` and `setTabUrl`. New edit kinds
     `setViewerState`/`setTmuxName`/`setFolder`/`setUrl`/`addToScope` carry them.
     The `ownsTabs` prop is gone from `TabPane`/`BrowserPane` with its reason —
     panes may write from either window now.
     - [x] 🤖 Automated test — a link opened in a popout mints the tab in main,
       inside the popout, and lands it; viewer state, a tmux rename and a
       browsed folder set in a popout all arrive on main's payload
       (`DetachedTwoHeap.test.ts`).
     - [ ] 🖐️ Manual test — Ctrl+click a link in a popped-out README opens
       the file; set a breakpoint in a popped-out `.py`, relaunch, it is still
       there.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

232. **A popout of a local project has no project identity.**
     `remoteInfoForScope` returns `undefined` unless `project.remote`
     (`detached.ts:558-561`), so `DetachedCenterPanel.tsx:1514` injects
     nothing and `ProjectFilesTab.tsx:104-111` resolves `project = null`,
     `projectId = null`, `projectDir = tab.cwd`. `ProjectFilesView` gates ~50
     things on `projectId` (`:1569` the whole view block, `:345` remarks,
     `:491` git probes, `:1451` SLURM, …), `FileTree.tsx:659-667`
     (`isRemote`, `mirrorRoot`). Result: the ◫ column and any Files (Project)
     tab in a local-project popout is a bare tree — no git bar/history, no
     project settings, no Apps/Sessions, no remarks, no type tags. Viewers:
     `FileViewerPane.tsx:386, 660, 702` (sync/resolve buttons gone), `:1285`
     (REMARKS.md reload skipped), `:2298`/`:5084` (context-file picker / blame
     from an empty project list), `:5644-5646` (`projectDir=""` → Run cwd
     falls to the file's dir, `pythonRun.ts:403-405`). Monitoring panes
     (`NetworkTrafficPane.tsx:339`, `DiskUsagePane.tsx:98`,
     `SystemMonitorPane.tsx:499`) treat a remote project as local when popped
     out; `useAddTabMenuData.ts:130-134` `boxMembers` empty. Fix: seed a
     `projectInfo` (id, dir, remote, box members) for **every** scope, not a
     `remoteInfo` for remote ones, and have `ProjectFilesTab` resolve from it.
     **Fixed**, and the second half goes further than "have `ProjectFilesTab`
     resolve from it": `projectInfoForScope` now answers for every scope (a
     local project ships its entry with no host; a box scope ships its members),
     and `DetachedApp` seeds the popout's own **projects store** from it. That
     is what makes the ~50 gated things work at once — the file view's git bar,
     history, Apps/Sessions, remarks and type tags, the viewer's sync/resolve
     buttons and context-file picker, the monitoring panes' remote/local
     verdict, `useAddTabMenuData`'s box members — rather than threading a
     project prop through each. Safe because a popout is inert to project
     switching by construction: it mounts no runtime-switch listener, so that
     store is a read-only fact there.
     - [x] 🤖 Automated test — `projectInfoForScope` returns the entry for a
       LOCAL project (it returned `undefined` before) with no `primaryHost`
       (`DetachedTwoHeap.test.ts`).
     - [ ] 🖐️ Manual test — local project, pop out a subwindow, open ◫: the
       git bar, history and Apps/Sessions views are all present.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

233. **Dialog hosts mounted only in `AppShell` make popout actions hang or
     vanish.** `AppShell.tsx:943-1057` mounts them; `DetachedApp.tsx:596-600`
     mounts only `BrowserDownloadHost` and `SyncConfirmDialog`. The
     **HPC guard**: FileTree ▶ (`FileTree.tsx:3025-3040`) / viewer Run →
     `hpcGuard.ts:130` → `hpcGuardPrompt.ts:45-53` parks a Promise only
     `HpcGuardDialog` resolves → on an HPC-tagged host the run **hangs forever,
     silently**. **Screenshot**: `PdfViewer.tsx:1691` `useScreenshotPendingStore`
     is popout-local → no `ScreenshotSaveOverlay`; clipboard-only, the
     save-to-project step never appears. `ProjectFilesPane.tsx:380, 764`
     "Remote machines…" and `:659` "Large folders…" → stores with no host →
     dead buttons. `TerminalView.tsx:650` OSC-52 clipboard notice writes
     `switchToast` on a projects store nobody renders. Fix per dialog: either
     mount it in `DetachedApp` too (portaled, explicit color — the
     [[feedback_unified_menu_layout]] rule) or route the request to main
     over an event with a reply channel; the HPC guard must never park a
     Promise nobody can resolve — reject when no host is mounted.
     **Fixed**, per dialog as the item asks. Mounted in `DetachedApp` too:
     `HpcGuardDialog` and `ScreenshotSaveOverlay` (both are answered where the
     action was started). Routed to main instead: "Remote machines…" and "Large
     folders…", whose stores forward an open request over
     `DETACHED_OPEN_DIALOG` when `isDetachedWindow()` — those dialogs manage the
     project rather than the popout, and the host focuses the main window so the
     answer is not raised behind the popout that asked. And the guard itself no
     longer parks: `hpcGuardPrompt` refcounts its mounted hosts and answers a
     request "no" immediately when there are none, so the failure mode is the
     caller's ordinary "the user backed out" path rather than a silent hang.
     - [x] 🤖 Automated test — a request with no dialog host resolves `false`
       instead of pending; one with a host asks and returns the answer; the host
       count survives one window closing (`HpcGuardNoHost.test.ts`).
     - [ ] 🖐️ Manual test — HPC-tagged project, pop out, ▶ a script: the
       guard dialog appears in the popout; take a PDF screenshot from a
       popout: the save overlay appears.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

234. **Activity and usage are blind to popouts.** `AppShell.tsx:734-764` is
     the only `terminal-output` → `notePtyOutput` feed; `noteUserInput` from
     a popout `TerminalView` lands in the popout's **own** `stores/activity`.
     Main's classifier requires input (`activity.ts:120-134, 244`) and
     suppresses attention for detached tabs (`:48`), so a popped-out agent
     never lights the project pill or tab status in main; the popout's own
     strip renders no busy/attention state at all
     (`DetachedCenterPanel.tsx:1316-1378` vs `TabBar.tsx:221-225`), and its
     `TabHoverCard` reads an empty store (`:145`). `stores/usage.ts:45-49`
     accumulates in-module and `flushUsage` runs only from
     `AppShell.tsx:603-606, 660-663` → prompts typed in a popout never reach
     the daily recap. Fix: stream `noteUserInput`/usage ticks to main as a
     `DETACHED_ACTIVITY` event; mirror the classified state back in the seed
     so the popout strip can render it.
     **Fixed**, both directions. Outbound: `noteUserInput`, `noteBell` and
     `clearAttention` forward over `DETACHED_ACTIVITY` when the heap is a
     popout, and `bumpUsage` forwards over `DETACHED_USAGE` into the one
     accumulator that is ever flushed. Inbound: the host publishes each popout's
     classified statuses on its own label-namespaced channel whenever the
     classifier moves (and on every seed), and `applyDetachedStatus` adopts them
     into the popout's store, so its strip paints the same working /
     needs-decision / finished rings `TabBar` does — it rendered none at all
     before. The `isTabDetached` suppression in `attentionFor` is gone with its
     reason: `isTabLookedAt` now reads a popout's own active tab, so a
     popped-out agent is classified like a docked one and lights the project
     pill. Mirrored on a separate channel rather than in the seed, because a
     status change must not cost a whole tree reseed.
     - [x] 🤖 Automated test — input recorded in a popout heap flips main's
       classifier to working for that tab; `statusForEntry`'s verdict, adopted
       by the popout, reads as `TabBar` reads it; a popout's usage bump leaves
       its own accumulator empty and lands in main's (`DetachedTwoHeap.test.ts`).
     - [ ] 🖐️ Manual test — pop out a Claude tab, send a prompt: the project
       pill shows working, then done; the recap counts the prompt.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

235. **Popped-out terminals start blank.** `TerminalView.tsx:761-783`
     subscribes to live output and the hidden-pane replay only; the backend
     buffers only while **no** viewer is visible (`terminal/mod.rs:56-68,
     113, 342-366` `take_pending`). There is no scrollback fetch on attach. A
     freshly popped-out (or docked-into) shell renders empty until the program
     redraws — a TUI recovers via the fit's SIGWINCH, a plain shell's history
     exists only in main's hidden xterm. Every seed-driven group remount (#227)
     blanks again. Also the reverse: after dock-back main's xterm holds only
     `PENDING_OUTPUT_CAP` of what streamed while hidden (`:780-782`). Fix: a
     `pty_scrollback(id)` command returning the router's retained tail (a
     bounded ring, U#213-style), replayed into a new attach before live
     output — the same mechanism the mobile PWA's history replay uses
     ([[project_mobile_lazy_history]]).
     **Fixed** as specified. The router keeps a bounded `retained` tail per PTY
     (`ROUTE_SCROLLBACK_CAP`, 256 KB, trimmed with the same hysteresis the
     pending buffer uses) appended for every routed chunk — visible or not,
     since the question is what the terminal has SHOWN, not who saw it — and
     `pty_scrollback` hands it back. Deliberately smaller than the hidden-spell
     buffer, which is retained only for hidden PTYs; a TUI repaints its whole
     frame, so the replay converges on the current screen either way. An
     attach-only `TerminalView` fetches it before its first live byte and
     PREPENDS it to anything that streamed in during the round trip, holding the
     write back with a `historyPending` flag so the order is right; a backend
     too old to answer clears the flag and opens blank, as before. A read rather
     than a drain, so a third window attaching later gets it too; cleared on
     respawn, since a new program's predecessor is not its history.
     - [x] 🤖 Automated test — a viewer attaching to a PTY that already ran gets
       its output (from before ANY viewer, and from while one was visible), the
       read does not consume it, a respawn clears it, and the tail is bounded
       (`terminal/mod.rs`); an attach-only `TerminalView` asks for it and a
       normal one does not (`TerminalAttachOnly.test.tsx`).
     - [ ] 🖐️ Manual test — `ls -la` in a shell, pop it out: the listing is
       there.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

236. **Startup respawn applies saved bounds unvalidated, and the default size
     is in the wrong unit.** `detach_subwindow` sets raw physical x/y
     (`subwindow.rs:199-204`); only the project-switch-back path runs
     `resolve_detached_geometry` (`project_runtime.rs:240-256`). After a
     monitor is unplugged or rearranged the borderless popout respawns
     off-screen with nothing to grab. And `DetachedApp.tsx:362` seeds
     `size = {900, 640}` — the builder's **logical** default
     (`subwindow.rs:184`) — while `onResized`/`onMoved` payloads are physical,
     so a popout moved but never resized flushes 900×640 as physical → a
     half-size respawn on a 2× display. Fix: run the same geometry resolver at
     respawn; seed the size from the window's actual physical size.
     **Fixed**, both halves. `detach_subwindow` runs the saved rect through
     `fit_detached_bounds` → `resolve_detached_geometry` against the monitors
     the freshly-built window can see (the same resolver the switch-back path
     already used), and applies nothing when the rect no longer overlaps any of
     them — leaving the WM's placement, which is on a real screen, rather than
     flinging a borderless window off-screen. And `DetachedApp` seeds its size
     from `innerSize()` (physical, like the event payloads) instead of the
     builder's logical 900×640, refusing to flush until that read lands.
     - [x] 🤖 Automated test — the query/geometry tests in `subwindow.rs` pin the
       physical variants; `resolve_detached_geometry`'s own suite covers the
       unplugged-monitor case. The bounds seed is a live-only path.
     - [ ] 🖐️ Manual test — popout on an external monitor, quit, unplug,
       relaunch: the popout is on the remaining screen.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

### B.3 — The escape hatch, the protocol, and the long tail

241. **An attach-only view resizes a PTY it does not own.** Spawn and kill are
     both gated on `attachOnly` (`TerminalView.tsx:1028`, `:1295`) and the B
     audit signed off "attach-only never spawns/kills" — but `pty_resize` is
     not gated, at either call site: the post-`open()` fit
     (`TerminalView.tsx:612`) and the ResizeObserver/window-resize `doFit`
     (`:1173`). A PTY has one size, so every view sharing an id races to set
     it, last fit wins. The backend does not arbitrate: `pty_resize`
     (`commands/terminal.rs:693`) is a bare pass-through with no owner check —
     pointedly unlike `pty_set_visible` right below it, which takes a
     `viewer_id` and derives the window from the *calling* window precisely
     because several views share one PTY. Four surfaces attach:
     `DetachedCenterPanel.tsx:1694` (popout), `InstallOverlay.tsx:112` (an
     overlay box over the root terminal), and `RemoteConnectDialog.tsx:631,854`
     (adopted login terminals in a dialog). The last three are all *smaller*
     than the pane behind them, so opening one shrinks the shared PTY and the
     full-size terminal is left drawing into a sub-rectangle of its own grid,
     the remainder unpainted — and a TUI takes a SIGWINCH it never asked for.
     Not simply "attach-only never resizes": a popout whose owner pane is
     hidden (no layout, so it never fits) would then be stuck at the size the
     PTY had before the detach. Wants one designated size owner — the visible
     view, or the smallest of the visible ones — arbitrated backend-side the
     way visibility already is.
     - [ ] 🤖 Automated test
     - [ ] ✅ Works on Linux (X11)
     - [ ] ❌ Doesn't work on Linux (X11)
     - [ ] ✅ Works on Linux (Wayland)
     - [ ] ❌ Doesn't work on Linux (Wayland)
     - [ ] ✅ Works on Windows
     - [ ] ❌ Doesn't work on Windows
     - [ ] ✅ Works on macOS
     - [ ] ❌ Doesn't work on macOS

237. **Bring back a dock-back gesture.** Since the 2026-07-19 move-only
     rework there is no way to return a whole popout to the main window: the
     ⤓ button is gone, grip and titlebar drags are native OS moves, the WM ×
     **permanently closes** the tabs (`DetachedApp.tsx:556-585`,
     `WindowControls.tsx:84`), and `DETACHED_DOCK` is emitted nowhere. The
     user chose native snapping over drag-to-dock, and that stands — but
     without *some* dock-back every failure in B.1 is tab loss, and "closed
     the popout, lost my tabs" is the likeliest complaint behind "error
     prone". Minimal shape: a ⤓ in the titlebar cluster (and a shortcut)
     that emits `DETACHED_DOCK` — the main-side ladder still exists
     (`CenterPanel.tsx:794-880`, `decideDetachedGroupDrop`) — plus the WM ×
     asking dock-or-close instead of closing. The pane-grip pop-out-a-pane
     gesture deferred in the same rework belongs here too.
     **Fixed** to the minimal shape. A **⤓** in the popout's title bar (beside
     the window controls, `no-drag` so the press never starts a window move)
     emits `DETACHED_DOCK` — the main-side ladder was already there and had no
     caller. And the WM **✕** now raises `DetachedCloseChoice`: put the tabs
     back / close them / cancel, with cancel the answer to a misclick and the
     dialog the one place the difference can be stated. Both persist the scope
     afterwards (#229). **Not done:** the shortcut, and the pane-grip
     pop-out-a-pane gesture — neither is load-bearing for tab loss, which is
     what this item is about; they belong with the rest of #239's decisions.
     - [x] 🤖 Automated test — a `DETACHED_DOCK` for a live record moves its
       subtree back into the main layout and closes the window
       (`DetachedHost.test.ts`'s dock cases, now also persisting the scope).
     - [ ] 🖐️ Manual test — ⤓ on a two-pane popout: both panes are back in
       main, terminals still live.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

238. **Fragile cross-window protocol paths** (each plausible from reading,
     none confirmed live):
     - A lost `DETACHED_DRAG_END` freezes main's input: START puts main's
       drag store into `kind:"detached"` → `.center-panel.dragging` → panes
       `pointer-events:none`; main's own release handlers deliberately never
       end a detached drag (`CenterPanel.tsx:526-530`), only Escape does
       (`:555-559`). If the popout never emits END (destroyed mid-gesture,
       WebKitGTK swallowing the terminal event — `dragPlatform.ts:84-87, 174`
       binds the blur backstop only on Win/mac), main ignores clicks until
       Escape is pressed *in main*. Fix: a main-side timeout/pointerup net.
     - **Viewer-registration leak on every popout teardown**: all teardowns
       use `destroy()`, so the popout's `pty_remove_view`
       (`TerminalView.tsx:1108-1113`) never runs and the route keeps a
       `visible:true` viewer with a random uuid; the backend is fail-open
       (`mod.rs:401-404`). Every tab that ever lived in a popout streams over
       IPC forever, undoing the visible-only streaming work
       ([[project_bg_terminal_render_cost]]). Fix: drop viewers by window
       label in the `Destroyed` hook.
     - **Cross-scope drags lie**: `startDetachedDropSession.resolve()`
       targets only `st.scope`'s popouts (`detachedDropTargets.ts:97-99`),
       yet root/box popouts are never parked (`project_runtime.rs:164, 221`
       filter on `project_id == previous_project_id`). Dragging a tab out of
       a root popout while project X is active lights X's popouts, then
       `moveTabBetweenDetached("root", …)` no-ops (`tabs.ts:3322-3324`); a
       `dockMain` lands it invisibly in root's stored layout
       (`CenterPanel.tsx:756-763`, `tabs.ts:3037`).
     - A stale `close` edit between a dock (END) and the popout's reseed
       deletes a tab that already moved (`tabs.ts:3401-3406` filters the
       payload whether or not the key is still in that popout's subtree).
     - Main-side terminal-title/agent retitles, renames and
       `computeHosts`/SSH-state changes reach a popout only on the next
       unrelated reseed (the documented bargain at `detached.ts:246-248`).
     - `addDetachedTab` applies `withTmuxSession` but not
       `withRunHostDefault` (`tabs.ts:3502` vs `:2102-2106`) → "+ Shell" in a
       popout ignores the project's run-host preference, contradicting
       [[project_run_host_pref]]; `countTabOpen` is skipped too.
     - Parked-popout `hide()`/`show()` can fire Moved/Resized → junk
       `DETACHED_BOUNDS` (`DetachedApp.tsx:379-392`) that a quit-while-parked
       persists. `DETACHED_PANES` listen-vs-request ordering
       (`detachedDropTargets.ts:87-95, 111`) can leave `targetAt` undefined →
       the dock silently lands in the first pane. On Wayland/macOS
       `find_window_for_title(title, 20)` is a 2 s sleep loop per detach
       (`subwindow.rs:376-378`) and `detached_window_frontmost` answers `true`
       for an unresolved id (`:343`), so the occlusion guard is absent there.
     **Fixed**, bullet by bullet. **Lost END** — `detachedDragNet` in
     `CenterPanel`: MOVEs stopping for 2 s (the popout polls the cursor every
     frame while a gesture is live), or a `pointerdown` landing in the main
     window, ends the drag; both are facts this window can observe without the
     popout. **Viewer leak** — `pty_set_visible` records the CALLING window's
     label and the `Destroyed` hook calls `route_drop_window_views`, so a window
     torn down with `destroy()` (which is all of them) stops holding its PTYs
     subscribed. **Cross-scope drags** — the drop session takes the DRAG's own
     scope, not the active one, so a root or box popout's tab lights up and
     lands only in siblings of its own scope. **Stale close** — `applyDetachedEdit`
     ignores a `close` for a key that is no longer in that popout's subtree, so
     a close racing a dock cannot delete a tab that already moved. **Main-side
     changes reaching a popout** — the host subscribes to the tabs, projects and
     remote-status stores and reseeds (debounced, signature-guarded) the popouts
     a change touches, so a retitle, a rename, a host switch or an SSH state
     change no longer waits for an unrelated edit. **Run-host default** —
     `addDetachedTab`/`addDetachedTabSplit` apply `withRunHostDefault` and count
     the tab open, like every other add path. **Parked-popout junk bounds** — a
     flush is refused while the window is not visible. **PANES ordering** —
     `resolve()` awaits its own `listen` before asking any popout for geometry.
     **Not done:** the Wayland/macOS `find_window_for_title` sleep loop and the
     absent occlusion guard there — platform work with no Linux/X11 symptom,
     left as a known limit rather than half-built.
     - [x] 🤖 Automated test — the END-timeout net's four cases
       (`DetachedDragNet.test.ts`), viewer-drop-by-label (`terminal/mod.rs`), the
       stale-close guard and the run-host default (`DetachedTwoHeap.test.ts`).
     - [ ] 🖐️ Manual test — start a tab drag from a popout and `xkill` the
       popout mid-drag: main still takes clicks.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

239. **Parity gaps that are features, not bugs** — decide each, build or
     document: no tab **rename** UI or context menu on the popout strip (the
     `rename` edit exists, `detached.ts:302`; main has rename/duplicate/
     close-others, `TabBar.tsx:654-668, 1651-1682`); no `UntestedTag`
     rendering; keyboard set (`DetachedCenterPanel.tsx:380-500` vs
     `useKeyboard.ts:184-388`) lacks Ctrl+Enter fullscreen (deliberately
     maximize — keep), `closeSubwindow`, `hideSubwindow`, `closeAllTabs`, F1,
     steering mode, Escape, Ctrl+P QuickOpen (`QuickOpen.tsx:104-116`); file
     drag popout→main unsupported (`DetachedCenterPanel.tsx:767-785`);
     TeX↔PDF scroll sync off (`TabPane` gets no `groupId`, `:1486-1494`,
     `scrollSync.ts:121`); a calendar tab in a popout never pushes CalDAV
     (`CalDavSyncHost` is main-only; `calendarWriteHook.ts:68` resolves
     without pushing, main's calendar store not refreshed); per-tab
     persistence only when `ownsTabs` (`BrowserPane.tsx:129-134` title+URL,
     `ProjectFilesTab.tsx:146` browsed folder, `DiskUsagePane.tsx:136`
     label); a parked/minimised popout keeps `visible=true` so PTY streaming
     and mtime polls continue (`TerminalView.tsx:1103-1106`,
     `fileAccess.ts:44-59` — the [[project_pane_visible_gating]] rule);
     `remoteStatus` seeded once per seed and workers never
     (`DetachedApp.tsx:443-446`).
     **Decided.** *Built:* tab **rename** (right-click the popout's strip — the
     `rename` edit finally has an emitter); **per-tab persistence**, all three
     (browser title+URL, the Files tab's browsed folder, the Disk Usage label)
     — the `ownsTabs` gate that suppressed them is gone, since #231's seam is
     the write channel back it was standing in for; **parked/minimised gating**
     — `DetachedApp` polls its own window visibility and the panes compose it
     into `visible`, so a popout nobody can see stops streaming its terminals
     and polling its file views; **`remoteStatus` freshness** — the host's new
     store subscription reseeds on an SSH state change rather than waiting for
     an unrelated edit. *Documented, not built:* duplicate / close-others on the
     strip (rename was the one with an existing edit; the others need new ones
     for a gesture that is rare in a popout); `UntestedTag` rendering in a
     popout; the missing chords (`closeSubwindow`/`hideSubwindow`/`closeAllTabs`
     are whole-window acts a popout expresses through its own title bar
     instead — F1, steering and QuickOpen are main-window surfaces); file drag
     popout→main; TeX↔PDF scroll sync in a popout (`TabPane` gets no `groupId`
     there); a calendar tab in a popout not pushing CalDAV (`CalDavSyncHost` is
     deliberately main-only — a second pusher would be two writers for one
     row). Ctrl+Enter staying a maximize is kept, as the item says.
     - [x] 🤖 Automated test — for what was built: per-tab persistence and the
       rename ride #231's seam tests; the rest are live-only surfaces.
     - [ ] 🖐️ Manual test — rename a tab in a popout; check a popped-out
       browser tab keeps its address across a relaunch; park a popout by
       switching project and confirm its terminals stop streaming.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

240. **Test the second window as a second window.** The existing suites
     (`DetachedHost`, `DetachedSync`, `DetachedSplit`, `DecideDetachedDrop`,
     `DetachedPaneDock`, `DetachedToDetachedDock`, `FileDropIntoPopout`,
     `SplitPopoutRespawn`, `TerminalAttachOnly`) cover the protocol reducers
     and pure ladders; **none of #224–#236 is under test**, because nothing
     runs two stores against each other. Build a two-heap harness: two
     isolated module registries (vitest `vi.resetModules` + a per-heap
     `invoke`/`emit` shim that forwards events between them) so a test can
     detach in heap A, edit in heap B, and assert both layouts agree. Every
     fix above then lands with a test in that harness, and the harness itself
     is the regression net for the "second React root" class of bug.
     **Built** as `src/__tests__/helpers/detachedHarness.ts` + `DetachedTwoHeap.test.ts`
     (20 cases). `loadHeap()` is `vi.resetModules()` + a fresh dynamic import,
     so each heap has its own `useTabsStore`/`useSettingsStore`/
     `useActivityStore`/`useProjectsStore`; the hoisted mocks are
     registry-independent, so both heaps' `emit`/`listen` reach ONE shared bus
     and a round trip (popout edit → main store → reseed → popout state) is a
     thing a test can assert on. `mountFakePopout` stands in for the popout's
     renderer (it holds what the seeds carry); `installPopoutContext` installs
     the store seam the way `DetachedApp` does. The bus is synchronous on
     purpose: Tauri's is not, but the protocol settles ordering (a seed answers a
     request, a reseed follows an edit), so immediate delivery removes flakiness
     without removing anything a case is checking.
     - [x] 🤖 Automated test — the harness exists; #224, #225, #226, #227, #228,
       #230, #231, #232, #234 and #238 all have cases in it.
     - [ ] 🖐️ Manual test — n/a.

261. **[Bug] A popout stopped moving when you dragged its top frame.** Found
     live: the popout carried `_NET_WM_STATE_FULLSCREEN`, sized to exactly the
     external monitor (`2048,0 3840x2160`), and its `_NET_WM_ALLOWED_ACTIONS`
     held neither `_NET_WM_ACTION_MOVE` nor `_NET_WM_ACTION_RESIZE` — so Muffin
     refused the `_NET_WM_MOVERESIZE` that `startDragging` sends and the title
     bar, the tab-bar grip and every resize edge silently did nothing. Exactly
     the trap #240's F11-maximizes rule and `DetachedApp`'s no-fullscreen guard
     exist to prevent, with the guard mounted and running the whole time.
     **Root cause:** the guard asked before clearing, and the question has no
     honest answer. `isFullscreen()` never reaches the window manager — tao
     returns the value its own `set_fullscreen` last wrote
     (`fullscreen: RefCell<Option<Fullscreen>>`), so a fullscreen from anywhere
     else (the WM's own shortcut, a page's `requestFullscreen()` — WebKitGTK
     fullscreens the toplevel for it — whose element was then destroyed, a
     presenter torn down without its cleanup) reads back `false` for ever and
     the guard's `if (fs)` never fired. **Fixed** by clearing without asking:
     `setFullscreen(false)` maps onto `gtk_window_unfullscreen()`
     unconditionally and is a no-op otherwise — which is how the backend has
     always cleared the main window's (`restore_main_window`: `let _ =
     win.set_fullscreen(false)`, no read, no branch). What must not be cleared
     is now the pure `mayClearStrayFullscreen` (`lib/window/strayFullscreen`): the
     page's own DOM fullscreen and a talk in progress hold it, macOS is
     excluded. And the title-bar press self-heals, because the guard fires on
     resize and focus-regain and a window already stuck *and* already focused
     produces neither — so `beginNativeWindowMove` fires the clear
     alongside the drag — unawaited, and gated on `windowFillsScreen()`, so a
     maximized popout (which Muffin moves fine) pays nothing and the worst case
     left is a stuck window that takes a second press. **Not fixed:** what put the window there. The
     rect matches `snap_detached_geometry` exactly (it clamps to the monitor
     size at the monitor origin), so a WM promoting an undecorated
     monitor-sized window to fullscreen is the leading suspect and unproven;
     the rescue is deliberately mechanism-independent.
     - [x] 🤖 Automated test — `StrayFullscreen.test.ts` covers both pure
       halves: who may clear (DOM fullscreen and a running talk hold it, macOS
       excluded, an orphaned DOM fullscreen is rescued) and the viewport test.
     - [ ] 🖐️ Manual test — with a popout stuck filling a screen, drag its
       title bar: it leaves fullscreen and follows the cursor. Then check the
       ordinary case is untouched — a normal-sized popout still moves the
       instant you grab the strip — and that a video/browser tab inside a
       popout can still go fullscreen and stay there.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

262. **A popout's title bar has no visible move handle.** The whole strip has
     been a drag region since #42 — every pixel of it that isn't the window
     controls hands the press to the WM — but an undecorated window shows
     nothing that says so, and once the dock-back ⤓ and the min/max/close
     cluster fill the right end there is no marked place to aim at. The main
     window carries an explicit `⠿` (`.app-drag-grip`) in its header for
     exactly this reason, and so does every subwindow tab bar inside a popout
     (`.tab-drag-grip`); only the popout's own frame went without. The title bar
     now renders the same `.tab-drag-grip` beside the star — a plain element
     matching none of the no-drag selectors, so its pointerdown bubbles to
     `onTitlebarPointerDown` and drives the same native move (and the same
     double-click-to-snap) the bare strip already did. No behaviour changed;
     the affordance is what was missing.
     - [x] 🤖 Automated test — n/a (markup-only; the drag path itself is
       `decideTitlebarPress`, already covered).
     - [ ] 🖐️ Manual test — pop a tab out: a `⠿` sits at the top-left of the
       popout's title bar, next to the star. Drag it — the window follows the
       cursor. Double-click it — the window snaps onto its screen (#240), the
       same as double-clicking the bare strip.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

263. **[Bug] A tab dragged out of a popout could not be dropped into the main
     window or another popout on native Wayland** (2026-09-22; a recurring
     report — dropping it back into the SAME popout, e.g. as a split, kept
     working). The cross-window dock protocol hit-tests a PHYSICAL desktop
     cursor against every window's desktop frame, and a native Wayland client
     has neither (`desktopCoordinatesSupported` refuses the dummy `(0,0)`), so
     the popout never streamed the gesture at all: a release outside itself
     did nothing. In-popout drops use DOM coordinates, hence the asymmetry.
     Fix (`lib/window/dropClaim.ts`): the source broadcasts a PROBE at release
     and the window that receives the pointer next — the compositor moves
     pointer focus the moment the implicit grab ends, and WebKitGTK turns that
     crossing into a mouse move — CLAIMS it with the pane under the cursor.
     Main hosts popout-sourced probes (own DOM → dock into main at that pane;
     a sibling popout's claim → move the tab there); a main-window tab dragged
     out probes the popouts the same way before falling back to a new window.
     No claim within 1.2 s leaves the tab where it was (never a surprise new
     window). No dock preview during the drag on Wayland: the target sees no
     pointer until the button is up. X11/Windows/macOS keep the geometric path.
     - [x] 🤖 Automated test — `DropClaim.test.ts`, `DetachedTabDrag.test.tsx`
       (probe + claim), `DetachedDropClaimHost.test.tsx` (main host: dock into
       main / into a sibling / timeout).
     - [ ] 🖐️ Manual test (Wayland) — pop two tabs out into two popouts. Drag a
       tab from popout A onto a pane in the main window and release: it lands
       there (bar → that slot, body edge → split). Drag one from A onto popout
       B: it lands in B's pane under the cursor. Drag a main-window tab onto a
       popout: it docks there instead of opening a new window. Release over
       the desktop or another app: the tab stays where it was. If a drop over
       a window is ignored until the mouse is nudged, the crossing event did
       not arrive — say so.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

264. **[Bug] Switching between two projects that each have a popout showed a
     third, empty popout on GNOME/Wayland** (2026-09-23). Wayland parking was
     `minimize()` + a flag GTK can never reconcile there; when the compositor
     put the other project's popout back on screen, its renderer (told it was
     parked) blanked every pane. The sync also ran twice per switch, unordered
     (`setScope` and `project_runtime::switch`'s worker thread). Fix: `setScope`
     is the one sync authority; on native Wayland a left scope's popouts are
     CLOSED (after they flush autosave and report no unsaved work — dirty or
     silent ones fall back to minimize, and then keep rendering), their records
     kept, and `respawnDetachedForScope` rebuilds them on return at their saved
     size (the compositor picks the position). X11/Windows/macOS keep hide/show.
     `detach_subwindow` now reserves its label atomically and waits out a
     same-label retire (fast A→B→A). A popout that never announced it can
     answer (`detached_retire_ready` — still loading, or a renderer from before
     this protocol) holds no work and is closed without asking.
     Trade-off (Wayland only): a respawned popout is a fresh renderer, so its
     popout-local view state is gone — scroll position, PDF page, search,
     selection, undo — and GNOME chooses where it opens; only its size comes back.
     - [x] 🤖 Automated test — `subwindow.rs` / `window_state.rs` unit tests
       (sync planner, retire tokens, `Destroyed` disposition, reservation),
       `DetachedScopeVisibility.test.ts`, `DetachedRetire.test.ts`,
       `DetachedTwoHeap.test.ts` (retire keeps the record; crash still docks).
     - [ ] 🖐️ Manual test — open two projects, each with a popout (drag a tab
       out). Switch back and forth several times, slowly and then fast: at no
       point is there a blank/empty popout; only the active project's popout is
       on screen, and on return it reopens with its tabs (terminals keep their
       scrollback) at the size it had. With autosave off, type into a file in a
       popout and switch away: the popout is minimized, not closed, and the edit
       is still there on return. X11: put a popout on the second monitor,
       switch to another project and back — it returns on the same monitor at
       the same position and size.
       - [ ] ✅ Works on Linux (X11)
       - [ ] ❌ Doesn't work on Linux (X11)
       - [ ] ✅ Works on Linux (Wayland)
       - [ ] ❌ Doesn't work on Linux (Wayland)
       - [ ] ✅ Works on Windows
       - [ ] ❌ Doesn't work on Windows
       - [ ] ✅ Works on macOS
       - [ ] ❌ Doesn't work on macOS

---

**Verified sound by the same audit** (so nobody re-audits it): seed handshake
ordering (listener before request, retry until seeded); edit symmetry for
activate/close/reorder/move/files *given identical ids* (no echo loop — main
reseeds only on `add`); PTY ownership (attach-only never spawns/kills;
`isDetachedPtyId` sees the record before the unmount commit; `unloadScope` /
deactivate destroy popouts, then drop the record, so the unmount kills — the
ORDER there is now inverted deliberately, records first, so the `Destroyed`
hook does not read a deliberate teardown as a crash); WM
close with the 1500 ms fallback; physical-px coordinates end-to-end incl.
negative multi-monitor; popout→popout move, Shift→new window, lone-tab
refusal; restart persistence for single and split popouts; project-switch
park/unpark with captured geometry; quit teardown; theme/accent/language DOM
propagation; per-window renderer watchdog, crash reporter, custom scrollbars;
`BrowserDownloadHost` + `SyncConfirmDialog` per window; Python/shell/SLURM
runs from a popout land in it; the experimental sweep closes a popout's own
withdrawn tabs.
