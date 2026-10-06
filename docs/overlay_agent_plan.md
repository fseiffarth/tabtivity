# Agent docked in the mail / calendar / to-do overlays — plan

Status: implemented on branch `overlay-agent` (Steps 1–8, see "As built" at
the end); not yet live-verified.

## Why

The root agents are the only ones with Tabtivity's own MCP tools: `calendar_*`,
`todo_*`, `mail_*` and the project sweeps (`services::root_mcp`). Today the user
has to pick one of two views:

- **The app overlay** (✉ / 🗓 / ☑) shows the data. Ctrl+1 here opens an agent
  in the workspace pane *under* the overlay, where it can't be seen.
- **The root console** (Ctrl+Shift+R) holds the agent. It floats over
  everything and covers the calendar.

The promo video shows something neither view can do today: you type "put a
meeting on Friday 14:00" and watch the entry land in the calendar. This plan
makes that the normal way to work. A hotkey inside any of the three overlays
docks a root agent tab beside the app, in the same window, so the agent's MCP
writes show up next to the prompt that caused them.

## Decisions

1. **Hotkey: Ctrl+1–9 are routed into the overlay** (the user picked this). While
   a mail, calendar or to-do overlay is up, the existing new-agent chords open
   that slot's agent as a root tab docked in the overlay (Ctrl+1 is the default
   agent). Today these chords open a tab that is hidden under the overlay, so
   nothing useful is lost. No new shortcut action is added. The rebinding,
   physical-key matching and "works from a focused terminal" all come from the
   existing `newAgentTab*` actions.
2. **Layout: a docked column inside the overlay** (the user picked this). The
   column is resizable, sits on the right like the ◫ file column, and shows an
   attach-only `TabPane` of a root-scope tab. One window means one frame, which
   moves, fills and closes together.
3. **The tab lives in root.** It goes into `tabsByScope.root` through the same
   hydrate-first door the console uses. Its PTY is owned by `CenterPanel`'s
   keep-alive layer, as for every root tab. Closing the overlay or the column
   ends nothing, and the tab also shows as an ordinary tab in the root console.
   The MCP rights need no backend change: `pty_spawn` already hands out the
   token for `is_agent && project_id.is_none()`.
4. **Which agents are offered** follows the root console's own "+" menu. The
   list is root-allowed agents only (`useAddTabMenuData(ROOT_SCOPE)` →
   `rootAllowedAgentBins`), in `agentShortcutSlots` order. If the default agent
   is not root-allowed, slot 1 is empty. Ctrl+1 then shows an inline hint in the
   column ("Allow <agent> in the root console: Models & agents → Root chip")
   instead of silently passing the key through. Any other empty slot passes the
   key on, as it does today.
5. **One docked agent per overlay**, recorded in a session-only store (per-app
   `{ key, open }`). Ctrl+N works like this:
   - If the column is closed, its tab is still alive and it is the same agent,
     Ctrl+N re-opens the column on that tab, so the conversation is kept.
   - Otherwise Ctrl+N mints a new root tab and docks it. The previous tab keeps
     running in the root console.
6. **Only one visible view per PTY.**
   - While the root console is open, the column shows a placeholder ("Shown in
     the root console") instead of its pane.
   - `CenterPanel`'s root copy steps aside for a key that a live column shows.
     This is the same rule as `!(rootConsoleOpen && scopeKey === ROOT_SCOPE)`.
7. **Escape typed in the agent belongs to the agent.** Each overlay's
   window-level Escape handler ignores events whose target is inside the column.
   This is `RootOverlay`'s `regionRef` rule. Without it, Escape (Claude's cancel
   key) would close the overlay.
8. **"Flying in"**: rows that arrive through `root-mcp-changed` get a short
   arrival animation in the calendar and on the board. The animation uses
   opacity and transform only, never an animated blurred `box-shadow`, and
   `prefers-reduced-motion` turns it off. User edits never trigger it. Under the
   default review level (`root_mcp_review = "all"`), writes are staged first and
   land when the user approves them in the overlay's own ✓ Approvals pill. That
   pill is already in the same window, so the animation plays on approval.
   Lower levels apply the write at once.

