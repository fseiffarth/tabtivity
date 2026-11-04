## Group A — Bottom Panel: Meta-Project Grouping (new feature)
*Files: data model (`schema/project.rs`/`projects.rs`, `types/index.ts`), `ProjectSwitcher.tsx`, `ProjectPill.tsx`. No grouping concept exists today.*

13. **Project boxes / meta-project management.** Right-click to create a named,
    renamable box (e.g. PaperBox, CodingBox) that groups projects, with
    drag-and-drop of pills into boxes. Requires a new grouping field in the
    project/entry schema plus drag-drop UI and grouped rendering. Largest bottom-
    panel item.
    > **Phase 1 (#13) DONE (🤖 covered).** Box model (`schema/boxes.rs`
    > `ProjectBox`/`BoxRelation`, `boxes.json`) + box CRUD commands
    > (`commands/boxes.rs`: get/save/create/rename/delete/set_box_members) +
    > native-DnD pill-into-box + ungrouped-drop-zone + grouped pill rendering with
    > a distinct `.project-box-chip` (badge + member count) +
    > `stores/boxes.ts`/`BoxChip.tsx`. `box_id` rides in `ProjectEntry.extra`;
    > member_ids authoritative, `box_id` derived in-memory on load (no write).

41. **Project box containers (merge of two or more projects).** Building on #13,
    let a box be opened as a single *merged* workspace that spans its member
    projects rather than just a pill grouping. Specifics:
    - **Merged file view in the right panel.** Extend the right-panel file tree
      (`FileTree.tsx`/`RightPanel.tsx`) to render a box as a multi-root view —
      each member project listed as a top-level node, populated from that
      project's **stored state** (its `project.json` tree layout / file metadata)
      rather than re-walking only one root. Reuse the existing per-project file
      model so each member keeps its own git markers, hidden-file sections, etc.
    - **A box folder in the tabtivity root.** Create a `~/tabtivity/boxes/<box-name>/`
      (or similar under the tabtivity root) directory per box to host box-scoped
      state and serve as the cwd for the box's terminals/agents.
    - **Agent tabs rooted in the box, hinted to each member.** Start the box's
      agent tabs rooted in the box folder, seeding each agent with hints/pointers
      to every member project's local agent files (`CLAUDE.md`/`AGENTS.md`/
      `GEMINI.md` and paths) so the agent can work across all merged projects
      from one place.
    - **Boxes in the project search (merge is opt-in).** Surface boxes as results
      in the "Search inactive…" box (`ProjectSwitcher.tsx`,
      `activateSearchResult`/`results`) alongside individual projects; picking a
      box result opens the merged box workspace. The merge is **opt-in** — a box's
      member projects stay independently searchable and can each be loaded on
      their own as a normal single project, without activating the box merge.
    - **Visual distinction box vs. single project.** Give boxes a distinct look
      from single projects everywhere they appear — in the search results
      (`project-search-row`), the pills (`ProjectPill.tsx`/`project-switcher`),
      and the right-panel multi-root header — e.g. a box icon/badge, member count,
      and/or a grouped style, so a merged box is never mistaken for a plain
      project. Add the corresponding styles in `themes.css`.
    - **Inter-project relations within a box.** Let a box record directed
      relations between its members — "a change in project A may influence
      project B" — e.g. project B depends on a Python library developed in project
      A, so editing A's library can break/affect B. Model as relation edges in the
      box metadata (source → dependents, with an optional kind/label like
      "python-lib" and an optional path/package hint). Surface them so the
      dependency is visible and actionable: show related members in the box view,
      flag dependents when a source changes (tie into the existing git-status
      markers so a dirty source highlights its dependents), and seed the box's
      agent hints with the relation graph so a cross-project agent knows which
      members a change ripples into. Auto-detection of relations (e.g. scanning
      `pyproject.toml`/`requirements.txt`/imports for local-path deps between
      members) is a stretch goal; manual declaration is the baseline.
    - Schema/model: extends the #13 grouping field with box-as-workspace metadata
      (member list, box folder path, relation edges); touches
      `schema/project.rs`/`projects.rs`, `types/index.ts`, `ProjectSwitcher.tsx`,
      `RightPanel.tsx`/`FileTree.tsx`, and the runtime/spawn path that sets
      agent-tab cwd + env. Scope to be refined when picked.
    > **Phase 2 (#41 groundwork) DONE (🤖 covered):** full box schema stored
    > (`folder`, `relations`; the uncalled `set_box_relations` setter was
    > removed 2026-10-15), lazy
    > `~/tabtivity/boxes/<name>/` creation (`ensure_box_folder`, idempotent +
    > name-collision-safe against reserved `folder`s and on-disk dirs), boxes in
    > the project search (`.project-search-row.is-box`, opt-in — members stay
    > searchable), and opt-in box activation (`openBox` → `box:<id>` scope rooted
    > in the box folder). **Box scopes are session-only this pass** —
    > `switch_project_runtime` does not persist/restore them.
    > **Phase 3 — DONE** (recorded 2026-07-28; the entry said "deferred" long
    > after it shipped): merged multi-root file tree lives in
    > `ProjectFilesPane.tsx:159-230` (`BoxRoot` / `useBoxRoots` /
    > `BoxRootSection`), consumed at `ProjectFilesView.tsx:845` and
    > `RightPanel.tsx:100-102`.
    > **Phase 4 — agent-hint seeding DONE:** `commands/boxes.rs:118-184`
    > (`box_links_block` / `write_box_agent_docs`), `:349`
    > `refresh_box_agent_docs`, registered `lib.rs:711`, called from
    > `src/stores/boxes.ts:165` — the managed CLAUDE/GEMINI/AGENTS link block is
    > regenerated on member change.
    > **Phase 5 — boxes upgrade DONE (2026-08-26, 🤖 covered, untested live):**
    > the "session-only" note above is superseded — `box:<id>` is a first-class
    > persisted scope now (`sessions/box_<id>/terminals.json`, lazy restore +
    > shell seed via `restoreBoxScope`; the spawn gate and `compute_allowed_roots`
    > accept box folder ∪ member roots ∪ remote mirrors, fail-closed on unknown
    > boxes; box tabs pinned `sandbox: false` — v1 trust statement). Membership
    > went **N:M** (per-project `box_id` retired; `addToBox`/`removeFromBox`/
    > `boxProjects`; NO silent one-member dissolve — the box editor's confirmed
    > Dissolve is the only way out). Switcher moved to the **overlay model**
    > (member pills always render, ▣ badge; boxes placed by their own
    > `position`; empty boxes render dimmed). All four box/unbox gestures:
    > pill-menu Boxes group, Ctrl-click multi-select → "Box these…",
    > `BoxEditorDialog` (rename/members/dissolve/trust notice), Alt-drag kept
    > additive. Box folder gains a **member symlink farm** (Unix,
    > `.tabtivity-box-links.json` ownership manifest, never clobbers user paths;
    > Tabtivity confinement doesn't follow the links). Box "+" menu offers
    > per-member Files/Shell/Claude rows (member-cwd, resume-safe); PDF merge
    > picker is multi-root in a box scope; disconnected remote members gate
    > behind a connect prompt; local box shells get tmux persistence. See
    > `docs/context/project_boxes.md`.
    > **Still deferred:** relation-graph *surfacing* (`relations` is stored
    > and round-trips, but nothing edits it: the uncalled `set_box_relations`
    > command was removed 2026-10-15 — a surfacing UI adds a patch-style
    > setter, e.g. a `BoxPatch` field), dirty-source→dependent git
    > markers, auto-detection, remote-member mirror fallback in the box file
    > view, box-level sandbox/VM.
    - [x] 🤖 Automated test — `commands/boxes.rs` cargo tests (reconcile drops
      unknown member_ids / recomputes box_id inverse / drop-on-delete, gap-spaced
      position, defaults round-trip, folder-collision suffixing); `paths.rs`
      `boxes_root`; vitest `BoxAssignment` (assign/unassign/move/delete sweep,
      create/rename, derive-on-load no-write), `BoxRendering` (grouped vs inline,
      orphan box_id inline, chip drop ≠ reorder, ungrouped drop), `BoxSearch`
      (is-box row → openBox, members independently searchable). Phase 5 adds:
      cargo `commands::boxes` (box scope ids, allowed-roots table incl. unknown
      box fail-closed, link planner + Unix link-farm suite), `commands::fs`
      (box-scope allowed roots), `services::sandbox` (box never sandboxed);
      vitest `BoxScopePersistence`, rewritten `BoxAssignment`/`BoxRendering`
      (N:M + overlay), `BoxUx` (gestures + editor), `BoxScopeMenus` ("+" menu
      cwds, cross-root paste invoke shape, multi-root merge picker),
      `RightPanelBox` remote gate, `TmuxSessions` box flip.
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
    > **Phase 6 — box file-view fixes + per-member line (2026-08-28, 🤖
    > covered, untested live).** Two live-found bugs fixed: (1) cross-project
    > drag-and-drop in the multi-root view moved files *within the source
    > project* to the other project's rel path ("strangely moved" folders) —
    > every `[data-move-rel]` target now carries its tree's identity
    > (`data-move-root`/`data-move-remote`), `lib/projects/fileMove.ts`'s
    > `resolveMoveTarget` routes the drop (cross-root local↔local only; remote
    > either side refuses the target up front), and `move_path` is called with
    > the TARGET root — this also fixes a right-panel drag into another
    > project's Files tab. (2) A remote member had no Remote/Local switch (the
    > "remote-member mirror fallback" deferred above): `BoxRootSection` now
    > shares the project-wide side (`useFileSource`), lists the mirror on
    > Local (browsable while disconnected), and gates only the SFTP side
    > behind the connect prompt. Plus each member root gained its own
    > **Files/Git/Search + ⧉/⚙ + source-switch line** (member-scoped
    > `GitHistory`/`SearchPanel`, per-member `ProjectFilesSettingsDialog`, and
    > the member's own hidden-endings/paths filters now apply in the box view).
    - [x] 🤖 Automated test — vitest `FileMove` (resolveMoveTarget table,
      dest-rel/abs builders, `remoteMemberTreeDir`, source tripwires: every
      `data-move-rel` stamps identity attrs, move commit routes to
      `target.root`, member tree keyed on `treeDir` + `syncSource`); updated
      `SidePanelBox` (Remote side gated + switch stays up while disconnected,
      Local mirror browsable offline); cargo `commands::fs`
      `move_path_moves_a_folder_between_roots`.
    - [ ] 🖐️ Manual test (drag member→member file + folder both directions;
      drag onto a member's breadcrumb; remote member: flip Local/Remote while
      disconnected; per-member Git/Search/⚙ line)
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
    > **Phase 7 — slice membership controls (2026-08-28, 🤖 covered,
    > untested live).** While a Box slice is selected, the switcher's `+`
    > becomes a filterable list of active non-members and each member pill's
    > `×` removes only that membership. Opening a member keeps the slice in
    > membership mode; an open project removed from the Box stays visible as
    > the existing non-member exception, without a Box badge or `×`. Project
    > creation/import and global deactivation remain unchanged in All projects.
    - [x] 🤖 Automated test — vitest `BoxMembershipControls` (candidate
      eligibility/filter/empty state, repeated in-place adds, member removal,
      open non-member exception, and All-project behavior), plus the existing
      `BoxRendering`/`BoxUx` switcher regressions.
    - [ ] 🖐️ Manual test (select a Box, add several projects without reopening
      `+`, remove both an ordinary and a currently open member, then return to All
      projects and confirm the ordinary create/import/deactivate controls)
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
    > **Phase 8 — agent-fence integration (2026-08-31, implemented; live QA
    > pending):** box-scoped and member-scoped local agents receive the box's
    > read-write root union under the default-on bubblewrap fence, plus native
    > Claude/Codex/Gemini working-root flags. See Group S #204 for the complete
    > boundary and QA matrix. A member's container/VM remains a separate,
    > stronger axis and does not become a box-level container/VM.

    > **Phase 9 — the chip became the scope chip (2026-09-04, 🤖 covered,
    > untested live).** Root and Trash lost their pinned pills at the head of the
    > row and moved into the chip's dropdown, above "All projects" and the boxes:
    > two permanent pills' worth of header for destinations reached by name
    > rather than by pointing, so the leading segment is now a single control
    > that names where you are (Root · Trash · a box · nothing = an ordinary
    > project) and the strip got the width back. Picking Root or Trash lifts the
    > box slice — neither is inside a box, and a strip left filtered by a box
    > nobody is in reads as a strip that dropped projects. The chip's status
    > strip now spans root + Trash + every box, narrowing to one scope only while
    > a box slice is selected (naming root is where you stand, not a filter, and
    > that is exactly when a box waiting on a decision must still be able to say
    > so). The dropdown is hover-opened through the shared header hover-menu id,
    > like the `+` menu beside it, so opening another header menu closes it in
    > the same frame; click still reveals, and a pill drag still springs it open
    > with every box row a drop target. The tour's root-terminal step re-anchors
    > to `.box-chip-main`, and the steering station digit for root/Trash rides
    > the chip and its rows.
    - [x] 🤖 Automated test — vitest `BoxRendering` (chip is the row's whole
      leading segment with no root/Trash pill; dropdown lists Root and Trash
      ahead of the boxes and neither is a drop target; dissolving the last box
      keeps the chip; multi-scope vs. narrowed status strip) and
      `ProjectPillsRender` (Trash has a chip row, not a pill, and stays out of
      the scrolling strip).
    - [ ] 🖐️ Manual test — hover the chip, switch to Root and to Trash from its
      list, confirm the strip un-slices, the accent line follows the scope, the
      bars still open a waiting box tab from inside root, and that dragging a
      pill still springs the list open onto a box row.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
    > **Phase 10 — the selected box gets its own pill (2026-09-04, 🤖 covered,
    > untested live).** The chip was doing two jobs: the menu you open to go
    > somewhere, and the label saying where you are — so returning to the box you
    > were already looking at meant opening a dropdown and clicking the row
    > already marked current, while a project pill one hairline away is a single
    > click. The box the dropdown selects now stands beside the chip as a pill of
    > its own (`.box-scope-pill`, the same `.box-chip` box minus the caret): it
    > names the box, counts its members, carries the box's own (unprefixed)
    > status strip, hosts the rename input and the Open/Rename/Edit box/Delete
    > context menu, holds the `data-box-id` a dragged project drops onto, and
    > enters the box scope on one click. The chip keeps the dropdown untouched —
    > still the only list of boxes, still spring-loaded under a drag, still the
    > thing that slices the strip — and now names only Root or Trash, lighting up
    > only for those; its strip drops the box the pill already reports, so no
    > scope is tallied twice in one segment. Not the per-box pills coming back:
    > only the ONE selected box is ever on the row, in the *fixed* leading
    > segment, so N boxes still cost the scrolling strip nothing.
    - [x] 🤖 Automated test — vitest `BoxRendering` (no pill before a box is
      picked, then one pill naming the box with its member count; the chip stops
      naming it and stops wearing the active accent; clicking the pill re-enters
      the box scope from a member without opening a menu; the pill carries
      `data-box-id` and the box context menu while the chip carries neither; the
      chip's strip keeps the OTHER boxes while the pill carries its own).
    - [ ] 🖐️ Manual test — pick a box in the chip list, click a member pill, then
      click the box pill to land back in the box's tabs; right-click the pill for
      Rename/Edit box/Delete; drag a project pill onto the pill to add a member;
      confirm a box tab waiting on a decision draws its bar on the pill and not
      also on the chip.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
    > **Phase 11 — the slice hands the scope back (2026-09-05, 🤖 covered,
    > untested live).** Entering a box already took the scope with it
    > (`openBox`); leaving by "All projects" did not give it back, so the strip
    > showed every project while the tabs below were still the box's and no pill
    > on the row was lit. The chip's "All projects" row now re-activates the
    > project the *unsliced* strip was last on — remembered only while no slice
    > is selected, since a member opened from inside the slice was current in
    > the box's view, not in this one — via `setActive` with the id it already
    > holds, which is the established way back out of a box scope (CenterPanel
    > re-runs its `setScope` off `switchGeneration`). It fires only from inside a
    > box scope (after a hop to a member, strip and tabs already agree), and
    > falls back to the root terminal when the remembered project has since been
    > closed.
    - [x] 🤖 Automated test — vitest `BoxRendering` ("All projects" re-activates
      the project the strip was on and moves the scope out of the box; a member
      opened from inside the slice triggers no second switch; a closed
      remembered project falls back to root).
    - [ ] 🖐️ Manual test — with project P current, pick a box in the chip: its
      tabs come up and the box pill lights. Pick "All projects": P is current
      again with its tabs and its pill lit. Repeat after clicking a member
      inside the slice, and after closing P while the box is open (lands at the
      root terminal).
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
    > **Phase 12 — every box is a pill, in colour (2026-09-22, 🤖 covered,
    > untested live).** The user found the box feature unfriendly: switching
    > between boxes was a hover, a wait and a click each way (only the
    > *selected* box had a pill; the rest lived in the dropdown), adding a
    > project to a box meant finding a project pill's menu or dragging into a
    > sprung-open list, boxed projects were marked by one grey ▣ that said
    > nothing about *which* box, and the selected box's pill (accent-filled
    > member-count badge, 4px inset) looked squashed and off-style. Now: (1)
    > every box stands beside the chip as a small pill of its own, up to
    > `MAX_BOX_PILLS` (6; the rest stay in the dropdown and the chip shows
    > "+N", always seating the selected box), on the project pill's own inset,
    > with no count badge (count in the tooltip); (2) each box has a stable
    > colour hashed from its id (`lib/theme/boxColor`) worn by its pill's mark
    > and active line, by one square swatch per box on each member's project
    > pill (replacing the grey ▣), and by the dropdown / Boxes-menu rows; (3)
    > every box pill is a drop target, and its context menu carries a
    > *Members* checklist (open projects, members first, capped at 12 before
    > "Edit box…") that toggles on the spot and stays open; the pill's "Delete
    > box" now asks the editor's dissolve question first; (4) `cycleBox` /
    > `cycleBoxBack` chords (Ctrl+Shift+PageDown/PageUp, rebindable) walk the
    > pills' row order and step into the boxes from a project. The dropdown
    > springs open under a drag only while some boxes have no pill.
    - [x] 🤖 Automated test — vitest `BoxRendering` (every box gets a pill in
      row order with its colour inline and no count badge; MAX_BOX_PILLS cap +
      "+N" + selected box seated; member swatches per box; box pill Members
      checklist toggles add/remove and stays open; drop on a box pill adds with
      no list sprung; overflow springs the list and its rows are targets; each
      pill reports its own bars), `BoxCycle` (ring order, entry from outside,
      no-op cases, chords collide with nothing).
    - [ ] 🖐️ Manual test — with three boxes: click each box pill in turn (tabs
      follow, the clicked pill lights in its colour, the strip slices); the
      member pills show a square in the box's colour, several when in several
      boxes, tooltip naming them; drag a project pill onto a non-selected box
      pill (tinted while over, added on drop); right-click a box pill → Members:
      tick two projects without the menu closing, untick one, Esc; Ctrl+Shift+
      PageDown from a project lands in the first box, again → second, PageUp →
      back; create 7 boxes → six pills + "+1" on the chip, pick the seventh in
      the list → it takes the last slot; "Delete box" on a pill asks first.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

---

826. **The project pill: pending git state in the hover card, a menu that
    scrolls.** (1) The folder icon's git colour (uncommitted / staged /
    committed-not-pushed / broken) was explained only by a native `title` on
    the icon — a second popup beside the hover card. `ProjectHoverCard` now
    names the state itself, coloured like the icon, and shows nothing for a
    clean project; the file viewer shares the card and gains the line (`303fc16`).
    (2) The right-click menu opens downward and, with remote, git and Python
    entries all present, ran past the bottom edge; it is capped to the room
    below the anchor and scrolls an inner wrapper so the accent wash still spans
    the menu (`35b249f`). Frontend: `components/projects/{ProjectHoverCard,ProjectPill}.tsx`,
    `styles/{projects-tabs,apps}.css`. Implemented 2026-09-14, **not live-tested**.
    - [x] 🤖 Automated test — `ProjectHoverCardGitState` (git state line)
    - [ ] 🖐️ Manual test — edit a tracked file in a project: hovering its pill
      names "uncommitted" in the icon's colour and the icon has no tooltip of its
      own; commit without pushing → the line changes; a clean project shows no
      line. Right-click a remote project's pill with the window made short: the
      menu stops at the window's bottom edge and scrolls, header wash intact.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

827. **Folders spring open while dragging a file to move it.** The tree lists
    one folder at a time, so a file dragged toward a folder the listing did not
    show had nowhere to land. Hovering a folder row, a breadcrumb or ↑ of the
    same tree for 650 ms now navigates there and the drag carries on,
    re-resolving the drop target once the new rows paint; after an open the
    pointer must move before another folder can arm, so a held-still drag does
    not drill down a level per dwell. Timing core `createSpringLoader` in
    `lib/projects/fileMove.ts`; `components/files/FileTree.tsx`. Frontend only.
    Implemented 2026-09-14 (`de0f931`), **not live-tested**. 2026-09-21: the
    listing itself (`.file-tree`, file rows and empty space) is now a drop
    target for the folder it shows — before, a release inside a freshly
    sprung-open folder hit no target and the file stayed put.
    - [x] 🤖 Automated test — `FileMove` (spring loader: dwell, re-arm only
      after movement, cancel; tripwire: tree root carries `data-move-rel`)
    - [ ] 🖐️ Manual test — drag a file over a folder row and hold still: after
      about ⅔ s the tree opens that folder and exactly one level, not deeper;
      wiggle onto a subfolder → it opens too; drop on a file row or empty space
      of the opened listing (dashed frame) → the file moves there. Hover
      a breadcrumb and ↑ the same way. Pass over folders quickly → nothing opens.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

2427. **Project boxes redesign: one colour, one way out, one way in.** The box UI
    was rebuilt in 2026-11 (`docs/box_redesign_plan.md`): box pills with an
    always-visible ✕ and a fold pill, quick create from every door, one shared
    membership checklist, the member chip on tabs, the "Start in…" fly-out, the
    accordion side panel, the box sheet, boxes in the header search and Ctrl+K,
    the popout title-bar mark and a feature hint. **Nothing is live-tested**; each
    row below is one thing to click through. Frontend, except `create_box`/
    `patch_box` (new optional arguments; until the running window is restarted the
    frontend falls back to the older calls). `docs/box_redesign_handoff.md` lists
    the commits, `UntestedTag` ids and flagged choices.
    - [ ] 🖐️ Manual test — **Enter and leave a box.** Create two boxes
      with two projects each, then click a box pill: the strip narrows
      to that box's projects and takes the box colour, the pill shows an
      always-visible ✕. Click the ✕ (and again with All projects in the
      box list, and with the first row of the header search): you are
      back on the project the strip was on. In the list the box you are
      in has a ✓ and the sliced box is bold; a click on the caret keeps
      the list open until a second click, a pick, Escape or a press
      elsewhere. Dissolve the box you are standing in: the strip leaves
      it first.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
    - [ ] 🖐️ Manual test — **Narrow windows and the empty state.**
      Shrink the window through the three width tiers: the box pills
      drop to 3 and then to the selected box alone, and the fold pill ▣▾
      +N (a bare count when no pill fits) opens the same list. With no
      box at all, a dashed + Box pill stands where the box pills would;
      one click asks for a name and enters the new box.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
    - [ ] 🖐️ Manual test — **Quick create from every door.** New box
      through: the + menu's New Box, the box list's New Box row, the
      ghost pill, Box these (N)… after Ctrl-clicking pills, New box with
      <project>… on a pill, Ctrl+K → New box…. Each asks for a name
      pre-filled "Box 1" (the next free number), Enter creates the box
      and you are inside it. An empty name, a duplicate (any case) and
      an 81-character name are refused with a reason on the prompt.
      Alt-drag one pill onto another: the two are boxed, you enter the
      box and its pill name is in rename.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
    - [ ] 🖐️ Manual test — **Membership checklists.** Box pill menu →
      Members and project pill menu → Boxes show one checklist: it stays
      open across toggles, scrolls without a row cap, gets a filter
      field past 8 rows and lists closed projects labelled "closed" (add
      and remove one without opening it). Inside a box, a member pill's
      menu has Remove <project> from <box>. Dissolve box… asks, leaves
      the box first when you are in it, and the projects stay.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
    - [ ] 🖐️ Manual test — **The box sheet (Edit box…).** Edit box…
      opens one box (the box you are in, else the first): name (checked as
      you type), colour, the member list (closed projects too, badges
      for closed/container/VM/remote and the swatches of the other boxes
      holding the project, a filter field), one trust line per kind of
      member that runs outside its container/VM or needs a connection,
      the folder with Open, the phone-access switch and a Dissolve box…
      footer. Save sends only the difference: add a member from a pill
      menu while the sheet is open, then Save a rename: the new member is
      still there. A refused name stays on the sheet with its reason.
      Switch phone access on, turn persistent local sessions off in
      Settings and reopen the sheet: the switch is still there (access
      can always be switched off) with a line saying it is on but cannot
      work; with the box's access off the line says it needs them.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
    - [ ] 🖐️ Manual test — **Keyboard and swatches.**
      Ctrl+Shift+PageDown/PageUp walk home → box 1 … box N → back to the
      project you came from (and unslice); with one box it alternates
      box and home. While a box is sliced, Ctrl+Shift+Tab and the
      steering digits visit only the visible pills. A click on a project
      pill's coloured box swatch opens that box (a small list when the
      project is in several).
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
    - [ ] 🖐️ Manual test — **Which project is this tab in?** Open an
      agent, a shell and a Files tab from different members inside a
      box: each tab wears a dot in its project's colour after its label
      (a square for the whole box), dot only when the tab bar is under
      about 520 px; viewer and monitor tabs show none. The tab's hover
      card has a member row. Pop a tab out: the popout strip shows the
      same chip. Rename a tab: the chip stays.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
    - [ ] 🖐️ Manual test — **The + menu starts where you are.** Inside a
      box with an agent tab of member A active, press + (and
      Ctrl+Shift+N, Ctrl+Shift+M, Ctrl+1): the new tab starts in A, and
      the menu header names the target. Hover Agents/Shell/Files for
      Start in…: pick member B or the whole box; the tab starts there
      and a worktree choice follows B's repository. Monitor, Disk usage
      and the like keep the box folder. The popout's + menu does the
      same; the empty group starts in the box folder.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
    - [ ] 🖐️ Manual test — **Side panel accordion.** In a box the side
      panel shows one section per member: one open at a time, each
      header with the project's colour dot, a git dot (only when dirty,
      staged, unpushed or broken; none for remote members), and the
      agent count. Folding is remembered per box across a restart. Drag
      a file over a folded section for about ⅔ s: it opens, and dropping
      moves the file there. The ⋯ on a header opens a menu (Files/Git,
      Remote/Local, open folder, project settings, Open as tab: a files
      tab with the git bar at that member's root). The toolbar 🔍 opens
      one search field above the sections that searches the expanded
      member (disabled on a remote member's Remote side). Drag a header's
      grip to reorder the members; add a project from the box pill menu
      in the meantime and reorder again: the new member is still there.
      An empty box shows "No projects yet" with an Add projects… button
      that opens the box sheet (no button in a popout).
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
    - [ ] 🖐️ Manual test — **Search, palette and popout.** Focus the
      header search with nothing typed: the boxes are listed with their
      coloured swatch and member names; inside a box "All projects"
      leads. Type a member's name: its box appears, and project rows
      wear their boxes' swatches. Ctrl+K lists a Boxes group (Enter
      enters the box), New box…, Show all projects (only inside a box),
      and once you type, Add <project> to <box>; a tab row of a box
      scope names its box. A popout showing a box has ▣ and the box name
      in the box colour in its title bar.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
    - [ ] 🖐️ Manual test — **Member agents on the box pill, and the
      hint.** Start an agent in a member project while the box is closed
      on the strip: the box pill's status bar (and its row in the list)
      shows it, and a click on that bar opens the member's tab. With
      four or more projects and no box, the feature hint "Group related
      projects in a box" points at the ghost pill after the usual pause;
      it never shows once a box exists. The lesson "Group projects into
      a box" walks through the seven steps, and Help → Containers, VMs
      and project boxes describes the same flow.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
