# Prompt chart redesign: handoff from implementer A (steps 1-5)

Branch `prompt-chart-redesign` (worktree `.claude/worktrees/agent-a40cba7d0f34f1d42`),
started from `develop` at `4cf65018d`. Plan: `docs/prompt_chart_redesign_plan.md`.
Nothing here was run live; every claim below is from tests, `tsc`, lint and
reading the CSS.

## Steps

| Step | Commit | State |
| --- | --- | --- |
| 1. Shell: command bar, three columns, timeline fills the tab | `0ee64cbf2` | done |
| 2. Inspector replaces expand-in-place | `c8f561ddc` | done |
| 3. Card face and anchoring | `e7b2800af` | done |
| 4. Axis: Now pill and the folded night | `762b4995e` | done |
| 5. Help and options popovers | `cfd94933b` (tests only, see below) | done |

Steps 6-10 are untouched.

## Where the plan was silent, and what I chose

Step 1
- **The Help and Options components landed in step 1**, not step 5: the command
  bar needs its two buttons, and leaving them dead for three commits was worse
  than moving the work. The step-5 commit is the tests that pin them.
- `PromptChartCommandBar.tsx` exports `PromptChartPopoverButton` (a button that
  drops a popover through `ContextMenuPortal`, `keepBelow`, class
  `agent-prompt-popover`). Filters, Options and Help all use it. Use it for any
  new bar popover (the composer's When menu is its own thing).
- The Filters popover uses **chip rows**, not `Dropdown`s, for agent / outcome /
  when: a Dropdown inside a portaled popover is a menu inside a menu. The
  Options popover does hold the two `Dropdown`s the plan asks for.
- `PromptChartFilterBar` is now the popover body (same file name). The
  `shown of total` count is `strip matches + timeline session matches` over
  `cards.length`, always visible in the popover; Clear appears only while a
  facet is set. The Filters button gets `is-active` while any facet is set.
- The Drafts column: collapse state `storageKey("promptChart.drafts")` =
  `collapsed`, width `storageKey("promptChart.draftsWidth")` (240-720, default
  288). A collapsed column unmounts the board (layout lives in localStorage, so
  nothing is lost) and stays the unschedule drop zone (`stripRef`). The handle is
  a `role="separator"`, pointer drag via `bindDragRelease`, and Left/Right keys
  move it by 16 px.
- List layout is now one card per row at the column's width; Free keeps the
  168 px cards. The viewport scrolls inside the column (no `max-height`).
- `DraftBoardHandle` gained `setFree(free)`. The List | Free switch is drawn by
  `PromptChart` and reads `draftBoard.current?.free`; it re-renders via the
  board's `onLayout` -> `refreshLinks`, as the links did before.
- Layout geometry: `.agent-prompt-chart` is a container (`container-type:
  inline-size`) and `.agent-prompt-chart-columns` is the grid; below 899 px of
  the chart's own width the columns stack. The timeline body is
  `height: 100%` and scrolls inside; a `.agent-prompt-timeline-sizer` child
  carries the lanes' height (`bodyHeight`) so lifted and queued cards still
  scroll.
- The composer row (step 6) goes between `PromptChartCommandBar` and the
  `.agent-prompt-chart` div in `PromptChart.tsx`. The temporary "New draft"
  button in the Drafts header (`draftBoard.compose()`) is yours to remove.
- Retired i18n keys (all five dictionaries): `draftSearch`, `timelineSearch`,
  `timeline`, `timelineTitle`, `hideTimeline`, `showTimeline`, `zoomHint`,
  `dropHint`, `draftLayoutHint`, `draftCreateHint`, `completionHint`,
  `selectHint`, `draftFreeHint`, `now`. `hideOthers` now reads "Hide
  non-matching". The old `promptChart.timeline` localStorage key is not read.

Step 2
- Selection state stays in `PromptChart` (`selected`); the inspector's editor is
  `editId` (a double click on a card sets it with the selection, the inspector's
  Edit button sets it too) and `focusToken` (Enter/Space on a card bumps it, the
  inspector focuses its heading). `closeInspector` returns focus to the card's
  node. Escape order: link mode, multi-selection, selection (the handler still
  ignores keys inside fields, dialogs and `.context-menu`, and anything
  `defaultPrevented`, so an open popover swallows its own Escape).
- `PromptInspector` is keyed by the selected card id, so its edit buffer resets
  on a new selection. It shows the session view (a list of the session's
  prompts with Collect again / Delete per row) when the selected sent card's
  session has more than one prompt in `timeCards`, whether or not the session
  card is what was clicked.
- `PromptAgentPick.tsx` is the agent picker both the card face and the
  inspector use. `PromptCardTarget` moved there (re-exported from `PromptCard`).
- `PromptCard`'s prop list shrank to what the face needs: gone are `onSave`,
  `onSend`, `onSchedule`, `onUnschedule`, `onCollect`, `onRetime`, `onQueueMove`,
  `onUnlink`, `onEditLink`, `links` (re-added in step 3 for the chip),
  `linkLabel`, `onGoToTab`, `retimeEarlierDisabled`. New: `onOpen`, `onEdit`.
  `PromptSessionCard` lost `onCollect`, `onDelete`, `onGoToTab`.
- The inspector's +-5 min buttons read "-5" / "+5" with `aria-label` "5 min
  earlier" / "5 min later" (the existing keys). Tests find them by role.
- `stateFact` is exported from `PromptCard` (the inspector prints it as the When
  text). `AgentScheduleProposal` (Approve / Reject for agent-authored rules)
  stayed on the card face **and** shows in the inspector.
- Untested register: `promptChart.heading` row text now describes the shell,
  new rows `promptChart.inspector` and `promptChart.options`. The register test
  wants a row per pill, so rows for your composer, sequences, usage band and
  outcome chips are yours (step 10).

Step 3
- State chip: `lib/agents/prompt/stateChip.ts` `promptStateChip(card, links)`
  returns `{ key, params?, tone }`; chip class `.agent-prompt-chip.is-<tone>`.
  A chained card reads "After step n" with n = `chainDepth` (predecessors along
  `after` edges, at least 1). Your `sequences.ts` can replace `chainDepth`.
- Card face rows: `.agent-prompt-card-top` (time + chip), the message, an
  optional `.agent-prompt-card-fact`, `PromptAgentPick` (dot, tab or picker,
  model from the `model:` tag), two stored tags then `+n`. Auto tags are only in
  the inspector. The lamp is gone from cards (kept for the month's day cells).
- The time row prints the **date only in Week and Month** (`showDate` prop);
  Day and Hour leave it to the range label. Session cards print the dates when
  the span crosses midnight, as before.
- **The sent card's fact line is already built**: `lib/agents/prompt/cardFacts.ts`
  `sentFactLine(cards, t)` = "6 min . 4 files . 2 prompts" (duration from
  `files_at - sent_at`, file count over the session, prompt count). That is the
  plan's step-7 sentence; step 7 should extend it (Running, Needs answer, Cut
  off, Finished, the "Missed"/"Failed" reasons) rather than redo it. New keys:
  `durationMin`, `durationHourMin`, `filesOne`, `filesMany`, `noTime`.
- `packLanes(items, win, width, now, cardWidth?, gap?)` takes `now` as the 4th
  argument. `LaneItem` gained `anchor` ("left" for future, "right" for past) and
  `barWidth` (px, at least 4; a past card's bar is `files_at - sent_at` wide,
  capped at the card width; a future card just gets the 4 px corner).
  `promptEndedAt(card)` (exported from `timeline.ts`) is the one place that
  reads `files_at`. A card whose end is after `now` (clock skew) is treated as
  future. `renderCard` gained a 5th argument `{ anchor, width }` that the cards
  draw as `.agent-prompt-card-bar`.
- `TIMELINE_LANE_HEIGHT` 120 -> 140 (the face got a row). The 3 px stripe is
  gone from `.agent-prompt-card`; `--prompt-strand` now only colours the dot and
  the bar.

Step 4
- `TimelineWindow.fold?: { start, end, px }`; `timelineX`/`timelineTimeAt` are
  piecewise when it is set; `dayFold(win, instants)` decides it. `PromptChart`
  keeps `baseWin` (what `timelineWindow` returns, used for the usage query) and
  `win` (the same with the fold, used by the axis, the drag hook, drops and the
  badge). The instants that keep the night open: `now`, every timeline item's
  start and end (`promptEndedAt`), every reset mark. Queued cards sit at `now`,
  so they are covered by it.
- The axis markup changed: `.agent-prompt-timeline-axis` now holds
  `.agent-prompt-timeline-axis-marks` (aria-hidden: ticks, reset labels, the
  Now pill) and, when folded, the `button.agent-prompt-timeline-fold`
  (`data-testid="prompt-timeline-fold"`). The axis is 28 px tall. The reset
  labels are **still in the axis marks** (they were not moved: that is step 9).
- Opening a day is `unfolded: Set<anchor>` in `PromptChart` state.
- **Test helper gotcha**: with an empty night the fold is on in most fixtures,
  which changes every x <-> time mapping. `layout()` in `PromptChart.test.tsx`
  and `PromptChartSelect.test.tsx` clicks the fold open first. A new gesture test
  that lays out a "plain 1000 px day" must do the same, or compute on the folded
  scale (40 px + 960 px over 18 h).

Step 5
- Help rows are gesture/effect pairs from the mock (`promptChart.help.*`, five
  dictionaries). `{modifier}` is `modifierLabel()`.

## Tests

- Rewritten against the new structure (intent kept): the `PromptChart.test.tsx`
  tests that expanded a card (now read the inspector through a local
  `inspector()` helper), the filter / hide / count tests (one filter), the
  timeline-hidden test (now drafts collapse), the edit-near-the-edge test (now
  "nothing grows inside the timeline"), `PromptCardKeyboard`,
  `PromptSessionCard`, the two `AgentSchedulesView` filter/hide tests, the
  `PromptChartLift` height check (reads the sizer), two `packLanes` tests.
- Added: `AgentPromptStateChip.test.ts`, an "anchoring" block and a "folded
  night" block in `AgentPromptTimeline.test.ts` (round trip across the fold,
  snapping inside it, ticks, `dayFold` conditions), and in `PromptChart.test.tsx`
  inspector, face, axis and popover describes.
