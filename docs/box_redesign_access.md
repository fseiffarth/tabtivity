# Box redesign — access & switching lens

Scope: how a user finds a box, enters it, sees where they are, moves between
boxes and member projects, and leaves. Creating boxes / membership editing and
the arrangement of tabs inside a box belong to the two other designs; only the
touch points are named. Read against `docs/context/project_boxes.md` (why the
pills exist) and the code as of 2026-11-03.

## 1. Today

### The flow, step by step

1. **Discover.** With no box the header shows nothing about boxes. The only way
   to the first one is `+` -> last entry "New Box" of seven, tagged untested
   (`ProjectSwitcher.tsx:850-858`), or "Box these..." on a pill menu. The chip's
   `▾` (`BoxScopeChip.tsx:332-359`) is a bare caret, titled "All projects --
   hover for the root project and the project boxes" (`en.ts` `boxChip.pickerTitle`).
2. **Enter.** Click a box pill (`BoxScopeChip.tsx:414-425`) -> `selectBox`
   (`ProjectSwitcher.tsx:375`) sets the slice (`boxFilter`) at once and awaits
   `openBox` (`stores/boxes.ts:332`: restore closed members, `ensure_box_folder`
   IPC, then `setScope`). The strip immediately drops every non-member pill
   (`visibleProjects`, `ProjectSwitcher.tsx:409-414`).
3. **See where you are.** The box pill is `is-selected` (slice) and, only while
   the box's own tabs are on screen, `active` with a box-coloured top line
   (`projects-tabs.css:540-548`). Inside a slice member pills drop their
   multi-box swatches and show only this box's (`ProjectSwitcher.tsx:700-707`).
   Nothing in the tab area or side panel says "box scope"; the popout shows
   only its own window name (`DetachedCenterPanel.tsx:1884`).
4. **Move among members.** Click a member pill -> `setActive`. The scope leaves
   the box; the slice stays (one-way effect, `ProjectSwitcher.tsx:332-336`) and
   the box pill goes from `active` to merely `is-selected` -- only a thin
   line's difference between "in the box" and "visiting a member".
5. **Switch box.** Click another pill, or `cycleBox` (`useKeyboard.ts:1467`):
   walks *all* boxes by position (including ones whose pill is hidden), from a
   project lands on the first box. There is no stop that returns to the project
   you came from, and `cycleProject` walks all open projects, not the slice.
6. **Leave.** Hover the chip caret, wait, click "All projects" (`BoxScopeChip.tsx:476`)
   -> `selectBox(null)` -> `setActive(lastUnslicedScope)` (`ProjectSwitcher.tsx:388`).
   Clicking a member *also* leaves the scope but keeps the slice, so non-member
   projects stay invisible until that same hover menu is used.
7. **Search.** `ProjectSearch` sits right of `+` (`ProjectSwitcher.tsx:870`).
   Boxes appear only after a query is typed (`ProjectSearch.tsx:78-84`), not on
   focus and not in steering's `/` jump list before typing (`:72-77`); the row
   icon is the neutral `HexagonIcon`, not the box's colour (`:221`).
8. **Palette (Ctrl+K).** `CommandPalette.tsx:217-237`: projects and tabs, no
   boxes. Tab rows from a box scope get no scope name (`:222-223` resolves only
   root and projects), so two boxes' "Shell" tabs read alike.
9. **Narrow window.** `.box-pill-row` is `flex-shrink: 0` (`projects-tabs.css:516`),
   up to `MAX_BOX_PILLS = 6` pills at <=140px label + 20px padding + swatch, and
   `headerWidthTier` (`headerPins.ts:207`) never reaches it; only the search box
   narrows (`header-menus.css:2084,2092`). The "+N" lives *beside the logo*
   (`:348`), far from the pills it counts.
10. **Popout.** No project strip; no box mark. A box subwindow popped out is
    identified by its window name only.

### Friction, ranked

1. **Leaving / "show everything" is hover-menu-only, and slice vs scope is
   invisible.** Entering a box hides non-members, leaving the box scope does
   not restore them. Cost: hover + wait + click, from a menu whose
   trigger is a 10 px caret. This is the "I'm stuck in a box" feeling.
2. **The box row cannot shrink.** Six long names starve the project strip below
   ~1100 px; the overflow count is detached from the hidden pills.
3. **Boxes are second-class on every keyboard/search surface.** Palette none,
   search only after typing, steering none, `cycleBox` has no way back.
4. **Weak discovery and an overloaded chip.** No box -> no hint; logo = window
   drag + root console; caret = hover-only picker whose tooltip says "All projects".
5. **"Where am I" is carried by one thin coloured line.** Swatches vanish in a
   slice, the box pill's status strip counts only box-scope tabs (not members'
   agents), popouts and the tab area carry no box mark.
