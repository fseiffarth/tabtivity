# Steering: rows-first navigation in the side panel — plan

Status: plan, 2026-11-10. Decisions settled with the user the same day.
Frontend only. One implementer (Sonnet) in a worktree on `develop`; the main
agent lands it. Never run live.

## Why

Steering's side panel region (`B`) walks the panel with the generic region
cursor (`lib/shortcuts/steeringRegion.ts`), which does not fit a panel made of
a head and a list:

- `placeRegionCursor` lands on the panel's first control (its header), not in
  the list.
- ↑/↓ are `moveRegionCursor`: one flat walk over header buttons, up to 11 view
  tabs, the action icons, the breadcrumb, every row and every row's own
  buttons. The tenth file is ~30 presses away.
- ←/→ are `stepSidePanelView` over a hardcoded four views
  (`steeringRegion.SIDE_PANEL_VIEWS`); the panel's row offers up to 11
  (`files/sidePanelViews.ts`, gated per scope).
- Enter is `click()`. A file row's click only selects (`FileTree`
  `handleRowClick`); opening is `onDoubleClick`. A file cannot be opened.
- A view switch clears the cursor and re-places it at the top.

## Fixed decisions

### The user's (2026-11-10; a reviewer may not undo them)

U1. **←/→ on a list row = folders + row buttons.** Files view: → on a folder
    row opens the folder, ← on a file-tree row goes to the parent folder with
    the cursor back on the folder just left. On every other row ←/→ step
    through that row's own buttons.
U2. **Enter on a file opens it and steering goes to its tab**: tabs level, and
    a panel that `B` opened closes. **Shift+Enter** opens it and stays in the
    panel.
U3. **Worktree on `develop` HEAD, gates, commit, land on `develop`.** The main
    checkout holds other sessions' uncommitted steering edits; the main agent
    merges three-way and does not touch them.

### Design (decided here)

D1. **B lands in the list**: the row the cursor was last on in this view (kept
    per project + view, by a row signature, since the panel unmounts when
    closed), else the first control of the view's body, else the active view
    tab. "Body" = the shown `.side-panel-scroll`, minus `.file-tree-head`.
D2. **↑/↓ move one line per press** (the existing line cut: a row and the
    buttons nested in or beside it are one line), landing on the line's first
    target; on the view row, on the active view tab. ↑ from the first list row
    climbs the head line by line. **No wrap**: the first and last line are firm.
D3. **Shift+↑/↓ move a screenful**: `max(2, floor(body height / cursor row
    height) − 1)` lines, 10 when nothing measures; clamped at the ends.
D4. **←/→ on the view row** switch to the previous / next view as the cursor
    moves (wrapping), over the tabs the panel actually renders. The cursor
    stays on the view row.
D5. **Slot keys 1–9** (the `slot1`…`slot9` bindings, so rebinding carries)
    switch to view N from anywhere in the panel and land the cursor in that
    view's body (D1 order). The active view's own number just lands in the body.
D6. **Each view tab wears its slot key** while the side region is on (a small
    cap on the tab, the steering cap look). The floating `sideViews` cap goes.
D7. `/`, `.`, Esc, the `B`-again close, the pointer rules and every other
    region are unchanged.
D8. Views are switched by clicking the panel's own tab buttons (as
    `stepSettingsPage` does), so the gates in `sidePanelViews.ts` apply for
    free. `stepSidePanelView` and `steeringRegion.SIDE_PANEL_VIEWS` are deleted.
D9. A folder row's own buttons are not reachable with → (it opens the folder);
    they stay on the row's `.` menu. Accepted.
D10. A `.zip` row: Enter extracts and navigates (what its double-click does);
    steering stays in the panel.

## Behaviour table (region `side`)

