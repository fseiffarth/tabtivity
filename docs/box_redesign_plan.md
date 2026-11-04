# Project boxes redesign — merged plan

Status: **plan only, 2026-11-03. Nothing is built.** Merges three design
lenses written the same day; each holds the detail (today's flow with
`file:line` refs, ranked friction, mockups, per-step files):

- `docs/box_redesign_access.md` — finding, entering, leaving, switching (lens **A**)
- `docs/box_redesign_membership.md` — creating, filling, editing, dissolving (lens **M**)
- `docs/box_redesign_workspace.md` — tabs, "+" menu, side panel inside a box (lens **W**)

Goal (user): boxes that are user-friendly, easy to reach, well organised and
neatly arranged. Background: `docs/context/project_boxes.md` (Phase 12 pills,
2026-09-22, was the previous "boxes are unfriendly" round).

## The problems, merged and ranked

1. **Trapped in a box.** Entering hides every non-member pill; the only way
   back is the hover-only `▾` caret → "All projects" (A §1.1).
2. **Which member does this tab belong to?** Tabs have no member field; the
   " — name" label suffix is the only trace and a rename erases it (W §1.1, TODO 31av).
3. **Creating a box is a 4-in-1 form** that doesn't enter the box afterwards, has two
   default names, and a "Box" dropdown that discards the draft (M §1.2–3).
4. **Closed projects can't join or leave a box** in any membership UI, though
   the slice shows them (M §1.1).
5. **No discoverability.** With no boxes there is no box UI; the door is the 7th
   row of the import menu; boxes are missing from the palette and from empty search (A §1.3, M §1.4).
6. **Clutter.** A "+" menu with 3 × N per-member rows, Claude only (W §1.2); a side panel
   spending about 60 px per member on chrome, collapse not persisted (W §1.3); the
   box pill row never shrinks on narrow windows (A §1.2).
7. **Data loss on Save**: the editor sends the whole member list
   (`set_box_members`), so a member added meanwhile is erased (M §1.7).

## Core idea

**One colour, one "where", one exit.** A box keeps its pill and colour; the
selected pill gets a visible ✕. Every member gets a stable dot colour
(`autoBoxColor(projectId)`) shown the same way on tabs, in the "+" fly-out, in the
side-panel headers and on the phone. Creating a box is "name it, Enter, you're
in"; membership is edited by one shared checklist everywhere.

## Fixed decisions (defaults taken from the lens recommendations)

These hold unless the user overrides them. The decisions still open are listed further down.

- N:M membership and "no silent dissolve" stay. `boxes.json` shape is unchanged;
  new names are validated (trim, non-empty, unique case-insensitive), legacy
  duplicates are tolerated on read (M D2a).
- Closed projects are listable, addable and removable everywhere, labelled "closed" (M D3a).
- Editor Save is one diffed `patch_box` (`name`, `addMembers`, `removeMembers`);
  backend first, `backend:stale` reported (M step 1). Backend rules (plan review,
  checked against `commands/boxes.rs` and `services/box_store.rs`):
  - `BoxPatch` (`commands/boxes.rs:447`) already has the singular `addMember` /
    `removeMember`; they stay (drag-drop, menus, old callers). The plural fields and
    `name` are added beside them; `deny_unknown_fields` stays.
  - `clean_box_name` runs in `create_box`, `rename_box` and `patch_box`, and only when
    the name differs from the stored one, so a legacy empty or duplicate name never
    blocks an unrelated save. The uniqueness check needs the other boxes, so it sits in
    `patch_box_at` (which holds `next`), not in the pure `apply_box_patch(target, ..)`.
  - Member ids that satisfy `storage::is_reserved_scope` are dropped by
    `addMembers`/`create_box(memberIds)` (a new id check calls it, AGENTS.md). Unknown
    ids need no check: `boxes_as_seen` reconciles on read.
  - Name + members in one `patch_box` is one `write_boxes_stamped`, so `rev` moves once.
    Not a conflict with the whole-list CAS: `patch_box` never compares `rev`, it applies
    to the file under the lock, and the answer replaces the store's copy.
  - `color` on `create_box` reuses the patch's `#rrggbb` validation (one helper).
  - No new command name: no `command_class` row, and `commandClasses.ts` must come out
    unchanged (run the generated-file test). `create_box` only gains optional
    camelCase args (`memberIds`, `color`); build.rs regenerates the dispatch wrapper.
