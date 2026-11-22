# Cockpit declutter — handoff

Plan: `docs/cockpit_declutter_plan.md`. Branch `cockpit-declutter` (from `develop`
d6eefa36), four commits D1–D4, not pushed. Frontend only; no backend read, store
or command added. Design notes: `docs/context/cockpit.md` ("Layout").

## Steps

### D1 — chrome + Now (`fcca819c`)

- `CockpitViewHeading.tsx` is now `CockpitUntested.tsx` (the pill only; `git mv`).
  Views keep `role="region"` + `aria-label` from the old heading keys
  (`cockpit.*.heading`, which stay in the dictionaries for that).
- Flat columns: `.cockpit-rail/-roster/-detail` lose fill, border, radius. The one
  hairline (`--border-subtle`) is drawn in the middle of `.cockpit-grip` (still the
  6 px drag target). Mid band's icon rail keeps only a right hairline.
- Approvals out of the rail: `approvals` removed from `DECISION_GROUPS`,
  `DecisionsInput`, `DecisionItems` (so also from `total`, the icon rail, Root's rail
  and the Needs-you chip count). `cockpitBadge` still counts them. Callers
  (`CockpitNow`, `useDecisionsFor`) no longer call `useDomainReview`.
- Alerts: `AlertsMenu` has `bare`; its title row, count and ⟳ are suppressed (only
  the muted-reveal chip survives, when something is muted). The rail's `Group` takes
  `trailing`; the Alerts group puts the ⟳ there.
- Roster: `RosterViewMenu` (`<grouping> · <sort> ▾`, `ContextMenuPortal` +
  `.tab-new-menu`, `menuitemradio` rows). The steering keys call store setters and
  are untouched. Count `4 of 104` (key `cockpit.roster.countOf`) when rows < total.
- State dot: every row draws `DotIcon` filled in the state colour (idle = muted).
- Follow: `pickFollow(rows, followId)` in `lib/cockpit/roster.ts`, tested.
  `shownId = selected ?? topAsking ?? followed`; `followId` is state synced by an
  effect. Strip `cockpit.detail.following` + `UntestedTag cockpit.now.follow`.

Left open by the plan, my choice:
- "latest working" = newest `facts.turnStartedAt` (`workingAt` is `now` for every
  working row); ties keep roster order.
- When the followed agent stops and nobody else works, the pane **stays** on it (a
  finished turn does not blank the pane). It is dropped only if the row is gone.
- Narrow band has no rail column or heading row: the "Needs you N" chip and the
  `cockpit.narrow` pill ride the roster head, and the detail's back bar (one is
  mounted at a time).

### D2 — Projects rows (`b90ccd40`)

- Pure (all tested in `CockpitProjects.test.ts`): `runHostLabel`, `agentsSummary`,
  `hostsSummary`, `splitGroups`, `filterGroups`, `projectTotals`.
- Row = state dot, name button (opens) + L/R/VM/C kind mark, agents, git dot + word
  (+ push / sync chips), hosts, today, last active, actions. Whole row click opens;
  New agent tab / Agents / ⋯ fade in on hover and `:focus-within` (opacity, no
  animation). Mid drops Today and Last active; narrow keeps name + agents + git and
  a ⋯ that holds New agent tab / Agents / Restore.
- Fold: one `Not open · N` line per box with the names as `cockpit-chip-btn`s; click
  opens; right-click offers Restore tabs through `EntryMenu`. Also `title` hint.
- `card.runHost` now carries the resolved name; the raw `host:<id>` is never shown.
- Chose: a project that is `open` but not hydrated (`loaded` false) is in the fold,
  per "a not-loaded project never reaches a row". A loaded project with zero agent
  tabs has an empty agents cell. The box filter stays the header's; the toolbar
  filter is local state.
- Git colours: dirty / staged / unpushed amber (`--warning`), broken `--danger`,
  clean `--success`, unknown muted.
- Fix after the first gate run: `⋯` text glyph tripped the ESLint chrome-glyph
  rule; now `MoreIcon`.

### D3 — Tonight + Usage (`dc53032a`)

- Tonight: `.cockpit-tonight` is one centred column (max 880 px), sections stacked
  and only as tall as their content; the first section got a head line (title +
  pill), so an empty one is head + one muted line.
