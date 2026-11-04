# Cockpit + root console: visual and interaction design

Status: **design only.** Nothing here is implemented. Architecture, ownership,
steps and gates are in `docs/cockpit_root_merge_plan.md`; this document is the
layout and behaviour the plan defers to. Written 2026-11-04 on develop.
Reviewed 2026-11-04: every choice that differs from the plan is now one of the
plan's **Open decisions** (`docs/cockpit_root_merge_plan.md`); recommendations
below that differ from the plan's are marked "Reviewer" or listed in the
reconciliation table at the end. Layout A is the shape the plan's steps build.

Mockups (light and dark, every view, both alternatives, narrow window, empty and
off states): https://claude.ai/artifact/L3JgYc5cdkvuaur9zLKqzf (private; the
source is `tmp/cockpit_root_merge/index.html`, gitignored).

Basis: the user's cockpit canvas (https://claude.ai/artifact/SnNxvyuUSCibTE8RRqZAkr:
Now, Projects, Tonight, Usage; read, not modified) and the shipped chrome of
`RootOverlay` and `CockpitOverlayHost`. The mockups use the app's own tokens
(`fancy_dark`, `fancy_light`), radius 6/10/14, static shadows, no motion.

## Recommendation in two sentences

One floating window with one title bar that never changes: the four overview
views (Now, Projects, Tonight, Usage), a divider, then **Root** as a fifth view
that holds today's console unchanged inside (its tab strip drops to a sub-bar).
Root agents are also ordinary roster rows, so Now follows them in the detail
pane, and a 40 px icon rail keeps the Needs-you decisions in sight inside Root.

## Anatomy

```
┌ ◎ Cockpit  [Now][Projects][Tonight][Usage] │ [★ Root ②]     Box ▾  ★▸  ✓ Approvals 2 ▾  ⤢  ✕ ┐  title bar (stable)
├ [claude ●][codex ◌][shell][+]                        tools on  ◫ ┤                              sub-bar: Root view only
├────────────────────────────────────────────────────────────────┤
│ body: the shown view (only it is mounted)                       │
└────────────────────────────────────────────────────────────────┘
```

- **Frame.** `useFloatingFrame` (grips, drag the bar, double-click fills, ⤢),
  `.root-overlay.subwindow` chrome, `--accent` border, `--shadow-3` static. One
  remembered frame for all views. A window that jumps between views is the thing
  `mail-todo.css` already avoids for the header overlays, so Root takes the
  cockpit's size when the experiment is on (`min(1680px, 100vw-24px)`), and the
  console's own size when it is off (matches plan decision 5).
- **Title bar.** Glyph mark, label, `UntestedTag`, the view tabs as the shipped
  `.tab` strip (underline and wash; the canvas's purple segmented control is not
  used), divider, **Root** tab. Right cluster: box filter (cockpit views only),
  star button (dock, optional), the one `OverlayApprovals` pill, ⤢, ✕.
- **Root tab lamp.** A count pill (amber) when any root tab asks, the dotted
  working ring when one works. It reads the live activity store only, like the
  header badge, so it costs nothing while another view is shown.
- **Sub-bar (Root view).** The root layout's sole-group strip and `+`
  (`NewTabMenu`), then `RootRightsBadge` and the ◫ file toggle. Split, each
  subwindow carries its own strip (as `RootOverlay` does today) and the sub-bar
  disappears.

## Layout per view

### Now

Rail | roster | detail, as the canvas and the shipped `CockpitNow`
(300 / flex / 560 default, grips, widths in localStorage). Changes:

- Root agents are roster rows with a **star "Root" chip** in the project slot
  (instead of a project name) and a Root-coloured stripe. They sit in the same
  state groups as every other agent.
- Selecting one draws it in the detail pane through `AttachedAgentPane`
  (`readerAlways`). The old "The root console is open and shows this tab" note
  goes away: Now and Root are never mounted together, so the one-visible-view
  rule holds by construction.
- The detail pane's primary button on a root row reads **Open in Root**. Enter
  on a root row switches to Root with that tab active (no jump to a project,
  no close). Enter on any other row is unchanged (jump, close).
- The rail's "Root approvals" group stays; Open opens the ✓ panel.