| Key | Cursor on | Does |
| --- | --- | --- |
| ↑ / ↓ | anything | Previous / next line, no wrap |
| Shift+↑ / ↓ | anything | A screenful of lines, clamped |
| ← / → | view row | Previous / next view (wraps), cursor follows the active tab |
| → | folder row (`.file-entry.dir`) | Open the folder; cursor on its first row, or on the breadcrumb line when it is empty |
| ← | a file-tree row itself | Parent folder (`.file-tree-up` of that row's own `.file-tree`); cursor on the folder left. At the root: nothing |
| ← / → | any other line | Along the line's targets, no wrap (← from a row's first button returns to the row) |
| slot 1–9 | anything | View N, cursor into its body |
| Enter | file row | Open (synthetic `dblclick`), leave to the tabs level, close a steering-opened panel |
| Shift+Enter | file row | Open, stay |
| Enter | anything else | As today (`activateRegionCursor`) |

## Steps

Keep the logic in the new module; the edits in shared files are call sites.

1. **`src/lib/shortcuts/steeringRegion.ts`** (clean in the main checkout):
   export what the new module needs — the line cut (`regionLines`), a way to
   set the cursor on a given target (`setCursor` under an exported name), the
   remembered cursor of a root. Rows that open by double-click: in
   `activateRegionCursor`, a target matching `[data-steer-open="dblclick"]`
   gets a bubbling `dblclick` `MouseEvent` instead of `click()`, result
   `"open"` (new member of the return type). Delete `SIDE_PANEL_VIEWS`.
2. **`src/components/files/FileTree.tsx`** `FileRow` (line ~381): a file row
   (not a folder) gets `data-steer-open="dblclick"`; a `.zip` row also gets
   `data-steer-stay`, so the caller stays in the panel (D10).
   `FileTreeSearch.tsx` result rows (line ~286, files only):
   `data-steer-open="dblclick"`.
3. **`src/components/files/ProjectFilesView.tsx`** view row (line ~1805): each
   tab button gets `data-view={v}` and, as a child, `<SideViewKey n={i} />`.
4. **New `src/lib/shortcuts/steeringSidePanel.ts`**:
   - `steerSidePanel(e, action, bindings, hooks): boolean` — handles ↑/↓
     (Shift), ←/→, the slot keys and Enter on a `data-steer-open` row; false
     for everything else, which then goes to `steerRegion` as today.
     `hooks`: `{ leaveToTabs(): void }` (useKeyboard: `leaveRegion("side")`,
     then level tabs).
   - `placeSidePanelCursor(root, resume): boolean` — D1.
   - The waits (a folder loading, a view mounting) are a bounded retry (≤20 ×
     50 ms) that stops by itself when steering left the side region or a newer
     key came (generation counter). No timer for useKeyboard to cancel.
   - The row signature for D1: `data-entry-path`, else the trimmed text (≤80
     chars); the map key is `<activeId ?? "root">:<data-view of the active tab>`.
   - The folder left (U1): the name on `.file-tree-crumb.current`, read before
     the ↑ click; afterwards the `.file-entry.dir` whose `.file-name` reads it.
   - Everything DOM-scoped to the cursor's own `.file-tree` (a box scope's
     panel is an accordion of several trees).
   - A React re-render rewrites `className` on the two view tabs whose
     `active` changed and drops `.steer-cursor`: re-set the cursor after the
     switch rendered.
5. **New `src/components/files/SideViewKey.tsx`**: subscribes by itself to the
   steering store (`active && level === "region" && region === "side"`, a
   boolean selector) and to `settings.steering_keys`; renders the slot's key
   (`steeringSlotKey` in `steeringBindings.ts`) for n < 9, else nothing.
   `aria-hidden`, `pointer-events: none`, absolutely placed on the tab's
   corner so the row's layout does not move. Style beside `.steering-cap`
   (`src/styles/subwindows.css` ~892), same `.tok-*` colour as the "move"
   group; static, no animation.
6. **`src/hooks/useKeyboard.ts`** (HEAD line numbers):
   - `placeCursorSoon` (283): region `side` places through
     `placeSidePanelCursor(root, resume)`.
   - region case of `steerKey`: one inserted line after the `landed` guard
     (1166): `if (region === "side" && steerSidePanel(e, action, bindings, hooks)) return;`.
     The `landed` guard must keep swallowing the arrow that only landed.
     **Do not edit line 1169** (`steerRegion(sideBack ? …)`): another session
     rewrote it.
   - `steerRegion` left/right: drop the `side` branch; delete
     `stepSidePanelView` (1622) and the imports only it used.