- **Frontend against an older running backend** (`src/` hot-reloads, `src-tauri/` does
  not): an old `patch_box` refuses `name`/`addMembers` ("unknown field") and an old
  `create_box` silently ignores `memberIds`/`color`. So `saveBox` falls back on that
  refusal to the legacy calls (`rename_box` + one singular `patch_box` per id), and
  `createBoxQuick` checks the answer's `member_ids` and tops up with singular patches.
  The frontend also validates the name itself (`promptText` `validate`), since an old
  backend does not. AS1 tests both fallbacks.
- **Every step with strings edits all five dictionaries.** `src/__tests__/shell/i18n.test.ts`
  fails when `de/es/fr/it` miss an English key, or hold one English dropped. So new keys
  go into `en.ts` AND `de/es/fr/it.ts`, and a replaced key (`boxEditor.defaultName`,
  `newTabMenu.boxMember*`, `newTabMenu.groupBoxMembers`) is removed from all five
  once its last use is gone. (Earlier text said "en.ts only": that is wrong.)
- **The slice moves into a store.** `boxFilter` is `useState` inside `ProjectSwitcher`
  (`:325`), with `lastUnslicedScope` (a ref, `:368`) and `selectBox` (`:375`). The ✕,
  `cycleBox`'s return stop, "`cycleProject` honours the slice", the palette's "Show
  all projects", the search's "All projects" row, quick-create-then-enter and
  Dissolve-while-inside all need to read or clear it from outside. New
  `src/stores/boxSlice.ts` (`sliceBoxId`, `lastUnslicedScope`, `selectBox`,
  `leaveBox`) is its one home; the switcher's effects keep their behaviour. Still
  session-only, nothing persisted.
- Narrow windows: pill budget by `headerWidthTier` (6/3/1) plus a fold pill `▣▾ +N`
  after the shown pills (A D2a).
- Boxes in ProjectSearch on focus (matched by member name too, coloured swatch)
  and in the Ctrl+K palette (A D4a + M §2.4, merged into one step).
- `cycleBox` ring gains a return-to-project stop (A D3a). Member swatch click
  opens its box (A D5a).
- Tab member chip derived from `tab.cwd` (`memberOfCwd`), dot-only when narrow;
  new tabs drop the " — name" suffix (W D1a). `memberOfCwd` rules: path-component
  prefix match through `lib/paths` (never string `startsWith`; Windows case/separators),
  longest member root wins, the box folder and anything else is "whole box". It uses the
  same member to directory table as `boxMembersOfScope`, so a remote member whose tabs
  run in its local copy gets no chip in v1 (noted in the handoff, not guessed from
  paths: AGENTS.md "remoteness is explicit"). The chip shows on shell, agent, `files`
  and `projectfiles` tabs only; viewer, monitor and similar tabs stay chip-free.
  Popouts have a separate strip (`DetachedCenterPanel.tsx`, its own `TabHoverCard`
  use) fed by the one-time `projectInfoForScope` seed (`stores/detached.ts:899`: the
  box and its member `ProjectEntry`s), so both strips render one shared `TabMemberChip`.
- "+" menu: "Start in…" fly-out on Agents/Shell/Files rows, Box-members group
  deleted, popout parity (W D2a). The member "Files" row opens a `projectfiles` tab
  (`PROJECT_FILES_TAB_CMD`, the one with the commit bar), the whole-box "Files" row the
  plain `files` tab; the fly-out maps each. Rows that name no member keep following the
  header target (Local Model, API-key and cloud rows included), so they cannot start in
  a *different* member in this run (non-blocking, see the handoff).
- Per-member git: dirty dot in the section header, commit via "Open as tab" (W D5a).
- Phone access as a row in the box sheet (M D4a). Delete renamed "Dissolve box…";
  the slice ✕ keeps meaning "remove from box", plus an explicit menu row (M D5a).

### Decision 3 in code: where a new tab starts

