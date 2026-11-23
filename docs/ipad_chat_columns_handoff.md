# iPad chat in three columns — handoff

Plan: `docs/ipad_chat_columns_plan.md`. Never run live: no iPad, no running app.

## Step 1 — tabs rail and portrait strip

- Start: `bdc2be64b` (`develop`). Commit: `5cc975895` (`feat(mobile): tabs
  rail beside the iPad chat`); this handoff is the commit after it.
- New: `mobile-web/src/components/ChatTabsRail.tsx`, `mobile-web/src/chatRail.ts`,
  `src/__tests__/mobile/MobileChatRail.test.tsx`.
- Touched: `screens/Terminal.tsx`, `style.css`, `prefs.ts` (`chatRailFolded`),
  `api.ts` (`PROJECT_DETAIL_POLL = 5_000`, now also used by `Project.tsx`),
  `components/AgentStatusPill.tsx` (exports `AGENT_STATUS_WORD`), the five
  dictionaries, `src/lib/untested.ts`, `MobileTabletChat.test.tsx` (660 px
  assertion → portrait 660 / split 700 pair), `docs/filemap_frontend.md`,
  `todo/group-h-crossplatform.md` (31cu).

### Choices where the plan left room

- **Portrait strip attribute.** `main` gets `data-rail="strip"` upright (the
  plan named only `open | folded`); the tablet block gives `main` a fourth row
  for it. A phone never gets `data-rail`.
- **Under 1120 px** is decided in script, not CSS: `RAIL_WIDE_QUERY =
  "(min-width:1120px)"` in `chatRail.ts`, read with `useMediaQuery` in
  `Terminal`. `data-rail` is then already `folded`, so the stylesheet needs no
  width condition and `useTier.ts`/the equality test are untouched. While
  forced, the fold button is not drawn (it could not unfold anything).
