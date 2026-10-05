## Group R — Right Panel: Polish & App-Window Tracking
*Files: `src/components/layout/RightPanel.tsx`, `src/styles/themes.css`,
`src/stores/windows.ts`, backend `commands/apps.rs` + window tracking in
`services/window_service.rs`/`platform/x11.rs`. The pin toggle itself is done
(Group D.13 / #37); these are follow-on polish + a tracking-display bug.*

63. **Pin needle black in dark fancy mode.** The right-panel pin (📌) needle isn't
    legible in the dark "fancy" theme — make it black (or otherwise contrast-fix)
    in that mode.
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

64. **[Bug] Right-panel Apps list must drop closed app windows.** A project-opened
    external app appears in the right-panel "Apps" list but doesn't disappear when
    the app/window is closed. Fix the add/remove lifecycle so the list reflects
    live windows. Doubles as a window-tracking test surface: on hover, show the
    entry's window id, monitor id, and z-order.
    Implemented 2026-08-30, **never live-tested**: every launch keeps its `Child`
    and a wait-thread reconciles the registry on exit (hand-offs to an existing
    instance keep a pid-0 delist-only row when their window survives), emitting
    `app-windows-changed` → scoped store refresh; `get_opened_windows` prunes
    dead-pid rows as a backstop; × now **closes** the app via
    `close_tracked_window` (subtree SIGTERM→KILL, untrack fallback for pid-0
    rows); the list is per-scope (merge-refresh store + per-render filter, root/
    box scopes included) and the Apps-view origin set grew `restored`/
    `downloads`/`blob_file_viewer`, kept in step with parking. The hover
    window-id/monitor/z-order debug surface is NOT built.
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

65. **Nested-repo git view: remote support.** The right panel's git section now
    auto-detects a nested git repo under the browsed folder (`git_repo_root`) and
    re-roots status/commit/push/history at it, with a toggle back to the project
    repo — but **local projects only**. Extend to remote (SSH) projects: run
    `git rev-parse --show-toplevel` over SSH in `remote_path/rel`, and give
    `remote_target_for_dir` a way to map a nested host toplevel back to the
    project's `RemoteSpec` (currently a directory reverse-lookup that won't match
    a deeper subpath). Related out-of-scope note: per-file tree git markers stay
    project-scoped, not re-rooted per nested repo.
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

66. **Share the remaining per-surface probes across file-viewer instances.** The
    same `ProjectFilesView` is mounted many times over at once (right panel, each
    Files (Project) tab, each subwindow's docked file column, main window + every
    popout). The persistent-session list was pulled out into one shared, refcounted
    reading (`src/stores/remote/hostSessions.ts`); the same duplication remains for the
    HPC probes, which are per-project facts held per surface:
    `slurmAvailable(projectDir)` (one SSH round trip per mounted viewer),
    `slurmQueue` (a 7s poll per viewer showing the Jobs view — so a cancel in one
    surface lingers in the others), and `wsAvailable` + `wsList` (two round trips
    per mounted viewer for any project recording a workspace, since the expiry
    banner reads them in *every* view). Move them behind the same
    retain/release + shared-list pattern. Deliberately NOT in scope: the git
    section — `effectiveGitRoot` follows each surface's own browsed folder (nested
    repo detection), so those probes are genuinely per-surface.
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

67. **Alerts group in the file viewer.** A collapsible "Alerts" group
    below the file tree in `ProjectFilesView` (so it lands in the right panel and
    every Files (Project) tab alike), merging the three things that can need the
    user *now* into one time-ordered strip: priority-marked mail, calendar entries
    about to start, and to-do cards at or past their due date. **On by default**
    (`files_alerts`, which *is* the group's visibility — the toolbar 🔔 writes it,
    so a close persists rather than returning at the next remount, and the button
    renders either way so the × is never a one-way door), with a lookahead window
    (`files_alerts_days`) and per-source
    opt-outs (`files_alerts_sources`); the mail source stays additionally gated by
    the `mail_client` experimental flag. Reads only the stores that already own
    these rows — `calendar.json`'s events/tasks and the local mail priority index
    — so there is no fourth store and no cached copy of a deadline to go stale.
    Pure selectors in `src/lib/alerts.ts` (clock passed in, so the boundary cases
    are testable), the reads in `useAlertsFeed`, the chrome in `AlertsSection`.
    Implemented 2026-07-29, **never live-tested**.
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