`CenterPanel.newTabCwd` (`:180`) is **per scope**, not per pane, so it cannot know the
active tab. The target is computed per group in `TabBar.tsx` (`projectCwd` prop, used by
all the handlers `:831-1005`): `memberOfCwd(activeTab.cwd)`'s **root directory** (never
the tab's own cwd: a viewer tab's cwd is its file's folder), else the box folder. One
helper `newTabTarget(...)` in `stores/boxes.ts` is used by every path, which are all of:

1. the "+" button and its menu (`TabBar.tsx`, header names the target);
2. the chords: Ctrl+Shift+N shell, Ctrl+Shift+M monitor, Ctrl+1-9 agents
   (`newTabChord.ts` -> `NEW_TAB_SHORTCUT_EVENT` -> the focused group's `TabBar`
   `onRequest`, `:1044`), and steering's `+`/`=` menu and 1-9 (`useKeyboard.ts:388,541,602-608`).
   They all land in the same `TabBar` listener, so the one computation covers them.
   There is **no Ctrl+T** in the app; the user's wording means these chords;
3. the popout "+" menu: `detachedNewTabCwd` (`stores/detached.ts:932`) already gets the
   group's tab cwds, and `NewTabMenu` mounts in `DetachedCenterPanel.tsx:1955-1970`;
   members come from the seeded `remoteInfo.boxMembers`;
4. the empty group (`Subwindow` with `EMPTY_GROUP_ID`, `CenterPanel.tsx:1096`): no active
   tab, so the box folder;
5. kinds whose cwd is not a launch directory (Monitor, Disk usage, Network, Printing,
   Prompt chart, Workspace, Projects 3D, `TabBar.tsx:925-1005`) keep the box folder,
   or their "already open" match (`tab.cwd === projectCwd`, `:832`) would open one per member;