### Root

Body = `[icon rail 40 px][region]`. The region is today's console: sub-bar,
layout tree, pane layer, ◫ file column, viewers, `+` menu, drag, all unchanged.

- **Icon rail.** One icon per Needs-you group with its count, amber for asking,
  red for interrupted. v1 shows only groups read from live stores (asking,
  interrupted, root approvals, finished-not-seen, alerts), like the header badge.
  Push, schedule and markup groups need backend reads and appear when the full
  rail is open. The top button, or a count click, opens the real `CockpitRail`
  (220 to 300 px) beside the region, scrolled to that group. Collapsed by
  default; state per machine. It is the answer to the plan's open question
  "a slimmer Needs-you column beside the root tabs".
- The rail never takes keyboard focus from a terminal; it is reached by click or
  Tab from the sub-bar.
- ✓ Approvals is the title bar's pill (no second one); the panel is
  `RootReviewStrip` with the advisory line, as now.

### Projects, Tonight, Usage

Bodies exactly as shipped (and as the canvas). Only the title bar around them
changes. Optional dock: the star button docks a root agent column on the right
(`OverlayAgentColumn`, as in mail, calendar and to-do; Ctrl+1..9 as there). In
Now the same button simply selects the docked or last root agent in the detail
pane, because Now already has a right-hand pane.

### Narrow window

Minimum window 800x600, so the frame is 776 px; `cockpit.css` has no breakpoint
today, so Now overflows. Breakpoints on the frame's width (container query on the
body), not the viewport:

| Frame width | Title bar | Now | Root |
|---|---|---|---|
| 1180 px and up | label, all controls | rail, roster, detail | icon rail, region |
| 820 to 1179 px | label | rail becomes the icon rail (the same component as Root's); roster and detail side by side, detail min 360 | same |
| below 820 px | label hidden (glyph keeps `title`); box filter folds into a ▾ icon | master and detail: the roster fills the width, a **Needs you N** chip opens the rail in a popover (`ContextMenuPortal`), selecting a row replaces the roster with the detail and a **Agents** back button (Esc or back returns) | no icon rail; sub-bar strip scrolls with its existing chevrons |

Projects' grid is `auto-fill`; Tonight and Usage stack their two columns below
820 px. The canvas's answer (stack the three columns) is replaced because it
makes the detail pane a scroll away from the list on an 800x600 screen.

### Empty and off

- **Experiment off.** The merged component renders only Root, with the strip in
  the title bar and no sub-bar, no icon rail, no view tabs: pixel-compatible with
  today's console. The label is the console's (no label, star mark).
- **Experiment on, no root tab.** Root's empty card gains one primary action,
  "Start <default agent> in Root" (one click, per the install-flow rule), and the
  `+` menu stays beside it. Today it is text only.
- **Experiment on, Now quiet.** Rail "Nothing is waiting for you."; roster
  "No agent is running" with the same Start-in-Root button; detail "Pick an agent
  to follow it here." (existing keys).

## Alternatives for the one real layout choice

**Where the root terminal tabs live.**

- **A (recommended). Root is a fifth view; its strip is a sub-bar.** The title
  bar is identical in every view, so the muscle memory of the view tabs never
  shifts. The split layout keeps per-group strips (its own rule today) with no
  special casing against the view tabs. Cost: a 34 px extra row in Root only, and
  root tab lamps are visible elsewhere only as the Root tab's rolled-up lamp (the
  Needs-you rail shows them in full anyway).
- **B. Views are pinned tabs and root tabs follow in the same strip.** Saves the
  row, and every root lamp is visible in every view. Cost: at 776 px the views
  and four root tabs do not fit and scroll behind chevrons (mockup B), a tab means
  two different things (view versus PTY, close button on one kind only), a split
  console needs strips inside groups while the bar still holds the views, and tab
  drag and drop must exclude the pinned ones. The plan lists this as the
  non-recommended shape for the same reasons.

Smaller choices, each with a recommendation:

