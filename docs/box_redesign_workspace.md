# Boxes, redesigned: working inside one (arrangement and organisation)

Status: **design proposal, 2026-11-03. Nothing here is built.** Lens: what a
user sees and does once a `box:<id>` scope is open. Access/switching (header
chip and pills) and creating/managing membership are the other two lenses; this
doc touches them only where a step depends on them (section 3 marks those).
Background: `docs/context/project_boxes.md`, `docs/mobile_box_parity_plan.md`,
TODO 31av/31aw (`todo/group-h-crossplatform.md:2919`). Every box manual-test row
in `todo/group-a-boxes.md` is still unticked: nothing below was seen live.

## 1. Today

### The walk-through

1. The user clicks a box pill. `openBox` only switches the scope
   (`src/stores/boxes.ts:332-396`); `restoreBoxScope` (`:120`) loads
   `sessions/box_<id>/terminals.json`, or seeds one shell at the box folder
   labelled with the box name (`:128`).
2. New tabs default to the box folder (`CenterPanel.tsx:175-180`, `newTabCwd`).
   `PaneSlot` receives `paneBox` but uses it only for the Mobile tmux flag
   (`PaneSlot.tsx:43,124`); `paneProject` is `undefined` in a box, so no pane
   knows which member it belongs to.
3. The strip draws `tab.label` and the kind-colour stripe, nothing else
   (`TabBar.tsx:369`). There is no member field on a tab.
4. The "+" menu (`TabBar.tsx:1857`) lists the ordinary Agents group (all start in
   the box folder), API-key groups, then **Box members**
   (`TabBar.tsx:1914-1950`): per member a `Files — x`, `Shell — x` and
   `Claude — x` row, so 3 x N flat rows, then Local Model, Shell, Files,
   Monitoring, Workspace, Printing, Skills, Prompt chart, Browser, Project.
5. The side panel (`AppShell.tsx:403-422`) shows the shared two-row toolbar
   (views rail, then Files/Git controls) and, in the scroll area, one
   `BoxRootSection` per root (`ProjectFilesPane.tsx:307`, rendered `:924`): the box
   folder, then every member, each fully expanded with its own tree.
6. A member section has a header band (grip, caret, icon, name, `project` tag),
   then a second toolbar line `Files | Git | ⧉ | ⚙ | UntestedTag | Remote/Local`
   (`:413-456`). Git there is history only (`GitHistory`, `:509`).
7. Files opened from a member tree become tabs; `ProjectFilesTab` resolves the
   member from the tab's cwd (`ProjectFilesTab.tsx:78-83`).

### Friction, ranked

1. **Tab ownership is invisible and fragile.** The only record of "which member"
   is the label typed at creation (`newTabMenu.boxMemberShell` = "Shell — {name}",
   `TabBar.tsx:884-890`) plus the cwd, which only the hover card shows
   (`TabHoverCard.tsx:132-147`). Any rename erases it. The generic Agents/Shell/Files
   rows start in the box folder with a bare "Claude" or "Shell" label, so a
   four-member box fills with indistinguishable tabs. The phone has the same hole
   (31av). Nothing marks the whole-box agent as the one that spans members.
2. **The "+" menu repeats itself.** 3 x N rows for N members (12 rows for 4)
   sit in one flat group; the same kinds are offered again higher and lower for
   the box folder, with no cue that they differ. The per-member agent is
   hard-coded to Claude (`TabBar.tsx:900`), ignoring the user's default agent,
   Codex, Gemini and custom agents. The detached popout's menu has only Files and
   Shell per member, no agent row (`NewTabMenu.tsx:261-300`), so the two menus
   already disagree. No Ctrl+T/Ctrl+1 route exists to a member at all.
3. **The side panel spends its height on chrome.** Each member costs a header
   band plus a toolbar line (about 60 px) before its tree, and every tree starts
   expanded. Collapse and the Files/Git choice are plain `useState`
   (`ProjectFilesPane.tsx:334-335`), so they reset whenever the panel remounts. The
   shared in-tree search fold is handed to every mounted tree (`:934`), so
   opening search opens a field per member. The member's dirty state is not in
   its header at all, although the pills already poll it (`ProjectSwitcher.tsx:210`,
   `useGitDirtyStore`).