6. unchanged on purpose: reopen-closed-tab (keeps the tab's own cwd), file drops
   (`commitFileDrop`), the Subwindow files sidebar, prompt-chart and reader "new tab"
   (they carry their originating cwd).
The agent worktree picker (`useAgentWorktreePicker`, keyed by `projectCwd`) then simply
follows the member's repository.

## Cross-lens resolutions

- **Ghost "+ Box" pill** appears in both A step 3 and M step 6. It lands once, in
  the access pill-row step, calling M's `createBoxQuick`.
- **`BoxScopeChip.tsx`** is touched by A (pill row, ✕, fold pill) and M (context-menu
  block). The pill-row steps land first; M then edits only the menu block.
- **Palette** steps A5 and M6 merge into one step. Box tabs get their scope name as
  `detail` via one shared `scopeDisplayName(scope, projects, boxes, t)` helper (not
  `scopeLabel`, a local name in `FileTree.tsx`), which W's hover card reuses. It is
  created in AS1 so AS3a (hover card) and AS6 (palette) do not both write it.
- **Member dots vs box swatches.** Both use the `autoBoxColor` hue space. Members
  are always round dots (●) and boxes always rounded squares (▣), never swapped.
- **Empty box**: M owns the copy and the "Add projects…" button, W owns where the
  file view shows it.
- **Dissolving while inside the box** first calls `boxSlice.leaveBox()` (M §2.5). Today
  only the switcher effect at `ProjectSwitcher.tsx:341` drops the slice; the *scope* stays
  `box:<id>` of a vanished box. `dissolveBoxSpec` is exported from `BoxEditorDialog.tsx`
  and imported by `ProjectSwitcher.tsx:8`: keep it exported (or move it) when the sheet
  replaces the dialog.
- **`renamingId`** lives in `BoxScopeChip` state (`:107`). AS1 adds the field to
  `boxEditor`; AS2a makes the pill row read it; AS5a's Alt-drag sets it.
- **Create doors** (all go through one `useQuickCreateBox()` hook, built in AS1, since
  `promptText` is a hook and a store cannot call it): `BoxScopeChip.tsx:533`,
  `ProjectSwitcher.tsx:854` and the Alt-drag at `:508`, `ProjectPill.tsx:1933,1966`,
  and the ghost pill. `openCreate` has no caller left afterwards; `openEditor(null)`
  (`BoxScopeChip.tsx:541`, `ProjectPill.tsx:1977`) must become "open the list / first box".
  `set_box_members` callers after this run: `boxProjects` (append to an existing box,
  the only live use), the legacy fallback, and tests; nothing in the mobile bridge, import
  (`join_boxes_by_name` writes directly) or MCP calls a box command.
- `stores/boxes.ts` is edited by M (create/save) and W (`memberOfCwd`): additions only, no reshape.

## Ordered steps

| # | Step | From | Size |
|---|------|------|------|
| 1 | Backend: `clean_box_name`, `create_box(memberIds?, color?)`, `BoxPatch{name, addMembers, removeMembers}` beside the singular fields, `rename_box` validated, + cargo tests (name rules, legacy duplicate tolerated, reserved member id dropped, one `rev` bump) | M1 | S-M |
| 2 | Store and hooks: `createBoxQuick`, `defaultBoxName` ("Box N"), `useQuickCreateBox()` (prompt, create, `openBox`), diffed `saveBox` with the old-backend fallback, `renamingId` field in `boxEditor`; pure `memberOfCwd`, `memberColor`, `newTabTarget`, `scopeDisplayName` | M2, W1 | S-M |
| 2b | Slice into `stores/boxSlice.ts` (`sliceBoxId`, `lastUnslicedScope`, `selectBox`, `leaveBox`); `ProjectSwitcher` reads it. No visible change | review | S |
| 3 | Exit and state: ✕ on the selected pill, strip tint, ✓ = scope / bold = slice, caret opens on click | A1 | S-M |
| 4 | Width budget + fold pill; ghost "+ Box" pill when no boxes exist (calls `useQuickCreateBox`) | A2, A3, M6 (pill) | M |
| 5 | Quick create everywhere (all doors use the hook; enter the box after); Alt-drag lands in inline rename; "Edit boxes…" never opens create mode | M4 | S |
| 6 | `BoxMemberChecklist` shared by both pill menus (closed included, scrolls, filter past 8); explicit "Remove X from Box" row; "Dissolve box…" wording, leaving the box first | M3, M5 (menu) | M |
| 7 | Box sheet replaces `BoxEditorDialog` (one box, colour, badges, folder, phone row, Dissolve footer, reuses the checklist); empty-box copy + "Add projects…" | M5, M7 | M-L |
| 8 | Search + palette: boxes on focus, member-name match, palette group/actions, `scopeDisplayName` as `detail` | A4, A5, M6 (palette) | M |
| 9 | Keyboard: `cycleBox` return stop; `cycleProject`/`projectStations`/badges follow the slice; swatch click opens box | A6, A7 | S-M |
| 10 | Shared `TabMemberChip` in both strips (main `TabBar`, popout) + hover-card row | W2 | M |
| 11 | "+" menu "Start in…" fly-out, delete Box-members group, drop the label suffix, `newTabTarget` for every path in "Decision 3 in code", popout parity | W3, W4 + decision 3 | M-L |
| 12 | Side panel accordion: rich headers, dirty dot, persisted collapse (12a); `⋯` menu, Open as tab, one search (12b) | W5, W6 | L (split) |
| 13 | Polish: popout titlebar box mark, box pill counts member agents, feature hint, lesson + help doc + `DOCUMENTATION.md` + `todo/group-a-boxes.md` rows | A8, A9, M6 | M |
| 14 | Phone: `PublicTab.member` chip (31av), member selector (31aw) | W7 | M each |
| 15 | Optional: "Open beside" split | W8 | M |

Steps 1-2b are invisible groundwork. Steps 3-5 are the first user-visible win:
no more being trapped, and creating a box becomes cheap. Steps 10-11 fix tab
ownership. Every new surface gets an `UntestedTag` row. Hot shared files
(the five `i18n/*` dictionaries, `untested.ts`, filemaps) are applied once per step by the merger.
Persisted collapse (step 12) is a per-viewer convenience: a small store over
`localStorage` via `storageKey` from `lib/brand`, wrapped in try/catch, keyed by box id
(expanded member + Files/Git view); no JSON file, nothing to round-trip.

## User decisions (2026-11-03)

1. Entering a box keeps hiding non-members, with an always-visible ✕ on the
   selected pill and the strip tinted in the box colour (A D1a).
2. Creating a box: a name prompt, then you are in the box; members are added
   afterwards (M D1a).
3. A plain "+" / Ctrl+T in a box opens in the active tab's member, and the menu
   header names it; the "Start in…" fly-out picks another member or the whole box (W D3a).
4. Side panel: an accordion, one member expanded, rich one-line headers,
   collapse state persisted (W D4a).

All of these are now fixed decisions; reviewers may not undo them.

## Organisation

**Shape:** mixed risk, with a contract first. One agent lands the groundwork
(the backend patch semantics, the store helpers and the slice store). Then four
parallel tracks in worktrees (header, tab chip, "+" menu, side panel), then the two
tracks that build on the header and the side panel. Reviewers are attached only to
the risky steps (data writes, the large side-panel rewrite, the box sheet); the final
review covers the rest. **Why it fits:** after AS1 the header, tab strip, menu and side
panel touch disjoint files except the shared ones named below. At most 5 subagents
run at once and at most 3 run builds, so phase 2 is the full house; reviewers wait for a free slot.

### Agent steps

Each agent: one subsystem, about 1.5 days, at most about 3 large files.

| Agent step | Plan steps | Main files | Depends on | Reviewer |
|---|---|---|---|---|
| AS1 Groundwork | 1, 2, 2b | `src-tauri/src/commands/boxes.rs` (+ `services/box_store.rs` only if a helper moves), `src/stores/boxes.ts`, `src/stores/boxEditor.ts`, new `src/stores/boxSlice.ts`, new `src/components/projects/useQuickCreateBox.ts`, `src/lib/theme/boxColor.ts`, `ProjectSwitcher.tsx` (slice state only), tests (`BoxAssignment`, new `MemberOfCwd`, cargo) | none | yes (data writes) |
| AS2a Header access | 3, 4 | `src/components/projects/BoxScopeChip.tsx` (pill row, caret), `src/components/layout/ProjectSwitcher.tsx`, `src/components/layout/HeaderBar.tsx` + `src/lib/headerPins.ts` (tier as a prop to `ProjectSwitcher`; it is `HeaderBar` state, no store needed), `src/styles/projects-tabs.css` (`.box-chip`, `.box-pill-row`, ~370-550) | AS1 | final only |
| AS2b Keyboard + swatch | 9 | `src/hooks/useKeyboard.ts` (`cycleBox` `:1467`, `cycleProject` `:1451`), `src/stores/keyboardSteering.ts` (`projectStations`: ring = the visible pills when sliced, inactive members included; `ProjectSwitcher` badges `:188` number the same list), `src/components/projects/ProjectPill.tsx` (swatch span only); tests `BoxCycle`, `KeyboardSteering`, `KeyboardNav` | AS2a | final only |
| AS3a Tab member chip | 10 | `src/components/tabs/TabBar.tsx` (the tab item, `:369`), new `TabMemberChip.tsx`, `src/components/tabs/TabHoverCard.tsx`, `src/components/layout/DetachedCenterPanel.tsx` (popout strip only), `src/styles/projects-tabs.css` (`.tab`, ~1359-1450) | AS1 | final only |
| AS3b "+" menu + new-tab target | 11 | `src/components/tabs/TabBar.tsx` (add-menu code `:830-1005, :1857-1950`), `src/components/tabs/NewTabMenu.tsx`, `AddTabMenuList.tsx`, `useAddTabMenuData.ts`, `agentMenuEntries.ts` (all in `components/tabs/`), `src/stores/detached.ts` (`detachedNewTabCwd`), `DetachedCenterPanel.tsx` (add-menu block `:1955` only); tests `NewTabChordTabBar`, `DetachedNewTabCwd`, `TabBarPlusPinned` | AS1 | yes (touches every new-tab path) |
| AS4a Side panel accordion | 12a | `src/components/files/ProjectFilesPane.tsx` (`BoxRootSection` `:307`), new small collapse store, `src/styles/projects-tabs.css` (`.file-root`, ~834-980) | AS1 | no (AS4b's reviewer covers both) |
| AS4b Side panel menu + search | 12b | `ProjectFilesPane.tsx` (shared search `:934`, `⋯` menu), `ProjectFilesView.tsx` only if the search fold needs a prop | AS4a (same worktree, sequential) | yes (L) |
| AS5a Membership menus | 5, 6 | `BoxScopeChip.tsx` (menu block `:550-634` only), `ProjectPill.tsx` (menus `:1922-1984`), new `BoxMemberChecklist.tsx`, `ProjectSwitcher.tsx` (create doors, Alt-drag `:508`, `+` menu `:850`) | AS1, AS2a merged | final only |
| AS5b Box sheet | 7 | `BoxEditorDialog.tsx`, `BoxColorPicker.tsx`, `boxEditor.ts`, `MobileSettings.tsx` (row reuse), `ProjectSwitcher.tsx` strip + `ProjectFilesPane.tsx` (empty-box copy only) | AS5a, AS4 merged | yes (diff save) |
| AS6 Search, palette, polish | 8, 13 | `src/components/projects/ProjectSearch.tsx`, `src/components/layout/CommandPalette.tsx`, `DetachedCenterPanel.tsx` (titlebar `:1884` only), `BoxScopeChip.tsx` (`ScopeSetStatusBars` only), `src/lib/shortcuts/featureHints.ts`, `src/lib/lessons.ts` (`projectBoxes`), `docs/help/containers-boxes.md`, `DOCUMENTATION.md` (`rg "Project Boxes"`), `docs/context/project_boxes.md`, `todo/group-a-boxes.md` | AS1, AS2a, AS3a/b merged | final only |

Graph: AS1 -> (AS2a -> AS2b ∥ AS3a ∥ AS3b ∥ AS4a -> AS4b) -> (AS5a -> AS5b ∥ AS6) -> final review -> land.
Phase 2 is four chains; AS3a and AS3b both edit `TabBar.tsx` (the tab item vs the
add-menu code, far apart) and `DetachedCenterPanel.tsx` (strip vs add-menu block), and
AS2a/AS3a/AS4a each add a disjoint block to `projects-tabs.css`; the merger resolves
these by 3-way merge, nobody reformats outside their block. AS5a/AS6 both touch
`BoxScopeChip.tsx` (menu block vs status strip) and `DetachedCenterPanel.tsx` (AS6 only
after AS3b merged); AS5b reads AS6-free files.
**Out of this run:** step 14 (phone, already planned in `docs/mobile_box_parity_plan.md`,
its 31aa base never phone-tested; `PublicTab.member` must carry opaque ids only, the
`mobile_control` rule) and step 15 (optional).

**Hot shared files.** i18n strings go into **all five** dictionaries (`en.ts`, then
`de/es/fr/it.ts`; the i18n test enforces parity both ways), in a block placed after the
existing keys with the same prefix, never at the end of the file. Each implementer adds
`untested.ts` rows and filemap rows (new files: `BoxMemberChecklist`, `TabMemberChip`,
`useQuickCreateBox`, `boxSlice`, the collapse store) in its own worktree; the main agent
resolves the merges. Handoff: `docs/box_redesign_handoff.md`.

**Landing note.** The main checkout has uncommitted edits by other sessions in
`ProjectSwitcher.tsx`, `en.ts`, `featureHints.ts`, `untested.ts`,
`projects-tabs.css` and the filemaps. Landing commits by `update-ref` and then
3-way-merges (`git merge-file`) each such working-tree file onto the new blob, so
neither side's edits are lost.

## Verification

Gates per `AGENTS.md` (`scripts/gates.sh`). Step 1 adds the cargo gates (incl.
`cargo test -p tabtivity --no-default-features --lib`, the daemon build, and the
generated `commandClasses.ts` test, which must show no diff) + `backend:stale`, step 14
`mobile:bundle`. Cargo tests are cross-OS (no path literals). Extend the vitest suites
`BoxRendering`, `BoxUx`, `BoxSearch`, `BoxMembershipControls`, `BoxScopeMenus`,
`BoxAssignment` (its `create_box {name}` / `set_box_members` / `New Box` expectations
change), `BoxCycle`, `SidePanelBox` (uses `set_box_members`), `KeyboardSteering`,
`CommandPalette`, `NewTabChordTabBar`, `DetachedNewTabCwd`, `TabHoverCardFeatures`; add
`MemberOfCwd` and the old-backend fallback cases. `npm test` also runs `i18n.test.ts`. Nothing is live-verified until the user
clicks through; new manual rows in `todo/group-a-boxes.md` carry the four platform children.