- **Polling.** The existing open/`visibilitychange` read in `Terminal` also
  takes `detail.tabs`; a `useVisiblePoll` at `PROJECT_DETAIL_POLL` (the project
  screen's cadence, now a shared constant) runs only while the rail or strip is
  on screen (`immediate:false`, `catchUp:false` — the existing effect covers
  both). `sameRailTabs` keeps the old array when nothing drawn changed, so the
  chat does not re-render every 5 s.
- **No flicker on a switch.** `App` re-keys `Terminal` per tab, so a new chat
  would start without tabs and the columns would jump. `chatRail.ts` keeps the
  last list per project in memory (`rememberedRailTabs`) as the first state.
- **Seen state.** A tap marks a done/interrupted tab seen (`markDoneSeen`,
  `markInterruptedSeen`), as the project screen's tap does, and the marks
  follow `showsStatusBadge` (a seen finished tab drops its mark, like its card).
- **Row content.** Open row: `AgentStatusMark` (a terminal glyph for a shell,
  empty for an agent without state), label (2 lines), then
  `agent_model || agent_label` and the state word (`AGENT_STATUS_WORD`); a
  question shows `AgentStatusPill status="question"` in place of the word. A
  CSS `::before` puts "· " between model and word. PLAN/GOAL show as the inset
  ring (`agentModeClass` → `in-plan`/`in-goal`), the colour as `--tab-color`
  stripe (`has-tab-color`), as on the tablet's project cards. Strip chip: same
  mark + label (22 ch) + asking pill; the colour is a bottom rule there (a left
  stripe disappears into a pill's rounding).
- **Unfolded current row background** is `#2e2b48`, the split list's
  `.is-current`. Folded current tile: a 2 px `#7c6cff` inset ring.
- **Strings.** Also added to `es`/`fr`/`it`: `i18n.test.ts` requires every
  language to cover every English key.

### For implementer 2 (step 2)

- **Where the rail is mounted:** `Terminal.tsx`, directly after `</header>`,
  `{railShown && railTabs && <ChatTabsRail variant={splitTier ? "rail" : "strip"} … forceFolded={railForced} />}`.
  Step 2's "fold while the pane is wider than 308 px" goes into that prop:
  `forceFolded={railForced || overviewWide}`, **and** into `railAt`
  (`railLayout(tier, railShown, railFoldPref || railForced)` — add the same
  term there), or `main`'s column and the rail's drawing disagree. Neither may
  write `chatRailFolded`.
- **`forceFolded`** also hides the fold button.
- **State in `Terminal`** (just above `queueSheet`): `railTabs`,
  `takeRailTabs`, `railFoldPref`, `toggleRailFold`, `railForced`, `railShown`
  (`tablet && !!openTab && railOffered(project, railTabs)`), `railAt`,
  `openRailTab`.
- **`main`'s grid in the split tier** (`style.css`, split block, after the
  files dock): with `data-rail="open"` columns `220px minmax(0,1fr)`, with
  `folded` `76px minmax(0,1fr)`; rows stay the base `auto 1fr auto`. Explicit
  placement: header `grid-column:1 / -1; grid-row:1`, `.chat-rail`
  `grid-column:1; grid-row:2 / span 2`, `.terminal-body` `grid-column:2;
  grid-row:2`, `.terminal-controls` `grid-column:2; grid-row:3`. Step 2's
  overview column goes on as a third column; today's files dock still works by
  `padding-right:424px` on `main` and a fixed `.files-library`, untouched.
  Without `data-rail` (one tab, Tabby, no project) nothing of this applies,
  so the overview must not assume a rail column exists.
- **Upright** (tablet block): `data-rail="strip"` → rows `auto auto
  minmax(0,1fr) auto`, header 1, `.chat-strip` 2, body 3, controls 4.
- **Chat measure:** split block overrides the tablet block's 660 px rules with
  `max(24px,calc((100% - 700px) / 2))` (readable output, pinned prompt) and
  `max(8px,…)` on `.terminal-controls`.
- **Class names:** `chat-rail` (+ `folded`), `chat-rail-head`,
  `chat-rail-title`, `chat-rail-fold`, `chat-rail-list`, `chat-rail-row`
  (+ `is-current`, `has-tab-color`, `in-plan`, `in-goal`), `chat-rail-mark`,
  `chat-rail-text`, `chat-rail-label`, `chat-rail-sub`, `chat-rail-what`,
  `chat-rail-state`, `chat-rail-tile` (+ `asking`); `chat-strip`,
  `chat-strip-list`, `chat-strip-chip` (+ same modifiers), `chat-strip-label`.
- **i18n keys:** `mobile.chatRail.region` (nav name "Tabs of this project"),
  `mobile.chatRail.title` ("Tabs · {count}"), `mobile.chatRail.fold` ("Fold
  the tab list", `aria-pressed`), `mobile.chatRail.tile` ("{label} · {state}").
- **Untested id:** `mobile.chatRail` (one pill in the rail's head, one at the
  strip's end).
- **Flag:** `chatRailFolded` (off unset).
- `MobileTabletChat.test.tsx`'s fixture project has `tabs: []`, so no rail
  shows there; `MobileChatRail.test.tsx` has a 5-tab fixture and a
  `stubWindow(tier, wide)` that also answers `RAIL_WIDE_QUERY`.

### Gates

`scripts/gates-job.sh start` on the step-1 tree: brand, whitespace,
`npm run lint` (0 errors; the one `exhaustive-deps` warning in `Terminal.tsx`
at the `[tab.id, closeChatIndex, closeIndexLink]` effect is older than this
step), `npm run build` (tsc + all bundles) and vitest (`--changed`) all PASS;
the Rust gates were skipped (no Rust change). A full `npx vitest run`
afterwards: 13 522 tests passed, 0 failed. The phone bundle (`mobile-dist/`)
is not rebuilt in the commit; the post-commit dev build or `npm run
mobile:bundle` does that.

### Click-through for the user

Rebuild the phone app first (`npm run mobile:bundle`, or the next dev build).

1. **iPad landscape**, an agent tab of a project with three or more tabs: the
   rail on the left under the header, "Tabs · n", rows in the desktop's order,
   the current one highlighted; the chat centred beside it. Tap another row →
   that tab opens with the rail in place (no jump). Tap the current row →
   nothing. Fold → tiles; close and reopen the app → still folded; unfold.
   Drag Stage Manager / Split View under ~1120 px → folded, no fold button.
   Make another tab finish or ask on the desktop → its mark changes within ~5 s.
   Terminal and Diffs views keep the rail. One-tab project, Tabby: no rail.
2. **iPad portrait**: a row of chips under the header, current chip in view,
   swipes sideways, tap → that tab. Turn the iPad mid-draft: the draft, the
   scroll and the connection survive; rail and strip swap.
3. **Phone** upright and on its side: unchanged (no rail, no strip).

### Flagged for user

- The rail reads the project's tabs from `getProjectDetail` every 5 s while
  shown — a full project detail read, as the project screen does. If that is
  too heavy for the chat, a slimmer route would be needed (decision 2 forbade
  a new backend in v1).
- Under 1120 px the rail is always folded (plan); in portrait the strip shows
  even on an 820 px iPad mini, per plan.
- An unavailable tab is only dimmed and disabled; the project screen can
  restart a not-yet-attachable agent tab from its card, the rail cannot.
- Folded, the "Untested" pill sits in the 64 px head and may wrap.

## Step 2 — session overview pane

- Start: `fbb11e98b` (step 1's handoff). Commits: `5874570e0` (2a,
  `feat(mobile): session overview beside the iPad chat`), `eefd97d6e` (2b,
  `feat(mobile): a chat's file opens in the iPad overview pane`); this
  handoff is the commit after them.
- New: `mobile-web/src/components/ChatOverview.tsx`,
  `mobile-web/src/components/SubagentIndexGroups.tsx` (the chips' subagent
  rows, now shared with the overview), `src/__tests__/mobile/MobileChatOverview.test.tsx`.
- Touched: `screens/Terminal.tsx`, `screens/terminal/useOutbox.tsx` (`paned`),
  `components/ChatLinksIndex.tsx` (exports `ChatLinkRows`),
  `components/OutboxViewer.tsx` (arrow guard when paned), `prefs.ts`
  (`chatOverviewPane`, `readOverviewPane`), `style.css`, the five
  dictionaries, `src/lib/untested.ts`, `MobileTabletChat.test.tsx`,
  `docs/filemap_frontend.md`, `docs/context/mobile_access.md` (new section
  "The iPad chat's columns" — no other context doc described the tablet chat),
  `todo/group-h-crossplatform.md` (31cu: three new manual boxes).

### How it works

- `Terminal` state: `paneOpen` (the pane, `chatOverviewPane`), `filesOpen`
  (the library / the drawer, as before), `overviewPane` (an agent tab of a
  project, not Tabby: the pane is an overview; else the library alone),
  `filePaned` (split + overview tab + no tucked-away markup + an outbox,
  inbox or asked file open). `paneAt` = `file` > `library` > `overview`, on
  `main` as `data-overview`. `data-files-docked` is gone: the library is now
  a grid item, not a `padding-right` dock.
- Grid (split block): `--overview-col` 320 / 412 / 492 px (308 / 400 / 480
  panel + 12 px), a third column after the rail's (`[data-rail][data-overview]`
  rules) or the second without a rail; body and controls `grid-column:-3 / -2`.
  The library (`.files-library:not(.files-split)`) and a chat viewer
  (`> .pane-file > .outbox-viewer.paned`) become `position:relative` grid
  items in that column; under an agent's pane they get `margin-top:
  var(--overview-head)` (56 px) so the aside's "‹ Overview" head shows above
  them. Their hosts are `display:contents`, so the tree is unchanged.
- Rail: `railFolded = railForced || paneWide` goes into both `forceFolded`
  and `railLayout` (never writes `chatRailFolded`).

### Choices where the plan left room

- **Library close / Escape** in an agent's pane goes back to the overview
  (pane stays open, flag untouched); in a shell's pane it closes the pane and
  writes the flag off, as the old files pane did.
- **Mode not remembered**: the pane always reopens on the overview; only open
  or closed is stored.
- **Shell tabs** read the same `chatOverviewPane` flag, so with it unset a
  shell in landscape now opens with the library docked (before: closed unset).
  See Flagged.
- **Migration**: `readOverviewPane()` reads `chatOverviewPane`; unset, it
  reads `chatFilesPane` (unset → on), writes the answer to
  `chatOverviewPane` once and never reads the old flag again.
- **Markup tucked away** (`markupAway`): the overview is no markup host and
  stays; a library under it hides with the view (as before) and an agent's
  pane shows the overview meanwhile; a shell's chat takes its whole width.
- **Pills**: the queue and sent-files pills are gone in split only for tabs
  that have the overview (a shell or Tabby's chat keeps the gallery pill).
- **"Project files"** is the Files section's head action, or a lone button at
  the end of the pane when there is no Files section (also the empty state).
  Absent while the desktop's "Project files on the phone" switch is off.
- **Finished subagents**: the newest three are the last three in transcript
  order; Show all expands in place (no "show fewer"). Files show the newest
  four, Links the newest four, Sent three tiles (`OutboxGrid` without
  Delete) and always a Show all that opens the gallery.
- **Section titles** reuse the chips' strings with counts ("Subagents (n)",
  "Files (n)", "Links (n)", "Files from the agent (n)", "Prompt queue").
- **A file in the pane** (2b): opens even when the pane was closed (then
  ‹ Overview closes the file and the pane stays closed); ‹ Overview from a
  file also puts away a library it covered. Escape in the composer leaves a
  paned file alone (only with the focus in the viewer), and the viewer's
  ←/→ picture stepping ignores keys typed in a text field when paned (also
  helps the library's own `files-split` search box).
- **Panel glyph** is an inline SVG (window with a right column), the mirror
  of `SidebarIcon`; the button keeps the `drawer-open` class (+ `has-count`).
- The terminal view keeps the pane, as it kept the docked files pane.

### Names (all checked free before use)

- Classes: `chat-overview`, `chat-overview-head`, `chat-overview-title`,
  `chat-overview-back`, `chat-overview-body`, `chat-overview-section`,
  `chat-overview-section-head`, `chat-overview-action`, `chat-overview-more`,
  `chat-overview-empty`, `pane-file`, modifier `drawer-open.has-count`.
- Attribute: `data-overview="overview" | "library" | "file"` on `main`.
  CSS vars `--overview-col`, `--overview-head`.
- i18n: `mobile.chatOverview.region`, `.title`, `.backLabel`, `.toggle`,
  `.toggleRunning`, `.projectFiles`, `.queued`, `.showAll`, `.empty` (en, de,
  es, fr, it).
- Flag `chatOverviewPane` (on unset); `chatFilesPane` stays in `MobileFlag`
  for the one read. Untested id `mobile.chatOverview` (pill in the pane head).

### Tests changed in `MobileTabletChat.test.tsx`

- The tier-change case: the pane button is now "Show or hide the session
  overview", open by default; the library is reached through "Project files"
  and its attribute is `data-overview="library"`; flag `chatOverviewPane`.
- "opens the pane at once…": now also covers on-unset and the one-time
  carry-over of a closed `chatFilesPane`.
- Keys case: the library is opened from the overview; Escape in it returns to
  the overview instead of closing the pane.
- Markup tucked-away case: the agent keeps its overview; the library-hidden
  half moved to a shell tab (an agent's pane opens on the overview, not the
  library). It uses tab id `tab-marked`: `awayMarkups` outlives the screen
  per tab and leaked into later cases once a file could stand in the pane.
- Turn-with-markup case: a shell tab (whose pane opens with the library).
- Drawer case: attribute and flag renamed; landscape now shows the library
  in the pane under the overview button.
- Stylesheet case: the 424 px padding dock became the 412 px grid column.

### Gates

`scripts/gates-job.sh start` on each step's tree: brand, whitespace, `npm run
lint` (0 errors; the one older `exhaustive-deps` warning in `Terminal.tsx`),
`npm run build`, vitest `--changed` all PASS for 2a and for 2b; Rust gates
skipped (no Rust change). Full `npx vitest run` after 2b: 1 285 files, 13 536 tests passed, 0
failed (step 1 ended at 13 522; the 14 new ones are `MobileChatOverview`).

### Click-through for the user

Rebuild the phone app first (`npm run mobile:bundle`, or the next dev build).

1. **iPad landscape, overview**: an agent tab of a project with subagents,
   files and links → the pane on the right under the header, "Overview" and
   the Untested pill; sections only for what exists; Show all in Finished /
   Files / Links expands in place; Sent's Show all opens the gallery; a
   subagent row opens its conversation; a hold on a file opens its menu; with
   queued prompts a Prompt queue row opens the queue sheet. No chips over the
   transcript, no queue or sent-files pill. Close with the panel button →
   chips back, the button counts running subagents; relaunch → still closed.
2. **Library**: Project files → the library (400 px) under "‹ Overview", the
   rail folded to tiles with no fold button; Escape with the focus in the
   library or ‹ Overview → back to the overview, the rail unfolds.
3. **File**: tap a picture post, a Files row, a changed file, a PDF → it
   opens in the pane (480 px), the chat beside it scrolls and takes typing;
   Mark up → full screen; its Chat button → chat with the overview; ‹ Overview
   closes the file. Turn the iPad with a file open → upright it covers the
   chat, back in landscape it is in the pane.
4. **Shell tab** in landscape: the panel button shows/hides the library alone.
5. **Portrait iPad**: header pills, chips and the files drawer as before; a
   turn mid-draft keeps draft, scroll and connection.
6. **Phone** upright and on its side: unchanged.

### Flagged for user

- **Shell tabs now open with the library docked** in landscape when the flag
  is unset (one flag for both kinds, on by default per plan). If that is
  unwanted, shells need their own off-by-default reading.
- **The landscape header has no queue or sent-files pill even while the pane
  is closed** (plan); the queue is then reachable only by opening the pane
  (or the queued bubble's own buttons in the chat).
- **A file from the chat opens in the pane even when the pane was closed**
  (rather than full screen over the chat); say if a closed pane should mean
  the old full-screen viewer.
- The markup-asks poll pauses while a paned file is open (its condition
  already paused for any open viewer); the banner comes back when it closes.
- The mode (overview / library) is not remembered across chats.
- The pane's three sent tiles carry the gallery's Save/Share row, which is
  tight at ~90 px per tile.
- Never seen on an iPad: the grid placement of the library and of a paned
  `MarkupView` (PDF reader) as `position:relative` grid items is verified only
  by jsdom and the stylesheet tests.
