# Box redesign — creation and membership management

Lens: how a box is learned about, created, filled, edited and dissolved.
Header access (lens a) and in-box arrangement (lens b) are touched only where
this design depends on them. Based on the code as of 2026-11-03, not the docs
alone. Nothing here is built.

## 1. Today

Files: `src/components/projects/BoxEditorDialog.tsx` (editor), `BoxColorPicker.tsx`,
`BoxScopeChip.tsx` (chip, box pills, box-pill menu), `src/stores/boxes.ts`,
`src/stores/boxEditor.ts`, `ProjectSwitcher.tsx`, `ProjectPill.tsx`,
`src-tauri/src/commands/boxes.rs`, `services/box_store.rs`.

### Flows (clicks = clicks after the first hover/right-click; typing extra)

| Goal | Path | Cost |
|---|---|---|
| Create, from nothing | hover `+` (`ProjectSwitcher.tsx:768`) -> **New Box**, the 7th and last row of a project-import menu (`:850`) -> editor in create mode (`BoxEditorDialog.tsx:58`, name pre-filled "New box", focused but not selected) -> retype name -> tick members -> Save (`:93`) | 3 + members + typing; box is NOT entered afterwards |
| Create from selection | Ctrl-click N pills -> right-click -> **Box these (N)...** (`ProjectPill.tsx:1928`) -> same editor -> Save | N + 3 + typing |
| Create from one project | pill menu -> **New box with X...** (`ProjectPill.tsx:1962`) -> editor -> Save | 3 + typing |
| Create by Alt-drag | Alt-drag A onto B (`ProjectSwitcher.tsx:506`) -> box instantly named "New Box" (a different string than the editor's "New box"), not renamed | 1 gesture, then rename = right-click, Rename, type, Enter |
| Add to a box | (a) drag a pill onto a box pill (`BoxScopeChip.tsx:388`, only for boxes with a pill and projects that have a pill); (b) box-pill menu **Members** checklist (`:583`, stays open, 12 rows max, `:38`); (c) project-pill menu **Boxes** (`ProjectPill.tsx:1940`, closes after each click, 6 boxes max); (d) while a box slice is selected `+` becomes a candidate list (`ProjectSwitcher.tsx:788`); (e) editor | 1-2 each |
| Remove | slice: the pill's x (`ProjectSwitcher.tsx:718`); menus (b)(c); editor | 1 |
| Rename | box-pill menu -> Rename -> inline input (`BoxScopeChip.tsx:401`); or editor | 2 |
| Recolour | box-pill menu -> swatch (`BoxColorPicker.tsx`); not in the editor, not at creation | 2 |
| Dissolve | box-pill menu **Delete box** -> confirm (`dissolveBoxSpec`, `BoxEditorDialog.tsx:34`); or editor **Dissolve box** -> confirm | 3 / 4 |
| Phone access | Settings -> Mobile -> "Box access" (`MobileSettings.tsx:811`); nowhere on the box | far away |
| Discover | lesson `projectBoxes` (`lessons.ts:1320`), help `containers-boxes`, the `+` row. No hint, no palette entry (`CommandPalette.tsx` has no box action) | passive |

### Friction, ranked

1. **Closed projects cannot be added or removed in any membership UI.** The
   editor (`BoxEditorDialog.tsx:76`), the box-pill checklist (`BoxScopeChip.tsx:265`)
   and the slice candidate list (`ProjectSwitcher.tsx:419`) all filter out
   `status === "inactive"`, yet the slice shows inactive members. A box with a
   closed member cannot have it unticked in the editor (the id stays in
   `checked`, invisible), and a closed project cannot join without reopening it first.
2. **Creating a box is a form, and the form is a 4-in-1.** One dialog is create,
   edit, member picker and dissolve; the top "Box" dropdown (`:142`) swaps the
   target and silently discards the draft (`:65`). "Edit boxes..." opens it in
   *create* mode (`boxEditor.ts:28`, `boxId: null`) so "edit" lands on "New box".
   No colour, no way to see what the box will do. Nothing enters the new box.
3. **Naming is sloppy.** Two default strings ("New box" in `boxEditor.defaultName`,
   "New Box" in `projectSwitcher.newBox`), Alt-drag makes unnamed duplicates, the
   backend accepts empty and duplicate names (`create_box`/`rename_box`,
   `boxes.rs:339,366`) while project import joins boxes *by name*
   (`join_boxes_by_name`, `:403`, first match wins). The folder name is fixed at first
   open (`resolve_box_folder`, `:583`) so a rename leaves it stale, and nothing shows the folder.
4. **Discoverability is near zero.** With no boxes there is no box UI at all
   (`BoxScopeChip.tsx:376` renders the pill row only when `shown.length > 0`).
   The sole door is the last row of the import menu, tagged "untested". The
   lesson text still describes a hexagon chip "named New Box with 0 members"; the help doc
   says "the chip lists boxes" and omits Colour.
5. **Same job, three menus, three behaviours.** Box-pill Members stays open,
   project-pill Boxes closes, the slice list is a third widget; caps of 12 vs 6 and
   an "Edit boxes..." row that exists only past 6 (`ProjectPill.tsx:1972`).
6. **Mode-dependent x.** In a slice the x on a pill means "remove from box" (title
   only), elsewhere "close project". No undo. In a slice the `+` menu loses New
   project/Import.
7. **Whole-list overwrite on Save.** The editor sends `set_box_members`
   (`boxes.rs:521`) with the full list plus a separate `rename_box`: two writes, and a
   member added meanwhile (phone, import, second window) is erased. `patch_box`
   (`:467`) already does additive edits.
8. **Edge cases are invisible at membership time.** Container/VM members get one
   summary sentence below the list, worded "sandboxed to the box folder" while
   the box is uncontained (`boxEditor.trustNotice`). Remote members get nothing
   (box tabs are local-only, remote files need a connect prompt, the phone sees no
   root for remote/VM/container members, `mobile_box_parity_plan.md`).
9. **Dissolve vs Delete**: same action, two names; the dissolve confirm names no
   folder path though the box has one.
10. Dissolving while inside the box scope leaves `scope` pointing at a vanished
   box until the slice effect (`ProjectSwitcher.tsx:341`) fires (not verified live).

Constraints from the backend: only `id`/`name` required, `color`/`hide_pill`
live in `extra` (`schema/boxes.rs:73`), `rev` stamps per box, reserved ids refused
(`box_store.rs:25,67`), members reconcile against `projects.json` on read
(`boxes_as_seen`), `delete_box` never removes the folder, `box:<id>` session
state, or links. `BoxPatch` is `deny_unknown_fields` (new fields are safe for old
callers; old backends refuse new ones, so ship backend first).

## 2. Proposal: "name it, then fill it where you are"

Principles: the cheapest path is name + Enter; membership is edited in the
same widget everywhere; the full sheet is for what is rare (colour, phone,
dissolve); every row tells the truth about its project (closed, container, VM,
remote, also-in-other-boxes). N:M and "no silent dissolve" stay as they are.

### 2.1 Quick create (replaces the editor as the creation door)

Every create door (`+` menu, Box these, New box with X, Alt-drag, palette, ghost pill) calls one
`createBoxQuick(memberIds)`: `useDialogs().promptText` (`validate` exists,
`PromptDialogs.tsx:54`) -> backend create with members -> enter the box.

```
 +-- New box ---------------------------------+
 | Name your box                              |
 | [ Thesis                                 ] |   default "Box 3" (first free), all selected
 | 3 projects: paper, data, slides            |   only when created from a selection
 | A box with that name exists.   (validate)  |
 |                      [Cancel]  [Create box]|
 +--------------------------------------------+
```
Costs: `+` -> New box -> type -> Enter = 2 clicks + name (was 3 + retype + Save).
Selection: Box these (N) -> type -> Enter. Alt-drag: box appears AND its pill goes into
inline rename (`renamingId` lifted into `stores/boxEditor`), so no "New Box"
duplicates survive. The box is entered, and the empty case (2.5) tells the next step.

### 2.2 The box sheet (replaces `BoxEditorDialog`; "Edit box..." only)

One box per sheet: no target dropdown, no create mode (creation is 2.1), so a
draft can never be swapped away. Same classes (`project-dialog dialog-framed
box-editor`, `useModalFocus`, `DialogShell` scheme, no new variant).

```
 +-- Box: Thesis -------------------------------------- [x] +
 | Name    [ Thesis                      ]                   |
 | Colour  (auto)(o)(o)(o)(o)(o)(o)(o)(o) (custom)           |  BoxColorPicker swatches, shared
 | Members [ Filter projects...  ]  3 of 14   Select shown   |
 | +-----------------------------------------------------+   |
 | | [x] paper          [] [] <- also-in swatches         |   |  members first, then the rest,
 | | [x] data           container                         |   |  badges: container | VM | remote |
 | | [x] slides         remote - files need a connection  |   |          closed | also in: (swatch)
 | | [ ] old-notes      closed                            |   |
 | | [ ] cluster-run    remote                            |   |
 | +-----------------------------------------------------+   |
 | i Box tabs run on this machine without the container or   |  shown only if a ticked member is
 |   VM of: data. Remote files open through the connection.  |  container/VM/remote; names listed
 | Folder   ~/tabtivity/boxes/thesis   [Open]  (created on   |
 |          first open; renaming the box does not move it)  |
 | Phone    [ ] Reach this box from my phone  (Choose...)    |  existing ToggleRow + phone picker
 |                                                           |
 | Dissolve box...                       [Cancel]   [Save]   |  danger, left, set apart
 +-----------------------------------------------------------+
```
- Closed projects are listed and can be added (they stay closed; `openBox`
  already reopens them box-locally, `boxes.ts:332`). Fixes friction 1.
- Save sends ONE `patch_box` carrying `name` + `addMembers`/`removeMembers` diffed
  against the draft's *loaded* snapshot (not `set_box_members`): concurrent
  additions survive. Name errors (empty, duplicate) show inline.
- "Dissolve box..." is the one name everywhere (the pill menu's "Delete box"
  becomes "Dissolve box..."); the confirm states the folder path.
- Phone row reuses `setBoxMobileAccess` with the box's *current* device list (passing
  `null` would widen it to every phone, `boxes.ts:86`); the row is hidden when the
  preconditions fail (tmux, persistent sessions), saying why.

