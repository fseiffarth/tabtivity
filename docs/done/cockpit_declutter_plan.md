# Cockpit declutter

Status: **plan** (2026-11-06). The user found the cockpit window (Now,
Projects, Tonight, Usage) "very crowded" and approved a redesign. Mockups: design canvas
https://claude.ai/artifact/BP72ZyPEaJ5GvmUR3nSnNU (one artboard per view).
Design background: `docs/context/cockpit.md`; file rows: `docs/filemap_frontend.md`
(grep `cockpit`). Handoff: `docs/cockpit_declutter_handoff.md`.

This is a layout and density pass. No new backend reads, no new stores, no
new commands. Every view still renders what it renders today; it just renders
less of it at once, in fewer boxes.

**Sibling plan:** `docs/cockpit_apps_merge_plan.md` (plan only, another session)
dissolves Usage into Agents / Models / Machines views (its S2). This plan
therefore builds Usage's machine list as its **own component**
(`CockpitMachineList`) so S2 can move it into the Machines view unchanged.
Don't touch the view ids, the strip, or `views.ts`.

## Fixed decisions (the user's, 2026-11-06)

1. **Projects = compact rows**, not cards. One row per project, ~34 px:
   state dot · name + kind marker · agents · git · hosts · today · last active
   · actions. Clicking the row opens the project (today's Open). New agent tab /
   Agents / ⋯ (Restore) show on row hover and on keyboard focus within the row.
2. **Not-open projects fold per box**: under each box's open rows, one dim
   line `Not open · N` followed by the names as small buttons. A click opens
   the project (= today's not-open "Open"). The only other action, Restore
   tabs, goes in the button's context menu or a `title` hint plus the row's ⋯
   menu. Take whichever is closer to an existing shared menu in the code. A box
   with no open project is only its heading plus that line.
3. **Usage machines = one row per machine.** Project hosts (primary +
   `compute_hosts`) and global machines merge, keyed by host name. Each row
   shows the machine lamp, the name, a state word, the projects that use it as
   chips (each chip with a small dot for that project's own SSH state) and
   one Connect button for any project that is not connected. With one such
   project the button opens it directly. With several, a menu lists them, and
   picking one calls today's `useRemoteMachinesStore.getState().open(projectId)`.
   **Which lamp the row shows:** the global machine's status when the host is
   a global machine, else connected if any project session is connected, else
   the worst state among them.
4. **Now's detail pane follows the latest working agent** when nothing is
   picked: `shownId = selected ?? decisions.topAsking ?? followId`. Keep
   `followId` while that agent is still working. Re-pick only when it stops,
   so the pane does not churn, since every switch re-attaches a terminal. A
   one-line strip in the detail pane says it is following and that picking a
   row pins it. A picked row (`selected`) wins as today.

## Decided here (the approved mockup)

- **No per-view heading row.** `CockpitViewHeading` renders no `<h2>`. Its
  `UntestedTag` pill stays, moved into the view's existing first row (Now:
  roster head; Projects: toolbar; Tonight: first section head; Usage: first
  section head). Keep the literal-id rule (`npm run untested -- list` reads
  them off the source). Simplest shape: `CockpitViewHeading` becomes the pill only
  (`CockpitUntested view=…`), placed by each view.
- **Flat columns.** Now's rail / roster / detail, Tonight's two halves and
  Usage's columns lose their filled grey panel background, border and radius.
  Columns are separated by one hairline (`var(--border-subtle)`). Use theme
  tokens only, no hex. Check `src/styles/cockpit.css` for the panel rule (likely
  `.cockpit-column`, `.cockpit-rail`, `.cockpit-tonight-*`, `.cockpit-usage-*`).
- **Approvals only in the title-bar pill.** The Needs-you rail drops its
  `approvals` group, so `RootReviewStrip` is no longer rendered there.
  `decisions.ts` still counts approvals for the header badge
  (`cockpitBadge`); only the rail stops drawing that group. The icon rail
  (`CockpitRailIcons`) drops it too.
- **Alerts heading once (bug).** The rail's `Group` heading "Alerts N" and
  `AlertsMenu`'s own title row ("Alerts (N) ⟳") both draw. Give `AlertsMenu`
  an opt-in `bare` / `hideTitle` prop that suppresses its title row. Move its
  ⟳ refresh into the rail group heading (the `Group` takes an optional
  trailing control). Default unchanged for the header's AlertsMenu.
- **Roster toolbar.** Keep the filter input and the status segment (Active /
  Asking / Working / Done / All). Grouping (Flat / By project / By box) and
  sort (Last working …) become one menu button labelled
  `<grouping> · <sort> ▾`, in the shared popover scheme
  (`ContextMenuPortal` / `.tab-new-menu`). Their rebindable `cockpit*`
  steering keys keep working (they call store setters, not buttons). Check
  `steeringBindings`.
- **Roster count**: `Agents  4 of 104` (shown of total) when a filter or
  segment hides rows; `Agents 104` when none does.
- **Status dot**: the roster row's dot is filled in the state's colour
  (working, asking, interrupted, done, idle). Use the existing lamp/dot classes
  or tokens the roster or `PillStatusBars` already use. Don't add a new colour
  scheme. Today every row shows the same hollow ○ while "4 working".
- **Project row content** (`CockpitProjects.tsx` + `lib/cockpit/projectCards.ts`):
  - agents: only non-zero parts, working first: `4 working · 17 agents`,
    `1 asking · 3 agents`, or just `8 agents` (dim when nothing is
    working or asking). A not-loaded project never reaches a row (it is in the
    fold).
  - git: a small dot plus a short word (`changes`, `clean`, `unpushed`,
    `staged`, `broken`, `—` for unknown). No red text: dirty is amber
    (`--warning`), broken is the danger token.
  - push / sync chips: keep them, compact, in the git cell after the word.
  - hosts: one summary `N hosts · all off` / `2 of 6 on`, or the single
    host's name and state when N = 1. The full per-host list goes in the
    cell's `title`. Then `· runs on <label>` when a run host is set.
  - today / last active: today's `timeTodaySecs` / `lastActivityAt`;
    empty cell when absent (never `0`).
  - kind: a small marker with the kind label as `title` (L / R / VM / C, or
    an existing icon if one fits).
  - A column header row (`Project · Agents · Git · Hosts · Today · Last
    active`) under a toolbar that has the view's filter input (filter by name,
    local state) and a count line (`27 projects · 13 open · 1 working`).
  - Box group label: keep `tab-new-menu-group-label`.
- **Run host label (bug).** `run_host` is a `TabLocation`: `"local"`,
  `"remote"` or `"host:<id>"`. Today both Projects and Usage print it raw
  (`runs on host:56bc0dda-…`). Add a pure `runHostLabel(project, location, t)`
  (in `lib/cockpit/projectCards.ts` or next to `projectTabHost.ts`):
  `"host:<id>"` → that compute host's `label || host || id`, `"remote"` → the
  primary's `remote.host`, `"local"` → the i18n "this machine". Use it in both
  views. Unit test.
- **Tonight empty state.** Both sections stop stretching to full height. When
  a section is empty it is its heading line plus one muted line. Lay the view
  out as one centred column (max-width ~880 px) in the wide band, sections
  stacked, instead of two full-height side-by-side panels. Rows, when there are
  any, stay today's rows.
- **Usage layout.** Top strip: Agent CLIs (`CliOverviewBody`, unchanged
  component) beside This machine (`MachineMeters`, unchanged). Below, full
  width: `CockpitMachineList` (new file `cockpit/CockpitMachineList.tsx`, with
  its pure grouping in `lib/cockpit/machines.ts` plus a test). The "Open
  machines" button stays (as `Manage machines…`) in the list heading.
  **No Sign-in buttons**: the mockup's are not approved. Show
  `CliOverviewBody` as it is.
- **Narrow / mid bands** keep working. Projects rows: under the `mid` band,
  hide Today and Last active. Under `narrow`, the row is name + agents + git and
  the actions move into ⋯. Read the band from `FrameBandContext` /
  `data-band` as the other views do.
- i18n: every new string through `useT()`, English in `en.ts`; other
  dictionaries get the keys too if the repo's i18n test demands it (check
  `src/__tests__` for a key-parity test). Remove keys that are no longer used
  only if a test flags them.