- Usage: top strip (`CliOverviewBody` | This machine; the Usage pill is on This
  machine's head, the first head the view owns) over `CockpitMachineList`. The old
  "Remote" section is gone; "Open global machines…" became "Manage machines…" in the
  list head. No Sign-in buttons.
- `lib/cockpit/machines.ts` (+ `CockpitMachines.test.ts`): merge key is the lower-cased
  host name (primary: `remote.host`, compute host: `host`); one chip per project
  even if it reaches a machine twice (better state wins); lamp rule exactly as the
  plan; rows sorted by name so they do not reshuffle as lamps change.
- Connect: one disconnected project calls
  `useRemoteMachinesStore.getState().open(projectId)` directly, several give an
  `EntryMenu` of project names. A global-only machine has no Connect (none existed).
- `EntryMenu.tsx` extracted from Projects so both views share it.
- Run host in Usage: shown on the project's chip as `· runs on <name>` (primary
  host only, as before) via `runHostLabel`.

### D4 — docs

This file, the plan, `docs/context/cockpit.md` (new "Layout" section + three
sentences), filemap rows (Now, Projects, Usage). Register: `cockpit.now.follow`,
`cockpit.usage.machines` rows in `src/lib/untested.ts`; `cockpit.rootRail` text
no longer lists root approvals.

## Gates

| Step | brand | whitespace | lint | build | vitest |
|---|---|---|---|---|---|
| D1 | pass | pass | pass (0 errors) | pass | 7909 passed, 2 failed (807/809 files) |
| D2 | pass | pass | pass after the glyph fix | tsc + `npm run build` pass | cockpit + i18n + untested: 181 passed |
| D3 | pass | pass | pass | pass | 7917 passed, 2 failed (807/809 files) |

The failing tests are load flakes under the 809-file run, unrelated to the cockpit,
and pass when run alone: D1 `MobileTerminalTranscript` (expected 4 to be 3) and
`TerminalAiSwitch`; D3 `MobileTerminalTranscript` again and `BibCards`.
Cockpit directory alone: 177 tests in 19 files pass. D2's full `scripts/gates.sh` was
not re-run after the glyph/tsc fixes (lint and `tsc` were run directly; see table).
Rust gates: not applicable, no Rust change.

## Flagged for user

- Nothing was run live. All of it needs a look in the window (layout, hover reveal,
  hairlines in each theme, the follow behaviour with real agents).
- Dead i18n keys left behind (the plan said remove only if a test flags them):
  `cockpit.rail.approvals*`, `cockpit.projects.agents`, `.notOpen`, `.timeToday`,
  `.lastActivity`, `cockpit.usage.remote`, `.openMachines`. Say if you want them swept.
- Decision: pane stays on the last followed agent when nothing works. The other
  reading (blank to "Pick an agent") is a one-line change in `pickFollow`.
- Decision: removing `approvals` from the decision groups also removes it from Root's
  Needs-you rail/icon rail and the chip count (they share `buildDecisions`).
- Narrow band: chip and pill moved into the roster head / back bar; check it feels
  right.
- Usage pill sits on the This machine head, not on the CLIs section (that body is
  `CliOverviewBody`, unchanged).

## Click-through

1. Open the cockpit, Now: no big "Now" title, the pill sits on the Agents head;
   columns have no grey panels, one thin line between them.
2. Needs-you rail: "Alerts N" appears once with a ⟳ at its right end; no root
   approvals group (the title-bar ✓ pill still shows them).
3. Roster toolbar: click `Flat · Last working ▾`, pick By project and Last done;
   the rebound steering keys still move / jump. Type a filter: the head reads
   `4 of 104`. Rows have a filled dot in the state colour.
4. With nothing selected and nothing asking, the detail shows a working agent with
   the "Following…" strip; start a second agent: the pane stays; click a row: the
   strip goes (pinned).
5. Projects: one row per open project; hover shows New agent tab / Agents / ⋯; click
   the row opens the project; the `Not open · N` line per box: click opens, right-click
   Restore tabs. Run host reads as a name. Narrow the window: columns drop, ⋯ holds
   the actions.
6. Tonight: one centred column, empty sections are a head and a muted line.
7. Usage: CLIs beside This machine, then one row per machine; a host used by two
   projects shows two chips and one Connect (menu of projects); Manage machines…
   opens the machines window; the run host shows as a name.