- `AgentPromptTimelineDst.test.ts` is unchanged and green.

## Gates

- `scripts/gates-job.sh start --base develop` (the whole A range): brand PASS,
  whitespace PASS, lint PASS (0 errors, the repo's existing warnings only; I ran
  eslint on every file I touched and it is clean), build PASS, vitest
  `--changed develop` PASS (215 s). No Rust changed, so no cargo gate ran.
- Per-step I ran `tsc` (TS 7), eslint on the touched files and
  `vitest run src/__tests__/agents src/__tests__/theme src/__tests__/shell`:
  259 files, 2299 tests green at the last commit (that directory set holds
  `FloatingRecipe`, `TypeScale`, `ChromeGlyphs`, `DialogShellRatchet` and the
  untested-registry test).
- Step 1's full `--changed` run once timed out `tex/BibCards.test.tsx > mounts
  only a window of a long list` (20 s, under the load of ~930 files); it passes
  alone and in the last full run.
- Commits 2-4 were checked by the manual set above, not by a separate gate job
  each (an i18n edit pulls ~930 test files into `--changed`, about 9 minutes).

## Flagged for user

- **Nothing was run live.** What I could not see: the container-query stacking
  below 900 px, the scrolling timeline body (`height: 100%` + sizer), the
  `Dropdown` menus opening inside the Options popover, the chip / bar / pill
  colours in the user's themes, the fold block's look. The click-through at the
  end of the plan covers them; add "open the Options popover and pick a model"
  and "fold: click the 00-06 block" to it.
- **Fold vs hanging cards.** A past card hangs left of its end, so a card ending
  at 06:30 draws over the folded block. The fold only checks instants, not card
  extents. Harmless (the card is clamped at x >= 0) but it can cover the block's
  "00-06" label. Fix if it bothers: also count `item.at - cardWidthInTime` as
  occupying the night.
- **Day-view cards no longer print their date**, even when the day shown is not
  today (Week and Month do). The range label carries it. Easy to flip with
  `showDate`.
- **Hiding the timeline is gone** as planned; the timeline can no longer be
  made to give its room to the drafts (only the drafts column collapses). If
  that mattered to the user, say so.
- **Collapsed drafts draw no links to chained cards** (the board is unmounted,
  so `cardNodes` has no entry for them).
- The stacked layout (< 900 px) puts the inspector after the timeline, below the
  fold of the tab; selecting a card there scrolls nothing into view.
- `.agent-prompt-chart-select-hint` and `.agent-prompt-lamp.is-*` rules are
  still in `projects-tabs.css` (the lamp is the month's). The select-hint rule is
  dead; I left it for the wrap-up sweep.
- Decisions-made-while-planning I implemented as written, no objection: one
  filter, no Hide timeline, options popover, `files_at - sent_at` as duration,
  face buttons in the inspector. The one I would watch: **"When applies to the
  timeline only"** means a draft is never dimmed by Today / Upcoming, which can
  read as "the filter ignored my drafts".
- The plan's step-5 text said the hints "are removed from the layout"; they are,
  and a test pins it, but a reader who never opens "?" will not learn
  Shift+drag or Ctrl+wheel. That is the trade the user chose.

## Click-through for the user (additions to the plan's list)

Day view with an empty night: the `00-06` block at the left of the axis; click
it, the day opens; go to the next day, it folds again. Select a card: the
inspector appears; Esc closes it; Enter on a focused card moves focus into it.
Open Filters, Options and `?`: each drops under its button and Esc closes it.
Drag the right edge of the Drafts column; collapse it and reload the window.