- Untested: the four view pills stay on the existing register ids. Add no new
  ids unless a new visible feature needs one: the follow strip
  (`cockpit.now.follow`) and the machine list (`cockpit.usage.machines`) do. Add
  their rows in `src/lib/untested.ts`.
- No `box-shadow` animation, no new animation loops (WebKitGTK rule).

## Steps (commit units)

1. **D1 — chrome + Now.** Heading row removal, flat columns, alerts heading
   fix (`AlertsMenu` prop), approvals group out of the rail and icon rail,
   roster toolbar menu, `N of M` count, filled state dots, detail follow
   (`followId` with the stickiness rule, plus a test of the pure pick function,
   e.g. in `lib/cockpit/roster.ts`).
   Files: `CockpitViewHeading.tsx`, `CockpitNow.tsx`, `CockpitRail.tsx`,
   `CockpitRailIcons.tsx`, `CockpitRoster.tsx`, `CockpitDetail*.tsx`,
   `header/AlertsMenu.tsx`, `lib/cockpit/{roster,decisions}.ts`, `cockpit.css`.
2. **D2 — Projects rows.** `CockpitProjects.tsx`, `lib/cockpit/projectCards.ts`
   (row model: agents summary, host summary, `runHostLabel`), `cockpit.css`.
   Update or extend the existing `projectCards` tests.
3. **D3 — Tonight + Usage.** `CockpitTonight.tsx` layout,
   `CockpitUsage.tsx` strip, new `CockpitMachineList.tsx` +
   `lib/cockpit/machines.ts` (+ test), `cockpit.css`.
4. **D4 — docs.** `docs/context/cockpit.md` (only the sentences this
   changes), the filemap rows for the touched/new files (one line each),
   `untested.ts` rows.

## Organisation

Small and frontend-only, so **one implementer** (Sonnet, the user's choice) in
one worktree, D1→D4 as separate commits. The main agent checks the gates in a
clean tree and lands. No per-step reviewer. Why: one subsystem, ~10 files, no
invariant-bearing code.

## Out of scope

Mail / calendar / to-do / the Usage dissolution (the sibling plan), the Root
view, the phone, any backend.