4. **Git is split across two surfaces.** The side panel's commit/push/pull bar is
   gated off in a box (`ProjectFilesView.tsx:1989`, `!activeBox`); only a
   `Files — x` tab carries a member's full git bar. Nothing says so.
5. **Chrome that ignores the shared look.** `.file-root` is a square-cornered
   bordered block with a 3 px left rail (`styles/projects-tabs.css:834-847`), and
   member sections all share one neutral rail colour, so nothing ties a section to
   its tabs.
6. **Narrow width.** The member toolbar line (two buttons, two icons, a tag, the
   Remote/Local switch pushed right with `marginLeft: auto`) wraps or clips in a
   narrow panel; nothing collapses it.
7. **Cross-member agent scope is unexplained.** A member-rooted agent receives
   the box's read-write union under the fence (`todo/group-a-boxes.md` Phase 8),
   which a "Claude — api" label does not say.

## 2. Proposal: one member colour and one "where" everywhere

Core idea: a tab, a menu row, a side-panel section and (on the phone) a tab
chip all name their member the same way, with the same colour. Placement stops
being a separate row family and becomes a property of the rows that already exist.

**Member colour.** `autoBoxColor(member.id)` (`lib/theme/boxColor.ts`) already
gives a stable, golden-angle-spread hue per id; call it with the project id. No
new picker, no new store. The box folder uses the box's own colour (`boxColor`).

### Tab strip

A small chip after the label: member dot and short name; the box-folder tab
(the whole-box agent) shows the box mark instead. The kind stripe keeps its
meaning; the chip carries ownership. Chip derives from `tab.cwd` (a pure
`memberOfCwd(cwd, members)` beside `boxMembersOfScope`), so renames cannot
erase it and legacy labelled tabs still resolve. Labels for new tabs drop the
" — name" suffix (`Claude`, `Shell`, `Files`) so the chip is not repeated.

```
 normal   [› Shell ●api] [✦ Claude ●api] [✦ Claude ●paper] [✦ Claude ▣box] [▤ Files ●api] +
 narrow   [› ●] [✦ ●] [✦ ●] [✦ ▣] [▤ ●]  +        (name moves to the hover card)
 hover    ┌──────────────────────────────┐
          │ Claude  · api                │   new "Member" row, then the
          │ /home/…/api                  │   existing cwd, sandbox, features
          │ Can also write: paper, box   │   (the box RW union, friction 7)
          └──────────────────────────────┘
```

A tab whose label already contains the member name (legacy "Claude — api")
suppresses the chip's text and keeps only the dot, so nothing prints twice.
Chip text is ellipsised at about 10 characters. No new animation; no shadow.

### "+" menu

The per-member rows go away. The three kinds the user already knows (Agents,
Shell, Files) each get a **Start in…** fly-out, the mechanism agent rows
already use for remote machines (`AddMenuEntry.machineEntries`, ▾ at the row's
right end, `AddTabMenuList.tsx:43,163`; a box has no remote machines, so the
slot is free). The row's one-click default stays the current target.

```
 ┌ New tab in ●api ─────────────────┐   header names the target (decision 3)
 │ 🔎 search…                       │
 │ AGENTS                           │
 │  ✦ Claude                    ▾   │   ▾ opens:
 │  ✦ Codex                     ▾   │   ┌ Start in ───────────┐
 │  ✦ Gemini                    ▾   │   │ ▣ Whole box         │
 │ SHELL                            │   │ ● api               │
 │  › Shell                     ▾   │   │ ● paper             │
 │ FILES                            │   │ ● data              │
 │  ▤ Files                     ▾   │   └─────────────────────┘
 │  …Local Model, Monitoring, …     │
 └──────────────────────────────────┘
```

Gains: any agent (default, Codex, custom) can start in a member, not only
Claude; the popout menu gets it for free because both menus share
`useAddTabMenuData` and `AddTabMenuList`; 3 N rows become 0 rows plus N fly-out
entries. Typing a member name in the menu's search still finds it: the search
filter reads `moreEntries`/`machineEntries` labels, so the fly-out entries are
given a full label ("Claude in api") for that purpose, same as today's rows.
The Box members group is deleted. Keyboard: the new-tab chords open at the
current target (decision 3); no new chord.

