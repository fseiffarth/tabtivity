# Cockpit: the apps and the system pages as views

Status: **implemented on develop, not live-tested** (2026-11-06, 87e736d8..36602de6;
build log, flagged items and click-through: `docs/cockpit_apps_merge_handoff.md`).
develop's cockpit declutter landed meanwhile; its machine list
(`CockpitMachineList`) is the Machines view's list. The user asked to merge
mail, to-do and calendar into the cockpit, and then models, machines and agents
too, "but leave the option to add them as separate icons into the main rail".
Builds on `docs/cockpit_root_merge_plan.md` (the cockpit and the root console
are one window) and `docs/context/cockpit.md` / `docs/context/root_console.md`
("Views"). Read those first. This plan only says what changes.

## Why

The console window already holds five views (Now, Projects, Tonight, Usage │ ★
Root). Five more cross-project surfaces float as separate overlays, each with its
own frame and Escape handling: Mail (`mail/MailOverlay.tsx`), Calendar
(`calendar/CalendarOverlay.tsx`), To-do (`todo/TodoOverlay.tsx`), Models & agents
(`models/ModelsOverlay.tsx`) and Machines (`header/MachinesOverlay.tsx` +
`MachinesIndicator`). Several mechanisms exist only so those overlays and the window can sit
next to each other:

- `stores/consoleCover` + `lib/window/consoleFront` + `.under-overlay`: Machines /
  Models opened *from* the window must land above it, and one Escape must close
  only one of them.
- `html[data-console-under-overlay]` and `apps.css`'s `--z-modal - 2` rule: mail /
  calendar / to-do drop a layer when the window is under an overlay.
- `CockpitDetailPane`'s `docked` mode ("Shown in the {name} overlay") and
  `OverlayAgentColumn`'s "Shown in the root console" stand-down. Without them, a
  docked root agent could be visible in two places.
- `lib/shortcuts/appOverlays.ts`'s `STACK` / `frontAppOverlay`: which of three
  stacked overlays gets Ctrl+1–9.
- Six frames in localStorage (`rootConsoleFrame` plus one for each overlay).

Inside one window only one view is shown at a time. That makes "one visible
view per PTY" true by construction, and every item above can be deleted.

## Fixed decisions (the user's, 2026-11-06)

1. **Separate icons stay in the top bar.** Each view keeps or gets a
   `HeaderSlot` icon with its live badge; a click opens the window on that view.
   Pin/fold and drag-reorder are the existing `header_pins` / `header_order`.
   The side panel's edge rail is not used.
2. **All six get an icon by default:** ✉ Mail, 🗓 Calendar, ☑ To-do, Agents
   (new item), Models (today's 🧠 `models` item), Machines (today's `machines`
   item, status group). Plus the existing `cockpit` button. In
   `lib/headerPins.ts` this adds `agents` to `HEADER_ITEM_IDS`,
   `PINNED_BY_DEFAULT` and `HEADER_GROUPS.apps`.
3. **A grouped view strip:**
   `Now Projects Tonight │ Mail Calendar To-do │ Agents Models Machines │ ★ Root`.
   Icon + label in the wide band (≥ 1180 px), icons only in the mid band
   (820–1179), a ▾ overflow under 820. It stays the title bar's one strip, so the
   steering chrome level still walks it left/right.
4. **Usage dissolves.** `CliOverviewBody` (plan / token usage) goes to Agents.
   `RunningModelCard` + Unload go to Models. `MachineMeters` and the remote
   hosts / global machines list go to Machines. `CockpitUsage.tsx` and the
   `usage` view id are deleted.

## Decided here (conventions or forced by the code)

- **One frame.** All views share `rootConsoleFrame`. The per-overlay frame
  keys are no longer read (left in localStorage, harmless).
- **Views mount the existing bodies.** `MailPane`, `CalendarPane`, `TodoPane`,
  the Models hub sections, `MachinesSurface`. No copy (AGENTS.md: viewer
  features stay in one shared component; memory "no redundant variants").
- **Mail stays mounted while a composer tab is open.** Today
  `MailOverlayHost` keeps the overlay mounted while hidden, because the
  half-written message lives in the mounted composer. The Mail view keeps
  that exception: hidden but mounted while `mailTabs` has a `compose` tab. Its
  docked agent column still unmounts when hidden, so no PTY stays drawn. Every
  other view mounts only while shown.
- **Mail's own tab strip** (inbox + composer tabs) goes into the sub-bar
  through `RootBarSlots`, the same way Root's strip does.
- **Models & agents splits.** Agents = Settings' `AgentsPanel` + `AgentChips`
  and the Skills library (`SkillsLibraryView projectDir={null}`), plus Usage's
  CLI overview. Models = Local models + Ollama sections. The overview grid of
  four tiles is gone; each view opens straight on its content.
  `modelsOverlay.openOverlay(section)` callers map section → view.
- **The docked root agent stays** in Mail / Calendar / To-do
  (`OverlayAgentColumn`, `useOverlayAgent`, ✦, Ctrl+1–9). Its only
  stand-down left is a popout-owned tab.