7. **Legend** (`src/lib/shortcuts/shortcuts.ts` `STEERING_KEYS`, `when:
   "sideRegion"`): the ←/→ row becomes `steering.sideRow.label` ("Row ·
   folder"); a slots row (`actions: []`, `slots: true`) under a new key
   `steering.sideViewJump.label` ("Switch view"), bar only. Remove the
   `sideViews` cap: its `CapAnchor` member, `ALSO_IN_BAR` entry and
   `capAnchorOf` line in `steeringBar.ts`, its `ANCHORS` row in
   `steeringCaps.ts`. Remove the dead `steering.sideView.*` keys from all five
   dictionaries.
8. **Strings**: `src/lib/i18n/en.ts` and `de`/`es`/`fr`/`it` (the steering
   keys are translated in all five): `steering.sideRow.label/desc`,
   `steering.sideViewJump.label/desc`; `steering.sidePanel.desc` and
   `steering.press.desc` mention rows / opening a file.
9. **Register + docs**: `src/lib/untested.ts` row `steering.sidePanelRows`
   with its `UntestedTag` in `ShortcutHelpOverlay.tsx` beside the other
   steering ids; `docs/help/keyboard.md` (the `B` row, ~98: one short
   paragraph or rows for the side panel keys); `docs/filemap_frontend.md` rows
   for the two new files and the reworded `steeringRegion.ts` row;
   `todo/group-l-tabs.md` next free `213x` Live-QA item with the per-platform
   ✅/❌ pairs.
10. **Tests**: new `src/__tests__/shell/SteeringSidePanel.test.tsx` — B lands
    in the body; ↑/↓ by line without wrap; Shift step; ←/→ along a row; →
    into a folder and ← back onto it; view row ←/→; slot key → view + body
    landing; a rebound slot key; Enter on a file fires `dblclick` and lands on
    tabs (panel closed when steering opened it); Shift+Enter stays; zip stays;
    the remembered row after close + reopen; `SideViewKey` renders only in the
    side region. Update the existing side tests in `SteeringLevels.test.tsx`
    and `SteeringBar.test.tsx` (`sideViews` cap) to the new behaviour. jsdom
    has no layout: stub `getBoundingClientRect`; dispatch keys on
    `document.body`; keep the `useKeyboard` harness outside re-rendering
    components.

## Other sessions' uncommitted edits (stay clear)

The main checkout differs from HEAD in these HEAD line ranges; keep at least
three unchanged lines between an edit and any of them, and report every edit
that could not.

- `src/hooks/useKeyboard.ts`: 24, 85, 95, 98, 300, 575, 663–664, 675–677, 688,
  690, 717, 734–743, 746–747, 750–751, 981–989, 993–1002, 1064, 1169, 1582,
  1595, 1612–1619 (the last one sits right above `stepSidePanelView`: expected,
  the main agent resolves it).
- `src/lib/shortcuts/shortcuts.ts`: 839, 860–861, 891–893, 1014–1019, 1095,
  1111–1113.
- `src/lib/shortcuts/steeringBar.ts`: 59–61, 72–74 (step 7 touches 64 and 76:
  expected).
- `src/lib/shortcuts/steeringBindings.ts`: 8, 45, 61–63, 125, 139–141 (no edit
  planned there).
- `src/lib/i18n/en.ts`: 1092, 2585, 2599, 8989; `de.ts`: 1048, 2571, 8632.
- `src/lib/untested.ts`: 235, 478, 497, 697, 699.
- `src/components/files/FileTree.tsx`: 3531–3533.
- `src/styles/subwindows.css`: 1000–1260, 4083 (the cap styles at ~892 are clear).
- `docs/help/keyboard.md`: 86, 92, 94; `docs/filemap_frontend.md`: 352–353,
  444, 492, 496–497, 548.

## Verification

- `scripts/gates.sh` in the worktree, in the background (build, `npm test`,
  lint with no new warning, brand-check); report file / test counts.
- Not run live. Click-through for the user after landing: Shift+Space, `B`;
  ↓ ↓ → on a folder, ← back; `2` for Git; ↑ to the view row and ←/→; Enter on
  a file; Shift+Enter on a second; Esc.
