## Group L — Center Panel: Tabs, Subwindows & Navigation
*Builds on Group D.11 (tiling split subwindows). All items share the center-panel
files: `src/stores/tabs.ts` (per-scope layout tree `layoutByScope`,
`focusedGroupByScope`, active tab), `src/components/layout/CenterPanel.tsx`,
`src/components/tabs/Subwindow.tsx` / `src/components/tabs/TabBar.tsx`,
`src/stores/projects.ts`. #42 additionally needs a Tauri multi-window surface
(`src-tauri/src/lib.rs`, `tauri.conf.json`) + the platform show/hide path
(`platform/x11.rs`, `platform/wayland_kde.rs`, `services/window_service.rs`,
`services/project_runtime.rs`); #55–#57 touch `schema/project.rs`; #62 touches
`src/App.tsx` (global key handlers). #55 (mapping bug) and #62 (keyboard nav) are
correctness/UX work atop the same layout model #42 detaches.*

42. **Drag a subwindow out of the Tabtivity main window.** ✅ Implemented · 🧪 Awaiting
    live multi-window QA. Let a tiling subwindow
    (a tab group from Group D.11/#36) be dragged out of the main window and become
    its own standalone OS window, while keeping it bound to its project. The
    detached window must follow the **same hide/show logic as on project switch**:
    when the user switches projects in the main window, a detached subwindow
    belonging to the now-inactive project is parked/hidden on the hidden workspace
    (and re-shown on switching back) exactly like other project-owned windows,
    rather than floating free across all projects.
    Settled decisions (v1): detach gesture = explicit **pop-out button** (drag-past-
    edge deferred — WebKitGTK risk); detached window is a **second Tauri
    `WebviewWindow`** loading the same bundle under `?detached=<scope>:<groupId>`
    rendering one group (inert to project switches); the group leaves `layoutByScope`
    and is tracked in `detachedGroupsByScope` while its tab payloads stay in the
    shared store (PTYs never unmount); detached `TerminalView` is **attach-only**
    (no `pty_spawn`/no kill-on-unmount — output is broadcast by id; blank until next
    output, no scrollback restore); restart re-docks (session-only) but a detached
    group's tabs stay in `project.json` mid-session; parking reuses the existing
    `project_runtime::switch` path via an `ORIGIN_DETACHED_SUBWINDOW` tracked window
    + a hardened X11 `set_parkable` override (main window structurally never
    parkable) **and** a backend-independent Tauri `hide()/show()` fallback so
    Wayland/KDE/null also hide an inactive project's detached window; re-attach via
    dock-back button + dock-on-close (`onCloseRequested`) **and Ctrl+drag-to-dock**:
    Ctrl+dragging the popout's tab bar streams the gesture (screen coords, via the
    `DETACHED_DRAG_*` events) to the main window, which maps them to client space,
    shows the normal drop preview, and docks the group on release over a subwindow
    (`attachGroup` with the resolved edge/center target) — released outside the main
    window or on Escape, the popout stays floating. A plain (non-Ctrl) tab-bar drag
    still hands off to the WM for a native window move.
    Code review: `docs/group_l_42_detach_review_code.md`.
    *Files: `src/stores/detached.ts`, `src/stores/tabs.ts`,
    `src/components/layout/DetachedApp.tsx` / `DetachedCenterPanel.tsx` /
    `AppShell.tsx`, `src/components/tabs/TabBar.tsx`,
    `src/components/terminal/TerminalView.tsx`, `src/App.tsx`;
    `src-tauri/src/commands/subwindow.rs`, `platform/x11.rs` / `platform/mod.rs`,
    `services/window_service.rs` / `services/project_runtime.rs`, `lib.rs`,
    `tauri.conf.json`, `capabilities/default.json`.*
    - [ ] Verify tab split, merge and reorder in the main window and inside a
      detached window on native Wayland and X11. Local gestures now use DOM
      coordinates; native Wayland's dummy desktop cursor must never route a drop
      to another window. Covered by `DragDropSplit` and `DetachedTabDrag` tests;
      desktop-coordinate dragging between OS windows remains unavailable on native
      Wayland (use the existing dock controls).
    - [ ] Restore a detached window to its previous monitor on native Wayland
      after both project switching and app restart (reported on a non-KDE
      desktop). The tab-drag fix does not solve placement: GTK's global positions
      are unavailable, and hiding/showing leaves placement to the compositor.
    - [x] 🤖 Automated test — `SubwindowDetach`, `DetachedSync`, `DetachedHost`,
      `TerminalAttachOnly` (frontend) + `window_service` detached-labels selector
      (backend). tsc clean; 30 #42 frontend tests pass; cargo 373 pass.
    - [ ] 🖐️ Manual test — needs backend rebuild + live run (pop-out spawns &
      seeds, PTY attaches without respawn, X11 park + Tauri hide on switch,
      Wayland hide fallback, dock-back & dock-on-close, main window never parked).
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

55. **[Bug] Fix tab→project mapping leak.** A tab can show up under the wrong
    project — e.g. the ProjectEldrun main window showing a `TODO.md` tab that
    belongs to a different project. This must never happen. Audit tab persistence
    / restore and the per-scope layout keying (`layoutByScope`, `tab_layout`/
    `tab_groups`, scope ids) so tabs are strictly bound to their owning project.
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

56. **Right-click a tab → start renaming.** Shipped as **Shift+right-click**
    (`TabBar.tsx:200,210,640`); plain right-click still opens the context menu.
    Amend the wording or change the binding — as written the item doesn't match
    the code.
    - [x] 🤖 Automated test — `src/__tests__/tabs/TabInlineRename.test.tsx`
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

