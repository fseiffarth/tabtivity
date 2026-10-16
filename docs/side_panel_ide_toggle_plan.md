# Side panel: IDE-standard show/hide (VS Code model)

Status: plan only. On approval this file is saved as
`docs/side_panel_ide_toggle_plan.md`; no code changes now.

## Context

The desktop side panel (files / git / apps / agents …) opens in a way no
mainstream app or IDE does:

- **Unpinned (the default):** an overlay that opens after the pointer rests
  400 ms on the edge rail (`RAIL_DWELL_MS`). It closes on mouse-leave, with a
  `hoverGuard` for hover-opens the pointer never entered. To dock it you click
  the 📌 inside it.
- **The rail goes away once the panel opens** (`!revealPanel` gate in
  `AppShell.tsx`), so the icons that opened it can't close it. This is also why
  the rail buttons commit on pointer press rather than on click
  (`railPressedAt`).
- **There is no key for the panel itself.** Super/F9 (`togglePanels`) hides
  every panel, and steering's `b` only works inside steering mode.

Users of VS Code, Cursor, JetBrains, Zed and Obsidian expect three things:

- an **activity bar that is always there** and marks the active view;
- **clicking the active icon collapses** the side bar, and clicking another
  icon switches to that view;
- **Ctrl+B / ⌘B toggles** it, and it stays **docked**, pushing the workspace
  aside, with its open/closed state remembered across restarts.

The user chose:

- **The VS Code model.** Docked toggle, no hover-open and no pin by default.
  Today's hover overlay survives only as an opt-in **Auto-hide** setting.
- **Ctrl+B, but never inside terminals.** The key stays with tmux and
  readline there. Alt+1 is a terminal-safe alias (off on macOS), and ⌘B
  covers macOS everywhere.

## Decisions

1. **State model.** One persisted `side_panel_open` boolean replaces
   `panelOpen` + `panelPinned` for the docked mode. A new
   `side_panel_auto_hide` (default `false`) brings back today's unpinned
   overlay: dwell, mouse-leave close, `hoverGuard`, no reflow.
   `side_panel_pinned` / `right_panel_pinned` become read-only legacy
   fallbacks, the same pattern as `right_panel_*` in `src/types/index.ts`.
   Nothing writes them any more.
2. **Migration (round-trip existing state).** These keys go through the
   settings `extra` catch-all, so no backend field is needed.
   - `side_panel_open` unset → `side_panel_pinned ?? right_panel_pinned ?? false`.
     A user who had pinned the panel finds it open and docked. A hover user
     finds it closed, with the rail one click away.
   - Auto-hide is never switched on by migration. The new default is the point
     of the change.
3. **The activity bar is permanent.** The rail renders whenever
   `panelTarget && !panelsHidden`, open or closed and in both modes. It sits at
   the outer window edge with the panel inside it, as in VS Code: on the right
   edge `[workspace][panel][rail]`, mirrored on the left. Each view icon gets
   `aria-pressed` / `.active` when the panel is open on that view.
4. **Click semantics** (in `onClick`; the pointer-press commit is no longer
   needed because the rail never unmounts):
   - view icon, panel closed → open on that view;
   - icon of the view already shown → close;
   - another view's icon → switch to it, staying open;
   - chevron → toggle on the remembered view. It points inward when closed and
     outward when open. It is also the way to close a view that has no rail icon
     (sessions, jobs, remarks, todo, orange).
   - The side switch keeps its press-commit, because it re-mounts the rail on
     the other edge under the pointer.
5. **Auto-hide mode** keeps the dwell, `hoverGuard` and mouse-leave close.
   Clicking the active icon of a panel that was *hover*-opened commits it, the
   same as a click-open today: hover-close is disarmed and the panel stays.
   It does not close it. This avoids the race where a dwell opens Git and the
   click that was already on its way toggles it straight shut. A second click
   closes it.
6. **Keyboard.**
   - New `ShortcutAction` `toggleSidePanel`, group `view`, default Ctrl+B
     (`ctrl: true`, which `chordMatches` already reads as ⌘ on macOS).
   - `actionChords` adds Alt+1 as an alias off macOS, in the same place the F9
     alias sits beside lone-Super. A rebind replaces both.
   - It matches through `useKeyboard`'s normal `is()` path, after the
     editable-target guard. So from inputs, the code editor and terminals
     Ctrl+B stays theirs (tmux prefix, readline, the bold key in
     `MarkdownPromptField`).
   - Two exceptions may reach it from a field. (a) A chord with Alt, from any
     target including a pane terminal: `terminalYieldsChord` and
     `terminalMayTakeChord` in `src/lib/shortcuts/terminalTabChord.ts` admit
     `toggleSidePanel` only when the matched chord carries `alt`. (b) ⌘B on
     macOS: add the action to the `editorMayTakeChord` set, unless
     `e.defaultPrevented`, so the Markdown field's ⌘B bold still wins.
   - Super/F9 `togglePanels` (hide all panels) and steering's `b` keep working.
     Steering's `onSidePanel` now sets `side_panel_open`.