Non-goals: auto-navigating the calendar to a new entry's date; phone support;
a dock in popouts (the overlays aren't mounted there); any change to MCP
tools or review gates.

## Steps

1. **Root-tab door without the console** — `src/stores/rootOverlay.ts`
   - Extract `addTabToRoot(spec, onOpened?)` from `openTabInRootConsole`. It
     hydrates first, then calls `addTabToScope(ROOT_SCOPE, …)`, and keeps the
     detached-window branch.
   - `openTabInRootConsole` becomes `addTabToRoot` + `show(tab.key)`. Behaviour
     stays the same.

2. **Dock store** — new `src/stores/overlayAgent.ts`
   - Per `SteeringApp` (`"mail" | "calendar" | "todo"`, reuse the type):
     `{ key: string | null; open: boolean }`.
   - Actions: `dock(app, key)`, `hide(app)`, `reopen(app)`.
   - A `shownKeys` set is written by the column's mount effect and read by
     `CenterPanel`.
   - Column width is a per-machine localStorage value
     (`storageKey("overlayAgentWidth")`), clamped like `clampFilesWidth`.
   - Subscribe to `tabsByScope.root`: when a docked key's tab is gone (it was
     closed in the console, or exited), clear it.

3. **Chord routing**
   - `src/lib/shortcuts/newTabChord.ts`: add `OVERLAY_AGENT_EVENT` and
     `requestOverlayAgent(slot): boolean`. It is a cancelable `CustomEvent`, the
     same pattern as `requestNewTab` / `TabBar`'s listener.
   - `src/hooks/useKeyboard.ts` (~L825): before `requestNewTab`, for
     `request.kind === "agent"`, check `frontAppOverlay()`:
     - An app overlay counts when its store has `overlayOpen` and its settings
       gate (`mail_client` / `calendar_global_app` / `todo_board`) is on.
     - The overlay containing `document.activeElement` wins. Otherwise the
       topmost open one wins, by mount order in `AppShell` (todo > calendar >
       mail).
     - If that overlay answers, preventDefault, leave steering, and close the
       root console if it is open, so the column becomes visible.
   - Shell and monitor chords are unchanged.

4. **The column** — new `src/components/layout/OverlayAgentColumn.tsx`, plus a
   hook `useOverlayAgent(app)`
   - The hook (mounted by each overlay while it is live):
     - It reads `useAddTabMenuData(ROOT_SCOPE)` → `agentShortcutSlots(...)`.
     - It listens for `OVERLAY_AGENT_EVENT`, but only when it is the addressed
       app.
     - It builds the spec with `buildStaticTabSpec(item, rootDir, "", t)`,
       exactly as the console's menu does.
     - It calls `addTabToRoot(spec, tab => dock(app, tab.key))`, then applies
       the reuse rule from decision 5.
   - Column chrome (copy the sibling, don't invent):
     - A left-edge resize handle taken from `files/SubwindowFilesSidebar.tsx`.
     - A header with the agent's label and the rights badge. Extract the badge
       from `RootOverlay.tsx` (`.root-overlay-rights status` + `root_mcp_status`)
       into a small shared `RootRightsBadge` so both render the same thing. That
       way the user can see when tools are off or mail is not granted.
     - ↗ "Open in root console" (`hide(app)` + `useRootOverlayStore.show(key)`)
       and × to hide.
   - Body: `TabScopeContext.Provider value={ROOT_SCOPE}` around
     `<TabPane tab scope={ROOT_SCOPE} visible focused={…} attachOnly
     filesProjectDir terminalCwd>`, with the same props `RootOverlay` passes.
     - `focused` is true on docking and after a pointerdown inside the column,
       and false after a pointerdown in the app pane.
     - The body shows the placeholder while `useRootOverlayStore.open`.

5. **Wire the three overlays**
   - Files: `src/components/calendar/CalendarOverlay.tsx`,
     `src/components/todo/TodoOverlay.tsx`, `src/components/mail/MailOverlay.tsx`.
   - The `.subwindow-body` becomes a row: the existing pane, then the column
     (when `open && key`).
   - A title-bar button sits before `OverlayApprovals`. It is an agent glyph
     titled "Agent (Ctrl+1)" and does the same as Ctrl+1, or toggles the
     column when a tab is already docked.
   - The Escape guard from decision 7 goes in each overlay.
   - Mail stays mounted while hidden (composer survival), so the column renders
     only while `open`.
   - CSS goes next to the overlay chrome rules: a column with a fixed width,
     the resize edge, and the placeholder.

6. **Stand-down** — `src/components/layout/CenterPanel.tsx` (~L1182): add
   `!overlayAgentShown.has(tab.key)` to `visible`.

7. **Arrival animation**
   - New session store `src/stores/calendar/arrivals.ts`: id → expiry,
     auto-cleared after ~1.8 s.
   - `RootOverlayHost`'s `root-mcp-changed` listener (`RootOverlay.tsx`
     ~L189) marks `upsert` rows whose id was not in the store before the merge.
     Only new ids are marked: an update to an existing row, or a `local: true`
     rank-only move, plays no animation.
   - Add the `arrived` class to event chips in `TimeGrid.tsx`, `MonthView.tsx`,
     `AgendaView.tsx`, `TasksView.tsx`, and to the board's `TodoCard.tsx`.
   - The keyframe animates opacity plus `translateY`/`scale` only.