68. **Merge the two project searches into the tree's search box.** The toolbar
    "Search" view (`SearchPanel`) duplicated the in-tree search
    (`FileTreeSearch`) with strictly less capability — content-only, no scope,
    no reveal, every hit opened as raw text, and on a remote project it silently
    searched the local mirror. Deleted the view (main toolbar + box member-root
    mini toolbar), extracted the shared pure pieces into
    `src/lib/projects/projectSearch.ts` (`SearchMatch`, `matchParts`, `rankNameMatches`),
    and a remote-source tree now shows a "switch the source to Local to search"
    hint in the box's place instead of nothing. Implemented 2026-08-31.
    Follow-ups, deliberately out of scope: `QuickOpen` (Ctrl+P) is a third
    name-search implementation (true fuzzy, `lib/fuzzy.ts`) that could share
    `list_project_paths` plumbing; a host-side `project_search` over SSH would
    let the Remote source search for real.
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

69. **Fold the tree's search away, and move 🔍 / ↻ into the Files/Git/Apps row.**
    The search box + its mode pills cost two permanent rows of every surface that
    renders `FileTree` — worst in the side panel, where they are rows of files
    not shown. Search now starts CLOSED and its chrome lives in the view
    toolbar: `ProjectFilesView` owns the fold (`searchOpen`) and a re-list
    counter (`refreshNonce`), `ProjectFilesPane` forwards both to every tree
    below it (a box's N roots fold as one), and `FileTree` draws neither button
    when a host passes them — so closed, it spends no row at all. The refresh
    button moved up with it: it shared the search row, and leaving it behind
    would have kept that row alive for one button. Closing clears the query (an
    effect on the fold, since the toolbar closes it without calling into the
    tree); Escape clears, then folds. A bare `<FileTree>` with neither prop keeps
    its own inline toggle. Implemented 2026-08-31.
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

244. **[Bug] The panel asked its questions in two different chromes.** "New File"
    in the side panel opened `window.prompt()` — which WebKitGTK draws as an
    origin-titled browser alert ("localhost:1420 says" in a dev window, a blank
    system box in a packaged one) — while the rename gesture right next to it
    opened Tabtivity's own dialog. Auditing the rest of the panel found the same
    split everywhere: New Folder, New Presentation, the sessions kill/rename,
    the SLURM cancel/watch, the HPC workspace extend and project move, the log
    copy, every destructive git confirm (lockstep resolve, pairing overwrite,
    backup restore, worktree remove/force-remove/lock) and the remarks
    edit/delete.
    `RenameDialog`'s chrome is generalized into
    `src/components/common/PromptDialogs.tsx` — `TextPromptDialog`,
    `ConfirmDialog`, `MessageDialog` on the `.file-delete-dialog` surface, plus a
    `useDialogs()` hook that returns `await`-able versions so a handler that had
    a `window.confirm` in the middle of it keeps its straight-line shape.
    `RenameDialog` is now a thin wrapper over `TextPromptDialog`, so the two can
    no longer drift. Two behaviours come with it: a create that fails keeps the
    dialog open with the typed name and the reason (the native prompt threw both
    away), and the validators that were alerts — a tmux-safe session name, a
    workspace day count — land under the field instead of in a second box.
    A `reset --hard` warning that *lists paths* is also finally readable, since
    the strings' newlines survive (`.file-delete-body`).
    Frontend: `components/common/PromptDialogs.tsx` (new),
    `components/files/{RenameDialog,FileTree,FileBrowser,ProjectFilesView,GitHistory,RemarksPane}.tsx`,
    `styles/file-tree.css`, `lib/i18n.ts` + the four dictionaries.
    Implemented 2026-09-01.
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test — in the side panel, right-click the tree background →
      **New File**: a Tabtivity dialog opens (accent top rail, "Creating in
      &lt;folder&gt;"), Enter creates, and a name that already exists keeps the
      dialog open with the error under the field. Same for New Folder and New
      Presentation, and in the middle file browser. Then check one confirm
      (Git → a worktree Remove, or Sessions → kill) and one report (Jobs → Copy
      logs): no browser-titled box appears anywhere.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

252. **The side panel forgot which view it was on.** The Files / Git / Apps /
    Agents switcher lived in `ProjectFilesView`'s own state, and the panel
    remounts on both of the things that end a sitting: a project switch (the
    panel is keyed by project id) and a relaunch. So a user working out of Git
    or Agents re-picked it after every switch. The selection now round-trips
    through `settings.side_panel_view` — the panel reads it and writes it back
    on each switch, riding the settings `extra` catch-all like
    `side_panel_edge`, so no backend field was needed. The viewer keeps its own
    copy for the paint (a click shows immediately rather than after the write
    comes back) and folds in the host's value whenever it *changes*, which also
    covers a settings load landing after the panel mounted. A stored view whose
    button this project has no reason to show — Orange/Sessions off a remote
    project, Jobs off a SLURM host, Remarks with the flag off — renders as Files
    without overwriting what is stored, so it returns on a project that has it;
    that also keeps the async SLURM probe from being raced into a room with no
    door out. The Files (Project) tab and the docked subwindow sidebar pass
    neither prop and still open on Files: each is opened for a folder, not
    resumed.
    Frontend: `types/index.ts` (`FilesPanelView`, `Settings.side_panel_view`),
    `components/files/ProjectFilesView.tsx`, `components/layout/SidePanel.tsx`.
    Implemented 2026-09-02, **not live-tested**.
    - [x] 🤖 Automated test — `SidePanelViewMemory`
    - [ ] 🖐️ Manual test — open the side panel, switch to **Git** (or Agents),
      switch to another project and back: the panel is still on that view.
      Quit and relaunch: still there. Then, on a **local** project, confirm the
      panel does not open into a Sessions/Jobs view it has no button for.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

267. **The closed panel's edge tab is a rail: Files / Git / Apps / Agents.** The
    edge affordance said only "Files", so reaching Git, Apps or Agents from a
    closed panel was a click to open plus a second click inside — and with #252
    remembering the last view per scope, the panel often opened on the *other*
    one first. The single tab is now a stacked rail of four, one per view the
    panel's own switcher leads with, labelled from the same i18n keys so the two
    can never read differently. A click writes the view (the shared
    `sidePanelViewPatch`, the same patch the in-panel switcher writes) and then
    reveals the panel, so it slides in already on that view. The rail swallows
    `mousemove`: it sits *on* the 8px hover-reveal band, which would otherwise
    open the panel — and unmount the rail — before any button could be clicked.
    Hovering the edge above or below the rail still reveals the panel on its
    remembered view, and the click path stays the Windows/WebView2-safe one.
    Frontend: `lib/projects/sidePanelView.ts` (new), `components/layout/AppShell.tsx`,
    `components/layout/SidePanel.tsx`, `styles/onboarding.css`, `lib/i18n.ts`
    + the four dicts (`appShell.showPanelView` replaces `showFilesPanel` and
    `filesEdgeLabel`).
    Implemented 2026-09-08, **not live-tested**.
    - [x] 🤖 Automated test — `SidePanelEdgeRail`
    - [ ] 🖐️ Manual test — unpin the side panel so it closes. Four tabs stand at
      the edge: click **Git** → the panel opens on Git; close it, click
      **Agents** → it opens on Agents. Move the panel to the other edge (⇄) and
      repeat: the rail mirrors and still works. Hover the edge *above* the rail:
      the panel still reveals, on whichever view it was last left on.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

268. **The edge rail is a bar with a gutter of its own, not a floating cluster.**
    #267's four tabs were `position: fixed` and vertically centred *over* the
    workspace, so they cut into whichever terminal, viewer or subwindow happened
    to sit at that edge — a strip of window content permanently under them, and
    nothing below could be clicked. The rail is now a full-height bar filling a
    `--side-rail-w` (26px) gutter that `.app-body` holds open on the panel's edge
    (`rail-docked` / `rail-docked-left`), so no content is laid out beneath it.
    The gutter is reserved for as long as an *unpinned* panel exists, not only
    while the rail is mounted: releasing it when the panel slides open would
    reflow — and re-fit — every terminal underneath by the rail's width on each
    hover-open and again on each close. A pinned panel replaces it with its own,
    wider inset as before. The tabs run edge to edge across it — no side padding,
    no side borders, no corner radius — so the whole width of the bar is the
    button rather than a tab floating in a trough.

    **The hover-open moved onto the bar with them, and that is what made the tabs
    reliable.** It used to be a body-level `mousemove` band 8px wide at the window
    edge, fired instantly — and a full-height bar sits *on* that band, so every
    approach to a tab crossed it: the panel opened, the rail unmounted, and the
    button vanished from under a click that had not landed yet. The band is gone
    (`handleBodyMouseMove`, `REVEAL_EDGE_PX`). The bar owns the gesture now:
    resting on its empty run for `RAIL_DWELL_MS` (400ms) reveals the panel on its
    remembered view, and moving onto a tab cancels the pending dwell. A tab also
    commits on `pointerdown` rather than on click — a click only counts if press
    and release land on the same live element, and this button is one render away
    from unmounting itself — with `onClick` kept for keyboard and assistive
    activation and a timestamp so a pointer press never does the work twice.

    The bar no longer has to top the window to stay visible (nothing is
    laid out into its gutter), so `--z-edge-handle: 10001` is gone — z 16 clears
    the pane chrome that can bleed across, and menus, dialogs and tooltips paint
    over a strip that is now full height instead of being buried by it.
    Frontend: `components/layout/AppShell.tsx`, `styles/onboarding.css`,
    `styles/themes.css` (`--side-rail-w` replaces `--z-edge-handle`).
    Implemented 2026-09-09, **not live-tested**.
    - [x] 🤖 Automated test — `SidePanelEdgeRail`
    - [ ] 🖐️ Manual test — unpin the side panel so it closes. The four tabs stand
      in a bar of their own against the edge, filling its full width, and the
      terminal/viewer next to it ends *before* the bar — nothing is covered.
      **Click each of Files / Git / Apps / Agents ten times over, approaching
      from above, from below and straight in: every press opens the panel on that
      view — none is swallowed.** Then rest the pointer on the bar *away* from
      the tabs: the panel reveals itself after a moment. Open a terminal, hover
      to reveal the panel and move away to close it: the terminal does not resize
      or reflow either way. Move the panel to the other edge (⇄): the bar and the
      gutter mirror. Open a header menu that reaches that edge: it paints over
      the bar, not under it.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

269. **The edge rail is icons: chevron, Files / Git / Apps / Agents, side switch
    — and the chevron works.** The chevron was a bare `<span>` with
    `pointer-events: none` inside the tab group, and the group cancels the
    hover-dwell — so the one glyph that says "this edge opens" did nothing when
    clicked. It is now a rail button that opens the panel on its remembered
    view, storing no view. #267's four vertical text labels are icons now
    (folder, branch, window grid, chat bubble). Below them a side switch (panel
    outline with a two-way arrow) moves the panel — and the rail with it — to
    the other edge without opening anything, reusing the panel's own
    `toggleSide`. Every button commits on `pointerdown` per #268, and the glyphs
    share the `SaveIcon` / `PrinterIcon` outline style
    (`common/EdgeRailIcons.tsx`).
    Frontend: `components/layout/AppShell.tsx`, `components/common/EdgeRailIcons.tsx`,
    `styles/onboarding.css`, `lib/i18n.ts` (`appShell.showPanel`).
    Implemented 2026-09-10, **not live-tested**.
    - [x] 🤖 Automated test — `SidePanelEdgeRail`
    - [ ] 🖐️ Manual test — unpin the side panel so it closes. The bar shows six
      icons: a chevron, Files / Git / Apps / Agents, and a side switch set
      slightly apart. Click the chevron → the panel opens on whichever view it
      was last on. Close it, click each of the four → it opens on that view
      (hover a tab for its name). Close it, click the side
      switch → the panel does **not** open; the bar jumps to the other edge and
      the chevron now points the other way. Click the switch again → back.
      Hover the bar's empty run: the panel still reveals after a moment.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

270. **Resting on a rail icon opens the panel on that view; the side switch sits
    at the top of the bar.** #268 made pointing at a tab *cancel* the hover
    dwell, because the dwell opened the panel on its remembered view and that
    reveal unmounted the tab from under a click. The tabs were click-only as a
    result (user, 2026-09-14: "make the icons also hover not only click"). The
    dwell now keys on what the pointer rests on (`data-rail-view` /
    `data-rail-action`): a tab opens the panel on **its** view after the same
    400ms, so press and dwell can only ever agree; crossing one tab on the way
    to another restarts the dwell for the new one; the chevron and the bar's
    empty run keep opening on the remembered view; the switch only cancels —
    hovering must never move the panel. The switch itself left the centred
    group for the top of the bar (`position: absolute; top: 0` inside the
    positioned rail), where a layout control reads as chrome rather than as a
    fifth destination.
    Frontend: `components/layout/AppShell.tsx`, `styles/onboarding.css`.
    Implemented 2026-09-14, **not live-tested**.
    - [x] 🤖 Automated test — `SidePanelEdgeRail`
    - [ ] 🖐️ Manual test — unpin the side panel so it closes. The side switch
      is the topmost icon on the bar; the chevron and Files / Git / Apps /
      Agents stay centred. Rest the pointer on **Git** without clicking → after
      a moment the panel opens on Git. Close it; rest on **Agents** → Agents.
      Sweep the pointer down across Files → Git → Apps and stop on **Apps** →
      only Apps opens, and only once the pointer has settled there. Rest on the
      side switch for a few seconds → nothing opens and the bar stays on its
      edge; click it → the bar jumps to the other edge, still with the switch
      on top. Clicking any tab still opens it at once.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

271. **The rail's hover-open is quick, lands on the right view, and can close
    again; a side switch is a jump; the panel's scrollbar thumb sits where the
    panel ended up.** Four faults behind "show side panel is very slow and
    buggy" (user, 2026-09-14). (1) `updateSettings` set state only after the
    backend's write answered, so a rail tab opening the panel on Agents opened
    it on the *old* view first — the file tree mounted, listed and probed, then
    was thrown away a write later — and the side switch answered its press a
    write later too. The patch is now in state before it is on disk; the
    backend's merged answer replaces it, a failed write rolls back. (2) The
    app-drawn scrollbar (`lib/theme/customScrollbar.ts`) re-measured on resize,
    mutation and scroll but never when a *transition* moved a container: a view
    mounted mid-slide had its thumb measured wherever the panel was that frame
    and left there — "the scrollbar in the agents view is in the middle of the
    side panel". `transitionend`/`transitioncancel`/`animationend` now queue a
    geometry pass. (3) The closed panel's resting transform flips from +100%
    to −100% on a side switch, and eased, that flip slid the panel and its
    contents across the whole window ("side switching shows underlying view").
    `SidePanel` wears `.switching` (transition: none) for the one frame that
    moves it. (4) A hover-open gave the panel no mouseenter — the pointer rests
    on the rail, the rail unmounts, the panel arrives under a pointer that is
    not moving — so a pointer that wandered off during the slide never left it
    either, and the panel stood open. A hover-armed guard watches the document
    until the pointer's first move over the panel; a move elsewhere that is
    still elsewhere 450ms later closes it. Clicks and the lessons event are not
    guarded. Also: `CenterPanel` is memoised — it takes no props, and the shell
    re-rendered the whole workspace under it on every hover-open and close.
    Frontend: `stores/settings.ts`, `lib/theme/customScrollbar.ts`,
    `components/layout/{AppShell,SidePanel,CenterPanel}.tsx`,
    `styles/files-panel.css`. Implemented 2026-09-14, **not live-tested**.
    - [x] 🤖 Automated test — `SettingsPatchOptimistic`, `SidePanelEdgeRail`,
      `SidePanelReveal` (side switch), `CustomScrollbar` (install)
    - [ ] 🖐️ Manual test — unpin the side panel so it closes. Rest on the
      **Agents** icon → the panel opens straight onto Agents (no flash of the
      file tree first) and, once it has slid in, a long Agents list shows its
      thumb along the panel's right edge, not down its middle. Rest on an icon
      and, while the panel is still sliding in, move the pointer away into the
      terminal → the panel closes on its own within about half a second and the
      rail is back. Rest again and stay put → it stays open; move into it and
      out → it closes as before. Click the side switch on the rail → the bar
      jumps to the other edge at once, and nothing slides across the window.
      Open the panel with a click, move the pointer away without entering it →
      it stays open (as before).
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

272. **The side switch says where the panel goes; the panel's list gets its
    bar whatever its first paint held.** (1) "The side rail switch side button
    is hardly detectable as switch sides" (user, 2026-09-14): the rail's switch
    was a frame with a two-headed arrow inside at 0.55 on top of the handle's
    own 0.8, and the open panel's header had a bare `⇄` — both read as
    swap/sync. One shared `RailSwitchSideIcon` now draws a window frame with
    the panel filled in on the edge it sits on and an arrow at the edge it will
    jump to, mirrored for a left-docked panel; the rail's switch takes the
    tabs' own resting tone, the header's lights accent on hover. (2) "Scroll
    bar on unhide sometimes shows, sometimes keeps hidden, sometimes not at the
    wished position" (user, 2026-09-14): two discovery gaps in
    `lib/theme/customScrollbar.ts`. A container got a thumb per axis that overflowed
    *when it was found* and was then skipped by every later scan, so a file
    tree first painted with few rows and long names had a horizontal bar and
    never a vertical one; the missing axis's thumb is now made the moment that
    axis overflows. And a container was found only when nodes were added under
    it or when it was first scrolled, so one that grew scrollable through a
    class flip, a width change or a window resize had no bar until the wheel
    touched it; the end of a box-moving transition rescans the element that
    moved, and a window resize or visibility change rescans the document.
    Frontend: `components/common/EdgeRailIcons.tsx`,
    `components/layout/{AppShell,SidePanel}.tsx`, `lib/theme/customScrollbar.ts`,
    `styles/{onboarding,files-panel}.css`. Implemented 2026-09-14, **not
    live-tested**.
    - [x] 🤖 Automated test — `SidePanelFlip`, `CustomScrollbar` (discovering
      late overflow)
    - [ ] 🖐️ Manual test — unpin the side panel. The topmost rail icon shows a
      window with a filled strip on the panel's edge and an arrow pointing the
      other way; it is as visible as the tabs below it. Click it → the bar jumps
      to the other edge and the icon mirrors. Open the panel: the header's
      leftmost button shows the same picture. Then, on a project with a deep
      tree: hide the panels (F9) and show them again, and hover-open the panel
      from the rail several times → every time the file list overflows, its
      thumb is along the panel's edge, at the list's scroll position, not
      missing and not standing mid-panel. Expand folders until the list
      overflows downward when it did not before → a vertical thumb appears
      without scrolling first. Shrink the window until a list that fitted no
      longer does → same.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