7. **Panel header.** The 📌 pin button is replaced by a **Hide side panel**
   button: the same chevron icon pointing outward, in the same `pin` slot of
   `ProjectFilesView`. The side-flip button stays. The panel's own view
   switcher stays: it lists all nine views, and the Files tab host needs it.
8. **Rail context menu** (right-click, as on VS Code's activity bar):
   Move to left/right · Auto-hide ✓ · Hide side panel. Build it through the
   shared `ContextMenuPortal` scheme. Auto-hide also gets a `ToggleRow` in
   Settings › General, next to UI zoom (`SettingsPanel.tsx` ~l.1420).
9. **Resize sash, VS Code behaviour.**
   - Dragging below `SIDE_PANEL_MIN − 60` (≈160 px) snaps the panel closed and
     keeps the last good width for the next open.
   - Double-clicking the sash resets the width to `SIDE_PANEL_DEFAULT` (280).
   - `clampPanelWidth` subtracts the rail width.
10. **No slide in docked mode.** A docked open or close reflows straight away,
    with no transform transition, and dispatches `resize` so terminals refit,
    as `onResizeEnd` already does. The slide transition stays for the
    auto-hide overlay only. No blurred `box-shadow` animation.

## Steps

1. **Settings types:** `src/types/index.ts`.
   - Add `side_panel_open?: boolean` and `side_panel_auto_hide?: boolean`,
     with doc comments.
   - Mark `side_panel_pinned` `@deprecated` as a read-only fallback.
2. **`AppShell.tsx` state.**
   - Derive `panelOpen` from settings (with the migration fallback) and keep a
     local mirror only for auto-hide's transient hover-open.
   - Replace `panelPinned` / `togglePin` with `autoHide` and a single
     `setSidePanelOpen(open)` that persists `side_panel_open` and dispatches
     `resize`.
   - `revealPanel`, `railDocked`, the `.app-body` docked classes and the
     padding become: docked = `!autoHide && open` → padding =
     `panelWidth + rail`; otherwise gutter = rail.
   - Keep `app:reveal-side-panel` (tour/lessons) working: it opens the panel,
     and in auto-hide mode it counts as a click-open.
3. **Rail rendering** (`AppShell.tsx` ~l.1312–1405):
   - drop the `!revealPanel` gate;
   - give each view button `aria-pressed` from the current `panelView`
     (`sidePanelViewKey` / settings, as `SidePanel.tsx` reads it);
   - add the click semantics (Decision 4) and the auto-hide commit rule
     (Decision 5);
   - wire `onContextMenu` to the rail menu (Decision 8);
   - delete `railPressedAt` except on the side switch;
   - run the dwell handlers only when `autoHide`.
4. **`SidePanel.tsx`.**
   - Swap the `pinned` / `onTogglePin` props for `onHide`, and render the hide
     button in the `chrome` slot (`RailChevronIcon` from
     `common/EdgeRailIcons`).
   - Mouse enter/leave props stay, used only in auto-hide.
   - Add `onResizeReset` for the sash double-click.
5. **CSS.**
   - `src/styles/files-panel.css`: `.side-panel` is offset by `--side-rail-w`
     from its edge; there is no transform transition unless an `.overlay`
     class is set (auto-hide).
   - `src/styles/onboarding.css`: the rail's comment block is rewritten (it
     no longer unmounts); add a `.side-panel-reveal-handle.active` style (a
     static accent edge bar, as VS Code's active indicator).
   - `src/styles/shell.css:85`: the docked padding includes the rail.
   - Keep `.tour-edge-marker` on the rail.
6. **Shortcuts.**
   - `src/lib/shortcuts/shortcuts.ts`: the `toggleSidePanel` def (group
     `view`, `untested: "shortcut.toggleSidePanel"`) and the Alt+1 alias in
     `actionChords`.
   - `src/hooks/useKeyboard.ts`: an `onToggleSidePanel` option and the
     `is("toggleSidePanel")` dispatch, plus the Alt-from-terminal and ⌘B-macOS
     admissions (Decision 6).
   - `src/lib/shortcuts/terminalTabChord.ts`: the Alt-chord yield.
   - Update the shortcut cheat sheet / help group if it lists `view` keys
     explicitly.
7. **i18n** (`src/lib/i18n.ts`, then de/es/fr/it):
   - `shortcut.toggleSidePanel`, `sidePanel.hideTitle`;
   - the rail menu entries (`appShell.railMoveLeft/Right`,
     `appShell.railAutoHide`, `appShell.hidePanel`);
   - the settings row label and description;
   - rewrite the pin-based lesson text (below);
   - delete `sidePanel.pinTitle` / `unpinTitle` once nothing uses them.
8. **Lessons and tour.**
   - In `src/lib/lessons.ts:272`, the `pin-panel` step anchors on
     `.side-panel-pin`. Re-anchor it to the rail's chevron and reword it as
     "click an icon or press Ctrl+B to keep the panel open; click it again to
     hide it".
   - `src/lib/tour.ts` keeps `app:reveal-side-panel`, but update its "hover"
     comments.
9. **Untested register:** add a `src/lib/untested.ts` row
   `sidePanel.ideToggle`. Put the `UntestedTag` pill on the Auto-hide settings
   row, and add `untested:` to the rail menu entries.
10. **Help and docs.**
    - `docs/help/tabs-and-panels.md:63`: "Click an icon on the edge bar (or
      press Ctrl+B / ⌘B; Alt+1 also works from a terminal) to show or hide the
      panel; click the active icon to hide it. Auto-hide (right-click the bar)
      brings back the reveal-on-hover overlay."
    - Add the key to `docs/help/keyboard.md`.
    - Update the `SidePanel.tsx` row in `docs/filemap_frontend.md` (it says
      "📌 pin").