8. **Strings, tags, docs**
   - i18n keys in `src/lib/i18n.ts` (English holds all; add de/es/fr/it).
   - `UntestedTag` id `overlayAgent.dock`, with a row in `src/lib/untested.ts`.
   - `docs/help/mail-calendar.md` and `docs/help/keyboard.md`: Ctrl+1–9 inside
     an overlay.
   - A short section in `docs/context/root_console.md`: "Docked in the app
     overlays", covering the one-view-per-PTY rule and the Escape rule.
   - One row each in `docs/filemap_frontend.md` for the new store and column.

## Verification

- **Unit / component** (vitest):
  - Routing: with an overlay open, Ctrl+1 dispatches `OVERLAY_AGENT_EVENT` and
    not the new-tab event. With no overlay open, behaviour is unchanged. Extend
    `src/__tests__/tabs/NewTabChord.test.ts`.
  - The front overlay is chosen correctly: by focus, then by mount order.
  - Each overlay:
    - Docking renders the column with an attach-only pane of a new root tab.
    - Escape inside the column leaves the overlay open; Escape elsewhere still
      closes it.
    - When root is not hydrated yet, hydration runs before the add.
    - Tests to extend: `todo/TodoOverlay.test.tsx`, `mail/MailOverlay.test.tsx`,
      a calendar overlay test.
  - The reuse rule: the column is re-opened for the same agent, and a new tab is
    minted otherwise.
  - Ctrl+1 with no root-allowed default agent shows the hint.
  - Stand-down: `CenterPanel` hides a docked key. The column shows the
    placeholder while the root console is open.
  - Arrivals: a new id is marked, an existing id is not, and the mark expires.
- **Gates**: `npm run build`, `npm test`, `npm run lint`,
  `scripts/brand-check.sh`, `git diff --check`. No Rust changes are planned.
  Run `cargo test` and `cargo clippy` only if Rust ends up touched, and say so
  in the report either way.
- **Live** (the user clicks through it; never launched by an agent):
  1. Open 🗓 and press Ctrl+1. A Claude column appears on the right with the
     tools badge on.
  2. Ask "add a meeting Friday 14:00–15:00". With the review level at
     `destructive` or `off`, the event animates into the week view. At `all`,
     ✓ Approvals counts 1, and approving it animates the event in.
  3. Type Escape in the agent: the overlay stays open.
  4. Press Ctrl+Shift+R: the column shows the placeholder and the tab is in the
     console. Close the console and the column is back.
  5. Repeat in ☑ ("add a card to project X") and ✉ ("draft a reply to the last
     mail", which needs mail granted).

## As built

Where the build departed from the plan above:

- **Chords per front overlay.** `useKeyboard` asks `frontAppOverlay`
  (`lib/shortcuts/appOverlays.ts`: the focused overlay, else the topmost by
  mount order) and sends `OVERLAY_AGENT_EVENT` to that one only; an unanswered
  number passes on, never into the hidden workspace tab.
- **`useAddTabMenuData(scope, { active })`.** The agent probes run only while
  the overlay shows (the mail overlay stays mounted when hidden); a chord that
  beats the first probe is held and run when it lands.
- **Reuse keyed on the `+` menu row**, not the command (a custom agent may run
  a built-in's binary), plus an exit watcher on the terminal bus per docked key
  so an exited agent's `[process exited]` tab is never re-shown; a
  `terminal-ready` revives it.
- **Column width cap** `maxWidth = max(320, body − 360)`, measured per overlay
  and never stored; the stored width stays the user's.
- **Popout placeholder.** A docked tab inside a popped-out root subwindow shows
  "Shown in a popout window", and ↗ is dropped for it.
- **Arrivals** mark nothing before the calendar store has loaded, and a delete
  followed by an upsert of the same id (a move to another calendar) is an
  update, not an arrival.
- **Mail drafts don't animate**: a draft lands unfiled in the approvals list and
  reaches "Drafted by agents" only through the user's ✓.
- **Shortcut labels unchanged**: the Ctrl+1–9 rows still say "in the focused
  pane"; the overlay routing is documented in the help (`keyboard`,
  `mail-calendar`) instead.