### Side panel

An accordion: **one member expanded at a time** (the one the user last
clicked, or the active tab's member), the others a one-line header. The header
carries what the expanded body used to hide: colour dot, name, dirty dot (from
`useGitDirtyStore`), count of that member's agent tabs, and a `⋯` button.
`⋯` is the shared context menu (not a new popup scheme) holding Files/Git,
open in file manager, project settings, Remote/Local, and *Open as tab*
(= `Files — x`, which also carries the commit bar, friction 4). The Files/Git
pair stays as a segmented control only inside the expanded body.

```
 normal (320 px)                         narrow (220 px)
 ┌ Files  Git  Search  … ───────┐        ┌ ▤  ±  🔍 ─────────────┐
 │ ▣ thesis box           ▾     │        │ ▣ thesis        ▾     │
 │   tree of the box folder     │        │   tree…               │
 │ ● api    ●dirty  ✦2    ⋯  ▾  │        │ ● api  ● ✦2   ⋯  ▾   │
 │   [Files|Git]       Remote▾  │        │   [Files|Git]         │
 │   src/                       │        │   src/                │
 │ ● paper  ✦1            ⋯  ▸  │        │ ● paper ✦1    ⋯  ▸    │
 │ ● data   ●dirty        ⋯  ▸  │        │ ● data ●      ⋯  ▸    │
 └──────────────────────────────┘        └───────────────────────┘
```

Rules kept: it is still `ProjectFilesView`'s shared pane (no second host);
sections still use the grip reorder (`useMemberReorder`) and the cross-root
drag-and-drop targets; collapsed state moves to a small persisted map beside
`sidePanelFolderByProject` so it survives remounts; a collapsed section still
accepts a drop (hover-expands after the existing hold delay, as folder rows
do). Remote members: Remote/Local switch and the Connect prompt keep their
current gating on the SSH lamp, and the dirty dot is simply absent (not zero)
for remote members. Hidden panes keep not probing (`PaneVisibleContext`). Shared
search shows one field above the sections and searches the expanded member;
a toggle "all members" is a follow-on.

Chrome: `.file-root` gets the shared panel radius and the member's colour as its
rail instead of the neutral grey, which also answers friction 5. No cut
corners, no box-shadow animation.

### Panes and splits

Opening a member's Files tab beside its agent is the common move. Add one
row to the section `⋯` menu and the tab context menu: **Open beside Claude**
(split with the member's Files on one side, a new agent in that member on the
other), using the existing subwindow/group machinery rather than a new layout.
Optional, last in the order.

### Phone parity

Same derivation, same chip: `PublicTab.member` (31av) renders as a dot-plus-name
chip with the model-tag treatment; the opaque member ids of 31aw drive both the
create row's selector and the dot colour (`autoBoxColor` on the opaque id, so no
raw id leaves the desktop; before 31aw the chip is name-only). The create row's
member selector lists the same order as the desktop "Start in" fly-out. No
side-panel equivalent: the phone has a files library, not box sections.

## 3. Changes (ordered)