11. **Tests.**
    - Rewrite `src/__tests__/shell/SidePanelEdgeRail.test.tsx`. Clear
      `localStorage` and file-view snapshots in `beforeEach`.
    - Docked mode:
      - the rail stays mounted while the panel is open;
      - the active icon is `aria-pressed`;
      - clicking the active icon closes and persists `side_panel_open: false`;
      - clicking another icon switches without closing;
      - the chevron toggles;
      - the gutter grows to `panelWidth + rail` when open;
      - migration: `side_panel_pinned: true` with no `side_panel_open` →
        opens docked;
      - no dwell opens anything.
    - Auto-hide mode: the existing dwell / `hoverGuard` / mouse-leave cases
      move under a `describe("auto-hide")`, plus "clicking the active icon of
      a hover-open commits instead of closing".
    - Sash: dragging under the threshold closes, and a double-click resets to
      280.
    - Keys:
      - Ctrl+B toggles from the body;
      - Ctrl+B is ignored from an input and from `.xterm-helper-textarea`;
      - Alt+1 toggles from `.xterm-helper-textarea`;
      - a rebind replaces the alias.
    - Add `toggleSidePanel` to any default-chord uniqueness test in the
      shortcuts tests.

## Out of scope

- The per-subwindow docked files sidebar (`files/SubwindowFilesSidebar.tsx`).
- Popout windows, which have no side panel.
- The phone PWA.
- Moving the panel's nine-view switcher into the rail.

## Verification

- Gates: `scripts/gates.sh` (touches `npm run build`, `npm test`,
  `npm run lint`, `scripts/brand-check.sh`; frontend only, so no `cargo`
  gate), then `git diff --check`.
- Not run live (the app is never started by the agent). Manual steps for the
  user in the dev build:
  1. Fresh settings: the panel is closed and the rail is visible. Click
     Files: it opens docked and the workspace shrinks. Click Files again: it
     closes.
  2. Click Git while Files is open: it switches and stays open.
  3. Ctrl+B in the tab bar or on an empty area toggles it. Focus a shell tab:
     Ctrl+B reaches the shell (`Ctrl+B` in bash moves back a character; in
     tmux it is the prefix). Alt+1 toggles the panel from that terminal.
  4. Restart: the open/closed state and the view are restored.
  5. Drag the sash to the far edge: it snaps closed. Reopen: the old width is
     back. Double-click the sash: 280 px.
  6. Right-click the rail → Auto-hide: resting on the rail opens the overlay
     without reflow; it closes on mouse-leave; clicking the active icon of a
     hover-open keeps it.
  7. Move to left: everything mirrors.
  8. An install that had the panel pinned opens docked.
- Add a 🖐️ QA box to `todo/` with the per-platform ✅/❌ pairs (Linux X11 and
  Wayland, Windows, macOS ⌘B) when it is implemented.