6. **Reverse navigation is dead.** A member's swatch says "in Thesis" but a click
   does nothing; icons differ between chip menu (coloured swatch), search (grey hexagon) and logo.

## 2. Proposal -- "one scope bar"

Keep the overlay model, the pills, the colours and the slice (users asked for
them). Fix the access gaps with: an always-visible **exit**, a **width budget**
for the pill row, a **fold pill** that sits where the hidden boxes would be, and
**boxes everywhere you can type**.

### 2.1 Header, wide (>= 1280 px, tier 0), inside box "Thesis", visiting a member

```
 ⬡▾ │ ▣ Thesis ✕ │ ▣ Paper │ ▣ Infra │ ▣▾ +2 │ ‖ alpha ▣ │ beta ▣▣ │ gamma ▣ │ + │ [Search...]  ✉ 🗓 ☑ ⚙
    │ ▔▔▔▔▔▔▔▔▔▔▔▔▔ Thesis colour line spans the box pill AND its member strip ▔▔▔▔▔▔│
```
- `⬡▾` logo = drag + root console (unchanged); caret still opens root /
  All projects / settings-ish rows, now **also on click (toggle)**.
- `▣ Thesis ✕`: selected box pill carries a visible `✕` ("Show all projects",
  title says so). It is the same action as the menu's "All projects": unslice
  and return to the last unsliced project. Shown always on the selected pill,
  never hover-only. `active` keeps today's box-coloured top line; **visiting a
  member** keeps the pill lit in the box colour but with the line on the member
  (already so) and the region line below tinting the whole strip, so slice = tinted
  strip, scope = line over the lit pill. Static `border`/`background-color` only.
- `▣▾ +2` (fold pill) is the hidden-box overflow, placed *after* the shown
  pills. It opens the existing `.box-chip-menu` anchored under itself. The
  "+N" leaves the logo caret.
- Member pills keep the swatch; **swatch click opens that box** (menu of boxes
  when it is in several), hit area >= 16 px (padding on the span, `stopPropagation`).
- Outside a slice the row is the same minus `✕`; no box -> the row is one quiet
  `▣ +` pill (tooltip "New box"; first-use discovery, hidden once any box exists).

### 2.2 Header, narrow

```
 tier 2 (900-1100):  ⬡▾ │ ▣ Thesis ✕ │ ▣ Paper │ ▣▾ +3 │ ‖ alpha ▣ │ beta ▣▣ │ >  │ + │ [Search..]
                         labels capped at ~96 px, at most 3 pills incl. the selected one
 tier 3 (< 900):     ⬡▾ │ ▣ Thesis ✕ │ ▣▾ 4 │ ‖ alpha │ beta │ >  │ + │ [Se..]
                         only the selected box (label ~80 px) + the fold pill
 no box selected, tier 3:  ⬡▾ │ ▣▾ 4 │ ‖ alpha │ beta │ ...
```
The budget replaces the fixed `MAX_BOX_PILLS`: tier 0-1 = 6 (as today),
2 = 3, 3 = 1. The selected box always keeps its pill (existing rule at
`BoxScopeChip.tsx:167-175`); the user's "hide pill" checkbox still applies first.
Tier comes from `headerWidthTier`, which `HeaderBar` owns; expose it through a
tiny store/context rather than re-measuring. CSS only caps label width.

### 2.3 Menus (all on the one shared `.box-chip-menu` / `.context-menu` scheme)