57. **Open `README.md` by default for a project with no tab.** ⛔ **REVERTED —
    was implemented, then deliberately removed.** When a project is
    opened/activated and has no tabs to restore, show its `README.md` in an
    in-app viewer tab by default (uses the Group D.14 viewer).
    - `src/components/layout/CenterPanel.tsx:250` now reads: *"we no longer seed
      a default README.md tab"* — an empty scope shows a Subwindow with a `+`
      instead (see [Tab persistence policy]). Boxes below are stale from the
      original implementation.
    - [ ] 🤖 Automated test — n/a while reverted.
    - [ ] 🖐️ Manual test — n/a while reverted.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
    - **Decide:** restore the behaviour, or close this item as withdrawn.

62. **Fast keyboard navigation across projects / subwindows / tabs.** Make the
    whole app steerable from the keyboard with no mouse required. Needs design
    choices, but the target set: a fast fullscreen mode for a tab/subwindow,
    keyboard switching between projects, between subwindows (e.g. `Shift`+arrows
    to focus subwindows), between tabs in a subwindow (e.g. `Shift`+`Tab`), and
    between projects (e.g. `Shift`+`Ctrl`+`Tab`), plus closing tabs/subwindows —
    all keyboard-driven.
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

82. **Native keyboard file-tree navigation (no mouse).** Make the right-panel
    file tree (`FileTree.tsx`) fully steerable from the keyboard — arrow/`j`/`k`
    to move the selection cursor, `←`/`→` (or `h`/`l`) to collapse/expand a
    directory, `Enter` to open the selected file in a tab, plus wheel-style fast
    scrolling so a long tree can be traversed without reaching for the mouse.
    Builds on #62 (keyboard nav) and the Group D.1 file tree.
    - **PARTIAL, not unstarted.** `FileTree.tsx:1332 handleTreeKeyDown` already
      handles `Enter` / `Escape` / `Delete` — but only once something has been
      selected with the mouse. Genuinely missing: cursor movement
      (`↑`/`↓`/`j`/`k`), `←`/`→` expand-collapse, and fast scrolling.
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

83. **One key shows the radial "pie" project view (as in the root project).**
    A single keypress brings up the same radial/pie project-blob view used by the
    root project (the 3D project blob default root tab, see `ProjectBlobPane.tsx`)
    as a fast project switcher overlay — invoked purely from the keyboard.
    Builds on #62.
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