| Choice | Recommended | Other |
|---|---|---|
| Icon rail in Root | Yes, collapsed, live-store groups only | None: Root stays a bare console; decisions are one view away |
| Dock in the cockpit views | Reviewer: skip for now. Not cheap: `overlayAgent.docks` and the Ctrl+1..9 routing (`frontAppOverlay`) are keyed per `SteeringApp`, so it needs a fourth dock key | Yes, as its own step (plan A10) |
| Ctrl+Shift+R when open on another view | Switch to Root; close only when already on Root | Plain toggle (closes from any view) |
| View tab label | "Root" with the star | "Terminals" (plan wording) |
| Window label with the experiment on | "Cockpit" | "Root console" (plan decision 4) |

## Doors, keys and focus

| Door | Behaviour |
|---|---|
| Header cockpit button | Toggles the window on the last view; badge unchanged (plan decision 4 recommends always `Now`) |
| `U` in steering | Opens on the last view, enters the overlay region (plan decision 4: `Now`) |
| Ctrl+Shift+R | Closed: open on Root, active root terminal focused. On another view: switch to Root. On Root: close. Experiment off: the old toggle |
| Project header's Root chip, Ctrl+Shift+S, install and login flows | Open on Root with the tab revealed (as today) |
| Enter on a root roster row | Switch to Root, that tab active |
| Ctrl+1..9 | Optional dock, as in the other overlays |
| Esc | Closes from the bar, rail, roster or a view. Inside a terminal, the Reader, or a docked agent it is the agent's. Open menus and the approvals panel first |

Focus order: view tablist (roving Left and Right, Enter or Space picks; it is
`role="tablist"` already), then the view's controls, then the body. Opening on a
view focuses its primary target: the active terminal (Root), the roster list
(Now, `.cockpit-roster-list`). Switching view by tab click keeps focus on the
tablist. Terminals own the keyboard, so there is no key from a Root terminal to
Now except closing and reopening; a global rebindable cockpit chord would fix
that (open question below).

## Against the canvas and against today's RootOverlay

Against the canvas: shipped tab strip instead of segmented control; **Root** tab
where the canvas shows the later "Sphere" slot (Sphere, when it comes, joins the
four views before the divider); the canvas's header "Root" pill is the project
header's Root chip and now opens the Root view; "Approvals" is the shipped
`OverlayApprovals` pill; the canvas's `max-width:1100px` stacking is replaced by
the frame-width breakpoints above; the collapsed icon rail, Root rows with the
star chip, and Start-in-Root actions are new.