Chip / fold-pill menu (rows reuse today's markup; additions marked +):
```
 ★ Root project                    Ctrl+Shift+R
 ──────────────
 ◉ All projects                    (current when no slice)
 ──────────────
 Boxes                      (+ shown on the row ☑)
 ☑ ▣ Thesis       ▮▮▯  4         <- check = box scope, bold = slice
 ☑ ▣ Paper        ▯▯▯  2
 ☐ ▣ Infra             3
 ──────────────
 New box...   Edit boxes...
```
Rows are unchanged except that the menu now also opens from the fold pill and
by click; `✓` marks the *scope* box, bold the *slice* box, so the two states
have two visible marks.

ProjectSearch (empty focus, wide popover, same `.project-search-row`s):
```
 [ 🔍 |                        ]
 Boxes
  ▣ Thesis      4 members: alpha, beta, ...      <- coloured BoxSwatch, not HexagonIcon
  ▣ Paper       2 members: alpha, gamma
 Open projects                   (jump mode: as today)
  alpha  open   ▣ ▣
```
Typing matches a box by its name **or a member's name**; project rows show
their box swatches; when inside a box a first row "All projects" appears.

Palette (Ctrl+K): new group "Boxes" (rows `box:<id>`, run = `selectBox`-equivalent
`openBox`), action rows "Show all projects" (only when sliced), and tab rows of
box scopes carry the box name as `detail`.

Keyboard: `cycleBox`'s ring becomes `[project you came from, box1 ... boxN]`:
the step past the last box returns to the project (and unslices) -- one chord
is a full round trip. `cycleBoxBack` mirrors it. Steering's `/` jump uses the
search change above; no new steering keys.

Popout: titlebar shows `▣ <box name>` in box colour before `windowName` when
the window's scope is `box:<id>` (data already shipped: `detached.ts:901-907`).

## 3. Changes (ordered)

| # | Step | Files | Size | Lens conflict |
|---|---|---|---|---|
| 1 | Selected-pill `✕` + region tint + scope-vs-slice marks; click-toggle on caret | `BoxScopeChip.tsx`, `ProjectSwitcher.tsx` (pass `onLeave`), `projects-tabs.css`, `i18n/en.ts` (+de/fr/es/it) | S-M | A: same file as context-menu edits; keep to chip/pill markup |
| 2 | Width budget + fold pill (move "+N") | `BoxScopeChip.tsx`, `HeaderBar.tsx` (publish tier), `projects-tabs.css`, `headerPins.ts` (budget helper) | M | A: "New/Edit boxes" rows stay as is; B: none |
| 3 | Empty-state `▣ +` pill (first-use) | `BoxScopeChip.tsx`, `boxEditor` `openCreate` | S | **A owns "create"; this only calls `openCreate()`** |
| 4 | Boxes in `ProjectSearch` (focus list, member-name match, coloured swatch, box swatches on project rows, "All projects" row) | `ProjectSearch.tsx`, `apps.css` search rows | M | none |
| 5 | Palette: Boxes group, scope names for box tabs, "Show all projects" | `CommandPalette.tsx`, `i18n/en.ts` | S | B: tab-row naming also used by arrangement lens -- agree on `name(scope)` |
| 6 | `cycleBox` ring with return stop; `cycleProject` honours the slice | `useKeyboard.ts` (`cycleBox`, `cycleProject`), `keyboardSteering.projectStations` | S-M | none; test in `__tests__/shortcuts` |
| 7 | Swatch click -> open box (menu when several) | `ProjectPill.tsx` (swatch span only), `ContextMenuPortal` | S | A: pill menu Boxes group is theirs; do not touch it |
| 8 | Popout titlebar box mark | `DetachedCenterPanel.tsx`, `detached.ts` | S | B: popout titlebar/tab chrome |
| 9 | Box pill status strip: also count members' agent scopes | `BoxScopeChip.tsx` (`ScopeSetStatusBars scopes`) | S | B if members' tabs move into box scope |

Tests: extend `BoxRendering`, `BoxUx`, `BoxSearch` vitest suites; add a
width-tier case; register new un-live-verified surfaces with `UntestedTag`
rows (`src/lib/untested.ts`). Order 1 -> 2 -> 4 -> 5 -> 6 delivers most of the
value; 3, 7, 8, 9 are polish. Frontend-only: `src/` hot reloads; no backend gate.

Rules checked: rounded corners only (reuse `.box-chip` radius tokens, no clip-path);
all strings through `useT()` (`boxChip.leaveTitle`, `boxChip.foldTitle`,
`palette.group.boxes`, `palette.action.showAllProjects`, `projectSearch.groupBoxes`);
no `box-shadow` animation (tint is a static background/border); no new menu look.

## 4. Decisions for the user

1. **What does the slice do on entering a box?**
   (a) Keep hiding non-members, add the visible `✕` + tinted strip (recommended:
   it is what the 2026-09 round asked for -- boxed projects visible -- and the
   `✕` removes the trap). (b) Dim instead of hide: nothing reshuffles, but a long
   strip stays long. (c) No slice at all: entering a box only changes the scope.
2. **Narrow-window policy.**
   (a) Tier-based budget (6/3/1) with the fold pill (recommended: reuses
   `headerWidthTier`, predictable). (b) Always a single "current box ▾" pill
   at every width: simplest, but one more click for box-to-box switching.
   (c) Leave the cap at 6 and only shrink labels.
3. **`cycleBox` and exit.**
   (a) The ring includes the project you came from (recommended: one chord, no
   new binding). (b) A separate `leaveBox` chord. (c) Unchanged.
4. **Where boxes show up for typing.**
   (a) Search focus list + palette group + member-name match (recommended:
   covers mouse and keyboard with existing components). (b) Palette only.
   (c) A new dedicated box switcher popup (more code, a second look).
5. **Swatch on a member pill.**
   (a) Click opens the box (recommended: closes the member -> box loop in one
   click). (b) Leave inert; use the pill menu. (c) Hover card lists boxes
   with "Open" links (needs the hover-card to take clicks).
