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