Against `RootOverlay`: two controls move (its own ✓ pill becomes
`OverlayApprovals`; `RootRightsBadge` moves from the title bar to the sub-bar); the
sole-group strip leaves the title bar when the experiment is on; the untouched
default size grows with the experiment; the empty card gets an action; Escape
also ignores `.cockpit-detail-pane` (already true of the cockpit's handler).

## Components reused (real paths)

- `src/components/common/useFloatingFrame.tsx`, `src/styles/subwindows.css`
  (`.root-overlay*`, `.tab-bar`, `.tab-strip`, `.tab`), `src/styles/mail-todo.css`
- `src/components/layout/RootOverlay.tsx` (layout tree, pane layer, `GroupStrip`,
  file column), `src/components/layout/RootRightsBadge.tsx`
- `src/components/layout/OverlayApprovals.tsx`, `RootReviewStrip.tsx`
- `src/components/cockpit/CockpitRail.tsx`, `CockpitRoster.tsx`,
  `CockpitDetailPane.tsx`, `CockpitDetail.tsx`, `CockpitProjects.tsx`,
  `CockpitTonight.tsx`, `CockpitUsage.tsx`
- `src/components/layout/AttachedAgentPane.tsx`, `OverlayAgentColumn.tsx` +
  `useOverlayAgent.ts` (dock), `ContextMenuPortal` (narrow Needs-you popover)
- `src/components/layout/StarIcon.tsx` (the star), `src/components/common/icons/Icon.tsx`
  (close; new glyphs there, never in JSX text), `UntestedTag`,
  `src/components/tabs/NewTabMenu.tsx`
- `src/styles/cockpit.css` (add the container breakpoints and the icon rail here)

No new variants: the icon rail is `CockpitRail`'s data in a different density, and
the narrow popover is the same rail in a portal.

## New i18n keys (all five dictionaries, English holds every key)

- `cockpit.view.root` ("Root"), `cockpit.view.rootHint`
  ("Root console · {chord}"), `cockpit.view.rootAsking` (aria for the lamp:
  "{count} root tabs asking")
- `cockpit.rail.collapsed` ("Needs you, {count}"), `cockpit.rail.expand`,
  `cockpit.rail.collapse`
- `cockpit.narrow.needsYou` ("Needs you {count}"), `cockpit.narrow.back` ("Agents")
- `cockpit.roster.rootChip` ("Root"), `cockpit.detail.openInRoot` ("Open in Root")
- `rootConsole.emptyStart` ("Start {agent} in Root")
- `cockpit.dock.toggle` (optional dock button title)
- `cockpit.keys.root` (rebindable steering label, if a Root key is added)
- Removed: `cockpit.detail.inConsole` (as the plan says).

## For the plan

All ten points are now covered by the plan's steps (M0-M9, A1-A10) or its Open
decisions; the list is kept as the design's own notes.

1. **Strip placement.** Under A the Root sub-bar needs no bar slot when the
   experiment is on; the slot in M1 is still needed for the experiment-off look,
   and for the split case nothing changes. Say which of the two layouts the bar
   slot serves.
2. **`CockpitIndicator`, U and the box chip land on the last view, not always
   Now** (design) versus Now (plan). Decide once.
3. **Icon rail** adds a live-store read to Root (no backend fan-out) and a
   second `CockpitRail` mount point; keep the "nothing runs while shut" rule: its
   counts must not call `usePushRequests`, `useMarkupAsks`, `useLoadSchedules`.
4. **Narrow layouts** are new work in M2's CSS (container queries on the body)
   plus a small master and detail state in `CockpitNow` (selected row opens the
   pane, back button). Not in any step today.
5. **Root tab lamp** on the title bar tab: derive from `stores/activity` /
   `agentRosterFacts` for `ROOT_SCOPE`, no timers.
6. **Dock in cockpit views** is optional and extends `useOverlayAgent`/
   `OverlayAgentColumn` to a fourth host; the plan keeps those unchanged. Treat
   as a separate step after A5 or drop.
7. **Root's empty card** action calls the same default-agent door the `+` menu
   uses (`useAddTabMenuData(ROOT_SCOPE)` -> `agentShortcutSlots`), and respects
   the Root chip (`overlayAgent.rootNotAllowed` hint when none).
8. **Escape/focus**: add `.root-overlay-region` and `.overlay-agent-column` to
   the ignore list; the roving tablist keys are new.
9. **Global chord for the cockpit** (reach Now from a Root terminal by keyboard):
   open question for the user; `shortcuts.ts` has Ctrl+Shift+R only.
10. **Tests/docs**: untested register rows for the icon rail, narrow layouts and
    Start-in-Root; `docs/context/root_console.md` and `cockpit.md` get the new
    anatomy; the canvas stays as is.

## Where design and plan disagree

Resolved by the review: each real choice is now an **Open decision** in
`docs/cockpit_root_merge_plan.md` (the user decides; the recommended option is
first). Pointer table only; the plan holds the options and trade-offs.

| Topic | Plan's Open decision |
|---|---|
| Where root tabs sit (sub-bar A, same strip B, plumbing only) | 1 |
| Name of the console view, window label with the experiment on | 3 |
| Ctrl+Shift+R, header gauge, U, box chip (which view they open) | 4 |
| Default size | 5 |
| Root rows, docked root tab in an app overlay | 6 |
| Icon rail, dock in cockpit views, "Start in Root" empty-card action | 7 |
| Narrow window breakpoints | 8 |
| Experiment off | 2 |
| Agreed, no decision: box filter only on cockpit views, ✓ Approvals in the title bar (`OverlayApprovals`), Enter and Space on root rows, popouts, store/key retirement | none |

Reviewer corrections to this document: the star is `layout/StarIcon.tsx`; the
dock is not a one-line extension; the title bar's bar slot is still needed for
the experiment-off look (plan M1), while the sub-bar (plan M3) serves layout A.
The plan's own wording uses **Root** for the view, as this document does.