84. **Keyboard navigation within the pie view.** Once the radial/pie view (#83)
    is open, additional keys step the selection around the pie (e.g. arrows /
    rotate keys to move between wedges, `Enter` to activate the highlighted
    project, `Esc` to dismiss) so a project can be picked entirely by keyboard.
    Builds on #83.
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

85. **Keyboard tab/subwindow management (split, detach, move).** Drive the whole
    Group D.11 tiling layout from the keyboard with no mouse: split the focused
    subwindow horizontally/vertically into a new tab group, move the focused tab
    into an adjacent subwindow (or a fresh split), detach the focused subwindow
    into its own OS window (the #42 pop-out gesture, keyboard-triggered), and
    re-dock it — all via shortcuts. Builds on #62 and #42 (detached subwindows).
    *Files: `src/stores/tabs.ts` (split/move on `layoutByScope`),
    `src/components/tabs/Subwindow.tsx`/`TabBar.tsx`,
    `src/stores/detached.ts` + `src/components/layout/DetachedApp.tsx`,
    `src/App.tsx` (global key handlers).*
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

213. **Live-QA the keyboard steering system (#62 follow-on).** ✅ Implemented ·
    🧪 Awaiting live QA. Verify the four new surfaces together: steering mode
    (Ctrl+Shift+Space toggles it, even from a focused terminal; digit stations
    1 = root / 2+ = pills incl. Trash, arrow-key subwindow focus with the
    relative ↓/↑ badges, Tab/Shift+Tab tab cycling, F/P/W toggles, S/?/Esc/Enter
    exits, bottom-center legend + station chips on the pills), the F1 shortcut
    cheat sheet (grouped bindings, "customized" marks, fixed keys, ⚙ menu
    entry), Settings → Keyboard Shortcuts (grouped rows, conflict warning on
    colliding chords, Reset all, the new Ctrl+Shift+← cycle-back), and the
    "Steer with the keyboard" lesson (basics tier — its enter-mode task must
    complete when the legend appears).
    *Files: `src/lib/shortcuts/shortcuts.ts`, `src/hooks/useKeyboard.ts`,
    `src/stores/keyboardSteering.ts`, `src/components/layout/SteeringLegend.tsx`
    / `ShortcutHelpOverlay.tsx`, `src/lib/lessons.ts`.*
    - [x] 🤖 Automated test — `src/__tests__/shell/Shortcuts.test.ts` (chord helpers,
      grouping, conflicts, fixed chords); the i18n parity tests cover the
      lesson keys.
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

213a. **Live-QA steering levels, new-tab keys, region cursor and status
    jumps.** ✅ Implemented · 🧪 Awaiting live QA (2026-09-28). Steering is
    now a hierarchy: it opens on the projects (←/→ switch project, 1–9 jump,
    ↓ in), then subwindows (←/→ between them; with one subwindow ←/→ step its
    tabs), then tabs (↓ in, ↑/Esc back out). Inside a pane: N shell, M monitor,
    1–9 agents (the legend names them), + opens the pane's + menu. On the
    projects: N new-project dialog, M/C/T mail/calendar/to-do (only when
    enabled). E opens the side panel. In a panel/overlay/menu a highlight
    walks with ↑/↓, Enter presses (a text field gets the caret and steering
    exits), ←/→ switch the side panel's view, Esc closes what steering opened.
    Q/R/D (Shift: back) jump to the next tab needing an answer / working /
    done in any project. Verify: the highlight is visible and lands on real
    controls in each surface (file tree rows, git view, mail list, calendar,
    board, + menu rows and fly-outs); Enter on a + menu row opens that tab;
    the legend's title names the level and its counts match the pill bars.
    *Files: `src/hooks/useKeyboard.ts`, `src/stores/keyboardSteering.ts`,
    `src/lib/shortcuts/steeringRegion.ts` / `statusJump.ts` / `shortcuts.ts`
    (`STEERING_KEYS`), `src/components/layout/SteeringLegend.tsx`,
    `src/components/tabs/TabBar.tsx` (`menu` request, slot labels).*
    - [x] 🤖 Automated test — `src/__tests__/shell/SteeringLevels.test.tsx`
      (levels, new-tab requests, station digits, status jumps, legend table,
      region cursor with a faked layout).
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

213b. **Live-QA steering's Shift+Space entry, tab-level start and E S D F.**
    ✅ Implemented · 🧪 Awaiting live QA (2026-09-29). The default chord is now
    Shift+Space (was Ctrl+Shift+Space); within 400 ms of a typed character it
    stays a plain space ("I am" with Shift still held). The mode opens on the
    current project's tabs; ↑ climbs to subwindows → projects (skipping the
    subwindow level when there is only one). E S D F double ↑ ← ↓ →
    everywhere, region cursor included; Space, Esc or Enter leave from any
    tab-bar level. Keys that moved off E/S/D/F: side panel E→B, settings
    S→`,`, done jump D→X, file viewer F→V. In the + menu (and any region) `/`
    puts the caret in its search field and leaves steering; nothing focuses
    the search on its own. Verify: Shift+Space from a focused terminal enters,
    fast "I am" / "Hello World" typing never does; S/F switch tabs at once; +
    then D/E walk the rows, `/` then typing filters; Space exits.
    *Files: `src/hooks/useKeyboard.ts`, `src/stores/keyboardSteering.ts`,
    `src/lib/shortcuts/shortcuts.ts` / `steeringRegion.ts`.*
    - [x] 🤖 Automated test — `src/__tests__/shell/SteeringLevels.test.tsx`
      (tab-level start, E S D F, Space exit, typing-burst guard, `/` search).
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

213c. **Live-QA: every key rebindable, steering keys included.** ✅ Implemented
    · 🧪 Awaiting live QA (2026-09-29). Settings → Keyboard Shortcuts now lists
    every key: the former fixed ones (F11, the panel toggle, Esc out of pane
    fullscreen, Ctrl +/−/0 zoom) in *Window & view*, the terminal's
    Ctrl+Shift+C/V/X, the editor's Ctrl+F/R/Space/Z/Y/S and Ctrl+Shift+C, and
    the steering-mode keys per level (two keys per action, `settings.steering_keys`).
    × turns a chord off or drops a steering key; the panel toggle captures a
    lone Super tap on Linux (press + release). F9 still toggles the panels
    while the toggle is at its Super default; redo still takes Ctrl+Shift+Z at
    its default. Verify: rebind steering's "Right" to L — the legend shows it,
    F no longer steps, L does; unbind Space and leave with Enter; rebind F11 to
    F10 in the main window, a popout and a presenter, from a focused terminal
    too; rebind zoom in and check window / agent font / editor text; rebind
    the panel toggle to a lone Super on GNOME and to F10 on Cinnamon.
    *Files: `src/lib/shortcuts/shortcuts.ts` / `steeringBindings.ts`,
    `src/hooks/useKeyboard.ts`, `src/components/layout/SettingsPanel.tsx`.*
    - [x] 🤖 Automated test — `SteeringBindings`, `SteeringLevels` (rebound
      keys act), `Shortcuts` (zoom/unbound/lone Super), `SuperKeyOwnership`
      (panel-toggle rebind), `schema_edge_cases` (steering_keys round-trip).
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

213d. **Live-QA steering through settings.** ✅ Implemented · 🧪 Awaiting
    live QA (2026-09-30). `,` in steering opens settings and stays in steering
    on a "Settings" region: ←/→ previous/next page of the left-hand list,
    ↑/↓ walk the page's controls (never landing on × first), Enter presses — a
    dropdown opens, ↓ to an option and Enter picks it with the cursor back on
    the dropdown; a text field takes the caret and steering steps aside
    (Shift+Space over settings comes back to it). `/` types in the settings
    search, Esc closes an open dropdown, then settings (back on the level it
    was opened from). Verify: Shift+Space, `,`, walk General → Layout with F,
    change the zoom dropdown, Esc twice; Shortcuts page: Enter on a key button
    still captures the next key. *Files: `src/hooks/useKeyboard.ts`,
    `src/lib/shortcuts/steeringRegion.ts`, `ProjectSwitcher.tsx`.*
    - [x] 🤖 Automated test — `SteeringSettings`.
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

213e. **Live-QA steering through every dialog and menu.** ✅ Implemented ·
    🧪 Awaiting live QA (2026-09-30). Dialogs and menus no longer end
    steering: whatever is on top — any `.modal-backdrop` dialog, the root
    console, a right-click menu, a top-bar menu — is walked as the "Dialog or
    menu" region (↑/↓ row to row, ←/→ along a row, Enter presses, a text field
    takes the caret; Esc sends the dialog its own Escape, else presses its ×),
    and steering returns to the surface it was opened from with the cursor
    where it was (settings under a sub-dialog, the top bar under its menu).
    It follows dialogs the app raises by itself as they mount. ↑ on the
    projects level walks the top bar (←/→, ↓ drops a button's hover menu,
    Enter presses — mail/calendar/to-do/settings open on their own regions and
    Esc comes back to the bar). `.` (or the Menu key) opens the right-click
    menu of the current project / active tab / highlighted row. A walks the
    card over the active agent tab (Undo clear after K, sign-in link, update
    notice). N (New project) and ? (cheat sheet, ↑/↓ scroll) stay in steering.
    Verify: W on a tab needing confirmation → the confirm is walked, Esc
    cancels; `,` → Appearance → a button raising the theme customizer → Esc
    back on that button; E E from the tabs → top bar → D on mail's button →
    its menu → Esc; `.` on a tab; K then A → Undo clear; B → a file row → `.`
    → its menu; Shift+Space over a dialog opened by mouse.
    *Files: `src/hooks/useKeyboard.ts`, `src/lib/shortcuts/steeringRegion.ts`,
    `src/stores/keyboardSteering.ts`.*
    - [x] 🤖 Automated test — `SteeringOverlays`, `SteeringSettings`.
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

213f. **Live-QA steering's dimming of what the level can't reach.** ✅
    Implemented · 🧪 Awaiting live QA (2026-09-30). On the subwindow, tab
    and inside-a-tab levels the top bar with the project pills fades to 40 %;
    on the tab level the other subwindows get a light veil; inside a tab (D)
    the veil darkens and the side panel fades too, so only the focused
    subwindow stays lit. Regions (dialogs, side panel, top bar) show
    everything undimmed. Verify: Shift+Space on two subwindows → other one
    lightly veiled, top bar faded; E → subwindow level: veil gone, bar still
    faded; ↓ D → inside the tab: everything but the focused subwindow dark,
    the numbered subwindow badges still readable; E E E → projects: all lit.
    *Files: `src/styles/subwindows.css`.*
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

215. **Live-QA one-click installs in the root console.** ✅ Implemented · 🧪
    Awaiting live QA. Every one-click install (`runInstallInTab`: Ollama/agent
    CLI installs, the LaTeX/MiKTeX prompt, `gh`/`glab` install + auth login,
    custom-agent install commands) opens its root tab **in the root console**
    (2026-09-17). It used to float its own centered overlay terminal
    (`InstallOverlay`) on the same PTY — a second overlay onto the root
    terminal beside the console; the two are merged, the install overlay, its
    store, CSS and strings are gone. Verify: the console opens over the dialog
    the install was started from, with the install's tab in front, live and
    accepting input (a sudo password); closing it (×, backdrop, Escape outside
    a pane, Ctrl+Shift+R) leaves the install running and reopening shows the
    full output; Escape typed into the terminal does NOT close the console;
    after a relaunch, an install started BEFORE the console was first opened
    keeps the saved root tabs (root is restored before the tab is added) —
    same for a login parked by `openConnectionInRoot`.
    *Files: `src/lib/installCommand.ts`, `src/lib/remote/remoteConnect.ts`,
    `src/stores/rootOverlay.ts` (`openTabInRootConsole`),
    `src/components/layout/AppShell.tsx`.*
    - [x] 🤖 Automated test — `src/__tests__/run/InstallInRootConsole.test.tsx`
      (tab in front + console open, project untouched, restore-before-add,
      no second login mid-restore).
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

216. **Live-QA the scheduled agent warm-up (Manage CLIs → Scheduled warm-up).**
    ✅ Implemented · 🧪 Awaiting live QA. An agent CLI's allowance is a window
    that opens on the first message (Claude's is five hours), so this sends one
    `Test` at times the user picks, **in the background** — the CLI's own
    one-shot mode (`claude -p`, `codex exec`, `gemini -p`, …) as a detached,
    windowless process run by `agent_warmup` in `<state_dir>/agent-cron/`, no
    tab, no terminal, no project (it used to type into a Trash agent tab;
    reworked 2026-08-31) — to put the window where they want it. Settings → Manage CLIs carries one card: master switch, a
    global time list, an **All agents** toggle (default off, a bulk flip of the
    per-agent flags), and a **button grid** of every installed agent (the
    file-hiding endings grid — pressed = participates, greyed = no
    non-interactive mode); an agent that is on gets a row below the grid for
    its own times (override the global list) and "Next: 06:00 tomorrow". The scheduler is `AgentCronHost` at the shell —
    main window only, one-minute tick, a 5-minute grace after each slot and
    **never** a late fire, with the fired slots in localStorage so a reload does
    not resend. Verify: the grid buttons press/unpress and the All toggle
    reads on only when every capable agent is on (and one unpress turns it
    off again); agents without a recipe (aider, cline, …) are disabled with
    the reason in their tip; a time two minutes out fires once
    and only once (a `claude -p Test` process appears in `ps` and exits within
    seconds; no tab or window opens; `claude /usage` afterwards shows the
    session window running); a second window (popout) sends nothing; a slot
    missed while the app was closed is skipped, not sent at launch; the chips read in the user's 12/24-hour setting; the panel's warnings
    render for "armed with no times" and "master switch off". Settings ride the
    backend `extra` catch-all, so **no backend restart is needed**.
    *Files: `src/lib/agents/agentCron.ts`, `src/lib/agents/agentCronRun.ts`,
    `src/components/layout/AgentCronHost.tsx`,
    `src/components/layout/SettingsSubPanels.tsx`, `src/styles/header-menus.css`,
    `src/types/index.ts`, `src/lib/i18n.ts` (+ the four dictionaries).*
    - [x] 🤖 Automated test — `src/__tests__/agents/AgentCron.test.ts` (parse/format,
      per-agent override vs. the global list, the three conditions for being
      scheduled, the grace window and the never-fire-late rule, the fired-slot
      key across midnight, next-run, and the config editors).
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

217. **Live-QA the TeX ⇄ PDF tab coupling mark.**
    ✅ Implemented · 🧪 Awaiting live QA. A compiled PDF opens in its own tab
    beside the LaTeX source, so the two halves of one document sat in the strip
    looking unrelated. Both tabs now carry a small accent **⇄** badge naming the
    other half in its tooltip; clicking it activates that tab — across
    subwindows, via the store's `setActive`. The coupling is **derived** from the
    paths (`<dir>/<stem>.tex` ↔ `<dir>/<stem>.pdf`, case-insensitively), not
    stored on the tab: nothing to persist, nothing to clean up when either tab
    closes, and a PDF opened by hand next to an open source is marked exactly
    like a freshly compiled one. Both `.tex` halves count — the single-tab
    workspace and a standalone `.tex` editor tab. Verify: compiling from a TeX
    workspace makes ⇄ appear on **both** tabs; the tooltip names the partner;
    clicking jumps to it (including when the partner lives in another
    subwindow); closing one half removes the mark from the other; an unrelated
    PDF (`notes.pdf` next to `paper.tex`) is never marked; the badge is muted on
    an inactive tab and full-strength on the hovered/active one; a popout's
    strip shows the same badge for a pair that is fully inside that window.
    *Files: `src/lib/viewers/tex/texPdfLink.ts`,
    `src/components/tabs/TabLocalityBadges.tsx`,
    `src/components/tabs/TabBar.tsx`,
    `src/components/layout/DetachedCenterPanel.tsx`,
    `src/styles/projects-tabs.css`, `src/lib/i18n.ts` (+ the four dictionaries).*
    - [x] 🤖 Automated test — `src/__tests__/tex/texPdfLink.test.ts` (both
      directions, the standalone `.tex` editor, one-half-open, stem and
      directory mismatches, non-viewer/other-viewer tabs, case-insensitive
      pairing, never returning the tab itself).
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

846. **Root console: the root terminal as a Ctrl+Shift+R overlay with Tabtivity's own tools.**
    ✅ Implemented · 🧪 Awaiting live QA. The root scope is no longer a place
    you switch to: Ctrl+Shift+R (rebindable, `rootConsole`), the scope chip's
    Root entry and a root-terminal login all open it as one floating subwindow
    over whatever project is open, and nothing about the project on screen
    moves. Agents opened there, and nowhere else, get Tabtivity's MCP tools:
    `projects_list`, `calendar_list`, `calendar_add_event` (1 h by default),
    `calendar_delete_event`, and the whole to-do board — `todo_list`,
    `todo_add`, `todo_update`, `todo_complete`, `todo_reopen`, `todo_move`
    (column + position, through the drag's own `move_tasks_at`) and
    `todo_delete`. The
    tools are served on loopback with a per-run token that only a root-scope
    agent spawn is given. The root console is never in Tabtivity Mobile's catalog
    and its Claude tabs get no `--remote-control`. Design:
    `docs/context/root_console.md`.
    *Files: `src-tauri/src/services/root_mcp.rs`,
    `src-tauri/src/commands/root_mcp.rs`, `commands/terminal.rs`,
    `commands/calendar.rs`, `services/mobile_control/discovery.rs`, `lib.rs`;
    `src/components/layout/RootOverlay.tsx`, `src/stores/rootOverlay.ts`,
    `CenterPanel.tsx`, `AppShell.tsx`, `ProjectSwitcher.tsx`,
    `src/lib/remote/remoteConnect.ts`, `src/lib/shortcuts/shortcuts.ts`, `src/hooks/useKeyboard.ts`,
    `src/styles/subwindows.css`, `src/lib/i18n.ts` (+ the four dictionaries).*
    - [x] 🤖 Automated test — `services::root_mcp` (spawn wiring per CLI,
      bearer check, every tool incl. the 1 h default and bad input),
      `discovery::the_root_scope_is_never_in_the_catalog`,
      `src/__tests__/root/RootOverlay.test.tsx`.
    - [ ] 🖐️ Manual test (needs a restart: backend change)
      - Ctrl+Shift+R from a focused project terminal opens the console and
        pressing it again closes it; the project stays where it was.
      - Open Claude with **+**: `/mcp` lists `tabtivity`; "add a calendar entry
        tomorrow at 14:00, 1 h, Review" puts the event in the header's 🗓 at
        once. With CalDAV write turned on, the event also reaches the server.
      - With the to-do board open beside the console: "put a card 'Ship' on
        the board for project X", "move it to Doing", "rename it", "mark it
        done", "reopen it", "delete it" — each shows on the board at once,
        with no reload.
      - "Show me my mail" / "open the calendar" / "open the board on that
        card": the console closes and the overlay appears (the card's editor
        for the last one). With that overlay's setting off, the agent is told
        so and nothing opens.
      - Claude in a project tab: `/mcp` lists no `tabtivity`.
      - Codex in the root console: `/mcp` lists `tabtivity`.
      - The phone's project list never shows the root console.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

- [ ] **Root MCP staged writes — live QA** (implemented, not run live).
  After the updated backend is running, ask a root agent to add an event: only
  the header's pending count should change. Open Ctrl+Shift+R and approve: the
  event appears and a CalDAV calendar pushes it. Add then move a card; approve
  both in order, then repeat and reject the add to conflict the dependent move.
  Edit a proposed row yourself: approval must conflict without overwriting it.
  Verify per-tab `proposals_list`, persistence across tab close/resume, bulk
  approval of only displayed cards, inert bidi titles, and the outbound warning.
  In Settings → root MCP review, choose destructive: adds apply with Undo,
  deletes wait; Undo after a user edit conflicts. Off restores direct writes.
  Keep the strip/setting's `UntestedTag` until these checks are confirmed.
- [ ] **Root MCP usefulness + read hygiene — live QA** (implemented 2026-09-20,
  not run live). In a root Claude tab ask for "my calendar, my board and my
  projects" in one turn: three parallel calls, none may fail with a 429. Ask
  "which projects have uncommitted work" (partial answer + `skipped` if slow,
  never an error) and "what happened in <project> lately" (`project_activity`).
  Ask for "a free hour next week" (`calendar_free_busy`), a weekly event with a
  reminder, and a card with a priority. Check that a subscribed (read-only)
  calendar's events arrive `external` with `[link]` for URLs and that no reply
  shows `caldav_href`. Switch the agent fence off for root: the ⚿ badge gains ⚠
  and the review strip says review is not enforced. Open a reader draft with
  recipients: the composer shows the recipients warning.
- [ ] **Root MCP token is inherited by everything the agent runs** (open,
  2026-09-23). The token reaches Claude/Codex/Vibe through the process
  environment (`${TABTIVITY_ROOT_MCP_TOKEN}`, `bearer_token_env_var`,
  `api_key_env`), so hooks, package scripts, Makefiles and `curl` inside the tab
  can call the tools as the tab; the schedule token is the same for project
  agents. Documented (`docs/context/root_console.md`, *Known limit,
  inherited*; audit help text). Closing it needs the CLI to read the secret
  from a 0600 file and scrub the variable before spawning children — file
  upstream requests, or wrap the CLI once one supports a token file.
- [ ] **Root MCP `calendar_import_ics` — live QA** (implemented 2026-09-21, not
  run live; pill `rootReview.icsImport`). After the updated backend is running,
  give a root agent an `.ics` and ask it to import it: the reply must say
  *proposed*, the ✓ Approvals count goes up by one and the calendar is
  unchanged. The card shows the file's counts and findings (try one with an
  `ATTACH` or a `PROCEDURE` alarm); ✓ creates one new calendar with the entries,
  ✗ discards. "Approve all" must not import it. Afterwards `calendar_list` shows
  the imported events `external` with `[link]` for URLs. Also check: a sixth
  staged file from one tab is refused, a file over 96 KiB is refused with the
  Import-button hint, the tool is absent for a mail reader, and with
  `root_mcp_review` off the file still only stages.
  - [ ] 🖐️ Manual test
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

2314. **The root console as a window: a docked file viewer, move, resize.** ✅
    Implemented · 🧪 Awaiting live QA. Three things the console lacked because
    it was built as a dialog and is used as a window (2026-09-17). **The file
    viewer** docks on every subwindow's right edge through the same ◫ a
    project's subwindows carry — the shared `SubwindowFilesSidebar` →
    `ProjectFilesTab` → `ProjectFilesView`, so no fourth copy of the viewer —
    rooted at `~/tabtivity/root`, the folder that belongs to no project and could
    until now only be read with `ls` from inside the console. Its state is the
    group node's own three fields (`filesOpen`/`filesWidth`/`filesFolder`),
    written through new `setGroupFiles*InScope` actions, because root is not the
    active scope while the console floats over a project and the plain actions
    would have filed the console's file column onto the project on screen.
    Unsplit, the ◫ sits in the console's title bar beside the ×, and the control
    cluster reserves the column's width the way `TabBar` does; split, every
    subwindow carries its own ◫ and its own column. **Move** is a drag of the
    title bar (a press on a tab or a control keeps its own meaning), **resize**
    is eight grips on the edges and corners, and ⤢ fills the window with ⤡ back
    — double-clicking the bar does the same. The frame is remembered per machine
    in localStorage (`stores/rootOverlay`, the `fileSourcePref`/`texViewPref`
    convention, never `settings.json`: where a window sits on one desk is not a
    preference worth syncing) and re-clamped against the window it actually
    opens in, so a console sized on an external display is still reachable
    without one; an edge dragged past the minimum pins the opposite edge instead
    of pushing the console across the screen.
    *Files: `src/components/layout/RootOverlay.tsx`, `src/stores/rootOverlay.ts`,
    `src/stores/tabs.ts`, `src/styles/subwindows.css`, `src/lib/i18n.ts` (+ the
    four dictionaries), `docs/context/root_console.md`.*
    - [x] 🤖 Automated test — `src/__tests__/root/RootOverlay.test.tsx` (the ◫ writes
      the ROOT group node and never the project's, the column's scope/cwd/viewer
      id, one column per split subwindow, fill/restore, and the pure frame
      helpers: clamping into a smaller window, move, corner resize, the pinned
      far edge).
    - [ ] 🖐️ Manual test (frontend only — hot-reloads)
      - Ctrl+Shift+R, then ◫: a file tree of `~/tabtivity/root` docks on the right;
        drag its left edge to resize it, double-click that edge to close it.
        Close and reopen the console — the column, its width and its browsed
        folder are still there; the project on screen never grew one.
      - Split the console (drag a tab onto a body edge): each subwindow has its
        own ◫ and its own column.
      - Drag the title bar's empty space to move the console; drag each edge and
        corner to resize it; ⤢ fills the window and ⤡ comes back; a
        double-click on the bar toggles the same. A press on a tab still drags
        the tab, and a press on ⚿/×/+ still does its own job.
      - Relaunch: the console opens where it was left, at the size it was left.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

2315. **Root console: an event is edited in place, and five sweeps answer for
    every project at once.** ✅ Implemented · 🧪 Awaiting live QA (2026-09-17).
    Six tools on top of the console's original set. **`calendar_update_event`**
    was the missing sibling of `todo_update`: rescheduling an event used to mean
    delete + add, which loses the row's identity, so a CalDAV server saw a
    cancellation and a new invitation. Only the fields given change, an empty
    string clears `location`/`notes`, and moving `start` alone **keeps the
    event's length** (an agent that omits `end` is moving it, not resizing it);
    `all_day` can be turned on and off, and an event in a read-only calendar is
    refused before anything is written. The five read-only sweeps answer what no
    project agent can: **`projects_git_status`** (branch, ahead/behind,
    staged/unstaged/untracked per project, `dirty_only` to keep it short),
    **`sync_status`** (lockstep state and why, what byte-sync tracks, and the
    unacknowledged local-loss warnings), **`time_summary`** (tracked seconds per
    project, Tabtivity's own window time separate), **`usage_recap`** (the daily
    recap's counters over a range) and **`boxes_list`** (each box's members and
    relations). None of them opens a connection: the git sweep reads the local
    working copy only — a remote project through its mirror, skipped with a
    reason when it has none — and `sync_status` reports the last recorded pass,
    because a synchronous SSH round trip per project inside a tool call is the
    window freeze the remote gates exist to avoid. Both rollups are bucketed by
    UTC date, as they were written, and say so. Design:
    `docs/context/root_console.md`.
    *Files: `src-tauri/src/services/root_mcp.rs`,
    `src-tauri/src/commands/root_mcp.rs`, `commands/calendar.rs`,
    `schema/calendar.rs` (`days_between`/`minutes_between`),
    `services/{git_peer,remote_sync,local_loss}.rs` (`*_in` path helpers).*
    - [x] 🤖 Automated test — `services::root_mcp` (the move-keeps-its-length
      rule, field-by-field edits, all-day both ways, every refusal incl. the
      read-only calendar; the porcelain/branch-header parsers; the git sweep
      against a real repo, a non-repo, a missing folder and a mirror-less remote;
      the rollups' ranges, filters and app-time split; `sync_status` against
      written state), `schema::calendar` (the two date helpers).
    - [ ] 🖐️ Manual test (needs a restart: backend change)
      - In a root Claude/Codex tab: "move tomorrow's 14:00 Review to 16:00" —
        the header's 🗓 shows it at 16:00, still one hour long (or whatever it
        was), and the same event, not a new one. With CalDAV write on, the
        server gets an update rather than a cancel + invite.
      - "Rename it", "clear its notes", "make it an all-day event", "put it back
        at 10:00 for 90 minutes" — each lands at once, with no reload.
      - "Which of my projects have uncommitted work?" — the answer matches the
        switcher's dots; a remote project without a mirror is named as skipped
        rather than silently missing.
      - "How long was I on <project> last week?" and "what did I do yesterday?"
        — the numbers match the daily recap's.
      - "Is anything out of step with its host?" — matches the pill lamps and
        the local-loss dialog, with no SSH connection made (a disconnected
        remote project answers instantly).
      - "What's in my boxes?" — members and their names match the switcher.
      - The ⚿ badge's tooltip lists twenty tools.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