### 2.3 One membership checklist, three places

Extract `BoxMemberChecklist` (props: box or project, rows, filter) from the
two copies (`BoxScopeChip.tsx:583`, `ProjectPill.tsx:1940`). Rules:
stays open across toggles; scrolls (max-height, no 12/6 cap, no "Edit box..."
dead-end); a filter input appears past 8 rows; closed projects included and
labelled; same `context-menu-check` / `BoxSwatch` classes as today.

```
 Box pill menu                         Project pill menu (paper)
 Open box                              ...
 Rename                                Boxes
 Colour (auto)(o)(o)...                 [x] (o) Thesis
 Members         filter [ ]             [ ] (o) Collab
  [x] paper                             [x] (o) Review      (stays open)
  [x] data                              New box with paper...
  [ ] old-notes   closed                In a box slice:  Remove paper from Thesis
 Edit box...
 Dissolve box...
```
The slice's mode-dependent x stays (it is the established gesture) but each
member pill's menu gains the explicit "Remove X from Box" row, and the slice `+`
list keeps its job but also offers "New project..." so the slice is not a dead end
(shared with lens a). A toast with Undo for the x removal is optional (step 7).

### 2.4 Discoverability

- Zero boxes: a ghost pill "[+ Box]" (dashed `box-chip` outline, same radius/rim
  tokens) sits where box pills would. One box or more: it shrinks to a trailing "+".
  Click = quick create. **Lens-a dependency**: the pill row is theirs; if they
  restructure it, this becomes one `+ New box` row at the top of their box list.