| # | Step | Files | Size | Lens risk |
|---|------|-------|------|-----------|
| 1 | `memberOfCwd(cwd, members)` and `memberColor(id)` (wrapper of `autoBoxColor`), pure + tests | `src/stores/boxes.ts`, `src/lib/theme/boxColor.ts`, new `__tests__/boxes/MemberOfCwd.test.ts` | S | Low; both lenses edit `stores/boxes.ts`: add only, do not reshape |
| 2 | Tab member chip (desktop strip, narrow dot-only, hover-card row, popout strip parity) | `components/tabs/TabBar.tsx` (the tab at `:369`), `TabHoverCard.tsx`, popout strip, `styles/projects-tabs.css`, `lib/i18n/en.ts` | M | Low |
| 3 | Drop the " — name" label suffix for new tabs; keep legacy labels | `TabBar.tsx:867-910`, `NewTabMenu.tsx`, `en.ts` | S | None |
| 4 | "Start in" fly-out on Agents/Shell/Files rows; delete the Box members group; one shared `openInMember(kind, member)` helper replaces the three handlers; popout parity | `agentMenuEntries.ts`, `TabBar.tsx:1914`, `NewTabMenu.tsx:261`, `useAddTabMenuData.ts`, `AddTabMenuList.tsx` (search over fly-out labels), `en.ts` | M-L | Medium: lens (a) may change what a bare "+" does on a box pill; the "current target" default (decision 3) must be agreed |
| 5 | Side panel accordion: header facts (dot, dirty, agent count), `⋯` menu, persisted collapse map, one shared search | `files/ProjectFilesPane.tsx` (`BoxRootSection`, `:307-520`), `styles/projects-tabs.css:834+`, `stores/projects.ts` (collapse map), `en.ts` | L | Medium: lens (b) owns member order and the editor; the grip reorder stays as is |
| 6 | Dirty dot reads `useGitDirtyStore`; ensure open-member probe targets cover boxes opened without the pills strip | `ProjectFilesPane.tsx`, `layout/ProjectSwitcher.tsx:210` | S | Medium: touches the switcher lens (a) edits; read-only use of the store avoids it |
| 7 | Phone: `PublicTab.member` + chip (31av), then member selector (31aw) | `services/mobile_control/discovery.rs`, `mobile-web/src/screens/Project.tsx`, `host.rs`, `MobileBridgeHost.tsx` | M each | Low; blocked on 31aa phone QA |
| 8 | "Open beside" split action | tab context menu, `CenterPanel.tsx` group helpers | M | Low; optional |
| 9 | Tests and register: `UntestedTag` rows for the new chip, fly-out and accordion in `lib/untested.ts`; update filemap rows; help doc `docs/help/containers-boxes.md` step 3 | `src/lib/untested.ts`, `docs/filemap_frontend.md`, help doc | S | None |

Order logic: 1-3 are independent and ship the biggest win (ownership) alone;
4 follows once decision 3 is taken; 5-6 are the panel pass; 7-8 trail. Gates
per `AGENTS.md`: `npm run build`, `npm test`, `npm run lint`; step 7 adds the
cargo gates and `npm run backend:stale` plus `npm run mobile:bundle`. All new
strings go through `useT()` with `en.ts` first.

## 4. Decisions for the user

1. **How a tab names its member.**
   (a) Coloured dot-plus-name chip derived from the cwd, dot-only when narrow
   (recommended: survives renames, covers legacy and generic tabs, one look on
   phone). (b) Keep label suffixes only (zero work, still fragile). (c) Group
   tabs into per-member segments in the strip (clear, but costs strip width and
   breaks free drag order).
2. **Shape of the "+" menu in a box.**
   (a) "Start in…" fly-out on the existing Agents/Shell/Files rows (recommended:
   works for every agent, no 3 x N rows, popout parity free). (b) Kind-first rows
   per member kept flat but grouped under a member sub-heading. (c) Keep today's
   rows and only add the missing popout agent row and the default-agent fix
   (smallest, leaves the clutter).
3. **Where a plain "+" or Ctrl+T opens.**
   (a) In the active tab's member, the menu header naming the target (recommended:
   the common case is "another tab for what I am working on"; the chip makes the
   target visible). (b) Always the box folder, as today (predictable, but every
   member tab needs the fly-out). (c) A remembered "current member" picked in the
   side panel (explicit, but adds one more piece of state to keep in sync).
4. **Side panel layout.**
   (a) Accordion, one member expanded, rich one-line headers (recommended: cuts
   height by the most; persisted collapse). (b) All members stay expanded but
   headers slim down to one line and collapse persists (smaller change, still
   tall). (c) A member switcher at the panel top (segmented control) showing one
   member at a time (smallest footprint, loses the at-a-glance dirty overview).
5. **Per-member git in a box.**
   (a) Dirty dot in the header, commit/push through the member's Files tab via
   "Open as tab" (recommended: reuses the one existing git bar; AGENTS.md says
   viewer features live in the shared view). (b) Compact commit bar inside the
   expanded section (more code in `ProjectFilesView`, which assumes one project).
   (c) A box-level git overview of all members (most useful for cross-repo work,
   largest and overlaps lens (b)'s relations idea).