2316. **Root console: one global switch for Tabtivity's MCP tools.** ✅
    Implemented · 🧪 Untested (2026-09-17). `settings.json`'s `root_mcp`
    (absent means on, so nothing migrates) turns the root console's tools off
    and on. It is read per spawn and per request, so neither direction needs a
    restart, and off closes both halves: `apply_to_spawn` hands a new root agent
    no endpoint, and `POST /mcp` answers `503` to the agents that already hold
    the token — after the bearer check, so an unauthenticated caller learns
    nothing from it. Two doors onto the one key: Settings → "Tabtivity's tools
    (MCP) for root-console agents", and the console's ⚿ badge, now a button
    that is struck through while off.
    *Files: `src-tauri/src/schema/settings.rs`, `services/root_mcp.rs`
    (`enabled_in`), `commands/root_mcp.rs`,
    `src/components/layout/{RootOverlay,SettingsPanel}.tsx`.*
    - [x] 🤖 Automated test — `services::root_mcp::the_switch_is_on_unless_stored_off`.
    - [ ] 🖐️ Manual test (needs a restart once: backend change)
      - Click the ⚿ badge: it strikes through, and the Settings toggle follows.
        A root Claude tab opened now has no `tabtivity` server under `/mcp`.
      - In a root agent opened *before* the click, ask for the calendar: the
        tool call fails with "switched off in Tabtivity's Settings".
      - Click again: that same agent's next tool call works, no restart.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