- Command palette: "New box...", "Open box <name>", "Add <current project> to <box>...".
- One feature hint (the hint rotation) when >= 4 projects and 0 boxes: "Working across
  projects? Group them in a box"; points at the ghost pill. Lesson and `containers-boxes`
  help rewritten (pills, quick create, colour, no hexagon chip, Dissolve).
- Drop a pill on the ghost pill = create a box with it (prompt opens).

### 2.5 Empty box, edge cases

- Empty box: pill dimmed (as today); entering shows, in the slice strip and the
  box file view, "No projects yet - drag a pill here or [Add projects...]" (button opens
  the member popover). Lens b owns the file-view placement; I own the copy and button.
- Project in several boxes: member rows show every other box's swatch; the project-pill menu already lists all.
- Remote member: badge + sheet line; mobile caveat only shown when the phone switch is on.
- Container/VM member: badge per row replaces the misleading summary wording
  ("Box tabs run on this machine, outside the container or VM of: ...").
- Dissolve in the box's own scope: switch to All projects first, then delete.
- Duplicates already on disk (many "New Box"): tolerated on read, never rewritten;
  only new writes are validated.

## 3. Changes (in order)

| # | Step | Files | Size | Notes |
|---|---|---|---|---|
| 1 | Backend: `clean_box_name` (trim, non-empty, <= 80 chars, no control chars, case-insensitive unique on create/rename); `create_box` takes optional `memberIds`, `color`; `BoxPatch` gains `name`, `addMembers`, `removeMembers` | `commands/boxes.rs` (`create_box` :339, `rename_box` :366, `BoxPatch` :447, `apply_box_patch` :488), cargo tests there | S-M | `boxes.json` shape unchanged (name is the same field; legacy duplicates/empties read fine). Optional args keep old callers working. No new commands, so no `command_class` row; if one is added regenerate `commandClasses.ts` |
| 2 | Store: `createBoxQuick`, `defaultBoxName` (first free "Box N", one i18n key replacing `boxEditor.defaultName` and `projectSwitcher.newBox` use), `patchBox`-based `saveBox(draftDiff)`; `renamingId` moves to `stores/boxEditor` | `stores/boxes.ts`, `stores/boxEditor.ts`, `ProjectSwitcher.tsx:506` | S | Alt-drag then auto-rename |
| 3 | `BoxMemberChecklist` + `BoxColorSwatches` extracted; box-pill and project-pill menus use them; closed projects included; Remove row in slice | new `components/projects/BoxMemberChecklist.tsx`; `BoxColorPicker.tsx`, `BoxScopeChip.tsx:583`, `ProjectPill.tsx:1922-1984`; CSS in `styles/projects-tabs.css` | M | **Conflicts with lens a**: `BoxScopeChip.tsx` is the header file. Touch only the context-menu block (:550-634) |
| 4 | Quick create via `promptText`; all create doors call it; "Edit boxes..." opens the first box or the list, never create mode | `ProjectSwitcher.tsx:850`, `ProjectPill.tsx:1928,1962,1977`, `BoxScopeChip.tsx:530`, `AppShell` unchanged | S | Needs i18n keys (en + de/es/fr/it) |
| 5 | Box sheet rewrite (no target dropdown, colour, badges, folder, phone row, diff save, dissolve footer) | `BoxEditorDialog.tsx`, `boxEditor.ts` (`openEditor(boxId)` only), `MobileSettings.tsx` row reused | M-L | Register new UI in `src/lib/untested.ts` (UntestedTag) |
| 6 | Discoverability: ghost pill, palette actions, hint, lesson + help doc rewrite | `BoxScopeChip.tsx:376` (**lens a**), `CommandPalette.tsx`, `shortcuts/featureHints.ts`, `lessons.ts:1320`, `docs/help/containers-boxes.md`, `docs/context/project_boxes.md` | M | Ghost pill is the likeliest merge conflict |
| 7 | Empty-state copy + button; optional Undo toast for slice removal | `ProjectSwitcher.tsx` strip (**lens a**), file view (**lens b**) | S | Copy and component are mine, placement theirs |
| 8 | Tests | update `BoxUx`, `BoxMembershipControls`, `BoxScopeMenus`, `BoxAssignment`; add closed-member, diff-save, name-validation cases; cargo for `clean_box_name`, patch name/members | S-M | Also `git grep` the old keys for dead i18n |