- **"Is the app open" becomes derived.** `mail.overlayOpen`,
  `calendar.overlayOpen`, `todo.overlayOpen`, `modelsOverlay.open` and
  `machinesOverlay.open` become `rootOverlay.open && view === X`.
  `openOverlay()` / `closeOverlay()` stay as thin forwarders to
  `openView(X)` / `close()` (about 30 call sites, including the alarm popup, the
  to-do mail rail and the steering M / C / T keys). Mail's `newCount` and the
  calendar's arrival count clear when their view is shown, as they do now
  when the overlay opens.
- **Feature gates hide the view and the icon:** `mail_client`,
  `calendar_global_app`, `todo_board`, `machines_enabled`. A view whose gate
  goes off while shown falls back to Now.
- **Header hover menus stay.** `LocalModelMenu`'s and `MachinesIndicator`'s
  dropdowns keep working; a click (or ⤢) opens the view instead of an
  overlay.
- **Not in popouts, not on the phone.** Unchanged.

## Steps

**S1 — View ids and strip.** `lib/cockpit/views.ts`: replace `usage` with
`mail | calendar | todo | agents | models | machines`, and add a
`VIEW_GROUPS` table. `RootOverlayView` follows. The strip in `RootOverlay.tsx`
renders the groups with dividers, the three bands, and drops views whose gate
is off. i18n keys `cockpit.view.*`. `CockpitViewBody` lazy-loads each new body.

**S2 — Agents / Models / Machines views.** Split `ModelsOverlay.tsx`'s sections
into two view bodies. Move `MachinesSurface` (its overlay layout) into a
Machines view body with `MachineMeters` and Usage's remote list above it.
Delete `CockpitUsage.tsx`, `ModelsOverlay`'s home grid, `MachinesOverlay.tsx`,
the two overlay hosts in `AppShell.tsx`, `stores/consoleCover.ts` and
`lib/window/consoleFront.ts`. The Escape handlers fall back to the shell's one
rule. Check what dialogs raised from these views do: host-key, HPC and monitor
dialogs are mounted in `AppShell` *after* `MachinesOverlayHost` today so they
land on top. They must still land above the window (`--z-modal`).

**S3 — Mail / Calendar / To-do views.** The bodies move under the shell and
their overlay chrome is dropped. `OverlayAgentColumn` becomes a view-level
column. Delete the `docked` mode in `CockpitDetailPane` / `useDockedApp`, the
"Shown in the root console" branch, `data-console-under-overlay` and the
`apps.css` layering rule. `appOverlays.ts` becomes "the shown view, if it is an
app" (no `STACK`). Ctrl+1–9 routing in `useKeyboard` follows. Mail's
keep-alive as decided above.

**S4 — Header.** `headerPins.ts` (`agents` item, defaults per decision 2), an
`AgentsButton` with no badge to start with, and the five existing buttons call
`openView`. The `cockpit` button opens Now, as today. The steering M / C / T keys open
the views. Update `HeaderGlyphs` if Agents needs its own glyph (today's
`BrainGlyph` marks Models & agents and stays on Models).

**S5 — Docs, untested tags, file maps.** Rewrite the overlay sections of
`docs/context/cockpit.md` ("Machines and Models over the window") and
`root_console.md` ("Docked in the app overlays", "Views"). Update the
filemap rows for every file touched or deleted. Add `UntestedTag`s for the new
views and the Agents icon, with rows in `src/lib/untested.ts`.

Order: S1 → S2 → S3 → S4 → S5. S3 is the risky step (mail keep-alive,
docked-agent ownership, Ctrl+1–9). Review it on its own.

## Risks

- **One frame for very different bodies.** Mail wants a large window, Now a
  compact one. If this bothers the user once it is live, a per-view
  "remember size" is a small follow-up. It is not in v1.
- **Mid band with about 10 icons.** That is roughly 400 px of strip in an
  820 px frame next to the ✓ pill. Measure the strip in S1; the ▾ overflow
  could take over earlier.
- **Steering chrome level grows** from 5 view tabs to about 10. Left/right
  still works; no new keys.
- **Tests that assert the overlays' z-order** (`consoleFront`, `appOverlays`,
  `CockpitDetailPane` docked mode) are deleted along with the code, not
  rewritten to pass.

## Verification

Gates per `AGENTS.md` (`scripts/gates.sh`; frontend only, so `npm run build`,
`npm test`, `npm run lint`, `scripts/brand-check.sh`). Live click-through for
the user, since nothing here can be run live by an agent:

1. Click each of the six top-bar icons: the window opens on that view, and a
   second click on the same icon closes it.
2. Mail: start a composer, switch to Now, come back. The draft is still there.
3. Calendar: Ctrl+1 docks a root agent; type "meeting Friday 14:00" and watch it
   land. Switch to Now and select that agent: it attaches there. Back on
   Calendar, the column draws it again.
4. Machines → Add machine / a host-key prompt: the dialog is above the window.
5. Narrow the window below 1180 and then below 820: icons only, then ▾.
6. Turn `mail_client` off: the Mail tab and the ✉ icon are both gone.