---

2317. **Colour a tab, on the desktop and on the phone.**
    ✅ Implemented · 🧪 Awaiting live QA (2026-09-18). A tab bar of five
    look-alike `claude` tabs had one mark to tell them apart — the label — and
    the tab's *kind* colour, which is the same for all five. A tab now carries
    an optional colour from a closed palette of eight hues
    (`src/lib/theme/tabColors.ts`, the calendar sidebar's own eight, so the app has
    one palette rather than two): **right-click a tab → Colour**, a swatch grid
    under the menu's accent group label, with a leading ⃠ chip that clears it.
    The colour substitutes for the kind colour in the same `--tab-accent` slot,
    so every treatment already keyed off it follows without a second code path;
    what is new is that a coloured tab shows its bottom rule while **inactive**
    too (dimmed, `.tab.has-tab-color`), because a mark only the current tab
    carries says nothing about the other four. The picker deliberately keeps the
    menu open after a pick — it is the one row in that menu that is not a
    one-shot action — which is also why the popout's strip finally dismisses its
    context menu on an outside click / Escape like the main window's does.
    Persisted through `toSavedTabEntry` (so the colour survives the relaunch
    that reopens the tabs) and validated against the palette on the way back
    in; copied by Duplicate, since a colour describes a tab rather than
    identifying it. The popout forwards its pick as the `setColor` edit, applied
    optimistically so the tab recolours under the open picker.

    On the phone the same colour is reachable and readable: **✻ Colour** on any
    tab card (agent or shell — the rename beside it is agent-only) opens a
    sheet of named chips that commits on the tap, and the colour becomes the
    card's left border on the project screen *and* on the flat cross-project
    Activity list, which is the list it earns most. `PUT
    /api/v1/tabs/{id}/color` is its own route rather than a field on the
    agent-only rename, whose body is `deny_unknown_fields`. **Only a palette id
    crosses** — never a CSS value — validated by `protocol::clean_tab_color` at
    the sidecar, again at the desktop bridge (reachable without that route),
    and once more on restore; an unknown id is refused rather than read as a
    clear, and the catalog drops one it does not know instead of publishing it
    for the phone to guess at. The bridge write is scoped, restores the project
    first and persists the layout itself, for the three reasons the close
    beside it does: the phone colours a tab in whichever project it is looking
    at, that project may not be open in the window at all, and `CenterPanel`
    persists only the active scope — so without the write the catalog (read out
    of that same session file) would keep publishing the old colour.
    *Files: `src/lib/theme/tabColors.ts`,
    `src/components/tabs/TabColorPicker.tsx`, `src/components/tabs/TabBar.tsx`,
    `src/components/layout/{DetachedCenterPanel,DetachedApp}.tsx`,
    `src/stores/{tabs,detached}.ts`, `src/styles/projects-tabs.css`,
    `src/lib/i18n.ts` (+ the four dictionaries),
    `src/components/mobile/MobileBridgeHost.tsx`,
    `src-tauri/src/services/mobile_control/{protocol,discovery,host}.rs`,
    `mobile-web/src/tabColors.ts`, `mobile-web/src/screens/ColorSheet.tsx`,
    `mobile-web/src/screens/{Project,Activity}.tsx`, `mobile-web/src/api.ts`,
    `mobile-web/src/style.css`.*
    - [x] 🤖 Automated test — `src/__tests__/tabs/TabColor.test.tsx` (the palette
      resolves its ids and nothing else, incl. a hex and a CSS injection; the
      scoped and active-scope writes; the disk projection; restore dropping an
      unknown id; the popout's optimistic apply; and the real `TabBar` menu
      painting, keeping itself open, and clearing),
      `src/__tests__/mobile/MobileTabColor.test.tsx` (the bridge across a
      non-showing scope, a shell tab, the layout write, clear-by-null and
      clear-by-absent, every refusal; and the phone screen's chips, request
      body, ring and card border), `services::mobile_control::host`
      (`clean_tab_color`), `services::mobile_control::discovery` (a palette
      colour published, an unknown one dropped).
    - [ ] 🖐️ Manual test (needs a restart: backend change — the sidecar route
      and the published field)
      - Right-click a tab → pick a hue: the tab's bottom rule takes it at once,
        and stays visible when another tab is active. Pick a second hue without
        re-opening the menu. ⃠ clears it. Escape / a click outside closes the
        menu.
      - Colour three tabs, quit and relaunch: all three come back coloured.
        Duplicate one: the copy carries the colour.
      - Pop a coloured tab out: the popout's strip shows the colour; colour a
        tab *in* the popout and dock it back — the colour survives.
      - On the phone: ✻ Colour on an agent card and on a shell card. The chip
        rings, the card gets a left border, and the desktop tab recolours
        without a reload. The Activity list's row shows it too.
      - Colour a tab of a project the desktop window is **not** showing: it
        lands there, the project on screen is untouched, and it is still there
        after a relaunch.
      - With desktop Tabtivity closed, the sheet says "Open desktop Tabtivity to
        colour a tab." rather than a generic failure.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