Order rationale: 1 then 2 ship invisibly (backend first, old frontend still
works); 3 and 4 are the user-visible win; 5 builds on them; 6-7 wait on lens a/b.
Roll out with the compatibility rule: a frontend must tolerate an older running
backend refusing `deny_unknown_fields` (`backend:stale` applies, so run it and say so).

Compatibility: no field added to `boxes.json`; `color`/`hide_pill` stay in
`extra`; legacy `box_id` stripping, `tabtivity_mobile_*` keys and `rev` stamping untouched;
`set_box_members` stays (mobile bridge, import). `join_boxes_by_name` benefits from
unique names but is unchanged.

Invariants checked: no cut corners (ghost pill uses existing rim/radius tokens); one
menu/dialog scheme, `useDialogs()` for the prompt and confirm; all strings in `i18n/en.ts`;
no app name literals; `is_reserved_scope` unchanged (box ids are still generated); no new
`tauri::command` outside the `cfg_attr` pattern; hidden-pane gating unaffected.

## 4. Decisions for the user

1. **How should a new box be created?**
   (a) Name prompt, then it exists and opens; members added afterwards where you
   are (recommended: 2 clicks + a name, empty boxes are legal anyway).
   (b) Keep one full dialog with the member list. (c) Inline name on a ghost pill, no dialog.
2. **Name uniqueness.**
   (a) Reject duplicate and empty names on new writes, tolerate old ones (recommended:
   import joins by name, folders derive from names).
   (b) Allow duplicates but warn. (c) Auto-suffix silently ("Thesis 2").
3. **Closed projects in boxes.**
   (a) Listable, addable and removable everywhere, labelled "closed", staying closed
   (recommended: matches what a slice already shows). (b) Only addable in the sheet.
   (c) Keep excluding them and just show a hint.
4. **Where does phone access live?**
   (a) A row in the box sheet that reuses the Settings > Mobile switch (recommended: the
   user thinks "this box", not "Settings"). (b) Leave it in Settings only. (c) Add it to the box-pill menu too.
5. **Slice x and Delete wording.**
   (a) Keep x as remove-in-slice, add the explicit menu row, rename Delete to
   "Dissolve box..." (recommended: least gesture churn). (b) Replace the x with a
   distinct minus glyph in slices. (c) Remove x in slices, menu only.