2319. **A shell the agent started is its own mark, beside the agent's.**
    ✅ Implemented · 🧪 Awaiting live QA (2026-09-20). The shell status colour
    (`--status-shell-working`, 0d8036e) stopped at shell *tabs*: an agent tab
    whose turn had ended while a command
    of its own kept running reached the window as a held `working` verdict and
    wore the agent's green, saying "this agent is thinking" about a tab that had
    stopped thinking an hour ago. The backend now reports the two facts apart —
    `services::agent_turn` polls `/proc` for the tool shells every bound tab is
    running (one walk for the whole fleet, every 2 s) and puts a `job` flag on
    every `agent-turn` event beside the hook's own state, instead of rewriting a
    `done` into a `working`. Only a **backgrounded** command counts: either it
    outlived the turn (`done`, the reading this started as, and Codex's only
    one) or Claude's wrapper says so — `run_in_background` is the one spelling
    that redirects stdin, so the eval'd command is followed by `< /dev/null`
    before the wrapper's `pwd -P` (measured against a live tab, 2026-09-20).
    The tool call an agent is sitting and waiting on is NOT a job: that is the
    turn, and it is already green. The window reads both halves: a `done` over a
    running job keeps the tab busy but paints it in the shell colour (and holds
    the "finished" flag and the scheduled-prompt gate, as the held verdict used
    to), and a `working` with a job is **both at once** — the green ring the
    agent has earned, plus a *second* ▶ mark in the shell colour for the
    command. One helper (`busyStateClass`) resolves the class for all three
    strips (docked, root console, popout), and the busy kind rides the popout
    mirror so a detached tab says the same thing.
    *Files: `src-tauri/src/services/agent_turn.rs`, `src/stores/activity.ts`,
    `src/stores/detached.ts`, `src/components/layout/{AppShell,SidePanel,RootOverlay,DetachedCenterPanel}.tsx`,
    `src/components/tabs/{TabBar,TabLocalityBadges}.tsx`,
    `src/styles/projects-tabs.css`, `src/lib/i18n.ts` (+ the four dictionaries).*
    - [x] 🤖 Automated test — `services::agent_turn` (two live shells of the
      real wrapper's two spellings: the backgrounded one is announced once,
      beside the state its hooks last reported, the foreground tool call is not
      — until its turn ends; the seam is not matched when the USER's command
      ends in `< /dev/null`; a tab with no job says nothing; a session end
      forgets both), `PillRunningIndicator`
      (a finished turn stays busy as a *command* and raises no "finished" flag
      nor opens the delivery gate until the shell exits; an agent working with
      one is `both`; a verdict whose silence is the job's is not retired),
      `TabStatusMark` (one mark, the shell's mark, or two), `DetachedTwoHeap`
      (the busy kind crosses to the popout).
    - [ ] 🖐️ Manual test (needs a restart: backend change — the `job` flag on
      the `agent-turn` event)
      - In a Claude tab, run something long in the background
        (`run_in_background`, or `npm test &`), then let the turn end and switch
        away: the tab's ring and ▶ are the shell colour, not the agent green,
        and it does **not** read as finished. When the command exits the tab
        turns green-solid ✓ (finished, unread) without the agent doing anything.
      - While the agent is working AND a command it backgrounded is running, the
        tab shows **two ▶ marks** — green then shell-coloured — with the ring
        still green.
      - An ordinary long foreground tool call (a `cargo build` the agent is
        waiting on) shows **one** green ▶, not two: the turn is what is running.
      - A scheduled prompt aimed at that tab waits for the command, not just for
        the Stop.
      - Pop the tab out: the popout's strip shows the same colour and marks.
      - A plain shell tab running a build is unchanged (shell colour, one mark).
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
